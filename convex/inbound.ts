import { v } from "convex/values";
import {
  mutation,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  env,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { domainOfEmail } from "./lib/domains";
import { toMinor, normalizeToUsdMinor } from "./lib/money";
import { fetchUsdRates } from "./lib/fx";
import {
  PARSING_MODEL,
  openAiJson,
  strictObject,
  nullable,
} from "./lib/openai";
import { recordEvent } from "./lib/events";
import { requireRequestOwner } from "./lib/authz";

/**
 * Idempotency at the door (PLAN.md §4).
 *
 * The component dedupes its own webhook, but everything downstream is ours: an
 * LLM parse that runs twice costs money and can write two quotes. The eventId
 * lands in `inboundParses` behind a unique lookup and a repeat is a no-op.
 */
export const onMessageReceived = internalMutation({
  args: {
    message: v.any(),
    thread: v.any(),
    eventId: v.string(),
    /** Sender failed SPF/DKIM/DMARC. Ingested, but never auto-trusted. */
    unauthenticated: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("inboundParses")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) return null;

    const message = (args.message ?? {}) as Record<string, unknown>;
    const messageId = asString(message.message_id) ?? args.eventId;
    const threadId = asString(message.thread_id);
    const inboxId = asString(message.inbox_id);
    const from = asString(message.from);

    const rfqId = await matchRfq(ctx, { threadId, from });

    const body = asString(message.text) ?? asString(message.html) ?? "";
    const parseId = await ctx.db.insert("inboundParses", {
      eventId: args.eventId,
      messageId,
      threadId,
      inboxId,
      rfqId: rfqId ?? undefined,
      state: "received",
      attempts: 0,
      fromAddress: from,
      // Bounded: a human only needs enough to judge, and the row has a limit.
      text: body.slice(0, 8_000),
    });

    if (rfqId) {
      await ctx.runMutation(internal.rfqs.markReplied, { rfqId, threadId });
      const rfq = await ctx.db.get("rfqs", rfqId);
      await recordEvent(ctx, {
        requestId: rfq?.requestId,
        kind: "reply.received",
        message: `Reply received from ${from ?? "a supplier"}.`,
      });
    }

    if (args.unauthenticated === true) {
      // Anyone can forge an address that fails authentication. Letting such a
      // message become a `confirmed` quote would let a stranger set the price
      // the recommendation is computed from, so it stops here for a human.
      await ctx.db.patch("inboundParses", parseId, {
        state: "needs_review",
        reason:
          "Sender failed email authentication (SPF/DKIM/DMARC). Confirm this " +
          "reply is genuine before trusting its price.",
      });
      await recordEvent(ctx, {
        requestId: rfqId
          ? (await ctx.db.get("rfqs", rfqId))?.requestId
          : undefined,
        kind: "reply.unauthenticated",
        message: `Unauthenticated reply from ${from ?? "an unknown sender"} held for review.`,
      });
      return null;
    }

    await ctx.scheduler.runAfter(0, internal.inbound.parseMessage, {
      parseId,
      text: body,
      from: from ?? "",
    });
    return null;
  },
});

/**
 * Match a reply to the RFQ that provoked it. The thread id is authoritative;
 * the sender's domain is the fallback for the first reply on a thread we have
 * not seen an id for yet.
 */
async function matchRfq(
  ctx: MutationCtx,
  args: { threadId?: string; from?: string },
): Promise<Id<"rfqs"> | null> {
  const threadId = args.threadId;
  if (threadId) {
    const byThread = await ctx.db
      .query("rfqs")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .first();
    if (byThread) return byThread._id;
  }

  if (!args.from) return null;
  const domain = domainOfEmail(args.from);
  if (!domain) return null;

  const supplier = await ctx.db
    .query("suppliers")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .unique();
  if (!supplier) return null;

  const rfq = await ctx.db
    .query("rfqs")
    .withIndex("by_supplierId", (q) => q.eq("supplierId", supplier._id))
    .order("desc")
    .first();
  return rfq ? rfq._id : null;
}

export const loadParse = internalQuery({
  args: { parseId: v.id("inboundParses") },
  handler: async (ctx, args) => {
    const parse = await ctx.db.get("inboundParses", args.parseId);
    if (!parse) return null;
    const rfq = parse.rfqId ? await ctx.db.get("rfqs", parse.rfqId) : null;
    const request = rfq ? await ctx.db.get("requests", rfq.requestId) : null;
    return { parse, rfq, request };
  },
});

/**
 * received -> parsing -> parsed | needs_review | not_a_quote.
 * Never silently drop a message: every path below ends in a terminal state.
 */
export const parseMessage = internalAction({
  args: { parseId: v.id("inboundParses"), text: v.string(), from: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.inbound.loadParse, {
      parseId: args.parseId,
    });
    if (!loaded) return null;
    if (loaded.parse.state !== "received") return null;

    await ctx.runMutation(internal.inbound.setParseState, {
      parseId: args.parseId,
      state: "parsing",
    });

    if (!loaded.rfq || !loaded.request) {
      await ctx.runMutation(internal.inbound.setParseState, {
        parseId: args.parseId,
        state: "needs_review",
        reason: "Could not match this reply to an outstanding RFQ.",
      });
      return null;
    }

    if (args.text.trim().length === 0) {
      // The PDF pro-forma with an empty body is the common case, not the
      // exception (PLAN.md §7). It goes to review, not to the bin.
      await ctx.runMutation(internal.inbound.setParseState, {
        parseId: args.parseId,
        state: "needs_review",
        reason: "Empty message body — likely an attachment-only quote.",
      });
      return null;
    }

    try {
      const parsed = await openAiJson({
        apiKey: env.OPENAI_API_KEY,
        model: PARSING_MODEL,
        system:
          "You read a supplier's email reply and extract the quoted price. If the message is not a " +
          "quotation (a question, an out-of-office, a refusal), set isQuote to false. Never invent a " +
          "number that is not written in the message.",
        user: `Our request: ${loaded.request.title}\nFrom: ${args.from}\n\n${args.text}`,
        schemaName: "quote_parse",
        schema: strictObject({
          isQuote: { type: "boolean" },
          totalAmount: nullable("number"),
          currency: nullable("string"),
          vatIncluded: nullable("boolean"),
          incoterm: nullable("string"),
          leadTimeDays: nullable("number"),
          warrantyMonths: nullable("number"),
          note: nullable("string"),
        }),
      });

      if (parsed.isQuote !== true) {
        await ctx.runMutation(internal.inbound.setParseState, {
          parseId: args.parseId,
          state: "not_a_quote",
          reason: asString(parsed.note) ?? "Reply did not contain a quotation.",
        });
        return null;
      }

      const totalAmount = parsed.totalAmount;
      const currency = asString(parsed.currency);
      if (typeof totalAmount !== "number" || !currency) {
        await ctx.runMutation(internal.inbound.setParseState, {
          parseId: args.parseId,
          state: "needs_review",
          reason: "Reply reads as a quote but has no clear total and currency.",
        });
        return null;
      }

      let rates: Record<
        string,
        { fxRate: number; fxRateAt: number; fxSource: string }
      > = {};
      try {
        rates = await fetchUsdRates();
      } catch (error) {
        console.error("FX snapshot failed during parse", error);
      }

      await ctx.runMutation(internal.inbound.applyParsedQuote, {
        parseId: args.parseId,
        totalAmount,
        currency: currency.toUpperCase(),
        vatIncluded: parsed.vatIncluded === true,
        incoterm: asString(parsed.incoterm),
        leadTimeDays:
          typeof parsed.leadTimeDays === "number"
            ? parsed.leadTimeDays
            : undefined,
        warrantyMonths:
          typeof parsed.warrantyMonths === "number"
            ? parsed.warrantyMonths
            : undefined,
        fx: rates[currency.toUpperCase()],
      });
    } catch (error) {
      await ctx.runMutation(internal.inbound.setParseState, {
        parseId: args.parseId,
        state: "needs_review",
        reason: `Parse failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    return null;
  },
});

export const setParseState = internalMutation({
  args: {
    parseId: v.id("inboundParses"),
    state: v.union(
      v.literal("received"),
      v.literal("parsing"),
      v.literal("parsed"),
      v.literal("needs_review"),
      v.literal("not_a_quote"),
    ),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const parse = await ctx.db.get("inboundParses", args.parseId);
    if (!parse) return null;
    await ctx.db.patch("inboundParses", args.parseId, {
      state: args.state,
      reason: args.reason,
      attempts: parse.attempts + (args.state === "parsing" ? 1 : 0),
    });
    return null;
  },
});

/**
 * The moment the demo exists for: an emailed quote supersedes the crawled row
 * for that supplier, and the board upgrades in front of the viewer.
 */
export const applyParsedQuote = internalMutation({
  args: {
    parseId: v.id("inboundParses"),
    totalAmount: v.number(),
    currency: v.string(),
    vatIncluded: v.boolean(),
    incoterm: v.optional(v.string()),
    leadTimeDays: v.optional(v.number()),
    warrantyMonths: v.optional(v.number()),
    fx: v.optional(
      v.object({
        fxRate: v.number(),
        fxRateAt: v.number(),
        fxSource: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const parse = await ctx.db.get("inboundParses", args.parseId);
    if (!parse || !parse.rfqId) return null;
    const rfq = await ctx.db.get("rfqs", parse.rfqId);
    if (!rfq) return null;

    const totalMinor = toMinor(args.totalAmount, args.currency);

    const quoteId = await ctx.db.insert("quotes", {
      requestId: rfq.requestId,
      supplierId: rfq.supplierId,
      rfqId: rfq._id,
      source: "emailed",
      // Earned, not guessed: this price came from a real reply on a real thread.
      confidence: "high",
      totalMinor,
      currency: args.currency,
      vatIncluded: args.vatIncluded,
      incoterm: args.incoterm,
      normalizedUsdMinor: args.fx
        ? normalizeToUsdMinor(totalMinor, args.currency, args.fx)
        : undefined,
      fxRate: args.fx?.fxRate,
      fxRateAt: args.fx?.fxRateAt,
      fxSource: args.fx?.fxSource,
      leadTimeDays: args.leadTimeDays,
      warrantyMonths: args.warrantyMonths,
    });

    // Supersede the crawled row for this supplier rather than deleting it —
    // the board shows what changed, and the audit trail keeps both.
    const priorQuotes = await ctx.db
      .query("quotes")
      .withIndex("by_requestId_and_supplierId", (q) =>
        q.eq("requestId", rfq.requestId).eq("supplierId", rfq.supplierId),
      )
      .take(20);

    for (const prior of priorQuotes) {
      if (prior._id === quoteId) continue;
      if (prior.source !== "crawled") continue;
      if (prior.supersededBy) continue;
      await ctx.db.patch("quotes", prior._id, { supersededBy: quoteId });
    }

    await ctx.db.patch("inboundParses", args.parseId, {
      state: "parsed",
      quoteId,
      reason: undefined,
    });

    await recordEvent(ctx, {
      requestId: rfq.requestId,
      kind: "quote.confirmed",
      message: `Confirmed quote received and applied to the board.`,
    });
    return null;
  },
});

/**
 * Release a held message for parsing.
 *
 * Holding an unauthenticated reply is the safe default, not a verdict. A
 * person who recognises the sender can let it through, and the normal parse
 * runs from the stored body — no second trip to AgentMail.
 */
export const releaseForParsing = mutation({
  args: { sessionToken: v.string(), parseId: v.id("inboundParses") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const parse = await ctx.db.get("inboundParses", args.parseId);
    if (!parse) throw new Error("That message no longer exists.");
    // The held reply hangs off an RFQ, which hangs off a request. Verify the
    // caller owns that request before letting them release it for parsing.
    const rfq = parse.rfqId ? await ctx.db.get("rfqs", parse.rfqId) : null;
    if (!rfq) throw new Error("That message is not linked to your request.");
    await requireRequestOwner(ctx, args.sessionToken, rfq.requestId);
    if (parse.state === "parsed") {
      throw new Error("This message has already produced a quote.");
    }
    if (!parse.text) {
      throw new Error("The message body was not stored, so it cannot be re-parsed.");
    }

    await ctx.db.patch("inboundParses", args.parseId, {
      state: "received",
      reason: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.inbound.parseMessage, {
      parseId: args.parseId,
      text: parse.text,
      from: parse.fromAddress ?? "",
    });
    return null;
  },
});

/** Held messages for one request, with enough context to judge them. */
export const reviewQueueForRequest = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);
    const rfqIds = new Set(rfqs.map((rfq) => rfq._id));

    const held = await ctx.db
      .query("inboundParses")
      .withIndex("by_state", (q) => q.eq("state", "needs_review"))
      .order("desc")
      .take(50);

    return await Promise.all(
      held
        .filter((parse) => parse.rfqId && rfqIds.has(parse.rfqId))
        .map(async (parse) => {
          const rfq = parse.rfqId
            ? await ctx.db.get("rfqs", parse.rfqId)
            : null;
          const supplier = rfq
            ? await ctx.db.get("suppliers", rfq.supplierId)
            : null;
          return {
            _id: parse._id,
            reason: parse.reason ?? "Held for review.",
            fromAddress: parse.fromAddress ?? null,
            preview: (parse.text ?? "").slice(0, 600),
            supplierName: supplier?.name ?? "Unknown supplier",
            receivedAt: parse._creationTime,
          };
        }),
    );
  },
});

/** The messy replies, kept visible. Every competitor will handle only the clean one. */
export const needsReview = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("inboundParses")
      .withIndex("by_state", (q) => q.eq("state", "needs_review"))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 50));
  },
});

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

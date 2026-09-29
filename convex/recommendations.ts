import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  env,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { formatMoney } from "./lib/money";
import { PARSING_MODEL, openAiJson, strictObject } from "./lib/openai";
import { recordEvent } from "./lib/events";
import { requireRequestOwner } from "./lib/authz";

/**
 * Not "cheapest" (PLAN.md §2, step 7).
 *
 * The ranking is arithmetic: total landed cost, lead time against the stated
 * window, warranty, and whether the price was confirmed by a human being or
 * merely scraped. The model is allowed to write the sentence explaining the
 * choice — it is not allowed to make the choice, and every input it was given
 * is stored on the recommendation and shown on hover.
 */
export const recommend = mutation({
  args: { sessionToken: v.string(), requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    await ctx.scheduler.runAfter(0, internal.recommendations.compute, {
      requestId: args.requestId,
    });
    return null;
  },
});

export const forRequest = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    const recommendation = await ctx.db
      .query("recommendations")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .first();
    if (!recommendation) return null;

    const quote = await ctx.db.get("quotes", recommendation.quoteId);
    const supplier = quote
      ? await ctx.db.get("suppliers", quote.supplierId)
      : null;

    return {
      ...recommendation,
      supplierName: supplier?.name ?? "Unknown supplier",
      totalMinor: quote?.totalMinor ?? null,
      currency: quote?.currency ?? null,
      source: quote?.source ?? null,
    };
  },
});

type QuoteCandidate = {
  quoteId: Id<"quotes">;
  supplierName: string;
  source: "crawled" | "emailed";
  totalMinor: number;
  currency: string;
  normalizedUsdMinor?: number;
  leadTimeDays?: number;
  warrantyMonths?: number;
  vatIncluded: boolean;
};

export const loadCandidates = internalQuery({
  args: { requestId: v.id("requests") },
  // Explicit return type: read back through `internal`, so inference would
  // otherwise collapse to `any` at the call site.
  handler: async (
    ctx,
    args,
  ): Promise<{
    request: Doc<"requests">;
    candidates: QuoteCandidate[];
  } | null> => {
    const request = await ctx.db.get("requests", args.requestId);
    if (!request) return null;

    const quotes = await ctx.db
      .query("quotes")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(200);

    const priced = quotes.filter((quote) => !quote.supersededBy);

    const candidates = await Promise.all(
      priced.map(async (quote) => {
        const supplier = await ctx.db.get("suppliers", quote.supplierId);
        return {
          quoteId: quote._id,
          supplierName: supplier?.name ?? "Unknown supplier",
          source: quote.source,
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          normalizedUsdMinor: quote.normalizedUsdMinor,
          leadTimeDays: quote.leadTimeDays,
          warrantyMonths: quote.warrantyMonths,
          vatIncluded: quote.vatIncluded,
        };
      }),
    );

    return { request, candidates };
  },
});

export const compute = internalAction({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(
      internal.recommendations.loadCandidates,
      { requestId: args.requestId },
    );
    if (!loaded || loaded.candidates.length === 0) return null;

    // Deterministic ranking. Nothing below is a model output.
    const window = loaded.request.deliveryWindowDays;
    const scored = loaded.candidates
      .map((candidate) => {
        const cost = candidate.normalizedUsdMinor ?? candidate.totalMinor;
        const lateBy =
          window !== undefined && candidate.leadTimeDays !== undefined
            ? Math.max(0, candidate.leadTimeDays - window)
            : 0;
        return {
          ...candidate,
          cost,
          lateBy,
          // A confirmed price is worth more than a scraped one; a late
          // delivery and a missing warranty each cost the candidate ground.
          score:
            cost *
            (1 + lateBy * 0.02) *
            (candidate.source === "emailed" ? 1 : 1.15) *
            (candidate.warrantyMonths && candidate.warrantyMonths >= 12
              ? 1
              : 1.05),
        };
      })
      .sort((a, b) => a.score - b.score);

    const winner = scored[0];
    const runnerUp = scored[1];

    const inputs = [
      {
        label: "Total",
        value: formatMoney(winner.totalMinor, winner.currency),
      },
      {
        label: "Price track",
        value: winner.source === "emailed" ? "confirmed by reply" : "web price",
      },
      {
        label: "Lead time",
        value:
          winner.leadTimeDays !== undefined
            ? `${winner.leadTimeDays} days`
            : "not stated",
      },
      {
        label: "Delivery window",
        value: window !== undefined ? `${window} days` : "not stated",
      },
      {
        label: "Warranty",
        value:
          winner.warrantyMonths !== undefined
            ? `${winner.warrantyMonths} months`
            : "not stated",
      },
      {
        label: "Candidates compared",
        value: String(scored.length),
      },
    ];

    // The named trade-off, derived before the model sees anything.
    let tradeoff = "No material trade-off — it leads on every input compared.";
    if (winner.lateBy > 0) {
      tradeoff = `Arrives ${winner.lateBy} day(s) past the stated window.`;
    } else if (winner.source === "crawled") {
      tradeoff =
        "Price is a scraped web listing, not yet confirmed by the supplier.";
    } else if (runnerUp && runnerUp.cost < winner.cost) {
      tradeoff = `Not the cheapest — ${runnerUp.supplierName} is lower but scores worse on lead time, warranty, or confirmation.`;
    } else if (winner.warrantyMonths === undefined) {
      tradeoff = "Warranty terms were never stated in the quotation.";
    }

    let rationale = `${winner.supplierName} at ${formatMoney(
      winner.totalMinor,
      winner.currency,
    )}, chosen on total landed cost against the stated delivery window.`;

    // The model writes prose from the computed facts, and only that.
    try {
      const written = await openAiJson({
        apiKey: env.OPENAI_API_KEY,
        model: PARSING_MODEL,
        system:
          "You write one short, factual procurement recommendation from the supplied facts. " +
          "Use only the facts given. Do not introduce numbers, claims, or comparisons that are not present.",
        user: JSON.stringify({ winner, runnerUp, window, inputs }),
        schemaName: "recommendation_prose",
        schema: strictObject({ rationale: { type: "string" } }),
      });
      if (typeof written.rationale === "string" && written.rationale.trim()) {
        rationale = written.rationale.trim();
      }
    } catch (error) {
      // The computed sentence above already stands on its own.
      console.error("Recommendation prose failed", error);
    }

    await ctx.runMutation(internal.recommendations.save, {
      requestId: args.requestId,
      quoteId: winner.quoteId,
      rationale,
      tradeoff,
      totalLandedUsdMinor: winner.normalizedUsdMinor,
      leadTimeDays: winner.leadTimeDays,
      inputs,
    });
    return null;
  },
});

export const save = internalMutation({
  args: {
    requestId: v.id("requests"),
    quoteId: v.id("quotes"),
    rationale: v.string(),
    tradeoff: v.string(),
    totalLandedUsdMinor: v.optional(v.number()),
    leadTimeDays: v.optional(v.number()),
    inputs: v.array(v.object({ label: v.string(), value: v.string() })),
  },
  returns: v.id("recommendations"),
  handler: async (ctx, args): Promise<Id<"recommendations">> => {
    const recommendationId = await ctx.db.insert("recommendations", {
      requestId: args.requestId,
      quoteId: args.quoteId,
      rationale: args.rationale,
      tradeoff: args.tradeoff,
      totalLandedUsdMinor: args.totalLandedUsdMinor,
      leadTimeDays: args.leadTimeDays,
      inputs: args.inputs,
    });

    await ctx.db.patch("requests", args.requestId, { status: "decided" });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "recommendation.made",
      message: args.rationale,
    });
    return recommendationId;
  },
});

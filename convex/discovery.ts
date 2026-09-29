import { v } from "convex/values";
import {
  WorkflowManager,
  start,
  cancel,
  vWorkflowId,
  type WorkflowId,
} from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  env,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { registrableDomain } from "./lib/domains";
import {
  toMinor,
  normalizeToUsdMinor,
  formatMoney,
  FxSnapshot,
} from "./lib/money";
import { composeRfqBody } from "./lib/rfqText";
import { verifyEmailMx } from "./lib/mx";
import { fetchUsdRates } from "./lib/fx";
import {
  PARSING_MODEL,
  openAiJson,
  clip,
  strictObject,
  nullable,
} from "./lib/openai";
import { recordEvent } from "./lib/events";
import { SEED_SUPPLIERS } from "./lib/seedSuppliers";

export const workflow = new WorkflowManager(components.workflow);
const firecrawl = new FirecrawlClient(components.firecrawl);

// Cost and latency guards. The board must fill in ~20 seconds (PLAN.md §3),
// and every candidate past this point costs a scrape plus one LLM call — so
// this number is the per-run inference bill, not a tuning knob. Raise it only
// when there is credit to spend on it.
const MAX_CANDIDATES = 4;
const MAX_SUPPLIERS_WRITTEN = 6;

const vCandidate = v.object({
  url: v.string(),
  domain: v.string(),
  name: v.string(),
});

type Candidate = { url: string; domain: string; name: string };

const vEnriched = v.object({
  domain: v.string(),
  name: v.string(),
  websiteUrl: v.string(),
  sourceUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  priceAmount: v.optional(v.number()),
  currency: v.optional(v.string()),
  productDescription: v.optional(v.string()),
});

const vFxSnapshot = v.object({
  fxRate: v.number(),
  fxRateAt: v.number(),
  fxSource: v.string(),
});

/**
 * The discovery pipeline as a durable workflow (PLAN.md §5): a Firecrawl
 * timeout on supplier seven does not lose suppliers one through six. Each step
 * is a separate Convex function so the workflow itself stays deterministic.
 *
 * search -> scrape -> extract -> dedupe -> verify -> write
 */
export const discoveryWorkflow = workflow
  .define({
    args: { requestId: v.id("requests") },
    returns: v.null(),
  })
  .handler(async (step, args): Promise<null> => {
    const candidates: Candidate[] = await step.runAction(
      internal.discovery.searchCandidates,
      { requestId: args.requestId },
    );

    const fx = await step.runAction(internal.discovery.snapshotFx, {});

    // Fan out: each candidate is scraped and extracted independently, so one
    // slow supplier site does not hold up the rest of the board.
    const enriched = await Promise.all(
      candidates.slice(0, MAX_CANDIDATES).map((candidate) =>
        step.runAction(internal.discovery.enrichCandidate, {
          requestId: args.requestId,
          candidate,
        }),
      ),
    );

    let written = 0;
    for (const supplier of enriched) {
      if (supplier === null) continue;
      if (written >= MAX_SUPPLIERS_WRITTEN) break;

      // Verify the contact before it is ever offered as a send target.
      const verification = supplier.email
        ? await step.runAction(internal.discovery.verifyEmailDomain, {
            email: supplier.email,
          })
        : "unverified";

      await step.runMutation(internal.discovery.writeCandidate, {
        requestId: args.requestId,
        supplier,
        verification,
        fx,
      });
      written += 1;
    }

    await step.runMutation(internal.discovery.finishDiscovery, {
      requestId: args.requestId,
      supplierCount: written,
    });
    return null;
  });

export const startDiscovery = internalMutation({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workflowId = await start(
      ctx,
      internal.discovery.discoveryWorkflow,
      { requestId: args.requestId },
      {
        // Without this, a workflow that dies mid-run leaves the request stuck
        // on "finding suppliers" forever with nothing to retry and nothing to
        // explain it. The completion handler is what turns a crash into a
        // visible, retryable failure.
        onComplete: internal.discovery.onDiscoveryComplete,
        context: { requestId: args.requestId },
      },
    );
    await ctx.db.patch("requests", args.requestId, {
      discoveryWorkflowId: workflowId as unknown as string,
    });
    return null;
  },
});

export const onDiscoveryComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ requestId: v.id("requests") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind === "success") return null;

    const request = await ctx.db.get("requests", args.context.requestId);
    if (!request) return null;
    // Only rescue a request still mid-flight; never overwrite a later state.
    if (request.status !== "discovering") return null;

    const reason =
      args.result.kind === "canceled"
        ? "Supplier search was cancelled."
        : `Supplier search failed: ${String(args.result.error).slice(0, 300)}`;

    await ctx.db.patch("requests", args.context.requestId, {
      status: "failed",
      failureReason: reason,
    });
    await recordEvent(ctx, {
      requestId: args.context.requestId,
      kind: "discovery.failed",
      message: reason,
    });
    return null;
  },
});

/**
 * Stop an in-flight discovery run. Every remaining candidate costs a scrape
 * and an LLM call, so this is the switch that bounds a run that is going
 * wrong — cheaper than waiting it out and paying for the rest.
 */
export const cancelDiscovery = mutation({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get("requests", args.requestId);
    if (!request?.discoveryWorkflowId) return null;

    await cancel(
      ctx,
      components.workflow,
      request.discoveryWorkflowId as WorkflowId,
    );
    await ctx.db.patch("requests", args.requestId, {
      status: "failed",
      failureReason: "Discovery cancelled.",
    });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "discovery.cancelled",
      message: "Discovery cancelled before it finished.",
    });
    return null;
  },
});

export const loadForDiscovery = internalQuery({
  args: { requestId: v.id("requests") },
  // Explicit return type: this query is read back through `internal`, and
  // without it the call sites downstream infer `any`.
  handler: async (
    ctx,
    args,
  ): Promise<{
    request: Doc<"requests">;
    items: Doc<"lineItems">[];
  } | null> => {
    const request = await ctx.db.get("requests", args.requestId);
    if (!request) return null;
    const items = await ctx.db
      .query("lineItems")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(20);
    return { request, items };
  },
});

/**
 * Firecrawl search for candidate suppliers. Falls back to the hand-verified
 * seed list so a discovery failure degrades instead of collapsing (PLAN.md §7).
 */
export const searchCandidates = internalAction({
  args: { requestId: v.id("requests") },
  returns: v.array(vCandidate),
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.discovery.loadForDiscovery, {
      requestId: args.requestId,
    });
    if (!loaded) return [];

    const terms = loaded.items.map((item) => item.description).join(", ");
    const query = `${terms} supplier price ${loaded.request.deliverTo}`;

    const candidates: Array<{ url: string; domain: string; name: string }> = [];
    const seen = new Set<string>();

    try {
      const results = await firecrawl.search(ctx, query, {
        limit: MAX_CANDIDATES,
        location: loaded.request.deliverTo,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      });

      for (const hit of results.web ?? []) {
        const record = hit as Record<string, unknown>;
        const url =
          typeof record.url === "string"
            ? record.url
            : typeof (record.metadata as Record<string, unknown> | undefined)
                  ?.sourceURL === "string"
              ? ((record.metadata as Record<string, unknown>).sourceURL as string)
              : null;
        if (!url) continue;

        const domain = registrableDomain(url);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);

        candidates.push({
          url,
          domain,
          name: typeof record.title === "string" ? record.title : domain,
        });
      }
    } catch (error) {
      console.error("Firecrawl search failed, falling back to seeds", error);
    }

    for (const seed of SEED_SUPPLIERS) {
      if (candidates.length >= MAX_CANDIDATES) break;
      if (seen.has(seed.domain)) continue;
      seen.add(seed.domain);
      candidates.push({
        url: seed.websiteUrl,
        domain: seed.domain,
        name: seed.name,
      });
    }

    return candidates;
  },
});

export const snapshotFx = internalAction({
  args: {},
  returns: v.record(v.string(), vFxSnapshot),
  handler: async () => {
    try {
      return await fetchUsdRates();
    } catch (error) {
      // No snapshot means no USD normalization — the board still shows native
      // currency rather than a number nobody can defend.
      console.error("FX snapshot failed", error);
      return {};
    }
  },
});

/**
 * Scrape the candidate's pages and pull out the supplier, a listed price, and
 * a contact address. Returns null when the page yields nothing usable, which
 * is a normal outcome, not an error.
 */
export const enrichCandidate = internalAction({
  args: {
    requestId: v.id("requests"),
    candidate: vCandidate,
  },
  returns: v.union(v.null(), vEnriched),
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.discovery.loadForDiscovery, {
      requestId: args.requestId,
    });
    if (!loaded) return null;

    let markdown = "";
    try {
      const page = await firecrawl.scrape(ctx, args.candidate.url, {
        formats: ["markdown"],
        onlyMainContent: true,
        maxAge: 3_600_000,
      });
      const record = page as Record<string, unknown>;
      markdown = typeof record.markdown === "string" ? record.markdown : "";
    } catch (error) {
      console.error(`Scrape failed for ${args.candidate.url}`, error);
      return null;
    }
    if (!markdown) return null;

    const wanted = loaded.items
      .map((item) => `${item.quantity} x ${item.description}`)
      .join("; ");

    try {
      const extracted = await openAiJson({
        apiKey: env.OPENAI_API_KEY,
        model: PARSING_MODEL,
        system:
          "You read a supplier web page and extract the vendor, any listed price for the requested " +
          "item, and a contact email. Return null for anything the page does not state. Never guess " +
          "an email address or a price.",
        user: `Requested: ${wanted}\n\nPage (${args.candidate.url}):\n${clip(markdown)}`,
        schemaName: "supplier_extract",
        schema: strictObject({
          supplierName: { type: "string" },
          email: nullable("string"),
          priceAmount: nullable("number"),
          currency: nullable("string"),
          productDescription: nullable("string"),
        }),
      });

      const email =
        typeof extracted.email === "string" && extracted.email.includes("@")
          ? extracted.email.trim().toLowerCase()
          : undefined;

      return {
        domain: args.candidate.domain,
        name:
          typeof extracted.supplierName === "string" &&
          extracted.supplierName.trim().length > 0
            ? extracted.supplierName.trim()
            : args.candidate.name,
        websiteUrl: args.candidate.url,
        sourceUrl: args.candidate.url,
        email,
        priceAmount:
          typeof extracted.priceAmount === "number"
            ? extracted.priceAmount
            : undefined,
        currency:
          typeof extracted.currency === "string" &&
          extracted.currency.length === 3
            ? extracted.currency.toUpperCase()
            : undefined,
        productDescription:
          typeof extracted.productDescription === "string"
            ? extracted.productDescription
            : undefined,
      };
    } catch (error) {
      console.error(`Extraction failed for ${args.candidate.url}`, error);
      return null;
    }
  },
});

export const verifyEmailDomain = internalAction({
  args: { email: v.string() },
  returns: v.union(
    v.literal("unverified"),
    v.literal("mx_valid"),
    v.literal("mx_invalid"),
  ),
  handler: async (_ctx, args) => verifyEmailMx(args.email),
});

/**
 * Dedupe by registrable domain and write the supplier, its contact, and the
 * crawled quote in one transaction.
 */
export const writeCandidate = internalMutation({
  args: {
    requestId: v.id("requests"),
    supplier: vEnriched,
    verification: v.union(
      v.literal("unverified"),
      v.literal("mx_valid"),
      v.literal("mx_invalid"),
    ),
    fx: v.record(v.string(), vFxSnapshot),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("suppliers")
      .withIndex("by_domain", (q) => q.eq("domain", args.supplier.domain))
      .unique();

    const supplierId: Id<"suppliers"> =
      existing?._id ??
      (await ctx.db.insert("suppliers", {
        name: args.supplier.name,
        domain: args.supplier.domain,
        websiteUrl: args.supplier.websiteUrl,
        discoveredVia: "crawled",
        sourceUrl: args.supplier.sourceUrl,
      }));

    if (args.supplier.email) {
      const knownContact = await ctx.db
        .query("contacts")
        .withIndex("by_email", (q) => q.eq("email", args.supplier.email!))
        .unique();
      if (!knownContact) {
        await ctx.db.insert("contacts", {
          supplierId,
          email: args.supplier.email,
          verification: args.verification,
          verifiedAt: Date.now(),
          sourceUrl: args.supplier.sourceUrl,
        });
      }
    }

    // A crawled price is optional. A supplier with no listed price still
    // belongs on the board — it is a valid RFQ target.
    if (
      args.supplier.priceAmount !== undefined &&
      args.supplier.currency !== undefined
    ) {
      const currency = args.supplier.currency;
      const totalMinor = toMinor(args.supplier.priceAmount, currency);
      const snapshot: FxSnapshot | undefined = args.fx[currency];

      const alreadyQuoted = await ctx.db
        .query("quotes")
        .withIndex("by_requestId_and_supplierId", (q) =>
          q.eq("requestId", args.requestId).eq("supplierId", supplierId),
        )
        .first();

      if (!alreadyQuoted) {
        await ctx.db.insert("quotes", {
          requestId: args.requestId,
          supplierId,
          source: "crawled",
          confidence: "low",
          totalMinor,
          currency,
          vatIncluded: false,
          normalizedUsdMinor: snapshot
            ? normalizeToUsdMinor(totalMinor, currency, snapshot)
            : undefined,
          fxRate: snapshot?.fxRate,
          fxRateAt: snapshot?.fxRateAt,
          fxSource: snapshot?.fxSource,
          sourceUrl: args.supplier.sourceUrl,
        });
      }
    }

    // Link the supplier to this request with an RFQ draft, whether or not it
    // has a price or an address. Without this row a discovered supplier has
    // nothing tying it to the request, so it never reaches the board and the
    // send gate has nothing to approve — which is exactly how a request could
    // sit at "awaiting approval" with an empty screen.
    const existingDraft = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId_and_supplierId", (q) =>
        q.eq("requestId", args.requestId).eq("supplierId", supplierId),
      )
      .first();

    if (!existingDraft) {
      const request = await ctx.db.get("requests", args.requestId);
      if (request) {
        const items = await ctx.db
          .query("lineItems")
          .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
          .take(20);

        const contact = await ctx.db
          .query("contacts")
          .withIndex("by_supplierId", (q) => q.eq("supplierId", supplierId))
          .first();

        await ctx.db.insert("rfqs", {
          requestId: args.requestId,
          supplierId,
          contactId: contact?._id,
          status: "draft",
          subject: `Request for quotation — ${request.title}`,
          body: composeRfqBody({
            supplierName: args.supplier.name,
            title: request.title,
            items: items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
            })),
            deliverTo: request.deliverTo,
            deliveryWindowDays: request.deliveryWindowDays,
            budget:
              request.budgetMinor !== undefined
                ? formatMoney(request.budgetMinor, request.currency)
                : undefined,
          }),
          chaseCount: 0,
        });
      }
    }

    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "supplier.discovered",
      message: `${args.supplier.name} (${args.supplier.domain})${
        args.supplier.email ? "" : " — no email found"
      }`,
    });
    return null;
  },
});

export const finishDiscovery = internalMutation({
  args: { requestId: v.id("requests"), supplierCount: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("requests", args.requestId, {
      status: "awaiting_approval",
    });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "discovery.complete",
      message: `Discovery finished with ${args.supplierCount} supplier(s). Awaiting your approval to send.`,
    });
    return null;
  },
});

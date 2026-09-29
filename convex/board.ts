import { v } from "convex/values";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireRequestOwner } from "./lib/authz";

/**
 * The comparison board — the one query that merges the two quote tracks
 * (PLAN.md §3).
 *
 * Per supplier: an emailed quote always wins over a crawled one, and a
 * superseded crawled row never surfaces. Rows appear within seconds as
 * `web price`, then upgrade to `confirmed` in front of the viewer when a real
 * reply lands. Reactive by construction — no polling, no refresh.
 */
export const forRequest = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    const quotes = await ctx.db
      .query("quotes")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(200);

    // One winner per supplier: emailed beats crawled, newer beats older.
    const best = new Map<Id<"suppliers">, Doc<"quotes">>();
    for (const quote of quotes) {
      if (quote.supersededBy) continue;
      const held = best.get(quote.supplierId);
      if (!held || outranks(quote, held)) {
        best.set(quote.supplierId, quote);
      }
    }

    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);
    const rfqBySupplier = new Map(rfqs.map((rfq) => [rfq.supplierId, rfq]));

    // Suppliers we contacted but who have not priced anything yet still belong
    // on the board — silence is information too.
    const supplierIds = new Set<Id<"suppliers">>([
      ...best.keys(),
      ...rfqs.map((rfq) => rfq.supplierId),
    ]);

    const rows = await Promise.all(
      [...supplierIds].map(async (supplierId) => {
        const supplier = await ctx.db.get("suppliers", supplierId);
        const quote = best.get(supplierId) ?? null;
        const rfq = rfqBySupplier.get(supplierId) ?? null;

        return {
          supplierId,
          supplierName: supplier?.name ?? "Unknown supplier",
          supplierDomain: supplier?.domain ?? "",
          websiteUrl: supplier?.websiteUrl ?? null,
          // What the viewer reads. "awaiting" means we actually asked and are
          // waiting; a supplier we merely drafted is "no price" — claiming to
          // be waiting on a reply we never sent would be a lie on the board.
          track: quote
            ? quote.source === "emailed"
              ? ("confirmed" as const)
              : ("web price" as const)
            : rfq && (rfq.status === "sent" || rfq.status === "replied")
              ? ("awaiting" as const)
              : ("no price" as const),
          confidence: quote?.confidence ?? null,
          totalMinor: quote?.totalMinor ?? null,
          currency: quote?.currency ?? null,
          normalizedUsdMinor: quote?.normalizedUsdMinor ?? null,
          fxRate: quote?.fxRate ?? null,
          fxRateAt: quote?.fxRateAt ?? null,
          fxSource: quote?.fxSource ?? null,
          vatIncluded: quote?.vatIncluded ?? null,
          incoterm: quote?.incoterm ?? null,
          leadTimeDays: quote?.leadTimeDays ?? null,
          warrantyMonths: quote?.warrantyMonths ?? null,
          sourceUrl: quote?.sourceUrl ?? null,
          quoteId: quote?._id ?? null,
          rfqStatus: rfq?.status ?? null,
          sentAt: rfq?.sentAt ?? null,
          repliedAt: rfq?.repliedAt ?? null,
        };
      }),
    );

    // Confirmed first, then priced crawled rows, then the silent ones. Within a
    // group, cheapest in comparable terms leads.
    return rows.sort((a, b) => {
      const rank = trackRank(a.track) - trackRank(b.track);
      if (rank !== 0) return rank;
      const aCost = a.normalizedUsdMinor ?? a.totalMinor ?? Infinity;
      const bCost = b.normalizedUsdMinor ?? b.totalMinor ?? Infinity;
      return aCost - bCost;
    });
  },
});

function outranks(candidate: Doc<"quotes">, held: Doc<"quotes">): boolean {
  if (candidate.source === held.source) {
    return candidate._creationTime > held._creationTime;
  }
  return candidate.source === "emailed";
}

function trackRank(
  track: "confirmed" | "web price" | "awaiting" | "no price",
): number {
  if (track === "confirmed") return 0;
  if (track === "web price") return 1;
  if (track === "awaiting") return 2;
  return 3;
}

/** Quote-level detail for the row expander, including the FX snapshot. */
export const quoteLines = query({
  args: { quoteId: v.id("quotes") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("quoteLines")
      .withIndex("by_quoteId", (q) => q.eq("quoteId", args.quoteId))
      .take(50);
  },
});

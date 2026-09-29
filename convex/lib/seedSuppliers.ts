/**
 * Hand-verified fallback suppliers (PLAN.md §7, Week 2).
 *
 * Purpose: when Firecrawl search returns nothing — rate limit, outage, an
 * unlucky query — discovery degrades to this list instead of collapsing and
 * leaving a judge staring at an empty board.
 *
 * DELIBERATELY EMPTY. These entries become real outbound email targets, so
 * every row must be a supplier whose site and address you have opened and
 * confirmed yourself. Do not populate this from a model, and do not guess an
 * address from a company name — a wrong address is a cold email to a stranger
 * sent under your domain's reputation.
 *
 * Target: ~20 real IT suppliers, Uganda and regional, plus a few international
 * distributors so a judge in San Francisco sees names they half-recognise.
 * Contact addresses are discovered and MX-verified by the pipeline; keep this
 * list to identity only.
 */
export type SeedSupplier = {
  name: string;
  /** Registrable domain — must match what registrableDomain() returns. */
  domain: string;
  websiteUrl: string;
  country?: string;
};

export const SEED_SUPPLIERS: SeedSupplier[] = [];

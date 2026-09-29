import { FxSnapshot } from "./money";

// A quote that silently changes value when the shilling moves is a bug you
// will not find at 2am on the 21st (PLAN.md §4). So every normalization takes
// a snapshot: the rate, when it was read, and who said so. Stored on the quote.

// Keyless public endpoint returning USD-based rates. Swap the provider here if
// it rate-limits during the build; nothing else needs to change.
const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
const FX_SOURCE = "open.er-api.com";

/**
 * Rates as units of the quoted currency per 1 USD, taken once per pipeline run
 * and reused for every quote written by that run.
 */
export async function fetchUsdRates(): Promise<Record<string, FxSnapshot>> {
  const response = await fetch(FX_ENDPOINT);
  if (!response.ok) {
    throw new Error(`FX lookup failed: ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("FX lookup returned a non-object payload");
  }
  const rates = (body as { rates?: unknown }).rates;
  if (typeof rates !== "object" || rates === null) {
    throw new Error("FX lookup returned no rates");
  }

  const at = Date.now();
  const snapshots: Record<string, FxSnapshot> = {};
  for (const [currency, rate] of Object.entries(rates as Record<string, unknown>)) {
    if (typeof rate === "number" && rate > 0) {
      snapshots[currency.toUpperCase()] = {
        fxRate: rate,
        fxRateAt: at,
        fxSource: FX_SOURCE,
      };
    }
  }
  return snapshots;
}

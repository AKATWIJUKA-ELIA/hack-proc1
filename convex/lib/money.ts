// Money helpers. Every amount in this app is an integer count of minor units.
// Nothing here rounds a price into a float and hands it onward.

// ISO 4217 minor-unit exponents for the currencies this demo actually meets.
// UGX and KES quote whole shillings; getting this wrong inflates a quote 100x.
const EXPONENTS: Record<string, number> = {
  UGX: 0,
  KES: 2,
  TZS: 2,
  RWF: 0,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  ZAR: 2,
};

export const DEFAULT_EXPONENT = 2;

export function exponentFor(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? DEFAULT_EXPONENT;
}

/** "180,000,000" UGX -> 180000000 minor units. Throws on a non-finite result. */
export function toMinor(amount: number, currency: string): number {
  const minor = Math.round(amount * 10 ** exponentFor(currency));
  if (!Number.isFinite(minor)) {
    throw new Error(`Cannot convert ${amount} ${currency} to minor units`);
  }
  return minor;
}

/** Minor units back to a display number. Presentation only — never store this. */
export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** exponentFor(currency);
}

export function formatMoney(minor: number, currency: string): string {
  const exponent = exponentFor(currency);
  return `${currency} ${fromMinor(minor, currency).toLocaleString(undefined, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })}`;
}

export type FxSnapshot = {
  fxRate: number;
  fxRateAt: number;
  fxSource: string;
};

/**
 * Normalize to USD minor units using an explicit rate snapshot.
 *
 * The snapshot is stored on the quote alongside the result (PLAN.md §4) so a
 * comparison made today can still be explained next week. `fxRate` is units of
 * `currency` per 1 USD.
 */
export function normalizeToUsdMinor(
  amountMinor: number,
  currency: string,
  snapshot: FxSnapshot,
): number {
  if (currency.toUpperCase() === "USD") return amountMinor;
  if (!(snapshot.fxRate > 0)) {
    throw new Error(`Invalid FX rate for ${currency}: ${snapshot.fxRate}`);
  }
  const major = fromMinor(amountMinor, currency) / snapshot.fxRate;
  return toMinor(major, "USD");
}

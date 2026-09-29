// Supplier dedupe key. Two crawled pages on the same site must collapse into
// one supplier row, or the board shows the same company three times.

// Multi-part public suffixes this demo's geography actually hits. A full PSL
// is overkill here; extend this list rather than guessing at parse time.
const MULTIPART_SUFFIXES = new Set([
  "co.ug",
  "or.ug",
  "ac.ug",
  "co.ke",
  "co.tz",
  "co.za",
  "co.uk",
  "com.au",
]);

/**
 * Registrable domain for a URL or bare host: the dedupe key for `suppliers`.
 * "https://shop.dell.co.ug/pricing" -> "dell.co.ug". Returns null when the
 * input is not a usable host, so callers can drop the candidate honestly
 * instead of inventing a key.
 */
export function registrableDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;

  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split("/")[0];
  }

  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!host.includes(".") || /\s/.test(host)) return null;

  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return null;

  const lastTwo = parts.slice(-2).join(".");
  if (MULTIPART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/** Domain of an email address, for matching a reply back to a supplier. */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  return registrableDomain(email.slice(at + 1));
}

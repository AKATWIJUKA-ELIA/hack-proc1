export type MxVerification = "unverified" | "mx_valid" | "mx_invalid";

/**
 * MX check over DNS-over-HTTPS. A domain with no MX record cannot receive the
 * RFQ, and saying so is better than a silent bounce three days later.
 *
 * A plain async helper rather than an action, so both the discovery pipeline
 * and the manual "add address" path can call it directly — actions should only
 * call other actions to cross runtimes.
 */
export async function verifyEmailMx(email: string): Promise<MxVerification> {
  const domain = email.split("@").pop();
  if (!domain) return "mx_invalid";

  try {
    const response = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!response.ok) return "unverified";

    const body: unknown = await response.json();
    const answers =
      typeof body === "object" && body !== null
        ? (body as { Answer?: unknown }).Answer
        : undefined;
    return Array.isArray(answers) && answers.length > 0
      ? "mx_valid"
      : "mx_invalid";
  } catch {
    // A DNS failure is not proof the address is bad.
    return "unverified";
  }
}

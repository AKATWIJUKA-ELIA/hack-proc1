/**
 * Svix webhook signature verification.
 *
 * We need this because AgentMail emits event types the component's schema
 * rejects (`message.received.unauthenticated` fails its `vEventType` union and
 * throws on insert), so those deliveries never reach our handler. To process
 * them ourselves we must verify the signature ourselves — the component's
 * verifier is not reachable, since the package's `exports` map exposes only the
 * client class and blocks deep imports.
 *
 * This is the standard Svix scheme: HMAC-SHA256 over `id.timestamp.body`,
 * keyed by the base64 material after the `whsec_` prefix.
 */

const TOLERANCE_MS = 5 * 60 * 1000;

export type SvixHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export function readSvixHeaders(request: Request): SvixHeaders {
  const get = (name: string, fallback: string) =>
    request.headers.get(name) ?? request.headers.get(fallback);
  return {
    id: get("svix-id", "webhook-id"),
    timestamp: get("svix-timestamp", "webhook-timestamp"),
    signature: get("svix-signature", "webhook-signature"),
  };
}

/**
 * Constant-time-ish comparison. Not a perfect defence in a JS runtime, but it
 * avoids the trivially timing-leaky `===` on secrets.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function verifySvixSignature(args: {
  secret: string;
  rawBody: string;
  headers: SvixHeaders;
  now?: number;
}): Promise<boolean> {
  const { id, timestamp, signature } = args.headers;
  if (!id || !timestamp || !signature) return false;

  // Reject replays of an old delivery.
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs((args.now ?? Date.now()) - sentAt) > TOLERANCE_MS) return false;

  const secret = args.secret.startsWith("whsec_")
    ? args.secret.slice("whsec_".length)
    : args.secret;

  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${args.rawBody}`),
  );
  const expected = bytesToBase64(signed);

  // The header carries one or more space-separated `v1,<signature>` entries.
  return signature
    .split(" ")
    .map((part) => part.split(",", 2))
    .some(([version, value]) => version === "v1" && safeEqual(value, expected));
}

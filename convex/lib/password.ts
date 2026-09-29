// Custom password hashing and session-token minting, built on the Web Crypto
// API that is available in Convex's default runtime — no "use node", no npm
// dependency. PBKDF2-HMAC-SHA256 with a per-user random salt; the stored form
// is `pbkdf2$<iterations>$<saltHex>$<hashHex>` so the parameters travel with the
// hash and can be raised later without breaking existing users.

const ITERATIONS = 100_000;
const KEY_LEN_BYTES = 32; // 256-bit derived key
const SALT_LEN_BYTES = 16;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LEN_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a plaintext password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN_BYTES));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/**
 * Verify a plaintext password against a stored hash. Constant-time comparison
 * on the derived bytes so a mismatch does not leak timing about how far the
 * comparison got.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** A 256-bit URL-safe opaque session token. Unguessable; the bearer credential. */
export function generateSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Custom bearer-token authorization. There is no JWT provider, so
 * ctx.auth.getUserIdentity() is unavailable; instead the client presents an
 * opaque session token (minted in auth.ts, stored hashed-random in `sessions`)
 * and the server resolves it to a user here. The token is an unguessable
 * credential, not a user identifier — so this is bearer auth, not the
 * "trust a userId arg" anti-pattern.
 */

export type Ctx = QueryCtx | MutationCtx;

/** Resolve a session token to its live user, or null if invalid/expired. */
export async function getUserBySession(
  ctx: Ctx,
  sessionToken: string | undefined | null,
): Promise<Doc<"users"> | null> {
  if (!sessionToken) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", sessionToken))
    .unique();
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  return await ctx.db.get("users", session.userId);
}

/** Require a signed-in user; throw a clear auth error otherwise. */
export async function requireUser(
  ctx: Ctx,
  sessionToken: string | undefined | null,
): Promise<Doc<"users">> {
  const user = await getUserBySession(ctx, sessionToken);
  if (!user) throw new Error("Not signed in. Please sign in and try again.");
  return user;
}

/**
 * Require that the caller owns the given request. Every public function that
 * takes a requestId funnels through this so child data (line items, RFQs,
 * quotes, recommendations, inbound replies) is protected at the one entry point
 * they all hang off.
 */
export async function requireRequestOwner(
  ctx: Ctx,
  sessionToken: string | undefined | null,
  requestId: Id<"requests">,
): Promise<{ user: Doc<"users">; request: Doc<"requests"> }> {
  const user = await requireUser(ctx, sessionToken);
  const request = await ctx.db.get("requests", requestId);
  if (!request) throw new Error("That request no longer exists.");
  if (request.userId !== user._id) {
    throw new Error("You do not have access to that request.");
  }
  return { user, request };
}

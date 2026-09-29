import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
} from "./lib/password";
import { getUserBySession } from "./lib/authz";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Shape returned to the client on a successful auth. Never includes the hash. */
const authResult = v.object({
  token: v.string(),
  user: v.object({
    _id: v.id("users"),
    email: v.string(),
    name: v.union(v.string(), v.null()),
  }),
});

/**
 * Create an account and open a session. Fails if the email is already taken.
 * The password is hashed (PBKDF2) before it touches the database.
 */
export const signUp = mutation({
  args: {
    email: v.string(),
    password: v.string(),
    name: v.optional(v.string()),
  },
  returns: authResult,
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    if (!EMAIL_RE.test(email)) {
      throw new Error("Enter a valid email address.");
    }
    if (args.password.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) {
      throw new Error("An account with that email already exists.");
    }

    const passwordHash = await hashPassword(args.password);
    const name = args.name?.trim() || undefined;
    const userId: Id<"users"> = await ctx.db.insert("users", {
      email,
      name,
      passwordHash,
    });

    const token = generateSessionToken();
    await ctx.db.insert("sessions", {
      userId,
      token,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    return {
      token,
      user: { _id: userId, email, name: name ?? null },
    };
  },
});

/** Verify credentials and open a session. Same error for both failure modes. */
export const signIn = mutation({
  args: { email: v.string(), password: v.string() },
  returns: authResult,
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    // Uniform error whether the email is unknown or the password is wrong, so
    // the response does not reveal which emails have accounts.
    const invalid = new Error("Incorrect email or password.");
    if (!user) {
      // Still spend the hashing cost to blunt timing-based user enumeration.
      await verifyPassword(args.password, "pbkdf2$100000$00$00");
      throw invalid;
    }
    const ok = await verifyPassword(args.password, user.passwordHash);
    if (!ok) throw invalid;

    const token = generateSessionToken();
    await ctx.db.insert("sessions", {
      userId: user._id,
      token,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    return {
      token,
      user: { _id: user._id, email: user.email, name: user.name ?? null },
    };
  },
});

/** End the current session. Idempotent — an unknown token is a no-op. */
export const signOut = mutation({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.sessionToken))
      .unique();
    if (session) await ctx.db.delete("sessions", session._id);
    return null;
  },
});

/**
 * The current user for a session token, or null. Reactive — the client uses it
 * to decide between the auth screen and the app, and it flips to null the moment
 * the session is deleted or expires.
 */
export const me = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(
    v.object({
      _id: v.id("users"),
      email: v.string(),
      name: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await getUserBySession(ctx, args.sessionToken);
    if (!user) return null;
    return { _id: user._id, email: user.email, name: user.name ?? null };
  },
});

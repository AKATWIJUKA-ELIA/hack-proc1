import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requestStatus } from "./schema";
import { recordEvent } from "./lib/events";
import { requireUser, requireRequestOwner } from "./lib/authz";

/**
 * Step 1 of the demo spine: state the need. Free text in, a request row out,
 * with extraction scheduled behind it. The structured spec does not exist yet
 * when this returns — the UI subscribes and watches it fill in.
 */
export const create = mutation({
  args: {
    sessionToken: v.string(),
    rawText: v.string(),
    deliverTo: v.string(),
    currency: v.string(),
  },
  returns: v.id("requests"),
  handler: async (ctx, args): Promise<Id<"requests">> => {
    const user = await requireUser(ctx, args.sessionToken);
    const rawText = args.rawText.trim();
    if (rawText.length < 10) {
      throw new Error("Describe what you need in a sentence or two.");
    }

    const requestId = await ctx.db.insert("requests", {
      userId: user._id,
      // A readable placeholder until extraction names the request properly.
      title: rawText.slice(0, 60),
      rawText,
      status: "extracting",
      deliverTo: args.deliverTo,
      currency: args.currency.toUpperCase(),
      // budget and delivery window are extracted, not typed in.
    });

    await recordEvent(ctx, {
      requestId,
      kind: "request.created",
      message: "Request received, extracting the specification.",
    });

    await ctx.scheduler.runAfter(0, internal.intake.extractSpec, { requestId });
    return requestId;
  },
});

/**
 * Retry a request that failed, resuming from the stage it actually died at.
 *
 * Extraction and supplier search both fail for transient reasons — a rate
 * limit, a bad gateway, a search that returned nothing. Re-typing the whole
 * requirement to recover from that is not a reasonable ask, so this restarts
 * the pipeline in place. If the spec was already extracted, it does not pay
 * for extraction again; it goes straight back to discovery.
 */
export const retry = mutation({
  args: { sessionToken: v.string(), requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { request } = await requireRequestOwner(
      ctx,
      args.sessionToken,
      args.requestId,
    );
    if (request.status !== "failed") {
      throw new Error("This request has not failed, so there is nothing to retry.");
    }

    const existingItems = await ctx.db
      .query("lineItems")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(1);

    if (existingItems.length > 0) {
      await ctx.db.patch("requests", args.requestId, {
        status: "discovering",
        failureReason: undefined,
      });
      await recordEvent(ctx, {
        requestId: args.requestId,
        kind: "request.retry",
        message: "Retrying supplier search.",
      });
      await ctx.scheduler.runAfter(0, internal.discovery.startDiscovery, {
        requestId: args.requestId,
      });
      return null;
    }

    await ctx.db.patch("requests", args.requestId, {
      status: "extracting",
      failureReason: undefined,
    });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "request.retry",
      message: "Retrying extraction of the requirement.",
    });
    await ctx.scheduler.runAfter(0, internal.intake.extractSpec, {
      requestId: args.requestId,
    });
    return null;
  },
});

export const get = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    const { request } = await requireRequestOwner(
      ctx,
      args.sessionToken,
      args.requestId,
    );
    return request;
  },
});

export const list = query({
  args: { sessionToken: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx, args.sessionToken);
    const requests = await ctx.db
      .query("requests")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));

    // Confirmed-reply count per request, so the history can show at a glance
    // which one a supplier actually answered. Bounded per request; the board
    // remains the place for detail.
    return await Promise.all(
      requests.map(async (request) => {
        const quotes = await ctx.db
          .query("quotes")
          .withIndex("by_requestId", (q) => q.eq("requestId", request._id))
          .take(50);
        return {
          ...request,
          confirmedQuotes: quotes.filter(
            (quote) => quote.source === "emailed" && !quote.supersededBy,
          ).length,
        };
      }),
    );
  },
});

export const lineItems = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    return await ctx.db
      .query("lineItems")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);
  },
});

/** Recent audit trail for one request. The table stays; the full screen was cut. */
export const timeline = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    return await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(30);
  },
});

export const loadInternal = internalQuery({
  args: { requestId: v.id("requests") },
  handler: async (ctx, args) => {
    return await ctx.db.get("requests", args.requestId);
  },
});

export const setStatus = internalMutation({
  args: {
    requestId: v.id("requests"),
    status: requestStatus,
    failureReason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("requests", args.requestId, {
      status: args.status,
      failureReason: args.failureReason,
    });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: `request.${args.status}`,
      message: args.failureReason ?? `Request moved to ${args.status}.`,
    });
    return null;
  },
});

/**
 * Commit the extracted specification and hand off to discovery. One mutation so
 * the line items, the header facts, and the status move together or not at all.
 */
export const saveSpec = internalMutation({
  args: {
    requestId: v.id("requests"),
    title: v.string(),
    budgetMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    deliveryWindowDays: v.optional(v.number()),
    items: v.array(
      v.object({
        description: v.string(),
        quantity: v.number(),
        unit: v.optional(v.string()),
        specs: v.optional(v.record(v.string(), v.string())),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get("requests", args.requestId);
    if (!request) throw new Error("Request no longer exists");

    for (const item of args.items) {
      await ctx.db.insert("lineItems", {
        requestId: args.requestId,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        specs: item.specs,
      });
    }

    await ctx.db.patch("requests", args.requestId, {
      title: args.title,
      budgetMinor: args.budgetMinor,
      currency: args.currency?.toUpperCase() ?? request.currency,
      deliveryWindowDays: args.deliveryWindowDays,
      status: "discovering",
    });

    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "request.extracted",
      message: `Extracted ${args.items.length} line item(s); discovering suppliers.`,
    });

    await ctx.scheduler.runAfter(0, internal.discovery.startDiscovery, {
      requestId: args.requestId,
    });
    return null;
  },
});

export const setWorkflowId = internalMutation({
  args: { requestId: v.id("requests"), workflowId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("requests", args.requestId, {
      discoveryWorkflowId: args.workflowId,
    });
    return null;
  },
});

import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  env,
} from "./_generated/server";
import { createInboxViaRest, sendMessageViaRest } from "./lib/agentmailRest";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { MAX_RECIPIENTS } from "./lib/agentmail";
import { recordEvent } from "./lib/events";
import { verifyEmailMx } from "./lib/mx";
import { requireRequestOwner } from "./lib/authz";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHASE_SCHEDULE_MS = [3 * DAY_MS, 7 * DAY_MS];

/**
 * Supply a contact address by hand.
 *
 * Contact extraction misses often — a 0-for-3 run is a normal afternoon, and
 * the plan budgets real days for it. Without this, a request whose suppliers
 * all came back "no email found" reaches "awaiting approval" with nothing to
 * approve and no way forward. This is that way forward.
 */
export const addContact = mutation({
  args: {
    sessionToken: v.string(),
    rfqId: v.id("rfqs"),
    email: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    // Deliberately loose: a real address the parser dislikes is worse than a
    // typo the supplier bounces. MX verification below is the real check.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("That does not look like an email address.");
    }

    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) throw new Error("That draft no longer exists.");
    await requireRequestOwner(ctx, args.sessionToken, rfq.requestId);
    // "failed" is editable too: a send that failed on a bad address is exactly
    // the case where the address needs changing before the retry.
    if (rfq.status !== "draft" && rfq.status !== "failed") {
      throw new Error("This RFQ has already been approved or sent.");
    }

    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    const contactId =
      existing?._id ??
      (await ctx.db.insert("contacts", {
        supplierId: rfq.supplierId,
        email,
        verification: "unverified",
      }));

    await ctx.db.patch("rfqs", args.rfqId, { contactId });

    const supplier = await ctx.db.get("suppliers", rfq.supplierId);
    await recordEvent(ctx, {
      requestId: rfq.requestId,
      kind: "contact.added",
      message: `Address added by hand for ${supplier?.name ?? "a supplier"}.`,
    });

    // MX check costs a DNS lookup and no model tokens, so it always runs.
    await ctx.scheduler.runAfter(0, internal.rfqs.verifyContact, { contactId });
    return null;
  },
});

/**
 * Detach the address from a draft, so a wrong or unwanted one can be removed
 * before anything is approved. The contact row itself is left alone — other
 * requests may reference the same supplier.
 */
export const clearContact = mutation({
  args: { sessionToken: v.string(), rfqId: v.id("rfqs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) throw new Error("That draft no longer exists.");
    await requireRequestOwner(ctx, args.sessionToken, rfq.requestId);
    // "failed" is editable too: a send that failed on a bad address is exactly
    // the case where the address needs changing before the retry.
    if (rfq.status !== "draft" && rfq.status !== "failed") {
      throw new Error("This RFQ has already been approved or sent.");
    }
    await ctx.db.patch("rfqs", args.rfqId, { contactId: undefined });
    return null;
  },
});

export const verifyContact = internalAction({
  args: { contactId: v.id("contacts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const contact = await ctx.runQuery(internal.rfqs.loadContact, {
      contactId: args.contactId,
    });
    if (!contact) return null;

    const verification = await verifyEmailMx(contact.email);
    await ctx.runMutation(internal.rfqs.setContactVerification, {
      contactId: args.contactId,
      verification,
    });
    return null;
  },
});

export const loadContact = internalQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args): Promise<Doc<"contacts"> | null> => {
    return await ctx.db.get("contacts", args.contactId);
  },
});

export const setContactVerification = internalMutation({
  args: {
    contactId: v.id("contacts"),
    verification: v.union(
      v.literal("unverified"),
      v.literal("mx_valid"),
      v.literal("mx_invalid"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("contacts", args.contactId, {
      verification: args.verification,
      verifiedAt: Date.now(),
    });
    return null;
  },
});

/** The exact recipient list the human approves. Shown verbatim in the gate. */
export const listForRequest = query({
  args: { sessionToken: v.optional(v.string()), requestId: v.id("requests") },
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);

    return await Promise.all(
      rfqs.map(async (rfq) => {
        const supplier = await ctx.db.get("suppliers", rfq.supplierId);
        const contact = rfq.contactId
          ? await ctx.db.get("contacts", rfq.contactId)
          : null;
        return {
          _id: rfq._id,
          status: rfq.status,
          subject: rfq.subject,
          body: rfq.body,
          chaseCount: rfq.chaseCount,
          sentAt: rfq.sentAt,
          repliedAt: rfq.repliedAt,
          failureReason: rfq.failureReason ?? null,
          supplierName: supplier?.name ?? "Unknown supplier",
          supplierDomain: supplier?.domain ?? "",
          email: contact?.email ?? null,
          verification: contact?.verification ?? "unverified",
        };
      }),
    );
  },
});

/**
 * The one human checkpoint (PLAN.md §4). `sent` is unreachable except through
 * this mutation, and the five-supplier cap lives here rather than in the UI so
 * it cannot be clicked around.
 */
export const approveAndSend = mutation({
  args: {
    sessionToken: v.string(),
    requestId: v.id("requests"),
    rfqIds: v.array(v.id("rfqs")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    if (args.rfqIds.length === 0) {
      throw new Error("Select at least one supplier to contact.");
    }
    if (args.rfqIds.length > MAX_RECIPIENTS) {
      throw new Error(
        `Nothing goes to more than ${MAX_RECIPIENTS} suppliers at once.`,
      );
    }

    const approvedAt = Date.now();
    for (const rfqId of args.rfqIds) {
      const rfq = await ctx.db.get("rfqs", rfqId);
      if (!rfq) throw new Error("That draft no longer exists.");
      if (rfq.requestId !== args.requestId) {
        throw new Error("That draft belongs to a different request.");
      }
      if (rfq.status !== "draft") continue;
      // Approving a supplier with no address would move it to "approved" and
      // then silently drop it at dispatch. Refuse it here instead, where the
      // person clicking can still do something about it.
      if (!rfq.contactId) {
        throw new Error(
          "One of the selected suppliers has no email address. Add one first.",
        );
      }

      await ctx.db.patch("rfqs", rfqId, { status: "approved", approvedAt });
    }

    await ctx.db.patch("requests", args.requestId, { status: "collecting" });
    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "rfq.approved",
      message: `Approved ${args.rfqIds.length} RFQ(s) for sending.`,
    });

    await ctx.scheduler.runAfter(0, internal.rfqs.sendApproved, {
      requestId: args.requestId,
    });
    return null;
  },
});

/** Approved RFQs paired with the address each one goes to. */
export const listApprovedWithContacts = internalQuery({
  args: { requestId: v.id("requests") },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      rfqId: Id<"rfqs">;
      email: string;
      subject: string;
      body: string;
      inboxId?: string;
    }>
  > => {
    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);

    const out = [];
    for (const rfq of rfqs) {
      if (rfq.status !== "approved") continue;
      if (!rfq.contactId) continue;
      const contact = await ctx.db.get("contacts", rfq.contactId);
      if (!contact) continue;
      out.push({
        rfqId: rfq._id,
        email: contact.email,
        subject: rfq.subject,
        body: rfq.body,
        inboxId: rfq.inboxId,
      });
    }
    return out;
  },
});

/**
 * Resolve an inbox, then send each approved RFQ.
 *
 * This is an action rather than a mutation because the send goes out over
 * plain REST — see lib/agentmailRest.ts for why the component cannot do it.
 * Each recipient is isolated: one failure is recorded against its own RFQ and
 * the rest still go.
 */
export const sendApproved = internalAction({
  args: { requestId: v.id("requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const approved = await ctx.runQuery(
      internal.rfqs.listApprovedWithContacts,
      { requestId: args.requestId },
    );
    if (approved.length === 0) return null;

    if (!env.AGENTMAIL_API_KEY) {
      await ctx.runMutation(internal.rfqs.markSendFailed, {
        requestId: args.requestId,
        reason:
          "AGENTMAIL_API_KEY is not set on this deployment. Run " +
          "`npx convex env set AGENTMAIL_API_KEY <key>`.",
      });
      return null;
    }

    // Precedence: an inbox this request already used, then a configured
    // shared inbox, then create one.
    let inboxId = approved.find((rfq) => rfq.inboxId)?.inboxId ?? env.AGENTMAIL_INBOX_ID;

    try {
      if (!inboxId) {
        const created = await createInboxViaRest({
          apiKey: env.AGENTMAIL_API_KEY,
          baseUrl: env.AGENTMAIL_BASE_URL,
          displayName: "Quotebook RFQ",
          clientId: args.requestId,
        });
        inboxId = created.inboxId;
      }
    } catch (error) {
      await ctx.runMutation(internal.rfqs.markSendFailed, {
        requestId: args.requestId,
        reason: `Could not open a mailbox: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return null;
    }

    for (const rfq of approved) {
      try {
        const sent = await sendMessageViaRest({
          apiKey: env.AGENTMAIL_API_KEY,
          baseUrl: env.AGENTMAIL_BASE_URL,
          inboxId,
          to: rfq.email,
          subject: rfq.subject,
          text: rfq.body,
          labels: ["rfq", `request:${args.requestId}`],
        });
        await ctx.runMutation(internal.rfqs.markSent, {
          rfqId: rfq.rfqId,
          inboxId,
          threadId: sent.threadId,
          outboundId: sent.messageId,
          email: rfq.email,
        });
      } catch (error) {
        await ctx.runMutation(internal.rfqs.markRfqFailed, {
          rfqId: rfq.rfqId,
          inboxId,
          reason: `Send to ${rfq.email} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    return null;
  },
});

export const markSent = internalMutation({
  args: {
    rfqId: v.id("rfqs"),
    inboxId: v.string(),
    threadId: v.optional(v.string()),
    outboundId: v.optional(v.string()),
    email: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) return null;

    await ctx.db.patch("rfqs", args.rfqId, {
      status: "sent",
      sentAt: Date.now(),
      inboxId: args.inboxId,
      threadId: args.threadId,
      outboundId: args.outboundId,
      failureReason: undefined,
    });
    await recordEvent(ctx, {
      requestId: rfq.requestId,
      kind: "rfq.sent",
      message: `RFQ sent to ${args.email}`,
    });

    // Automatic chase-up on a silent RFQ.
    for (const delay of CHASE_SCHEDULE_MS) {
      await ctx.scheduler.runAfter(delay, internal.rfqs.chase, {
        rfqId: args.rfqId,
      });
    }
    return null;
  },
});

export const markRfqFailed = internalMutation({
  args: {
    rfqId: v.id("rfqs"),
    inboxId: v.optional(v.string()),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) return null;
    await ctx.db.patch("rfqs", args.rfqId, {
      status: "failed",
      inboxId: args.inboxId ?? rfq.inboxId,
      failureReason: args.reason,
    });
    await recordEvent(ctx, {
      requestId: rfq.requestId,
      kind: "rfq.send_failed",
      message: args.reason,
    });
    return null;
  },
});

/** Mark every still-approved RFQ on a request as failed, with the reason. */
export const markSendFailed = internalMutation({
  args: { requestId: v.id("requests"), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);

    let failed = 0;
    for (const rfq of rfqs) {
      if (rfq.status !== "approved") continue;
      await ctx.db.patch("rfqs", rfq._id, {
        status: "failed",
        failureReason: args.reason,
      });
      failed += 1;
    }

    if (failed > 0) {
      await recordEvent(ctx, {
        requestId: args.requestId,
        kind: "rfq.send_failed",
        message: `${failed} RFQ(s) could not be sent. ${args.reason}`,
      });
    }
    return null;
  },
});

/**
 * Retry the sends that failed.
 *
 * The human already approved these exact recipients, and a transport failure
 * does not undo that — so this puts them back to `approved` and runs the send
 * again rather than making someone re-tick the same boxes. The five-supplier
 * cap was applied at approval and still holds.
 */
export const retrySend = mutation({
  args: { sessionToken: v.string(), requestId: v.id("requests") },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    await requireRequestOwner(ctx, args.sessionToken, args.requestId);
    const rfqs = await ctx.db
      .query("rfqs")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .take(50);

    let recovered = 0;
    for (const rfq of rfqs) {
      if (rfq.status === "failed") {
        await ctx.db.patch("rfqs", rfq._id, {
          status: "approved",
          failureReason: undefined,
        });
        recovered += 1;
      } else if (rfq.status === "approved") {
        // Stalled, not failed: approved but never dispatched, because an older
        // send path could throw after approval without recording anything. The
        // request then claims to be waiting on replies forever. These are
        // exactly as retryable as the failed ones.
        recovered += 1;
      }
    }

    if (recovered === 0) return 0;

    await recordEvent(ctx, {
      requestId: args.requestId,
      kind: "rfq.retry",
      message: `Retrying ${recovered} RFQ(s) that never sent.`,
    });
    await ctx.scheduler.runAfter(0, internal.rfqs.sendApproved, {
      requestId: args.requestId,
    });
    return recovered;
  },
});

/** One RFQ plus its address, for a scheduled chase-up. */
export const loadRfqForChase = internalQuery({
  args: { rfqId: v.id("rfqs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    requestId: Id<"requests">;
    email: string;
    subject: string;
    body: string;
    inboxId: string;
    chaseCount: number;
  } | null> => {
    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) return null;
    // Silent RFQs only, and never more than the schedule allows.
    if (rfq.status !== "sent") return null;
    if (rfq.chaseCount >= CHASE_SCHEDULE_MS.length) return null;
    if (!rfq.inboxId || !rfq.contactId) return null;

    const contact = await ctx.db.get("contacts", rfq.contactId);
    if (!contact) return null;

    return {
      requestId: rfq.requestId,
      email: contact.email,
      subject: rfq.subject,
      body: rfq.body,
      inboxId: rfq.inboxId,
      chaseCount: rfq.chaseCount,
    };
  },
});

/** Nudge a supplier that has not replied. An action, because sending is REST. */
export const chase = internalAction({
  args: { rfqId: v.id("rfqs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfq = await ctx.runQuery(internal.rfqs.loadRfqForChase, {
      rfqId: args.rfqId,
    });
    if (!rfq) return null;
    if (!env.AGENTMAIL_API_KEY) return null;

    try {
      await sendMessageViaRest({
        apiKey: env.AGENTMAIL_API_KEY,
        baseUrl: env.AGENTMAIL_BASE_URL,
        inboxId: rfq.inboxId,
        to: rfq.email,
        subject: `Re: ${rfq.subject}`,
        text:
          "Following up on the request for quotation below — if you are able " +
          "to quote, a price and lead time is all we need.\n\n" +
          rfq.body,
        labels: ["rfq", "chase"],
      });
    } catch (error) {
      // A failed nudge is not worth failing the RFQ over; it already sent once.
      console.error("Chase-up failed", error);
      return null;
    }

    await ctx.runMutation(internal.rfqs.markChased, {
      rfqId: args.rfqId,
      email: rfq.email,
    });
    return null;
  },
});

export const markChased = internalMutation({
  args: { rfqId: v.id("rfqs"), email: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rfq = await ctx.db.get("rfqs", args.rfqId);
    if (!rfq) return null;
    await ctx.db.patch("rfqs", args.rfqId, {
      chaseCount: rfq.chaseCount + 1,
      lastChasedAt: Date.now(),
    });
    await recordEvent(ctx, {
      requestId: rfq.requestId,
      kind: "rfq.chased",
      message: `Followed up with ${args.email}.`,
    });
    return null;
  },
});

export const markReplied = internalMutation({
  args: { rfqId: v.id("rfqs"), threadId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("rfqs", args.rfqId, {
      status: "replied",
      repliedAt: Date.now(),
      threadId: args.threadId,
    });
    return null;
  },
});

import { httpRouter } from "convex/server";
import { httpAction, env } from "./_generated/server";
import { internal } from "./_generated/api";
import { agentmail } from "./lib/agentmail";
import { readSvixHeaders, verifySvixSignature } from "./lib/svix";

const http = httpRouter();

// Version skew, not a bug in either package: @agentmail/convex@0.1.0 declares
// its RunMutationCtx against a pre-1.41 Convex signature, before runMutation
// grew the optional `transactionLimits` argument, so a 1.45 action ctx is not
// structurally assignable to it. The runtime shape is exactly what it wants.
// Re-check on the next component release and drop the cast when it lands.
type AgentMailWebhookCtx = Parameters<typeof agentmail.handleWebhook>[0];

// The event types the component's own schema accepts. Anything outside this
// set throws on insert inside the component and the delivery fails, so those
// are handled here instead.
const COMPONENT_EVENT_TYPES = new Set([
  "message.received",
  "message.sent",
  "message.delivered",
  "message.bounced",
  "message.complained",
  "message.rejected",
  "domain.verified",
]);

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // Clone to inspect the body; the component needs the original request
    // intact, because the signature covers the exact bytes.
    const raw = await req.clone().text();
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through: the component will reject it.
    }

    const eventType =
      typeof payload?.event_type === "string" ? payload.event_type : null;

    // Known-good types keep their existing path through the component, which
    // verifies the signature and stores the message itself.
    if (eventType && COMPONENT_EVENT_TYPES.has(eventType)) {
      return agentmail.handleWebhook(ctx as unknown as AgentMailWebhookCtx, req);
    }

    // Everything else, we verify and route ourselves. AgentMail emits
    // `message.received.unauthenticated` for senders that fail email
    // authentication; the component's validator rejects it outright, so those
    // replies would otherwise be lost.
    if (!env.AGENTMAIL_WEBHOOK_SECRET) {
      return new Response("webhook secret not configured", { status: 500 });
    }

    const verified = await verifySvixSignature({
      secret: env.AGENTMAIL_WEBHOOK_SECRET,
      rawBody: raw,
      headers: readSvixHeaders(req),
    });
    if (!verified) {
      return new Response("invalid signature", { status: 401 });
    }

    if (eventType && eventType.startsWith("message.received")) {
      const eventId =
        typeof payload?.event_id === "string" ? payload.event_id : null;
      if (!eventId) {
        return new Response("missing event id", { status: 400 });
      }

      await ctx.runMutation(internal.inbound.onMessageReceived, {
        message: payload?.message ?? {},
        thread: payload?.thread ?? {},
        eventId,
        // A sender that failed SPF/DKIM/DMARC can be anyone. Its price is not
        // allowed to become a `confirmed` quote on the strength of an email
        // alone — it goes to the review queue for a human to look at.
        unauthenticated: true,
      });
      return new Response(null, { status: 204 });
    }

    // An event type we have no use for. Acknowledge it so AgentMail stops
    // retrying rather than leaving it to fail forever.
    return new Response(null, { status: 204 });
  }),
});

// Firecrawl's own webhook is mounted by the component at /firecrawl/ via the
// httpPrefix in convex.config.ts, so it needs no route here.
//
// The Next.js frontend is served by Next.js (not Convex), so there is no
// static-hosting catch-all route here any more — Convex only handles the API
// and the webhook endpoints above.

export default http;

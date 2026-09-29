import { AgentMail } from "@agentmail/convex";
import { components, internal } from "../_generated/api";

/**
 * One configured AgentMail client for the whole app.
 *
 * The `onMessageReceived` callback must be wired on the same instance that
 * handles the webhook, so sending and receiving share this module rather than
 * each constructing their own client and drifting apart.
 *
 * Credentials (AGENTMAIL_API_KEY, AGENTMAIL_WEBHOOK_SECRET) are read from the
 * deployment's env vars by the component itself and never passed through here.
 */
// The explicit annotation is load-bearing: this instance references `internal`,
// which is generated from the modules that import this one. Without it
// TypeScript reports a circular initializer and infers `any`.
export const agentmail: AgentMail = new AgentMail(components.agentmail, {
  onMessageReceived: internal.inbound.onMessageReceived,
});

/** Nothing leaves without a click, and never to more than this many suppliers. */
export const MAX_RECIPIENTS = 5;

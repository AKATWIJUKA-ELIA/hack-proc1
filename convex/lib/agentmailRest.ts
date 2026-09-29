/**
 * Direct AgentMail REST, used for inbox creation only.
 *
 * Why this exists: in @agentmail/convex@0.1.0 the client's inbox methods
 * (createInbox, listInboxes, getInbox, deleteInbox) call component functions
 * that the component declares `internal`. A parent app cannot resolve a
 * component's internal functions, so every one of those calls fails at runtime
 * with "Couldn't resolve agentmail.lib.createInbox" — verified by probing the
 * component directly: its `public` functions resolve, its `internal` ones do
 * not. Sending is unaffected, because `sendMessage` is backed by `enqueueSend`,
 * which is public.
 *
 * So the RFQ send path keeps using the component for everything it can, and
 * only borrows this one call. The request shape and base URL below are taken
 * from the component's own source, not guessed. Drop this file once upstream
 * exposes inbox management publicly.
 */

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export type CreatedInbox = { inboxId: string };

/**
 * Send a message.
 *
 * The component cannot do this either. Convex gives each component an isolated
 * environment: a component only sees env vars its own definition declares and
 * the app passes through. `defineComponent("agentmail")` declares none, so its
 * `process.env.AGENTMAIL_API_KEY` is always empty and the server rejects any
 * attempt to supply it ("Component agentmail has no env var named
 * AGENTMAIL_API_KEY"). Firecrawl works precisely because it declares typed env.
 *
 * Endpoint and payload below come from the component's own source
 * (eventLogic.sendPath, shared.vSendPayload). Inbound mail still flows through
 * the component, which needs no API key to store a webhook event.
 */
export async function sendMessageViaRest(args: {
  apiKey: string;
  baseUrl?: string;
  inboxId: string;
  to: string;
  subject: string;
  text: string;
  labels?: string[];
}): Promise<{ messageId?: string; threadId?: string }> {
  const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const path = `/inboxes/${encodeURIComponent(args.inboxId)}/messages/send`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      stripUndefined({
        to: [args.to],
        subject: args.subject,
        text: args.text,
        labels: args.labels,
      }),
    ),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AgentMail ${response.status}: ${detail.slice(0, 200)}`);
  }

  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  return {
    messageId:
      typeof record.message_id === "string" ? record.message_id : undefined,
    threadId:
      typeof record.thread_id === "string" ? record.thread_id : undefined,
  };
}

export async function createInboxViaRest(args: {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  /** Passed through as AgentMail's client_id, for tracing back to a request. */
  clientId?: string;
}): Promise<CreatedInbox> {
  const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  const response = await fetch(`${baseUrl}/inboxes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      stripUndefined({
        display_name: args.displayName,
        client_id: args.clientId,
      }),
    ),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `AgentMail ${response.status} creating inbox: ${detail.slice(0, 200)}`,
    );
  }

  const body: unknown = await response.json();
  const inboxId = readInboxId(body);
  if (!inboxId) {
    throw new Error("AgentMail did not return an inbox id");
  }
  return { inboxId };
}

function readInboxId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const key of ["inbox_id", "inboxId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Money rule (PLAN.md §4): never a float. Every amount below is an integer count
// of minor units (UGX 1 => 1, USD 1.99 => 199) held in a Float64, which is exact
// for integers up to 2^53 — far above any procurement total. Currency travels
// with every amount, and any USD normalization carries the FX snapshot that
// produced it so a quote cannot silently change value when the shilling moves.

export const quoteSource = v.union(v.literal("crawled"), v.literal("emailed"));

// Confidence is derived, never guessed (PLAN.md §4): "crawled" is always low,
// "emailed" is high once it came from a verified contact on a real thread.
export const confidence = v.union(v.literal("low"), v.literal("high"));

export const requestStatus = v.union(
  v.literal("draft"),
  v.literal("extracting"),
  v.literal("discovering"),
  v.literal("awaiting_approval"),
  v.literal("collecting"),
  v.literal("decided"),
  v.literal("failed"),
);

// The send gate is a status machine, not a flag (PLAN.md §4). "sent" is
// unreachable except through "approved", and only a human mutation writes that.
export const rfqStatus = v.union(
  v.literal("draft"),
  v.literal("approved"),
  v.literal("sent"),
  v.literal("replied"),
  v.literal("bounced"),
  v.literal("cancelled"),
  // A send that errored before it left. Distinct from `bounced`, which means
  // the mail left and the far side rejected it. Approval is already on record,
  // so a failed RFQ can be retried without asking the human again.
  v.literal("failed"),
);

// Parse is a state machine, not a function (PLAN.md §4). Nothing is silently
// dropped: every inbound message ends in one of the three terminal states.
export const parseState = v.union(
  v.literal("received"),
  v.literal("parsing"),
  v.literal("parsed"),
  v.literal("needs_review"),
  v.literal("not_a_quote"),
);

export const contactVerification = v.union(
  v.literal("unverified"),
  v.literal("mx_valid"),
  v.literal("mx_invalid"),
  v.literal("bounced"),
);

export default defineSchema({
  // Custom email + password auth (no third-party provider). Password is stored
  // only as a PBKDF2 hash (see lib/password.ts); the plaintext never lands here.
  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    passwordHash: v.string(),
  }).index("by_email", ["email"]),

  // Opaque bearer session tokens. `token` is unguessable random; the client
  // holds it and presents it on every call. `expiresAt` bounds its lifetime.
  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  // The procurement need: free text in, structured spec out.
  // Owned by the user who created it — reads and writes are scoped to the owner.
  // `userId` is optional only to tolerate rows created before auth existed; every
  // new request sets it, and requireRequestOwner denies access to any row whose
  // owner does not match the caller (a legacy row with no owner is invisible).
  requests: defineTable({
    userId: v.optional(v.id("users")),
    title: v.string(),
    rawText: v.string(),
    status: requestStatus,
    deliverTo: v.string(),
    deliveryWindowDays: v.optional(v.number()),
    budgetMinor: v.optional(v.number()),
    currency: v.string(),
    discoveryWorkflowId: v.optional(v.string()),
    failureReason: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_userId", ["userId"]),

  // One extracted spec line per item, by request.
  lineItems: defineTable({
    requestId: v.id("requests"),
    description: v.string(),
    quantity: v.number(),
    unit: v.optional(v.string()),
    specs: v.optional(v.record(v.string(), v.string())),
  })
    .index("by_requestId", ["requestId"])
    // Product lookup across past requests (PLAN.md §6).
    .searchIndex("search_description", { searchField: "description" }),

  // Discovered organisations, deduped by registrable domain.
  suppliers: defineTable({
    name: v.string(),
    domain: v.string(),
    websiteUrl: v.optional(v.string()),
    country: v.optional(v.string()),
    discoveredVia: v.union(v.literal("crawled"), v.literal("seed")),
    sourceUrl: v.optional(v.string()),
  })
    .index("by_domain", ["domain"])
    // Supplier lookup across past requests (PLAN.md §6).
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["country"],
    }),

  // Email addresses per supplier, with how far we trust each one.
  contacts: defineTable({
    supplierId: v.id("suppliers"),
    email: v.string(),
    role: v.optional(v.string()),
    verification: contactVerification,
    verifiedAt: v.optional(v.number()),
    sourceUrl: v.optional(v.string()),
  })
    .index("by_supplierId", ["supplierId"])
    .index("by_email", ["email"]),

  // One per (request, supplier). Holds the AgentMail inbox and thread.
  rfqs: defineTable({
    requestId: v.id("requests"),
    supplierId: v.id("suppliers"),
    contactId: v.optional(v.id("contacts")),
    status: rfqStatus,
    subject: v.string(),
    body: v.string(),
    inboxId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    outboundId: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    sentAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    chaseCount: v.number(),
    lastChasedAt: v.optional(v.number()),
    failureReason: v.optional(v.string()),
  })
    .index("by_requestId", ["requestId"])
    .index("by_requestId_and_supplierId", ["requestId", "supplierId"])
    .index("by_supplierId", ["supplierId"])
    .index("by_threadId", ["threadId"])
    .index("by_status", ["status"]),

  // The two-pass quote model (PLAN.md §3). A crawled row fills the board in
  // seconds; an emailed row supersedes it for that supplier when it lands.
  quotes: defineTable({
    requestId: v.id("requests"),
    supplierId: v.id("suppliers"),
    rfqId: v.optional(v.id("rfqs")),
    source: quoteSource,
    confidence: confidence,
    totalMinor: v.number(),
    currency: v.string(),
    vatIncluded: v.boolean(),
    incoterm: v.optional(v.string()),
    // USD normalization plus the snapshot of the rate that produced it.
    normalizedUsdMinor: v.optional(v.number()),
    fxRate: v.optional(v.number()),
    fxRateAt: v.optional(v.number()),
    fxSource: v.optional(v.string()),
    leadTimeDays: v.optional(v.number()),
    warrantyMonths: v.optional(v.number()),
    validUntilMs: v.optional(v.number()),
    supersededBy: v.optional(v.id("quotes")),
    sourceUrl: v.optional(v.string()),
  })
    .index("by_requestId", ["requestId"])
    .index("by_requestId_and_supplierId", ["requestId", "supplierId"])
    .index("by_supplierId", ["supplierId"]),

  // Normalized per-line pricing under a quote.
  quoteLines: defineTable({
    quoteId: v.id("quotes"),
    lineItemId: v.optional(v.id("lineItems")),
    description: v.string(),
    quantity: v.number(),
    unitPriceMinor: v.number(),
    totalMinor: v.number(),
    currency: v.string(),
  }).index("by_quoteId", ["quoteId"]),

  // Idempotency at the door (PLAN.md §4): one row per AgentMail eventId.
  inboundParses: defineTable({
    eventId: v.string(),
    messageId: v.string(),
    threadId: v.optional(v.string()),
    inboxId: v.optional(v.string()),
    rfqId: v.optional(v.id("rfqs")),
    state: parseState,
    reason: v.optional(v.string()),
    quoteId: v.optional(v.id("quotes")),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    // Kept so a held message can be read by a human and re-parsed on release
    // without another round-trip to AgentMail. Clipped before storage.
    fromAddress: v.optional(v.string()),
    text: v.optional(v.string()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_state", ["state"])
    .index("by_rfqId", ["rfqId"]),

  // The decision, its reasoning, and the trade-off it accepts by name.
  recommendations: defineTable({
    requestId: v.id("requests"),
    quoteId: v.id("quotes"),
    rationale: v.string(),
    tradeoff: v.string(),
    totalLandedUsdMinor: v.optional(v.number()),
    leadTimeDays: v.optional(v.number()),
    // Small, bounded list of the inputs behind the call, shown on hover.
    inputs: v.array(v.object({ label: v.string(), value: v.string() })),
  }).index("by_requestId", ["requestId"]),

  // PDF pro-formas arriving on a reply, in Convex file storage.
  attachments: defineTable({
    rfqId: v.optional(v.id("rfqs")),
    inboundParseId: v.optional(v.id("inboundParses")),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    parsed: v.boolean(),
  })
    .index("by_rfqId", ["rfqId"])
    .index("by_inboundParseId", ["inboundParseId"]),

  // Append-only audit trail. The table survives the cut line; the screen does not.
  events: defineTable({
    requestId: v.optional(v.id("requests")),
    kind: v.string(),
    message: v.string(),
    meta: v.optional(v.record(v.string(), v.string())),
  })
    .index("by_requestId", ["requestId"])
    .index("by_kind", ["kind"]),
});

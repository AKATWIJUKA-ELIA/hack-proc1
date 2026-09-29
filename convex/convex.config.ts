import { defineApp } from "convex/server";
import { v } from "convex/values";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";
import agentmail from "@agentmail/convex/convex.config";
import workflow from "@convex-dev/workflow/convex.config";

// Typed app env. Read these with `env` from ./_generated/server, never
// process.env. CONVEX_SITE_URL / CONVEX_CLOUD_URL are provided by the platform
// and must not be declared here.
const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
    OPENAI_API_KEY: v.string(),
    // Read by lib/agentmailRest.ts for inbox creation only — see that file for
    // why the component cannot do it. Optional so a deployment without mail
    // configured (dev) still deploys; the send path reports it as a failure a
    // human can retry rather than crashing.
    AGENTMAIL_API_KEY: v.optional(v.string()),
    AGENTMAIL_BASE_URL: v.optional(v.string()),
    // Also read by the component's client for its own verification; declared
    // here so convex/http.ts can verify the deliveries the component rejects.
    AGENTMAIL_WEBHOOK_SECRET: v.optional(v.string()),
    // Use an inbox that already exists instead of creating one per request.
    // Set this when the API key has no `inbox_create` permission, or when you
    // want every RFQ to come from one stable, warmed reply-to address — which
    // is the better answer for deliverability on cold outbound anyway.
    AGENTMAIL_INBOX_ID: v.optional(v.string()),
  },
});

app.use(firecrawl, {
  // Mounts the crawl webhook at <site>/firecrawl/webhook.
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});

// AgentMail reads AGENTMAIL_API_KEY / AGENTMAIL_WEBHOOK_SECRET from the
// deployment's own env vars, so they are deliberately absent from app.env —
// credentials never pass through function args or logs.
app.use(agentmail);

app.use(workflow);

export default app;

import { defineApp } from "convex/server";
import { v } from "convex/values";
import agentmail from "@agentmail/convex/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workflow from "@convex-dev/workflow/convex.config.js";
import firecrawl from "@firecrawl/firecrawl-convex/convex.config";

const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.string(),
    FIRECRAWL_WEBHOOK_SECRET: v.optional(v.string()),
    TYPESAFE_API_KEY: v.optional(v.string()),
    AGENTMAIL_API_KEY: v.optional(v.string()),
    AGENTMAIL_BASE_URL: v.optional(v.string()),
    AGENTMAIL_WEBHOOK_SECRET: v.optional(v.string()),
    AGENTMAIL_RECONCILIATION_READ_MAX_COST_MICRO_USD: v.optional(v.string()),
    HACKATHON_OWNER_RECIPIENT: v.optional(v.string()),
    RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD: v.optional(v.string()),
    JEV_ATTEMPT_MAX_COST_MICRO_USD: v.optional(v.string()),
    JEV_PRICING_VERSION: v.optional(v.string()),
    JEV_PRICING_BASIS: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    OPENAI_ENDPOINT: v.optional(v.string()),
    OPENAI_MODEL: v.optional(v.string()),
    OPENAI_TIMEOUT_MS: v.optional(v.string()),
    OPENAI_INPUT_MICRO_USD_PER_MILLION: v.optional(v.string()),
    OPENAI_OUTPUT_MICRO_USD_PER_MILLION: v.optional(v.string()),
    OPENAI_MAX_INPUT_TOKENS: v.optional(v.string()),
    OPENAI_MAX_OUTPUT_TOKENS: v.optional(v.string()),
    OPENAI_PRICING_VERSION: v.optional(v.string()),
    OPENAI_PRICING_BASIS: v.optional(v.string()),
  },
});

app.use(firecrawl, {
  httpPrefix: "/firecrawl/",
  env: {
    FIRECRAWL_API_KEY: app.env.FIRECRAWL_API_KEY,
    FIRECRAWL_WEBHOOK_SECRET: app.env.FIRECRAWL_WEBHOOK_SECRET,
  },
});
app.use(agentmail);
app.use(workflow);
// App-owned root routing: no httpPrefix, so existing /agentmail/webhook and
// auth routes keep their exact paths and win over the SPA catch-all.
app.use(staticHosting);

export default app;

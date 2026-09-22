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

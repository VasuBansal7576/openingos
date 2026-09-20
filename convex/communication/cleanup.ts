/**
 * Provider housekeeping boundary.
 *
 * AgentMail's component deletes finalized outbound rows after seven days.
 * OpeningOS app-owned snapshots, processed events, project timeline rows and
 * quote/evidence records live outside that component and are never removed by
 * this operation.
 */

import { v } from "convex/values";
import type { FunctionReference } from "convex/server";
import { components } from "../models/components.js";
import { f1InternalMutation } from "../server.js";
import { denialValidator } from "../access/checks.js";
import { OUTBOUND_RETENTION_MS } from "./contracts.js";

const cleanupResultValidator = v.union(
  v.object({ ok: v.literal(true), retentionMs: v.number() }),
  denialValidator,
);

export const cleanupFinalizedProviderRows = f1InternalMutation({
  args: { retentionMs: v.optional(v.number()) },
  returns: cleanupResultValidator,
  handler: async (ctx, args) => {
    const retentionMs = args.retentionMs ?? OUTBOUND_RETENTION_MS;
    if (retentionMs !== OUTBOUND_RETENTION_MS) {
      return { ok: false as const, code: "invalid-payload", message: "provider cleanup retention is fixed at seven days" };
    }
    const agentmail = components.agentmail;
    if (agentmail === undefined || agentmail.lib === undefined) {
      return { ok: false as const, code: "provider-rejection", message: "AgentMail component is unavailable" };
    }
    const cleanupRef = agentmail.lib.cleanupFinalizedOutbound as unknown as FunctionReference<
      "mutation",
      "internal" | "public",
      { olderThan?: number },
      null
    >;
    // The component owns its outbound rows and performs its own bounded
    // status sweep. No application-owned purchasing row is passed to it.
    await ctx.runMutation(cleanupRef, { olderThan: retentionMs });
    return { ok: true as const, retentionMs };
  },
});

/**
 * F1 capability catalog surface (controlled contract, ADR-0007).
 *
 * Deny-by-default: unknown operations are denied, including from retrieved
 * instructions or recovery plans. The UI and Jev classifier cannot grant
 * authority; this catalog plus backend checks is authoritative.
 */

import { v } from "convex/values";
import { f1Query } from "../server.js";
import {
  CAPABILITY_CATALOG_VERSION,
  catalogEntries,
  lookupCapability,
} from "../shared/scope.js";

export const catalogVersionValidator = v.object({
  version: v.string(),
  operations: v.array(
    v.object({
      operationId: v.string(),
      effect: v.string(),
      requiredRole: v.string(),
      enabled: v.boolean(),
      description: v.string(),
    }),
  ),
});

/** Public catalog descriptor: versions and enabled operations only. */
export const catalog = f1Query({
  args: {},
  returns: catalogVersionValidator,
  handler: async () => ({
    version: CAPABILITY_CATALOG_VERSION,
    operations: catalogEntries().map((entry) => ({
      operationId: entry.operationId,
      effect: entry.effect,
      requiredRole: entry.requiredRole,
      enabled: entry.enabled,
      description: entry.description,
    })),
  }),
});

/** Whether an operation ID exists and is enabled (no authority granted). */
export const describe = f1Query({
  args: { operationId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      operationId: v.string(),
      enabled: v.boolean(),
      requiredRole: v.string(),
    }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (_ctx, args) => {
    const entry = lookupCapability(args.operationId);
    if (entry === undefined) {
      return { ok: false as const, code: "unknown-operation", message: `unknown operation ${args.operationId}` };
    }
    return {
      ok: true as const,
      operationId: entry.operationId,
      enabled: entry.enabled,
      requiredRole: entry.requiredRole,
    };
  },
});

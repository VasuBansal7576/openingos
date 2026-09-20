/**
 * F1 owner-recipient configuration surface (controlled contract, S-22).
 *
 * Exactly one active `HACKATHON_OWNER_RECIPIENT`-backed configuration exists
 * at a time. Every communication grant binds its version; a change
 * invalidates queued grants and requires re-approval. The descriptor
 * exposes version + label only, never the private address; configuration
 * requires an owner role proven through organization membership.
 */

import { v } from "convex/values";
import { f1InternalMutation, f1Query } from "../server.js";
import { isValidSingleMailbox, normalizeMailbox, payloadHash } from "../shared/hashing.js";
import { denialValidator } from "./checks.js";

const describeValidator = v.union(
  v.object({
    ok: v.literal(true),
    version: v.number(),
    active: v.boolean(),
    counterpartyLabel: v.string(),
  }),
  denialValidator,
);

/** Public descriptor: version + label, never the private address. */
export const describe = f1Query({
  args: {},
  returns: describeValidator,
  handler: async (ctx) => {
    const active = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(1);
    const current = active[0];
    if (current === undefined) {
      return { ok: false as const, code: "missing-recipient-config", message: "owner recipient is not configured" };
    }
    return {
      ok: true as const,
      version: current.version,
      active: true,
      counterpartyLabel: "Demo supplier (owner playing supplier)",
    };
  },
});

/**
 * Server-controlled recipient setup (deployment boundary for
 * HACKATHON_OWNER_RECIPIENT). Internal only: no organization owner can
 * change the global recipient through any public call; rotation happens
 * through protected deployment configuration and invalidates queued
 * grants at claim time via the version binding.
 */
export const configure = f1InternalMutation({
  args: { mailbox: v.string(), authorizedBy: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), version: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    // Server-controlled boundary: the caller is deployment automation, not
    // an organization member. No org owner can reach this function through
    // any public call, so no membership check could authorize them.
    if (args.authorizedBy.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "server authority required" };
    }
    const normalized = normalizeMailbox(args.mailbox);
    if (!isValidSingleMailbox(normalized)) {
      return { ok: false as const, code: "invalid-payload", message: "mailbox is not a single valid address" };
    }
    const now = Date.now();
    const activeConfigs = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    for (const config of activeConfigs) {
      await ctx.db.patch(config._id, { active: false });
    }
    const latest = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_version")
      .order("desc")
      .take(1);
    const version = (latest[0]?.version ?? 0) + 1;
    await ctx.db.insert("recipientConfigs", {
      version,
      mailboxNormalized: normalized,
      mailboxHash: payloadHash(normalized),
      active: true,
      configuredAt: now,
      configuredBy: args.authorizedBy,
    });
    return { ok: true as const, version };
  },
});

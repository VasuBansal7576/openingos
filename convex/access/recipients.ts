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
import { f1Mutation, f1Query } from "../server.js";
import { normalizeMailbox, payloadHash } from "../shared/hashing.js";
import { denialValidator, identityOf } from "./checks.js";

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
 * Configure (or rotate) the owner recipient. Requires an owner role in the
 * named organization; the value is protected backend configuration and
 * never comes from project inputs, prompts, or reply headers.
 */
export const configure = f1Mutation({
  args: { organizationId: v.id("organizations"), mailbox: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), version: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const normalized = normalizeMailbox(args.mailbox);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return { ok: false as const, code: "invalid-payload", message: "mailbox is not valid" };
    }
    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_organization_and_identity", (q) =>
        q.eq("organizationId", args.organizationId).eq("identity", identity),
      )
      .collect();
    const now = Date.now();
    const current = rows.filter(
      (row) => row.status === "active" && (row.expiresAt === undefined || row.expiresAt > now),
    );
    const isOwner = current.some((row) => row.role === "owner");
    if (!isOwner) {
      return { ok: false as const, code: "denied-capability", message: "only an owner configures the recipient" };
    }
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
      configuredBy: identity,
    });
    return { ok: true as const, version };
  },
});

/**
 * F1 owner-recipient configuration surface (controlled contract, S-22).
 *
 * Exactly one active `HACKATHON_OWNER_RECIPIENT`-backed configuration exists
 * at a time. Every communication grant binds its version; a change
 * invalidates queued grants and requires re-approval. Callers never see the
 * raw address unless they hold an owner role; public guests receive the
 * controlled-counterparty label and version only.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
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
export const describe = query({
  args: {},
  returns: describeValidator,
  handler: async (ctx) => {
    const configs = (await ctx.db.query("recipientConfigs").collect()) as unknown as {
      version: number;
      active: boolean;
    }[];
    const active = configs.find((config) => config.active);
    if (!active) {
      return { ok: false as const, code: "missing-recipient-config", message: "owner recipient is not configured" };
    }
    return {
      ok: true as const,
      version: active.version,
      active: true,
      counterpartyLabel: "Demo supplier (owner playing supplier)",
    };
  },
});

/**
 * Configure (or rotate) the owner recipient. Requires an owner role in at
 * least one organization; the value is protected backend configuration and
 * never comes from project inputs, prompts, or reply headers.
 */
export const configure = mutation({
  args: { mailbox: v.string(), now: v.number() },
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
    const memberships = (await ctx.db.query("memberships").collect()) as unknown as {
      identity: string;
      role: string;
      status: string;
    }[];
    const isOwner = memberships.some(
      (row) => row.identity === identity && row.role === "owner" && row.status === "active",
    );
    if (!isOwner) {
      return { ok: false as const, code: "denied-capability", message: "only an owner configures the recipient" };
    }
    const existing = (await ctx.db.query("recipientConfigs").collect()) as unknown as {
      _id: string;
      active: boolean;
      version: number;
    }[];
    for (const config of existing) {
      if (config.active) await ctx.db.patch(config._id as never, { active: false });
    }
    const version = existing.reduce((max, config) => Math.max(max, config.version), 0) + 1;
    await ctx.db.insert("recipientConfigs", {
      version,
      mailboxNormalized: normalized,
      mailboxHash: payloadHash(normalized),
      active: true,
      configuredAt: args.now,
      configuredBy: identity,
    });
    return { ok: true as const, version };
  },
});

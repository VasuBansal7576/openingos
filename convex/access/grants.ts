/**
 * F1 version-bound grant surface (controlled contract, ADR-0007).
 *
 * A grant binds organization, project, allowed operations, recipients,
 * disclosure fields, purpose, cost ceiling, round limit, expiry, and
 * revocation version. Changed recipients, specifications, quantities, or
 * limits invalidate affected queued approvals; the dispatch claim rechecks
 * all of it atomically.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { canonicalJson, payloadHash } from "../shared/hashing.js";
import { lookupCapability } from "../shared/scope.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { checkProjectAccess, denialValidator, identityOf } from "./checks.js";

const grantViewValidator = v.object({
  id: v.string(),
  organizationId: v.string(),
  projectId: v.string(),
  operations: v.array(v.string()),
  communicationProfile: v.string(),
  recipientConfigVersion: v.number(),
  expiresAt: v.number(),
  revocationVersion: v.number(),
  status: v.string(),
});

const issueResultValidator = v.union(
  v.object({ ok: v.literal(true), grantId: v.string(), revocationVersion: v.number() }),
  denialValidator,
);

/** Issue a version-bound grant (approver role or above). */
export const issue = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    operations: v.array(v.string()),
    communicationProfile: v.string(),
    recipientConfigVersion: v.number(),
    inputVersions: v.record(v.string(), v.string()),
    payload: v.any(),
    costCeilingMicroUsd: v.number(),
    roundLimit: v.number(),
    expiresAt: v.number(),
    conversationId: v.optional(v.string()),
    now: v.number(),
  },
  returns: issueResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (args.operations.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "grant must authorize at least one operation" };
    }
    for (const operationId of args.operations) {
      const entry = lookupCapability(operationId);
      if (entry === undefined) {
        return { ok: false as const, code: "unknown-operation", message: `unknown operation ${operationId}` };
      }
      if (!entry.enabled) {
        return { ok: false as const, code: "unavailable-capability", message: `operation ${operationId} unavailable` };
      }
    }
    const needsRecipient = args.operations.some(
      (operationId) => operationId === "communication.send" || operationId === "communication.clarify",
    );
    if (needsRecipient && args.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
      return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
    }
    if (!Number.isSafeInteger(args.costCeilingMicroUsd) || args.costCeilingMicroUsd < 0) {
      return { ok: false as const, code: "invalid-payload", message: "cost ceiling must be a non-negative safe integer" };
    }
    if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= args.now) {
      return { ok: false as const, code: "invalid-payload", message: "grant expiry must be in the future" };
    }
    const canonical = canonicalJson(args.payload);
    const grantId = await ctx.db.insert("grants", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      operations: [...args.operations],
      communicationProfile: args.communicationProfile,
      recipientConfigVersion: args.recipientConfigVersion,
      inputVersions: { ...args.inputVersions },
      canonicalPayload: canonical,
      payloadHash: payloadHash(args.payload),
      costCeilingMicroUsd: args.costCeilingMicroUsd,
      roundLimit: args.roundLimit,
      expiresAt: args.expiresAt,
      revocationVersion: 1,
      status: "active",
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      createdAt: args.now,
    });
    return {
      ok: true as const,
      grantId: grantId as unknown as string,
      revocationVersion: 1,
    };
  },
});

/** Revoke a grant; queued operations under it stop at claim time. */
export const revoke = mutation({
  args: { grantId: v.string(), organizationId: v.string(), projectId: v.string(), now: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true), revocationVersion: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const grant = (await ctx.db.get(args.grantId as never)) as unknown as {
      organizationId?: string;
      revocationVersion?: number;
    } | null;
    if (!grant || grant.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "grant is not in this organization" };
    }
    const nextVersion = (grant.revocationVersion ?? 1) + 1;
    await ctx.db.patch(args.grantId as never, { status: "revoked", revocationVersion: nextVersion });
    return { ok: true as const, revocationVersion: nextVersion };
  },
});

/** Read one grant the caller may access (same project isolation). */
export const get = query({
  args: { grantId: v.string(), organizationId: v.string(), projectId: v.string(), now: v.number() },
  returns: v.union(grantViewValidator.extend({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const grant = (await ctx.db.get(args.grantId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      operations?: string[];
      communicationProfile?: string;
      recipientConfigVersion?: number;
      expiresAt?: number;
      revocationVersion?: number;
      status?: string;
    } | null;
    if (!grant || grant.organizationId !== args.organizationId || grant.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "grant is not in this project" };
    }
    return {
      ok: true as const,
      id: args.grantId,
      organizationId: args.organizationId,
      projectId: args.projectId,
      operations: grant.operations ?? [],
      communicationProfile: grant.communicationProfile ?? "",
      recipientConfigVersion: grant.recipientConfigVersion ?? 0,
      expiresAt: grant.expiresAt ?? 0,
      revocationVersion: grant.revocationVersion ?? 1,
      status: grant.status ?? "active",
    };
  },
});

/**
 * F1 version-bound grant surface (controlled contract, ADR-0007).
 *
 * A grant binds organization, project, allowed operations, recipients,
 * disclosure fields, purpose, cost ceiling, round limit, expiry, and
 * revocation version. Changed recipients, specifications, quantities, or
 * limits invalidate affected queued approvals; the dispatch claim rechecks
 * all of it atomically. Identity and time are server-derived.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { parseBoundedPayloadJson } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import { lookupCapability } from "../shared/scope.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { checkProjectAccess, denialValidator, identityOf } from "./checks.js";

const grantViewValidator = v.object({
  id: v.id("grants"),
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  operations: v.array(v.string()),
  communicationProfile: v.string(),
  recipientConfigVersion: v.number(),
  expiresAt: v.number(),
  revocationVersion: v.number(),
  status: v.string(),
});

const issueResultValidator = v.union(
  v.object({ ok: v.literal(true), grantId: v.id("grants"), revocationVersion: v.number() }),
  denialValidator,
);

/** Issue a version-bound grant (approver role or above). */
export const issue = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    operations: v.array(v.string()),
    communicationProfile: v.string(),
    recipientConfigVersion: v.number(),
    inputVersions: v.record(v.string(), v.string()),
    payloadJson: v.string(),
    costCeilingMicroUsd: v.number(),
    roundLimit: v.number(),
    expiresAt: v.number(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: issueResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      now,
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
    if (!Number.isSafeInteger(args.roundLimit) || args.roundLimit < 1) {
      return { ok: false as const, code: "invalid-payload", message: "round limit must be a positive safe integer" };
    }
    if (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= now) {
      return { ok: false as const, code: "invalid-payload", message: "grant expiry must be in the future" };
    }
    if (needsRecipient) {
      const recipient = await ctx.db
        .query("recipientConfigs")
        .withIndex("by_active", (q) => q.eq("active", true))
        .unique();
      if (recipient === null || args.recipientConfigVersion !== recipient.version) {
        return { ok: false as const, code: "invalid-payload", message: "grant must bind the active recipient version" };
      }
    }
    if (args.conversationId !== undefined) {
      const conversation = await ctx.db.get(args.conversationId);
      if (
        conversation === null ||
        conversation.organizationId !== args.organizationId ||
        conversation.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "conversation is not in this project" };
      }
    }
    const parsed = parseBoundedPayloadJson(args.payloadJson);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, message: parsed.message };
    const canonical = parsed.payload.canonical;
    const payloadSha256 = await sha256HexOfCanonical(canonical);
    const grantId = await ctx.db.insert("grants", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      operations: [...args.operations],
      communicationProfile: args.communicationProfile,
      recipientConfigVersion: args.recipientConfigVersion,
      inputVersions: { ...args.inputVersions },
      canonicalPayload: canonical,
      payloadHash: parsed.payload.hash,
      payloadSha256,
      costCeilingMicroUsd: args.costCeilingMicroUsd,
      roundLimit: args.roundLimit,
      expiresAt: args.expiresAt,
      revocationVersion: 1,
      status: "active",
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      createdAt: now,
    });
    return { ok: true as const, grantId, revocationVersion: 1 };
  },
});

/** Revoke a grant; queued operations under it stop at claim time. */
export const revoke = f1Mutation({
  args: { grantId: v.id("grants") },
  returns: v.union(
    v.object({ ok: v.literal(true), revocationVersion: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const grant = await ctx.db.get(args.grantId);
    if (grant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      grant.organizationId,
      grant.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const nextVersion = grant.revocationVersion + 1;
    await ctx.db.patch(args.grantId, { status: "revoked", revocationVersion: nextVersion });
    return { ok: true as const, revocationVersion: nextVersion };
  },
});

/** Read one grant the caller may access (same project isolation). */
export const get = f1Query({
  args: { grantId: v.id("grants") },
  returns: v.union(grantViewValidator.extend({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const grant = await ctx.db.get(args.grantId);
    if (grant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      grant.organizationId,
      grant.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return {
      ok: true as const,
      id: args.grantId,
      organizationId: grant.organizationId,
      projectId: grant.projectId,
      operations: [...grant.operations],
      communicationProfile: grant.communicationProfile,
      recipientConfigVersion: grant.recipientConfigVersion,
      expiresAt: grant.expiresAt,
      revocationVersion: grant.revocationVersion,
      status: grant.status,
    };
  },
});

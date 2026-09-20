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
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
import { parseBoundedPayloadJson } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import {
  defaultWorkflowAuthority,
  lookupCapability,
  workflowAuthorityForOperation,
  workflowAuthorityMatchesProject,
  workflowAuthoritiesValidator,
  type WorkflowAuthority,
} from "../shared/scope.js";
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

async function validateAuthorityReferences(
  ctx: F1MutationCtx,
  authority: WorkflowAuthority,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
): Promise<boolean> {
  if (!workflowAuthorityMatchesProject(authority, authority.operationId, projectId)) return false;
  if (authority.operationId === "communication.send" || authority.operationId === "communication.clarify") {
    if (authority.conversationId === undefined) return true;
    const conversation = await ctx.db.get(authority.conversationId);
    return (
      conversation !== null &&
      conversation.organizationId === organizationId &&
      conversation.projectId === projectId &&
      conversation.state !== "cancelled" &&
      conversation.state !== "closed"
    );
  }
  const requirementId = "requirementId" in authority ? authority.requirementId : undefined;
  const candidateId = "candidateId" in authority ? authority.candidateId : undefined;
  let requirement: { readonly _id: Id<"requirements"> } | null = null;
  if (requirementId !== undefined) {
    const row = await ctx.db.get(requirementId);
    if (row === null || row.organizationId !== organizationId || row.projectId !== projectId) return false;
    if (row.state === "cancelled") return false;
    requirement = row;
  }
  if (candidateId !== undefined) {
    const candidate = await ctx.db.get(candidateId);
    if (
      candidate === null ||
      candidate.organizationId !== organizationId ||
      candidate.projectId !== projectId ||
      (requirement !== null && candidate.requirementId !== requirement._id)
    ) {
      return false;
    }
    if (requirement === null) {
      const candidateRequirement = await ctx.db.get(candidate.requirementId);
      if (
        candidateRequirement === null ||
        candidateRequirement.organizationId !== organizationId ||
        candidateRequirement.projectId !== projectId ||
        candidateRequirement.state === "cancelled"
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Resolve at most one exact requirement from the approved workflow payload.
 * The payload text is only a lookup hint; authority comes from the returned
 * server-owned row, and ambiguity deliberately produces no fallback ref.
 */
async function uniqueRequirementForPayload(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  canonicalPayload: string,
): Promise<Id<"requirements"> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalPayload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (!("query" in parsed) || typeof parsed.query !== "string") return undefined;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 1 || keys[0] !== "query") return undefined;
  const tokens = [...new Set(parsed.query.match(/[A-Za-z0-9]+/g) ?? [])].slice(0, 24);
  const matches = new Set<Id<"requirements">>();
  for (const token of tokens) {
    const variants = [...new Set([
      token,
      token.toLocaleLowerCase(),
      token.length === 0 ? token : token.charAt(0).toLocaleUpperCase() + token.slice(1).toLocaleLowerCase(),
    ])];
    for (const variant of variants) {
      const byTitle = await ctx.db
        .query("requirements")
        .withIndex("by_organization_and_project_and_title", (q) =>
          q.eq("organizationId", organizationId).eq("projectId", projectId).eq("title", variant),
        )
        .take(2);
      for (const requirement of byTitle) matches.add(requirement._id);
      const byKey = await ctx.db
        .query("requirements")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", projectId).eq("key", variant),
        )
        .take(2);
      for (const requirement of byKey) matches.add(requirement._id);
    }
    if (matches.size > 1) return undefined;
  }
  if (matches.size > 1) return undefined;
  const requirementId =
    matches.size === 1
      ? [...matches][0]
      : await (async () => {
          const rows = (
            await Promise.all(
              (["draft", "approved", "sourcing", "readyForDecision", "selected", "fulfilled"] as const).map(
                (state) =>
                  ctx.db
                    .query("requirements")
                    .withIndex("by_project_and_state", (q) =>
                      q.eq("projectId", projectId).eq("state", state),
                    )
                    .take(2),
              ),
            )
          ).flat();
          const current = new Map<Id<"requirements">, true>();
          for (const row of rows) {
            if (row.organizationId === organizationId && row.projectId === projectId) {
              current.set(row._id, true);
            }
          }
          const ids = [...current.keys()];
          return ids.length === 1 ? ids[0] : undefined;
        })();
  if (requirementId === undefined) return undefined;
  const requirement = await ctx.db.get(requirementId);
  if (
    requirement === null ||
    requirement.organizationId !== organizationId ||
    requirement.projectId !== projectId ||
    requirement.state === "cancelled"
  ) {
    return undefined;
  }
  return requirementId;
}

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
    workflowAuthorities: v.optional(workflowAuthoritiesValidator),
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
        conversation.projectId !== args.projectId ||
        conversation.state === "cancelled" ||
        conversation.state === "closed"
      ) {
        return { ok: false as const, code: "denied-project", message: "conversation is not in this project" };
      }
    }
    const parsed = parseBoundedPayloadJson(args.payloadJson);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, message: parsed.message };
    const canonical = parsed.payload.canonical;
    const payloadSha256 = await sha256HexOfCanonical(canonical);
    const matchedRequirementId = await uniqueRequirementForPayload(
      ctx,
      args.organizationId,
      args.projectId,
      canonical,
    );
    const workflowAuthorities: WorkflowAuthority[] = [];
    for (const operationId of args.operations) {
      const explicit = workflowAuthorityForOperation(args.workflowAuthorities, operationId);
      const baseAuthority =
        explicit ??
        (args.workflowAuthorities === undefined
          ? defaultWorkflowAuthority(operationId, args.projectId)
          : null);
      if (baseAuthority === null) {
        return { ok: false as const, code: "invalid-payload", message: "each grant operation requires one workflow authority" };
      }
      const authority =
        operationId === "research.collect" &&
        matchedRequirementId !== undefined &&
        baseAuthority.operationId === "research.collect" &&
        baseAuthority.requirementId === undefined
          ? { ...baseAuthority, requirementId: matchedRequirementId }
          : baseAuthority;
      const scopedAuthority =
        args.conversationId !== undefined &&
        (operationId === "communication.send" || operationId === "communication.clarify")
          ? { ...authority, conversationId: args.conversationId }
          : authority;
      if (
        !workflowAuthorityMatchesProject(scopedAuthority, operationId, args.projectId) ||
        !(await validateAuthorityReferences(
          ctx,
          scopedAuthority,
          args.organizationId,
          args.projectId,
        ))
      ) {
        return { ok: false as const, code: "denied-project", message: "workflow authority is not in this project" };
      }
      workflowAuthorities.push(scopedAuthority);
    }
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
      workflowAuthorities,
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

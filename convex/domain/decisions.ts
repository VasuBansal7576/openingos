/**
 * F1 selections and approvals (controlled contract, PRD 17/35, ADR-0003).
 *
 * A selection pins the exact quote version, quantity, actor, and the
 * requirement version it was decided against; it changes forecast only.
 * An approval snapshots the exact decision canonical string and hash;
 * changed inputs invalidate the approval (new row state) instead of
 * rewriting history. Concurrent edits cannot make an older approval
 * authorize newer terms: the snapshot hash binds the decision.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import { decimalCompare, decimalZero, quantity } from "../../proofs/money/decimal.js";
import {
  approvalInputValidator,
  selectionInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

const selectionResultValidator = v.union(
  v.object({ ok: v.literal(true), selectionId: v.id("selections") }),
  denialValidator,
);

/**
 * Record a selection. Requirement, candidate, and quote must all live in
 * the caller's project, the quote version must match exactly, and the
 * requirement version must be current. The quantity is a validated
 * positive decimal, and mixed currencies are refused until an explicit
 * dated conversion basis is accepted (PRD 17): a requirement currency
 * that disagrees with the quote currency blocks the selection.
 */
export const recordSelection = f1Mutation({
  args: selectionInputValidator.fields,
  returns: selectionResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const candidate = await requireOwnedRef(
      await ctx.db.get(args.candidateId),
      args.organizationId,
      args.projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    if (candidate.value.requirementId !== args.requirementId) {
      return { ok: false as const, code: "denied-project", message: "candidate is for another requirement" };
    }
    const quote = await ctx.db.get(args.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    if (quote.version !== args.quoteVersion) {
      return { ok: false as const, code: "invalid-payload", message: "quote version mismatch" };
    }
    if (requirement.value.version !== args.requirementVersion) {
      return { ok: false as const, code: "invalid-payload", message: "requirement version is stale" };
    }
    if (
      requirement.value.currency !== undefined &&
      requirement.value.currency !== quote.currency
    ) {
      return { ok: false as const, code: "invalid-payload", message: "mixed-currency-requires-accepted-conversion-basis" };
    }
    try {
      const selected = quantity(args.quantity);
      if (decimalCompare(selected, decimalZero()) <= 0) {
        return { ok: false as const, code: "invalid-payload", message: "selected quantity must be positive" };
      }
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "selected quantity is not a valid decimal" };
    }
    const selectionId = await ctx.db.insert("selections", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      candidateId: args.candidateId,
      quoteId: args.quoteId,
      quoteVersion: args.quoteVersion,
      quantity: args.quantity,
      requirementVersion: args.requirementVersion,
      actor: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, selectionId };
  },
});

const approvalResultValidator = v.union(
  v.object({ ok: v.literal(true), approvalId: v.id("approvals"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Record an approval snapshot. The client-supplied hash is verified
 * server-side against SHA-256 of the canonical snapshot: a hash that
 * does not match the canonical text is rejected, so callers can never
 * bind an approval to terms the hash does not cover. The verified hash
 * is unique per project: replaying the same decision returns the
 * existing row. Optional selection/quote links must resolve inside the
 * project.
 */
export const recordApproval = f1Mutation({
  args: approvalInputValidator.fields,
  returns: approvalResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.snapshotHash.trim().length === 0 || args.snapshotCanonical.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "decision snapshot required" };
    }
    const computedHash = await sha256HexOfCanonical(args.snapshotCanonical);
    if (computedHash !== args.snapshotHash) {
      return { ok: false as const, code: "invalid-payload", message: "snapshot hash does not match canonical decision" };
    }
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_project_and_snapshot", (q) =>
        q.eq("projectId", args.projectId).eq("snapshotHash", args.snapshotHash),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      return { ok: true as const, approvalId: existing._id, deduplicated: true };
    }
    if (args.selectionId !== undefined) {
      const selection = await requireOwnedRef(
        await ctx.db.get(args.selectionId),
        args.organizationId,
        args.projectId,
      );
      if (!selection.ok) {
        return { ok: false as const, code: selection.code, message: selection.message };
      }
    }
    if (args.quoteId !== undefined) {
      const quote = await ctx.db.get(args.quoteId);
      if (
        quote === null ||
        quote.organizationId !== args.organizationId ||
        quote.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
      }
    }
    const approvalId = await ctx.db.insert("approvals", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      scope: args.scope,
      snapshotCanonical: args.snapshotCanonical,
      snapshotHash: args.snapshotHash,
      ...(args.selectionId === undefined ? {} : { selectionId: args.selectionId }),
      ...(args.quoteId === undefined ? {} : { quoteId: args.quoteId }),
      state: "pending",
      approver: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, approvalId, deduplicated: false };
  },
});

/**
 * Decide an approval (approve or reject). Only pending approvals move;
 * invalidation after a basis change uses `invalidateApproval` so the
 * reason for invalidation stays explicit.
 */
export const decideApproval = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    if (approval.value.state !== "pending") {
      return { ok: false as const, code: "invalid-payload", message: "approval is no longer pending" };
    }
    await ctx.db.patch(args.approvalId, {
      state: args.decision,
      approver: access.value.identity,
      decidedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/**
 * Invalidate an approval whose basis changed (new quote, spec, or
 * quantity). Terminal states never move again.
 */
export const invalidateApproval = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "approver",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    if (approval.value.state === "invalidated" || approval.value.state === "rejected") {
      return { ok: false as const, code: "invalid-payload", message: "approval already terminal" };
    }
    await ctx.db.patch(args.approvalId, { state: "invalidated" });
    return { ok: true as const };
  },
});

/** Read one approval snapshot in the caller's project. */
export const getApproval = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    approvalId: v.id("approvals"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), state: v.string(), snapshotHash: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const approval = await requireOwnedRef(
      await ctx.db.get(args.approvalId),
      args.organizationId,
      args.projectId,
    );
    if (!approval.ok) {
      return { ok: false as const, code: approval.code, message: approval.message };
    }
    return {
      ok: true as const,
      state: approval.value.state,
      snapshotHash: approval.value.snapshotHash,
    };
  },
});

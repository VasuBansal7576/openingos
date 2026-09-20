/**
 * F1 sourcing graph (controlled contract, PRD 20/21/22, ADR-0003).
 *
 * Vendors, contacts, candidates, field-level product evidence, RFQs, and
 * negotiation mandates. Candidate identity is the exact
 * (requirement, variant, vendor) triple: the same model from another
 * seller is another row and a different variant never merges.
 * Product evidence keeps verification separate from freshness and
 * preserves controlled counterparty provenance. RFQs carry an
 * idempotency key so retries replay the same row.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  candidateInputValidator,
  candidateVariantKey,
  compatibilityVerificationInputValidator,
  negotiationInputValidator,
  productEvidenceInputValidator,
  rfqInputValidator,
  vendorContactInputValidator,
  vendorInputValidator,
} from "../shared/domainContracts.js";
import {
  requireDomainAccess,
  requireOrganizationAccess,
  requireOwnedRef,
} from "./guards.js";

const vendorResultValidator = v.union(
  v.object({ ok: v.literal(true), vendorId: v.id("vendors") }),
  denialValidator,
);

/**
 * Record a discovered vendor. Vendors are organization-scoped supplier
 * identity: one vendor serves many projects, so creation requires
 * org-level authority and the row carries no project.
 */
export const recordVendor = f1Mutation({
  args: vendorInputValidator.fields,
  returns: vendorResultValidator,
  handler: async (ctx, args) => {
    const access = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "name required" };
    }
    const vendorId = await ctx.db.insert("vendors", {
      organizationId: args.organizationId,
      name: args.name,
      regions: [...args.regions],
      ...(args.dealerEvidence === undefined ? {} : { dealerEvidence: args.dealerEvidence }),
      ...(args.serviceCoverage === undefined ? {} : { serviceCoverage: args.serviceCoverage }),
      ...(args.serviceCheckedAt === undefined ? {} : { serviceCheckedAt: args.serviceCheckedAt }),
      createdAt: Date.now(),
    });
    return { ok: true as const, vendorId };
  },
});

/** Read one vendor; the row must belong to the caller's organization. */
export const getVendor = f1Query({
  args: {
    organizationId: v.id("organizations"),
    vendorId: v.id("vendors"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string(), regions: v.array(v.string()) }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const row = await ctx.db.get(args.vendorId);
    if (row === null || row.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized" };
    }
    return { ok: true as const, name: row.name, regions: [...row.regions] };
  },
});

/**
 * Record an authorized contact channel for one project. The vendor is
 * organization-scoped and must belong to the caller's organization; the
 * contact itself authorizes outreach for the stated project only.
 */
export const recordVendorContact = f1Mutation({
  args: vendorContactInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), contactId: v.id("vendorContacts") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const vendor = await ctx.db.get(args.vendorId);
    if (vendor === null || vendor.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "vendor is not in this organization" };
    }
    const contactId = await ctx.db.insert("vendorContacts", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      vendorId: args.vendorId,
      channel: args.channel,
      detailHash: args.detailHash,
      ...(args.preference === undefined ? {} : { preference: args.preference }),
      createdAt: Date.now(),
    });
    return { ok: true as const, contactId };
  },
});

const candidateResultValidator = v.union(
  v.object({ ok: v.literal(true), candidateId: v.id("candidates") }),
  denialValidator,
);

/**
 * Record a candidate for one requirement/vendor/exact-variant triple.
 * The exact variant key is unique per requirement, so re-recording the
 * same variant conflicts instead of duplicating. Compatibility is always
 * stored `unknown` here: callers cannot self-assert a pass, and
 * verification requires evidence through `verifyCompatibility`.
 */
export const recordCandidate = f1Mutation({
  args: candidateInputValidator.fields,
  returns: candidateResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
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
    const vendor = await ctx.db.get(args.vendorId);
    if (vendor === null || vendor.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "vendor is not in this organization" };
    }
    if (args.productModel.trim().length === 0 || args.variant.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "exact model and variant required" };
    }
    const variantKey = candidateVariantKey({
      requirementId: args.requirementId,
      productModel: args.productModel,
      variant: args.variant,
      vendorId: args.vendorId,
    });
    const duplicate = await ctx.db
      .query("candidates")
      .withIndex("by_requirement_and_variant", (q) =>
        q.eq("requirementId", args.requirementId).eq("variantKey", variantKey),
      )
      .unique();
    if (duplicate !== null) {
      return { ok: false as const, code: "duplicate-conflict", message: "exact variant already a candidate" };
    }
    const candidateId = await ctx.db.insert("candidates", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      vendorId: args.vendorId,
      productModel: args.productModel,
      variant: args.variant,
      variantKey,
      compatibility: "unknown",
      compatibilityEvidenceRefs: [],
      conversationState: args.conversationState,
      createdAt: Date.now(),
    });
    return { ok: true as const, candidateId };
  },
});

/**
 * Verify a candidate's compatibility against evidence. Only an approver
 * (or above) may set pass/fail, every verdict carries its evidence
 * references, and the candidate must live in the caller's project.
 */
export const verifyCompatibility = f1Mutation({
  args: compatibilityVerificationInputValidator.fields,
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
    const candidate = await requireOwnedRef(
      await ctx.db.get(args.candidateId),
      args.organizationId,
      args.projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    if (args.evidenceRefs.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "verification requires evidence" };
    }
    await ctx.db.patch(args.candidateId, {
      compatibility: args.result,
      compatibilityEvidenceRefs: [...args.evidenceRefs],
    });
    return { ok: true as const };
  },
});

/** List candidates for one requirement (bounded through the requirement index). */
export const listCandidates = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      candidates: v.array(
        v.object({
          id: v.id("candidates"),
          productModel: v.string(),
          variant: v.string(),
          compatibility: v.string(),
        }),
      ),
    }),
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
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    const rows = await ctx.db
      .query("candidates")
      .withIndex("by_requirement", (q) => q.eq("requirementId", args.requirementId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      candidates: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          id: row._id,
          productModel: row.productModel,
          variant: row.variant,
          compatibility: row.compatibility,
        })),
    };
  },
});

/**
 * Record field-level product evidence. The caller is a user import, so
 * provenance is fixed server-side to `userImport`/`recorded`; the
 * verified provider pipeline writes through its own internal path.
 */
export const recordProductEvidence = f1Mutation({
  args: productEvidenceInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), evidenceId: v.id("productEvidence") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.requirementId !== undefined) {
      const requirement = await requireOwnedRef(
        await ctx.db.get(args.requirementId),
        args.organizationId,
        args.projectId,
      );
      if (!requirement.ok) {
        return { ok: false as const, code: requirement.code, message: requirement.message };
      }
    }
    if (args.candidateId !== undefined) {
      const candidate = await requireOwnedRef(
        await ctx.db.get(args.candidateId),
        args.organizationId,
        args.projectId,
      );
      if (!candidate.ok) {
        return { ok: false as const, code: candidate.code, message: candidate.message };
      }
    }
    if (args.field.trim().length === 0 || args.normalizedValue.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "field and normalized value required" };
    }
    const evidenceId = await ctx.db.insert("productEvidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.requirementId === undefined ? {} : { requirementId: args.requirementId }),
      ...(args.candidateId === undefined ? {} : { candidateId: args.candidateId }),
      field: args.field,
      sourceKind: args.sourceKind,
      ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
      capturedAt: args.capturedAt,
      originalValue: args.originalValue,
      normalizedValue: args.normalizedValue,
      verification: "unverified",
      freshness: args.freshness,
      ...(args.lastCheckedAt === undefined ? {} : { lastCheckedAt: args.lastCheckedAt }),
      counterpartyRole: "userImport",
      executionMode: "recorded",
      createdAt: Date.now(),
    });
    return { ok: true as const, evidenceId };
  },
});

const rfqResultValidator = v.union(
  v.object({ ok: v.literal(true), rfqId: v.id("rfqs"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Create an RFQ. Every recipient vendor must belong to the caller's
 * organization AND hold an authorized contact channel for this project:
 * a known vendor without an authorized channel is a `recipient-mismatch`,
 * never a silent send. The idempotency key is unique per project: a
 * replayed key with identical material fields returns the existing row,
 * while a replay with different fields is a `duplicate-conflict` so a
 * collision can never silently swap recipients or scope.
 */
export const createRfq = f1Mutation({
  args: rfqInputValidator.fields,
  returns: rfqResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.recipientVendorIds.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "at least one recipient required" };
    }
    const existing = await ctx.db
      .query("rfqs")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameRecipients =
        existing.recipientVendorIds.length === args.recipientVendorIds.length &&
        existing.recipientVendorIds.every((id) => args.recipientVendorIds.includes(id));
      if (
        existing.requirementId !== args.requirementId ||
        !sameRecipients ||
        existing.briefHash !== args.briefHash ||
        existing.conversationState !== args.conversationState
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, rfqId: existing._id, deduplicated: true };
    }
    const requirement = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
    for (const vendorId of args.recipientVendorIds) {
      const vendor = await ctx.db.get(vendorId);
      if (vendor === null || vendor.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "vendor is not in this organization" };
      }
      // Compound lookup for an authorized channel. Several channels
      // may exist per vendor/project, so existence (not uniqueness) is
      // the check, short-circuiting on the first organization-matching
      // row: exact, with no cap and no silent truncation.
      let authorized = false;
      for await (const contact of ctx.db
        .query("vendorContacts")
        .withIndex("by_vendor_and_project", (q) =>
          q.eq("vendorId", vendorId).eq("projectId", args.projectId),
        )) {
        if (contact.organizationId === args.organizationId) {
          authorized = true;
          break;
        }
      }
      if (!authorized) {
        return { ok: false as const, code: "recipient-mismatch", message: "vendor has no authorized contact in this project" };
      }
    }
    const rfqId = await ctx.db.insert("rfqs", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      idempotencyKey: args.idempotencyKey,
      recipientVendorIds: [...args.recipientVendorIds],
      briefHash: args.briefHash,
      conversationState: args.conversationState,
      createdAt: Date.now(),
    });
    return { ok: true as const, rfqId, deduplicated: false };
  },
});

const negotiationResultValidator = v.union(
  v.object({ ok: v.literal(true), negotiationId: v.id("negotiations") }),
  denialValidator,
);

/**
 * Open a negotiation mandate against one exact quote version. The quote
 * must live in the caller's project; round limits and expiry are stored
 * on the mandate itself (PRD 24).
 */
export const openNegotiation = f1Mutation({
  args: negotiationInputValidator.fields,
  returns: negotiationResultValidator,
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
    const quote = await ctx.db.get(args.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    if (args.roundLimit < 1) {
      return { ok: false as const, code: "invalid-payload", message: "round limit must be positive" };
    }
    const now = Date.now();
    if (args.expiresAt <= now) {
      return { ok: false as const, code: "invalid-payload", message: "mandate already expired" };
    }
    const negotiationId = await ctx.db.insert("negotiations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      quoteId: args.quoteId,
      mandateHash: args.mandateHash,
      ...(args.targetMinorUnits === undefined ? {} : { targetMinorUnits: args.targetMinorUnits }),
      roundLimit: args.roundLimit,
      roundsUsed: 0,
      state: "active",
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, negotiationId };
  },
});

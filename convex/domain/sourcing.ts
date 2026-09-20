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
  providerProductEvidenceInputValidator,
  rfqInputValidator,
  vendorContactInputValidator,
  vendorInputValidator,
} from "../shared/domainContracts.js";
import { f1InternalMutation, type F1MutationCtx } from "../server.js";
import { decimalCompare, decimalToString, decimalZero, quantity } from "../../proofs/money/decimal.js";
import type { Id } from "../_generated/dataModel.js";
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
 * Record a supplier contact channel. Contacts are organization-owned
 * research data describing how a vendor can be reached; they never
 * authorize direct vendor delivery, which stays governed by the
 * communication grant and recipient configuration. The idempotency key
 * is unique per organization: identical replays return the existing
 * row, divergent replays conflict.
 */
export const recordVendorContact = f1Mutation({
  args: vendorContactInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), contactId: v.id("vendorContacts"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    const existing = await ctx.db
      .query("vendorContacts")
      .withIndex("by_organization_and_key", (q) =>
        q.eq("organizationId", args.organizationId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      const samePreference =
        (existing.preference ?? undefined) === args.preference;
      if (
        existing.vendorId !== args.vendorId ||
        existing.channel !== args.channel ||
        existing.detailHash !== args.detailHash ||
        !samePreference
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, contactId: existing._id, deduplicated: true };
    }
    const vendor = await ctx.db.get(args.vendorId);
    if (vendor === null || vendor.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "vendor is not in this organization" };
    }
    if (args.channel.trim().length === 0 || args.detailHash.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "channel and detail hash required" };
    }
    const contactId = await ctx.db.insert("vendorContacts", {
      organizationId: args.organizationId,
      vendorId: args.vendorId,
      channel: args.channel,
      detailHash: args.detailHash,
      ...(args.preference === undefined ? {} : { preference: args.preference }),
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, contactId, deduplicated: false };
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

type ProductEvidenceFields = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  requirementId?: Id<"requirements">;
  candidateId?: Id<"candidates">;
  field: string;
  sourceKind: string;
  sourceUrl?: string;
  capturedAt: number;
  originalValue: string;
  normalizedValue: string;
  freshness: "fresh" | "stale" | "expired" | "unknown";
  lastCheckedAt?: number;
  counterpartyRole: "ownerStandIn" | "vendor";
  executionMode: "live" | "recorded";
  origin: "internal" | "ownerImport";
  idempotencyKey: string;
};

async function checkProductEvidenceRefs(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  requirementId: Id<"requirements"> | undefined,
  candidateId: Id<"candidates"> | undefined,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (requirementId !== undefined) {
    const requirement = await requireOwnedRef(
      await ctx.db.get(requirementId),
      organizationId,
      projectId,
    );
    if (!requirement.ok) {
      return { ok: false as const, code: requirement.code, message: requirement.message };
    }
  }
  if (candidateId !== undefined) {
    const candidate = await requireOwnedRef(
      await ctx.db.get(candidateId),
      organizationId,
      projectId,
    );
    if (!candidate.ok) {
      return { ok: false as const, code: candidate.code, message: candidate.message };
    }
    // F1R-03: when both sides are named, the candidate must belong to
    // the stated requirement. Independent in-project checks preserve a
    // contradiction instead of validating it.
    if (requirementId !== undefined && candidate.value.requirementId !== requirementId) {
      return { ok: false as const, code: "denied-project", message: "candidate is for another requirement" };
    }
  }
  return { ok: true as const };
}

function sameProductEvidenceFields(
  existing: {
    readonly field: string;
    readonly sourceKind: string;
    readonly originalValue: string;
    readonly normalizedValue: string;
    readonly counterpartyRole: string;
    readonly executionMode: string;
    readonly origin: string;
  },
  fields: ProductEvidenceFields,
): boolean {
  return (
    existing.field === fields.field &&
    existing.sourceKind === fields.sourceKind &&
    existing.originalValue === fields.originalValue &&
    existing.normalizedValue === fields.normalizedValue &&
    existing.counterpartyRole === fields.counterpartyRole &&
    existing.executionMode === fields.executionMode &&
    existing.origin === fields.origin
  );
}

async function insertProductEvidence(
  ctx: F1MutationCtx,
  fields: ProductEvidenceFields,
  now: number,
): Promise<Id<"productEvidence">> {
  return await ctx.db.insert("productEvidence", {
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    ...(fields.requirementId === undefined ? {} : { requirementId: fields.requirementId }),
    ...(fields.candidateId === undefined ? {} : { candidateId: fields.candidateId }),
    field: fields.field,
    sourceKind: fields.sourceKind,
    ...(fields.sourceUrl === undefined ? {} : { sourceUrl: fields.sourceUrl }),
    capturedAt: fields.capturedAt,
    originalValue: fields.originalValue,
    normalizedValue: fields.normalizedValue,
    verification: "unverified",
    freshness: fields.freshness,
    ...(fields.lastCheckedAt === undefined ? {} : { lastCheckedAt: fields.lastCheckedAt }),
    counterpartyRole: fields.counterpartyRole,
    executionMode: fields.executionMode,
    origin: fields.origin,
    conflictEvidenceIds: [],
    idempotencyKey: fields.idempotencyKey,
    createdAt: now,
  });
}

const productEvidenceResultValidator = v.union(
  v.object({ ok: v.literal(true), evidenceId: v.id("productEvidence"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Explicit owner-import product evidence (public path). The caller states
 * whose counterparty terms these are from the closed ownerStandIn/vendor
 * union; the row is labeled `ownerImport`/`recorded` so it can never
 * masquerade as a live vendor record. Collection reruns replay through
 * the idempotency key: identical fields deduplicate, divergent fields
 * conflict.
 */
export const recordProductEvidence = f1Mutation({
  args: productEvidenceInputValidator.fields,
  returns: productEvidenceResultValidator,
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
    if (args.field.trim().length === 0 || args.normalizedValue.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "field and normalized value required" };
    }
    const fields: ProductEvidenceFields = {
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
      freshness: args.freshness,
      ...(args.lastCheckedAt === undefined ? {} : { lastCheckedAt: args.lastCheckedAt }),
      counterpartyRole: args.counterpartyRole,
      executionMode: "recorded",
      origin: "ownerImport",
      idempotencyKey: args.idempotencyKey,
    };
    const existing = await ctx.db
      .query("productEvidence")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      if (!sameProductEvidenceFields(existing, fields)) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, evidenceId: existing._id, deduplicated: true };
    }
    const refs = await checkProductEvidenceRefs(
      ctx,
      args.organizationId,
      args.projectId,
      args.requirementId,
      args.candidateId,
    );
    if (!refs.ok) {
      return { ok: false as const, code: refs.code, message: refs.message };
    }
    const evidenceId = await insertProductEvidence(ctx, fields, Date.now());
    return { ok: true as const, evidenceId, deduplicated: false };
  },
});

/**
 * Internal pipeline product evidence (R1/C1 ingestion only): same closed
 * counterparty union, transport-accurate execution mode, `internal`
 * origin. No client can reach this path.
 */
export const ingestProductEvidence = f1InternalMutation({
  args: providerProductEvidenceInputValidator.fields,
  returns: productEvidenceResultValidator,
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (args.field.trim().length === 0 || args.normalizedValue.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "field and normalized value required" };
    }
    const fields: ProductEvidenceFields = {
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
      freshness: args.freshness,
      ...(args.lastCheckedAt === undefined ? {} : { lastCheckedAt: args.lastCheckedAt }),
      counterpartyRole: args.counterpartyRole,
      executionMode: args.executionMode,
      origin: "internal",
      idempotencyKey: args.idempotencyKey,
    };
    const existing = await ctx.db
      .query("productEvidence")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      if (!sameProductEvidenceFields(existing, fields)) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, evidenceId: existing._id, deduplicated: true };
    }
    const refs = await checkProductEvidenceRefs(
      ctx,
      args.organizationId,
      args.projectId,
      args.requirementId,
      args.candidateId,
    );
    if (!refs.ok) {
      return { ok: false as const, code: refs.code, message: refs.message };
    }
    const evidenceId = await insertProductEvidence(ctx, fields, Date.now());
    return { ok: true as const, evidenceId, deduplicated: false };
  },
});

/**
 * Link conflicting field evidence. Every conflicting row must live in
 * the caller's project; the link moves verification to `conflicted`
 * from `unverified` only, so verified findings are never silently
 * disputed and self-links are rejected.
 */
export const linkEvidenceConflict = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    evidenceId: v.id("productEvidence"),
    conflictingIds: v.array(v.id("productEvidence")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
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
    const evidence = await requireOwnedRef(
      await ctx.db.get(args.evidenceId),
      args.organizationId,
      args.projectId,
    );
    if (!evidence.ok) {
      return { ok: false as const, code: evidence.code, message: evidence.message };
    }
    if (evidence.value.verification !== "unverified") {
      return { ok: false as const, code: "invalid-payload", message: "only unverified evidence can gain conflicts" };
    }
    if (args.conflictingIds.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "at least one conflicting row required" };
    }
    for (const conflictingId of args.conflictingIds) {
      if (conflictingId === args.evidenceId) {
        return { ok: false as const, code: "invalid-payload", message: "evidence cannot conflict with itself" };
      }
      const conflicting = await requireOwnedRef(
        await ctx.db.get(conflictingId),
        args.organizationId,
        args.projectId,
      );
      if (!conflicting.ok) {
        return { ok: false as const, code: conflicting.code, message: conflicting.message };
      }
    }
    await ctx.db.patch(args.evidenceId, {
      verification: "conflicted",
      conflictEvidenceIds: [...args.conflictingIds],
    });
    return { ok: true as const };
  },
});

/**
 * Resolve field evidence to verified or superseded. Approver authority
 * or above; terminal states never move again.
 */
export const verifyProductEvidence = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    evidenceId: v.id("productEvidence"),
    verdict: v.union(v.literal("verified"), v.literal("superseded")),
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
    const evidence = await requireOwnedRef(
      await ctx.db.get(args.evidenceId),
      args.organizationId,
      args.projectId,
    );
    if (!evidence.ok) {
      return { ok: false as const, code: evidence.code, message: evidence.message };
    }
    if (evidence.value.verification !== "unverified" && evidence.value.verification !== "conflicted") {
      return { ok: false as const, code: "invalid-payload", message: "evidence already resolved" };
    }
    await ctx.db.patch(args.evidenceId, {
      verification: args.verdict,
      lastCheckedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

const rfqResultValidator = v.union(
  v.object({ ok: v.literal(true), rfqId: v.id("rfqs"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Create an RFQ. `scenarioVendorIds` names researched vendors as scenario
 * context only: the list can neither imply nor authorize direct vendor
 * delivery. Owner-only transport stays governed by the communication
 * grant and recipient configuration (ADR-0004/0007), never by this
 * record. Line items state the requested scope with validated positive
 * decimal quantities; an optional conversation binding must resolve
 * in-project. The idempotency key is unique per project: a replayed key
 * with identical material fields returns the existing row, while a
 * replay with different fields is a `duplicate-conflict`.
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
    if (args.scenarioVendorIds.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "at least one scenario vendor required" };
    }
    if (args.lineItems.length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "at least one line item required" };
    }
    const normalizedLines: { itemId: string; description: string; quantity: string; unit: string }[] = [];
    for (const item of args.lineItems) {
      if (item.itemId.trim().length === 0 || item.description.trim().length === 0 || item.unit.trim().length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "line items require id, description, and unit" };
      }
      let normalizedQuantity: string;
      try {
        const parsed = quantity(item.quantity);
        if (decimalCompare(parsed, decimalZero()) <= 0) {
          return { ok: false as const, code: "invalid-payload", message: "line item quantity must be positive" };
        }
        normalizedQuantity = decimalToString(parsed);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "line item quantity is not a valid decimal" };
      }
      normalizedLines.push({
        itemId: item.itemId,
        description: item.description,
        quantity: normalizedQuantity,
        unit: item.unit,
      });
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
      const sameVendors =
        existing.scenarioVendorIds.length === args.scenarioVendorIds.length &&
        existing.scenarioVendorIds.every((id) => args.scenarioVendorIds.includes(id));
      const sameLines =
        existing.lineItems.length === normalizedLines.length &&
        existing.lineItems.every((line, index) => {
          const wanted = normalizedLines[index];
          return (
            wanted !== undefined &&
            line.itemId === wanted.itemId &&
            line.description === wanted.description &&
            line.quantity === wanted.quantity &&
            line.unit === wanted.unit
          );
        });
      const sameConversation =
        (existing.conversationId ?? undefined) === args.conversationId;
      if (
        existing.requirementId !== args.requirementId ||
        !sameVendors ||
        !sameLines ||
        !sameConversation ||
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
    for (const vendorId of args.scenarioVendorIds) {
      const vendor = await ctx.db.get(vendorId);
      if (vendor === null || vendor.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "vendor is not in this organization" };
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
    const rfqId = await ctx.db.insert("rfqs", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      idempotencyKey: args.idempotencyKey,
      scenarioVendorIds: [...args.scenarioVendorIds],
      lineItems: normalizedLines.map((line) => ({ ...line })),
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
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
 * must live in the caller's project; the mandate pins the quote's exact
 * version, currency, and conversation binding server-side (read from the
 * row, never caller-supplied), plus mandate limits, round budget, and
 * expiry (PRD 24).
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
    if (args.mandateHash.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "mandate hash required" };
    }
    const now = Date.now();
    if (args.expiresAt <= now) {
      return { ok: false as const, code: "invalid-payload", message: "mandate already expired" };
    }
    const negotiationId = await ctx.db.insert("negotiations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      quoteId: args.quoteId,
      quoteVersion: quote.version,
      currency: quote.currency,
      ...(quote.conversationId === undefined ? {} : { conversationId: quote.conversationId }),
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

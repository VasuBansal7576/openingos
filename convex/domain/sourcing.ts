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
  COMPATIBILITY_RULE_VERSION,
  negotiationInputValidator,
  productEvidenceInputValidator,
  providerProductEvidenceInputValidator,
  rfqInputValidator,
  vendorContactInputValidator,
  vendorInputValidator,
} from "../shared/domainContracts.js";
import {
  f1InternalMutation,
  type F1MutationCtx,
} from "../server.js";
import { decimalCompare, decimalToString, decimalZero, quantity } from "../../proofs/money/decimal.js";
import { money as makeMoney } from "../../proofs/money/money.js";
import { canonicalJson } from "../shared/hashing.js";
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
 * (or above) may set pass/fail. F1R-06: every reference must resolve to
 * supporting field evidence inside the caller's project, at the exact
 * stated version, relevant to this candidate's requirement (and variant
 * via the evidence's candidate binding). Each supporting row must
 * already be verification=verified: an unverified owner import can
 * never justify compatibility=pass. The finding pins the requirement
 * version and the compatibility rule version it was decided against.
 * Unsupported facts stay `unknown`: any unresolvable, foreign,
 * stale-version, non-fresh, unverified, disputed, or unrelated
 * reference denies the whole write. There is deliberately no
 * human-override path: a verified-evidence-backed pass is the only
 * pass, so no separate actor/reason/risk override record exists to
 * maintain.
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
    if (args.evidenceRefs.length > MAX_COMPATIBILITY_EVIDENCE_REFS) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: `compatibility evidence references exceed the supported bound of ${MAX_COMPATIBILITY_EVIDENCE_REFS}`,
      };
    }
    const requirement = await ctx.db.get(candidate.value.requirementId);
    if (
      requirement === null ||
      requirement.organizationId !== args.organizationId ||
      requirement.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "requirement is not in this project" };
    }
    for (const ref of args.evidenceRefs) {
      let evidence: {
        organizationId: Id<"organizations">;
        projectId: Id<"projects">;
        requirementId?: Id<"requirements">;
        candidateId?: Id<"candidates">;
        version: string;
        verification: string;
        freshness: string;
      } | null = null;
      try {
        evidence = await ctx.db.get(ref.sourceId as Id<"productEvidence">);
      } catch {
        evidence = null;
      }
      if (evidence === null) {
        return { ok: false as const, code: "unknown-evidence", message: "compatibility evidence does not resolve" };
      }
      if (
        evidence.organizationId !== args.organizationId ||
        evidence.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "compatibility evidence is not in this project" };
      }
      if (ref.version !== evidence.version) {
        return { ok: false as const, code: "stale-evidence", message: "compatibility evidence version changed; re-verify against the current revision" };
      }
      if (evidence.freshness !== "fresh") {
        return { ok: false as const, code: "stale-evidence", message: "compatibility evidence is no longer fresh" };
      }
      if (evidence.verification === "conflicted" || evidence.verification === "superseded") {
        return { ok: false as const, code: "conflicted-evidence", message: "compatibility evidence is disputed" };
      }
      if (evidence.verification !== "verified") {
        return { ok: false as const, code: "unverified-evidence", message: "compatibility evidence is not verified" };
      }
      if (evidence.candidateId !== undefined) {
        if (evidence.candidateId !== args.candidateId) {
          return { ok: false as const, code: "unrelated-evidence", message: "compatibility evidence concerns another variant" };
        }
      } else if (evidence.requirementId !== requirement._id) {
        return { ok: false as const, code: "unrelated-evidence", message: "compatibility evidence concerns another requirement" };
      }
    }
    // Preflight the complete indexed dependent set before changing this
    // candidate. A 257th dependent is denied with no candidate or binding
    // write, so every accepted evidence transition remains enumerable by
    // the bounded invalidation transaction.
    const requestedEvidenceIds = new Set(args.evidenceRefs.map((ref) => ref.sourceId));
    for (const sourceId of requestedEvidenceIds) {
      const dependents = await ctx.db
        .query("compatibilityEvidenceBindings")
        .withIndex("by_evidence", (q) =>
          q.eq("evidenceId", sourceId as Id<"productEvidence">),
        )
        .take(MAX_COMPATIBILITY_FANOUT + 1);
      const dependentCandidateIds = new Set<string>();
      for (const dependent of dependents) {
        if (
          dependent.organizationId !== args.organizationId ||
          dependent.projectId !== args.projectId
        ) {
          return {
            ok: false as const,
            code: "invalid-payload",
            message: "compatibility evidence binding scope is inconsistent",
          };
        }
        dependentCandidateIds.add(dependent.candidateId);
      }
      const currentCandidateAlreadyBound = dependentCandidateIds.has(args.candidateId);
      if (
        dependents.length > MAX_COMPATIBILITY_FANOUT ||
        dependentCandidateIds.size > MAX_COMPATIBILITY_FANOUT ||
        (!currentCandidateAlreadyBound && dependentCandidateIds.size >= MAX_COMPATIBILITY_FANOUT)
      ) {
        return {
          ok: false as const,
          code: "invalid-payload",
          message: `compatibility evidence fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
        };
      }
    }
    // Keep a bounded reverse index for every cited evidence row. The old
    // candidate row remains the authoritative finding payload; these child
    // rows only make sparse invalidation addressable when the requirement
    // itself has more candidates than one transaction may scan or patch.
    // F1R-06 residual: preflight the complete bounded mutation before any
    // write. Every per-evidence binding count is resolved first, so an
    // over-bound set denies with zero writes instead of denying after an
    // earlier evidence row's bindings were already deleted.
    const bindingEvidenceIds = new Set<string>();
    for (const ref of candidate.value.compatibilityEvidenceRefs ?? []) {
      bindingEvidenceIds.add(ref.sourceId);
    }
    for (const ref of args.evidenceRefs) bindingEvidenceIds.add(ref.sourceId);
    if (bindingEvidenceIds.size > MAX_COMPATIBILITY_FANOUT) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: `compatibility evidence binding fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
      };
    }
    const doomedBindingIds: Id<"compatibilityEvidenceBindings">[] = [];
    for (const sourceId of bindingEvidenceIds) {
      const bindings = await ctx.db
        .query("compatibilityEvidenceBindings")
        .withIndex("by_candidate_and_evidence", (q) =>
          q
            .eq("candidateId", args.candidateId)
            .eq("evidenceId", sourceId as Id<"productEvidence">),
        )
        .take(MAX_COMPATIBILITY_FANOUT + 1);
      if (bindings.length > MAX_COMPATIBILITY_FANOUT) {
        return {
          ok: false as const,
          code: "invalid-payload",
          message: `compatibility evidence binding fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
        };
      }
      for (const binding of bindings) doomedBindingIds.push(binding._id);
    }
    for (const bindingId of doomedBindingIds) await ctx.db.delete(bindingId);
    await ctx.db.patch(args.candidateId, {
      compatibility: args.result,
      compatibilityEvidenceRefs: [...args.evidenceRefs],
      compatibilityRequirementVersion: requirement.version,
      compatibilityRuleVersion: COMPATIBILITY_RULE_VERSION,
      compatibilityEvidenceIndexComplete: true,
    });
    const indexedEvidenceIds = new Set<string>();
    for (const ref of args.evidenceRefs) {
      if (indexedEvidenceIds.has(ref.sourceId)) continue;
      indexedEvidenceIds.add(ref.sourceId);
      await ctx.db.insert("compatibilityEvidenceBindings", {
        organizationId: args.organizationId,
        projectId: args.projectId,
        candidateId: args.candidateId,
        evidenceId: ref.sourceId as Id<"productEvidence">,
        evidenceVersion: ref.version,
      });
    }
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
          // A historical row may predate the reverse index. The bounded
          // projection fails closed without reading each evidence ref.
          compatibility: row.compatibility === "pass" &&
              row.compatibilityEvidenceIndexComplete !== true
            ? "unknown"
            : row.compatibility,
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

/**
 * F1R-06 integrity bound. Compatibility invalidation is one transaction, so
 * a requirement-scoped evidence change is accepted only when its indexed
 * candidate fanout fits this bounded write set. The MAX+1 probe below denies
 * before any state changes when the supported fanout is exceeded; it never
 * silently leaves a tail of pass findings stale.
 */
export const MAX_COMPATIBILITY_FANOUT = 256;

/**
 * A finding may cite multiple evidence rows, but each row's reverse index is
 * integrity-checked before a write. Four refs cap that preflight at 1,028
 * binding documents (4 * (MAX_COMPATIBILITY_FANOUT + 1)), in addition to the
 * bounded evidence and candidate reads, instead of multiplying the 256-row
 * fanout probe by an unbounded request array.
 */
export const MAX_COMPATIBILITY_EVIDENCE_REFS = 4;

type CompatibilityEvidenceRef = {
  readonly sourceId: string;
  readonly version: string;
  readonly locator?: string;
};

const LEGACY_REPLAY_AMBIGUOUS = "legacy-replay-ambiguous";

type ProductEvidenceReplaySnapshot = {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId?: Id<"requirements">;
  readonly candidateId?: Id<"candidates">;
  readonly field: string;
  readonly sourceKind: string;
  readonly sourceUrl?: string;
  readonly capturedAt: number;
  readonly originalValue: string;
  readonly normalizedValue: string;
  readonly freshness: string;
  readonly lastCheckedAt?: number;
  readonly counterpartyRole: string;
  readonly executionMode: string;
  readonly origin: string;
};

function productEvidenceReplayIdentity(
  fields: ProductEvidenceReplaySnapshot,
): string {
  return canonicalJson({
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    requirementId: fields.requirementId,
    candidateId: fields.candidateId,
    field: fields.field,
    sourceKind: fields.sourceKind,
    sourceUrl: fields.sourceUrl,
    capturedAt: fields.capturedAt,
    originalValue: fields.originalValue,
    normalizedValue: fields.normalizedValue,
    freshness: fields.freshness,
    lastCheckedAt: fields.lastCheckedAt,
    counterpartyRole: fields.counterpartyRole,
    executionMode: fields.executionMode,
    origin: fields.origin,
  });
}

function legacyReplayIdentityForTransition(
  evidence: ProductEvidenceReplaySnapshot & {
    readonly verification: string;
    readonly ingestionIdentity?: string;
    readonly legacyReplayIdentity?: string;
  },
): string | undefined {
  if (
    evidence.ingestionIdentity !== undefined ||
    evidence.legacyReplayIdentity !== undefined
  ) {
    return undefined;
  }
  return evidence.verification === "unverified"
    ? productEvidenceReplayIdentity(evidence)
    : LEGACY_REPLAY_AMBIGUOUS;
}

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

/**
 * F1R-07: one normalized immutable input snapshot. Replay identity
 * covers every material relationship and provenance field: the
 * requirement/candidate bindings, the source URL and capture time, and
 * freshness/last-checked state alongside the value, source, and
 * counterparty fields. Any divergence is a conflicting replay, never a
 * silent merge of differently attributed records.
 */
function sameProductEvidenceFields(
  existing: {
    readonly requirementId?: Id<"requirements">;
    readonly candidateId?: Id<"candidates">;
    readonly field: string;
    readonly sourceKind: string;
    readonly sourceUrl?: string;
    readonly capturedAt: number;
    readonly originalValue: string;
    readonly normalizedValue: string;
    readonly freshness: string;
    readonly lastCheckedAt?: number;
    readonly counterpartyRole: string;
    readonly executionMode: string;
    readonly origin: string;
    readonly verification: string;
    readonly ingestionIdentity?: string;
    readonly legacyReplayIdentity?: string;
  },
  fields: ProductEvidenceFields,
): boolean {
  if (existing.ingestionIdentity !== undefined) {
    return existing.ingestionIdentity === productEvidenceIngestionIdentity(fields);
  }
  // A current transition captures a complete legacy snapshot before it can
  // mutate lastCheckedAt. Rows already resolved before this deployment have
  // no recoverable original check time, so the explicit ambiguity marker
  // rejects every replay rather than acknowledging changed input.
  if (existing.legacyReplayIdentity === LEGACY_REPLAY_AMBIGUOUS) return false;
  if (existing.legacyReplayIdentity !== undefined) {
    return existing.legacyReplayIdentity === productEvidenceReplayIdentity(fields);
  }
  // An untouched historical row still has its original check time. Compare
  // it strictly, including freshness, before any current verification.
  if (existing.verification !== "unverified") return false;
  return (
    (existing.requirementId ?? undefined) === fields.requirementId &&
    (existing.candidateId ?? undefined) === fields.candidateId &&
    existing.field === fields.field &&
    existing.sourceKind === fields.sourceKind &&
    (existing.sourceUrl ?? undefined) === fields.sourceUrl &&
    existing.capturedAt === fields.capturedAt &&
    existing.originalValue === fields.originalValue &&
    existing.normalizedValue === fields.normalizedValue &&
    existing.freshness === fields.freshness &&
    existing.lastCheckedAt === fields.lastCheckedAt &&
    existing.counterpartyRole === fields.counterpartyRole &&
    existing.executionMode === fields.executionMode &&
    existing.origin === fields.origin
  );
}

/**
 * F1R-07: normalize every material ingestion relationship and provenance
 * field once. Mutable verification/status projections are deliberately not
 * part of this identity, so verification and conflict replay cannot reset a
 * row or create a second evidence record.
 */
function productEvidenceIngestionIdentity(fields: ProductEvidenceFields): string {
  return productEvidenceReplayIdentity(fields);
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
    ingestionIdentity: productEvidenceIngestionIdentity(fields),
    // F1R-06: every evidence row starts at revision "1". Verification
    // or freshness changes bump it so outstanding finding references
    // go stale instead of silently covering new terms.
    version: "1",
    createdAt: now,
  });
}

/** Next evidence revision after a verification/freshness change. */
function bumpEvidenceVersion(version: string): string {
  const parsed = Number.parseInt(version, 10);
  return Number.isSafeInteger(parsed) ? String(parsed + 1) : `${version}.1`;
}

/**
 * F1R-06: invalidate compatibility findings whose supporting evidence
 * just changed meaningfully (conflicted or superseded). Findings that
 * cited the evidence row return to `unknown` with their basis pins
 * cleared; findings on other evidence are untouched.
 *
 * F1R-06 residual: a current-captured row with zero bindings is a
 * complete empty dependent set (no requirement scan); a historical row
 * without ingestion identity keeps the bounded legacy scan. Clearing a
 * candidate removes every basis's binding for that candidate and the
 * full plan is preflighted before any write, keeping the accepted
 * four-reference and 256-dependent bounds with atomic zero-write denial.
 */
async function invalidateDependentCompatibility(
  ctx: F1MutationCtx,
  evidence: {
    readonly _id: Id<"productEvidence">;
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly requirementId?: Id<"requirements">;
    readonly candidateId?: Id<"candidates">;
    readonly ingestionIdentity?: string;
  },
): Promise<{ ok: true } | { ok: false; code: "invalid-payload"; message: string }> {
  type CandidateRow = {
    readonly _id: Id<"candidates">;
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly compatibilityEvidenceRefs?: readonly CompatibilityEvidenceRef[];
  };
  type CandidateInvalidation = {
    readonly row: CandidateRow;
    readonly bindingIds: Id<"compatibilityEvidenceBindings">[];
  };
  const rows = new Map<string, CandidateInvalidation>();
  const staleBindingIds: Id<"compatibilityEvidenceBindings">[] = [];
  const addCandidate = (
    row: CandidateRow,
    bindingId?: Id<"compatibilityEvidenceBindings">,
  ): void => {
    const existing = rows.get(row._id);
    if (existing !== undefined) {
      if (bindingId !== undefined) existing.bindingIds.push(bindingId);
      return;
    }
    rows.set(row._id, {
      row,
      bindingIds: bindingId === undefined ? [] : [bindingId],
    });
  };

  // New findings are addressed through the sparse reverse index. The
  // MAX+1 read is the integrity gate for a dense dependent set, preserving
  // the existing no-write denial instead of partially invalidating a tail.
  const bindings = await ctx.db
    .query("compatibilityEvidenceBindings")
    .withIndex("by_evidence", (q) => q.eq("evidenceId", evidence._id))
    .take(MAX_COMPATIBILITY_FANOUT + 1);
  if (bindings.length > MAX_COMPATIBILITY_FANOUT) {
    return {
      ok: false,
      code: "invalid-payload",
      message: `compatibility fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
    };
  }
  for (const binding of bindings) {
    if (
      binding.organizationId !== evidence.organizationId ||
      binding.projectId !== evidence.projectId
    ) {
      return {
        ok: false,
        code: "invalid-payload",
        message: "compatibility evidence binding scope is inconsistent",
      };
    }
    const candidate = await ctx.db.get(binding.candidateId);
    if (
      candidate === null ||
      candidate.organizationId !== evidence.organizationId ||
      candidate.projectId !== evidence.projectId
    ) {
      staleBindingIds.push(binding._id);
      continue;
    }
    const citesEvidence = (candidate.compatibilityEvidenceRefs ?? [])
      .some((ref) => ref.sourceId === evidence._id);
    if (!citesEvidence) {
      staleBindingIds.push(binding._id);
      continue;
    }
    addCandidate(candidate, binding._id);
  }

  // Historical rows predate the child index. Keep their migration path
  // bounded; once any current binding exists, the indexed set is complete
  // for current writes and public reads derive stale status for old rows.
  // F1R-06 residual: a complete current reverse index containing zero
  // dependents is distinct from uncertain historical migration. Every
  // compatibility write maintains bindings, so a current-captured evidence
  // row (stored ingestion identity) with zero bindings has no dependents
  // and needs no requirement scan. Rows without that identity predate the
  // guarantee and keep the bounded legacy fallback below.
  if (bindings.length === 0 && evidence.candidateId !== undefined) {
    const direct = await ctx.db.get(evidence.candidateId);
    if (
      direct !== null &&
      direct.organizationId === evidence.organizationId &&
      direct.projectId === evidence.projectId &&
      (direct.compatibilityEvidenceRefs ?? []).some((ref) => ref.sourceId === evidence._id)
    ) {
      addCandidate(direct);
    }
  } else if (
    bindings.length === 0 &&
    evidence.candidateId === undefined &&
    evidence.requirementId !== undefined &&
    evidence.ingestionIdentity === undefined
  ) {
    const scoped = await ctx.db
      .query("candidates")
      .withIndex("by_requirement", (q) => q.eq("requirementId", evidence.requirementId as Id<"requirements">))
      .take(MAX_COMPATIBILITY_FANOUT + 1);
    if (scoped.length > MAX_COMPATIBILITY_FANOUT) {
      return {
        ok: false,
        code: "invalid-payload",
        message: `compatibility fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
      };
    }
    for (const row of scoped) {
      if (
        row.organizationId === evidence.organizationId &&
        row.projectId === evidence.projectId &&
        (row.compatibilityEvidenceRefs ?? []).some((ref) => ref.sourceId === evidence._id)
      ) {
        addCandidate(row);
      }
    }
  }

  // F1R-06 residual: clearing a candidate wipes its entire compatibility
  // evidence list, so every basis's reverse-index row for that candidate
  // goes stale — not just the triggering evidence's row. Leaving the other
  // basis's bindings behind would strand its fanout capacity against
  // candidates that no longer cite it. Preflight the complete bounded
  // mutation (all affected candidates plus every binding row to delete)
  // before any write, so an over-bound set denies with zero writes.
  const plannedBindingDeletes = new Set<string>();
  for (const bindingId of staleBindingIds) plannedBindingDeletes.add(bindingId);
  for (const { bindingIds } of rows.values()) {
    for (const bindingId of bindingIds) plannedBindingDeletes.add(bindingId);
  }
  for (const { row } of rows.values()) {
    const refs = row.compatibilityEvidenceRefs ?? [];
    if (refs.length > MAX_COMPATIBILITY_EVIDENCE_REFS) {
      return {
        ok: false,
        code: "invalid-payload",
        message: `compatibility evidence references exceed the supported bound of ${MAX_COMPATIBILITY_EVIDENCE_REFS}`,
      };
    }
    for (const ref of refs) {
      if (ref.sourceId === evidence._id) continue;
      const found = await ctx.db
        .query("compatibilityEvidenceBindings")
        .withIndex("by_candidate_and_evidence", (q) =>
          q
            .eq("candidateId", row._id)
            .eq("evidenceId", ref.sourceId as Id<"productEvidence">),
        )
        .take(2);
      if (found.length > 1) {
        return {
          ok: false,
          code: "invalid-payload",
          message: `compatibility evidence binding fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
        };
      }
      for (const binding of found) {
        if (
          binding.organizationId !== evidence.organizationId ||
          binding.projectId !== evidence.projectId
        ) {
          return {
            ok: false,
            code: "invalid-payload",
            message: "compatibility evidence binding scope is inconsistent",
          };
        }
        plannedBindingDeletes.add(binding._id);
      }
    }
  }
  if (rows.size > MAX_COMPATIBILITY_FANOUT) {
    return {
      ok: false,
      code: "invalid-payload",
      message: `compatibility fanout exceeds the supported bound of ${MAX_COMPATIBILITY_FANOUT}`,
    };
  }

  for (const bindingId of plannedBindingDeletes) {
    await ctx.db.delete(bindingId as Id<"compatibilityEvidenceBindings">);
  }
  for (const { row } of rows.values()) {
    await ctx.db.patch(row._id, {
      compatibility: "unknown",
      compatibilityEvidenceRefs: [],
      compatibilityRequirementVersion: undefined,
      compatibilityRuleVersion: undefined,
      compatibilityEvidenceIndexComplete: false,
    });
  }
  return { ok: true };
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
 * from `unverified` or `verified`, so findings decided against the
 * undisputed revision are invalidated rather than silently disputed,
 * and self-links are rejected. Terminal states never move again.
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
    if (evidence.value.verification !== "unverified" && evidence.value.verification !== "verified") {
      return { ok: false as const, code: "invalid-payload", message: "only undisputed evidence can gain conflicts" };
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
    // F1R-06: check the bounded invalidation set before changing the receipt.
    // An over-bound fanout returns with zero writes rather than leaving stale
    // compatibility passes behind.
    const invalidation = await invalidateDependentCompatibility(ctx, evidence.value);
    if (!invalidation.ok) return invalidation;
    const legacyReplayIdentity = legacyReplayIdentityForTransition(evidence.value);
    await ctx.db.patch(args.evidenceId, {
      verification: "conflicted",
      conflictEvidenceIds: [...args.conflictingIds],
      version: bumpEvidenceVersion(evidence.value.version),
      ...(legacyReplayIdentity === undefined ? {} : { legacyReplayIdentity }),
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
    // F1R-06: resolve the bounded invalidation set before changing the
    // evidence. A supersession that exceeds the bound is denied with zero
    // writes, so no stale compatibility pass can be observed.
    if (args.verdict === "superseded") {
      const invalidation = await invalidateDependentCompatibility(ctx, evidence.value);
      if (!invalidation.ok) return invalidation;
    }
    const legacyReplayIdentity = legacyReplayIdentityForTransition(evidence.value);
    await ctx.db.patch(args.evidenceId, {
      verification: args.verdict,
      lastCheckedAt: Date.now(),
      version: bumpEvidenceVersion(evidence.value.version),
      ...(legacyReplayIdentity === undefined ? {} : { legacyReplayIdentity }),
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
      // F1R-07: replay identity uses normalized vendor-set equality:
      // duplicates and order never distinguish a replay from the
      // original row, while a different set conflicts.
      const existingVendors = new Set(existing.scenarioVendorIds);
      const wantedVendors = new Set(args.scenarioVendorIds);
      const sameVendors =
        existingVendors.size === wantedVendors.size &&
        [...existingVendors].every((id) => wantedVendors.has(id));
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
 * F1R-21: a stored negotiation row without finite mandate limits is never
 * usable authority. Rows predating finite-limit validation fail
 * `isUsableNegotiationMandate` and must be treated as expired by every
 * future send path: revoke or expire them through the normal lifecycle,
 * never authorize a send from them, and never repair them by inventing a
 * limit the approver did not set.
 */
export function isUsableNegotiationMandate(
  row: {
    readonly roundLimit: number;
    readonly expiresAt: number;
    readonly targetMinorUnits?: number;
    readonly currency: string;
    readonly state: string;
    readonly roundsUsed: number;
  },
  now: number,
): boolean {
  if (row.state !== "active") return false;
  if (!Number.isSafeInteger(row.roundLimit) || row.roundLimit < 1) return false;
  if (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= now) return false;
  if (!Number.isSafeInteger(row.roundsUsed) || row.roundsUsed < 0) return false;
  if (row.roundsUsed >= row.roundLimit) return false;
  if (row.targetMinorUnits !== undefined) {
    try {
      makeMoney(row.currency, row.targetMinorUnits);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Open a negotiation mandate against one exact quote version. The quote
 * must live in the caller's project; the mandate pins the quote's exact
 * version, currency, and conversation binding server-side (read from the
 * row, never caller-supplied), plus mandate limits, round budget, and
 * expiry (PRD 24).
 *
 * F1R-21: Convex numbers admit NaN and infinity, and neither comparison
 * below rejects them, so every numeric mandate limit is validated as a
 * finite value before any insert: a finite positive safe-integer round
 * limit, a finite safe-integer future expiry, and exact finite
 * nonnegative integer minor units checked through the accepted money
 * constructor against the quote currency.
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
    if (
      typeof args.roundLimit !== "number" ||
      !Number.isSafeInteger(args.roundLimit) ||
      args.roundLimit < 1
    ) {
      return { ok: false as const, code: "invalid-payload", message: "round limit must be a finite positive safe integer" };
    }
    if (args.mandateHash.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "mandate hash required" };
    }
    const now = Date.now();
    if (
      typeof args.expiresAt !== "number" ||
      !Number.isFinite(args.expiresAt) ||
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= now
    ) {
      const finite =
        typeof args.expiresAt === "number" && Number.isFinite(args.expiresAt);
      return {
        ok: false as const,
        code: "invalid-payload",
        message: finite
          ? "mandate already expired"
          : "mandate expiry must be a finite future timestamp",
      };
    }
    if (args.targetMinorUnits !== undefined) {
      if (
        typeof args.targetMinorUnits !== "number" ||
        !Number.isSafeInteger(args.targetMinorUnits) ||
        args.targetMinorUnits < 0
      ) {
        return { ok: false as const, code: "invalid-payload", message: "negotiation target must be finite nonnegative integer minor units" };
      }
      try {
        makeMoney(quote.currency, args.targetMinorUnits);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "negotiation target money is invalid" };
      }
    }
    // The mandate-approved conversation identity is read server-side from
    // the live conversation row at approval: the exact approved version AND
    // the exact approved state. These are pins, not mirrors: raw inbound
    // callback ingestion never advances them, so a reply recorded after
    // approval leaves the live conversation ahead of the pins and every
    // dependent claim fails closed until an explicit reply-incorporation
    // transition exists.
    let approvedConversationVersion: number | undefined;
    let approvedConversationState: "draft" | "queued" | "awaitingReply" | "replyReceived" | "closed" | "cancelled" | undefined;
    if (quote.conversationId !== undefined) {
      const boundConversation = await ctx.db.get(quote.conversationId);
      if (boundConversation !== null) {
        approvedConversationVersion = boundConversation.version;
        approvedConversationState = boundConversation.state;
      }
    }
    const negotiationId = await ctx.db.insert("negotiations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      quoteId: args.quoteId,
      quoteVersion: quote.version,
      currency: quote.currency,
      ...(quote.conversationId === undefined ? {} : { conversationId: quote.conversationId }),
      ...(approvedConversationVersion === undefined ? {} : { conversationVersion: approvedConversationVersion }),
      ...(approvedConversationState === undefined ? {} : { conversationState: approvedConversationState }),
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

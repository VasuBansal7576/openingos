/**
 * F1 durable shared-schema authority (controlled contract, NR03 gate).
 *
 * This schema is the single frozen record layout for dependent R1/C1/U1/E1
 * workers. Physical table names are frozen once this file lands; later
 * packages must request a foundation-owner amendment instead of inventing
 * parallel schemas.
 *
 * Every table carries its owning organization (and project where applicable)
 * so backend code can enforce tenant/project isolation on every direct call.
 * Money is integer minor units plus ISO currency; unknown charges are never
 * stored as zero. All evidence is labeled controlled until a live gate passes.
 *
 * Payload binding (coordinator design check, 2026-09-20): the approved
 * payload is persisted as its exact canonical string (`normalizedPayload`)
 * and equality is decided by exact canonical-string comparison. The FNV-1a
 * `normalizedPayloadHash` is an index hint only, never the sole binding.
 * The validated boundary additionally records a collision-resistant
 * `payloadSha256` (crypto.subtle, async); when both sides present it, the
 * claim requires it to match as well.
 *
 * Shared budgets (coordinator design check, 2026-09-20): per-job
 * reservations draw atomically from the organization-level `providerBudgets`
 * ledger, so two concurrent branches or jobs cannot each spend the full
 * shared allowance. The job reservation is a partition of the org ledger,
 * not an independent allowance.
 *
 * Auth tables (Astra F1-19): the official Convex Auth server writes its
 * users/sessions/accounts/verifiers/rate-limits to APP tables declared
 * here via `authTables`. Without them, anonymous sign-in fails on a
 * missing `providerAndAccountId` index. These tables are auth
 * infrastructure; product authority still lives in memberships/grants.
 */

import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  quoteComparisonScopeValidator,
  quoteEvidenceRefValidator,
  quoteTaxBasisValidator,
  storedQuoteChargeValidator,
  storedQuoteLineValidator,
} from "./shared/quoteSemantics.js";
import {
  storedAcceptanceLineValidator,
  storedFinancialEvidenceRefValidator,
  storedOrderLineValidator,
  storedSelectionLineValidator,
  requirementMilestoneValidator,
} from "./shared/domainContracts.js";
import { workflowAuthoritiesValidator, workflowAuthorityValidator } from "./shared/scope.js";

/**
 * Negotiation authority binding (Devin findings 4060796830/4060796928):
 * prepared negotiation sends carry an immutable pin of the exact mandate
 * facts they were approved under. Every value is derived server-side from
 * the live rows at preparation; the atomic claim rechecks each pin against
 * the current rows immediately before provider effect. Optional so
 * historical operations without the binding stay readable.
 */
const negotiationConversationStateValidator = v.union(
  v.literal("draft"),
  v.literal("queued"),
  v.literal("awaitingReply"),
  v.literal("replyReceived"),
  v.literal("closed"),
  v.literal("cancelled"),
);
const negotiationAuthorityValidator = v.object({
  negotiationId: v.id("negotiations"),
  quoteId: v.id("quotes"),
  quoteVersion: v.string(),
  quoteContentHash: v.string(),
  roundsUsed: v.number(),
  conversationId: v.optional(v.id("conversations")),
  conversationVersion: v.optional(v.number()),
  conversationState: v.optional(negotiationConversationStateValidator),
});

/**
 * Field-level evidence references for the F1 shared-domain graph use the
 * quote-semantics shape (optional locator): research claims often carry
 * source/version identity without a byte locator, and handlers narrow
 * each entry before the write.
 */
const domainEvidenceRefValidator = quoteEvidenceRefValidator;

const moneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});

const evidenceRefValidator = v.object({
  sourceId: v.string(),
  version: v.string(),
  locator: v.string(),
});

export default defineSchema({
  ...authTables,
  organizations: defineTable({
    name: v.string(),
    kind: v.union(v.literal("guest"), v.literal("private")),
    createdAt: v.number(),
  }).index("by_kind", ["kind"]),

  projects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    visibility: v.union(v.literal("open"), v.literal("restricted")),
    locationId: v.optional(v.id("locations")),
    currency: v.optional(v.string()),
    budgetMinorUnits: v.optional(v.number()),
    needByAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  locations: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    region: v.string(),
    reportingCurrency: v.string(),
    operatingStatus: v.string(),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  requirements: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    key: v.string(),
    title: v.string(),
    category: v.string(),
    quantity: v.string(),
    unit: v.string(),
    priority: v.union(v.literal("P0"), v.literal("P1"), v.literal("P2")),
    state: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("sourcing"),
      v.literal("readyForDecision"),
      v.literal("selected"),
      v.literal("fulfilled"),
      v.literal("cancelled"),
    ),
    fulfillment: v.union(
      v.literal("notOrdered"),
      v.literal("ordered"),
      v.literal("partiallyDelivered"),
      v.literal("delivered"),
      v.literal("installed"),
      v.literal("commissioned"),
      v.literal("cancelled"),
    ),
    version: v.number(),
    budgetMinorUnits: v.optional(v.number()),
    currency: v.optional(v.string()),
    needByAt: v.optional(v.number()),
    hardConstraints: v.optional(v.string()),
    responsible: v.optional(v.string()),
    requiredMilestone: v.optional(requirementMilestoneValidator),
    templateId: v.optional(v.id("templates")),
    templateVersion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "key"])
    .index("by_project_and_state", ["projectId", "state"])
    .index("by_organization_and_project", ["organizationId", "projectId"])
    .index("by_organization_and_project_and_title", ["organizationId", "projectId", "title"]),

  /** Immutable before/after history for optimistic requirement edits. */
  requirementRevisions: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    idempotencyKey: v.string(),
    expectedVersion: v.number(),
    previousVersion: v.number(),
    nextVersion: v.number(),
    patchCanonical: v.string(),
    before: v.string(),
    after: v.string(),
    actor: v.string(),
    createdAt: v.number(),
  })
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_requirement", ["requirementId"]),

  dependencies: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    fromRequirementId: v.id("requirements"),
    toRequirementId: v.id("requirements"),
    kind: v.union(v.literal("technical"), v.literal("scheduling")),
    verification: v.union(
      v.literal("pending"),
      v.literal("verified"),
      v.literal("failed"),
      v.literal("waived"),
    ),
    responsible: v.optional(v.string()),
    evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_from_requirement", ["fromRequirementId"])
    .index("by_to_requirement", ["toRequirementId"]),

  /** Immutable transition history for dependency verification decisions. */
  dependencyRevisions: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    dependencyId: v.id("dependencies"),
    beforeVerification: v.string(),
    afterVerification: v.string(),
    beforeEvidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    afterEvidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    reason: v.optional(v.string()),
    actor: v.string(),
    createdAt: v.number(),
  })
    .index("by_dependency", ["dependencyId"]),

  vendors: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    regions: v.array(v.string()),
    dealerEvidence: v.optional(v.string()),
    serviceCoverage: v.optional(v.string()),
    serviceCheckedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_name", ["organizationId", "name"]),

  vendorContacts: defineTable({
    organizationId: v.id("organizations"),
    vendorId: v.id("vendors"),
    channel: v.string(),
    detailHash: v.string(),
    preference: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_vendor", ["vendorId"])
    .index("by_organization_and_key", ["organizationId", "idempotencyKey"]),

  candidates: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    vendorId: v.id("vendors"),
    productModel: v.string(),
    variant: v.string(),
    variantKey: v.string(),
    compatibility: v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown")),
    compatibilityEvidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    // F1R-06: a compatibility finding pins the exact basis it was
    // decided against — the requirement version and the compatibility
    // rule version — so later input changes can be detected as stale.
    compatibilityRequirementVersion: v.optional(v.number()),
    compatibilityRuleVersion: v.optional(v.string()),
    // F1R-06: current writes maintain a complete reverse index for the
    // cited evidence refs. Historical rows without this marker fail closed
    // at the list projection until they are re-verified.
    compatibilityEvidenceIndexComplete: v.optional(v.boolean()),
    conversationState: v.union(
      v.literal("draft"),
      v.literal("awaitingReply"),
      v.literal("clarificationNeeded"),
      v.literal("quoteReceived"),
      v.literal("negotiating"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_requirement", ["requirementId"])
    .index("by_requirement_and_variant", ["requirementId", "variantKey"]),

  productEvidence: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
    candidateId: v.optional(v.id("candidates")),
    field: v.string(),
    sourceKind: v.string(),
    sourceUrl: v.optional(v.string()),
    capturedAt: v.number(),
    originalValue: v.string(),
    normalizedValue: v.string(),
    verification: v.union(
      v.literal("unverified"),
      v.literal("verified"),
      v.literal("conflicted"),
      v.literal("superseded"),
    ),
    freshness: v.union(
      v.literal("fresh"),
      v.literal("stale"),
      v.literal("expired"),
      v.literal("unknown"),
    ),
    lastCheckedAt: v.optional(v.number()),
    counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
    executionMode: v.union(
      v.literal("live"),
      v.literal("recorded"),
      v.literal("fixture"),
    ),
    origin: v.union(v.literal("internal"), v.literal("ownerImport")),
    conflictEvidenceIds: v.array(v.id("productEvidence")),
    // C1 inbound source link: an agentmail message marker records the exact
    // evidence row it was extracted from, so replay and quote extraction use
    // a durable link instead of scanning a project evidence prefix.
    sourceEvidenceId: v.optional(v.id("evidence")),
    idempotencyKey: v.string(),
    // F1R-07: the normalized ingestion identity is immutable. Verification,
    // freshness, and status projections may change without changing replay
    // identity, while any material ingestion input still conflicts.
    ingestionIdentity: v.optional(v.string()),
    // F1R-07 migration bridge: a current deployment captures the legacy
    // replay identity before mutating an old row, or records explicit
    // ambiguity when that original check-time value is already unavailable.
    legacyReplayIdentity: v.optional(v.string()),
    // F1R-06: explicit evidence revision. Compatibility findings bind
    // the exact version they were decided against; any verification or
    // freshness change bumps it so outstanding refs go stale.
    version: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_candidate", ["candidateId"])
    .index("by_requirement", ["requirementId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  /**
   * F1R-06 migration-safe reverse index for compatibility findings.
   * New compatibility writes record one child row per cited evidence row,
   * so invalidation reads only the sparse dependent set instead of scanning
   * every candidate under a requirement. Existing candidate rows remain
   * valid without a binding and are handled by the bounded legacy fallback.
   */
  compatibilityEvidenceBindings: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    candidateId: v.id("candidates"),
    evidenceId: v.id("productEvidence"),
    evidenceVersion: v.string(),
  })
    .index("by_evidence", ["evidenceId"])
    .index("by_candidate_and_evidence", ["candidateId", "evidenceId"]),

  rfqs: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    idempotencyKey: v.string(),
    scenarioVendorIds: v.array(v.id("vendors")),
    lineItems: v.array(
      v.object({
        itemId: v.string(),
        description: v.string(),
        quantity: v.string(),
        unit: v.string(),
      }),
    ),
    conversationId: v.optional(v.id("conversations")),
    briefHash: v.string(),
    conversationState: v.union(
      v.literal("draft"),
      v.literal("awaitingReply"),
      v.literal("clarificationNeeded"),
      v.literal("quoteReceived"),
      v.literal("negotiating"),
      v.literal("closed"),
    ),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_requirement", ["requirementId"]),

  negotiations: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    quoteId: v.id("quotes"),
    quoteVersion: v.string(),
    currency: v.string(),
    conversationId: v.optional(v.id("conversations")),
    // Mandate-approved conversation identity, pinned server-side when
    // openNegotiation binds the quote conversation: the exact approved
    // version AND the exact approved state. Raw inbound callback ingestion
    // never advances these pins: the callback already increments the live
    // conversation version and sets replyReceived, so a newer or
    // state-drifted live conversation creates a fail-closed mismatch until
    // an explicit reply-incorporation transition exists. Optional for
    // historical rows.
    conversationVersion: v.optional(v.number()),
    conversationState: v.optional(negotiationConversationStateValidator),
    mandateHash: v.string(),
    targetMinorUnits: v.optional(v.number()),
    roundLimit: v.number(),
    roundsUsed: v.number(),
    state: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("concluded"),
      v.literal("expired"),
      v.literal("revoked"),
    ),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_state", ["projectId", "state"])
    .index("by_quote", ["quoteId"]),

  selections: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    requirementId: v.id("requirements"),
    candidateId: v.id("candidates"),
    quoteId: v.id("quotes"),
    quoteVersion: v.string(),
    // F1R-13: `selectionLines` is the authoritative normalized per-line
    // selection (quote line id, canonical decimal quantity, unit).
    // `quantity` is the legacy single-line mirror, present only when the
    // selection carries exactly one line.
    quantity: v.optional(v.string()),
    selectionLines: v.optional(v.array(storedSelectionLineValidator)),
    requirementVersion: v.number(),
    actor: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_requirement", ["requirementId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  approvals: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    scope: v.string(),
    snapshotCanonical: v.string(),
    snapshotHash: v.string(),
    selectionId: v.optional(v.id("selections")),
    quoteId: v.optional(v.id("quotes")),
    // Derived server-side from the linked selection/quote. These fields let
    // approval decisions re-check the exact requirement basis after edits.
    requirementId: v.optional(v.id("requirements")),
    requirementVersion: v.optional(v.number()),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("invalidated"),
    ),
    approver: v.string(),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_state", ["projectId", "state"])
    .index("by_project_and_snapshot", ["projectId", "snapshotHash"]),

  orders: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    selectionId: v.id("selections"),
    requirementId: v.id("requirements"),
    quoteId: v.id("quotes"),
    quoteVersion: v.string(),
    requirementVersion: v.number(),
    idempotencyKey: v.string(),
    // F1R-13: `orderLines` is the authoritative normalized per-line
    // commitment. `orderedQuantity` is the legacy single-line mirror,
    // present only when the order carries exactly one line.
    orderedQuantity: v.optional(v.string()),
    orderLines: v.optional(v.array(storedOrderLineValidator)),
    supplierReference: v.optional(v.string()),
    state: v.union(v.literal("recorded"), v.literal("amended"), v.literal("cancelled")),
    amendmentCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_selection", ["selectionId"]),

  orderEvents: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    orderId: v.id("orders"),
    kind: v.union(
      v.literal("confirmation"),
      v.literal("shipment"),
      v.literal("partialDelivery"),
      v.literal("acceptance"),
      v.literal("installation"),
      v.literal("commissioning"),
    ),
    // F1R-13: `acceptanceLines` is the authoritative per-line acceptance
    // (quote line id, canonical decimal accepted quantity, unit).
    // `acceptedQuantity` is the legacy single-line mirror, present only
    // when the event carries exactly one acceptance line.
    acceptedQuantity: v.optional(v.string()),
    acceptanceLines: v.optional(v.array(storedAcceptanceLineValidator)),
    note: v.optional(v.string()),
    recordedBy: v.string(),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  costEntries: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    orderId: v.id("orders"),
    kind: v.union(
      v.literal("payment"),
      v.literal("settledCost"),
      v.literal("refund"),
      v.literal("credit"),
    ),
    amount: moneyValidator,
    idempotencyKey: v.string(),
    linkedEntryId: v.optional(v.id("costEntries")),
    // F1R-13 adjustment lineage: the affected order line and quantity
    // (required for credits/refunds, optional as a complete triple for
    // payments/settled costs) plus typed immutable evidence references.
    // Quote-level shared charges stay quote-level: no line allocation is
    // ever inferred from descriptions.
    quoteLineId: v.optional(v.string()),
    affectedQuantity: v.optional(v.string()),
    affectedUnit: v.optional(v.string()),
    evidenceRefs: v.optional(v.array(storedFinancialEvidenceRefValidator)),
    recordedBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_order", ["orderId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_project_and_kind", ["projectId", "kind"])
    // Link repair: bounded existence lookup for exclusive credit/refund
    // pairing. Rows without a link carry no `linkedEntryId` and never
    // enter this index; only paired rows are scanned, one at most.
    .index("by_linked_entry", ["linkedEntryId"]),

  assets: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    locationId: v.optional(v.id("locations")),
    orderId: v.optional(v.id("orders")),
    label: v.string(),
    serial: v.optional(v.string()),
    constraints: v.optional(v.string()),
    purchaseProvenance: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_location", ["locationId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  assetDocuments: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    assetId: v.id("assets"),
    kind: v.string(),
    storageRef: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_asset", ["assetId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  serviceCases: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    assetId: v.id("assets"),
    urgency: v.union(v.literal("urgent"), v.literal("high"), v.literal("normal"), v.literal("low")),
    summary: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("inProgress"),
      v.literal("waitingForSupplier"),
      v.literal("resolved"),
      v.literal("closed"),
    ),
    outcome: v.optional(v.string()),
    idempotencyKey: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_asset", ["assetId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  watches: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    jobId: v.optional(v.id("jobs")),
    targetKind: v.literal("candidate"),
    targetId: v.id("candidates"),
    cadenceMs: v.number(),
    nextCheckAt: v.number(),
    state: v.union(v.literal("active"), v.literal("paused"), v.literal("stopped")),
    lastResult: v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
    lastCheckedAt: v.optional(v.number()),
    source: v.union(v.literal("internal"), v.literal("ownerImport")),
    counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
    evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    idempotencyKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_state", ["projectId", "state"])
    .index("by_project_and_nextCheck", ["projectId", "nextCheckAt"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"]),

  projectEvents: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    kind: v.string(),
    actor: v.string(),
    evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_kind", ["projectId", "kind"]),

  risks: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    scope: v.string(),
    severity: v.union(v.literal("critical"), v.literal("high"), v.literal("medium"), v.literal("low")),
    state: v.union(
      v.literal("open"),
      v.literal("mitigating"),
      v.literal("resolved"),
      v.literal("accepted"),
    ),
    source: v.string(),
    owner: v.optional(v.string()),
    dependencyIds: v.array(v.id("dependencies")),
    acceptedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_state", ["projectId", "state"])
    .index("by_project_and_severity", ["projectId", "severity"]),

  templates: defineTable({
    organizationId: v.id("organizations"),
    sourceProjectId: v.id("projects"),
    name: v.string(),
    version: v.string(),
    requirementSnapshot: v.string(),
    constraintSnapshot: v.string(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_version", ["organizationId", "version"]),

  memberships: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    identity: v.string(),
    role: v.union(
      v.literal("owner"),
      v.literal("approver"),
      v.literal("contributor"),
      v.literal("viewer"),
    ),
    status: v.union(v.literal("active"), v.literal("revoked")),
    version: v.number(),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_organization_and_identity", ["organizationId", "identity"])
    .index("by_project_and_identity", ["projectId", "identity"])
    // Legacy membership rows remain addressable by their exact authority
    // dimensions.  The access checks use the maintained projection below for
    // current writes, while this index keeps bounded compatibility probes
    // available for rows written before the projection was introduced.
    .index(
      "by_organization_and_identity_and_project_and_status_and_role",
      ["organizationId", "identity", "projectId", "status", "role"],
    )
    // The deadline suffix lets migration reads select permanent rows and the
    // strongest currently valid temporary row without collecting history.
    .index(
      "by_organization_and_identity_and_project_and_status_and_role_and_expires_at",
      ["organizationId", "identity", "projectId", "status", "role", "expiresAt"],
    ),

  /**
   * Current authority projection for membership history.
   *
   * One row is written for every active membership grant, and removed when
   * that membership is revoked.  `authorityUntil` is a sortable deadline:
   * Number.MAX_VALUE represents permanent authority.  Access checks
   * ask for the newest row for each scope/role, so they never collect the
   * append-only membership history.
   */
  membershipAuthorities: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.optional(v.id("projects")),
    identity: v.string(),
    scopeKey: v.string(),
    role: v.union(
      v.literal("owner"),
      v.literal("approver"),
      v.literal("contributor"),
      v.literal("viewer"),
    ),
    membershipId: v.id("memberships"),
    authorityUntil: v.number(),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    // S1/U1 projection pages one identity's authority horizons without
    // scanning other identities; organization and project remain in the key
    // for consumer-side tenant and project rechecks on each returned row.
    .index(
      "by_identity_and_authority_until_and_organization_and_project",
      ["identity", "authorityUntil", "organizationId", "projectId"],
    )
    .index(
      "by_organization_and_identity_and_scope_and_role_and_authority_until",
      ["organizationId", "identity", "scopeKey", "role", "authorityUntil"],
    )
    .index("by_membership", ["membershipId"]),

  recipientConfigs: defineTable({
    version: v.number(),
    mailboxNormalized: v.string(),
    mailboxHash: v.string(),
    active: v.boolean(),
    configuredAt: v.number(),
    configuredBy: v.string(),
  })
    .index("by_version", ["version"])
    .index("by_active", ["active"]),

  providerBudgets: defineTable({
    organizationId: v.id("organizations"),
    ceilingMicroUsd: v.number(),
    reservedMicroUsd: v.number(),
    spentMicroUsd: v.number(),
    unresolvedMicroUsd: v.number(),
    pricingBasis: v.string(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  grants: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    operations: v.array(v.string()),
    communicationProfile: v.string(),
    recipientConfigVersion: v.number(),
    inputVersions: v.record(v.string(), v.string()),
    canonicalPayload: v.string(),
    payloadHash: v.string(),
    payloadSha256: v.optional(v.string()),
    // A bounded, discriminated authority entry is stored for each allowed
    // operation and copied into the job/operation that uses it.
    workflowAuthorities: v.optional(workflowAuthoritiesValidator),
    costCeilingMicroUsd: v.number(),
    roundLimit: v.number(),
    expiresAt: v.number(),
    revocationVersion: v.number(),
    status: v.union(v.literal("active"), v.literal("revoked"), v.literal("expired")),
    conversationId: v.optional(v.id("conversations")),
    createdAt: v.number(),
  })
    .index("by_project_and_status", ["projectId", "status"])
    .index("by_organization", ["organizationId"]),

  jobs: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    grantId: v.id("grants"),
    grantVersion: v.number(),
    kind: v.union(
      v.literal("research"),
      v.literal("communication"),
      v.literal("execution"),
    ),
    // F1R-20: jobs retain the server-validated OpeningOS purpose and the
    // organization/project binding used again at operation claim. Optional
    // keeps legacy controlled rows readable; new jobs always populate both.
    workflowPurpose: v.optional(
      v.union(v.literal("purchasingResearch"), v.literal("purchasingCommunication")),
    ),
    workflowContext: v.optional(v.string()),
    state: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("waitingForSupplier"),
      v.literal("waitingForUser"),
      v.literal("pausedBudget"),
      v.literal("completed"),
      v.literal("partial"),
      v.literal("failed"),
      // Cancellation is a durable fence before cleanup finishes. Claims,
      // operation creation, and new reservations reject both cancelling and
      // cancelled jobs.
      v.literal("cancelling"),
      v.literal("cancelled"),
    ),
    inputVersions: v.record(v.string(), v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    // Cleanup progresses through bounded operation and reservation pages.
    // Null means that phase has not consumed a page yet; a string is the
    // opaque Convex cursor for the next page.
    cancellationPhase: v.optional(
      v.union(v.literal("operations"), v.literal("reservations"), v.literal("complete")),
    ),
    cancellationOperationCursor: v.optional(v.union(v.string(), v.null())),
    cancellationReservationCursor: v.optional(v.union(v.string(), v.null())),
    cancellationOperationsProcessed: v.optional(v.number()),
    cancellationReservationsProcessed: v.optional(v.number()),
    // Reconciliation is separate from bounded cleanup completion. The sample
    // is capped by the execution handler and the count remains the durable
    // aggregate when more unresolved operations exist than can be returned.
    cancellationUnresolvedOperationIds: v.optional(v.array(v.id("operations"))),
    cancellationUnresolvedOperationCount: v.optional(v.number()),
    cancellationReconciliationComplete: v.optional(v.boolean()),
    cancellationReconciliationCursor: v.optional(v.union(v.string(), v.null())),
    // The operation-specific server-owned authority is copied grant -> job
    // -> operation and revalidated at each protected boundary. Missing
    // authority on legacy rows fails closed before new work is created.
    workflowAuthority: v.optional(workflowAuthorityValidator),
    // E3 automatic-start idempotency: a client-supplied bounded key that
    // binds one logical automatic research start to exactly one grant+job.
    // Optional so legacy rows remain readable; new automatic starts with a
    // key populate it. Scoped by the compound project index below so a key
    // never replays across projects.
    startIdempotencyKey: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_grant", ["grantId"])
    .index("by_project_and_start_key", ["projectId", "startIdempotencyKey"]),

  operations: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    jobId: v.id("jobs"),
    kind: v.string(),
    requestId: v.string(),
    requestKey: v.string(),
    normalizedPayload: v.string(),
    normalizedPayloadHash: v.string(),
    payloadSha256: v.optional(v.string()),
    inputVersions: v.record(v.string(), v.string()),
    grantId: v.id("grants"),
    grantVersion: v.number(),
    recipientConfigVersion: v.optional(v.number()),
    conversationVersion: v.optional(v.number()),
    state: v.union(
      v.literal("prepared"),
      v.literal("dispatching"),
      v.literal("observedSuccess"),
      v.literal("observedFailure"),
      v.literal("outcomeUnknown"),
      v.literal("cancelled"),
      v.literal("denied"),
    ),
    reservationId: v.optional(v.id("reservations")),
    attemptToken: v.optional(v.string()),
    linkedResendOf: v.optional(v.id("operations")),
    workflowAuthority: v.optional(workflowAuthorityValidator),
    // Optional immutable negotiation authority binding derived server-side
    // at preparation and rechecked inside the atomic claim immediately
    // before provider effect. Missing on historical rows keeps them
    // claimable exactly as before; a bound mandate must stay exact, active,
    // unexpired, round-current, and quote/conversation-current.
    negotiationAuthority: v.optional(negotiationAuthorityValidator),
    // The atomic claim consumes the bound negotiation round before provider
    // effect. Definitive non-sends may refund only the operation that owns
    // this marker; this prevents one concurrent attempt from refunding
    // another attempt's round.
    negotiationRoundConsumed: v.optional(v.boolean()),
    negotiationRoundRefunded: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_requestKey", ["requestKey"])
    // Coordinated R1 historical bridge: the R1 owner scopes exact
    // project-local prefix ranges over previous F03 target-bound requestKey
    // values without grant enumeration or cross-project coupling.
    .index("by_project_and_requestKey", ["projectId", "requestKey"])
    .index("by_job", ["jobId"])
    .index("by_job_and_state", ["jobId", "state"])
    .index("by_reservation", ["reservationId"])
    .index("by_grant", ["grantId"]),

  attempts: defineTable({
    operationId: v.id("operations"),
    token: v.string(),
    state: v.union(
      v.literal("prepared"),
      v.literal("dispatching"),
      v.literal("observedSuccess"),
      v.literal("observedFailure"),
      v.literal("outcomeUnknown"),
    ),
    createdAt: v.number(),
    observedAt: v.optional(v.number()),
    providerEventId: v.optional(v.string()),
    detail: v.optional(v.string()),
  })
    .index("by_operation", ["operationId"])
    .index("by_token", ["token"]),

  reservations: defineTable({
    organizationId: v.id("organizations"),
    jobId: v.id("jobs"),
    budgetId: v.id("providerBudgets"),
    ceilingMicroUsd: v.number(),
    reservedMicroUsd: v.number(),
    spentMicroUsd: v.number(),
    unresolvedMicroUsd: v.number(),
    pricingBasis: v.string(),
    state: v.union(v.literal("open"), v.literal("paused"), v.literal("closed")),
    updatedAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_budget", ["budgetId"]),

  processedEvents: defineTable({
    provider: v.string(),
    environment: v.string(),
    eventId: v.string(),
    processingVersion: v.number(),
    outcome: v.string(),
    // F1R-12: receipt ownership/facts are immutable and separate from the
    // operation binding and application projection below. Optional fields
    // preserve reads of historical receipts created before this contract.
    // C1 callback binding facts are normalized provider identifiers. Keeping
    // them outside `outcome` makes message and thread reconciliation use an
    // exact compound index while the legacy JSON remains readable.
    providerMessageId: v.optional(v.string()),
    providerThreadId: v.optional(v.string()),
    providerInboxId: v.optional(v.string()),
    organizationId: v.optional(v.id("organizations")),
    projectId: v.optional(v.id("projects")),
    operationId: v.optional(v.id("operations")),
    applicationOutcome: v.optional(v.union(v.literal("success"), v.literal("failure"), v.literal("unknown"))),
    applicationState: v.optional(v.string()),
    appliedAt: v.optional(v.number()),
    // Fair replay rotation: the last time this row was evaluated by a
    // waiting-set repair pass. Absent until the first evaluation; rows
    // never evaluated sort ahead of retried rows.
    replayLastAttemptAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_provider_environment_and_event", ["provider", "environment", "eventId"])
    // Full provider binding lookup used for callback-to-operation matching.
    // The identifiers are optional for migration compatibility, so legacy
    // rows without them are intentionally absent from this exact lookup.
    .index(
      "by_provider_environment_and_provider_message_and_thread_and_inbox",
      ["provider", "environment", "providerMessageId", "providerThreadId", "providerInboxId"],
    )
    // Replies use the outbound thread and inbox but have a different message
    // id, so conversation routing needs this second exact key.
    .index(
      "by_provider_environment_and_provider_thread_and_inbox",
      ["provider", "environment", "providerThreadId", "providerInboxId"],
    )
    // Retained pre-binding replies query their exact waiting set through
    // this key (Greptile r4058523015 repair). Patching a replayed row to
    // observedSuccess removes it from the waiting set, so the next bounded
    // read advances past completed rows without sampling a fixed prefix and
    // without deleting the raw event record or its application outcome.
    .index(
      "by_provider_environment_and_thread_inbox_and_state",
      ["provider", "environment", "providerThreadId", "providerInboxId", "applicationState"],
    )
    // Fair replay rotation: equality on the waiting set plus ascending
    // order over the last evaluation time, so each bounded take returns
    // the least-recently-attempted waiting rows first.
    .index(
      "by_provider_environment_and_thread_inbox_state_and_attempt",
      ["provider", "environment", "providerThreadId", "providerInboxId", "applicationState", "replayLastAttemptAt"],
    ),

  evidence: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    sourceKind: v.string(),
    sourceUrl: v.optional(v.string()),
    providerIds: v.optional(v.string()),
    capturedAt: v.number(),
    contentHash: v.string(),
    // Protected source bytes stay linked to the immutable content hash. UI
    // projections expose only bounded, redacted excerpts from productEvidence;
    // these fields are never part of a public projection or guest download.
    protectedSourceText: v.optional(v.string()),
    protectedSourceHtml: v.optional(v.string()),
    completeness: v.union(
      v.literal("complete"),
      v.literal("partial"),
      v.literal("unavailable"),
    ),
    counterpartyRole: v.string(),
    executionMode: v.union(
      v.literal("live"),
      v.literal("recorded"),
      v.literal("fixture"),
    ),
    locator: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    // Exact replay lookup for an inbound source snapshot by its content hash
    // inside one project. Legacy markers without `sourceEvidenceId` use this
    // instead of collecting an arbitrary project evidence prefix.
    .index("by_project_and_contentHash", ["projectId", "contentHash"]),

  files: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    evidenceId: v.id("evidence"),
    sizeBytes: v.optional(v.number()),
    contentType: v.optional(v.string()),
    storageRef: v.optional(v.string()),
  }).index("by_evidence", ["evidenceId"]),

  outboundSnapshots: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    operationId: v.id("operations"),
    grantId: v.id("grants"),
    to: v.string(),
    cc: v.array(v.string()),
    bcc: v.array(v.string()),
    replyTo: v.optional(v.string()),
    communicationProfile: v.string(),
    recipientConfigVersion: v.number(),
    payloadHash: v.string(),
    bodyHash: v.string(),
    counterpartyRole: v.string(),
    createdAt: v.number(),
  }).index("by_operation", ["operationId"]),

  /**
   * C1 durable provider-thread identity (Greptile r4058523017 repair).
   *
   * One row binds a provider thread in an inbox to the single purchasing
   * conversation it belongs to. `recordProviderBinding` establishes the row
   * when the first outbound send binds, and denies a later send whose grant
   * resolves to a different conversation, so conflicting identities fail
   * closed at bind time. Inbound routing and quote-source proof read this
   * row through one exact indexed lookup instead of scanning every binding
   * row under the thread, so legitimate long threads keep routing no matter
   * how many binding rows they accumulate. Threads that predate this table
   * fall back to the bounded legacy row scan.
   */
  threadBindings: defineTable({
    provider: v.string(),
    environment: v.string(),
    providerThreadId: v.string(),
    providerInboxId: v.string(),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    conversationId: v.id("conversations"),
    operationId: v.id("operations"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider_environment_and_thread_and_inbox", [
      "provider",
      "environment",
      "providerThreadId",
      "providerInboxId",
    ])
    .index("by_conversation", ["conversationId"]),

  /**
   * C1 resumable thread-identity migration (Greptile r4058523017 follow-up).
   *
   * Threads that accumulated more than 64 binding rows before the durable
   * thread binding existed cannot be proven unanimous inside one bounded
   * read. This row carries the migration progress so successive bounded
   * transactions eventually prove exactly one identity: `candidate...`
   * fields name the identity under proof, `cursor` is the opaque Convex
   * pagination continuation for the exact thread/inbox index (absent at
   * the start), and `verifiedReads` counts exactly verified rows.
   * Positional cursors never stall on equal timestamps. `conflicted` is
   * terminal and never produces a binding; only `complete` writes it.
   */
  threadMigrationStates: defineTable({
    provider: v.string(),
    environment: v.string(),
    providerThreadId: v.string(),
    providerInboxId: v.string(),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    candidateConversationId: v.optional(v.id("conversations")),
    candidateOperationId: v.optional(v.id("operations")),
    verifiedReads: v.number(),
    cursor: v.optional(v.string()),
    state: v.union(
      v.literal("verifying"),
      v.literal("complete"),
      v.literal("conflicted"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_provider_environment_and_thread_and_inbox", [
    "provider",
    "environment",
    "providerThreadId",
    "providerInboxId",
  ]),

  conversations: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    grantId: v.id("grants"),
    version: v.number(),
    state: v.union(
      v.literal("draft"),
      v.literal("queued"),
      v.literal("awaitingReply"),
      v.literal("replyReceived"),
      v.literal("closed"),
      v.literal("cancelled"),
    ),
    recipientConfigVersion: v.number(),
    lastReplyAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_organization_and_project", ["organizationId", "projectId"])
    .index("by_organization_and_project_and_grant_and_state", ["organizationId", "projectId", "grantId", "state"])
    .index("by_organization_and_project_and_state", ["organizationId", "projectId", "state"]),

  quotes: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    requirementId: v.optional(v.id("requirements")),
    vendorId: v.optional(v.id("vendors")),
    rfqId: v.optional(v.id("rfqs")),
    // New requirement-bound quotes pin the requirement version that produced
    // them. Historical rows may omit this field and must fail closed when a
    // new quote-only approval would otherwise need to infer the basis.
    requirementVersion: v.optional(v.number()),
    version: v.string(),
    contentHash: v.string(),
    payloadSha256: v.optional(v.string()),
    currency: v.string(),
    lines: v.array(storedQuoteLineValidator),
    charges: v.array(storedQuoteChargeValidator),
    taxBasis: quoteTaxBasisValidator,
    comparisonScope: v.optional(quoteComparisonScopeValidator),
    evidenceRefs: v.array(quoteEvidenceRefValidator),
    counterpartyRole: v.string(),
    executionMode: v.union(
      v.literal("live"),
      v.literal("recorded"),
      v.literal("fixture"),
    ),
    supersedes: v.optional(v.string()),
    createdAt: v.number(),
  })
    // S1/U1 candidate projection lookup: latest matching quote selection is
    // bounded to one project, requirement, and vendor tuple by createdAt.
    .index(
      "by_project_and_requirement_and_vendor_and_created_at",
      ["projectId", "requirementId", "vendorId", "createdAt"],
    )
    .index("by_project", ["projectId"])
    .index("by_contentHash", ["contentHash"])
    .index("by_project_and_version", ["projectId", "version"])
    .index("by_project_and_contentHash", ["projectId", "contentHash"])
    // Successor-existence lookup: seek directly to revisions whose
    // `supersedes` equals a predecessor content hash inside one project.
    // Rows without `supersedes` sort under undefined and are never matched
    // by an equality probe for a concrete hash, so an existence probe
    // reads at most one row instead of collecting the project's history.
    .index("by_project_and_supersedes", ["projectId", "supersedes"]),

  scopeDecisions: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requestFingerprint: v.string(),
    verdict: v.union(
      v.literal("supported"),
      v.literal("unrelatedRefused"),
      v.literal("unavailableRefused"),
    ),
    reason: v.string(),
    jobId: v.optional(v.id("jobs")),
    createdAt: v.number(),
  }).index("by_fingerprint", ["requestFingerprint"]),

  /**
   * E5 changed-term impact (P-11, P-12, D-15). An append-only,
   * evidence-backed re-evaluation triggered by a superseding quote
   * revision or an explicit watch observation. It distinguishes an
   * unplaced selection change from already placed orders, carries
   * explicit unknown and incomplete states, and never mutates
   * selections, approvals, orders, or financial rows. A failed watch
   * check stays `unknown` and can never mark a placed order delayed:
   * no assessment field expresses delivery delay at all. Reason text
   * derives only from stored rows, never from invented savings,
   * availability, or vendor replies.
   */
  impactAssessments: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    requirementId: v.id("requirements"),
    trigger: v.union(v.literal("quoteRevision"), v.literal("watchObservation")),
    // Exact revision lineage for the quoteRevision trigger: the current
    // (successor) revision and the predecessor content hash it supersedes.
    quoteId: v.optional(v.id("quotes")),
    quoteVersion: v.optional(v.string()),
    predecessorQuoteId: v.optional(v.id("quotes")),
    predecessorQuoteVersion: v.optional(v.string()),
    // Watch-observation trigger: the watched candidate and the observed
    // result. A failed check (error/unknown) keeps the assessment unknown.
    watchId: v.optional(v.id("watches")),
    watchResult: v.optional(
      v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
    ),
    // Durable selection/order distinction: no selection is affected, only
    // an unplaced selection, placed orders exist (fresh approval needed),
    // or the impact itself is unknown after a failed watch check.
    orderImpact: v.union(
      v.literal("none"),
      v.literal("selectionOnly"),
      v.literal("reviewRequired"),
      v.literal("unknown"),
    ),
    state: v.union(v.literal("recorded"), v.literal("unknown"), v.literal("incomplete")),
    affectedSelectionId: v.optional(v.id("selections")),
    placedOrderCount: v.number(),
    reason: v.string(),
    // Bounded per-candidate currentness re-evaluation. Statuses derive
    // only from stored quote rows; no availability or price ranking.
    alternatives: v.array(
      v.object({
        candidateId: v.id("candidates"),
        status: v.union(
          v.literal("current"),
          v.literal("superseded"),
          v.literal("noQuote"),
          v.literal("unknown"),
        ),
        quoteId: v.optional(v.id("quotes")),
        quoteVersion: v.optional(v.string()),
        note: v.string(),
      }),
    ),
    evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_requirement", ["requirementId"]),

  /**
   * E5 substitute proposal (P-12, P-13, D-15). Always requires fresh
   * approval: it references the impact assessment that explains it,
   * pins the exact proposed candidate, quote, and line quantities, and
   * only a pending proposal whose quote revision and requirement
   * version are still current can be decided by an approver. Deciding
   * records a new approvals row whose snapshot binds the proposal
   * decision. No proposal ever deletes or rewrites prior selection,
   * approval, order, or financial history; executing an approved
   * substitute remains an explicit new selection through the decision
   * machinery.
   */
  substituteProposals: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    idempotencyKey: v.string(),
    assessmentId: v.id("impactAssessments"),
    requirementId: v.id("requirements"),
    requirementVersion: v.number(),
    currentSelectionId: v.optional(v.id("selections")),
    proposedCandidateId: v.id("candidates"),
    proposedQuoteId: v.id("quotes"),
    proposedQuoteVersion: v.string(),
    proposedLines: v.array(storedSelectionLineValidator),
    reason: v.string(),
    state: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    decidedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    decisionApprovalId: v.optional(v.id("approvals")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_requirement", ["requirementId"])
    .index("by_assessment", ["assessmentId"]),
});

export { moneyValidator, evidenceRefValidator };

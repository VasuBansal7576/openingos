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
    templateId: v.optional(v.id("templates")),
    templateVersion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_key", ["projectId", "key"])
    .index("by_project_and_state", ["projectId", "state"]),

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
    idempotencyKey: v.string(),
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
    requirementId: v.id("requirements"),
    candidateId: v.id("candidates"),
    quoteId: v.id("quotes"),
    quoteVersion: v.string(),
    quantity: v.string(),
    requirementVersion: v.number(),
    actor: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_requirement", ["requirementId"]),

  approvals: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    scope: v.string(),
    snapshotCanonical: v.string(),
    snapshotHash: v.string(),
    selectionId: v.optional(v.id("selections")),
    quoteId: v.optional(v.id("quotes")),
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
    orderedQuantity: v.string(),
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
    acceptedQuantity: v.optional(v.string()),
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
    recordedBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_order", ["orderId"])
    .index("by_project_and_key", ["projectId", "idempotencyKey"])
    .index("by_project_and_kind", ["projectId", "kind"]),

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
    targetKind: v.string(),
    targetId: v.string(),
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
    .index("by_project_and_identity", ["projectId", "identity"]),

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
    state: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("waitingForSupplier"),
      v.literal("waitingForUser"),
      v.literal("pausedBudget"),
      v.literal("completed"),
      v.literal("partial"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    inputVersions: v.record(v.string(), v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_grant", ["grantId"]),

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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_requestKey", ["requestKey"])
    .index("by_job", ["jobId"])
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
    operationId: v.optional(v.id("operations")),
    createdAt: v.number(),
  }).index("by_provider_environment_and_event", ["provider", "environment", "eventId"]),

  evidence: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    sourceKind: v.string(),
    sourceUrl: v.optional(v.string()),
    providerIds: v.optional(v.string()),
    capturedAt: v.number(),
    contentHash: v.string(),
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
  }).index("by_project", ["projectId"]),

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
  }).index("by_project", ["projectId"]),

  quotes: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    requirementId: v.optional(v.id("requirements")),
    vendorId: v.optional(v.id("vendors")),
    rfqId: v.optional(v.id("rfqs")),
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
    .index("by_project", ["projectId"])
    .index("by_contentHash", ["contentHash"])
    .index("by_project_and_version", ["projectId", "version"])
    .index("by_project_and_contentHash", ["projectId", "contentHash"]),

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
});

export { moneyValidator, evidenceRefValidator };

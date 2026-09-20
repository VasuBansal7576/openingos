/**
 * F1 shared-domain contracts (controlled contract, PRD section 30).
 *
 * This module is the single typed handoff surface for the durable product
 * graph: locations, requirements, dependencies, candidates, productEvidence,
 * vendors, vendorContacts, rfqs, negotiations, selections, approvals,
 * orders, orderEvents, costEntries, assets, assetDocuments, serviceCases,
 * watches, projectEvents, risks, and templates.
 *
 * Every state is a discriminated union matching the PRD and ADR-0003
 * through ADR-0007: requirement progress, conversation, fulfillment,
 * approval, financial, evidence verification/freshness, and provenance.
 * Provenance is server-derived (never client-supplied): owner-authored
 * terms keep `counterpartyRole: ownerStandIn` and every export preserves
 * the controlled-demo label.
 *
 * Runtime Convex validators plus inferred exported TypeScript types give
 * typed handoffs among research collection, browser observations,
 * Jev/OpenAI decisions, outbound/inbound communication, quote updates,
 * and UI projections. No `any`, no assertion-hiding helpers, no unbounded
 * reads, no client-supplied provenance or authority.
 *
 * This module registers no Convex functions.
 */

import { v, type Infer } from "convex/values";

// -- Shared primitives ------------------------------------------------------

export const domainMoneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});
export type DomainMoney = Infer<typeof domainMoneyValidator>;

export const domainEvidenceRefValidator = v.object({
  sourceId: v.string(),
  version: v.string(),
  locator: v.optional(v.string()),
});
export type DomainEvidenceRef = Infer<typeof domainEvidenceRefValidator>;

// -- State unions (PRD sections 13, 17, 21; ADR-0003/0004) -------------------

/** Requirement progress (PRD 13). Risk flags are separate records. */
export const requirementStateValidator = v.union(
  v.literal("draft"),
  v.literal("approved"),
  v.literal("sourcing"),
  v.literal("readyForDecision"),
  v.literal("selected"),
  v.literal("fulfilled"),
  v.literal("cancelled"),
);
export type RequirementState = Infer<typeof requirementStateValidator>;

/** Supplier conversation per requirement/vendor (PRD 13). */
export const domainConversationStateValidator = v.union(
  v.literal("draft"),
  v.literal("awaitingReply"),
  v.literal("clarificationNeeded"),
  v.literal("quoteReceived"),
  v.literal("negotiating"),
  v.literal("closed"),
);
export type DomainConversationState = Infer<typeof domainConversationStateValidator>;

/** Fulfillment per requirement quantity (PRD 13). */
export const fulfillmentStateValidator = v.union(
  v.literal("notOrdered"),
  v.literal("ordered"),
  v.literal("partiallyDelivered"),
  v.literal("delivered"),
  v.literal("installed"),
  v.literal("commissioned"),
  v.literal("cancelled"),
);
export type FulfillmentState = Infer<typeof fulfillmentStateValidator>;

/** Approval lifecycle (PRD 35): changed inputs invalidate, never mutate. */
export const approvalStateValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("invalidated"),
);
export type ApprovalState = Infer<typeof approvalStateValidator>;

/** Financial entry kinds (PRD 17): credits cut obligations, refunds cut paid. */
export const costEntryKindValidator = v.union(
  v.literal("payment"),
  v.literal("settledCost"),
  v.literal("refund"),
  v.literal("credit"),
);
export type CostEntryKind = Infer<typeof costEntryKindValidator>;

/** Order lifecycle: user-recorded commitments plus amendments (PRD 17). */
export const orderStateValidator = v.union(
  v.literal("recorded"),
  v.literal("amended"),
  v.literal("cancelled"),
);
export type OrderState = Infer<typeof orderStateValidator>;

/** Order event kinds: confirmation through commissioning (PRD 30). */
export const orderEventKindValidator = v.union(
  v.literal("confirmation"),
  v.literal("shipment"),
  v.literal("partialDelivery"),
  v.literal("acceptance"),
  v.literal("installation"),
  v.literal("commissioning"),
);
export type OrderEventKind = Infer<typeof orderEventKindValidator>;

/** Evidence verification is separate from transport completeness (ADR-0003). */
export const evidenceVerificationValidator = v.union(
  v.literal("unverified"),
  v.literal("verified"),
  v.literal("conflicted"),
  v.literal("superseded"),
);
export type EvidenceVerification = Infer<typeof evidenceVerificationValidator>;

/** Freshness: stale results stay accessible with last check time (PRD 21). */
export const evidenceFreshnessValidator = v.union(
  v.literal("fresh"),
  v.literal("stale"),
  v.literal("expired"),
  v.literal("unknown"),
);
export type EvidenceFreshness = Infer<typeof evidenceFreshnessValidator>;

/**
 * Counterparty provenance. Server-derived only: public handlers fix
 * `userImport`/`recorded`, the provider pipeline supplies vendor or
 * ownerStandIn, and no client field can assert live vendor authorship.
 */
export const counterpartyRoleValidator = v.union(
  v.literal("vendor"),
  v.literal("ownerStandIn"),
  v.literal("userImport"),
);
export type DomainCounterpartyRole = Infer<typeof counterpartyRoleValidator>;

export const domainExecutionModeValidator = v.union(
  v.literal("live"),
  v.literal("recorded"),
  v.literal("fixture"),
);
export type DomainExecutionMode = Infer<typeof domainExecutionModeValidator>;

/** Opening critical path priority meanings are frozen (PRD 19). */
export const requirementPriorityValidator = v.union(
  v.literal("P0"),
  v.literal("P1"),
  v.literal("P2"),
);
export type RequirementPriority = Infer<typeof requirementPriorityValidator>;

/** Dependency relationship kinds (PRD 15): technical vs scheduling. */
export const dependencyKindValidator = v.union(
  v.literal("technical"),
  v.literal("scheduling"),
);
export type DependencyKind = Infer<typeof dependencyKindValidator>;

/** Dependency verification: missing evidence is never a pass (PRD 16). */
export const dependencyVerificationValidator = v.union(
  v.literal("pending"),
  v.literal("verified"),
  v.literal("failed"),
  v.literal("waived"),
);
export type DependencyVerification = Infer<typeof dependencyVerificationValidator>;

/** Compatibility finding per exact variant and quantity (PRD 16). */
export const compatibilityResultValidator = v.union(
  v.literal("pass"),
  v.literal("fail"),
  v.literal("unknown"),
);
export type CompatibilityResult = Infer<typeof compatibilityResultValidator>;

/**
 * Compatibility rule version (F1R-06): every compatibility finding pins
 * the rule version it was decided against alongside the requirement
 * version, so a rule change can be detected as a stale basis exactly
 * like a changed input.
 */
export const COMPATIBILITY_RULE_VERSION = "1";

/** Negotiation mandate execution state (PRD 24, ADR-0004). */
export const negotiationStateValidator = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("concluded"),
  v.literal("expired"),
  v.literal("revoked"),
);
export type NegotiationState = Infer<typeof negotiationStateValidator>;

/** Service case lifecycle (PRD 30). */
export const serviceCaseStateValidator = v.union(
  v.literal("open"),
  v.literal("inProgress"),
  v.literal("waitingForSupplier"),
  v.literal("resolved"),
  v.literal("closed"),
);
export type ServiceCaseState = Infer<typeof serviceCaseStateValidator>;

export const serviceCaseUrgencyValidator = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);
export type ServiceCaseUrgency = Infer<typeof serviceCaseUrgencyValidator>;

/** Evidence watch lifecycle (PRD 30). */
export const watchStateValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("stopped"),
);
export type WatchState = Infer<typeof watchStateValidator>;

export const watchResultValidator = v.union(
  v.literal("ok"),
  v.literal("stale"),
  v.literal("error"),
  v.literal("unknown"),
);
export type WatchResult = Infer<typeof watchResultValidator>;

/** Risk severity and resolution (PRD 30). */
export const riskSeverityValidator = v.union(
  v.literal("critical"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);
export type RiskSeverity = Infer<typeof riskSeverityValidator>;

export const riskStateValidator = v.union(
  v.literal("open"),
  v.literal("mitigating"),
  v.literal("resolved"),
  v.literal("accepted"),
);
export type RiskState = Infer<typeof riskStateValidator>;

// -- Record input validators (creation shapes; provenance server-derived) ----

export const locationInputValidator = v.object({
  organizationId: v.id("organizations"),
  name: v.string(),
  region: v.string(),
  reportingCurrency: v.string(),
  operatingStatus: v.string(),
});
export type LocationInput = Infer<typeof locationInputValidator>;

export const requirementInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  key: v.string(),
  title: v.string(),
  category: v.string(),
  quantity: v.string(),
  unit: v.string(),
  priority: requirementPriorityValidator,
  budgetMinorUnits: v.optional(v.number()),
  currency: v.optional(v.string()),
  needByAt: v.optional(v.number()),
});
export type RequirementInput = Infer<typeof requirementInputValidator>;

/**
 * Dependency edge input. Cycle-safe by construction: handlers reject
 * self-edges and any edge that closes a directed cycle (see
 * `dependencyCreatesCycle`), and scheduling edges never invent durations
 * for unknown external activities (PRD 15).
 */
export const dependencyInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  fromRequirementId: v.id("requirements"),
  toRequirementId: v.id("requirements"),
  kind: dependencyKindValidator,
  responsible: v.optional(v.string()),
  evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
});
export type DependencyInput = Infer<typeof dependencyInputValidator>;

/**
 * Vendors are organization-scoped supplier identity (PRD 30): one vendor
 * serves many projects. Project work references the vendor; project
 * authorization to contact it travels through vendorContacts.
 */
export const vendorInputValidator = v.object({
  organizationId: v.id("organizations"),
  name: v.string(),
  regions: v.array(v.string()),
  dealerEvidence: v.optional(v.string()),
  serviceCoverage: v.optional(v.string()),
  serviceCheckedAt: v.optional(v.number()),
});
export type VendorInput = Infer<typeof vendorInputValidator>;

/**
 * Vendor contacts are organization-owned (a supplier's channel does not
 * change per project). Replay-safe through the idempotency key.
 */
export const vendorContactInputValidator = v.object({
  organizationId: v.id("organizations"),
  vendorId: v.id("vendors"),
  channel: v.string(),
  detailHash: v.string(),
  preference: v.optional(v.string()),
  idempotencyKey: v.string(),
});
export type VendorContactInput = Infer<typeof vendorContactInputValidator>;

/**
 * Candidate identity is the exact triple (requirement, variant, vendor):
 * the same model from another seller is another candidate, and a
 * different variant never merges into an existing row (PRD 20).
 * Compatibility is server-derived (`unknown` at record time): the public
 * path can never self-assert a pass, and verification requires evidence
 * through the dedicated transition.
 */
export const candidateInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  requirementId: v.id("requirements"),
  vendorId: v.id("vendors"),
  productModel: v.string(),
  variant: v.string(),
  conversationState: domainConversationStateValidator,
});
export type CandidateInput = Infer<typeof candidateInputValidator>;

export const compatibilityVerificationInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  candidateId: v.id("candidates"),
  result: compatibilityResultValidator,
  evidenceRefs: v.array(domainEvidenceRefValidator),
});
export type CompatibilityVerificationInput = Infer<
  typeof compatibilityVerificationInputValidator
>;

/**
 * Explicit owner-import product evidence (public path). The caller states
 * whose counterparty terms these are from the closed ownerStandIn/vendor
 * union — explicit and labeled `ownerImport`/`recorded`, never a
 * self-asserted live vendor record. The idempotency key makes collection
 * reruns replay-safe.
 */
export const productEvidenceInputValidator = v.object({
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
  freshness: evidenceFreshnessValidator,
  lastCheckedAt: v.optional(v.number()),
  counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
  idempotencyKey: v.string(),
});
export type ProductEvidenceInput = Infer<typeof productEvidenceInputValidator>;

/** Internal pipeline product evidence (R1/C1 ingestion only). */
export const providerProductEvidenceInputValidator = v.object({
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
  freshness: evidenceFreshnessValidator,
  lastCheckedAt: v.optional(v.number()),
  counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
  executionMode: v.union(v.literal("live"), v.literal("recorded")),
  idempotencyKey: v.string(),
});
export type ProviderProductEvidenceInput = Infer<
  typeof providerProductEvidenceInputValidator
>;

/**
 * RFQ input. `scenarioVendorIds` names researched vendors as scenario
 * context only: the list can neither imply nor authorize direct vendor
 * delivery. Owner-only transport stays governed by the communication
 * grant and recipient configuration (ADR-0004/0007), never by this
 * record. Line items state the requested scope; an optional
 * conversation binding must resolve in-project.
 */
export const rfqLineItemValidator = v.object({
  itemId: v.string(),
  description: v.string(),
  quantity: v.string(),
  unit: v.string(),
});
export type RfqLineItem = Infer<typeof rfqLineItemValidator>;

export const rfqInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  requirementId: v.id("requirements"),
  idempotencyKey: v.string(),
  scenarioVendorIds: v.array(v.id("vendors")),
  lineItems: v.array(rfqLineItemValidator),
  conversationId: v.optional(v.id("conversations")),
  briefHash: v.string(),
  conversationState: domainConversationStateValidator,
});
export type RfqInput = Infer<typeof rfqInputValidator>;

export const negotiationInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  quoteId: v.id("quotes"),
  mandateHash: v.string(),
  targetMinorUnits: v.optional(v.number()),
  roundLimit: v.number(),
  expiresAt: v.number(),
});
export type NegotiationInput = Infer<typeof negotiationInputValidator>;

/** Selection pins the exact quote version and quantity (ADR-0003). */
export const selectionInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  // Optional for compatibility with pre-F1R-11 callers; durable rows always
  // receive an explicit or server-derived stable replay key.
  idempotencyKey: v.optional(v.string()),
  requirementId: v.id("requirements"),
  candidateId: v.id("candidates"),
  quoteId: v.id("quotes"),
  quoteVersion: v.string(),
  quantity: v.string(),
  requirementVersion: v.number(),
});
export type SelectionInput = Infer<typeof selectionInputValidator>;

/** Approval snapshots the exact decision; change invalidates (PRD 35). */
export const approvalInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  scope: v.string(),
  snapshotCanonical: v.string(),
  snapshotHash: v.string(),
  selectionId: v.optional(v.id("selections")),
  quoteId: v.optional(v.id("quotes")),
});
export type ApprovalInput = Infer<typeof approvalInputValidator>;

export const orderInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  selectionId: v.id("selections"),
  idempotencyKey: v.string(),
  orderedQuantity: v.string(),
  supplierReference: v.optional(v.string()),
});
export type OrderInput = Infer<typeof orderInputValidator>;

export const orderEventInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  orderId: v.id("orders"),
  kind: orderEventKindValidator,
  acceptedQuantity: v.optional(v.string()),
  note: v.optional(v.string()),
  idempotencyKey: v.string(),
});
export type OrderEventInput = Infer<typeof orderEventInputValidator>;

export const costEntryInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  orderId: v.id("orders"),
  kind: costEntryKindValidator,
  amount: domainMoneyValidator,
  idempotencyKey: v.string(),
  linkedEntryId: v.optional(v.id("costEntries")),
});
export type CostEntryInput = Infer<typeof costEntryInputValidator>;

export const assetInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  locationId: v.optional(v.id("locations")),
  orderId: v.optional(v.id("orders")),
  label: v.string(),
  serial: v.optional(v.string()),
  constraints: v.optional(v.string()),
  purchaseProvenance: v.optional(v.string()),
  idempotencyKey: v.string(),
});
export type AssetInput = Infer<typeof assetInputValidator>;

export const assetDocumentInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  assetId: v.id("assets"),
  kind: v.string(),
  storageRef: v.optional(v.string()),
  idempotencyKey: v.string(),
});
export type AssetDocumentInput = Infer<typeof assetDocumentInputValidator>;

export const serviceCaseInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  assetId: v.id("assets"),
  urgency: serviceCaseUrgencyValidator,
  summary: v.string(),
  idempotencyKey: v.string(),
});
export type ServiceCaseInput = Infer<typeof serviceCaseInputValidator>;

/**
 * Watch input (explicit owner-import path). The caller declares the
 * watched counterparty and an optional job allowance linkage; the source
 * is validator-fixed to `ownerImport` so a public caller can never claim
 * internal pipeline verification. The next check time derives
 * server-side from cadence.
 */
export const watchInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  jobId: v.optional(v.id("jobs")),
  // F1R-10 intentionally freezes the first watch target to a candidate.
  // A future target kind needs its own validated relationship contract; a
  // free-form string cannot establish project ownership at the boundary.
  targetKind: v.literal("candidate"),
  targetId: v.id("candidates"),
  cadenceMs: v.number(),
  counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
  evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
  idempotencyKey: v.string(),
});
export type WatchInput = Infer<typeof watchInputValidator>;

export const projectEventInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  kind: v.string(),
  evidenceRefs: v.optional(v.array(domainEvidenceRefValidator)),
});
export type ProjectEventInput = Infer<typeof projectEventInputValidator>;

export const riskInputValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  scope: v.string(),
  severity: riskSeverityValidator,
  source: v.string(),
  owner: v.optional(v.string()),
  dependencyIds: v.optional(v.array(v.id("dependencies"))),
});
export type RiskInput = Infer<typeof riskInputValidator>;

/**
 * Templates are organization-owned (PRD 30) with the source project kept
 * as a derivable parent reference. The version is unique per
 * organization; instantiation copies requirements and constraints only.
 */
export const templateInputValidator = v.object({
  organizationId: v.id("organizations"),
  sourceProjectId: v.id("projects"),
  name: v.string(),
  version: v.string(),
  requirementSnapshot: v.string(),
  constraintSnapshot: v.string(),
});
export type TemplateInput = Infer<typeof templateInputValidator>;

// -- Typed handoffs ----------------------------------------------------------

/**
 * Research collection handoff: Firecrawl/page claims into evidence (R1).
 * Tenancy plus the job input version travel with the claims so a stale
 * collection can never write into a newer job or another workspace.
 */
export const researchCollectionValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  jobId: v.id("jobs"),
  inputVersion: v.string(),
  grantId: v.optional(v.id("grants")),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  collectedAt: v.number(),
  completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("unavailable")),
  claims: v.array(
    v.object({
      field: v.string(),
      originalValue: v.string(),
      normalizedValue: v.string(),
      locator: v.optional(v.string()),
      status: v.union(v.literal("proposed"), v.literal("verified"), v.literal("conflicted")),
    }),
  ),
});
export type ResearchCollection = Infer<typeof researchCollectionValidator>;

/**
 * Browser observation handoff: executor findings into records
 * (ADR-0006). The observation version plus input version bind the
 * finding to the exact DOM state and job inputs it was read from.
 */
export const browserObservationValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  jobId: v.id("jobs"),
  inputVersion: v.string(),
  attemptId: v.string(),
  observationVersion: v.number(),
  url: v.string(),
  capturedAt: v.number(),
  visibleTextHash: v.string(),
  observedTargets: v.array(v.string()),
  claimedOutcome: v.string(),
  status: v.union(v.literal("observed"), v.literal("stale"), v.literal("failed")),
  evidenceRefs: v.array(domainEvidenceRefValidator),
  meteredUsageMicroUsd: v.number(),
});
export type BrowserObservation = Infer<typeof browserObservationValidator>;

/** Jev decision handoff: bounded choice over observed options (ADR-0005). */
export const jevDecisionValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  decisionType: v.string(),
  questionVersion: v.string(),
  jobId: v.id("jobs"),
  inputVersion: v.string(),
  evidenceRefs: v.array(domainEvidenceRefValidator),
  permittedOptions: v.array(v.string()),
  choice: v.string(),
  confidence: v.number(),
  modelVersion: v.string(),
  status: v.union(
    v.literal("decided"),
    v.literal("needsReview"),
    v.literal("unavailable"),
    v.literal("stale"),
  ),
});
export type JevDecision = Infer<typeof jevDecisionValidator>;

/** OpenAI handoff: extraction proposals and drafted text (ADR-0005). */
export const openAIExtractionValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  jobId: v.id("jobs"),
  inputVersion: v.string(),
  modelVersion: v.string(),
  sourceRef: v.string(),
  evidenceRefs: v.array(domainEvidenceRefValidator),
  fields: v.record(v.string(), v.string()),
  confidence: v.string(),
  status: v.union(v.literal("proposed"), v.literal("needsReview"), v.literal("rejected")),
});
export type OpenAIExtraction = Infer<typeof openAIExtractionValidator>;

export const openAIDraftValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  jobId: v.id("jobs"),
  inputVersion: v.string(),
  draftKind: v.string(),
  contentHash: v.string(),
  sourceLocators: v.array(v.string()),
  status: v.union(v.literal("proposed"), v.literal("approved"), v.literal("superseded")),
});
export type OpenAIDraft = Infer<typeof openAIDraftValidator>;

/**
 * Outbound brief handoff: approved message into the send path (C1).
 * `scenarioVendorIds` is scenario context only; the actual transport
 * destination stays governed by the communication grant and recipient
 * configuration, never by this record.
 */
export const outboundBriefValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  grantId: v.id("grants"),
  inputVersion: v.string(),
  scenarioVendorIds: v.array(v.id("vendors")),
  communicationProfile: v.string(),
  payloadHash: v.string(),
});
export type OutboundBrief = Infer<typeof outboundBriefValidator>;

/** Inbound classification handoff: reply into quote updates (C1). */
export const inboundClassificationValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  conversationId: v.optional(v.id("conversations")),
  providerIds: v.string(),
  counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
  executionMode: v.union(v.literal("live"), v.literal("recorded")),
  classification: v.union(
    v.literal("quote"),
    v.literal("clarification"),
    v.literal("decline"),
    v.literal("unavailable"),
    v.literal("partial"),
    v.literal("negotiation"),
    v.literal("orderUpdate"),
    v.literal("serviceResponse"),
    v.literal("attachment"),
  ),
  evidenceRefs: v.array(domainEvidenceRefValidator),
  status: v.union(v.literal("classified"), v.literal("needsReview"), v.literal("applied")),
  extractedVersion: v.optional(v.string()),
});
export type InboundClassification = Infer<typeof inboundClassificationValidator>;

/**
 * Quote update handoff: revision linkage for the quote pipeline, bound
 * to the exact content hash so a version label can never drift from its
 * hashed terms.
 */
export const quoteUpdateValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  quoteId: v.id("quotes"),
  version: v.string(),
  contentHash: v.string(),
  supersedes: v.optional(v.string()),
});
export type QuoteUpdate = Infer<typeof quoteUpdateValidator>;

/** UI projection handoff: cached answers keyed by exact versions (U1). */
export const uiProjectionValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  projectionKey: v.string(),
  inputVersions: v.record(v.string(), v.string()),
  computedAt: v.number(),
  status: v.union(v.literal("current"), v.literal("stale"), v.literal("invalidated")),
});
export type UIProjection = Infer<typeof uiProjectionValidator>;

// -- Pure domain predicates (no I/O, no hidden assertions) -------------------

/** Requirement states from which no further sourcing work may start. */
export function isTerminalRequirementState(state: RequirementState): boolean {
  return state === "selected" || state === "fulfilled" || state === "cancelled";
}

/** Fulfillment states that close out remaining quantity tracking. */
export function isTerminalFulfillmentState(state: FulfillmentState): boolean {
  return state === "commissioned" || state === "cancelled";
}


/**
 * Approvals that can still authorize a pending action. Only an approved
 * decision authorizes: a pending approval is a request awaiting a human,
 * never authority to act.
 */
export function isActionableApproval(state: ApprovalState): boolean {
  return state === "approved";
}

/** Freshness that permits reuse without re-verification. */
export function isReusableFreshness(freshness: EvidenceFreshness): boolean {
  return freshness === "fresh";
}

/**
 * Exact candidate identity: requirement, model, variant, and vendor
 * joined byte-for-byte. No case folding, no whitespace trimming: fuzzy
 * normalization collapses distinct supplier variants into one row and
 * hides the difference the comparison must show. Near-duplicates stay
 * visible as separate candidates until evidence merges them.
 */
export function candidateVariantKey(input: {
  readonly requirementId: string;
  readonly productModel: string;
  readonly variant: string;
  readonly vendorId: string;
}): string {
  return [
    input.requirementId,
    input.productModel,
    input.variant,
    input.vendorId,
  ].join("|");
}

/**
 * Cycle-safe dependency input shape: true when adding from -> to would
 * close a directed cycle (including the self-edge) given existing edges.
 * Handlers load the project's bounded edge list and refuse the insert.
 */
export function dependencyCreatesCycle(
  edges: readonly { readonly from: string; readonly to: string }[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const reachable = new Set<string>([to]);
  const queue: string[] = [to];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    if (current === from) return true;
    for (const edge of edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
}

/**
 * Template reuse scope: a template instantiates requirements and
 * constraints only. Historical orders, order events, payments, settled
 * costs, refunds, and credits are never copied into a new project, so a
 * reused plan cannot inherit another project's commitments or cash.
 */
export const TEMPLATE_REUSE_COLLECTIONS = ["requirements", "constraints"] as const;
export type TemplateReuseCollection = (typeof TEMPLATE_REUSE_COLLECTIONS)[number];

export function templateReuseExcludesHistoricFinancials(
  collections: readonly string[],
): boolean {
  const forbidden = ["orders", "orderEvents", "costEntries", "payments"];
  return !collections.some((collection) => forbidden.includes(collection));
}

/**
 * Controlled-demo labeling lives on the stored records themselves
 * (`counterpartyRole` plus `executionMode`/`origin`): no helper
 * re-labels roles in flight, so provenance cannot be laundered between
 * the read and the write.
 */
export const CONTROLLED_COUNTERPARTY_ROLES = ["ownerStandIn", "userImport"] as const;

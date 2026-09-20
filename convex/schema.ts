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
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

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
    .index("by_contentHash", ["contentHash"]),

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

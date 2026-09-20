/**
 * F1 shared entity types (controlled contract).
 *
 * String IDs here mirror the frozen Convex tables in `convex/schema.ts`.
 * The deterministic `ControlledBackend` in `store.ts` implements the same
 * invariants the Convex queries/mutations enforce against `ctx.db`, so
 * controlled tests exercise identical authority logic.
 */

export type OrganizationKind = "guest" | "private";
export type ProjectVisibility = "open" | "restricted";
export type MembershipRole = "owner" | "approver" | "contributor" | "viewer";
export type MembershipStatus = "active" | "revoked";
export type GrantStatus = "active" | "revoked" | "expired";
export type JobKind = "research" | "communication" | "execution";
export type JobState =
  | "queued"
  | "running"
  | "waitingForSupplier"
  | "waitingForUser"
  | "pausedBudget"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";
export type OperationState =
  | "prepared"
  | "dispatching"
  | "observedSuccess"
  | "observedFailure"
  | "outcomeUnknown"
  | "cancelled"
  | "denied";
export type AttemptState =
  | "prepared"
  | "dispatching"
  | "observedSuccess"
  | "observedFailure"
  | "outcomeUnknown";
export type ConversationState =
  | "draft"
  | "queued"
  | "awaitingReply"
  | "replyReceived"
  | "closed"
  | "cancelled";
export type Completeness = "complete" | "partial" | "unavailable";
export type ExecutionMode = "live" | "recorded" | "fixture";

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly kind: OrganizationKind;
  readonly createdAt: number;
}

export interface Project {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly visibility: ProjectVisibility;
  readonly createdAt: number;
}

export interface Membership {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly identity: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly version: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly updatedAt: number;
}

export interface RecipientConfig {
  readonly id: string;
  readonly version: number;
  readonly mailboxNormalized: string;
  readonly mailboxHash: string;
  readonly active: boolean;
  readonly configuredAt: number;
  readonly configuredBy: string;
}

export interface ProviderBudget {
  readonly id: string;
  readonly organizationId: string;
  readonly ceilingMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly unresolvedMicroUsd: number;
  readonly pricingBasis: string;
  readonly updatedAt: number;
}

export interface Grant {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operations: readonly string[];
  readonly communicationProfile: string;
  readonly recipientConfigVersion: number;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly canonicalPayload: string;
  readonly payloadHash: string;
  readonly payloadSha256: string | null;
  readonly costCeilingMicroUsd: number;
  readonly roundLimit: number;
  readonly expiresAt: number;
  readonly revocationVersion: number;
  readonly status: GrantStatus;
  readonly conversationId: string | null;
  readonly createdAt: number;
}

export interface Job {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cancelledAt: number | null;
  readonly cancelReason: string | null;
}

export interface Operation {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly kind: string;
  readonly requestId: string;
  readonly requestKey: string;
  readonly canonicalPayload: string;
  readonly normalizedPayloadHash: string;
  readonly payloadSha256: string | null;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly grantId: string;
  readonly grantVersion: number;
  readonly recipientConfigVersion: number | null;
  readonly conversationVersion: number | null;
  readonly state: OperationState;
  readonly reservationId: string | null;
  readonly attemptToken: string | null;
  readonly linkedResendOf: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Attempt {
  readonly id: string;
  readonly operationId: string;
  readonly token: string;
  readonly state: AttemptState;
  readonly createdAt: number;
  readonly observedAt: number | null;
  readonly providerEventId: string | null;
  readonly detail: string | null;
}

export interface Reservation {
  readonly id: string;
  readonly organizationId: string;
  readonly jobId: string;
  readonly budgetId: string;
  readonly ceilingMicroUsd: number;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly unresolvedMicroUsd: number;
  readonly pricingBasis: string;
  readonly state: "open" | "paused" | "closed";
  readonly updatedAt: number;
}

export interface Evidence {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly sourceKind: string;
  readonly sourceUrl: string | null;
  readonly providerIds: string | null;
  readonly capturedAt: number;
  readonly contentHash: string;
  readonly completeness: Completeness;
  readonly counterpartyRole: string;
  readonly executionMode: ExecutionMode;
  readonly locator: string | null;
}

export interface EvidenceFile {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly evidenceId: string;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly storageRef: string | null;
}

export interface OutboundSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly grantId: string;
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: string | null;
  readonly communicationProfile: string;
  readonly recipientConfigVersion: number;
  readonly payloadHash: string;
  readonly bodyHash: string;
  readonly counterpartyRole: string;
  readonly createdAt: number;
}

export interface Conversation {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly version: number;
  readonly state: ConversationState;
  readonly recipientConfigVersion: number;
  readonly lastReplyAt: number | null;
  readonly cancelledAt: number | null;
  readonly updatedAt: number;
}

export interface QuoteEvidenceRef {
  readonly sourceId: string;
  readonly version: string;
  readonly locator?: string;
}

export interface QuoteLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: { readonly currency: string; readonly minorUnits: number };
  readonly evidenceRefs: readonly QuoteEvidenceRef[];
}

export type QuoteChargeScope =
  | Readonly<{ kind: "quote" }>
  | Readonly<{ kind: "line"; lineId: string }>
  | Readonly<{ kind: "allocated"; lineId: string; method: "fixed" | "proportional" }>;

export type QuoteChargeState =
  | Readonly<{ kind: "known"; amount: { readonly currency: string; readonly minorUnits: number } }>
  | Readonly<{ kind: "included"; coveringId: string }>
  | Readonly<{
    kind: "estimated";
    estimate:
    | Readonly<{ kind: "point"; amount: { readonly currency: string; readonly minorUnits: number } }>
    | Readonly<{
      kind: "range";
      minimum: { readonly currency: string; readonly minorUnits: number };
      maximum: { readonly currency: string; readonly minorUnits: number };
    }>;
  }>
  | Readonly<{ kind: "unknown"; reason: string }>
  | Readonly<{ kind: "notApplicable"; reason: string }>;

export interface QuoteCharge {
  readonly chargeId: string;
  readonly label: string;
  readonly scope: QuoteChargeScope;
  readonly state: QuoteChargeState;
  readonly evidenceRefs: readonly QuoteEvidenceRef[];
}

export type QuoteTaxBasis =
  | Readonly<{ kind: "inclusive" | "exclusive"; basisId: string; evidenceRefs: readonly QuoteEvidenceRef[] }>
  | Readonly<{ kind: "unknown"; reason: string; evidenceRefs: readonly QuoteEvidenceRef[] }>;

export interface QuoteComparisonScopeItem {
  readonly itemId: string;
  readonly lineId: string;
  readonly unit: string;
  readonly requiredQuantity: string;
}

export interface QuoteComparisonScope {
  readonly requirementId: string;
  readonly scopeId: string;
  readonly items: readonly QuoteComparisonScopeItem[];
}

export interface Quote {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly version: string;
  readonly contentHash: string;
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  readonly charges: readonly QuoteCharge[];
  readonly taxBasis: QuoteTaxBasis;
  readonly comparisonScope: QuoteComparisonScope | null;
  readonly evidenceRefs: readonly QuoteEvidenceRef[];
  readonly counterpartyRole: string;
  readonly executionMode: ExecutionMode;
  readonly supersedes: string | null;
  readonly createdAt: number;
}

export interface ControlledSentMessage {
  readonly operationId: string;
  readonly attemptToken: string;
  readonly to: string;
  readonly payloadHash: string;
  readonly sentAt: number;
}

export interface ScopeDecision {
  readonly fingerprint: string;
  readonly verdict: "supported" | "unrelatedRefused" | "unavailableRefused";
  readonly reason: string;
  readonly jobId: string | null;
  readonly createdAt: number;
}

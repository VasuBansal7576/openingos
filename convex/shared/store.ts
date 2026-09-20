/**
 * F1 deterministic controlled backend (controlled contract, NR03 gate).
 *
 * `ControlledBackend` implements the exact authority invariants the Convex
 * queries/mutations enforce against `ctx.db` (see `convex/access/**` and
 * `convex/execution/**`): organization/project/guest isolation, restricted
 * projects, version-bound grants, owner-recipient binding, idempotent
 * operations, shared-budget reservations, single-use claim tokens,
 * crash/replay reconciliation, and cancellation/late-delivery separation.
 *
 * All authority derives from stored memberships, grants, and configuration —
 * never from caller-supplied IDs, roles, or model output. Every denial
 * returns a typed code with zero new effect; tests assert this with
 * `snapshotCounts()`.
 *
 * Payload binding: idempotency and claim compare the exact canonical
 * payload string (`sameCanonicalPayload`); the FNV hash is an index hint
 * and SHA-256 is a second binding when both sides present it.
 *
 * Money: integer minor units + ISO currency via `convex/shared/money.ts`;
 * unknown charges stay unknown and remain reserved after failure.
 */

import { canonicalJson, normalizeMailbox, payloadHash, requestKey } from "./hashing.js";
import { sameCanonicalPayload, sha256BindingOk } from "./sha256.js";
import { isExpired } from "./time.js";
import {
  classifyScope,
  containsInstructionOverride,
  lookupCapability,
  roleSatisfies,
} from "./scope.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "./provenance.js";
import { approved, denial, type AuthorityResult, type Denial } from "./denials.js";
import { checkMoney } from "./money.js";
import type {
  Attempt,
  Conversation,
  ControlledSentMessage,
  Evidence,
  EvidenceFile,
  ExecutionMode,
  Grant,
  Job,
  JobKind,
  JobState,
  Membership,
  MembershipRole,
  Operation,
  OperationState,
  Organization,
  OrganizationKind,
  OutboundSnapshot,
  Project,
  ProjectVisibility,
  ProviderBudget,
  Quote,
  QuoteCharge,
  QuoteLine,
  RecipientConfig,
  Reservation,
  ScopeDecision,
} from "./types.js";

export type AuthorityRole = MembershipRole;

const ROLE_RANK: Record<MembershipRole, number> = {
  viewer: 0,
  contributor: 1,
  approver: 2,
  owner: 3,
};

/** Operation kinds that can never execute (vendor writes / scripts). */
const BLOCKED_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  "submitContactForm",
  "sendChatMessage",
  "submitRfq",
  "vendorForm",
  "websiteChat",
  "purchase",
  "createAccount",
  "runScript",
  "browserOutreach",
]);

const COMMUNICATION_KINDS: ReadonlySet<string> = new Set([
  "communication.send",
  "communication.clarify",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => rightKeys[index] === key && left[key] === right[key]);
}

export interface IssueGrantInput {
  readonly issuerIdentity: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operations: readonly string[];
  readonly communicationProfile: string;
  readonly recipientConfigVersion: number;
  readonly inputVersions: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly costCeilingMicroUsd: number;
  readonly roundLimit: number;
  readonly expiresAt: number;
  readonly conversationId?: string;
}

export interface CreateOperationInput {
  readonly identity: string;
  readonly jobId: string;
  readonly kind: string;
  readonly requestId: string;
  readonly payload: unknown;
  readonly grantId: string;
  readonly reservationId?: string;
}

export interface ClaimInput {
  readonly identity: string;
  readonly operationId: string;
}

export interface OutcomeInput {
  readonly operationId: string;
  readonly token: string;
  readonly outcome: "success" | "failure" | "unknown";
  readonly providerEventId?: string;
  readonly unknownCharges?: boolean;
  readonly detail?: string;
}

export interface RequestWorkInput {
  readonly identity: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly text: string;
  readonly operationId?: string;
  readonly kind?: JobKind;
  readonly grantId?: string;
  readonly requestId?: string;
}

export class ControlledBackend {
  private sequence = 0;
  readonly organizations = new Map<string, Organization>();
  readonly projects = new Map<string, Project>();
  readonly memberships = new Map<string, Membership>();
  readonly recipientConfigs = new Map<string, RecipientConfig>();
  readonly budgets = new Map<string, ProviderBudget>();
  readonly grants = new Map<string, Grant>();
  readonly jobs = new Map<string, Job>();
  readonly operations = new Map<string, Operation>();
  readonly operationsByKey = new Map<string, string>();
  readonly attempts = new Map<string, Attempt>();
  readonly reservations = new Map<string, Reservation>();
  readonly processedEvents = new Map<string, { outcome: string; processingVersion: number }>();
  readonly evidenceRecords = new Map<string, Evidence>();
  readonly files = new Map<string, EvidenceFile>();
  readonly outboundSnapshots = new Map<string, OutboundSnapshot>();
  readonly conversations = new Map<string, Conversation>();
  readonly quotes = new Map<string, Quote>();
  readonly sentMessages: ControlledSentMessage[] = [];
  readonly scopeDecisions: ScopeDecision[] = [];

  private next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  // -- Setup -----------------------------------------------------------

  createOrganization(name: string, kind: OrganizationKind, now: number): Organization {
    const organization: Organization = {
      id: this.next("org"),
      name,
      kind,
      createdAt: now,
    };
    this.organizations.set(organization.id, organization);
    return Object.freeze(organization);
  }

  createProject(
    organizationId: string,
    name: string,
    visibility: ProjectVisibility,
    now: number,
  ): Project {
    if (!this.organizations.has(organizationId)) throw new Error("unknown organization");
    const project: Project = {
      id: this.next("proj"),
      organizationId,
      name,
      visibility,
      createdAt: now,
    };
    this.projects.set(project.id, project);
    return Object.freeze(project);
  }

  addMembership(
    organizationId: string,
    projectId: string | null,
    identity: string,
    role: MembershipRole,
    now: number,
    expiresAt: number | null = null,
  ): Membership {
    if (projectId !== null) {
      const project = this.projects.get(projectId);
      if (!project || project.organizationId !== organizationId) throw new Error("project mismatch");
    }
    const existing = [...this.memberships.values()].filter(
      (entry) => entry.identity === identity && entry.organizationId === organizationId,
    ).length;
    const membership: Membership = {
      id: this.next("member"),
      organizationId,
      projectId,
      identity,
      role,
      status: "active",
      version: existing + 1,
      expiresAt,
      revokedAt: null,
      updatedAt: now,
    };
    this.memberships.set(membership.id, membership);
    return Object.freeze(membership);
  }

  revokeMembership(membershipId: string, now: number): Membership {
    const current = this.memberships.get(membershipId);
    if (!current) throw new Error("unknown membership");
    const revoked: Membership = { ...current, status: "revoked", revokedAt: now, updatedAt: now };
    this.memberships.set(membershipId, revoked);
    return Object.freeze(revoked);
  }

  configureRecipient(mailbox: string, configuredBy: string, now: number): RecipientConfig {
    const normalized = normalizeMailbox(mailbox);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("invalid mailbox");
    for (const config of this.recipientConfigs.values()) {
      if (config.active) {
        this.recipientConfigs.set(config.id, { ...config, active: false });
      }
    }
    const version =
      [...this.recipientConfigs.values()].reduce((max, config) => Math.max(max, config.version), 0) + 1;
    const config: RecipientConfig = {
      id: this.next("recipient"),
      version,
      mailboxNormalized: normalized,
      mailboxHash: payloadHash(normalized),
      active: true,
      configuredAt: now,
      configuredBy,
    };
    this.recipientConfigs.set(config.id, config);
    return Object.freeze(config);
  }

  getActiveRecipient(): RecipientConfig | null {
    for (const config of this.recipientConfigs.values()) {
      if (config.active) return config;
    }
    return null;
  }

  ensureBudget(
    organizationId: string,
    ceilingMicroUsd: number,
    pricingBasis: string,
    now: number,
  ): ProviderBudget {
    for (const budget of this.budgets.values()) {
      if (budget.organizationId === organizationId) return budget;
    }
    const budget: ProviderBudget = {
      id: this.next("budget"),
      organizationId,
      ceilingMicroUsd,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis,
      updatedAt: now,
    };
    this.budgets.set(budget.id, budget);
    return Object.freeze(budget);
  }

  getBudgetForOrganization(organizationId: string): ProviderBudget | null {
    for (const budget of this.budgets.values()) {
      if (budget.organizationId === organizationId) return budget;
    }
    return null;
  }

  issueGrant(input: IssueGrantInput, now: number): AuthorityResult<Grant> {
    const access = this.checkProjectAccess(
      input.issuerIdentity,
      input.organizationId,
      input.projectId,
      "approver",
      now,
    );
    if (!access.ok) return access;
    for (const operationId of input.operations) {
      const entry = lookupCapability(operationId);
      if (entry === undefined) return denial("unknown-operation", `unknown operation ${operationId}`);
      if (!entry.enabled) return denial("unavailable-capability", `operation ${operationId} unavailable`);
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      return denial("invalid-payload", "grant expiry must be in the future");
    }
    const canonical = canonicalJson(input.payload);
    const grant: Grant = {
      id: this.next("grant"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      operations: Object.freeze([...input.operations]),
      communicationProfile: input.communicationProfile,
      recipientConfigVersion: input.recipientConfigVersion,
      inputVersions: Object.freeze({ ...input.inputVersions }),
      canonicalPayload: canonical,
      payloadHash: payloadHash(input.payload),
      payloadSha256: null,
      costCeilingMicroUsd: input.costCeilingMicroUsd,
      roundLimit: input.roundLimit,
      expiresAt: input.expiresAt,
      revocationVersion: 1,
      status: "active",
      conversationId: input.conversationId ?? null,
      createdAt: now,
    };
    this.grants.set(grant.id, grant);
    return approved(Object.freeze(grant));
  }

  revokeGrant(grantId: string, now: number): Grant {
    const current = this.grants.get(grantId);
    if (!current) throw new Error("unknown grant");
    const revoked: Grant = {
      ...current,
      status: "revoked",
      revocationVersion: current.revocationVersion + 1,
    };
    void now;
    this.grants.set(grantId, revoked);
    return Object.freeze(revoked);
  }

  amendGrantDraft(grantId: string, issuerIdentity: string, payload: unknown, now: number): AuthorityResult<Grant> {
    const current = this.grants.get(grantId);
    if (!current) return denial("denied-membership", "not authorized for this project");
    const access = this.checkProjectAccess(
      issuerIdentity,
      current.organizationId,
      current.projectId,
      "approver",
      now,
    );
    if (!access.ok) return access;
    const canonical = canonicalJson(payload);
    const amended: Grant = {
      ...current,
      canonicalPayload: canonical,
      payloadHash: payloadHash(payload),
      payloadSha256: null,
    };
    this.grants.set(grantId, amended);
    return approved(Object.freeze(amended));
  }

  bindConversation(grantId: string, conversationId: string): void {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error("unknown grant");
    this.grants.set(grantId, { ...grant, conversationId });
  }

  openConversation(
    organizationId: string,
    projectId: string,
    grantId: string,
    now: number,
  ): Conversation {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error("unknown grant");
    const conversation: Conversation = {
      id: this.next("conv"),
      organizationId,
      projectId,
      grantId,
      version: 1,
      state: "draft",
      recipientConfigVersion: grant.recipientConfigVersion,
      lastReplyAt: null,
      cancelledAt: null,
      updatedAt: now,
    };
    this.conversations.set(conversation.id, conversation);
    return Object.freeze(conversation);
  }

  recordReply(conversationId: string, now: number): Conversation {
    const current = this.conversations.get(conversationId);
    if (!current) throw new Error("unknown conversation");
    const updated: Conversation = {
      ...current,
      version: current.version + 1,
      state: "replyReceived",
      lastReplyAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversationId, updated);
    return Object.freeze(updated);
  }

  cancelConversation(conversationId: string, now: number): Conversation {
    const current = this.conversations.get(conversationId);
    if (!current) throw new Error("unknown conversation");
    const updated: Conversation = {
      ...current,
      state: "cancelled",
      cancelledAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversationId, updated);
    return Object.freeze(updated);
  }

  // -- Authority -------------------------------------------------------

  checkProjectAccess(
    identity: string,
    organizationId: string,
    projectId: string,
    minRole: MembershipRole,
    now: number,
  ): AuthorityResult<MembershipRole> {
    if (typeof identity !== "string" || identity.trim().length === 0) {
      return denial("forged-identity", "missing identity proof");
    }
    // No existence oracles: unknown organizations, unknown projects, missing
    // memberships, cross-organization IDs, and restricted projects without an
    // explicit membership share one denial. Caller-owned membership states
    // (revoked/expired) stay distinguishable.
    const organization = this.organizations.get(organizationId);
    const orgRows = [...this.memberships.values()].filter(
      (entry) => entry.organizationId === organizationId && entry.identity === identity,
    );
    if (!organization || orgRows.length === 0) {
      return denial("denied-membership", "not authorized for this project");
    }
    const activeOrg = orgRows.filter((entry) => entry.status === "active");
    if (activeOrg.length === 0) return denial("revoked-membership", "membership revoked");
    const currentOrg = activeOrg.filter(
      (entry) => entry.expiresAt === null || !isExpired(now, entry.expiresAt),
    );
    if (currentOrg.length === 0) return denial("expired-membership", "membership expired");
    const project = this.projects.get(projectId);
    if (!project || project.organizationId !== organizationId) {
      return denial("denied-membership", "not authorized for this project");
    }
    let role: MembershipRole = currentOrg
      .map((entry) => entry.role)
      .sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ?? "viewer";

    if (project.visibility === "restricted") {
      const projectRows = currentOrg.filter((entry) => entry.projectId === projectId);
      if (projectRows.length === 0) {
        return denial("denied-membership", "not authorized for this project");
      }
      role =
        projectRows.map((entry) => entry.role).sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ??
        "viewer";
    }
    if (!roleSatisfies(role, minRole)) {
      return denial("denied-capability", `role ${role} cannot perform ${minRole}-level work`);
    }
    return approved(role);
  }

  requireCapability(operationKind: string, role: MembershipRole): AuthorityResult<true> {
    if (BLOCKED_CHANNEL_KINDS.has(operationKind)) {
      return denial("alternate-channel-denied", `channel operation ${operationKind} is never permitted`);
    }
    const entry = lookupCapability(operationKind);
    if (entry === undefined) return denial("unknown-operation", `unknown operation ${operationKind}`);
    if (!entry.enabled) return denial("unavailable-capability", `operation ${operationKind} unavailable`);
    if (!roleSatisfies(role, entry.requiredRole)) {
      return denial("denied-capability", `role ${role} cannot run ${operationKind}`);
    }
    return approved(true);
  }

  // -- Scope-gated work -------------------------------------------------

  requestWork(input: RequestWorkInput, now: number): AuthorityResult<Job> {
    if (containsInstructionOverride(input.text)) {
      this.recordScopeDecision(input, "unrelatedRefused", "supplier-evidence-instructions-cannot-expand-capabilities", null, now);
      return denial(
        "prompt-injection-denied",
        "supplier evidence cannot expand capabilities",
      );
    }
    const classified = classifyScope({
      text: input.text,
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    });
    if (classified.verdict === "unrelatedRefused") {
      this.recordScopeDecision(input, "unrelatedRefused", classified.reason, null, now);
      return denial("unrelated-refusal", classified.reason);
    }
    if (classified.verdict === "unavailableRefused") {
      this.recordScopeDecision(input, "unavailableRefused", classified.reason, null, now);
      return denial("unavailable-capability", classified.reason);
    }
    const operationId = classified.operationId;
    const access = this.checkProjectAccess(
      input.identity,
      input.organizationId,
      input.projectId,
      lookupCapability(operationId)?.requiredRole ?? "contributor",
      now,
    );
    if (!access.ok) return access;
    const capability = this.requireCapability(operationId, access.value);
    if (!capability.ok) return capability;

    const kind: JobKind = input.kind ?? "research";
    let grantId = input.grantId ?? null;
    let grantVersion = 0;
    let inputVersions: Record<string, string> = {};
    if (kind === "communication") {
      if (grantId === null) return denial("denied-capability", "communication requires a grant");
      const grant = this.grants.get(grantId);
      if (!grant) return denial("denied-membership", "not authorized for this project");
      if (grant.status !== "active") return denial("revoked-grant", "grant is not active");
      if (isExpired(now, grant.expiresAt)) return denial("expired-grant", "grant expired");
      grantVersion = grant.revocationVersion;
      inputVersions = { ...grant.inputVersions };
    }
    if (grantId === null) {
      const fallback = [...this.grants.values()].find(
        (grant) =>
          grant.organizationId === input.organizationId &&
          grant.projectId === input.projectId &&
          grant.status === "active",
      );
      if (fallback) {
        grantId = fallback.id;
        grantVersion = fallback.revocationVersion;
        inputVersions = { ...fallback.inputVersions };
      } else {
        const created = this.next("grant-auto");
        const auto: Grant = {
          id: created,
          organizationId: input.organizationId,
          projectId: input.projectId,
          operations: Object.freeze([operationId]),
          communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
          recipientConfigVersion: this.getActiveRecipient()?.version ?? 0,
          inputVersions: Object.freeze({}),
          canonicalPayload: canonicalJson({}),
          payloadHash: payloadHash({}),
          payloadSha256: null,
          costCeilingMicroUsd: 0,
          roundLimit: 0,
          expiresAt: now + 900_000,
          revocationVersion: 1,
          status: "active",
          conversationId: null,
          createdAt: now,
        };
        this.grants.set(created, auto);
        grantId = created;
        grantVersion = 1;
      }
    }
    const job: Job = {
      id: this.next("job"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      grantId,
      grantVersion,
      kind,
      state: "queued",
      inputVersions: Object.freeze(inputVersions),
      createdAt: now,
      updatedAt: now,
      cancelledAt: null,
      cancelReason: null,
    };
    this.jobs.set(job.id, job);
    this.recordScopeDecision(input, "supported", operationId, job.id, now);
    return approved(Object.freeze(job));
  }

  private recordScopeDecision(
    input: RequestWorkInput,
    verdict: ScopeDecision["verdict"],
    reason: string,
    jobId: string | null,
    now: number,
  ): void {
    const fingerprint = payloadHash({
      organizationId: input.organizationId,
      projectId: input.projectId,
      text: input.text,
      operationId: input.operationId ?? null,
    });
    this.scopeDecisions.push(
      Object.freeze({ fingerprint, verdict, reason, jobId, createdAt: now }),
    );
  }

  // -- Idempotent operations --------------------------------------------

  createOperation(input: CreateOperationInput, now: number): AuthorityResult<{ operation: Operation; deduped: boolean }> {
    // Authorization precedes the idempotency lookup: foreign request keys
    // can neither reveal existence nor conflict.
    const job = this.jobs.get(input.jobId);
    if (!job) return denial("denied-membership", "not authorized for this project");
    const access = this.checkProjectAccess(
      input.identity,
      job.organizationId,
      job.projectId,
      lookupCapability(input.kind)?.requiredRole ?? "contributor",
      now,
    );
    if (!access.ok) return access;
    const capability = this.requireCapability(input.kind, access.value);
    if (!capability.ok) return capability;
    if (job.state === "cancelled") return denial("cancelled-before-claim", "job is cancelled");

    const grant = this.grants.get(input.grantId);
    if (!grant) return denial("denied-membership", "not authorized for this project");
    if (grant.organizationId !== job.organizationId || grant.projectId !== job.projectId) {
      return denial("denied-project", "grant belongs to another project");
    }
    if (!grant.operations.includes(input.kind)) {
      return denial("denied-capability", `grant does not authorize ${input.kind}`);
    }
    if (grant.status !== "active") return denial("revoked-grant", "grant is not active");
    if (isExpired(now, grant.expiresAt)) return denial("expired-grant", "grant expired");

    const key = requestKey(job.organizationId, input.kind, input.requestId);
    const canonical = canonicalJson(input.payload);
    const hash = payloadHash(input.payload);

    const existingId = this.operationsByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.operations.get(existingId);
      if (existing) {
        if (
          existing.jobId === job.id &&
          sameCanonicalPayload(existing.canonicalPayload, canonical) &&
          sha256BindingOk(existing.payloadSha256, null)
        ) {
          return approved({ operation: existing, deduped: true });
        }
        return denial("duplicate-conflict", "requestId reused with a different payload");
      }
    }

    let conversationVersion: number | null = null;
    if (COMMUNICATION_KINDS.has(input.kind)) {
      if (grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
        return denial("alternate-channel-denied", "only the owner-roleplay profile is permitted");
      }
      const conversation = grant.conversationId === null
        ? null
        : this.conversations.get(grant.conversationId);
      if (conversation) conversationVersion = conversation.version;
    }

    let reservationId: string | null = null;
    if (input.reservationId !== undefined) {
      const reservation = this.reservations.get(input.reservationId);
      if (!reservation || reservation.jobId !== job.id) {
        return denial("allowance-exhausted", "reservation does not belong to this job");
      }
      reservationId = reservation.id;
    }

    const operation: Operation = {
      id: this.next("op"),
      organizationId: job.organizationId,
      projectId: job.projectId,
      jobId: job.id,
      kind: input.kind,
      requestId: input.requestId,
      requestKey: key,
      canonicalPayload: canonical,
      normalizedPayloadHash: hash,
      payloadSha256: null,
      grantId: grant.id,
      grantVersion: grant.revocationVersion,
      recipientConfigVersion: COMMUNICATION_KINDS.has(input.kind)
        ? grant.recipientConfigVersion
        : null,
      conversationVersion,
      state: "prepared",
      reservationId,
      attemptToken: null,
      linkedResendOf: null,
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(operation.id, operation);
    this.operationsByKey.set(key, operation.id);
    return approved({ operation: Object.freeze(operation), deduped: false });
  }

  // -- Atomic dispatch claim ---------------------------------------------

  claimOperation(input: ClaimInput, now: number): AuthorityResult<{ operation: Operation; attemptToken: string }> {
    const operation = this.operations.get(input.operationId);
    if (!operation) return denial("denied-membership", "not authorized for this project");
    if (operation.state !== "prepared") {
      if (operation.state === "cancelled") {
        return denial("cancelled-before-claim", "operation was cancelled before claim");
      }
      return denial("already-claimed", `operation is already ${operation.state}`);
    }

    // Decide everything before mutating: any denial below leaves zero effect.
    const job = this.jobs.get(operation.jobId);
    if (!job) return denial("denied-membership", "not authorized for this project");
    if (job.state === "cancelled") return denial("cancelled-before-claim", "job is cancelled");

    const capabilityEntry = lookupCapability(operation.kind);
    if (BLOCKED_CHANNEL_KINDS.has(operation.kind)) {
      return denial("alternate-channel-denied", `channel operation ${operation.kind} is never permitted`);
    }
    if (capabilityEntry === undefined) {
      return denial("unknown-operation", `unknown operation ${operation.kind}`);
    }
    const access = this.checkProjectAccess(
      input.identity,
      operation.organizationId,
      operation.projectId,
      capabilityEntry.requiredRole,
      now,
    );
    if (!access.ok) return access;
    const capability = this.requireCapability(operation.kind, access.value);
    if (!capability.ok) return capability;

    const grant = this.grants.get(operation.grantId);
    if (!grant) return denial("denied-membership", "not authorized for this project");
    if (grant.status !== "active") return denial("revoked-grant", "grant was revoked");
    if (grant.revocationVersion !== operation.grantVersion) {
      return denial("stale-grant-version", "grant was re-issued after this operation was prepared");
    }
    if (isExpired(now, grant.expiresAt)) return denial("grant-expired-at-claim", "grant expired before claim");
    if (!recordsEqual(job.inputVersions, grant.inputVersions)) {
      return denial("stale-input-version", "job inputs no longer match the current grant");
    }

    // Communication envelope first: header injections (alternate recipient,
    // CC/BCC, Reply-To, profile) receive their precise typed denial before
    // the draft comparison, so smuggled headers cannot hide behind it.
    if (COMMUNICATION_KINDS.has(operation.kind)) {
      const recipient = this.getActiveRecipient();
      if (!recipient) return denial("missing-recipient-config", "owner recipient is not configured");
      if (
        operation.recipientConfigVersion !== grant.recipientConfigVersion ||
        grant.recipientConfigVersion !== recipient.version
      ) {
        return denial("stale-recipient-version", "recipient configuration changed; re-approval required");
      }
      const parsed: unknown = JSON.parse(operation.canonicalPayload);
      if (!isRecord(parsed)) return denial("invalid-payload", "communication payload must be an object");
      const to = typeof parsed["to"] === "string" ? normalizeMailbox(parsed["to"]) : "";
      const cc = Array.isArray(parsed["cc"]) ? parsed["cc"] : null;
      const bcc = Array.isArray(parsed["bcc"]) ? parsed["bcc"] : null;
      const profile = parsed["profile"];
      if (to !== recipient.mailboxNormalized) {
        return denial("recipient-mismatch", "recipient is not the configured owner mailbox");
      }
      if (cc === null || cc.length !== 0) return denial("cc-not-empty", "CC must remain empty");
      if (bcc === null || bcc.length !== 0) return denial("bcc-not-empty", "BCC must remain empty");
      if (parsed["replyTo"] !== undefined) {
        return denial("reply-to-redirect", "Reply-To redirection is denied");
      }
      if (profile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
        return denial("alternate-channel-denied", "only the owner-roleplay profile is permitted");
      }
    }

    if (!sameCanonicalPayload(operation.canonicalPayload, grant.canonicalPayload)) {
      return denial("changed-draft", "approved draft changed after this operation was prepared");
    }
    if (!sha256BindingOk(operation.payloadSha256, grant.payloadSha256)) {
      return denial("changed-draft", "payload digest no longer matches the approved draft");
    }

    if (operation.conversationVersion !== null) {
      const conversation = grant.conversationId === null
        ? null
        : this.conversations.get(grant.conversationId);
      if (conversation && conversation.version !== operation.conversationVersion) {
        return denial("relevant-reply-superseded", "a relevant reply arrived after this operation was prepared");
      }
      if (conversation && conversation.state === "cancelled") {
        return denial("cancelled-before-claim", "conversation was cancelled before claim");
      }
    }

    if (operation.reservationId !== null) {
      const reservation = this.reservations.get(operation.reservationId);
      if (!reservation || reservation.state !== "open") {
        return denial("allowance-exhausted", "reservation is not available");
      }
    }

    // Commit: single-use attempt token, prepared -> dispatching.
    const token = this.next("att-token");
    const claimed: Operation = {
      ...operation,
      state: "dispatching",
      attemptToken: token,
      updatedAt: now,
    };
    this.operations.set(claimed.id, claimed);
    const attempt: Attempt = {
      id: this.next("att"),
      operationId: claimed.id,
      token,
      state: "dispatching",
      createdAt: now,
      observedAt: null,
      providerEventId: null,
      detail: null,
    };
    this.attempts.set(attempt.id, attempt);
    return approved({ operation: Object.freeze(claimed), attemptToken: token });
  }

  // -- Controlled dispatch + outcomes -------------------------------------

  dispatchControlledSend(operationId: string, token: string, now: number): AuthorityResult<ControlledSentMessage> {
    const operation = this.operations.get(operationId);
    if (!operation) return denial("denied-membership", "not authorized for this project");
    if (operation.state !== "dispatching" || operation.attemptToken !== token) {
      return denial("already-claimed", "attempt token is not valid for dispatch");
    }
    for (const sent of this.sentMessages) {
      if (sent.attemptToken === token) {
        return denial("already-claimed", "this attempt was already dispatched");
      }
    }
    if (!COMMUNICATION_KINDS.has(operation.kind)) {
      return denial("denied-capability", "only communication operations dispatch mail");
    }
    const parsed: unknown = JSON.parse(operation.canonicalPayload);
    if (!isRecord(parsed) || typeof parsed["to"] !== "string") {
      return denial("invalid-payload", "communication payload must carry a recipient");
    }
    const grant = this.grants.get(operation.grantId);
    const recipientVersion = grant?.recipientConfigVersion ?? operation.recipientConfigVersion ?? 0;
    const snapshot: OutboundSnapshot = {
      id: this.next("out"),
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      operationId: operation.id,
      grantId: operation.grantId,
      to: normalizeMailbox(parsed["to"]),
      cc: [],
      bcc: [],
      replyTo: null,
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: recipientVersion,
      payloadHash: operation.normalizedPayloadHash,
      bodyHash: payloadHash(parsed["body"] ?? null),
      counterpartyRole: "ownerStandIn",
      createdAt: now,
    };
    this.outboundSnapshots.set(snapshot.id, snapshot);
    const sent: ControlledSentMessage = Object.freeze({
      operationId: operation.id,
      attemptToken: token,
      to: snapshot.to,
      payloadHash: operation.normalizedPayloadHash,
      sentAt: now,
    });
    this.sentMessages.push(sent);
    return approved(sent);
  }

  recordOutcome(input: OutcomeInput, now: number): AuthorityResult<Operation> {
    const operation = this.operations.get(input.operationId);
    if (!operation) return denial("denied-membership", "not authorized for this project");
    if (operation.state !== "dispatching" || operation.attemptToken !== input.token) {
      return denial("already-claimed", "attempt token is not valid for this operation");
    }
    if (input.providerEventId !== undefined) {
      const key = `controlled|${input.providerEventId}`;
      const seen = this.processedEvents.get(key);
      if (seen) {
        return approved(operation);
      }
      this.processedEvents.set(key, { outcome: input.outcome, processingVersion: 1 });
    }
    let state: OperationState = "observedSuccess";
    if (input.outcome === "unknown" || (input.outcome === "failure" && input.unknownCharges === true)) {
      state = "outcomeUnknown";
      this.retainReservationUnknown(operation, now);
    } else if (input.outcome === "failure") {
      state = "observedFailure";
      this.releaseReservation(operation, now);
    } else {
      this.spendReservation(operation, now);
    }
    const updated: Operation = { ...operation, state, updatedAt: now };
    this.operations.set(updated.id, updated);
    for (const attempt of this.attempts.values()) {
      if (attempt.operationId === updated.id && attempt.token === input.token) {
        const next: Attempt = {
          ...attempt,
          state,
          observedAt: now,
          providerEventId: input.providerEventId ?? null,
          detail: input.detail ?? null,
        };
        this.attempts.set(attempt.id, next);
      }
    }
    return approved(Object.freeze(updated));
  }

  reconcileAfterCrash(operationId: string, now: number): { reconciled: boolean; state: OperationState | null } {
    const operation = this.operations.get(operationId);
    if (!operation) return { reconciled: false, state: null };
    if (operation.state !== "dispatching") return { reconciled: false, state: operation.state };
    const updated: Operation = { ...operation, state: "outcomeUnknown", updatedAt: now };
    this.operations.set(updated.id, updated);
    for (const attempt of this.attempts.values()) {
      if (attempt.operationId === updated.id && attempt.state === "dispatching") {
        this.attempts.set(attempt.id, { ...attempt, state: "outcomeUnknown", observedAt: now, detail: "crash-reconciliation" });
      }
    }
    return { reconciled: true, state: "outcomeUnknown" };
  }

  reviewedResend(
    operationId: string,
    newRequestId: string,
    reviewerIdentity: string,
    now: number,
  ): AuthorityResult<{ operation: Operation; warning: string }> {
    const operation = this.operations.get(operationId);
    if (!operation) return denial("denied-membership", "not authorized for this project");
    if (operation.state !== "outcomeUnknown") {
      return denial("already-claimed", "only an ambiguous operation may be resent after review");
    }
    const access = this.checkProjectAccess(
      reviewerIdentity,
      operation.organizationId,
      operation.projectId,
      "approver",
      now,
    );
    if (!access.ok) return access;
    const key = requestKey(operation.organizationId, operation.kind, newRequestId);
    if (this.operationsByKey.has(key)) {
      return denial("duplicate-conflict", "resend requestId is already in use");
    }
    const resent: Operation = {
      ...operation,
      id: this.next("op"),
      requestId: newRequestId,
      requestKey: key,
      state: "prepared",
      attemptToken: null,
      linkedResendOf: operation.id,
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(resent.id, resent);
    this.operationsByKey.set(key, resent.id);
    return approved({
      operation: Object.freeze(resent),
      warning: "prior attempt outcome remains unknown; resend may duplicate the external effect",
    });
  }

  cancelJob(
    jobId: string,
    identity: string,
    now: number,
    reason: string,
  ): AuthorityResult<{ job: Job; unresolvedOperationIds: string[] }> {
    const job = this.jobs.get(jobId);
    if (!job) return denial("denied-membership", "not authorized for this project");
    const access = this.checkProjectAccess(
      identity,
      job.organizationId,
      job.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return access;
    const unresolved: string[] = [];
    for (const operation of this.operations.values()) {
      if (operation.jobId !== jobId) continue;
      if (operation.state === "prepared") {
        this.operations.set(operation.id, { ...operation, state: "cancelled", updatedAt: now });
      } else if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
        unresolved.push(operation.id);
      }
    }
    const cancelled: Job = {
      ...job,
      state: "cancelled",
      cancelledAt: now,
      cancelReason: reason,
      updatedAt: now,
    };
    this.jobs.set(jobId, cancelled);
    return approved({ job: Object.freeze(cancelled), unresolvedOperationIds: unresolved });
  }

  recordLateDelivery(
    operationId: string,
    token: string,
    providerEventId: string,
    now: number,
  ): AuthorityResult<{ jobState: JobState; delivery: OperationState }> {
    const operation = this.operations.get(operationId);
    if (!operation) return denial("denied-membership", "not authorized for this project");
    const job = this.jobs.get(operation.jobId);
    if (!job) return denial("denied-membership", "not authorized for this project");
    const outcome = this.recordOutcome(
      { operationId, token, outcome: "success", providerEventId, detail: "late-confirmation" },
      now,
    );
    if (!outcome.ok) return outcome;
    // Cancellation and confirmed late delivery remain separate facts: the
    // job keeps its cancelled state while the delivery is recorded.
    return approved({ jobState: job.state, delivery: outcome.value.state });
  }

  // -- Shared budgets -----------------------------------------------------

  reserve(
    jobId: string,
    amountMicroUsd: number,
    pricingBasis: string,
    now: number,
  ): AuthorityResult<Reservation> {
    const job = this.jobs.get(jobId);
    if (!job) return denial("denied-membership", "not authorized for this project");
    if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd <= 0) {
      return denial("invalid-payload", "reservation amount must be a positive safe integer");
    }
    const budget = this.getBudgetForOrganization(job.organizationId);
    if (!budget) return denial("allowance-exhausted", "no provider budget configured");
    const committed = budget.reservedMicroUsd + budget.spentMicroUsd + budget.unresolvedMicroUsd;
    if (committed + amountMicroUsd > budget.ceilingMicroUsd) {
      return denial("allowance-exhausted", "shared allowance cannot cover another full reservation");
    }
    if (job.state === "cancelled") return denial("cancelled-before-claim", "job is cancelled");
    const reservation: Reservation = {
      id: this.next("res"),
      organizationId: job.organizationId,
      jobId: job.id,
      budgetId: budget.id,
      ceilingMicroUsd: budget.ceilingMicroUsd,
      reservedMicroUsd: amountMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis,
      state: "open",
      updatedAt: now,
    };
    this.reservations.set(reservation.id, reservation);
    this.budgets.set(budget.id, {
      ...budget,
      reservedMicroUsd: budget.reservedMicroUsd + amountMicroUsd,
      updatedAt: now,
    });
    return approved(Object.freeze(reservation));
  }

  private spendReservation(operation: Operation, now: number): void {
    if (operation.reservationId === null) return;
    const reservation = this.reservations.get(operation.reservationId);
    const budget = reservation ? this.budgets.get(reservation.budgetId) : undefined;
    if (!reservation) return;
    const amount = reservation.reservedMicroUsd;
    this.reservations.set(reservation.id, {
      ...reservation,
      reservedMicroUsd: 0,
      spentMicroUsd: reservation.spentMicroUsd + amount,
      state: "closed",
      updatedAt: now,
    });
    if (budget) {
      this.budgets.set(budget.id, {
        ...budget,
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        spentMicroUsd: budget.spentMicroUsd + amount,
        updatedAt: now,
      });
    }
  }

  private releaseReservation(operation: Operation, now: number): void {
    if (operation.reservationId === null) return;
    const reservation = this.reservations.get(operation.reservationId);
    const budget = reservation ? this.budgets.get(reservation.budgetId) : undefined;
    if (!reservation) return;
    const amount = reservation.reservedMicroUsd;
    this.reservations.set(reservation.id, {
      ...reservation,
      reservedMicroUsd: 0,
      state: "closed",
      updatedAt: now,
    });
    if (budget) {
      this.budgets.set(budget.id, {
        ...budget,
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        updatedAt: now,
      });
    }
  }

  private retainReservationUnknown(operation: Operation, now: number): void {
    if (operation.reservationId === null) return;
    const reservation = this.reservations.get(operation.reservationId);
    const budget = reservation ? this.budgets.get(reservation.budgetId) : undefined;
    if (!reservation) return;
    const amount = reservation.reservedMicroUsd;
    this.reservations.set(reservation.id, {
      ...reservation,
      reservedMicroUsd: 0,
      unresolvedMicroUsd: reservation.unresolvedMicroUsd + amount,
      updatedAt: now,
    });
    if (budget) {
      this.budgets.set(budget.id, {
        ...budget,
        reservedMicroUsd: Math.max(0, budget.reservedMicroUsd - amount),
        unresolvedMicroUsd: budget.unresolvedMicroUsd + amount,
        updatedAt: now,
      });
    }
  }

  // -- Events, evidence, files, quotes -------------------------------------

  processEvent(
    provider: string,
    environment: string,
    eventId: string,
    processingVersion: number,
    outcome: string,
    now: number,
  ): { deduplicated: boolean; outcome: string } {
    void now;
    const key = `${provider}|${environment}|${eventId}`;
    const seen = this.processedEvents.get(key);
    if (seen) return { deduplicated: true, outcome: seen.outcome };
    this.processedEvents.set(key, { outcome, processingVersion });
    return { deduplicated: false, outcome };
  }

  recordEvidence(
    identity: string,
    organizationId: string,
    projectId: string,
    input: {
      sourceKind: string;
      sourceUrl?: string;
      providerIds?: string;
      contentHash: string;
      completeness: Evidence["completeness"];
      counterpartyRole: string;
      executionMode: ExecutionMode;
      locator?: string;
    },
    now: number,
  ): AuthorityResult<Evidence> {
    const access = this.checkProjectAccess(identity, organizationId, projectId, "contributor", now);
    if (!access.ok) return access;
    const entry = lookupCapability("evidence.record");
    if (!entry || !roleSatisfies(access.value, entry.requiredRole)) {
      return denial("denied-capability", "cannot record evidence");
    }
    const evidence: Evidence = {
      id: this.next("ev"),
      organizationId,
      projectId,
      sourceKind: input.sourceKind,
      sourceUrl: input.sourceUrl ?? null,
      providerIds: input.providerIds ?? null,
      capturedAt: now,
      contentHash: input.contentHash,
      completeness: input.completeness,
      counterpartyRole: input.counterpartyRole,
      executionMode: input.executionMode,
      locator: input.locator ?? null,
    };
    this.evidenceRecords.set(evidence.id, evidence);
    return approved(Object.freeze(evidence));
  }

  recordFile(
    identity: string,
    evidenceId: string,
    input: { sizeBytes?: number; contentType?: string; storageRef?: string },
    now: number,
  ): AuthorityResult<EvidenceFile> {
    const evidence = this.evidenceRecords.get(evidenceId);
    if (!evidence) return denial("denied-membership", "not authorized for this project");
    const access = this.checkProjectAccess(
      identity,
      evidence.organizationId,
      evidence.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return access;
    const file: EvidenceFile = {
      id: this.next("file"),
      organizationId: evidence.organizationId,
      projectId: evidence.projectId,
      evidenceId,
      sizeBytes: input.sizeBytes ?? null,
      contentType: input.contentType ?? null,
      storageRef: input.storageRef ?? null,
    };
    this.files.set(file.id, file);
    return approved(Object.freeze(file));
  }

  recordQuote(
    identity: string,
    organizationId: string,
    projectId: string,
    input: {
      version: string;
      currency: string;
      lines: readonly QuoteLine[];
      charges: readonly QuoteCharge[];
      taxBasis: string;
      evidenceRefs: Quote["evidenceRefs"];
      counterpartyRole: string;
      executionMode: ExecutionMode;
      conversationId?: string;
      supersedes?: string;
    },
    now: number,
  ): AuthorityResult<Quote> {
    const access = this.checkProjectAccess(identity, organizationId, projectId, "contributor", now);
    if (!access.ok) return access;
    const capability = this.requireCapability("quote.record", access.value);
    if (!capability.ok) return capability;
    for (const line of input.lines) {
      try {
        checkMoney(line.unitPrice, `line ${line.lineId}`);
      } catch {
        return denial("invalid-payload", `line ${line.lineId} is not valid minor-unit money`);
      }
      if (line.unitPrice.currency !== input.currency) {
        return denial("invalid-payload", `line ${line.lineId} mixes currency`);
      }
    }
    for (const charge of input.charges) {
      if (charge.amount !== undefined) {
        try {
          checkMoney(charge.amount, `charge ${charge.chargeId}`);
        } catch {
          return denial("invalid-payload", `charge ${charge.chargeId} is not valid minor-unit money`);
        }
      }
      if (charge.state === "unknown" && charge.amount !== undefined) {
        return denial("invalid-payload", `unknown charge ${charge.chargeId} must not carry an amount`);
      }
    }
    const quote: Quote = {
      id: this.next("quote"),
      organizationId,
      projectId,
      conversationId: input.conversationId ?? null,
      version: input.version,
      contentHash: payloadHash({
        version: input.version,
        currency: input.currency,
        lines: input.lines,
        charges: input.charges,
        taxBasis: input.taxBasis,
      }),
      currency: input.currency,
      lines: Object.freeze([...input.lines]),
      charges: Object.freeze([...input.charges]),
      taxBasis: input.taxBasis,
      evidenceRefs: Object.freeze([...input.evidenceRefs]),
      counterpartyRole: input.counterpartyRole,
      executionMode: input.executionMode,
      supersedes: input.supersedes ?? null,
      createdAt: now,
    };
    this.quotes.set(quote.id, quote);
    return approved(Object.freeze(quote));
  }

  /**
   * Equivalent-scope comparison: unknown charges block any "cheaper" claim.
   * Returns `complete` only when both totals are fully known on the same
   * currency and tax basis; otherwise `incomplete` with the blocking reason.
   */
  compareControlledQuotes(leftId: string, rightId: string): AuthorityResult<{
    verdict: "complete" | "incomplete";
    differenceMinorUnits: number | null;
    cheaper: "left" | "right" | "equal" | null;
    reason: string;
  }> {
    const left = this.quotes.get(leftId);
    const right = this.quotes.get(rightId);
    if (!left || !right) return denial("denied-project", "unknown quote");
    if (left.organizationId !== right.organizationId || left.projectId !== right.projectId) {
      return denial("denied-project", "quotes belong to different projects");
    }
    if (left.currency !== right.currency) {
      return approved({
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "mixed-currency-requires-accepted-conversion-basis",
      });
    }
    if (left.taxBasis !== right.taxBasis) {
      return approved({
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "mixed-tax-basis",
      });
    }
    const total = (quote: Quote): { known: boolean; total: number } => {
      let sum = 0;
      for (const line of quote.lines) sum += line.unitPrice.minorUnits;
      for (const charge of quote.charges) {
        if (charge.state === "unknown") return { known: false, total: 0 };
        if (charge.state === "known" || charge.state === "estimated") {
          if (!charge.amount) return { known: false, total: 0 };
          sum += charge.amount.minorUnits;
        }
      }
      return { known: true, total: sum };
    };
    const leftTotal = total(left);
    const rightTotal = total(right);
    if (!leftTotal.known || !rightTotal.known) {
      return approved({
        verdict: "incomplete",
        differenceMinorUnits: null,
        cheaper: null,
        reason: "unknown-charge-prevents-complete-claim",
      });
    }
    const difference = leftTotal.total - rightTotal.total;
    return approved({
      verdict: "complete",
      differenceMinorUnits: Math.abs(difference),
      cheaper: difference === 0 ? "equal" : difference < 0 ? "left" : "right",
      reason: "equivalent-scope",
    });
  }

  // -- Introspection -------------------------------------------------------

  snapshotCounts(): {
    jobs: number;
    operations: number;
    sends: number;
    reservations: number;
    quotes: number;
    evidence: number;
    scopeDecisions: number;
  } {
    return {
      jobs: this.jobs.size,
      operations: this.operations.size,
      sends: this.sentMessages.length,
      reservations: this.reservations.size,
      quotes: this.quotes.size,
      evidence: this.evidenceRecords.size,
      scopeDecisions: this.scopeDecisions.length,
    };
  }

  getOperationByKey(organizationId: string, kind: string, requestId: string): Operation | null {
    const id = this.operationsByKey.get(requestKey(organizationId, kind, requestId));
    if (!id) return null;
    return this.operations.get(id) ?? null;
  }
}

export type { AuthorityResult, Denial };
export { COMMUNICATION_PROFILE_OWNER_ROLEPLAY };

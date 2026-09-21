/**
 * F1 idempotent operations and atomic dispatch claims (controlled contract).
 *
 * Duplicate `requestId` with an identical canonical payload returns the one
 * existing operation; a changed payload conflicts and creates no provider
 * call. Authorization precedes the idempotency lookup, so foreign request
 * keys can neither reveal existence nor conflict. The claim rechecks
 * cancellation, access, grant, input versions, approved payload, recipient
 * version, and reservation atomically and mints a single-use attempt token.
 * Any denial leaves zero new effect.
 *
 * Visibility: `create`/`get` are public product calls. `claim` is an
 * internal executor transition, reachable only through the authorized
 * dispatch action — browser callers can never claim directly, and attempt
 * token possession alone never authorizes an outcome.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
import { canonicalJson, parseBoundedPayloadJson, payloadHash, requestKey } from "../shared/hashing.js";
import { sameCanonicalPayload, sha256BindingOk, sha256HexOfCanonical } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";
import { isCommunicationDenial, validateOutboundPayload } from "../communication/contracts.js";
import {
  MAX_JOBS_PER_GRANT,
  MAX_OPERATIONS_PER_GRANT,
  MAX_OPERATIONS_PER_JOB,
  MAX_RESERVATIONS_PER_JOB,
  classifyScope,
  lookupCapability,
  validateWorkflowBinding,
  validateWorkflowPayload,
  supportedWorkflowPayload,
  workflowTextForPayload,
  workflowAuthorityForOperation,
  workflowAuthorityMatchesProject,
  workflowContextKey,
  workflowPurposeForOperation,
  type WorkflowAuthority,
  type ProjectWorkflowContext,
} from "../shared/scope.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../access/checks.js";

const BLOCKED_CHANNEL_KINDS = [
  "submitContactForm",
  "sendChatMessage",
  "submitRfq",
  "vendorForm",
  "websiteChat",
  "purchase",
  "createAccount",
  "runScript",
  "browserOutreach",
];

function isCommunicationKind(kind: string): boolean {
  return kind === "communication.send" || kind === "communication.clarify";
}

function isReplyPayload(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    typeof payload["body"] === "string" &&
    /\breply\b/i.test(payload["body"])
  );
}

/**
 * Provider-effectful operations that must carry a reservation into the
 * claim: bounded collection and outbound communication consume shared
 * provider allowance. Pure reads and local record changes carry no
 * provider cost and claim without one.
 */
const REQUIRES_RESERVATION: ReadonlySet<string> = new Set([
  "research.collect",
  "communication.send",
  "communication.clarify",
]);

export function requiresReservation(kind: string): boolean {
  return REQUIRES_RESERVATION.has(kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputVersionsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Build workflow context from bounded indexed presence probes and exact
 * server-materialized refs.
 *
 * The context is deliberately derived from the project and organization
 * records, never from caller-provided terms. Requirement refs are resolved
 * only by exact indexed lookup of the request text or an authority ref
 * already carried by the grant/job chain, so unrelated row count or insertion
 * position cannot hide them.
 */
export async function projectWorkflowContext(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  text?: string,
  grantId?: Id<"grants">,
  authority?: WorkflowAuthority,
): Promise<ProjectWorkflowContext | null> {
  const project = await ctx.db.get(projectId);
  if (project === null || project.organizationId !== organizationId) return null;
  const requirementPresence = await ctx.db
    .query("requirements")
    .withIndex("by_organization_and_project", (q) =>
      q.eq("organizationId", organizationId).eq("projectId", projectId),
    )
    .take(1);
  const terms: string[] = [];
  let matchedRequirementId: Id<"requirements"> | undefined =
    authority !== undefined && "requirementId" in authority
      ? authority.requirementId
      : undefined;
  if (matchedRequirementId !== undefined) {
    const requirement = await ctx.db.get(matchedRequirementId);
    if (
      requirement === null ||
      requirement.organizationId !== organizationId ||
      requirement.projectId !== projectId ||
      requirement.state === "cancelled"
    ) {
      return null;
    }
    terms.push(requirement.key, requirement.title, requirement.category);
  }
  // Once the grant/job chain carries an exact requirement ref, request text
  // is payload data only. It must not pivot the bound context to another
  // requirement or add terms that broaden the authority.
  if (text !== undefined && matchedRequirementId === undefined) {
    const textTokens = [...new Set(text.match(/[A-Za-z0-9]+/g) ?? [])].slice(0, 24);
    const matches = new Map<Id<"requirements">, (typeof requirementPresence)[number]>();
    for (const token of textTokens) {
      const variants = [...new Set([
        token,
        token.toLocaleLowerCase(),
        token.length === 0 ? token : token.charAt(0).toLocaleUpperCase() + token.slice(1).toLocaleLowerCase(),
      ])];
      for (const variant of variants) {
        const byTitle = await ctx.db
          .query("requirements")
          .withIndex("by_organization_and_project_and_title", (q) =>
            q.eq("organizationId", organizationId).eq("projectId", projectId).eq("title", variant),
          )
          .take(2);
        for (const requirement of byTitle) matches.set(requirement._id, requirement);
        const byKey = await ctx.db
          .query("requirements")
          .withIndex("by_project_and_key", (q) =>
            q.eq("projectId", projectId).eq("key", variant),
          )
          .take(2);
        for (const requirement of byKey) matches.set(requirement._id, requirement);
      }
    }
    if (matches.size === 1) {
      const requirement = [...matches.values()][0];
      if (requirement !== undefined && requirement.state !== "cancelled") {
        matchedRequirementId = requirement._id;
        if (!terms.includes(requirement.key)) {
          terms.push(requirement.key, requirement.title, requirement.category);
        }
      }
    }
  }
  const conversationsByState = await Promise.all(
    (["draft", "queued", "awaitingReply", "replyReceived"] as const).map((state) =>
      (grantId === undefined
        ? ctx.db
            .query("conversations")
            .withIndex("by_organization_and_project_and_state", (q) =>
              q.eq("organizationId", organizationId).eq("projectId", projectId).eq("state", state),
            )
        : ctx.db
            .query("conversations")
            .withIndex("by_organization_and_project_and_grant_and_state", (q) =>
              q.eq("organizationId", organizationId)
                .eq("projectId", projectId)
                .eq("grantId", grantId)
                .eq("state", state),
            ))
        .take(2),
    ),
  );
  const conversations = conversationsByState.flat();
  const purchasingConversationIds: Id<"conversations">[] = [];
  if (
    authority !== undefined &&
    "conversationId" in authority &&
    authority.conversationId !== undefined
  ) {
    const conversation = await ctx.db.get(authority.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== organizationId ||
      conversation.projectId !== projectId ||
      (grantId !== undefined && conversation.grantId !== grantId) ||
      conversation.state === "cancelled" ||
      conversation.state === "closed"
    ) {
      return null;
    }
    purchasingConversationIds.push(conversation._id);
  }
  for (const conversation of conversations) {
    const grant = await ctx.db.get(conversation.grantId);
    if (
      grant !== null &&
      grant.organizationId === organizationId &&
      grant.projectId === projectId &&
      grant.operations.some(
        (operationId) =>
          operationId === "communication.send" || operationId === "communication.clarify",
      )
    ) {
      if (!purchasingConversationIds.includes(conversation._id)) {
        purchasingConversationIds.push(conversation._id);
      }
    }
  }
  return {
    organizationId,
    projectId,
    projectName: project.name,
    terms,
    hasStructuredContext: requirementPresence.length > 0,
    hasPurchasingThread: purchasingConversationIds.length > 0,
    ...(purchasingConversationIds.length === 1
      ? { purchasingConversationId: purchasingConversationIds[0] }
      : {}),
    ...(matchedRequirementId === undefined ? {} : { matchedRequirementId }),
  };
}

export async function validateWorkflowAuthority(
  ctx: F1MutationCtx,
  authority: WorkflowAuthority | null,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  operationId: string,
  grantId?: Id<"grants">,
): Promise<boolean> {
  if (!workflowAuthorityMatchesProject(authority, operationId, projectId)) return false;
  if (authority === null) return false;
  if ("requirementId" in authority && authority.requirementId !== undefined) {
    const requirement = await ctx.db.get(authority.requirementId);
    if (
      requirement === null ||
      requirement.organizationId !== organizationId ||
      requirement.projectId !== projectId ||
      requirement.state === "cancelled"
    ) {
      return false;
    }
  }
  if ("candidateId" in authority && authority.candidateId !== undefined) {
    const candidate = await ctx.db.get(authority.candidateId);
    if (
      candidate === null ||
      candidate.organizationId !== organizationId ||
      candidate.projectId !== projectId ||
      ("requirementId" in authority &&
        authority.requirementId !== undefined &&
        candidate.requirementId !== authority.requirementId)
    ) {
      return false;
    }
    if (!("requirementId" in authority) || authority.requirementId === undefined) {
      const candidateRequirement = await ctx.db.get(candidate.requirementId);
      if (
        candidateRequirement === null ||
        candidateRequirement.organizationId !== organizationId ||
        candidateRequirement.projectId !== projectId ||
        candidateRequirement.state === "cancelled"
      ) {
        return false;
      }
    }
  }
  if ("conversationId" in authority && authority.conversationId !== undefined) {
    const conversation = await ctx.db.get(authority.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== organizationId ||
      conversation.projectId !== projectId ||
      (conversation.state === "cancelled" || conversation.state === "closed") ||
      (grantId !== undefined && conversation.grantId !== grantId)
    ) {
      return false;
    }
  }
  return true;
}

function authorityRefsCompatible(
  parent: WorkflowAuthority,
  child: WorkflowAuthority,
): boolean {
  if (parent.operationId !== child.operationId || parent.projectId !== child.projectId) return false;
  if (
    "requirementId" in parent &&
    parent.requirementId !== undefined &&
    (!("requirementId" in child) || child.requirementId !== parent.requirementId)
  ) {
    return false;
  }
  if (
    "candidateId" in parent &&
    parent.candidateId !== undefined &&
    (!("candidateId" in child) || child.candidateId !== parent.candidateId)
  ) {
    return false;
  }
  if (
    "conversationId" in parent &&
    parent.conversationId !== undefined &&
    (!("conversationId" in child) || child.conversationId !== parent.conversationId)
  ) {
    return false;
  }
  return true;
}

function parseCanonicalPayload(payload: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch {
    return null;
  }
}

type CommunicationEnvelopeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

type CommunicationGrant = {
  readonly communicationProfile: string;
  readonly recipientConfigVersion: number;
  readonly conversationId?: Id<"conversations">;
};

function isCommunicationEnvelopeCandidate(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return workflowTextForPayload("communication.send", value) !== null ||
    "replyTo" in value ||
    "reply_to" in value;
}

async function validateCommunicationEnvelope(
  ctx: F1MutationCtx,
  payload: unknown,
  grant: CommunicationGrant,
  operationRecipientConfigVersion?: number,
): Promise<CommunicationEnvelopeResult> {
  if (grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
    return {
      ok: false,
      code: "alternate-channel-denied",
      message: "only the owner-roleplay profile is permitted",
    };
  }
  const recipient = await ctx.db
    .query("recipientConfigs")
    .withIndex("by_active", (q) => q.eq("active", true))
    .unique();
  if (recipient === null) {
    return { ok: false, code: "missing-recipient-config", message: "owner recipient is not configured" };
  }
  if (
    (operationRecipientConfigVersion !== undefined &&
      operationRecipientConfigVersion !== grant.recipientConfigVersion) ||
    grant.recipientConfigVersion !== recipient.version
  ) {
    return {
      ok: false,
      code: "stale-recipient-version",
      message: "recipient configuration changed; re-approval required",
    };
  }
  const validated = validateOutboundPayload(payload, recipient.mailboxNormalized);
  if (isCommunicationDenial(validated)) {
    return validated.code === "malicious-content"
      ? { ok: false, code: "unrelated-refusal", message: "communication payload is outside the purchasing workflow" }
      : validated;
  }
  return { ok: true };
}

/**
 * A communication grant may omit a conversation for a new RFQ. Once a grant
 * or the current project context identifies one, however, the operation must
 * carry that exact conversation. Multiple active conversations without a
 * bound authority are ambiguous and fail closed.
 */
function communicationAuthorityMatchesContext(
  grant: CommunicationGrant,
  authority: WorkflowAuthority,
  context: ProjectWorkflowContext,
): boolean {
  const authorityConversationId =
    "conversationId" in authority ? authority.conversationId : undefined;
  if (grant.conversationId !== undefined && authorityConversationId !== grant.conversationId) {
    return false;
  }
  if (
    context.purchasingConversationId !== undefined &&
    authorityConversationId !== context.purchasingConversationId
  ) {
    return false;
  }
  return !(
    context.hasPurchasingThread === true &&
    context.purchasingConversationId === undefined &&
    authorityConversationId === undefined
  );
}

function isScopeInjectionRefusal(result: { readonly verdict: string; readonly reason: string }): boolean {
  return result.reason === "supplier-evidence-instructions-cannot-expand-capabilities";
}

const createResultValidator = v.union(
  v.object({ ok: v.literal(true), operationId: v.id("operations"), deduped: v.boolean() }),
  denialValidator,
);

/**
 * Create (or deduplicate) an operation under a job. Authorization runs
 * before the idempotency lookup; deduplication additionally requires the
 * same job so keys cannot leak across jobs or projects.
 */
export const create = f1Mutation({
  args: {
    jobId: v.id("jobs"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    kind: v.string(),
    requestId: v.string(),
    payloadJson: v.string(),
    grantId: v.id("grants"),
    reservationId: v.optional(v.id("reservations")),
    negotiationId: v.optional(v.id("negotiations")),
    /**
     * Exact saved-draft authority for a negotiation send (Astra repair:
     * concurrent different-request dispatches reusing one round-0 draft).
     *
     * The orchestrator resolves the opaque draft bundle server-side and
     * passes its pins here; this mutation verifies every pin against the
     * live rows inside the same atomic transaction that inserts the
     * operation, then pins the live values as the operation's
     * `negotiationAuthority`. A stale draft (advanced round, changed quote
     * or conversation, mismatched payload) denies here with zero new
     * effect — even when the action-level pre-check raced it. The atomic
     * `claim` rechecks the pinned authority against the live rows again
     * immediately before provider effect, so two operations created from
     * one draft under different request ids serialize on the mandate round:
     * the first claim consumes it and the stale loser denies with no
     * effect. Reply drift rides the same pins: an accepted reply bumps the
     * live conversation version (or supersedes the quote), which the claim
     * recheck denies; quarantined replies never enter workloads and hold
     * the action before creation.
     */
    negotiationDraft: v.optional(v.object({
      quoteVersion: v.string(),
      quoteContentHash: v.string(),
      roundsUsed: v.number(),
      conversationVersion: v.optional(v.number()),
      conversationState: v.optional(v.string()),
      payloadHash: v.string(),
    })),
  },
  returns: createResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    if (args.requestId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "requestId required" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (BLOCKED_CHANNEL_KINDS.includes(args.kind)) {
      return { ok: false as const, code: "alternate-channel-denied", message: `channel operation ${args.kind} is never permitted` };
    }
    const capability = requireCapability(args.kind, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    const job = await ctx.db.get(args.jobId);
    if (
      job === null ||
      job.organizationId !== args.organizationId ||
      job.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    const grant = await ctx.db.get(args.grantId);
    if (
      grant === null ||
      grant.organizationId !== args.organizationId ||
      grant.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (!grant.operations.includes(args.kind)) {
      return { ok: false as const, code: "denied-capability", message: `grant does not authorize ${args.kind}` };
    }
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant is not active" };
    }
    if (isExpired(now, grant.expiresAt)) {
      return { ok: false as const, code: "expired-grant", message: "grant expired" };
    }
    // F1-23: the operation grant must equal the job grant, so revoking the
    // job grant cannot be bypassed through an alternate grant.
    if (args.grantId !== job.grantId) {
      return { ok: false as const, code: "denied-capability", message: "operation grant must match the job grant" };
    }
    const grantAuthority = workflowAuthorityForOperation(grant.workflowAuthorities, args.kind);
    if (grantAuthority === null) {
      return { ok: false as const, code: "unrelated-refusal", message: "grant has no operation-specific workflow authority" };
    }

    const parsed = parseBoundedPayloadJson(args.payloadJson);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, message: parsed.message };
    let canonical = parsed.payload.canonical;
    let hash = parsed.payload.hash;
    let operationPayload = parseCanonicalPayload(canonical);
    if (operationPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "operation payload is not valid JSON" };
    }
    const contextText =
      isRecord(operationPayload) && typeof operationPayload["query"] === "string"
        ? operationPayload["query"]
        : undefined;
    const context = await projectWorkflowContext(
      ctx,
      args.organizationId,
      args.projectId,
      contextText,
      args.grantId,
      grantAuthority,
    );
    if (context === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (
      isCommunicationKind(args.kind) &&
      isReplyPayload(operationPayload) &&
      context.purchasingConversationId === undefined
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "reply requires one exact active purchasing conversation" };
    }
    const purpose = workflowPurposeForOperation(args.kind);
    if (purpose === undefined) {
      return { ok: false as const, code: "unknown-operation", message: `operation purpose unavailable for ${args.kind}` };
    }
    if (
      job.workflowPurpose !== purpose ||
      job.workflowContext !== workflowContextKey(context, purpose)
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "job is not bound to this OpeningOS workflow purpose" };
    }

    const submittedCanonical = canonical;
    const submittedHash = hash;
    const grantPayload = parseCanonicalPayload(grant.canonicalPayload);
    if (grantPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload is not valid JSON" };
    }

    // Communication headers are checked before their body is interpreted as
    // scope text. The exception below is deliberately not granted here: it
    // also requires the exact grant payload and the authority checks that
    // follow this section.
    let operationEnvelope: CommunicationEnvelopeResult | null = null;
    if (isCommunicationKind(args.kind)) {
      if (isCommunicationEnvelopeCandidate(operationPayload)) {
        operationEnvelope = await validateCommunicationEnvelope(ctx, operationPayload, grant);
        if (!operationEnvelope.ok) {
          return { ok: false as const, code: operationEnvelope.code, message: operationEnvelope.message };
        }
      }
    }

    // Admission accepts a caller's shaped request only long enough to derive
    // its server-owned supported segment. A communication body with no
    // standalone classifier anchor is deferred until the exact grant,
    // workflow, and authority checks below have passed.
    const operationText = workflowTextForPayload(args.kind, operationPayload);
    if (operationText === null) {
      return { ok: false as const, code: "unrelated-refusal", message: "operation payload is outside the purchasing workflow" };
    }
    const operationClassification = classifyScope({
      text: operationText,
      operationId: args.kind,
      projectContext: context,
    });
    if (operationClassification.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: operationClassification.reason };
    }
    if (operationClassification.verdict === "unrelatedRefused" && !isCommunicationKind(args.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: operationClassification.reason };
    }
    if (operationClassification.verdict === "supported") {
      const supportedPayload = supportedWorkflowPayload(
        args.kind,
        operationPayload,
        operationClassification.supportedSegment,
      );
      if (supportedPayload === null) {
        return { ok: false as const, code: "invalid-payload", message: "operation payload cannot carry the supported segment" };
      }
      if (
        operationClassification.refusedSegments.length > 0 ||
        canonicalJson(supportedPayload) === grant.canonicalPayload
      ) {
        canonical = canonicalJson(supportedPayload);
        hash = payloadHash(supportedPayload);
        operationPayload = supportedPayload;
      }
    }

    const operationPurpose = validateWorkflowBinding({
      operationId: args.kind,
      jobPurpose: job.workflowPurpose,
      jobContext: job.workflowContext,
      context,
      payload: operationPayload,
    });
    if (!operationPurpose.ok && !isCommunicationKind(args.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: operationPurpose.reason ?? "operation purpose is not supported" };
    }
    const grantPurpose = validateWorkflowPayload({
      operationId: args.kind,
      purpose,
      payload: grantPayload,
      context,
    });
    if (!grantPurpose.ok && !isCommunicationKind(args.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
    }
    const grantText = workflowTextForPayload(args.kind, grantPayload);
    if (grantText === null) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload has no workflow text" };
    }
    const grantClassification = classifyScope({
      text: grantText,
      operationId: args.kind,
      projectContext: context,
    });
    if (!isCommunicationKind(args.kind) && grantClassification.verdict !== "supported") {
      return { ok: false as const, code: "unrelated-refusal", message: "grant purpose is not supported" };
    }
    if (grantClassification.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: grantClassification.reason };
    }
    if (
      operationClassification.verdict === "supported" &&
      grantClassification.verdict === "supported"
    ) {
      const supportedGrantPayload = supportedWorkflowPayload(
        args.kind,
        grantPayload,
        operationClassification.supportedSegment,
      );
      const canonicalizeSegments =
        operationClassification.refusedSegments.length > 0 ||
        grantClassification.refusedSegments.length > 0;
      // A fully supported draft is still bound to the approved segment. Only
      // mixed input compares against the canonical supported projection.
      const comparableGrantPayload = canonicalizeSegments
        ? supportedGrantPayload
        : grantPayload;
      if (
        supportedGrantPayload === null ||
        grantClassification.supportedSegment !== operationClassification.supportedSegment ||
        comparableGrantPayload === null ||
        canonicalJson(comparableGrantPayload) !== canonical
      ) {
        return { ok: false as const, code: "changed-draft", message: "operation segment does not match the approved grant" };
      }
    }
    let operationAuthority: WorkflowAuthority = grantAuthority;
    if (
      args.kind === "research.collect" &&
      context.matchedRequirementId !== undefined &&
      operationAuthority.operationId === "research.collect" &&
      operationAuthority.requirementId === undefined
    ) {
      operationAuthority = { ...operationAuthority, requirementId: context.matchedRequirementId };
    }
    if (job.workflowAuthority !== undefined) {
      if (!authorityRefsCompatible(grantAuthority, job.workflowAuthority)) {
        return { ok: false as const, code: "unrelated-refusal", message: "job authority does not match the grant" };
      }
      operationAuthority = job.workflowAuthority;
    }
    if (
      isCommunicationKind(args.kind) &&
      context.purchasingConversationId !== undefined &&
      (operationAuthority.operationId === "communication.send" ||
        operationAuthority.operationId === "communication.clarify") &&
      operationAuthority.conversationId === undefined
    ) {
      operationAuthority = { ...operationAuthority, conversationId: context.purchasingConversationId };
    }
    if (
      !authorityRefsCompatible(grantAuthority, operationAuthority) ||
      !(await validateWorkflowAuthority(
        ctx,
        operationAuthority,
        args.organizationId,
        args.projectId,
        args.kind,
        grant._id,
      ))
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "workflow authority is not current for this project" };
    }
    if (
      isCommunicationKind(args.kind) &&
      !communicationAuthorityMatchesContext(grant, operationAuthority, context)
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "communication conversation is not current for this project" };
    }

    // A no-anchor communication body may use the exception only when both
    // snapshots are exact, owner-only envelopes under the current authority.
    // Unavailable bodies and supplier-evidence instructions were rejected
    // above and can never enter this branch.
    const communicationPayloadMatchesGrant =
      isCommunicationKind(args.kind) &&
      sameCanonicalPayload(submittedCanonical, grant.canonicalPayload) &&
      submittedHash === grant.payloadHash;
    const communicationScopeException =
      isCommunicationKind(args.kind) &&
      operationEnvelope?.ok === true &&
      communicationPayloadMatchesGrant &&
      operationClassification.verdict === "unrelatedRefused" &&
      grantClassification.verdict === "unrelatedRefused" &&
      !isScopeInjectionRefusal(operationClassification) &&
      !isScopeInjectionRefusal(grantClassification);
    if (
      isCommunicationKind(args.kind) &&
      operationClassification.verdict === "unrelatedRefused" &&
      grantClassification.verdict === "unrelatedRefused" &&
      !communicationPayloadMatchesGrant
    ) {
      return { ok: false as const, code: "changed-draft", message: "operation payload does not exactly match the approved grant" };
    }
    if (!operationPurpose.ok && !communicationScopeException) {
      return { ok: false as const, code: "unrelated-refusal", message: operationPurpose.reason ?? "operation purpose is not supported" };
    }
    if (!grantPurpose.ok && !communicationScopeException) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
    }
    if (
      isCommunicationKind(args.kind) &&
      !communicationScopeException &&
      (operationClassification.verdict !== "supported" || grantClassification.verdict !== "supported")
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "communication payload is outside the purchasing workflow" };
    }
    const key = requestKey(args.organizationId, args.kind, args.requestId);
    // Same-request dedupe precedes round-limit rejection: an identical
    // retry returns the one existing operation without consuming another
    // round, while a changed payload conflicts regardless of rounds.
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .unique();
    if (existing !== null) {
      if (
        existing.jobId === args.jobId &&
        sameCanonicalPayload(existing.normalizedPayload, canonical)
      ) {
        return { ok: true as const, operationId: existing._id, deduped: true };
      }
      return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different payload" };
    }

    // Round accounting for dependent C1 follow-ups: each prepared or
    // in-flight operation consumes one round of its grant. Cancelled
    // operations free their round; terminal and ambiguous ones keep it.
    const grantOperations = await ctx.db
      .query("operations")
      .withIndex("by_grant", (q) => q.eq("grantId", args.grantId))
      .take(MAX_OPERATIONS_PER_GRANT + 1);
    if (grantOperations.length >= MAX_OPERATIONS_PER_GRANT) {
      return { ok: false as const, code: "operation-admission-limit", message: "grant operation admission limit reached" };
    }
    const roundsUsed = grantOperations.filter(
      (operation) => operation.state !== "cancelled" && operation.state !== "denied",
    ).length;
    if (roundsUsed >= grant.roundLimit) {
      return { ok: false as const, code: "round-limit-exceeded", message: "grant round limit exhausted" };
    }

    let conversationVersion: number | undefined;
    if (isCommunicationKind(args.kind)) {
      if (grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
        return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
      }
      const conversationId =
        "conversationId" in operationAuthority ? operationAuthority.conversationId : undefined;
      if (conversationId !== undefined) {
        const conversation = await ctx.db.get(conversationId);
        if (conversation !== null) conversationVersion = conversation.version;
      }
    }

    // Negotiation authority binding (Devin findings 4060796830/4060796928):
    // every pinned value is read server-side from the live rows at
    // preparation and stored immutably on the operation. An old bound
    // mandate without the approved conversation pin, a dead mandate, or a
    // stale/superseded quote cannot produce a binding; the atomic claim
    // rechecks every pin again immediately before provider effect.
    let negotiationAuthority: {
      negotiationId: Id<"negotiations">;
      quoteId: Id<"quotes">;
      quoteVersion: string;
      quoteContentHash: string;
      roundsUsed: number;
      conversationId?: Id<"conversations">;
      conversationVersion?: number;
      conversationState?: "draft" | "queued" | "awaitingReply" | "replyReceived" | "closed" | "cancelled";
    } | undefined;
    if (args.negotiationId !== undefined) {
      const negotiation = await ctx.db.get(args.negotiationId);
      if (
        negotiation === null ||
        negotiation.organizationId !== args.organizationId ||
        negotiation.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-membership", message: "negotiation mandate is not in this project" };
      }
      if (negotiation.state === "revoked") {
        return { ok: false as const, code: "mandate-revoked", message: "negotiation mandate was revoked before preparation" };
      }
      if (negotiation.state !== "active") {
        return { ok: false as const, code: "mandate-not-active", message: "negotiation mandate is not active" };
      }
      if (negotiation.expiresAt <= now) {
        return { ok: false as const, code: "mandate-expired", message: "negotiation mandate expired before preparation" };
      }
      if (negotiation.roundsUsed >= negotiation.roundLimit) {
        return { ok: false as const, code: "mandate-round-limit-reached", message: "negotiation mandate has no remaining rounds" };
      }
      const mandateQuote = await ctx.db.get(negotiation.quoteId);
      if (
        mandateQuote === null ||
        mandateQuote.organizationId !== args.organizationId ||
        mandateQuote.projectId !== args.projectId ||
        mandateQuote.version !== negotiation.quoteVersion
      ) {
        return { ok: false as const, code: "mandate-quote-stale", message: "negotiation quote is no longer the mandate's exact version" };
      }
      const successorProbe = await ctx.db
        .query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", args.projectId).eq("supersedes", mandateQuote.contentHash),
        )
        .first();
      if (successorProbe !== null) {
        return { ok: false as const, code: "mandate-quote-superseded", message: "negotiation quote version has been superseded" };
      }
      if (negotiation.conversationId !== undefined) {
        const boundConversation = await ctx.db.get(negotiation.conversationId);
        if (boundConversation === null) {
          return { ok: false as const, code: "mandate-conversation-stale", message: "bound conversation is unavailable" };
        }
        if (negotiation.conversationVersion === undefined || negotiation.conversationState === undefined) {
          return { ok: false as const, code: "mandate-approval-unpinned", message: "bound mandate lacks the approved conversation version" };
        }
        if (
          negotiation.conversationState === "closed" ||
          negotiation.conversationState === "cancelled"
        ) {
          return { ok: false as const, code: "mandate-conversation-closed", message: "bound conversation is closed or cancelled" };
        }
      }
      // Atomic saved-draft binding: the exact draft pins must equal the live
      // mandate rows inside this same transaction. A draft prepared under an
      // older round, quote version, or conversation (or carrying a different
      // payload than submitted here) denies before any operation row is
      // inserted or allowance is bound.
      if (args.negotiationDraft !== undefined) {
        const draft = args.negotiationDraft;
        if (!Number.isSafeInteger(draft.roundsUsed) || draft.roundsUsed < 0) {
          return { ok: false as const, code: "invalid-payload", message: "saved draft round is not a usable bound" };
        }
        if (
          draft.quoteVersion !== negotiation.quoteVersion ||
          draft.quoteContentHash !== mandateQuote.contentHash
        ) {
          return { ok: false as const, code: "draft-quote-stale", message: "prepared draft quote version is no longer current" };
        }
        if (draft.roundsUsed !== negotiation.roundsUsed) {
          return { ok: false as const, code: "draft-round-stale", message: "negotiation round advanced after this draft was prepared" };
        }
        const draftConversationVersion = draft.conversationVersion ?? null;
        const liveConversationVersion = negotiation.conversationVersion ?? null;
        if (draftConversationVersion !== liveConversationVersion) {
          return { ok: false as const, code: "draft-conversation-changed", message: "prepared draft conversation version is no longer current" };
        }
        const draftConversationState = draft.conversationState ?? null;
        const liveConversationState = negotiation.conversationState ?? null;
        if (draftConversationState !== liveConversationState) {
          return { ok: false as const, code: "draft-conversation-changed", message: "prepared draft conversation state is no longer current" };
        }
        if (draft.payloadHash !== hash && draft.payloadHash !== submittedHash) {
          return { ok: false as const, code: "draft-payload-mismatch", message: "prepared draft payload no longer matches its approved hash" };
        }
      }
      negotiationAuthority = {
        negotiationId: args.negotiationId,
        quoteId: negotiation.quoteId,
        quoteVersion: negotiation.quoteVersion,
        quoteContentHash: mandateQuote.contentHash,
        roundsUsed: negotiation.roundsUsed,
        ...(negotiation.conversationId === undefined ? {} : { conversationId: negotiation.conversationId }),
        ...(negotiation.conversationVersion === undefined
          ? {}
          : { conversationVersion: negotiation.conversationVersion }),
        ...(negotiation.conversationState === undefined
          ? {}
          : { conversationState: negotiation.conversationState }),
      };
    }

    let reservationRef: Id<"reservations"> | undefined;
    if (args.reservationId !== undefined) {
      const reservation = await ctx.db.get(args.reservationId);
      if (reservation === null || reservation.jobId !== args.jobId) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation does not belong to this job" };
      }
      if (reservation.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      // One-to-one binding: a reservation funds at most one live
      // operation. A second operation cannot attach to an already bound
      // reservation; it must reserve its own allowance.
      const siblings = await ctx.db
        .query("operations")
        .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
        .take(MAX_OPERATIONS_PER_JOB + 1);
      if (siblings.length >= MAX_OPERATIONS_PER_JOB) {
        return { ok: false as const, code: "operation-admission-limit", message: "job operation admission limit reached" };
      }
      const alreadyBound = siblings.some(
        (sibling) =>
          sibling.reservationId === args.reservationId &&
          sibling.state !== "cancelled" &&
          sibling.state !== "denied",
      );
      if (alreadyBound) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation is already bound to another operation" };
      }
      reservationRef = args.reservationId;
    }

    const payloadSha256 = await sha256HexOfCanonical(canonical);
    const operationId = await ctx.db.insert("operations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      jobId: args.jobId,
      kind: args.kind,
      requestId: args.requestId,
      requestKey: key,
      normalizedPayload: canonical,
      normalizedPayloadHash: hash,
      payloadSha256,
      inputVersions: { ...grant.inputVersions },
      grantId: args.grantId,
      grantVersion: grant.revocationVersion,
      ...(isCommunicationKind(args.kind)
        ? { recipientConfigVersion: grant.recipientConfigVersion }
        : {}),
      ...(conversationVersion === undefined ? {} : { conversationVersion }),
      workflowAuthority: operationAuthority,
      ...(negotiationAuthority === undefined ? {} : { negotiationAuthority }),
      state: "prepared",
      ...(reservationRef === undefined ? {} : { reservationId: reservationRef }),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, operationId, deduped: false };
  },
});

const claimResultValidator = v.union(
  v.object({ ok: v.literal(true), operationId: v.id("operations"), attemptToken: v.string() }),
  denialValidator,
);

/**
 * Internal atomic dispatch claim: recheck everything, then mint one
 * attempt token. Callable only from server-side dispatch, never browsers.
 */
export const claim = f1InternalMutation({
  args: { operationId: v.id("operations"), identity: v.string() },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.state !== "prepared") {
      if (operation.state === "cancelled") {
        return { ok: false as const, code: "cancelled-before-claim", message: "operation was cancelled before claim" };
      }
      return { ok: false as const, code: "already-claimed", message: `operation is already ${operation.state}` };
    }
    const job = await ctx.db.get(operation.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    }
    if (BLOCKED_CHANNEL_KINDS.includes(operation.kind)) {
      return { ok: false as const, code: "alternate-channel-denied", message: `channel operation ${operation.kind} is never permitted` };
    }
    const entry = lookupCapability(operation.kind);
    if (entry === undefined) {
      return { ok: false as const, code: "unknown-operation", message: `unknown operation ${operation.kind}` };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      entry.requiredRole,
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability(operation.kind, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }

    const grant = await ctx.db.get(operation.grantId);
    if (grant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (grant.organizationId !== operation.organizationId || grant.projectId !== operation.projectId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (!grant.operations.includes(operation.kind)) {
      return { ok: false as const, code: "denied-capability", message: `grant does not authorize ${operation.kind}` };
    }
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant was revoked" };
    }
    if (grant.revocationVersion !== operation.grantVersion) {
      return { ok: false as const, code: "stale-grant-version", message: "grant was re-issued after this operation was prepared" };
    }
    if (isExpired(now, grant.expiresAt)) {
      return { ok: false as const, code: "grant-expired-at-claim", message: "grant expired before claim" };
    }
    // F1-23: the operation grant must still equal the job grant; an
    // operation prepared under an alternate grant cannot outlive the
    // job grant's revocation.
    if (operation.grantId !== job.grantId || operation.grantId !== grant._id) {
      return { ok: false as const, code: "denied-capability", message: "operation grant must match the job grant" };
    }

    const operationPayload = parseCanonicalPayload(operation.normalizedPayload);
    if (operationPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "operation payload is not valid JSON" };
    }
    const grantPayload = parseCanonicalPayload(grant.canonicalPayload);
    if (grantPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload is not valid JSON" };
    }
    const contextText =
      isRecord(operationPayload) && typeof operationPayload["query"] === "string"
        ? operationPayload["query"]
        : undefined;
    const context = await projectWorkflowContext(
      ctx,
      operation.organizationId,
      operation.projectId,
      contextText,
      grant._id,
      operation.workflowAuthority,
    );
    if (context === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (
      isCommunicationKind(operation.kind) &&
      isReplyPayload(operationPayload) &&
      context.purchasingConversationId === undefined
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "reply requires one exact active purchasing conversation" };
    }
    const operationText = workflowTextForPayload(operation.kind, operationPayload);
    if (operationText === null) {
      return { ok: false as const, code: "unrelated-refusal", message: "operation payload is outside the purchasing workflow" };
    }
    const operationClassification = classifyScope({
      text: operationText,
      operationId: operation.kind,
      projectContext: context,
    });
    if (operationClassification.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: operationClassification.reason };
    }
    if (operationClassification.verdict === "unrelatedRefused" && !isCommunicationKind(operation.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: operationClassification.reason };
    }
    if (operationClassification.verdict === "supported") {
      const expectedOperationPayload = supportedWorkflowPayload(
        operation.kind,
        operationPayload,
        operationClassification.supportedSegment,
      );
      if (
        expectedOperationPayload === null ||
        (operationClassification.refusedSegments.length > 0 &&
          canonicalJson(expectedOperationPayload) !== operation.normalizedPayload)
      ) {
        return { ok: false as const, code: "unrelated-refusal", message: "operation payload is not the canonical supported segment" };
      }
    }
    const grantAuthority = workflowAuthorityForOperation(grant.workflowAuthorities, operation.kind);
    if (grantAuthority === null || operation.workflowAuthority === undefined) {
      return { ok: false as const, code: "unrelated-refusal", message: "operation authority is unavailable" };
    }
    if (
      !authorityRefsCompatible(grantAuthority, operation.workflowAuthority) ||
      (job.workflowAuthority !== undefined &&
        canonicalJson(job.workflowAuthority) !== canonicalJson(operation.workflowAuthority) &&
        !(isCommunicationKind(operation.kind) &&
          authorityRefsCompatible(job.workflowAuthority, operation.workflowAuthority) &&
          (!("conversationId" in job.workflowAuthority) ||
            job.workflowAuthority.conversationId === undefined) &&
          "conversationId" in operation.workflowAuthority &&
          operation.workflowAuthority.conversationId !== undefined)) ||
      !(await validateWorkflowAuthority(
        ctx,
        operation.workflowAuthority,
        operation.organizationId,
        operation.projectId,
        operation.kind,
        grant._id,
      ))
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "operation authority is not current for this project" };
    }
    if (
      isCommunicationKind(operation.kind) &&
      !communicationAuthorityMatchesContext(grant, operation.workflowAuthority, context)
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "communication conversation is not current for this project" };
    }
    const purpose = validateWorkflowBinding({
      operationId: operation.kind,
      context,
      payload: operationPayload,
      ...(job.workflowPurpose === undefined ? {} : { jobPurpose: job.workflowPurpose }),
      ...(job.workflowContext === undefined ? {} : { jobContext: job.workflowContext }),
    });
    if (!purpose.ok && !isCommunicationKind(operation.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: purpose.reason ?? "job purpose is not supported" };
    }
    const grantPurpose = validateWorkflowPayload({
      operationId: operation.kind,
      purpose: workflowPurposeForOperation(operation.kind) ?? "purchasingResearch",
      payload: grantPayload,
      context,
    });
    if (!grantPurpose.ok && !isCommunicationKind(operation.kind)) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
    }
    const grantText = workflowTextForPayload(operation.kind, grantPayload);
    if (grantText === null) {
      return { ok: false as const, code: "unrelated-refusal", message: "grant payload is outside the purchasing workflow" };
    }
    const grantClassification = classifyScope({
      text: grantText,
      operationId: operation.kind,
      projectContext: context,
    });
    if (!isCommunicationKind(operation.kind) && grantClassification.verdict !== "supported") {
      return { ok: false as const, code: "unrelated-refusal", message: "grant purpose is not supported" };
    }
    if (grantClassification.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: grantClassification.reason };
    }
    if (
      operationClassification.verdict === "supported" &&
      grantClassification.verdict === "supported"
    ) {
      const expectedGrantPayload = supportedWorkflowPayload(
        operation.kind,
        grantPayload,
        operationClassification.supportedSegment,
      );
      if (
        expectedGrantPayload === null ||
        grantClassification.supportedSegment !== operationClassification.supportedSegment ||
        ((operationClassification.refusedSegments.length > 0 ||
          grantClassification.refusedSegments.length > 0) &&
          canonicalJson(expectedGrantPayload) !== grant.canonicalPayload) ||
        grant.canonicalPayload !== operation.normalizedPayload
      ) {
        return { ok: false as const, code: "changed-draft", message: "operation segment no longer matches the approved grant" };
      }
    }
    // F1-22: compare the operation's captured versions against current
    // authority. Coordinated job/grant advancement still stales prepared
    // operations; equality of job and grant alone is insufficient.
    if (
      !inputVersionsEqual(operation.inputVersions, grant.inputVersions) ||
      !inputVersionsEqual(job.inputVersions, grant.inputVersions)
    ) {
      return { ok: false as const, code: "stale-input-version", message: "prepared inputs no longer match the current grant" };
    }
    // The grant cost ceiling binds the claim grant-wide (F1R-01): the
    // running reservation total across every job bound to this grant
    // must still fit inside what the grant authorizes.
    const grantJobs = await ctx.db
      .query("jobs")
      .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
      .take(MAX_JOBS_PER_GRANT + 1);
    if (grantJobs.length > MAX_JOBS_PER_GRANT) {
      return { ok: false as const, code: "grant-accounting-limit", message: "grant exposure exceeds the bounded accounting contract" };
    }
    let grantCommitted = 0;
    for (const grantJob of grantJobs) {
      const grantJobReservations = await ctx.db
        .query("reservations")
        .withIndex("by_job", (q) => q.eq("jobId", grantJob._id))
        .take(MAX_RESERVATIONS_PER_JOB + 1);
      if (grantJobReservations.length > MAX_RESERVATIONS_PER_JOB) {
        return { ok: false as const, code: "grant-accounting-limit", message: "grant exposure exceeds the bounded accounting contract" };
      }
      for (const reservation of grantJobReservations) {
        grantCommitted +=
          reservation.reservedMicroUsd + reservation.spentMicroUsd + reservation.unresolvedMicroUsd;
      }
    }
    if (grantCommitted > grant.costCeilingMicroUsd) {
      return { ok: false as const, code: "grant-ceiling-exceeded", message: "grant-wide reservations exceed the grant cost ceiling" };
    }

    // Communication envelope first: header injections receive their precise
    // typed denial before the draft comparison.
    if (isCommunicationKind(operation.kind)) {
      const envelope = await validateCommunicationEnvelope(
        ctx,
        operationPayload,
        grant,
        operation.recipientConfigVersion,
      );
      if (!envelope.ok) {
        return { ok: false as const, code: envelope.code, message: envelope.message };
      }
    }

    const communicationScopeException =
      isCommunicationKind(operation.kind) &&
      sameCanonicalPayload(operation.normalizedPayload, grant.canonicalPayload) &&
      operation.normalizedPayloadHash === grant.payloadHash &&
      operationClassification.verdict === "unrelatedRefused" &&
      grantClassification.verdict === "unrelatedRefused" &&
      !isScopeInjectionRefusal(operationClassification) &&
      !isScopeInjectionRefusal(grantClassification);

    // Compare the immutable snapshots before allowing the communication
    // exception. A changed normalized payload is never rescued by a body
    // that happens to be a valid owner-only envelope.
    if (!sameCanonicalPayload(operation.normalizedPayload, grant.canonicalPayload)) {
      return { ok: false as const, code: "changed-draft", message: "approved draft changed after this operation was prepared" };
    }
    if (isCommunicationKind(operation.kind) && operation.normalizedPayloadHash !== grant.payloadHash) {
      return { ok: false as const, code: "changed-draft", message: "approved draft hash changed after this operation was prepared" };
    }
    if (!sha256BindingOk(operation.payloadSha256, grant.payloadSha256)) {
      return { ok: false as const, code: "changed-draft", message: "payload digest no longer matches the approved draft" };
    }
    if (!purpose.ok && !communicationScopeException) {
      return { ok: false as const, code: "unrelated-refusal", message: purpose.reason ?? "job purpose is not supported" };
    }
    if (!grantPurpose.ok && !communicationScopeException) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
    }
    if (
      isCommunicationKind(operation.kind) &&
      !communicationScopeException &&
      (operationClassification.verdict !== "supported" || grantClassification.verdict !== "supported")
    ) {
      return { ok: false as const, code: "unrelated-refusal", message: "communication payload is outside the purchasing workflow" };
    }

    if (operation.conversationVersion !== undefined) {
      const conversationId =
        "conversationId" in operation.workflowAuthority
          ? operation.workflowAuthority.conversationId
          : undefined;
      if (conversationId !== undefined) {
        const conversation = await ctx.db.get(conversationId);
        if (conversation !== null && conversation.version !== operation.conversationVersion) {
          return { ok: false as const, code: "relevant-reply-superseded", message: "a relevant reply arrived after this operation was prepared" };
        }
        if (conversation !== null && conversation.state === "cancelled") {
          return { ok: false as const, code: "cancelled-before-claim", message: "conversation was cancelled before claim" };
        }
      }
    }

    // F1-24: recheck the full reservation relationship, not just its
    // open state. A reservation from another job, organization, budget,
    // or grant cannot fund this claim, and one reservation never funds
    // two live operations.
    if (operation.reservationId === undefined) {
      // Reservation is mandatory for every paid/effectful claim: a
      // provider-effectful operation reaches dispatch only with bound
      // allowance. Pure reads and local record changes claim without one.
      if (REQUIRES_RESERVATION.has(operation.kind)) {
        return { ok: false as const, code: "allowance-exhausted", message: "operation requires a reservation before claim" };
      }
    } else {
      const reservation = await ctx.db.get(operation.reservationId);
      if (reservation === null || reservation.state !== "open") {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation is not available" };
      }
      if (reservation.jobId !== operation.jobId) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation does not belong to this job" };
      }
      if (reservation.organizationId !== operation.organizationId) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      const budget = await ctx.db.get(reservation.budgetId);
      if (budget === null || budget.organizationId !== operation.organizationId) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      const reservationJob = await ctx.db.get(reservation.jobId);
      if (reservationJob === null || reservationJob.grantId !== operation.grantId) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation grant does not match the operation grant" };
      }
      const jobOperations = await ctx.db
        .query("operations")
        .withIndex("by_job", (q) => q.eq("jobId", operation.jobId))
        .take(MAX_OPERATIONS_PER_JOB + 1);
      if (jobOperations.length > MAX_OPERATIONS_PER_JOB) {
        return { ok: false as const, code: "operation-admission-limit", message: "job operation history exceeds the bounded contract" };
      }
      const doubleBound = jobOperations.some(
        (sibling) =>
          sibling._id !== operation._id &&
          sibling.reservationId === operation.reservationId &&
          sibling.state !== "cancelled" &&
          sibling.state !== "denied",
      );
      if (doubleBound) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation is already bound to another operation" };
      }
    }

    // Negotiation authority recheck (Devin findings 4060796830/4060796928):
    // runs inside the same atomic mutation that consumes the unique mandate
    // round and mints the attempt token, immediately before provider effect.
    // A revoked, expired, superseded, reply-changed, or round-moved mandate
    // denies the claim with zero provider transport, and the prepared
    // operation stays intact.
    let negotiationRoundConsumed = false;
    if (operation.negotiationAuthority !== undefined) {
      const authority = operation.negotiationAuthority;
      const negotiation = await ctx.db.get(authority.negotiationId);
      if (
        negotiation === null ||
        negotiation.organizationId !== operation.organizationId ||
        negotiation.projectId !== operation.projectId ||
        negotiation.quoteId !== authority.quoteId ||
        negotiation.quoteVersion !== authority.quoteVersion
      ) {
        return { ok: false as const, code: "mandate-not-current", message: "negotiation mandate is not current for this operation" };
      }
      if (negotiation.state === "revoked") {
        return { ok: false as const, code: "mandate-revoked", message: "negotiation mandate was revoked after preparation" };
      }
      if (negotiation.state === "concluded") {
        return { ok: false as const, code: "mandate-concluded", message: "negotiation mandate concluded after preparation" };
      }
      if (negotiation.state === "paused") {
        return { ok: false as const, code: "mandate-paused", message: "negotiation mandate is paused" };
      }
      if (negotiation.state !== "active") {
        return { ok: false as const, code: "mandate-not-active", message: "negotiation mandate is not active" };
      }
      if (negotiation.expiresAt <= now) {
        return { ok: false as const, code: "mandate-expired", message: "negotiation mandate expired after preparation" };
      }
      if (negotiation.roundsUsed >= negotiation.roundLimit) {
        return { ok: false as const, code: "mandate-round-limit-reached", message: "negotiation mandate has no remaining rounds" };
      }
      if (negotiation.roundsUsed !== authority.roundsUsed) {
        return { ok: false as const, code: "mandate-round-changed", message: "negotiation round advanced after this operation was prepared" };
      }
      const mandateQuote = await ctx.db.get(authority.quoteId);
      if (
        mandateQuote === null ||
        mandateQuote.organizationId !== operation.organizationId ||
        mandateQuote.projectId !== operation.projectId
      ) {
        return { ok: false as const, code: "mandate-quote-stale", message: "negotiation quote is unavailable for this project" };
      }
      if (mandateQuote.version !== authority.quoteVersion || mandateQuote.contentHash !== authority.quoteContentHash) {
        return { ok: false as const, code: "mandate-quote-changed", message: "negotiation quote changed after preparation" };
      }
      const quoteSuccessor = await ctx.db
        .query("quotes")
        .withIndex("by_project_and_supersedes", (q) =>
          q.eq("projectId", operation.projectId).eq("supersedes", mandateQuote.contentHash),
        )
        .first();
      if (quoteSuccessor !== null) {
        return { ok: false as const, code: "mandate-quote-superseded", message: "negotiation quote version has been superseded" };
      }
      const boundConversationId = authority.conversationId;
      if (boundConversationId !== undefined) {
        if (authority.conversationVersion === undefined || authority.conversationState === undefined) {
          // An old bound mandate without the approved conversation pins has
          // no current approval basis; it stays fail-closed until an
          // explicit reply-incorporation transition exists.
          return { ok: false as const, code: "mandate-approval-unpinned", message: "bound mandate lacks the approved conversation version" };
        }
        const boundConversation = await ctx.db.get(boundConversationId);
        if (
          boundConversation === null ||
          boundConversation.organizationId !== operation.organizationId ||
          boundConversation.projectId !== operation.projectId
        ) {
          return { ok: false as const, code: "mandate-conversation-stale", message: "bound conversation is unavailable" };
        }
        if (boundConversation.state === "closed" || boundConversation.state === "cancelled") {
          return { ok: false as const, code: "mandate-conversation-closed", message: "bound conversation is closed or cancelled" };
        }
        if (
          boundConversation.version !== authority.conversationVersion ||
          boundConversation.state !== authority.conversationState
        ) {
          // Covers both version drift (a recorded reply ingested by the
          // callback) and same-version state drift until an explicit
          // reply-incorporation transition exists.
          return { ok: false as const, code: "mandate-conversation-changed", message: "bound conversation changed after mandate approval" };
        }
      }
      await ctx.db.patch(authority.negotiationId, {
        roundsUsed: negotiation.roundsUsed + 1,
        updatedAt: now,
      });
      negotiationRoundConsumed = true;
    }

    const token = crypto.randomUUID();
    await ctx.db.patch(args.operationId, {
      state: "dispatching",
      attemptToken: token,
      ...(negotiationRoundConsumed
        ? { negotiationRoundConsumed: true, negotiationRoundRefunded: false }
        : {}),
      updatedAt: now,
    });
    await ctx.db.insert("attempts", {
      operationId: args.operationId,
      token,
      state: "dispatching",
      createdAt: now,
    });
    return { ok: true as const, operationId: args.operationId, attemptToken: token };
  },
});

/** Read one authorized operation (no authority granted by reading). */
export const get = f1Query({
  args: { operationId: v.id("operations") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      state: v.string(),
      kind: v.string(),
      requestId: v.string(),
      dedupKey: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      operation.organizationId,
      operation.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return {
      ok: true as const,
      state: operation.state,
      kind: operation.kind,
      requestId: operation.requestId,
      dedupKey: operation.requestKey,
    };
  },
});

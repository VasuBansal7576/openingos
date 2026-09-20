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
import { canonicalJson, parseBoundedPayloadJson, requestKey } from "../shared/hashing.js";
import { normalizeMailbox } from "../shared/mailbox.js";
import { sameCanonicalPayload, sha256BindingOk, sha256HexOfCanonical } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";
import {
  MAX_JOBS_PER_GRANT,
  MAX_OPERATIONS_PER_GRANT,
  MAX_OPERATIONS_PER_JOB,
  MAX_RESERVATIONS_PER_JOB,
  lookupCapability,
  validateWorkflowBinding,
  validateWorkflowPayload,
  workflowContextKey,
  workflowPurposeForOperation,
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

const PROJECT_CONTEXT_REQUIREMENT_LIMIT = 32;
const PROJECT_CONTEXT_CONVERSATION_LIMIT = 32;

/**
 * Build bounded workflow context from the newest server-owned project rows.
 *
 * The context is deliberately derived from the project and organization
 * records, never from caller-provided terms.  Descending creation order keeps
 * a newly qualifying requirement or conversation visible even when a project
 * has more than the bounded context window of older rows.
 */
export async function projectWorkflowContext(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
): Promise<ProjectWorkflowContext | null> {
  const project = await ctx.db.get(projectId);
  if (project === null || project.organizationId !== organizationId) return null;
  const requirements = await ctx.db
    .query("requirements")
    .withIndex("by_organization_and_project", (q) =>
      q.eq("organizationId", organizationId).eq("projectId", projectId),
    )
    .order("desc")
    .take(PROJECT_CONTEXT_REQUIREMENT_LIMIT);
  const terms = requirements.flatMap((requirement) => [
    requirement.key,
    requirement.title,
    requirement.category,
  ]);
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_organization_and_project", (q) =>
      q.eq("organizationId", organizationId).eq("projectId", projectId),
    )
    .order("desc")
    .take(PROJECT_CONTEXT_CONVERSATION_LIMIT);
  let hasPurchasingThread = false;
  for (const conversation of conversations) {
    if (conversation.state === "cancelled") continue;
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
      hasPurchasingThread = true;
      break;
    }
  }
  return {
    organizationId,
    projectId,
    projectName: project.name,
    terms,
    hasStructuredContext: requirements.length > 0,
    hasPurchasingThread,
  };
}

function parseCanonicalPayload(payload: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch {
    return null;
  }
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

    const context = await projectWorkflowContext(ctx, args.organizationId, args.projectId);
    if (context === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
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

    const parsed = parseBoundedPayloadJson(args.payloadJson);
    if (!parsed.ok) return { ok: false as const, code: parsed.code, message: parsed.message };
    const canonical = parsed.payload.canonical;
    const hash = parsed.payload.hash;
    const operationPayload = parseCanonicalPayload(canonical);
    if (operationPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "operation payload is not valid JSON" };
    }
    const operationPurpose = validateWorkflowBinding({
      operationId: args.kind,
      jobPurpose: job.workflowPurpose,
      jobContext: job.workflowContext,
      context,
      payload: operationPayload,
    });
    if (!operationPurpose.ok) {
      return { ok: false as const, code: "unrelated-refusal", message: operationPurpose.reason ?? "operation purpose is not supported" };
    }
    const grantPayload = parseCanonicalPayload(grant.canonicalPayload);
    if (grantPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload is not valid JSON" };
    }
    const grantPurpose = validateWorkflowPayload({
      operationId: args.kind,
      purpose,
      payload: grantPayload,
      context,
    });
    if (!grantPurpose.ok) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
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
      if (grant.conversationId !== undefined) {
        const conversation = await ctx.db.get(grant.conversationId);
        if (conversation !== null) conversationVersion = conversation.version;
      }
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

    const context = await projectWorkflowContext(ctx, operation.organizationId, operation.projectId);
    if (context === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const operationPayload = parseCanonicalPayload(operation.normalizedPayload);
    if (operationPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "operation payload is not valid JSON" };
    }
    const purpose = validateWorkflowBinding({
      operationId: operation.kind,
      context,
      payload: operationPayload,
      ...(job.workflowPurpose === undefined ? {} : { jobPurpose: job.workflowPurpose }),
      ...(job.workflowContext === undefined ? {} : { jobContext: job.workflowContext }),
    });
    if (!purpose.ok) {
      return { ok: false as const, code: "unrelated-refusal", message: purpose.reason ?? "job purpose is not supported" };
    }
    const grantPayload = parseCanonicalPayload(grant.canonicalPayload);
    if (grantPayload === null) {
      return { ok: false as const, code: "invalid-payload", message: "grant payload is not valid JSON" };
    }
    const grantPurpose = validateWorkflowPayload({
      operationId: operation.kind,
      purpose: workflowPurposeForOperation(operation.kind) ?? "purchasingResearch",
      payload: grantPayload,
      context,
    });
    if (!grantPurpose.ok) {
      return { ok: false as const, code: "unrelated-refusal", message: grantPurpose.reason ?? "grant purpose is not supported" };
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

    const storedPayload = operation.normalizedPayload;

    // Communication envelope first: header injections receive their precise
    // typed denial before the draft comparison.
    if (isCommunicationKind(operation.kind)) {
      const recipient = await ctx.db
        .query("recipientConfigs")
        .withIndex("by_active", (q) => q.eq("active", true))
        .unique();
      if (recipient === null) {
        return { ok: false as const, code: "missing-recipient-config", message: "owner recipient is not configured" };
      }
      if (
        operation.recipientConfigVersion !== grant.recipientConfigVersion ||
        grant.recipientConfigVersion !== recipient.version
      ) {
        return { ok: false as const, code: "stale-recipient-version", message: "recipient configuration changed; re-approval required" };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(storedPayload);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "communication payload is not valid JSON" };
      }
      if (!isRecord(parsed)) {
        return { ok: false as const, code: "invalid-payload", message: "communication payload must be an object" };
      }
      const to = typeof parsed["to"] === "string" ? normalizeMailbox(parsed["to"]) : "";
      const cc = Array.isArray(parsed["cc"]) ? parsed["cc"] : null;
      const bcc = Array.isArray(parsed["bcc"]) ? parsed["bcc"] : null;
      if (to !== recipient.mailboxNormalized) {
        return { ok: false as const, code: "recipient-mismatch", message: "recipient is not the configured owner mailbox" };
      }
      if (cc === null || cc.length !== 0) {
        return { ok: false as const, code: "cc-not-empty", message: "CC must remain empty" };
      }
      if (bcc === null || bcc.length !== 0) {
        return { ok: false as const, code: "bcc-not-empty", message: "BCC must remain empty" };
      }
      if (parsed["replyTo"] !== undefined) {
        return { ok: false as const, code: "reply-to-redirect", message: "Reply-To redirection is denied" };
      }
      if (parsed["profile"] !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
        return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
      }
    }

    if (!sameCanonicalPayload(storedPayload, grant.canonicalPayload)) {
      return { ok: false as const, code: "changed-draft", message: "approved draft changed after this operation was prepared" };
    }
    if (!sha256BindingOk(operation.payloadSha256, grant.payloadSha256)) {
      return { ok: false as const, code: "changed-draft", message: "payload digest no longer matches the approved draft" };
    }

    if (operation.conversationVersion !== undefined) {
      if (grant.conversationId !== undefined) {
        const conversation = await ctx.db.get(grant.conversationId);
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

    const token = crypto.randomUUID();
    await ctx.db.patch(args.operationId, {
      state: "dispatching",
      attemptToken: token,
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

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
import { f1InternalMutation, f1Mutation, f1Query } from "../server.js";
import { canonicalJson, normalizeMailbox, payloadHash, requestKey } from "../shared/hashing.js";
import { sameCanonicalPayload, sha256BindingOk } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";
import { lookupCapability } from "../shared/scope.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputVersionsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
    payload: v.any(),
    payloadSha256: v.optional(v.string()),
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
    if (job.state === "cancelled") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is cancelled" };
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

    const key = requestKey(args.organizationId, args.kind, args.requestId);
    const canonical = canonicalJson(args.payload);
    const hash = payloadHash(args.payload);
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .unique();
    if (existing !== null) {
      if (
        existing.jobId === args.jobId &&
        sameCanonicalPayload(existing.normalizedPayload, canonical) &&
        sha256BindingOk(existing.payloadSha256, args.payloadSha256)
      ) {
        return { ok: true as const, operationId: existing._id, deduped: true };
      }
      return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different payload" };
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
      reservationRef = args.reservationId;
    }

    const operationId = await ctx.db.insert("operations", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      jobId: args.jobId,
      kind: args.kind,
      requestId: args.requestId,
      requestKey: key,
      normalizedPayload: canonical,
      normalizedPayloadHash: hash,
      ...(args.payloadSha256 === undefined ? {} : { payloadSha256: args.payloadSha256 }),
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
    if (job.state === "cancelled") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is cancelled" };
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
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant was revoked" };
    }
    if (grant.revocationVersion !== operation.grantVersion) {
      return { ok: false as const, code: "stale-grant-version", message: "grant was re-issued after this operation was prepared" };
    }
    if (isExpired(now, grant.expiresAt)) {
      return { ok: false as const, code: "grant-expired-at-claim", message: "grant expired before claim" };
    }
    if (!inputVersionsEqual(job.inputVersions, grant.inputVersions)) {
      return { ok: false as const, code: "stale-input-version", message: "job inputs no longer match the current grant" };
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

    if (operation.reservationId !== undefined) {
      const reservation = await ctx.db.get(operation.reservationId);
      if (reservation === null || reservation.state !== "open") {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation is not available" };
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

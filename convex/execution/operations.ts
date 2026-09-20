/**
 * F1 idempotent operations and atomic dispatch claims (controlled contract).
 *
 * Duplicate `requestId` with an identical canonical payload returns the one
 * existing operation; a changed payload conflicts and creates no provider
 * call. The claim rechecks cancellation, access, grant, input versions,
 * approved payload, recipient version, and reservation atomically and mints
 * a single-use attempt token. Any denial leaves zero new effect.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
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

const createResultValidator = v.union(
  v.object({ ok: v.literal(true), operationId: v.string(), deduped: v.boolean() }),
  denialValidator,
);

/** Create (or deduplicate) an operation under a job. */
export const create = mutation({
  args: {
    jobId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    kind: v.string(),
    requestId: v.string(),
    payload: v.any(),
    payloadSha256: v.optional(v.string()),
    grantId: v.string(),
    reservationId: v.optional(v.string()),
    now: v.number(),
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
    const job = (await ctx.db.get(args.jobId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      state?: string;
    } | null;
    if (!job || job.organizationId !== args.organizationId || job.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "job is not in this project" };
    }
    const key = requestKey(args.organizationId, args.kind, args.requestId);
    const canonical = canonicalJson(args.payload);
    const hash = payloadHash(args.payload);

    const existing = (await ctx.db
      .query("operations")
      .filter((q) => q.eq(q.field("requestKey"), key))
      .unique()) as unknown as {
      _id: string;
      canonicalPayload?: string;
      normalizedPayload?: string;
      payloadSha256?: string;
    } | null;
    if (existing) {
      const stored = existing.normalizedPayload ?? existing.canonicalPayload ?? "";
      if (
        sameCanonicalPayload(stored, canonical) &&
        sha256BindingOk(existing.payloadSha256, args.payloadSha256)
      ) {
        return { ok: true as const, operationId: existing._id, deduped: true };
      }
      return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different payload" };
    }

    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (BLOCKED_CHANNEL_KINDS.includes(args.kind)) {
      return { ok: false as const, code: "alternate-channel-denied", message: `channel operation ${args.kind} is never permitted` };
    }
    const capability = requireCapability(args.kind, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    if (job.state === "cancelled") {
      return { ok: false as const, code: "cancelled-before-claim", message: "job is cancelled" };
    }
    const grant = (await ctx.db.get(args.grantId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      operations?: string[];
      status?: string;
      expiresAt?: number;
      revocationVersion?: number;
      communicationProfile?: string;
      recipientConfigVersion?: number;
      conversationId?: string;
    } | null;
    if (!grant || grant.organizationId !== args.organizationId || grant.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "grant is not in this project" };
    }
    if (!(grant.operations ?? []).includes(args.kind)) {
      return { ok: false as const, code: "denied-capability", message: `grant does not authorize ${args.kind}` };
    }
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant is not active" };
    }
    if (grant.expiresAt !== undefined && isExpired(args.now, grant.expiresAt)) {
      return { ok: false as const, code: "expired-grant", message: "grant expired" };
    }

    let conversationVersion: number | undefined;
    if (isCommunicationKind(args.kind)) {
      if (grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
        return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
      }
      if (grant.conversationId !== undefined) {
        const conversation = (await ctx.db.get(grant.conversationId as never)) as unknown as {
          version?: number;
        } | null;
        if (conversation?.version !== undefined) conversationVersion = conversation.version;
      }
    }

    let reservationRef: string | undefined;
    if (args.reservationId !== undefined) {
      const reservation = (await ctx.db.get(args.reservationId as never)) as unknown as {
        jobId?: string;
      } | null;
      if (!reservation || String(reservation.jobId) !== String(args.jobId)) {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation does not belong to this job" };
      }
      reservationRef = args.reservationId;
    }

    const grantVersion = grant.revocationVersion ?? 1;
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
      inputVersions: {},
      grantId: args.grantId,
      grantVersion,
      ...(isCommunicationKind(args.kind)
        ? { recipientConfigVersion: grant.recipientConfigVersion ?? 0 }
        : {}),
      ...(conversationVersion === undefined ? {} : { conversationVersion }),
      state: "prepared",
      ...(reservationRef === undefined ? {} : { reservationId: reservationRef as never }),
      createdAt: args.now,
      updatedAt: args.now,
    });
    return { ok: true as const, operationId: operationId as unknown as string, deduped: false };
  },
});

const claimResultValidator = v.union(
  v.object({ ok: v.literal(true), operationId: v.string(), attemptToken: v.string() }),
  denialValidator,
);

/** Atomic dispatch claim: recheck everything, then mint one attempt token. */
export const claim = mutation({
  args: { operationId: v.string(), now: v.number() },
  returns: claimResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const operation = (await ctx.db.get(args.operationId as never)) as unknown as {
      _id: string;
      organizationId: string;
      projectId: string;
      jobId: string;
      kind: string;
      state: string;
      normalizedPayload?: string;
      canonicalPayload?: string;
      payloadSha256?: string;
      grantId: string;
      grantVersion: number;
      recipientConfigVersion?: number;
      conversationVersion?: number;
      reservationId?: string;
    } | null;
    if (!operation) return { ok: false as const, code: "denied-project", message: "unknown operation" };
    if (operation.state !== "prepared") {
      if (operation.state === "cancelled") {
        return { ok: false as const, code: "cancelled-before-claim", message: "operation was cancelled before claim" };
      }
      return { ok: false as const, code: "already-claimed", message: `operation is already ${operation.state}` };
    }
    const job = (await ctx.db.get(operation.jobId as never)) as unknown as {
      state?: string;
      inputVersions?: Record<string, string>;
    } | null;
    if (!job) return { ok: false as const, code: "denied-project", message: "unknown job" };
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
      identity,
      operation.organizationId,
      operation.projectId,
      entry.requiredRole,
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability(operation.kind, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }

    const grant = (await ctx.db.get(operation.grantId as never)) as unknown as {
      status?: string;
      revocationVersion?: number;
      expiresAt?: number;
      inputVersions?: Record<string, string>;
      canonicalPayload?: string;
      payloadSha256?: string;
      communicationProfile?: string;
      recipientConfigVersion?: number;
      conversationId?: string;
    } | null;
    if (!grant) return { ok: false as const, code: "denied-project", message: "unknown grant" };
    if (grant.status !== "active") {
      return { ok: false as const, code: "revoked-grant", message: "grant was revoked" };
    }
    if ((grant.revocationVersion ?? 1) !== operation.grantVersion) {
      return { ok: false as const, code: "stale-grant-version", message: "grant was re-issued after this operation was prepared" };
    }
    if (grant.expiresAt !== undefined && isExpired(args.now, grant.expiresAt)) {
      return { ok: false as const, code: "grant-expired-at-claim", message: "grant expired before claim" };
    }
    const storedPayload = operation.normalizedPayload ?? operation.canonicalPayload ?? "";

    // Communication envelope first: header injections receive their precise
    // typed denial before the draft comparison, so smuggled headers cannot
    // hide behind it.
    if (isCommunicationKind(operation.kind)) {
      const configs = (await ctx.db.query("recipientConfigs").collect()) as unknown as {
        version: number;
        active: boolean;
        mailboxNormalized: string;
      }[];
      const recipient = configs.find((config) => config.active);
      if (!recipient) {
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

    if (grant.canonicalPayload !== undefined && !sameCanonicalPayload(storedPayload, grant.canonicalPayload)) {
      return { ok: false as const, code: "changed-draft", message: "approved draft changed after this operation was prepared" };
    }
    if (!sha256BindingOk(operation.payloadSha256, grant.payloadSha256)) {
      return { ok: false as const, code: "changed-draft", message: "payload digest no longer matches the approved draft" };
    }

    if (operation.conversationVersion !== undefined) {
      if (grant.conversationId !== undefined) {
        const conversation = (await ctx.db.get(grant.conversationId as never)) as unknown as {
          version?: number;
          state?: string;
        } | null;
        if (conversation && conversation.version !== operation.conversationVersion) {
          return { ok: false as const, code: "relevant-reply-superseded", message: "a relevant reply arrived after this operation was prepared" };
        }
        if (conversation && conversation.state === "cancelled") {
          return { ok: false as const, code: "cancelled-before-claim", message: "conversation was cancelled before claim" };
        }
      }
    }

    if (operation.reservationId !== undefined) {
      const reservation = (await ctx.db.get(operation.reservationId as never)) as unknown as {
        state?: string;
      } | null;
      if (!reservation || reservation.state !== "open") {
        return { ok: false as const, code: "allowance-exhausted", message: "reservation is not available" };
      }
    }

    const token = crypto.randomUUID();
    await ctx.db.patch(args.operationId as never, {
      state: "dispatching",
      attemptToken: token,
      updatedAt: args.now,
    });
    await ctx.db.insert("attempts", {
      operationId: args.operationId,
      token,
      state: "dispatching",
      createdAt: args.now,
    });
    return { ok: true as const, operationId: args.operationId, attemptToken: token };
  },
});

/** Read one authorized operation (no authority granted by reading). */
export const get = query({
  args: { operationId: v.string(), organizationId: v.string(), projectId: v.string(), now: v.number() },
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
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const operation = (await ctx.db.get(args.operationId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      state?: string;
      kind?: string;
      requestId?: string;
      requestKey?: string;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    return {
      ok: true as const,
      state: operation.state ?? "prepared",
      kind: operation.kind ?? "",
      requestId: operation.requestId ?? "",
      dedupKey: operation.requestKey ?? "",
    };
  },
});

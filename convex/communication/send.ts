/**
 * C1 outbound communication orchestration.
 *
 * The action is intentionally thin: prepare an immutable app-owned snapshot,
 * call the F1 atomic claim, make one REST request, then record the provider
 * outcome. It never uses AgentMail's independent outbound queue.
 */

import { AgentMail, type AgentMailComponent } from "@agentmail/convex";
import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { env, internalAction } from "../_generated/server.js";
import { f1InternalMutation, type F1ActionCtx, type F1MutationCtx } from "../server.js";
import * as attempts from "../execution/attempts.js";
import * as operations from "../execution/operations.js";
import * as reconciliation from "../execution/reconciliation.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { payloadHash } from "../shared/hashing.js";
import { denialValidator } from "../access/checks.js";
import {
  providerPayloadFromOutbound,
  validateOutboundPayload,
  isCommunicationDenial,
  DEFAULT_AGENTMAIL_BASE_URL,
  EU_AGENTMAIL_BASE_URL,
  DEFAULT_RECONCILIATION_OVERALL_TIMEOUT_MS,
  DEFAULT_RECONCILIATION_READ_TIMEOUT_MS,
  type CommunicationDenial,
} from "./contracts.js";
import { inboundResultValidator, maybeScheduleThreadMigration } from "./callbacks.js";
import { components } from "../models/components.js";
import { operationLabel, sendAgentMailOneShot } from "./transport.js";
import type * as callbacks from "./callbacks.js";

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Awaited<Return> : never;

// Legacy callback receipts have no structured provider fields. Only use the
// bounded fallback when the sentinel proves that every legacy row was read;
// an incomplete horizon remains unresolved rather than being treated as a
// successful reconciliation.
const LEGACY_BINDING_RECOVERY_LIMIT = 64;

const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const outcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.recordOutcome>,
  MutationReturn<typeof attempts.recordOutcome>
>("execution/attempts:recordOutcome");
const lateDeliveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.recordLateDelivery>,
  MutationReturn<typeof reconciliation.recordLateDelivery>
>("execution/reconciliation:recordLateDelivery");
const replayWaitingRef = makeFunctionReference<
  "mutation",
  { threadId: string; inboxId: string; continuation?: number },
  MutationReturn<typeof callbacks.replayWaitingInbound>
>("communication/callbacks:replayWaitingInbound");
const resumeWaitingRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof callbacks.resumeWaitingInbound>,
  MutationReturn<typeof callbacks.resumeWaitingInbound>
>("communication/callbacks:resumeWaitingInbound");
const prepareRecoveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof callbacks.prepareOversizedRecovery>,
  MutationReturn<typeof callbacks.prepareOversizedRecovery>
>("communication/callbacks:prepareOversizedRecovery");
const claimRecoveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof callbacks.claimRecoveryRead>,
  MutationReturn<typeof callbacks.claimRecoveryRead>
>("communication/callbacks:claimRecoveryRead");
const settleRecoveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof callbacks.settleRecoveryRun>,
  MutationReturn<typeof callbacks.settleRecoveryRun>
>("communication/callbacks:settleRecoveryRun");
const watchdogRecoveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof callbacks.watchdogRecoveryRun>,
  MutationReturn<typeof callbacks.watchdogRecoveryRun>
>("communication/callbacks:watchdogRecoveryRun");

const snapshotResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    snapshotId: v.id("outboundSnapshots"),
    deduplicated: v.boolean(),
    payloadJson: v.string(),
    inboxId: v.string(),
  }),
  denialValidator,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(canonical: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(canonical);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function denial(code: CommunicationDenial["code"], message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function normalizedProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Persist the app-owned outbound snapshot before the external effect. The
 * schema intentionally stores hashes and protected binding metadata, not a
 * separate public body projection; the exact approved body remains bound to
 * the F1 operation payload while quote evidence stores only redacted
 * derivatives.
 */
export const prepareOutboundSnapshot = f1InternalMutation({
  args: { operationId: v.id("operations"), inboxId: v.string() },
  returns: snapshotResultValidator,
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(args.inboxId)) {
      return denial("invalid-payload", "provider inbox id is invalid");
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) return denial("invalid-payload", "operation is not available");
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return denial("alternate-channel-denied", "operation is not an outbound communication");
    }
    if (operation.state !== "prepared" && operation.state !== "dispatching") {
      return denial("invalid-payload", `operation is ${operation.state}`);
    }
    const job = await ctx.db.get(operation.jobId);
    if (job === null) return denial("invalid-payload", "job is not available");
    if (job.state === "cancelled" || job.state === "cancelling") {
      return denial("alternate-channel-denied", "job is fenced for cancellation");
    }
    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId ||
      grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY
    ) {
      return denial("alternate-channel-denied", "communication grant is not owner-roleplay bound");
    }
    if (grant.status !== "active" || grant.revocationVersion !== operation.grantVersion || grant.expiresAt <= Date.now()) {
      return denial("alternate-channel-denied", "communication grant is stale, revoked, or expired");
    }
    if (grant.conversationId !== undefined) {
      const conversation = await ctx.db.get(grant.conversationId);
      if (
        conversation === null ||
        conversation.organizationId !== operation.organizationId ||
        conversation.projectId !== operation.projectId ||
        conversation.state === "cancelled" ||
        conversation.state === "closed" ||
        (operation.conversationVersion !== undefined && conversation.version !== operation.conversationVersion)
      ) {
        return denial("alternate-channel-denied", "communication conversation is stale or closed");
      }
    }
    const activeRecipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    if (activeRecipients.length !== 1) {
      return denial("missing-recipient-config", "owner recipient is not configured uniquely");
    }
    const recipient = activeRecipients[0];
    if (recipient === undefined || recipient.version !== grant.recipientConfigVersion) {
      return denial("recipient-mismatch", "recipient configuration changed; re-approval required");
    }
    const value = parseObject(operation.normalizedPayload);
    if (value === null) return denial("invalid-payload", "operation payload is invalid JSON");
    const validated = validateOutboundPayload(value, recipient.mailboxNormalized);
    if (isCommunicationDenial(validated)) return validated;
    if (validated.canonical !== operation.normalizedPayload) {
      return denial("invalid-payload", "payload canonical form changed");
    }
    if (operation.normalizedPayload !== grant.canonicalPayload || validated.normalizedPayloadHash !== operation.normalizedPayloadHash) {
      return denial("invalid-payload", "approved communication draft changed");
    }
    const existingRows = await ctx.db
      .query("outboundSnapshots")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .take(2);
    if (existingRows.length > 1) return denial("invalid-payload", "duplicate outbound snapshots detected");
    const existing = existingRows[0];
    if (existing !== undefined) {
      if (
        existing.payloadHash !== operation.normalizedPayloadHash ||
        existing.to !== validated.payload.to ||
        existing.recipientConfigVersion !== recipient.version
      ) {
        return denial("invalid-payload", "stored outbound snapshot does not match the operation");
      }
      return {
        ok: true as const,
        snapshotId: existing._id,
        deduplicated: true,
        payloadJson: operation.normalizedPayload,
        inboxId: args.inboxId,
      };
    }
    const snapshotId = await ctx.db.insert("outboundSnapshots", {
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      operationId: operation._id,
      grantId: grant._id,
      to: validated.payload.to,
      cc: [],
      bcc: [],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: recipient.version,
      payloadHash: operation.normalizedPayloadHash,
      bodyHash: payloadHash(validated.payload.body),
      counterpartyRole: "ownerStandIn",
      createdAt: Date.now(),
    });
    return {
      ok: true as const,
      snapshotId,
      deduplicated: false,
      payloadJson: operation.normalizedPayload,
      inboxId: args.inboxId,
    };
  },
});

const bindingResultValidator = v.union(
  v.object({ ok: v.literal(true), bound: v.boolean(), applied: v.boolean() }),
  denialValidator,
);

interface BindingFacts {
  readonly eventId?: string;
  readonly eventType?: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
}

function bindingFacts(value: unknown): BindingFacts | null {
  if (!isRecord(value)) return null;
  const messageId = normalizedProviderId(value["messageId"]);
  const threadId = normalizedProviderId(value["threadId"]);
  const inboxId = normalizedProviderId(value["inboxId"]);
  if (messageId === undefined || threadId === undefined || inboxId === undefined) return null;
  const eventId = normalizedProviderId(value["eventId"]);
  const eventType = typeof value["eventType"] === "string" ? value["eventType"] : undefined;
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventType === undefined ? {} : { eventType }),
    messageId,
    threadId,
    inboxId,
  };
}

function rowBindingFacts(row: {
  readonly outcome: string;
  readonly providerMessageId?: string;
  readonly providerThreadId?: string;
  readonly providerInboxId?: string;
}): BindingFacts | null {
  const legacy = bindingFacts(parseObject(row.outcome));
  const structuredMessageId = normalizedProviderId(row.providerMessageId);
  const structuredThreadId = normalizedProviderId(row.providerThreadId);
  const structuredInboxId = normalizedProviderId(row.providerInboxId);
  if (
    (structuredMessageId !== undefined && legacy?.messageId !== undefined && structuredMessageId !== legacy.messageId) ||
    (structuredThreadId !== undefined && legacy?.threadId !== undefined && structuredThreadId !== legacy.threadId) ||
    (structuredInboxId !== undefined && legacy?.inboxId !== undefined && structuredInboxId !== legacy.inboxId)
  ) return null;
  const messageId = structuredMessageId ?? legacy?.messageId;
  const threadId = structuredThreadId ?? legacy?.threadId;
  const inboxId = structuredInboxId ?? legacy?.inboxId;
  if (messageId === undefined || threadId === undefined || inboxId === undefined) return null;
  return {
    ...(legacy?.eventId === undefined ? {} : { eventId: legacy.eventId }),
    ...(legacy?.eventType === undefined ? {} : { eventType: legacy.eventType }),
    messageId,
    threadId,
    inboxId,
  };
}

function matchesBinding(
  row: {
    readonly outcome: string;
    readonly providerMessageId?: string;
    readonly providerThreadId?: string;
    readonly providerInboxId?: string;
  },
  expected: BindingFacts,
): boolean {
  const facts = rowBindingFacts(row);
  return facts?.messageId === expected.messageId && facts.threadId === expected.threadId && facts.inboxId === expected.inboxId;
}

function isSuccessEvent(eventType: string | undefined): boolean {
  return eventType === "message.sent" || eventType === "message.delivered";
}

// Bounded agreement horizon for establishing a durable thread identity.
// Threads that already exceed it keep the legacy fail-closed behavior; only
// unanimous horizons earn a durable binding, so a cap is never silently
// raised over a conflict.
const THREAD_BINDING_VERIFY_LIMIT = 64;

interface ThreadBindingRow {
  readonly _id: Id<"threadBindings">;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly conversationId: Id<"conversations">;
}

/**
 * Exact durable thread-identity read. Compatible duplicates (same
 * organization, project and conversation) resolve to that identity; rows
 * implying different identities are a conflict.
 */
async function readThreadBinding(
  ctx: F1MutationCtx,
  threadId: string,
  inboxId: string,
): Promise<{ readonly status: "absent" } | { readonly status: "resolved"; readonly row: ThreadBindingRow } | { readonly status: "conflict" }> {
  const rows = await ctx.db
    .query("threadBindings")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .take(2);
  if (rows.length === 0) return { status: "absent" as const };
  if (rows.length > 1) {
    const first = rows[0];
    const second = rows[1];
    if (
      first === undefined || second === undefined ||
      first.organizationId !== second.organizationId ||
      first.projectId !== second.projectId ||
      first.conversationId !== second.conversationId
    ) return { status: "conflict" as const };
  }
  const row = rows[0];
  if (row === undefined) return { status: "absent" as const };
  return { status: "resolved" as const, row };
}

/** Grant conversation behind an outbound operation, if the grant names one. */
async function grantConversationId(
  ctx: F1MutationCtx,
  operation: { readonly grantId: Id<"grants"> },
): Promise<Id<"conversations"> | null> {
  const grant = await ctx.db.get(operation.grantId);
  if (grant === null || grant.conversationId === undefined) return null;
  return grant.conversationId;
}

async function rowThreadConversation(
  ctx: F1MutationCtx,
  row: { readonly operationId?: Id<"operations"> },
  scope: { readonly organizationId: Id<"organizations">; readonly projectId: Id<"projects"> },
): Promise<Id<"conversations"> | null> {
  if (row.operationId === undefined) return null;
  const operation = await ctx.db.get(row.operationId);
  if (
    operation === null ||
    operation.organizationId !== scope.organizationId ||
    operation.projectId !== scope.projectId
  ) return null;
  return grantConversationId(ctx, operation);
}

/**
 * Fail-closed gate for the durable thread identity (Greptile r4058523017
 * repair). A thread already bound to a different conversation denies the new
 * bind before anything is written. Absent identities are created only after
 * the insert, and only when a bounded verification proves every existing
 * binding row agrees; anything else keeps today's legacy behavior.
 */
async function checkThreadBindingGate(
  ctx: F1MutationCtx,
  scope: { readonly organizationId: Id<"organizations">; readonly projectId: Id<"projects"> },
  threadId: string,
  inboxId: string,
  conversationId: Id<"conversations"> | null,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (conversationId === null) return { ok: true as const };
  const current = await readThreadBinding(ctx, threadId, inboxId);
  if (current.status === "conflict") {
    return { ok: false as const, code: "invalid-payload", message: "provider thread binding is ambiguous" };
  }
  if (current.status === "resolved") {
    if (
      current.row.organizationId !== scope.organizationId ||
      current.row.projectId !== scope.projectId ||
      current.row.conversationId !== conversationId
    ) {
      return { ok: false as const, code: "invalid-payload", message: "provider thread is already bound to another conversation" };
    }
  }
  return { ok: true as const };
}

/**
 * Backfill the durable thread identity after a binding insert. Creation
 * requires a bounded unanimous horizon across structured rows and legacy
 * rows; a truncated horizon or any disagreement leaves the thread on the
 * legacy path instead of masking a conflict.
 */
async function backfillThreadBinding(
  ctx: F1MutationCtx,
  scope: { readonly organizationId: Id<"organizations">; readonly projectId: Id<"projects"> },
  threadId: string,
  inboxId: string,
  conversationId: Id<"conversations"> | null,
  operationId: Id<"operations">,
): Promise<void> {
  if (conversationId === null) return;
  const current = await readThreadBinding(ctx, threadId, inboxId);
  if (current.status !== "absent") return;
  const structured = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .take(THREAD_BINDING_VERIFY_LIMIT + 1);
  if (structured.length > THREAD_BINDING_VERIFY_LIMIT) {
    // The horizon cannot prove this thread here. Hand it to the resumable
    // migration instead of leaving routing permanently broken.
    await maybeScheduleThreadMigration(ctx, threadId, inboxId);
    return;
  }
  for (const row of structured) {
    const facts = rowBindingFacts(row);
    if (facts === null || facts.threadId !== threadId || facts.inboxId !== inboxId) return;
    const rowConversation = await rowThreadConversation(ctx, row, scope);
    if (rowConversation === null || rowConversation !== conversationId) return;
  }
  const legacy = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", undefined)
        .eq("providerInboxId", undefined),
    )
    .take(THREAD_BINDING_VERIFY_LIMIT + 1);
  // Only true legacy rows are visible here, so this limit counts actual
  // legacy history: more than 64 stays fail-closed instead of sampling.
  if (legacy.length > THREAD_BINDING_VERIFY_LIMIT) return;
  for (const row of legacy) {
    const facts = rowBindingFacts(row);
    if (facts === null || facts.threadId !== threadId || facts.inboxId !== inboxId) continue;
    const rowConversation = await rowThreadConversation(ctx, row, scope);
    if (rowConversation === null || rowConversation !== conversationId) return;
  }
  const now = Date.now();
  await ctx.db.insert("threadBindings", {
    provider: "agentmail-binding",
    environment: "live",
    providerThreadId: threadId,
    providerInboxId: inboxId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    conversationId,
    operationId,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Bind an out-of-order callback to the provider response. Binding rows are
 * stored in F1's processed-event ledger as compact, redacted facts, so no
 * second table or unbounded message mirror is introduced by C1.
 */
export const recordProviderBinding = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    messageId: v.string(),
    threadId: v.string(),
    inboxId: v.string(),
  },
  returns: bindingResultValidator,
  handler: async (ctx, args) => {
    const expected = bindingFacts({
      messageId: args.messageId,
      threadId: args.threadId,
      inboxId: args.inboxId,
    });
    if (expected === null) {
      return denial("invalid-payload", "provider response identifiers are required");
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) return denial("invalid-payload", "operation is not available");
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return denial("alternate-channel-denied", "operation is not communication-bound");
    }
    const scope = { organizationId: operation.organizationId, projectId: operation.projectId };
    // Durable thread-identity gate: a thread already bound to another
    // conversation denies this bind before anything is written.
    const threadConversationId = await grantConversationId(ctx, operation);
    const gate = await checkThreadBindingGate(ctx, scope, expected.threadId, expected.inboxId, threadConversationId);
    if (!gate.ok) return { ok: false as const, code: gate.code, message: gate.message };
    const existingRows = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", "agentmail-binding").eq("environment", "live").eq("eventId", expected.messageId),
      )
      .take(2);
    if (existingRows.length > 1) return denial("invalid-payload", "provider message binding is ambiguous");
    const existing = existingRows[0];
    if (existing !== undefined) {
      if (
        existing.organizationId !== scope.organizationId ||
        existing.projectId !== scope.projectId ||
        existing.operationId !== args.operationId
      ) {
        return denial("invalid-payload", "provider message is already bound to another project");
      }
      if (!matchesBinding(existing, expected)) {
        return denial("invalid-payload", "provider message binding facts conflict");
      }
      if (
        existing.providerMessageId === undefined ||
        existing.providerThreadId === undefined ||
        existing.providerInboxId === undefined
      ) {
        await ctx.db.patch(existing._id, {
          providerMessageId: expected.messageId,
          providerThreadId: expected.threadId,
          providerInboxId: expected.inboxId,
        });
      }
      const applied = existing.applicationState === "observedSuccess" || operation.state === "observedSuccess";
      if (applied && existing.applicationState !== "observedSuccess") {
        await ctx.db.patch(existing._id, {
          applicationOutcome: "success",
          applicationState: "observedSuccess",
          appliedAt: Date.now(),
        });
      }
      await backfillThreadBinding(ctx, scope, expected.threadId, expected.inboxId, threadConversationId, args.operationId);
      return { ok: true as const, bound: true, applied };
    }

    const now = Date.now();
    let applied = false;
    const indexedCallbacks = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-callback")
          .eq("environment", "live")
          .eq("providerMessageId", expected.messageId)
          .eq("providerThreadId", expected.threadId)
          .eq("providerInboxId", expected.inboxId),
      )
      .take(2);
    if (indexedCallbacks.length > 1) return denial("invalid-payload", "provider callback binding is ambiguous");
    let callback = indexedCallbacks[0];
    if (callback === undefined) {
      // Legacy-only callback recovery: rows predating structured fields
      // are exactly those missing the thread/inbox index fields, so
      // hundreds of unrelated structured rows cannot push a true legacy
      // callback out of this bounded read.
      const legacyRows = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
          q
            .eq("provider", "agentmail-callback")
            .eq("environment", "live")
            .eq("providerThreadId", undefined)
            .eq("providerInboxId", undefined),
        )
        .take(LEGACY_BINDING_RECOVERY_LIMIT + 1);
      if (legacyRows.length <= LEGACY_BINDING_RECOVERY_LIMIT) {
        const matches = legacyRows.filter((row) => matchesBinding(row, expected));
        if (matches.length > 1) return denial("invalid-payload", "legacy provider callback binding is ambiguous");
        callback = matches[0];
      }
    }
    if (callback !== undefined) {
      if (callback.organizationId !== undefined && callback.organizationId !== scope.organizationId) {
        return denial("invalid-payload", "callback belongs to another organization");
      }
      if (callback.projectId !== undefined && callback.projectId !== scope.projectId) {
        return denial("invalid-payload", "callback belongs to another project");
      }
      if (callback.operationId !== undefined && callback.operationId !== args.operationId) {
        return denial("invalid-payload", "callback is already bound to another operation");
      }
      const facts = rowBindingFacts(callback);
      if (facts === null || !matchesBinding(callback, expected)) {
        return denial("invalid-payload", "provider callback binding facts conflict");
      }
      const successEvent = isSuccessEvent(facts.eventType);
      if (successEvent) {
        const token = operation.attemptToken;
        if (operation.state === "observedSuccess") {
          applied = true;
        } else if (token !== undefined && facts.eventId !== undefined) {
          const late: MutationReturn<typeof reconciliation.recordLateDelivery> = await ctx.runMutation(lateDeliveryRef, {
            operationId: args.operationId,
            token,
            providerEventId: facts.eventId,
            provider: "agentmail",
            environment: "live",
          });
          applied = late.ok;
        }
      }
      await ctx.db.patch(callback._id, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        operationId: args.operationId,
        providerMessageId: expected.messageId,
        providerThreadId: expected.threadId,
        providerInboxId: expected.inboxId,
        applicationOutcome: successEvent && applied ? "success" : "unknown",
        applicationState: successEvent && applied ? "observedSuccess" : "outcomeUnknown",
        ...(successEvent && applied ? { appliedAt: now } : {}),
      });
    }
    await ctx.db.insert("processedEvents", {
      provider: "agentmail-binding",
      environment: "live",
      eventId: expected.messageId,
      processingVersion: 1,
      outcome: JSON.stringify({ messageId: expected.messageId, threadId: expected.threadId, inboxId: expected.inboxId }),
      providerMessageId: expected.messageId,
      providerThreadId: expected.threadId,
      providerInboxId: expected.inboxId,
      ...scope,
      operationId: args.operationId,
      applicationOutcome: applied ? "success" : "unknown",
      applicationState: applied ? "observedSuccess" : "outcomeUnknown",
      ...(applied ? { appliedAt: now } : {}),
      createdAt: now,
    });
    // Establish the durable thread identity once the bounded horizon proves
    // every binding row agrees. Threads that cannot be proven keep the
    // legacy fail-closed behavior.
    await backfillThreadBinding(ctx, scope, expected.threadId, expected.inboxId, threadConversationId, args.operationId);
    // Retained pre-binding replies take effect now that their conversation
    // binding exists. The replay is bounded and marker-idempotent.
    const replay: MutationReturn<typeof callbacks.replayWaitingInbound> = await ctx.runMutation(replayWaitingRef, {
      threadId: expected.threadId,
      inboxId: expected.inboxId,
    });
    if (!replay.ok) return { ok: false as const, code: replay.code, message: replay.message };
    return { ok: true as const, bound: true, applied };
  },
});

const dispatchResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.union(v.literal("success"), v.literal("failure"), v.literal("unknown")),
    providerMessageId: v.union(v.string(), v.null()),
    providerThreadId: v.union(v.string(), v.null()),
    recorded: v.boolean(),
  }),
  denialValidator,
);

/** Internal one-shot dispatch. Never exposed to browsers. */
export const dispatch = internalAction({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    inboxId: v.string(),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, args) => {
    const apiKey = env.AGENTMAIL_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return denial("provider-rejection", "AgentMail allowance or credentials are unavailable");
    }
    const prepared: MutationReturn<typeof prepareOutboundSnapshot> = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        MutationArgs<typeof prepareOutboundSnapshot>,
        MutationReturn<typeof prepareOutboundSnapshot>
      >("communication/send:prepareOutboundSnapshot"),
      { operationId: args.operationId, inboxId: args.inboxId },
    );
    if (!prepared.ok) return prepared;
    const owner = env.HACKATHON_OWNER_RECIPIENT;
    if (owner === undefined || owner.trim().length === 0) {
      return denial("missing-recipient-config", "owner recipient is not configured for transport");
    }
    const value: unknown = JSON.parse(prepared.payloadJson);
    const outbound = validateOutboundPayload(value, owner);
    if (isCommunicationDenial(outbound)) return outbound;
    const claim: MutationReturn<typeof operations.claim> = await ctx.runMutation(claimRef, {
      operationId: args.operationId,
      identity: args.identity,
    });
    if (!claim.ok) return claim;
    const transport = await sendAgentMailOneShot({
      apiKey,
      inboxId: args.inboxId,
      ownerMailbox: owner,
      payload: providerPayloadFromOutbound(outbound.payload),
      operationLabel: operationLabel(String(args.operationId)),
      ...(env.AGENTMAIL_BASE_URL === undefined ? {} : { baseUrl: env.AGENTMAIL_BASE_URL }),
    });
    let recorded = false;
    if (transport.outcome === "success") {
      const outcome: MutationReturn<typeof attempts.recordOutcome> = await ctx.runMutation(outcomeRef, {
        operationId: args.operationId,
        token: claim.attemptToken,
        provider: "agentmail",
        environment: "live",
        providerEventId: transport.providerEventId,
        outcome: "success",
        detail: "AgentMail accepted one direct REST send",
      });
      recorded = outcome.ok;
      if (!outcome.ok) return outcome;
      const binding: MutationReturn<typeof recordProviderBinding> = await ctx.runMutation(
        makeFunctionReference<
          "mutation",
          MutationArgs<typeof recordProviderBinding>,
          MutationReturn<typeof recordProviderBinding>
        >("communication/send:recordProviderBinding"),
        {
          operationId: args.operationId,
          messageId: transport.response.messageId,
          threadId: transport.response.threadId,
          inboxId: args.inboxId,
        },
      );
      if (!binding.ok) return binding;
      return {
        ok: true as const,
        outcome: "success" as const,
        providerMessageId: transport.response.messageId,
        providerThreadId: transport.response.threadId,
        recorded,
      };
    }
    const outcome: MutationReturn<typeof attempts.recordOutcome> = await ctx.runMutation(outcomeRef, {
      operationId: args.operationId,
      token: claim.attemptToken,
      provider: "agentmail",
      environment: "live",
      outcome: transport.outcome === "failure" ? "failure" : "unknown",
      ...(transport.outcome === "unknown" ? { unknownCharges: true } : {}),
      detail: transport.outcome === "failure" ? transport.denial.message : transport.reason,
    });
    recorded = outcome.ok;
    return {
      ok: true as const,
      outcome: transport.outcome,
      providerMessageId: transport.providerEventId ?? null,
      providerThreadId: null,
      recorded,
    };
  },
});

// Bounded provider-read recovery (S-15, Greptile r4058523016 repair).
//
// A retained oversized reply has no replayable snapshot, so the standard
// replay leaves it waiting forever. This internal action is the reachable
// recovery trigger: after the `prepareOversizedRecovery` gate proves the
// waiting row, its conversation binding, its live grant, and admits one
// reserved run under the canonical reconciliation pricing basis, the action
// performs up to three exact reads through the installed official AgentMail
// component path (`getMessage`), each claimed before dispatch with per-read
// and overall deadlines. Bytes sink through `resumeWaitingInbound`, which
// hash-verifies the exact content and ingests marker-idempotently. Anything
// else — missing row, stale grant, missing pricing/allowance/credentials,
// transport failure, identity mismatch — stays waiting or returns unknown;
// success is never claimed without the exact bytes. The run always
// settles: definitive rejections release, everything else stays unresolved
// without inventing a spend number.
//
// Owner-only and idempotency rules are unchanged: the recovered bytes take
// the same validated path as a live callback, so a non-owner sender lands
// in needsReview and a repeated recovery deduplicates by marker. Live use
// additionally requires the foundation owner's component mount; controlled
// tests register the official component helper instead.

const recoveryResultValidator = v.union(
  inboundResultValidator,
  v.object({ ok: v.literal(true), outcome: v.literal("unknown"), reason: v.string() }),
  denialValidator,
);

function recoveryDenial(code: CommunicationDenial["code"], message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function recoveryString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) return undefined;
  return normalized;
}

function normalizedRecoveryId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Project a provider getMessage payload to the documented resume fields.
 * Unknown provider fields are dropped at this boundary; attachment
 * descriptors that are not plain string maps keep a placeholder so the
 * entry count — which drives evidence completeness — stays exact.
 */
function projectRecoveryMessage(entry: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["message_id", "thread_id", "inbox_id", "from"]) {
    const trimmed = recoveryString(entry[key], 1024);
    if (trimmed !== undefined) projected[key] = trimmed;
  }
  for (const key of ["subject", "text", "html", "in_reply_to"]) {
    if (typeof entry[key] === "string") projected[key] = entry[key];
  }
  for (const key of ["to", "cc"]) {
    const value = entry[key];
    if (typeof value === "string") {
      projected[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      projected[key] = [...value];
    }
  }
  const timestamp = entry["timestamp"];
  if ((typeof timestamp === "number" && Number.isFinite(timestamp)) || typeof timestamp === "string") {
    projected["timestamp"] = timestamp;
  }
  const references = entry["references"];
  if (Array.isArray(references) && references.every((item) => typeof item === "string")) {
    projected["references"] = [...references];
  }
  const attachments = entry["attachments"];
  if (Array.isArray(attachments)) {
    projected["attachments"] = attachments.map((item) => {
      if (
        typeof item === "object" && item !== null && !Array.isArray(item) &&
        Object.values(item).every((field) => typeof field === "string")
      ) return { ...(item as Record<string, string>) };
      return { unprojected: "true" };
    });
  }
  return projected;
}

function readTimeoutError(): Error {
  return new Error("recovery read deadline exceeded");
}

/**
 * The official component surfaces definitive provider rejections (unknown
 * inbox or message, denied credentials) as an error carrying a permanent
 * marker. Those reads provably caused no charge, so the run may release
 * instead of retaining. Everything else stays unresolved.
 */
function isDefinitiveProviderRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly permanent?: unknown }).permanent === true &&
    typeof (error as { readonly status?: unknown }).status === "number"
  );
}

// Watchdog delay: one per-read deadline plus margin. A crashed or stalled
// run is settled from the durable claimed total even if this run never
// reaches its own settlement; a normally completed run makes the watchdog
// a harmless no-op.
const RECOVERY_WATCHDOG_DELAY_MS = 15_000;

async function readExactMessage(
  client: AgentMail,
  ctx: Parameters<AgentMail["getMessage"]>[0],
  inboxId: string,
  messageId: string,
  deadlineAt: number,
): Promise<unknown> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw readTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.getMessage(ctx, inboxId, messageId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(readTimeoutError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Internal bounded recovery read. Never exposed to browsers. */
export const recoverOversizedInbound = internalAction({
  args: {
    threadId: v.string(),
    inboxId: v.string(),
    messageId: v.string(),
  },
  returns: recoveryResultValidator,
  handler: async (ctx, args) => {
    const threadId = recoveryString(args.threadId, 1024);
    const inboxId = recoveryString(args.inboxId, 160);
    const messageId = recoveryString(args.messageId, 1024);
    if (threadId === undefined || inboxId === undefined || messageId === undefined) {
      return recoveryDenial("invalid-payload", "thread, inbox, and message identifiers are required");
    }
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(inboxId)) {
      return recoveryDenial("invalid-payload", "provider inbox id is invalid");
    }
    // Zero-read configuration first: credentials and origin are validated
    // before the gate admits anything, so a config denial can never leak
    // an admitted reservation.
    const apiKey = env.AGENTMAIL_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return recoveryDenial("provider-rejection", "AgentMail allowance or credentials are unavailable");
    }
    const baseUrl = env.AGENTMAIL_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL;
    if (baseUrl !== DEFAULT_AGENTMAIL_BASE_URL && baseUrl !== EU_AGENTMAIL_BASE_URL) {
      return recoveryDenial("provider-origin-denied", "AgentMail origin is not allowlisted");
    }
    // Authority and admission next: no provider call before the gate proves
    // the waiting row, its conversation binding, its live grant, and
    // reserves the run under the canonical pricing basis.
    const gate: MutationReturn<typeof callbacks.prepareOversizedRecovery> = await ctx.runMutation(prepareRecoveryRef, {
      threadId,
      inboxId,
      messageId,
    });
    if (!gate.ok) return gate;
    const client = new AgentMail(components.agentmail as unknown as AgentMailComponent);
    const overallDeadline = Date.now() + DEFAULT_RECONCILIATION_OVERALL_TIMEOUT_MS;
    let claims = 0;
    let outcome: "recovered" | "unknown" | "rejected" = "unknown";
    let result:
      | MutationReturn<typeof callbacks.resumeWaitingInbound>
      | { ok: true; outcome: "unknown"; reason: string }
      | { ok: false; code: string; message: string } = {
        ok: true as const,
        outcome: "unknown" as const,
        reason: "recovery read budget exhausted",
      };
    try {
      while (claims < gate.readsRemaining) {
        if (Date.now() > overallDeadline) {
          result = { ok: true as const, outcome: "unknown" as const, reason: "recovery overall deadline exceeded" };
          break;
        }
        // Claim before dispatch: bound to the admitted run, so a watchdog
        // (or a concurrent run) that already settled denies here before any
        // HTTP read. The atomic check-and-increment keeps total reads at or
        // below the bound across crashes and concurrent runs.
        const claim: MutationReturn<typeof callbacks.claimRecoveryRead> = await ctx.runMutation(claimRecoveryRef, {
          threadId,
          inboxId,
          messageId,
          jobId: gate.jobId,
          reservationId: gate.reservationId,
        });
        if (!claim.ok) {
          result = { ok: true as const, outcome: "unknown" as const, reason: claim.message };
          break;
        }
        claims += 1;
        // Watchdog before dispatch: if this run crashes or stalls past its
        // deadlines, the scheduled check settles the admitted run from the
        // durable claimed total instead of stranding an open reservation.
        await ctx.scheduler.runAfter(RECOVERY_WATCHDOG_DELAY_MS, watchdogRecoveryRef, {
          jobId: gate.jobId,
          reservationId: gate.reservationId,
          threadId,
          inboxId,
          messageId,
        });
        const readDeadline = Math.min(overallDeadline, Date.now() + DEFAULT_RECONCILIATION_READ_TIMEOUT_MS);
        let payload: unknown;
        try {
          payload = await readExactMessage(
            client,
            ctx as unknown as Parameters<AgentMail["getMessage"]>[0],
            inboxId,
            messageId,
            readDeadline,
          );
        } catch (error) {
          if (isDefinitiveProviderRejection(error)) {
            outcome = "rejected";
            result = { ok: true as const, outcome: "unknown" as const, reason: "provider definitively rejected the read" };
            break;
          }
          continue;
        }
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          result = { ok: true as const, outcome: "unknown" as const, reason: "recovered payload is not an object" };
          break;
        }
        const entry = payload as Record<string, unknown>;
        if (
          normalizedRecoveryId(entry["message_id"]) !== messageId ||
          normalizedRecoveryId(entry["thread_id"]) !== threadId ||
          normalizedRecoveryId(entry["inbox_id"]) !== inboxId
        ) {
          result = { ok: true as const, outcome: "unknown" as const, reason: "recovered message identity conflicts" };
          break;
        }
        const projected = projectRecoveryMessage(entry);
        if (
          typeof projected["message_id"] !== "string" ||
          typeof projected["thread_id"] !== "string" ||
          typeof projected["inbox_id"] !== "string" ||
          typeof projected["from"] !== "string"
        ) {
          result = { ok: true as const, outcome: "unknown" as const, reason: "recovered message lacks provider identity" };
          break;
        }
        let resumed: MutationReturn<typeof callbacks.resumeWaitingInbound>;
        try {
          resumed = await ctx.runMutation(resumeWaitingRef, {
            message: projected as MutationArgs<typeof callbacks.resumeWaitingInbound>["message"],
            eventId: `recovery:${messageId}`,
          });
        } catch {
          result = { ok: true as const, outcome: "unknown" as const, reason: "recovered payload failed boundary validation" };
          break;
        }
        if (resumed.ok) outcome = "recovered";
        result = resumed;
        break;
      }
    } finally {
      // The run always settles from the durable claimed total: definitive
      // rejections release, everything else stays unresolved without
      // inventing a spend number. A failed settlement leaves the reservation
      // safely locked for the watchdog, never freed.
      await ctx.runMutation(settleRecoveryRef, {
        jobId: gate.jobId,
        reservationId: gate.reservationId,
        threadId,
        inboxId,
        messageId,
        outcome,
      });
    }
    return result;
  },
});

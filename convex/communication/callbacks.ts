/**
 * AgentMail callback ingestion and quote handoff.
 *
 * The official component verifies the signed HTTP envelope and deduplicates
 * provider event IDs before invoking these internal mutations. C1 still
 * validates every nested provider field, preserves out-of-order events, and
 * applies only a project/thread binding proven from app-owned records.
 */

import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, type F1MutationCtx } from "../server.js";
import * as reconciliation from "../execution/reconciliation.js";
import * as reservations from "../execution/reservations.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import { parseBoundedPayloadJson, payloadHash } from "../shared/hashing.js";
import { MAX_JOBS_PER_GRANT } from "../shared/scope.js";
import { normalizeMailbox } from "../shared/mailbox.js";
import { denialValidator } from "../access/checks.js";
import {
  MAX_RECONCILIATION_READS,
  parseInboundMessage,
  sanitizeInboundContent,
  serializeProviderEventForBinding,
  isCommunicationDenial,
  type CommunicationDenial,
  type InboundMessage,
  type ParsedProviderEvent,
} from "./contracts.js";
import { loadRecoveryReadPricing } from "./recoveryPolicy.js";

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Awaited<Return> : never;

// Legacy receipts predate structured binding fields. Recovery is safe only
// when this bounded provider prefix is known to contain every legacy row. If
// the extra sentinel row is present, callers leave the record waiting for
// reconciliation instead of claiming a match that may be outside the page.
const LEGACY_BINDING_RECOVERY_LIMIT = 64;

// One binding row exists per provider message in a thread, so a thread
// routinely matches several rows. Resolution reads stay exact (equality on
// the thread and inbox) and bounded; a larger horizon fails closed instead
// of sampling an arbitrary prefix.
const THREAD_BINDING_RESOLVE_LIMIT = 64;

// Retained pre-binding replies replayed per trigger. Each pass reads the
// exact waiting set (Greptile r4058523015 repair): a successful replay
// patches its retained row to observedSuccess, which removes the row from
// the waiting-state index, so the next bounded read advances past completed
// rows instead of re-sampling a completed prefix. The raw event record and
// its application outcome are preserved, never deleted. Leftovers stay
// waitingForBinding for the next trigger.
const WAITING_REPLAY_LIMIT = 8;

// Durable retained inbound snapshot cap (Greptile r4058523016 repair).
// Bodies at or below this bound are preserved byte-exact in the waiting row
// so replay re-ingests the identical content hash. Larger bodies stay waiting
// with an explicit oversized marker carrying their exact content hash, and
// resume through `resumeWaitingInbound` with the exact bytes supplied through
// the same validated interface (authorized provider read or re-delivery).
// Nothing is ever truncated into a conflicting source hash.
const WAITING_SNAPSHOT_DURABLE_MAX_BYTES = 262_144;

const lateDeliveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.recordLateDelivery>,
  MutationReturn<typeof reconciliation.recordLateDelivery>
>("execution/reconciliation:recordLateDelivery");
const quoteIngestRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.ingestProviderQuote>,
  MutationReturn<typeof quotes.ingestProviderQuote>
>("purchasing/contracts/quotes:ingestProviderQuote");
const reserveServerReadRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.reserveServerRead>,
  MutationReturn<typeof reservations.reserveServerRead>
>("execution/reservations:reserveServerRead");
const settleServerReadRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.settleServerRead>,
  MutationReturn<typeof reservations.settleServerRead>
>("execution/reservations:settleServerRead");
const recoverActionRef = makeFunctionReference<
  "action",
  { threadId: string; inboxId: string; messageId: string },
  unknown
>("communication/send:recoverOversizedInbound");
const advanceMigrationRef = makeFunctionReference<
  "mutation",
  { threadId: string; inboxId: string },
  { ok: true; state: string; verifiedReads: number; replayed: number; stillWaiting: number } | { ok: false; code: string; message: string }
>("communication/callbacks:advanceThreadMigration");
const replayWaitingSelfRef = makeFunctionReference<
  "mutation",
  { threadId: string; inboxId: string },
  | { ok: true; replayed: number; stillWaiting: number }
  | CommunicationDenial
>("communication/callbacks:replayWaitingInbound");
const settleRecoverySelfRef = makeFunctionReference<
  "mutation",
  {
    jobId: Id<"jobs">;
    reservationId: Id<"reservations">;
    threadId: string;
    inboxId: string;
    messageId: string;
    outcome: "recovered" | "unknown" | "rejected";
  },
  | { ok: true; retainedMicroUsd: number; releasedMicroUsd: number; readsSettled: number }
  | { ok: false; code: string; message: string }
>("communication/callbacks:settleRecoveryRun");
const watchdogRecoverySelfRef = makeFunctionReference<
  "mutation",
  {
    jobId: Id<"jobs">;
    reservationId: Id<"reservations">;
    threadId: string;
    inboxId: string;
    messageId: string;
  },
  | { ok: true; settled: boolean }
  | { ok: false; code: string; message: string }
>("communication/callbacks:watchdogRecoveryRun");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function denial(code: CommunicationDenial["code"], message: string): CommunicationDenial {
  return { ok: false, code, message };
}

function eventType(value: unknown): ParsedProviderEvent["eventType"] | null {
  if (
    value === "message.received" ||
    value === "message.sent" ||
    value === "message.delivered" ||
    value === "message.bounced" ||
    value === "message.complained" ||
    value === "message.rejected" ||
    value === "domain.verified"
  ) return value;
  return null;
}

function providerId(value: unknown): string | undefined {
  return isRecord(value) ? normalizedProviderId(value["message_id"]) : undefined;
}

function providerThread(value: unknown): string | undefined {
  return isRecord(value) ? normalizedProviderId(value["thread_id"]) : undefined;
}

function providerInbox(value: unknown): string | undefined {
  return isRecord(value) ? normalizedProviderId(value["inbox_id"]) : undefined;
}

function parseProviderEvent(value: unknown): ParsedProviderEvent | CommunicationDenial {
  if (!isRecord(value)) return denial("invalid-payload", "provider event is not an object");
  const eventId = value["event_id"];
  const kind = eventType(value["event_type"]);
  if (!nonEmptyString(eventId) || kind === null) return denial("invalid-payload", "provider event identity is invalid");
  const messageValue = value["message"];
  const message = kind === "message.received" && messageValue !== undefined ? parseInboundMessage(messageValue) : undefined;
  if (message !== undefined && isCommunicationDenial(message)) return message;
  const source = isRecord(messageValue)
    ? messageValue
    : value["send"] ?? value["delivery"] ?? value["bounce"] ?? value["complaint"] ?? value["reject"] ?? value["thread"];
  const messageId = providerId(source);
  const threadId = providerThread(source);
  const inboxId = providerInbox(source);
  const rawForBinding = JSON.stringify({
    messageId,
    threadId,
    inboxId,
  });
  return {
    eventId,
    eventType: kind,
    ...(messageId === undefined ? {} : { messageId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(inboxId === undefined ? {} : { inboxId }),
    ...(message !== undefined && !isCommunicationDenial(message) ? { message } : {}),
    rawForBinding,
  };
}

interface BindingFacts {
  readonly eventId?: string;
  readonly eventType?: string;
  readonly messageId?: string;
  readonly threadId?: string;
  readonly inboxId?: string;
}

interface BindingKey {
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
}

function bindingKey(
  messageId: string | undefined,
  threadId: string | undefined,
  inboxId: string | undefined,
): BindingKey | null {
  const normalizedMessageId = normalizedProviderId(messageId);
  const normalizedThreadId = normalizedProviderId(threadId);
  const normalizedInboxId = normalizedProviderId(inboxId);
  if (normalizedMessageId === undefined || normalizedThreadId === undefined || normalizedInboxId === undefined) return null;
  return { messageId: normalizedMessageId, threadId: normalizedThreadId, inboxId: normalizedInboxId };
}

function bindingValue(value: string): BindingFacts | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const eventId = normalizedProviderId(parsed["eventId"]);
    const eventType = typeof parsed["eventType"] === "string" ? parsed["eventType"] : undefined;
    const messageId = normalizedProviderId(parsed["messageId"]);
    const threadId = normalizedProviderId(parsed["threadId"]);
    const inboxId = normalizedProviderId(parsed["inboxId"]);
    return {
      ...(eventId === undefined ? {} : { eventId }),
      ...(eventType === undefined ? {} : { eventType }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(inboxId === undefined ? {} : { inboxId }),
    };
  } catch {
    return null;
  }
}

function rowBindingFacts(row: {
  readonly outcome: string;
  readonly providerMessageId?: string;
  readonly providerThreadId?: string;
  readonly providerInboxId?: string;
}): BindingFacts | null {
  const legacy = bindingValue(row.outcome);
  const structuredMessageId = normalizedProviderId(row.providerMessageId);
  const structuredThreadId = normalizedProviderId(row.providerThreadId);
  const structuredInboxId = normalizedProviderId(row.providerInboxId);
  if (
    (structuredMessageId !== undefined && legacy?.messageId !== undefined && structuredMessageId !== legacy.messageId) ||
    (structuredThreadId !== undefined && legacy?.threadId !== undefined && structuredThreadId !== legacy.threadId) ||
    (structuredInboxId !== undefined && legacy?.inboxId !== undefined && structuredInboxId !== legacy.inboxId)
  ) return null;
  const eventId = legacy?.eventId;
  const eventType = legacy?.eventType;
  const messageId = structuredMessageId ?? legacy?.messageId;
  const threadId = structuredThreadId ?? legacy?.threadId;
  const inboxId = structuredInboxId ?? legacy?.inboxId;
  if (messageId === undefined && threadId === undefined && inboxId === undefined) return null;
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(eventType === undefined ? {} : { eventType }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(inboxId === undefined ? {} : { inboxId }),
  };
}

function matchesBinding(row: {
  readonly outcome: string;
  readonly providerMessageId?: string;
  readonly providerThreadId?: string;
  readonly providerInboxId?: string;
}, expected: BindingKey): boolean {
  const facts = rowBindingFacts(row);
  return facts?.messageId === expected.messageId && facts.threadId === expected.threadId && facts.inboxId === expected.inboxId;
}

function matchesThreadAndInbox(row: {
  readonly outcome: string;
  readonly providerThreadId?: string;
  readonly providerInboxId?: string;
}, expected: BindingKey): boolean {
  const facts = rowBindingFacts(row);
  return facts?.threadId === expected.threadId && facts.inboxId === expected.inboxId;
}

function isSuccessEvent(eventType: string | undefined): boolean {
  return eventType === "message.sent" || eventType === "message.delivered";
}

function normalizedInboundMessage(message: InboundMessage): InboundMessage {
  return {
    ...message,
    messageId: normalizedProviderId(message.messageId) ?? message.messageId,
    threadId: normalizedProviderId(message.threadId) ?? message.threadId,
    inboxId: normalizedProviderId(message.inboxId) ?? message.inboxId,
  };
}

async function legacyBindingRows(ctx: F1MutationCtx, provider: string) {
  // Legacy-only recovery: rows that predate structured provider fields are
  // precisely those missing the thread/inbox index fields, so this query
  // returns only true legacy rows no matter how many structured rows share
  // the provider. More than 64 actual legacy rows stays incomplete and
  // fails closed instead of sampling.
  const rows = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", provider)
        .eq("environment", "live")
        .eq("providerThreadId", undefined)
        .eq("providerInboxId", undefined),
    )
    .take(LEGACY_BINDING_RECOVERY_LIMIT + 1);
  return {
    rows: rows.slice(0, LEGACY_BINDING_RECOVERY_LIMIT),
    complete: rows.length <= LEGACY_BINDING_RECOVERY_LIMIT,
  };
}

interface StoredBindingRow {
  readonly _id: Id<"processedEvents">;
  readonly outcome: string;
  readonly providerMessageId?: string;
  readonly providerThreadId?: string;
  readonly providerInboxId?: string;
  readonly organizationId?: Id<"organizations">;
  readonly projectId?: Id<"projects">;
  readonly operationId?: Id<"operations">;
}

async function operationForProviderMessage(
  ctx: F1MutationCtx,
  messageId: string | undefined,
  threadId: string | undefined,
  inboxId: string | undefined,
): Promise<{ operationId: Id<"operations">; token: string } | null> {
  const expected = bindingKey(messageId, threadId, inboxId);
  if (expected === null) return null;
  const indexedRows: StoredBindingRow[] = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerMessageId", expected.messageId)
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(THREAD_BINDING_RESOLVE_LIMIT + 1);
  if (indexedRows.length > THREAD_BINDING_RESOLVE_LIMIT) return null;
  // Compatible duplicates (same exact key, same operation) resolve to that
  // operation; rows pointing at different operations fail closed.
  let resolved: { operationId: Id<"operations">; token: string } | null = null;
  for (const row of indexedRows) {
    if (!matchesBinding(row, expected) || row.operationId === undefined) return null;
    const operation = await ctx.db.get(row.operationId);
    if (
      operation === null ||
      (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") ||
      operation.attemptToken === undefined
    ) return null;
    if (resolved !== null && resolved.operationId !== operation._id) return null;
    resolved = { operationId: operation._id, token: operation.attemptToken };
  }
  if (resolved !== null) return resolved;

  // Historical binding rows use eventId=messageId and keep the original
  // facts only in outcome JSON. This exact lookup is migration-safe and
  // does not inspect an arbitrary receipt prefix.
  const legacyRows: StoredBindingRow[] = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_event", (q) =>
      q.eq("provider", "agentmail-binding").eq("environment", "live").eq("eventId", expected.messageId),
    )
    .take(2);
  if (legacyRows.length > 1) return null;
  const row = legacyRows[0];
  if (row === undefined || !matchesBinding(row, expected)) return null;
  await ctx.db.patch(row._id, {
    providerMessageId: expected.messageId,
    providerThreadId: expected.threadId,
    providerInboxId: expected.inboxId,
  });
  if (row.operationId === undefined) return null;
  const operation = await ctx.db.get(row.operationId);
  if (
    operation === null ||
    (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") ||
    operation.attemptToken === undefined
  ) return null;
  return { operationId: operation._id, token: operation.attemptToken };
}

const eventResultValidator = v.union(
  v.object({ ok: v.literal(true), deduplicated: v.boolean(), applied: v.boolean(), quarantined: v.boolean() }),
  denialValidator,
);

/** Internal callback used by `onEvent` after the component's signature check. */
export const ingestEvent = f1InternalMutation({
  args: { event: v.any() },
  returns: eventResultValidator,
  handler: async (ctx, args) => {
    const parsed = parseProviderEvent(args.event);
    if (isCommunicationDenial(parsed)) return parsed;
    const existing = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", "agentmail-callback").eq("environment", "live").eq("eventId", parsed.eventId),
      )
      .unique();
    if (existing !== null) return { ok: true as const, deduplicated: true, applied: existing.applicationState === "observedSuccess", quarantined: existing.organizationId === undefined };

    const now = Date.now();
    const binding = await operationForProviderMessage(ctx, parsed.messageId, parsed.threadId, parsed.inboxId);
    const isSuccessEvent = parsed.eventType === "message.sent" || parsed.eventType === "message.delivered";
    let applied = false;
    if (binding !== null && isSuccessEvent) {
      const operation = await ctx.db.get(binding.operationId);
      if (operation?.state === "observedSuccess") {
        applied = true;
      } else {
        const late: MutationReturn<typeof reconciliation.recordLateDelivery> = await ctx.runMutation(lateDeliveryRef, {
          operationId: binding.operationId,
          token: binding.token,
          providerEventId: parsed.eventId,
          provider: "agentmail",
          environment: "live",
        });
        applied = late.ok;
      }
    }
    const boundOperation = binding === null ? null : await ctx.db.get(binding.operationId);
    await ctx.db.insert("processedEvents", {
      provider: "agentmail-callback",
      environment: "live",
      eventId: parsed.eventId,
      processingVersion: 1,
      outcome: serializeProviderEventForBinding(parsed),
      ...(parsed.messageId === undefined ? {} : { providerMessageId: parsed.messageId }),
      ...(parsed.threadId === undefined ? {} : { providerThreadId: parsed.threadId }),
      ...(parsed.inboxId === undefined ? {} : { providerInboxId: parsed.inboxId }),
      ...(binding === null ? {} : { operationId: binding.operationId }),
      ...(boundOperation === null ? {} : { organizationId: boundOperation.organizationId, projectId: boundOperation.projectId }),
      applicationOutcome: isSuccessEvent && applied ? "success" : "unknown",
      applicationState: isSuccessEvent && applied ? "observedSuccess" : "outcomeUnknown",
      ...(applied ? { appliedAt: now } : {}),
      createdAt: now,
    });
    return { ok: true as const, deduplicated: false, applied, quarantined: binding === null };
  },
});

const inboundResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    messageId: v.string(),
    deduplicated: v.boolean(),
    state: v.union(v.literal("replyReceived"), v.literal("needsReview"), v.literal("waitingForBinding")),
    evidenceId: v.union(v.id("evidence"), v.null()),
  }),
  denialValidator,
);
export { inboundResultValidator };

interface ConversationBinding {
  readonly conversationId: Id<"conversations">;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
}

/**
 * Best-effort lazy migration for threads that predate the durable thread
 * binding. Called only after a bounded scan has proven every visible
 * binding row unanimous for one conversation. Threads beyond the bounded
 * horizon are proven instead by advanceThreadMigration.
 */
async function noteThreadBinding(
  ctx: F1MutationCtx,
  expected: Pick<BindingKey, "threadId" | "inboxId">,
  binding: ConversationBinding,
  operationId: Id<"operations"> | undefined,
): Promise<"recorded" | "present" | "conflict"> {
  if (operationId === undefined) return "conflict";
  const rows = await ctx.db
    .query("threadBindings")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(2);
  if (rows.length === 0) {
    const now = Date.now();
    await ctx.db.insert("threadBindings", {
      provider: "agentmail-binding",
      environment: "live",
      providerThreadId: expected.threadId,
      providerInboxId: expected.inboxId,
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      conversationId: binding.conversationId,
      operationId,
      createdAt: now,
      updatedAt: now,
    });
    return "recorded";
  }
  const compatible = rows.every(
    (row) =>
      row.organizationId === binding.organizationId &&
      row.projectId === binding.projectId &&
      row.conversationId === binding.conversationId,
  );
  return compatible ? "present" : "conflict";
}

async function resolveBindingRowConversation(
  ctx: F1MutationCtx,
  row: StoredBindingRow,
  expected: BindingKey,
): Promise<ConversationBinding | null> {
  if (!matchesThreadAndInbox(row, expected) || row.operationId === undefined) return null;
  const operation = await ctx.db.get(row.operationId);
  if (operation === null) return null;
  const grant = await ctx.db.get(operation.grantId);
  if (
    grant === null ||
    grant.conversationId === undefined ||
    grant.organizationId !== operation.organizationId ||
    grant.projectId !== operation.projectId
  ) return null;
  const conversation = await ctx.db.get(grant.conversationId);
  if (
    conversation === null ||
    conversation.organizationId !== operation.organizationId ||
    conversation.projectId !== operation.projectId
  ) return null;
  return { conversationId: grant.conversationId, organizationId: operation.organizationId, projectId: operation.projectId };
}
async function conversationForMessage(
  ctx: F1MutationCtx,
  message: Pick<InboundMessage, "messageId" | "threadId" | "inboxId">,
): Promise<ConversationBinding | null> {
  const expected = bindingKey(message.messageId, message.threadId, message.inboxId);
  if (expected === null) return null;
  // Durable thread identity (Greptile r4058523017 repair): one exact indexed
  // read resolves the thread no matter how many binding rows it holds.
  // Compatible rows share this identity; conflicts were denied at bind time.
  // Compatible duplicate identity rows resolve; conflicting ones fail closed.
  const durableRows = await ctx.db
    .query("threadBindings")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(2);
  const durable = durableRows.length === 1
    ? durableRows[0]
    : durableRows.length === 2 &&
      durableRows[0] !== undefined && durableRows[1] !== undefined &&
      durableRows[0].organizationId === durableRows[1].organizationId &&
      durableRows[0].projectId === durableRows[1].projectId &&
      durableRows[0].conversationId === durableRows[1].conversationId
    ? durableRows[0]
    : undefined;
  if (durableRows.length === 2 && durable === undefined) return null;
  if (durable !== undefined) {
    const conversation = await ctx.db.get(durable.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== durable.organizationId ||
      conversation.projectId !== durable.projectId
    ) return null;
    return {
      conversationId: durable.conversationId,
      organizationId: durable.organizationId,
      projectId: durable.projectId,
    };
  }
  const indexedRows: StoredBindingRow[] = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(THREAD_BINDING_RESOLVE_LIMIT + 1);
  if (indexedRows.length > THREAD_BINDING_RESOLVE_LIMIT) {
    // The bounded horizon cannot prove this thread. Kick off the resumable
    // migration, which eventually proves one identity or fails closed, and
    // keep failing closed for this trigger.
    await maybeScheduleThreadMigration(ctx, expected.threadId, expected.inboxId);
    return null;
  }
  // Legacy fallback for threads that predate the durable thread binding.
  // Several binding rows routinely share one thread (one per provider
  // message). Compatible rows that resolve to the same conversation return
  // it; rows implying different conversations fail closed. Threads that
  // outgrow this bounded horizon resolve through the durable binding above.
  let resolved: ConversationBinding | null = null;
  let resolvedOperationId: Id<"operations"> | undefined = undefined;
  for (const row of indexedRows) {
    const single = await resolveBindingRowConversation(ctx, row, expected);
    if (single === null) return null;
    if (
      resolved !== null &&
      (resolved.conversationId !== single.conversationId ||
        resolved.organizationId !== single.organizationId ||
        resolved.projectId !== single.projectId)
    ) return null;
    resolved = single;
    if (resolvedOperationId === undefined) resolvedOperationId = row.operationId;
  }
  if (resolved !== null) {
    // A unanimous bounded horizon earns its durable identity; a conflicting
    // identity recorded concurrently fails closed.
    const noted = await noteThreadBinding(ctx, expected, resolved, resolvedOperationId);
    if (noted === "conflict") return null;
    return resolved;
  }
  // Old binding rows have no indexed thread/inbox facts. Recovery is only
  // accepted when the bounded provider prefix is complete; otherwise the
  // inbound event stays in waitingForBinding for explicit reconciliation.
  const legacy = await legacyBindingRows(ctx, "agentmail-binding");
  if (!legacy.complete) return null;
  const matches = legacy.rows.filter((candidate) => matchesThreadAndInbox(candidate, expected));
  if (matches.length !== 1) return null;
  const candidate = matches[0];
  if (candidate === undefined) return null;
  const facts = rowBindingFacts(candidate);
  if (facts === null || facts.messageId === undefined || facts.threadId === undefined || facts.inboxId === undefined) return null;
  await ctx.db.patch(candidate._id, {
    providerMessageId: facts.messageId,
    providerThreadId: facts.threadId,
    providerInboxId: facts.inboxId,
  });
  const migrated = await resolveBindingRowConversation(ctx, candidate, expected);
  if (migrated === null) return null;
  const noted = await noteThreadBinding(ctx, expected, migrated, candidate.operationId);
  if (noted === "conflict") return null;
  return migrated;
}

interface WaitingInboundSnapshot {
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
  readonly from: string;
  readonly text: string;
  readonly html: string;
  readonly timestamp: number;
  readonly attachmentCount: number;
}

/**
 * Bounded snapshot of a retained pre-binding reply. Bodies within the
 * durable bound are preserved byte-exact; larger bodies are never truncated
 * into a conflicting source hash. They stay waiting with an explicit
 * oversized marker (exact content hash plus byte size) for the
 * `resumeWaitingInbound` recovery path.
 */
function waitingSnapshotOf(message: InboundMessage): WaitingInboundSnapshot | null {
  const bytes = new TextEncoder().encode(message.text).byteLength + new TextEncoder().encode(message.html).byteLength;
  if (bytes > WAITING_SNAPSHOT_DURABLE_MAX_BYTES) return null;
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    inboxId: message.inboxId,
    from: message.from,
    text: message.text,
    html: message.html,
    timestamp: message.timestamp,
    attachmentCount: message.attachments.length,
  };
}

function parseWaitingSnapshot(value: unknown): WaitingInboundSnapshot | null {
  if (!isRecord(value)) return null;
  const snapshot = value["snapshot"];
  if (!isRecord(snapshot)) return null;
  const messageId = normalizedProviderId(snapshot["messageId"]);
  const threadId = normalizedProviderId(snapshot["threadId"]);
  const inboxId = normalizedProviderId(snapshot["inboxId"]);
  const from = typeof snapshot["from"] === "string" ? snapshot["from"] : undefined;
  const text = typeof snapshot["text"] === "string" ? snapshot["text"] : undefined;
  const html = typeof snapshot["html"] === "string" ? snapshot["html"] : undefined;
  const timestamp = typeof snapshot["timestamp"] === "number" ? snapshot["timestamp"] : undefined;
  const attachmentCount = typeof snapshot["attachmentCount"] === "number" ? snapshot["attachmentCount"] : undefined;
  if (
    messageId === undefined || threadId === undefined || inboxId === undefined ||
    from === undefined || text === undefined || html === undefined || timestamp === undefined ||
    attachmentCount === undefined || !Number.isInteger(attachmentCount) || attachmentCount < 0
  ) return null;
  return { messageId, threadId, inboxId, from, text, html, timestamp, attachmentCount };
}

function inboundContentHash(message: Pick<InboundMessage, "messageId" | "text" | "html">): string {
  return payloadHash({ messageId: message.messageId, text: message.text, html: message.html });
}

/**
 * Resolve a source marker to its exact evidence row through the durable
 * marker link. Legacy markers without the link use one exact content-hash
 * lookup; zero or several matches fail closed instead of scanning a project
 * evidence prefix.
 */
async function resolveMarkerEvidence(
  ctx: F1MutationCtx,
  binding: ConversationBinding,
  marker: { readonly sourceEvidenceId?: Id<"evidence"> },
  parsed: Pick<InboundMessage, "messageId" | "text" | "html">,
): Promise<Id<"evidence"> | CommunicationDenial> {
  const expectedHash = inboundContentHash(parsed);
  if (marker.sourceEvidenceId !== undefined) {
    const evidence = await ctx.db.get(marker.sourceEvidenceId);
    if (
      evidence === null ||
      evidence.organizationId !== binding.organizationId ||
      evidence.projectId !== binding.projectId ||
      evidence.contentHash !== expectedHash
    ) {
      return denial("invalid-payload", "replayed message conflicts with the stored source");
    }
    return evidence._id;
  }
  const rows = await ctx.db
    .query("evidence")
    .withIndex("by_project_and_contentHash", (q) =>
      q.eq("projectId", binding.projectId).eq("contentHash", expectedHash),
    )
    .take(2);
  if (rows.length !== 1) {
    return denial("invalid-payload", "replayed message conflicts with the stored source");
  }
  const evidence = rows[0];
  if (evidence === undefined || evidence.organizationId !== binding.organizationId) {
    return denial("invalid-payload", "replayed message conflicts with the stored source");
  }
  return evidence._id;
}

type BoundIngestResult =
  | {
      readonly ok: true;
      readonly messageId: string;
      readonly deduplicated: boolean;
      readonly state: "replyReceived" | "needsReview";
      readonly evidenceId: Id<"evidence"> | null;
    }
  | CommunicationDenial;

/**
 * Shared bound-ingest core used by the live callback and by the waiting
 * replay. Marker idempotency makes replay safe: a retained reply takes
 * effect exactly once with no duplicate evidence or quote input.
 */
async function ingestBoundMessage(
  ctx: F1MutationCtx,
  parsed: InboundMessage,
  binding: ConversationBinding,
): Promise<BoundIngestResult> {
  const configRows = await ctx.db
    .query("recipientConfigs")
    .withIndex("by_active", (q) => q.eq("active", true))
    .take(2);
  const config = configRows.length === 1 ? configRows[0] : undefined;
  const fromMatches = config !== undefined && normalizeMailbox(parsed.from) === normalizeMailbox(config.mailboxNormalized);
  const content = sanitizeInboundContent(parsed);
  const sourceVersion = !fromMatches || content.needsReview ? "source:1:review" : "source:1";
  const key = `agentmail:${parsed.messageId}:source:1`;
  const markerRows = await ctx.db
    .query("productEvidence")
    .withIndex("by_project_and_key", (q) => q.eq("projectId", binding.projectId).eq("idempotencyKey", key))
    .take(2);
  if (markerRows.length > 1) return denial("invalid-payload", "duplicate extraction markers detected");
  if (markerRows[0] !== undefined) {
    const resolved = await resolveMarkerEvidence(ctx, binding, markerRows[0], parsed);
    if (isCommunicationDenial(resolved)) return resolved;
    return {
      ok: true as const,
      messageId: parsed.messageId,
      deduplicated: true,
      state: content.needsReview || !fromMatches ? "needsReview" as const : "replyReceived" as const,
      evidenceId: resolved,
    };
  }
  const attachmentCount = parsed.attachments.length;
  const hasText = parsed.text.length > 0 || parsed.html.length > 0;
  // C1 has no approved inbound-attachment byte store, so a message carrying
  // attachments is never labeled complete even when its text survived. The
  // gap stays explicit through the missing-attachment marker below.
  const completeness = hasText && attachmentCount === 0 ? "complete" : "partial";
  const contentHash = inboundContentHash(parsed);
  const evidenceId = await ctx.db.insert("evidence", {
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    sourceKind: "agentmail.message",
    providerIds: JSON.stringify({ messageId: parsed.messageId, threadId: parsed.threadId, inboxId: parsed.inboxId }),
    capturedAt: parsed.timestamp,
    contentHash,
    completeness,
    counterpartyRole: "ownerStandIn",
    // Controlled demo evidence, never genuine vendor evidence: the content
    // is owner-authored supplier terms. Live transport stays proven
    // separately by the provider callback receipt and operation outcome.
    executionMode: "recorded",
    locator: `redacted:${contentHash}`,
  });
  await ctx.db.insert("productEvidence", {
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    field: "agentmail.message",
    sourceKind: "agentmail.message",
    capturedAt: parsed.timestamp,
    originalValue: content.text.slice(0, 8_000),
    normalizedValue: content.text.slice(0, 8_000),
    verification: "unverified",
    freshness: "fresh",
    counterpartyRole: "ownerStandIn",
    executionMode: "recorded",
    origin: "ownerImport",
    conflictEvidenceIds: [],
    idempotencyKey: key,
    ingestionIdentity: `${parsed.messageId}:source:1`,
    sourceEvidenceId: evidenceId,
    version: sourceVersion,
    createdAt: Date.now(),
  });
  if (attachmentCount > 0) {
    await ctx.db.insert("productEvidence", {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      field: "missing:attachment",
      sourceKind: "agentmail.message",
      capturedAt: parsed.timestamp,
      originalValue: "unknown",
      normalizedValue: "unknown",
      verification: "unverified",
      freshness: "unknown",
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
      origin: "ownerImport",
      conflictEvidenceIds: [],
      idempotencyKey: `${key}:missing:attachment`,
      ingestionIdentity: `${parsed.messageId}:missing:attachment`,
      version: sourceVersion,
      createdAt: Date.now(),
    });
  }
  const conversation = await ctx.db.get(binding.conversationId);
  if (conversation === null) return denial("invalid-payload", "conversation binding disappeared");
  // F04: any verified owner reply retires stale follow-up authority by
  // advancing the conversation version. The bump happens for review-gated
  // content too; only the replyReceived state waits for clean content.
  const verifiedReply = fromMatches && conversation.state !== "cancelled" && conversation.state !== "closed";
  if (verifiedReply) {
    await ctx.db.patch(binding.conversationId, {
      version: conversation.version + 1,
      ...(content.needsReview ? {} : { state: "replyReceived" }),
      lastReplyAt: parsed.timestamp,
      updatedAt: Date.now(),
    });
  }
  return {
    ok: true as const,
    messageId: parsed.messageId,
    deduplicated: false,
    state: verifiedReply && !content.needsReview ? "replyReceived" as const : "needsReview" as const,
    evidenceId,
  };
}

interface WaitingOversizedMarker {
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
  readonly reason: string;
  readonly snapshotOversized: true;
  readonly contentHash: string;
  readonly byteSize: number;
  /** Provider-read attempts already claimed against this row (default 0). */
  readonly recoveryAttempts: number;
  readonly recoveryJobId?: string;
  readonly recoveryReservationId?: string;
  /** Claimed reads when the current run was admitted; settlement counts only above this baseline. */
  readonly recoveryRunStartAttempts?: number;
  /** Watchdog retry executions already scheduled for a failed settlement. */
  readonly watchdogAttempts?: number;
}

function inboundBodyBytes(message: Pick<InboundMessage, "text" | "html">): number {
  return new TextEncoder().encode(message.text).byteLength + new TextEncoder().encode(message.html).byteLength;
}

function parseWaitingOversizedMarker(value: unknown): WaitingOversizedMarker | null {
  if (!isRecord(value) || value["snapshotOversized"] !== true) return null;
  const messageId = normalizedProviderId(value["messageId"]);
  const threadId = normalizedProviderId(value["threadId"]);
  const inboxId = normalizedProviderId(value["inboxId"]);
  const reason = typeof value["reason"] === "string" ? value["reason"] : undefined;
  const contentHash = typeof value["contentHash"] === "string" ? value["contentHash"] : undefined;
  const byteSize = typeof value["byteSize"] === "number" ? value["byteSize"] : undefined;
  if (
    messageId === undefined || threadId === undefined || inboxId === undefined ||
    reason === undefined || contentHash === undefined || byteSize === undefined ||
    !Number.isInteger(byteSize) || byteSize <= WAITING_SNAPSHOT_DURABLE_MAX_BYTES
  ) return null;
  const recoveryAttempts = value["recoveryAttempts"];
  if (
    recoveryAttempts !== undefined &&
    (typeof recoveryAttempts !== "number" || !Number.isInteger(recoveryAttempts) || recoveryAttempts < 0)
  ) return null;
  const recoveryJobId = value["recoveryJobId"];
  const recoveryReservationId = value["recoveryReservationId"];
  if (recoveryJobId !== undefined && (typeof recoveryJobId !== "string" || recoveryJobId.length === 0)) return null;
  if (recoveryReservationId !== undefined && (typeof recoveryReservationId !== "string" || recoveryReservationId.length === 0)) return null;
  const recoveryRunStartAttempts = value["recoveryRunStartAttempts"];
  if (
    recoveryRunStartAttempts !== undefined &&
    (typeof recoveryRunStartAttempts !== "number" ||
      !Number.isInteger(recoveryRunStartAttempts) ||
      recoveryRunStartAttempts < 0)
  ) return null;
  const watchdogAttempts = value["watchdogAttempts"];
  if (
    watchdogAttempts !== undefined &&
    (typeof watchdogAttempts !== "number" || !Number.isInteger(watchdogAttempts) || watchdogAttempts < 0)
  ) return null;
  return {
    messageId,
    threadId,
    inboxId,
    reason,
    snapshotOversized: true as const,
    contentHash,
    byteSize,
    recoveryAttempts: typeof recoveryAttempts === "number" ? recoveryAttempts : 0,
    ...(recoveryJobId === undefined ? {} : { recoveryJobId }),
    ...(recoveryReservationId === undefined ? {} : { recoveryReservationId }),
    ...(recoveryRunStartAttempts === undefined ? {} : { recoveryRunStartAttempts }),
    ...(watchdogAttempts === undefined ? {} : { watchdogAttempts }),
  };
}

async function replayWaitingForThread(
  ctx: F1MutationCtx,
  threadId: string,
  inboxId: string,
): Promise<{ readonly replayed: number; readonly stillWaiting: number }> {
  // Fair-progress repair (Greptile r4058523015 follow-up). Each trigger
  // reads exactly one bounded page of the exact waiting-state index and
  // persists the positional continuation cursor, so permanently
  // unprocessable rows cannot permanently hide later valid replies: the
  // horizon rotates across triggers instead of re-sampling one fixed
  // prefix. Completed rows leave the waiting set on success, so the set
  // only shrinks; marker idempotency keeps concurrent triggers to exactly
  // one effect per source. At most WAITING_REPLAY_LIMIT ingests happen per
  // trigger. stillWaiting counts evaluated-but-unapplied rows in this page,
  // plus one when another page remains (at least one further waiting row
  // exists then, since the page query itself is the waiting set).
  const cursorRow = await ctx.db
    .query("threadReplayCursors")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-inbound")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .unique();
  const page = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_thread_inbox_and_state", (q) =>
      q
        .eq("provider", "agentmail-inbound")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId)
        .eq("applicationState", "outcomeUnknown"),
    )
    .order("asc")
    .paginate({ cursor: cursorRow?.cursor ?? null, numItems: WAITING_REPLAY_LIMIT });
  let replayed = 0;
  let stillWaiting = 0;
  let ingests = 0;
  for (const row of page.page) {
    const stored = parseWaitingSnapshot(parseObject(row.outcome));
    if (
      stored === null ||
      stored.threadId !== threadId ||
      stored.inboxId !== inboxId ||
      row.providerMessageId === undefined ||
      stored.messageId !== row.providerMessageId
    ) {
      const oversized = parseWaitingOversizedMarker(parseObject(row.outcome));
      if (
        oversized !== null &&
        oversized.threadId === threadId &&
        oversized.inboxId === inboxId &&
        row.providerMessageId !== undefined &&
        oversized.messageId === row.providerMessageId &&
        oversized.recoveryAttempts < MAX_RECONCILIATION_READS
      ) {
        // Durable scheduling: the recovery action gates, claims, reads,
        // and settles; attempts are shared, so concurrent triggers cannot
        // exceed the bound.
        await ctx.scheduler.runAfter(0, recoverActionRef, {
          threadId,
          inboxId,
          messageId: oversized.messageId,
        });
      }
      stillWaiting += 1;
      continue;
    }
    const binding = await conversationForMessage(ctx, stored);
    if (binding === null || ingests >= WAITING_REPLAY_LIMIT) {
      stillWaiting += 1;
      continue;
    }
    const result = await ingestBoundMessage(
      ctx,
      {
        ...stored,
        to: [],
        cc: [],
        subject: "",
        references: [],
        attachments: Array.from({ length: stored.attachmentCount }),
      },
      binding,
    );
    if (!result.ok) {
      stillWaiting += 1;
      continue;
    }
    ingests += 1;
    // Patching to observedSuccess removes the row from the waiting-state
    // index while preserving the raw event record and its outcome. Marker
    // idempotency keeps a concurrent trigger's duplicate ingest to exactly
    // one effect.
    await ctx.db.patch(row._id, {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      applicationOutcome: "success",
      applicationState: "observedSuccess",
      appliedAt: Date.now(),
    });
    replayed += 1;
  }
  if (page.isDone) {
    if (cursorRow !== null) await ctx.db.delete(cursorRow._id);
  } else {
    stillWaiting += 1;
    const now = Date.now();
    if (cursorRow === null) {
      await ctx.db.insert("threadReplayCursors", {
        provider: "agentmail-inbound",
        environment: "live",
        providerThreadId: threadId,
        providerInboxId: inboxId,
        cursor: page.continueCursor,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(cursorRow._id, { cursor: page.continueCursor, updatedAt: now });
    }
  }
  return { replayed, stillWaiting };
}

/**
 * Internal callback used by `onMessageReceived`. It stores an immutable
 * redacted evidence snapshot, advances only the bound conversation, and
 * leaves extraction as a separate versioned operation.
 */
export const ingestMessage = f1InternalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: inboundResultValidator,
  handler: async (ctx, args) => {
    const parsedValue = parseInboundMessage(args.message);
    if (isCommunicationDenial(parsedValue)) return parsedValue;
    const parsed = normalizedInboundMessage(parsedValue);
    if (
      isRecord(args.thread) &&
      normalizedProviderId(args.thread["thread_id"]) !== undefined &&
      normalizedProviderId(args.thread["thread_id"]) !== parsed.threadId
    ) {
      return denial("invalid-payload", "inbound message and thread identifiers conflict");
    }
    const binding = await conversationForMessage(ctx, parsed);
    if (binding === null) {
      // Exact full-identity dedupe: the same provider message retained under
      // a different event id must not create a second waiting row.
      const retained = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
          q
            .eq("provider", "agentmail-inbound")
            .eq("environment", "live")
            .eq("providerMessageId", parsed.messageId)
            .eq("providerThreadId", parsed.threadId)
            .eq("providerInboxId", parsed.inboxId),
        )
        .take(2);
      if (retained.length > 0) {
        return { ok: true as const, messageId: parsed.messageId, deduplicated: true, state: "waitingForBinding" as const, evidenceId: null };
      }
      const snapshot = waitingSnapshotOf(parsed);
      const snapshotBytes = inboundBodyBytes(parsed);
      await ctx.db.insert("processedEvents", {
        provider: "agentmail-inbound",
        environment: "live",
        eventId: args.eventId,
        processingVersion: 1,
        outcome: JSON.stringify({
          messageId: parsed.messageId,
          threadId: parsed.threadId,
          inboxId: parsed.inboxId,
          reason: "no verified conversation binding",
          // Oversized bodies keep their exact content hash and byte size so
          // `resumeWaitingInbound` can verify the exact bytes later. The
          // full content is never truncated into a conflicting source hash.
          ...(snapshot === null
            ? { snapshotOversized: true, contentHash: inboundContentHash(parsed), byteSize: snapshotBytes }
            : { snapshot }),
        }),
        providerMessageId: parsed.messageId,
        providerThreadId: parsed.threadId,
        providerInboxId: parsed.inboxId,
        applicationOutcome: "unknown",
        applicationState: "outcomeUnknown",
        createdAt: Date.now(),
      });
      return { ok: true as const, messageId: parsed.messageId, deduplicated: false, state: "waitingForBinding" as const, evidenceId: null };
    }
    // Retained pre-binding replies take effect exactly once before newer
    // content. The replay is bounded and marker-idempotent.
    await replayWaitingForThread(ctx, parsed.threadId, parsed.inboxId);
    const result = await ingestBoundMessage(ctx, parsed, binding);
    if (isCommunicationDenial(result)) return result;
    return {
      ok: true as const,
      messageId: result.messageId,
      deduplicated: result.deduplicated,
      state: result.state,
      evidenceId: result.evidenceId,
    };
  },
});

/**
 * Bounded S-15 repair: replay retained pre-binding replies once their
 * conversation binding exists. Marker idempotency keeps the replay to one
 * evidence snapshot and one extraction input per source and version.
 */
export const replayWaitingInbound = f1InternalMutation({
  args: { threadId: v.string(), inboxId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), replayed: v.number(), stillWaiting: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    if (threadId === undefined || inboxId === undefined) {
      return denial("invalid-payload", "thread and inbox identifiers are required");
    }
    const result = await replayWaitingForThread(ctx, threadId, inboxId);
    return { ok: true as const, replayed: result.replayed, stillWaiting: result.stillWaiting };
  },
});

/**
 * Typed provider-message projection for the oversized resume path. The
 * authorized provider-read adapter projects the redelivered payload to
 * exactly these documented fields before calling; anything else is rejected
 * at the boundary and the nested content is still validated by
 * `parseInboundMessage` before any product change.
 */
const resumeMessageValidator = v.object({
  message_id: v.string(),
  thread_id: v.string(),
  inbox_id: v.string(),
  from: v.string(),
  to: v.optional(v.union(v.string(), v.array(v.string()))),
  cc: v.optional(v.union(v.string(), v.array(v.string()))),
  subject: v.optional(v.string()),
  text: v.optional(v.string()),
  html: v.optional(v.string()),
  timestamp: v.optional(v.union(v.number(), v.string())),
  references: v.optional(v.array(v.string())),
  in_reply_to: v.optional(v.string()),
  attachments: v.optional(v.array(v.record(v.string(), v.string()))),
});

/**
 * Authorized resume path for an oversized retained reply (Greptile r4058523016
 * repair). The caller supplies the exact inbound bytes through the same
 * validated provider interface used by the live callback — an authorized
 * provider read or a re-delivered webhook payload — and this mutation
 * verifies them against the retained content hash before ingesting through
 * the identical bound-ingest core. Mismatched bytes fail closed; success is
 * never claimed without the exact bytes.
 */
export const resumeWaitingInbound = f1InternalMutation({
  args: { message: resumeMessageValidator, eventId: v.string() },
  returns: inboundResultValidator,
  handler: async (ctx, args) => {
    const parsedValue = parseInboundMessage(args.message);
    if (isCommunicationDenial(parsedValue)) return parsedValue;
    const parsed = normalizedInboundMessage(parsedValue);
    const retained = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-inbound")
          .eq("environment", "live")
          .eq("providerMessageId", parsed.messageId)
          .eq("providerThreadId", parsed.threadId)
          .eq("providerInboxId", parsed.inboxId),
      )
      .take(2);
    if (retained.length !== 1) {
      return denial("invalid-payload", "no single retained oversized reply matches this message");
    }
    const row = retained[0];
    if (row === undefined) return denial("invalid-payload", "retained reply is not available");
    if (row.applicationState === "observedSuccess") {
      const binding = await conversationForMessage(ctx, parsed);
      if (binding === null) {
        return { ok: true as const, messageId: parsed.messageId, deduplicated: true, state: "waitingForBinding" as const, evidenceId: null };
      }
      const result = await ingestBoundMessage(ctx, parsed, binding);
      if (isCommunicationDenial(result)) return result;
      return {
        ok: true as const,
        messageId: result.messageId,
        deduplicated: true,
        state: result.state,
        evidenceId: result.evidenceId,
      };
    }
    const marker = parseWaitingOversizedMarker(parseObject(row.outcome));
    if (marker === null) {
      return denial("invalid-payload", "retained reply is not oversized; use the standard replay");
    }
    if (inboundBodyBytes(parsed) !== marker.byteSize || inboundContentHash(parsed) !== marker.contentHash) {
      return denial("invalid-payload", "resumed bytes conflict with the retained source");
    }
    const binding = await conversationForMessage(ctx, parsed);
    if (binding === null) {
      return { ok: true as const, messageId: parsed.messageId, deduplicated: false, state: "waitingForBinding" as const, evidenceId: null };
    }
    const result = await ingestBoundMessage(ctx, parsed, binding);
    if (isCommunicationDenial(result)) return result;
    // Patching to observedSuccess removes the row from the waiting-state
    // index while preserving the raw event record and its outcome.
    await ctx.db.patch(row._id, {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      applicationOutcome: "success",
      applicationState: "observedSuccess",
      appliedAt: Date.now(),
    });
    return {
      ok: true as const,
      messageId: result.messageId,
      deduplicated: result.deduplicated,
      state: result.state,
      evidenceId: result.evidenceId,
    };
  },
});

/**
 * Authority gate for the bounded provider-read recovery (S-15). Verifies
 * that exactly one oversized retained reply waits for the given identity,
 * that its thread resolves to a live conversation, that the owning grant is
 * still active and unexpired, and that owner-configured read pricing
 * exists. It then admits one recovery run: a server-owned execution job
 * plus one explicit reservation sized for the remaining read budget under
 * the canonical reconciliation pricing basis. A valid open run is reused
 * instead of admitted twice. No provider call may happen before this gate
 * passes; denied gates cause zero HTTP reads.
 */
export const prepareOversizedRecovery = f1InternalMutation({
  args: { threadId: v.string(), inboxId: v.string(), messageId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      jobId: v.id("jobs"),
      reservationId: v.id("reservations"),
      readsRemaining: v.number(),
      readCostMicroUsd: v.number(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    const messageId = normalizedProviderId(args.messageId);
    if (threadId === undefined || inboxId === undefined || messageId === undefined) {
      return denial("invalid-payload", "thread, inbox, and message identifiers are required");
    }
    const retained = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-inbound")
          .eq("environment", "live")
          .eq("providerMessageId", messageId)
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .take(2);
    if (retained.length !== 1) {
      return denial("invalid-payload", "no single retained oversized reply matches this message");
    }
    const row = retained[0];
    if (row === undefined || row.applicationState !== "outcomeUnknown") {
      return denial("invalid-payload", "retained reply is not waiting for recovery");
    }
    const marker = parseWaitingOversizedMarker(parseObject(row.outcome));
    if (marker === null) {
      return denial("invalid-payload", "retained reply is not oversized; use the standard replay");
    }
    if (marker.recoveryAttempts >= MAX_RECONCILIATION_READS) {
      return { ok: false as const, code: "recovery-attempts-exhausted", message: "recovery read budget is exhausted" };
    }
    const binding = await conversationForMessage(ctx, { messageId, threadId, inboxId });
    if (binding === null) {
      return denial("invalid-payload", "thread has no verified conversation binding");
    }
    const conversation = await ctx.db.get(binding.conversationId);
    if (
      conversation === null ||
      conversation.state === "cancelled" ||
      conversation.state === "closed"
    ) return denial("invalid-payload", "conversation is not available for recovery");
    const grant = await ctx.db.get(conversation.grantId);
    if (
      grant === null ||
      grant.organizationId !== binding.organizationId ||
      grant.projectId !== binding.projectId ||
      grant.status !== "active" ||
      grant.expiresAt <= Date.now()
    ) {
      return denial("alternate-channel-denied", "communication grant is not active for recovery");
    }
    const pricing = loadRecoveryReadPricing();
    if (!pricing.ok) {
      return { ok: false as const, code: "invalid-pricing-config", message: pricing.message };
    }
    const readsRemaining = MAX_RECONCILIATION_READS - marker.recoveryAttempts;
    const amount = readsRemaining * pricing.pricing.readCostMicroUsd;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return denial("invalid-payload", "recovery read budget overflow");
    }
    // Reuse a valid open run instead of admitting twice. Stored identifiers
    // are normalized through the table binding and fail closed on null.
    // Accounting is run-relative: the reservation lifetime total must equal
    // exactly the capacity admitted for this run — (MAX minus the run's
    // start baseline) reads at the current unit cost — and must still cover
    // the reads claimed since that baseline. A rotated run therefore never
    // re-retains reads an earlier run already settled, and a crashed run
    // with an intact open reservation reuses it instead of stranding it
    // beside a second open reservation.
    if (marker.recoveryJobId !== undefined && marker.recoveryReservationId !== undefined) {
      const storedJobId = ctx.db.normalizeId("jobs", marker.recoveryJobId);
      const storedReservationId = ctx.db.normalizeId("reservations", marker.recoveryReservationId);
      const job = storedJobId === null ? null : await ctx.db.get(storedJobId);
      const reservation = storedReservationId === null ? null : await ctx.db.get(storedReservationId);
      const baseline = marker.recoveryRunStartAttempts ?? 0;
      const runClaims = marker.recoveryAttempts - baseline;
      const expectedCapacity = (MAX_RECONCILIATION_READS - baseline) * pricing.pricing.readCostMicroUsd;
      const lifetimeTotal = (reservation?.reservedMicroUsd ?? -1) +
        (reservation?.unresolvedMicroUsd ?? -1) +
        (reservation?.spentMicroUsd ?? -1);
      if (baseline < 0 || baseline > marker.recoveryAttempts || marker.recoveryAttempts > MAX_RECONCILIATION_READS) {
        return denial("invalid-payload", "recovery accounting baseline is inconsistent");
      }
      if (
        !Number.isSafeInteger(expectedCapacity) ||
        expectedCapacity <= 0 ||
        !Number.isSafeInteger(runClaims) ||
        runClaims < 0
      ) {
        return denial("invalid-payload", "recovery accounting baseline is inconsistent");
      }
      if (
        job !== null &&
        job.organizationId === binding.organizationId &&
        job.projectId === binding.projectId &&
        job.grantId === grant._id &&
        job.state !== "cancelled" &&
        job.state !== "cancelling" &&
        reservation !== null &&
        reservation.organizationId === binding.organizationId &&
        reservation.jobId === job._id &&
        reservation.state === "open" &&
        reservation.pricingBasis === pricing.pricing.basis &&
        lifetimeTotal === expectedCapacity &&
        lifetimeTotal >= runClaims * pricing.pricing.readCostMicroUsd
      ) {
        // Admission watchdog: a crash after this admission but before any
        // claim or settlement must still release the run. A normally
        // completed run makes the firing a harmless no-op.
        await ctx.scheduler.runAfter(RECOVERY_ADMISSION_WATCHDOG_DELAY_MS, watchdogRecoverySelfRef, {
          jobId: job._id,
          reservationId: reservation._id,
          threadId,
          inboxId,
          messageId,
        });
        return {
          ok: true as const,
          jobId: job._id,
          reservationId: reservation._id,
          readsRemaining,
          readCostMicroUsd: pricing.pricing.readCostMicroUsd,
        };
      }
      // A referenced prior run that has not settled blocks rotation: admit
      // no second open reservation beside it. Old watchdogs keep settling
      // the old run through the same checks; only a closed or missing
      // prior run may rotate. Fail closed until then.
      if (reservation !== null && reservation.state !== "closed") {
        return { ok: false as const, code: "unknown-charges-reserved", message: "prior recovery run is still open" };
      }
    }
    const grantJobs = await ctx.db
      .query("jobs")
      .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
      .take(MAX_JOBS_PER_GRANT + 1);
    if (grantJobs.length > MAX_JOBS_PER_GRANT) {
      return { ok: false as const, code: "operation-admission-limit", message: "grant job admission limit reached" };
    }
    const now = Date.now();
    const jobId = await ctx.db.insert("jobs", {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      grantId: grant._id,
      grantVersion: grant.revocationVersion,
      kind: "execution",
      workflowPurpose: "purchasingCommunication",
      state: "running",
      inputVersions: { ...grant.inputVersions },
      createdAt: now,
      updatedAt: now,
    });
    const reserved: MutationReturn<typeof reservations.reserveServerRead> = await ctx.runMutation(reserveServerReadRef, {
      jobId,
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      grantId: grant._id,
      amountMicroUsd: amount,
      pricingBasis: pricing.pricing.basis,
    });
    if (!reserved.ok) {
      // A denied admission must not orphan a running job: remove the run
      // this gate just created so no ownerless execution row remains.
      await ctx.db.delete(jobId);
      return reserved;
    }
    const outcomeValue = parseObject(row.outcome);
    await ctx.db.patch(row._id, {
      outcome: JSON.stringify({
        ...(isRecord(outcomeValue) ? outcomeValue : {}),
        recoveryJobId: jobId,
        recoveryReservationId: reserved.reservationId,
        // Per-run baseline: settlement later counts only reads claimed at
        // or above this mark, so a rotated run never re-retains reads an
        // earlier run already settled. Watchdog retries reset: a new run
        // gets its own finite retry budget instead of inheriting the old
        // run's consumed attempts.
        recoveryRunStartAttempts: marker.recoveryAttempts,
        watchdogAttempts: 0,
      }),
    });
    // Admission watchdog: a crash after this admission but before any
    // claim or settlement must still release the zero-claim reservation.
    // A normally completed run makes this firing a harmless no-op.
    await ctx.scheduler.runAfter(RECOVERY_ADMISSION_WATCHDOG_DELAY_MS, watchdogRecoverySelfRef, {
      jobId,
      reservationId: reserved.reservationId,
      threadId,
      inboxId,
      messageId,
    });
    return {
      ok: true as const,
      jobId,
      reservationId: reserved.reservationId,
      readsRemaining,
      readCostMicroUsd: pricing.pricing.readCostMicroUsd,
    };
  },
});

/**
 * Claim one recovery read before dispatch (claim-before-read, mirroring the
 * dispatch claim). The claim binds to the admitted run: the waiting row
 * must still reference this exact job and reservation, and that reservation
 * must still be open. A watchdog (or a concurrent run) that already settled
 * therefore denies every later claim before any HTTP read, so a closed run
 * can never fund another provider read. The atomic check-and-increment
 * keeps total reads at or below the bound across crashes and concurrent
 * runs: a crash after a claim only ever reduces future reads. Each claim
 * revalidates the live conversation and grant, so revoked authority stops
 * the next read.
 */
export const claimRecoveryRead = f1InternalMutation({
  args: {
    threadId: v.string(),
    inboxId: v.string(),
    messageId: v.string(),
    jobId: v.id("jobs"),
    reservationId: v.id("reservations"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), attemptNumber: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    const messageId = normalizedProviderId(args.messageId);
    if (threadId === undefined || inboxId === undefined || messageId === undefined) {
      return denial("invalid-payload", "thread, inbox, and message identifiers are required");
    }
    const retained = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-inbound")
          .eq("environment", "live")
          .eq("providerMessageId", messageId)
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .take(2);
    if (retained.length !== 1) {
      return denial("invalid-payload", "no single retained oversized reply matches this message");
    }
    const row = retained[0];
    if (row === undefined || row.applicationState !== "outcomeUnknown") {
      return denial("invalid-payload", "retained reply is not waiting for recovery");
    }
    const marker = parseWaitingOversizedMarker(parseObject(row.outcome));
    if (marker === null) {
      return denial("invalid-payload", "retained reply is not oversized; use the standard replay");
    }
    if (marker.recoveryAttempts >= MAX_RECONCILIATION_READS) {
      return { ok: false as const, code: "recovery-attempts-exhausted", message: "recovery read budget is exhausted" };
    }
    // The claim belongs to exactly one admitted run. A rotated run (a newer
    // gate admission) or a settled reservation denies before any HTTP read.
    if (marker.recoveryJobId !== args.jobId || marker.recoveryReservationId !== args.reservationId) {
      return { ok: false as const, code: "already-claimed", message: "recovery claim does not match the admitted run" };
    }
    const binding = await conversationForMessage(ctx, { messageId, threadId, inboxId });
    if (binding === null) {
      return denial("invalid-payload", "thread has no verified conversation binding");
    }
    const reservation = await ctx.db.get(args.reservationId);
    if (
      reservation === null ||
      reservation.organizationId !== binding.organizationId ||
      reservation.jobId !== args.jobId ||
      reservation.state !== "open"
    ) {
      return { ok: false as const, code: "allowance-exhausted", message: "recovery reservation is not open" };
    }
    const conversation = await ctx.db.get(binding.conversationId);
    if (
      conversation === null ||
      conversation.state === "cancelled" ||
      conversation.state === "closed"
    ) return denial("invalid-payload", "conversation is not available for recovery");
    const grant = await ctx.db.get(conversation.grantId);
    if (
      grant === null ||
      grant.organizationId !== binding.organizationId ||
      grant.projectId !== binding.projectId ||
      grant.status !== "active" ||
      grant.expiresAt <= Date.now()
    ) {
      return denial("alternate-channel-denied", "communication grant is not active for recovery");
    }
    const outcomeValue = parseObject(row.outcome);
    await ctx.db.patch(row._id, {
      outcome: JSON.stringify({
        ...(isRecord(outcomeValue) ? outcomeValue : {}),
        recoveryAttempts: marker.recoveryAttempts + 1,
      }),
    });
    return { ok: true as const, attemptNumber: marker.recoveryAttempts + 1 };
  },
});

/**
 * Settle one recovery run. The settled read count always comes from the
 * durable row marker minus the run's admission baseline — the exact reads
 * claimed by this run across restarts — never from a single action's local
 * counter, so a crash between reads cannot strand claimed reads outside
 * the settlement and a rotated run cannot re-retain reads an earlier run
 * already settled. The settlement binds to the admitted run: a mismatched
 * job or reservation fails closed.
 */
export const settleRecoveryRun = f1InternalMutation({
  args: {
    jobId: v.id("jobs"),
    reservationId: v.id("reservations"),
    threadId: v.string(),
    inboxId: v.string(),
    messageId: v.string(),
    outcome: v.union(v.literal("recovered"), v.literal("unknown"), v.literal("rejected")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), retainedMicroUsd: v.number(), releasedMicroUsd: v.number(), readsSettled: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    const messageId = normalizedProviderId(args.messageId);
    if (threadId === undefined || inboxId === undefined || messageId === undefined) {
      return denial("invalid-payload", "thread, inbox, and message identifiers are required");
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return denial("invalid-payload", "recovery job is not available");
    }
    const retained = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-inbound")
          .eq("environment", "live")
          .eq("providerMessageId", messageId)
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .take(2);
    if (retained.length !== 1) {
      return denial("invalid-payload", "no single retained reply matches this run");
    }
    const row = retained[0];
    if (row === undefined) return denial("invalid-payload", "retained reply is not available");
    const marker = parseWaitingOversizedMarker(parseObject(row.outcome));
    if (marker === null) {
      return denial("invalid-payload", "retained reply has no recovery marker");
    }
    if (marker.recoveryJobId !== args.jobId || marker.recoveryReservationId !== args.reservationId) {
      return denial("invalid-payload", "settlement does not match the admitted run");
    }
    const baseline = marker.recoveryRunStartAttempts ?? 0;
    const readsSettled = marker.recoveryAttempts - baseline;
    if (
      !Number.isSafeInteger(readsSettled) ||
      readsSettled < 0 ||
      readsSettled > MAX_RECONCILIATION_READS
    ) {
      return denial("invalid-payload", "settlement read count is outside the bounded retry policy");
    }
    // A crash between a successful ingest and settlement must still close
    // the run as completed: the durable row proves the bytes landed.
    const effectiveOutcome = args.outcome === "recovered" || row.applicationState === "observedSuccess"
      ? ("recovered" as const)
      : args.outcome;
    const settled: MutationReturn<typeof reservations.settleServerRead> = await ctx.runMutation(settleServerReadRef, {
      reservationId: args.reservationId,
      organizationId: job.organizationId,
      jobId: args.jobId,
      readsUsed: readsSettled,
      mode: effectiveOutcome === "rejected" ? "release" : "retainUnknown",
    });
    if (!settled.ok) return settled;
    await ctx.db.patch(args.jobId, {
      state: effectiveOutcome === "recovered" ? "completed" : "failed",
      updatedAt: Date.now(),
    });
    return {
      ok: true as const,
      retainedMicroUsd: settled.retainedMicroUsd,
      releasedMicroUsd: settled.releasedMicroUsd,
      readsSettled,
    };
  },
});

/**
 * Watchdog for a recovery run. Settles the admitted run from the durable
 * claimed total when the driving action crashed, stalled past its
 * deadlines, or otherwise never settled: an open reservation with
 * exhausted attempts settles through this retry path instead of stranding
 * allowance, and an already-settled run is a harmless no-op. Never reads
 * the provider. A failed settlement schedules at most three bounded
 * backoff retries; each retry re-reads the durable counter, so the total
 * number of watchdog executions stays finite and no scheduler loop can
 * run forever.
 */
// Admission watchdog delay: comfortably beyond one full action run
// (overall deadline plus margins) so only a genuinely stranded admission
// is ever settled by it.
const RECOVERY_ADMISSION_WATCHDOG_DELAY_MS = 60_000;
const WATCHDOG_MAX_ATTEMPTS = 3;
const WATCHDOG_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;

export const watchdogRecoveryRun = f1InternalMutation({
  args: {
    jobId: v.id("jobs"),
    reservationId: v.id("reservations"),
    threadId: v.string(),
    inboxId: v.string(),
    messageId: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), settled: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const reservation = await ctx.db.get(args.reservationId);
    if (reservation === null || reservation.state !== "open") {
      return { ok: true as const, settled: false };
    }
    const settled: MutationReturn<typeof settleRecoveryRun> = await ctx.runMutation(settleRecoverySelfRef, {
      jobId: args.jobId,
      reservationId: args.reservationId,
      threadId: args.threadId,
      inboxId: args.inboxId,
      messageId: args.messageId,
      outcome: "unknown",
    });
    if (settled.ok) return { ok: true as const, settled: true };
    // A locked failed settlement retries on a bounded backoff without
    // another provider read. The counter lives on the durable row, so
    // concurrent watchdogs converge on the same finite budget.
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    const messageId = normalizedProviderId(args.messageId);
    if (threadId !== undefined && inboxId !== undefined && messageId !== undefined) {
      const retained = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
          q
            .eq("provider", "agentmail-inbound")
            .eq("environment", "live")
            .eq("providerMessageId", messageId)
            .eq("providerThreadId", threadId)
            .eq("providerInboxId", inboxId),
        )
        .take(2);
      const row = retained.length === 1 ? retained[0] : undefined;
      const marker = row === undefined ? null : parseWaitingOversizedMarker(parseObject(row.outcome));
      const attempts = marker?.watchdogAttempts ?? 0;
      if (row !== undefined && marker !== null && attempts < WATCHDOG_MAX_ATTEMPTS) {
        const outcomeValue = parseObject(row.outcome);
        await ctx.db.patch(row._id, {
          outcome: JSON.stringify({
            ...(isRecord(outcomeValue) ? outcomeValue : {}),
            watchdogAttempts: attempts + 1,
          }),
        });
        await ctx.scheduler.runAfter(WATCHDOG_RETRY_DELAYS_MS[Math.min(attempts, WATCHDOG_RETRY_DELAYS_MS.length - 1)] ?? 30_000, watchdogRecoverySelfRef, {
          jobId: args.jobId,
          reservationId: args.reservationId,
          threadId,
          inboxId,
          messageId,
        });
      }
    }
    return { ok: true as const, settled: false };
  },
});

// One migration transaction reads at most one page of binding rows. Larger
// threads resume across transactions through the durable pagination cursor
// stored on the migration state.
const MIGRATION_PAGE_SIZE = 64;

const migrationStateValidator = v.union(v.literal("verifying"), v.literal("complete"), v.literal("conflicted"));

/**
 * Advance the durable thread-identity migration by one bounded chunk
 * (Greptile r4058523017 follow-up). Every step is an exact indexed read or
 * a bounded take; unanimity is proven row by row through the same
 * conversation resolution as live routing, and only a fully proven thread
 * earns its durable binding. Conflicting rows terminate as `conflicted`
 * without ever producing a binding. Incomplete work schedules its own
 * continuation, so a finite prefix may fail closed temporarily but normal
 * routing is eventually restored.
 */
export const advanceThreadMigration = f1InternalMutation({
  args: { threadId: v.string(), inboxId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      state: migrationStateValidator,
      verifiedReads: v.number(),
      replayed: v.number(),
      stillWaiting: v.number(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const threadId = normalizedProviderId(args.threadId);
    const inboxId = normalizedProviderId(args.inboxId);
    if (threadId === undefined || inboxId === undefined) {
      return denial("invalid-payload", "thread and inbox identifiers are required");
    }
    const finish = async (
      state: "complete" | "conflicted",
      verifiedReads: number,
    ): Promise<{
      readonly ok: true;
      readonly state: "complete" | "conflicted";
      readonly verifiedReads: number;
      readonly replayed: number;
      readonly stillWaiting: number;
    }> => {
      let replayed = 0;
      let stillWaiting = 0;
      if (state === "complete") {
        // Nested subtransaction: the replay gets its own paginated-query
        // budget because only one paginate call is allowed per execution.
        const replay: MutationReturn<typeof replayWaitingInbound> = await ctx.runMutation(replayWaitingSelfRef, {
          threadId,
          inboxId,
        });
        if (!replay.ok) {
          return { ok: true as const, state, verifiedReads, replayed, stillWaiting };
        }
        replayed = replay.replayed;
        stillWaiting = replay.stillWaiting;
      }
      return { ok: true as const, state, verifiedReads, replayed, stillWaiting };
    };
    const threaded = await ctx.db
      .query("threadBindings")
      .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-binding")
          .eq("environment", "live")
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .take(2);
    const firstIdentity = threaded[0];
    if (firstIdentity !== undefined) {
      const compatible = threaded.every(
        (row) =>
          row.organizationId === firstIdentity.organizationId &&
          row.projectId === firstIdentity.projectId &&
          row.conversationId === firstIdentity.conversationId,
      );
      if (!compatible) {
        return denial("invalid-payload", "durable thread identity is ambiguous");
      }
      const states = await ctx.db
        .query("threadMigrationStates")
        .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
          q
            .eq("provider", "agentmail-binding")
            .eq("environment", "live")
            .eq("providerThreadId", threadId)
            .eq("providerInboxId", inboxId),
        )
        .take(2);
      for (const stateRow of states) {
        if (stateRow.state !== "complete") {
          await ctx.db.patch(stateRow._id, { state: "complete", updatedAt: Date.now() });
        }
      }
      return finish("complete", 0);
    }
    const states = await ctx.db
      .query("threadMigrationStates")
      .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-binding")
          .eq("environment", "live")
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .take(2);
    if (states.length > 1) {
      return denial("invalid-payload", "thread migration state is ambiguous");
    }
    const existing = states[0];
    if (existing !== undefined && existing.state !== "verifying") {
      return finish(existing.state, existing.verifiedReads);
    }
    const now = Date.now();
    let verifying = existing;
    if (verifying === undefined) {
      const first = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
          q
            .eq("provider", "agentmail-binding")
            .eq("environment", "live")
            .eq("providerThreadId", threadId)
            .eq("providerInboxId", inboxId),
        )
        .order("asc")
        .take(1);
      const firstRow = first[0];
      if (firstRow === undefined) {
        return denial("invalid-payload", "thread has no binding rows to migrate");
      }
      const expected = bindingKey(firstRow.providerMessageId, threadId, inboxId);
      const resolved = expected === null ? null : await resolveBindingRowConversation(ctx, firstRow, expected);
      const operation = firstRow.operationId === undefined ? null : await ctx.db.get(firstRow.operationId);
      if (resolved === null || operation === null) {
        if (operation !== null) {
          await ctx.db.insert("threadMigrationStates", {
            provider: "agentmail-binding",
            environment: "live",
            providerThreadId: threadId,
            providerInboxId: inboxId,
            organizationId: operation.organizationId,
            projectId: operation.projectId,
            verifiedReads: 0,
            state: "conflicted",
            createdAt: now,
            updatedAt: now,
          });
        }
        return finish("conflicted", 0);
      }
      const stateId = await ctx.db.insert("threadMigrationStates", {
        provider: "agentmail-binding",
        environment: "live",
        providerThreadId: threadId,
        providerInboxId: inboxId,
        organizationId: resolved.organizationId,
        projectId: resolved.projectId,
        candidateConversationId: resolved.conversationId,
        ...(firstRow.operationId === undefined ? {} : { candidateOperationId: firstRow.operationId }),
        verifiedReads: 0,
        state: "verifying",
        createdAt: now,
        updatedAt: now,
      });
      const created = await ctx.db.get(stateId);
      if (created === null || created.state !== "verifying" || created.candidateConversationId === undefined) {
        return denial("invalid-payload", "thread migration state could not start");
      }
      verifying = created;
    }
    const candidateConversationId = verifying.candidateConversationId;
    if (candidateConversationId === undefined) {
      await ctx.db.patch(verifying._id, { state: "conflicted", updatedAt: now });
      return finish("conflicted", verifying.verifiedReads);
    }
    // One bounded page per transaction through the exact thread/inbox
    // index. The positional continuation cursor advances past every
    // returned row, so equal timestamps can never stall progress and no
    // row is ever verified twice.
    const page = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
        q
          .eq("provider", "agentmail-binding")
          .eq("environment", "live")
          .eq("providerThreadId", threadId)
          .eq("providerInboxId", inboxId),
      )
      .order("asc")
      .paginate({ cursor: verifying.cursor ?? null, numItems: MIGRATION_PAGE_SIZE });
    for (const row of page.page) {
      const expected = bindingKey(row.providerMessageId, threadId, inboxId);
      const single = expected === null ? null : await resolveBindingRowConversation(ctx, row, expected);
      if (
        single === null ||
        single.conversationId !== candidateConversationId ||
        single.organizationId !== verifying.organizationId ||
        single.projectId !== verifying.projectId
      ) {
        await ctx.db.patch(verifying._id, { state: "conflicted", updatedAt: now });
        return finish("conflicted", verifying.verifiedReads + page.page.length);
      }
    }
    const verifiedReads = verifying.verifiedReads + page.page.length;
    if (page.isDone) {
      const noted = await noteThreadBinding(
        ctx,
        { threadId, inboxId },
        {
          conversationId: candidateConversationId,
          organizationId: verifying.organizationId,
          projectId: verifying.projectId,
        },
        verifying.candidateOperationId,
      );
      if (noted === "conflict") {
        await ctx.db.patch(verifying._id, { state: "conflicted", verifiedReads, updatedAt: now });
        return finish("conflicted", verifiedReads);
      }
      await ctx.db.patch(verifying._id, { state: "complete", verifiedReads, updatedAt: now });
      return finish("complete", verifiedReads);
    }
    await ctx.db.patch(verifying._id, {
      verifiedReads,
      cursor: page.continueCursor,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, advanceMigrationRef, { threadId, inboxId });
    return { ok: true as const, state: "verifying" as const, verifiedReads, replayed: 0, stillWaiting: 0 };
  },
});

/**
 * Schedule migration work for a thread the bounded scan cannot prove.
 * Skipped when migration already settled; the advance step itself is
 * idempotent, so concurrent triggers converge instead of duplicating
 * bindings.
 */
export async function maybeScheduleThreadMigration(
  ctx: F1MutationCtx,
  threadId: string,
  inboxId: string,
): Promise<void> {
  const states = await ctx.db
    .query("threadMigrationStates")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .take(2);
  if (states.every((row) => row.state !== "verifying") && states.length > 0) return;
  await ctx.scheduler.runAfter(0, advanceMigrationRef, { threadId, inboxId });
}

const quoteResultValidator = v.union(
  v.object({ ok: v.literal(true), quoteId: v.id("quotes"), deduplicated: v.boolean(), executionMode: v.string() }),
  denialValidator,
);

/**
 * Prove the extraction source's exact conversation binding. The stored
 * evidence snapshot identifies the provider thread and inbox; every binding
 * row under that exact key must resolve to the requesting conversation.
 * Zero, several, or foreign bindings fail closed.
 */
async function verifyQuoteSourceConversation(
  ctx: F1MutationCtx,
  args: {
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly conversationId: Id<"conversations">;
  },
  source: { readonly sourceEvidenceId?: Id<"evidence"> },
): Promise<{ readonly ok: true } | CommunicationDenial> {
  if (source.sourceEvidenceId === undefined) {
    return denial("invalid-payload", "quote source predates verifiable conversation binding");
  }
  const evidence = await ctx.db.get(source.sourceEvidenceId);
  if (
    evidence === null ||
    evidence.organizationId !== args.organizationId ||
    evidence.projectId !== args.projectId
  ) {
    return denial("invalid-payload", "quote source snapshot is not in this project");
  }
  const providerIds = parseObject(evidence.providerIds ?? "");
  const threadId = normalizedProviderId(providerIds?.["threadId"]);
  const inboxId = normalizedProviderId(providerIds?.["inboxId"]);
  if (threadId === undefined || inboxId === undefined) {
    return denial("invalid-payload", "quote source snapshot lacks provider thread binding");
  }
  // Durable thread identity (Greptile r4058523017 repair): one exact indexed
  // read proves the requesting conversation owns the thread, regardless of
  // how many binding rows the thread holds. Anything else fails closed.
  const durableRows = await ctx.db
    .query("threadBindings")
    .withIndex("by_provider_environment_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .take(2);
  const durable = durableRows.length === 1
    ? durableRows[0]
    : durableRows.length === 2 &&
      durableRows[0] !== undefined && durableRows[1] !== undefined &&
      durableRows[0].organizationId === durableRows[1].organizationId &&
      durableRows[0].projectId === durableRows[1].projectId &&
      durableRows[0].conversationId === durableRows[1].conversationId
    ? durableRows[0]
    : undefined;
  if (durableRows.length === 2 && durable === undefined) {
    return denial("invalid-payload", "quote source conversation binding is ambiguous");
  }
  if (durable !== undefined) {
    if (
      durable.organizationId !== args.organizationId ||
      durable.projectId !== args.projectId ||
      durable.conversationId !== args.conversationId
    ) {
      return denial("invalid-payload", "quote source belongs to another conversation");
    }
    return { ok: true as const };
  }
  // Legacy fallback for quote sources whose thread predates the durable
  // thread binding. Long threads resolve through the durable check above.
  const rows: StoredBindingRow[] = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId),
    )
    .take(THREAD_BINDING_RESOLVE_LIMIT + 1);
  if (rows.length === 0 || rows.length > THREAD_BINDING_RESOLVE_LIMIT) {
    return denial("invalid-payload", "quote source conversation binding is ambiguous");
  }
  for (const row of rows) {
    if (
      row.organizationId !== args.organizationId ||
      row.projectId !== args.projectId ||
      row.operationId === undefined
    ) {
      return denial("invalid-payload", "quote source conversation binding conflicts");
    }
    const operation = await ctx.db.get(row.operationId);
    if (
      operation === null ||
      operation.organizationId !== args.organizationId ||
      operation.projectId !== args.projectId
    ) {
      return denial("invalid-payload", "quote source conversation binding conflicts");
    }
    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.organizationId !== args.organizationId ||
      grant.projectId !== args.projectId ||
      grant.conversationId === undefined ||
      grant.conversationId !== args.conversationId
    ) {
      return denial("invalid-payload", "quote source belongs to another conversation");
    }
  }
  return { ok: true as const };
}

/** Versioned extraction handoff. The model result is data, never authority. */
export const ingestQuote = f1InternalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    conversationId: v.id("conversations"),
    providerMessageId: v.string(),
    extractionVersion: v.string(),
    quoteJson: v.string(),
    executionMode: v.union(v.literal("live"), v.literal("recorded")),
  },
  returns: quoteResultValidator,
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== args.organizationId ||
      conversation.projectId !== args.projectId ||
      conversation.state === "cancelled" ||
      conversation.state === "closed"
    ) return denial("invalid-payload", "conversation is not available for quote ingestion");
    const sourceKey = `agentmail:${args.providerMessageId}:source:1`;
    const sourceRows = await ctx.db
      .query("productEvidence")
      .withIndex("by_project_and_key", (q) => q.eq("projectId", args.projectId).eq("idempotencyKey", sourceKey))
      .take(2);
    if (sourceRows.length !== 1) return denial("invalid-payload", "quote source is not a verified inbound snapshot");
    const source = sourceRows[0];
    if (source === undefined) return denial("invalid-payload", "quote source is not available");
    if (source.version !== "source:1") return denial("malicious-content", "quote source requires manual review");
    const conversationProof = await verifyQuoteSourceConversation(ctx, args, source);
    if (isCommunicationDenial(conversationProof)) return conversationProof;
    const content = sanitizeInboundContent({ text: source.normalizedValue, html: "" });
    if (content.needsReview) return denial("malicious-content", "supplier instructions require manual review");
    const bounded = parseBoundedPayloadJson(args.quoteJson);
    if (!bounded.ok || !isRecord(bounded.payload.value)) return denial("invalid-payload", "quote extraction is not valid bounded JSON");
    const extractionHash = payloadHash(bounded.payload.value);
    const extractionKey = `agentmail:${args.providerMessageId}:extract:${args.extractionVersion}`;
    const extractionRows = await ctx.db
      .query("productEvidence")
      .withIndex("by_project_and_key", (q) => q.eq("projectId", args.projectId).eq("idempotencyKey", extractionKey))
      .take(2);
    if (extractionRows.length > 1) return denial("invalid-payload", "duplicate extraction markers detected");
    if (extractionRows[0] !== undefined) {
      const marker = parseObject(extractionRows[0].normalizedValue);
      if (!isRecord(marker) || marker["extractionHash"] !== extractionHash) {
        return denial("invalid-payload", "replayed extraction conflicts with the stored result");
      }
      // The marker carries the exact durable link to its quote; no project
      // quote prefix is scanned.
      if (typeof marker["quoteId"] !== "string") {
        return denial("invalid-payload", "extraction marker has no linked quote");
      }
      let quote: {
        readonly _id: Id<"quotes">;
        readonly organizationId: Id<"organizations">;
        readonly projectId: Id<"projects">;
        readonly conversationId?: Id<"conversations">;
        readonly evidenceRefs: ReadonlyArray<{ readonly sourceId: string; readonly version: string }>;
        readonly executionMode: string;
      } | null = null;
      try {
        quote = await ctx.db.get(marker["quoteId"] as Id<"quotes">);
      } catch {
        return denial("invalid-payload", "extraction marker has no linked quote");
      }
      if (
        quote !== null &&
        quote.organizationId === args.organizationId &&
        quote.projectId === args.projectId &&
        quote.conversationId === args.conversationId &&
        quote.evidenceRefs.some(
          (ref) => ref.sourceId === `agentmail:${args.providerMessageId}` && ref.version === args.extractionVersion,
        )
      ) {
        return { ok: true as const, quoteId: quote._id, deduplicated: true, executionMode: quote.executionMode };
      }
      return denial("invalid-payload", "extraction marker has no linked quote");
    }
    const quoteValue = bounded.payload.value;
    const version = typeof quoteValue["version"] === "string" && quoteValue["version"].trim().length > 0
      ? quoteValue["version"]
      : `${args.providerMessageId}:${args.extractionVersion}`;
    // Controlled demo evidence: this pipeline is owner-only, so extracted
    // quote terms are always owner-authored supplier terms, never genuine
    // vendor evidence, regardless of the transport mode the caller observed.
    // Live transport stays proven separately by the provider callback
    // receipt and operation outcome.
    const quoteExecutionMode = "recorded" as const;
    const sourceRefs = [{ sourceId: `agentmail:${args.providerMessageId}`, version: args.extractionVersion, locator: `message:${args.providerMessageId}` }];
    // `parseBoundedPayloadJson` proves the size, depth and canonical JSON
    // boundary; F1's provider validator is the authoritative field schema.
    const quoteArgs = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      version,
      currency: quoteValue["currency"],
      lines: quoteValue["lines"],
      ...(quoteValue["charges"] === undefined ? {} : { charges: quoteValue["charges"] }),
      taxBasis: quoteValue["taxBasis"],
      ...(quoteValue["comparisonScope"] === undefined ? {} : { comparisonScope: quoteValue["comparisonScope"] }),
      evidenceRefs: sourceRefs,
      counterpartyRole: "ownerStandIn" as const,
      executionMode: quoteExecutionMode,
      conversationId: args.conversationId,
      ...(quoteValue["requirementId"] !== undefined ? { requirementId: quoteValue["requirementId"] } : {}),
      ...(quoteValue["vendorId"] !== undefined ? { vendorId: quoteValue["vendorId"] } : {}),
      ...(quoteValue["rfqId"] !== undefined ? { rfqId: quoteValue["rfqId"] } : {}),
      ...(quoteValue["supersedes"] !== undefined ? { supersedes: quoteValue["supersedes"] } : {}),
    } as MutationArgs<typeof quotes.ingestProviderQuote>;
    const recorded: MutationReturn<typeof quotes.ingestProviderQuote> = await ctx.runMutation(quoteIngestRef, quoteArgs);
    if (!recorded.ok) return recorded;
    await ctx.db.insert("productEvidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      field: "agentmail.quote-extraction",
      sourceKind: "agentmail.message",
      capturedAt: Date.now(),
      originalValue: bounded.payload.canonical.slice(0, 8_000),
      normalizedValue: JSON.stringify({ quoteId: recorded.quoteId, contentHash: recorded.contentHash, extractionHash }),
      verification: "unverified",
      freshness: "fresh",
      counterpartyRole: "ownerStandIn",
      executionMode: quoteExecutionMode,
      origin: "ownerImport",
      conflictEvidenceIds: [],
      idempotencyKey: extractionKey,
      ingestionIdentity: `${args.providerMessageId}:extract:${args.extractionVersion}`,
      version: args.extractionVersion,
      createdAt: Date.now(),
    });
    const projectEventEvidence = [{ sourceId: `agentmail:${args.providerMessageId}`, version: args.extractionVersion, locator: `message:${args.providerMessageId}` }];
    await ctx.db.insert("projectEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: "communication.quoteRevision",
      actor: "communication",
      evidenceRefs: projectEventEvidence,
      createdAt: Date.now(),
    });
    return { ok: true as const, quoteId: recorded.quoteId, deduplicated: false, executionMode: quoteExecutionMode };
  },
});

// Names match the F0 route's documented callback contract. The coordinator
// owns the tiny shared http.ts wiring change because that file is outside C1.
export const onAgentMailEvent = ingestEvent;
export const onAgentMailMessageReceived = ingestMessage;

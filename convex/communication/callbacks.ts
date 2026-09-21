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
import * as quotes from "../purchasing/contracts/quotes.js";
import { parseBoundedPayloadJson, payloadHash } from "../shared/hashing.js";
import { normalizeMailbox } from "../shared/mailbox.js";
import { denialValidator } from "../access/checks.js";
import {
  parseInboundMessage,
  sanitizeInboundContent,
  serializeProviderEventForBinding,
  isCommunicationDenial,
  type CommunicationDenial,
  type InboundMessage,
  type ParsedProviderEvent,
} from "./contracts.js";

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
  const rows = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_event", (q) => q.eq("provider", provider).eq("environment", "live"))
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
 * binding row unanimous for one conversation. Records the durable identity
 * so later routing is one exact read; a concurrently recorded conflicting
 * identity fails closed instead. Threads whose history cannot be proven
 * unanimous within the bounded horizon are never migrated: resolving a
 * sampled prefix into a durable identity could mask a conflict further
 * down the thread, so those threads stay on the explicit legacy
 * fail-closed path (waitingForBinding with reconciliation).
 */
async function noteThreadBinding(
  ctx: F1MutationCtx,
  expected: BindingKey,
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
  if (indexedRows.length > THREAD_BINDING_RESOLVE_LIMIT) return null;
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
    executionMode: "live",
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
    executionMode: "live",
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
      executionMode: "live",
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
  return { messageId, threadId, inboxId, reason, snapshotOversized: true as const, contentHash, byteSize };
}

async function replayWaitingForThread(
  ctx: F1MutationCtx,
  threadId: string,
  inboxId: string,
): Promise<{ readonly replayed: number; readonly stillWaiting: number }> {
  // Waiting-set repair (Greptile r4058523015 repair). The query returns
  // only rows still in outcomeUnknown through the exact waiting-state
  // index, so completed rows never occupy the bounded prefix and later
  // waiting replies stay reachable. One bounded exact-index read per
  // trigger keeps every pass finite; each pass applies up to
  // WAITING_REPLAY_LIMIT rows, which guarantees forward progress.
  // Oversized rows without a replayable snapshot stay explicitly waiting
  // for `resumeWaitingInbound`; anything unparseable also stays waiting
  // rather than being dropped.
  const rows = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_thread_inbox_and_state", (q) =>
      q
        .eq("provider", "agentmail-inbound")
        .eq("environment", "live")
        .eq("providerThreadId", threadId)
        .eq("providerInboxId", inboxId)
        .eq("applicationState", "outcomeUnknown"),
    )
    .take(WAITING_REPLAY_LIMIT + 1);
  let replayed = 0;
  let stillWaiting = 0;
  for (const row of rows.slice(0, WAITING_REPLAY_LIMIT)) {
    const stored = parseWaitingSnapshot(parseObject(row.outcome));
    if (
      stored === null ||
      stored.threadId !== threadId ||
      stored.inboxId !== inboxId ||
      row.providerMessageId === undefined ||
      stored.messageId !== row.providerMessageId
    ) {
      stillWaiting += 1;
      continue;
    }
    const binding = await conversationForMessage(ctx, stored);
    if (binding === null) {
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
  if (rows.length > WAITING_REPLAY_LIMIT) stillWaiting += rows.length - WAITING_REPLAY_LIMIT;
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
 * that its thread resolves to a live conversation, and that the owning
 * grant is still active and unexpired. No provider call may happen before
 * this gate passes, and no row is modified by it.
 */
export const prepareOversizedRecovery = f1InternalMutation({
  args: { threadId: v.string(), inboxId: v.string(), messageId: v.string() },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
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
    if (parseWaitingOversizedMarker(parseObject(row.outcome)) === null) {
      return denial("invalid-payload", "retained reply is not oversized; use the standard replay");
    }
    const binding = await conversationForMessage(ctx, { messageId, threadId, inboxId });
    if (binding === null) {
      return denial("invalid-payload", "thread has no verified conversation binding");
    }
    const conversation = await ctx.db.get(binding.conversationId);
    if (conversation === null) return denial("invalid-payload", "conversation is not available");
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
    return { ok: true as const };
  },
});

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
      executionMode: args.executionMode,
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
      executionMode: args.executionMode,
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
    return { ok: true as const, quoteId: recorded.quoteId, deduplicated: false, executionMode: args.executionMode };
  },
});

// Names match the F0 route's documented callback contract. The coordinator
// owns the tiny shared http.ts wiring change because that file is outside C1.
export const onAgentMailEvent = ingestEvent;
export const onAgentMailMessageReceived = ingestMessage;

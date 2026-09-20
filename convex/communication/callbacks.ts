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

async function operationForProviderMessage(
  ctx: F1MutationCtx,
  messageId: string | undefined,
  threadId: string | undefined,
  inboxId: string | undefined,
): Promise<{ operationId: Id<"operations">; token: string } | null> {
  const expected = bindingKey(messageId, threadId, inboxId);
  if (expected === null) return null;
  const indexedRows = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_message_and_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerMessageId", expected.messageId)
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(2);
  if (indexedRows.length > 1) return null;

  let row = indexedRows[0];
  if (row === undefined) {
    // Historical binding rows use eventId=messageId and keep the original
    // facts only in outcome JSON. This exact lookup is migration-safe and
    // does not inspect an arbitrary receipt prefix.
    const legacyRows = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", "agentmail-binding").eq("environment", "live").eq("eventId", expected.messageId),
      )
      .take(2);
    if (legacyRows.length > 1) return null;
    const legacy = legacyRows[0];
    if (legacy === undefined || !matchesBinding(legacy, expected)) return null;
    row = legacy;
    await ctx.db.patch(row._id, {
      providerMessageId: expected.messageId,
      providerThreadId: expected.threadId,
      providerInboxId: expected.inboxId,
    });
  }
  if (!matchesBinding(row, expected) || row.operationId === undefined) return null;
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

interface ConversationBinding {
  readonly conversationId: Id<"conversations">;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
}

async function conversationForMessage(
  ctx: F1MutationCtx,
  message: InboundMessage,
): Promise<ConversationBinding | null> {
  const expected = bindingKey(message.messageId, message.threadId, message.inboxId);
  if (expected === null) return null;
  const indexedRows = await ctx.db
    .query("processedEvents")
    .withIndex("by_provider_environment_and_provider_thread_and_inbox", (q) =>
      q
        .eq("provider", "agentmail-binding")
        .eq("environment", "live")
        .eq("providerThreadId", expected.threadId)
        .eq("providerInboxId", expected.inboxId),
    )
    .take(2);
  if (indexedRows.length > 1) return null;

  let row = indexedRows[0];
  if (row === undefined) {
    // Old binding rows have no indexed thread/inbox facts. Recovery is only
    // accepted when the bounded provider prefix is complete; otherwise the
    // inbound event stays in waitingForBinding for explicit reconciliation.
    const legacy = await legacyBindingRows(ctx, "agentmail-binding");
    if (!legacy.complete) return null;
    const matches = legacy.rows.filter((candidate) => matchesThreadAndInbox(candidate, expected));
    if (matches.length !== 1) return null;
    const candidate = matches[0];
    if (candidate === undefined) return null;
    row = candidate;
    const facts = rowBindingFacts(row);
    if (facts === null || facts.messageId === undefined || facts.threadId === undefined || facts.inboxId === undefined) return null;
    await ctx.db.patch(row._id, {
      providerMessageId: facts.messageId,
      providerThreadId: facts.threadId,
      providerInboxId: facts.inboxId,
    });
  }
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
    const configRows = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    const config = configRows.length === 1 ? configRows[0] : undefined;
    const fromMatches = config !== undefined && normalizeMailbox(parsed.from) === normalizeMailbox(config.mailboxNormalized);
    const content = sanitizeInboundContent(parsed);
    const sourceVersion = !fromMatches || content.needsReview ? "source:1:review" : "source:1";
    const binding = await conversationForMessage(ctx, parsed);
    if (binding === null) {
      const seenEvent = await ctx.db
        .query("processedEvents")
        .withIndex("by_provider_environment_and_event", (q) =>
          q.eq("provider", "agentmail-inbound").eq("environment", "live").eq("eventId", args.eventId),
        )
        .unique();
      if (seenEvent !== null) {
        return {
          ok: true as const,
          messageId: parsed.messageId,
          deduplicated: true,
          state: "waitingForBinding" as const,
          evidenceId: null,
        };
      }
      await ctx.db.insert("processedEvents", {
        provider: "agentmail-inbound",
        environment: "live",
        eventId: args.eventId,
        processingVersion: 1,
        outcome: JSON.stringify({ messageId: parsed.messageId, threadId: parsed.threadId, reason: "no verified conversation binding" }),
        providerMessageId: parsed.messageId,
        providerThreadId: parsed.threadId,
        providerInboxId: parsed.inboxId,
        createdAt: Date.now(),
      });
      return { ok: true as const, messageId: parsed.messageId, deduplicated: false, state: "waitingForBinding" as const, evidenceId: null };
    }
    const key = `agentmail:${parsed.messageId}:source:1`;
    const markerRows = await ctx.db
      .query("productEvidence")
      .withIndex("by_project_and_key", (q) => q.eq("projectId", binding.projectId).eq("idempotencyKey", key))
      .take(2);
    if (markerRows.length > 1) return denial("invalid-payload", "duplicate extraction markers detected");
    if (markerRows[0] !== undefined) {
      const evidenceRows = await ctx.db
        .query("evidence")
        .withIndex("by_project", (q) => q.eq("projectId", binding.projectId))
        .take(128);
      const evidence = evidenceRows.find((row) => row.contentHash === payloadHash({ messageId: parsed.messageId, text: parsed.text, html: parsed.html }));
      if (evidence === undefined) return denial("invalid-payload", "replayed message conflicts with the stored source");
      return { ok: true as const, messageId: parsed.messageId, deduplicated: true, state: content.needsReview || !fromMatches ? "needsReview" as const : "replyReceived" as const, evidenceId: evidence?._id ?? null };
    }
    const contentHash = payloadHash({ messageId: parsed.messageId, text: parsed.text, html: parsed.html });
    const evidenceId = await ctx.db.insert("evidence", {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      sourceKind: "agentmail.message",
      providerIds: JSON.stringify({ messageId: parsed.messageId, threadId: parsed.threadId, inboxId: parsed.inboxId }),
      capturedAt: parsed.timestamp,
      contentHash,
      completeness: parsed.text.length > 0 || parsed.html.length > 0 ? "complete" : "partial",
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
      version: sourceVersion,
      createdAt: Date.now(),
    });
    const conversation = await ctx.db.get(binding.conversationId);
    if (conversation === null) return denial("invalid-payload", "conversation binding disappeared");
    const canAdvance = fromMatches && !content.needsReview && conversation.state !== "cancelled" && conversation.state !== "closed";
    if (canAdvance) {
      await ctx.db.patch(binding.conversationId, {
        version: conversation.version + 1,
        state: "replyReceived",
        lastReplyAt: parsed.timestamp,
        updatedAt: Date.now(),
      });
    }
    return {
      ok: true as const,
      messageId: parsed.messageId,
      deduplicated: false,
      state: canAdvance ? "replyReceived" as const : "needsReview" as const,
      evidenceId,
    };
  },
});

const quoteResultValidator = v.union(
  v.object({ ok: v.literal(true), quoteId: v.id("quotes"), deduplicated: v.boolean(), executionMode: v.string() }),
  denialValidator,
);

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
      const quoteRows = await ctx.db
        .query("quotes")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(128);
      const quote = quoteRows.find((row) => row.conversationId === args.conversationId && row.evidenceRefs.some((ref) => ref.sourceId === `agentmail:${args.providerMessageId}` && ref.version === args.extractionVersion));
      if (quote !== undefined) return { ok: true as const, quoteId: quote._id, deduplicated: true, executionMode: quote.executionMode };
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

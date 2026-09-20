/**
 * C1 communication boundary contracts.
 *
 * This module has no Convex side effects. It is deliberately the narrow
 * boundary between untrusted drafts/provider payloads and the durable C1
 * handlers. F1 remains authoritative for grants, operation claims and
 * payload equality; these checks make the transport contract explicit before
 * an operation can reach AgentMail.
 */

import { canonicalJson, payloadHash } from "../shared/hashing.js";
import { isValidSingleMailbox, normalizeMailbox } from "../shared/mailbox.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";

export const DEFAULT_AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0" as const;
export const EU_AGENTMAIL_BASE_URL = "https://api.agentmail.eu/v0" as const;
export const MAX_MESSAGE_BODY_BYTES = 64_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 64_000;
export const MAX_RECONCILIATION_RESULTS = 25;
export const MAX_RECONCILIATION_READS = 3;
export const OUTBOUND_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type CommunicationDenialCode =
  | "invalid-payload"
  | "missing-recipient-config"
  | "recipient-mismatch"
  | "cc-not-empty"
  | "bcc-not-empty"
  | "reply-to-redirect"
  | "alternate-channel-denied"
  | "malicious-content"
  | "expiring-attachment"
  | "unsupported-attachment"
  | "provider-origin-denied"
  | "provider-response-invalid"
  | "provider-rejection"
  | "outcome-unknown";

export interface CommunicationDenial {
  readonly ok: false;
  readonly code: CommunicationDenialCode;
  readonly message: string;
}

export function isCommunicationDenial(value: unknown): value is CommunicationDenial {
  return isRecord(value) && value["ok"] === false && typeof value["code"] === "string" && typeof value["message"] === "string";
}

export interface AttachmentInput {
  readonly filename: string;
  readonly contentBase64: string;
  readonly contentType?: string;
  readonly expiresAt?: number;
}

export interface OutboundPayload {
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly profile: typeof COMMUNICATION_PROFILE_OWNER_ROLEPLAY;
  readonly subject: string;
  readonly body: string;
  readonly attachments?: readonly AttachmentInput[];
}

export interface ValidatedOutboundPayload {
  readonly payload: OutboundPayload;
  readonly canonical: string;
  readonly normalizedPayloadHash: string;
}

export interface ProviderSendPayload {
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly attachments?: readonly {
    readonly filename: string;
    readonly content: string;
    readonly content_type?: string;
  }[];
}

export interface ProviderSendResponse {
  readonly messageId: string;
  readonly threadId: string;
}

export interface InboundMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly timestamp: number;
  readonly attachments: readonly unknown[];
}

export interface SanitizedInboundContent {
  readonly text: string;
  readonly htmlText: string;
  readonly dangerous: boolean;
  readonly needsReview: boolean;
  readonly reason?: string;
}

export interface ParsedProviderEvent {
  readonly eventId: string;
  readonly eventType:
    | "message.received"
    | "message.sent"
    | "message.delivered"
    | "message.bounced"
    | "message.complained"
    | "message.rejected"
    | "domain.verified";
  readonly messageId?: string;
  readonly threadId?: string;
  readonly inboxId?: string;
  readonly message?: InboundMessage;
  readonly rawForBinding: string;
}

export interface ReconciliationMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type ReconciliationResult =
  | { readonly kind: "confirmed"; readonly message: ReconciliationMessage }
  | { readonly kind: "unknown"; readonly reason: "empty" | "ambiguous" | "malformed" };

function denial(code: CommunicationDenialCode, message: string): CommunicationDenial {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value.map((entry) => entry.trim());
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseAttachment(value: unknown, now: number): AttachmentInput | CommunicationDenial {
  if (!isRecord(value)) return denial("unsupported-attachment", "attachment must be an object");
  const filename = value["filename"];
  const contentBase64 = value["contentBase64"] ?? value["content"];
  const contentType = value["contentType"] ?? value["content_type"];
  const expiresAt = value["expiresAt"];
  if (!nonEmptyString(filename) || !nonEmptyString(contentBase64)) {
    return denial("unsupported-attachment", "attachment bytes and filename are required");
  }
  if (filename.includes("/") || filename.includes("\\") || filename.includes("\u0000")) {
    return denial("unsupported-attachment", "attachment filename is unsafe");
  }
  if (/^(?:https?:|data:|file:)/i.test(contentBase64)) {
    return denial("unsupported-attachment", "remote attachment URLs are not accepted");
  }
  if (typeof contentType !== "undefined" && !nonEmptyString(contentType)) {
    return denial("unsupported-attachment", "attachment content type is invalid");
  }
  if (typeof expiresAt !== "undefined") {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now) {
      return denial("expiring-attachment", "attachment has expired or an invalid expiry");
    }
  }
  return {
    filename,
    contentBase64,
    ...(typeof contentType === "string" ? { contentType } : {}),
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
  };
}

/**
 * Validate the canonical communication envelope and bind it to the one
 * server-configured owner mailbox. Unknown provider headers are rejected at
 * this boundary, while F1's exact canonical-string equality remains the
 * authoritative approval check at claim time.
 */
export function validateOutboundPayload(
  value: unknown,
  ownerMailbox: string | undefined,
  now = Date.now(),
): ValidatedOutboundPayload | CommunicationDenial {
  if (ownerMailbox === undefined || !isValidSingleMailbox(ownerMailbox)) {
    return denial("missing-recipient-config", "owner recipient is not configured");
  }
  if (!isRecord(value)) return denial("invalid-payload", "communication payload must be an object");
  const to = value["to"];
  const cc = stringArray(value["cc"]);
  const bcc = stringArray(value["bcc"]);
  const profile = value["profile"];
  const subject = value["subject"];
  const body = value["body"];
  const replyTo = value["replyTo"] ?? value["reply_to"];
  if (!nonEmptyString(to)) return denial("invalid-payload", "recipient is required");
  if (cc === null) return denial("cc-not-empty", "CC must be an explicit empty array");
  if (bcc === null) return denial("bcc-not-empty", "BCC must be an explicit empty array");
  if (cc.length !== 0) return denial("cc-not-empty", "CC must remain empty");
  if (bcc.length !== 0) return denial("bcc-not-empty", "BCC must remain empty");
  if (replyTo !== undefined) return denial("reply-to-redirect", "Reply-To redirection is denied");
  if (profile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
    return denial("alternate-channel-denied", "only the owner-roleplay profile is permitted");
  }
  const normalizedTo = normalizeMailbox(to);
  const normalizedOwner = normalizeMailbox(ownerMailbox);
  if (!isValidSingleMailbox(normalizedTo) || normalizedTo !== normalizedOwner) {
    return denial("recipient-mismatch", "recipient is not the configured owner mailbox");
  }
  if (!nonEmptyString(subject) || /[\r\n]/.test(subject)) {
    return denial("invalid-payload", "subject is required and cannot contain header breaks");
  }
  if (!nonEmptyString(body)) return denial("invalid-payload", "message body is required");
  if (bytes(body) > MAX_MESSAGE_BODY_BYTES) return denial("invalid-payload", "message body exceeds the size bound");
  if (/<(?:script|iframe|object|embed|form)\b/i.test(body) || /<[a-z][^>]*>/i.test(body) || /(?:javascript:|on[a-z]+\s*=)/i.test(body)) {
    return denial("malicious-content", "unsafe HTML or instructions cannot be sent");
  }
  if (/\b(?:ignore|disregard)\s+(?:all|any|the|previous|prior)(?:\s+(?:all|any|the|previous|prior))*\s+instructions\b/i.test(body)) {
    return denial("malicious-content", "instruction-like content cannot be sent");
  }

  let attachments: readonly AttachmentInput[] | undefined;
  const rawAttachments = value["attachments"];
  if (rawAttachments !== undefined) {
    if (!Array.isArray(rawAttachments)) return denial("unsupported-attachment", "attachments must be an array");
    const parsed: AttachmentInput[] = [];
    for (const raw of rawAttachments) {
      const attachment = parseAttachment(raw, now);
      if (isCommunicationDenial(attachment)) return attachment;
      parsed.push(attachment);
    }
    attachments = parsed;
  }

  const payload: OutboundPayload = {
    to: normalizedTo,
    cc: [],
    bcc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject,
    body,
    ...(attachments === undefined ? {} : { attachments }),
  };
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return denial("invalid-payload", "communication payload cannot be canonicalized");
  }
  return { payload, canonical, normalizedPayloadHash: payloadHash(value) };
}

export function providerPayloadFromOutbound(payload: OutboundPayload): ProviderSendPayload {
  return {
    to: payload.to,
    cc: [],
    bcc: [],
    subject: payload.subject,
    text: payload.body,
    ...(payload.attachments === undefined
      ? {}
      : {
          attachments: payload.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.contentBase64,
            ...(attachment.contentType === undefined ? {} : { content_type: attachment.contentType }),
          })),
        }),
  };
}

export function parseProviderSendResponse(value: unknown): ProviderSendResponse | CommunicationDenial {
  if (!isRecord(value) || !nonEmptyString(value["message_id"]) || !nonEmptyString(value["thread_id"])) {
    return denial("provider-response-invalid", "provider response lacks message_id or thread_id");
  }
  return { messageId: value["message_id"], threadId: value["thread_id"] };
}

function parseAddressList(value: unknown): readonly string[] | null {
  if (typeof value === "string") return [value];
  return stringArray(value);
}

/** Parse only the provider fields C1 is allowed to use as evidence. */
export function parseInboundMessage(value: unknown): InboundMessage | CommunicationDenial {
  if (!isRecord(value)) return denial("invalid-payload", "inbound message is not an object");
  const messageId = value["message_id"];
  const threadId = value["thread_id"];
  const inboxId = value["inbox_id"];
  const from = value["from"];
  const to = parseAddressList(value["to"]);
  const cc = value["cc"] === undefined ? [] : parseAddressList(value["cc"]);
  const subject = value["subject"] === undefined ? "" : value["subject"];
  const text = value["text"] === undefined ? "" : value["text"];
  const html = value["html"] === undefined ? "" : value["html"];
  const timestamp = value["timestamp"];
  if (!nonEmptyString(messageId) || !nonEmptyString(threadId) || !nonEmptyString(inboxId) || !nonEmptyString(from)) {
    return denial("invalid-payload", "inbound message is missing provider identity fields");
  }
  if (to === null || cc === null) return denial("invalid-payload", "inbound address fields are invalid");
  if (typeof subject !== "string" || typeof text !== "string" || typeof html !== "string") {
    return denial("invalid-payload", "inbound body fields are invalid");
  }
  const timestampNumber =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
        ? Date.parse(timestamp)
        : Date.now();
  const references = stringArray(value["references"] ?? []) ?? [];
  const inReplyTo = typeof value["in_reply_to"] === "string" ? value["in_reply_to"] : undefined;
  const attachments = Array.isArray(value["attachments"]) ? [...value["attachments"]] : [];
  return {
    messageId,
    threadId,
    inboxId,
    from,
    to,
    cc,
    subject,
    text,
    html,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
    timestamp: timestampNumber,
    attachments,
  };
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function redactMailboxAddresses(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-mailbox]");
}

/**
 * Convert supplier HTML to a private, redacted text snapshot. Any active
 * content or instruction-shaped text is marked for review and never enters
 * the automatic quote path.
 */
export function sanitizeInboundContent(message: Pick<InboundMessage, "text" | "html">): SanitizedInboundContent {
  const html = message.html;
  const dangerous =
    /<(?:script|iframe|object|embed|form|style)\b/i.test(html) ||
    /(?:javascript:|vbscript:|data:text\/html|on[a-z]+\s*=)/i.test(html);
  const htmlText = decodeBasicEntities(
    html
      .replace(/<\/(?:p|div|br|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
  const text = redactMailboxAddresses(`${message.text}\n${htmlText}`.trim()).slice(0, MAX_MESSAGE_BODY_BYTES);
  const instructionLike =
    /\b(?:ignore|disregard)\s+(?:all|any|the|previous|prior)(?:\s+(?:all|any|the|previous|prior))*\s+instructions\b/i.test(text) ||
    /\b(?:system|developer)\s+message\b/i.test(text) ||
    /\b(?:reveal|print|share)\s+(?:the\s+)?(?:secret|api\s*key|credential)/i.test(text);
  const needsReview = dangerous || instructionLike;
  return {
    text,
    htmlText,
    dangerous,
    needsReview,
    ...(needsReview
      ? { reason: dangerous ? "active HTML was removed" : "instruction-like supplier content" }
      : {}),
  };
}

export function parseProviderReconciliationMessages(value: unknown): readonly ReconciliationMessage[] | null {
  if (!isRecord(value)) return null;
  const candidates = value["messages"] ?? value["data"] ?? value["items"];
  if (!Array.isArray(candidates)) return null;
  const parsed: ReconciliationMessage[] = [];
  for (const candidate of candidates.slice(0, MAX_RECONCILIATION_RESULTS)) {
    if (!isRecord(candidate)) return null;
    const messageId = candidate["message_id"];
    const threadId = candidate["thread_id"];
    const to = parseAddressList(candidate["to"]);
    const subject = candidate["subject"];
    const text = candidate["text"];
    const headers = candidate["headers"];
    if (!nonEmptyString(messageId) || !nonEmptyString(threadId) || to === null || typeof subject !== "string" || typeof text !== "string") {
      return null;
    }
    const normalizedHeaders: Record<string, string> = {};
    if (headers !== undefined) {
      if (!isRecord(headers)) return null;
      for (const [key, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== "string") return null;
        normalizedHeaders[key.toLowerCase()] = headerValue;
      }
    }
    parsed.push({ messageId, threadId, to, subject, text, headers: normalizedHeaders });
  }
  return parsed;
}

export function reconcileProviderMessages(
  messages: readonly ReconciliationMessage[],
  expected: { readonly recipient: string; readonly subject: string; readonly operationLabel: string },
): ReconciliationResult {
  const recipient = normalizeMailbox(expected.recipient);
  const matches = messages.filter((message) => {
    const recipients = message.to.map(normalizeMailbox);
    const label = message.headers["x-openingos-operation"] ?? message.headers["x-openingos-operation-label"];
    return (
      recipients.includes(recipient) &&
      message.subject === expected.subject &&
      label === expected.operationLabel
    );
  });
  if (matches.length === 1) {
    const message = matches[0];
    if (message !== undefined) return { kind: "confirmed", message };
  }
  return { kind: "unknown", reason: matches.length === 0 ? "empty" : "ambiguous" };
}

export function serializeProviderEventForBinding(event: ParsedProviderEvent): string {
  return canonicalJson({
    eventId: event.eventId,
    eventType: event.eventType,
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
    ...(event.inboxId === undefined ? {} : { inboxId: event.inboxId }),
    rawForBinding: event.rawForBinding,
  });
}

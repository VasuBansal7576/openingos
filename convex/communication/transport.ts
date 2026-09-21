/**
 * One-shot AgentMail REST transport.
 *
 * The adapter intentionally does not use `@agentmail/convex`'s outbound
 * queue. F1 claims the application operation immediately before this action;
 * this function performs exactly one request and classifies an uncertain
 * result without retrying or silently resending.
 */

import {
  DEFAULT_AGENTMAIL_BASE_URL,
  EU_AGENTMAIL_BASE_URL,
  MAX_PROVIDER_RESPONSE_BYTES,
  parseProviderSendResponse,
  isCommunicationDenial,
  type CommunicationDenial,
  type ProviderSendPayload,
  type ProviderSendResponse,
} from "./contracts.js";
import { isValidSingleMailbox, normalizeMailbox } from "../shared/mailbox.js";

export type AgentMailTransportResult =
  | { readonly outcome: "success"; readonly response: ProviderSendResponse; readonly providerEventId: string }
  | { readonly outcome: "failure"; readonly denial: CommunicationDenial; readonly providerEventId?: string }
  | { readonly outcome: "unknown"; readonly reason: string; readonly providerEventId?: string };

export type TransportFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentMailTransportInput {
  readonly apiKey: string;
  readonly inboxId: string;
  readonly ownerMailbox: string;
  readonly payload: ProviderSendPayload;
  readonly operationLabel: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: TransportFetch;
}

function failure(code: CommunicationDenial["code"], message: string): AgentMailTransportResult {
  return { outcome: "failure", denial: { ok: false, code, message } };
}

function allowedBaseUrl(value: string): boolean {
  return value === DEFAULT_AGENTMAIL_BASE_URL || value === EU_AGENTMAIL_BASE_URL;
}

function safeOperationLabel(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) return null;
  return text;
}

/**
 * Perform one fixed-origin, no-redirect request. A successful 2xx response
 * is only AgentMail acceptance, not recipient delivery. A transport error,
 * malformed success, redirect, timeout, or undocumented server response is
 * outcomeUnknown and must be reconciled before any resend.
 */
export async function sendAgentMailOneShot(input: AgentMailTransportInput): Promise<AgentMailTransportResult> {
  if (input.apiKey.trim().length === 0) return failure("provider-rejection", "AgentMail is not configured");
  if (input.inboxId.trim().length === 0) return failure("invalid-payload", "inbox id is required");
  if (!isRecord(input.payload) || typeof input.payload["to"] !== "string" || !Array.isArray(input.payload["cc"]) || !Array.isArray(input.payload["bcc"])) {
    return failure("invalid-payload", "transport payload shape is invalid");
  }
  const allowedKeys = new Set(["to", "cc", "bcc", "subject", "text", "attachments"]);
  for (const key of Object.keys(input.payload)) {
    if (key === "replyTo" || key === "reply_to") return failure("reply-to-redirect", "transport Reply-To is denied");
    if (!allowedKeys.has(key)) return failure("invalid-payload", "transport payload contains unsupported fields");
  }
  if (!isValidSingleMailbox(input.ownerMailbox) || normalizeMailbox(input.payload.to) !== normalizeMailbox(input.ownerMailbox)) {
    return failure("recipient-mismatch", "transport recipient is not the configured owner mailbox");
  }
  if (input.payload.cc.length !== 0 || input.payload.bcc.length !== 0) {
    return failure("cc-not-empty", "transport CC and BCC must remain empty");
  }
  if (!safeOperationLabel(input.operationLabel)) return failure("invalid-payload", "operation label is invalid");
  const baseUrl = input.baseUrl ?? DEFAULT_AGENTMAIL_BASE_URL;
  if (!allowedBaseUrl(baseUrl)) return failure("provider-origin-denied", "AgentMail origin is not allowlisted");
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    return failure("invalid-payload", "transport timeout is outside the bounded policy");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "X-OpeningOS-Operation": input.operationLabel,
      },
      body: JSON.stringify(input.payload),
    });
    const bodyText = await boundedResponseText(response);
    if (bodyText === null) return { outcome: "unknown", reason: "provider response exceeded the size bound" };
    let body: unknown = null;
    if (bodyText.trim().length > 0) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        return response.ok
          ? { outcome: "unknown", reason: "provider returned malformed success JSON" }
          : { outcome: "unknown", reason: "provider returned malformed error JSON" };
      }
    }
    if (response.ok) {
      const parsed = parseProviderSendResponse(body);
      if (isCommunicationDenial(parsed)) {
        return { outcome: "unknown", reason: parsed.message };
      }
      return { outcome: "success", response: parsed, providerEventId: parsed.messageId };
    }
    // Only statuses documented as rejecting the request before acceptance are
    // safe to classify as failure. Rate limits and all 5xx responses remain
    // unknown because a proxy/provider may have accepted the request.
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422) {
      return failure("provider-rejection", `AgentMail rejected the request (${response.status})`);
    }
    return { outcome: "unknown", reason: `AgentMail response is ambiguous (${response.status})` };
  } catch (error) {
    return {
      outcome: "unknown",
      reason: error instanceof Error ? `AgentMail transport failed: ${error.message}` : "AgentMail transport failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed operation label has no project, recipient, or budget disclosure. */
export function operationLabel(operationId: string): string {
  const safe = operationId.replace(/[^A-Za-z0-9._:-]/g, "_");
  return `openingos-${safe.slice(0, 140)}`;
}

export function providerMessageListPath(inboxId: string, limit = 25): string {
  const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  return `${DEFAULT_AGENTMAIL_BASE_URL}/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${boundedLimit}`;
}

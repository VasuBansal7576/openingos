/**
 * E6 controlled negotiation execution loop (P-05 / P-23, controlled D-12,
 * controlled J-06 extension; supports P-13 / P-17).
 *
 * This module is deliberately pure: it performs no Convex reads or writes,
 * no model calls, no email sends, and no live transport of any kind. Every
 * external effect in production must flow through the existing boundaries:
 *
 * - Move selection consumes the Jev typed decision boundary shape
 *   (ADR-0005, `proofs/jev/jev-boundary.ts`): only a validated, current
 *   `decided` choice over the permitted move catalog may supply a move.
 *   The pinned model constant is imported from that boundary so drift is a
 *   compile-time fact, not a string copy.
 * - Clarify/counter text follows the OpenAI supplier-draft boundary shape
 *   (ADR-0005, `convex/models/openai.ts`): the dated
 *   `gpt-5.4-mini-2026-03-17` snapshot, source-bound drafts, and the output
 *   byte bound. The constant below mirrors that boundary; the type import
 *   keeps the draft shape identical without pulling server-only transport
 *   into this pure module.
 * - Outbound validation reuses the existing C1 communication boundary
 *   (`convex/communication/contracts.ts` `validateOutboundPayload`), which
 *   binds the payload to the single server-configured owner mailbox and
 *   rejects CC/BCC, Reply-To redirection, alternate profiles, and unsafe
 *   content before anything may reach `communication/send:dispatch`.
 * - Idempotency reuses the F1 request-key contract
 *   (`convex/shared/hashing.ts` `requestKey`/`payloadHash`): identical
 *   retries deduplicate, changed payloads conflict, and no second send path
 *   exists here.
 *
 * Durable lineage is expressed only with existing-record references
 * (negotiation, quote version/content hash, conversation version, F1
 * operation kind, request key, payload hash, attempt outcome). No schema
 * change is introduced by this module. Owner-authored terms flowing through
 * here are controlled demo evidence (`counterpartyRole: ownerStandIn`,
 * `executionMode: controlled`) and never realized savings; confidential
 * target/ceiling figures and the private owner mailbox never enter public
 * projections, logs, or evidence — lineage carries only redacted previews
 * and hashes.
 */

import { JEV_PINNED_MODEL } from "../../proofs/jev/jev-boundary.js";
import {
  isCommunicationDenial,
  validateOutboundPayload,
} from "../communication/contracts.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import {
  canonicalJson,
  payloadHash,
  requestKey,
} from "../shared/hashing.js";
import type { SupplierDraftOutput } from "../models/openai.js";

/** Module version for lineage and review. */
export const NEGOTIATION_LOOP_VERSION = "e6-negotiation-loop-v1" as const;
/** Jev question/policy version this loop was authored against. */
export const NEGOTIATION_QUESTION_VERSION = "e6-negotiation-questions-v1" as const;
/**
 * Dated OpenAI snapshot for negotiation drafting. Mirrors
 * `OPENAI_PINNED_MODEL` in `convex/models/openai.ts` (ADR-0005); kept as a
 * literal so this pure module never imports server-only transport.
 */
export const NEGOTIATION_OPENAI_MODEL = "gpt-5.4-mini-2026-03-17" as const;
/** Versioned controlled E6 corpus extending J-06 (no new thresholds). */
export const E6_NEGOTIATION_CORPUS_VERSION = "e6-negotiation-corpus-v1" as const;
/** F1 operation kind used for every negotiation send. No second send path. */
export const NEGOTIATION_OPERATION_KIND = "communication.send" as const;
/** Maximum draft bytes admitted, mirroring the OpenAI output bound. */
export const NEGOTIATION_MAX_DRAFT_BYTES = 32 * 1024;

export const NEGOTIATION_MOVES = [
  "clarify",
  "counter",
  "hold",
  "stop",
] as const;
export type NegotiationMove = (typeof NEGOTIATION_MOVES)[number];

export type MandateState =
  | "draft"
  | "active"
  | "paused"
  | "concluded"
  | "expired"
  | "revoked";
export type NegotiationGrantStatus = "active" | "revoked" | "expired";
export type NegotiationJobState =
  | "queued"
  | "running"
  | "waitingForSupplier"
  | "waitingForUser"
  | "pausedBudget"
  | "completed"
  | "partial"
  | "failed"
  | "cancelling"
  | "cancelled";

export type NegotiationDenialCode =
  | "mandate-not-active"
  | "mandate-paused"
  | "mandate-expired"
  | "mandate-revoked"
  | "mandate-concluded"
  | "round-limit-reached"
  | "quote-changed"
  | "quote-superseded"
  | "conversation-changed"
  | "grant-revoked"
  | "grant-expired"
  | "grant-version-changed"
  | "recipient-missing"
  | "recipient-changed"
  | "job-cancelled"
  | "allowance-exhausted"
  | "jev-malformed"
  | "jev-disallowed-choice"
  | "draft-malformed"
  | "draft-disclosure-leak"
  | "outbound-denied"
  | "retry-conflict"
  | "provider-result-malformed"
  | "live-transport-refused";

export type NegotiationStopReason =
  | "mandate-expired"
  | "mandate-revoked"
  | "mandate-concluded"
  | "round-limit-reached"
  | "quote-changed"
  | "quote-superseded"
  | "conversation-changed"
  | "user-takeover"
  | "final-offer"
  | "stop-move"
  | "grant-revoked"
  | "grant-expired";

export type NegotiationWaitReason =
  | "mandate-paused"
  | "jev-stale"
  | "jev-needs-review"
  | "jev-unavailable"
  | "draft-stale"
  | "draft-unavailable"
  | "outcome-unknown"
  | "send-failure"
  | "waiting-for-owner";

export interface MandateSnapshot {
  readonly negotiationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly quoteId: string;
  readonly state: MandateState;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly conversationId?: string;
  readonly conversationVersion?: number;
  readonly roundsUsed: number;
  readonly roundLimit: number;
  /** Confidential negotiating target in minor units. Never leaves this boundary. */
  readonly targetMinorUnits?: number;
  /** Confidential negotiating ceiling in minor units. Never leaves this boundary. */
  readonly ceilingMinorUnits?: number;
  readonly expiresAt: number;
}

export interface NegotiationCurrentSnapshot {
  readonly now: number;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly quoteSuperseded: boolean;
  readonly conversationVersion?: number;
  readonly jobState: NegotiationJobState;
  readonly jobCancelled: boolean;
  readonly grantStatus: NegotiationGrantStatus;
  readonly grantExpiresAt: number;
  readonly grantRevocationVersion: number;
  readonly operationGrantVersion: number;
  readonly recipientConfigured: boolean;
  readonly recipientConfigVersion?: number;
  readonly currentRecipientConfigVersion?: number;
  /** Server-normalized owner mailbox. Never copied into lineage or previews. */
  readonly recipientMailboxNormalized?: string;
  readonly allowanceExhausted: boolean;
  readonly userTakeover: boolean;
  readonly finalOfferReceived: boolean;
}

export type InjectedJevOutcome = "decided" | "needsReview" | "unavailable" | "stale";

export interface InjectedJevResult {
  readonly outcome: InjectedJevOutcome;
  readonly choice?: string;
  readonly model?: string;
  readonly inputVersion: string;
  readonly currentInputVersion: string;
}

export type InjectedDraftOutcome = "completed" | "rejected" | "unavailable" | "stale";

export interface InjectedDraftResult {
  readonly outcome: InjectedDraftOutcome;
  readonly draftKind?: string;
  /** Supplier-visible draft text. Must already exclude confidential figures. */
  readonly content?: string;
  readonly sourceQuoteVersion?: string;
  readonly sourceConversationVersion?: number;
  readonly model?: string;
  readonly inputVersion: string;
  readonly currentInputVersion: string;
}

export type InjectedSendOutcome = "success" | "failure" | "unknown";

export interface InjectedSendResult {
  readonly outcome: InjectedSendOutcome;
  readonly providerMessageId?: string;
  readonly reason?: string;
}

export interface PriorNegotiationAttempt {
  readonly requestKey: string;
  readonly payloadHash: string;
}

/**
 * Controlled stand-in for the `communication/send:dispatch` path. The only
 * accepted execution mode is `controlled`; any other mode is refused before
 * invocation, and this task never invokes dispatch against configured
 * transport. In production the same validated payload flows through the real
 * dispatch claim; here the injected result records the honest outcome.
 */
export interface ControlledNegotiationSender {
  readonly executionMode: "controlled";
  readonly send: (payload: {
    readonly canonical: string;
    readonly payloadHash: string;
    readonly requestKey: string;
  }) => InjectedSendResult;
}

export interface NegotiationLineage {
  readonly loopVersion: typeof NEGOTIATION_LOOP_VERSION;
  readonly executionMode: "controlled";
  readonly counterpartyRole: "ownerStandIn";
  readonly evidenceLabel: "controlled demo evidence — never realized savings";
  readonly negotiationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly move: NegotiationMove | "none";
  readonly quoteId: string;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly conversationId?: string;
  readonly conversationVersion?: number;
  readonly round: number;
  readonly roundsUsedAfter: number;
  readonly operationKind: typeof NEGOTIATION_OPERATION_KIND;
  readonly requestKey: string;
  readonly payloadHash: string | null;
  readonly sendState:
    | "not-sent"
    | "prepared"
    | "observedSuccess"
    | "observedFailure"
    | "outcomeUnknown"
    | "deduplicated";
  readonly providerMessageId?: string;
  readonly stopReason?: NegotiationStopReason;
  readonly waitReason?: NegotiationWaitReason;
  readonly denialCode?: NegotiationDenialCode;
  /** Redacted public-safe preview: mailbox redacted, never any confidential figure. */
  readonly redactedPreview: string;
}

export type NegotiationStepResult =
  | {
      readonly kind: "sent";
      readonly move: Extract<NegotiationMove, "clarify" | "counter">;
      readonly requestKey: string;
      readonly payloadHash: string;
      readonly roundsUsedAfter: number;
      readonly sends: 1;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "deduplicated";
      readonly move: Extract<NegotiationMove, "clarify" | "counter">;
      readonly requestKey: string;
      readonly payloadHash: string;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "waiting";
      readonly move: NegotiationMove | "none";
      readonly reason: NegotiationWaitReason;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "stopped";
      readonly move: NegotiationMove | "none";
      readonly reason: NegotiationStopReason;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "denied";
      readonly move: NegotiationMove | "none";
      readonly code: NegotiationDenialCode;
      readonly message: string;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly lineage: NegotiationLineage;
    };

function isMove(value: unknown): value is NegotiationMove {
  return (
    value === "clarify" || value === "counter" || value === "hold" || value === "stop"
  );
}

function baseLineage(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  redactedPreview: string,
): Omit<NegotiationLineage, "move" | "payloadHash" | "sendState"> {
  return {
    loopVersion: NEGOTIATION_LOOP_VERSION,
    executionMode: "controlled",
    counterpartyRole: "ownerStandIn",
    evidenceLabel: "controlled demo evidence — never realized savings",
    negotiationId: mandate.negotiationId,
    organizationId: mandate.organizationId,
    projectId: mandate.projectId,
    quoteId: mandate.quoteId,
    quoteVersion: mandate.quoteVersion,
    quoteContentHash: mandate.quoteContentHash,
    ...(mandate.conversationId === undefined ? {} : { conversationId: mandate.conversationId }),
    ...(mandate.conversationVersion === undefined
      ? {}
      : { conversationVersion: mandate.conversationVersion }),
    round: mandate.roundsUsed + 1,
    roundsUsedAfter: mandate.roundsUsed,
    operationKind: NEGOTIATION_OPERATION_KIND,
    requestKey: requestKey(mandate.organizationId, NEGOTIATION_OPERATION_KIND, requestId),
    redactedPreview,
  };
}

/**
 * Select the negotiation move from an injected Jev typed decision. Only a
 * validated, current `decided` result over the permitted catalog supplies a
 * move: malformed or disallowed answers deny, stale answers wait, and
 * needsReview/unavailable outcomes wait without sending.
 */
export function selectNegotiationMove(
  jev: InjectedJevResult,
):
  | { readonly ok: true; readonly move: NegotiationMove }
  | { readonly ok: false; readonly kind: "denied"; readonly code: NegotiationDenialCode; readonly message: string }
  | { readonly ok: false; readonly kind: "waiting"; readonly reason: NegotiationWaitReason } {
  if (jev.inputVersion !== jev.currentInputVersion) {
    return { ok: false as const, kind: "waiting" as const, reason: "jev-stale" as const };
  }
  if (jev.outcome === "stale") {
    return { ok: false as const, kind: "waiting" as const, reason: "jev-stale" as const };
  }
  if (jev.outcome === "needsReview") {
    return { ok: false as const, kind: "waiting" as const, reason: "jev-needs-review" as const };
  }
  if (jev.outcome === "unavailable") {
    return { ok: false as const, kind: "waiting" as const, reason: "jev-unavailable" as const };
  }
  if (jev.model !== JEV_PINNED_MODEL) {
    return {
      ok: false as const,
      kind: "denied" as const,
      code: "jev-malformed" as const,
      message: "Jev result is not from the pinned negotiation model",
    };
  }
  if (jev.choice === undefined || !isMove(jev.choice)) {
    return {
      ok: false as const,
      kind: "denied" as const,
      code: ("jev-malformed" as NegotiationDenialCode),
      message: "Jev result carries no permitted negotiation move",
    };
  }
  if (!NEGOTIATION_MOVES.includes(jev.choice)) {
    return {
      ok: false as const,
      kind: "denied" as const,
      code: ("jev-disallowed-choice" as NegotiationDenialCode),
      message: "Jev choice is outside the permitted negotiation catalog",
    };
  }
  return { ok: true as const, move: jev.choice };
}

function confidentialRenderings(minorUnits: number): string[] {
  const renderings = new Set<string>();
  renderings.add(String(minorUnits));
  const major = minorUnits / 100;
  renderings.add(major.toFixed(2));
  renderings.add(major.toFixed(2).replace(/\.00$/, ""));
  renderings.add(
    major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  );
  return [...renderings];
}

/**
 * Deterministically validate supplier-visible draft text. Rejects empty or
 * oversized drafts, active HTML, instruction-shaped text, and any leak of
 * confidential target/ceiling figures or the private owner mailbox. Never
 * accepts, orders, or commits anything: drafts are clarification/counter
 * text only.
 */
export function validateNegotiationDraft(
  content: unknown,
  disclosure: {
    readonly targetMinorUnits?: number;
    readonly ceilingMinorUnits?: number;
    readonly ownerMailboxNormalized?: string;
  },
):
  | { readonly ok: true; readonly redactedPreview: string }
  | { readonly ok: false; readonly code: NegotiationDenialCode; readonly message: string } {
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      ok: false as const,
      code: "draft-malformed" as const,
      message: "negotiation draft text is required",
    };
  }
  if (new TextEncoder().encode(content).byteLength > NEGOTIATION_MAX_DRAFT_BYTES) {
    return {
      ok: false as const,
      code: "draft-malformed" as const,
      message: "negotiation draft exceeds the output bound",
    };
  }
  if (
    /<(?:script|iframe|object|embed|form)\b/i.test(content) ||
    /(?:javascript:|on[a-z]+\s*=)/i.test(content)
  ) {
    return {
      ok: false as const,
      code: "draft-malformed" as const,
      message: "negotiation draft carries unsafe content",
    };
  }
  if (
    /\b(?:ignore|disregard)\s+(?:all|any|the|previous|prior)(?:\s+(?:all|any|the|previous|prior))*\s+instructions\b/i.test(
      content,
    )
  ) {
    return {
      ok: false as const,
      code: "draft-malformed" as const,
      message: "negotiation draft carries instruction-like content",
    };
  }
  const lowered = content.toLowerCase();
  const secrets: number[] = [];
  if (disclosure.targetMinorUnits !== undefined) secrets.push(disclosure.targetMinorUnits);
  if (disclosure.ceilingMinorUnits !== undefined) secrets.push(disclosure.ceilingMinorUnits);
  for (const secret of secrets) {
    for (const rendering of confidentialRenderings(secret)) {
      if (rendering.length > 0 && lowered.includes(rendering.toLowerCase())) {
        return {
          ok: false as const,
          code: "draft-disclosure-leak" as const,
          message: "negotiation draft discloses a confidential negotiating figure",
        };
      }
    }
  }
  const mailbox = disclosure.ownerMailboxNormalized?.trim().toLowerCase();
  if (mailbox !== undefined && mailbox.length > 0) {
    const localPart = mailbox.split("@")[0] ?? "";
    if (lowered.includes(mailbox)) {
      return {
        ok: false as const,
        code: "draft-disclosure-leak" as const,
        message: "negotiation draft discloses the private owner mailbox",
      };
    }
    if (localPart.length >= 3 && lowered.includes(localPart)) {
      return {
        ok: false as const,
        code: "draft-disclosure-leak" as const,
        message: "negotiation draft discloses the private owner mailbox",
      };
    }
  }
  return { ok: true as const, redactedPreview: redactForProjection(content) };
}

/** Public-safe projection: mailbox redacted, bounded, never any confidential figure. */
export function redactForProjection(content: string): string {
  return content
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-mailbox]")
    .slice(0, 240);
}

/**
 * Re-check current authority immediately before every consequential
 * transition. Returns the first applicable fence: terminal stops, honest
 * waits, or denials — each with zero sends. Returns `null` when the loop may
 * proceed to move selection.
 */
export function checkNegotiationFences(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
):
  | { readonly kind: "stopped"; readonly reason: NegotiationStopReason }
  | { readonly kind: "waiting"; readonly reason: NegotiationWaitReason }
  | { readonly kind: "denied"; readonly code: NegotiationDenialCode; readonly message: string }
  | null {
  if (current.jobCancelled || current.jobState === "cancelled" || current.jobState === "cancelling") {
    return {
      kind: "denied" as const,
      code: "job-cancelled" as const,
      message: "job is cancelled; no negotiation send may proceed",
    };
  }
  if (mandate.state === "revoked") {
    return { kind: "stopped" as const, reason: "mandate-revoked" as const };
  }
  if (mandate.state === "concluded") {
    return { kind: "stopped" as const, reason: "mandate-concluded" as const };
  }
  if (mandate.state === "expired" || current.now >= mandate.expiresAt) {
    return { kind: "stopped" as const, reason: "mandate-expired" as const };
  }
  if (mandate.state === "paused") {
    return { kind: "waiting" as const, reason: "mandate-paused" as const };
  }
  if (mandate.state !== "active") {
    return {
      kind: "denied" as const,
      code: "mandate-not-active" as const,
      message: "negotiation mandate is not active",
    };
  }
  if (current.grantStatus === "revoked") {
    return { kind: "stopped" as const, reason: "grant-revoked" as const };
  }
  if (current.grantStatus === "expired" || current.now >= current.grantExpiresAt) {
    return { kind: "stopped" as const, reason: "grant-expired" as const };
  }
  if (current.grantRevocationVersion !== current.operationGrantVersion) {
    return {
      kind: "denied" as const,
      code: "grant-version-changed" as const,
      message: "grant was re-issued; re-approval required before send",
    };
  }
  if (!current.recipientConfigured || current.recipientMailboxNormalized === undefined) {
    return {
      kind: "denied" as const,
      code: "recipient-missing" as const,
      message: "owner recipient is not configured",
    };
  }
  if (current.recipientConfigVersion !== current.currentRecipientConfigVersion) {
    return {
      kind: "denied" as const,
      code: "recipient-changed" as const,
      message: "recipient configuration changed; re-approval required",
    };
  }
  if (current.allowanceExhausted) {
    return {
      kind: "denied" as const,
      code: "allowance-exhausted" as const,
      message: "provider allowance is exhausted",
    };
  }
  if (mandate.roundsUsed >= mandate.roundLimit) {
    return { kind: "stopped" as const, reason: "round-limit-reached" as const };
  }
  if (
    current.quoteSuperseded ||
    current.quoteVersion !== mandate.quoteVersion ||
    current.quoteContentHash !== mandate.quoteContentHash
  ) {
    return {
      kind: current.quoteSuperseded ? ("stopped" as const) : ("stopped" as const),
      reason: (current.quoteSuperseded ? "quote-superseded" : "quote-changed") as NegotiationStopReason,
    };
  }
  if (
    mandate.conversationVersion !== undefined &&
    current.conversationVersion !== undefined &&
    current.conversationVersion !== mandate.conversationVersion
  ) {
    return { kind: "stopped" as const, reason: "conversation-changed" as const };
  }
  if (current.userTakeover) {
    return { kind: "stopped" as const, reason: "user-takeover" as const };
  }
  if (current.finalOfferReceived) {
    return { kind: "stopped" as const, reason: "final-offer" as const };
  }
  return null;
}

/**
 * Idempotency gate over the F1 request-key contract. Identical retries
 * deduplicate without a second send; a reused key with a changed payload
 * conflicts and creates no provider effect.
 */
export function deduplicateNegotiationRetry(
  key: string,
  hash: string,
  prior: PriorNegotiationAttempt | null,
):
  | { readonly outcome: "proceed" }
  | { readonly outcome: "deduplicated" }
  | { readonly outcome: "conflict" } {
  if (prior === null || prior.requestKey !== key) return { outcome: "proceed" as const };
  if (prior.payloadHash === hash) return { outcome: "deduplicated" as const };
  return { outcome: "conflict" as const };
}

/**
 * Honest round accounting: only an observed successful owner-only send
 * increments `roundsUsed`. Ambiguous or failed transport stays honest and
 * never becomes a successful round.
 */
export function applyNegotiationSendOutcome(
  roundsUsed: number,
  outcome: InjectedSendOutcome,
):
  | { readonly sendState: "observedSuccess"; readonly roundsUsedAfter: number; readonly waiting: false }
  | { readonly sendState: "observedFailure" | "outcomeUnknown"; readonly roundsUsedAfter: number; readonly waiting: true } {
  if (outcome === "success") {
    return { sendState: "observedSuccess", roundsUsedAfter: roundsUsed + 1, waiting: false as const };
  }
  return {
    sendState: outcome === "failure" ? "observedFailure" : "outcomeUnknown",
    roundsUsedAfter: roundsUsed,
    waiting: true as const,
  };
}

/** Validate an injected provider result shape before it may affect lineage. */
export function validateInjectedSendResult(
  value: unknown,
):
  | { readonly ok: true; readonly result: InjectedSendResult }
  | { readonly ok: false; readonly code: NegotiationDenialCode; readonly message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "provider result is not an object",
    };
  }
  const outcome = (value as Record<string, unknown>)["outcome"];
  if (outcome !== "success" && outcome !== "failure" && outcome !== "unknown") {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "provider result outcome is malformed",
    };
  }
  const messageId = (value as Record<string, unknown>)["providerMessageId"];
  if (messageId !== undefined && (typeof messageId !== "string" || messageId.trim().length === 0)) {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "provider result message id is malformed",
    };
  }
  return {
    ok: true as const,
    result: {
      outcome,
      ...(typeof messageId === "string" ? { providerMessageId: messageId } : {}),
      ...(((value as Record<string, unknown>)["reason"] as string | undefined) !== undefined &&
      typeof (value as Record<string, unknown>)["reason"] === "string"
        ? { reason: (value as Record<string, unknown>)["reason"] as string }
        : {}),
    },
  };
}

export interface NegotiationStepInput {
  readonly mandate: MandateSnapshot;
  readonly current: NegotiationCurrentSnapshot;
  readonly jev: InjectedJevResult;
  readonly draft?: InjectedDraftResult;
  readonly requestId: string;
  readonly prior?: PriorNegotiationAttempt | null;
  readonly sender: ControlledNegotiationSender;
  readonly subject?: string;
}

function denied(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  move: NegotiationMove | "none",
  code: NegotiationDenialCode,
  message: string,
): NegotiationStepResult {
  const base = baseLineage(mandate, current, requestId, "denied — no supplier-visible text prepared");
  return {
    kind: "denied" as const,
    move,
    code,
    message,
    roundsUsedAfter: mandate.roundsUsed,
    sends: 0 as const,
    lineage: {
      ...base,
      move,
      payloadHash: null,
      sendState: "not-sent" as const,
      denialCode: code,
      redactedPreview: base.redactedPreview,
    },
  };
}

function waiting(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  move: NegotiationMove | "none",
  reason: NegotiationWaitReason,
  preview = "waiting — no supplier-visible text prepared",
): NegotiationStepResult {
  const base = baseLineage(mandate, current, requestId, preview);
  return {
    kind: "waiting" as const,
    move,
    reason,
    roundsUsedAfter: mandate.roundsUsed,
    sends: 0 as const,
    lineage: {
      ...base,
      move,
      payloadHash: null,
      sendState: "not-sent" as const,
      waitReason: reason,
      redactedPreview: base.redactedPreview,
    },
  };
}

function stopped(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  move: NegotiationMove | "none",
  reason: NegotiationStopReason,
): NegotiationStepResult {
  const base = baseLineage(mandate, current, requestId, "stopped — no supplier-visible text prepared");
  return {
    kind: "stopped" as const,
    move,
    reason,
    roundsUsedAfter: mandate.roundsUsed,
    sends: 0 as const,
    lineage: {
      ...base,
      move,
      payloadHash: null,
      sendState: "not-sent" as const,
      stopReason: reason,
      redactedPreview: base.redactedPreview,
    },
  };
}

/**
 * Execute one controlled negotiation step: fence, permitted move selection,
 * deterministic draft validation, owner-only outbound validation, idempotent
 * controlled dispatch, and honest round accounting. Zero live provider or
 * model calls; the injected sender is the only effect, and it is invoked at
 * most once, only after every check passes. Never accepts terms, places an
 * order, or commits money.
 */
export function runNegotiationStep(input: NegotiationStepInput): NegotiationStepResult {
  const { mandate, current, requestId, sender } = input;
  if (requestId.trim().length === 0) {
    return denied(mandate, current, requestId, "none", "provider-result-malformed", "request id is required");
  }

  const fence = checkNegotiationFences(mandate, current);
  if (fence !== null) {
    if (fence.kind === "stopped") return stopped(mandate, current, requestId, "none", fence.reason);
    if (fence.kind === "waiting") return waiting(mandate, current, requestId, "none", fence.reason);
    return denied(mandate, current, requestId, "none", fence.code, fence.message);
  }

  const selected = selectNegotiationMove(input.jev);
  if (!selected.ok) {
    if (selected.kind === "waiting") return waiting(mandate, current, requestId, "none", selected.reason);
    return denied(mandate, current, requestId, "none", selected.code, selected.message);
  }
  const move = selected.move;
  if (move === "stop") return stopped(mandate, current, requestId, move, "stop-move");
  if (move === "hold") {
    return waiting(mandate, current, requestId, move, "waiting-for-owner");
  }

  const draft = input.draft;
  if (draft === undefined) {
    return denied(mandate, current, requestId, move, "draft-malformed", "clarify/counter requires draft text");
  }
  if (draft.inputVersion !== draft.currentInputVersion || draft.outcome === "stale") {
    return waiting(mandate, current, requestId, move, "draft-stale");
  }
  if (draft.outcome === "unavailable" || draft.outcome === "rejected") {
    return waiting(mandate, current, requestId, move, "draft-unavailable");
  }
  if (draft.model !== NEGOTIATION_OPENAI_MODEL) {
    return denied(mandate, current, requestId, move, "draft-malformed", "draft is not from the pinned drafting model");
  }
  if (
    draft.sourceQuoteVersion !== undefined &&
    (draft.sourceQuoteVersion !== mandate.quoteVersion ||
      (draft.sourceConversationVersion !== undefined &&
        mandate.conversationVersion !== undefined &&
        draft.sourceConversationVersion !== mandate.conversationVersion))
  ) {
    return waiting(mandate, current, requestId, move, "draft-stale");
  }

  const checked = validateNegotiationDraft(draft.content, {
    ...(mandate.targetMinorUnits === undefined ? {} : { targetMinorUnits: mandate.targetMinorUnits }),
    ...(mandate.ceilingMinorUnits === undefined ? {} : { ceilingMinorUnits: mandate.ceilingMinorUnits }),
    ...(current.recipientMailboxNormalized === undefined
      ? {}
      : { ownerMailboxNormalized: current.recipientMailboxNormalized }),
  });
  if (!checked.ok) {
    return denied(mandate, current, requestId, move, checked.code, checked.message);
  }

  // Keep the draft shape identical to the OpenAI supplier-draft output
  // contract without importing server transport: content plus source refs.
  const supplierDraft: SupplierDraftOutput = {
    kind: "supplierDraft",
    draftKind: draft.draftKind ?? move,
    content: draft.content ?? "",
    sources: [],
  };
  void supplierDraft;

  const outboundValue = {
    to: current.recipientMailboxNormalized ?? "",
    cc: [],
    bcc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject: input.subject ?? `Negotiation ${move} — controlled demo`,
    body: draft.content ?? "",
  };
  const validated = validateOutboundPayload(outboundValue, current.recipientMailboxNormalized);
  if (isCommunicationDenial(validated)) {
    return denied(mandate, current, requestId, move, "outbound-denied", validated.message);
  }
  const canonical = canonicalJson(outboundValue);
  if (canonical !== validated.canonical) {
    return denied(mandate, current, requestId, move, "outbound-denied", "payload canonical form changed");
  }
  const hash = payloadHash(outboundValue);
  const key = requestKey(mandate.organizationId, NEGOTIATION_OPERATION_KIND, requestId);

  const gate = deduplicateNegotiationRetry(key, hash, input.prior ?? null);
  if (gate.outcome === "conflict") {
    return denied(mandate, current, requestId, move, "retry-conflict", "request key reused with a changed payload");
  }
  if (gate.outcome === "deduplicated") {
    const base = baseLineage(mandate, current, requestId, checked.redactedPreview);
    return {
      kind: "deduplicated" as const,
      move,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: mandate.roundsUsed,
      sends: 0 as const,
      lineage: {
        ...base,
        move,
        payloadHash: hash,
        sendState: "deduplicated" as const,
        redactedPreview: checked.redactedPreview,
      },
    };
  }

  if (sender.executionMode !== "controlled") {
    return denied(mandate, current, requestId, move, "live-transport-refused", "only controlled dispatch is permitted");
  }
  const raw = sender.send({ canonical, payloadHash: hash, requestKey: key });
  const parsed = validateInjectedSendResult(raw);
  if (!parsed.ok) {
    return denied(mandate, current, requestId, move, parsed.code, parsed.message);
  }
  const accounting = applyNegotiationSendOutcome(mandate.roundsUsed, parsed.result.outcome);
  const base = baseLineage(mandate, current, requestId, checked.redactedPreview);
  if (!accounting.waiting) {
    return {
      kind: "sent" as const,
      move,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: accounting.roundsUsedAfter,
      sends: 1 as const,
      lineage: {
        ...base,
        move,
        payloadHash: hash,
        sendState: accounting.sendState,
        roundsUsedAfter: accounting.roundsUsedAfter,
        redactedPreview: checked.redactedPreview,
        ...(parsed.result.providerMessageId === undefined
          ? {}
          : { providerMessageId: parsed.result.providerMessageId }),
      },
    };
  }
  return {
    kind: "waiting" as const,
    move,
    reason: (parsed.result.outcome === "failure" ? "send-failure" : "outcome-unknown") as NegotiationWaitReason,
    roundsUsedAfter: accounting.roundsUsedAfter,
    sends: 0 as const,
    lineage: {
      ...base,
      move,
      payloadHash: hash,
      sendState: accounting.sendState,
      roundsUsedAfter: accounting.roundsUsedAfter,
      waitReason: (parsed.result.outcome === "failure" ? "send-failure" : "outcome-unknown") as NegotiationWaitReason,
      redactedPreview: checked.redactedPreview,
      ...(parsed.result.providerMessageId === undefined
        ? {}
        : { providerMessageId: parsed.result.providerMessageId }),
    },
  };
}

/** Versioned controlled E6 corpus extending J-06 (no new thresholds). */
export interface E6NegotiationCorpusCase {
  readonly id: string;
  /** Originating J-06 category this negotiation case extends. */
  readonly j06Category:
    | "incomplete-offer"
    | "short-followup"
    | "unrelated"
    | "adversarial"
    | "changed-reply";
  readonly description: string;
  /** Injected Jev choice for the case. Controlled demo content only. */
  readonly jevChoice: string;
  /** Moves the versioned policy accepts for this case. */
  readonly permittedMoves: readonly NegotiationMove[];
  readonly provenance: "controlled" | "injected";
}

export const E6_NEGOTIATION_CORPUS: readonly E6NegotiationCorpusCase[] = [
  {
    id: "e6-neg-01",
    j06Category: "incomplete-offer",
    description: "Incomplete owner terms select a permitted clarification move.",
    jevChoice: "clarify",
    permittedMoves: ["clarify", "counter"],
    provenance: "controlled",
  },
  {
    id: "e6-neg-02",
    j06Category: "incomplete-offer",
    description: "Incomplete owner terms select a permitted counter move.",
    jevChoice: "counter",
    permittedMoves: ["clarify", "counter"],
    provenance: "controlled",
  },
  {
    id: "e6-neg-03",
    j06Category: "short-followup",
    description: "Short owner follow-up holds for the owner's next reply.",
    jevChoice: "hold",
    permittedMoves: ["hold"],
    provenance: "controlled",
  },
  {
    id: "e6-neg-04",
    j06Category: "unrelated",
    description: "Unrelated request stops without a supplier send.",
    jevChoice: "stop",
    permittedMoves: ["stop"],
    provenance: "controlled",
  },
  {
    id: "e6-neg-05",
    j06Category: "adversarial",
    description: "Injected supplier instruction stops without a supplier send.",
    jevChoice: "stop",
    permittedMoves: ["stop"],
    provenance: "injected",
  },
  {
    id: "e6-neg-06",
    j06Category: "changed-reply",
    description: "Changed owner reply re-enters clarification under the current mandate.",
    jevChoice: "clarify",
    permittedMoves: ["clarify", "counter", "hold"],
    provenance: "controlled",
  },
];

/**
 * Score the versioned E6 corpus with the injected move selector. Reports
 * per-case in-policy selection without inventing thresholds: a case passes
 * when the selected move is within its permitted set.
 */
export function scoreE6NegotiationCorpus(
  select: (choice: string) => NegotiationMove | null,
): {
  readonly corpusVersion: typeof E6_NEGOTIATION_CORPUS_VERSION;
  readonly evaluated: number;
  readonly inPolicy: number;
  readonly outOfPolicy: readonly string[];
} {
  const outOfPolicy: string[] = [];
  for (const item of E6_NEGOTIATION_CORPUS) {
    const move = select(item.jevChoice);
    if (move === null || !item.permittedMoves.includes(move)) outOfPolicy.push(item.id);
  }
  return {
    corpusVersion: E6_NEGOTIATION_CORPUS_VERSION,
    evaluated: E6_NEGOTIATION_CORPUS.length,
    inPolicy: E6_NEGOTIATION_CORPUS.length - outOfPolicy.length,
    outOfPolicy,
  };
}

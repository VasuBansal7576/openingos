/**
 * E6 controlled negotiation policy and adapter contract (P-05 / P-23,
 * controlled D-12, controlled J-06 extension; supports P-13 / P-17).
 *
 * Honest scope: this module is a CONTROLLED, PURE policy contract. It
 * performs no Convex reads or writes, persists no lineage rows, and makes no
 * Jev, OpenAI, or AgentMail call of any kind. Every model/provider outcome
 * here is an injected controlled value, and the only effect is one call to
 * an injected controlled sender whose result must mirror the existing
 * `communication/send:dispatch` result shape. Returned lineage objects are
 * unpersisted in-memory values: they describe the existing-record references
 * (negotiation, quote, conversation, F1 operation kind, request key, payload
 * hash, attempt outcome) that a future production orchestrator must store,
 * but this module stores nothing.
 *
 * Production wiring still open (NOT implemented here, and not claimed):
 * a production orchestrator package must (1) load mandate/current snapshots
 * from live Convex rows, (2) call the real `models/jev:classify` decision
 * and `models/openai:draft` actions, (3) claim an F1 operation and
 * reservation, (4) invoke the real `communication/send:dispatch` action, and
 * (5) persist the returned lineage against existing records. Until that
 * package lands, this module only proves the policy that orchestrator must
 * consume. It must never be presented as a live negotiation, a persisted
 * history, or a completed external send.
 *
 * Consumed boundaries (shapes only, never invoked against live transport):
 *
 * - Move selection mirrors the Jev typed decision boundary (ADR-0005,
 *   `proofs/jev/jev-boundary.ts`): only a validated, current `decided`
 *   choice over the permitted move catalog may supply a move. The pinned
 *   model constant is imported from that boundary so drift is a
 *   compile-time fact, not a string copy.
 * - Clarify/counter drafts mirror the OpenAI supplier-draft boundary shape
 *   (ADR-0005, `convex/models/openai.ts`): the dated
 *   `gpt-5.4-mini-2026-03-17` snapshot, mandatory source pins, and the
 *   output byte bound. The constant below mirrors that boundary; the type
 *   import keeps the draft shape identical without pulling server-only
 *   transport into this pure module.
 * - Outbound validation reuses the existing C1 communication boundary
 *   (`convex/communication/contracts.ts` `validateOutboundPayload`), which
 *   binds the payload to the single server-configured owner mailbox and
 *   rejects CC/BCC, Reply-To redirection, alternate profiles, and unsafe
 *   content.
 * - The controlled sender result mirrors the existing
 *   `communication/send:dispatch` result shape (`ok`, `outcome`,
 *   `providerMessageId`, `providerThreadId`, `recorded`, or a denial).
 * - Idempotency reuses the F1 request-key contract
 *   (`convex/shared/hashing.ts` `requestKey`/`payloadHash`): identical
 *   retries deduplicate, changed payloads conflict, and no second send path
 *   exists here.
 *
 * Owner-authored terms flowing through here are controlled demo evidence
 * (`counterpartyRole: ownerStandIn`, `executionMode: controlled`) and never
 * realized savings; confidential target/ceiling figures and the private
 * owner mailbox never enter public projections, logs, or evidence — lineage
 * carries only redacted previews and hashes.
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
/**
 * The single fixed server-derived subject. Caller-controlled subject text
 * was removed: confidential values cannot leak through a channel the caller
 * cannot write to. The constant carries no figures or addresses, and every
 * step re-validates it against the mandate disclosure before dispatch.
 */
export const NEGOTIATION_SUBJECT = "Negotiation follow-up — controlled demo" as const;

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
  | "invalid-bounds"
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
  | "grant-binding-changed"
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
  | "dispatch-denied"
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
  /** Current quote identity. Must exactly equal the mandate quote id. */
  readonly currentQuoteId?: string;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly quoteSuperseded: boolean;
  /** Current conversation identity. Exact-equality with the mandate is required. */
  readonly currentConversationId?: string;
  readonly conversationVersion?: number;
  readonly jobState: NegotiationJobState;
  readonly jobCancelled: boolean;
  readonly grantStatus: NegotiationGrantStatus;
  readonly grantExpiresAt: number;
  /** Current grant binding. Must exactly equal the operation grant binding. */
  readonly currentGrantId?: string;
  /** Grant binding the operation was approved under. */
  readonly operationGrantId?: string;
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

/**
 * Controlled adapter result mirroring the existing
 * `communication/send:dispatch` result shape: a success/failure/unknown
 * outcome with provider ids and a recorded flag, or a denial. A `success`
 * may advance the round only when `recorded` is true and
 * `providerMessageId` is a nonempty string; anything else stays honest.
 */
export interface ControlledDispatchSuccess {
  readonly ok: true;
  readonly outcome: "success" | "failure" | "unknown";
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly recorded: boolean;
}

export interface ControlledDispatchDenial {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ControlledDispatchResult = ControlledDispatchSuccess | ControlledDispatchDenial;

export interface PriorNegotiationAttempt {
  readonly requestKey: string;
  readonly payloadHash: string;
}

/**
 * Controlled stand-in for the `communication/send:dispatch` path. The only
 * accepted execution mode is `controlled`; any other mode is refused before
 * invocation, and this task never invokes dispatch against configured
 * transport. The injected result must mirror the real dispatch shape above;
 * malformed or unrecorded success never advances a round.
 */
export interface ControlledNegotiationSender {
  readonly executionMode: "controlled";
  readonly send: (payload: {
    readonly canonical: string;
    readonly payloadHash: string;
    readonly requestKey: string;
  }) => ControlledDispatchResult;
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
  readonly providerThreadId?: string;
  /** Controlled dispatch invocations this step performed (0 or 1). */
  readonly dispatchAttempts: number;
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
      readonly dispatchAttempts: 1;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "deduplicated";
      readonly move: Extract<NegotiationMove, "clarify" | "counter">;
      readonly requestKey: string;
      readonly payloadHash: string;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly dispatchAttempts: 0;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "waiting";
      readonly move: NegotiationMove | "none";
      readonly reason: NegotiationWaitReason;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly dispatchAttempts: 0 | 1;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "stopped";
      readonly move: NegotiationMove | "none";
      readonly reason: NegotiationStopReason;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly dispatchAttempts: 0;
      readonly lineage: NegotiationLineage;
    }
  | {
      readonly kind: "denied";
      readonly move: NegotiationMove | "none";
      readonly code: NegotiationDenialCode;
      readonly message: string;
      readonly roundsUsedAfter: number;
      readonly sends: 0;
      readonly dispatchAttempts: 0 | 1;
      readonly lineage: NegotiationLineage;
    };

function isMove(value: unknown): value is NegotiationMove {
  return (
    value === "clarify" || value === "counter" || value === "hold" || value === "stop"
  );
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Fail-closed numeric projection: malformed counts never reach handling. */
function safeCount(value: unknown): number {
  return isNonNegativeSafeInt(value) ? value : 0;
}

function baseLineage(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  redactedPreview: string,
  dispatchAttempts: number,
): Omit<NegotiationLineage, "move" | "payloadHash" | "sendState"> {
  const roundsUsed = safeCount(mandate.roundsUsed);
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
    round: roundsUsed + 1,
    roundsUsedAfter: roundsUsed,
    operationKind: NEGOTIATION_OPERATION_KIND,
    requestKey: requestKey(mandate.organizationId, NEGOTIATION_OPERATION_KIND, requestId),
    dispatchAttempts,
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
  renderings.add(
    major.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  );
  return [...renderings];
}

/**
 * Fail-closed confidential-figure detector. Besides fixed renderings (minor
 * units, major units with decimals, US/EU grouped forms), every digit run in
 * the text is normalized by stripping spaces, thousand/decimal separators
 * and apostrophes, then compared against the minor-units digits and the
 * major-units digits. Any match is a leak. Deliberately fail-closed: a
 * supplier-visible draft that quotes a figure indistinguishable from a
 * confidential target/ceiling is denied rather than risking disclosure.
 */
function confidentialFigureLeaked(text: string, minorUnits: number): boolean {
  const lowered = text.toLowerCase();
  for (const rendering of confidentialRenderings(minorUnits)) {
    if (rendering.length > 0 && lowered.includes(rendering.toLowerCase())) return true;
  }
  const minorDigits = String(minorUnits).replace(/^0+(?=\d)/, "");
  const majorDigits = String(Math.trunc(minorUnits / 100)).replace(/^0+(?=\d)/, "");
  for (const match of text.matchAll(/[\d][\d\s.,']*/g)) {
    const digits = match[0].replace(/[\s.,']/g, "").replace(/^0+(?=\d)/, "");
    if (digits.length === 0) continue;
    if (digits === minorDigits || digits === majorDigits) return true;
  }
  return false;
}

function mailboxLeaked(text: string, ownerMailboxNormalized: string | undefined): boolean {
  const mailbox = ownerMailboxNormalized?.trim().toLowerCase();
  if (mailbox === undefined || mailbox.length === 0) return false;
  const lowered = text.toLowerCase();
  if (lowered.includes(mailbox)) return true;
  const localPart = mailbox.split("@")[0] ?? "";
  return localPart.length >= 3 && lowered.includes(localPart);
}

/**
 * Deterministically validate supplier-visible text against the mandate
 * disclosure. Rejects empty or oversized text, active HTML,
 * instruction-shaped text, and any leak of confidential target/ceiling
 * figures or the private owner mailbox. Never accepts, orders, or commits
 * anything: drafts are clarification/counter text only.
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
  const secrets: number[] = [];
  if (disclosure.targetMinorUnits !== undefined) secrets.push(disclosure.targetMinorUnits);
  if (disclosure.ceilingMinorUnits !== undefined) secrets.push(disclosure.ceilingMinorUnits);
  for (const secret of secrets) {
    if (!isNonNegativeSafeInt(secret)) continue;
    if (confidentialFigureLeaked(content, secret)) {
      return {
        ok: false as const,
        code: "draft-disclosure-leak" as const,
        message: "negotiation draft discloses a confidential negotiating figure",
      };
    }
  }
  if (mailboxLeaked(content, disclosure.ownerMailboxNormalized)) {
    return {
      ok: false as const,
      code: "draft-disclosure-leak" as const,
      message: "negotiation draft discloses the private owner mailbox",
    };
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
 * Runtime numeric bounds, checked before every fence and transition so that
 * malformed counts from untyped callers fail closed. No NaN, infinity,
 * non-integer, or negative round/expiry/version figure may reach
 * model/draft/dispatch handling.
 */
export function checkNegotiationBounds(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
):
  | { readonly kind: "denied"; readonly code: NegotiationDenialCode; readonly message: string }
  | null {
  const required: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["roundsUsed", mandate.roundsUsed, false],
    ["roundLimit", mandate.roundLimit, true],
    ["expiresAt", mandate.expiresAt, false],
    ["now", current.now, false],
    ["grantExpiresAt", current.grantExpiresAt, false],
    ["grantRevocationVersion", current.grantRevocationVersion, false],
    ["operationGrantVersion", current.operationGrantVersion, false],
  ];
  for (const [field, value, positive] of required) {
    if (!isNonNegativeSafeInt(value) || (positive && value <= 0)) {
      return {
        kind: "denied" as const,
        code: "invalid-bounds" as const,
        message: `negotiation ${field} is not a usable bound`,
      };
    }
  }
  const optional: ReadonlyArray<readonly [string, unknown]> = [
    ["targetMinorUnits", mandate.targetMinorUnits],
    ["ceilingMinorUnits", mandate.ceilingMinorUnits],
    ["conversationVersion(mandate)", mandate.conversationVersion],
    ["conversationVersion(current)", current.conversationVersion],
    ["recipientConfigVersion", current.recipientConfigVersion],
    ["currentRecipientConfigVersion", current.currentRecipientConfigVersion],
  ];
  for (const [field, value] of optional) {
    if (value !== undefined && !isNonNegativeSafeInt(value)) {
      return {
        kind: "denied" as const,
        code: "invalid-bounds" as const,
        message: `negotiation ${field} is not a usable bound`,
      };
    }
  }
  return null;
}

/**
 * Re-check current authority immediately before every consequential
 * transition. Requires exact current quote identity and exact current
 * conversation identity (both directions of present-versus-missing count as
 * a change), exact grant id binding, and all mandate/grant/recipient/round
 * fences. Returns the first applicable fence: terminal stops, honest waits,
 * or denials — each with zero sends. Returns `null` when the loop may
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
  if (
    current.currentGrantId === undefined ||
    current.operationGrantId === undefined ||
    current.currentGrantId !== current.operationGrantId
  ) {
    return {
      kind: "denied" as const,
      code: "grant-binding-changed" as const,
      message: "grant binding changed or is missing; re-approval required before send",
    };
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
    current.currentQuoteId !== mandate.quoteId ||
    current.quoteSuperseded ||
    current.quoteVersion !== mandate.quoteVersion ||
    current.quoteContentHash !== mandate.quoteContentHash
  ) {
    return {
      kind: "stopped" as const,
      reason: (current.quoteSuperseded ? "quote-superseded" : "quote-changed") as NegotiationStopReason,
    };
  }
  if (mandate.conversationId === undefined) {
    if (current.currentConversationId !== undefined || current.conversationVersion !== undefined) {
      return { kind: "stopped" as const, reason: "conversation-changed" as const };
    }
  } else {
    if (current.currentConversationId !== mandate.conversationId) {
      return { kind: "stopped" as const, reason: "conversation-changed" as const };
    }
    if (current.conversationVersion !== mandate.conversationVersion) {
      return { kind: "stopped" as const, reason: "conversation-changed" as const };
    }
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

/** Validate a controlled adapter result before it may affect lineage. */
export function validateControlledDispatchResult(
  value: unknown,
):
  | { readonly ok: true; readonly result: ControlledDispatchSuccess | ControlledDispatchDenial }
  | { readonly ok: false; readonly code: NegotiationDenialCode; readonly message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "dispatch result is not an object",
    };
  }
  const record = value as Record<string, unknown>;
  if (record["ok"] === false) {
    if (typeof record["code"] !== "string" || record["code"].trim().length === 0) {
      return {
        ok: false as const,
        code: "provider-result-malformed" as const,
        message: "dispatch denial carries no code",
      };
    }
    if (typeof record["message"] !== "string" || record["message"].trim().length === 0) {
      return {
        ok: false as const,
        code: "provider-result-malformed" as const,
        message: "dispatch denial carries no message",
      };
    }
    return {
      ok: true as const,
      result: { ok: false as const, code: record["code"], message: record["message"] },
    };
  }
  if (record["ok"] !== true) {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "dispatch result carries no ok flag",
    };
  }
  const outcome = record["outcome"];
  if (outcome !== "success" && outcome !== "failure" && outcome !== "unknown") {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "dispatch result outcome is malformed",
    };
  }
  for (const field of ["providerMessageId", "providerThreadId"] as const) {
    const entry = record[field];
    if (entry !== null && (typeof entry !== "string" || entry.trim().length === 0)) {
      return {
        ok: false as const,
        code: "provider-result-malformed" as const,
        message: `dispatch result ${field} is malformed`,
      };
    }
  }
  if (typeof record["recorded"] !== "boolean") {
    return {
      ok: false as const,
      code: "provider-result-malformed" as const,
      message: "dispatch result recorded flag is malformed",
    };
  }
  return {
    ok: true as const,
    result: {
      ok: true as const,
      outcome,
      providerMessageId: record["providerMessageId"] as string | null,
      providerThreadId: record["providerThreadId"] as string | null,
      recorded: record["recorded"] as boolean,
    },
  };
}

/**
 * Honest round accounting over the dispatch-shaped adapter result. A round
 * advances only for an observed, recorded success carrying a nonempty
 * provider message id. Unrecorded or id-less "success" denies and never
 * increments; failure/unknown stays waiting without claiming a send.
 */
export function applyControlledDispatchOutcome(
  roundsUsed: number,
  result: ControlledDispatchSuccess | ControlledDispatchDenial,
):
  | { readonly outcome: "sent"; readonly sendState: "observedSuccess"; readonly roundsUsedAfter: number }
  | { readonly outcome: "waiting"; readonly sendState: "observedFailure" | "outcomeUnknown"; readonly reason: NegotiationWaitReason; readonly roundsUsedAfter: number }
  | { readonly outcome: "denied"; readonly code: NegotiationDenialCode; readonly message: string; readonly roundsUsedAfter: number } {
  const base = safeCount(roundsUsed);
  if (!result.ok) {
    return {
      outcome: "denied" as const,
      code: "dispatch-denied" as const,
      message: result.message,
      roundsUsedAfter: base,
    };
  }
  if (result.outcome === "failure") {
    return {
      outcome: "waiting" as const,
      sendState: "observedFailure" as const,
      reason: "send-failure" as const,
      roundsUsedAfter: base,
    };
  }
  if (result.outcome === "unknown") {
    return {
      outcome: "waiting" as const,
      sendState: "outcomeUnknown" as const,
      reason: "outcome-unknown" as const,
      roundsUsedAfter: base,
    };
  }
  if (!result.recorded || result.providerMessageId === null) {
    return {
      outcome: "denied" as const,
      code: "provider-result-malformed" as const,
      message: "unrecorded dispatch success cannot advance a negotiation round",
      roundsUsedAfter: base,
    };
  }
  return { outcome: "sent" as const, sendState: "observedSuccess" as const, roundsUsedAfter: base + 1 };
}

export interface NegotiationStepInput {
  readonly mandate: MandateSnapshot;
  readonly current: NegotiationCurrentSnapshot;
  readonly jev: InjectedJevResult;
  readonly draft?: InjectedDraftResult;
  readonly requestId: string;
  readonly prior?: PriorNegotiationAttempt | null;
  readonly sender: ControlledNegotiationSender;
}

function denied(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
  requestId: string,
  move: NegotiationMove | "none",
  code: NegotiationDenialCode,
  message: string,
  dispatchAttempts: 0 | 1 = 0,
): NegotiationStepResult {
  const base = baseLineage(mandate, current, requestId, "denied — no supplier-visible text prepared", dispatchAttempts);
  return {
    kind: "denied" as const,
    move,
    code,
    message,
    roundsUsedAfter: base.roundsUsedAfter,
    sends: 0 as const,
    dispatchAttempts,
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
  dispatchAttempts: 0 | 1 = 0,
  payloadHashValue: string | null = null,
  sendState: NegotiationLineage["sendState"] = "not-sent",
  providerIds: { readonly messageId: string | null; readonly threadId: string | null } | null = null,
): NegotiationStepResult {
  const base = baseLineage(mandate, current, requestId, preview, dispatchAttempts);
  return {
    kind: "waiting" as const,
    move,
    reason,
    roundsUsedAfter: base.roundsUsedAfter,
    sends: 0 as const,
    dispatchAttempts,
    lineage: {
      ...base,
      move,
      payloadHash: payloadHashValue,
      sendState,
      waitReason: reason,
      redactedPreview: base.redactedPreview,
      ...(providerIds?.messageId == null ? {} : { providerMessageId: providerIds.messageId }),
      ...(providerIds?.threadId == null ? {} : { providerThreadId: providerIds.threadId }),
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
  const base = baseLineage(mandate, current, requestId, "stopped — no supplier-visible text prepared", 0);
  return {
    kind: "stopped" as const,
    move,
    reason,
    roundsUsedAfter: base.roundsUsedAfter,
    sends: 0 as const,
    dispatchAttempts: 0 as const,
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

function disclosureOf(
  mandate: MandateSnapshot,
  current: NegotiationCurrentSnapshot,
): {
  readonly targetMinorUnits?: number;
  readonly ceilingMinorUnits?: number;
  readonly ownerMailboxNormalized?: string;
} {
  return {
    ...(mandate.targetMinorUnits === undefined ? {} : { targetMinorUnits: mandate.targetMinorUnits }),
    ...(mandate.ceilingMinorUnits === undefined ? {} : { ceilingMinorUnits: mandate.ceilingMinorUnits }),
    ...(current.recipientMailboxNormalized === undefined
      ? {}
      : { ownerMailboxNormalized: current.recipientMailboxNormalized }),
  };
}

/**
 * Execute one controlled negotiation step: runtime bounds, exact-basis
 * fences, permitted move selection, exact draft-basis validation, disclosure
 * screening of the fixed subject and draft body, owner-only outbound
 * validation, idempotent controlled dispatch, and honest round accounting.
 * Zero live provider or model calls; the injected controlled sender is the
 * only effect, invoked at most once and only after every check passes.
 * Never accepts terms, places an order, or commits money.
 */
export function runNegotiationStep(input: NegotiationStepInput): NegotiationStepResult {
  const { mandate, current, requestId, sender } = input;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return denied(mandate, current, String(requestId), "none", "invalid-bounds", "request id is required");
  }

  const bounds = checkNegotiationBounds(mandate, current);
  if (bounds !== null) {
    return denied(mandate, current, requestId, "none", bounds.code, bounds.message);
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
  if (draft.sourceQuoteVersion === undefined) {
    return denied(mandate, current, requestId, move, "draft-malformed", "draft is not pinned to a quote version");
  }
  if (draft.sourceQuoteVersion !== mandate.quoteVersion) {
    return waiting(mandate, current, requestId, move, "draft-stale");
  }
  if (mandate.conversationVersion !== undefined) {
    if (draft.sourceConversationVersion === undefined) {
      return denied(mandate, current, requestId, move, "draft-malformed", "draft is not pinned to the mandate conversation");
    }
    if (draft.sourceConversationVersion !== mandate.conversationVersion) {
      return waiting(mandate, current, requestId, move, "draft-stale");
    }
  } else if (draft.sourceConversationVersion !== undefined) {
    return waiting(mandate, current, requestId, move, "draft-stale");
  }
  if (draft.draftKind === undefined || draft.draftKind !== move) {
    return denied(mandate, current, requestId, move, "draft-malformed", "draft kind does not match the selected move");
  }

  const disclosure = disclosureOf(mandate, current);
  if (
    confidentialFigureLeakedSafe(NEGOTIATION_SUBJECT, disclosure) ||
    mailboxLeaked(NEGOTIATION_SUBJECT, disclosure.ownerMailboxNormalized)
  ) {
    return denied(mandate, current, requestId, move, "draft-disclosure-leak", "fixed subject fails disclosure screening");
  }
  const checked = validateNegotiationDraft(draft.content, disclosure);
  if (!checked.ok) {
    return denied(mandate, current, requestId, move, checked.code, checked.message);
  }

  // Keep the draft shape identical to the OpenAI supplier-draft output
  // contract without importing server transport: content plus source refs.
  // This value is never sent anywhere; it exists so reviewers can verify
  // the controlled shape matches the boundary type.
  const supplierDraft: SupplierDraftOutput = {
    kind: "supplierDraft",
    draftKind: draft.draftKind,
    content: draft.content ?? "",
    sources: [],
  };
  void supplierDraft;

  const outboundValue = {
    to: current.recipientMailboxNormalized ?? "",
    cc: [],
    bcc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject: NEGOTIATION_SUBJECT,
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
    const base = baseLineage(mandate, current, requestId, checked.redactedPreview, 0);
    return {
      kind: "deduplicated" as const,
      move,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: base.roundsUsedAfter,
      sends: 0 as const,
      dispatchAttempts: 0 as const,
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
  const parsed = validateControlledDispatchResult(raw);
  if (!parsed.ok) {
    return denied(mandate, current, requestId, move, parsed.code, parsed.message, 1);
  }
  if (!parsed.result.ok) {
    return denied(mandate, current, requestId, move, "dispatch-denied", parsed.result.message, 1);
  }
  const accounting = applyControlledDispatchOutcome(safeCount(mandate.roundsUsed), parsed.result);
  const base = baseLineage(mandate, current, requestId, checked.redactedPreview, 1);
  const thread = parsed.result.providerThreadId;
  const message = parsed.result.providerMessageId;
  if (accounting.outcome === "sent") {
    return {
      kind: "sent" as const,
      move,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: accounting.roundsUsedAfter,
      sends: 1 as const,
      dispatchAttempts: 1 as const,
      lineage: {
        ...base,
        move,
        payloadHash: hash,
        sendState: accounting.sendState,
        roundsUsedAfter: accounting.roundsUsedAfter,
        redactedPreview: checked.redactedPreview,
        ...(message === null ? {} : { providerMessageId: message }),
        ...(thread === null ? {} : { providerThreadId: thread }),
      },
    };
  }
  if (accounting.outcome === "waiting") {
    return waiting(
      mandate,
      current,
      requestId,
      move,
      accounting.reason,
      checked.redactedPreview,
      1,
      hash,
      accounting.sendState,
      { messageId: parsed.result.providerMessageId, threadId: parsed.result.providerThreadId },
    );
  }
  return denied(mandate, current, requestId, move, accounting.code, accounting.message, 1);
}

function confidentialFigureLeakedSafe(
  text: string,
  disclosure: { readonly targetMinorUnits?: number; readonly ceilingMinorUnits?: number },
): boolean {
  if (disclosure.targetMinorUnits !== undefined && isNonNegativeSafeInt(disclosure.targetMinorUnits)) {
    if (confidentialFigureLeaked(text, disclosure.targetMinorUnits)) return true;
  }
  if (disclosure.ceilingMinorUnits !== undefined && isNonNegativeSafeInt(disclosure.ceilingMinorUnits)) {
    if (confidentialFigureLeaked(text, disclosure.ceilingMinorUnits)) return true;
  }
  return false;
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

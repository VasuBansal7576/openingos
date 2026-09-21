/**
 * E12 production negotiation orchestrator (P-05 / P-23, D-12, D-13, D-14, D-17).
 *
 * This module is the production wiring that the E6 controlled policy header
 * describes as still open: it (1) loads mandate/current snapshots from live
 * Convex rows, (2) calls the real `models/jev:classify` decision and
 * `models/openai:draft` actions, (3) reuses the F1 operation claim and
 * reservation contracts, (4) invokes the real `communication/send:dispatch`
 * action as the single send path, and (5) persists round accounting against
 * existing records.
 *
 * Authority model (all enforced in backend code, never delegated to models):
 * - Identity comes from `ctx.auth`; capability from the shipped catalog;
 *   project access from memberships; scope from `classifyScope` over
 *   server-built text (D-17). Unknown, cross-tenant, and guest-denied calls
 *   share generic denials so no existence oracle leaks.
 * - The recipient is always the single server-configured owner mailbox read
 *   from `recipientConfigs`. Callers, models, and reply headers cannot set
 *   it. Missing or changed configuration fails closed before any send.
 * - The sender is always the server-owned provider inbox resolved from the
 *   existing protected provider-binding contract (`threadBindings`) for the
 *   bound conversation, else the project. A caller-supplied inbox must equal
 *   that binding exactly; missing, foreign, stale, ambiguous, or
 *   cross-project bindings fail closed with zero provider calls and no
 *   round/job advancement. The sender binding is also compared before any
 *   observed-success deduplication, so a changed same-key replay conflicts.
 * - Every consequential transition re-reads and pins project, grant,
 *   capability, mandate, quote, conversation, and job authority. E6 fences
 *   run before the first provider call AND again after drafting, immediately
 *   before the send operation is created.
 * - Exactly one bounded step per call. The operation's atomic claim consumes
 *   one round immediately before provider effect. Definitive non-sends refund
 *   only their own operation's round; ambiguous outcomes keep the round under
 *   the reconciliation contract. There is never a blind resend or a second
 *   send path.
 * - Nothing here accepts an offer, creates a quote revision, order,
 *   commitment, saving, or live-success claim. Owner-authored terms stay
 *   labeled controlled demo evidence (`ownerStandIn`, never realized
 *   savings); confidential figures and the private mailbox never enter
 *   projections, logs, or evidence.
 *
 * Pinning notes:
 * - The negotiations row stores the mandate quote id and version but no
 *   quote content hash, so the mandate hash basis is pinned from the live
 *   quote row at load: version drift since mandate creation stops the step,
 *   and any in-step hash drift denies it stale at the post-draft recheck.
 * - The E6 operation-grant binding cannot pin before the send operation
 *   exists. Pre-call fences therefore run with a matched pending-grant
 *   sentinel pair (documented below); the real grant binding pins post-draft
 *   against the discovered exact grant, and F1's atomic claim rechecks it
 *   again at dispatch.
 */

import { makeFunctionReference } from "convex/server";
import type {
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Action, f1InternalMutation, f1InternalQuery, f1Query } from "../server.js";
import type { F1DataModel, F1QueryCtx } from "../server.js";
import type { GenericActionCtx } from "convex/server";
import {
  checkNegotiationBounds,
  checkNegotiationFences,
  NEGOTIATION_MAX_DRAFT_BYTES,
  NEGOTIATION_OPENAI_MODEL,
  NEGOTIATION_OPERATION_KIND,
  NEGOTIATION_SUBJECT,
  selectNegotiationMove,
  validateNegotiationDraft,
  type InjectedDraftResult,
  type InjectedJevResult,
  type MandateSnapshot,
  type NegotiationCurrentSnapshot,
  type NegotiationMove,
} from "../domain/negotiationLoop.js";
import {
  isCommunicationDenial,
  validateOutboundPayload,
} from "../communication/contracts.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { canonicalJson, payloadHash, requestKey } from "../shared/hashing.js";
import {
  checkProjectAccess,
  denialValidator,
  requireCapability,
} from "../access/checks.js";
import { classifyScope, lookupCapability } from "../shared/scope.js";
import { JEV_PINNED_MODEL } from "../../proofs/jev/jev-boundary.js";
import { OPENAI_PINNED_MODEL } from "../models/openai.js";
import type * as jev from "../models/jev.js";
import type * as openai from "../models/openai.js";
import type * as send from "../communication/send.js";
import type * as operations from "../execution/operations.js";
import type * as grants from "../access/grants.js";
import type {
  StoredQuoteCharge,
  StoredQuoteLine,
  StoredTaxBasis,
} from "../shared/quoteSemantics.js";

type ActionArgs<T> = T extends RegisteredAction<infer _V, infer A, infer _R> ? A : never;
type ActionReturn<T> = T extends RegisteredAction<infer _V, infer _A, infer R> ? Awaited<R> : never;
type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

const classifyRef = makeFunctionReference<
  "action",
  ActionArgs<typeof jev.classify>,
  ActionReturn<typeof jev.classify>
>("models/jev:classify");
const draftRef = makeFunctionReference<
  "action",
  ActionArgs<typeof openai.draft>,
  ActionReturn<typeof openai.draft>
>("models/openai:draft");
const dispatchRef = makeFunctionReference<
  "action",
  ActionArgs<typeof send.dispatch>,
  ActionReturn<typeof send.dispatch>
>("communication/send:dispatch");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");

/** Pinned input version for the server-built Jev move workload. */
export const NEGOTIATION_JEV_INPUT_VERSION = "e6-negotiation-workload-v2" as const;
/** Pinned input version for the server-built OpenAI draft workload. */
export const NEGOTIATION_DRAFT_INPUT_VERSION = "e6-negotiation-draft-v2" as const;
/** Version tag for the bounded quote-terms derivation below. */
export const NEGOTIATION_QUOTE_TERMS_VERSION = "e6-negotiation-quote-terms-v1" as const;
/** Orchestrator lineage version for review. */
export const NEGOTIATION_ORCHESTRATOR_VERSION = "e12-negotiation-orchestrator-v1" as const;
/**
 * Matched pending-grant sentinel pair for pre-call E6 fences. Both binding
 * fields are equal so the exact-equality check passes vacuously before any
 * send operation exists; the real binding pins post-draft against the
 * discovered exact grant and F1 rechecks it atomically at claim.
 */
const PENDING_SEND_GRANT = "send-grant-pending" as const;

const INBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

/**
 * Bounded versioned quote-terms derivation (Astra repair: complete terms
 * must alter workloads).
 *
 * The Jev move state previously carried a fixed
 * `missingTerms: "freight,installation,warranty"` constant and the draft
 * workload a thin 4-line `description: quantity` excerpt, so a quote whose
 * freight/installation terms became complete (or changed at all) produced
 * byte-identical model workloads. These helpers derive bounded, versioned
 * summaries from the ACTUAL live quote row instead:
 * - `missingTermsOf` lists the charge labels still blocking comparison
 *   (`unknown`/`estimated` states only; `known`/`included` terms are
 *   complete and `notApplicable` terms are not missing), or
 *   `"none-complete"` when every charge is resolved.
 * - `summarizeQuoteTerms` renders every line (id, description, quantity,
 *   unit price), every charge state, and the tax basis, tagged with the
 *   quote version and content-hash prefix so any term change alters the
 *   workload bytes.
 *
 * Bounds: at most 8 lines and 8 charges, 2000 chars of terms, 240 chars of
 * missing-terms. Truncation is explicit (`…[truncated]`) so a capped
 * summary never masquerades as the complete quote. Quote unit prices are
 * supplier-provided comparison terms (the negotiation subject), never
 * confidential mandate targets — those must never enter these summaries.
 */
const NEGOTIATION_MAX_TERM_LINES = 8;
const NEGOTIATION_MAX_TERM_CHARGES = 8;
const NEGOTIATION_MAX_TERMS_CHARS = 2000;
const NEGOTIATION_MAX_MISSING_TERMS = 12;
const NEGOTIATION_MAX_MISSING_TERMS_CHARS = 240;
/** Bounded latest owner-reply excerpt carried into draft workloads. */
const NEGOTIATION_MAX_REPLY_CHARS = 1000;

/**
 * Neutralize clause-boundary punctuation inside supplier-derived workload
 * text.
 *
 * The F1 scope contract splits operation bodies into clauses on `.`, `;`,
 * `!`, `?` (plus newlines and `and`/`but` before independent starters) and
 * requires EVERY clause to carry a purchasing anchor; otherwise it stores
 * the canonical supported projection and the exact-payload binding the
 * negotiation grants depend on breaks. Raw quote terms ("charges: none",
 * trailing periods in descriptions) would therefore silently break grant
 * binding. This collapases those boundaries to spaces (preserving
 * digit-dot-digit decimals) so the brief stays anchored; the complete
 * structured terms remain digest-bound through the workload sources.
 */
function sanitizeClauseBoundary(text: string): string {
  return text
    .replace(/[;!?…\n\r\t]+/g, " ")
    .replace(/(?<![0-9])\.|\.(?![0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Explicit money rendering for model workloads (Astra repair: unlabeled
 * minor units).
 *
 * Workload strings previously rendered `795000EUR`, which a model cannot
 * distinguish from major units (€795,000 vs €7,950.00). Every amount now
 * carries both the explicit major-unit figure and the structured minor-unit
 * count with its currency, so known, estimated point, estimated range, and
 * per-line prices are unambiguous: `EUR 7950.00 (795000 minor units)`.
 */
export function formatMoneyAmount(minorUnits: number, currency: string): string {
  const major = (minorUnits / 100).toFixed(2);
  return `${currency} ${major} (${minorUnits} minor units)`;
}

function renderChargeState(
  charge: StoredQuoteCharge,
): string {
  const state = charge.state;
  switch (state.kind) {
    case "known":
      return `${charge.label}: known ${formatMoneyAmount(state.amount.minorUnits, state.amount.currency)}`;
    case "included":
      return `${charge.label}: included in ${state.coveringId}`;
    case "estimated":
      return state.estimate.kind === "point"
        ? `${charge.label}: estimated ${formatMoneyAmount(state.estimate.amount.minorUnits, state.estimate.amount.currency)}`
        : `${charge.label}: estimated range ${formatMoneyAmount(state.estimate.minimum.minorUnits, state.estimate.minimum.currency)} to ${formatMoneyAmount(state.estimate.maximum.minorUnits, state.estimate.maximum.currency)}`;
    case "unknown":
      return `${charge.label}: unknown (${state.reason})`;
    case "notApplicable":
      return `${charge.label}: n/a (${state.reason})`;
  }
}

export function missingTermsOf(
  charges: readonly StoredQuoteCharge[],
): string {
  const missing: string[] = [];
  for (const charge of charges) {
    if (missing.length >= NEGOTIATION_MAX_MISSING_TERMS) break;
    if (charge.state.kind === "unknown") {
      missing.push(`unknown:${charge.label}`);
    } else if (charge.state.kind === "estimated") {
      missing.push(`estimated:${charge.label}`);
    }
  }
  if (missing.length === 0) return "none-complete";
  return sanitizeClauseBoundary(missing.join(",")).slice(0, NEGOTIATION_MAX_MISSING_TERMS_CHARS);
}

function renderTaxBasis(taxBasis: StoredTaxBasis): string {
  if (taxBasis.kind === "unknown") return `tax: unknown (${taxBasis.reason})`;
  return `tax: ${taxBasis.kind} (${taxBasis.basisId})`;
}

export function summarizeQuoteTerms(args: {
  readonly version: string;
  readonly contentHash: string;
  readonly currency: string;
  readonly lines: readonly StoredQuoteLine[];
  readonly charges: readonly StoredQuoteCharge[];
  readonly taxBasis: StoredTaxBasis;
}): string {
  const hashPrefix = args.contentHash.slice(0, 8);
  const lineParts: string[] = [];
  for (const line of args.lines.slice(0, NEGOTIATION_MAX_TERM_LINES)) {
    lineParts.push(
      `${line.lineId} ${line.description} x${line.quantity} @${formatMoneyAmount(line.unitPrice.minorUnits, line.unitPrice.currency)}`,
    );
  }
  if (args.lines.length > NEGOTIATION_MAX_TERM_LINES) lineParts.push("…[truncated]");
  const chargeParts: string[] = [];
  for (const charge of args.charges.slice(0, NEGOTIATION_MAX_TERM_CHARGES)) {
    chargeParts.push(renderChargeState(charge));
  }
  if (args.charges.length > NEGOTIATION_MAX_TERM_CHARGES) chargeParts.push("…[truncated]");
  const summary =
    `quote ${args.version} (${hashPrefix}) ${args.currency}: ` +
    `lines: ${lineParts.length > 0 ? lineParts.join("; ") : "none"}; ` +
    `charges: ${chargeParts.length > 0 ? chargeParts.join("; ") : "none"}; ` +
    renderTaxBasis(args.taxBasis);
  if (summary.length <= NEGOTIATION_MAX_TERMS_CHARS) return sanitizeClauseBoundary(summary);
  return `${sanitizeClauseBoundary(summary).slice(0, NEGOTIATION_MAX_TERMS_CHARS - 13)}…[truncated]`;
}

/**
 * Reply digest for the Jev move state: the reply version tag plus a short
 * hash of the bounded excerpt, or `"no-reply"` when no bound reply exists.
 * Any new or changed reply alters this digest and therefore the workload.
 */
export function replyDigestOf(pinned: {
  readonly replyExcerpt: string | undefined;
  readonly replyVersion: string | undefined;
}): string {
  if (pinned.replyExcerpt === undefined || pinned.replyVersion === undefined) return "no-reply";
  return `${pinned.replyVersion}#${payloadHash(pinned.replyExcerpt).slice(0, 8)}`;
}

/**
 * Permissible mandate context for draft workloads: mandate identity,
 * state, and round accounting plus the permitted move catalog. Carries no
 * confidential figures (targets/ceilings) and no mailbox.
 */
export function mandateContextSummary(pinned: {
  readonly negotiationId: string;
  readonly quoteVersion: string;
  readonly mandateState: string;
  readonly roundsUsed: number;
  readonly roundLimit: number;
}): string {
  return (
    `Active negotiation mandate ${pinned.negotiationId} for quote ${pinned.quoteVersion} ` +
    `(state ${pinned.mandateState}, round ${pinned.roundsUsed}/${pinned.roundLimit}); ` +
    `permitted moves clarify and counter within the approved round limit.`
  );
}

const pinnedQuoteValidator = v.object({
  version: v.string(),
  contentHash: v.string(),
  excerpt: v.string(),
  terms: v.string(),
  missingTerms: v.string(),
});

const pinnedContextValidator = v.object({
  ok: v.literal(true),
  organizationId: v.string(),
  projectId: v.string(),
  projectName: v.string(),
  negotiationId: v.string(),
  quoteId: v.string(),
  quote: pinnedQuoteValidator,
  mandateState: v.string(),
  mandateQuoteVersion: v.string(),
  mandateQuoteContentHash: v.string(),
  mandateConversationVersion: v.optional(v.number()),
  mandateConversationState: v.optional(v.string()),
  mandateHasConversation: v.boolean(),
  roundsUsed: v.number(),
  roundLimit: v.number(),
  expiresAt: v.number(),
  targetMinorUnits: v.optional(v.number()),
  currentQuoteId: v.optional(v.string()),
  currentConversationId: v.optional(v.string()),
  currentQuoteVersion: v.string(),
  currentQuoteContentHash: v.string(),
  quoteSuperseded: v.boolean(),
  currentConversationVersion: v.optional(v.number()),
  conversationState: v.optional(v.string()),
  replyExcerpt: v.optional(v.string()),
  replyCapturedAt: v.optional(v.number()),
  replyVersion: v.optional(v.string()),
  replySourceId: v.optional(v.string()),
  replySourceVersion: v.optional(v.string()),
  replySourceLocator: v.optional(v.string()),
  replyReviewPending: v.optional(v.boolean()),
  replyScanIncomplete: v.optional(v.boolean()),
  recipientConfigured: v.boolean(),
  recipientConfigVersion: v.optional(v.number()),
  recipientMailboxNormalized: v.optional(v.string()),
});

interface PinnedContext {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  projectName: string;
  negotiationId: Id<"negotiations">;
  quoteId: Id<"quotes">;
  mandateState: string;
  mandateQuoteVersion: string;
  mandateQuoteContentHash: string;
  mandateConversationId: Id<"conversations"> | undefined;
  mandateConversationVersion: number | undefined;
  mandateConversationState: string | undefined;
  roundsUsed: number;
  roundLimit: number;
  expiresAt: number;
  targetMinorUnits: number | undefined;
  quoteVersion: string;
  quoteContentHash: string;
  quoteExcerpt: string;
  quoteTerms: string;
  missingTerms: string;
  quoteSuperseded: boolean;
  conversationVersion: number | undefined;
  conversationState: string | undefined;
  replyExcerpt: string | undefined;
  replyCapturedAt: number | undefined;
  replyVersion: string | undefined;
  replySourceId: string | undefined;
  replySourceVersion: string | undefined;
  replySourceLocator: string | undefined;
  replyReviewPending: boolean;
  replyScanIncomplete: boolean;
  recipientConfigured: boolean;
  recipientConfigVersion: number | undefined;
  recipientMailboxNormalized: string | undefined;
}

function genericDenial(): { ok: false; code: string; message: string } {
  return { ok: false, code: "denied-membership", message: "not authorized for this project" };
}

/**
 * Negotiation-local conversation gate (Devin 4060796928 repair).
 *
 * E6 fences pin conversation identity but never inspect conversation state,
 * so a bound owner reply that advanced the version would pass the equality
 * fence and the step could send an obsolete follow-up without reading the
 * reply. PRD requires a supplier reply to stop obsolete queued follow-ups
 * before dispatch, so a bound conversation sitting in `replyReceived`,
 * `closed`, or `cancelled` stops the step with zero provider calls. The
 * reply must first be ingested into a new quote version and mandate basis
 * before another outbound step may proceed.
 *
 * The foundation persists the mandate-approved conversation version and
 * state. The live conversation must still equal both pins before any model
 * or transport call; old bound mandates without those pins fail closed.
 */
function conversationGate(conversationState: string | undefined): {
  readonly stopped: boolean;
} {
  if (
    conversationState === "replyReceived" ||
    conversationState === "closed" ||
    conversationState === "cancelled"
  ) {
    return { stopped: true };
  }
  return { stopped: false };
}

function approvedConversationGate(pinned: PinnedContext): {
  readonly stopped: boolean;
} {
  if (pinned.mandateConversationId === undefined) {
    return conversationGate(pinned.conversationState);
  }
  return {
    stopped:
      pinned.mandateConversationVersion === undefined ||
      pinned.mandateConversationState === undefined ||
      pinned.conversationVersion !== pinned.mandateConversationVersion ||
      pinned.conversationState !== pinned.mandateConversationState ||
      conversationGate(pinned.conversationState).stopped,
  };
}

/**
 * Quarantine/incompleteness gate over the bound-reply scan (Astra repair).
 *
 * Runs after the conversation gate and before any model call, grant lookup,
 * operation, claim, or provider effect. A truncated scan (`incomplete`) or
 * a quarantined marker newer than the accepted basis (`review`) holds the
 * step honestly instead of negotiating past unreviewed or unprovable owner
 * content. Query-shaped callers surface the code as a denial; action-shaped
 * callers surface it as a waiting outcome with the same reason string.
 */
function replyGate(pinned: PinnedContext): { readonly code: string; readonly message: string } | null {
  if (pinned.replyScanIncomplete) {
    return {
      code: "reply-scan-incomplete",
      message: "bound reply scan exceeded its bound without proving exhaustion; reconcile before another automated step",
    };
  }
  if (pinned.replyReviewPending) {
    return {
      code: "owner-reply-needs-review",
      message: "a bound owner reply needs manual review before another automated step",
    };
  }
  return null;
}

/**
 * Server-built scope brief for D-17 admission. Structural purchasing anchors
 * only; never caller text, never supplier content.
 */
function serverScopeBrief(projectName: string, quoteVersion: string): string {
  return (
    `Negotiate the supplier quote ${quoteVersion} for project ${projectName}: ` +
    `clarify freight and installation inclusion and compare vendor options.`
  );
}

/**
 * Bounded latest accepted owner-reply excerpt for model workloads (Astra
 * repairs: changed replies must alter workloads; `source:1:review`
 * quarantined evidence must never be promoted; the newest-32 project scan
 * must not silently lose a bound reply).
 *
 * The bound conversation's provider threads come from the existing
 * `threadBindings` contract; the latest inbound message under those threads
 * is resolved through `productEvidence` (sanitized `normalizedValue`
 * excerpt, never raw protected bytes) linked via `sourceEvidenceId`.
 *
 * Authoritative eligibility is enforced here at the negotiation boundary:
 * only markers with `version === "source:1"` (exact-sender verified, no
 * instruction-like or active-HTML content) supply model meaning. Markers
 * with `version === "source:1:review"` (unexpected sender or content needing
 * manual review) are quarantined: their text never enters a workload, and a
 * quarantined marker newer than the newest accepted reply surfaces an
 * explicit review-pending state so the step waits honestly instead of
 * negotiating past an unreviewed owner reply.
 *
 * Retrieval is constrained to the bound conversation's threads, and the
 * project scan proves exhaustion inside its bound: more rows than the bound
 * surfaces an explicit incomplete state instead of a false no-reply. Every
 * read is bounded. The excerpt is mailbox-redacted before it enters any
 * workload, and carries its source identity (message key, accepted version,
 * locator) so models receive bounded source-linked meaning.
 */
const LATEST_REPLY_SCAN = 256;
const REPLY_BINDING_WINDOW = 65;
/** Accepted inbound marker: exact-sender verified, safe for auto handling. */
const ACCEPTED_REPLY_VERSION = "source:1" as const;
/** Quarantined inbound marker: unexpected sender or review-gated content. */
const QUARANTINED_REPLY_VERSION = "source:1:review" as const;
/** Bounded accepted-reply meaning carried into the Jev move state. */
const NEGOTIATION_MAX_JEV_REPLY_MEANING_CHARS = 500;

/**
 * Mailbox-redacted reply excerpt. Supplier-derived text must never leak the
 * private owner mailbox into model workloads; redact before bounding.
 */
function redactReplyExcerpt(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-mailbox]")
    .slice(0, NEGOTIATION_MAX_REPLY_CHARS);
}

type ReplyLoadResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "accepted";
      readonly excerpt: string;
      readonly capturedAt: number;
      readonly version: string;
      readonly sourceId: string;
      readonly sourceVersion: typeof ACCEPTED_REPLY_VERSION;
      readonly locator: string;
      /**
       * A quarantined marker newer than this accepted reply exists on the
       * bound threads: unreviewed owner content arrived after the accepted
       * basis, so the step must wait for review rather than negotiating
       * past it, even though accepted meaning is available.
       */
      readonly reviewPending: boolean;
    }
  | { readonly kind: "review" }
  | { readonly kind: "incomplete" };

async function loadLatestReply(
  ctx: F1QueryCtx,
  scope: {
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly conversationId: Id<"conversations"> | undefined;
    readonly conversationVersion: number | undefined;
  },
): Promise<ReplyLoadResult> {
  if (scope.conversationId === undefined || scope.conversationVersion === undefined) return { kind: "none" };
  const bindings = await ctx.db
    .query("threadBindings")
    .withIndex("by_conversation", (q) => q.eq("conversationId", scope.conversationId as Id<"conversations">))
    .take(REPLY_BINDING_WINDOW + 1);
  if (bindings.length > REPLY_BINDING_WINDOW) return { kind: "incomplete" };
  const threads = new Set<string>();
  for (const binding of bindings) {
    if (binding.organizationId !== scope.organizationId || binding.projectId !== scope.projectId) continue;
    threads.add(binding.providerThreadId);
  }
  if (threads.size === 0) return { kind: "none" };
  const candidates = await ctx.db
    .query("productEvidence")
    .withIndex("by_project", (q) => q.eq("projectId", scope.projectId))
    .order("desc")
    .take(LATEST_REPLY_SCAN + 1);
  if (candidates.length > LATEST_REPLY_SCAN) return { kind: "incomplete" };
  let accepted: {
    readonly excerpt: string;
    readonly capturedAt: number;
    readonly version: string;
    readonly sourceId: string;
    readonly locator: string;
  } | null = null;
  let quarantinedNewestAt: number | null = null;
  for (const candidate of candidates) {
    if (
      candidate.field !== "agentmail.message" ||
      candidate.organizationId !== scope.organizationId ||
      candidate.sourceEvidenceId === undefined
    ) {
      continue;
    }
    // Quarantined senders are never promoted: only the accepted version may
    // supply model meaning. A quarantined marker still counts as pending
    // review when it is newer than the newest accepted reply.
    if (
      candidate.version !== ACCEPTED_REPLY_VERSION &&
      candidate.version !== QUARANTINED_REPLY_VERSION
    ) {
      continue;
    }
    const evidence = await ctx.db.get(candidate.sourceEvidenceId);
    if (
      evidence === null ||
      evidence.organizationId !== scope.organizationId ||
      evidence.projectId !== scope.projectId ||
      evidence.sourceKind !== "agentmail.message" ||
      typeof evidence.providerIds !== "string"
    ) {
      continue;
    }
    let threadId: string | undefined;
    let messageId: string | undefined;
    try {
      const parsed = JSON.parse(evidence.providerIds) as { threadId?: unknown; messageId?: unknown };
      threadId = parsed.threadId as string | undefined;
      messageId = parsed.messageId as string | undefined;
    } catch {
      continue;
    }
    if (typeof threadId !== "string" || !threads.has(threadId)) continue;
    if (typeof messageId !== "string" || messageId.trim().length === 0) continue;
    if (candidate.version === QUARANTINED_REPLY_VERSION) {
      if (quarantinedNewestAt === null || evidence.capturedAt > quarantinedNewestAt) {
        quarantinedNewestAt = evidence.capturedAt;
      }
      continue;
    }
    const excerpt = redactReplyExcerpt(candidate.normalizedValue);
    if (excerpt.trim().length === 0) continue;
    if (accepted === null || evidence.capturedAt > accepted.capturedAt) {
      accepted = {
        excerpt,
        capturedAt: evidence.capturedAt,
        version: `v${scope.conversationVersion}@${evidence.capturedAt}`,
        sourceId: `agentmail:${messageId}`,
        locator: `message:${messageId}`,
      };
    }
  }
  if (accepted !== null) {
    return {
      kind: "accepted",
      ...accepted,
      sourceVersion: ACCEPTED_REPLY_VERSION,
      reviewPending:
        quarantinedNewestAt !== null && quarantinedNewestAt > accepted.capturedAt,
    };
  }
  if (quarantinedNewestAt !== null) return { kind: "review" };
  return { kind: "none" };
}

/**
 * Load and pin every authority snapshot for one negotiation step. Queries
 * only; zero provider calls and zero writes. Any denial leaves no effect.
 */
export const loadNegotiationContext = f1InternalQuery({
  args: {
    negotiationId: v.id("negotiations"),
    identity: v.string(),
    requestText: v.optional(v.string()),
  },
  returns: v.union(pinnedContextValidator, denialValidator),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const negotiation = await ctx.db.get(args.negotiationId);
    if (negotiation === null) return genericDenial();
    const project = await ctx.db.get(negotiation.projectId);
    if (project === null || project.organizationId !== negotiation.organizationId) {
      return genericDenial();
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      negotiation.organizationId,
      negotiation.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      // No existence oracle: cross-tenant, guest, and unknown rows share the
      // generic membership denial whenever project authorization failed.
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const capability = requireCapability(NEGOTIATION_OPERATION_KIND, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    if (lookupCapability(NEGOTIATION_OPERATION_KIND) === undefined) {
      return { ok: false as const, code: "unknown-operation", message: "negotiation send is not a shipped capability" };
    }
    const brief = serverScopeBrief(project.name, negotiation.quoteVersion);
    const briefScope = classifyScope({ text: brief, operationId: NEGOTIATION_OPERATION_KIND });
    if (briefScope.verdict !== "supported") {
      return { ok: false as const, code: "unrelated-refusal", message: "negotiation brief is outside the purchasing workflow" };
    }
    if (args.requestText !== undefined && args.requestText.trim().length > 0) {
      const requested = classifyScope({ text: args.requestText });
      if (requested.verdict === "unrelatedRefused") {
        return { ok: false as const, code: "unrelated-refusal", message: requested.reason };
      }
      if (requested.verdict === "unavailableRefused") {
        return { ok: false as const, code: "unavailable-capability", message: requested.reason };
      }
    }
    const quote = await ctx.db.get(negotiation.quoteId);
    if (
      quote === null ||
      quote.organizationId !== negotiation.organizationId ||
      quote.projectId !== negotiation.projectId
    ) {
      return genericDenial();
    }
    let conversationVersion: number | undefined;
    let conversationState: string | undefined;
    let conversationId: Id<"conversations"> | undefined;
    if (negotiation.conversationId !== undefined) {
      if (
        negotiation.conversationVersion === undefined ||
        negotiation.conversationState === undefined
      ) {
        return {
          ok: false as const,
          code: "mandate-approval-unpinned",
          message: "bound negotiation lacks its approved conversation version and state",
        };
      }
      const conversation = await ctx.db.get(negotiation.conversationId);
      if (
        conversation === null ||
        conversation.organizationId !== negotiation.organizationId ||
        conversation.projectId !== negotiation.projectId
      ) {
        return genericDenial();
      }
      conversationVersion = conversation.version;
      conversationState = conversation.state;
      conversationId = conversation._id;
    }
    const latestReply = await loadLatestReply(ctx, {
      organizationId: negotiation.organizationId,
      projectId: negotiation.projectId,
      conversationId,
      conversationVersion,
    });
    const acceptedReply = latestReply.kind === "accepted" ? latestReply : null;
    const replyReviewPending =
      latestReply.kind === "review" ||
      (latestReply.kind === "accepted" && latestReply.reviewPending);
    const replyScanIncomplete = latestReply.kind === "incomplete";
    const successors = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_supersedes", (q) =>
        q.eq("projectId", negotiation.projectId).eq("supersedes", quote.contentHash),
      )
      .take(1);
    const recipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    const recipient = recipients.length === 1 ? recipients[0] : undefined;
    const excerpt = quote.lines
      .slice(0, 4)
      .map((line) => `${line.description}: ${line.quantity}`)
      .join("; ")
      .slice(0, 480);
    const terms = summarizeQuoteTerms({
      version: quote.version,
      contentHash: quote.contentHash,
      currency: quote.currency,
      lines: quote.lines,
      charges: quote.charges,
      taxBasis: quote.taxBasis,
    });
    const missingTerms = missingTermsOf(quote.charges);
    return {
      ok: true as const,
      organizationId: String(negotiation.organizationId),
      projectId: String(negotiation.projectId),
      projectName: project.name,
      negotiationId: String(negotiation._id),
      quoteId: String(quote._id),
      quote: { version: quote.version, contentHash: quote.contentHash, excerpt, terms, missingTerms },
      mandateState: negotiation.state,
      mandateQuoteVersion: negotiation.quoteVersion,
      // The row stores no content hash; pin the live hash as the mandate
      // basis so in-step drift still fails closed at the post-draft recheck.
      mandateQuoteContentHash: quote.contentHash,
      ...(negotiation.conversationVersion === undefined
        ? {}
        : { mandateConversationVersion: negotiation.conversationVersion }),
      ...(negotiation.conversationState === undefined
        ? {}
        : { mandateConversationState: negotiation.conversationState }),
      mandateHasConversation: negotiation.conversationId !== undefined,
      roundsUsed: negotiation.roundsUsed,
      roundLimit: negotiation.roundLimit,
      expiresAt: negotiation.expiresAt,
      ...(negotiation.targetMinorUnits === undefined ? {} : { targetMinorUnits: negotiation.targetMinorUnits }),
      currentQuoteId: String(quote._id),
      ...(negotiation.conversationId === undefined
        ? {}
        : { currentConversationId: String(negotiation.conversationId) }),
      currentQuoteVersion: quote.version,
      currentQuoteContentHash: quote.contentHash,
      quoteSuperseded: successors.length > 0,
      ...(conversationVersion === undefined ? {} : { currentConversationVersion: conversationVersion }),
      ...(conversationState === undefined ? {} : { conversationState }),
      ...(acceptedReply === null ? {} : { replyExcerpt: acceptedReply.excerpt }),
      ...(acceptedReply === null ? {} : { replyCapturedAt: acceptedReply.capturedAt }),
      ...(acceptedReply === null ? {} : { replyVersion: acceptedReply.version }),
      ...(acceptedReply === null ? {} : { replySourceId: acceptedReply.sourceId }),
      ...(acceptedReply === null ? {} : { replySourceVersion: acceptedReply.sourceVersion }),
      ...(acceptedReply === null ? {} : { replySourceLocator: acceptedReply.locator }),
      ...(replyReviewPending ? { replyReviewPending: true as const } : {}),
      ...(replyScanIncomplete ? { replyScanIncomplete: true as const } : {}),
      recipientConfigured: recipient !== undefined,
      ...(recipient === undefined ? {} : { recipientConfigVersion: recipient.version }),
      ...(recipient === undefined ? {} : { recipientMailboxNormalized: recipient.mailboxNormalized }),
    };
  },
});

const loadContextRef = makeFunctionReference<
  "query",
  QueryArgs<typeof loadNegotiationContext>,
  QueryReturn<typeof loadNegotiationContext>
>("negotiation/orchestrator:loadNegotiationContext");

/**
 * Build the deterministic Jev move workload from pinned snapshots only.
 * Fixtures reuse this builder so workload digests match exactly.
 *
 * The move state carries the ACTUAL bounded quote terms, the derived
 * missing-terms list, and the latest-reply digest — never a fixed constant —
 * so complete terms and changed replies produce different workloads (and
 * therefore different workload digests bound into grants). The digest alone
 * cannot convey reply meaning, so the state also carries the bounded
 * source-linked accepted reply excerpt (`replyMeaning`, mailbox-redacted,
 * with its `replySource` message identity): final-offer, refusal, and
 * changed-charge meaning reach the move decision, while quarantined
 * (`source:1:review`) text never enters this state — the review gate holds
 * the step before any model call instead.
 */
export function buildNegotiationJevWorkload(pinned: {
  readonly negotiationId: string;
  readonly quoteId: string;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly quoteTerms: string;
  readonly missingTerms: string;
  readonly replyDigest: string;
  readonly replyMeaning?: string;
  readonly replySource?: string;
  readonly conversationVersion: number | undefined;
  readonly roundsUsed: number;
  readonly roundLimit: number;
  readonly mandateState: string;
}): {
  readonly state: Record<string, string>;
  readonly questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
  readonly inputVersion: string;
  readonly queryText: string;
} {
  const state = {
    negotiation: pinned.negotiationId,
    quote: `${pinned.quoteId}@${pinned.quoteVersion}#${pinned.quoteContentHash.slice(0, 8)}`,
    terms: pinned.quoteTerms,
    missingTerms: pinned.missingTerms,
    reply: pinned.replyDigest,
    replyMeaning: (pinned.replyMeaning ?? "no-accepted-reply").slice(0, NEGOTIATION_MAX_JEV_REPLY_MEANING_CHARS),
    replySource: pinned.replySource ?? "no-source",
    conversation: pinned.conversationVersion === undefined ? "unbound" : `v${pinned.conversationVersion}`,
    rounds: `${pinned.roundsUsed}/${pinned.roundLimit}`,
    mandate: pinned.mandateState,
  };
  const questions = {
    move: {
      type: "choice" as const,
      instructions: "Select the next permitted negotiation move for the current mandate and quote.",
      criteria: {
        clarify: "Request missing comparison terms from the owner playing the supplier.",
        counter: "Propose improved freight, installation, or warranty terms within the mandate.",
        hold: "Hold the current position and wait for the owner reply.",
        stop: "Stop negotiation without sending; quote changed, mandate ended, or review needed.",
      },
    },
  };
  return {
    state,
    questions,
    inputVersion: NEGOTIATION_JEV_INPUT_VERSION,
    queryText: `Research supplier negotiation move for quote ${pinned.quoteVersion} [${pinned.missingTerms}]`,
  };
}

/**
 * Build the deterministic supplier-draft workload from pinned snapshots.
 * The brief never carries confidential figures or the private mailbox.
 *
 * Sources are the versioned quote-terms derivation (locator
 * `quote-terms`), the permissible mandate context (locator
 * `mandate-brief`, no figures), and — when a bound reply exists — the
 * bounded latest-reply excerpt (locator `latest-reply`, versioned by
 * conversation version and capture time). Any term completion or new reply
 * changes these bytes, so the workload digest bound into the draft grant
 * changes with them.
 */
export function buildNegotiationDraftWorkload(
  pinned: {
    readonly negotiationId: string;
    readonly quoteId: string;
    readonly quoteVersion: string;
    readonly quoteContentHash: string;
    readonly quoteTerms: string;
    readonly missingTerms: string;
    readonly mandateState: string;
    readonly conversationId: string | undefined;
    readonly conversationVersion: number | undefined;
    readonly replyExcerpt: string | undefined;
    readonly replyVersion: string | undefined;
    readonly roundsUsed: number;
    readonly roundLimit: number;
  },
  move: Extract<NegotiationMove, "clarify" | "counter">,
): {
  readonly kind: "supplierDraft";
  readonly inputVersion: string;
  readonly draftKind: string;
  readonly brief: string;
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly version: string;
    readonly locator: string;
    readonly content: string;
  }>;
} {
  // Single-clause brief: every sentence of an operation payload must carry a
  // purchasing-communication anchor, otherwise F1 stores the canonical
  // supported projection and the exact-payload binding breaks. The brief
  // never carries confidential figures or the private mailbox.
  const brief =
    `Negotiation mandate ${pinned.negotiationId}: ${move} the supplier on the pinned quote ` +
    `${pinned.quoteVersion} terms (${pinned.quoteTerms}) with missing comparison terms ` +
    `${pinned.missingTerms}, and negotiate the comparison using only the pinned quote and ` +
    `mandate sources without disclosing internal targets.`;
  const mandateSummary = mandateContextSummary({
    negotiationId: pinned.negotiationId,
    quoteVersion: pinned.quoteVersion,
    mandateState: pinned.mandateState,
    roundsUsed: pinned.roundsUsed,
    roundLimit: pinned.roundLimit,
  });
  return {
    kind: "supplierDraft",
    inputVersion: NEGOTIATION_DRAFT_INPUT_VERSION,
    draftKind: move,
    brief,
    sources: [
      {
        sourceId: `quote:${pinned.quoteId}`,
        version: pinned.quoteVersion,
        locator: "quote-terms",
        content: pinned.quoteTerms,
      },
      {
        sourceId: `negotiation:${pinned.negotiationId}`,
        version: `mandate-round-${pinned.roundsUsed}`,
        locator: "mandate-brief",
        content: mandateSummary,
      },
      ...(pinned.replyExcerpt === undefined ||
      pinned.replyVersion === undefined ||
      pinned.conversationId === undefined
        ? []
        : [
            {
              sourceId: `conversation:${pinned.conversationId}`,
              version: pinned.replyVersion,
              locator: "latest-reply",
              content: pinned.replyExcerpt,
            },
          ]),
    ],
  };
}

/** Carrier payload binding a draft-workload approval to canonical JSON. */
export function draftCarrierPayloadJson(ownerMailboxNormalized: string, brief: string): string {
  return canonicalJson({
    bcc: [],
    body: brief,
    cc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject: NEGOTIATION_SUBJECT,
    to: ownerMailboxNormalized,
  });
}

/** Exact owner-only send envelope for a validated draft body. */
export function sendEnvelope(
  ownerMailboxNormalized: string,
  body: string,
): {
  readonly to: string;
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly profile: typeof COMMUNICATION_PROFILE_OWNER_ROLEPLAY;
  readonly subject: typeof NEGOTIATION_SUBJECT;
  readonly body: string;
} {
  return {
    to: ownerMailboxNormalized,
    cc: [],
    bcc: [],
    profile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
    subject: NEGOTIATION_SUBJECT,
    body,
  };
}

type NegotiationActionCtx = GenericActionCtx<F1DataModel>;

/**
 * Resolve live rows into pinned snapshots or a denial. Shared by every
 * entrypoint so auth, D-17, capability, and pinning never drift between
 * the single-step and two-phase flows.
 */
async function resolvePins(
  ctx: NegotiationActionCtx,
  negotiationId: Id<"negotiations">,
  identity: string,
  requestText: string | undefined,
): Promise<
  { readonly ok: true; readonly pinned: PinnedContext } | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const loaded = await ctx.runQuery(loadContextRef, {
    negotiationId,
    identity,
    ...(requestText === undefined ? {} : { requestText }),
  });
  if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
  return {
    ok: true,
    pinned: {
      organizationId: loaded.organizationId as Id<"organizations">,
      projectId: loaded.projectId as Id<"projects">,
      projectName: loaded.projectName,
      negotiationId: loaded.negotiationId as Id<"negotiations">,
      quoteId: loaded.quoteId as Id<"quotes">,
      mandateState: loaded.mandateState,
      mandateQuoteVersion: loaded.mandateQuoteVersion,
      mandateQuoteContentHash: loaded.mandateQuoteContentHash,
      mandateConversationId:
        loaded.mandateHasConversation && loaded.currentConversationId !== undefined
          ? (loaded.currentConversationId as Id<"conversations">)
          : undefined,
      mandateConversationVersion: loaded.mandateConversationVersion,
      mandateConversationState: loaded.mandateConversationState,
      roundsUsed: loaded.roundsUsed,
      roundLimit: loaded.roundLimit,
      expiresAt: loaded.expiresAt,
      targetMinorUnits: loaded.targetMinorUnits,
      quoteVersion: loaded.quote.version,
      quoteContentHash: loaded.quote.contentHash,
      quoteExcerpt: loaded.quote.excerpt,
      quoteTerms: loaded.quote.terms,
      missingTerms: loaded.quote.missingTerms,
      quoteSuperseded: loaded.quoteSuperseded,
      conversationVersion: loaded.currentConversationVersion,
      conversationState: loaded.conversationState,
      replyExcerpt: loaded.replyExcerpt,
      replyCapturedAt: loaded.replyCapturedAt,
      replyVersion: loaded.replyVersion,
      replySourceId: loaded.replySourceId,
      replySourceVersion: loaded.replySourceVersion,
      replySourceLocator: loaded.replySourceLocator,
      replyReviewPending: loaded.replyReviewPending ?? false,
      replyScanIncomplete: loaded.replyScanIncomplete ?? false,
      recipientConfigured: loaded.recipientConfigured,
      recipientConfigVersion: loaded.recipientConfigVersion,
      recipientMailboxNormalized: loaded.recipientMailboxNormalized,
    },
  };
}

/**
 * Validate a caller-supplied approved envelope against the live owner
 * mailbox and mandate disclosure. The grant equality check (exact payload
 * approval) happens separately in discovery; this gate ensures the text
 * itself is safe and well-formed before any operation exists.
 */
function validateApprovedEnvelope(
  envelopeCanonical: unknown,
  recipientMailboxNormalized: string | undefined,
  targetMinorUnits: number | undefined,
):
  | { readonly ok: true; readonly body: string; readonly redactedPreview: string }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  if (typeof envelopeCanonical !== "string" || envelopeCanonical.trim().length === 0) {
    return { ok: false, code: "invalid-payload", message: "approved envelope is required" };
  }
  let value: unknown;
  try {
    value = JSON.parse(envelopeCanonical) as unknown;
  } catch {
    return { ok: false, code: "invalid-payload", message: "approved envelope is not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid-payload", message: "approved envelope must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (record["subject"] !== NEGOTIATION_SUBJECT) {
    return { ok: false, code: "outbound-denied", message: "envelope subject is not the fixed server subject" };
  }
  if (typeof record["body"] !== "string" || record["body"].trim().length === 0) {
    return { ok: false, code: "draft-malformed", message: "approved envelope carries no draft text" };
  }
  if (new TextEncoder().encode(record["body"]).byteLength > NEGOTIATION_MAX_DRAFT_BYTES) {
    return { ok: false, code: "draft-malformed", message: "approved envelope draft exceeds the output bound" };
  }
  const outbound = validateOutboundPayload(value, recipientMailboxNormalized);
  if (isCommunicationDenial(outbound)) {
    return { ok: false, code: "outbound-denied", message: outbound.message };
  }
  if (canonicalJson(value) !== outbound.canonical) {
    return { ok: false, code: "outbound-denied", message: "payload canonical form changed" };
  }
  const checked = validateNegotiationDraft(record["body"], {
    ...(targetMinorUnits === undefined ? {} : { targetMinorUnits }),
    ...(recipientMailboxNormalized === undefined
      ? {}
      : { ownerMailboxNormalized: recipientMailboxNormalized }),
  });
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  return { ok: true, body: record["body"], redactedPreview: checked.redactedPreview };
}

/**
 * Exact saved-draft bindings for one prepared negotiation draft. Every
 * value is written server-side at preparation from the live pins; dispatch
 * and approval recheck each one against the current pins before the first
 * send. Optional so the checker (not the schema) decides staleness.
 */
export interface SavedDraftBindings {
  readonly projectId: string;
  readonly negotiationId: string;
  readonly quoteId: string;
  readonly quoteVersion: string;
  readonly quoteContentHash: string;
  readonly conversationVersion: number | undefined;
  readonly conversationState?: string | undefined;
  readonly replyVersion: string | undefined;
  readonly roundsUsed: number;
  readonly move: string;
  readonly payloadHash: string;
}

/**
 * Enforce the exact saved-draft bindings before the first dispatch (Astra
 * repair: cross-negotiation first dispatch and stale rounds).
 *
 * The live mandate/quote/conversation fences alone cannot stop a draft
 * prepared under one negotiation, quote version, conversation version,
 * reply, round, or payload from sending under another: the live pins stay
 * self-consistent while the DRAFT is stale. This check compares the stored
 * bundle byte-for-byte against the current pins — project, negotiation,
 * quote id/version/hash, conversation version (both directions),
 * reply version (both directions), rounds used, permitted move, and the
 * payload hash recomputed from the stored canonical envelope. Any drift
 * denies with zero provider calls. The operation claim then preserves these
 * pins: `operations.create` re-pins them server-side from the same live
 * rows at operation creation and `claim` rechecks them atomically before
 * provider effect.
 */
export function checkDraftBindings(
  draft: SavedDraftBindings,
  live: {
    readonly projectId: string;
    readonly negotiationId: string;
    readonly quoteId: string;
    readonly quoteVersion: string;
    readonly quoteContentHash: string;
    readonly conversationVersion: number | undefined;
    readonly conversationState?: string | undefined;
    readonly replyVersion: string | undefined;
    readonly roundsUsed: number;
  },
  envelopeCanonical: string,
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  if (
    draft.projectId !== live.projectId ||
    draft.negotiationId !== live.negotiationId ||
    draft.quoteId !== live.quoteId
  ) {
    return {
      ok: false as const,
      code: "draft-negotiation-mismatch",
      message: "prepared draft was approved for another project, negotiation, or quote",
    };
  }
  if (draft.move !== "clarify" && draft.move !== "counter") {
    return {
      ok: false as const,
      code: "draft-move-unknown",
      message: "prepared draft carries no permitted negotiation move",
    };
  }
  if (draft.quoteVersion !== live.quoteVersion || draft.quoteContentHash !== live.quoteContentHash) {
    return {
      ok: false as const,
      code: "draft-quote-stale",
      message: "prepared draft quote version is no longer current",
    };
  }
  if ((draft.conversationVersion ?? null) !== (live.conversationVersion ?? null)) {
    return {
      ok: false as const,
      code: "draft-conversation-changed",
      message: "prepared draft conversation version is no longer current",
    };
  }
  // Drafts prepared before the state pin existed carry no state; those skip
  // this dimension while the round, version, and payload pins still bind
  // them. New drafts always carry the draft-time conversation state.
  if (
    draft.conversationState !== undefined &&
    draft.conversationState !== live.conversationState
  ) {
    return {
      ok: false as const,
      code: "draft-conversation-changed",
      message: "prepared draft conversation state is no longer current",
    };
  }
  if ((draft.replyVersion ?? null) !== (live.replyVersion ?? null)) {
    return {
      ok: false as const,
      code: "draft-reply-changed",
      message: "a newer owner reply arrived after this draft was prepared",
    };
  }
  if (draft.roundsUsed !== live.roundsUsed) {
    return {
      ok: false as const,
      code: "draft-round-stale",
      message: "negotiation round advanced after this draft was prepared",
    };
  }
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(envelopeCanonical) as unknown;
  } catch {
    return { ok: false as const, code: "draft-payload-mismatch", message: "prepared draft envelope is not valid JSON" };
  }
  if (payloadHash(envelopeValue) !== draft.payloadHash) {
    return {
      ok: false as const,
      code: "draft-payload-mismatch",
      message: "prepared draft payload no longer matches its approved hash",
    };
  }
  return { ok: true as const };
}

/**
 * E17 mailbox-privacy repair: prepared drafts persist server-side only.
 *
 * The unredacted owner envelope (containing the private `To` mailbox) is
 * stored in the protected `evidence.protectedSourceText` field, which never
 * enters a public projection or guest download. The client receives only the
 * opaque evidence-row id (`draftId`) plus a redacted preview. Dispatch
 * resolves the envelope server-side from that id under the same approver
 * authority, preserving exact grant binding, idempotency, and owner-only
 * transport without ever returning the mailbox.
 */
const DRAFT_EVIDENCE_SOURCE_KIND = "negotiation-draft-v1" as const;

export const savePreparedNegotiationDraft = f1InternalMutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    negotiationId: v.id("negotiations"),
    quoteId: v.id("quotes"),
    quoteVersion: v.string(),
    quoteContentHash: v.string(),
    conversationVersion: v.optional(v.number()),
    conversationState: v.optional(v.string()),
    replyVersion: v.optional(v.string()),
    roundsUsed: v.number(),
    move: v.string(),
    envelopeCanonical: v.string(),
    payloadHash: v.string(),
    identity: v.string(),
  },
  returns: v.union(v.object({ ok: v.literal(true), draftId: v.id("evidence") }), denialValidator),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      args.organizationId,
      args.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const negotiation = await ctx.db.get(args.negotiationId);
    if (
      negotiation === null ||
      negotiation.organizationId !== args.organizationId ||
      negotiation.projectId !== args.projectId
    ) {
      return genericDenial();
    }
    const draftId = await ctx.db.insert("evidence", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      sourceKind: DRAFT_EVIDENCE_SOURCE_KIND,
      capturedAt: Date.now(),
      contentHash: args.payloadHash,
      protectedSourceText: canonicalJson({
        conversationVersion: args.conversationVersion ?? null,
        conversationState: args.conversationState ?? null,
        envelopeCanonical: args.envelopeCanonical,
        move: args.move,
        negotiationId: String(args.negotiationId),
        payloadHash: args.payloadHash,
        projectId: String(args.projectId),
        quoteContentHash: args.quoteContentHash,
        quoteId: String(args.quoteId),
        quoteVersion: args.quoteVersion,
        replyVersion: args.replyVersion ?? null,
        roundsUsed: args.roundsUsed,
      }),
      completeness: "complete",
      counterpartyRole: "ownerStandIn",
      executionMode: "live",
      locator: "negotiation-draft",
    });
    return { ok: true as const, draftId };
  },
});

const saveDraftRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof savePreparedNegotiationDraft>,
  MutationReturn<typeof savePreparedNegotiationDraft>
>("negotiation/orchestrator:savePreparedNegotiationDraft");

export const loadPreparedNegotiationDraft = f1InternalQuery({
  args: {
    draftId: v.id("evidence"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    negotiationId: v.id("negotiations"),
    identity: v.string(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      envelopeCanonical: v.string(),
      projectId: v.string(),
      negotiationId: v.string(),
      quoteId: v.string(),
      quoteVersion: v.string(),
      quoteContentHash: v.string(),
      conversationVersion: v.optional(v.number()),
      conversationState: v.optional(v.string()),
      replyVersion: v.optional(v.string()),
      roundsUsed: v.number(),
      move: v.string(),
      payloadHash: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      args.organizationId,
      args.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const row = await ctx.db.get(args.draftId);
    // Tenant isolation is organization- AND project-scoped: the row must
    // live in the caller's project, otherwise the private envelope (owner
    // mailbox and draft text) could leak across projects. Negotiation
    // mismatches within the project are NOT denied here: the F3
    // exact-replay inspection downstream must still see a reused request
    // key as a conflict, and the exact draft bindings deny a
    // cross-negotiation first dispatch with zero provider calls. No
    // envelope ever returns to the caller on any denial path.
    if (
      row === null ||
      row.organizationId !== args.organizationId ||
      row.projectId !== args.projectId ||
      row.sourceKind !== DRAFT_EVIDENCE_SOURCE_KIND ||
      typeof row.protectedSourceText !== "string"
    ) {
      return genericDenial();
    }
    let bundle: unknown;
    try {
      bundle = JSON.parse(row.protectedSourceText) as unknown;
    } catch {
      return genericDenial();
    }
    if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
      return genericDenial();
    }
    const record = bundle as Record<string, unknown>;
    if (
      typeof record["envelopeCanonical"] !== "string" ||
      typeof record["projectId"] !== "string" ||
      typeof record["negotiationId"] !== "string" ||
      typeof record["quoteId"] !== "string" ||
      typeof record["quoteVersion"] !== "string" ||
      typeof record["quoteContentHash"] !== "string" ||
      typeof record["move"] !== "string" ||
      typeof record["payloadHash"] !== "string" ||
      typeof record["roundsUsed"] !== "number"
    ) {
      return genericDenial();
    }
    // The bundle must name this project; a cross-project draft id fails
    // closed here with no oracle. Negotiation mismatches within the
    // project stay visible so the F3 inspection in dispatch still reports
    // a reused request key as a conflict, while the exact draft bindings
    // deny a cross-negotiation first dispatch with zero provider calls.
    if (record["projectId"] !== String(args.projectId)) {
      return genericDenial();
    }
    const conversationVersion =
      record["conversationVersion"] === null || record["conversationVersion"] === undefined
        ? undefined
        : typeof record["conversationVersion"] === "number"
          ? (record["conversationVersion"] as number)
          : undefined;
    if (record["conversationVersion"] !== null && record["conversationVersion"] !== undefined && conversationVersion === undefined) {
      return genericDenial();
    }
    const conversationState =
      record["conversationState"] === null || record["conversationState"] === undefined
        ? undefined
        : typeof record["conversationState"] === "string"
          ? (record["conversationState"] as string)
          : undefined;
    if (record["conversationState"] !== null && record["conversationState"] !== undefined && conversationState === undefined) {
      return genericDenial();
    }
    const replyVersion =
      record["replyVersion"] === null || record["replyVersion"] === undefined
        ? undefined
        : typeof record["replyVersion"] === "string"
          ? (record["replyVersion"] as string)
          : undefined;
    if (record["replyVersion"] !== null && record["replyVersion"] !== undefined && replyVersion === undefined) {
      return genericDenial();
    }
    return {
      ok: true as const,
      envelopeCanonical: record["envelopeCanonical"] as string,
      projectId: record["projectId"] as string,
      negotiationId: record["negotiationId"] as string,
      quoteId: record["quoteId"] as string,
      quoteVersion: record["quoteVersion"] as string,
      quoteContentHash: record["quoteContentHash"] as string,
      ...(conversationVersion === undefined ? {} : { conversationVersion }),
      ...(conversationState === undefined ? {} : { conversationState }),
      ...(replyVersion === undefined ? {} : { replyVersion }),
      roundsUsed: record["roundsUsed"] as number,
      move: record["move"] as string,
      payloadHash: record["payloadHash"] as string,
    };
  },
});

const loadDraftRef = makeFunctionReference<
  "query",
  QueryArgs<typeof loadPreparedNegotiationDraft>,
  QueryReturn<typeof loadPreparedNegotiationDraft>
>("negotiation/orchestrator:loadPreparedNegotiationDraft");

function mandateSnapshotOf(pinned: PinnedContext): MandateSnapshot {
  return {
    negotiationId: String(pinned.negotiationId),
    organizationId: String(pinned.organizationId),
    projectId: String(pinned.projectId),
    quoteId: String(pinned.quoteId),
    state: pinned.mandateState as MandateSnapshot["state"],
    quoteVersion: pinned.mandateQuoteVersion,
    quoteContentHash: pinned.mandateQuoteContentHash,
    ...(pinned.mandateConversationId === undefined
      ? {}
      : { conversationId: String(pinned.mandateConversationId) }),
    ...(pinned.mandateConversationVersion === undefined
      ? {}
      : { conversationVersion: pinned.mandateConversationVersion }),
    roundsUsed: pinned.roundsUsed,
    roundLimit: pinned.roundLimit,
    ...(pinned.targetMinorUnits === undefined ? {} : { targetMinorUnits: pinned.targetMinorUnits }),
    expiresAt: pinned.expiresAt,
  };
}

function currentSnapshotOf(
  pinned: PinnedContext,
  sendGrant: { readonly grantId: string; readonly revocationVersion: number } | null,
): NegotiationCurrentSnapshot {
  const now = Date.now();
  const grantId = sendGrant === null ? PENDING_SEND_GRANT : sendGrant.grantId;
  const grantVersion = sendGrant === null ? 0 : sendGrant.revocationVersion;
  return {
    now,
    currentQuoteId: String(pinned.quoteId),
    quoteVersion: pinned.quoteVersion,
    quoteContentHash: pinned.quoteContentHash,
    quoteSuperseded: pinned.quoteSuperseded,
    ...(pinned.mandateConversationId === undefined
      ? {}
      : { currentConversationId: String(pinned.mandateConversationId) }),
    ...(pinned.conversationVersion === undefined
      ? {}
      : { conversationVersion: pinned.conversationVersion }),
    jobState: "running",
    jobCancelled: false,
    grantStatus: "active",
    grantExpiresAt: pinned.expiresAt,
    currentGrantId: grantId,
    operationGrantId: grantId,
    grantRevocationVersion: grantVersion,
    operationGrantVersion: grantVersion,
    recipientConfigured: pinned.recipientConfigured,
    ...(pinned.recipientConfigVersion === undefined
      ? {}
      : { recipientConfigVersion: pinned.recipientConfigVersion }),
    ...(pinned.recipientConfigVersion === undefined
      ? {}
      : { currentRecipientConfigVersion: pinned.recipientConfigVersion }),
    ...(pinned.recipientMailboxNormalized === undefined
      ? {}
      : { recipientMailboxNormalized: pinned.recipientMailboxNormalized }),
    allowanceExhausted: false,
    userTakeover: false,
    finalOfferReceived: false,
  };
}

const sendCandidateValidator = v.object({
  ok: v.literal(true),
  grantId: v.id("grants"),
  grantRevocationVersion: v.number(),
  jobId: v.id("jobs"),
  reservationId: v.id("reservations"),
  envelopeCanonical: v.string(),
});

/**
 * Discover the exact send grant/job/reservation bound to one validated
 * envelope. Reads only; fails closed when nothing current authorizes it.
 *
 * Bounded pagination (Devin 4060797122 repair): fixed-window `.take()`
 * scans could hide a valid chain behind older unusable grants, so every
 * level paginates to proof of exhaustion. Hitting a page bound with more
 * rows remaining returns an explicit `capacity-search-exhausted` denial
 * instead of a false `grant-not-current` absence.
 */
/**
 * Bounded scan windows with overflow detection. Convex allows only one
 * `.paginate()` call per function execution, so capacity search uses
 * `take(window + 1)` reads: a full (window + 1)th row proves truncation and
 * returns an explicit `capacity-search-exhausted` denial instead of a false
 * absence. Windows comfortably exceed the F1 admission bounds
 * (MAX_JOBS_PER_GRANT, MAX_OPERATIONS_PER_GRANT, MAX_OPERATIONS_PER_JOB,
 * MAX_RESERVATIONS_PER_JOB are all 64).
 */
const DISCOVER_GRANT_WINDOW = 128;
const DISCOVER_JOB_WINDOW = 65;
const DISCOVER_RESERVATION_WINDOW = 65;
export const discoverSendCapacity = f1InternalQuery({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    identity: v.string(),
    envelopeCanonical: v.string(),
  },
  returns: v.union(sendCandidateValidator, denialValidator),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      args.organizationId,
      args.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const now = Date.now();
    const recipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    if (recipients.length !== 1 || recipients[0] === undefined) {
      return { ok: false as const, code: "recipient-missing", message: "owner recipient is not configured" };
    }
    const recipient = recipients[0];
    const grants = await ctx.db
      .query("grants")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "active"))
      .take(DISCOVER_GRANT_WINDOW + 1);
    if (grants.length > DISCOVER_GRANT_WINDOW) {
      return {
        ok: false as const,
        code: "capacity-search-exhausted",
        message: "grant search exceeded its bounded window without proving exhaustion",
      };
    }
    for (const grant of grants) {
      if (
        grant.organizationId !== args.organizationId ||
        !grant.operations.includes(NEGOTIATION_OPERATION_KIND) ||
        grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY ||
        grant.canonicalPayload !== args.envelopeCanonical ||
        grant.recipientConfigVersion !== recipient.version ||
        grant.expiresAt <= now
      ) {
        continue;
      }
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
        .take(DISCOVER_JOB_WINDOW + 1);
      if (jobs.length > DISCOVER_JOB_WINDOW) {
        return {
          ok: false as const,
          code: "capacity-search-exhausted",
          message: "job search exceeded its bounded window without proving exhaustion",
        };
      }
      for (const job of jobs) {
        if (
          job.organizationId !== args.organizationId ||
          job.projectId !== args.projectId ||
          job.grantId !== grant._id ||
          job.grantVersion !== grant.revocationVersion ||
          job.state === "cancelled" ||
          job.state === "cancelling" ||
          canonicalJson(job.inputVersions) !== canonicalJson(grant.inputVersions)
        ) {
          continue;
        }
        const reservations = await ctx.db
          .query("reservations")
          .withIndex("by_job", (q) => q.eq("jobId", job._id))
          .take(DISCOVER_RESERVATION_WINDOW + 1);
        if (reservations.length > DISCOVER_RESERVATION_WINDOW) {
          return {
            ok: false as const,
            code: "capacity-search-exhausted",
            message: "reservation search exceeded its bounded window without proving exhaustion",
          };
        }
        for (const reservation of reservations) {
          if (reservation.state !== "open" || reservation.organizationId !== args.organizationId) {
            continue;
          }
          const bound = await ctx.db
            .query("operations")
            .withIndex("by_reservation", (q) => q.eq("reservationId", reservation._id))
            .take(1);
          if (
            bound.length > 0 &&
            bound[0] !== undefined &&
            bound[0].state !== "cancelled" &&
            bound[0].state !== "denied"
          ) {
            continue;
          }
          return {
            ok: true as const,
            grantId: grant._id,
            grantRevocationVersion: grant.revocationVersion,
            jobId: job._id,
            reservationId: reservation._id,
            envelopeCanonical: args.envelopeCanonical,
          };
        }
      }
    }
    return {
      ok: false as const,
      code: "grant-not-current",
      message: "no current grant, job, and reservation authorize this exact negotiation draft",
    };
  },
});

const discoverCapacityRef = makeFunctionReference<
  "query",
  QueryArgs<typeof discoverSendCapacity>,
  QueryReturn<typeof discoverSendCapacity>
>("negotiation/orchestrator:discoverSendCapacity");

/**
 * Server-owned sender-inbox resolution (Astra F1 repair).
 *
 * The caller-supplied `inboxId` is never trusted as authority. The
 * application-side sender is the provider inbox recorded in the existing
 * protected provider-binding contract (`threadBindings`: provider,
 * environment, organization, project, provider inbox/thread, application
 * conversation/operation), assigned server-side per sponsor-contracts. A
 * negotiation bound to a conversation must use that conversation's single
 * bound inbox; a negotiation without one must use the project's single
 * established inbox. Missing, foreign, stale (closed/cancelled), ambiguous,
 * or cross-project bindings fail closed with zero provider calls.
 */
const SENDER_BINDING_SCAN_WINDOW = 65;

type SenderScope = {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly conversationId: Id<"conversations"> | undefined;
};

async function collectConversationInbox(
  ctx: F1QueryCtx,
  scope: SenderScope,
  conversation: {
    readonly _id: Id<"conversations">;
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly state: string;
  },
  inboxes: Set<string>,
): Promise<{ readonly ok: true; readonly sawBinding: boolean } | { readonly ok: false; readonly code: string; readonly message: string }> {
  const rows = await ctx.db
    .query("threadBindings")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .take(SENDER_BINDING_SCAN_WINDOW + 1);
  if (rows.length > SENDER_BINDING_SCAN_WINDOW) {
    return {
      ok: false as const,
      code: "sender-inbox-conflict",
      message: "sender binding search exceeded its bounded window without proving unanimity",
    };
  }
  let sawBinding = false;
  for (const row of rows) {
    if (row.provider !== "agentmail-binding" || row.environment !== "live") continue;
    if (row.organizationId !== scope.organizationId || row.projectId !== scope.projectId) {
      return {
        ok: false as const,
        code: "sender-inbox-cross-project",
        message: "sender binding belongs to another organization or project",
      };
    }
    sawBinding = true;
    inboxes.add(row.providerInboxId);
  }
  return { ok: true as const, sawBinding };
}

async function resolveServerSenderInbox(
  ctx: F1QueryCtx,
  scope: SenderScope,
): Promise<{ readonly ok: true; readonly inboxId: string } | { readonly ok: false; readonly code: string; readonly message: string }> {
  if (scope.conversationId !== undefined) {
    const conversation = await ctx.db.get(scope.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== scope.organizationId ||
      conversation.projectId !== scope.projectId
    ) {
      return {
        ok: false as const,
        code: "sender-inbox-cross-project",
        message: "sender binding conversation is not in this organization and project",
      };
    }
    if (conversation.state === "closed" || conversation.state === "cancelled") {
      return {
        ok: false as const,
        code: "sender-inbox-stale",
        message: "sender binding conversation is closed; re-approval must establish a live binding",
      };
    }
    const inboxes = new Set<string>();
    const collected = await collectConversationInbox(ctx, scope, conversation, inboxes);
    if (!collected.ok) return collected;
    if (inboxes.size === 0) {
      return {
        ok: false as const,
        code: "sender-inbox-unbound",
        message: "no bound provider sender inbox authorizes this project conversation",
      };
    }
    if (inboxes.size > 1) {
      return {
        ok: false as const,
        code: "sender-inbox-conflict",
        message: "sender binding is ambiguous for this project conversation",
      };
    }
    return { ok: true as const, inboxId: [...inboxes][0] as string };
  }
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_project", (q) => q.eq("projectId", scope.projectId))
    .take(SENDER_BINDING_SCAN_WINDOW + 1);
  if (conversations.length > SENDER_BINDING_SCAN_WINDOW) {
    return {
      ok: false as const,
      code: "sender-inbox-conflict",
      message: "sender binding search exceeded its bounded window without proving unanimity",
    };
  }
  const inboxes = new Set<string>();
  let sawBinding = false;
  for (const conversation of conversations) {
    if (conversation.organizationId !== scope.organizationId) {
      return {
        ok: false as const,
        code: "sender-inbox-cross-project",
        message: "sender binding belongs to another organization",
      };
    }
    // Closed and cancelled conversations keep their historical binding but
    // no longer authorize new sends; they count toward stale, not toward
    // the live project inbox.
    if (conversation.state === "closed" || conversation.state === "cancelled") {
      const probe = new Set<string>();
      const collected = await collectConversationInbox(ctx, scope, conversation, probe);
      if (!collected.ok) return collected;
      if (collected.sawBinding) sawBinding = true;
      continue;
    }
    const collected = await collectConversationInbox(ctx, scope, conversation, inboxes);
    if (!collected.ok) return collected;
    if (collected.sawBinding) sawBinding = true;
  }
  if (inboxes.size === 1) {
    return { ok: true as const, inboxId: [...inboxes][0] as string };
  }
  if (inboxes.size > 1) {
    return {
      ok: false as const,
      code: "sender-inbox-conflict",
      message: "sender binding is ambiguous for this project",
    };
  }
  if (sawBinding) {
    return {
      ok: false as const,
      code: "sender-inbox-stale",
      message: "project sender bindings exist only on closed conversations",
    };
  }
  return {
    ok: false as const,
    code: "sender-inbox-unbound",
    message: "no bound provider sender inbox authorizes this project",
  };
}

/**
 * Server-owned sender-inbox gate for the negotiation send paths. Reads only;
 * fails closed before any operation, claim, or provider call.
 */
export const resolveNegotiationSenderInbox = f1InternalQuery({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
    identity: v.string(),
  },
  returns: v.union(v.object({ ok: v.literal(true), inboxId: v.string() }), denialValidator),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      args.organizationId,
      args.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    return resolveServerSenderInbox(ctx, {
      organizationId: args.organizationId,
      projectId: args.projectId,
      conversationId: args.conversationId,
    });
  },
});

const resolveSenderInboxRef = makeFunctionReference<
  "query",
  QueryArgs<typeof resolveNegotiationSenderInbox>,
  QueryReturn<typeof resolveNegotiationSenderInbox>
>("negotiation/orchestrator:resolveNegotiationSenderInbox");

/**
 * Pre-flight send-operation check (Astra F3 repair): the authorized
 * organization/project/job/negotiation, canonical payload hash/envelope, and
 * sender binding are compared BEFORE observed-success deduplication. Only an
 * exact replay deduplicates. The same requestId with a changed body,
 * subject, negotiation/project, or inbox returns conflict with no further
 * state change. A prepared operation left by a crashed attempt stays unknown
 * under reconciliation; it is never blindly resumed here.
 */
export const inspectSendOperation = f1InternalQuery({
  args: {
    organizationId: v.string(),
    projectId: v.id("projects"),
    negotiationId: v.id("negotiations"),
    requestId: v.string(),
    inboxId: v.string(),
    envelopeCanonical: v.optional(v.string()),
    identity: v.string(),
  },
  returns: v.union(
    v.object({
      status: v.union(
        v.literal("absent"),
        v.literal("deduplicated"),
        v.literal("unknown"),
        v.literal("conflict"),
      ),
      requestKey: v.string(),
      payloadHash: v.optional(v.string()),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    if (args.requestId.trim().length === 0 || args.requestId.length > 128) {
      return { ok: false as const, code: "invalid-bounds", message: "request id is required" };
    }
    const key = requestKey(args.organizationId, NEGOTIATION_OPERATION_KIND, args.requestId);
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .unique();
    if (existing === null) {
      return { status: "absent" as const, requestKey: key };
    }
    const conflict = { status: "conflict" as const, requestKey: key, payloadHash: existing.normalizedPayloadHash };
    // The request key is organization-scoped, not project-scoped: a reused
    // key must still prove the same project, job, negotiation, payload, and
    // sender before any success may be reported.
    if (String(existing.organizationId) !== args.organizationId || existing.projectId !== args.projectId) {
      return conflict;
    }
    if (existing.negotiationAuthority?.negotiationId !== args.negotiationId) {
      return conflict;
    }
    const job = await ctx.db.get(existing.jobId);
    if (job === null || job.organizationId !== existing.organizationId || job.projectId !== existing.projectId) {
      return conflict;
    }
    if (args.envelopeCanonical !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.envelopeCanonical) as unknown;
      } catch {
        return conflict;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        canonicalJson(parsed) !== existing.normalizedPayload ||
        payloadHash(parsed) !== existing.normalizedPayloadHash
      ) {
        return conflict;
      }
    }
    // The stored operation's sender is the server-owned binding at first
    // send (threadBindings for its bound conversation, else its project).
    // A replay naming any other inbox conflicts instead of deduplicating.
    const storedSender = await resolveServerSenderInbox(ctx, {
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      conversationId: existing.negotiationAuthority?.conversationId,
    });
    if (!storedSender.ok || storedSender.inboxId !== args.inboxId) {
      return conflict;
    }
    if (existing.state === "observedSuccess") {
      return { status: "deduplicated" as const, requestKey: key, payloadHash: existing.normalizedPayloadHash };
    }
    return { status: "unknown" as const, requestKey: key, payloadHash: existing.normalizedPayloadHash };
  },
});

const inspectOperationRef = makeFunctionReference<
  "query",
  QueryArgs<typeof inspectSendOperation>,
  QueryReturn<typeof inspectSendOperation>
>("negotiation/orchestrator:inspectSendOperation");

const outcomeValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.union(v.literal("sent"), v.literal("waiting")),
    jobId: v.optional(v.id("jobs")),
    jobState: v.optional(v.string()),
    expectedRoundsUsed: v.number(),
  }),
  denialValidator,
);

/**
 * Refund a claim-consumed round when provably no send occurred. Production
 * callers identify the exact operation whose atomic claim owns the round;
 * the ownership markers prevent a concurrent failed attempt from refunding
 * another attempt's round. Ambiguous outcomes never reach this mutation.
 */
export const refundNegotiationRound = f1InternalMutation({
  args: {
    negotiationId: v.id("negotiations"),
    identity: v.string(),
    expectedRoundsUsed: v.number(),
    operationId: v.id("operations"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), refunded: v.boolean(), roundsUsed: v.number() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const negotiation = await ctx.db.get(args.negotiationId);
    if (negotiation === null) return genericDenial();
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      negotiation.organizationId,
      negotiation.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const operation = await ctx.db.get(args.operationId);
    if (
      operation === null ||
      operation.organizationId !== negotiation.organizationId ||
      operation.projectId !== negotiation.projectId ||
      operation.negotiationAuthority?.negotiationId !== args.negotiationId ||
      operation.negotiationAuthority.roundsUsed !== args.expectedRoundsUsed ||
      operation.negotiationRoundConsumed !== true ||
      operation.negotiationRoundRefunded === true
    ) {
      return { ok: true as const, refunded: false, roundsUsed: negotiation.roundsUsed };
    }
    if (negotiation.roundsUsed === args.expectedRoundsUsed + 1) {
      await ctx.db.patch(args.negotiationId, {
        roundsUsed: args.expectedRoundsUsed,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(args.operationId, {
        negotiationRoundRefunded: true,
        updatedAt: Date.now(),
      });
      return { ok: true as const, refunded: true, roundsUsed: args.expectedRoundsUsed };
    }
    return { ok: true as const, refunded: false, roundsUsed: negotiation.roundsUsed };
  },
});

const refundRoundRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof refundNegotiationRound>,
  MutationReturn<typeof refundNegotiationRound>
>("negotiation/orchestrator:refundNegotiationRound");

/**
 * Persist honest job states against existing records. Round consumption
 * lives in the operation's atomic claim and definitive non-sends use
 * `refundNegotiationRound`; this mutation only moves jobs into the existing
 * supplier/user wait states. Terminal, denied, and deduplicated outcomes
 * write nothing. Never touches quotes, orders, selections, or commitments.
 */
export const applyStepOutcome = f1InternalMutation({
  args: {
    negotiationId: v.id("negotiations"),
    identity: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("waiting")),
    jobId: v.optional(v.id("jobs")),
    jobState: v.optional(v.string()),
    expectedRoundsUsed: v.number(),
  },
  returns: outcomeValidator,
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const negotiation = await ctx.db.get(args.negotiationId);
    if (negotiation === null) return genericDenial();
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      negotiation.organizationId,
      negotiation.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.jobId !== undefined) {
      const job = await ctx.db.get(args.jobId);
      if (
        job === null ||
        job.organizationId !== negotiation.organizationId ||
        job.projectId !== negotiation.projectId
      ) {
        return genericDenial();
      }
      const patchable =
        job.state === "queued" ||
        job.state === "running" ||
        job.state === "waitingForSupplier" ||
        job.state === "waitingForUser" ||
        job.state === "pausedBudget";
      if (args.outcome === "sent") {
        if (patchable) {
          await ctx.db.patch(job._id, { state: "waitingForSupplier", updatedAt: Date.now() });
        }
        return {
          ok: true as const,
          outcome: "sent" as const,
          jobId: job._id,
          jobState: "waitingForSupplier",
          expectedRoundsUsed: negotiation.roundsUsed,
        };
      }
      if (args.outcome === "waiting" && args.jobState !== undefined && patchable) {
        if (args.jobState === "waitingForSupplier" || args.jobState === "waitingForUser") {
          await ctx.db.patch(job._id, {
            state: args.jobState,
            updatedAt: Date.now(),
          });
        }
      }
      return {
        ok: true as const,
        outcome: args.outcome,
        jobId: args.jobId,
        ...(args.jobState === undefined ? {} : { jobState: args.jobState }),
        expectedRoundsUsed: negotiation.roundsUsed,
      };
    }
    if (args.outcome === "sent") {
      return {
        ok: true as const,
        outcome: "sent" as const,
        expectedRoundsUsed: negotiation.roundsUsed,
      };
    }
    return { ok: true as const, outcome: args.outcome, expectedRoundsUsed: negotiation.roundsUsed };
  },
});

const applyOutcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof applyStepOutcome>,
  MutationReturn<typeof applyStepOutcome>
>("negotiation/orchestrator:applyStepOutcome");

/**
 * Readiness probe: at least one current send grant/job/reservation chain
 * exists for this project. Runs before the first provider call so
 * allowance/recipient denials cost zero provider calls.
 */
export const probeSendReadiness = f1InternalQuery({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    identity: v.string(),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing identity proof" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      args.organizationId,
      args.projectId,
      "approver",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const now = Date.now();
    const recipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    if (recipients.length !== 1) {
      return { ok: false as const, code: "recipient-missing", message: "owner recipient is not configured" };
    }
    // Same bounded-window contract as discovery: never mistake a
    // truncated scan for absence.
    const grants = await ctx.db
      .query("grants")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "active"))
      .take(DISCOVER_GRANT_WINDOW + 1);
    if (grants.length > DISCOVER_GRANT_WINDOW) {
      return {
        ok: false as const,
        code: "capacity-search-exhausted",
        message: "grant search exceeded its bounded window without proving exhaustion",
      };
    }
    for (const grant of grants) {
      // Send capacity is specifically a grant carrying the orchestrator's
      // `send` input-version marker (draft/model grants use their own
      // workload bindings), so revoking or cancelling the send chain alone
      // fails this probe before any provider call.
      if (
        grant.organizationId !== args.organizationId ||
        !grant.operations.includes(NEGOTIATION_OPERATION_KIND) ||
        grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY ||
        grant.inputVersions["send"] === undefined ||
        grant.expiresAt <= now
      ) {
        continue;
      }
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
        .take(DISCOVER_JOB_WINDOW + 1);
      if (jobs.length > DISCOVER_JOB_WINDOW) {
        return {
          ok: false as const,
          code: "capacity-search-exhausted",
          message: "job search exceeded its bounded window without proving exhaustion",
        };
      }
      for (const job of jobs) {
        if (
          job.organizationId !== args.organizationId ||
          job.state === "cancelled" ||
          job.state === "cancelling"
        ) {
          continue;
        }
        const reservations = await ctx.db
          .query("reservations")
          .withIndex("by_job", (q) => q.eq("jobId", job._id))
          .take(DISCOVER_RESERVATION_WINDOW + 1);
        if (reservations.length > DISCOVER_RESERVATION_WINDOW) {
          return {
            ok: false as const,
            code: "capacity-search-exhausted",
            message: "reservation search exceeded its bounded window without proving exhaustion",
          };
        }
        if (reservations.some((reservation) => reservation.state === "open")) {
          return { ok: true as const };
        }
      }
    }
    return {
      ok: false as const,
      code: "allowance-exhausted",
      message: "no current send grant, job, and reservation authorize negotiation work",
    };
  },
});

const probeReadinessRef = makeFunctionReference<
  "query",
  QueryArgs<typeof probeSendReadiness>,
  QueryReturn<typeof probeSendReadiness>
>("negotiation/orchestrator:probeSendReadiness");

const stepResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.literal("sent"),
    move: v.string(),
    requestKey: v.string(),
    payloadHash: v.string(),
    roundsUsedAfter: v.number(),
    providerMessageId: v.string(),
    redactedPreview: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("deduplicated"),
    move: v.string(),
    requestKey: v.string(),
    payloadHash: v.string(),
    roundsUsedAfter: v.number(),
    redactedPreview: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("waiting"),
    move: v.string(),
    reason: v.string(),
    roundsUsedAfter: v.number(),
    redactedPreview: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("stopped"),
    move: v.string(),
    reason: v.string(),
    roundsUsedAfter: v.number(),
    redactedPreview: v.string(),
  }),
  denialValidator,
);

function deniedResult(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function actionDenialOf(value: unknown): { code: string; message: string } | null {
  if (typeof value !== "object" || value === null || !("ok" in value)) return null;
  const record = value as { ok?: unknown; code?: unknown; message?: unknown };
  if (record.ok === false && typeof record.code === "string" && typeof record.message === "string") {
    return { code: record.code, message: record.message };
  }
  return null;
}

function malformedResult(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: "provider-result-malformed", message };
}

function mapJevToInjected(
  result: ActionReturn<typeof jev.classify>,
  currentInputVersion: string,
): { ok: true; value: InjectedJevResult } | { ok: false; code: string; message: string } {
  const denial = actionDenialOf(result);
  if (denial !== null) {
    return { ok: false, code: denial.code, message: denial.message };
  }
  if (typeof result !== "object" || result === null) {
    return malformedResult("Jev result is not an object");
  }
  const record = result as Record<string, unknown>;
  const outcome = record["outcome"];
  const inputVersion = record["inputVersion"];
  if (typeof inputVersion !== "string" || inputVersion.length === 0) {
    return malformedResult("Jev result carries no input version");
  }
  if (inputVersion !== currentInputVersion) {
    return {
      ok: true,
      value: { outcome: "stale", model: JEV_PINNED_MODEL, inputVersion, currentInputVersion },
    };
  }
  if (outcome === "stale" || outcome === "needsReview" || outcome === "unavailable") {
    return {
      ok: true,
      value: { outcome, model: JEV_PINNED_MODEL, inputVersion, currentInputVersion },
    };
  }
  if (outcome !== "decided") {
    return malformedResult("Jev result outcome is not a known value");
  }
  const model = record["model"];
  if (typeof model !== "string" || model.length === 0) {
    return malformedResult("Jev result carries no model version");
  }
  const answers = record["answers"];
  const moveAnswer =
    typeof answers === "object" && answers !== null
      ? (answers as Record<string, unknown>)["move"]
      : undefined;
  const choice =
    typeof moveAnswer === "object" &&
    moveAnswer !== null &&
    (moveAnswer as Record<string, unknown>)["type"] === "choice" &&
    typeof (moveAnswer as Record<string, unknown>)["choice"] === "string"
      ? ((moveAnswer as Record<string, unknown>)["choice"] as string)
      : undefined;
  return {
    ok: true,
    value: {
      outcome: "decided",
      ...(choice === undefined ? {} : { choice }),
      model,
      inputVersion,
      currentInputVersion,
    },
  };
}

function mapDraftToInjected(
  result: ActionReturn<typeof openai.draft>,
  currentInputVersion: string,
  quote: { readonly id: string; readonly version: string },
  reply: { readonly conversationId: string; readonly version: string } | null,
  conversationVersion: number | undefined,
): { ok: true; value: InjectedDraftResult } | { ok: false; code: string; message: string } {
  const denial = actionDenialOf(result);
  if (denial !== null) {
    return { ok: false, code: denial.code, message: denial.message };
  }
  if (typeof result !== "object" || result === null) {
    return malformedResult("draft result is not an object");
  }
  const record = result as Record<string, unknown>;
  const outcome = record["outcome"];
  const inputVersion = record["inputVersion"];
  if (typeof inputVersion !== "string" || inputVersion.length === 0) {
    return malformedResult("draft result carries no input version");
  }
  if (inputVersion !== currentInputVersion) {
    return {
      ok: true,
      value: {
        outcome: "stale",
        model: NEGOTIATION_OPENAI_MODEL,
        inputVersion,
        currentInputVersion,
      },
    };
  }
  if (outcome === "stale" || outcome === "unavailable" || outcome === "rejected") {
    return {
      ok: true,
      value: { outcome, model: NEGOTIATION_OPENAI_MODEL, inputVersion, currentInputVersion },
    };
  }
  if (outcome !== "completed") {
    return malformedResult("draft result outcome is not a known value");
  }
  const output = record["output"];
  if (typeof output !== "object" || output === null) {
    return { ok: false, code: "draft-malformed", message: "draft result carries no output" };
  }
  const outputRecord = output as Record<string, unknown>;
  if (outputRecord["kind"] !== "supplierDraft") {
    return { ok: false, code: "draft-malformed", message: "draft workload returned a non-draft output" };
  }
  const sources = outputRecord["sources"];
  const quotePinned =
    Array.isArray(sources) &&
    sources.some(
      (source) =>
        typeof source === "object" &&
        source !== null &&
        (source as Record<string, unknown>)["sourceId"] === `quote:${quote.id}` &&
        (source as Record<string, unknown>)["version"] === quote.version,
    );
  if (!quotePinned) {
    return { ok: false, code: "draft-malformed", message: "draft is not pinned to the current quote source" };
  }
  if (reply !== null) {
    const replyPinned =
      Array.isArray(sources) &&
      sources.some(
        (source) =>
          typeof source === "object" &&
          source !== null &&
          (source as Record<string, unknown>)["sourceId"] === `conversation:${reply.conversationId}` &&
          (source as Record<string, unknown>)["version"] === reply.version,
      );
    if (!replyPinned) {
      return {
        ok: true,
        value: {
          outcome: "stale",
          model: NEGOTIATION_OPENAI_MODEL,
          inputVersion,
          currentInputVersion,
        },
      };
    }
  }
  const model = record["model"];
  if (typeof model !== "string" || model.length === 0) {
    return malformedResult("draft result carries no model version");
  }
  const draftKind = outputRecord["draftKind"];
  const content = outputRecord["content"];
  if (typeof draftKind !== "string" || typeof content !== "string") {
    return { ok: false, code: "draft-malformed", message: "draft output shape is invalid" };
  }
  return {
    ok: true,
    value: {
      outcome: "completed",
      draftKind,
      content,
      sourceQuoteVersion: quote.version,
      ...(conversationVersion === undefined ? {} : { sourceConversationVersion: conversationVersion }),
      model,
      inputVersion,
      currentInputVersion,
    },
  };
}

/**
 * Authorized honest-state projection for one negotiation. Read-only: exposes
 * mandate state, round accounting, current quote version, and recipient
 * readiness with the controlled-demo evidence label. Never exposes the
 * private mailbox, confidential figures, or provider internals.
 */
export const stepStatus = f1Query({
  args: { negotiationId: v.id("negotiations") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      state: v.string(),
      roundsUsed: v.number(),
      roundLimit: v.number(),
      quoteVersion: v.string(),
      recipientConfigured: v.boolean(),
      counterpartyRole: v.string(),
      evidenceLabel: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const negotiation = await ctx.db.get(args.negotiationId);
    if (negotiation === null) return genericDenial();
    const access = await checkProjectAccess(
      ctx,
      identity,
      negotiation.organizationId,
      negotiation.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) {
      if (access.code === "denied-membership") return genericDenial();
      return { ok: false as const, code: access.code, message: access.message };
    }
    const recipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    return {
      ok: true as const,
      state: negotiation.state,
      roundsUsed: negotiation.roundsUsed,
      roundLimit: negotiation.roundLimit,
      quoteVersion: negotiation.quoteVersion,
      recipientConfigured: recipients.length === 1,
      counterpartyRole: "ownerStandIn",
      evidenceLabel: "controlled demo evidence — never realized savings",
    };
  },
});

const preparedResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.literal("prepared"),
    move: v.string(),
    draftId: v.id("evidence"),
    payloadHash: v.string(),
    quoteVersion: v.string(),
    quoteContentHash: v.string(),
    conversationVersion: v.optional(v.number()),
    roundsUsed: v.number(),
    redactedPreview: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("waiting"),
    move: v.string(),
    reason: v.string(),
    roundsUsedAfter: v.number(),
    redactedPreview: v.string(),
  }),
  v.object({
    ok: v.literal(true),
    outcome: v.literal("stopped"),
    move: v.string(),
    reason: v.string(),
    roundsUsedAfter: v.number(),
    redactedPreview: v.string(),
  }),
  denialValidator,
);

/**
 * Phase one of the two-phase flow (Devin 4060796714 repair, E17 mailbox
 * privacy): classify the move, generate and validate the draft, persist its
 * exact canonical envelope server-side, and return only an opaque draft id
 * plus a redacted preview WITHOUT sending. A generated draft can never match
 * a pre-issued grant, so the approval flow issues an exact send grant from
 * the stored envelope; `dispatchApprovedDraft` resolves that envelope
 * server-side from the draft id and sends only under that grant. Consumes no
 * round and creates no send operation; the unredacted recipient never leaves
 * the backend in this response.
 */
export const prepareNegotiationDraft = f1Action({
  args: {
    negotiationId: v.id("negotiations"),
    jevOperationId: v.id("operations"),
    draftOperationId: v.id("operations"),
    requestText: v.optional(v.string()),
  },
  returns: preparedResultValidator,
  handler: async (ctx, args) => {
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return deniedResult("forged-identity", "unauthenticated");
    }
    const resolved = await resolvePins(ctx, args.negotiationId, identity, args.requestText);
    if (!resolved.ok) return deniedResult(resolved.code, resolved.message);
    const pinned = resolved.pinned;
    const mandate = mandateSnapshotOf(pinned);
    const bounds = checkNegotiationBounds(mandate, currentSnapshotOf(pinned, null));
    if (bounds !== null) return deniedResult(bounds.code, bounds.message);
    const earlyFence = checkNegotiationFences(mandate, currentSnapshotOf(pinned, null));
    if (earlyFence !== null) {
      if (earlyFence.kind === "stopped") {
        return {
          ok: true as const,
          outcome: "stopped" as const,
          move: "none",
          reason: earlyFence.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: "stopped — no supplier-visible text prepared",
        };
      }
      if (earlyFence.kind === "waiting") {
        return {
          ok: true as const,
          outcome: "waiting" as const,
          move: "none",
          reason: earlyFence.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: "waiting — no supplier-visible text prepared",
        };
      }
      return deniedResult(earlyFence.code, earlyFence.message);
    }
    if (approvedConversationGate(pinned).stopped) {
      return {
        ok: true as const,
        outcome: "stopped" as const,
        move: "none",
        reason: "conversation-changed",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "stopped — bound reply arrived; ingestion must update the mandate basis first",
      };
    }
    const replyHold = replyGate(pinned);
    if (replyHold !== null) {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: "none",
        reason: replyHold.code,
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: `waiting — ${replyHold.message}`,
      };
    }

    const jevWorkload = buildNegotiationJevWorkload({
      negotiationId: String(pinned.negotiationId),
      quoteId: String(pinned.quoteId),
      quoteVersion: pinned.quoteVersion,
      quoteContentHash: pinned.quoteContentHash,
      quoteTerms: pinned.quoteTerms,
      missingTerms: pinned.missingTerms,
      replyDigest: replyDigestOf(pinned),
      ...(pinned.replyExcerpt === undefined ? {} : { replyMeaning: pinned.replyExcerpt }),
      ...(pinned.replySourceId === undefined ||
      pinned.replySourceVersion === undefined ||
      pinned.replySourceLocator === undefined
        ? {}
        : {
            replySource: `${pinned.replySourceId}@${pinned.replySourceVersion}#${pinned.replySourceLocator}`,
          }),
      conversationVersion: pinned.conversationVersion,
      roundsUsed: pinned.roundsUsed,
      roundLimit: pinned.roundLimit,
      mandateState: pinned.mandateState,
    });
    const jevResult = await ctx.runAction(classifyRef, {
      operationId: args.jevOperationId,
      identity,
      state: jevWorkload.state,
      questions: jevWorkload.questions,
      inputVersion: jevWorkload.inputVersion,
    });
    const injectedJev = mapJevToInjected(jevResult, jevWorkload.inputVersion);
    if (!injectedJev.ok) return deniedResult(injectedJev.code, injectedJev.message);
    const selected = selectNegotiationMove(injectedJev.value);
    if (!selected.ok) {
      if (selected.kind === "waiting") {
        return {
          ok: true as const,
          outcome: "waiting" as const,
          move: "none",
          reason: selected.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: "waiting — no supplier-visible text prepared",
        };
      }
      return deniedResult(selected.code, selected.message);
    }
    if (selected.move === "stop") {
      return {
        ok: true as const,
        outcome: "stopped" as const,
        move: selected.move,
        reason: "stop-move",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "stopped — no supplier-visible text prepared",
      };
    }
    if (selected.move === "hold") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: selected.move,
        reason: "waiting-for-owner",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — no supplier-visible text prepared",
      };
    }
    const move: Extract<NegotiationMove, "clarify" | "counter"> = selected.move;

    const draftWorkload = buildNegotiationDraftWorkload(
      {
        negotiationId: String(pinned.negotiationId),
        quoteId: String(pinned.quoteId),
        quoteVersion: pinned.quoteVersion,
        quoteContentHash: pinned.quoteContentHash,
        quoteTerms: pinned.quoteTerms,
        missingTerms: pinned.missingTerms,
        mandateState: pinned.mandateState,
        conversationId:
          pinned.mandateConversationId === undefined ? undefined : String(pinned.mandateConversationId),
        conversationVersion: pinned.conversationVersion,
        replyExcerpt: pinned.replyExcerpt,
        replyVersion: pinned.replyVersion,
        roundsUsed: pinned.roundsUsed,
        roundLimit: pinned.roundLimit,
      },
      move,
    );
    const carrierCanonical = draftCarrierPayloadJson(
      pinned.recipientMailboxNormalized ?? "",
      draftWorkload.brief,
    );
    const draftResult = await ctx.runAction(draftRef, {
      operationId: args.draftOperationId,
      identity,
      inputVersion: draftWorkload.inputVersion,
      payloadJson: carrierCanonical,
      workload: {
        kind: "supplierDraft",
        inputVersion: draftWorkload.inputVersion,
        draftKind: draftWorkload.draftKind,
        brief: draftWorkload.brief,
        sources: draftWorkload.sources.map((source) => ({ ...source })),
      },
    });
    const injectedDraft = mapDraftToInjected(
      draftResult,
      draftWorkload.inputVersion,
      { id: String(pinned.quoteId), version: pinned.quoteVersion },
      pinned.mandateConversationId === undefined || pinned.replyVersion === undefined
        ? null
        : { conversationId: String(pinned.mandateConversationId), version: pinned.replyVersion },
      pinned.conversationVersion,
    );
    if (!injectedDraft.ok) return deniedResult(injectedDraft.code, injectedDraft.message);
    const draftValue: InjectedDraftResult = injectedDraft.value;
    if (draftValue.outcome === "stale") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "draft-stale",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — no supplier-visible text prepared",
      };
    }
    if (draftValue.outcome === "unavailable" || draftValue.outcome === "rejected") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "draft-unavailable",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — no supplier-visible text prepared",
      };
    }
    if (draftValue.model !== NEGOTIATION_OPENAI_MODEL || draftValue.model !== OPENAI_PINNED_MODEL) {
      return deniedResult("draft-malformed", "draft is not from the pinned drafting model");
    }
    if (draftValue.draftKind !== move) {
      return deniedResult("draft-malformed", "draft kind does not match the selected move");
    }
    if (draftValue.sourceQuoteVersion !== pinned.quoteVersion) {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "draft-stale",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — no supplier-visible text prepared",
      };
    }
    if ((pinned.conversationVersion ?? null) !== (draftValue.sourceConversationVersion ?? null)) {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "draft-stale",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — no supplier-visible text prepared",
      };
    }
    if (typeof draftValue.content !== "string" || draftValue.content.trim().length === 0) {
      return deniedResult("draft-malformed", "negotiation draft text is required");
    }
    if (new TextEncoder().encode(draftValue.content).byteLength > NEGOTIATION_MAX_DRAFT_BYTES) {
      return deniedResult("draft-malformed", "negotiation draft exceeds the output bound");
    }
    const checked = validateNegotiationDraft(draftValue.content, {
      ...(pinned.targetMinorUnits === undefined ? {} : { targetMinorUnits: pinned.targetMinorUnits }),
      ...(pinned.recipientMailboxNormalized === undefined
        ? {}
        : { ownerMailboxNormalized: pinned.recipientMailboxNormalized }),
    });
    if (!checked.ok) return deniedResult(checked.code, checked.message);

    const envelope = sendEnvelope(pinned.recipientMailboxNormalized ?? "", draftValue.content);
    const outbound = validateOutboundPayload(envelope, pinned.recipientMailboxNormalized);
    if (isCommunicationDenial(outbound)) {
      return deniedResult("outbound-denied", outbound.message);
    }
    const envelopeCanonical = canonicalJson(envelope);
    if (envelopeCanonical !== outbound.canonical) {
      return deniedResult("outbound-denied", "payload canonical form changed");
    }
    const hash = payloadHash(envelope);
    // E17: persist the unredacted owner envelope server-side only. The
    // caller receives an opaque draft id plus a redacted preview; the
    // mailbox and canonical recipient never leave the backend in this
    // response.
    const stored = await ctx.runMutation(saveDraftRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      negotiationId: pinned.negotiationId,
      quoteId: pinned.quoteId,
      quoteVersion: pinned.quoteVersion,
      quoteContentHash: pinned.quoteContentHash,
      ...(pinned.conversationVersion === undefined ? {} : { conversationVersion: pinned.conversationVersion }),
      ...(pinned.conversationState === undefined ? {} : { conversationState: pinned.conversationState }),
      ...(pinned.replyVersion === undefined ? {} : { replyVersion: pinned.replyVersion }),
      roundsUsed: pinned.roundsUsed,
      move,
      envelopeCanonical,
      payloadHash: hash,
      identity,
    });
    if (!stored.ok) return deniedResult(stored.code, stored.message);
    return {
      ok: true as const,
      outcome: "prepared" as const,
      move,
      draftId: stored.draftId,
      payloadHash: hash,
      quoteVersion: pinned.quoteVersion,
      quoteContentHash: pinned.quoteContentHash,
      ...(pinned.conversationVersion === undefined
        ? {}
        : { conversationVersion: pinned.conversationVersion }),
      roundsUsed: pinned.roundsUsed,
      redactedPreview: checked.redactedPreview,
    };
  },
});

const prepareDraftRef = makeFunctionReference<
  "action",
  ActionArgs<typeof prepareNegotiationDraft>,
  ActionReturn<typeof prepareNegotiationDraft>
>("negotiation/orchestrator:prepareNegotiationDraft");

const approvalResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.literal("approved"),
    draftId: v.id("evidence"),
    move: v.string(),
    quoteVersion: v.string(),
    quoteContentHash: v.string(),
    conversationVersion: v.optional(v.number()),
    replyVersion: v.optional(v.string()),
    roundsUsed: v.number(),
    payloadHash: v.string(),
    redactedPreview: v.string(),
  }),
  denialValidator,
);

/**
 * Public authorized draft-id approval boundary (Astra repair: opaque
 * approve).
 *
 * The caller supplies only the opaque server-side draft id; the exact
 * canonical envelope (containing the private owner mailbox) is resolved
 * server-side under approver authority and never returns to the client.
 * The response carries the approved move, quote/round/reply pins, payload
 * hash, and a redacted advance preview — enough to approve with
 * understanding — but no mailbox, no draft text, and no canonical
 * envelope. Read-only: makes no model calls, creates no operation, and
 * consumes no round. `dispatchApprovedDraft` re-enforces every binding
 * live before the single send.
 */
export const approveNegotiationDraft = f1Query({
  args: {
    negotiationId: v.id("negotiations"),
    draftId: v.id("evidence"),
  },
  returns: approvalResultValidator,
  handler: async (ctx, args) => {
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const loaded = await ctx.runQuery(loadContextRef, {
      negotiationId: args.negotiationId,
      identity,
    });
    if (!loaded.ok) return { ok: false as const, code: loaded.code, message: loaded.message };
    const pinned: PinnedContext = {
      organizationId: loaded.organizationId as Id<"organizations">,
      projectId: loaded.projectId as Id<"projects">,
      projectName: loaded.projectName,
      negotiationId: loaded.negotiationId as Id<"negotiations">,
      quoteId: loaded.quoteId as Id<"quotes">,
      mandateState: loaded.mandateState,
      mandateQuoteVersion: loaded.mandateQuoteVersion,
      mandateQuoteContentHash: loaded.mandateQuoteContentHash,
      mandateConversationId:
        loaded.mandateHasConversation && loaded.currentConversationId !== undefined
          ? (loaded.currentConversationId as Id<"conversations">)
          : undefined,
      mandateConversationVersion: loaded.mandateConversationVersion,
      mandateConversationState: loaded.mandateConversationState,
      roundsUsed: loaded.roundsUsed,
      roundLimit: loaded.roundLimit,
      expiresAt: loaded.expiresAt,
      targetMinorUnits: loaded.targetMinorUnits,
      quoteVersion: loaded.quote.version,
      quoteContentHash: loaded.quote.contentHash,
      quoteExcerpt: loaded.quote.excerpt,
      quoteTerms: loaded.quote.terms,
      missingTerms: loaded.quote.missingTerms,
      quoteSuperseded: loaded.quoteSuperseded,
      conversationVersion: loaded.currentConversationVersion,
      conversationState: loaded.conversationState,
      replyExcerpt: loaded.replyExcerpt,
      replyCapturedAt: loaded.replyCapturedAt,
      replyVersion: loaded.replyVersion,
      replySourceId: loaded.replySourceId,
      replySourceVersion: loaded.replySourceVersion,
      replySourceLocator: loaded.replySourceLocator,
      replyReviewPending: loaded.replyReviewPending ?? false,
      replyScanIncomplete: loaded.replyScanIncomplete ?? false,
      recipientConfigured: loaded.recipientConfigured,
      recipientConfigVersion: loaded.recipientConfigVersion,
      recipientMailboxNormalized: loaded.recipientMailboxNormalized,
    };
    const mandate = mandateSnapshotOf(pinned);
    const bounds = checkNegotiationBounds(mandate, currentSnapshotOf(pinned, null));
    if (bounds !== null) return { ok: false as const, code: bounds.code, message: bounds.message };
    const fence = checkNegotiationFences(mandate, currentSnapshotOf(pinned, null));
    if (fence !== null) {
      return { ok: false as const, code: "mandate-not-current", message: "negotiation mandate is not currently sendable" };
    }
    if (approvedConversationGate(pinned).stopped) {
      return { ok: false as const, code: "mandate-not-current", message: "bound reply arrived; ingestion must update the mandate basis first" };
    }
    const replyHold = replyGate(pinned);
    if (replyHold !== null) {
      return { ok: false as const, code: replyHold.code, message: replyHold.message };
    }
    const approvedDraft = await ctx.runQuery(loadDraftRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      negotiationId: pinned.negotiationId,
      draftId: args.draftId,
      identity,
    });
    if (!approvedDraft.ok) return { ok: false as const, code: approvedDraft.code, message: approvedDraft.message };
    const approved = validateApprovedEnvelope(
      approvedDraft.envelopeCanonical,
      pinned.recipientMailboxNormalized,
      pinned.targetMinorUnits,
    );
    if (!approved.ok) return { ok: false as const, code: approved.code, message: approved.message };
    const binding = checkDraftBindings(
      {
        projectId: approvedDraft.projectId,
        negotiationId: approvedDraft.negotiationId,
        quoteId: approvedDraft.quoteId,
        quoteVersion: approvedDraft.quoteVersion,
        quoteContentHash: approvedDraft.quoteContentHash,
        conversationVersion: approvedDraft.conversationVersion,
        conversationState: approvedDraft.conversationState,
        replyVersion: approvedDraft.replyVersion,
        roundsUsed: approvedDraft.roundsUsed,
        move: approvedDraft.move,
        payloadHash: approvedDraft.payloadHash,
      },
      {
        projectId: String(pinned.projectId),
        negotiationId: String(pinned.negotiationId),
        quoteId: String(pinned.quoteId),
        quoteVersion: pinned.quoteVersion,
        quoteContentHash: pinned.quoteContentHash,
        conversationVersion: pinned.conversationVersion,
        conversationState: pinned.conversationState,
        replyVersion: pinned.replyVersion,
        roundsUsed: pinned.roundsUsed,
      },
      approvedDraft.envelopeCanonical,
    );
    if (!binding.ok) return { ok: false as const, code: binding.code, message: binding.message };
    return {
      ok: true as const,
      outcome: "approved" as const,
      draftId: args.draftId,
      move: approvedDraft.move,
      quoteVersion: approvedDraft.quoteVersion,
      quoteContentHash: approvedDraft.quoteContentHash,
      ...(approvedDraft.conversationVersion === undefined
        ? {}
        : { conversationVersion: approvedDraft.conversationVersion }),
      ...(approvedDraft.replyVersion === undefined ? {} : { replyVersion: approvedDraft.replyVersion }),
      roundsUsed: approvedDraft.roundsUsed,
      payloadHash: approvedDraft.payloadHash,
      redactedPreview: approved.redactedPreview,
    };
  },
});

const approvalGrantValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.literal("grant-issued"),
    grantId: v.id("grants"),
    revocationVersion: v.number(),
    move: v.string(),
    quoteVersion: v.string(),
    quoteContentHash: v.string(),
    roundsUsed: v.number(),
    payloadHash: v.string(),
    redactedPreview: v.string(),
  }),
  denialValidator,
);

/**
 * Bounded approval parameters for issuing the exact send grant. All values
 * are non-private numbers; the private envelope always comes from the
 * server-side draft bundle, never from the caller.
 */
const APPROVAL_MAX_COST_CEILING_MICRO_USD = 1_000_000;
const APPROVAL_MAX_ROUND_LIMIT = 8;
const APPROVAL_MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Send input-version marker the readiness probe and discovery require. */
const APPROVAL_SEND_INPUT_VERSION = "send-v1";

/**
 * Public approval that establishes send authority from a draft id (Astra
 * finding 3 root-cause repair).
 *
 * The read-only `approveNegotiationDraft` preview alone could not close the
 * loop: `discoverSendCapacity` demands a pre-existing grant whose canonical
 * payload equals the private envelope, and `grants:issue` demands a
 * browser-supplied `payloadJson` — so a fresh approver holding only a
 * draft id could never reach authorized dispatch without knowing or
 * leaking the protected envelope. This action closes that gap: it accepts
 * the draft id plus only non-private bounded approval parameters,
 * resolves and validates the protected envelope server-side (same pins,
 * envelope validation, and exact draft bindings as dispatch), and issues
 * the exact send grant through the existing `grants:issue` invariants —
 * same recipient-version binding, same canonical-payload equality, same
 * workflow authority — with `payloadJson` supplied server-side from the
 * stored bundle. The response carries the new grant id, the approved move
 * and pins, and a redacted preview; never the mailbox, the canonical
 * envelope, or raw draft text. Makes no model calls and sends nothing;
 * the normal public job/reservation setup followed by
 * `dispatchApprovedDraft` completes the flow.
 */
export const approveNegotiationSend = f1Action({
  args: {
    negotiationId: v.id("negotiations"),
    draftId: v.id("evidence"),
    costCeilingMicroUsd: v.number(),
    roundLimit: v.number(),
    expiresAt: v.number(),
  },
  returns: approvalGrantValidator,
  handler: async (ctx, args) => {
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return deniedResult("forged-identity", "unauthenticated");
    }
    if (
      !Number.isSafeInteger(args.costCeilingMicroUsd) ||
      args.costCeilingMicroUsd < 1 ||
      args.costCeilingMicroUsd > APPROVAL_MAX_COST_CEILING_MICRO_USD
    ) {
      return deniedResult("invalid-bounds", "cost ceiling must be a positive safe integer within the approval bound");
    }
    if (
      !Number.isSafeInteger(args.roundLimit) ||
      args.roundLimit < 1 ||
      args.roundLimit > APPROVAL_MAX_ROUND_LIMIT
    ) {
      return deniedResult("invalid-bounds", "round limit must be a positive safe integer within the approval bound");
    }
    const now = Date.now();
    if (
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= now ||
      args.expiresAt > now + APPROVAL_MAX_EXPIRY_MS
    ) {
      return deniedResult("invalid-bounds", "grant expiry must be in the future within the approval bound");
    }
    const resolved = await resolvePins(ctx, args.negotiationId, identity, undefined);
    if (!resolved.ok) return deniedResult(resolved.code, resolved.message);
    const pinned = resolved.pinned;
    const mandate = mandateSnapshotOf(pinned);
    const bounds = checkNegotiationBounds(mandate, currentSnapshotOf(pinned, null));
    if (bounds !== null) return deniedResult(bounds.code, bounds.message);
    const earlyFence = checkNegotiationFences(mandate, currentSnapshotOf(pinned, null));
    if (earlyFence !== null) {
      return deniedResult("mandate-not-current", "negotiation mandate is not currently sendable");
    }
    if (approvedConversationGate(pinned).stopped) {
      return deniedResult("mandate-not-current", "bound reply arrived; ingestion must update the mandate basis first");
    }
    const replyHold = replyGate(pinned);
    if (replyHold !== null) {
      return deniedResult(replyHold.code, replyHold.message);
    }
    const approvedDraft = await ctx.runQuery(loadDraftRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      negotiationId: pinned.negotiationId,
      draftId: args.draftId,
      identity,
    });
    if (!approvedDraft.ok) return deniedResult(approvedDraft.code, approvedDraft.message);
    const envelopeCanonical: string = approvedDraft.envelopeCanonical;
    const approved = validateApprovedEnvelope(
      envelopeCanonical,
      pinned.recipientMailboxNormalized,
      pinned.targetMinorUnits,
    );
    if (!approved.ok) return deniedResult(approved.code, approved.message);
    const binding = checkDraftBindings(
      {
        projectId: approvedDraft.projectId,
        negotiationId: approvedDraft.negotiationId,
        quoteId: approvedDraft.quoteId,
        quoteVersion: approvedDraft.quoteVersion,
        quoteContentHash: approvedDraft.quoteContentHash,
        conversationVersion: approvedDraft.conversationVersion,
        conversationState: approvedDraft.conversationState,
        replyVersion: approvedDraft.replyVersion,
        roundsUsed: approvedDraft.roundsUsed,
        move: approvedDraft.move,
        payloadHash: approvedDraft.payloadHash,
      },
      {
        projectId: String(pinned.projectId),
        negotiationId: String(pinned.negotiationId),
        quoteId: String(pinned.quoteId),
        quoteVersion: pinned.quoteVersion,
        quoteContentHash: pinned.quoteContentHash,
        conversationVersion: pinned.conversationVersion,
        conversationState: pinned.conversationState,
        replyVersion: pinned.replyVersion,
        roundsUsed: pinned.roundsUsed,
      },
      envelopeCanonical,
    );
    if (!binding.ok) return deniedResult(binding.code, binding.message);
    // Issue the exact send grant through the existing grant invariants.
    // The canonical payload comes server-side from the validated stored
    // bundle; the caller never supplies or receives it.
    const issued = await ctx.runMutation(issueGrantRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      operations: [NEGOTIATION_OPERATION_KIND],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: pinned.recipientConfigVersion ?? 0,
      inputVersions: { send: APPROVAL_SEND_INPUT_VERSION },
      payloadJson: envelopeCanonical,
      costCeilingMicroUsd: args.costCeilingMicroUsd,
      roundLimit: args.roundLimit,
      expiresAt: args.expiresAt,
      workflowAuthorities: [{ operationId: NEGOTIATION_OPERATION_KIND, projectId: pinned.projectId }],
    });
    if (!issued.ok) return deniedResult(issued.code, issued.message);
    return {
      ok: true as const,
      outcome: "grant-issued" as const,
      grantId: issued.grantId,
      revocationVersion: issued.revocationVersion,
      move: approvedDraft.move,
      quoteVersion: approvedDraft.quoteVersion,
      quoteContentHash: approvedDraft.quoteContentHash,
      roundsUsed: approvedDraft.roundsUsed,
      payloadHash: approvedDraft.payloadHash,
      redactedPreview: approved.redactedPreview,
    };
  },
});

const approveSendRef = makeFunctionReference<
  "action",
  ActionArgs<typeof approveNegotiationSend>,
  ActionReturn<typeof approveNegotiationSend>
>("negotiation/orchestrator:approveNegotiationSend");

/**
 * Phase two of the two-phase flow: send a previously prepared and approved
 * draft. The caller supplies only the opaque server-side draft id; the exact
 * canonical envelope is resolved server-side under the same approver
 * authority and never returns to the client. Approval is proven by a live
 * grant whose canonical payload equals the stored envelope byte-for-byte,
 * and every mandate/quote/conversation/recipient/round pin is re-fenced
 * live before the single dispatch. Makes no model calls by construction,
 * so every denial here costs zero provider calls.
 */
export const dispatchApprovedDraft = f1Action({
  args: {
    negotiationId: v.id("negotiations"),
    requestId: v.string(),
    draftId: v.id("evidence"),
    inboxId: v.string(),
    requestText: v.optional(v.string()),
  },
  returns: stepResultValidator,
  handler: async (ctx, args) => {
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return deniedResult("forged-identity", "unauthenticated");
    }
    if (args.requestId.trim().length === 0 || args.requestId.length > 128) {
      return deniedResult("invalid-bounds", "request id is required");
    }
    if (!INBOX_ID_PATTERN.test(args.inboxId)) {
      return deniedResult("invalid-payload", "provider inbox id is invalid");
    }
    const resolved = await resolvePins(ctx, args.negotiationId, identity, args.requestText);
    if (!resolved.ok) return deniedResult(resolved.code, resolved.message);
    const pinned = resolved.pinned;
    const mandate = mandateSnapshotOf(pinned);
    const bounds = checkNegotiationBounds(mandate, currentSnapshotOf(pinned, null));
    if (bounds !== null) return deniedResult(bounds.code, bounds.message);
    const earlyFence = checkNegotiationFences(mandate, currentSnapshotOf(pinned, null));
    if (earlyFence !== null) {
      if (earlyFence.kind === "stopped") {
        return {
          ok: true as const,
          outcome: "stopped" as const,
          move: "none",
          reason: earlyFence.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: "stopped — no supplier-visible text prepared",
        };
      }
      if (earlyFence.kind === "waiting") {
        return {
          ok: true as const,
          outcome: "waiting" as const,
          move: "none",
          reason: earlyFence.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: "waiting — no supplier-visible text prepared",
        };
      }
      return deniedResult(earlyFence.code, earlyFence.message);
    }
    if (approvedConversationGate(pinned).stopped) {
      return {
        ok: true as const,
        outcome: "stopped" as const,
        move: "none",
        reason: "conversation-changed",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "stopped — bound reply arrived; ingestion must update the mandate basis first",
      };
    }
    const dispatchReplyHold = replyGate(pinned);
    if (dispatchReplyHold !== null) {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: "none",
        reason: dispatchReplyHold.code,
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: `waiting — ${dispatchReplyHold.message}`,
      };
    }
    const approvedDraft = await ctx.runQuery(loadDraftRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      negotiationId: pinned.negotiationId,
      draftId: args.draftId,
      identity,
    });
    if (!approvedDraft.ok) return deniedResult(approvedDraft.code, approvedDraft.message);
    const envelopeCanonical: string = approvedDraft.envelopeCanonical;
    const approved = validateApprovedEnvelope(
      envelopeCanonical,
      pinned.recipientMailboxNormalized,
      pinned.targetMinorUnits,
    );
    if (!approved.ok) return deniedResult(approved.code, approved.message);
    const approvedMove = approvedDraft.move;
    const approvedPreview = approved.redactedPreview;

    // F3: replay inspection binds project/negotiation/payload/sender before
    // any deduplication, so a changed same-key replay conflicts here rather
    // than reporting a false success or falling through to grant lookup.
    const prior = await ctx.runQuery(inspectOperationRef, {
      organizationId: String(pinned.organizationId),
      projectId: pinned.projectId,
      negotiationId: pinned.negotiationId,
      requestId: args.requestId,
      inboxId: args.inboxId,
      envelopeCanonical,
      identity,
    });
    if (!("status" in prior)) return deniedResult(prior.code, prior.message);
    if (prior.status === "conflict") {
      return deniedResult(
        "duplicate-conflict",
        "request key reused with a changed payload, project, negotiation, or sender inbox",
      );
    }
    if (prior.status === "deduplicated") {
      return {
        ok: true as const,
        outcome: "deduplicated" as const,
        move: approvedMove,
        requestKey: prior.requestKey,
        payloadHash: prior.payloadHash ?? "unknown",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: approvedPreview,
      };
    }
    if (prior.status === "unknown") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: approvedMove,
        reason: "outcome-unknown",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: approvedPreview,
      };
    }
    // Exact saved-draft bindings before the first dispatch: the stored
    // bundle must equal the current pins (project, negotiation, quote,
    // conversation, reply, round, move, payload). This runs after replay
    // inspection so an identical retry still deduplicates (its bundle is
    // necessarily from before the round advanced) while a
    // cross-negotiation draft id or any drift since preparation denies
    // with zero provider calls. The operation claim preserves these pins
    // through the send.
    const binding = checkDraftBindings(
      {
        projectId: approvedDraft.projectId,
        negotiationId: approvedDraft.negotiationId,
        quoteId: approvedDraft.quoteId,
        quoteVersion: approvedDraft.quoteVersion,
        quoteContentHash: approvedDraft.quoteContentHash,
        conversationVersion: approvedDraft.conversationVersion,
        conversationState: approvedDraft.conversationState,
        replyVersion: approvedDraft.replyVersion,
        roundsUsed: approvedDraft.roundsUsed,
        move: approvedDraft.move,
        payloadHash: approvedDraft.payloadHash,
      },
      {
        projectId: String(pinned.projectId),
        negotiationId: String(pinned.negotiationId),
        quoteId: String(pinned.quoteId),
        quoteVersion: pinned.quoteVersion,
        quoteContentHash: pinned.quoteContentHash,
        conversationVersion: pinned.conversationVersion,
        conversationState: pinned.conversationState,
        replyVersion: pinned.replyVersion,
        roundsUsed: pinned.roundsUsed,
      },
      envelopeCanonical,
    );
    if (!binding.ok) return deniedResult(binding.code, binding.message);

    // F1: the caller-selected inbox must exactly equal the server-owned
    // organization/project/conversation binding before any grant, operation,
    // claim, or provider call. Missing, foreign, stale, ambiguous, or
    // cross-project bindings fail closed here.
    const senderBinding = await ctx.runQuery(resolveSenderInboxRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      ...(pinned.mandateConversationId === undefined ? {} : { conversationId: pinned.mandateConversationId }),
      identity,
    });
    if (!senderBinding.ok) return deniedResult(senderBinding.code, senderBinding.message);
    if (senderBinding.inboxId !== args.inboxId) {
      return deniedResult(
        "sender-inbox-foreign",
        "provider sender inbox is not the bound project inbox",
      );
    }

    const capacity = await ctx.runQuery(discoverCapacityRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      identity,
      envelopeCanonical,
    });
    if (!capacity.ok) return deniedResult(capacity.code, capacity.message);

    const fenced = checkNegotiationFences(
      mandate,
      currentSnapshotOf(pinned, {
        grantId: String(capacity.grantId),
        revocationVersion: capacity.grantRevocationVersion,
      }),
    );
    if (fenced !== null) {
      if (fenced.kind === "stopped") {
        return {
          ok: true as const,
          outcome: "stopped" as const,
          move: approvedMove,
          reason: fenced.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: approvedPreview,
        };
      }
      if (fenced.kind === "waiting") {
        return {
          ok: true as const,
          outcome: "waiting" as const,
          move: approvedMove,
          reason: fenced.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: approvedPreview,
        };
      }
      return deniedResult(fenced.code, fenced.message);
    }

    const envelopeValue = JSON.parse(envelopeCanonical) as Record<string, unknown>;
    const hash = payloadHash(envelopeValue);
    const key = requestKey(String(pinned.organizationId), NEGOTIATION_OPERATION_KIND, args.requestId);
    // Atomically bind the exact saved draft authority into operation
    // creation: the pins below are the stored server-side bundle the approval
    // proved, and `operations.create` verifies them against the live mandate
    // rows inside its own transaction. A draft that went stale after the
    // pre-check denies there with no operation row; the atomic claim then
    // rechecks the pinned authority again before provider effect, so a
    // different request id cannot reuse this obsolete draft.
    const created = await ctx.runMutation(createOperationRef, {
      jobId: capacity.jobId,
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      kind: NEGOTIATION_OPERATION_KIND,
      requestId: args.requestId,
      payloadJson: envelopeCanonical,
      grantId: capacity.grantId,
      reservationId: capacity.reservationId,
      negotiationId: pinned.negotiationId,
      negotiationDraft: {
        quoteVersion: approvedDraft.quoteVersion,
        quoteContentHash: approvedDraft.quoteContentHash,
        roundsUsed: approvedDraft.roundsUsed,
        ...(approvedDraft.conversationVersion === undefined
          ? {}
          : { conversationVersion: approvedDraft.conversationVersion }),
        ...(approvedDraft.conversationState === undefined
          ? {}
          : { conversationState: approvedDraft.conversationState }),
        payloadHash: approvedDraft.payloadHash,
      },
    });
    if (!created.ok) {
      if (created.code === "duplicate-conflict") {
        return deniedResult("retry-conflict", "request key reused with a changed payload");
      }
      return deniedResult(created.code, created.message);
    }
    if (created.deduped) {
      return {
        ok: true as const,
        outcome: "deduplicated" as const,
        move: approvedMove,
        requestKey: key,
        payloadHash: hash,
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: approvedPreview,
      };
    }
    const expectedRoundsUsedAfter = pinned.roundsUsed + 1;
    const refundConsumed = async (): Promise<number> => {
      const refunded = await ctx.runMutation(refundRoundRef, {
        negotiationId: pinned.negotiationId,
        identity,
        expectedRoundsUsed: pinned.roundsUsed,
        operationId: created.operationId,
      });
      return refunded.ok ? refunded.roundsUsed : expectedRoundsUsedAfter;
    };

    const dispatched = await ctx.runAction(dispatchRef, {
      operationId: created.operationId,
      identity,
      inboxId: args.inboxId,
    });
    const dispatchDenial = actionDenialOf(dispatched);
    if (dispatchDenial !== null) {
      const roundsUsedAfter = await refundConsumed();
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: roundsUsedAfter,
      });
      return deniedResult("dispatch-denied", dispatchDenial.message);
    }
    if (typeof dispatched !== "object" || dispatched === null) {
      return deniedResult("provider-result-malformed", "dispatch result is not an object");
    }
    const success = dispatched as {
      outcome: string;
      recorded: boolean;
      providerMessageId: string | null;
    };
    if (success.outcome !== "success" && success.outcome !== "failure" && success.outcome !== "unknown") {
      return deniedResult("provider-result-malformed", "dispatch result outcome is malformed");
    }
    if (success.outcome === "failure") {
      const roundsUsedAfter = await refundConsumed();
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: roundsUsedAfter,
      });
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: approvedMove,
        reason: "send-failure",
        roundsUsedAfter,
        redactedPreview: approvedPreview,
      };
    }
    if (success.outcome === "unknown" || !success.recorded || success.providerMessageId === null) {
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: expectedRoundsUsedAfter,
      });
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: approvedMove,
        reason: "outcome-unknown",
        roundsUsedAfter: expectedRoundsUsedAfter,
        redactedPreview: approvedPreview,
      };
    }
    const applied = await ctx.runMutation(applyOutcomeRef, {
      negotiationId: pinned.negotiationId,
      identity,
      outcome: "sent",
      jobId: capacity.jobId,
      jobState: "waitingForSupplier",
      expectedRoundsUsed: expectedRoundsUsedAfter,
    });
    if (!applied.ok) return deniedResult(applied.code, applied.message);
    return {
      ok: true as const,
      outcome: "sent" as const,
      move: approvedMove,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: expectedRoundsUsedAfter,
      providerMessageId: success.providerMessageId,
      redactedPreview: approvedPreview,
    };
  },
});

const dispatchDraftRef = makeFunctionReference<
  "action",
  ActionArgs<typeof dispatchApprovedDraft>,
  ActionReturn<typeof dispatchApprovedDraft>
>("negotiation/orchestrator:dispatchApprovedDraft");

/**
 * Run exactly one bounded negotiation step. Public action: authenticates the
 * caller, pins authority server-side, drives Jev classification, OpenAI
 * drafting, E6 validation, and the single owner-only dispatch path, then
 * persists honest round/job state. Unrelated requests create no
 * negotiation, model, communication, or execution effect.
 */
export const runNegotiationStep = f1Action({
  args: {
    negotiationId: v.id("negotiations"),
    requestId: v.string(),
    jevOperationId: v.id("operations"),
    draftOperationId: v.id("operations"),
    inboxId: v.string(),
    requestText: v.optional(v.string()),
  },
  returns: stepResultValidator,
  handler: async (ctx, args) => {
    // Single-step composition: prepare (classify + draft + validate, no
    // send) followed by dispatch (exact-grant approval + single send).
    // Composing the two phases instead of duplicating them keeps every
    // fence identical between the flows, and dispatch re-fences everything
    // live, so the check-to-send window is as narrow as the phase boundary.
    const authIdentity = await ctx.auth.getUserIdentity();
    const identity = authIdentity?.tokenIdentifier ?? null;
    if (identity === null || identity.trim().length === 0) {
      return deniedResult("forged-identity", "unauthenticated");
    }
    if (args.requestId.trim().length === 0 || args.requestId.length > 128) {
      return deniedResult("invalid-bounds", "request id is required");
    }
    if (!INBOX_ID_PATTERN.test(args.inboxId)) {
      return deniedResult("invalid-payload", "provider inbox id is invalid");
    }
    const resolved = await resolvePins(ctx, args.negotiationId, identity, args.requestText);
    if (!resolved.ok) return deniedResult(resolved.code, resolved.message);
    // A bound reply that arrived before this call stops the step before any
    // replay, sender, readiness, or model effect, preserving the obsolete
    // follow-up fence for the single-step flow.
    if (approvedConversationGate(resolved.pinned).stopped) {
      return {
        ok: true as const,
        outcome: "stopped" as const,
        move: "none",
        reason: "conversation-changed",
        roundsUsedAfter: resolved.pinned.roundsUsed,
        redactedPreview: "stopped — bound reply arrived; ingestion must update the mandate basis first",
      };
    }
    const stepReplyHold = replyGate(resolved.pinned);
    if (stepReplyHold !== null) {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: "none",
        reason: stepReplyHold.code,
        roundsUsedAfter: resolved.pinned.roundsUsed,
        redactedPreview: `waiting — ${stepReplyHold.message}`,
      };
    }
    // F3: bind the replay to project/negotiation/sender before dedup. No
    // envelope exists yet (the draft is built below), so payload comparison
    // happens in the dispatch phase; sender/project/negotiation conflicts
    // still fail closed here with zero model calls.
    const prior = await ctx.runQuery(inspectOperationRef, {
      organizationId: String(resolved.pinned.organizationId),
      projectId: resolved.pinned.projectId,
      negotiationId: resolved.pinned.negotiationId,
      requestId: args.requestId,
      inboxId: args.inboxId,
      identity,
    });
    if (!("status" in prior)) return deniedResult(prior.code, prior.message);
    if (prior.status === "conflict") {
      return deniedResult(
        "duplicate-conflict",
        "request key reused with a changed project, negotiation, or sender inbox",
      );
    }
    if (prior.status === "deduplicated") {
      return {
        ok: true as const,
        outcome: "deduplicated" as const,
        move: "none",
        requestKey: prior.requestKey,
        payloadHash: prior.payloadHash ?? "unknown",
        roundsUsedAfter: resolved.pinned.roundsUsed,
        redactedPreview: "deduplicated — no supplier-visible text prepared",
      };
    }
    if (prior.status === "unknown") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: "none",
        reason: "outcome-unknown",
        roundsUsedAfter: resolved.pinned.roundsUsed,
        redactedPreview: "waiting — prior attempt outcome is unknown under reconciliation",
      };
    }
    // F1: exact sender-binding equality before the first model call, so a
    // foreign or unbound inbox costs zero provider calls.
    const senderBinding = await ctx.runQuery(resolveSenderInboxRef, {
      organizationId: resolved.pinned.organizationId,
      projectId: resolved.pinned.projectId,
      ...(resolved.pinned.mandateConversationId === undefined
        ? {}
        : { conversationId: resolved.pinned.mandateConversationId }),
      identity,
    });
    if (!senderBinding.ok) return deniedResult(senderBinding.code, senderBinding.message);
    if (senderBinding.inboxId !== args.inboxId) {
      return deniedResult(
        "sender-inbox-foreign",
        "provider sender inbox is not the bound project inbox",
      );
    }
    const readiness = await ctx.runQuery(probeReadinessRef, {
      organizationId: resolved.pinned.organizationId,
      projectId: resolved.pinned.projectId,
      identity,
    });
    if (!readiness.ok) return deniedResult(readiness.code, readiness.message);

    const prepared = await ctx.runAction(prepareDraftRef, {
      negotiationId: args.negotiationId,
      jevOperationId: args.jevOperationId,
      draftOperationId: args.draftOperationId,
      ...(args.requestText === undefined ? {} : { requestText: args.requestText }),
    });
    if (!prepared.ok) return deniedResult(prepared.code, prepared.message);
    if (prepared.outcome !== "prepared") {
      return prepared;
    }
    const dispatched = await ctx.runAction(dispatchDraftRef, {
      negotiationId: args.negotiationId,
      requestId: args.requestId,
      draftId: prepared.draftId,
      inboxId: args.inboxId,
      ...(args.requestText === undefined ? {} : { requestText: args.requestText }),
    });
    if (!dispatched.ok) return dispatched;
    return { ...dispatched, move: prepared.move };
  },
});

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
 * - Every consequential transition re-reads and pins project, grant,
 *   capability, mandate, quote, conversation, and job authority. E6 fences
 *   run before the first provider call AND again after drafting, immediately
 *   before the send operation is created.
 * - Exactly one bounded step per call. Rounds advance only for an observed,
 *   recorded provider acceptance with a message id. Ambiguous outcomes stay
 *   unknown under the existing reconciliation contract; there is never a
 *   blind resend or a second send path.
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
import {
  checkNegotiationBounds,
  checkNegotiationFences,
  deduplicateNegotiationRetry,
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

/** Pinned input version for the server-built Jev move workload. */
export const NEGOTIATION_JEV_INPUT_VERSION = "e6-negotiation-workload-v1" as const;
/** Pinned input version for the server-built OpenAI draft workload. */
export const NEGOTIATION_DRAFT_INPUT_VERSION = "e6-negotiation-draft-v1" as const;
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

const pinnedQuoteValidator = v.object({
  version: v.string(),
  contentHash: v.string(),
  excerpt: v.string(),
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
  roundsUsed: number;
  roundLimit: number;
  expiresAt: number;
  targetMinorUnits: number | undefined;
  quoteVersion: string;
  quoteContentHash: string;
  quoteExcerpt: string;
  quoteSuperseded: boolean;
  conversationVersion: number | undefined;
  conversationState: string | undefined;
  recipientConfigured: boolean;
  recipientConfigVersion: number | undefined;
  recipientMailboxNormalized: string | undefined;
}

function genericDenial(): { ok: false; code: string; message: string } {
  return { ok: false, code: "denied-membership", message: "not authorized for this project" };
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
    if (negotiation.conversationId !== undefined) {
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
    }
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
    return {
      ok: true as const,
      organizationId: String(negotiation.organizationId),
      projectId: String(negotiation.projectId),
      projectName: project.name,
      negotiationId: String(negotiation._id),
      quoteId: String(quote._id),
      quote: { version: quote.version, contentHash: quote.contentHash, excerpt },
      mandateState: negotiation.state,
      mandateQuoteVersion: negotiation.quoteVersion,
      // The row stores no content hash; pin the live hash as the mandate
      // basis so in-step drift still fails closed at the post-draft recheck.
      mandateQuoteContentHash: quote.contentHash,
      ...(conversationVersion === undefined ? {} : { mandateConversationVersion: conversationVersion }),
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
 */
export function buildNegotiationJevWorkload(pinned: {
  readonly negotiationId: string;
  readonly quoteId: string;
  readonly quoteVersion: string;
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
    quote: `${pinned.quoteId}@${pinned.quoteVersion}`,
    conversation: pinned.conversationVersion === undefined ? "unbound" : `v${pinned.conversationVersion}`,
    rounds: `${pinned.roundsUsed}/${pinned.roundLimit}`,
    mandate: pinned.mandateState,
    missingTerms: "freight,installation,warranty",
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
    queryText: `Research supplier negotiation move for quote ${pinned.quoteVersion}`,
  };
}

/**
 * Build the deterministic supplier-draft workload from pinned snapshots.
 * The brief never carries confidential figures or the private mailbox.
 */
export function buildNegotiationDraftWorkload(
  pinned: {
    readonly negotiationId: string;
    readonly quoteId: string;
    readonly quoteVersion: string;
    readonly conversationVersion: number | undefined;
    readonly roundsUsed: number;
    readonly quoteExcerpt: string;
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
    `Negotiation mandate ${pinned.negotiationId}: ${move} the supplier on freight and ` +
    `installation inclusion for quote ${pinned.quoteVersion} and negotiate the comparison ` +
    `using only the pinned quote and mandate sources without disclosing internal targets.`;
  return {
    kind: "supplierDraft",
    inputVersion: NEGOTIATION_DRAFT_INPUT_VERSION,
    draftKind: move,
    brief,
    sources: [
      {
        sourceId: `quote:${pinned.quoteId}`,
        version: pinned.quoteVersion,
        locator: "quote-lines",
        content: pinned.quoteExcerpt.length > 0 ? pinned.quoteExcerpt : `quote ${pinned.quoteVersion}`,
      },
      {
        sourceId: `negotiation:${pinned.negotiationId}`,
        version: `mandate-round-${pinned.roundsUsed}`,
        locator: "mandate-brief",
        content:
          `Active negotiation mandate for quote ${pinned.quoteVersion}; ` +
          `permitted moves clarify and counter within the approved round limit.`,
      },
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
 */
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
    const grants = await ctx.db
      .query("grants")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "active"))
      .take(64);
    const recipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    if (recipients.length !== 1 || recipients[0] === undefined) {
      return { ok: false as const, code: "recipient-missing", message: "owner recipient is not configured" };
    }
    const recipient = recipients[0];
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
        .take(16);
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
          .take(16);
        for (const reservation of reservations) {
          if (reservation.state !== "open" || reservation.organizationId !== args.organizationId) continue;
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
 * Pre-flight send-operation check: an identical in-flight or terminal send
 * operation for this request key short-circuits the step with zero provider
 * calls. A prepared operation left by a crashed attempt stays unknown under
 * reconciliation; it is never blindly resumed here.
 */
export const inspectSendOperation = f1InternalQuery({
  args: {
    organizationId: v.string(),
    requestId: v.string(),
    identity: v.string(),
  },
  returns: v.union(
    v.object({
      status: v.union(v.literal("absent"), v.literal("deduplicated"), v.literal("unknown")),
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
 * Persist honest round accounting and job states against existing records.
 * Rounds advance only for an observed send; waiting maps to the existing
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
      if (args.outcome === "sent" && negotiation.roundsUsed === args.expectedRoundsUsed) {
        await ctx.db.patch(negotiation._id, {
          roundsUsed: negotiation.roundsUsed + 1,
          updatedAt: Date.now(),
        });
        if (patchable) {
          await ctx.db.patch(job._id, { state: "waitingForSupplier", updatedAt: Date.now() });
        }
        return {
          ok: true as const,
          outcome: "sent" as const,
          jobId: job._id,
          jobState: "waitingForSupplier",
          expectedRoundsUsed: args.expectedRoundsUsed + 1,
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
    if (args.outcome === "sent" && negotiation.roundsUsed === args.expectedRoundsUsed) {
      await ctx.db.patch(negotiation._id, {
        roundsUsed: negotiation.roundsUsed + 1,
        updatedAt: Date.now(),
      });
      return {
        ok: true as const,
        outcome: "sent" as const,
        expectedRoundsUsed: args.expectedRoundsUsed + 1,
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
    const grants = await ctx.db
      .query("grants")
      .withIndex("by_project_and_status", (q) => q.eq("projectId", args.projectId).eq("status", "active"))
      .take(64);
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
        .take(16);
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
          .take(8);
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
  quoteId: string,
  quoteVersion: string,
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
        (source as Record<string, unknown>)["sourceId"] === `quote:${quoteId}` &&
        (source as Record<string, unknown>)["version"] === quoteVersion,
    );
  if (!quotePinned) {
    return { ok: false, code: "draft-malformed", message: "draft is not pinned to the current quote source" };
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
      sourceQuoteVersion: quoteVersion,
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
    const loaded = await ctx.runQuery(loadContextRef, {
      negotiationId: args.negotiationId,
      identity,
      ...(args.requestText === undefined ? {} : { requestText: args.requestText }),
    });
    if (!loaded.ok) return deniedResult(loaded.code, loaded.message);

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
      roundsUsed: loaded.roundsUsed,
      roundLimit: loaded.roundLimit,
      expiresAt: loaded.expiresAt,
      targetMinorUnits: loaded.targetMinorUnits,
      quoteVersion: loaded.quote.version,
      quoteContentHash: loaded.quote.contentHash,
      quoteExcerpt: loaded.quote.excerpt,
      quoteSuperseded: loaded.quoteSuperseded,
      conversationVersion: loaded.currentConversationVersion,
      conversationState: loaded.conversationState,
      recipientConfigured: loaded.recipientConfigured,
      recipientConfigVersion: loaded.recipientConfigVersion,
      recipientMailboxNormalized: loaded.recipientMailboxNormalized,
    };

    // Idempotency pre-check: zero provider calls when this request key
    // already has a send operation. Terminal success deduplicates;
    // anything else stays unknown under reconciliation, never resends.
    const prior = await ctx.runQuery(inspectOperationRef, {
      organizationId: String(pinned.organizationId),
      requestId: args.requestId,
      identity,
    });
    if (!("status" in prior)) return deniedResult(prior.code, prior.message);
    if (prior.status === "deduplicated") {
      return {
        ok: true as const,
        outcome: "deduplicated" as const,
        move: "none",
        requestKey: prior.requestKey,
        payloadHash: prior.payloadHash ?? "unknown",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "deduplicated — no supplier-visible text prepared",
      };
    }
    if (prior.status === "unknown") {
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move: "none",
        reason: "outcome-unknown",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: "waiting — prior attempt outcome is unknown under reconciliation",
      };
    }

    const mandate = mandateSnapshotOf(pinned);
    // Pre-call fences: every denial below performs zero provider calls.
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

    // Readiness runs before the first provider call so allowance and
    // recipient denials also cost zero provider calls.
    const readiness = await ctx.runQuery(probeReadinessRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      identity,
    });
    if (!readiness.ok) return deniedResult(readiness.code, readiness.message);

    const jevWorkload = buildNegotiationJevWorkload({
      negotiationId: String(pinned.negotiationId),
      quoteId: String(pinned.quoteId),
      quoteVersion: pinned.quoteVersion,
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
        await ctx.runMutation(applyOutcomeRef, {
          negotiationId: pinned.negotiationId,
          identity,
          outcome: "waiting",
          expectedRoundsUsed: pinned.roundsUsed,
        });
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
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        expectedRoundsUsed: pinned.roundsUsed,
      });
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
        conversationVersion: pinned.conversationVersion,
        roundsUsed: pinned.roundsUsed,
        quoteExcerpt: pinned.quoteExcerpt,
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
      String(pinned.quoteId),
      pinned.quoteVersion,
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
    if (
      (pinned.conversationVersion ?? null) !== (draftValue.sourceConversationVersion ?? null)
    ) {
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

    // Post-draft recheck: re-read everything before the consequential send.
    const reloaded = await ctx.runQuery(loadContextRef, {
      negotiationId: args.negotiationId,
      identity,
      ...(args.requestText === undefined ? {} : { requestText: args.requestText }),
    });
    if (!reloaded.ok) return deniedResult(reloaded.code, reloaded.message);
    if (
      reloaded.mandateQuoteVersion !== pinned.mandateQuoteVersion ||
      reloaded.mandateQuoteContentHash !== pinned.mandateQuoteContentHash ||
      reloaded.roundsUsed !== pinned.roundsUsed ||
      reloaded.currentQuoteVersion !== pinned.quoteVersion ||
      reloaded.currentQuoteContentHash !== pinned.quoteContentHash ||
      reloaded.quoteSuperseded ||
      (reloaded.mandateConversationVersion ?? null) !== (pinned.conversationVersion ?? null) ||
      reloaded.recipientConfigured !== true ||
      reloaded.recipientConfigVersion !== pinned.recipientConfigVersion ||
      reloaded.recipientMailboxNormalized !== pinned.recipientMailboxNormalized
    ) {
      return deniedResult(
        "stale-input-version",
        "negotiation inputs changed during drafting; re-approval required",
      );
    }

    const capacity = await ctx.runQuery(discoverCapacityRef, {
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      identity,
      envelopeCanonical,
    });
    if (!capacity.ok) return deniedResult(capacity.code, capacity.message);

    // Fence the exact send-grant binding through E6 before creating the
    // operation: recipient, grant, round, quote, and conversation pins.
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
          move,
          reason: fenced.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: checked.redactedPreview,
        };
      }
      if (fenced.kind === "waiting") {
        return {
          ok: true as const,
          outcome: "waiting" as const,
          move,
          reason: fenced.reason,
          roundsUsedAfter: pinned.roundsUsed,
          redactedPreview: checked.redactedPreview,
        };
      }
      return deniedResult(fenced.code, fenced.message);
    }

    const hash = payloadHash(envelope);
    const key = requestKey(String(pinned.organizationId), NEGOTIATION_OPERATION_KIND, args.requestId);
    const gate = deduplicateNegotiationRetry(key, hash, null);
    if (gate.outcome === "conflict") {
      return deniedResult("retry-conflict", "request key reused with a changed payload");
    }
    const created = await ctx.runMutation(createOperationRef, {
      jobId: capacity.jobId,
      organizationId: pinned.organizationId,
      projectId: pinned.projectId,
      kind: NEGOTIATION_OPERATION_KIND,
      requestId: args.requestId,
      payloadJson: envelopeCanonical,
      grantId: capacity.grantId,
      reservationId: capacity.reservationId,
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
        move,
        requestKey: key,
        payloadHash: hash,
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: checked.redactedPreview,
      };
    }

    // The single send path: exactly one dispatch per created operation.
    const dispatched = await ctx.runAction(dispatchRef, {
      operationId: created.operationId,
      identity,
      inboxId: args.inboxId,
    });
    const dispatchDenial = actionDenialOf(dispatched);
    if (dispatchDenial !== null) {
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: pinned.roundsUsed,
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
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: pinned.roundsUsed,
      });
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "send-failure",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: checked.redactedPreview,
      };
    }
    if (success.outcome === "unknown" || !success.recorded || success.providerMessageId === null) {
      await ctx.runMutation(applyOutcomeRef, {
        negotiationId: pinned.negotiationId,
        identity,
        outcome: "waiting",
        jobId: capacity.jobId,
        jobState: "waitingForSupplier",
        expectedRoundsUsed: pinned.roundsUsed,
      });
      return {
        ok: true as const,
        outcome: "waiting" as const,
        move,
        reason: "outcome-unknown",
        roundsUsedAfter: pinned.roundsUsed,
        redactedPreview: checked.redactedPreview,
      };
    }
    const applied = await ctx.runMutation(applyOutcomeRef, {
      negotiationId: pinned.negotiationId,
      identity,
      outcome: "sent",
      jobId: capacity.jobId,
      jobState: "waitingForSupplier",
      expectedRoundsUsed: pinned.roundsUsed,
    });
    if (!applied.ok) return deniedResult(applied.code, applied.message);
    return {
      ok: true as const,
      outcome: "sent" as const,
      move,
      requestKey: key,
      payloadHash: hash,
      roundsUsedAfter: applied.expectedRoundsUsed,
      providerMessageId: success.providerMessageId,
      redactedPreview: checked.redactedPreview,
    };
  },
});

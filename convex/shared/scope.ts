/**
 * F1 capability catalog and OpeningOS workflow-purpose classification
 * (controlled contract, ADR-0007 / D-17).
 *
 * Backend code is authoritative: the UI and Jev classifier cannot grant
 * authority, supplier evidence cannot expand capabilities, and unknown
 * operations are denied even when a model is confident.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";

export const CAPABILITY_CATALOG_VERSION = "capability-catalog-1" as const;

/**
 * A job is admitted only for one of these shipped OpeningOS workflows.  The
 * catalog answers whether an operation is enabled; this contract answers
 * whether the operation belongs to the product's purchasing workflow.
 */
export const WORKFLOW_PURPOSE_CONTRACT_VERSION = "openingos-purchasing-1" as const;

export type WorkflowPurpose = "purchasingResearch" | "purchasingCommunication";

/**
 * Project context is assembled from server-owned project records.  `terms`
 * are bounded requirement/project vocabulary, never caller-provided authority.
 */
export interface ProjectWorkflowContext {
  readonly organizationId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly terms?: readonly string[];
  readonly hasStructuredContext?: boolean;
  /** A server-owned, non-cancelled purchasing conversation exists. */
  readonly hasPurchasingThread?: boolean;
  /** Present only when one exact active purchasing conversation is found. */
  readonly purchasingConversationId?: Id<"conversations">;
  /** Present only when one exact requirement term matches the request. */
  readonly matchedRequirementId?: Id<"requirements">;
}

/**
 * A workflow authority names the server-owned records that make an operation
 * meaningful. Project scope is valid for a new research/RFQ brief; a
 * requirement, candidate, or conversation ref narrows the same operation to
 * an exact durable record. The operation discriminator prevents a ref for
 * one workflow from laundering authority into another.
 */
export type WorkflowAuthority =
  | {
      readonly operationId: "research.collect";
      readonly projectId: Id<"projects">;
      readonly requirementId?: Id<"requirements">;
    }
  | {
      readonly operationId: "research.read";
      readonly projectId: Id<"projects">;
      readonly requirementId?: Id<"requirements">;
      readonly candidateId?: Id<"candidates">;
    }
  | {
      readonly operationId: "evidence.record";
      readonly projectId: Id<"projects">;
      readonly requirementId?: Id<"requirements">;
      readonly candidateId?: Id<"candidates">;
    }
  | {
      readonly operationId: "quote.record";
      readonly projectId: Id<"projects">;
      readonly requirementId?: Id<"requirements">;
      readonly candidateId?: Id<"candidates">;
    }
  | {
      readonly operationId: "comparison.read";
      readonly projectId: Id<"projects">;
      readonly requirementId?: Id<"requirements">;
      readonly candidateId?: Id<"candidates">;
    }
  | {
      readonly operationId: "communication.send";
      readonly projectId: Id<"projects">;
      readonly conversationId?: Id<"conversations">;
    }
  | {
      readonly operationId: "communication.clarify";
      readonly projectId: Id<"projects">;
      readonly conversationId?: Id<"conversations">;
    };

export const workflowAuthorityValidator = v.union(
  v.object({
    operationId: v.literal("research.collect"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
  }),
  v.object({
    operationId: v.literal("research.read"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
    candidateId: v.optional(v.id("candidates")),
  }),
  v.object({
    operationId: v.literal("evidence.record"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
    candidateId: v.optional(v.id("candidates")),
  }),
  v.object({
    operationId: v.literal("quote.record"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
    candidateId: v.optional(v.id("candidates")),
  }),
  v.object({
    operationId: v.literal("comparison.read"),
    projectId: v.id("projects"),
    requirementId: v.optional(v.id("requirements")),
    candidateId: v.optional(v.id("candidates")),
  }),
  v.object({
    operationId: v.literal("communication.send"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
  }),
  v.object({
    operationId: v.literal("communication.clarify"),
    projectId: v.id("projects"),
    conversationId: v.optional(v.id("conversations")),
  }),
);

export const workflowAuthoritiesValidator = v.array(workflowAuthorityValidator);

export function defaultWorkflowAuthority(
  operationId: string,
  projectId: Id<"projects">,
): WorkflowAuthority | null {
  switch (operationId) {
    case "research.collect":
      return { operationId, projectId };
    case "research.read":
      return { operationId, projectId };
    case "evidence.record":
      return { operationId, projectId };
    case "quote.record":
      return { operationId, projectId };
    case "comparison.read":
      return { operationId, projectId };
    case "communication.send":
      return { operationId, projectId };
    case "communication.clarify":
      return { operationId, projectId };
    default:
      return null;
  }
}

export function workflowAuthorityForOperation(
  authorities: readonly WorkflowAuthority[] | undefined,
  operationId: string,
): WorkflowAuthority | null {
  const matches = authorities?.filter((authority) => authority.operationId === operationId) ?? [];
  return matches.length === 1 && matches[0] !== undefined ? matches[0] : null;
}

export function workflowAuthorityMatchesProject(
  authority: WorkflowAuthority | null,
  operationId: string,
  projectId: Id<"projects">,
): boolean {
  return authority !== null && authority.operationId === operationId && authority.projectId === projectId;
}

/**
 * Explicit admission limits keep grant-wide accounting and cancellation
 * finite.  These values are intentionally conservative: ordinary grants use
 * a much smaller round limit, while the bounds also protect legacy rows that
 * predate this contract.
 */
export const MAX_JOBS_PER_GRANT = 64 as const;
export const MAX_OPERATIONS_PER_GRANT = 64 as const;
export const MAX_OPERATIONS_PER_JOB = 64 as const;
export const MAX_RESERVATIONS_PER_JOB = 64 as const;

export type EffectClass =
  | "read"
  | "recordChange"
  | "externalCommunication"
  | "disclosure"
  | "bindingCommitment"
  | "permissionChange";

export interface CapabilityEntry {
  readonly operationId: string;
  readonly effect: EffectClass;
  readonly requiredRole: "viewer" | "contributor" | "approver" | "owner";
  readonly allowedTools: readonly string[];
  readonly enabled: boolean;
  readonly description: string;
}

/**
 * Hackathon catalog. No binding purchase, payment, financing,
 * contract-signing, or service-booking operation exists here; any such
 * request is denied as an unknown/unavailable operation.
 */
const ENTRIES: readonly CapabilityEntry[] = Object.freeze([
  Object.freeze({
    operationId: "research.collect",
    effect: "read",
    requiredRole: "contributor",
    allowedTools: ["firecrawlSearch", "firecrawlScrape", "readEvidence"],
    enabled: true,
    description: "Bounded public-source collection within the job allowance",
  }),
  Object.freeze({
    operationId: "research.read",
    effect: "read",
    requiredRole: "viewer",
    allowedTools: ["readEvidence"],
    enabled: true,
    description: "Read authorized research progress and evidence summaries",
  }),
  Object.freeze({
    operationId: "evidence.record",
    effect: "recordChange",
    requiredRole: "contributor",
    allowedTools: ["recordEvidence"],
    enabled: true,
    description: "Record source-backed evidence snapshots",
  }),
  Object.freeze({
    operationId: "quote.record",
    effect: "recordChange",
    requiredRole: "contributor",
    allowedTools: ["recordQuote"],
    enabled: true,
    description: "Record an immutable quote version from bound evidence",
  }),
  Object.freeze({
    operationId: "comparison.read",
    effect: "read",
    requiredRole: "viewer",
    allowedTools: ["compareOffers"],
    enabled: true,
    description: "Compare exact quote versions on equivalent scope",
  }),
  Object.freeze({
    operationId: "communication.send",
    effect: "externalCommunication",
    requiredRole: "approver",
    allowedTools: ["agentMailSend"],
    enabled: true,
    description: "Owner-only RFQ/clarification send under a current grant",
  }),
  Object.freeze({
    operationId: "communication.clarify",
    effect: "externalCommunication",
    requiredRole: "approver",
    allowedTools: ["agentMailSend"],
    enabled: true,
    description: "Covered clarification within the approved brief",
  }),
  Object.freeze({
    operationId: "job.start",
    effect: "recordChange",
    requiredRole: "contributor",
    allowedTools: ["startJob"],
    enabled: true,
    description: "Start a bounded job under a current grant",
  }),
  Object.freeze({
    operationId: "job.cancel",
    effect: "recordChange",
    requiredRole: "contributor",
    allowedTools: ["cancelJob"],
    enabled: true,
    description: "Cancel own authorized job; in-flight effects reconcile",
  }),
  Object.freeze({
    operationId: "job.read",
    effect: "read",
    requiredRole: "viewer",
    allowedTools: ["readJob"],
    enabled: true,
    description: "Read authorized job state",
  }),
  Object.freeze({
    operationId: "reservation.create",
    effect: "recordChange",
    requiredRole: "contributor",
    allowedTools: ["reserveBudget"],
    enabled: true,
    description: "Reserve shared provider budget before dispatch",
  }),
]);

const BY_ID: ReadonlyMap<string, CapabilityEntry> = new Map(
  ENTRIES.map((entry) => [entry.operationId, entry] as const),
);

export function catalogEntries(): readonly CapabilityEntry[] {
  return ENTRIES;
}

export function lookupCapability(operationId: string): CapabilityEntry | undefined {
  return BY_ID.get(operationId);
}

const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  contributor: 1,
  approver: 2,
  owner: 3,
};

export function roleSatisfies(actual: string, required: CapabilityEntry["requiredRole"]): boolean {
  const left = ROLE_RANK[actual] ?? -1;
  const right = ROLE_RANK[required] ?? 99;
  return left >= right;
}

export type ScopeVerdict =
  | {
      readonly verdict: "supported";
      readonly operationId: string;
      readonly purpose: WorkflowPurpose;
    }
  | { readonly verdict: "unrelatedRefused"; readonly reason: string }
  | { readonly verdict: "unavailableRefused"; readonly reason: string };

/**
 * Stable purchasing-intent anchors.  This is deliberately not a vocabulary
 * of every word that appeared in a fixture.  Unknown product names can be
 * carried by a request that already has one of these structural anchors, but
 * unknown wording cannot establish authority on its own.
 */
const PURCHASING_INTENT_ANCHORS: ReadonlySet<string> = new Set([
  "budget",
  "compare",
  "comparison",
  "cost",
  "delivery",
  "equipment",
  "freight",
  "install",
  "installation",
  "item",
  "items",
  "machine",
  "order",
  "price",
  "pricing",
  "product",
  "products",
  "procure",
  "procurement",
  "purchase",
  "purchasing",
  "quote",
  "quotes",
  "replacement",
  "supplier",
  "suppliers",
  "utilities",
  "utility",
  "vendor",
  "vendors",
  "warranty",
]);

const COMMUNICATION_ANCHORS: ReadonlySet<string> = new Set([
  "clarification",
  "clarify",
  "counter",
  "counteroffer",
  "negotiate",
  "negotiation",
  "rfq",
]);

/**
 * Cues for a follow-up to an already structured project.  Question words by
 * themselves are intentionally absent: "what is the weather" must not gain
 * authority merely because a project exists.
 */
const CONTEXTUAL_FOLLOW_UP_CUES: ReadonlySet<string> = new Set([
  "again",
  "back",
  "change",
  "changes",
  "choose",
  "current",
  "latest",
  "more",
  "next",
  "option",
  "options",
  "progress",
  "status",
  "still",
]);

/**
 * A cue that changes or asks for project progress, paired with an anaphoric
 * reference, can establish a short follow-up without repeating the product
 * name.  One generic cue alone is never enough: a structured project must
 * either be named by a server-owned term or be referenced coherently.
 */
const CONTEXTUAL_REFERENCE_CUES: ReadonlySet<string> = new Set([
  "another",
  "choose",
  "chosen",
  "it",
  "same",
  "that",
  "them",
  "they",
]);

const CONTEXTUAL_PROGRESS_CUES: ReadonlySet<string> = new Set([
  "again",
  "back",
  "change",
  "changes",
  "current",
  "latest",
  "more",
  "next",
  "progress",
  "status",
  "still",
]);

const CONTEXTUAL_OPTION_CUES: ReadonlySet<string> = new Set(["option", "options"]);

const CONTEXTUAL_ANAPHORIC_GRAMMAR: ReadonlySet<string> = new Set([
  ...CONTEXTUAL_PROGRESS_CUES,
  ...CONTEXTUAL_REFERENCE_CUES,
  ...CONTEXTUAL_OPTION_CUES,
]);

const RESEARCH_ANCHORS = PURCHASING_INTENT_ANCHORS;

/**
 * Supplier-record nouns a purchasing read or comparison question names.
 * Generic commercial nouns such as "price", "stock", or "budget" are
 * intentionally absent: those words can appear in an unrelated question and
 * cannot establish read authority on their own.
 */
const PURCHASING_READ_RECORD_ANCHORS: ReadonlySet<string> = new Set([
  "candidate",
  "candidates",
  "evidence",
  "offer",
  "offers",
  "quote",
  "quotes",
  "rfq",
  "supplier",
  "suppliers",
  "vendor",
  "vendors",
]);

/**
 * Progress, comparison, and listing cues. They stay weaker than the data
 * anchors: a cue authorizes a read only beside a matching server-owned
 * project term, so a generic "what is the latest" or an unrelated
 * "lakers vs celtics" cannot reach project records.
 */
const PURCHASING_READ_STATE_CUES: ReadonlySet<string> = new Set([
  "cheap",
  "cheaper",
  "cheapest",
  "compare",
  "comparison",
  "current",
  "difference",
  "differences",
  "equivalent",
  "expensive",
  "findings",
  "latest",
  "list",
  "listed",
  "option",
  "options",
  "outstanding",
  "pending",
  "progress",
  "read",
  "results",
  "review",
  "show",
  "status",
  "summarize",
  "summary",
  "versus",
  "vs",
]);

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "for",
  "from",
  "how",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "please",
  "the",
  "these",
  "this",
  "to",
  "two",
  "what",
  "when",
  "which",
  "with",
  "we",
  "why",
  "who",
  "would",
]);

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function contextTokens(context: ProjectWorkflowContext | undefined): ReadonlySet<string> {
  // Project names are labels, not workflow authority. Only requirement
  // terms that were loaded from server-owned records may participate in a
  // contextual follow-up.
  const values = [...(context?.terms ?? [])];
  return new Set(values.flatMap((value) => tokenize(value)));
}

function meaningfulTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

function hasResearchAnchor(tokens: readonly string[]): boolean {
  return tokens.some((token) => RESEARCH_ANCHORS.has(token));
}

function hasCommunicationAnchor(
  tokens: readonly string[],
  context?: ProjectWorkflowContext,
): boolean {
  // A reply is meaningful only inside a server-owned purchasing thread. A
  // caller cannot turn the generic word "reply" into outbound authority.
  if (tokens.includes("reply")) return context?.hasPurchasingThread === true;
  if (tokens.some((token) => COMMUNICATION_ANCHORS.has(token))) return true;
  return (
    tokens.includes("send") &&
    tokens.some((token) =>
      token === "quote" ||
      token === "rfq" ||
      token === "supplier" ||
      token === "suppliers" ||
      token === "vendor" ||
      token === "vendors",
    )
  );
}

function hasContextualCue(tokens: readonly string[]): boolean {
  return tokens.some((token) => CONTEXTUAL_FOLLOW_UP_CUES.has(token));
}

function hasContextualFollowUp(
  tokens: readonly string[],
  context: ReadonlySet<string>,
  hasStructuredContext: boolean,
): boolean {
  if (!hasStructuredContext || context.size === 0) return false;
  const hasServerOwnedTerm = tokens.some((token) => context.has(token));
  if (hasServerOwnedTerm && hasContextualCue(tokens)) return true;

  // Preserve concise anaphoric follow-ups such as "What changes if they
  // choose another option?" while rejecting a generic "what is the latest"
  // or an unrelated topic that happens to contain "changes".
  return (
    tokens.some((token) => CONTEXTUAL_PROGRESS_CUES.has(token)) &&
    tokens.some((token) => CONTEXTUAL_REFERENCE_CUES.has(token)) &&
    tokens.some((token) => CONTEXTUAL_OPTION_CUES.has(token)) &&
    tokens.every(
      (token) => CONTEXTUAL_ANAPHORIC_GRAMMAR.has(token) || context.has(token),
    )
  );
}

function hasMixedUnsupportedClause(input: {
  readonly text: string;
  readonly context: ReadonlySet<string>;
  readonly purpose: WorkflowPurpose;
  readonly hasStructuredContext: boolean;
}): boolean {
  const clauses = input.text
    .toLocaleLowerCase()
    .split(/\band\b|\bbut\b|[.!?;]|\n/)
    .map((clause) => meaningfulTokens(tokenize(clause)))
    .filter((clause) => clause.length > 0);
  if (clauses.length < 2) return false;
  return clauses.some((clause) => {
    const hasPurposeAnchor =
      input.purpose === "purchasingCommunication"
        ? hasCommunicationAnchor(clause)
        : hasResearchAnchor(clause);
    const hasContextualReference =
      input.hasStructuredContext &&
      input.context.size > 0 &&
      hasContextualFollowUp(clause, input.context, input.hasStructuredContext);
    return !hasPurposeAnchor && !hasContextualReference;
  });
}

function allowedWorkflowText(input: {
  readonly text: string;
  readonly purpose: WorkflowPurpose;
  readonly context?: ProjectWorkflowContext;
}): boolean {
  const context = contextTokens(input.context);
  const tokens = tokenize(input.text);
  const meaningful = meaningfulTokens(tokens);
  if (meaningful.length === 0) return false;
  if (
    hasMixedUnsupportedClause({
      text: input.text,
      context,
      purpose: input.purpose,
      hasStructuredContext: input.context?.hasStructuredContext === true,
    })
  ) {
    return false;
  }

  const anchor =
    input.purpose === "purchasingCommunication"
      ? hasCommunicationAnchor(meaningful, input.context)
      : hasResearchAnchor(meaningful);
  const contextual = hasContextualFollowUp(
    meaningful,
    context,
    input.context?.hasStructuredContext === true,
  );
  if (!anchor && !contextual) return false;

  // There is intentionally no unknown-token allowlist or vocabulary budget.
  // The positive anchor or the server-owned contextual follow-up is the
  // authority boundary; opaque product names are data carried by that
  // already-authorized structure, never a source of authority themselves.
  return true;
}

function isCommunicationSendText(text: string): boolean {
  const tokens = meaningfulTokens(tokenize(text));
  return hasCommunicationAnchor(tokens);
}

function purposeForOperation(operationId: string): WorkflowPurpose | undefined {
  if (operationId === "communication.send" || operationId === "communication.clarify") {
    return "purchasingCommunication";
  }
  if (
    operationId === "research.collect" ||
    operationId === "research.read" ||
    operationId === "evidence.record" ||
    operationId === "quote.record" ||
    operationId === "comparison.read" ||
    operationId === "job.start"
  ) {
    return "purchasingResearch";
  }
  return undefined;
}

export function workflowPurposeForOperation(operationId: string): WorkflowPurpose | undefined {
  return purposeForOperation(operationId);
}

export function workflowContextKey(
  context: Pick<ProjectWorkflowContext, "organizationId" | "projectId">,
  purpose: WorkflowPurpose,
): string {
  return `${WORKFLOW_PURPOSE_CONTRACT_VERSION}:${context.organizationId}:${context.projectId}:${purpose}`;
}

export interface WorkflowPayloadVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

function exactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isResearchCollectionText(
  text: string,
  context: ProjectWorkflowContext | undefined,
): boolean {
  const tokens = meaningfulTokens(tokenize(text));
  if (tokens.length === 0) return false;
  if (
    hasContextualFollowUp(
      tokens,
      contextTokens(context),
      context?.hasStructuredContext === true,
    )
  ) {
    return true;
  }
  // `research.collect` is a supplier/equipment collection operation. A
  // generic purchasing noun such as "price" or "machine" cannot turn an
  // unrelated question into collection authority; the request must describe
  // the collection action and its supplier-facing target. Unknown product
  // names remain valid data after this structural shape is established.
  const collectionAction = tokens.some((token) =>
    token === "research" || token === "source" || token === "identify" || token === "find",
  );
  const supplierTarget = tokens.some((token) =>
    token === "supplier" || token === "suppliers" || token === "vendor" || token === "vendors",
  );
  return collectionAction && supplierTarget;
}

function isResearchReadOperation(operationId: string): boolean {
  return operationId === "research.read" || operationId === "comparison.read";
}

/**
 * `research.read`/`comparison.read` read the project's durable supplier
 * records, so the request must reference that data: a supplier-record anchor,
 * or a read/progress/comparison cue beside a matching server-owned
 * requirement term, or a full contextual follow-up. Generic commercial nouns
 * and object nouns remain payload data only, and cannot establish read
 * authority on their own.
 */
function isResearchReadTokens(
  tokens: readonly string[],
  context: ReadonlySet<string>,
  hasStructuredContext: boolean,
): boolean {
  if (hasContextualFollowUp(tokens, context, hasStructuredContext)) return true;
  if (tokens.some((token) => PURCHASING_READ_RECORD_ANCHORS.has(token))) return true;
  if (!tokens.some((token) => PURCHASING_READ_STATE_CUES.has(token))) return false;
  return tokens.some((token) => context.has(token));
}

function hasMixedUnsupportedReadClause(input: {
  readonly text: string;
  readonly context: ReadonlySet<string>;
  readonly hasStructuredContext: boolean;
}): boolean {
  const clauses = input.text
    .toLocaleLowerCase()
    .split(/\band\b|\bbut\b|[.!?;]|\n/)
    .map((clause) => meaningfulTokens(tokenize(clause)))
    .filter((clause) => clause.length > 0);
  if (clauses.length < 2) return false;
  return clauses.some(
    (clause) =>
      !isResearchReadTokens(clause, input.context, input.hasStructuredContext),
  );
}

/**
 * The read-route analogue of `allowedWorkflowText`: the same mixed-clause
 * boundary, but each clause must satisfy the read structure rather than a
 * single weak purchasing anchor.
 */
function allowedResearchReadText(
  text: string,
  context: ProjectWorkflowContext | undefined,
): boolean {
  const contextTokensSet = contextTokens(context);
  const tokens = meaningfulTokens(tokenize(text));
  if (tokens.length === 0) return false;
  if (
    hasMixedUnsupportedReadClause({
      text,
      context: contextTokensSet,
      hasStructuredContext: context?.hasStructuredContext === true,
    })
  ) {
    return false;
  }
  return isResearchReadTokens(
    tokens,
    contextTokensSet,
    context?.hasStructuredContext === true,
  );
}

function validatedResearchPayload(
  payload: unknown,
  operationId: string,
  context: ProjectWorkflowContext | undefined,
): { readonly text: string } | null {
  if (!exactObjectKeys(payload, ["query"])) return null;
  const query = payload.query;
  if (typeof query !== "string" || query.trim().length === 0) return null;
  if (operationId === "research.collect" && !isResearchCollectionText(query, context)) return null;
  return { text: query };
}

/**
 * Validate semantic payload fields that can carry a workflow purpose. Other
 * fields stay bound to the approved grant and are not interpreted as policy.
 */
export function validateWorkflowPayload(input: {
  readonly operationId: string;
  readonly purpose: WorkflowPurpose;
  readonly payload: unknown;
  readonly context?: ProjectWorkflowContext;
}): WorkflowPayloadVerdict {
  if (input.purpose === "purchasingCommunication") {
    if (!exactObjectKeys(input.payload, ["profile", "to", "cc", "bcc", "subject", "body"])) {
      return { ok: false, reason: "communication-payload-is-outside-purchasing-workflow" };
    }
    if (
      input.payload.profile !== "ownerRoleplay" ||
      typeof input.payload.to !== "string" ||
      !Array.isArray(input.payload.cc) ||
      !Array.isArray(input.payload.bcc) ||
      input.payload.cc.length !== 0 ||
      input.payload.bcc.length !== 0 ||
      typeof input.payload.subject !== "string" ||
      typeof input.payload.body !== "string"
    ) {
      return { ok: false, reason: "communication-payload-is-outside-purchasing-workflow" };
    }
    // The subject is metadata, not authority. Validate the body on its own
    // so an "RFQ" or "Clarification" subject cannot launder an unrelated
    // request into an approved outbound operation.
    if (
      !allowedWorkflowText({
        text: input.payload.body,
        purpose: input.purpose,
        ...(input.context === undefined ? {} : { context: input.context }),
      })
    ) {
      return { ok: false, reason: "communication-payload-is-outside-purchasing-workflow" };
    }
    return { ok: true };
  }
  const research = validatedResearchPayload(input.payload, input.operationId, input.context);
  if (research === null) {
    return { ok: false, reason: "research-payload-is-outside-purchasing-workflow" };
  }
  const allowedText = isResearchReadOperation(input.operationId)
    ? allowedResearchReadText(research.text, input.context)
    : allowedWorkflowText({
        text: research.text,
        purpose: input.purpose,
        ...(input.context === undefined ? {} : { context: input.context }),
      });
  if (!allowedText) {
    return { ok: false, reason: "research-payload-is-outside-purchasing-workflow" };
  }
  return { ok: true };
}

export function validateWorkflowBinding(input: {
  readonly operationId: string;
  readonly jobPurpose?: string;
  readonly jobContext?: string;
  readonly context: ProjectWorkflowContext;
  readonly payload: unknown;
}): WorkflowPayloadVerdict {
  const purpose = purposeForOperation(input.operationId);
  if (purpose === undefined) return { ok: false, reason: "operation-purpose-unavailable" };
  if (input.jobPurpose !== purpose) return { ok: false, reason: "job-purpose-mismatch" };
  if (input.jobContext !== workflowContextKey(input.context, purpose)) {
    return { ok: false, reason: "job-project-context-mismatch" };
  }
  return validateWorkflowPayload({
    operationId: input.operationId,
    purpose,
    payload: input.payload,
    context: input.context,
  });
}

/**
 * Classify a free-text request against the shipped capability catalog and the
 * positive OpeningOS workflow grammar. Supplier evidence markers never
 * expand capabilities, and an operation ID cannot launder an unrelated or
 * mixed request into a supported job.
 */
export function classifyScope(input: {
  readonly text: string;
  readonly operationId?: string;
  readonly fromSupplierEvidence?: boolean;
  readonly projectContext?: ProjectWorkflowContext;
}): ScopeVerdict {
  const text = input.text;
  if (containsInstructionOverride(text)) {
    return {
      verdict: "unrelatedRefused",
      reason: "supplier-evidence-instructions-cannot-expand-capabilities",
    };
  }
  const requestedOperationId = input.operationId ?? (isCommunicationSendText(text) ? "communication.send" : "research.collect");
  const entry = lookupCapability(requestedOperationId);
  if (entry === undefined || !entry.enabled) {
    return { verdict: "unavailableRefused", reason: `operation-unavailable:${requestedOperationId}` };
  }
  const purpose = purposeForOperation(entry.operationId);
  if (purpose === undefined) {
    return { verdict: "unavailableRefused", reason: `operation-purpose-unavailable:${entry.operationId}` };
  }
  const allowedText = isResearchReadOperation(entry.operationId)
    ? allowedResearchReadText(text, input.projectContext)
    : allowedWorkflowText({
        text,
        purpose,
        ...(input.projectContext === undefined ? {} : { context: input.projectContext }),
      });
  if (!allowedText) {
    return { verdict: "unrelatedRefused", reason: "request-is-not-an-allowlisted-openingos-workflow" };
  }
  if (input.operationId !== undefined) {
    // Explicit IDs are checked against the same positive workflow contract;
    // they never bypass text or project-context validation.
    return { verdict: "supported", operationId: entry.operationId, purpose };
  }
  if (entry.operationId === "communication.send" && !isCommunicationSendText(text)) {
    return { verdict: "unrelatedRefused", reason: "communication-purpose-not-established" };
  }
  return { verdict: "supported", operationId: entry.operationId, purpose };
}

/** Detect prompt-injection directives smuggled inside supplier content. */
export function containsInstructionOverride(text: string): boolean {
  return (
    /\bignore (all )?previous instructions\b/i.test(text) ||
    /\bdisregard (all )?(prior|previous) (instructions|policy)\b/i.test(text) ||
    /\bsystem\s*:\s*you are now\b/i.test(text) ||
    /\bgrant (yourself|admin|owner) (access|permission)\b/i.test(text) ||
    /\bsend to (a new|another|this) (address|recipient|vendor)\b/i.test(text)
  );
}

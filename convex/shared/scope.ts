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
      /**
       * The server-derived portion that this job is allowed to execute.
       * Never use the caller's full mixed text as an execution payload.
       */
      readonly supportedSegment: string;
      /**
       * Unrelated or unavailable clauses are retained as explicit metadata
       * so a caller can explain what was refused without granting it work.
       */
      readonly refusedSegments: readonly RefusedScopeSegment[];
    }
  | { readonly verdict: "unrelatedRefused"; readonly reason: string }
  | { readonly verdict: "unavailableRefused"; readonly reason: string };

export interface RefusedScopeSegment {
  readonly text: string;
  readonly verdict: "unrelatedRefused" | "unavailableRefused";
  readonly reason: string;
}

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

/**
 * Words that make the text after `and`/`but` look like a new request rather
 * than a coordinated object list.  This is intentionally a small grammar,
 * not a general parser: product names and quantities remain opaque data.
 */
const INDEPENDENT_CLAUSE_STARTERS: ReadonlySet<string> = new Set([
  "accept",
  "ask",
  "book",
  "buy",
  "calculate",
  "check",
  "compare",
  "confirm",
  "contact",
  "create",
  "draft",
  "explain",
  "find",
  "fill",
  "finance",
  "give",
  "identify",
  "list",
  "make",
  "negotiate",
  "open",
  "pay",
  "place",
  "provide",
  "purchase",
  "research",
  "review",
  "schedule",
  "send",
  "show",
  "sign",
  "submit",
  "tell",
  "use",
  "what",
  "which",
  "why",
  "write",
]);

const CLAUSE_START_FILLERS: ReadonlySet<string> = new Set([
  "also",
  "could",
  "have",
  "has",
  "he",
  "i",
  "instead",
  "just",
  "let",
  "lets",
  "like",
  "may",
  "might",
  "must",
  "need",
  "next",
  "now",
  "please",
  "she",
  "should",
  "then",
  "they",
  "want",
  "we",
  "will",
  "would",
  "you",
]);

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Split at explicit natural-language clause boundaries without treating a
 * decimal point as a sentence boundary or a coordinated object as a second
 * request.  A clause is admitted independently below, so a separator never
 * creates authority by itself and opaque product names remain payload data.
 */
function requestClauses(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;

  const pushClause = (end: number, nextStart: number): void => {
    const clause = text.slice(start, end).trim().replace(/^,+|,+$/g, "").trim();
    if (meaningfulTokens(tokenize(clause)).length > 0) clauses.push(clause);
    start = nextStart;
  };

  const startsIndependentClause = (wordStart: number, word: "and" | "but"): boolean => {
    const remainder = text.slice(wordStart + word.length);
    const tokens = tokenize(remainder);
    if (tokens.length === 0) return false;
    const firstMeaningfulToken = tokens.find((token) =>
      INDEPENDENT_CLAUSE_STARTERS.has(token) || (!STOP_WORDS.has(token) && !CLAUSE_START_FILLERS.has(token)),
    );
    const firstClauseText = remainder.split(/\band\b|\bbut\b|[.!?;\n]/i)[0] ?? remainder;
    if (unavailableCapabilityForClause(firstClauseText) !== null) return true;
    return firstMeaningfulToken !== undefined && INDEPENDENT_CLAUSE_STARTERS.has(firstMeaningfulToken);
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === ".") {
      const previous = text[index - 1];
      const next = text[index + 1];
      if (previous !== undefined && next !== undefined && /\d/.test(previous) && /\d/.test(next)) continue;
      pushClause(index, index + 1);
      continue;
    }
    if (character === "!" || character === "?" || character === ";" || character === "\n") {
      pushClause(index, index + 1);
      continue;
    }
    if (character !== "a" && character !== "A" && character !== "b" && character !== "B") continue;
    const word = text.slice(index, index + 3).toLocaleLowerCase();
    if (word !== "and" && word !== "but") continue;
    const before = text[index - 1];
    const after = text[index + 3];
    if ((before !== undefined && /[a-z0-9]/i.test(before)) || (after !== undefined && /[a-z0-9]/i.test(after))) continue;
    if (startsIndependentClause(index, word)) {
      pushClause(index, index + 3);
      index += 2;
    }
  }
  pushClause(text.length, text.length);
  return clauses;
}

/**
 * Detect only structurally explicit requests for capabilities that are not
 * shipped.  Bare nouns such as "order", "purchase", or "send" stay data;
 * they cannot turn an otherwise ambiguous clause into a refused authority
 * decision.
 */
function unavailableCapabilityForClause(
  text: string,
): { readonly operationId: string; readonly reason: string } | null {
  if (
    /\b(place|create|submit|confirm|accept)\b(?:\W+\w+){0,4}\W+\b(order|purchase|payment|financing|contract)\b/i.test(
      text,
    ) ||
    /\b(buy|purchase|pay|finance|sign)\b(?:\W+\w+){0,3}\b/i.test(text)
  ) {
    return {
      operationId: "purchase.placeOrder",
      reason: "operation-unavailable:purchase.placeOrder",
    };
  }
  if (
    /\b(submit|send|fill|use)\b(?:\W+\w+){0,4}\W+\b(contact\s+form|vendor\s+form|website\s+chat|chat\s+box)\b/i.test(
      text,
    )
  ) {
    return {
      operationId: "vendorForm",
      reason: "operation-unavailable:vendorForm",
    };
  }
  return null;
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

function allowedWorkflowClause(input: {
  readonly text: string;
  readonly purpose: WorkflowPurpose;
  readonly context?: ProjectWorkflowContext;
}): boolean {
  const context = contextTokens(input.context);
  const meaningful = meaningfulTokens(tokenize(input.text));
  if (meaningful.length === 0 || unavailableCapabilityForClause(input.text) !== null) return false;
  const anchor =
    input.purpose === "purchasingCommunication"
      ? hasCommunicationAnchor(meaningful, input.context)
      : hasResearchAnchor(meaningful);
  const contextual = hasContextualFollowUp(
    meaningful,
    context,
    input.context?.hasStructuredContext === true,
  );
  return anchor || contextual;
}

function allowedWorkflowText(input: {
  readonly text: string;
  readonly purpose: WorkflowPurpose;
  readonly context?: ProjectWorkflowContext;
}): boolean {
  const clauses = requestClauses(input.text);
  return (
    clauses.length > 0 &&
    clauses.every((text) => allowedWorkflowClause({ ...input, text }))
  );
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
  const hasReadStateCue = tokens.some((token) => PURCHASING_READ_STATE_CUES.has(token));
  // A bare record noun such as "evidence", "quotes", or "supplier" is
  // content, not a request to read the project's records. Require an
  // explicit read/comparison cue before a record anchor can establish
  // authority at admission, payload binding, or claim.
  if (!hasReadStateCue) return false;
  if (tokens.some((token) => PURCHASING_READ_RECORD_ANCHORS.has(token))) return true;
  return tokens.some((token) => context.has(token));
}

function hasMixedUnsupportedReadClause(input: {
  readonly text: string;
  readonly context: ReadonlySet<string>;
  readonly hasStructuredContext: boolean;
}): boolean {
  const clauses = requestClauses(input.text).map((clause) => meaningfulTokens(tokenize(clause)));
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
 * Extract the text that carries workflow purpose from an already shaped
 * payload.  The surrounding payload remains data and is never interpreted as
 * authority.  Callers use this before classifying a grant or operation so the
 * same segment contract applies at admission, creation, and claim.
 */
export function workflowTextForPayload(
  operationId: string,
  payload: unknown,
): string | null {
  if (operationId === "communication.send" || operationId === "communication.clarify") {
    return exactObjectKeys(payload, ["profile", "to", "cc", "bcc", "subject", "body"]) &&
      typeof payload.body === "string"
      ? payload.body
      : null;
  }
  if (
    operationId !== "research.collect" &&
    operationId !== "research.read" &&
    operationId !== "comparison.read"
  ) {
    return null;
  }
  return exactObjectKeys(payload, ["query"]) && typeof payload.query === "string"
    ? payload.query
    : null;
}

/**
 * Return the canonical payload that carries only a classifier-approved
 * segment.  Refused clauses are intentionally not serialised into a provider
 * payload, preventing a downstream handler from accidentally executing them.
 */
export function supportedWorkflowPayload(
  operationId: string,
  payload: unknown,
  supportedSegment: string,
): Record<string, unknown> | null {
  if (supportedSegment.trim().length === 0) return null;
  if (operationId === "communication.send" || operationId === "communication.clarify") {
    if (!exactObjectKeys(payload, ["profile", "to", "cc", "bcc", "subject", "body"])) return null;
    return { ...payload, body: supportedSegment };
  }
  if (
    operationId !== "research.collect" &&
    operationId !== "research.read" &&
    operationId !== "comparison.read"
  ) {
    return null;
  }
  if (!exactObjectKeys(payload, ["query"])) return null;
  return { query: supportedSegment };
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
    const classified = classifyScope({
      text: input.payload.body,
      operationId: input.operationId,
      ...(input.context === undefined ? {} : { projectContext: input.context }),
    });
    if (classified.verdict !== "supported") {
      return { ok: false, reason: "communication-payload-is-outside-purchasing-workflow" };
    }
    return { ok: true };
  }
  const research = validatedResearchPayload(input.payload, input.operationId, input.context);
  if (research === null) {
    return { ok: false, reason: "research-payload-is-outside-purchasing-workflow" };
  }
  const classified = classifyScope({
    text: research.text,
    operationId: input.operationId,
    ...(input.context === undefined ? {} : { projectContext: input.context }),
  });
  if (classified.verdict !== "supported") {
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
  const clauses = requestClauses(text);
  const supported: string[] = [];
  const refusedSegments: RefusedScopeSegment[] = [];
  for (const clause of clauses) {
    const unavailable = unavailableCapabilityForClause(clause);
    if (unavailable !== null) {
      refusedSegments.push({
        text: clause,
        verdict: "unavailableRefused",
        reason: unavailable.reason,
      });
      continue;
    }
    const allowed = isResearchReadOperation(entry.operationId)
      ? isResearchReadTokens(
          meaningfulTokens(tokenize(clause)),
          contextTokens(input.projectContext),
          input.projectContext?.hasStructuredContext === true,
        )
      : allowedWorkflowClause({
          text: clause,
          purpose,
          ...(input.projectContext === undefined ? {} : { context: input.projectContext }),
        });
    if (allowed) {
      supported.push(clause);
    } else {
      refusedSegments.push({
        text: clause,
        verdict: "unrelatedRefused",
        reason: "request-is-not-an-allowlisted-openingos-workflow",
      });
    }
  }
  // A contextual-only clause is safe as a standalone follow-up, but splitting
  // it away from unrelated text would let an ambiguous request manufacture
  // authority.  Mixed admission therefore needs one explicit purchasing
  // anchor; contextual-only requests remain supported when they are whole.
  if (
    supported.length > 0 &&
    refusedSegments.length > 0 &&
    !supported.some((clause) => {
      const tokens = meaningfulTokens(tokenize(clause));
      if (isResearchReadOperation(entry.operationId)) {
        return tokens.some((token) => PURCHASING_READ_STATE_CUES.has(token)) &&
          tokens.some((token) => PURCHASING_READ_RECORD_ANCHORS.has(token));
      }
      return purpose === "purchasingCommunication"
        ? hasCommunicationAnchor(tokens, input.projectContext)
        : hasResearchAnchor(tokens);
    })
  ) {
    const firstRefusal = refusedSegments[0];
    return {
      verdict: firstRefusal?.verdict === "unavailableRefused" ? "unavailableRefused" : "unrelatedRefused",
      reason: firstRefusal?.reason ?? "request-is-not-an-allowlisted-openingos-workflow",
    };
  }
  if (supported.length === 0) {
    const firstRefusal = refusedSegments[0];
    if (firstRefusal?.verdict === "unavailableRefused") {
      return { verdict: "unavailableRefused", reason: firstRefusal.reason };
    }
    return {
      verdict: "unrelatedRefused",
      reason: firstRefusal?.reason ?? "request-is-not-an-allowlisted-openingos-workflow",
    };
  }
  if (input.operationId === undefined && entry.operationId === "communication.send" && supported.length === 0) {
    return { verdict: "unrelatedRefused", reason: "communication-purpose-not-established" };
  }
  // Explicit IDs are checked against the same positive workflow contract;
  // they never bypass text, project context, or the segment boundary.
  return {
    verdict: "supported",
    operationId: entry.operationId,
    purpose,
    supportedSegment: supported.join(" and "),
    refusedSegments,
  };
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

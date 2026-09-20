/**
 * F1 capability catalog and OpeningOS workflow-purpose classification
 * (controlled contract, ADR-0007 / D-17).
 *
 * Backend code is authoritative: the UI and Jev classifier cannot grant
 * authority, supplier evidence cannot expand capabilities, and unknown
 * operations are denied even when a model is confident.
 */

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

/** Words that form the shipped purchasing workflow grammar. */
const WORKFLOW_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "active",
  "again",
  "an",
  "and",
  "another",
  "any",
  "are",
  "as",
  "at",
  "available",
  "back",
  "be",
  "between",
  "branch",
  "budget",
  "by",
  "can",
  "category",
  "check",
  "change",
  "changes",
  "clarification",
  "clarify",
  "choose",
  "coffee",
  "commercial",
  "compare",
  "comparison",
  "complete",
  "consider",
  "counter",
  "create",
  "current",
  "cost",
  "costs",
  "date",
  "delivery",
  "demo",
  "due",
  "equipment",
  "excluded",
  "espresso",
  "evidence",
  "failed",
  "find",
  "for",
  "freight",
  "from",
  "future",
  "grinder",
  "how",
  "if",
  "in",
  "install",
  "installation",
  "is",
  "it",
  "item",
  "items",
  "latest",
  "lead",
  "location",
  "machine",
  "more",
  "new",
  "next",
  "of",
  "on",
  "or",
  "order",
  "other",
  "option",
  "options",
  "please",
  "price",
  "pricing",
  "progress",
  "project",
  "quote",
  "quotes",
  "read",
  "ready",
  "record",
  "replacement",
  "reply",
  "research",
  "rfq",
  "round",
  "service",
  "services",
  "send",
  "seating",
  "source",
  "status",
  "still",
  "supplier",
  "suppliers",
  "support",
  "that",
  "the",
  "these",
  "this",
  "they",
  "to",
  "two",
  "utilities",
  "utility",
  "vendor",
  "vendors",
  "warranty",
  "water",
  "wave",
  "what",
  "when",
  "which",
  "with",
  "we",
  "why",
  "who",
  "would",
]);

const RESEARCH_ANCHORS: ReadonlySet<string> = new Set([
  "budget",
  "comparison",
  "delivery",
  "equipment",
  "evidence",
  "freight",
  "install",
  "installation",
  "lead",
  "machine",
  "order",
  "price",
  "pricing",
  "quote",
  "quotes",
  "replacement",
  "service",
  "supplier",
  "suppliers",
  "utilities",
  "utility",
  "vendor",
  "vendors",
  "warranty",
  "water",
]);

const COMMUNICATION_ANCHORS: ReadonlySet<string> = new Set([
  "clarification",
  "clarify",
  "demo",
  "reply",
  "rfq",
]);

const CONTEXTUAL_WORDS: ReadonlySet<string> = new Set([
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
  "that",
  "this",
  "what",
  "when",
  "which",
  "why",
  "who",
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
  const values = [
    ...(context?.terms ?? []),
    ...(context === undefined ? [] : [context.projectName]),
  ];
  return new Set(values.flatMap((value) => tokenize(value)));
}

function meaningfulTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

function hasResearchAnchor(tokens: readonly string[], context: ReadonlySet<string>): boolean {
  return tokens.some((token) => RESEARCH_ANCHORS.has(token) || context.has(token));
}

function hasCommunicationAnchor(tokens: readonly string[], context: ReadonlySet<string>): boolean {
  if (tokens.some((token) => COMMUNICATION_ANCHORS.has(token) || context.has(token))) return true;
  return (
    tokens.includes("send") &&
    tokens.some((token) =>
      token === "supplier" ||
      token === "suppliers" ||
      token === "vendor" ||
      token === "vendors",
    )
  );
}

function hasContextualCue(tokens: readonly string[]): boolean {
  return tokens.some((token) => CONTEXTUAL_WORDS.has(token));
}

function hasMixedUnsupportedClause(input: {
  readonly text: string;
  readonly context: ReadonlySet<string>;
  readonly purpose: WorkflowPurpose;
  readonly hasStructuredContext: boolean;
}): boolean {
  const clauses = input.text
    .toLocaleLowerCase()
    .split(/\band\b|\bbut\b|;|\n/)
    .map((clause) => meaningfulTokens(tokenize(clause)))
    .filter((clause) => clause.length > 0);
  if (clauses.length < 2) return false;
  return clauses.some((clause) => {
    const hasPurposeAnchor =
      input.purpose === "purchasingCommunication"
        ? hasCommunicationAnchor(clause, input.context)
        : hasResearchAnchor(clause, input.context);
    const hasContextualReference =
      input.hasStructuredContext &&
      input.context.size > 0 &&
      hasContextualCue(clause);
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
      ? hasCommunicationAnchor(meaningful, context)
      : hasResearchAnchor(meaningful, context);
  const contextual =
    input.context?.hasStructuredContext === true &&
    hasContextualCue(meaningful) &&
    (input.context?.terms?.length ?? 0) > 0;
  if (!anchor && !contextual) return false;

  const unknown = meaningful.filter(
    (token) => !WORKFLOW_WORDS.has(token) && !context.has(token),
  );
  // Project-specific names are accepted as opaque labels only alongside an
  // explicit workflow anchor. A request without a domain anchor is still
  // refused regardless of these labels, and mixed clauses are rejected above.
  if (unknown.length > 2) return false;
  return true;
}

function isCommunicationSendText(text: string): boolean {
  const tokens = meaningfulTokens(tokenize(text));
  return hasCommunicationAnchor(tokens, new Set());
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

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    record[recordKey] = recordValue;
  }
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Validate semantic payload fields that can carry a research purpose. Other
 * fields stay bound to the approved grant and are not interpreted as policy.
 */
export function validateWorkflowPayload(input: {
  readonly operationId: string;
  readonly purpose: WorkflowPurpose;
  readonly payload: unknown;
  readonly context?: ProjectWorkflowContext;
}): WorkflowPayloadVerdict {
  if (input.purpose !== "purchasingResearch") {
    return { ok: true };
  }
  for (const key of ["query", "topic", "request", "text"]) {
    const value = recordValue(input.payload, key);
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      !allowedWorkflowText({
        text: value,
        purpose: input.purpose,
        ...(input.context === undefined ? {} : { context: input.context }),
      })
    ) {
      return { ok: false, reason: "research-payload-is-outside-purchasing-workflow" };
    }
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
  if (
    !allowedWorkflowText({
      text,
      purpose,
      ...(input.projectContext === undefined ? {} : { context: input.projectContext }),
    })
  ) {
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

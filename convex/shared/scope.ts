/**
 * F1 deny-by-default capability catalog and scope classification
 * (controlled contract, ADR-0007 / D-17).
 *
 * Backend code is authoritative: the UI and Jev classifier cannot grant
 * authority, supplier evidence cannot expand capabilities, and unknown
 * operations are denied even when a model is confident.
 */

export const CAPABILITY_CATALOG_VERSION = "capability-catalog-1" as const;

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
  | { readonly verdict: "supported"; readonly operationId: string }
  | { readonly verdict: "unrelatedRefused"; readonly reason: string }
  | { readonly verdict: "unavailableRefused"; readonly reason: string };

const UNRELATED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bhomework\b/i,
  /\bwrite (my )?(essay|poem|novel|song)\b/i,
  /\bgeneral entertainment\b/i,
  /\bpersonal errand\b/i,
  /\bunrelated brows/i,
  /\b Arbitrary code\b/i,
  /\bdo my homework\b/i,
]);

const SUPPORTED_HINTS: readonly RegExp[] = Object.freeze([
  /\b(purchas|supplier|vendor|quote|rfq|equipment|order|deliver|budget|quote|freight|install|warranty|service|replacement|comparison|evidence)\b/i,
  /\bresearch\b/i,
  /\bcomparison\b/i,
]);

// Outbound-communication requests classify to the communication operation
// (not the generic research fallback) so an explicit job grant must
// authorize the actual send/clarify effect.
const COMMUNICATION_SEND_HINTS: readonly RegExp[] = Object.freeze([
  /\brfq\b/i,
  /\bdemo supplier\b/i,
  /\bsend\b.{0,40}\b(supplier|vendor|rfq)\b/i,
]);

/**
 * Classify a free-text request against the shipped capability catalog.
 * Supplier evidence markers (e.g. "ignore previous instructions") never
 * expand capabilities: when present, classification degrades to refused
 * unless the request is otherwise a clearly supported workflow request.
 */
export function classifyScope(input: {
  readonly text: string;
  readonly operationId?: string;
  readonly fromSupplierEvidence?: boolean;
}): ScopeVerdict {
  const text = input.text;
  if (containsInstructionOverride(text)) {
    return {
      verdict: "unrelatedRefused",
      reason: "supplier-evidence-instructions-cannot-expand-capabilities",
    };
  }
  // A supplied operationId never bypasses clearly unrelated text: the
  // text refusal is evaluated first, so a valid operation cannot launder
  // an out-of-scope request into a supported job.
  if (isUnrelatedText(text)) {
    return { verdict: "unrelatedRefused", reason: "request-outside-product-scope" };
  }
  if (input.operationId !== undefined) {
    const entry = lookupCapability(input.operationId);
    if (entry === undefined || !entry.enabled) {
      return { verdict: "unavailableRefused", reason: `operation-unavailable:${input.operationId}` };
    }
    return { verdict: "supported", operationId: entry.operationId };
  }
  if (isSupportedText(text)) {
    if (isCommunicationSendText(text)) {
      const entry = lookupCapability("communication.send");
      if (entry !== undefined && entry.enabled) {
        return { verdict: "supported", operationId: "communication.send" };
      }
    }
    return { verdict: "supported", operationId: "research.collect" };
  }
  return { verdict: "unavailableRefused", reason: "relevant-capability-not-shipped" };
}

function isUnrelatedText(text: string): boolean {
  return UNRELATED_PATTERNS.some((pattern) => pattern.test(text));
}

function isSupportedText(text: string): boolean {
  return SUPPORTED_HINTS.some((pattern) => pattern.test(text));
}

function isCommunicationSendText(text: string): boolean {
  return COMMUNICATION_SEND_HINTS.some((pattern) => pattern.test(text));
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

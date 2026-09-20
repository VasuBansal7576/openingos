/**
 * Authenticated, read-only U1 workbench projections.
 *
 * This module deliberately projects the frozen F1 records instead of creating
 * a second workbench store. Every read starts with the server-derived
 * identity and the existing project access guard. Fan-outs are capped, and a
 * quote or delivery fact is omitted when the bounded records cannot prove it.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability, type DbRole } from "../access/checks.js";
import { f1Query } from "../server.js";
import { provenanceLabel, type ExecutionMode } from "../shared/provenance.js";
import type {
  StoredChargeState,
  StoredQuoteCharge,
  StoredQuoteLine,
  StoredTaxBasis,
} from "../shared/quoteSemantics.js";

export const MAX_PROJECT_PAGE = 12;
export const MAX_REQUIREMENTS = 12;
export const MAX_CANDIDATES = 12;
export const MAX_CANDIDATE_EVIDENCE = 2;
export const MAX_EVIDENCE_SNAPSHOTS = MAX_CANDIDATES * MAX_CANDIDATE_EVIDENCE;
export const MAX_QUOTE_SCAN = 48;
const MAX_QUOTE_LINES = 64;
const MAX_QUOTE_CHARGES = 64;
const MAX_QUOTE_EVIDENCE_REFS = 128;
export const MAX_JOBS = 12;
export const MAX_OPERATIONS_PER_JOB = 8;
export const MAX_ATTEMPTS_PER_OPERATION = 4;
export const MAX_ATTEMPTS_PER_JOB = MAX_OPERATIONS_PER_JOB * MAX_ATTEMPTS_PER_OPERATION;
export const MAX_DECISIONS = 24;
export const MAX_ACTIVITY_PAGE = 24;

const roleValidator = v.union(
  v.literal("owner"),
  v.literal("approver"),
  v.literal("contributor"),
  v.literal("viewer"),
);

const provenanceModeValidator = v.union(
  v.literal("live"),
  v.literal("recorded"),
  v.literal("fixture"),
  v.literal("mixed"),
  v.literal("unknown"),
);

const provenanceValidator = v.object({
  mode: provenanceModeValidator,
  label: v.string(),
  ownerAuthoredTerms: v.boolean(),
});

const moneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});

const projectLocationValidator = v.object({
  id: v.id("locations"),
  name: v.string(),
  region: v.string(),
  reportingCurrency: v.string(),
  operatingStatus: v.string(),
});

const projectValidator = v.object({
  id: v.id("projects"),
  organizationId: v.id("organizations"),
  name: v.string(),
  visibility: v.union(v.literal("open"), v.literal("restricted")),
  location: v.optional(projectLocationValidator),
  currency: v.optional(v.string()),
  budgetMinorUnits: v.optional(v.number()),
  needByAt: v.optional(v.number()),
  createdAt: v.number(),
});

const capabilityFlagsValidator = v.object({
  canResearch: v.boolean(),
  canRecordEvidence: v.boolean(),
  canRecordQuote: v.boolean(),
  canCompare: v.boolean(),
  canCommunicate: v.boolean(),
  canClarify: v.boolean(),
});

const requirementValidator = v.object({
  id: v.id("requirements"),
  key: v.string(),
  title: v.string(),
  category: v.string(),
  quantity: v.string(),
  unit: v.string(),
  priority: v.string(),
  state: v.string(),
  fulfillment: v.string(),
  version: v.number(),
  budgetMinorUnits: v.optional(v.number()),
  currency: v.optional(v.string()),
  needByAt: v.optional(v.number()),
});

const redactedEvidenceValidator = v.object({
  id: v.union(v.id("productEvidence"), v.id("evidence")),
  field: v.string(),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  capturedAt: v.number(),
  completeness: v.optional(v.string()),
  normalizedValue: v.optional(v.string()),
  verification: v.string(),
  freshness: v.string(),
  lastCheckedAt: v.optional(v.number()),
  counterpartyRole: v.string(),
  executionMode: v.string(),
});

const quoteScopeValidator = v.union(
  v.object({ kind: v.literal("quote") }),
  v.object({ kind: v.literal("line"), lineId: v.string() }),
  v.object({ kind: v.literal("allocated"), lineId: v.string(), method: v.union(v.literal("fixed"), v.literal("proportional")) }),
);

const quoteChargeStateValidator = v.union(
  v.object({ kind: v.literal("known"), amount: moneyValidator }),
  v.object({ kind: v.literal("included"), coveringId: v.string() }),
  v.object({
    kind: v.literal("estimated"),
    estimate: v.union(
      v.object({ kind: v.literal("point"), amount: moneyValidator }),
      v.object({ kind: v.literal("range"), minimum: moneyValidator, maximum: moneyValidator }),
    ),
  }),
  v.object({ kind: v.literal("unknown"), reason: v.string() }),
  v.object({ kind: v.literal("notApplicable"), reason: v.string() }),
);

const quoteLineValidator = v.object({
  lineId: v.string(),
  description: v.string(),
  quantity: v.string(),
  unitPrice: moneyValidator,
});

const quoteChargeValidator = v.object({
  chargeId: v.string(),
  label: v.string(),
  scope: quoteScopeValidator,
  state: quoteChargeStateValidator,
});

const quoteTaxBasisValidator = v.union(
  v.object({ kind: v.literal("inclusive"), basisId: v.string() }),
  v.object({ kind: v.literal("exclusive"), basisId: v.string() }),
  v.object({ kind: v.literal("unknown"), reason: v.string() }),
);

const quoteValidator = v.object({
  id: v.id("quotes"),
  version: v.string(),
  currency: v.string(),
  lines: v.array(quoteLineValidator),
  charges: v.array(quoteChargeValidator),
  taxBasis: quoteTaxBasisValidator,
  createdAt: v.number(),
  provenance: provenanceValidator,
});

const vendorValidator = v.object({
  id: v.id("vendors"),
  name: v.string(),
  regions: v.array(v.string()),
  serviceCoverage: v.optional(v.string()),
  serviceCheckedAt: v.optional(v.number()),
});

const candidateValidator = v.object({
  id: v.id("candidates"),
  requirementId: v.id("requirements"),
  productModel: v.string(),
  variant: v.string(),
  compatibility: v.string(),
  conversationState: v.string(),
  vendor: v.optional(vendorValidator),
  latestValidQuote: v.union(quoteValidator, v.null()),
  evidence: v.array(redactedEvidenceValidator),
  provenance: provenanceValidator,
});

const attemptValidator = v.object({
  state: v.string(),
  createdAt: v.number(),
  observedAt: v.optional(v.number()),
});

const jobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("unknown"),
  v.literal("partial"),
  v.literal("paused"),
);

const jobValidator = v.object({
  id: v.id("jobs"),
  kind: v.string(),
  status: jobStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  grantVersion: v.number(),
  attempts: v.array(attemptValidator),
});

const decisionValidator = v.object({
  id: v.union(v.id("selections"), v.id("approvals")),
  kind: v.union(v.literal("selection"), v.literal("approval")),
  state: v.string(),
  requirementId: v.optional(v.id("requirements")),
  candidateId: v.optional(v.id("candidates")),
  quoteId: v.optional(v.id("quotes")),
  quoteVersion: v.optional(v.string()),
  createdAt: v.number(),
  decidedAt: v.optional(v.number()),
});

const activityItemValidator = v.object({
  id: v.id("projectEvents"),
  kind: v.string(),
  createdAt: v.number(),
});

const activityValidator = v.object({
  page: v.array(activityItemValidator),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

const projectListItemValidator = projectValidator.extend({
  effectiveRole: roleValidator,
});

const accessibleProjectsValidator = v.object({
  ok: v.literal(true),
  projects: v.array(projectListItemValidator),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
});

const projectionValidator = v.object({
  ok: v.literal(true),
  project: projectValidator,
  effectiveRole: roleValidator,
  capabilities: capabilityFlagsValidator,
  requirements: v.array(requirementValidator),
  requirementsTruncated: v.boolean(),
  candidates: v.array(candidateValidator),
  candidatesTruncated: v.boolean(),
  jobs: v.array(jobValidator),
  jobsTruncated: v.boolean(),
  decisions: v.array(decisionValidator),
  decisionsTruncated: v.boolean(),
  activity: activityValidator,
  provenance: provenanceValidator,
});

const queryResultValidator = v.union(projectionValidator, denialValidator);
const projectsResultValidator = v.union(accessibleProjectsValidator, denialValidator);

type ProvenanceView = {
  readonly mode: "live" | "recorded" | "fixture" | "mixed" | "unknown";
  readonly label: string;
  readonly ownerAuthoredTerms: boolean;
};

type ProvenanceEntry = {
  readonly counterpartyRole: string;
  readonly executionMode: string;
};

type ProjectRow = {
  readonly _id: Id<"projects">;
  readonly organizationId: Id<"organizations">;
  readonly name: string;
  readonly visibility: "open" | "restricted";
  readonly locationId?: Id<"locations">;
  readonly currency?: string;
  readonly budgetMinorUnits?: number;
  readonly needByAt?: number;
  readonly createdAt: number;
};

type QuoteProjection = {
  readonly id: Id<"quotes">;
  readonly version: string;
  readonly currency: string;
  readonly lines: Array<{
    readonly lineId: string;
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: { readonly currency: string; readonly minorUnits: number };
  }>;
  readonly charges: Array<{
    readonly chargeId: string;
    readonly label: string;
    readonly scope: StoredQuoteCharge["scope"];
    readonly state: StoredChargeState;
  }>;
  readonly taxBasis:
    | { readonly kind: "inclusive" | "exclusive"; readonly basisId: string }
    | { readonly kind: "unknown"; readonly reason: string };
  readonly createdAt: number;
  readonly provenance: ProvenanceView;
};

type QuoteSelection = {
  readonly view: QuoteProjection;
  readonly evidenceRefs: readonly { readonly sourceId: string; readonly version: string }[];
};

function denialForProject(): {
  readonly ok: false;
  readonly code: "denied-membership";
  readonly message: "not authorized for this project";
} {
  return { ok: false, code: "denied-membership", message: "not authorized for this project" };
}

function boundedLimit(requested: number | undefined, maximum: number): number | null {
  if (requested === undefined) return Math.min(8, maximum);
  if (!Number.isSafeInteger(requested) || requested < 1) return null;
  return Math.min(requested, maximum);
}

function capabilityFlags(role: DbRole) {
  return {
    canResearch: requireCapability("research.collect", role).ok,
    canRecordEvidence: requireCapability("evidence.record", role).ok,
    canRecordQuote: requireCapability("quote.record", role).ok,
    canCompare: requireCapability("comparison.read", role).ok,
    canCommunicate: requireCapability("communication.send", role).ok,
    canClarify: requireCapability("communication.clarify", role).ok,
  };
}

function executionMode(value: string): ExecutionMode | null {
  if (value === "live" || value === "recorded" || value === "fixture") return value;
  return null;
}

function provenanceFor(entry: ProvenanceEntry): ProvenanceView {
  const mode = executionMode(entry.executionMode);
  if (mode === null) {
    return { mode: "unknown", label: "Unclassified evidence", ownerAuthoredTerms: false };
  }
  const owner = entry.counterpartyRole === "ownerStandIn";
  const role = owner || entry.counterpartyRole === "vendor" ? entry.counterpartyRole : null;
  if (entry.counterpartyRole === "userImport") {
    return {
      mode,
      label: mode === "fixture" ? "Controlled fixture terms" : "Recorded user terms",
      ownerAuthoredTerms: false,
    };
  }
  if (role === null) {
    return { mode, label: "Unclassified evidence", ownerAuthoredTerms: false };
  }
  return {
    mode,
    label: provenanceLabel({ counterpartyRole: role, executionMode: mode }),
    ownerAuthoredTerms: owner,
  };
}

function combineProvenance(views: readonly ProvenanceView[]): ProvenanceView {
  if (views.length === 0) {
    return { mode: "unknown", label: "No supplier terms", ownerAuthoredTerms: false };
  }
  const modes = new Set(views.map((view) => view.mode));
  const ownerAuthoredTerms = views.some((view) => view.ownerAuthoredTerms);
  if (views.length === 1) return views[0] ?? { mode: "unknown", label: "No supplier terms", ownerAuthoredTerms: false };
  if (modes.size === 1 && views.every((view) => view.label === views[0]?.label)) {
    return {
      mode: views[0]?.mode ?? "unknown",
      label: views[0]?.label ?? "No supplier terms",
      ownerAuthoredTerms,
    };
  }
  return { mode: "mixed", label: "Mixed supplier evidence", ownerAuthoredTerms };
}

function safeMoney(value: { readonly currency: string; readonly minorUnits: number }): { currency: string; minorUnits: number } | null {
  if (!Number.isSafeInteger(value.minorUnits) || value.currency.trim().length === 0) return null;
  return { currency: value.currency, minorUnits: value.minorUnits };
}

function redactedChargeState(state: StoredChargeState): StoredChargeState | null {
  if (state.kind === "known") {
    const amount = safeMoney(state.amount);
    return amount === null ? null : { kind: "known", amount };
  }
  if (state.kind === "estimated") {
    if (state.estimate.kind === "point") {
      const amount = safeMoney(state.estimate.amount);
      return amount === null ? null : { kind: "estimated", estimate: { kind: "point", amount } };
    }
    const minimum = safeMoney(state.estimate.minimum);
    const maximum = safeMoney(state.estimate.maximum);
    return minimum === null || maximum === null
      ? null
      : { kind: "estimated", estimate: { kind: "range", minimum, maximum } };
  }
  if (state.kind === "included") return { kind: "included", coveringId: state.coveringId };
  if (state.kind === "unknown") return { kind: "unknown", reason: state.reason };
  return { kind: "notApplicable", reason: state.reason };
}

function renderQuote(row: {
  readonly _id: Id<"quotes">;
  readonly version: string;
  readonly currency: string;
  readonly lines: readonly StoredQuoteLine[];
  readonly charges: readonly StoredQuoteCharge[];
  readonly taxBasis: StoredTaxBasis;
  readonly evidenceRefs: readonly { readonly sourceId: string; readonly version: string; readonly locator?: string }[];
  readonly counterpartyRole: string;
  readonly executionMode: string;
  readonly createdAt: number;
}): QuoteSelection | null {
  if (
    row.currency.trim().length === 0 ||
    row.lines.length > MAX_QUOTE_LINES ||
    row.charges.length > MAX_QUOTE_CHARGES ||
    row.evidenceRefs.length > MAX_QUOTE_EVIDENCE_REFS
  ) return null;
  const lines: QuoteProjection["lines"] = [];
  for (const line of row.lines) {
    const unitPrice = safeMoney(line.unitPrice);
    if (
      unitPrice === null ||
      unitPrice.currency !== row.currency ||
      line.lineId.trim().length === 0 ||
      line.description.trim().length === 0 ||
      line.quantity.trim().length === 0
    ) return null;
    lines.push({
      lineId: line.lineId,
      description: line.description,
      quantity: line.quantity,
      unitPrice,
    });
  }
  const charges: QuoteProjection["charges"] = [];
  for (const charge of row.charges) {
    const state = redactedChargeState(charge.state);
    if (state === null || charge.chargeId.trim().length === 0 || charge.label.trim().length === 0) return null;
    charges.push({ chargeId: charge.chargeId, label: charge.label, scope: charge.scope, state });
  }
  const taxBasis = row.taxBasis.kind === "unknown"
    ? row.taxBasis.reason.trim().length === 0
      ? null
      : { kind: "unknown" as const, reason: row.taxBasis.reason }
    : row.taxBasis.basisId.trim().length === 0
      ? null
      : { kind: row.taxBasis.kind, basisId: row.taxBasis.basisId };
  if (taxBasis === null) return null;
  const provenance = provenanceFor(row);
  if (provenance.mode === "unknown") return null;
  return {
    view: {
      id: row._id,
      version: row.version,
      currency: row.currency,
      lines,
      charges,
      taxBasis,
      createdAt: row.createdAt,
      provenance,
    },
    evidenceRefs: row.evidenceRefs.map((ref) => ({ sourceId: ref.sourceId, version: ref.version })),
  };
}

function redactedEvidence(row: {
  readonly _id: Id<"productEvidence">;
  readonly field: string;
  readonly sourceKind: string;
  readonly sourceUrl?: string;
  readonly capturedAt: number;
  readonly normalizedValue: string;
  readonly verification: string;
  readonly freshness: string;
  readonly lastCheckedAt?: number;
  readonly counterpartyRole: string;
  readonly executionMode: string;
}) {
  const ownerAuthored = row.counterpartyRole === "ownerStandIn";
  const value: {
    id: Id<"productEvidence">;
    field: string;
    sourceKind: string;
    sourceUrl?: string;
    capturedAt: number;
    completeness?: string;
    normalizedValue?: string;
    verification: string;
    freshness: string;
    lastCheckedAt?: number;
    counterpartyRole: string;
    executionMode: string;
  } = {
    id: row._id,
    field: row.field,
    sourceKind: row.sourceKind,
    capturedAt: row.capturedAt,
    verification: row.verification,
    freshness: row.freshness,
    counterpartyRole: row.counterpartyRole,
    executionMode: row.executionMode,
  };
  // Owner-authored evidence can contain a private mailbox or raw reply text.
  // Its controlled label remains visible, while URL/value/locator material is
  // intentionally withheld from public projections.
  if (!ownerAuthored && row.sourceUrl?.startsWith("https://") === true) value.sourceUrl = row.sourceUrl;
  if (!ownerAuthored) value.normalizedValue = row.normalizedValue;
  if (row.lastCheckedAt !== undefined) value.lastCheckedAt = row.lastCheckedAt;
  return value;
}

function redactedSnapshot(row: {
  readonly _id: Id<"evidence">;
  readonly sourceKind: string;
  readonly sourceUrl?: string;
  readonly capturedAt: number;
  readonly completeness: string;
  readonly counterpartyRole: string;
  readonly executionMode: string;
}) {
  const ownerAuthored = row.counterpartyRole === "ownerStandIn";
  const value: {
    id: Id<"evidence">;
    field: string;
    sourceKind: string;
    sourceUrl?: string;
    capturedAt: number;
    completeness?: string;
    verification: string;
    freshness: string;
    counterpartyRole: string;
    executionMode: string;
  } = {
    id: row._id,
    field: row.sourceKind,
    sourceKind: row.sourceKind,
    capturedAt: row.capturedAt,
    completeness: row.completeness,
    verification: "unverified",
    freshness: row.completeness === "complete" ? "fresh" : "unknown",
    counterpartyRole: row.counterpartyRole,
    executionMode: row.executionMode,
  };
  if (!ownerAuthored && row.sourceUrl?.startsWith("https://") === true) value.sourceUrl = row.sourceUrl;
  return value;
}

/** Build a safe project summary. */
async function readProjectSummary(
  ctx: import("../server.js").F1QueryCtx,
  project: ProjectRow,
) {
  const location = project.locationId === undefined ? null : await ctx.db.get(project.locationId);
  const safeLocation = location !== null && location.organizationId === project.organizationId
    ? {
      id: location._id,
      name: location.name,
      region: location.region,
      reportingCurrency: location.reportingCurrency,
      operatingStatus: location.operatingStatus,
    }
    : undefined;
  return {
    id: project._id,
    organizationId: project.organizationId,
    name: project.name,
    visibility: project.visibility,
    ...(safeLocation === undefined ? {} : { location: safeLocation }),
    ...(project.currency === undefined ? {} : { currency: project.currency }),
    ...(project.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: project.budgetMinorUnits }),
    ...(project.needByAt === undefined ? {} : { needByAt: project.needByAt }),
    createdAt: project.createdAt,
  };
}

async function hasQuoteSuccessor(
  ctx: import("../server.js").F1QueryCtx,
  projectId: Id<"projects">,
  contentHash: string,
): Promise<boolean> {
  const successor = await ctx.db
    .query("quotes")
    .withIndex("by_project_and_supersedes", (q) =>
      q.eq("projectId", projectId).eq("supersedes", contentHash),
    )
    .first();
  return successor !== null;
}

type CandidateQuoteKey = `${string}:${string}`;

function candidateQuoteKey(requirementId: Id<"requirements">, vendorId: Id<"vendors">): CandidateQuoteKey {
  return `${requirementId}:${vendorId}`;
}

async function latestQuotesForCandidates(
  ctx: import("../server.js").F1QueryCtx,
  projectId: Id<"projects">,
  organizationId: Id<"organizations">,
  candidates: readonly { readonly requirementId: Id<"requirements">; readonly vendorId: Id<"vendors"> }[],
): Promise<Map<CandidateQuoteKey, QuoteSelection | null>> {
  // The frozen schema has no requirement/vendor quote index. Scan only a
  // bounded newest slice and use the indexed successor probe to reject stale
  // revisions. If the current match is outside this slice, null is safer than
  // presenting an older or guessed quote as current.
  const result = new Map<CandidateQuoteKey, QuoteSelection | null>();
  if (candidates.length === 0) return result;
  const rows = await ctx.db
    .query("quotes")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .order("desc")
    .take(MAX_QUOTE_SCAN);
  const wanted = new Set(candidates.map((candidate) => candidateQuoteKey(candidate.requirementId, candidate.vendorId)));
  const resolved = new Set<CandidateQuoteKey>();
  for (const row of rows) {
    if (
      row.organizationId !== organizationId ||
      row.projectId !== projectId ||
      row.requirementId === undefined ||
      row.vendorId === undefined
    ) continue;
    const key = candidateQuoteKey(row.requirementId, row.vendorId);
    if (!wanted.has(key) || resolved.has(key)) continue;
    if (await hasQuoteSuccessor(ctx, projectId, row.contentHash)) continue;
    const rendered = renderQuote(row);
    result.set(key, rendered);
    resolved.add(key);
  }
  for (const key of wanted) {
    if (!result.has(key)) result.set(key, null);
  }
  return result;
}

function mapJobStatus(
  jobState: string,
  kind: string,
  operationStates: readonly string[],
  attempts: readonly { readonly state: string }[],
  hasReply: boolean,
  fanoutTruncated: boolean,
): "queued" | "sent" | "delivered" | "unknown" | "partial" | "paused" {
  if (jobState === "pausedBudget" || jobState === "waitingForSupplier" || jobState === "waitingForUser") return "paused";
  if (jobState === "partial") return "partial";
  if (fanoutTruncated) return "unknown";
  if (operationStates.some((state) => state === "dispatching" || state === "outcomeUnknown") || attempts.some((attempt) => attempt.state === "dispatching" || attempt.state === "outcomeUnknown")) {
    return "unknown";
  }
  if (operationStates.includes("observedSuccess") && operationStates.includes("observedFailure")) return "partial";
  if (jobState === "queued" || jobState === "running") return "queued";
  if (jobState === "failed" || jobState === "cancelled" || jobState === "cancelling") return "unknown";
  if (operationStates.includes("observedSuccess")) return kind === "communication" && hasReply ? "delivered" : "sent";
  if (operationStates.length === 0 && attempts.length === 0) return "queued";
  return "unknown";
}

function uniqueModes(views: readonly ProvenanceView[]): ProvenanceView {
  return combineProvenance(views);
}

/** List projects visible to the authenticated identity through bounded scans. */
export const listAccessibleProjects = f1Query({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: projectsResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    const pageSize = boundedLimit(args.limit, MAX_PROJECT_PAGE);
    if (pageSize === null) return { ok: false as const, code: "invalid-payload", message: "limit must be a positive safe integer" };
    let page: {
      readonly page: readonly ProjectRow[];
      readonly isDone: boolean;
      readonly continueCursor: string;
    };
    try {
      page = await ctx.db
        .query("projects")
        .order("asc")
        .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "invalid project cursor" };
    }
    const now = Date.now();
    const projects = [] as Array<{
      readonly id: Id<"projects">;
      readonly organizationId: Id<"organizations">;
      readonly name: string;
      readonly visibility: "open" | "restricted";
      readonly location?: {
        readonly id: Id<"locations">;
        readonly name: string;
        readonly region: string;
        readonly reportingCurrency: string;
        readonly operatingStatus: string;
      };
      readonly currency?: string;
      readonly budgetMinorUnits?: number;
      readonly needByAt?: number;
      readonly createdAt: number;
      readonly effectiveRole: DbRole;
    }>;
    for (const project of page.page) {
      const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "viewer", now);
      if (!access.ok) continue;
      const summary = await readProjectSummary(ctx, project);
      projects.push({ ...summary, effectiveRole: access.value });
    }
    return {
      ok: true as const,
      projects,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Return the bounded, redacted workbench state for one authorized project. */
export const getProjection = f1Query({
  args: {
    projectId: v.id("projects"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: queryResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    const project = await ctx.db.get(args.projectId);
    if (project === null) return denialForProject();
    const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return denialForProject();
    const pageSize = boundedLimit(args.limit, MAX_ACTIVITY_PAGE);
    if (pageSize === null) return { ok: false as const, code: "invalid-payload", message: "limit must be a positive safe integer" };

    let activityPage: {
      readonly page: readonly {
        readonly _id: Id<"projectEvents">;
        readonly organizationId: Id<"organizations">;
        readonly projectId: Id<"projects">;
        readonly kind: string;
        readonly createdAt: number;
      }[];
      readonly isDone: boolean;
      readonly continueCursor: string;
    };
    try {
      activityPage = await ctx.db
        .query("projectEvents")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .order("desc")
        .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "invalid activity cursor" };
    }

    const requirementsPage = await ctx.db
      .query("requirements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .take(Math.min(pageSize, MAX_REQUIREMENTS) + 1);
    const requirements = requirementsPage
      .filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId)
      .slice(0, Math.min(pageSize, MAX_REQUIREMENTS))
      .map((row) => ({
        id: row._id,
        key: row.key,
        title: row.title,
        category: row.category,
        quantity: row.quantity,
        unit: row.unit,
        priority: row.priority,
        state: row.state,
        fulfillment: row.fulfillment,
        version: row.version,
        ...(row.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: row.budgetMinorUnits }),
        ...(row.currency === undefined ? {} : { currency: row.currency }),
        ...(row.needByAt === undefined ? {} : { needByAt: row.needByAt }),
      }));

    const candidatesPage = await ctx.db
      .query("candidates")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .take(Math.min(pageSize, MAX_CANDIDATES) + 1);
    const candidateRows = candidatesPage
      .filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId)
      .slice(0, Math.min(pageSize, MAX_CANDIDATES));
    const latestQuotes = await latestQuotesForCandidates(
      ctx,
      args.projectId,
      project.organizationId,
      candidateRows,
    );
    const candidates: Array<{
      readonly id: Id<"candidates">;
      readonly requirementId: Id<"requirements">;
      readonly productModel: string;
      readonly variant: string;
      readonly compatibility: string;
      readonly conversationState: string;
      readonly vendor?: {
        readonly id: Id<"vendors">;
        readonly name: string;
        readonly regions: string[];
        readonly serviceCoverage?: string;
        readonly serviceCheckedAt?: number;
      };
      readonly latestValidQuote: QuoteProjection | null;
      readonly evidence: Array<ReturnType<typeof redactedEvidence> | ReturnType<typeof redactedSnapshot>>;
      readonly provenance: ProvenanceView;
    }> = [];
    const sourceEvidenceRows = await ctx.db
      .query("evidence")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(MAX_EVIDENCE_SNAPSHOTS);
    const provenanceEntries: ProvenanceView[] = [];
    for (const candidate of candidateRows) {
      const requirementRow = await ctx.db.get(candidate.requirementId);
      if (
        requirementRow === null ||
        requirementRow.organizationId !== project.organizationId ||
        requirementRow.projectId !== args.projectId
      ) continue;
      const vendorRow = await ctx.db.get(candidate.vendorId);
      const vendor = vendorRow !== null && vendorRow.organizationId === project.organizationId
        ? {
          id: vendorRow._id,
          name: vendorRow.name,
          regions: [...vendorRow.regions],
          ...(vendorRow.serviceCoverage === undefined ? {} : { serviceCoverage: vendorRow.serviceCoverage }),
          ...(vendorRow.serviceCheckedAt === undefined ? {} : { serviceCheckedAt: vendorRow.serviceCheckedAt }),
        }
        : undefined;
      const evidenceRows = await ctx.db
        .query("productEvidence")
        .withIndex("by_candidate", (q) => q.eq("candidateId", candidate._id))
        .order("desc")
        .take(MAX_CANDIDATE_EVIDENCE);
      const evidence = evidenceRows
        .filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId && row.candidateId === candidate._id)
        .map(redactedEvidence);
      const quoteSelection = vendor === undefined
        ? null
        : latestQuotes.get(candidateQuoteKey(candidate.requirementId, candidate.vendorId)) ?? null;
      const quote = quoteSelection?.view ?? null;
      const quoteEvidence = quoteSelection === null
        ? []
        : quoteSelection.evidenceRefs.flatMap((ref) => {
          const snapshot = sourceEvidenceRows.find((row) =>
            row._id === ref.sourceId &&
            row.organizationId === project.organizationId &&
            row.projectId === args.projectId,
          );
          return snapshot === undefined ? [] : [redactedSnapshot(snapshot)];
        });
      const visibleEvidence = [...evidence, ...quoteEvidence];
      const entries: ProvenanceView[] = [
        ...visibleEvidence.map((row) => provenanceFor({ counterpartyRole: row.counterpartyRole, executionMode: row.executionMode })),
        ...(quote === null ? [] : [quote.provenance]),
      ];
      provenanceEntries.push(...entries);
      candidates.push({
        id: candidate._id,
        requirementId: candidate.requirementId,
        productModel: candidate.productModel,
        variant: candidate.variant,
        compatibility: candidate.compatibility === "pass" && candidate.compatibilityEvidenceIndexComplete !== true ? "unknown" : candidate.compatibility,
        conversationState: candidate.conversationState,
        ...(vendor === undefined ? {} : { vendor }),
        latestValidQuote: quote,
        evidence: visibleEvidence,
        provenance: combineProvenance(entries),
      });
    }

    const jobsPage = await ctx.db
      .query("jobs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(pageSize, MAX_JOBS) + 1);
    const jobsRows = jobsPage
      .filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId)
      .slice(0, Math.min(pageSize, MAX_JOBS));
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_JOBS);
    const jobs = [] as Array<{
      readonly id: Id<"jobs">;
      readonly kind: string;
      readonly status: "queued" | "sent" | "delivered" | "unknown" | "partial" | "paused";
      readonly createdAt: number;
      readonly updatedAt: number;
      readonly grantVersion: number;
      readonly attempts: Array<{ state: string; createdAt: number; observedAt?: number }>;
    }>;
    for (const job of jobsRows) {
      const rawOperations = await ctx.db
        .query("operations")
        .withIndex("by_job", (q) => q.eq("jobId", job._id))
        .order("desc")
        .take(MAX_OPERATIONS_PER_JOB + 1);
      const operations = rawOperations
        .filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId && row.jobId === job._id)
        .slice(0, MAX_OPERATIONS_PER_JOB);
      const attemptRows: Array<{ state: string; createdAt: number; observedAt?: number }> = [];
      let attemptsTruncated = false;
      for (const operation of operations) {
        const attempts = await ctx.db
          .query("attempts")
          .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
          .order("desc")
          .take(MAX_ATTEMPTS_PER_OPERATION + 1);
        if (attempts.length > MAX_ATTEMPTS_PER_OPERATION) attemptsTruncated = true;
        for (const attempt of attempts) {
          if (attemptRows.length >= MAX_ATTEMPTS_PER_JOB) {
            attemptsTruncated = true;
            break;
          }
          attemptRows.push({
            state: attempt.state,
            createdAt: attempt.createdAt,
            ...(attempt.observedAt === undefined ? {} : { observedAt: attempt.observedAt }),
          });
        }
      }
      const hasReply = conversations.some((conversation) => conversation.organizationId === project.organizationId && conversation.projectId === args.projectId && conversation.grantId === job.grantId && conversation.state === "replyReceived");
      jobs.push({
        id: job._id,
        kind: job.kind,
        status: mapJobStatus(
          job.state,
          job.kind,
          operations.map((operation) => operation.state),
          attemptRows,
          hasReply,
          rawOperations.length > MAX_OPERATIONS_PER_JOB || attemptsTruncated,
        ),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        grantVersion: job.grantVersion,
        attempts: attemptRows,
      });
    }

    const selectionRows = await ctx.db
      .query("selections")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(pageSize, MAX_DECISIONS) + 1);
    const approvalRows = await ctx.db
      .query("approvals")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.min(pageSize, MAX_DECISIONS) + 1);
    const decisionLimit = Math.min(pageSize, MAX_DECISIONS);
    const allDecisions = [
      ...selectionRows.filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId).map((row) => ({
        id: row._id,
        kind: "selection" as const,
        state: "selected",
        requirementId: row.requirementId,
        candidateId: row.candidateId,
        quoteId: row.quoteId,
        quoteVersion: row.quoteVersion,
        createdAt: row.createdAt,
      })),
      ...approvalRows.filter((row) => row.organizationId === project.organizationId && row.projectId === args.projectId).map((row) => ({
        id: row._id,
        kind: "approval" as const,
        state: row.state,
        ...(row.quoteId === undefined ? {} : { quoteId: row.quoteId }),
        createdAt: row.createdAt,
        ...(row.decidedAt === undefined ? {} : { decidedAt: row.decidedAt }),
      })),
    ].sort((left, right) => right.createdAt - left.createdAt);
    const decisions = allDecisions.slice(0, decisionLimit);
    const decisionsTruncated =
      allDecisions.length > decisionLimit ||
      selectionRows.length > decisionLimit ||
      approvalRows.length > decisionLimit;

    const activity = {
      page: activityPage.page
        .filter((row) => row.projectId === args.projectId && row.organizationId === project.organizationId)
        .map((row) => ({ id: row._id, kind: row.kind, createdAt: row.createdAt })),
      isDone: activityPage.isDone,
      continueCursor: activityPage.isDone ? null : activityPage.continueCursor,
    };
    const summary = await readProjectSummary(ctx, project);
    return {
      ok: true as const,
      project: summary,
      effectiveRole: access.value,
      capabilities: capabilityFlags(access.value),
      requirements,
      requirementsTruncated: requirementsPage.length > Math.min(pageSize, MAX_REQUIREMENTS),
      candidates,
      candidatesTruncated: candidatesPage.length > Math.min(pageSize, MAX_CANDIDATES),
      jobs,
      jobsTruncated: jobsPage.length > Math.min(pageSize, MAX_JOBS),
      decisions,
      decisionsTruncated,
      activity,
      provenance: uniqueModes(provenanceEntries),
    };
  },
});

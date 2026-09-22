/**
 * R1 bounded research collection and authorized projections.
 *
 * One request creates one F1 job, one reservation, and one
 * `research.collect` operation.  The internal action claims that operation
 * exactly once and invokes the Firecrawl component exactly once.  The
 * component owns its bounded four-attempt transport policy; this module does
 * not add a workflow retry around it.
 */

import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import {
  makeFunctionReference,
  paginationOptsValidator,
  type FunctionReference,
  type DefaultFunctionArgs,
  type PaginationOptions,
  type RegisteredAction,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api.js";
import { internalAction } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, f1InternalQuery, f1Mutation, f1Query } from "../server.js";
import type { F1MutationCtx } from "../server.js";
import * as attempts from "../execution/attempts.js";
import * as jobs from "../execution/jobs.js";
import * as operations from "../execution/operations.js";
import * as reservations from "../execution/reservations.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../access/checks.js";
import { ensureSharedBudget, RESEARCH_ALLOWANCE_PRICING_BASIS } from "../execution/allowance.js";
import { components } from "../models/components.js";
import type { ComponentApi } from "@firecrawl/firecrawl-convex/_generated/component.js";
import { canonicalJson, payloadHash, requestKey } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import { provenanceLabel } from "../shared/provenance.js";
import { MAX_OPERATIONS_PER_JOB } from "../shared/scope.js";
import {
  compareResultValidator,
  classifyFirecrawlError,
  isSafePublicSourceUrl,
  normalizeProviderResponse,
  normalizedSourceRecordValidator,
  projectResearchCandidatesPageValidator,
  projectResearchClaimsPageValidator,
  projectResearchEvidencePageValidator,
  projectResearchResultValidator,
  researchCompletenessValidator,
  researchExecutionModeValidator,
  researchIntentValidator,
  researchModeValidator,
  researchRecoveryResultValidator,
  researchResultValidator,
  type NormalizedSourceRecord,
  type ProviderOutcome,
  type ResearchExecutionMode,
  type ResearchIntent,
  type ResearchMode,
} from "./contracts.js";

const FIRECRAWL_MAX_TRANSPORT_ATTEMPTS = 4;
/** Conservative maximum for one Firecrawl search/map/scrape call. */
export const FIRECRAWL_CALL_MAX_COST_MICRO_USD = 25_000;
export const FIRECRAWL_PRICING_BASIS =
  `firecrawl-one-shot-v0;max-http-attempts=${FIRECRAWL_MAX_TRANSPORT_ATTEMPTS};maximum-cost-micro-usd=${FIRECRAWL_CALL_MAX_COST_MICRO_USD}`;

const MAX_PROVIDER_RECORDS = 32;
const MAX_PROJECT_RECORDS = 128;
/** Maximum number of rows returned by one page of any project stream. */
const MAX_PROJECT_PAGE_SIZE = 128;
/** One extra row lets Convex determine whether a bounded page is complete. */
const MAX_PROJECT_PAGE_ROWS_READ = MAX_PROJECT_PAGE_SIZE + 1;
/** Keep each stream read bounded even when callers omit read budgets. */
const MAX_PROJECT_PAGE_BYTES_READ = 2_000_000;
const DEFAULT_PROJECT_PAGE_SIZE = 32;
const MAX_RECOVERY_OPERATIONS = 4;

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;
type ActionArgs<T> = T extends RegisteredAction<infer _V, infer A, infer _R> ? A : never;
type ActionReturn<T> = T extends RegisteredAction<infer _V, infer _A, infer R> ? R : never;

const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.start>,
  MutationReturn<typeof jobs.start>
>("execution/jobs:start");
const reserveRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.reserve>,
  MutationReturn<typeof reservations.reserve>
>("execution/reservations:reserve");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const cancelJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.cancel>,
  MutationReturn<typeof jobs.cancel>
>("execution/jobs:cancel");
const recordOutcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.recordOutcome>,
  MutationReturn<typeof attempts.recordOutcome>
>("execution/attempts:recordOutcome");

type ClaimArgs = MutationArgs<typeof operations.claim>;
type ClaimReturn = MutationReturn<typeof operations.claim>;
type ProviderReadArgs = {
  operationId: Id<"operations">;
  identity: string;
};
type ProviderReadReturn =
  | {
      readonly ok: true;
      readonly operationId: Id<"operations">;
      readonly jobId: Id<"jobs">;
      readonly organizationId: Id<"organizations">;
      readonly projectId: Id<"projects">;
      readonly grantId: Id<"grants">;
      readonly payload: string;
      readonly state: string;
      readonly requestId: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };
type ApplyArgs = {
  operationId: Id<"operations">;
  token: string;
  identity: string;
  outcome: ProviderOutcome;
};
type ApplyReturn =
  | {
      readonly ok: true;
      readonly jobId: Id<"jobs">;
      readonly state: string;
      readonly requestCount: number;
      readonly incompleteCount: number;
      readonly controlled: boolean;
      readonly stale: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };
type PauseArgs = { operationId: Id<"operations">; identity: string };
type PauseReturn =
  | { readonly ok: true; readonly jobId: Id<"jobs">; readonly state: string }
  | { readonly ok: false; readonly code: string; readonly message: string };
type ExecuteArgs = {
  operationId: Id<"operations">;
  identity: string;
  mode: ResearchMode;
  sourceUrl?: string;
  controlledResponseJson?: string;
  controlled?: boolean;
};
type ExecuteReturn =
  | {
      readonly ok: true;
      readonly jobId: Id<"jobs">;
      readonly operationId: Id<"operations">;
      readonly state: string;
      readonly requestCount: number;
      readonly incompleteCount: number;
      readonly controlled: boolean;
      readonly stale: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Generated API is intentionally stale until the foundation deployment runs
 * codegen.  These refs are the same server-owned paths and are kept in one
 * typed boundary; no client can obtain them because all are internal refs.
 */
type InternalResearchApi = {
  readonly research: {
    readonly collection: {
      readonly execute: FunctionReference<"action", "internal", ExecuteArgs, ExecuteReturn>;
      readonly readOperation: FunctionReference<"query", "internal", ProviderReadArgs, ProviderReadReturn>;
      readonly applyOutcome: FunctionReference<"mutation", "internal", ApplyArgs, ApplyReturn>;
      readonly pauseForCredit: FunctionReference<"mutation", "internal", PauseArgs, PauseReturn>;
    };
  };
};
const researchInternal = internal as unknown as InternalResearchApi;

const firecrawlComponents = components as unknown as { readonly firecrawl: ComponentApi };
const firecrawl = new FirecrawlClient(firecrawlComponents.firecrawl);

const executionResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    jobId: v.id("jobs"),
    operationId: v.id("operations"),
    state: v.string(),
    requestCount: v.number(),
    incompleteCount: v.number(),
    controlled: v.boolean(),
    stale: v.boolean(),
  }),
  denialValidator,
);

const internalReadResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    operationId: v.id("operations"),
    jobId: v.id("jobs"),
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    grantId: v.id("grants"),
    payload: v.string(),
    state: v.string(),
    requestId: v.string(),
  }),
  denialValidator,
);

const internalApplyResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    jobId: v.id("jobs"),
    state: v.string(),
    requestCount: v.number(),
    incompleteCount: v.number(),
    controlled: v.boolean(),
    stale: v.boolean(),
  }),
  denialValidator,
);

const internalPauseResultValidator = v.union(
  v.object({ ok: v.literal(true), jobId: v.id("jobs"), state: v.string() }),
  denialValidator,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ProjectPaginationInput = {
  readonly numItems: number;
  readonly cursor: string | null;
  readonly endCursor?: string | null;
  readonly maximumRowsRead?: number;
  readonly maximumBytesRead?: number;
};

type ProjectPaginationResult = {
  readonly isDone: boolean;
  readonly continueCursor: string;
  readonly splitCursor?: string | null;
  readonly pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

function boundedProjectBudget(value: number | undefined, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

/**
 * Keep every project stream bounded while preserving the caller's cursor and
 * range.  The read floors are at least one page plus one look-ahead row so a
 * normal page never silently becomes partial merely because a caller omitted
 * or undersized the optional Convex read budgets.
 */
function normalizeProjectPaginationOpts(options: ProjectPaginationInput): PaginationOptions {
  const floored = Number.isFinite(options.numItems) ? Math.floor(options.numItems) : MAX_PROJECT_PAGE_SIZE;
  const numItems = Math.min(Math.max(floored, 1), MAX_PROJECT_PAGE_SIZE);
  return {
    numItems,
    cursor: options.cursor,
    ...(options.endCursor === undefined ? {} : { endCursor: options.endCursor }),
    maximumRowsRead: boundedProjectBudget(options.maximumRowsRead, numItems + 1, MAX_PROJECT_PAGE_ROWS_READ),
    maximumBytesRead: boundedProjectBudget(options.maximumBytesRead, 1_000_000, MAX_PROJECT_PAGE_BYTES_READ),
  };
}

function paginationInfo(page: ProjectPaginationResult) {
  return {
    // Convex's native cursor remains valid at the end of a stream and is
    // required when the other streams still have pages.  `isDone` is the
    // authoritative stop signal; the legacy top-level alias below still
    // converts a completed evidence cursor to null.
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    ...(page.splitCursor === undefined ? {} : { splitCursor: page.splitCursor }),
    ...(page.pageStatus === undefined ? {} : { pageStatus: page.pageStatus }),
  };
}

function isInvalidPaginationCursor(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /InvalidCursor|invalid.*cursor|cursor.*invalid|cursor.*query|invalid.*json|unexpected token/i.test(message);
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function queryFromPayload(payload: string): string | undefined {
  const value = parseJson(payload);
  if (!isRecord(value) || typeof value.query !== "string") return undefined;
  return value.query;
}

function canonicalResearchPayload(query: string): string {
  return canonicalJson({ query });
}

/**
 * Scope-safe research query derivation.
 *
 * The F1 scope contract (shared/scope) admits only classifier-supported
 * segments into the bound grant/operation payload: every clause needs a
 * purchasing-research anchor, and order/purchase verbs ("buy", "purchase",
 * "pay", ...) are refused as unshipped purchase authority. A verbatim brief
 * such as "rent a place and buy everything needed" would therefore lose its
 * region and scope clauses at admission, and the provider would search a
 * generic query instead of the user's request. The authoritative
 * requirement keeps the exact brief; this builder derives a single query
 * clause that preserves the user's region and scope words: line breaks and
 * semicolons become commas (they are clause boundaries), refused
 * order/purchase verbs become the collection verb "source", and the
 * "supplier equipment scope" prefix keeps the clause admissible even when
 * the brief carries no anchor of its own. Anchor nouns already present in
 * the title, category, or brief ("supplier", "equipment", "budget") ride
 * along untouched.
 */
function scopeSafeQueryText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/;/g, ",")
    .replace(
      /\b(buy|buys|buying|purchase|purchases|purchasing|pay|pays|paying|paid|finance|finances|financing|sign|signs|signing)\b/gi,
      "source",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The Firecrawl intent is derived from the authoritative requirement,
 * including its hard constraints (region plus the exact opening brief):
 * without them the provider would search a generic query instead of the
 * user's request. The grant canonical payload binds to this exact intent.
 */
function boundedResearchIntent(requirement: {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly hardConstraints?: string;
}): string {
  const base =
    `Research suppliers for purchasing requirement ${scopeSafeQueryText(requirement.key)}: ` +
    `${scopeSafeQueryText(requirement.title)} (${scopeSafeQueryText(requirement.category)})`;
  const constraints = scopeSafeQueryText(requirement.hardConstraints ?? "");
  if (constraints.length === 0) return `${base}.`;
  return `${base}, supplier equipment scope: ${constraints}.`;
}

/**
 * F03 collection-target binding.
 *
 * The shared operation payload shape is frozen to exactly `{query}` by the
 * F1 scope contract, so the actual collection inputs (effective mode and
 * source URL) cannot travel inside `normalizedPayload`. They are bound into
 * the stored operation `requestId` instead, which is server-written at
 * request time and is part of the request-key retry identity. A same-key
 * retry or recovery that supplies a different mode/sourceUrl therefore
 * conflicts instead of returning the existing operation as success, and the
 * internal transport action re-derives its dispatch values from this stored
 * binding rather than trusting independently supplied scheduler arguments.
 *
 * Rows written before this binding carry a bare client requestId. Those
 * legacy rows keep query-only comparison; every row written by the request
 * and recovery paths below carries the bound form.
 */
const COLLECTION_BINDING_PREFIX = "r1cb1:";

interface CollectionTarget {
  readonly mode: ResearchMode;
  readonly sourceUrl?: string;
}

function effectiveCollectionMode(
  mode: ResearchMode | undefined,
  sourceUrl: string | undefined,
): ResearchMode {
  return mode ?? (sourceUrl === undefined ? "search" : "scrape");
}

function collectionTargetOf(
  mode: ResearchMode | undefined,
  sourceUrl: string | undefined,
  effectiveMode: ResearchMode,
): CollectionTarget {
  return sourceUrl === undefined ? { mode: effectiveMode } : { mode: effectiveMode, sourceUrl };
}

/** Server-owned encoding of one client requestId plus its collection target. */
function encodeCollectionRequestId(clientRequestId: string, target: CollectionTarget): string {
  return `${COLLECTION_BINDING_PREFIX}${JSON.stringify({ r: clientRequestId, m: target.mode, s: target.sourceUrl ?? null })}`;
}

function decodeCollectionRequestId(stored: string): {
  readonly clientRequestId: string;
  readonly binding: CollectionTarget | undefined;
} {
  if (!stored.startsWith(COLLECTION_BINDING_PREFIX)) return { clientRequestId: stored, binding: undefined };
  try {
    const value = JSON.parse(stored.slice(COLLECTION_BINDING_PREFIX.length)) as unknown;
    if (!isRecord(value) || typeof value.r !== "string") return { clientRequestId: stored, binding: undefined };
    if (value.m !== "search" && value.m !== "scrape" && value.m !== "map") {
      return { clientRequestId: stored, binding: undefined };
    }
    if (value.s !== null && value.s !== undefined && typeof value.s !== "string") {
      return { clientRequestId: stored, binding: undefined };
    }
    const binding: CollectionTarget =
      value.s === null || value.s === undefined ? { mode: value.m } : { mode: value.m, sourceUrl: value.s };
    return { clientRequestId: value.r, binding };
  } catch {
    return { clientRequestId: stored, binding: undefined };
  }
}

function collectionTargetsEqual(first: CollectionTarget, second: CollectionTarget): boolean {
  return first.mode === second.mode && (first.sourceUrl ?? undefined) === (second.sourceUrl ?? undefined);
}

interface ProjectRequestSibling {
  readonly operationId: Id<"operations">;
  readonly jobId: Id<"jobs">;
  readonly normalizedPayload: string;
  readonly state: string;
  readonly binding: CollectionTarget | undefined;
}

const COLLECTION_OPERATION_KIND = "research.collect";

/**
 * Collection requests use a project-scoped exact key. The generic operation
 * key is organization-scoped, which is correct for most operations but would
 * incorrectly couple two projects that reuse a client request ID. Keeping
 * the project in this opaque key lets one indexed lookup enforce both
 * cross-grant idempotency and cross-project isolation.
 */
function collectionRequestKey(
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  clientRequestId: string,
): string {
  return requestKey(`${organizationId}|${projectId}`, COLLECTION_OPERATION_KIND, clientRequestId);
}

function legacyCollectionRequestKey(organizationId: Id<"organizations">, requestId: string): string {
  return requestKey(organizationId, COLLECTION_OPERATION_KIND, requestId);
}

/**
 * `operations.create` derives its index key from the request ID it receives.
 * Use a project-bound temporary ID during that generic admission, then
 * replace it with the server-owned bound request ID and collection key in
 * this mutation. This preserves the target binding in `requestId` while the
 * exact project/client key remains independent of mode and source URL.
 */
function collectionCreationRequestId(projectId: Id<"projects">, boundRequestId: string): string {
  return `${projectId}|${boundRequestId}`;
}

/**
 * Rows written before the project-scoped request key fold the original
 * collection target into their organization-scoped key, so a changed-target
 * retry cannot recompute that exact key. Every bound requestId for one
 * client requestId shares this deterministic prefix regardless of the stored
 * mode or source URL, so one lexicographic range covers the whole legacy
 * bound-key family.
 */
function legacyBoundCollectionRequestKeyPrefix(
  organizationId: Id<"organizations">,
  clientRequestId: string,
): string {
  return legacyCollectionRequestKey(
    organizationId,
    `${COLLECTION_BINDING_PREFIX}{"r":${JSON.stringify(clientRequestId)},`,
  );
}

function collectionTargetMatches(
  binding: CollectionTarget | undefined,
  requestedTarget: CollectionTarget,
): boolean {
  // Rows written before F03 had no target binding. Those rows represented the
  // original default search operation; treating them as search keeps the
  // controlled fixture state readable while a changed mode/source conflicts.
  return collectionTargetsEqual(binding ?? { mode: "search" }, requestedTarget);
}

/**
 * Cross-grant request lookup for one logical project/client request ID.
 *
 * The primary probe is one exact project/client key, so grant rotation does
 * not enumerate active, revoked, or expired grants. Two legacy exact probes
 * keep the current controlled fixture rows readable, and one project-scoped
 * lexicographic range over `by_project_and_requestKey` covers every
 * previous-F03 bound key for this client requestId — the stored target
 * varies inside those keys, so no exact key can reach them after a target
 * change. Only rows written before the project-scoped key sort inside that
 * range, so it reads a closed historical set. Every probe is an indexed,
 * two-row maximum read and only rows belonging to this organization,
 * project, and operation kind participate.
 */
async function lookupProjectRequest(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  clientRequestId: string,
  requestedTarget: CollectionTarget,
): Promise<
  | { readonly ok: true; readonly sibling: ProjectRequestSibling | null }
  | { readonly ok: false; readonly code: "duplicate-conflict"; readonly message: string }
> {
  const boundRequestId = encodeCollectionRequestId(clientRequestId, requestedTarget);
  const keys = [
    collectionRequestKey(organizationId, projectId, clientRequestId),
    legacyCollectionRequestKey(organizationId, clientRequestId),
    legacyCollectionRequestKey(organizationId, boundRequestId),
  ];
  for (const key of [...new Set(keys)]) {
    const rows = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .take(2);
    if (rows.length > 1) {
      return {
        ok: false as const,
        code: "duplicate-conflict" as const,
        message: "requestId maps to multiple collection operations",
      };
    }
    const sibling = rows[0];
    if (
      sibling === undefined ||
      sibling.organizationId !== organizationId ||
      sibling.projectId !== projectId ||
      sibling.kind !== COLLECTION_OPERATION_KIND
    ) {
      continue;
    }
    const decoded = decodeCollectionRequestId(sibling.requestId);
    if (decoded.clientRequestId !== clientRequestId) continue;
    return {
      ok: true as const,
      sibling: {
        operationId: sibling._id,
        jobId: sibling.jobId,
        normalizedPayload: sibling.normalizedPayload,
        state: sibling.state,
        binding: decoded.binding,
      },
    };
  }
  // Previous-F03 bound rows cannot be reached by an exact key when the
  // requested target differs from the stored one. The project equality in
  // the index confines this prefix range to this project, so rows another
  // project wrote under the same client requestId never collide here.
  const boundKeyPrefix = legacyBoundCollectionRequestKeyPrefix(organizationId, clientRequestId);
  const boundRows = await ctx.db
    .query("operations")
    .withIndex("by_project_and_requestKey", (q) =>
      q
        .eq("projectId", projectId)
        .gte("requestKey", boundKeyPrefix)
        .lt("requestKey", `${boundKeyPrefix}\uFFFF`),
    )
    .take(2);
  if (boundRows.length > 1) {
    return {
      ok: false as const,
      code: "duplicate-conflict" as const,
      message: "requestId maps to multiple collection operations",
    };
  }
  const bound = boundRows[0];
  if (bound === undefined) return { ok: true as const, sibling: null };
  const decodedBound = decodeCollectionRequestId(bound.requestId);
  if (
    bound.organizationId !== organizationId ||
    bound.kind !== COLLECTION_OPERATION_KIND ||
    decodedBound.clientRequestId !== clientRequestId
  ) {
    return { ok: true as const, sibling: null };
  }
  return {
    ok: true as const,
    sibling: {
      operationId: bound._id,
      jobId: bound.jobId,
      normalizedPayload: bound.normalizedPayload,
      state: bound.state,
      binding: decodedBound.binding,
    },
  };
}

/**
 * Validate the collection target before any dispatch or accounting side
 * effect. Private/local source URLs are rejected here, including the search
 * path when a source URL is supplied alongside it.
 */
function validateCollectionTarget(
  mode: ResearchMode | undefined,
  sourceUrl: string | undefined,
):
  | { readonly ok: true; readonly effectiveMode: ResearchMode }
  | { readonly ok: false; readonly code: "invalid-payload"; readonly message: string } {
  if (mode === undefined && sourceUrl !== undefined) {
    return { ok: false as const, code: "invalid-payload", message: "mode is required when sourceUrl is supplied" };
  }
  const effectiveMode = effectiveCollectionMode(mode, sourceUrl);
  if (sourceUrl !== undefined && !isSafePublicSourceUrl(sourceUrl)) {
    return { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" };
  }
  if ((effectiveMode === "map" || effectiveMode === "scrape") && sourceUrl === undefined) {
    return { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" };
  }
  return { ok: true as const, effectiveMode };
}

function sourceKey(projectId: Id<"projects">, record: NormalizedSourceRecord): string {
  return `${projectId}|${record.contentHash}`;
}

function fieldKey(
  projectId: Id<"projects">,
  record: NormalizedSourceRecord,
  candidateId: Id<"candidates"> | undefined,
  field: string,
): string {
  return `${sourceKey(projectId, record)}|${candidateId ?? "source"}|${field}`;
}

function sourceOrigin(record: NormalizedSourceRecord): "live" | "recorded" | "fixture" {
  return record.executionMode;
}

function parseSourceHost(sourceUrl: string | undefined): string | undefined {
  if (sourceUrl === undefined) return undefined;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

async function requirementForOperation(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  operation: { readonly workflowAuthority?: unknown },
): Promise<Id<"requirements"> | undefined> {
  const authority = operation.workflowAuthority;
  // `workflowAuthority` is a discriminated union in the frozen schema.  The
  // runtime check keeps this helper safe for legacy rows whose field is
  // absent; the branded ID assertion is isolated at that validated boundary.
  const explicit =
    isRecord(authority) && typeof authority.requirementId === "string"
      ? (authority.requirementId as Id<"requirements">)
      : undefined;
  if (explicit !== undefined) {
    const requirement = await ctx.db.get(explicit);
    return requirement !== null && requirement.organizationId === organizationId && requirement.projectId === projectId
      ? explicit
      : undefined;
  }
  const candidates = await ctx.db
    .query("requirements")
    .withIndex("by_organization_and_project", (q) => q.eq("organizationId", organizationId).eq("projectId", projectId))
    .take(2);
  return candidates.length === 1 && candidates[0] !== undefined ? candidates[0]._id : undefined;
}

/** Read the immutable operation payload for the claimed internal action. */
export const readOperation = f1InternalQuery({
  args: { operationId: v.id("operations"), identity: v.string() },
  returns: internalReadResultValidator,
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation === null || operation.kind !== "research.collect") {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      "contributor",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const job = await ctx.db.get(operation.jobId);
    if (job === null || job.organizationId !== operation.organizationId || job.projectId !== operation.projectId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    return {
      ok: true as const,
      operationId: operation._id,
      jobId: operation.jobId,
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      grantId: operation.grantId,
      payload: operation.normalizedPayload,
      state: operation.state,
      requestId: operation.requestId,
    };
  },
});

/** Mark the current research job paused after a confirmed credit denial. */
export const pauseForCredit = f1InternalMutation({
  args: { operationId: v.id("operations"), identity: v.string() },
  returns: internalPauseResultValidator,
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation === null || operation.kind !== "research.collect") {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const job = await ctx.db.get(operation.jobId);
    const grant = await ctx.db.get(operation.grantId);
    if (
      job === null ||
      grant === null ||
      job.organizationId !== operation.organizationId ||
      job.projectId !== operation.projectId ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      "contributor",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (job.state === "cancelled" || job.state === "cancelling") {
      return { ok: true as const, jobId: job._id, state: job.state };
    }
    if (job.state !== "completed" && job.state !== "partial") {
      await ctx.db.patch(job._id, { state: "pausedBudget", updatedAt: Date.now() });
    }
    return { ok: true as const, jobId: job._id, state: "pausedBudget" };
  },
});

/**
 * Persist one validated provider result and settle the same F1 reservation.
 * Evidence is immutable and retained even when the grant input became stale
 * while the provider call was in flight.  No current quote row is touched by
 * this package, so stale evidence cannot overwrite a quote or selection.
 */
export const applyOutcome = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    token: v.string(),
    identity: v.string(),
    outcome: v.object({
      mode: researchModeValidator,
      records: v.array(normalizedSourceRecordValidator),
      capturedAt: v.number(),
      requestCount: v.number(),
      incompleteCount: v.number(),
      provider: v.literal("firecrawl"),
      controlled: v.boolean(),
    }),
  },
  returns: internalApplyResultValidator,
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation === null || operation.kind !== "research.collect") {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.state !== "dispatching" || operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for this operation" };
    }
    const access = await checkProjectAccess(
      ctx,
      args.identity,
      operation.organizationId,
      operation.projectId,
      "contributor",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const job = await ctx.db.get(operation.jobId);
    const grant = await ctx.db.get(operation.grantId);
    if (
      job === null ||
      grant === null ||
      job.organizationId !== operation.organizationId ||
      job.projectId !== operation.projectId ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const stale = canonicalJson(operation.inputVersions) !== canonicalJson(grant.inputVersions);
    const requirementId = await requirementForOperation(ctx, operation.organizationId, operation.projectId, operation);
    const records = args.outcome.records.slice(0, MAX_PROVIDER_RECORDS);
    for (const record of records) {
      const markerKey = `${sourceKey(operation.projectId, record)}|sourceSnapshot`;
      const marker = await ctx.db
        .query("productEvidence")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", operation.projectId).eq("idempotencyKey", markerKey),
        )
        .unique();
      if (marker !== null) {
        if (marker.organizationId !== operation.organizationId) {
          return { ok: false as const, code: "denied-project", message: "source evidence is not in this project" };
        }
        continue;
      }
      const now = Date.now();
      const evidenceId = await ctx.db.insert("evidence", {
        organizationId: operation.organizationId,
        projectId: operation.projectId,
        sourceKind: `firecrawl.${args.outcome.mode}`,
        ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
        ...(record.providerId === undefined ? {} : { providerIds: record.providerId }),
        capturedAt: record.capturedAt,
        contentHash: record.contentHash,
        completeness: record.completeness,
        counterpartyRole: record.counterpartyRole,
        executionMode: sourceOrigin(record),
        ...(record.sourceUrl === undefined ? {} : { locator: record.sourceUrl }),
      });
      const sourceEvidenceRef = {
        sourceId: evidenceId,
        version: String(record.capturedAt),
        ...(record.sourceUrl === undefined ? {} : { locator: record.sourceUrl }),
      };
      let candidateId: Id<"candidates"> | undefined;
      if (requirementId !== undefined && (record.productModel !== undefined || record.title !== undefined)) {
        const vendorName = record.vendorName ?? parseSourceHost(record.sourceUrl);
        if (vendorName !== undefined) {
          const vendorRows = await ctx.db
            .query("vendors")
            .withIndex("by_organization_and_name", (q) =>
              q.eq("organizationId", operation.organizationId).eq("name", vendorName),
            )
            .take(2);
          const existingVendor = vendorRows[0];
          const vendorId =
            existingVendor !== undefined
              ? existingVendor._id
              : await ctx.db.insert("vendors", {
                  organizationId: operation.organizationId,
                  name: vendorName,
                  regions: [],
                  createdAt: now,
                });
          const productModel = record.productModel ?? record.title ?? "Unknown model";
          const variant = record.variant ?? "Unknown variant";
          const variantKey = record.variantKey ?? `unknown|${record.contentHash}`;
          const requirement = await ctx.db.get(requirementId);
          const candidateRows = await ctx.db
            .query("candidates")
            .withIndex("by_requirement_and_variant", (q) =>
              q.eq("requirementId", requirementId).eq("variantKey", variantKey),
            )
            .take(33);
          if (candidateRows.length <= 32) {
            const existingCandidate = candidateRows.find((candidate) => candidate.vendorId === vendorId);
            candidateId =
              existingCandidate?._id ??
              (await ctx.db.insert("candidates", {
                organizationId: operation.organizationId,
                projectId: operation.projectId,
                requirementId,
                vendorId,
                productModel,
                variant,
                variantKey,
                compatibility: "unknown",
                compatibilityEvidenceRefs: [sourceEvidenceRef],
                ...(requirement?.version === undefined ? {} : { compatibilityRequirementVersion: requirement.version }),
                compatibilityRuleVersion: "r1-research-unknown-v1",
                compatibilityEvidenceIndexComplete: true,
                conversationState: "draft",
                createdAt: now,
              }));
          }
        }
      }
      const sourceMarkerFields = {
        organizationId: operation.organizationId,
        projectId: operation.projectId,
        ...(requirementId === undefined ? {} : { requirementId }),
        field: "sourceSnapshot",
        sourceKind: `firecrawl.${args.outcome.mode}`,
        ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
        capturedAt: record.capturedAt,
        originalValue: record.sourceUrl ?? record.contentHash,
        normalizedValue: record.contentHash,
        verification: "unverified" as const,
        freshness: "unknown" as const,
        counterpartyRole: record.counterpartyRole,
        executionMode: sourceOrigin(record),
        origin: "internal" as const,
        idempotencyKey: markerKey,
        conflictEvidenceIds: [] as Id<"productEvidence">[],
        version: String(record.capturedAt),
        createdAt: now,
      };
      await ctx.db.insert("productEvidence", sourceMarkerFields);
      const requestCountKey = `${sourceKey(operation.projectId, record)}|request-count`;
      const requestCountEvidence = await ctx.db
        .query("productEvidence")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", operation.projectId).eq("idempotencyKey", requestCountKey),
        )
        .unique();
      if (requestCountEvidence === null) {
        await ctx.db.insert("productEvidence", {
          organizationId: operation.organizationId,
          projectId: operation.projectId,
          ...(requirementId === undefined ? {} : { requirementId }),
          ...(candidateId === undefined ? {} : { candidateId }),
          field: "request-count",
          sourceKind: `firecrawl.${args.outcome.mode}`,
          ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
          capturedAt: record.capturedAt,
          originalValue: String(args.outcome.requestCount),
          normalizedValue: String(args.outcome.requestCount),
          verification: "unverified",
          freshness: "unknown",
          counterpartyRole: record.counterpartyRole,
          executionMode: sourceOrigin(record),
          origin: "internal",
          conflictEvidenceIds: [],
          idempotencyKey: requestCountKey,
          version: String(record.capturedAt),
          createdAt: now,
        });
      }
      for (const sourceClaim of record.claims) {
        const key = fieldKey(operation.projectId, record, candidateId, sourceClaim.field);
        const existing = await ctx.db
          .query("productEvidence")
          .withIndex("by_project_and_key", (q) => q.eq("projectId", operation.projectId).eq("idempotencyKey", key))
          .unique();
        if (existing !== null) continue;
        await ctx.db.insert("productEvidence", {
          organizationId: operation.organizationId,
          projectId: operation.projectId,
          ...(requirementId === undefined ? {} : { requirementId }),
          ...(candidateId === undefined ? {} : { candidateId }),
          field: sourceClaim.field,
          sourceKind: `firecrawl.${args.outcome.mode}`,
          ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
          capturedAt: record.capturedAt,
          originalValue: sourceClaim.originalValue,
          normalizedValue: sourceClaim.normalizedValue,
          verification: sourceClaim.verification,
          freshness: sourceClaim.freshness,
          ...(sourceClaim.freshness === "unknown" ? {} : { lastCheckedAt: record.capturedAt }),
          counterpartyRole: record.counterpartyRole,
          executionMode: sourceOrigin(record),
          origin: "internal",
          conflictEvidenceIds: [],
          idempotencyKey: key,
          version: String(record.capturedAt),
          createdAt: now,
        });
      }
      for (const missing of record.missingFields) {
        const key = fieldKey(operation.projectId, record, candidateId, `missing:${missing}`);
        const existing = await ctx.db
          .query("productEvidence")
          .withIndex("by_project_and_key", (q) => q.eq("projectId", operation.projectId).eq("idempotencyKey", key))
          .unique();
        if (existing !== null) continue;
        await ctx.db.insert("productEvidence", {
          organizationId: operation.organizationId,
          projectId: operation.projectId,
          ...(requirementId === undefined ? {} : { requirementId }),
          ...(candidateId === undefined ? {} : { candidateId }),
          field: `missing:${missing}`,
          sourceKind: `firecrawl.${args.outcome.mode}`,
          ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
          capturedAt: record.capturedAt,
          originalValue: "unknown",
          normalizedValue: "unknown",
          verification: "unverified",
          freshness: "unknown",
          counterpartyRole: record.counterpartyRole,
          executionMode: sourceOrigin(record),
          origin: "internal",
          conflictEvidenceIds: [],
          idempotencyKey: key,
          version: String(record.capturedAt),
          createdAt: now,
        });
      }
      // Keep the evidence ref in a material event only through the immutable
      // product/evidence rows.  Existing F1 has no research-event table and
      // this package cannot alter the frozen schema.
      void evidenceId;
    }

    const outcome = await ctx.runMutation(recordOutcomeRef, {
      operationId: args.operationId,
      token: args.token,
      outcome: "success",
      provider: "firecrawl",
      environment: args.outcome.controlled ? "controlled" : "production",
      providerEventId: `firecrawl:${args.operationId}:${args.outcome.capturedAt}`,
      detail: stale ? "stale-result-preserved-as-evidence" : "research-result-recorded",
    });
    if (!outcome.ok) return { ok: false as const, code: outcome.code, message: outcome.message };
    const resultingState = job.state === "cancelled" || job.state === "cancelling"
      ? job.state
      : records.length === 0 || args.outcome.incompleteCount > 0 || stale
        ? "partial"
        : "completed";
    if (job.state !== "cancelled" && job.state !== "cancelling") {
      await ctx.db.patch(job._id, { state: resultingState, updatedAt: Date.now() });
    }
    return {
      ok: true as const,
      jobId: job._id,
      state: resultingState,
      requestCount: args.outcome.requestCount,
      incompleteCount: args.outcome.incompleteCount,
      controlled: args.outcome.controlled,
      stale,
    };
  },
});

/**
 * Internal transport action.  `controlledResponseJson` is only for the
 * controlled test path and is never accepted by a public function.  A
 * provider-mode invocation calls Firecrawl once; Firecrawl's own component
 * performs the documented initial request plus at most three transient
 * retries.  There is no workflow retry multiplier here.
 */
export const execute = internalAction({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    mode: researchModeValidator,
    sourceUrl: v.optional(v.string()),
    controlledResponseJson: v.optional(v.string()),
    controlled: v.optional(v.boolean()),
  },
  returns: executionResultValidator,
  handler: async (ctx, args) => {
    if (args.identity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "missing operation identity" };
    }
    const operation = await ctx.runQuery(researchInternal.research.collection.readOperation, {
      operationId: args.operationId,
      identity: args.identity,
    });
    if (!operation.ok) return operation;
    // F03: the dispatch target is server-derived from the stored request
    // binding. Scheduler arguments that disagree with the bound mode or
    // source URL are rejected before the claim, so a changed-input retry can
    // never dispatch or consume accounting under another request's identity.
    // Private/local source URLs are likewise rejected before the claim, for
    // both the live and the controlled paths. Rows written before the binding
    // keep the previous scheduler-argument behavior.
    const storedBinding = decodeCollectionRequestId(operation.requestId).binding;
    const requestedTarget = collectionTargetOf(args.mode, args.sourceUrl, args.mode);
    if (storedBinding !== undefined && !collectionTargetsEqual(requestedTarget, storedBinding)) {
      return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
    }
    const effectiveMode = storedBinding?.mode ?? args.mode;
    const effectiveSourceUrl = storedBinding?.sourceUrl ?? args.sourceUrl ?? undefined;
    const targetCheck = validateCollectionTarget(effectiveMode, effectiveSourceUrl);
    if (!targetCheck.ok) {
      return { ok: false as const, code: targetCheck.code, message: targetCheck.message };
    }
    const claim = await ctx.runMutation(
      makeInternalMutationRef<ClaimArgs, ClaimReturn>("execution/operations:claim"),
      { operationId: args.operationId, identity: args.identity },
    );
    if (!claim.ok) return { ok: false as const, code: claim.code, message: claim.message };
    let response: unknown;
    let executionMode: ResearchExecutionMode = args.controlled === true ? "fixture" : "live";
    try {
      if (args.controlledResponseJson !== undefined) {
        if (new TextEncoder().encode(args.controlledResponseJson).byteLength > 256_000) {
          response = effectiveMode === "scrape"
            ? {
                url: effectiveSourceUrl,
                title: "Controlled oversized source",
                markdown: "Source payload exceeded the application capture bound.",
                truncated: true,
              }
            : effectiveMode === "map"
              ? {
                  links: [
                    {
                      url: effectiveSourceUrl,
                      title: "Controlled oversized source",
                      truncated: true,
                    },
                  ],
                }
              : {
                  web: [
                    {
                      url: effectiveSourceUrl,
                      title: "Controlled oversized source",
                      truncated: true,
                      description: "Source payload exceeded the application capture bound.",
                    },
                  ],
                };
        } else {
          response = parseJson(args.controlledResponseJson);
        }
        if (response === null) {
          const outcome = await ctx.runMutation(researchInternal.research.collection.applyOutcome, {
            operationId: args.operationId,
            token: claim.attemptToken,
            identity: args.identity,
            outcome: normalizeProviderResponse({
              mode: effectiveMode,
              response: {},
              capturedAt: Date.now(),
              ...(effectiveSourceUrl === undefined ? {} : { sourceUrl: effectiveSourceUrl }),
              executionMode,
            }),
          });
          if (!outcome.ok) return outcome;
          return {
            ok: true as const,
            jobId: outcome.jobId,
            operationId: args.operationId,
            state: outcome.state,
            requestCount: outcome.requestCount,
            incompleteCount: outcome.incompleteCount,
            controlled: outcome.controlled,
            stale: outcome.stale,
          };
        }
      } else {
        if (effectiveMode === "search") {
          response = await firecrawl.search(ctx, queryFromPayload(operation.payload) ?? "", {
            sources: ["web"],
            limit: 10,
            highlights: true,
          });
        } else if (effectiveMode === "map") {
          response = await firecrawl.map(ctx, effectiveSourceUrl ?? "", { limit: 20, sitemap: "include" });
        } else {
          response = await firecrawl.scrape(ctx, effectiveSourceUrl ?? "", {
            formats: [
              "markdown",
              "links",
              {
                type: "json",
                schema: {
                  type: "object",
                  properties: {
                    vendorName: { type: "string" },
                    productModel: { type: "string" },
                    variant: { type: "string" },
                    price: { type: ["number", "string"] },
                    currency: { type: "string" },
                    availability: { type: "string" },
                    delivery: { type: "string" },
                    serviceCoverage: { type: "string" },
                    warranty: { type: "string" },
                  },
                },
              },
            ],
            onlyMainContent: true,
            location: { country: "NL", languages: ["en", "nl"] },
          });
        }
      }
      const normalized = normalizeProviderResponse({
        mode: effectiveMode,
        response,
        capturedAt: Date.now(),
        ...(effectiveSourceUrl === undefined ? {} : { sourceUrl: effectiveSourceUrl }),
        executionMode,
      });
      const applied = await ctx.runMutation(researchInternal.research.collection.applyOutcome, {
        operationId: args.operationId,
        token: claim.attemptToken,
        identity: args.identity,
        outcome: normalized,
      });
      if (!applied.ok) return applied;
      return {
        ok: true as const,
        jobId: applied.jobId,
        operationId: args.operationId,
        state: applied.state,
        requestCount: applied.requestCount,
        incompleteCount: applied.incompleteCount,
        controlled: applied.controlled,
        stale: applied.stale,
      };
    } catch (error) {
      const classified = classifyFirecrawlError(error);
      const recorded = await ctx.runMutation(recordOutcomeRef, {
        operationId: args.operationId,
        token: claim.attemptToken,
        outcome: "failure",
        provider: "firecrawl",
        environment: args.controlled === true ? "controlled" : "production",
        providerEventId: `firecrawl:error:${args.operationId}:${Date.now()}`,
        unknownCharges: classified.unknownCharges,
        detail: `${classified.code}:${classified.status ?? "none"}`,
      });
      if (!recorded.ok) return recorded;
      if (classified.code === "credits") {
        await ctx.runMutation(researchInternal.research.collection.pauseForCredit, {
          operationId: args.operationId,
          identity: args.identity,
        });
      }
      return {
        ok: false as const,
        code: classified.code === "credits" ? "allowance-exhausted" : "provider-failure",
        message: classified.code === "credits" ? "Firecrawl credits are exhausted; research is paused" : "Firecrawl collection failed after its bounded transport attempts",
      };
    }
  },
});

function makeInternalMutationRef<A extends DefaultFunctionArgs, R>(path: string): FunctionReference<"mutation", "internal", A, R> {
  const ref = internal as unknown as Record<string, unknown>;
  // Generated `internal` is a path proxy.  This helper keeps the stale-codegen
  // cast at one boundary while callers retain exact argument and return types.
  const parts = path.split(":");
  const modulePath = parts[0]?.split("/") ?? [];
  const functionName = parts[1] ?? "";
  let cursor: unknown = ref;
  for (const part of modulePath) {
    if (typeof cursor !== "object" || cursor === null) break;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor !== "object" || cursor === null) {
    throw new Error(`invalid internal function path ${path}`);
  }
  return (cursor as Record<string, unknown>)[functionName] as FunctionReference<"mutation", "internal", A, R>;
}

function makeInternalActionRef<A extends DefaultFunctionArgs, R>(path: string): FunctionReference<"action", "internal", A, R> {
  const ref = internal as unknown as Record<string, unknown>;
  const parts = path.split(":");
  const modulePath = parts[0]?.split("/") ?? [];
  const functionName = parts[1] ?? "";
  let cursor: unknown = ref;
  for (const part of modulePath) {
    if (typeof cursor !== "object" || cursor === null) break;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor !== "object" || cursor === null) {
    throw new Error(`invalid internal function path ${path}`);
  }
  return (cursor as Record<string, unknown>)[functionName] as FunctionReference<"action", "internal", A, R>;
}

/** Public entry point: authorize, reserve, create, and schedule one call. */
export const requestResearchWithoutGrant = f1Mutation({
  args: {
    projectId: v.id("projects"),
    requirementVersionId: v.optional(v.id("requirements")),
    requirementId: v.optional(v.id("requirements")),
    researchIntent: v.string(),
    requestId: v.string(),
    mode: v.optional(researchModeValidator),
    sourceUrl: v.optional(v.string()),
  },
  returns: researchResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    if (args.requestId.trim().length === 0 || args.researchIntent.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "research intent and requestId are required" };
    }
    const targetCheck = validateCollectionTarget(args.mode, args.sourceUrl);
    if (!targetCheck.ok) {
      return { ok: false as const, code: targetCheck.code, message: targetCheck.message };
    }
    const project = await ctx.db.get(args.projectId);
    if (project === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "contributor", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const requirementId = args.requirementVersionId ?? args.requirementId;
    if (requirementId !== undefined) {
      const requirement = await ctx.db.get(requirementId);
      if (
        requirement === null ||
        requirement.organizationId !== project.organizationId ||
        requirement.projectId !== project._id ||
        requirement.state === "cancelled"
      ) {
        return { ok: false as const, code: "denied-project", message: "requirement is not in this project" };
      }
    }
    const operationPayload = canonicalResearchPayload(args.researchIntent);
    const requestedTarget = collectionTargetOf(args.mode, args.sourceUrl, targetCheck.effectiveMode);
    const existingLookup = await lookupProjectRequest(
      ctx,
      project.organizationId,
      project._id,
      args.requestId,
      requestedTarget,
    );
    if (!existingLookup.ok) return existingLookup;
    const existing = existingLookup.sibling;
    if (existing !== null) {
      if (
        existing.normalizedPayload !== operationPayload ||
        !collectionTargetMatches(existing.binding, requestedTarget)
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      const existingJob = await ctx.db.get(existing.jobId);
      if (existingJob === null || existingJob.organizationId !== project.organizationId || existingJob.projectId !== project._id) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      return {
        ok: true as const,
        jobId: existing.jobId,
        operationId: existing.operationId,
        state: existingJob.state,
        requestCount: existing.state === "observedSuccess" ? 1 : 0,
        incompleteCount: existing.state === "observedSuccess" ? 0 : 0,
        controlled: false,
      };
    }
    // A no-grant automatic F1 job deliberately carries a zero cost ceiling;
    // it cannot dispatch a paid Firecrawl call.  Require an explicit grant
    // through the separate recovery path rather than silently creating work
    // that can never claim its reservation.
    return {
      ok: false as const,
      code: "allowance-exhausted",
      message: "research requires an explicit approved grant and provider allowance",
    };
  },
});

/**
 * Grant-bound request variant.  It is separate from the sponsor-shaped
 * public entry point so callers cannot accidentally create a no-spend job.
 */
export const requestGrantedResearch = f1Mutation({
  args: {
    projectId: v.id("projects"),
    requirementVersionId: v.optional(v.id("requirements")),
    requirementId: v.optional(v.id("requirements")),
    researchIntent: v.string(),
    requestId: v.string(),
    grantId: v.id("grants"),
    mode: v.optional(researchModeValidator),
    sourceUrl: v.optional(v.string()),
  },
  returns: researchResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    if (args.requestId.trim().length === 0 || args.researchIntent.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "research intent and requestId are required" };
    }
    const targetCheck = validateCollectionTarget(args.mode, args.sourceUrl);
    if (!targetCheck.ok) {
      return { ok: false as const, code: targetCheck.code, message: targetCheck.message };
    }
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "contributor", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const grant = await ctx.db.get(args.grantId);
    if (grant === null || grant.organizationId !== project.organizationId || grant.projectId !== project._id) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const requirementId = args.requirementVersionId ?? args.requirementId;
    if (requirementId !== undefined) {
      const requirement = await ctx.db.get(requirementId);
      if (requirement === null || requirement.organizationId !== project.organizationId || requirement.projectId !== project._id || requirement.state === "cancelled") {
        return { ok: false as const, code: "denied-project", message: "requirement is not in this project" };
      }
    }
    const operationPayload = canonicalResearchPayload(args.researchIntent);
    if (grant.canonicalPayload !== operationPayload) {
      return { ok: false as const, code: "changed-draft", message: "research intent does not match the approved grant" };
    }
    // F03: the stored request identity binds the client requestId together
    // with the effective collection target. The separate project-scoped
    // request key makes this lookup exact across grant rotation while a
    // changed mode or source URL still conflicts before any job, reservation,
    // or dispatch side effect.
    const requestedTarget = collectionTargetOf(args.mode, args.sourceUrl, targetCheck.effectiveMode);
    const boundRequestId = encodeCollectionRequestId(args.requestId, requestedTarget);
    const crossGrant = await lookupProjectRequest(
      ctx,
      project.organizationId,
      project._id,
      args.requestId,
      requestedTarget,
    );
    if (!crossGrant.ok) return crossGrant;
    const sibling = crossGrant.sibling;
    if (sibling !== null) {
      if (sibling.normalizedPayload !== operationPayload) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      if (!collectionTargetMatches(sibling.binding, requestedTarget)) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      const existingJob = await ctx.db.get(sibling.jobId);
      if (
        existingJob === null ||
        existingJob.organizationId !== project.organizationId ||
        existingJob.projectId !== project._id
      ) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      return { ok: true as const, jobId: sibling.jobId, operationId: sibling.operationId, state: existingJob.state, requestCount: 0, incompleteCount: 0, controlled: false };
    }
    const pausedJobs = await ctx.db.query("jobs").withIndex("by_project", (q) => q.eq("projectId", project._id)).take(MAX_PROJECT_RECORDS + 1);
    if (pausedJobs.length > MAX_PROJECT_RECORDS || pausedJobs.some((job) => job.state === "pausedBudget")) {
      return { ok: false as const, code: "allowance-exhausted", message: "research is paused until the provider allowance is recovered" };
    }
    const started = await ctx.runMutation(startJobRef, {
      organizationId: project.organizationId,
      projectId: project._id,
      text: args.researchIntent,
      operationId: "research.collect",
      kind: "research",
      grantId: args.grantId,
    });
    if (!started.ok) return started;
    const reserved = await ctx.runMutation(reserveRef, {
      jobId: started.jobId,
      organizationId: project.organizationId,
      projectId: project._id,
      amountMicroUsd: FIRECRAWL_CALL_MAX_COST_MICRO_USD,
      pricingBasis: FIRECRAWL_PRICING_BASIS,
    });
    if (!reserved.ok) {
      if (reserved.code === "allowance-exhausted") {
        return {
          ok: true as const,
          jobId: started.jobId,
          operationId: null,
          state: "pausedBudget",
          requestCount: 0,
          incompleteCount: 0,
          controlled: false,
          recovery: "increase-provider-allowance-or-resume",
        };
      }
      await ctx.runMutation(cancelJobRef, { jobId: started.jobId, reason: "research reservation could not be created" });
      return reserved;
    }
    const created = await ctx.runMutation(createOperationRef, {
      jobId: started.jobId,
      organizationId: project.organizationId,
      projectId: project._id,
      kind: COLLECTION_OPERATION_KIND,
      requestId: collectionCreationRequestId(project._id, boundRequestId),
      payloadJson: operationPayload,
      grantId: args.grantId,
      reservationId: reserved.reservationId,
    });
    if (!created.ok) {
      await ctx.runMutation(cancelJobRef, { jobId: started.jobId, reason: "research operation could not be created" });
      return created;
    }
    await ctx.db.patch(created.operationId, {
      requestId: boundRequestId,
      requestKey: collectionRequestKey(project.organizationId, project._id, args.requestId),
    });
    await ctx.scheduler.runAfter(0, makeInternalActionRef<ExecuteArgs, ExecuteReturn>("research/collection:execute"), {
      operationId: created.operationId,
      identity,
      mode: requestedTarget.mode,
      ...(requestedTarget.sourceUrl === undefined ? {} : { sourceUrl: requestedTarget.sourceUrl }),
    });
    return {
      ok: true as const,
      jobId: started.jobId,
      operationId: created.operationId,
      state: "queued",
      requestCount: 0,
      incompleteCount: 0,
      controlled: false,
    };
  },
});

const requestGrantedResearchSelfRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requestGrantedResearch>,
  MutationReturn<typeof requestGrantedResearch>
>("research/collection:requestGrantedResearch");

/**
 * One-click bounded Firecrawl search for the one current requirement.
 *
 * This is the production-safe path behind the workbench's "Start bounded
 * research" action. One explicit call atomically and idempotently admits and
 * schedules exactly one bounded `search` collection for the exact
 * project/requirement binding it names:
 *
 * - Authority: authenticated owner/approver project role plus the enabled
 *   `research.collect` capability. Contributors, viewers, and foreign
 *   identities are denied with zero new effect.
 * - Binding: the requirement must belong to the same organization/project,
 *   stay in a current (non-terminal) state, and carry the exact version the
 *   caller validated. A cross-project requirement or a changed version is
 *   denied before any grant, job, reservation, operation, or provider call.
 * - Allowance: the shared organization ledger is admitted (and initialized
 *   once from the server-only allowance) before any grant exists. A missing
 *   or invalid allowance fails with no grant, job, reservation, operation,
 *   or provider call.
 * - Effect: a finite grant (exactly one maximum Firecrawl call) is issued
 *   and the existing `requestGrantedResearch` contract performs the
 *   reservation, operation creation, and internal-action scheduling, so no
 *   reservation, claim, spend, retry, or provenance fence is bypassed.
 * - Idempotency: an exact replay of the idempotency key returns the original
 *   job and operation with no second grant, job, reservation, operation, or
 *   provider call. The same key with a different payload or target
 *   conflicts instead of replaying.
 */
export const requestBoundedResearch = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    requirementVersion: v.number(),
    idempotencyKey: v.string(),
  },
  returns: researchResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(args.idempotencyKey)) {
      return { ok: false as const, code: "invalid-payload", message: "idempotencyKey must be 8-128 chars of A-Za-z0-9:_-" };
    }
    if (!Number.isSafeInteger(args.requirementVersion) || args.requirementVersion < 0) {
      return { ok: false as const, code: "invalid-payload", message: "requirementVersion must be a non-negative safe integer" };
    }
    const now = Date.now();
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability("research.collect", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    const requirement = await ctx.db.get(args.requirementId);
    if (
      requirement === null ||
      requirement.organizationId !== args.organizationId ||
      requirement.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "requirement is not in this project" };
    }
    if (requirement.state === "selected" || requirement.state === "fulfilled" || requirement.state === "cancelled") {
      return { ok: false as const, code: "stale-requirement", message: "requirement is no longer current; research was not started" };
    }
    if (requirement.version !== args.requirementVersion) {
      return { ok: false as const, code: "changed-requirement", message: "requirement changed since this research was prepared; renewed authority required" };
    }
    if (
      requirement.key.trim().length === 0 ||
      requirement.title.trim().length === 0 ||
      requirement.category.trim().length === 0
    ) {
      return { ok: false as const, code: "invalid-payload", message: "the current requirement is incomplete, so research was not started" };
    }
    const researchIntent = boundedResearchIntent(requirement);
    const operationPayload = canonicalResearchPayload(researchIntent);
    const requestedTarget = { mode: "search" } as const;
    const targetCheck = validateCollectionTarget(requestedTarget.mode, undefined);
    if (!targetCheck.ok) {
      return { ok: false as const, code: targetCheck.code, message: targetCheck.message };
    }
    // Exact replay returns the original job and operation before any grant
    // is issued, so a double-click or reload mints no second effect. A
    // stored row with a different payload or target conflicts instead.
    const replay = await lookupProjectRequest(
      ctx,
      args.organizationId,
      args.projectId,
      args.idempotencyKey,
      requestedTarget,
    );
    if (!replay.ok) return replay;
    if (replay.sibling !== null) {
      if (replay.sibling.normalizedPayload !== operationPayload) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      if (!collectionTargetMatches(replay.sibling.binding, requestedTarget)) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      const existingJob = await ctx.db.get(replay.sibling.jobId);
      if (
        existingJob === null ||
        existingJob.organizationId !== args.organizationId ||
        existingJob.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      return {
        ok: true as const,
        jobId: replay.sibling.jobId,
        operationId: replay.sibling.operationId,
        state: existingJob.state,
        requestCount: 0,
        incompleteCount: 0,
        controlled: false,
      };
    }
    // The shared ledger must exist (or be initialized once from the
    // server-only allowance) before any grant, job, or reservation exists.
    const allowance = await ensureSharedBudget(ctx, args.organizationId, {
      minimumMicroUsd: FIRECRAWL_CALL_MAX_COST_MICRO_USD,
      pricingBasis: RESEARCH_ALLOWANCE_PRICING_BASIS,
    });
    if (!allowance.ok) return allowance;
    const recipient = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
    // One finite grant: exactly one maximum Firecrawl call, bound to the
    // exact project/requirement authority the checks above established.
    const grantId = await ctx.db.insert("grants", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      operations: ["research.collect"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: recipient?.version ?? 0,
      inputVersions: {},
      canonicalPayload: operationPayload,
      payloadHash: payloadHash({ query: researchIntent }),
      payloadSha256: await sha256HexOfCanonical(operationPayload),
      workflowAuthorities: [
        { operationId: "research.collect", projectId: args.projectId, requirementId: args.requirementId },
      ],
      costCeilingMicroUsd: FIRECRAWL_CALL_MAX_COST_MICRO_USD,
      roundLimit: 3,
      expiresAt: now + 900_000,
      revocationVersion: 1,
      status: "active",
      createdAt: now,
    });
    // The existing grant-bound contract performs the job admission,
    // bounded reservation, operation creation, and internal-action
    // scheduling, so this path cannot bypass any of those fences.
    return await ctx.runMutation(requestGrantedResearchSelfRef, {
      projectId: args.projectId,
      requirementId: args.requirementId,
      researchIntent,
      requestId: args.idempotencyKey,
      grantId,
      mode: "search",
    });
  },
});

/** Cancel a research job through the shared F1 cancellation fence. */
export const cancelResearch = f1Mutation({
  args: { jobId: v.id("jobs"), reason: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      state: v.string(),
      unresolvedOperationIds: v.array(v.id("operations")),
      complete: v.boolean(),
      reconciliationComplete: v.boolean(),
      unresolvedOperationCount: v.number(),
      phase: v.string(),
      processedOperations: v.number(),
      processedReservations: v.number(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.kind !== "research") return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, identity, job.organizationId, job.projectId, "contributor", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return await ctx.runMutation(cancelJobRef, args);
  },
});

/** Bounded explicit recovery.  Recovery always creates a fresh reservation and request key. */
export const recoverResearch = f1Mutation({
  args: {
    jobId: v.id("jobs"),
    operationId: v.id("operations"),
    requestId: v.string(),
    mode: researchModeValidator,
    sourceUrl: v.optional(v.string()),
  },
  returns: researchRecoveryResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    if (args.requestId.trim().length === 0) return { ok: false as const, code: "invalid-payload", message: "requestId required" };
    const recoveryTargetCheck = validateCollectionTarget(args.mode, args.sourceUrl);
    if (!recoveryTargetCheck.ok) {
      return { ok: false as const, code: recoveryTargetCheck.code, message: recoveryTargetCheck.message };
    }
    const operation = await ctx.db.get(args.operationId);
    const job = await ctx.db.get(args.jobId);
    if (
      operation === null ||
      job === null ||
      operation.jobId !== job._id ||
      operation.kind !== "research.collect" ||
      job.kind !== "research" ||
      operation.organizationId !== job.organizationId ||
      operation.projectId !== job.projectId
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(ctx, identity, job.organizationId, job.projectId, "contributor", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (job.state === "cancelled" || job.state === "cancelling") return { ok: false as const, code: "cancelled-before-claim", message: "job is fenced for cancellation" };
    // F03: recovery re-runs the original collection target. A recovery that
    // supplies another mode or source URL conflicts before any job patch,
    // reservation, or dispatch side effect. Legacy rows without a stored
    // binding adopt the requested target going forward.
    const originalBinding = decodeCollectionRequestId(operation.requestId).binding;
    const requestedRecoveryTarget = collectionTargetOf(args.mode, args.sourceUrl, args.mode);
    if (originalBinding !== undefined && !collectionTargetsEqual(requestedRecoveryTarget, originalBinding)) {
      return { ok: false as const, code: "duplicate-conflict", message: "recovery target does not match the original collection target" };
    }
    const recoveryTarget = originalBinding ?? requestedRecoveryTarget;
    const siblingOperations = await ctx.db.query("operations").withIndex("by_job", (q) => q.eq("jobId", job._id)).take(MAX_OPERATIONS_PER_JOB + 1);
    const recoveryCount = siblingOperations.filter((entry) =>
      decodeCollectionRequestId(entry.requestId).clientRequestId.startsWith(`${args.operationId}:recovery:`),
    ).length;
    if (recoveryCount >= MAX_RECOVERY_OPERATIONS) return { ok: false as const, code: "round-limit-exceeded", message: "bounded research recovery exhausted" };
    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.status !== "active" ||
      grant.revocationVersion !== operation.grantVersion ||
      canonicalJson(grant.inputVersions) !== canonicalJson(operation.inputVersions)
    ) {
      return { ok: false as const, code: "stale-grant-version", message: "research authority is stale; review is required" };
    }
    if (
      job.state !== "pausedBudget" &&
      job.state !== "failed" &&
      job.state !== "partial" &&
      operation.state !== "outcomeUnknown"
    ) {
      return { ok: false as const, code: "invalid-payload", message: "research recovery requires an incomplete or unresolved job" };
    }
    if (job.state === "pausedBudget" || job.state === "failed" || job.state === "partial") {
      await ctx.db.patch(job._id, { state: "queued", updatedAt: Date.now() });
    }
    const reserved = await ctx.runMutation(reserveRef, {
      jobId: job._id,
      organizationId: job.organizationId,
      projectId: job.projectId,
      amountMicroUsd: FIRECRAWL_CALL_MAX_COST_MICRO_USD,
      pricingBasis: FIRECRAWL_PRICING_BASIS,
    });
    if (!reserved.ok) return reserved;
    const payload = operation.normalizedPayload;
    const recoveryClientRequestId = `${args.operationId}:recovery:${args.requestId}`;
    const recoveryRequestId = encodeCollectionRequestId(recoveryClientRequestId, recoveryTarget);
    const created = await ctx.runMutation(createOperationRef, {
      jobId: job._id,
      organizationId: job.organizationId,
      projectId: job.projectId,
      kind: COLLECTION_OPERATION_KIND,
      requestId: collectionCreationRequestId(job.projectId, recoveryRequestId),
      payloadJson: payload,
      grantId: operation.grantId,
      reservationId: reserved.reservationId,
    });
    if (!created.ok) return created;
    await ctx.db.patch(created.operationId, {
      requestId: recoveryRequestId,
      requestKey: collectionRequestKey(job.organizationId, job.projectId, recoveryClientRequestId),
    });
    await ctx.scheduler.runAfter(0, makeInternalActionRef<ExecuteArgs, ExecuteReturn>("research/collection:execute"), {
      operationId: created.operationId,
      identity,
      mode: recoveryTarget.mode,
      ...(recoveryTarget.sourceUrl === undefined ? {} : { sourceUrl: recoveryTarget.sourceUrl }),
    });
    return { ok: true as const, jobId: job._id, operationId: created.operationId, state: "queued" };
  },
});

const projectResearchPageArgs = {
  projectId: v.id("projects"),
  identity: v.string(),
  paginationOpts: paginationOptsValidator,
};

/** One bounded native pagination stream for evidence. */
export const projectResearchEvidencePage = f1InternalQuery({
  args: projectResearchPageArgs,
  returns: v.union(projectResearchEvidencePageValidator, denialValidator),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, args.identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    try {
      const page = await ctx.db
        .query("evidence")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .order("desc")
        .paginate(normalizeProjectPaginationOpts(args.paginationOpts));
      const evidence = page.page.filter((row) => row.organizationId === project.organizationId).map((row) => ({
        id: row._id,
        projectId: row.projectId,
        sourceKind: row.sourceKind,
        ...(row.sourceUrl === undefined ? {} : { sourceUrl: row.sourceUrl }),
        ...(row.providerIds === undefined ? {} : { providerIds: row.providerIds }),
        capturedAt: row.capturedAt,
        contentHash: row.contentHash,
        completeness: row.completeness,
        counterpartyRole: row.counterpartyRole,
        executionMode: row.executionMode,
        ...(row.locator === undefined ? {} : { locator: row.locator }),
      }));
      return {
        ok: true as const,
        projectId: project._id,
        evidence,
        pagination: paginationInfo(page),
        progress: {
          returned: evidence.length,
          complete: evidence.filter((row) => row.completeness === "complete").length,
          partial: evidence.filter((row) => row.completeness === "partial").length,
          unavailable: evidence.filter((row) => row.completeness === "unavailable").length,
        },
      };
    } catch (error) {
      if (isInvalidPaginationCursor(error)) {
        return { ok: false as const, code: "invalid-pagination", message: "pagination cursor is invalid for this research stream" };
      }
      throw error;
    }
  },
});

/** One bounded native pagination stream for normalized claims. */
export const projectResearchClaimsPage = f1InternalQuery({
  args: projectResearchPageArgs,
  returns: v.union(projectResearchClaimsPageValidator, denialValidator),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, args.identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    try {
      const page = await ctx.db
        .query("productEvidence")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .order("desc")
        .paginate(normalizeProjectPaginationOpts(args.paginationOpts));
      const claims = page.page.filter((row) => row.organizationId === project.organizationId).map((row) => ({
        id: row._id,
        ...(row.requirementId === undefined ? {} : { requirementId: row.requirementId }),
        ...(row.candidateId === undefined ? {} : { candidateId: row.candidateId }),
        field: row.field,
        sourceKind: row.sourceKind,
        ...(row.sourceUrl === undefined ? {} : { sourceUrl: row.sourceUrl }),
        capturedAt: row.capturedAt,
        originalValue: row.originalValue,
        normalizedValue: row.normalizedValue,
        verification: row.verification,
        freshness: row.freshness,
        ...(row.lastCheckedAt === undefined ? {} : { lastCheckedAt: row.lastCheckedAt }),
        counterpartyRole: row.counterpartyRole,
        executionMode: row.executionMode,
        origin: row.origin,
      }));
      return {
        ok: true as const,
        projectId: project._id,
        claims,
        pagination: paginationInfo(page),
        progress: { returned: claims.length },
      };
    } catch (error) {
      if (isInvalidPaginationCursor(error)) {
        return { ok: false as const, code: "invalid-pagination", message: "pagination cursor is invalid for this research stream" };
      }
      throw error;
    }
  },
});

/** One bounded native pagination stream for candidates. */
export const projectResearchCandidatesPage = f1InternalQuery({
  args: projectResearchPageArgs,
  returns: v.union(projectResearchCandidatesPageValidator, denialValidator),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, args.identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    try {
      const page = await ctx.db
        .query("candidates")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .order("desc")
        .paginate(normalizeProjectPaginationOpts(args.paginationOpts));
      const candidates = page.page.filter((row) => row.organizationId === project.organizationId).map((row) => ({
        id: row._id,
        requirementId: row.requirementId,
        vendorId: row.vendorId,
        productModel: row.productModel,
        variant: row.variant,
        variantKey: row.variantKey,
        compatibility: row.compatibility,
        conversationState: row.conversationState,
        createdAt: row.createdAt,
      }));
      return {
        ok: true as const,
        projectId: project._id,
        candidates,
        pagination: paginationInfo(page),
        progress: { returned: candidates.length },
      };
    } catch (error) {
      if (isInvalidPaginationCursor(error)) {
        return { ok: false as const, code: "invalid-pagination", message: "pagination cursor is invalid for this research stream" };
      }
      throw error;
    }
  },
});

const projectResearchEvidencePageRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projectResearchEvidencePage>,
  Awaited<QueryReturn<typeof projectResearchEvidencePage>>
>("research/collection:projectResearchEvidencePage");
const projectResearchClaimsPageRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projectResearchClaimsPage>,
  Awaited<QueryReturn<typeof projectResearchClaimsPage>>
>("research/collection:projectResearchClaimsPage");
const projectResearchCandidatesPageRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projectResearchCandidatesPage>,
  Awaited<QueryReturn<typeof projectResearchCandidatesPage>>
>("research/collection:projectResearchCandidatesPage");

/**
 * Authorized research projection with three independently native-paginated
 * streams.  Convex permits one `.paginate()` per function execution, so each
 * stream runs in a bounded internal query and this public query composes the
 * three validated pages without collecting or silently capping rows.
 */
export const projectResearch = f1Query({
  args: {
    projectId: v.id("projects"),
    /** Legacy alias: when present, this paginates the evidence stream. */
    paginationOpts: v.optional(paginationOptsValidator),
    evidencePaginationOpts: v.optional(paginationOptsValidator),
    claimsPaginationOpts: v.optional(paginationOptsValidator),
    candidatesPaginationOpts: v.optional(paginationOptsValidator),
  },
  returns: v.union(projectResearchResultValidator, denialValidator),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };

    // The old `paginationOpts` argument remains an evidence alias.  Claims
    // and candidates start at their own first page unless their independent
    // options are supplied; their cursors can never be mixed with evidence.
    const legacyPageSize =
      args.paginationOpts?.numItems ?? args.evidencePaginationOpts?.numItems ?? DEFAULT_PROJECT_PAGE_SIZE;
    const evidencePaginationOpts = normalizeProjectPaginationOpts(
      args.evidencePaginationOpts ?? args.paginationOpts ?? { numItems: legacyPageSize, cursor: null },
    );
    const claimsPaginationOpts = normalizeProjectPaginationOpts(
      args.claimsPaginationOpts ?? { numItems: legacyPageSize, cursor: null },
    );
    const candidatesPaginationOpts = normalizeProjectPaginationOpts(
      args.candidatesPaginationOpts ?? { numItems: legacyPageSize, cursor: null },
    );

    const evidencePage = await ctx.runQuery(projectResearchEvidencePageRef, {
      projectId: project._id,
      identity,
      paginationOpts: evidencePaginationOpts,
    });
    if (!evidencePage.ok) return evidencePage;
    const claimsPage = await ctx.runQuery(projectResearchClaimsPageRef, {
      projectId: project._id,
      identity,
      paginationOpts: claimsPaginationOpts,
    });
    if (!claimsPage.ok) return claimsPage;
    const candidatesPage = await ctx.runQuery(projectResearchCandidatesPageRef, {
      projectId: project._id,
      identity,
      paginationOpts: candidatesPaginationOpts,
    });
    if (!candidatesPage.ok) return candidatesPage;

    return {
      ok: true as const,
      projectId: project._id,
      evidence: evidencePage.evidence,
      claims: claimsPage.claims,
      candidates: candidatesPage.candidates,
      pagination: {
        evidence: evidencePage.pagination,
        claims: claimsPage.pagination,
        candidates: candidatesPage.pagination,
      },
      // Backward-compatible aliases for callers that only paginated
      // evidence before the independent stream contract was added.
      continueCursor: evidencePage.pagination.continueCursor,
      isDone: evidencePage.pagination.isDone,
      progress: {
        sources: evidencePage.progress.returned,
        complete: evidencePage.progress.complete,
        partial: evidencePage.progress.partial,
        unavailable: evidencePage.progress.unavailable,
        claims: claimsPage.progress.returned,
        candidates: candidatesPage.progress.returned,
      },
      streamProgress: {
        evidence: evidencePage.progress,
        claims: claimsPage.progress,
        candidates: candidatesPage.progress,
      },
    };
  },
});

/** Exact-variant comparison projection with explicit unknown fields. */
export const compare = f1Query({
  args: { projectId: v.id("projects"), candidateIds: v.array(v.id("candidates")) },
  returns: compareResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    if (args.candidateIds.length === 0 || args.candidateIds.length > 16) return { ok: false as const, code: "invalid-payload", message: "compare between one and sixteen candidates" };
    const project = await ctx.db.get(args.projectId);
    if (project === null) return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    const access = await checkProjectAccess(ctx, identity, project.organizationId, project._id, "viewer", Date.now());
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const candidateViews = [] as Array<{
      id: Id<"candidates">;
      requirementId: Id<"requirements">;
      vendorId: Id<"vendors">;
      productModel: string;
      variant: string;
      variantKey: string;
      compatibility: "pass" | "fail" | "unknown";
      conversationState: string;
      createdAt: number;
    }>;
    const claimViews = [] as Array<{
      id: Id<"productEvidence">;
      requirementId?: Id<"requirements">;
      candidateId?: Id<"candidates">;
      field: string;
      sourceKind: string;
      sourceUrl?: string;
      capturedAt: number;
      originalValue: string;
      normalizedValue: string;
      verification: "unverified" | "verified" | "conflicted" | "superseded";
      freshness: "fresh" | "stale" | "expired" | "unknown";
      lastCheckedAt?: number;
      counterpartyRole: "ownerStandIn" | "vendor";
      executionMode: "live" | "recorded" | "fixture";
      origin: "internal" | "ownerImport";
    }>;
    const unknownFields = new Set<string>();
    for (const candidateId of args.candidateIds) {
      const candidate = await ctx.db.get(candidateId);
      if (candidate === null || candidate.organizationId !== project.organizationId || candidate.projectId !== project._id) {
        return { ok: false as const, code: "denied-project", message: "candidate is not in this project" };
      }
      candidateViews.push({
        id: candidate._id,
        requirementId: candidate.requirementId,
        vendorId: candidate.vendorId,
        productModel: candidate.productModel,
        variant: candidate.variant,
        variantKey: candidate.variantKey,
        compatibility: candidate.compatibility,
        conversationState: candidate.conversationState,
        createdAt: candidate.createdAt,
      });
      const candidateClaims = await ctx.db.query("productEvidence").withIndex("by_candidate", (q) => q.eq("candidateId", candidate._id)).take(65);
      for (const row of candidateClaims.slice(0, 64)) {
        if (row.organizationId !== project.organizationId || row.projectId !== project._id) continue;
        if (!claimViews.some((existing) => existing.id === row._id)) {
          claimViews.push({
            id: row._id,
            ...(row.requirementId === undefined ? {} : { requirementId: row.requirementId }),
            ...(row.candidateId === undefined ? {} : { candidateId: row.candidateId }),
            field: row.field,
            sourceKind: row.sourceKind,
            ...(row.sourceUrl === undefined ? {} : { sourceUrl: row.sourceUrl }),
            capturedAt: row.capturedAt,
            originalValue: row.originalValue,
            normalizedValue: row.normalizedValue,
            verification: row.verification,
            freshness: row.freshness,
            ...(row.lastCheckedAt === undefined ? {} : { lastCheckedAt: row.lastCheckedAt }),
            counterpartyRole: row.counterpartyRole,
            executionMode: row.executionMode,
            origin: row.origin,
          });
        }
      }
      for (const field of ["price", "currency", "availability", "delivery", "serviceCoverage"]) {
        const found = claimViews.some((row) => row.candidateId === candidate._id && row.field === field);
        if (!found) unknownFields.add(`${candidate._id}:${field}`);
      }
    }
    return { ok: true as const, projectId: project._id, candidates: candidateViews, claims: claimViews, unknownFields: [...unknownFields] };
  },
});

// Stable aliases for callers using the sponsor contract names.
export const requestResearch = requestGrantedResearch;
export const request = requestGrantedResearch;
export const list = projectResearch;

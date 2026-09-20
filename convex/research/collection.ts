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
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";
import { components } from "../models/components.js";
import type { ComponentApi } from "@firecrawl/firecrawl-convex/_generated/component.js";
import { canonicalJson, requestKey } from "../shared/hashing.js";
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
          response = args.mode === "scrape"
            ? {
                url: args.sourceUrl,
                title: "Controlled oversized source",
                markdown: "Source payload exceeded the application capture bound.",
                truncated: true,
              }
            : args.mode === "map"
              ? {
                  links: [
                    {
                      url: args.sourceUrl,
                      title: "Controlled oversized source",
                      truncated: true,
                    },
                  ],
                }
              : {
                  web: [
                    {
                      url: args.sourceUrl,
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
              mode: args.mode,
              response: {},
              capturedAt: Date.now(),
              ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
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
        if ((args.mode === "map" || args.mode === "scrape") &&
          (args.sourceUrl === undefined || !isSafePublicSourceUrl(args.sourceUrl))) {
          const recorded = await ctx.runMutation(recordOutcomeRef, {
            operationId: args.operationId,
            token: claim.attemptToken,
            outcome: "failure",
            provider: "firecrawl",
            environment: "production",
            providerEventId: `firecrawl:invalid-url:${args.operationId}`,
            detail: "source URL was not an allowed public HTTP(S) URL",
          });
          return recorded.ok
            ? { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" }
            : { ok: false as const, code: recorded.code, message: recorded.message };
        }
        if (args.mode === "search") {
          response = await firecrawl.search(ctx, queryFromPayload(operation.payload) ?? "", {
            sources: ["web"],
            limit: 10,
            highlights: true,
          });
        } else if (args.mode === "map") {
          response = await firecrawl.map(ctx, args.sourceUrl ?? "", { limit: 20, sitemap: "include" });
        } else {
          response = await firecrawl.scrape(ctx, args.sourceUrl ?? "", {
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
        mode: args.mode,
        response,
        capturedAt: Date.now(),
        ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
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
    if ((args.mode === "map" || args.mode === "scrape") &&
      (args.sourceUrl === undefined || !isSafePublicSourceUrl(args.sourceUrl))) {
      return { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" };
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
    const key = requestKey(project.organizationId, "research.collect", args.requestId);
    const existing = await ctx.db
      .query("operations")
      .withIndex("by_requestKey", (q) => q.eq("requestKey", key))
      .unique();
    if (existing !== null) {
      if (
        existing.projectId !== project._id ||
        existing.kind !== "research.collect" ||
        existing.normalizedPayload !== operationPayload
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
        operationId: existing._id,
        state: existingJob.state,
        requestCount: existing.state === "observedSuccess" ? 1 : 0,
        incompleteCount: existing.state === "observedSuccess" ? 0 : 0,
        controlled: false,
      };
    }
    if (args.mode === undefined && args.sourceUrl !== undefined) {
      return { ok: false as const, code: "invalid-payload", message: "mode is required when sourceUrl is supplied" };
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
    if ((args.mode === "map" || args.mode === "scrape") &&
      (args.sourceUrl === undefined || !isSafePublicSourceUrl(args.sourceUrl))) {
      return { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" };
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
    const key = requestKey(project.organizationId, "research.collect", args.requestId);
    const existing = await ctx.db.query("operations").withIndex("by_requestKey", (q) => q.eq("requestKey", key)).unique();
    if (existing !== null) {
      if (existing.projectId !== project._id || existing.kind !== "research.collect" || existing.normalizedPayload !== operationPayload) {
        return { ok: false as const, code: "duplicate-conflict", message: "requestId reused with a different research payload" };
      }
      const existingJob = await ctx.db.get(existing.jobId);
      if (existingJob === null || existingJob.projectId !== project._id) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      return { ok: true as const, jobId: existing.jobId, operationId: existing._id, state: existingJob.state, requestCount: 0, incompleteCount: 0, controlled: false };
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
      kind: "research.collect",
      requestId: args.requestId,
      payloadJson: operationPayload,
      grantId: args.grantId,
      reservationId: reserved.reservationId,
    });
    if (!created.ok) {
      await ctx.runMutation(cancelJobRef, { jobId: started.jobId, reason: "research operation could not be created" });
      return created;
    }
    await ctx.scheduler.runAfter(0, makeInternalActionRef<ExecuteArgs, ExecuteReturn>("research/collection:execute"), {
      operationId: created.operationId,
      identity,
      mode: args.mode ?? (args.sourceUrl === undefined ? "search" : "scrape"),
      ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
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
    if ((args.mode === "map" || args.mode === "scrape") && (args.sourceUrl === undefined || !isSafePublicSourceUrl(args.sourceUrl))) {
      return { ok: false as const, code: "invalid-payload", message: "source URL was not allowed" };
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
    const siblingOperations = await ctx.db.query("operations").withIndex("by_job", (q) => q.eq("jobId", job._id)).take(MAX_OPERATIONS_PER_JOB + 1);
    const recoveryCount = siblingOperations.filter((entry) => entry.requestId.startsWith(`${args.operationId}:recovery:`)).length;
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
    const recoveryRequestId = `${args.operationId}:recovery:${args.requestId}`;
    const created = await ctx.runMutation(createOperationRef, {
      jobId: job._id,
      organizationId: job.organizationId,
      projectId: job.projectId,
      kind: "research.collect",
      requestId: recoveryRequestId,
      payloadJson: payload,
      grantId: operation.grantId,
      reservationId: reserved.reservationId,
    });
    if (!created.ok) return created;
    await ctx.scheduler.runAfter(0, makeInternalActionRef<ExecuteArgs, ExecuteReturn>("research/collection:execute"), {
      operationId: created.operationId,
      identity,
      mode: args.mode,
      ...(args.sourceUrl === undefined ? {} : { sourceUrl: args.sourceUrl }),
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

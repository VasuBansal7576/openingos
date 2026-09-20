/**
 * F1 durable job lifecycle (controlled contract, ADR-0004).
 *
 * Job states: queued, running, waitingForSupplier, waitingForUser,
 * pausedBudget, completed, partial, failed, cancelling, cancelled. Supplier waits
 * suspend work rather than keeping a provider loop alive. Cancellation
 * before the dispatch claim prevents the send; cancellation after the
 * claim prevents subsequent work but cannot unsend — reconciliation
 * exposes that outcome honestly. Identity and time are server-derived;
 * callers supply neither.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import {
  f1Mutation,
  f1Query,
  type F1MutationCtx,
} from "../server.js";
import { projectWorkflowContext } from "./operations.js";
import { canonicalJson, payloadHash } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import { isExpired } from "../shared/time.js";
import {
  classifyScope,
  containsInstructionOverride,
  MAX_JOBS_PER_GRANT,
  validateWorkflowPayload,
  workflowContextKey,
} from "../shared/scope.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../access/checks.js";

const jobKindValidator = v.union(
  v.literal("research"),
  v.literal("communication"),
  v.literal("execution"),
);

const jobViewValidator = v.object({
  id: v.id("jobs"),
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  kind: v.string(),
  state: v.string(),
  grantVersion: v.number(),
  cancelledAt: v.optional(v.number()),
  cancelReason: v.optional(v.string()),
  cancellationPhase: v.optional(v.string()),
  cancellationUnresolvedOperationIds: v.optional(v.array(v.id("operations"))),
  cancellationUnresolvedOperationCount: v.optional(v.number()),
  cancellationReconciliationComplete: v.optional(v.boolean()),
});

const CANCELLATION_PAGE_SIZE = 16;
const CANCELLATION_UNRESOLVED_SAMPLE_LIMIT = 16;

type CancellationPhase = "operations" | "reservations" | "complete";

type CancellationJobProgress = {
  readonly _id: Id<"jobs">;
  readonly cancellationPhase?: CancellationPhase;
  readonly cancellationOperationCursor?: string | null;
  readonly cancellationReservationCursor?: string | null;
  readonly cancellationOperationsProcessed?: number;
  readonly cancellationReservationsProcessed?: number;
  readonly cancellationUnresolvedOperationIds?: readonly Id<"operations">[];
  readonly cancellationUnresolvedOperationCount?: number;
  readonly cancellationReconciliationComplete?: boolean;
  readonly cancellationReconciliationCursor?: string | null;
  readonly cancelledAt?: number;
};

const cancellationResultValidator = v.union(
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
);

type CancellationResult = {
  readonly ok: true;
  readonly state: string;
  readonly unresolvedOperationIds: Id<"operations">[];
  readonly complete: boolean;
  readonly reconciliationComplete: boolean;
  readonly unresolvedOperationCount: number;
  readonly phase: CancellationPhase;
  readonly processedOperations: number;
  readonly processedReservations: number;
};

function parseCanonicalPayload(payload: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch {
    return null;
  }
}

function isCancellationFenced(state: string): boolean {
  return state === "cancelling" || state === "cancelled";
}

function isTerminalWithoutProviderEffect(state: string): boolean {
  return state === "cancelled" || state === "denied";
}

type CancellationOperation = {
  readonly _id: Id<"operations">;
  readonly state: string;
};

type CancellationReservation = {
  readonly _id: Id<"reservations">;
  readonly organizationId: Id<"organizations">;
  readonly budgetId: Id<"providerBudgets">;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly unresolvedMicroUsd: number;
  readonly state: string;
};

type UnresolvedSummary = {
  readonly count: number;
  readonly ids: Id<"operations">[];
};

function unresolvedSummary(job: CancellationJobProgress): UnresolvedSummary {
  return {
    count: job.cancellationUnresolvedOperationCount ?? 0,
    ids: [...(job.cancellationUnresolvedOperationIds ?? [])],
  };
}

function recordUnresolved(
  summary: UnresolvedSummary,
  operationId: Id<"operations">,
): UnresolvedSummary {
  if (summary.ids.includes(operationId) || summary.ids.length >= CANCELLATION_UNRESOLVED_SAMPLE_LIMIT) {
    return { count: summary.count + 1, ids: summary.ids };
  }
  return { count: summary.count + 1, ids: [...summary.ids, operationId] };
}

function cancellationResult(
  job: CancellationJobProgress,
  state: string,
  complete: boolean,
  phase: CancellationPhase,
  reconciliationComplete: boolean,
  processedOperations: number,
  processedReservations: number,
): CancellationResult {
  const summary = unresolvedSummary(job);
  return {
    ok: true,
    state,
    unresolvedOperationIds: summary.ids,
    unresolvedOperationCount: summary.count,
    complete,
    reconciliationComplete,
    phase,
    processedOperations,
    processedReservations,
  };
}

async function releaseUnusedReservation(
  ctx: F1MutationCtx,
  reservation: CancellationReservation,
  now: number,
): Promise<void> {
  if (reservation.state !== "open" || reservation.reservedMicroUsd <= 0) return;
  // Spent and unknown exposure is never released by cancellation.  The
  // provider reconciliation path remains the only owner of that ledger.
  if (reservation.spentMicroUsd > 0 || reservation.unresolvedMicroUsd > 0) return;

  // The by_reservation index lets us prove the common one-to-one binding
  // without scanning the whole job.  More than one binding is retained
  // conservatively, because a partial scan cannot prove that all of them are
  // cancelled or denied.
  const boundOperations = await ctx.db
    .query("operations")
    .withIndex("by_reservation", (q) => q.eq("reservationId", reservation._id))
    .take(2);
  const onlyBoundOperation = boundOperations[0];
  const provablyUnused =
    boundOperations.length === 0 ||
    (onlyBoundOperation !== undefined &&
      boundOperations.length === 1 &&
      isTerminalWithoutProviderEffect(onlyBoundOperation.state));
  if (!provablyUnused) return;

  const budget = await ctx.db.get(reservation.budgetId);
  if (
    budget === null ||
    budget.organizationId !== reservation.organizationId ||
    budget.reservedMicroUsd < reservation.reservedMicroUsd
  ) {
    // A broken ledger relationship is not evidence that the hold is safe to
    // release.  Leave it visible for reconciliation instead.
    return;
  }
  const released = reservation.reservedMicroUsd;
  await ctx.db.patch(reservation._id, {
    reservedMicroUsd: 0,
    state: "closed",
    updatedAt: now,
  });
  await ctx.db.patch(budget._id, {
    reservedMicroUsd: budget.reservedMicroUsd - released,
    updatedAt: now,
  });
}

async function processCancellationRows(
  ctx: F1MutationCtx,
  job: CancellationJobProgress,
  operations: readonly CancellationOperation[],
  reservations: readonly CancellationReservation[],
  now: number,
): Promise<CancellationResult> {
  let summary = unresolvedSummary(job);
  for (const operation of operations) {
    if (operation.state === "prepared") {
      // Do not release here.  The reservation phase must inspect all
      // operation bindings before it can prove a hold is unused.
      await ctx.db.patch(operation._id, { state: "cancelled", updatedAt: now });
    } else if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
      summary = recordUnresolved(summary, operation._id);
    }
  }
  for (const reservation of reservations) {
    await releaseUnusedReservation(ctx, reservation, now);
  }
  await ctx.db.patch(job._id, {
    state: "cancelled",
    cancellationPhase: "complete",
    cancellationOperationCursor: null,
    cancellationReservationCursor: null,
    cancellationOperationsProcessed: operations.length,
    cancellationReservationsProcessed: reservations.length,
    cancellationUnresolvedOperationIds: summary.ids,
    cancellationUnresolvedOperationCount: summary.count,
    cancellationReconciliationComplete: summary.count === 0,
    cancellationReconciliationCursor: null,
    ...(job.cancelledAt === undefined ? { cancelledAt: now } : {}),
    updatedAt: now,
  });
  return cancellationResult(
    {
      ...job,
      cancellationUnresolvedOperationIds: summary.ids,
      cancellationUnresolvedOperationCount: summary.count,
      cancellationReconciliationComplete: summary.count === 0,
    },
    "cancelled",
    true,
    "complete",
    summary.count === 0,
    operations.length,
    reservations.length,
  );
}

/**
 * Process one bounded cancellation page.  Convex permits one paginated query
 * per mutation, so each invocation advances exactly one durable phase.  The
 * initial public call uses a bounded small-job fast path below; oversized or
 * legacy rows continue through this one-page mutation and its cursor.
 */
async function processCancellationPage(
  ctx: F1MutationCtx,
  job: CancellationJobProgress,
  now: number,
): Promise<CancellationResult> {
  let phase: CancellationPhase = job.cancellationPhase ?? "operations";
  let operationCursor = job.cancellationOperationCursor ?? null;
  let reservationCursor = job.cancellationReservationCursor ?? null;
  let processedOperations = job.cancellationOperationsProcessed ?? 0;
  let processedReservations = job.cancellationReservationsProcessed ?? 0;
  let summary = unresolvedSummary(job);

  if (phase === "operations") {
    const page = await ctx.db
      .query("operations")
      .withIndex("by_job", (q) => q.eq("jobId", job._id))
      .order("asc")
      .paginate({ numItems: CANCELLATION_PAGE_SIZE, cursor: operationCursor });
    for (const operation of page.page) {
      if (operation.state === "prepared") {
        await ctx.db.patch(operation._id, { state: "cancelled", updatedAt: now });
      } else if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
        summary = recordUnresolved(summary, operation._id);
      }
    }
    processedOperations += page.page.length;
    if (page.isDone) {
      phase = "reservations";
      operationCursor = null;
      reservationCursor = null;
    } else {
      operationCursor = page.continueCursor;
    }
  } else if (phase === "reservations") {
    const page = await ctx.db
      .query("reservations")
      .withIndex("by_job", (q) => q.eq("jobId", job._id))
      .order("asc")
      .paginate({ numItems: CANCELLATION_PAGE_SIZE, cursor: reservationCursor });
    for (const reservation of page.page) {
      await releaseUnusedReservation(ctx, reservation, now);
    }
    processedReservations += page.page.length;
    if (page.isDone) {
      phase = "complete";
      reservationCursor = null;
    } else {
      reservationCursor = page.continueCursor;
    }
  }

  const complete = phase === "complete";
  await ctx.db.patch(job._id, {
    state: complete ? "cancelled" : "cancelling",
    cancellationPhase: phase,
    cancellationOperationCursor: operationCursor,
    cancellationReservationCursor: reservationCursor,
    cancellationOperationsProcessed: processedOperations,
    cancellationReservationsProcessed: processedReservations,
    cancellationUnresolvedOperationIds: summary.ids,
    cancellationUnresolvedOperationCount: summary.count,
    cancellationReconciliationComplete: complete ? summary.count === 0 : false,
    cancellationReconciliationCursor: null,
    ...(complete && job.cancelledAt === undefined ? { cancelledAt: now } : {}),
    updatedAt: now,
  });

  return cancellationResult(
    {
      ...job,
      cancellationUnresolvedOperationIds: summary.ids,
      cancellationUnresolvedOperationCount: summary.count,
      cancellationReconciliationComplete: complete ? summary.count === 0 : false,
    },
    complete ? "cancelled" : "cancelling",
    complete,
    phase,
    complete && summary.count === 0,
    processedOperations,
    processedReservations,
  );
}

/**
 * Re-scan one bounded operations page after cancellation cleanup.  Cleanup is
 * complete even when a provider outcome is still ambiguous, so this phase
 * keeps the job cancelled while durable reconciliation remains explicitly
 * incomplete.  A null cursor starts a fresh bounded pass and rebuilds the
 * count/sample from current operation states.
 */
async function processReconciliationPage(
  ctx: F1MutationCtx,
  job: CancellationJobProgress,
  now: number,
): Promise<CancellationResult> {
  const cursor = job.cancellationReconciliationCursor ?? null;
  let summary: UnresolvedSummary =
    cursor === null ? { count: 0, ids: [] } : unresolvedSummary(job);
  const page = await ctx.db
    .query("operations")
    .withIndex("by_job", (q) => q.eq("jobId", job._id))
    .order("asc")
    .paginate({ numItems: CANCELLATION_PAGE_SIZE, cursor });
  for (const operation of page.page) {
    if (operation.state === "dispatching" || operation.state === "outcomeUnknown") {
      summary = recordUnresolved(summary, operation._id);
    }
  }
  const reconciliationComplete = page.isDone && summary.count === 0;
  const nextCursor = page.isDone ? null : page.continueCursor;
  await ctx.db.patch(job._id, {
    state: "cancelled",
    cancellationPhase: "complete",
    cancellationReconciliationCursor: nextCursor,
    cancellationUnresolvedOperationIds: summary.ids,
    cancellationUnresolvedOperationCount: summary.count,
    cancellationReconciliationComplete: reconciliationComplete,
    updatedAt: now,
  });
  return cancellationResult(
    {
      ...job,
      cancellationUnresolvedOperationIds: summary.ids,
      cancellationUnresolvedOperationCount: summary.count,
      cancellationReconciliationComplete: reconciliationComplete,
      cancellationReconciliationCursor: nextCursor,
    },
    "cancelled",
    true,
    "complete",
    reconciliationComplete,
    job.cancellationOperationsProcessed ?? 0,
    job.cancellationReservationsProcessed ?? 0,
  );
}

/**
 * Start a scope-gated job. Unrelated/unavailable requests are refused with
 * no job; supplier-evidence instructions cannot expand capabilities.
 * Research jobs without an explicit grant receive a server-bound
 * no-spend grant so the job always carries a versioned authority.
 */
export const start = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    text: v.string(),
    operationId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    grantId: v.optional(v.id("grants")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), jobId: v.id("jobs"), state: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    if (containsInstructionOverride(args.text)) {
      return { ok: false as const, code: "prompt-injection-denied", message: "supplier evidence cannot expand capabilities" };
    }

    // Resolve project context from server-owned records before classifying the
    // request. A caller cannot supply a project name, requirement, or topic
    // to manufacture OpeningOS authority.
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const context = await projectWorkflowContext(ctx, args.organizationId, args.projectId);
    if (context === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }

    // Validate an explicitly supplied grant before classification so a grant
    // payload cannot smuggle an unrelated query through the text path. This
    // is still a no-write read boundary.
    const suppliedGrant = args.grantId === undefined ? null : await ctx.db.get(args.grantId);
    if (args.grantId !== undefined && suppliedGrant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (
      suppliedGrant !== null &&
      (suppliedGrant.organizationId !== args.organizationId || suppliedGrant.projectId !== args.projectId)
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }

    const classified = classifyScope({
      text: args.text,
      ...(args.operationId === undefined ? {} : { operationId: args.operationId }),
      projectContext: context,
    });
    if (classified.verdict === "unrelatedRefused") {
      return { ok: false as const, code: "unrelated-refusal", message: classified.reason };
    }
    if (classified.verdict === "unavailableRefused") {
      return { ok: false as const, code: "unavailable-capability", message: classified.reason };
    }
    const operationId = classified.operationId;
    const capability = requireCapability(operationId, access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }

    const kind = args.kind ?? "research";
    const expectedKind = classified.purpose === "purchasingCommunication" ? "communication" : "research";
    if (kind !== expectedKind) {
      return { ok: false as const, code: "unrelated-refusal", message: "job kind does not match the OpeningOS workflow purpose" };
    }
    let grantId: Id<"grants"> | undefined = args.grantId;
    let grantVersion = 0;
    let inputVersions: Record<string, string> = {};
    if (grantId !== undefined) {
      // Every explicit job grant is fully validated: same
      // organization/project, active, unexpired, and authorizing the
      // classified operation. A foreign, revoked, expired, or
      // non-authorizing grant starts no job.
      const grant = suppliedGrant;
      if (
        grant === null ||
        grant.organizationId !== args.organizationId ||
        grant.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
      }
      if (grant.status !== "active") {
        return { ok: false as const, code: "revoked-grant", message: "grant is not active" };
      }
      if (isExpired(now, grant.expiresAt)) {
        return { ok: false as const, code: "expired-grant", message: "grant expired" };
      }
      if (!grant.operations.includes(operationId)) {
        return { ok: false as const, code: "denied-capability", message: `grant does not authorize ${operationId}` };
      }
      const grantPayload = parseCanonicalPayload(grant.canonicalPayload);
      if (grantPayload === null) {
        return { ok: false as const, code: "invalid-payload", message: "grant payload is not valid JSON" };
      }
      const purposePayload = validateWorkflowPayload({
        operationId,
        purpose: classified.purpose,
        payload: grantPayload,
        context,
      });
      if (!purposePayload.ok) {
        return { ok: false as const, code: "unrelated-refusal", message: purposePayload.reason ?? "grant purpose is not supported" };
      }
      grantVersion = grant.revocationVersion;
      inputVersions = { ...grant.inputVersions };
    } else if (kind === "communication") {
      return { ok: false as const, code: "denied-capability", message: "communication requires a grant" };
    } else {
      const recipient = await ctx.db
        .query("recipientConfigs")
        .withIndex("by_active", (q) => q.eq("active", true))
        .unique();
      const autoPayload = { research: "bounded-server-grant" };
      const autoCanonical = canonicalJson(autoPayload);
      grantId = await ctx.db.insert("grants", {
        organizationId: args.organizationId,
        projectId: args.projectId,
        operations: [operationId],
        communicationProfile: "ownerRoleplay",
        recipientConfigVersion: recipient?.version ?? 0,
        inputVersions: {},
        canonicalPayload: autoCanonical,
        payloadHash: payloadHash(autoPayload),
        payloadSha256: await sha256HexOfCanonical(autoCanonical),
        // No-spend research authority with valid positive semantics: the
        // round limit passes the same positive-safe-integer validation as
        // an issued grant, while the zero cost ceiling permits no
        // reservation — bounded real research still needs an
        // owner-funded allowance.
        costCeilingMicroUsd: 0,
        roundLimit: 3,
        expiresAt: now + 900_000,
        revocationVersion: 1,
        status: "active",
        createdAt: now,
      });
      grantVersion = 1;
    }

    // A grant can legally contain several operations, but every job remains
    // a bounded unit of work. Once the finite admission is reached we deny
    // without creating another job or changing the grant/budget.
    if (grantId === undefined) {
      return { ok: false as const, code: "denied-capability", message: "job authority could not be established" };
    }
    const grantJobs = await ctx.db
      .query("jobs")
      .withIndex("by_grant", (q) => q.eq("grantId", grantId))
      .take(MAX_JOBS_PER_GRANT + 1);
    if (grantJobs.length >= MAX_JOBS_PER_GRANT) {
      return { ok: false as const, code: "job-admission-limit", message: "grant job admission limit reached" };
    }

    const jobId = await ctx.db.insert("jobs", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      grantId,
      grantVersion,
      kind,
      workflowPurpose: classified.purpose,
      workflowContext: workflowContextKey(context, classified.purpose),
      state: "queued",
      inputVersions,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, jobId, state: "queued" };
  },
});

/** Cancel a job: undispatched work stops; in-flight work reconciles. */
export const cancel = f1Mutation({
  args: { jobId: v.id("jobs"), reason: v.string() },
  returns: cancellationResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      job.organizationId,
      job.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };

    // A completed cancellation is idempotent.  In-flight provider outcomes
    // may still reconcile against the retained operation/reservation facts.
    if (job.state === "cancelled") {
      if (job.cancellationReconciliationComplete === true) {
        return cancellationResult(
          job,
          "cancelled",
          true,
          "complete",
          true,
          job.cancellationOperationsProcessed ?? 0,
          job.cancellationReservationsProcessed ?? 0,
        );
      }
      // A cancelled job is still a valid reconciliation handle.  Repeated
      // calls rebuild a bounded operation summary after a late provider
      // outcome instead of forgetting an unresolved earlier page.
      return processReconciliationPage(ctx, job, now);
    }

    // The first write is the durable non-dispatchable fence.  Unlike the
    // rejected implementation, oversized legacy/seeded jobs are not denied
    // before this state is persisted and can be cleaned page by page.
    if (!isCancellationFenced(job.state)) {
      // A bounded probe keeps ordinary jobs immediately cancellable without
      // ever loading an unbounded history.  If either table exceeds the page
      // size, the first call fences and advances only the operations page;
      // subsequent calls continue from the durable cursor.
      const operations = await ctx.db
        .query("operations")
        .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
        .take(CANCELLATION_PAGE_SIZE + 1);
      const reservations = await ctx.db
        .query("reservations")
        .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
        .take(CANCELLATION_PAGE_SIZE + 1);
      const smallEnough =
        operations.length <= CANCELLATION_PAGE_SIZE &&
        reservations.length <= CANCELLATION_PAGE_SIZE;
      await ctx.db.patch(args.jobId, {
        state: "cancelling",
        cancelledAt: now,
        cancelReason: args.reason,
        cancellationPhase: "operations",
        cancellationOperationCursor: null,
        cancellationReservationCursor: null,
        cancellationOperationsProcessed: 0,
        cancellationReservationsProcessed: 0,
        cancellationUnresolvedOperationIds: [],
        cancellationUnresolvedOperationCount: 0,
        cancellationReconciliationComplete: false,
        cancellationReconciliationCursor: null,
        updatedAt: now,
      });
      if (smallEnough) {
        return processCancellationRows(ctx, {
          _id: job._id,
          cancellationOperationsProcessed: 0,
          cancellationReservationsProcessed: 0,
          cancelledAt: now,
        }, operations, reservations, now);
      }
      // Commit only the fence for an oversized job.  Cleanup starts in the
      // next repeated call, so the non-dispatchable state is durable even if
      // a later bounded page needs to be retried.
      return {
        ok: true as const,
        state: "cancelling",
        unresolvedOperationIds: [],
        unresolvedOperationCount: 0,
        complete: false,
        reconciliationComplete: false,
        phase: "operations",
        processedOperations: 0,
        processedReservations: 0,
      };
    }

    // Repeated public calls are a supported continuation path.  Each call
    // advances one durable page while the cancellation fence remains active.
    return processCancellationPage(ctx, job, now);
  },
});

/** Read one authorized job. */
export const get = f1Query({
  args: { jobId: v.id("jobs") },
  returns: v.union(jobViewValidator.extend({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      job.organizationId,
      job.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return {
      ok: true as const,
      id: args.jobId,
      organizationId: job.organizationId,
      projectId: job.projectId,
      kind: job.kind,
      state: job.state,
      grantVersion: job.grantVersion,
      ...(job.cancelledAt === undefined ? {} : { cancelledAt: job.cancelledAt }),
      ...(job.cancelReason === undefined ? {} : { cancelReason: job.cancelReason }),
      ...(job.cancellationPhase === undefined ? {} : { cancellationPhase: job.cancellationPhase }),
      ...(job.cancellationUnresolvedOperationIds === undefined
        ? {}
        : { cancellationUnresolvedOperationIds: [...job.cancellationUnresolvedOperationIds] }),
      ...(job.cancellationUnresolvedOperationCount === undefined
        ? {}
        : { cancellationUnresolvedOperationCount: job.cancellationUnresolvedOperationCount }),
      ...(job.cancellationReconciliationComplete === undefined
        ? {}
        : { cancellationReconciliationComplete: job.cancellationReconciliationComplete }),
    };
  },
});

/**
 * F1R-23: authenticated, project-authorized, bounded inventory of the
 * unresolved operations for one job.
 *
 * The cancellation summary on the job keeps a durable total count plus a
 * 16-ID sample; that sample alone is not the inventory. This query walks
 * the stable `by_job` operation order one bounded raw page at a time and
 * returns the `dispatching`/`outcomeUnknown` IDs found on that page. The
 * continuation cursor is returned whenever the raw scan is not done — even
 * when the filtered page holds zero IDs — so callers can enumerate every
 * unresolved operation beyond the first 16 without an unbounded read.
 */
export const listUnresolvedOperations = f1Query({
  args: {
    jobId: v.id("jobs"),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      operationIds: v.array(v.id("operations")),
      continueCursor: v.union(v.string(), v.null()),
      isDone: v.boolean(),
      unresolvedOperationCount: v.number(),
      reconciliationComplete: v.boolean(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const job = await ctx.db.get(args.jobId);
    if (job === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      job.organizationId,
      job.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const requested = args.limit ?? CANCELLATION_PAGE_SIZE;
    const pageSize = Math.min(
      CANCELLATION_PAGE_SIZE,
      Math.max(1, Math.floor(requested)),
    );
    const page = await ctx.db
      .query("operations")
      .withIndex("by_job", (q) => q.eq("jobId", args.jobId))
      .order("asc")
      .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    const operationIds = page.page
      .filter(
        (operation) =>
          operation.state === "dispatching" || operation.state === "outcomeUnknown",
      )
      .map((operation) => operation._id);
    return {
      ok: true as const,
      operationIds,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
      unresolvedOperationCount: job.cancellationUnresolvedOperationCount ?? 0,
      reconciliationComplete: job.cancellationReconciliationComplete ?? false,
    };
  },
});

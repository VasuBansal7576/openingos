/**
 * E10 truthful project usage and outcome metrics (P-22, PRD sections 40-42).
 *
 * One authorized, bounded, read-only project metrics query over EXISTING
 * durable records. This module never writes rows, never adds schema, never
 * invents fields: it reports measured raw facts stored by the F1 domain,
 * execution, and purchasing packages, and returns `notAssessed` or
 * `unavailable` with reasons for everything the current records cannot
 * prove (activation, readiness-by-need-by, savings, revenue, retention,
 * verified provider cost, success rates).
 *
 * Truthfulness rules enforced here:
 * - Job completion and failure include failed runs and retries (attempts
 *   beyond the first per operation are counted as retries).
 * - Time fields appear only where authoritative timestamps exist (attempt
 *   `observedAt` versus attempt `createdAt`); no derived latency claims.
 * - User interventions appear only where stored (approval decisions with a
 *   recorded decision timestamp; jobs parked in `waitingForUser`).
 * - Provider reservations and actual usage report the stored reserved,
 *   spent, and unresolved micro-USD accounting separately; unresolved
 *   charges are never turned into zero.
 * - Approved decisions and recorded order/service outcomes are raw counts.
 * - Confirmed spend groups stored cost entries by currency with finite
 *   integer arithmetic and no conversion; an unplaced selection is never
 *   procurement spend because spend derives only from order-linked cost
 *   entries.
 * - Cached versus fresh collection and controlled versus live provenance
 *   are separated from stored freshness and execution-mode fields.
 * - Every scan is an indexed, bounded read with a one-row truncation
 *   probe; the result carries explicit completeness and truncation
 *   metadata instead of silently dropping history.
 * - Every multi-row total uses checked safe-integer accumulation: a total
 *   that cannot be represented exactly is reported as an explicit
 *   unavailable/overflow discriminant with a reason (recorded in
 *   `completeness.overflowedSections`), never as a rounded number.
 *
 * Authorization: caller identity (never a client-supplied user id) must
 * hold an active project membership at viewer role or above for the exact
 * organization/project pair; unknown or foreign pairs share one generic
 * denial (ADR-0007).
 *
 * This module registers exactly one public query and owns no other files.
 */

import { v } from "convex/values";
import { f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import { requireDomainAccess } from "../domain/guards.js";

/** Fixed per-scan bounds; each scan reads at most limit + 1 rows. */
const LIMITS = {
  jobs: 100,
  operationsPerJob: 20,
  attemptsPerOperation: 10,
  reservationsPerJob: 10,
  approvals: 50,
  orders: 100,
  serviceCases: 100,
  costEntries: 200,
  productEvidence: 200,
} as const;

const JOB_STATES = [
  "queued",
  "running",
  "waitingForSupplier",
  "waitingForUser",
  "pausedBudget",
  "completed",
  "partial",
  "failed",
  "cancelling",
  "cancelled",
] as const;

const OPERATION_STATES = [
  "prepared",
  "dispatching",
  "observedSuccess",
  "observedFailure",
  "outcomeUnknown",
  "cancelled",
  "denied",
] as const;

const ATTEMPT_STATES = [
  "prepared",
  "dispatching",
  "observedSuccess",
  "observedFailure",
  "outcomeUnknown",
] as const;

const RESERVATION_STATES = ["open", "paused", "closed"] as const;

const APPROVAL_STATES = ["pending", "approved", "rejected", "invalidated"] as const;

const ORDER_STATES = ["recorded", "amended", "cancelled"] as const;

const SERVICE_CASE_STATES = [
  "open",
  "inProgress",
  "waitingForSupplier",
  "resolved",
  "closed",
] as const;

const COST_ENTRY_KINDS = ["payment", "settledCost", "refund", "credit"] as const;

const EVIDENCE_FRESHNESS = ["fresh", "stale", "expired", "unknown"] as const;

const EVIDENCE_EXECUTION_MODES = ["live", "recorded", "fixture"] as const;


function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function zeroCounts(states: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of states) counts[state] = 0;
  return counts;
}

const countsValidator = v.record(v.string(), v.number());

/**
 * Checked safe-integer accumulation (P-22 truthfulness repair).
 *
 * Every stored amount is a safe integer, but a bounded multi-row total is
 * not: plain JavaScript addition past 2^53-1 rounds silently and a rounded
 * total would be reported as measured. Each overflow-capable total is
 * therefore either an exact safe-integer number or an explicit
 * unavailable/overflow discriminant with a reason — never a rounded,
 * zeroed, or invented value.
 */
const OVERFLOW = "overflow" as const;
type Overflow = typeof OVERFLOW;

const OVERFLOW_TOTAL_REASON =
  "overflow: the stored-row total exceeds the exact safe-integer range; no rounded or invented total is reported.";

type MeasuredTotal = number | { readonly unavailable: typeof OVERFLOW; readonly reason: string };

function addSafe(total: number | Overflow, amount: number): number | Overflow {
  if (total === OVERFLOW) return OVERFLOW;
  const next = total + amount;
  return Number.isSafeInteger(next) ? next : OVERFLOW;
}

function measuredTotal(total: number | Overflow): MeasuredTotal {
  return typeof total === "number" ? total : { unavailable: OVERFLOW, reason: OVERFLOW_TOTAL_REASON };
}

const measuredTotalValidator = v.union(
  v.number(),
  v.object({ unavailable: v.literal(OVERFLOW), reason: v.string() }),
);

const notAssessedReasons = {
  activation:
    "notAssessed: no activation-event records exist in the durable schema, so no activation or time-to-value claim is made.",
  readinessByNeedBy:
    "notAssessed: this query does not evaluate requirement readiness against need-by dates; no readiness-by-need-by claim is made.",
  savings:
    "unavailable: no realized-savings records exist; savings are never derived here from quote or negotiation differences.",
  revenue: "unavailable: no revenue records exist.",
  retention:
    "notAssessed: no cohort, repeat-use, or dashboard-usage records are measured by this query.",
  providerCost:
    "unavailable: stored reservation and budget accounting is reported as stored, but no verified provider billing data exists, so no provider-cost claim is made.",
  successRate:
    "notAssessed: only raw completion, failure, and retry counts are reported; no success rate is derived.",
} as const;

const metricsValidator = v.object({
  ok: v.literal(true),
  scope: v.object({
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
  }),
  jobs: v.object({
    scanned: v.number(),
    truncated: v.boolean(),
    byState: countsValidator,
  }),
  operations: v.object({
    scanned: v.number(),
    truncated: v.boolean(),
    byState: countsValidator,
  }),
  attempts: v.object({
    scanned: v.number(),
    truncated: v.boolean(),
    retries: v.number(),
    byState: countsValidator,
    observedElapsed: v.object({
      attemptsWithObservedAt: v.number(),
      attemptsWithSaneInterval: v.number(),
      totalObservedElapsedMs: measuredTotalValidator,
    }),
  }),
  providerUsage: v.object({
    reservationsScanned: v.number(),
    reservationsTruncated: v.boolean(),
    byState: countsValidator,
    reservedMicroUsd: measuredTotalValidator,
    spentMicroUsd: measuredTotalValidator,
    unresolvedMicroUsd: measuredTotalValidator,
    reservationsWithUnresolvedCharges: v.number(),
  }),
  decisions: v.object({
    approvals: v.object({
      scanned: v.number(),
      truncated: v.boolean(),
      byState: countsValidator,
      decided: v.number(),
    }),
    orders: v.object({
      scanned: v.number(),
      truncated: v.boolean(),
      byState: countsValidator,
    }),
    serviceCases: v.object({
      scanned: v.number(),
      truncated: v.boolean(),
      byState: countsValidator,
      withRecordedOutcome: v.number(),
    }),
  }),
  spend: v.object({
    entriesScanned: v.number(),
    entriesTruncated: v.boolean(),
    currencies: v.array(
      v.object({
        currency: v.string(),
        entries: v.number(),
        byKind: countsValidator,
        paymentsAndSettledMinorUnits: measuredTotalValidator,
        refundsAndCreditsMinorUnits: measuredTotalValidator,
        netMinorUnits: measuredTotalValidator,
      }),
    ),
  }),
  collection: v.object({
    evidenceScanned: v.number(),
    evidenceTruncated: v.boolean(),
    freshness: countsValidator,
    executionMode: countsValidator,
  }),
  notAssessed: v.object({
    activation: v.string(),
    readinessByNeedBy: v.string(),
    savings: v.string(),
    revenue: v.string(),
    retention: v.string(),
    providerCost: v.string(),
    successRate: v.string(),
  }),
  completeness: v.object({
    complete: v.boolean(),
    truncatedSections: v.array(v.string()),
    overflowedSections: v.array(v.string()),
  }),
});

interface Page<Row> {
  readonly rows: readonly Row[];
  readonly truncated: boolean;
}

/** One-row truncation probe over an indexed bounded read. */
async function boundedTake<Row>(
  scan: Promise<Row[]>,
  limit: number,
): Promise<Page<Row>> {
  const page = await scan;
  return page.length > limit
    ? { rows: page.slice(0, limit), truncated: true }
    : { rows: page, truncated: false };
}

export const projectUsageMetrics = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
  },
  returns: v.union(metricsValidator, denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }

    const truncatedSections: string[] = [];

    // -- Jobs -------------------------------------------------------------
    const jobsPage = await boundedTake(
      ctx.db
        .query("jobs")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.jobs + 1),
      LIMITS.jobs,
    );
    if (jobsPage.truncated) truncatedSections.push("jobs");
    const jobCounts = zeroCounts(JOB_STATES);
    for (const job of jobsPage.rows) bump(jobCounts, job.state);

    // -- Operations, attempts (retries), reservations ---------------------
    let operationsTruncated = false;
    let attemptsTruncated = false;
    let reservationsTruncated = false;
    const operationCounts = zeroCounts(OPERATION_STATES);
    const attemptCounts = zeroCounts(ATTEMPT_STATES);
    const reservationCounts = zeroCounts(RESERVATION_STATES);
    let operationsScanned = 0;
    let attemptsScanned = 0;
    let retries = 0;
    let attemptsWithObservedAt = 0;
    let attemptsWithSaneInterval = 0;
    let totalObservedElapsedMs: number | Overflow = 0;
    let reservationsScanned = 0;
    let reservedMicroUsd: number | Overflow = 0;
    let spentMicroUsd: number | Overflow = 0;
    let unresolvedMicroUsd: number | Overflow = 0;
    let reservationsWithUnresolvedCharges = 0;

    for (const job of jobsPage.rows) {
      const opsPage = await boundedTake(
        ctx.db
          .query("operations")
          .withIndex("by_job", (q) => q.eq("jobId", job._id))
          .take(LIMITS.operationsPerJob + 1),
        LIMITS.operationsPerJob,
      );
      if (opsPage.truncated) operationsTruncated = true;
      operationsScanned += opsPage.rows.length;

      for (const operation of opsPage.rows) {
        bump(operationCounts, operation.state);

        const attemptsPage = await boundedTake(
          ctx.db
            .query("attempts")
            .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
            .take(LIMITS.attemptsPerOperation + 1),
          LIMITS.attemptsPerOperation,
        );
        if (attemptsPage.truncated) attemptsTruncated = true;
        attemptsScanned += attemptsPage.rows.length;
        retries += Math.max(0, attemptsPage.rows.length - 1);
        for (const attempt of attemptsPage.rows) {
          bump(attemptCounts, attempt.state);
          if (attempt.observedAt !== undefined) {
            attemptsWithObservedAt += 1;
            if (attempt.observedAt >= attempt.createdAt) {
              attemptsWithSaneInterval += 1;
              totalObservedElapsedMs = addSafe(
                totalObservedElapsedMs,
                attempt.observedAt - attempt.createdAt,
              );
            }
          }
        }
      }

      const reservationsPage = await boundedTake(
        ctx.db
          .query("reservations")
          .withIndex("by_job", (q) => q.eq("jobId", job._id))
          .take(LIMITS.reservationsPerJob + 1),
        LIMITS.reservationsPerJob,
      );
      if (reservationsPage.truncated) reservationsTruncated = true;
      reservationsScanned += reservationsPage.rows.length;
      for (const reservation of reservationsPage.rows) {
        bump(reservationCounts, reservation.state);
        reservedMicroUsd = addSafe(reservedMicroUsd, reservation.reservedMicroUsd);
        spentMicroUsd = addSafe(spentMicroUsd, reservation.spentMicroUsd);
        unresolvedMicroUsd = addSafe(unresolvedMicroUsd, reservation.unresolvedMicroUsd);
        if (reservation.unresolvedMicroUsd > 0) {
          reservationsWithUnresolvedCharges += 1;
        }
      }
    }
    if (operationsTruncated) truncatedSections.push("operations");
    if (attemptsTruncated) truncatedSections.push("attempts");
    if (reservationsTruncated) truncatedSections.push("providerUsage.reservations");
    const overflowedSections: string[] = [];
    if (
      reservedMicroUsd === OVERFLOW ||
      spentMicroUsd === OVERFLOW ||
      unresolvedMicroUsd === OVERFLOW
    ) {
      overflowedSections.push("providerUsage");
    }
    if (totalObservedElapsedMs === OVERFLOW) {
      overflowedSections.push("attempts.observedElapsed");
    }

    // -- Approvals (approved decisions and recorded user interventions) ---
    const approvalsPage = await boundedTake(
      ctx.db
        .query("approvals")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.approvals + 1),
      LIMITS.approvals,
    );
    if (approvalsPage.truncated) truncatedSections.push("decisions.approvals");
    const approvalCounts = zeroCounts(APPROVAL_STATES);
    let approvalsDecided = 0;
    for (const approval of approvalsPage.rows) {
      bump(approvalCounts, approval.state);
      if (approval.decidedAt !== undefined) approvalsDecided += 1;
    }

    // -- Recorded order outcomes ------------------------------------------
    const ordersPage = await boundedTake(
      ctx.db
        .query("orders")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.orders + 1),
      LIMITS.orders,
    );
    if (ordersPage.truncated) truncatedSections.push("decisions.orders");
    const orderCounts = zeroCounts(ORDER_STATES);
    for (const order of ordersPage.rows) bump(orderCounts, order.state);

    // -- Recorded service outcomes ----------------------------------------
    const serviceCasesPage = await boundedTake(
      ctx.db
        .query("serviceCases")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.serviceCases + 1),
      LIMITS.serviceCases,
    );
    if (serviceCasesPage.truncated) {
      truncatedSections.push("decisions.serviceCases");
    }
    const serviceCaseCounts = zeroCounts(SERVICE_CASE_STATES);
    let serviceCasesWithRecordedOutcome = 0;
    for (const serviceCase of serviceCasesPage.rows) {
      bump(serviceCaseCounts, serviceCase.state);
      if (serviceCase.outcome !== undefined) serviceCasesWithRecordedOutcome += 1;
    }

    // -- Confirmed spend, grouped by currency, no conversion ---------------
    const spendPage = await boundedTake(
      ctx.db
        .query("costEntries")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.costEntries + 1),
      LIMITS.costEntries,
    );
    if (spendPage.truncated) truncatedSections.push("spend.costEntries");
    interface CurrencyBucket {
      entries: number;
      byKind: Record<string, number>;
      paymentsAndSettledMinorUnits: number | Overflow;
      refundsAndCreditsMinorUnits: number | Overflow;
    }
    const spendByCurrency = new Map<string, CurrencyBucket>();
    for (const entry of spendPage.rows) {
      let bucket = spendByCurrency.get(entry.amount.currency);
      if (bucket === undefined) {
        bucket = {
          entries: 0,
          byKind: zeroCounts(COST_ENTRY_KINDS),
          paymentsAndSettledMinorUnits: 0,
          refundsAndCreditsMinorUnits: 0,
        };
        spendByCurrency.set(entry.amount.currency, bucket);
      }
      bucket.entries += 1;
      bump(bucket.byKind, entry.kind);
      if (entry.kind === "payment" || entry.kind === "settledCost") {
        bucket.paymentsAndSettledMinorUnits = addSafe(
          bucket.paymentsAndSettledMinorUnits,
          entry.amount.minorUnits,
        );
      } else {
        bucket.refundsAndCreditsMinorUnits = addSafe(
          bucket.refundsAndCreditsMinorUnits,
          entry.amount.minorUnits,
        );
      }
    }
    const currencies = [...spendByCurrency.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([currency, bucket]) => {
        if (
          bucket.paymentsAndSettledMinorUnits === OVERFLOW ||
          bucket.refundsAndCreditsMinorUnits === OVERFLOW
        ) {
          overflowedSections.push(`spend.currencies.${currency}`);
        }
        return {
          currency,
          entries: bucket.entries,
          byKind: bucket.byKind,
          paymentsAndSettledMinorUnits: measuredTotal(bucket.paymentsAndSettledMinorUnits),
          refundsAndCreditsMinorUnits: measuredTotal(bucket.refundsAndCreditsMinorUnits),
          // With both components exact, the difference stays exact; with
          // either component unavailable, the net is unavailable too.
          netMinorUnits:
            bucket.paymentsAndSettledMinorUnits === OVERFLOW ||
            bucket.refundsAndCreditsMinorUnits === OVERFLOW
              ? measuredTotal(OVERFLOW)
              : measuredTotal(
                  bucket.paymentsAndSettledMinorUnits - bucket.refundsAndCreditsMinorUnits,
                ),
        };
      });

    // -- Collection provenance: cached vs fresh, controlled vs live -------
    const evidencePage = await boundedTake(
      ctx.db
        .query("productEvidence")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(LIMITS.productEvidence + 1),
      LIMITS.productEvidence,
    );
    if (evidencePage.truncated) truncatedSections.push("collection.productEvidence");
    const freshnessCounts = zeroCounts(EVIDENCE_FRESHNESS);
    const executionModeCounts = zeroCounts(EVIDENCE_EXECUTION_MODES);
    for (const row of evidencePage.rows) {
      bump(freshnessCounts, row.freshness);
      bump(executionModeCounts, row.executionMode);
    }

    return {
      ok: true as const,
      scope: {
        organizationId: args.organizationId,
        projectId: args.projectId,
      },
      jobs: {
        scanned: jobsPage.rows.length,
        truncated: jobsPage.truncated,
        byState: jobCounts,
      },
      operations: {
        scanned: operationsScanned,
        truncated: operationsTruncated,
        byState: operationCounts,
      },
      attempts: {
        scanned: attemptsScanned,
        truncated: attemptsTruncated,
        retries,
        byState: attemptCounts,
        observedElapsed: {
          attemptsWithObservedAt,
          attemptsWithSaneInterval,
          totalObservedElapsedMs: measuredTotal(totalObservedElapsedMs),
        },
      },
      providerUsage: {
        reservationsScanned,
        reservationsTruncated,
        byState: reservationCounts,
        reservedMicroUsd: measuredTotal(reservedMicroUsd),
        spentMicroUsd: measuredTotal(spentMicroUsd),
        unresolvedMicroUsd: measuredTotal(unresolvedMicroUsd),
        reservationsWithUnresolvedCharges,
      },
      decisions: {
        approvals: {
          scanned: approvalsPage.rows.length,
          truncated: approvalsPage.truncated,
          byState: approvalCounts,
          decided: approvalsDecided,
        },
        orders: {
          scanned: ordersPage.rows.length,
          truncated: ordersPage.truncated,
          byState: orderCounts,
        },
        serviceCases: {
          scanned: serviceCasesPage.rows.length,
          truncated: serviceCasesPage.truncated,
          byState: serviceCaseCounts,
          withRecordedOutcome: serviceCasesWithRecordedOutcome,
        },
      },
      spend: {
        entriesScanned: spendPage.rows.length,
        entriesTruncated: spendPage.truncated,
        currencies,
      },
      collection: {
        evidenceScanned: evidencePage.rows.length,
        evidenceTruncated: evidencePage.truncated,
        freshness: freshnessCounts,
        executionMode: executionModeCounts,
      },
      notAssessed: { ...notAssessedReasons },
      completeness: {
        complete: truncatedSections.length === 0 && overflowedSections.length === 0,
        truncatedSections,
        overflowedSections,
      },
    };
  },
});

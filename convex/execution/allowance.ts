/**
 * Narrowly scoped shared provider-budget allowance (ADR-0004, D-16).
 *
 * Research dispatch draws every reservation from the organization-level
 * `providerBudgets` ledger, never from an independent allowance. This module
 * only admits the ledger row itself:
 *
 * - The ceiling comes from exactly one server-only env value,
 *   `RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD`. It is read inside Convex
 *   functions only and is never returned to a browser caller.
 * - A fresh organization receives one capped ledger row on first admitted
 *   dispatch. An existing row is never refilled, raised, or re-priced here;
 *   its ceiling stays exactly as first written.
 * - A missing, blank, non-integer, non-positive, below-minimum, or
 *   over-cap allowance fails closed before any grant, job, reservation,
 *   operation, or provider call is created.
 *
 * Deployment aggregate (Astra repair): per-org rows are accounting
 * partitions only. One `deploymentAllowances` row with key
 * `GLOBAL_ALLOWANCE_KEY` bounds the SUM of reservations across all
 * organizations and guest sessions. New organizations never mint fresh
 * spendable funds: every reservation debits both ledgers atomically in the
 * same mutation (see reservations.ts / attempts.ts), so concurrent
 * organizations serialize on the global row via Convex OCC and the loser
 * fails closed with `allowance-exhausted`. The configured 100,000
 * micro-USD app allowance is a hard global ceiling.
 *
 * This module exposes no public Convex function: callers use the plain
 * `ensureSharedBudget` helper inside their own authorized mutation, so no
 * new API surface or browser-readable value is introduced.
 */

import { env } from "../_generated/server.js";
import type { F1MutationCtx } from "../server.js";
import type { Id } from "../_generated/dataModel.js";

/** The single server-only env value that funds a fresh org ledger. */
export const RESEARCH_ALLOWANCE_ENV_VAR = "RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD" as const;

/** Hard cap for any freshly initialized ledger (10 USD in micro-USD). */
export const RESEARCH_ALLOWANCE_MAX_MICRO_USD = 10_000_000 as const;

/**
 * Deployment-wide hard ceiling for the Firecrawl provider account
 * (100,000 micro-USD = USD 0.10). The sum of reservations across every
 * organization and guest session never exceeds this value, regardless of
 * how many per-org ledger rows exist. The env value funds the global row;
 * any env amount above this cap is clamped to it for global admission.
 */
export const RESEARCH_GLOBAL_HARD_CEILING_MICRO_USD = 100_000 as const;

/** Singleton key for the deployment-wide Firecrawl allowance aggregate. */
export const GLOBAL_ALLOWANCE_KEY = "firecrawl-shared-global-v1" as const;

/** Ledger pricing-basis label for rows initialized through this module. */
export const RESEARCH_ALLOWANCE_PRICING_BASIS = "research-shared-allowance-v1" as const;

export type ResearchAllowanceParse =
  | { readonly ok: true; readonly ceilingMicroUsd: number }
  | { readonly ok: false; readonly code: "allowance-exhausted"; readonly message: string };

/**
 * Parse one server-only allowance value. The caller supplies the minimum
 * that its fixed reservation requires, so this module never learns which
 * provider bound applies. Anything that cannot fund real work fails closed
 * with the same honest code the dispatch path surfaces.
 */
export function parseResearchAllowance(
  raw: unknown,
  minimumMicroUsd: number,
): ResearchAllowanceParse {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (text.length === 0 || !/^\d+$/.test(text)) {
    return {
      ok: false as const,
      code: "allowance-exhausted" as const,
      message: "provider allowance is not configured for this deployment",
    };
  }
  const ceiling = Number(text);
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
    return {
      ok: false as const,
      code: "allowance-exhausted" as const,
      message: "provider allowance is not configured for this deployment",
    };
  }
  if (ceiling < minimumMicroUsd || ceiling > RESEARCH_ALLOWANCE_MAX_MICRO_USD) {
    return {
      ok: false as const,
      code: "allowance-exhausted" as const,
      message: "provider allowance cannot cover one bounded research call",
    };
  }
  return { ok: true as const, ceilingMicroUsd: ceiling };
}

export interface SharedBudgetAssurance {
  readonly minimumMicroUsd: number;
  readonly pricingBasis: string;
}

export type EnsureSharedBudgetResult =
  | { readonly ok: true; readonly budgetId: Id<"providerBudgets">; readonly initialized: boolean }
  | { readonly ok: false; readonly code: "allowance-exhausted"; readonly message: string };

/** Effective global ceiling: env-funded but never above the hard cap. */
export function effectiveGlobalCeiling(envCeilingMicroUsd: number): number {
  return Math.min(envCeilingMicroUsd, RESEARCH_GLOBAL_HARD_CEILING_MICRO_USD);
}

/**
 * Bounded legacy-partition count for first-global-row migration. The
 * migration reads at most this many per-org ledger rows in one bounded
 * query; more partitions than this fail closed and require an explicit
 * migration instead of a silent undercount.
 */
export const MAX_MIGRATION_ORG_PARTITIONS = 64 as const;

/**
 * Load or initialize the singleton deployment aggregate. Creation and the
 * caller's subsequent org admission run in the same mutation, so concurrent
 * organizations serialize on this row via OCC instead of each minting a
 * full allowance. An existing row is never raised: a lower env value cannot
 * refill spend, and a higher env value cannot exceed the first-written
 * ceiling without an explicit migration.
 *
 * Migration invariant: when the global row is created after per-org
 * ledgers already carry spend, the creation seeds the aggregate from the
 * bounded sum of those legacy partitions instead of starting at zero.
 * Starting at zero would permit extra spend beyond the stated app cap. The
 * seed reads at most MAX_MIGRATION_ORG_PARTITIONS rows; a larger partition
 * set fails closed (throws) rather than silently undercounting.
 */
export async function ensureGlobalAllowance(
  ctx: F1MutationCtx,
  ceilingMicroUsd: number,
  pricingBasis: string,
): Promise<Id<"deploymentAllowances">> {
  const capped = Math.min(ceilingMicroUsd, RESEARCH_GLOBAL_HARD_CEILING_MICRO_USD);
  const existing = await ctx.db
    .query("deploymentAllowances")
    .withIndex("by_key", (q) => q.eq("key", GLOBAL_ALLOWANCE_KEY))
    .unique();
  if (existing !== null) return existing._id;
  const seed = await sumLegacyPartitionCommitment(ctx);
  return await ctx.db.insert("deploymentAllowances", {
    key: GLOBAL_ALLOWANCE_KEY,
    ceilingMicroUsd: capped,
    reservedMicroUsd: seed.reservedMicroUsd,
    spentMicroUsd: seed.spentMicroUsd,
    unresolvedMicroUsd: seed.unresolvedMicroUsd,
    pricingBasis,
    updatedAt: Date.now(),
  });
}

/**
 * Bounded sum of pre-existing per-org ledger commitments for global-row
 * seeding. Reads at most MAX_MIGRATION_ORG_PARTITIONS + 1 rows; throws
 * (fail closed) when more partitions exist than can be proven in one
 * bounded read, instead of silently seeding an undercount.
 */
export async function sumLegacyPartitionCommitment(ctx: F1MutationCtx): Promise<{
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly unresolvedMicroUsd: number;
}> {
  const rows = await ctx.db.query("providerBudgets").take(MAX_MIGRATION_ORG_PARTITIONS + 1);
  if (rows.length > MAX_MIGRATION_ORG_PARTITIONS) {
    throw new Error(
      "deployment allowance migration requires an explicit bounded migration: too many organization partitions",
    );
  }
  let reservedMicroUsd = 0;
  let spentMicroUsd = 0;
  let unresolvedMicroUsd = 0;
  for (const row of rows) {
    reservedMicroUsd += row.reservedMicroUsd;
    spentMicroUsd += row.spentMicroUsd;
    unresolvedMicroUsd += row.unresolvedMicroUsd;
  }
  return { reservedMicroUsd, spentMicroUsd, unresolvedMicroUsd };
}

/** Read the deployment aggregate without creating it. */
export async function getGlobalAllowance(ctx: F1MutationCtx) {
  return await ctx.db
    .query("deploymentAllowances")
    .withIndex("by_key", (q) => q.eq("key", GLOBAL_ALLOWANCE_KEY))
    .unique();
}

/**
 * Atomically check-and-debit the global aggregate for one reservation.
 * Must be called in the same mutation that debits the org ledger so the
 * two can never drift. Returns false when the global hard ceiling cannot
 * cover the amount; the caller then fails closed without touching the org
 * ledger.
 */
export async function tryDebitGlobalForReservation(
  ctx: F1MutationCtx,
  amountMicroUsd: number,
): Promise<boolean> {
  const global = await getGlobalAllowance(ctx);
  if (global === null) return false;
  const committed =
    global.reservedMicroUsd + global.spentMicroUsd + global.unresolvedMicroUsd;
  if (committed + amountMicroUsd > global.ceilingMicroUsd) return false;
  await ctx.db.patch(global._id, {
    reservedMicroUsd: global.reservedMicroUsd + amountMicroUsd,
    updatedAt: Date.now(),
  });
  return true;
}

/**
 * Exact global attribution for one reservation row.
 *
 * - Rows created through `reserve` carry their explicit
 *   `globalReservedMicroUsd` marker: the hold placed on the aggregate in
 *   the same mutation. That marker is authoritative.
 * - Valid pre-global legacy rows predate the singleton
 *   (`_creationTime <= global._creationTime`), so their exposure was
 *   included in the bounded-sum seed. Their exact attributable hold is
 *   their current org-side reserved amount: application paths only ever
 *   decrease it after seeding (admits mirror globally in lockstep,
 *   settlement and cancellation close the row), so it can never exceed
 *   what was seeded.
 * - Post-global rows without a marker were never seeded and never debited
 *   the aggregate: attribution zero. Cancelling or settling them moves
 *   org-side only and cannot decrement another tenant's hold.
 *
 * A null aggregate means no global accounting exists at all: zero.
 */
export function attributedGlobalHold(
  reservation: {
    readonly globalReservedMicroUsd?: number;
    readonly reservedMicroUsd: number;
    readonly _creationTime: number;
  },
  global: { readonly _creationTime: number } | null,
): number {
  if (global === null) return 0;
  const explicit = reservation.globalReservedMicroUsd;
  if (typeof explicit === "number") return explicit;
  if (reservation._creationTime <= global._creationTime) {
    return reservation.reservedMicroUsd;
  }
  return 0;
}

/**
 * Exact unresolved-leg attribution for one reservation row.
 *
 * Mirrors `attributedGlobalHold` for the aggregate's unresolved exposure:
 * an explicit `globalUnresolvedMicroUsd` marker is authoritative; a valid
 * pre-global legacy row (no marker, created no later than the singleton)
 * is attributed its current org-side unresolved amount; a post-global row
 * without a marker never funded the aggregate and attributes zero.
 *
 * The legacy fallback is sound without inferring ownership from the
 * aggregate balance: every production mutation that changes a
 * reservation's unresolved amount moves the same delta on the aggregate
 * in the same mutation (settlement retains, reads spend), and unbound
 * post-global rows are excluded by age. Attribution therefore never
 * exceeds what was seeded or moved in lockstep for that row.
 *
 * A null aggregate means no global accounting exists at all: zero.
 */
export function attributedGlobalUnresolved(
  reservation: {
    readonly globalUnresolvedMicroUsd?: number;
    readonly unresolvedMicroUsd: number;
    readonly _creationTime: number;
  },
  global: { readonly _creationTime: number } | null,
): number {
  if (global === null) return 0;
  const explicit = reservation.globalUnresolvedMicroUsd;
  if (typeof explicit === "number") return explicit;
  if (reservation._creationTime <= global._creationTime) {
    return reservation.unresolvedMicroUsd;
  }
  return 0;
}

/** Both aggregate legs attributed to one reservation row. */
export interface GlobalAttribution {
  readonly reserved: number;
  readonly unresolved: number;
}

export function attributedGlobalExposure(
  reservation: {
    readonly globalReservedMicroUsd?: number;
    readonly globalUnresolvedMicroUsd?: number;
    readonly reservedMicroUsd: number;
    readonly unresolvedMicroUsd: number;
    readonly _creationTime: number;
  },
  global: { readonly _creationTime: number } | null,
): GlobalAttribution {
  return {
    reserved: attributedGlobalHold(reservation, global),
    unresolved: attributedGlobalUnresolved(reservation, global),
  };
}
/**
 * Mirror one settlement leg to the global aggregate. Called in the same
 * mutation as the org settlement so ledgers stay paired. The moved amount
 * is the acting reservation's own reserved attribution (see
 * `attributedGlobalHold`): the aggregate moves only exposure actually
 * attributed to that reservation, never an unproven share of another
 * tenant's hold. Unbound attributions are a no-op. Strict: an attributed
 * amount the aggregate cannot cover is genuine drift, so the mutation
 * throws (fail closed) instead of clamping with Math.max and silently
 * masking it. Legacy deployments without a global row keep org-only
 * accounting.
 *
 * Returns the reservation's updated global markers so the caller can
 * persist them on the reservation row in the same mutation and keep the
 * per-reservation attribution exact across later reads and settlements,
 * or null when no global move happened (no aggregate row, or a fully
 * unbound reservation) so the caller leaves markers untouched.
 */
export async function settleGlobalReservation(
  ctx: F1MutationCtx,
  mode: "spend" | "release" | "retainUnknown",
  reservation: {
    readonly globalReservedMicroUsd?: number;
    readonly globalUnresolvedMicroUsd?: number;
    readonly reservedMicroUsd: number;
    readonly unresolvedMicroUsd: number;
    readonly _creationTime: number;
  },
): Promise<GlobalAttribution | null> {
  const global = await getGlobalAllowance(ctx);
  if (global === null) return null;
  const attributed = attributedGlobalHold(reservation, global);
  const attributedUnresolved = attributedGlobalUnresolved(reservation, global);
  if (attributed <= 0) {
    // No reserved hold to move: a fully unbound reservation is a no-op,
    // while a row that already carries unresolved attribution gets its
    // markers pinned without touching the aggregate.
    if (attributedUnresolved <= 0) return null;
    return { reserved: 0, unresolved: attributedUnresolved };
  }
  if (global.reservedMicroUsd < attributed) {
    throw new Error("deployment allowance ledger drift: global reserved cannot cover settlement");
  }
  const now = Date.now();
  if (mode === "spend") {
    await ctx.db.patch(global._id, {
      reservedMicroUsd: global.reservedMicroUsd - attributed,
      spentMicroUsd: global.spentMicroUsd + attributed,
      updatedAt: now,
    });
    return { reserved: 0, unresolved: attributedUnresolved };
  } else if (mode === "retainUnknown") {
    await ctx.db.patch(global._id, {
      reservedMicroUsd: global.reservedMicroUsd - attributed,
      unresolvedMicroUsd: global.unresolvedMicroUsd + attributed,
      updatedAt: now,
    });
    return { reserved: 0, unresolved: attributedUnresolved + attributed };
  } else {
    await ctx.db.patch(global._id, {
      reservedMicroUsd: global.reservedMicroUsd - attributed,
      updatedAt: now,
    });
    return { reserved: 0, unresolved: attributedUnresolved };
  }
}

/**
 * Admit the organization's shared ledger, initializing it once from the
 * server-only allowance when it does not exist yet. An existing row is
 * returned untouched: this helper never patches a ceiling, adds funds, or
 * changes the pricing basis, so a deployment cannot silently refill spend.
 *
 * The deployment aggregate is ensured first in the same transaction. The
 * per-org row is an accounting partition, not independent funds: admission
 * here creates the partition, but every later reservation still debits the
 * global aggregate atomically, so N organizations share one hard ceiling.
 */
export async function ensureSharedBudget(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  assurance: SharedBudgetAssurance,
): Promise<EnsureSharedBudgetResult> {
  if (assurance.pricingBasis.trim().length === 0) {
    throw new Error("allowance pricing basis is required");
  }
  const parsed = parseResearchAllowance(env[RESEARCH_ALLOWANCE_ENV_VAR], assurance.minimumMicroUsd);
  if (!parsed.ok) return parsed;
  await ensureGlobalAllowance(ctx, parsed.ceilingMicroUsd, assurance.pricingBasis);
  const existing = await ctx.db
    .query("providerBudgets")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (existing !== null) {
    return { ok: true as const, budgetId: existing._id, initialized: false as const };
  }
  const now = Date.now();
  const budgetId = await ctx.db.insert("providerBudgets", {
    organizationId,
    // Partition display cap: never above the global hard ceiling, so a new
    // organization row cannot suggest independent funds beyond the shared
    // deployment aggregate. Spend authority still comes from the global
    // check at reservation time.
    ceilingMicroUsd: effectiveGlobalCeiling(parsed.ceilingMicroUsd),
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    unresolvedMicroUsd: 0,
    pricingBasis: assurance.pricingBasis,
    updatedAt: now,
  });
  return { ok: true as const, budgetId, initialized: true as const };
}

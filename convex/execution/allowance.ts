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

/**
 * Admit the organization's shared ledger, initializing it once from the
 * server-only allowance when it does not exist yet. An existing row is
 * returned untouched: this helper never patches a ceiling, adds funds, or
 * changes the pricing basis, so a deployment cannot silently refill spend.
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
    ceilingMicroUsd: parsed.ceilingMicroUsd,
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    unresolvedMicroUsd: 0,
    pricingBasis: assurance.pricingBasis,
    updatedAt: now,
  });
  return { ok: true as const, budgetId, initialized: true as const };
}

/**
 * F1 requirements and dependencies (controlled contract, PRD 13/15/16/19).
 *
 * Requirements carry quantity, priority, approved constraints, progress,
 * and fulfillment as discriminated unions. Dependencies are typed
 * technical/scheduling edges with verification state; scheduling edges
 * never invent durations, and any edge that would close a directed cycle
 * is rejected before the write.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalAdd,
  decimalCompare,
  decimalToString,
  decimalZero,
  quantity,
  type Decimal,
} from "../../proofs/money/decimal.js";
import { currencyCode, money as makeMoney } from "../../proofs/money/money.js";
import { canonicalJson } from "../shared/hashing.js";
import {
  dependencyVerificationInputValidator,
  dependencyCreatesCycle,
  dependencyInputValidator,
  normalizeBoundedText,
  normalizeRequirementDate,
  normalizeRequirementIdempotencyKey,
  REQUIREMENT_CATEGORY_MAX_LENGTH,
  REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
  REQUIREMENT_KEY_MAX_LENGTH,
  REQUIREMENT_RESPONSIBLE_MAX_LENGTH,
  REQUIREMENT_REVISION_MAX_PAYLOAD_LENGTH,
  REQUIREMENT_TITLE_MAX_LENGTH,
  REQUIREMENT_UNIT_MAX_LENGTH,
  requirementEditInputValidator,
  requirementInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

const requirementResultValidator = v.union(
  v.object({ ok: v.literal(true), requirementId: v.id("requirements") }),
  denialValidator,
);

const requirementRevisionResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    revisionId: v.id("requirementRevisions"),
    requirementId: v.id("requirements"),
    version: v.number(),
    deduplicated: v.boolean(),
  }),
  denialValidator,
);

const dependencyVerificationResultValidator = v.union(
  v.object({ ok: v.literal(true), revisionId: v.id("dependencyRevisions") }),
  denialValidator,
);

const readinessRequirementValidator = v.object({
  id: v.id("requirements"),
  priority: v.string(),
  requiredQuantity: v.string(),
  fulfilledQuantity: v.string(),
  requiredMilestone: v.string(),
  fulfillment: v.string(),
  ready: v.boolean(),
  dependencyBlocked: v.boolean(),
});

const readinessResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    assessed: v.boolean(),
    status: v.union(v.literal("ready"), v.literal("notReady"), v.literal("notAssessed"), v.literal("incomplete")),
    readinessPercent: v.union(v.number(), v.null()),
    // `readiness` and `score` are stable aliases for projections that use
    // either product term; both remain null when scope is not assessed.
    readiness: v.union(v.number(), v.null()),
    score: v.union(v.number(), v.null()),
    numerator: v.number(),
    denominator: v.number(),
    unresolvedP0Count: v.number(),
    scopeSize: v.number(),
    incompleteReason: v.optional(v.string()),
    requirements: v.array(readinessRequirementValidator),
  }),
  denialValidator,
);

const MAX_READINESS_REQUIREMENTS = 200;
const MAX_READINESS_DEPENDENCIES = 500;
const MAX_READINESS_ORDERS = 500;
const MAX_READINESS_EVENTS = 1_000;
const MAX_READINESS_LIMIT = 200;

export const READINESS_REQUIREMENT_BOUND = MAX_READINESS_REQUIREMENTS;
export const READINESS_DEPENDENCY_BOUND = MAX_READINESS_DEPENDENCIES;
export const READINESS_ORDER_BOUND = MAX_READINESS_ORDERS;
export const READINESS_EVENT_BOUND = MAX_READINESS_EVENTS;

type RequirementPatch = {
  title?: string | null;
  category?: string | null;
  quantity?: string | null;
  unit?: string | null;
  priority?: "P0" | "P1" | "P2" | null;
  budgetMinorUnits?: number | null;
  currency?: string | null;
  needByAt?: number | null;
  hardConstraints?: string | null;
  responsible?: string | null;
  requiredMilestone?: "delivered" | "installed" | "commissioned" | null;
};

function hasPatchField(patch: RequirementPatch, field: keyof RequirementPatch): boolean {
  return Object.prototype.hasOwnProperty.call(patch, field);
}

function normalizeRequirementTextFields(args: {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly unit: string;
}): { key: string; title: string; category: string; unit: string } {
  return {
    key: normalizeBoundedText(args.key, "key", REQUIREMENT_KEY_MAX_LENGTH),
    title: normalizeBoundedText(args.title, "title", REQUIREMENT_TITLE_MAX_LENGTH),
    category: normalizeBoundedText(args.category, "category", REQUIREMENT_CATEGORY_MAX_LENGTH),
    unit: normalizeBoundedText(args.unit, "unit", REQUIREMENT_UNIT_MAX_LENGTH),
  };
}

function normalizeRequirementPatch(args: {
  readonly title?: string | null;
  readonly category?: string | null;
  readonly quantity?: string | null;
  readonly unit?: string | null;
  readonly priority?: "P0" | "P1" | "P2" | null;
  readonly budgetMinorUnits?: number | null;
  readonly currency?: string | null;
  readonly needByAt?: number | null;
  readonly hardConstraints?: string | null;
  readonly responsible?: string | null;
  readonly requiredMilestone?: "delivered" | "installed" | "commissioned" | null;
}): RequirementPatch {
  const patch: RequirementPatch = {};
  if (args.title !== undefined) {
    if (args.title === null) throw new Error("title cannot be cleared");
    patch.title = normalizeBoundedText(args.title, "title", REQUIREMENT_TITLE_MAX_LENGTH);
  }
  if (args.category !== undefined) {
    if (args.category === null) throw new Error("category cannot be cleared");
    patch.category = normalizeBoundedText(args.category, "category", REQUIREMENT_CATEGORY_MAX_LENGTH);
  }
  if (args.quantity !== undefined) {
    if (args.quantity === null) throw new Error("quantity cannot be cleared");
    patch.quantity = decimalToString(quantity(args.quantity));
  }
  if (args.unit !== undefined) {
    if (args.unit === null) throw new Error("unit cannot be cleared");
    patch.unit = normalizeBoundedText(args.unit, "unit", REQUIREMENT_UNIT_MAX_LENGTH);
  }
  if (args.priority !== undefined) {
    if (args.priority === null) throw new Error("priority cannot be cleared");
    patch.priority = args.priority;
  }
  if (args.budgetMinorUnits !== undefined) {
    if (args.budgetMinorUnits !== null &&
      (!Number.isSafeInteger(args.budgetMinorUnits) || args.budgetMinorUnits < 0)) {
      throw new Error("budget amount must be a non-negative safe integer");
    }
    patch.budgetMinorUnits = args.budgetMinorUnits;
  }
  if (args.currency !== undefined) {
    patch.currency = args.currency === null
      ? null
      : currencyCode(normalizeBoundedText(args.currency, "currency", 3));
  }
  if (args.needByAt !== undefined) {
    patch.needByAt = args.needByAt === null
      ? null
      : normalizeRequirementDate(args.needByAt);
  }
  if (args.hardConstraints !== undefined) {
    patch.hardConstraints = args.hardConstraints === null
      ? null
      : normalizeBoundedText(
        args.hardConstraints,
        "hard constraints",
        REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
      );
  }
  if (args.responsible !== undefined) {
    patch.responsible = args.responsible === null
      ? null
      : normalizeBoundedText(
        args.responsible,
        "responsible",
        REQUIREMENT_RESPONSIBLE_MAX_LENGTH,
      );
  }
  if (args.requiredMilestone !== undefined) patch.requiredMilestone = args.requiredMilestone;
  if (Object.keys(patch).length === 0) throw new Error("at least one requirement field must change");
  return patch;
}

function safeMoney(
  currency: string | undefined,
  minorUnits: number | undefined,
): { readonly currency?: string; readonly minorUnits?: number } {
  if (minorUnits === undefined) return currency === undefined ? {} : { currency };
  if (currency === undefined) throw new Error("budget currency required");
  const checked = makeMoney(currency, minorUnits);
  return { currency: checked.currency, minorUnits: checked.minorUnits };
}

type RequirementSnapshot = {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly quantity: string;
  readonly unit: string;
  readonly priority: "P0" | "P1" | "P2";
  readonly state: string;
  readonly fulfillment: string;
  readonly version: number;
  readonly budgetMinorUnits?: number;
  readonly currency?: string;
  readonly needByAt?: number;
  readonly hardConstraints?: string;
  readonly responsible?: string;
  readonly requiredMilestone?: "delivered" | "installed" | "commissioned";
};

function requirementSnapshot(row: {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly quantity: string;
  readonly unit: string;
  readonly priority: "P0" | "P1" | "P2";
  readonly state: string;
  readonly fulfillment: string;
  readonly version: number;
  readonly budgetMinorUnits?: number;
  readonly currency?: string;
  readonly needByAt?: number;
  readonly hardConstraints?: string;
  readonly responsible?: string;
  readonly requiredMilestone?: "delivered" | "installed" | "commissioned";
}): RequirementSnapshot {
  return {
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
    ...(row.hardConstraints === undefined ? {} : { hardConstraints: row.hardConstraints }),
    ...(row.responsible === undefined ? {} : { responsible: row.responsible }),
    ...(row.requiredMilestone === undefined ? {} : { requiredMilestone: row.requiredMilestone }),
  };
}

function applyRequirementPatch(
  row: Parameters<typeof requirementSnapshot>[0],
  patch: RequirementPatch,
  version: number,
): RequirementSnapshot {
  const budget = hasPatchField(patch, "budgetMinorUnits")
    ? patch.budgetMinorUnits ?? undefined
    : row.budgetMinorUnits;
  const currency = hasPatchField(patch, "currency")
    ? patch.currency ?? undefined
    : row.currency;
  safeMoney(currency, budget);
  return {
    key: row.key,
    title: patch.title === null ? row.title : patch.title ?? row.title,
    category: patch.category === null ? row.category : patch.category ?? row.category,
    quantity: patch.quantity === null ? row.quantity : patch.quantity ?? row.quantity,
    unit: patch.unit === null ? row.unit : patch.unit ?? row.unit,
    priority: patch.priority === null ? row.priority : patch.priority ?? row.priority,
    state: row.state,
    fulfillment: row.fulfillment,
    version,
    ...(budget === undefined ? {} : { budgetMinorUnits: budget }),
    ...(currency === undefined ? {} : { currency }),
    ...(hasPatchField(patch, "needByAt")
      ? patch.needByAt === null ? {} : { needByAt: patch.needByAt }
      : row.needByAt === undefined ? {} : { needByAt: row.needByAt }),
    ...(hasPatchField(patch, "hardConstraints")
      ? patch.hardConstraints === null ? {} : { hardConstraints: patch.hardConstraints }
      : row.hardConstraints === undefined ? {} : { hardConstraints: row.hardConstraints }),
    ...(hasPatchField(patch, "responsible")
      ? patch.responsible === null ? {} : { responsible: patch.responsible }
      : row.responsible === undefined ? {} : { responsible: row.responsible }),
    ...(hasPatchField(patch, "requiredMilestone")
      ? patch.requiredMilestone === null ? {} : { requiredMilestone: patch.requiredMilestone }
      : row.requiredMilestone === undefined ? {} : { requiredMilestone: row.requiredMilestone }),
  };
}

/** Create a requirement; the key is unique per project (idempotency). */
export const create = f1Mutation({
  args: requirementInputValidator.fields,
  returns: requirementResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    let textFields: ReturnType<typeof normalizeRequirementTextFields>;
    try {
      textFields = normalizeRequirementTextFields(args);
    } catch (error) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: error instanceof Error ? error.message : "requirement text is invalid",
      };
    }
    // F1R-09: quantities and money validate through the accepted
    // proofs/money contract before any read-or-write side effect beyond
    // the access check. Positive decimals only; malformed or
    // unsupported-precision input is denied, and normalized decimals
    // (e.g. "1.0") persist in canonical form.
    let normalizedQuantity: string;
    try {
      const parsed = quantity(args.quantity);
      if (decimalCompare(parsed, decimalZero()) <= 0) {
        return { ok: false as const, code: "invalid-payload", message: "quantity must be positive" };
      }
      normalizedQuantity = decimalToString(parsed);
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "quantity is not a valid decimal" };
    }
    let normalizedCurrency: string | undefined;
    if (args.currency !== undefined) {
      try {
        normalizedCurrency = currencyCode(
          normalizeBoundedText(args.currency, "currency", 3),
        );
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "currency is invalid" };
      }
    }
    if (args.budgetMinorUnits !== undefined) {
      if (
        typeof args.budgetMinorUnits !== "number" ||
        !Number.isSafeInteger(args.budgetMinorUnits)
      ) {
        return { ok: false as const, code: "invalid-payload", message: "budget amount must be a safe integer" };
      }
      if (args.budgetMinorUnits < 0) {
        return { ok: false as const, code: "invalid-payload", message: "budget amount cannot be negative" };
      }
      if (normalizedCurrency === undefined) {
        return { ok: false as const, code: "invalid-payload", message: "budget currency required" };
      }
      try {
        makeMoney(normalizedCurrency, args.budgetMinorUnits);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "budget money is invalid" };
      }
    }
    let normalizedNeedByAt: number | undefined;
    if (args.needByAt !== undefined) {
      try {
        normalizedNeedByAt = normalizeRequirementDate(args.needByAt);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "required date is invalid" };
      }
    }
    let normalizedHardConstraints: string | undefined;
    let normalizedResponsible: string | undefined;
    try {
      normalizedHardConstraints = args.hardConstraints === undefined
        ? undefined
        : normalizeBoundedText(
          args.hardConstraints,
          "hard constraints",
          REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
        );
      normalizedResponsible = args.responsible === undefined
        ? undefined
        : normalizeBoundedText(
          args.responsible,
          "responsible",
          REQUIREMENT_RESPONSIBLE_MAX_LENGTH,
        );
    } catch (error) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: error instanceof Error ? error.message : "requirement text is invalid",
      };
    }
    const duplicate = await ctx.db
      .query("requirements")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", textFields.key),
      )
      .unique();
    if (duplicate !== null) {
      return { ok: false as const, code: "duplicate-conflict", message: `requirement key ${textFields.key} exists` };
    }
    const now = Date.now();
    const requirementId = await ctx.db.insert("requirements", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      key: textFields.key,
      title: textFields.title,
      category: textFields.category,
      quantity: normalizedQuantity,
      unit: textFields.unit,
      priority: args.priority,
      state: "draft",
      fulfillment: "notOrdered",
      version: 1,
      ...(args.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: args.budgetMinorUnits }),
      ...(normalizedCurrency === undefined ? {} : { currency: normalizedCurrency }),
      ...(normalizedNeedByAt === undefined ? {} : { needByAt: normalizedNeedByAt }),
      ...(normalizedHardConstraints === undefined ? {} : { hardConstraints: normalizedHardConstraints }),
      ...(normalizedResponsible === undefined ? {} : { responsible: normalizedResponsible }),
      ...(args.requiredMilestone === undefined ? {} : { requiredMilestone: args.requiredMilestone }),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, requirementId };
  },
});

/**
 * Apply one contributor-authorized optimistic requirement edit.
 *
 * The requirement key is deliberately absent from the input contract. A
 * revision is an atomic compare-and-swap on `version`: the revision row,
 * mutable current projection, and one material project event commit in the
 * same transaction. The idempotency lookup happens before loading the
 * current projection, so an exact retry returns its original immutable
 * revision even after later edits have advanced the requirement.
 */
export const update = f1Mutation({
  args: requirementEditInputValidator.fields,
  returns: requirementRevisionResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    let idempotencyKey: string;
    let patch: RequirementPatch;
    try {
      if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1) {
        throw new Error("expected version must be a positive safe integer");
      }
      idempotencyKey = normalizeRequirementIdempotencyKey(args.idempotencyKey);
      patch = normalizeRequirementPatch(args);
    } catch (error) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: error instanceof Error ? error.message : "requirement edit is invalid",
      };
    }
    const patchCanonical = canonicalJson(patch);
    if (patchCanonical.length > REQUIREMENT_REVISION_MAX_PAYLOAD_LENGTH) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "requirement edit exceeds the supported size",
      };
    }
    const prior = await ctx.db
      .query("requirementRevisions")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (prior !== null) {
      if (prior.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "revision is not in this project" };
      }
      if (
        prior.requirementId !== args.requirementId ||
        prior.expectedVersion !== args.expectedVersion ||
        prior.patchCanonical !== patchCanonical ||
        prior.actor !== access.value.identity
      ) {
        return {
          ok: false as const,
          code: "duplicate-conflict",
          message: "idempotency key already used with different requirement edit",
        };
      }
      return {
        ok: true as const,
        revisionId: prior._id,
        requirementId: prior.requirementId,
        version: prior.nextVersion,
        deduplicated: true,
      };
    }
    const owned = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!owned.ok) {
      return { ok: false as const, code: owned.code, message: owned.message };
    }
    if (owned.value.version !== args.expectedVersion) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "requirement version is stale",
      };
    }
    if (!Number.isSafeInteger(owned.value.version + 1)) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "requirement version exhausted",
      };
    }
    let after: RequirementSnapshot;
    try {
      after = applyRequirementPatch(owned.value, patch, owned.value.version + 1);
    } catch (error) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: error instanceof Error ? error.message : "requirement edit is invalid",
      };
    }
    const before = requirementSnapshot(owned.value);
    if (canonicalJson(before) === canonicalJson(after)) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "requirement edit does not change any field",
      };
    }
    const now = Date.now();
    const revisionId = await ctx.db.insert("requirementRevisions", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      requirementId: args.requirementId,
      idempotencyKey,
      expectedVersion: args.expectedVersion,
      previousVersion: owned.value.version,
      nextVersion: after.version,
      patchCanonical,
      before: canonicalJson(before),
      after: canonicalJson(after),
      actor: access.value.identity,
      createdAt: now,
    });
    await ctx.db.patch(args.requirementId, {
      ...(patch.title === undefined || patch.title === null ? {} : { title: patch.title }),
      ...(patch.category === undefined || patch.category === null ? {} : { category: patch.category }),
      ...(patch.quantity === undefined || patch.quantity === null ? {} : { quantity: patch.quantity }),
      ...(patch.unit === undefined || patch.unit === null ? {} : { unit: patch.unit }),
      ...(patch.priority === undefined || patch.priority === null ? {} : { priority: patch.priority }),
      ...(hasPatchField(patch, "budgetMinorUnits")
        ? patch.budgetMinorUnits === null ? { budgetMinorUnits: undefined } : { budgetMinorUnits: patch.budgetMinorUnits }
        : {}),
      ...(hasPatchField(patch, "currency")
        ? patch.currency === null ? { currency: undefined } : { currency: patch.currency }
        : {}),
      ...(hasPatchField(patch, "needByAt")
        ? patch.needByAt === null ? { needByAt: undefined } : { needByAt: patch.needByAt }
        : {}),
      ...(hasPatchField(patch, "hardConstraints")
        ? patch.hardConstraints === null ? { hardConstraints: undefined } : { hardConstraints: patch.hardConstraints }
        : {}),
      ...(hasPatchField(patch, "responsible")
        ? patch.responsible === null ? { responsible: undefined } : { responsible: patch.responsible }
        : {}),
      ...(hasPatchField(patch, "requiredMilestone")
        ? patch.requiredMilestone === null ? { requiredMilestone: undefined } : { requiredMilestone: patch.requiredMilestone }
        : {}),
      version: after.version,
      updatedAt: now,
    });
    await ctx.db.insert("projectEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: "requirement.revised",
      actor: access.value.identity,
      createdAt: now,
    });
    return {
      ok: true as const,
      revisionId,
      requirementId: args.requirementId,
      version: after.version,
      deduplicated: false,
    };
  },
});

/** Natural aliases used by the application and controlled callers. */
export const edit = update;
export const revise = update;
export const updateRequirement = update;
export const editRequirement = update;

/** Read immutable requirement revisions newest first within a small bound. */
export const listRevisions = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      revisions: v.array(
        v.object({
          id: v.id("requirementRevisions"),
          expectedVersion: v.number(),
          previousVersion: v.number(),
          nextVersion: v.number(),
          before: v.string(),
          after: v.string(),
          actor: v.string(),
        }),
      ),
    }),
    denialValidator,
  ),
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
    const owned = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!owned.ok) {
      return { ok: false as const, code: owned.code, message: owned.message };
    }
    if (!Number.isSafeInteger(args.limit) || args.limit <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "revision limit must be positive" };
    }
    const rows = await ctx.db
      .query("requirementRevisions")
      .withIndex("by_requirement", (q) => q.eq("requirementId", args.requirementId))
      .order("desc")
      .take(Math.min(100, Math.floor(args.limit)));
    return {
      ok: true as const,
      revisions: rows
        .filter((row) => row.organizationId === args.organizationId && row.projectId === args.projectId)
        .map((row) => ({
          id: row._id,
          expectedVersion: row.expectedVersion,
          previousVersion: row.previousVersion,
          nextVersion: row.nextVersion,
          before: row.before,
          after: row.after,
          actor: row.actor,
        })),
    };
  },
});

export const history = listRevisions;

/** Read one requirement in the caller's project (bounded single get). */
export const get = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    requirementId: v.id("requirements"),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      key: v.string(),
      title: v.string(),
      state: v.string(),
      fulfillment: v.string(),
      version: v.number(),
    }),
    denialValidator,
  ),
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
    const row = await requireOwnedRef(
      await ctx.db.get(args.requirementId),
      args.organizationId,
      args.projectId,
    );
    if (!row.ok) {
      return { ok: false as const, code: row.code, message: row.message };
    }
    return {
      ok: true as const,
      key: row.value.key,
      title: row.value.title,
      state: row.value.state,
      fulfillment: row.value.fulfillment,
      version: row.value.version,
    };
  },
});

/** List requirements for a project (bounded through the project index). */
export const list = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      requirements: v.array(
        v.object({ id: v.id("requirements"), key: v.string(), state: v.string() }),
      ),
    }),
    denialValidator,
  ),
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
    const rows = await ctx.db
      .query("requirements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      requirements: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({ id: row._id, key: row.key, state: row.state })),
    };
  },
});

const dependencyResultValidator = v.union(
  v.object({ ok: v.literal(true), dependencyId: v.id("dependencies") }),
  denialValidator,
);

/**
 * Create a typed dependency edge. Both requirements must live in the
 * caller's project, and the edge must not close a directed cycle
 * (scheduling cycles are rejected per PRD 15).
 */
export const addDependency = f1Mutation({
  args: dependencyInputValidator.fields,
  returns: dependencyResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const from = await requireOwnedRef(
      await ctx.db.get(args.fromRequirementId),
      args.organizationId,
      args.projectId,
    );
    if (!from.ok) {
      return { ok: false as const, code: from.code, message: from.message };
    }
    const to = await requireOwnedRef(
      await ctx.db.get(args.toRequirementId),
      args.organizationId,
      args.projectId,
    );
    if (!to.ok) {
      return { ok: false as const, code: to.code, message: to.message };
    }
    // Cycle verification reads the project's full edge list through
    // the project index. Verification is exact up to an explicit bound:
    // beyond it the write is denied rather than checked against a
    // silently truncated graph.
    const edges = await ctx.db
      .query("dependencies")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(501);
    if (edges.length > 500) {
      return { ok: false as const, code: "invalid-payload", message: "dependency graph exceeds verification bound" };
    }
    const shape = edges.map((edge) => ({
      from: edge.fromRequirementId,
      to: edge.toRequirementId,
    }));
    if (dependencyCreatesCycle(shape, args.fromRequirementId, args.toRequirementId)) {
      return { ok: false as const, code: "invalid-payload", message: "dependency would create a cycle" };
    }
    const dependencyId = await ctx.db.insert("dependencies", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      fromRequirementId: args.fromRequirementId,
      toRequirementId: args.toRequirementId,
      kind: args.kind,
      verification: "pending",
      ...(args.responsible === undefined ? {} : { responsible: args.responsible }),
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      createdAt: Date.now(),
    });
    return { ok: true as const, dependencyId };
  },
});

/**
 * Resolve a dependency without erasing its previous verification basis.
 * Verified edges require at least one source reference; waivers require an
 * approver and an explicit reason. The append-only revision row makes the
 * transition auditable while the dependency projection remains queryable.
 */
export const verifyDependency = f1Mutation({
  args: dependencyVerificationInputValidator.fields,
  returns: dependencyVerificationResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.verification === "waived") {
      const approver = await requireDomainAccess(
        ctx,
        args.organizationId,
        args.projectId,
        "approver",
      );
      if (!approver.ok) {
        return { ok: false as const, code: approver.code, message: approver.message };
      }
    }
    const dependency = await requireOwnedRef(
      await ctx.db.get(args.dependencyId),
      args.organizationId,
      args.projectId,
    );
    if (!dependency.ok) {
      return { ok: false as const, code: dependency.code, message: dependency.message };
    }
    if (dependency.value.verification !== "pending") {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "dependency verification is already resolved",
      };
    }
    const evidenceRefs = args.evidenceRefs === undefined ? [] : [...args.evidenceRefs];
    if (args.verification === "verified") {
      if (evidenceRefs.length === 0) {
        return { ok: false as const, code: "invalid-payload", message: "verified dependency requires evidence" };
      }
      if (evidenceRefs.some((ref) => ref.sourceId.trim().length === 0 || ref.version.trim().length === 0)) {
        return { ok: false as const, code: "invalid-payload", message: "dependency evidence is incomplete" };
      }
    }
    let reason: string | undefined;
    if (args.reason !== undefined) {
      try {
        reason = normalizeBoundedText(args.reason, "dependency reason", 512);
      } catch (error) {
        return {
          ok: false as const,
          code: "invalid-payload",
          message: error instanceof Error ? error.message : "dependency reason is invalid",
        };
      }
    }
    if (args.verification === "waived" && reason === undefined) {
      return { ok: false as const, code: "invalid-payload", message: "dependency waiver reason required" };
    }
    const revisionId = await ctx.db.insert("dependencyRevisions", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      dependencyId: args.dependencyId,
      beforeVerification: dependency.value.verification,
      afterVerification: args.verification,
      ...(dependency.value.evidenceRefs === undefined
        ? {}
        : { beforeEvidenceRefs: [...dependency.value.evidenceRefs] }),
      ...(evidenceRefs.length === 0 ? {} : { afterEvidenceRefs: evidenceRefs }),
      ...(reason === undefined ? {} : { reason }),
      actor: access.value.identity,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.dependencyId, {
      verification: args.verification,
      ...(evidenceRefs.length === 0 ? { evidenceRefs: undefined } : { evidenceRefs }),
    });
    return { ok: true as const, revisionId };
  },
});

export const updateDependencyVerification = verifyDependency;

/** List dependency edges for a project (bounded through the project index). */
export const listDependencies = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      dependencies: v.array(
        v.object({
          id: v.id("dependencies"),
          fromRequirementId: v.id("requirements"),
          toRequirementId: v.id("requirements"),
          kind: v.string(),
        }),
      ),
    }),
    denialValidator,
  ),
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
    const rows = await ctx.db
      .query("dependencies")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(100, Math.floor(args.limit))));
    return {
      ok: true as const,
      dependencies: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({
          id: row._id,
          fromRequirementId: row.fromRequirementId,
          toRequirementId: row.toRequirementId,
          kind: row.kind,
        })),
    };
  },
});

const PRIORITY_WEIGHT: Readonly<Record<"P0" | "P1" | "P2", number>> = {
  P0: 60,
  P1: 30,
  P2: 10,
};

const MILESTONE_RANK: Readonly<Record<"delivered" | "installed" | "commissioned", number>> = {
  delivered: 1,
  installed: 2,
  commissioned: 3,
};

function fulfillmentRank(value: string): number {
  if (value === "commissioned") return 3;
  if (value === "installed") return 2;
  if (value === "delivered") return 1;
  return 0;
}

function readinessIncomplete(
  reason: string,
  requirements: ReadonlyArray<{
    readonly _id: Id<"requirements">;
    readonly priority: string;
    readonly quantity: string;
    readonly fulfillment: string;
    readonly requiredMilestone?: string;
  }> = [],
) {
  return {
    ok: true as const,
    assessed: false,
    status: "incomplete" as const,
    readinessPercent: null,
    readiness: null,
    score: null,
    numerator: 0,
    denominator: 0,
    unresolvedP0Count: requirements.filter((row) => row.priority === "P0").length,
    scopeSize: requirements.length,
    incompleteReason: reason,
    requirements: requirements.map((row) => ({
      id: row._id,
      priority: row.priority,
      requiredQuantity: row.quantity,
      fulfilledQuantity: "0",
      requiredMilestone: row.requiredMilestone ?? "delivered",
      fulfillment: row.fulfillment,
      ready: false,
      dependencyBlocked: false,
    })),
  };
}

function readinessNotAssessed(reason: string) {
  return {
    ok: true as const,
    assessed: false,
    status: "notAssessed" as const,
    readinessPercent: null,
    readiness: null,
    score: null,
    numerator: 0,
    denominator: 0,
    unresolvedP0Count: 0,
    scopeSize: 0,
    incompleteReason: reason,
    requirements: [],
  };
}

/**
 * Compute procurement readiness from the authoritative project graph.
 * Requirement rows provide scope and priorities, order/order-event rows
 * provide accepted quantities and milestones, and dependency rows provide
 * blockers. Every collection is read through a project index with a MAX+1
 * probe, so a truncated project returns `incomplete` instead of a false
 * percentage.
 */
export const getReadiness = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.optional(v.number()),
  },
  returns: readinessResultValidator,
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
    const requestedLimit = args.limit === undefined ? MAX_READINESS_LIMIT : Math.floor(args.limit);
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "readiness limit must be positive" };
    }
    const limit = Math.min(MAX_READINESS_LIMIT, requestedLimit);
    const requirementRows = await ctx.db
      .query("requirements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(limit + 1);
    if (requirementRows.length > limit) {
      return readinessIncomplete("requirement scope exceeds the readiness bound", requirementRows.slice(0, limit));
    }
    for (const row of requirementRows) {
      if (row.organizationId !== args.organizationId) {
        return readinessIncomplete("requirement scope contains a foreign record", requirementRows);
      }
    }
    const activeRequirements = requirementRows.filter((row) => row.state !== "cancelled");
    if (activeRequirements.length === 0) return readinessNotAssessed("scope is empty");
    for (const row of activeRequirements) {
      try {
        normalizeBoundedText(row.key, "key", REQUIREMENT_KEY_MAX_LENGTH);
        normalizeBoundedText(row.title, "title", REQUIREMENT_TITLE_MAX_LENGTH);
        normalizeBoundedText(row.category, "category", REQUIREMENT_CATEGORY_MAX_LENGTH);
        normalizeBoundedText(row.unit, "unit", REQUIREMENT_UNIT_MAX_LENGTH);
        quantity(row.quantity);
        if (row.budgetMinorUnits !== undefined) {
          if (row.currency === undefined) throw new Error("budget currency required");
          makeMoney(row.currency, row.budgetMinorUnits);
        }
        if (row.needByAt !== undefined) normalizeRequirementDate(row.needByAt);
      } catch {
        return readinessIncomplete("requirement scope contains an incomplete or unconfigured record", activeRequirements);
      }
    }
    const requirementById = new Map<Id<"requirements">, (typeof activeRequirements)[number]>();
    const allRequirementById = new Map<Id<"requirements">, (typeof requirementRows)[number]>();
    for (const row of requirementRows) allRequirementById.set(row._id, row);
    for (const row of activeRequirements) requirementById.set(row._id, row);

    const dependencyRows = await ctx.db
      .query("dependencies")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_READINESS_DEPENDENCIES + 1);
    if (dependencyRows.length > MAX_READINESS_DEPENDENCIES) {
      return readinessIncomplete("dependency graph exceeds the readiness bound", activeRequirements);
    }
    const dependencyBlocked = new Set<Id<"requirements">>();
    for (const dependency of dependencyRows) {
      if (
        dependency.organizationId !== args.organizationId ||
        !allRequirementById.has(dependency.fromRequirementId) ||
        !allRequirementById.has(dependency.toRequirementId)
      ) {
        return readinessIncomplete("dependency graph is incomplete or foreign", activeRequirements);
      }
      if (
        dependency.verification !== "verified" &&
        dependency.verification !== "waived" &&
        requirementById.has(dependency.fromRequirementId)
      ) {
        dependencyBlocked.add(dependency.fromRequirementId);
      }
    }

    const orderRows = await ctx.db
      .query("orders")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_READINESS_ORDERS + 1);
    if (orderRows.length > MAX_READINESS_ORDERS) {
      return readinessIncomplete("fulfillment orders exceed the readiness bound", activeRequirements);
    }
    const orderById = new Map<Id<"orders">, (typeof orderRows)[number]>();
    for (const order of orderRows) {
      if (
        order.organizationId !== args.organizationId ||
        !allRequirementById.has(order.requirementId)
      ) {
        return readinessIncomplete("fulfillment order graph is incomplete or foreign", activeRequirements);
      }
      orderById.set(order._id, order);
    }

    const eventRows = await ctx.db
      .query("orderEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(MAX_READINESS_EVENTS + 1);
    if (eventRows.length > MAX_READINESS_EVENTS) {
      return readinessIncomplete("fulfillment events exceed the readiness bound", activeRequirements);
    }
    const requiredById = new Map<Id<"requirements">, Decimal>();
    for (const row of activeRequirements) {
      try {
        requiredById.set(row._id, quantity(row.quantity));
      } catch {
        return readinessIncomplete("requirement quantity is invalid", activeRequirements);
      }
    }
    const acceptedByRequirement = new Map<Id<"requirements">, Decimal>();
    const eventMilestoneByRequirement = new Map<Id<"requirements">, number>();
    for (const event of eventRows) {
      if (event.organizationId !== args.organizationId) {
        return readinessIncomplete("fulfillment event graph is foreign", activeRequirements);
      }
      const order = orderById.get(event.orderId);
      if (order === undefined) {
        return readinessIncomplete("fulfillment event has no resolvable order", activeRequirements);
      }
      if (order.state === "cancelled") continue;
      const requirement = requirementById.get(order.requirementId);
      if (requirement === undefined) continue;
      if (event.kind === "installation") {
        eventMilestoneByRequirement.set(requirement._id, Math.max(eventMilestoneByRequirement.get(requirement._id) ?? 0, 2));
      } else if (event.kind === "commissioning") {
        eventMilestoneByRequirement.set(requirement._id, 3);
      } else if (event.kind === "partialDelivery" || event.kind === "acceptance") {
        eventMilestoneByRequirement.set(requirement._id, Math.max(eventMilestoneByRequirement.get(requirement._id) ?? 0, 1));
      }
      const acceptedLines = event.acceptanceLines !== undefined
        ? event.acceptanceLines.map((line) => ({ quantity: line.acceptedQuantity, unit: line.unit }))
        : event.acceptedQuantity === undefined
          ? []
          : [{ quantity: event.acceptedQuantity, unit: requirement.unit }];
      for (const line of acceptedLines) {
        if (line.unit.trim().length > 0 && line.unit.trim() !== requirement.unit) {
          return readinessIncomplete("fulfillment unit does not match requirement unit", activeRequirements);
        }
        let accepted: Decimal;
        try {
          accepted = quantity(line.quantity);
        } catch {
          return readinessIncomplete("fulfillment quantity is invalid", activeRequirements);
        }
        const previous = acceptedByRequirement.get(requirement._id);
        try {
          acceptedByRequirement.set(
            requirement._id,
            previous === undefined ? accepted : decimalAdd(previous, accepted),
          );
        } catch {
          return readinessIncomplete("fulfilled quantity exceeds the supported precision", activeRequirements);
        }
      }
    }

    const presentPriorities = new Set(activeRequirements.map((row) => row.priority));
    let denominator = 0;
    for (const priority of ["P0", "P1", "P2"] as const) {
      if (presentPriorities.has(priority)) denominator += PRIORITY_WEIGHT[priority];
    }
    if (denominator === 0) return readinessNotAssessed("scope has no configured priorities");
    const counts: Record<"P0" | "P1" | "P2", number> = { P0: 0, P1: 0, P2: 0 };
    for (const row of activeRequirements) counts[row.priority] += 1;
    let numerator = 0;
    let unresolvedP0Count = 0;
    const readinessRequirements = activeRequirements.map((row) => {
      const required = requiredById.get(row._id);
      if (required === undefined) throw new Error("readiness quantity invariant violated");
      const fulfilled = acceptedByRequirement.get(row._id) ?? decimalZero();
      const milestone = row.requiredMilestone ?? "delivered";
      const milestoneRank = MILESTONE_RANK[milestone];
      const observedMilestone = Math.max(
        fulfillmentRank(row.fulfillment),
        eventMilestoneByRequirement.get(row._id) ?? 0,
      );
      const quantityReady = decimalCompare(fulfilled, required) >= 0;
      const milestoneReady = observedMilestone >= milestoneRank;
      const blocked = dependencyBlocked.has(row._id);
      const ready = quantityReady && milestoneReady && !blocked;
      if (!ready && row.priority === "P0") unresolvedP0Count += 1;
      if (ready) numerator += PRIORITY_WEIGHT[row.priority] / counts[row.priority];
      return {
        id: row._id,
        priority: row.priority,
        requiredQuantity: decimalToString(required),
        fulfilledQuantity: decimalToString(fulfilled),
        requiredMilestone: milestone,
        fulfillment: row.fulfillment,
        ready,
        dependencyBlocked: blocked,
      };
    });
    const readinessPercent = denominator === 0 ? null : (numerator / denominator) * 100;
    const status = readinessRequirements.every((row) => row.ready) ? "ready" as const : "notReady" as const;
    return {
      ok: true as const,
      assessed: true,
      status,
      readinessPercent,
      readiness: readinessPercent,
      score: readinessPercent,
      numerator,
      denominator,
      unresolvedP0Count,
      scopeSize: activeRequirements.length,
      requirements: readinessRequirements,
    };
  },
});

export const procurementReadiness = getReadiness;
export const readiness = getReadiness;
export const getProcurementReadiness = getReadiness;

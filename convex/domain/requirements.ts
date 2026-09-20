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
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalCompare,
  decimalToString,
  decimalZero,
  quantity,
} from "../../proofs/money/decimal.js";
import { currencyCode, money as makeMoney } from "../../proofs/money/money.js";
import {
  dependencyCreatesCycle,
  dependencyInputValidator,
  requirementInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

const requirementResultValidator = v.union(
  v.object({ ok: v.literal(true), requirementId: v.id("requirements") }),
  denialValidator,
);

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
    if (args.key.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "key required" };
    }
    if (args.title.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "title required" };
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
    if (args.currency !== undefined) {
      try {
        currencyCode(args.currency);
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
      if (args.currency !== undefined) {
        try {
          makeMoney(args.currency, args.budgetMinorUnits);
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "budget money is invalid" };
        }
      }
    }
    const duplicate = await ctx.db
      .query("requirements")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("key", args.key),
      )
      .unique();
    if (duplicate !== null) {
      return { ok: false as const, code: "duplicate-conflict", message: `requirement key ${args.key} exists` };
    }
    const now = Date.now();
    const requirementId = await ctx.db.insert("requirements", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      key: args.key,
      title: args.title,
      category: args.category,
      quantity: normalizedQuantity,
      unit: args.unit,
      priority: args.priority,
      state: "draft",
      fulfillment: "notOrdered",
      version: 1,
      ...(args.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: args.budgetMinorUnits }),
      ...(args.currency === undefined ? {} : { currency: args.currency }),
      ...(args.needByAt === undefined ? {} : { needByAt: args.needByAt }),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, requirementId };
  },
});

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

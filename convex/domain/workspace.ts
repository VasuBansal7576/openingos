/**
 * F1 workspace graph (controlled contract, PRD 30).
 *
 * Evidence watches, the append-only project event log, risks, and
 * organization-owned reusable templates. Template instantiation copies
 * requirements and constraints into the target project only: historical
 * orders, order events, payments, settled costs, refunds, and credits
 * are never copied, so reuse cannot inherit another project's
 * commitments or cash.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  TEMPLATE_REUSE_COLLECTIONS,
  projectEventInputValidator,
  riskInputValidator,
  templateInputValidator,
  templateReuseExcludesHistoricFinancials,
  watchInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

/** Create an evidence watch on a named target (bounded cadence). */
export const createWatch = f1Mutation({
  args: watchInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), watchId: v.id("watches") }),
    denialValidator,
  ),
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
    if (args.targetKind.trim().length === 0 || args.targetId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "watch target required" };
    }
    if (!Number.isInteger(args.cadenceMs) || args.cadenceMs <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "cadence must be positive" };
    }
    const watchId = await ctx.db.insert("watches", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      targetKind: args.targetKind,
      targetId: args.targetId,
      cadenceMs: args.cadenceMs,
      state: "active",
      lastResult: "unknown",
      createdAt: Date.now(),
    });
    return { ok: true as const, watchId };
  },
});

/** Record a watch check result; the watch must be in-project. */
export const checkWatch = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    watchId: v.id("watches"),
    result: v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
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
    const watch = await requireOwnedRef(
      await ctx.db.get(args.watchId),
      args.organizationId,
      args.projectId,
    );
    if (!watch.ok) {
      return { ok: false as const, code: watch.code, message: watch.message };
    }
    await ctx.db.patch(args.watchId, {
      lastResult: args.result,
      lastCheckedAt: Date.now(),
    });
    return { ok: true as const };
  },
});

/** Append a material project event (append-only; no edits, no deletes). */
export const appendProjectEvent = f1Mutation({
  args: projectEventInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), eventId: v.id("projectEvents") }),
    denialValidator,
  ),
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
    if (args.kind.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "event kind required" };
    }
    const eventId = await ctx.db.insert("projectEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: args.kind,
      actor: access.value.identity,
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      createdAt: Date.now(),
    });
    return { ok: true as const, eventId };
  },
});

/** List project events (bounded through the project index). */
export const listProjectEvents = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      events: v.array(v.object({ id: v.id("projectEvents"), kind: v.string() })),
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
      .query("projectEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      events: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({ id: row._id, kind: row.kind })),
    };
  },
});

/** Raise a risk with severity, source, and owner. */
export const raiseRisk = f1Mutation({
  args: riskInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), riskId: v.id("risks") }),
    denialValidator,
  ),
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
    if (args.scope.trim().length === 0 || args.source.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "scope and source required" };
    }
    const now = Date.now();
    const riskId = await ctx.db.insert("risks", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      scope: args.scope,
      severity: args.severity,
      state: "open",
      source: args.source,
      ...(args.owner === undefined ? {} : { owner: args.owner }),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, riskId };
  },
});

/** Move a risk through its resolution lifecycle (forward only). */
export const resolveRisk = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    riskId: v.id("risks"),
    state: v.union(
      v.literal("open"),
      v.literal("mitigating"),
      v.literal("resolved"),
      v.literal("accepted"),
    ),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
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
    const risk = await requireOwnedRef(
      await ctx.db.get(args.riskId),
      args.organizationId,
      args.projectId,
    );
    if (!risk.ok) {
      return { ok: false as const, code: risk.code, message: risk.message };
    }
    const order = ["open", "mitigating", "resolved", "accepted"] as const;
    const fromIndex = order.indexOf(risk.value.state);
    const toIndex = order.indexOf(args.state);
    if (toIndex < fromIndex) {
      return { ok: false as const, code: "invalid-payload", message: "risks move forward only" };
    }
    await ctx.db.patch(args.riskId, { state: args.state, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

/**
 * Save a reusable template. Templates are organization-owned: the version
 * is unique per organization and the source project is kept as a
 * derivable parent reference. The saver proves contributor access in the
 * source project. Snapshots are canonical strings so reuse never depends
 * on live row identity.
 */
export const saveTemplate = f1Mutation({
  args: templateInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), templateId: v.id("templates") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.sourceProjectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.name.trim().length === 0 || args.version.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "name and version required" };
    }
    const duplicate = await ctx.db
      .query("templates")
      .withIndex("by_organization_and_version", (q) =>
        q.eq("organizationId", args.organizationId).eq("version", args.version),
      )
      .unique();
    if (duplicate !== null) {
      return { ok: false as const, code: "duplicate-conflict", message: "template version exists" };
    }
    const templateId = await ctx.db.insert("templates", {
      organizationId: args.organizationId,
      sourceProjectId: args.sourceProjectId,
      name: args.name,
      version: args.version,
      requirementSnapshot: args.requirementSnapshot,
      constraintSnapshot: args.constraintSnapshot,
      createdAt: Date.now(),
    });
    return { ok: true as const, templateId };
  },
});

interface SnapshotRequirement {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly quantity: string;
  readonly unit: string;
}

interface SnapshotConstraint {
  readonly fromKey: string;
  readonly toKey: string;
  readonly kind: "technical" | "scheduling";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshotRequirements(snapshot: string): SnapshotRequirement[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SnapshotRequirement[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const { key, title, category, quantity, unit } = entry;
    if (
      typeof key !== "string" ||
      typeof title !== "string" ||
      typeof category !== "string" ||
      typeof quantity !== "string" ||
      typeof unit !== "string"
    ) {
      return null;
    }
    out.push({ key, title, category, quantity, unit });
  }
  return out;
}

function parseSnapshotConstraints(snapshot: string): SnapshotConstraint[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SnapshotConstraint[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const { fromKey, toKey, kind } = entry;
    if (typeof fromKey !== "string" || typeof toKey !== "string") return null;
    if (kind !== "technical" && kind !== "scheduling") return null;
    out.push({ fromKey, toKey, kind });
  }
  return out;
}

/**
 * Instantiate a template into a target project. Only the whitelisted
 * reuse collections (requirements, constraints) are copied; the handler
 * holds no reference to orders, order events, or cost entries, so
 * historical commitments and cash provably stay behind. The template
 * must belong to the caller's organization.
 */
export const instantiateTemplate = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    targetProjectId: v.id("projects"),
    templateId: v.id("templates"),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      requirementIds: v.array(v.id("requirements")),
      collections: v.array(v.string()),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.targetProjectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const template = await ctx.db.get(args.templateId);
    if (template === null || template.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "template is not in this organization" };
    }
    const wanted = parseSnapshotRequirements(template.requirementSnapshot);
    const edges = parseSnapshotConstraints(template.constraintSnapshot);
    if (wanted === null || edges === null) {
      return { ok: false as const, code: "invalid-payload", message: "template snapshot is invalid" };
    }
    // Explicit instantiation bounds, validated before any write:
    // oversized snapshots are denied whole, never silently truncated.
    if (wanted.length === 0 || wanted.length > 50) {
      return { ok: false as const, code: "invalid-payload", message: "template requirement snapshot outside instantiation bound" };
    }
    if (edges.length > 100) {
      return { ok: false as const, code: "invalid-payload", message: "template constraint snapshot outside instantiation bound" };
    }
    if (!templateReuseExcludesHistoricFinancials([...TEMPLATE_REUSE_COLLECTIONS])) {
      return { ok: false as const, code: "invalid-payload", message: "reuse scope includes financials" };
    }
    const now = Date.now();
    const idsByKey = new Map<string, Id<"requirements">>();
    const requirementIds: Id<"requirements">[] = [];
    for (const item of wanted) {
      const duplicate = await ctx.db
        .query("requirements")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.targetProjectId).eq("key", item.key),
        )
        .unique();
      if (duplicate !== null) continue;
      const requirementId = await ctx.db.insert("requirements", {
        organizationId: args.organizationId,
        projectId: args.targetProjectId,
        key: item.key,
        title: item.title,
        category: item.category,
        quantity: item.quantity,
        unit: item.unit,
        priority: "P1",
        state: "draft",
        fulfillment: "notOrdered",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      idsByKey.set(item.key, requirementId);
      requirementIds.push(requirementId);
    }
    for (const edge of edges) {
      const from = idsByKey.get(edge.fromKey);
      const to = idsByKey.get(edge.toKey);
      if (from === undefined || to === undefined || from === to) continue;
      await ctx.db.insert("dependencies", {
        organizationId: args.organizationId,
        projectId: args.targetProjectId,
        fromRequirementId: from,
        toRequirementId: to,
        kind: edge.kind,
        verification: "pending",
        createdAt: now,
      });
    }
    return {
      ok: true as const,
      requirementIds,
      collections: [...TEMPLATE_REUSE_COLLECTIONS],
    };
  },
});

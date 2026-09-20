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
import { f1InternalMutation, f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  TEMPLATE_REUSE_COLLECTIONS,
  dependencyCreatesCycle,
  projectEventInputValidator,
  riskInputValidator,
  templateInputValidator,
  templateReuseExcludesHistoricFinancials,
  watchInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

/**
 * Create an evidence watch on a named target (explicit owner-import
 * path). The caller declares the watched counterparty from the closed
 * union and an optional job allowance linkage; the source is fixed to
 * `ownerImport` so a public caller can never claim internal pipeline
 * verification. The next check time derives server-side from cadence.
 * Replays through the idempotency key return the existing watch or
 * conflict on divergence.
 */
export const createWatch = f1Mutation({
  args: watchInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), watchId: v.id("watches"), deduplicated: v.boolean() }),
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
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.targetKind.trim().length === 0 || args.targetId.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "watch target required" };
    }
    if (!Number.isInteger(args.cadenceMs) || args.cadenceMs <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "cadence must be positive" };
    }
    const existing = await ctx.db
      .query("watches")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameJob = (existing.jobId ?? undefined) === args.jobId;
      if (
        !sameJob ||
        existing.targetKind !== args.targetKind ||
        existing.targetId !== args.targetId ||
        existing.cadenceMs !== args.cadenceMs ||
        existing.counterpartyRole !== args.counterpartyRole
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, watchId: existing._id, deduplicated: true };
    }
    if (args.jobId !== undefined) {
      const job = await ctx.db.get(args.jobId);
      if (
        job === null ||
        job.organizationId !== args.organizationId ||
        job.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "job is not in this project" };
      }
    }
    const now = Date.now();
    const watchId = await ctx.db.insert("watches", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      targetKind: args.targetKind,
      targetId: args.targetId,
      cadenceMs: args.cadenceMs,
      nextCheckAt: now + args.cadenceMs,
      state: "active",
      lastResult: "unknown",
      source: "ownerImport",
      counterpartyRole: args.counterpartyRole,
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    return { ok: true as const, watchId, deduplicated: false };
  },
});

/**
 * Record an explicit owner-import watch check result; the watch must be
 * in-project. The next check time advances server-side from cadence.
 */
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
    if (watch.value.source !== "ownerImport") {
      return { ok: false as const, code: "invalid-payload", message: "internal watches check through the pipeline" };
    }
    const now = Date.now();
    await ctx.db.patch(args.watchId, {
      lastResult: args.result,
      lastCheckedAt: now,
      nextCheckAt: now + watch.value.cadenceMs,
    });
    return { ok: true as const };
  },
});

/**
 * Internal pipeline watch check (R1/C1 ingestion only): stamps an
 * internal verification result and advances the next check time. No
 * client can reach this path.
 */
export const ingestWatchCheck = f1InternalMutation({
  args: {
    watchId: v.id("watches"),
    result: v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watchId);
    if (watch === null) {
      return { ok: false as const, code: "denied-membership", message: "unknown watch" };
    }
    const now = Date.now();
    await ctx.db.patch(args.watchId, {
      lastResult: args.result,
      lastCheckedAt: now,
      nextCheckAt: now + watch.cadenceMs,
      source: "internal",
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

/** List project events, newest first (bounded timeline read). */
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
      .order("desc")
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      events: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({ id: row._id, kind: row.kind })),
    };
  },
});

/**
 * Raise a risk with severity, source, owner, and optional dependency
 * references. Every referenced dependency must resolve in-project, so a
 * risk can never point at another workspace's graph.
 */
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
    for (const dependencyId of args.dependencyIds ?? []) {
      const dependency = await ctx.db.get(dependencyId);
      if (
        dependency === null ||
        dependency.organizationId !== args.organizationId ||
        dependency.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "dependency is not in this project" };
      }
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
      dependencyIds: [...(args.dependencyIds ?? [])],
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, riskId };
  },
});

/**
 * Move a risk through its resolution lifecycle (forward only).
 * Terminally accepting a risk requires approver authority or above and
 * records the accepting identity with its timestamp: a contributor
 * alone can mitigate or resolve, but never accept, a risk.
 */
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
    const minRole = args.state === "accepted" ? "approver" : "contributor";
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      minRole,
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
    const now = Date.now();
    await ctx.db.patch(args.riskId, {
      state: args.state,
      updatedAt: now,
      ...(args.state === "accepted"
        ? { acceptedBy: access.value.identity, decidedAt: now }
        : {}),
    });
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
    v.object({ ok: v.literal(true), templateId: v.id("templates"), deduplicated: v.boolean() }),
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
    // Snapshots must parse before the version is claimed, so a broken
    // template can never occupy its version slot.
    if (
      parseSnapshotRequirements(args.requirementSnapshot) === null ||
      parseSnapshotConstraints(args.constraintSnapshot) === null
    ) {
      return { ok: false as const, code: "invalid-payload", message: "template snapshot is invalid" };
    }
    const duplicate = await ctx.db
      .query("templates")
      .withIndex("by_organization_and_version", (q) =>
        q.eq("organizationId", args.organizationId).eq("version", args.version),
      )
      .unique();
    if (duplicate !== null) {
      // Exact replay returns the stored row; any divergent field is a
      // version collision, never a silent overwrite.
      if (
        duplicate.sourceProjectId !== args.sourceProjectId ||
        duplicate.name !== args.name ||
        duplicate.requirementSnapshot !== args.requirementSnapshot ||
        duplicate.constraintSnapshot !== args.constraintSnapshot
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "template version already used with different fields" };
      }
      return { ok: true as const, templateId: duplicate._id, deduplicated: true };
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
    return { ok: true as const, templateId, deduplicated: false };
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
    parsed = JSON.parse(snapshot);
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
    parsed = JSON.parse(snapshot);
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
 *
 * Every structural check runs before the first write: duplicate
 * snapshot keys, unknown edge endpoints, self edges, dependency cycles,
 * and bound overruns are all denied whole, so a failed instantiation
 * leaves zero partial rows. Replaying an already-instantiated template
 * returns the stored requirement rows instead of duplicating them.
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
      deduplicated: v.boolean(),
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
    // Snapshot-internal validation before any write: unique keys, known
    // endpoints, no self edges, no cycles.
    const seenKeys = new Set<string>();
    for (const item of wanted) {
      if (seenKeys.has(item.key)) {
        return { ok: false as const, code: "invalid-payload", message: `duplicate requirement key ${item.key}` };
      }
      seenKeys.add(item.key);
    }
    const edgeShapes: { from: string; to: string }[] = [];
    for (const edge of edges) {
      if (!seenKeys.has(edge.fromKey) || !seenKeys.has(edge.toKey)) {
        return { ok: false as const, code: "invalid-payload", message: "dependency endpoint is not in the snapshot" };
      }
      if (edge.fromKey === edge.toKey) {
        return { ok: false as const, code: "invalid-payload", message: "dependency self edge is not allowed" };
      }
      if (dependencyCreatesCycle(edgeShapes, edge.fromKey, edge.toKey)) {
        return { ok: false as const, code: "invalid-payload", message: "dependency would create a cycle" };
      }
      edgeShapes.push({ from: edge.fromKey, to: edge.toKey });
    }
    // Target-side pre-check before any write: exact replay returns the
    // stored rows, any foreign key occupancy conflicts whole.
    const idsByKey = new Map<string, Id<"requirements">>();
    for (const item of wanted) {
      const duplicate = await ctx.db
        .query("requirements")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.targetProjectId).eq("key", item.key),
        )
        .unique();
      if (duplicate === null) continue;
      if (duplicate.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      idsByKey.set(item.key, duplicate._id);
    }
    if (idsByKey.size === wanted.length) {
      const replayed = wanted.map((item) => idsByKey.get(item.key));
      if (replayed.every((id): id is Id<"requirements"> => id !== undefined)) {
        const replayMatches = await Promise.all(
          replayed.map(async (id) => {
            const row = await ctx.db.get(id);
            return (
              row !== null &&
              row.templateId === args.templateId &&
              row.templateVersion === template.version
            );
          }),
        );
        if (replayMatches.every(Boolean)) {
          return {
            ok: true as const,
            requirementIds: replayed,
            collections: [...TEMPLATE_REUSE_COLLECTIONS],
            deduplicated: true,
          };
        }
      }
      return { ok: false as const, code: "duplicate-conflict", message: "target project already holds these requirement keys" };
    }
    if (idsByKey.size > 0) {
      return { ok: false as const, code: "duplicate-conflict", message: "target project already holds some requirement keys" };
    }
    const now = Date.now();
    const requirementIds: Id<"requirements">[] = [];
    for (const item of wanted) {
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
        templateId: args.templateId,
        templateVersion: template.version,
        createdAt: now,
        updatedAt: now,
      });
      idsByKey.set(item.key, requirementId);
      requirementIds.push(requirementId);
    }
    for (const edge of edges) {
      const from = idsByKey.get(edge.fromKey);
      const to = idsByKey.get(edge.toKey);
      if (from === undefined || to === undefined) {
        throw new Error("instantiation invariant violated: validated endpoint missing");
      }
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
      deduplicated: false,
    };
  },
});

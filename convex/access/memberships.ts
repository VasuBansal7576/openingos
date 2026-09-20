/**
 * F1 membership and project-isolation surface (controlled contract, NR03).
 *
 * Organization/project/guest/private ownership with restricted projects.
 * Identity always derives from `ctx.auth` and time always comes from the
 * server clock — callers supply neither. Forged IDs, cross-organization
 * access, and guest/private leakage are denied in backend code without
 * existence oracles.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { checkProjectAccess, denialValidator, identityOf } from "./checks.js";

const roleValidator = v.union(
  v.literal("owner"),
  v.literal("approver"),
  v.literal("contributor"),
  v.literal("viewer"),
);

const roleResultValidator = v.union(
  v.object({ ok: v.literal(true), role: v.string() }),
  denialValidator,
);

/** Caller's own role for a project (proves isolation on direct calls). */
export const myProjectRole = f1Query({
  args: { organizationId: v.id("organizations"), projectId: v.id("projects") },
  returns: roleResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return { ok: true as const, role: access.value };
  },
});

/** Create an organization; the caller becomes its owner. */
export const createOrganization = f1Mutation({
  args: { name: v.string(), kind: v.union(v.literal("guest"), v.literal("private")) },
  returns: v.union(
    v.object({ ok: v.literal(true), organizationId: v.id("organizations") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "organization name required" };
    }
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: args.name.trim(),
      kind: args.kind,
      createdAt: now,
    });
    await ctx.db.insert("memberships", {
      organizationId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      updatedAt: now,
    });
    return { ok: true as const, organizationId };
  },
});

/** Create a project inside a caller-administered organization. */
export const createProject = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    visibility: v.union(v.literal("open"), v.literal("restricted")),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), projectId: v.id("projects") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const organization = await ctx.db.get(args.organizationId);
    if (organization === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_organization_and_identity", (q) =>
        q.eq("organizationId", args.organizationId).eq("identity", identity),
      )
      .collect();
    const owner = rows.some((row) => row.status === "active" && row.role === "owner");
    if (!owner) {
      return { ok: false as const, code: "denied-capability", message: "only an owner creates projects" };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "project name required" };
    }
    const projectId = await ctx.db.insert("projects", {
      organizationId: args.organizationId,
      name: args.name.trim(),
      visibility: args.visibility,
      createdAt: Date.now(),
    });
    return { ok: true as const, projectId };
  },
});

/** Grant project access (owner/approver only); restricted projects need this. */
export const grantProjectAccess = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    targetIdentity: v.string(),
    role: roleValidator,
    expiresAt: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), membershipId: v.id("memberships") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    if (args.targetIdentity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "target identity required" };
    }
    const membershipId = await ctx.db.insert("memberships", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      identity: args.targetIdentity,
      role: args.role,
      status: "active",
      version: 1,
      ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      updatedAt: now,
    });
    return { ok: true as const, membershipId };
  },
});

/** Revoke a membership (owner/approver only). */
export const revokeProjectAccess = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    membershipId: v.id("memberships"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), revoked: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const row = await ctx.db.get(args.membershipId);
    if (row === null || row.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    await ctx.db.patch(args.membershipId, { status: "revoked", revokedAt: now, updatedAt: now });
    return { ok: true as const, revoked: true };
  },
});

/**
 * F1 membership and project-isolation surface (controlled contract, NR03).
 *
 * Organization/project/guest/private ownership with restricted projects.
 * All reads derive identity from `ctx.auth`; forged IDs, cross-organization
 * access, and guest/private leakage are denied in backend code.
 */

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
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
export const myProjectRole = query({
  args: { organizationId: v.string(), projectId: v.string(), now: v.number() },
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
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    return { ok: true as const, role: access.value };
  },
});

/** Create an organization; the caller becomes its owner. */
export const createOrganization = mutation({
  args: { name: v.string(), kind: v.union(v.literal("guest"), v.literal("private")) },
  returns: v.union(
    v.object({ ok: v.literal(true), organizationId: v.string() }),
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
    const organizationId = await ctx.db.insert("organizations", {
      name: args.name.trim(),
      kind: args.kind,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      organizationId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      updatedAt: Date.now(),
    });
    return { ok: true as const, organizationId: organizationId as unknown as string };
  },
});

/** Create a project inside a caller-administered organization. */
export const createProject = mutation({
  args: {
    organizationId: v.string(),
    name: v.string(),
    visibility: v.union(v.literal("open"), v.literal("restricted")),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), projectId: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const organization = (await ctx.db.get(args.organizationId as never)) as unknown as {
      _id?: string;
    } | null;
    if (!organization) {
      return { ok: false as const, code: "denied-project", message: "unknown organization" };
    }
    const rows = (await ctx.db
      .query("memberships")
      .filter((q) =>
        q.and(
          q.eq(q.field("organizationId"), args.organizationId),
          q.eq(q.field("identity"), identity),
        ),
      )
      .collect()) as unknown as { status?: string; role?: string }[];
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
      createdAt: args.now,
    });
    return { ok: true as const, projectId: projectId as unknown as string };
  },
});

/** Grant project access (owner/approver only); restricted projects need this. */
export const grantProjectAccess = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    targetIdentity: v.string(),
    role: roleValidator,
    now: v.number(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), membershipId: v.string() }),
    denialValidator,
  ),
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
      "approver",
      args.now,
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
      updatedAt: args.now,
    });
    return { ok: true as const, membershipId: membershipId as unknown as string };
  },
});

/** Revoke a membership (owner/approver only). */
export const revokeProjectAccess = mutation({
  args: {
    organizationId: v.string(),
    projectId: v.string(),
    membershipId: v.string(),
    now: v.number(),
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
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const row = (await ctx.db.get(args.membershipId as never)) as unknown as {
      organizationId?: string;
    } | null;
    if (!row || row.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "membership is not in this organization" };
    }
    await ctx.db.patch(args.membershipId as never, { status: "revoked", revokedAt: args.now, updatedAt: args.now });
    return { ok: true as const, revoked: true };
  },
});

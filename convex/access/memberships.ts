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
import { f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
import type { Id } from "../_generated/dataModel.js";
import {
  checkProjectAccess,
  denialValidator,
  identityOf,
  membershipScopeKey,
  PERMANENT_AUTHORITY_UNTIL,
  resolveProjectAccess,
} from "./checks.js";
import { roleSatisfies } from "../shared/scope.js";
import { isExpired } from "../shared/time.js";

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

async function recordCurrentAuthority(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects"> | undefined,
  identity: string,
  role: "owner" | "approver" | "contributor" | "viewer",
  membershipId: Id<"memberships">,
  expiresAt: number | undefined,
  updatedAt: number,
): Promise<void> {
  await ctx.db.insert("membershipAuthorities", {
    organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    identity,
    scopeKey: membershipScopeKey(projectId),
    role,
    membershipId,
    authorityUntil: expiresAt ?? PERMANENT_AUTHORITY_UNTIL,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    updatedAt,
  });
}

async function hasCurrentOrganizationOwner(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  identity: string,
  now: number,
): Promise<boolean> {
  const projected = await ctx.db
    .query("membershipAuthorities")
    .withIndex("by_organization_and_identity_and_scope_and_role_and_authority_until", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("scopeKey", membershipScopeKey(undefined))
        .eq("role", "owner"),
    )
    .order("desc")
    .first();
  if (projected !== null) {
    return projected.expiresAt === undefined || !isExpired(now, projected.expiresAt);
  }
  const legacy = await ctx.db
    .query("memberships")
    .withIndex("by_organization_and_identity_and_project_and_status_and_role", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("projectId", undefined)
        .eq("status", "active")
        .eq("role", "owner"),
    )
    .order("desc")
    .first();
  return legacy !== null && (legacy.expiresAt === undefined || !isExpired(now, legacy.expiresAt));
}

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
    const membershipId = await ctx.db.insert("memberships", {
      organizationId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      updatedAt: now,
    });
    await recordCurrentAuthority(
      ctx,
      organizationId,
      undefined,
      identity,
      "owner",
      membershipId,
      undefined,
      now,
    );
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
    const now = Date.now();
    // Organization administration requires current ORG-SCOPED owner
    // authority: a project-scoped owner row administers nothing outside
    // its own project.
    const owner = await hasCurrentOrganizationOwner(ctx, args.organizationId, identity, now);
    if (!owner) {
      return { ok: false as const, code: "denied-capability", message: "only an owner creates projects" };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "project name required" };
    }
    const now2 = Date.now();
    const projectId = await ctx.db.insert("projects", {
      organizationId: args.organizationId,
      name: args.name.trim(),
      visibility: args.visibility,
      createdAt: now2,
    });
    // Atomic project-scoped owner grant: restricted projects honor only
    // project-scoped rows, so the org-owner creator would otherwise be
    // locked out of their own project. The grant lives in the same
    // mutation as the project row, so creation never leaves an
    // inaccessible project behind.
    const membershipId = await ctx.db.insert("memberships", {
      organizationId: args.organizationId,
      projectId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      updatedAt: now2,
    });
    await recordCurrentAuthority(
      ctx,
      args.organizationId,
      projectId,
      identity,
      "owner",
      membershipId,
      undefined,
      now2,
    );
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
    const resolution = await resolveProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      now,
    );
    if (!resolution.ok) return { ok: false as const, code: resolution.code, message: resolution.message };
    if (args.targetIdentity.trim().length === 0) {
      return { ok: false as const, code: "forged-identity", message: "target identity required" };
    }
    if (
      args.expiresAt !== undefined &&
      (!Number.isFinite(args.expiresAt) ||
        !Number.isSafeInteger(args.expiresAt) ||
        args.expiresAt <= now)
    ) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "membership expiry must be a finite future safe-integer timestamp",
      };
    }
    // No escalation or lateral grants: the granted role cannot exceed the
    // granter's own role in the stated project.
    if (!roleSatisfies(resolution.value.role, args.role)) {
      return { ok: false as const, code: "denied-capability", message: "cannot grant a role above your own" };
    }

    // The target role may be supplied by any current stronger authority. A
    // permanent approver therefore remains able to delegate an approver role
    // even while a shorter temporary owner row is also present, while an
    // owner grant is still bounded by the temporary owner row itself.
    const authorityRows = resolution.value.authorities.filter((authority) =>
      roleSatisfies(authority.role, args.role),
    );
    if (authorityRows.length === 0) {
      return { ok: false as const, code: "denied-capability", message: "granting authority is no longer current" };
    }
    const authorityUntil = Math.max(...authorityRows.map((row) => row.authorityUntil));
    if (
      authorityUntil !== PERMANENT_AUTHORITY_UNTIL &&
      (args.expiresAt === undefined || args.expiresAt > authorityUntil)
    ) {
      return {
        ok: false as const,
        code: "invalid-payload",
        message: "membership expiry cannot exceed the granter authority expiry",
      };
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
    await recordCurrentAuthority(
      ctx,
      args.organizationId,
      args.projectId,
      args.targetIdentity,
      args.role,
      membershipId,
      args.expiresAt,
      now,
    );
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
    if (
      row === null ||
      row.organizationId !== args.organizationId ||
      (row.projectId !== undefined && row.projectId !== args.projectId)
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    // A project-scoped target must match the stated project before any role
    // comparison.  Organization-scoped targets are visible only to a current
    // organization owner, also checked before role comparison.  This keeps
    // inaccessible existing membership IDs indistinguishable from absent or
    // cross-organization IDs.
    if (
      row.projectId === undefined &&
      !(await hasCurrentOrganizationOwner(ctx, args.organizationId, identity, now))
    ) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    // Role-capped revocation: the revoker's best role in the stated
    // project must satisfy the target's role, so an approver cannot
    // remove an owner and a contributor cannot remove an approver.
    if (!roleSatisfies(access.value, row.role)) {
      return { ok: false as const, code: "denied-capability", message: "cannot revoke a membership above your own role" };
    }
    const authority = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId))
      .unique();
    if (authority !== null) await ctx.db.delete(authority._id);
    await ctx.db.patch(args.membershipId, { status: "revoked", revokedAt: now, updatedAt: now });
    return { ok: true as const, revoked: true };
  },
});

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
import { makeFunctionReference } from "convex/server";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../server.js";
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

/**
 * Typed scheduler reference to the internal expiry transition below. The
 * generated API proxy stays untouched (no-codegen constraint), so the
 * reference is built by path with exact argument/result types instead.
 */
const expireMembershipRef = makeFunctionReference<
  "mutation",
  { membershipId: Id<"memberships"> },
  { ok: true; expired: boolean }
>("access/memberships:expireMembership");

async function scheduleTemporaryExpiry(
  ctx: F1MutationCtx,
  membershipId: Id<"memberships">,
  expiresAt: number,
  now: number,
): Promise<void> {
  await ctx.scheduler.runAfter(Math.max(0, expiresAt - now), expireMembershipRef, {
    membershipId,
  });
}

export async function recordCurrentAuthority(
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
): Promise<number | null> {
  const authorityHorizons: number[] = [];
  const projected = await ctx.db
    .query("membershipAuthorities")
    .withIndex("by_organization_identity_scope_role_authority_until", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("scopeKey", membershipScopeKey(undefined))
        .eq("role", "owner")
        .gt("authorityUntil", now),
    )
    .order("desc")
    .first();
  if (projected !== null) authorityHorizons.push(projected.authorityUntil);
  const legacyPermanent = await ctx.db
    .query("memberships")
    .withIndex("by_organization_identity_project_status_role_expires_at", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("projectId", undefined)
        .eq("status", "active")
        .eq("role", "owner")
        .eq("expiresAt", undefined),
    )
    .order("desc")
    .first();
  if (legacyPermanent !== null) authorityHorizons.push(PERMANENT_AUTHORITY_UNTIL);
  const legacyCurrentTemporary = await ctx.db
    .query("memberships")
    .withIndex("by_organization_identity_project_status_role_expires_at", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("projectId", undefined)
        .eq("status", "active")
        .eq("role", "owner")
        .gt("expiresAt", now),
    )
    .order("desc")
    .first();
  if (legacyCurrentTemporary?.expiresAt !== undefined) {
    authorityHorizons.push(legacyCurrentTemporary.expiresAt);
  }
  return authorityHorizons.length === 0 ? null : Math.max(...authorityHorizons);
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
    const ownerAuthorityUntil = await hasCurrentOrganizationOwner(ctx, args.organizationId, identity, now);
    if (ownerAuthorityUntil === null) {
      return { ok: false as const, code: "denied-capability", message: "only an owner creates projects" };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "project name required" };
    }
    const now2 = Date.now();
    const ownerExpiresAt =
      ownerAuthorityUntil === PERMANENT_AUTHORITY_UNTIL ? undefined : ownerAuthorityUntil;
    if (ownerExpiresAt !== undefined && ownerExpiresAt <= now2) {
      return { ok: false as const, code: "denied-capability", message: "organization owner authority expired" };
    }
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
      ...(ownerExpiresAt === undefined ? {} : { expiresAt: ownerExpiresAt }),
      updatedAt: now2,
    });
    await recordCurrentAuthority(
      ctx,
      args.organizationId,
      projectId,
      identity,
      "owner",
      membershipId,
      ownerExpiresAt,
      now2,
    );
    if (ownerExpiresAt !== undefined) {
      await scheduleTemporaryExpiry(ctx, membershipId, ownerExpiresAt, now2);
    }
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
    const authorityRows = resolution.value.authorities.filter(
      (authority) =>
        roleSatisfies(authority.role, "approver") &&
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
    if (args.expiresAt !== undefined) {
      await scheduleTemporaryExpiry(ctx, membershipId, args.expiresAt, now);
    }
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
      (await hasCurrentOrganizationOwner(ctx, args.organizationId, identity, now)) === null
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

/**
 * Membership expiry transition (internal, scheduler-owned).
 *
 * Every temporary grant from grantProjectAccess and every temporary
 * project-owner grant derived in createProject schedules exactly one call to
 * this mutation in the same transaction as the grant. The scheduled write is
 * the reactive invalidation source: at or after the stored expiry it deletes
 * only this membership's authority projection and marks the row revoked, so
 * the membership/authority rows watched by listAccessibleProjects and
 * getProjection change and subscribers recompute. Queries keep their own
 * server-clock fence for rows whose scheduled transition has not committed.
 * Repeated, early, missing, permanent, or already-revoked executions are
 * safe no-ops that never touch unrelated authority.
 */
export const expireMembership = f1InternalMutation({
  args: { membershipId: v.id("memberships") },
  returns: v.object({ ok: v.literal(true), expired: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.membershipId);
    if (row === null || row.status !== "active" || row.expiresAt === undefined) {
      return { ok: true as const, expired: false };
    }
    const now = Date.now();
    if (row.expiresAt > now) {
      return { ok: true as const, expired: false };
    }
    const authority = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", args.membershipId))
      .unique();
    if (authority !== null) await ctx.db.delete(authority._id);
    await ctx.db.patch(args.membershipId, { status: "revoked", revokedAt: now, updatedAt: now });
    return { ok: true as const, expired: true };
  },
});

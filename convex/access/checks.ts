/**
 * F1 backend authority helpers (controlled contract, ADR-0007).
 *
 * Every callable Convex query/mutation derives identity from `ctx.auth`
 * (`tokenIdentifier`) — never from a client-supplied user ID. These helpers
 * implement the three independent checks (capability shipped + enabled,
 * project access, current grant) against the typed `F1DataModel` with the
 * same semantics as `ControlledBackend` in `convex/shared/store.ts`.
 *
 * No existence oracles: unknown organizations, unknown projects, missing
 * memberships, cross-organization IDs, and restricted projects without an
 * explicit membership all share one `denied-membership` denial with a
 * generic message. `denied-project` is reserved for sub-resource mismatches
 * observed after project authorization already passed.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import type { F1MutationCtx, F1QueryCtx } from "../server.js";
import { isExpired } from "../shared/time.js";
import {
  lookupCapability,
  roleSatisfies,
  type CapabilityEntry,
} from "../shared/scope.js";
import { approved, denial, type AuthorityResult } from "../shared/denials.js";

export const denialValidator = v.object({
  ok: v.literal(false),
  code: v.string(),
  message: v.string(),
});

export type DbRole = "owner" | "approver" | "contributor" | "viewer";

const ROLE_ORDER: readonly DbRole[] = ["owner", "approver", "contributor", "viewer"];
export const PERMANENT_AUTHORITY_UNTIL = Number.MAX_VALUE;

const ROLE_RANK: Record<DbRole, number> = {
  viewer: 0,
  contributor: 1,
  approver: 2,
  owner: 3,
};

function bestRole(roles: readonly DbRole[]): DbRole {
  return (
    [...roles].sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ?? "viewer"
  );
}

/** Stable key shared by current-authority writes and indexed access reads. */
export function membershipScopeKey(projectId: Id<"projects"> | undefined): string {
  return projectId === undefined ? "organization" : `project:${projectId}`;
}

export interface CurrentProjectAuthority {
  readonly role: DbRole;
  readonly authorityUntil: number;
  readonly expiresAt?: number;
}

export interface ProjectAccessResolution {
  readonly role: DbRole;
  readonly visibility: "open" | "restricted";
  readonly authorities: readonly CurrentProjectAuthority[];
}

/** Minimal auth surface: queries, mutations, and actions all qualify. */
export interface AuthContext {
  readonly auth: {
    getUserIdentity: () => Promise<{ readonly tokenIdentifier: string } | null>;
  };
}

/** Identity from the authenticated session; null when unauthenticated. */
export async function identityOf(ctx: AuthContext): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier ?? null;
}

interface AuthorityScope {
  readonly projectId: Id<"projects"> | undefined;
  readonly scopeKey: string;
}

interface AuthorityObservation {
  readonly status: "active" | "revoked";
  readonly authority: CurrentProjectAuthority;
}

function authorityFromProjection(row: {
  readonly role: DbRole;
  readonly authorityUntil: number;
  readonly expiresAt?: number;
}): CurrentProjectAuthority {
  return row.expiresAt === undefined
    ? { role: row.role, authorityUntil: row.authorityUntil }
    : { role: row.role, authorityUntil: row.authorityUntil, expiresAt: row.expiresAt };
}

/**
 * Read one role/scope authority without traversing membership history.
 *
 * New writes are represented in `membershipAuthorities`, which has a
 * sortable row per active membership grant and scope/role.  The descending
 * indexed probe selects the strongest current row for that role.  The
 * bounded legacy probe keeps pre-projection rows readable during the
 * migration window; it is still an exact indexed range and never collects
 * the history.
 */
async function readAuthorityForRole(
  ctx: F1QueryCtx | F1MutationCtx,
  organizationId: Id<"organizations">,
  identity: string,
  scope: AuthorityScope,
  role: DbRole,
): Promise<AuthorityObservation | null> {
  const projected = await ctx.db
    .query("membershipAuthorities")
    .withIndex("by_organization_and_identity_and_scope_and_role_and_authority_until", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("scopeKey", scope.scopeKey)
        .eq("role", role),
    )
    .order("desc")
    .first();
  if (projected !== null) {
    return { status: "active", authority: authorityFromProjection(projected) };
  }

  const legacy = await ctx.db
    .query("memberships")
    .withIndex("by_organization_and_identity_and_project_and_status_and_role", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("projectId", scope.projectId)
        .eq("status", "active")
        .eq("role", role),
    )
    .order("desc")
    .first();
  if (legacy !== null) {
    const authority =
      legacy.expiresAt === undefined
        ? { role: legacy.role, authorityUntil: PERMANENT_AUTHORITY_UNTIL }
        : { role: legacy.role, authorityUntil: legacy.expiresAt, expiresAt: legacy.expiresAt };
    return { status: "active", authority };
  }
  const revoked = await ctx.db
    .query("memberships")
    .withIndex("by_organization_and_identity_and_project_and_status_and_role", (q) =>
      q
        .eq("organizationId", organizationId)
        .eq("identity", identity)
        .eq("projectId", scope.projectId)
        .eq("status", "revoked")
        .eq("role", role),
    )
    .order("desc")
    .first();
  if (revoked === null) return null;
  const authority =
    revoked.expiresAt === undefined
      ? { role: revoked.role, authorityUntil: PERMANENT_AUTHORITY_UNTIL }
      : { role: revoked.role, authorityUntil: revoked.expiresAt, expiresAt: revoked.expiresAt };
  return { status: "revoked", authority };
}

/**
 * Resolve project authority from the maintained projection and exact legacy
 * ranges.  Each candidate role/scope reads at most one row, so membership
 * history, revoked rows, and unrelated projects do not expand the read set.
 */
export async function resolveProjectAccess(
  ctx: F1QueryCtx | F1MutationCtx,
  identity: string,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  minRole: DbRole,
  now: number,
): Promise<AuthorityResult<ProjectAccessResolution>> {
  if (identity.trim().length === 0) return denial("forged-identity", "missing identity proof");
  const organization = await ctx.db.get(organizationId);
  const project = await ctx.db.get(projectId);
  if (organization === null || project === null || project.organizationId !== organizationId) {
    return denial("denied-membership", "not authorized for this project");
  }

  const scopes: readonly AuthorityScope[] =
    project.visibility === "restricted"
      ? [{ projectId, scopeKey: membershipScopeKey(projectId) }]
      : [
          { projectId: undefined, scopeKey: membershipScopeKey(undefined) },
          { projectId, scopeKey: membershipScopeKey(projectId) },
        ];
  const observations: AuthorityObservation[] = [];
  for (const scope of scopes) {
    for (const role of ROLE_ORDER) {
      const observation = await readAuthorityForRole(ctx, organizationId, identity, scope, role);
      if (observation !== null) observations.push(observation);
    }
  }
  const authorities = observations
    .filter((observation) => observation.status === "active")
    .map((observation) => observation.authority);
  const current = authorities.filter(
    (authority) => authority.expiresAt === undefined || !isExpired(now, authority.expiresAt),
  );
  if (current.length === 0) {
    if (observations.length === 0) {
      return denial("denied-membership", "not authorized for this project");
    }
    if (observations.every((observation) => observation.status === "revoked")) {
      return denial("revoked-membership", "membership revoked");
    }
    return denial("expired-membership", "membership expired");
  }
  const role = bestRole(current.map((authority) => authority.role));
  if (!roleSatisfies(role, minRole)) {
    return denial("denied-capability", `role ${role} cannot perform ${minRole}-level work`);
  }
  return approved({ role, visibility: project.visibility, authorities: current });
}

/**
 * Project access from stored memberships. Organization membership is proven
 * before any project document is trusted; every failure below shares one
 * denial so callers cannot probe for organization, project, or membership
 * existence.
 */
export async function checkProjectAccess(
  ctx: F1QueryCtx | F1MutationCtx,
  identity: string,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  minRole: DbRole,
  now: number,
): Promise<AuthorityResult<DbRole>> {
  const resolution = await resolveProjectAccess(
    ctx,
    identity,
    organizationId,
    projectId,
    minRole,
    now,
  );
  if (!resolution.ok) return resolution;
  return approved(resolution.value.role);
}

/** Deny-by-default capability check for the caller's role. */
export function requireCapability(
  operationKind: string,
  role: DbRole,
): AuthorityResult<CapabilityEntry> {
  const entry = lookupCapability(operationKind);
  if (entry === undefined) return denial("unknown-operation", `unknown operation ${operationKind}`);
  if (!entry.enabled) return denial("unavailable-capability", `operation ${operationKind} unavailable`);
  if (!roleSatisfies(role, entry.requiredRole)) {
    return denial("denied-capability", `role ${role} cannot run ${operationKind}`);
  }
  return approved(entry);
}

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
  if (identity.trim().length === 0) return denial("forged-identity", "missing identity proof");
  const organization = await ctx.db.get(organizationId);
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_organization_and_identity", (q) =>
      q.eq("organizationId", organizationId).eq("identity", identity),
    )
    .collect();
  if (organization === null || rows.length === 0) {
    return denial("denied-membership", "not authorized for this project");
  }
  const active = rows.filter((row) => row.status === "active");
  const current = active.filter(
    (row) => row.expiresAt === undefined || !isExpired(now, row.expiresAt),
  );
  if (current.length === 0) {
    if (rows.every((row) => row.status === "revoked")) {
      return denial("revoked-membership", "membership revoked");
    }
    return denial("expired-membership", "membership expired");
  }
  const project = await ctx.db.get(projectId);
  if (project === null || project.organizationId !== organizationId) {
    return denial("denied-membership", "not authorized for this project");
  }
  let role = bestRole(current.map((row) => row.role));
  if (project.visibility === "restricted") {
    const scoped = current.filter((row) => row.projectId === projectId);
    if (scoped.length === 0) {
      return denial("denied-membership", "not authorized for this project");
    }
    role = bestRole(scoped.map((row) => row.role));
  }
  if (!roleSatisfies(role, minRole)) {
    return denial("denied-capability", `role ${role} cannot perform ${minRole}-level work`);
  }
  return approved(role);
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

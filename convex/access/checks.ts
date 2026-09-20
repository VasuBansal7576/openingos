/**
 * F1 backend authority helpers (controlled contract, ADR-0007).
 *
 * Every callable Convex query/mutation derives identity from `ctx.auth`
 * (`tokenIdentifier`) — never from a client-supplied user ID. These helpers
 * implement the three independent checks (capability shipped + enabled,
 * project access, current grant) against `ctx.db` with the same semantics
 * as `ControlledBackend` in `convex/shared/store.ts`.
 */

import { v } from "convex/values";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../_generated/server";
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

export interface MembershipRow {
  _id: string;
  organizationId: string;
  projectId?: string;
  identity: string;
  role: DbRole;
  status: "active" | "revoked";
  expiresAt?: number;
}

/** Identity from the authenticated session; null when unauthenticated. */
export async function identityOf(ctx: QueryCtx | MutationCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier ?? null;
}

async function loadMemberships(
  db: DatabaseReader,
  organizationId: string,
  identity: string,
): Promise<MembershipRow[]> {
  // Filtered read until official codegen emits schema indexes (F0-owned
  // deployment step); semantics match `by_organization_and_identity`.
  const rows = await db
    .query("memberships")
    .filter((q) =>
      q.and(
        q.eq(q.field("organizationId"), organizationId),
        q.eq(q.field("identity"), identity),
      ),
    )
    .collect();
  return rows as unknown as MembershipRow[];
}

/**
 * Project access from stored memberships. Restricted projects require an
 * explicit project membership; cross-organization and guest/private
 * boundaries hold because memberships are per-organization.
 */
export async function checkProjectAccess(
  ctx: QueryCtx | MutationCtx,
  identity: string,
  organizationId: string,
  projectId: string,
  minRole: DbRole,
  now: number,
): Promise<AuthorityResult<DbRole>> {
  if (identity.trim().length === 0) return denial("forged-identity", "missing identity proof");
  const project = (await ctx.db.get(projectId as never)) as unknown as {
    organizationId?: string;
    visibility?: string;
  } | null;
  if (!project || project.organizationId !== organizationId) {
    return denial("denied-project", "project is not in this organization");
  }
  const rows = await loadMemberships(ctx.db, organizationId, identity);
  if (rows.length === 0) return denial("denied-membership", "no membership in this organization");
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 0) return denial("revoked-membership", "membership revoked");
  const current = active.filter(
    (row) => row.expiresAt === undefined || !isExpired(now, row.expiresAt),
  );
  if (current.length === 0) return denial("expired-membership", "membership expired");

  let role: DbRole =
    current.map((row) => row.role).sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ??
    "viewer";
  if (project.visibility === "restricted") {
    const scoped = current.filter((row) => row.projectId === projectId);
    if (scoped.length === 0) {
      return denial("denied-project", "restricted project requires explicit membership");
    }
    role =
      scoped.map((row) => row.role).sort((left, right) => ROLE_RANK[right] - ROLE_RANK[left])[0] ??
      "viewer";
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

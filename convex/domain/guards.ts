/**
 * F1 shared-domain authority guards (controlled contract, ADR-0007).
 *
 * Every domain handler derives identity from `ctx.auth` and proves
 * tenant/project access before touching a record. Cross-project
 * references are rejected after authorization with `denied-project`;
 * unknown or foreign rows never leak existence (`denied-membership`).
 * Reads are bounded through compound indexes; no unbounded collect.
 *
 * This module registers no Convex functions.
 */

import type { Id } from "../_generated/dataModel.js";
import type { F1MutationCtx, F1QueryCtx } from "../server.js";
import { approved, denial, type AuthorityResult } from "../shared/denials.js";
import {
  checkProjectAccess,
  identityOf,
  type DbRole,
} from "../access/checks.js";
import { roleSatisfies } from "../shared/scope.js";

export interface DomainAccess {
  readonly identity: string;
  readonly role: DbRole;
}

/**
 * Project-scoped authority: authenticated identity plus an active
 * membership covering this organization/project at the minimum role.
 */
export async function requireDomainAccess(
  ctx: F1QueryCtx | F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  minRole: DbRole,
): Promise<AuthorityResult<DomainAccess>> {
  const identity = await identityOf(ctx);
  if (identity === null) {
    return denial("forged-identity", "unauthenticated");
  }
  const now = Date.now();
  const access = await checkProjectAccess(
    ctx,
    identity,
    organizationId,
    projectId,
    minRole,
    now,
  );
  if (!access.ok) return access;
  return approved({ identity, role: access.value });
}

/**
 * Organization-scoped authority for org-level records (locations,
 * vendors, templates): the caller holds an active, unexpired
 * ORGANIZATION-scoped membership row. A project-scoped-only row never
 * leaks into org-wide authority: it authorizes work inside its project
 * and nothing above it.
 */
export async function requireOrganizationAccess(
  ctx: F1QueryCtx | F1MutationCtx,
  organizationId: Id<"organizations">,
  minRole: DbRole,
): Promise<AuthorityResult<DomainAccess>> {
  const identity = await identityOf(ctx);
  if (identity === null) {
    return denial("forged-identity", "unauthenticated");
  }
  const now = Date.now();
  const organization = await ctx.db.get(organizationId);
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_organization_and_identity", (q) =>
      q.eq("organizationId", organizationId).eq("identity", identity),
    )
    .take(25);
  if (organization === null || rows.length === 0) {
    return denial("denied-membership", "not authorized for this organization");
  }
  const current = rows.filter(
    (row) =>
      row.status === "active" &&
      row.projectId === undefined &&
      (row.expiresAt === undefined || row.expiresAt > now),
  );
  if (current.length === 0) {
    return denial("denied-membership", "not authorized for this organization");
  }
  const ordered = current
    .map((row) => row.role)
    .sort((left, right) => rank(right) - rank(left));
  const best = ordered[0];
  if (best === undefined) {
    return denial("denied-membership", "not authorized for this organization");
  }
  if (!roleSatisfies(best, minRole)) {
    return denial(
      "denied-capability",
      `role ${best} cannot perform ${minRole}-level work`,
    );
  }
  return approved({ identity, role: best });
}

function rank(role: DbRole): number {
  if (role === "owner") return 3;
  if (role === "approver") return 2;
  if (role === "contributor") return 1;
  return 0;
}

export interface OwnedRef {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
}

/**
 * Cross-project reference check, applied after the caller's own project
 * authorization passed. A null row, an organization mismatch, or a
 * project mismatch all share one `denied-project` denial.
 */
export function requireOwnedRef<T extends OwnedRef>(
  doc: T | null,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
): AuthorityResult<T> {
  if (
    doc === null ||
    doc.organizationId !== organizationId ||
    doc.projectId !== projectId
  ) {
    return denial("denied-project", "reference is not in this project");
  }
  return approved(doc);
}

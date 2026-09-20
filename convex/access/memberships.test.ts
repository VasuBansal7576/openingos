/**
 * Project membership grant regressions (controlled, P-20 / D-14).
 *
 * These tests exercise the registered Convex mutation with synthetic
 * identities only. A temporary approver cannot extend access beyond the
 * authority expiry that permits the grant, including for self-access.
 */

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { expect, test } from "bun:test";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import { membershipScopeKey, PERMANENT_AUTHORITY_UNTIL } from "./checks.js";
import * as memberships from "./memberships.js";

const modules = {
  "./_generated/server.js": async () => await import("../_generated/server.js"),
  "./access/memberships.ts": async () => await import("./memberships.js"),
  "./access/checks.ts": async () => await import("./checks.js"),
  "./shared/scope.ts": async () => await import("../shared/scope.js"),
  "./shared/time.ts": async () => await import("../shared/time.js"),
  "./shared/denials.ts": async () => await import("../shared/denials.js"),
  "./server.ts": async () => await import("../server.js"),
} satisfies Record<string, () => Promise<unknown>>;

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;

const createOrganizationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createOrganization>,
  MutationReturn<typeof memberships.createOrganization>
>("access/memberships:createOrganization");
const createProjectRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createProject>,
  MutationReturn<typeof memberships.createProject>
>("access/memberships:createProject");
const grantProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.grantProjectAccess>,
  MutationReturn<typeof memberships.grantProjectAccess>
>("access/memberships:grantProjectAccess");
const revokeProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.revokeProjectAccess>,
  MutationReturn<typeof memberships.revokeProjectAccess>
>("access/memberships:revokeProjectAccess");
const myProjectRoleRef = makeFunctionReference<
  "query",
  QueryArgs<typeof memberships.myProjectRole>,
  QueryReturn<typeof memberships.myProjectRole>
>("access/memberships:myProjectRole");

const OWNER = { tokenIdentifier: "membership-regression-owner" };
const TEMPORARY_APPROVER = { tokenIdentifier: "membership-regression-temporary-approver" };

type MembershipRole = "owner" | "approver" | "contributor" | "viewer";

async function insertMembershipWithAuthority(
  t: ReturnType<typeof convexTest>,
  input: {
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
    identity: string;
    role: MembershipRole;
    expiresAt?: number;
  },
): Promise<Id<"memberships">> {
  return t.run(async (ctx) => {
    const membershipId = await ctx.db.insert("memberships", {
      organizationId: input.organizationId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      identity: input.identity,
      role: input.role,
      status: "active",
      version: 1,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("membershipAuthorities", {
      organizationId: input.organizationId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      identity: input.identity,
      scopeKey: membershipScopeKey(input.projectId),
      role: input.role,
      membershipId,
      authorityUntil: input.expiresAt ?? PERMANENT_AUTHORITY_UNTIL,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      updatedAt: Date.now(),
    });
    return membershipId;
  });
}

async function membershipCount(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("memberships").collect()).then((rows) => rows.length);
}

test("temporary approvers cannot grant access beyond their authority expiry", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership expiry regression organization",
    kind: "private",
  });
  expect(organization.ok).toBe(true);
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Membership expiry regression project",
    visibility: "open",
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error("project setup failed");

  const authorityExpiry = Date.now() + 3_600_000;
  const temporaryGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    targetIdentity: TEMPORARY_APPROVER.tokenIdentifier,
    role: "approver",
    expiresAt: authorityExpiry,
  });
  expect(temporaryGrant.ok).toBe(true);
  const asTemporaryApprover = t.withIdentity(TEMPORARY_APPROVER);

  for (const [label, targetIdentity, role] of [
    ["other-member", "membership-regression-other", "viewer"],
    ["self-access", TEMPORARY_APPROVER.tokenIdentifier, "approver"],
  ] as const) {
    const before = await membershipCount(t);
    const denied = await asTemporaryApprover.mutation(grantProjectAccessRef, {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      targetIdentity,
      role,
      expiresAt: authorityExpiry + 1,
    });
    expect(denied.ok, label).toBe(false);
    if (denied.ok) throw new Error(`${label} unexpectedly exceeded temporary authority`);
    expect(denied.code, label).toBe("invalid-payload");
    expect(await membershipCount(t), label).toBe(before);
  }

  const beforeNonExpiring = await membershipCount(t);
  const nonExpiring = await asTemporaryApprover.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    targetIdentity: "membership-regression-non-expiring",
    role: "viewer",
  });
  expect(nonExpiring.ok).toBe(false);
  if (!nonExpiring.ok) expect(nonExpiring.code).toBe("invalid-payload");
  expect(await membershipCount(t)).toBe(beforeNonExpiring);

  const bounded = await asTemporaryApprover.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    targetIdentity: "membership-regression-bounded",
    role: "viewer",
    expiresAt: authorityExpiry,
  });
  expect(bounded.ok).toBe(true);
});

test("open and restricted scope precedence preserves permanent approver delegation", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership precedence organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const open = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Open precedence project",
    visibility: "open",
  });
  if (!open.ok) throw new Error("open project setup failed");
  const restricted = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Restricted precedence project",
    visibility: "restricted",
  });
  if (!restricted.ok) throw new Error("restricted project setup failed");

  const delegate = "membership-regression-precedence-delegate";
  const ownerExpiry = Date.now() + 3_600_000;
  for (const projectId of [open.projectId, restricted.projectId]) {
    await insertMembershipWithAuthority(t, {
      organizationId: organization.organizationId,
      identity: delegate,
      role: "approver",
    });
    await insertMembershipWithAuthority(t, {
      organizationId: organization.organizationId,
      projectId,
      identity: delegate,
      role: "owner",
      expiresAt: ownerExpiry,
    });
  }

  const asDelegate = t.withIdentity({ tokenIdentifier: delegate });
  const openRole = await asDelegate.query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: open.projectId,
  });
  expect(openRole).toMatchObject({ ok: true, role: "owner" });
  const restrictedRole = await asDelegate.query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: restricted.projectId,
  });
  expect(restrictedRole).toMatchObject({ ok: true, role: "owner" });

  // Open projects retain the permanent organization approver as a valid
  // source for a permanent approver delegation despite the temporary owner.
  const openApprover = await asDelegate.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: open.projectId,
    targetIdentity: "membership-regression-open-approver",
    role: "approver",
  });
  expect(openApprover).toMatchObject({ ok: true });

  // Restricted projects ignore the organization row, so the same request is
  // bounded by the shorter project-scoped owner authority.
  const restrictedApprover = await asDelegate.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: restricted.projectId,
    targetIdentity: "membership-regression-restricted-approver",
    role: "approver",
  });
  expect(restrictedApprover).toMatchObject({ ok: false, code: "invalid-payload" });

  for (const [label, projectId] of [
    ["open", open.projectId],
    ["restricted", restricted.projectId],
  ] as const) {
    const unboundedOwner = await asDelegate.mutation(grantProjectAccessRef, {
      organizationId: organization.organizationId,
      projectId,
      targetIdentity: `membership-regression-${label}-owner`,
      role: "owner",
    });
    expect(unboundedOwner, label).toMatchObject({ ok: false, code: "invalid-payload" });
    const boundedOwner = await asDelegate.mutation(grantProjectAccessRef, {
      organizationId: organization.organizationId,
      projectId,
      targetIdentity: `membership-regression-${label}-bounded-owner`,
      role: "owner",
      expiresAt: ownerExpiry,
    });
    expect(boundedOwner, label).toMatchObject({ ok: true });
  }
});

test("actual access handlers stay bounded with 300 revoked unrelated memberships", async () => {
  const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 64 } });
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership bounded organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Membership bounded target project",
    visibility: "open",
  });
  if (!project.ok) throw new Error("target project setup failed");
  const unrelated = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Membership bounded unrelated project",
    visibility: "open",
  });
  if (!unrelated.ok) throw new Error("unrelated project setup failed");

  await t.run(async (ctx) => {
    for (let index = 0; index < 300; index += 1) {
      await ctx.db.insert("memberships", {
        organizationId: organization.organizationId,
        projectId: unrelated.projectId,
        identity: OWNER.tokenIdentifier,
        role: "viewer",
        status: "revoked",
        version: 1,
        revokedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });

  // The old history collect would exceed this transaction budget. Keep this
  // baseline probe explicit so the handler regressions prove the bound is
  // meaningful rather than merely counting a small test fixture.
  await expect(
    t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_organization_and_identity", (q) =>
          q.eq("organizationId", organization.organizationId).eq("identity", OWNER.tokenIdentifier),
        )
        .collect(),
    ),
  ).rejects.toThrow(/too many documents/i);

  const role = await asOwner.query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
  });
  expect(role).toMatchObject({ ok: true, role: "owner" });
  const granted = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    targetIdentity: "membership-regression-bounded-grantee",
    role: "viewer",
  });
  expect(granted).toMatchObject({ ok: true });
});

test("revoke denies inaccessible existing and absent memberships uniformly", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership revoke oracle organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const projectA = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Revoke oracle project A",
    visibility: "open",
  });
  if (!projectA.ok) throw new Error("project A setup failed");
  const projectB = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Revoke oracle project B",
    visibility: "open",
  });
  if (!projectB.ok) throw new Error("project B setup failed");
  const approver = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: projectB.projectId,
    targetIdentity: "membership-regression-revoke-approver",
    role: "approver",
  });
  if (!approver.ok) throw new Error("approver setup failed");

  const targetIdentity = "membership-regression-cross-project-target";
  const crossProjectMembershipId = await insertMembershipWithAuthority(t, {
    organizationId: organization.organizationId,
    projectId: projectA.projectId,
    identity: targetIdentity,
    role: "owner",
  });
  const absentMembershipId = await insertMembershipWithAuthority(t, {
    organizationId: organization.organizationId,
    projectId: projectA.projectId,
    identity: "membership-regression-absent-target",
    role: "viewer",
  });
  await t.run((ctx) => ctx.db.delete(absentMembershipId));

  const asApprover = t.withIdentity({ tokenIdentifier: "membership-regression-revoke-approver" });
  const inaccessible = await asApprover.mutation(revokeProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: projectB.projectId,
    membershipId: crossProjectMembershipId,
  });
  const absent = await asApprover.mutation(revokeProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: projectB.projectId,
    membershipId: absentMembershipId,
  });
  expect(inaccessible).toEqual(absent);
  expect(inaccessible).toEqual({
    ok: false,
    code: "denied-membership",
    message: "not authorized for this project",
  });
});

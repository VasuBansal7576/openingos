/**
 * Project membership grant regressions (controlled, P-20 / D-14).
 *
 * These tests exercise the registered Convex mutation with synthetic
 * identities only. A temporary approver cannot extend access beyond the
 * authority expiry that permits the grant, including for self-access.
 */

import { convexTest } from "convex-test";
import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { expect, test } from "bun:test";
import schema from "../schema.js";
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

const OWNER = { tokenIdentifier: "membership-regression-owner" };
const TEMPORARY_APPROVER = { tokenIdentifier: "membership-regression-temporary-approver" };

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

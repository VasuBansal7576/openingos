/**
 * Project membership grant regressions (controlled, P-20 / D-14).
 *
 * These tests exercise the registered Convex mutation with synthetic
 * identities only. A temporary approver cannot extend access beyond the
 * authority expiry that permits the grant, including for self-access.
 *
 * Scheduled-expiry regressions run on a controlled clock: `Date.now` and the
 * timer globals are replaced for the duration of a test, so the scheduler's
 * expiry transition only executes when the test advances controlled time
 * past the stored expiry and drains due callbacks. No wall-clock sleeping.
 */

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { afterEach, expect, test } from "bun:test";
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
const expireMembershipRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.expireMembership>,
  MutationReturn<typeof memberships.expireMembership>
>("access/memberships:expireMembership");

const OWNER = { tokenIdentifier: "membership-regression-owner" };
const TEMPORARY_APPROVER = { tokenIdentifier: "membership-regression-temporary-approver" };

type MembershipRole = "owner" | "approver" | "contributor" | "viewer";

async function insertMembership(
  t: ReturnType<typeof convexTest>,
  input: {
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
    identity: string;
    role: MembershipRole;
    expiresAt?: number;
  },
  withAuthority: boolean,
): Promise<Id<"memberships">> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const membershipId = await ctx.db.insert("memberships", {
      organizationId: input.organizationId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      identity: input.identity,
      role: input.role,
      status: "active",
      version: 1,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      updatedAt: now,
    });
    if (withAuthority) {
      await ctx.db.insert("membershipAuthorities", {
        organizationId: input.organizationId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        identity: input.identity,
        scopeKey: membershipScopeKey(input.projectId),
        role: input.role,
        membershipId,
        authorityUntil: input.expiresAt ?? PERMANENT_AUTHORITY_UNTIL,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        updatedAt: now,
      });
    }
    return membershipId;
  });
}

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
  return insertMembership(t, input, true);
}

async function insertLegacyMembership(
  t: ReturnType<typeof convexTest>,
  input: {
    organizationId: Id<"organizations">;
    projectId?: Id<"projects">;
    identity: string;
    role: MembershipRole;
    expiresAt?: number;
  },
): Promise<Id<"memberships">> {
  return insertMembership(t, input, false);
}

async function membershipCount(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) => ctx.db.query("memberships").collect()).then((rows) => rows.length);
}

function createKit() {
  return convexTest(schema, modules);
}

type Kit = ReturnType<typeof createKit>;

async function authorityCountFor(
  t: Kit,
  membershipId: Id<"memberships">,
): Promise<number> {
  return t.run(async (ctx) => {
    const rows = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", membershipId))
      .take(2);
    return rows.length;
  });
}

async function membershipStatus(
  t: Kit,
  membershipId: Id<"memberships">,
): Promise<string | null> {
  return t.run(async (ctx) => {
    const row = await ctx.db.get(membershipId);
    return row?.status ?? null;
  });
}

/**
 * Controlled clock for the scheduled-expiry regressions (P-20 / D-14).
 *
 * Temporary grants in these tests expire a few hundred controlled-clock
 * milliseconds after creation. While a clock is installed, `Date.now` reads
 * controlled time and the timer globals register callbacks on the clock
 * instead of the real event loop, so the scheduler's expiry timer can only
 * run when the test advances controlled time to it. convex-test captures the
 * real setTimeout for its own internal yielding before any clock is
 * installed, and reads `globalThis.setTimeout` at scheduling time, so the
 * replacement is observed end to end: the grant's `runAfter` delay is
 * computed from controlled `Date.now` and the transition fires exactly at
 * the controlled boundary.
 */
class ControlledClock {
  private currentMs: number;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextTimerId = 1;
  private readonly realDateNow: () => number = Date.now.bind(Date);
  private readonly realSetTimeout = globalThis.setTimeout;
  private readonly realClearTimeout = globalThis.clearTimeout;

  constructor() {
    this.currentMs = this.realDateNow();
  }

  install(): void {
    const clock = this;
    Date.now = () => clock.currentMs;
    globalThis.setTimeout = ((callback: () => void, ms?: number) =>
      clock.registerTimer(callback, ms ?? 0)) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timerId: number) => {
      clock.timers.delete(timerId);
    }) as unknown as typeof globalThis.clearTimeout;
  }

  restore(): void {
    Date.now = this.realDateNow;
    globalThis.setTimeout = this.realSetTimeout;
    globalThis.clearTimeout = this.realClearTimeout;
  }

  now(): number {
    return this.currentMs;
  }

  /** Move controlled time forward to exactly `targetMs`. */
  advanceTo(targetMs: number): void {
    if (targetMs < this.currentMs) {
      throw new Error("controlled clock cannot move backwards");
    }
    this.currentMs = targetMs;
  }

  private registerTimer(callback: () => void, ms: number): number {
    const timerId = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(timerId, { at: this.currentMs + Math.max(0, ms), callback });
    return timerId;
  }

  /** Run every timer callback whose controlled time has been reached. */
  fireDueTimers(): void {
    for (const [timerId, timer] of [...this.timers]) {
      if (timer.at <= this.currentMs) {
        this.timers.delete(timerId);
        timer.callback();
      }
    }
  }
}

let activeClock: ControlledClock | null = null;

/**
 * Install a controlled clock for the current test. The module-level
 * `afterEach` below restores the real clock even when an assertion fails,
 * so timer overrides never leak into the next test.
 */
function installControlledClock(): ControlledClock {
  const clock = new ControlledClock();
  clock.install();
  activeClock = clock;
  return clock;
}

afterEach(() => {
  activeClock?.restore();
  activeClock = null;
});

/**
 * Drain the scheduler boundary deterministically: fire every callback the
 * controlled time has reached (the registered expiry transition among them)
 * and wait for all in-flight scheduled functions to settle. The controlled
 * clock must already be at or past the expiry being tested, so this never
 * depends on wall-clock waiting.
 */
async function settleScheduledExpiries(t: Kit, clock: ControlledClock): Promise<void> {
  await t.finishAllScheduledFunctions(() => clock.fireDueTimers());
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
  for (const [projectId, approverProjectId] of [
    [open.projectId, undefined],
    [restricted.projectId, restricted.projectId],
  ] as const) {
    await insertMembershipWithAuthority(t, {
      organizationId: organization.organizationId,
      ...(approverProjectId === undefined ? {} : { projectId: approverProjectId }),
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

  // Restricted projects use the project-scoped permanent approver, which
  // remains a valid source despite the shorter project-scoped owner row.
  const restrictedApprover = await asDelegate.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: restricted.projectId,
    targetIdentity: "membership-regression-restricted-approver",
    role: "approver",
  });
  expect(restrictedApprover).toMatchObject({ ok: true });

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

test("permanent lower roles cannot extend a temporary approver delegation", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership mixed-role horizon organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const open = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Mixed-role open project",
    visibility: "open",
  });
  if (!open.ok) throw new Error("open project setup failed");
  const restricted = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Mixed-role restricted project",
    visibility: "restricted",
  });
  if (!restricted.ok) throw new Error("restricted project setup failed");

  const delegate = "membership-regression-mixed-role-delegate";
  const authorityExpiry = Date.now() + 3_600_000;
  for (const [projectId, projectScoped] of [
    [open.projectId, false],
    [restricted.projectId, true],
  ] as const) {
    for (const role of ["viewer", "contributor"] as const) {
      await insertMembershipWithAuthority(t, {
        organizationId: organization.organizationId,
        ...(projectScoped ? { projectId } : {}),
        identity: delegate,
        role,
      });
    }
    await insertMembershipWithAuthority(t, {
      organizationId: organization.organizationId,
      projectId,
      identity: delegate,
      role: "approver",
      expiresAt: authorityExpiry,
    });
  }

  const asDelegate = t.withIdentity({ tokenIdentifier: delegate });
  for (const [label, projectId] of [
    ["open", open.projectId],
    ["restricted", restricted.projectId],
  ] as const) {
    for (const role of ["viewer", "contributor"] as const) {
      const unbounded = await asDelegate.mutation(grantProjectAccessRef, {
        organizationId: organization.organizationId,
        projectId,
        targetIdentity: `membership-regression-${label}-${role}-unbounded`,
        role,
      });
      expect(unbounded, `${label} ${role}`).toMatchObject({
        ok: false,
        code: "invalid-payload",
      });

      const bounded = await asDelegate.mutation(grantProjectAccessRef, {
        organizationId: organization.organizationId,
        projectId,
        targetIdentity: `membership-regression-${label}-${role}-bounded`,
        role,
        expiresAt: authorityExpiry,
      });
      expect(bounded, `${label} ${role}`).toMatchObject({ ok: true });
    }
  }
});

test("temporary organization-owner authority bounds project creation membership and projection", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership temporary organization owner",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");

  const temporaryOwner = "membership-regression-temporary-organization-owner";
  const authorityExpiry = Date.now() + 3_600_000;
  await insertMembershipWithAuthority(t, {
    organizationId: organization.organizationId,
    identity: temporaryOwner,
    role: "owner",
    expiresAt: authorityExpiry,
  });

  const created = await t.withIdentity({ tokenIdentifier: temporaryOwner }).mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Temporary organization owner project",
    visibility: "restricted",
  });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error("temporary owner project creation failed");

  const stored = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_project_and_identity", (q) =>
        q.eq("projectId", created.projectId).eq("identity", temporaryOwner),
      )
      .unique();
    if (membership === null) throw new Error("project owner membership missing");
    const authority = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
      .unique();
    if (authority === null) throw new Error("project owner authority projection missing");
    return {
      membershipId: membership._id,
      authorityId: authority._id,
      membershipExpiresAt: membership.expiresAt,
      authorityExpiresAt: authority.expiresAt,
      authorityUntil: authority.authorityUntil,
    };
  });
  expect(stored.membershipExpiresAt).toBe(authorityExpiry);
  expect(stored.authorityExpiresAt).toBe(authorityExpiry);
  expect(stored.authorityUntil).toBe(authorityExpiry);

  const beforeExpiry = await t.withIdentity({ tokenIdentifier: temporaryOwner }).query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: created.projectId,
  });
  expect(beforeExpiry).toMatchObject({ ok: true, role: "owner" });

  // Move both propagated rows past the server clock so the public role query
  // proves the created project does not retain permanent access.
  await t.run(async (ctx) => {
    const expiredAt = Date.now() - 1;
    await ctx.db.patch(stored.membershipId, { expiresAt: expiredAt, updatedAt: expiredAt });
    await ctx.db.patch(stored.authorityId, {
      expiresAt: expiredAt,
      authorityUntil: expiredAt,
      updatedAt: expiredAt,
    });
  });
  const afterExpiry = await t.withIdentity({ tokenIdentifier: temporaryOwner }).query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: created.projectId,
  });
  expect(afterExpiry).toMatchObject({ ok: false, code: "expired-membership" });
});

test("legacy permanent authority wins over temporary and expired projections", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership migration precedence organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const temporaryProject = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Temporary projection project",
    visibility: "restricted",
  });
  if (!temporaryProject.ok) throw new Error("temporary project setup failed");
  const expiredProject = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Expired projection project",
    visibility: "restricted",
  });
  if (!expiredProject.ok) throw new Error("expired project setup failed");

  const cases = [
    {
      identity: "membership-regression-legacy-vs-temporary",
      projectId: temporaryProject.projectId,
      expiresAt: Date.now() + 3_600_000,
    },
    {
      identity: "membership-regression-legacy-vs-expired",
      projectId: expiredProject.projectId,
      expiresAt: Date.now() - 1,
    },
  ] as const;
  for (const authorityCase of cases) {
    await insertLegacyMembership(t, {
      organizationId: organization.organizationId,
      projectId: authorityCase.projectId,
      identity: authorityCase.identity,
      role: "approver",
    });
    await insertMembershipWithAuthority(t, {
      organizationId: organization.organizationId,
      projectId: authorityCase.projectId,
      identity: authorityCase.identity,
      role: "approver",
      expiresAt: authorityCase.expiresAt,
    });
  }

  for (const authorityCase of cases) {
    const asDelegate = t.withIdentity({ tokenIdentifier: authorityCase.identity });
    const role = await asDelegate.query(myProjectRoleRef, {
      organizationId: organization.organizationId,
      projectId: authorityCase.projectId,
    });
    expect(role, authorityCase.identity).toMatchObject({ ok: true, role: "approver" });
    const delegated = await asDelegate.mutation(grantProjectAccessRef, {
      organizationId: organization.organizationId,
      projectId: authorityCase.projectId,
      targetIdentity: `${authorityCase.identity}-target`,
      role: "approver",
    });
    expect(delegated, authorityCase.identity).toMatchObject({ ok: true });
  }
});

test("organization owner resolution merges legacy and projected authority", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership organization-owner migration organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const mixedIdentity = "membership-regression-mixed-organization-owner";

  await insertLegacyMembership(t, {
    organizationId: organization.organizationId,
    identity: mixedIdentity,
    role: "owner",
  });
  await insertMembershipWithAuthority(t, {
    organizationId: organization.organizationId,
    identity: mixedIdentity,
    role: "owner",
    expiresAt: Date.now() - 1,
  });

  const created = await t.withIdentity({ tokenIdentifier: mixedIdentity }).mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Created by mixed legacy owner",
    visibility: "restricted",
  });
  expect(created).toMatchObject({ ok: true });
});

test("repeated revocation leaves project access revoked and projection removed", async () => {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership repeated revocation organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Repeated revocation project",
    visibility: "restricted",
  });
  if (!project.ok) throw new Error("project setup failed");
  const granted = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    targetIdentity: "membership-regression-repeated-revoke",
    role: "viewer",
  });
  if (!granted.ok) throw new Error("grant setup failed");

  const first = await asOwner.mutation(revokeProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    membershipId: granted.membershipId,
  });
  const second = await asOwner.mutation(revokeProjectAccessRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    membershipId: granted.membershipId,
  });
  expect(first).toMatchObject({ ok: true, revoked: true });
  expect(second).toMatchObject({ ok: true, revoked: true });

  const role = await t.withIdentity({ tokenIdentifier: "membership-regression-repeated-revoke" }).query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
  });
  expect(role).toMatchObject({ ok: false, code: "revoked-membership" });
  const projectionCount = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", granted.membershipId))
      .take(2);
    return rows.length;
  });
  expect(projectionCount).toBe(0);
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

test("temporary grants schedule expiry while permanent grants and stronger authority persist", async () => {
  const clock = installControlledClock();
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership scheduled expiry organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Scheduled expiry project",
    visibility: "restricted",
  });
  if (!project.ok) throw new Error("project setup failed");

  const expiring = "membership-regression-scheduled-expiring";
  const steady = "membership-regression-scheduled-steady";
  const dual = "membership-regression-scheduled-dual";
  const expiresAt = clock.now() + 200;
  const grant = {
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };

  const tempViewer = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: expiring,
    role: "viewer",
    expiresAt,
  });
  if (!tempViewer.ok) throw new Error("temporary grant setup failed");
  const permanentViewer = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: steady,
    role: "viewer",
  });
  if (!permanentViewer.ok) throw new Error("permanent grant setup failed");
  const dualPermanent = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: dual,
    role: "approver",
  });
  if (!dualPermanent.ok) throw new Error("dual permanent grant setup failed");
  const dualTemp = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: dual,
    role: "viewer",
    expiresAt,
  });
  if (!dualTemp.ok) throw new Error("dual temporary grant setup failed");

  for (const [identity, role] of [
    [expiring, "viewer"],
    [steady, "viewer"],
    [dual, "approver"],
  ] as const) {
    const before = await t.withIdentity({ tokenIdentifier: identity }).query(myProjectRoleRef, grant);
    expect(before, identity).toMatchObject({ ok: true, role });
  }

  // Advance the controlled clock exactly to the stored expiry and drain the
  // scheduler boundary: the registered transition runs now, not on the wall
  // clock.
  clock.advanceTo(expiresAt);
  await settleScheduledExpiries(t, clock);

  // The scheduled transition revoked the temporary-only grant.
  const expiredRole = await t.withIdentity({ tokenIdentifier: expiring }).query(myProjectRoleRef, grant);
  expect(expiredRole).toMatchObject({ ok: false, code: "revoked-membership" });
  expect(await membershipStatus(t, tempViewer.membershipId)).toBe("revoked");
  expect(await authorityCountFor(t, tempViewer.membershipId)).toBe(0);

  // Permanent grants schedule nothing, so steady access is untouched.
  const steadyRole = await t.withIdentity({ tokenIdentifier: steady }).query(myProjectRoleRef, grant);
  expect(steadyRole).toMatchObject({ ok: true, role: "viewer" });
  expect(await membershipStatus(t, permanentViewer.membershipId)).toBe("active");
  expect(await authorityCountFor(t, permanentViewer.membershipId)).toBe(1);

  // The dual identity loses only its exact temporary authority; the
  // independent permanent approver grant remains valid.
  const dualRole = await t.withIdentity({ tokenIdentifier: dual }).query(myProjectRoleRef, grant);
  expect(dualRole).toMatchObject({ ok: true, role: "approver" });
  expect(await authorityCountFor(t, dualTemp.membershipId)).toBe(0);
  expect(await authorityCountFor(t, dualPermanent.membershipId)).toBe(1);

  // Repeated expiry on an already-revoked row and expiry on a permanent
  // row are safe no-ops.
  expect(await t.mutation(expireMembershipRef, { membershipId: tempViewer.membershipId })).toEqual({
    ok: true,
    expired: false,
  });
  expect(await t.mutation(expireMembershipRef, { membershipId: permanentViewer.membershipId })).toEqual({
    ok: true,
    expired: false,
  });
  expect(await t.withIdentity({ tokenIdentifier: steady }).query(myProjectRoleRef, grant)).toMatchObject({
    ok: true,
    role: "viewer",
  });
  expect(await t.withIdentity({ tokenIdentifier: dual }).query(myProjectRoleRef, grant)).toMatchObject({
    ok: true,
    role: "approver",
  });
});

test("temporary organization-owner project grants schedule their own expiry", async () => {
  const clock = installControlledClock();
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership scheduled project-owner organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");

  const temporaryOwner = "membership-regression-scheduled-organization-owner";
  const authorityExpiry = clock.now() + 200;
  await insertMembershipWithAuthority(t, {
    organizationId: organization.organizationId,
    identity: temporaryOwner,
    role: "owner",
    expiresAt: authorityExpiry,
  });

  const created = await t.withIdentity({ tokenIdentifier: temporaryOwner }).mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Scheduled organization owner project",
    visibility: "restricted",
  });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error("temporary owner project creation failed");

  const stored = await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_project_and_identity", (q) =>
        q.eq("projectId", created.projectId).eq("identity", temporaryOwner),
      )
      .unique();
    if (membership === null) throw new Error("project owner membership missing");
    return { membershipId: membership._id, membershipExpiresAt: membership.expiresAt };
  });
  expect(stored.membershipExpiresAt).toBe(authorityExpiry);

  const beforeExpiry = await t.withIdentity({ tokenIdentifier: temporaryOwner }).query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: created.projectId,
  });
  expect(beforeExpiry).toMatchObject({ ok: true, role: "owner" });

  // Controlled boundary: the derived project-owner grant's own scheduled
  // transition fires exactly when controlled time reaches its stored expiry.
  clock.advanceTo(authorityExpiry);
  await settleScheduledExpiries(t, clock);

  const afterExpiry = await t.withIdentity({ tokenIdentifier: temporaryOwner }).query(myProjectRoleRef, {
    organizationId: organization.organizationId,
    projectId: created.projectId,
  });
  expect(afterExpiry.ok).toBe(false);
  expect(await membershipStatus(t, stored.membershipId)).toBe("revoked");
  expect(await authorityCountFor(t, stored.membershipId)).toBe(0);
  expect(await t.mutation(expireMembershipRef, { membershipId: stored.membershipId })).toEqual({
    ok: true,
    expired: false,
  });
});

test("expiry execution is safe when early, permanent, or membership-scoped to a missing row", async () => {
  const clock = installControlledClock();
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Membership expiry safety organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Expiry safety project",
    visibility: "restricted",
  });
  if (!project.ok) throw new Error("project setup failed");
  const grant = {
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };

  const earlyExpiresAt = clock.now() + 400;
  const early = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: "membership-regression-expiry-early",
    role: "viewer",
    expiresAt: earlyExpiresAt,
  });
  if (!early.ok) throw new Error("early grant setup failed");
  const permanent = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: "membership-regression-expiry-permanent",
    role: "viewer",
  });
  if (!permanent.ok) throw new Error("permanent grant setup failed");
  const ghost = await asOwner.mutation(grantProjectAccessRef, {
    ...grant,
    targetIdentity: "membership-regression-expiry-ghost",
    role: "viewer",
  });
  if (!ghost.ok) throw new Error("ghost grant setup failed");

  // Executing before the stored expiry is a no-op that keeps authority.
  expect(await t.mutation(expireMembershipRef, { membershipId: early.membershipId })).toEqual({
    ok: true,
    expired: false,
  });
  expect(await t.withIdentity({ tokenIdentifier: "membership-regression-expiry-early" }).query(myProjectRoleRef, grant)).toMatchObject({
    ok: true,
    role: "viewer",
  });
  expect(await authorityCountFor(t, early.membershipId)).toBe(1);

  // Permanent memberships never expire through this transition.
  expect(await t.mutation(expireMembershipRef, { membershipId: permanent.membershipId })).toEqual({
    ok: true,
    expired: false,
  });

  // A missing membership row is a no-op scoped to that id: unrelated and
  // orphaned authority rows are left alone.
  await t.run((ctx) => ctx.db.delete(ghost.membershipId));
  expect(await t.mutation(expireMembershipRef, { membershipId: ghost.membershipId })).toEqual({
    ok: true,
    expired: false,
  });
  expect(await authorityCountFor(t, ghost.membershipId)).toBe(1);
  expect(await authorityCountFor(t, early.membershipId)).toBe(1);
  expect(await authorityCountFor(t, permanent.membershipId)).toBe(1);

  // The early grant's own scheduled transition still lands once controlled
  // time passes its stored expiry, while the permanent grant stays current.
  clock.advanceTo(earlyExpiresAt);
  await settleScheduledExpiries(t, clock);
  expect(await t.withIdentity({ tokenIdentifier: "membership-regression-expiry-early" }).query(myProjectRoleRef, grant)).toMatchObject({
    ok: false,
  });
  expect(await t.withIdentity({ tokenIdentifier: "membership-regression-expiry-permanent" }).query(myProjectRoleRef, grant)).toMatchObject({
    ok: true,
    role: "viewer",
  });
});

/// <reference types="vite/client" />
/**
 * P-01 intake boundary regressions (controlled, PRD 10 / P-01).
 *
 * One atomic, idempotent Convex boundary derives identity from auth,
 * validates bounded normalized inputs, reuses or creates the
 * caller-owned organization, creates a project with current owner
 * authority plus minimal initial records and material history, and
 * returns the exact project id. No research, grants, spend, provider
 * contact, or supplier evidence is involved.
 */

import { makeFunctionReference, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel.js";
import { PERMANENT_AUTHORITY_UNTIL, membershipScopeKey } from "../access/checks.js";
import schema from "../schema.js";
import * as intake from "./intake.js";
import * as memberships from "../access/memberships.js";
import * as projection from "../workbench/projection.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "./**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "../workbench/**/*.ts",
  "../research/researchScope.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!./**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../purchasing/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!../workbench/**/*.test.ts",
]);
const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./") ? `domain/${path.slice(2)}` : path.replace(/^\.\.\//, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;

function createKit() {
  return convexTest(schema, modules);
}

/** Typed test kit so ctx.db keeps the project's indexes and documents. */
type TestKit = ReturnType<typeof createKit>;

const createWorkspaceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof intake.createWorkspace>,
  MutationReturn<typeof intake.createWorkspace>
>("domain/intake:createWorkspace");
const myProjectRoleRef = makeFunctionReference<
  "query",
  QueryArgs<typeof memberships.myProjectRole>,
  QueryReturn<typeof memberships.myProjectRole>
>("access/memberships:myProjectRole");
const getProjectionRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.getProjection>,
  QueryReturn<typeof projection.getProjection>
>("workbench/projection:getProjection");
const listProjectsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof projection.listAccessibleProjects>,
  QueryReturn<typeof projection.listAccessibleProjects>
>("workbench/projection:listAccessibleProjects");

const OWNER = { tokenIdentifier: "intake-owner" };
const OTHER = { tokenIdentifier: "intake-other" };

const expireMembershipRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.expireMembership>,
  MutationReturn<typeof memberships.expireMembership>
>("access/memberships:expireMembership");

/**
 * Controlled clock for the scheduled-expiry regressions: the intake's
 * derived temporary project grant schedules the shared idempotent
 * membership-expiry transition, and convex-test reads `globalThis.setTimeout`
 * at scheduling time, so the replacement below is observed end to end. While
 * the clock is installed, `Date.now` reads controlled time and the expiry
 * timer fires only when the test advances controlled time to it.
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

afterEach(() => {
  activeClock?.restore();
  activeClock = null;
});

function installControlledClock(): ControlledClock {
  const clock = new ControlledClock();
  clock.install();
  activeClock = clock;
  return clock;
}

/**
 * Seed org-scoped owner authority rows for one identity inside one private
 * organization. "temporary" rows carry a controlled-clock horizon one hour
 * ahead; "permanent" rows carry the shared permanent horizon. The returned
 * horizon is the maximum authority until across the seeded rows.
 */
async function seedOrgOwnerAuthority(
  t: TestKit,
  identity: string,
  suffix: string,
  rows: readonly ("temporary" | "permanent")[],
): Promise<{ organizationId: Id<"organizations">; horizon: number }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `${suffix} organization`,
      kind: "private",
      createdAt: now,
    });
    const horizons: number[] = [];
    for (const row of rows) {
      const expiresAt = row === "temporary" ? now + 3_600_000 : undefined;
      const membershipId = await ctx.db.insert("memberships", {
        organizationId,
        identity,
        role: "owner",
        status: "active",
        version: 1,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        updatedAt: now,
      });
      await ctx.db.insert("membershipAuthorities", {
        organizationId,
        identity,
        scopeKey: membershipScopeKey(undefined),
        role: "owner",
        membershipId,
        authorityUntil: expiresAt ?? PERMANENT_AUTHORITY_UNTIL,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        updatedAt: now,
      });
      horizons.push(expiresAt ?? PERMANENT_AUTHORITY_UNTIL);
    }
    return { organizationId, horizon: Math.max(...horizons) };
  });
}

type ProjectGrantSnapshot = {
  readonly membership: { readonly expiresAt?: number; readonly status: string } | null;
  readonly authority: {
    readonly authorityUntil: number;
    readonly expiresAt?: number;
  } | null;
};

async function readProjectGrant(
  t: TestKit,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  identity: string,
): Promise<ProjectGrantSnapshot> {
  return await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_organization_identity_project_status_role_expires_at", (q) =>
        q
          .eq("organizationId", organizationId)
          .eq("identity", identity)
          .eq("projectId", projectId),
      )
      .order("desc")
      .first();
    if (membership === null) return { membership: null, authority: null };
    const authority = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", membership._id))
      .unique();
    return {
      membership: {
        ...(membership.expiresAt === undefined ? {} : { expiresAt: membership.expiresAt }),
        status: membership.status,
      },
      authority:
        authority === null
          ? null
          : {
            authorityUntil: authority.authorityUntil,
            ...(authority.expiresAt === undefined ? {} : { expiresAt: authority.expiresAt }),
          },
    };
  });
}

function openingArgs(key: string) {
  return {
    idempotencyKey: key,
    mode: "opening" as const,
    projectName: "Northside café",
    workspaceKind: "private" as const,
    region: "Netherlands",
    currency: "EUR",
    detailSummary: "Open a café on the Northside; rent a place and buy everything needed.",
  };
}

describe("P-01 intake boundary", () => {
  test("opening creates an owned workspace with minimal records and history", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const result = await asOwner.mutation(createWorkspaceRef, openingArgs("opening-1"));
    if (!result.ok) throw new Error(`intake failed: ${JSON.stringify(result)}`);
    expect(result.deduplicated).toBe(false);

    const role = await asOwner.query(myProjectRoleRef, {
      organizationId: result.organizationId,
      projectId: result.projectId,
    });
    expect(role).toMatchObject({ ok: true, role: "owner" });

    const view = await asOwner.query(getProjectionRef, { projectId: result.projectId, limit: 12 });
    if (!view.ok) throw new Error(`projection failed: ${JSON.stringify(view)}`);
    expect(view.project.name).toBe("Northside café");
    expect(view.project.location?.region).toBe("Netherlands");
    expect(view.requirements).toHaveLength(1);
    expect(view.requirements[0]?.key).toBe("opening-scope");
    expect(view.activity.page.map((entry) => entry.kind)).toContain("intake.created");
    expect(view.activity.page.map((entry) => entry.kind)).toContain("requirement.created");
  });

  test("quote comparison and equipment modes create their minimal records", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const quote = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "quote-1",
      mode: "quoteComparison",
      projectName: "Quote review",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Two-group espresso machine",
      detailCategory: "espresso",
    });
    if (!quote.ok) throw new Error(`quote intake failed: ${JSON.stringify(quote)}`);
    const quoteView = await asOwner.query(getProjectionRef, { projectId: quote.projectId, limit: 12 });
    if (!quoteView.ok) throw new Error(`quote projection failed: ${JSON.stringify(quoteView)}`);
    expect(quoteView.requirements[0]?.key).toBe("quote-comparison");
    expect(quoteView.requirements[0]?.title).toBe("Two-group espresso machine");

    const equipment = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "equipment-1",
      mode: "equipment",
      projectName: "Bar service",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Atlas grinder",
      detailSummary: "Grinder burrs need replacement.",
      urgency: "high",
    });
    if (!equipment.ok) throw new Error(`equipment intake failed: ${JSON.stringify(equipment)}`);
    const equipmentView = await asOwner.query(getProjectionRef, {
      projectId: equipment.projectId,
      limit: 12,
    });
    if (!equipmentView.ok) throw new Error(`equipment projection failed: ${JSON.stringify(equipmentView)}`);
    expect(equipmentView.requirements[0]?.key).toBe("equipment-case");
    expect(equipmentView.equipment.assets).toHaveLength(1);
    expect(equipmentView.equipment.assets[0]?.label).toBe("Atlas grinder");
    expect(equipmentView.equipment.assets[0]?.serviceCases).toHaveLength(1);
  });

  test("exact replay succeeds while a changed reuse of the key conflicts", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(createWorkspaceRef, openingArgs("replay-1"));
    if (!first.ok) throw new Error(`first intake failed: ${JSON.stringify(first)}`);
    const replay = await asOwner.mutation(createWorkspaceRef, openingArgs("replay-1"));
    if (!replay.ok) throw new Error(`replay failed: ${JSON.stringify(replay)}`);
    expect(replay.deduplicated).toBe(true);
    expect(replay.projectId).toBe(first.projectId);
    expect(replay.organizationId).toBe(first.organizationId);

    const conflict = await asOwner.mutation(createWorkspaceRef, {
      ...openingArgs("replay-1"),
      projectName: "Different café",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("changed key reuse must conflict");
    expect(conflict.code).toBe("duplicate-conflict");

    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects.filter((entry) => entry.name === "Different café")).toHaveLength(0);
  });

  test("same-key resubmission creates one workspace and reuses the organization", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(createWorkspaceRef, openingArgs("shared-1"));
    if (!first.ok) throw new Error(`first intake failed: ${JSON.stringify(first)}`);
    const second = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "shared-2",
      mode: "opening",
      projectName: "Second counter",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a second counter; rent a place and buy everything needed.",
    });
    if (!second.ok) throw new Error(`second intake failed: ${JSON.stringify(second)}`);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.projectId).not.toBe(first.projectId);

    const replay = await asOwner.mutation(createWorkspaceRef, openingArgs("shared-1"));
    if (!replay.ok) throw new Error(`replay failed: ${JSON.stringify(replay)}`);
    expect(replay.projectId).toBe(first.projectId);
    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects).toHaveLength(2);
  });

  test("guest and private kinds use separate organizations", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const guest = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "kind-guest",
      mode: "opening",
      projectName: "Guest counter",
      workspaceKind: "guest",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a guest counter; rent a place and buy everything needed.",
    });
    if (!guest.ok) throw new Error(`guest intake failed: ${JSON.stringify(guest)}`);
    const guestView = await asOwner.query(getProjectionRef, { projectId: guest.projectId, limit: 1 });
    if (!guestView.ok) throw new Error(`guest projection failed: ${JSON.stringify(guestView)}`);
    expect(guestView.project.visibility).toBe("open");

    const secondGuest = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "kind-guest-2",
      mode: "opening",
      projectName: "Guest counter two",
      workspaceKind: "guest",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a second guest counter; rent a place and buy everything needed.",
    });
    if (!secondGuest.ok) throw new Error(`second guest intake failed: ${JSON.stringify(secondGuest)}`);
    expect(secondGuest.organizationId).toBe(guest.organizationId);

    const privateResult = await asOwner.mutation(createWorkspaceRef, openingArgs("kind-private"));
    if (!privateResult.ok) throw new Error(`private intake failed: ${JSON.stringify(privateResult)}`);
    expect(privateResult.organizationId).not.toBe(guest.organizationId);
  });

  test("validation failure writes nothing", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const before = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!before.ok) throw new Error(`listing failed: ${JSON.stringify(before)}`);
    const denied = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "invalid-1",
      mode: "opening",
      projectName: "Broken café",
      workspaceKind: "private",
      currency: "EUR",
      detailSummary: "Open a broken café; rent a place and buy everything needed.",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("opening without a region must fail");
    expect(denied.code).toBe("invalid-payload");
    const after = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!after.ok) throw new Error(`listing failed: ${JSON.stringify(after)}`);
    expect(after.projects).toHaveLength(before.projects.length);

    const equipmentDenied = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "invalid-2",
      mode: "equipment",
      projectName: "Broken service",
      workspaceKind: "private",
      currency: "EUR",
      detailTitle: "Atlas grinder",
    });
    expect(equipmentDenied.ok).toBe(false);
    const afterEquipment = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!afterEquipment.ok) throw new Error(`listing failed: ${JSON.stringify(afterEquipment)}`);
    expect(afterEquipment.projects).toHaveLength(before.projects.length);
  });

  test("unauthenticated and cross-tenant calls deny without an existence oracle", async () => {
    const t = createKit();
    const anonymous = await t.mutation(createWorkspaceRef, openingArgs("anonymous-1"));
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) throw new Error("anonymous intake must fail");
    expect(anonymous.code).toBe("forged-identity");

    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createWorkspaceRef, openingArgs("tenant-1"));
    if (!created.ok) throw new Error(`intake failed: ${JSON.stringify(created)}`);

    const asOther = t.withIdentity(OTHER);
    const foreignRole = await asOther.query(myProjectRoleRef, {
      organizationId: created.organizationId,
      projectId: created.projectId,
    });
    expect(foreignRole.ok).toBe(false);
    if (foreignRole.ok) throw new Error("cross-tenant role must deny");
    expect(foreignRole.code).toBe("denied-membership");

    const foreignView = await asOther.query(getProjectionRef, { projectId: created.projectId, limit: 1 });
    expect(foreignView.ok).toBe(false);
    if (foreignView.ok) throw new Error("cross-tenant projection must deny");
    expect(foreignView.code).toBe("denied-membership");
  });
});

describe("F6 temporary organization reuse preserves the authority horizon", () => {
  test("temporary org ownership derives an equally temporary project grant that reactively expires", async () => {
    const clock = installControlledClock();
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const seeded = await seedOrgOwnerAuthority(t, OWNER.tokenIdentifier, "f6-temporary", ["temporary"]);
    const horizon = seeded.horizon;
    expect(Number.isFinite(horizon)).toBe(true);

    const result = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "f6-temporary-1",
      mode: "opening",
      projectName: "Temporary reuse",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a temporary reuse counter; rent a place and buy everything needed.",
    });
    if (!result.ok) throw new Error(`intake failed: ${JSON.stringify(result)}`);
    expect(result.deduplicated).toBe(false);
    expect(result.organizationId).toBe(seeded.organizationId);

    const grant = await readProjectGrant(t, seeded.organizationId, result.projectId, OWNER.tokenIdentifier);
    expect(grant.membership?.status).toBe("active");
    expect(grant.membership?.expiresAt).toBe(horizon);
    expect(grant.authority?.authorityUntil).toBe(horizon);
    expect(grant.authority?.expiresAt).toBe(horizon);

    const role = await asOwner.query(myProjectRoleRef, {
      organizationId: seeded.organizationId,
      projectId: result.projectId,
    });
    expect(role).toMatchObject({ ok: true, role: "owner" });

    const replay = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "f6-temporary-1",
      mode: "opening",
      projectName: "Temporary reuse",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a temporary reuse counter; rent a place and buy everything needed.",
    });
    if (!replay.ok) throw new Error(`replay failed: ${JSON.stringify(replay)}`);
    expect(replay.deduplicated).toBe(true);
    expect(replay.projectId).toBe(result.projectId);

    clock.advanceTo(horizon);
    await t.finishAllScheduledFunctions(() => clock.fireDueTimers());

    const expiredRole = await asOwner.query(myProjectRoleRef, {
      organizationId: seeded.organizationId,
      projectId: result.projectId,
    });
    expect(expiredRole.ok).toBe(false);
    if (expiredRole.ok) throw new Error("expired project authority must deny");
    // The scheduled invalidation revokes the membership row, so the
    // resolved denial reports the revocation.
    expect(expiredRole.code).toBe("revoked-membership");

    const expiredGrant = await readProjectGrant(t, seeded.organizationId, result.projectId, OWNER.tokenIdentifier);
    expect(expiredGrant.membership?.status).toBe("revoked");
    expect(expiredGrant.authority).toBeNull();

    const rerun = await asOwner.mutation(expireMembershipRef, {
      membershipId: (await t.run(async (ctx) => {
        const row = await ctx.db
          .query("memberships")
          .withIndex("by_organization_identity_project_status_role_expires_at", (q) =>
            q
              .eq("organizationId", seeded.organizationId)
              .eq("identity", OWNER.tokenIdentifier)
              .eq("projectId", result.projectId),
          )
          .order("desc")
          .first();
        if (row === null) throw new Error("membership disappeared");
        return row._id;
      })),
    });
    expect(rerun).toEqual({ ok: true, expired: false });

    const orgRows = await t.run(async (ctx) =>
      ctx.db
        .query("membershipAuthorities")
        .withIndex("by_organization_identity_scope_role_authority_until", (q) =>
          q
            .eq("organizationId", seeded.organizationId)
            .eq("identity", OWNER.tokenIdentifier)
            .eq("scopeKey", membershipScopeKey(undefined))
            .eq("role", "owner"),
        )
        .collect(),
    );
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]?.authorityUntil).toBe(horizon);
  });

  test("coexistence with stronger permanent authority stays permanent and wins reuse", async () => {
    const clock = installControlledClock();
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const sameOrg = await seedOrgOwnerAuthority(t, OWNER.tokenIdentifier, "f6-coexist", ["temporary", "permanent"]);
    const temporaryElsewhere = await seedOrgOwnerAuthority(t, OWNER.tokenIdentifier, "f6-temporary-only", ["temporary"]);

    const result = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "f6-coexist-1",
      mode: "opening",
      projectName: "Permanent coexistence",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a permanent coexistence counter; rent a place and buy everything needed.",
    });
    if (!result.ok) throw new Error(`intake failed: ${JSON.stringify(result)}`);
    // The strongest horizon is permanent, so the reuse is permanent even
    // though a temporary owner row also exists, and the permanent
    // organization wins reuse over a temporary-only organization.
    expect(result.organizationId).toBe(sameOrg.organizationId);
    const grant = await readProjectGrant(t, sameOrg.organizationId, result.projectId, OWNER.tokenIdentifier);
    expect(grant.membership?.status).toBe("active");
    expect(grant.membership?.expiresAt).toBeUndefined();
    expect(grant.authority?.authorityUntil).toBe(PERMANENT_AUTHORITY_UNTIL);
    expect(grant.authority?.expiresAt).toBeUndefined();

    const second = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "f6-coexist-2",
      mode: "opening",
      projectName: "Permanent org wins",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open a permanent org counter; rent a place and buy everything needed.",
    });
    if (!second.ok) throw new Error(`second intake failed: ${JSON.stringify(second)}`);
    expect(second.organizationId).toBe(sameOrg.organizationId);
    expect(second.organizationId).not.toBe(temporaryElsewhere.organizationId);

    clock.advanceTo(Date.now() + 10_000_000);
    await t.finishAllScheduledFunctions(() => clock.fireDueTimers());
    const role = await asOwner.query(myProjectRoleRef, {
      organizationId: sameOrg.organizationId,
      projectId: result.projectId,
    });
    expect(role).toMatchObject({ ok: true, role: "owner" });
  });

  test("another tenant without authority creates its own organization", async () => {
    const t = createKit();
    const seeded = await seedOrgOwnerAuthority(t, OWNER.tokenIdentifier, "f6-tenant", ["temporary"]);
    const asOther = t.withIdentity(OTHER);
    const result = await asOther.mutation(createWorkspaceRef, {
      idempotencyKey: "f6-tenant-1",
      mode: "opening",
      projectName: "Other tenant workspace",
      workspaceKind: "private",
      region: "Netherlands",
      currency: "EUR",
      detailSummary: "Open another tenant workspace; rent a place and buy everything needed.",
    });
    if (!result.ok) throw new Error(`other tenant intake failed: ${JSON.stringify(result)}`);
    expect(result.organizationId).not.toBe(seeded.organizationId);
    expect(result.deduplicated).toBe(false);
  });
});

describe("opening brief persistence (live browser defect)", () => {
  const LIVE_SUMMARY =
    "Open a coffee shop in San Francisco; rent a place and buy everything needed for the coffee shop; budget USD 250,000-500,000.";
  const LIVE_TITLE = "San Francisco coffee shop real estate and equipment";
  const LIVE_CATEGORY = "coffee shop opening";
  const LIVE_REGION = "San Francisco, CA";

  function liveOpeningArgs(key: string) {
    return {
      idempotencyKey: key,
      mode: "opening" as const,
      projectName: "San Francisco Coffee Shop Opening",
      workspaceKind: "private" as const,
      region: LIVE_REGION,
      currency: "USD",
      budgetMinorUnits: 50_000_000,
      detailTitle: LIVE_TITLE,
      detailCategory: LIVE_CATEGORY,
      detailSummary: LIVE_SUMMARY,
    };
  }

  test("opening persists the exact brief, title, category, region, and budget", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const result = await asOwner.mutation(createWorkspaceRef, liveOpeningArgs("live-opening-1"));
    if (!result.ok) throw new Error(`live opening intake failed: ${JSON.stringify(result)}`);
    expect(result.deduplicated).toBe(false);

    const stored = await t.run(async (ctx) => {
      const requirements = await ctx.db
        .query("requirements")
        .withIndex("by_organization_and_project", (q) =>
          q.eq("organizationId", result.organizationId).eq("projectId", result.projectId),
        )
        .collect();
      const project = await ctx.db.get(result.projectId);
      return { requirements, project };
    });
    expect(stored.requirements).toHaveLength(1);
    const requirement = stored.requirements[0];
    expect(requirement?.key).toBe("opening-scope");
    expect(requirement?.title).toBe(LIVE_TITLE);
    expect(requirement?.category).toBe(LIVE_CATEGORY);
    expect(requirement?.hardConstraints).toBe(
      `Primary region: ${LIVE_REGION}\nOpening brief: ${LIVE_SUMMARY}`,
    );
    expect(requirement?.budgetMinorUnits).toBe(50_000_000);
    expect(requirement?.currency).toBe("USD");
    expect(stored.project?.currency).toBe("USD");
    expect(stored.project?.budgetMinorUnits).toBe(50_000_000);
  });

  test("opening trims the brief and falls back only when title/category are absent", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const result = await asOwner.mutation(createWorkspaceRef, {
      idempotencyKey: "live-opening-trim-1",
      mode: "opening",
      projectName: "San Francisco Coffee Shop Opening",
      workspaceKind: "private",
      region: LIVE_REGION,
      currency: "USD",
      budgetMinorUnits: 50_000_000,
      detailSummary: `  ${LIVE_SUMMARY}  `,
    });
    if (!result.ok) throw new Error(`trimmed opening intake failed: ${JSON.stringify(result)}`);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("requirements")
        .withIndex("by_organization_and_project", (q) =>
          q.eq("organizationId", result.organizationId).eq("projectId", result.projectId),
        )
        .collect(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.title).toBe("Opening purchasing scope");
    expect(stored[0]?.category).toBe("equipment");
    expect(stored[0]?.hardConstraints).toBe(
      `Primary region: ${LIVE_REGION}\nOpening brief: ${LIVE_SUMMARY}`,
    );
  });

  test("missing, empty, and whitespace opening briefs deny with zero writes", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const before = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!before.ok) throw new Error(`listing failed: ${JSON.stringify(before)}`);
    const base = liveOpeningArgs("live-opening-missing-1");
    const { detailSummary: _omitted, ...withoutBrief } = base;
    void _omitted;
    const attempts = [
      { key: "live-opening-missing-1", args: withoutBrief },
      { key: "live-opening-empty-1", args: { ...base, idempotencyKey: "live-opening-empty-1", detailSummary: "" } },
      { key: "live-opening-blank-1", args: { ...base, idempotencyKey: "live-opening-blank-1", detailSummary: "   " } },
    ];
    for (const attempt of attempts) {
      const denied = await asOwner.mutation(createWorkspaceRef, attempt.args);
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error(`brief-less opening must fail: ${attempt.key}`);
      expect(denied.code).toBe("invalid-payload");
    }
    const after = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!after.ok) throw new Error(`listing failed: ${JSON.stringify(after)}`);
    expect(after.projects).toHaveLength(before.projects.length);
  });
});

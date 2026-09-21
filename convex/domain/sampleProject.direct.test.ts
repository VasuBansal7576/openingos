/// <reference types="vite/client" />
/**
 * E15 controlled sample guest project boundary (PRD 11 evaluator path,
 * P-16, H-06).
 *
 * One atomic, idempotent Convex boundary derives identity from auth,
 * creates one fresh isolated guest organization plus one EUR sample
 * cafe project per bounded idempotency key, and seeds the controlled
 * Northside dataset transactionally: EUR 7,950 included versus EUR
 * 8,500 itemized with the exact EUR 550 difference through the existing
 * quote semantics, an incomplete third offer that is never ranked, an
 * incompatible variant, a suitable vendor with an unpublished price,
 * and labeled installed equipment. Every illustrative vendor, evidence
 * row, and quote is controlled, non-live, and owner-stand-in/fixture
 * where the schema supports it. Zero jobs, operations, grants,
 * approvals, reservations, conversations, recipient configs, provider
 * IDs, email sends, or external effects are created.
 */

import { makeFunctionReference, type RegisteredMutation, type RegisteredQuery } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as sampleProject from "./sampleProject.js";
import * as projection from "../workbench/projection.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "./**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "../workbench/**/*.ts",
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

type TestKit = ReturnType<typeof createKit>;

const createSampleRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sampleProject.createSampleGuestProject>,
  MutationReturn<typeof sampleProject.createSampleGuestProject>
>("domain/sampleProject:createSampleGuestProject");
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

const OWNER = { tokenIdentifier: "sample-owner" };
const OTHER = { tokenIdentifier: "sample-other" };

/**
 * Controlled clock for the scheduled-expiry regression: the sample
 * boundary schedules the shared idempotent membership-expiry
 * transition, and convex-test reads `globalThis.setTimeout` at
 * scheduling time, so the replacement below is observed end to end.
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

  pendingTimerCount(): number {
    return this.timers.size;
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

async function countWorkspaceRows(t: TestKit) {
  return await t.run(async (ctx) => ({
    organizations: (await ctx.db.query("organizations").collect()).length,
    projects: (await ctx.db.query("projects").collect()).length,
    memberships: (await ctx.db.query("memberships").collect()).length,
    membershipAuthorities: (await ctx.db.query("membershipAuthorities").collect()).length,
    sampleProjectRequests: (await ctx.db.query("sampleProjectRequests").collect()).length,
    locations: (await ctx.db.query("locations").collect()).length,
    requirements: (await ctx.db.query("requirements").collect()).length,
    vendors: (await ctx.db.query("vendors").collect()).length,
    candidates: (await ctx.db.query("candidates").collect()).length,
    quotes: (await ctx.db.query("quotes").collect()).length,
    assets: (await ctx.db.query("assets").collect()).length,
  }));
}

async function countForbiddenRows(
  t: TestKit,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
) {
  return await t.run(async (ctx) => {
    const inProject = async (table: "jobs" | "approvals" | "conversations" | "selections" | "orders" | "costEntries" | "rfqs" | "negotiations" | "serviceCases" | "watches") =>
      (
        await ctx.db
          .query(table)
          .withIndex("by_project", (q) => q.eq("projectId", projectId))
          .collect()
      ).filter((row) => row.organizationId === organizationId).length;
    return {
      jobs: await inProject("jobs"),
      grants: (await ctx.db.query("grants").collect()).filter(
        (row) => row.organizationId === organizationId && row.projectId === projectId,
      ).length,
      approvals: await inProject("approvals"),
      reservations: (await ctx.db.query("reservations").collect()).filter(
        (row) => row.organizationId === organizationId,
      ).length,
      conversations: await inProject("conversations"),
      selections: await inProject("selections"),
      orders: await inProject("orders"),
      costEntries: await inProject("costEntries"),
      rfqs: await inProject("rfqs"),
      negotiations: await inProject("negotiations"),
      serviceCases: await inProject("serviceCases"),
      watches: await inProject("watches"),
      operations: (await ctx.db.query("operations").collect()).filter(
        (row) => row.organizationId === organizationId && row.projectId === projectId,
      ).length,
      attempts: (await ctx.db.query("attempts").collect()).length,
      recipientConfigs: (await ctx.db.query("recipientConfigs").collect()).length,
      outboundSnapshots: (await ctx.db.query("outboundSnapshots").collect()).filter(
        (row) => row.organizationId === organizationId && row.projectId === projectId,
      ).length,
      processedEvents: (await ctx.db.query("processedEvents").collect()).length,
      evidence: (await ctx.db.query("evidence").collect()).filter(
        (row) => row.organizationId === organizationId && row.projectId === projectId,
      ).length,
      vendorContacts: (await ctx.db.query("vendorContacts").collect()).filter(
        (row) => row.organizationId === organizationId,
      ).length,
    };
  });
}

async function readMemberships(
  t: TestKit,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  identity: string,
) {
  return await t.run(async (ctx) => {
    // by_organization_and_identity matches both org-scoped and
    // project-scoped rows, so the org membership is selected by its
    // exact shape (projectId === undefined) rather than unique().
    const orgCandidates = await ctx.db
      .query("memberships")
      .withIndex("by_organization_and_identity", (q) =>
        q.eq("organizationId", organizationId).eq("identity", identity),
      )
      .collect();
    const orgScoped = orgCandidates.filter((row) => row.projectId === undefined);
    const orgMembership = orgScoped[0] ?? null;
    const projectMembership = await ctx.db
      .query("memberships")
      .withIndex("by_project_and_identity", (q) =>
        q.eq("projectId", projectId).eq("identity", identity),
      )
      .unique();
    const authorityOf = async (membershipId: Id<"memberships"> | undefined) => {
      if (membershipId === undefined) return null;
      return await ctx.db
        .query("membershipAuthorities")
        .withIndex("by_membership", (q) => q.eq("membershipId", membershipId))
        .unique();
    };
    return {
      orgMembership,
      projectMembership,
      orgScopedCount: orgScoped.length,
      orgAuthority: await authorityOf(orgMembership?._id),
      projectAuthority: await authorityOf(projectMembership?._id),
    };
  });
}

describe("E15 sample guest project boundary", () => {
  test("unauthenticated creation denies with zero writes", async () => {
    const t = createKit();
    const before = await countWorkspaceRows(t);
    const denied = await t.mutation(createSampleRef, { idempotencyKey: "sample-anon-1" });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("anonymous sample creation must fail");
    expect(denied.code).toBe("forged-identity");
    expect(await countWorkspaceRows(t)).toEqual(before);
  });

  test("blank and overlong keys deny with zero writes", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const before = await countWorkspaceRows(t);
    const blank = await asOwner.mutation(createSampleRef, { idempotencyKey: "   " });
    expect(blank.ok).toBe(false);
    if (blank.ok) throw new Error("blank key must fail");
    expect(blank.code).toBe("invalid-payload");
    const overlong = await asOwner.mutation(createSampleRef, { idempotencyKey: `k${"x".repeat(128)}` });
    expect(overlong.ok).toBe(false);
    if (overlong.ok) throw new Error("overlong key must fail");
    expect(overlong.code).toBe("invalid-payload");
    expect(await countWorkspaceRows(t)).toEqual(before);
  });

  test("exact replay returns the same project while distinct keys create distinct workspaces", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const first = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-replay-1" });
    if (!first.ok) throw new Error(`sample creation failed: ${JSON.stringify(first)}`);
    expect(first.deduplicated).toBe(false);

    const rowsAfterFirst = await countWorkspaceRows(t);
    const replay = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-replay-1" });
    if (!replay.ok) throw new Error(`sample replay failed: ${JSON.stringify(replay)}`);
    expect(replay.deduplicated).toBe(true);
    expect(replay.projectId).toBe(first.projectId);
    expect(replay.organizationId).toBe(first.organizationId);
    expect(await countWorkspaceRows(t)).toEqual(rowsAfterFirst);

    const second = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-replay-2" });
    if (!second.ok) throw new Error(`second sample creation failed: ${JSON.stringify(second)}`);
    expect(second.deduplicated).toBe(false);
    expect(second.projectId).not.toBe(first.projectId);
    expect(second.organizationId).not.toBe(first.organizationId);

    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects.map((entry) => entry.id).sort()).toEqual(
      [first.projectId, second.projectId].sort(),
    );
    for (const entry of listed.projects) {
      expect(entry.sampleKind).toBe("controlledSample");
      expect(entry.sampleLabel).toBe("Controlled sample data");
    }
  });

  test("a second identity cannot read the sample project", async () => {
    const t = createKit();
    const created = await t.withIdentity(OWNER).mutation(createSampleRef, {
      idempotencyKey: "sample-isolation-1",
    });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);

    const denied = await t.withIdentity(OTHER).query(getProjectionRef, {
      projectId: created.projectId,
      limit: 1,
    });
    expect(denied).toEqual({
      ok: false,
      code: "denied-membership",
      message: "not authorized for this project",
    });

    const otherList = await t.withIdentity(OTHER).query(listProjectsRef, { limit: 10 });
    if (!otherList.ok) throw new Error(`other listing failed: ${JSON.stringify(otherList)}`);
    expect(otherList.projects.map((entry) => entry.id)).not.toContain(created.projectId);

    const ownerView = await t.withIdentity(OWNER).query(getProjectionRef, {
      projectId: created.projectId,
      limit: 1,
    });
    expect(ownerView.ok).toBe(true);
  });

  test("guest memberships carry a finite horizon and expire through the scheduled transition", async () => {
    const clock = installControlledClock();
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-expiry-1" });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);

    // Both fresh owner memberships schedule the established expiry
    // transition in the same transaction that grants them.
    expect(clock.pendingTimerCount()).toBe(2);

    const before = await readMemberships(t, created.organizationId, created.projectId, OWNER.tokenIdentifier);
    // Exactly one org-scoped row and one project-scoped row exist.
    expect(before.orgScopedCount).toBe(1);
    expect(before.orgMembership?.projectId).toBeUndefined();
    expect(before.projectMembership?.projectId).toBe(created.projectId);
    for (const membership of [before.orgMembership, before.projectMembership]) {
      expect(membership?.status).toBe("active");
      expect(membership?.role).toBe("owner");
      expect(membership?.expiresAt).toBeDefined();
      expect(Number.isSafeInteger(membership?.expiresAt)).toBe(true);
      expect(Number.isFinite(membership?.expiresAt)).toBe(true);
      expect(membership?.expiresAt).not.toBe(Number.MAX_VALUE);
    }
    for (const authority of [before.orgAuthority, before.projectAuthority]) {
      expect(authority).not.toBeNull();
      expect(Number.isSafeInteger(authority?.authorityUntil)).toBe(true);
      expect(Number.isFinite(authority?.authorityUntil)).toBe(true);
      expect(authority?.authorityUntil).not.toBe(Number.MAX_VALUE);
    }
    const horizon = before.projectMembership?.expiresAt;
    if (horizon === undefined) throw new Error("project membership horizon missing");
    expect(before.orgMembership?.expiresAt).toBe(horizon);

    const visible = await asOwner.query(getProjectionRef, { projectId: created.projectId, limit: 1 });
    expect(visible.ok).toBe(true);

    clock.advanceTo(horizon);
    await t.finishAllScheduledFunctions(() => clock.fireDueTimers());

    const after = await readMemberships(t, created.organizationId, created.projectId, OWNER.tokenIdentifier);
    expect(after.orgMembership?.status).toBe("revoked");
    expect(after.projectMembership?.status).toBe("revoked");
    expect(after.orgAuthority).toBeNull();
    expect(after.projectAuthority).toBeNull();

    const denied = await asOwner.query(getProjectionRef, { projectId: created.projectId, limit: 1 });
    expect(denied).toEqual({
      ok: false,
      code: "denied-membership",
      message: "not authorized for this project",
    });
    const listed = await asOwner.query(listProjectsRef, { limit: 10 });
    if (!listed.ok) throw new Error(`listing failed: ${JSON.stringify(listed)}`);
    expect(listed.projects.map((entry) => entry.id)).not.toContain(created.projectId);
  });

  test("seeds the exact EUR 7,950 versus EUR 8,500 comparison with an exact EUR 550 difference", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-totals-1" });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);

    const organization = await t.run(async (ctx) => ctx.db.get(created.organizationId));
    expect(organization?.kind).toBe("guest");

    const view = await asOwner.query(getProjectionRef, { projectId: created.projectId, limit: 12 });
    if (!view.ok) throw new Error(`projection failed: ${JSON.stringify(view)}`);
    expect(view.project.currency).toBe("EUR");
    expect(view.project.visibility).toBe("open");
    expect(view.project.sampleKind).toBe("controlledSample");
    expect(view.project.sampleLabel).toBe("Controlled sample data");
    expect(view.project.location?.region).toBe("Netherlands");
    expect(view.requirements).toHaveLength(1);
    expect(view.requirements[0]?.key).toBe("northside-espresso");

    const byVendor = (suffix: string) =>
      view.candidates.find((candidate) => candidate.vendor?.name.includes(`Vendor ${suffix}`));
    const offerA = byVendor("A");
    const offerB = byVendor("B");
    if (offerA === undefined || offerB === undefined) throw new Error("sample offers A/B missing");
    expect(offerA.latestValidQuote?.currency).toBe("EUR");
    expect(offerA.latestValidQuote?.totalMinorUnits).toBe(795000);
    expect(offerA.latestValidQuote?.comparableTotalMinorUnits).toBe(795000);
    expect(offerB.latestValidQuote?.totalMinorUnits).toBe(850000);
    expect(offerB.latestValidQuote?.comparableTotalMinorUnits).toBe(850000);

    const verdict = offerA.comparisons.find((entry) => entry.againstCandidateId === offerB.id);
    expect(verdict?.status).toBe("comparable");
    expect(verdict?.reason).toBe("equivalent-scope");
    expect(verdict?.differenceMinorUnits).toBe(55000);
    expect(verdict?.cheaper).toBe("self");
    expect(verdict?.estimatedDeltaMinorUnits).toBeNull();
    const mirror = offerB.comparisons.find((entry) => entry.againstCandidateId === offerA.id);
    expect(mirror?.status).toBe("comparable");
    expect(mirror?.differenceMinorUnits).toBe(55000);
    expect(mirror?.cheaper).toBe("other");
  });

  test("keeps the incomplete offer unranked, the variant incompatible, and the unpublished price empty", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-rows-1" });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);
    const view = await asOwner.query(getProjectionRef, { projectId: created.projectId, limit: 12 });
    if (!view.ok) throw new Error(`projection failed: ${JSON.stringify(view)}`);

    const byVendor = (suffix: string) =>
      view.candidates.find((candidate) => candidate.vendor?.name.includes(`Vendor ${suffix}`));
    const offerA = byVendor("A");
    const offerC = byVendor("C");
    const offerD = byVendor("D");
    const offerE = byVendor("E");
    if (offerA === undefined || offerC === undefined || offerD === undefined || offerE === undefined) {
      throw new Error("sample offers C/D/E missing");
    }

    // Incomplete third offer: visible with null totals, never comparable.
    expect(offerC.latestValidQuote).not.toBeNull();
    expect(offerC.latestValidQuote?.totalMinorUnits).toBeNull();
    expect(offerC.latestValidQuote?.comparableTotalMinorUnits).toBeNull();
    expect(offerC.comparisons.length).toBeGreaterThan(0);
    for (const entry of offerC.comparisons) {
      expect(entry.status).not.toBe("comparable");
      expect(entry.differenceMinorUnits).toBeNull();
      expect(entry.cheaper).toBeNull();
    }
    const incompleteVerdict = offerC.comparisons.find(
      (entry) => entry.againstCandidateId === offerA.id,
    );
    expect(incompleteVerdict?.status).toBe("incomplete");

    // Incompatible variant: exact own total, fail finding, no delta.
    expect(offerD.compatibility).toBe("fail");
    expect(offerD.variant).toContain("380V");
    expect(offerD.latestValidQuote?.totalMinorUnits).toBe(820000);
    const incompatibleVerdict = offerD.comparisons.find(
      (entry) => entry.againstCandidateId === offerA.id,
    );
    expect(incompatibleVerdict?.status).toBe("incompatible");
    expect(incompatibleVerdict?.reason).toContain("comparison scopes are not compatible");
    expect(incompatibleVerdict?.differenceMinorUnits).toBeNull();
    expect(incompatibleVerdict?.cheaper).toBeNull();

    // Suitable vendor with an unpublished price: no quote, no verdicts.
    expect(offerE.compatibility).toBe("pass");
    expect(offerE.latestValidQuote).toBeNull();
    expect(offerE.comparisons).toEqual([]);
    expect(offerE.vendor?.name).toContain("Vendor E");
  });

  test("labels every illustrative row controlled and projects the sample equipment", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-labels-1" });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);
    const view = await asOwner.query(getProjectionRef, { projectId: created.projectId, limit: 12 });
    if (!view.ok) throw new Error(`projection failed: ${JSON.stringify(view)}`);

    expect(view.candidates).toHaveLength(5);
    for (const candidate of view.candidates) {
      expect(candidate.provenance).toMatchObject({
        mode: "fixture",
        label: "Controlled demo quote",
        ownerAuthoredTerms: true,
      });
      expect(candidate.vendor?.name).toContain("(controlled demo)");
      const quote = candidate.latestValidQuote;
      if (quote !== null) {
        expect(quote.currency).toBe("EUR");
        expect(quote.provenance).toMatchObject({
          mode: "fixture",
          label: "Controlled demo quote",
          ownerAuthoredTerms: true,
        });
      }
    }
    expect(view.provenance).toMatchObject({
      mode: "fixture",
      label: "Controlled demo quote",
      ownerAuthoredTerms: true,
    });

    const stored = await t.run(async (ctx) => ({
      quotes: await ctx.db.query("quotes").collect(),
      evidence: await ctx.db.query("productEvidence").collect(),
    }));
    for (const quote of stored.quotes) {
      expect(quote.counterpartyRole).toBe("ownerStandIn");
      expect(quote.executionMode).toBe("fixture");
    }
    expect(stored.evidence.length).toBeGreaterThan(0);
    for (const row of stored.evidence) {
      expect(row.counterpartyRole).toBe("ownerStandIn");
      expect(row.executionMode).toBe("fixture");
    }

    expect(view.equipment.assets).toHaveLength(1);
    const asset = view.equipment.assets[0];
    expect(asset?.label).toContain("(controlled demo)");
    expect(asset?.purchaseProvenance).toBe("controlled sample record");
    expect(asset?.documents.map((document) => document.kind)).toEqual(["purchase", "warranty"]);
    for (const document of asset?.documents ?? []) {
      expect(Object.keys(document).sort()).toEqual(["createdAt", "kind"]);
    }
    expect(asset?.serviceCases).toEqual([]);

    const serialized = JSON.stringify(view);
    expect(serialized).toContain("Controlled sample data");
    expect(serialized).toContain("Controlled demo quote");
    expect(serialized).not.toContain("Live email");
    expect(serialized).not.toContain("Live vendor");
  });

  test("creates zero forbidden effect rows", async () => {
    const t = createKit();
    const asOwner = t.withIdentity(OWNER);
    const created = await asOwner.mutation(createSampleRef, { idempotencyKey: "sample-clean-1" });
    if (!created.ok) throw new Error(`sample creation failed: ${JSON.stringify(created)}`);
    const counts = await countForbiddenRows(t, created.organizationId, created.projectId);
    expect(counts).toEqual({
      jobs: 0,
      grants: 0,
      approvals: 0,
      reservations: 0,
      conversations: 0,
      selections: 0,
      orders: 0,
      costEntries: 0,
      rfqs: 0,
      negotiations: 0,
      serviceCases: 0,
      watches: 0,
      operations: 0,
      attempts: 0,
      recipientConfigs: 0,
      outboundSnapshots: 0,
      processedEvents: 0,
      evidence: 0,
      vendorContacts: 0,
    });
  });
});

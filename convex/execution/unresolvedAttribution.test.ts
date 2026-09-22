/**
 * F1 per-reservation unresolved attribution regression tests (Astra
 * findings 2 and 3 on the allowance follow-up line).
 *
 * The deployment aggregate carries TWO exposure legs — reserved and
 * unresolved — and every mutation must move only the acting reservation's
 * own attributed exposure on each leg:
 *
 * - An org A reconciliation read funded from A's unresolved exposure must
 *   never spend org B's global unresolved exposure (cross-org theft).
 * - `settleServerRead` must mirror the exact retained/released split
 *   globally, including `readsUsed=0` (which releases everything and
 *   retains nothing), and every denial must precede all writes.
 * - Valid pre-global legacy rows keep their age-based attribution without
 *   inferring ownership from the aggregate balance.
 *
 * Controlled convex-test boundaries only; every reservation and accounting
 * row here is synthetic and no test performs a provider call of any kind.
 */

import { convexTest, type TestConvex } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import { describe, expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import * as attempts from "./attempts.js";
import * as reservations from "./reservations.js";
import { canonicalJson, payloadHash } from "../shared/hashing.js";
import { reconciliationPricingBasis } from "../communication/contracts.js";

const modules = {
  "./_generated/server.js": async () => await import("../_generated/server.js"),
  "./access/checks.ts": async () => await import("../access/checks.js"),
  "./access/memberships.ts": async () => await import("../access/memberships.js"),
  "./access/grants.ts": async () => await import("../access/grants.js"),
  "./communication/contracts.ts": async () => await import("../communication/contracts.js"),
  "./execution/attempts.ts": async () => await import("./attempts.js"),
  "./execution/jobs.ts": async () => await import("./jobs.js"),
  "./execution/operations.ts": async () => await import("./operations.js"),
  "./execution/reservations.ts": async () => await import("./reservations.js"),
  "./shared/scope.ts": async () => await import("../shared/scope.js"),
  "./shared/hashing.ts": async () => await import("../shared/hashing.js"),
  "./shared/sha256.ts": async () => await import("../shared/sha256.js"),
  "./shared/time.ts": async () => await import("../shared/time.js"),
  "./shared/denials.ts": async () => await import("../shared/denials.js"),
  "./shared/provenance.ts": async () => await import("../shared/provenance.js"),
  "./shared/mailbox.ts": async () => await import("../shared/mailbox.js"),
  "./server.ts": async () => await import("../server.js"),
} satisfies Record<string, () => Promise<unknown>>;

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;

const reconcileAfterCrashRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.reconcileAfterCrash>,
  MutationReturn<typeof attempts.reconcileAfterCrash>
>("execution/attempts:reconcileAfterCrash");

const settleServerReadRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.settleServerRead>,
  MutationReturn<typeof reservations.settleServerRead>
>("execution/reservations:settleServerRead");

const READ_COST_MICRO_USD = 7;
const READ_BASIS = reconciliationPricingBasis(READ_COST_MICRO_USD);
const GLOBAL_KEY = "firecrawl-shared-global-v1";

const DRAFT = {
  profile: "ownerRoleplay",
  to: "owner@example.test",
  cc: [],
  bcc: [],
  subject: "Controlled RFQ",
  body: "Please confirm the controlled terms.",
};
const CANONICAL_DRAFT = canonicalJson(DRAFT);

interface OrgScope {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
}

async function createScope(t: TestConvex<typeof schema>, name: string): Promise<OrgScope> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name,
      kind: "private",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: `${name} project`,
      visibility: "open",
      createdAt: now,
    });
    const grantId = await ctx.db.insert("grants", {
      organizationId,
      projectId,
      operations: ["communication.send"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 1,
      inputVersions: { brief: "v1" },
      canonicalPayload: CANONICAL_DRAFT,
      payloadHash: payloadHash(DRAFT),
      costCeilingMicroUsd: 100_000,
      roundLimit: 8,
      expiresAt: now + 60 * 60 * 1000,
      revocationVersion: 1,
      status: "active",
      createdAt: now,
    });
    const jobId = await ctx.db.insert("jobs", {
      organizationId,
      projectId,
      grantId,
      grantVersion: 1,
      kind: "communication",
      state: "running",
      inputVersions: { brief: "v1" },
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, projectId, grantId, jobId };
  });
}

async function insertBudget(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  balances: { reserved: number; spent: number; unresolved: number; ceiling?: number },
): Promise<Id<"providerBudgets">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("providerBudgets", {
      organizationId,
      ceilingMicroUsd: balances.ceiling ?? 100_000,
      reservedMicroUsd: balances.reserved,
      spentMicroUsd: balances.spent,
      unresolvedMicroUsd: balances.unresolved,
      pricingBasis: "controlled-unresolved-attribution",
      updatedAt: Date.now(),
    }),
  );
}

async function insertGlobal(
  t: TestConvex<typeof schema>,
  balances: { reserved: number; spent: number; unresolved: number; ceiling?: number },
): Promise<Id<"deploymentAllowances">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("deploymentAllowances", {
      key: GLOBAL_KEY,
      ceilingMicroUsd: balances.ceiling ?? 100_000,
      reservedMicroUsd: balances.reserved,
      spentMicroUsd: balances.spent,
      unresolvedMicroUsd: balances.unresolved,
      pricingBasis: "controlled-unresolved-attribution",
      updatedAt: Date.now(),
    }),
  );
}

async function globalCreationTime(
  t: TestConvex<typeof schema>,
  globalId: Id<"deploymentAllowances">,
): Promise<number> {
  const row = await t.run(async (ctx) => ctx.db.get(globalId));
  if (row === null) throw new Error("global row missing");
  return row._creationTime;
}

/** Busy-wait so a later insert is strictly post-global (unbound by age). */
async function waitPastGlobalCreation(t: TestConvex<typeof schema>, globalId: Id<"deploymentAllowances">) {
  const createdAt = await globalCreationTime(t, globalId);
  const deadline = Date.now() + 5000;
  while (Date.now() <= createdAt) {
    if (Date.now() > deadline) throw new Error("test clock did not advance past global creation");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function insertReservation(
  t: TestConvex<typeof schema>,
  scope: OrgScope,
  budgetId: Id<"providerBudgets">,
  balances: { reserved: number; spent: number; unresolved: number },
  markers?: { reserved?: number; unresolved?: number },
): Promise<Id<"reservations">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("reservations", {
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      budgetId,
      ceilingMicroUsd: 100_000,
      reservedMicroUsd: balances.reserved,
      spentMicroUsd: balances.spent,
      unresolvedMicroUsd: balances.unresolved,
      pricingBasis: READ_BASIS,
      state: "open",
      updatedAt: Date.now(),
      ...(markers?.reserved === undefined ? {} : { globalReservedMicroUsd: markers.reserved }),
      ...(markers?.unresolved === undefined ? {} : { globalUnresolvedMicroUsd: markers.unresolved }),
    }),
  );
}

async function insertDispatchingOperation(
  t: TestConvex<typeof schema>,
  scope: OrgScope,
  reservationId: Id<"reservations">,
  suffix: string,
  attemptToken: string,
): Promise<Id<"operations">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const operationId = await ctx.db.insert("operations", {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      jobId: scope.jobId,
      kind: "communication.send",
      requestId: `unresolved-attr-${suffix}`,
      requestKey: `unresolved-attr-key-${suffix}-${now}`,
      normalizedPayload: CANONICAL_DRAFT,
      normalizedPayloadHash: payloadHash(DRAFT),
      inputVersions: { brief: "v1" },
      grantId: scope.grantId,
      grantVersion: 1,
      state: "dispatching",
      attemptToken,
      reservationId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("outboundSnapshots", {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      operationId,
      grantId: scope.grantId,
      to: "owner@example.test",
      cc: [],
      bcc: [],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 1,
      payloadHash: payloadHash(DRAFT),
      bodyHash: payloadHash(DRAFT.body),
      counterpartyRole: "ownerStandIn",
      createdAt: now,
    });
    return operationId;
  });
}

interface LedgerSnapshot {
  readonly budget: { reserved: number; spent: number; unresolved: number } | null;
  readonly reservation: {
    reserved: number;
    spent: number;
    unresolved: number;
    reservedMarker: number | null;
    unresolvedMarker: number | null;
    state: string;
  } | null;
  readonly global: { reserved: number; spent: number; unresolved: number } | null;
  readonly attempts: number;
}

async function snapshot(
  t: TestConvex<typeof schema>,
  budgetId: Id<"providerBudgets">,
  reservationId: Id<"reservations">,
  globalId: Id<"deploymentAllowances"> | null,
): Promise<LedgerSnapshot> {
  return await t.run(async (ctx) => {
    const budget = await ctx.db.get(budgetId);
    const reservation = await ctx.db.get(reservationId);
    const global = globalId === null ? null : await ctx.db.get(globalId);
    return {
      budget:
        budget === null
          ? null
          : {
            reserved: budget.reservedMicroUsd,
            spent: budget.spentMicroUsd,
            unresolved: budget.unresolvedMicroUsd,
          },
      reservation:
        reservation === null
          ? null
          : {
            reserved: reservation.reservedMicroUsd,
            spent: reservation.spentMicroUsd,
            unresolved: reservation.unresolvedMicroUsd,
            reservedMarker: reservation.globalReservedMicroUsd ?? null,
            unresolvedMarker: reservation.globalUnresolvedMicroUsd ?? null,
            state: reservation.state,
          },
      global:
        global === null
          ? null
          : {
            reserved: global.reservedMicroUsd,
            spent: global.spentMicroUsd,
            unresolved: global.unresolvedMicroUsd,
          },
      attempts: (await ctx.db.query("attempts").take(32)).length,
    };
  });
}

describe("unresolved attribution across the deployment aggregate", () => {
  test("an org A read funded from unresolved exposure cannot spend org B global unresolved exposure", async () => {
    const t = convexTest(schema, modules);
    // The aggregate holds B's seeded unresolved exposure only.
    const globalId = await insertGlobal(t, { reserved: 0, spent: 0, unresolved: 100 });
    await waitPastGlobalCreation(t, globalId);
    const scopeA = await createScope(t, "Unresolved cross-org A");
    // A is fully funded org-side (7 unresolved) but never funded the
    // aggregate: post-global, no markers.
    const budgetA = await insertBudget(t, scopeA.organizationId, { reserved: 0, spent: 0, unresolved: 7 });
    const reservationA = await insertReservation(t, scopeA, budgetA, { reserved: 0, spent: 0, unresolved: 7 });
    const operationA = await insertDispatchingOperation(t, scopeA, reservationA, "cross-org", "token-cross-org");

    const before = await snapshot(t, budgetA, reservationA, globalId);
    const denied = await t.mutation(reconcileAfterCrashRef, {
      operationId: operationA,
      mode: "admitRead",
      attemptToken: "token-cross-org",
      readNumber: 1,
    });
    expect(denied).toMatchObject({
      ok: false,
      code: "allowance-exhausted",
      message: "deployment reconciliation unresolved budget is not attributed to this reservation",
    });
    // The denial precedes every write: budget, reservation, aggregate,
    // and attempts are byte-identical.
    expect(await snapshot(t, budgetA, reservationA, globalId)).toEqual(before);
  });

  test("a read against the reservation's own attributed unresolved exposure admits and moves exactly", async () => {
    const t = convexTest(schema, modules);
    const globalId = await insertGlobal(t, { reserved: 0, spent: 0, unresolved: 100 });
    await waitPastGlobalCreation(t, globalId);
    const scopeA = await createScope(t, "Unresolved own-leg A");
    const budgetA = await insertBudget(t, scopeA.organizationId, { reserved: 0, spent: 0, unresolved: 7 });
    // Explicit markers prove these 7 unresolved micro-USD are A's own.
    const reservationA = await insertReservation(
      t,
      scopeA,
      budgetA,
      { reserved: 0, spent: 0, unresolved: 7 },
      { reserved: 0, unresolved: 7 },
    );
    const operationA = await insertDispatchingOperation(t, scopeA, reservationA, "own-leg", "token-own-leg");

    const admitted = await t.mutation(reconcileAfterCrashRef, {
      operationId: operationA,
      mode: "admitRead",
      attemptToken: "token-own-leg",
      readNumber: 1,
    });
    expect(admitted).toMatchObject({ ok: true, allowed: true });

    // Exactly one read cost moves reserved/unresolved -> spent on every
    // ledger, and both markers decrement in lockstep.
    expect(await snapshot(t, budgetA, reservationA, globalId)).toEqual({
      budget: { reserved: 0, spent: 7, unresolved: 0 },
      reservation: { reserved: 0, spent: 7, unresolved: 0, reservedMarker: 0, unresolvedMarker: 0, state: "open" },
      global: { reserved: 0, spent: 7, unresolved: 93 },
      attempts: 1,
    });

    // Replay of the same bounded slot is single-use: denied with no
    // further ledger movement.
    const beforeReplay = await snapshot(t, budgetA, reservationA, globalId);
    const replay = await t.mutation(reconcileAfterCrashRef, {
      operationId: operationA,
      mode: "admitRead",
      attemptToken: "token-own-leg",
      readNumber: 1,
    });
    expect(replay).toMatchObject({ ok: false, code: "already-claimed" });
    expect(await snapshot(t, budgetA, reservationA, globalId)).toEqual(beforeReplay);
  });

  test("settleServerRead mirrors a partial retain/release split globally", async () => {
    const t = convexTest(schema, modules);
    const globalId = await insertGlobal(t, { reserved: 21, spent: 0, unresolved: 0 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Split settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 21, spent: 0, unresolved: 0 });
    const reservationId = await insertReservation(
      t,
      scope,
      budgetId,
      { reserved: 21, spent: 0, unresolved: 0 },
      { reserved: 21, unresolved: 0 },
    );

    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 1,
      mode: "retainUnknown",
    });
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 7, releasedMicroUsd: 14 });

    // Exactly the retained split reaches unresolved on every ledger; the
    // released remainder simply leaves reserved. The unresolved marker
    // carries the retained split forward.
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 0, unresolved: 7 },
      reservation: { reserved: 0, spent: 0, unresolved: 7, reservedMarker: 0, unresolvedMarker: 7, state: "closed" },
      global: { reserved: 0, spent: 0, unresolved: 7 },
      attempts: 0,
    });

    // Settlement is one-shot: a second settle is denied with ledgers
    // unchanged.
    const beforeSecond = await snapshot(t, budgetId, reservationId, globalId);
    const second = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 1,
      mode: "retainUnknown",
    });
    expect(second.ok).toBe(false);
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual(beforeSecond);
  });

  test("a zero-read settlement releases the full hold globally and retains nothing", async () => {
    const t = convexTest(schema, modules);
    const globalId = await insertGlobal(t, { reserved: 14, spent: 0, unresolved: 5 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Zero-read settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 0 });
    const reservationId = await insertReservation(
      t,
      scope,
      budgetId,
      { reserved: 14, spent: 0, unresolved: 0 },
      { reserved: 14, unresolved: 0 },
    );

    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 0,
      mode: "retainUnknown",
    });
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 0, releasedMicroUsd: 14 });

    // Nothing is invented into unresolved: the hold is released on every
    // ledger and the pre-existing global unresolved balance is untouched.
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 0, unresolved: 0 },
      reservation: { reserved: 0, spent: 0, unresolved: 0, reservedMarker: 0, unresolvedMarker: 0, state: "closed" },
      global: { reserved: 0, spent: 0, unresolved: 5 },
      attempts: 0,
    });
  });

  test("a release settlement frees the attributed hold without retaining", async () => {
    const t = convexTest(schema, modules);
    const globalId = await insertGlobal(t, { reserved: 14, spent: 0, unresolved: 9 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Release settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 0 });
    const reservationId = await insertReservation(
      t,
      scope,
      budgetId,
      { reserved: 14, spent: 0, unresolved: 3 },
      { reserved: 14, unresolved: 3 },
    );

    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 2,
      mode: "release",
    });
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 0, releasedMicroUsd: 14 });
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 0, unresolved: 0 },
      reservation: { reserved: 0, spent: 0, unresolved: 3, reservedMarker: 0, unresolvedMarker: 3, state: "closed" },
      global: { reserved: 0, spent: 0, unresolved: 9 },
      attempts: 0,
    });
  });

  test("a drifted aggregate denies settlement before any write", async () => {
    const t = convexTest(schema, modules);
    // The aggregate cannot cover the reservation's attributed hold:
    // genuine drift, not a settlement.
    const globalId = await insertGlobal(t, { reserved: 5, spent: 0, unresolved: 0 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Drift settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 0 });
    const reservationId = await insertReservation(
      t,
      scope,
      budgetId,
      { reserved: 14, spent: 0, unresolved: 0 },
      { reserved: 14, unresolved: 0 },
    );

    const before = await snapshot(t, budgetId, reservationId, globalId);
    const denied = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 1,
      mode: "retainUnknown",
    });
    expect(denied).toMatchObject({
      ok: false,
      code: "allowance-exhausted",
      message: "deployment allowance ledger drift: global reserved cannot cover settlement",
    });
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual(before);
  });

  test("a valid pre-global legacy row keeps age-based attribution on both legs", async () => {
    const t = convexTest(schema, modules);
    const scope = await createScope(t, "Legacy both legs");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 7 });
    // Legacy row first: no markers, predates the singleton, so the
    // age rule attributes its current amounts without inferring
    // ownership from the aggregate balance.
    const reservationId = await insertReservation(t, scope, budgetId, { reserved: 14, spent: 0, unresolved: 7 });
    // The singleton seeds exactly this row's exposure.
    const globalId = await insertGlobal(t, { reserved: 14, spent: 0, unresolved: 7 });
    const operationId = await insertDispatchingOperation(t, scope, reservationId, "legacy", "token-legacy");

    const admitted = await t.mutation(reconcileAfterCrashRef, {
      operationId,
      mode: "admitRead",
      attemptToken: "token-legacy",
      readNumber: 1,
    });
    expect(admitted).toMatchObject({ ok: true, allowed: true });

    // The admitted read pins explicit markers (attribution minus the
    // consumed split) so later mutations move exactly the remainder.
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 7, spent: 7, unresolved: 7 },
      reservation: { reserved: 7, spent: 7, unresolved: 7, reservedMarker: 7, unresolvedMarker: 7, state: "open" },
      global: { reserved: 7, spent: 7, unresolved: 7 },
      attempts: 1,
    });

    // Settling the remainder retains nothing new (readsUsed=0) and
    // releases exactly the remaining attributed hold on both ledgers.
    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 0,
      mode: "retainUnknown",
    });
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 0, releasedMicroUsd: 7 });
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 7, unresolved: 7 },
      reservation: { reserved: 0, spent: 7, unresolved: 7, reservedMarker: 0, unresolvedMarker: 7, state: "closed" },
      global: { reserved: 0, spent: 7, unresolved: 7 },
      attempts: 1,
    });
  });

  test("a post-global unbound settlement never touches another tenant's aggregate", async () => {
    const t = convexTest(schema, modules);
    // The aggregate belongs entirely to another tenant.
    const globalId = await insertGlobal(t, { reserved: 50, spent: 10, unresolved: 50 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Unbound settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 0 });
    // Post-global row without markers: never funded the aggregate.
    const reservationId = await insertReservation(t, scope, budgetId, { reserved: 14, spent: 0, unresolved: 0 });

    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 1,
      mode: "retainUnknown",
    });
    // Org-only accounting still settles exactly...
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 7, releasedMicroUsd: 7 });
    // ...while the foreign aggregate is byte-identical and the row gains
    // no global marker for exposure it never owned.
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 0, unresolved: 7 },
      reservation: { reserved: 0, spent: 0, unresolved: 7, reservedMarker: null, unresolvedMarker: null, state: "closed" },
      global: { reserved: 50, spent: 10, unresolved: 50 },
      attempts: 0,
    });
  });

  test("a partially attributed settlement moves only owned exposure globally", async () => {
    const t = convexTest(schema, modules);
    const globalId = await insertGlobal(t, { reserved: 20, spent: 0, unresolved: 1 });
    await waitPastGlobalCreation(t, globalId);
    const scope = await createScope(t, "Partial marker settle");
    const budgetId = await insertBudget(t, scope.organizationId, { reserved: 14, spent: 0, unresolved: 3 });
    // Only 5 of the 14 settling micro-USD are owned globally; 2 more sit
    // in the row's unresolved attribution.
    const reservationId = await insertReservation(
      t,
      scope,
      budgetId,
      { reserved: 14, spent: 0, unresolved: 3 },
      { reserved: 5, unresolved: 2 },
    );

    const settled = await t.mutation(settleServerReadRef, {
      reservationId,
      organizationId: scope.organizationId,
      jobId: scope.jobId,
      readsUsed: 1,
      mode: "retainUnknown",
    });
    expect(settled).toEqual({ ok: true, retainedMicroUsd: 7, releasedMicroUsd: 7 });

    // Org settles the full split; the aggregate closes only the owned 5
    // and retains only that owned 5 into unresolved. The 2 unowned
    // retained micro-USD stay org-side and never invent global exposure.
    expect(await snapshot(t, budgetId, reservationId, globalId)).toEqual({
      budget: { reserved: 0, spent: 0, unresolved: 10 },
      reservation: { reserved: 0, spent: 0, unresolved: 10, reservedMarker: 0, unresolvedMarker: 7, state: "closed" },
      global: { reserved: 15, spent: 0, unresolved: 6 },
      attempts: 0,
    });
  });
});

/**
 * F1 shared-allowance reconciliation regression tests (ADR-0004 spend
 * contract).
 *
 * One organization-wide `providerBudgets` row is a shared allowance ledger
 * across branches, retries, and providers. An unresolved Jev reservation and
 * an unresolved OpenAI reservation may sit on the same budget row while the
 * reconciliation read for its own exact reconciliation-basis reservation is
 * admitted and accounted against that one row. A cross-family or
 * caller-invented reservation basis is still denied closed before any read
 * token allocation or ledger movement.
 *
 * Controlled convex-test boundaries only; every reservation and accounting
 * row here is synthetic and no test performs a provider call of any kind.
 */

import { convexTest, type TestConvex } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import * as attempts from "./attempts.js";
import * as jev from "../models/jev.js";
import * as openai from "../models/openai.js";
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

const SHARED_BUDGET_BASIS = "shared-org-allowance-ledger";
const READ_COST_MICRO_USD = 7;
const ATTEMPT_TOKEN = "controlled-attempt-token";
const CONTROLLED_ENV = {
  [jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd]: "1000",
  [jev.JEV_PRICING_ENV_VARS.pricingVersion]: "controlled-jev-v1",
  [jev.JEV_PRICING_ENV_VARS.pricingBasis]: "controlled-jev-pricing",
  [openai.OPENAI_PRICING_ENV_VARS.inputMicroUsdPerMillion]: "750000",
  [openai.OPENAI_PRICING_ENV_VARS.outputMicroUsdPerMillion]: "4500000",
  [openai.OPENAI_PRICING_ENV_VARS.pricingVersion]: "controlled-openai-v1",
  [openai.OPENAI_PRICING_ENV_VARS.pricingBasis]: "controlled-openai-text-pricing",
  [openai.OPENAI_PRICING_ENV_VARS.maxInputTokens]: "4096",
  [openai.OPENAI_PRICING_ENV_VARS.maxOutputTokens]: "1024",
} as const;
const CONTROLLED_ENV_KEYS = Object.keys(CONTROLLED_ENV) as readonly string[];
const ORIGINAL_ENV = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]] as const));

const DRAFT = {
  profile: "ownerRoleplay",
  to: "owner@example.test",
  cc: [],
  bcc: [],
  subject: "Controlled RFQ",
  body: "Please confirm the controlled terms.",
};
const CANONICAL_DRAFT = canonicalJson(DRAFT);

function controlledFamilyBases(): { readonly jevBasis: string; readonly openaiBasis: string } {
  const jevPolicy = jev.loadJevPricingPolicy();
  if (!jevPolicy.ok) throw new Error(`controlled Jev pricing setup failed: ${jevPolicy.message}`);
  const openaiPolicy = openai.loadOpenAIPricingPolicy();
  if (!openaiPolicy.ok) throw new Error(`controlled OpenAI pricing setup failed: ${openaiPolicy.message}`);
  return {
    jevBasis: jevPolicy.policy.reservationPricingBasis,
    openaiBasis: openaiPolicy.policy.reservationPricingBasis,
  };
}

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly organizationId: Id<"organizations">;
  readonly operationId: Id<"operations">;
  readonly budgetId: Id<"providerBudgets">;
  readonly jevReservationId: Id<"reservations">;
  readonly openaiReservationId: Id<"reservations">;
  readonly reconciliationReservationId: Id<"reservations">;
  readonly jevBasis: string;
  readonly openaiBasis: string;
}

async function createSharedReconciliationFixture(): Promise<Fixture> {
  const t = convexTest(schema, modules);
  const { jevBasis, openaiBasis } = controlledFamilyBases();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Shared reconciliation controlled org",
      kind: "private",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Shared reconciliation controlled project",
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
      costCeilingMicroUsd: 1_000,
      roundLimit: 1,
      expiresAt: now + 60_000,
      revocationVersion: 1,
      status: "active",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId,
      projectId,
      grantId,
      version: 1,
      state: "awaitingReply",
      recipientConfigVersion: 1,
      updatedAt: now,
    });
    await ctx.db.patch(grantId, { conversationId });
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
    const operationId = await ctx.db.insert("operations", {
      organizationId,
      projectId,
      jobId,
      kind: "communication.send",
      requestId: "controlled-request",
      requestKey: "controlled-request-key",
      normalizedPayload: CANONICAL_DRAFT,
      normalizedPayloadHash: payloadHash(DRAFT),
      inputVersions: { brief: "v1" },
      grantId,
      grantVersion: 1,
      recipientConfigVersion: 1,
      conversationVersion: 1,
      state: "prepared",
      attemptToken: ATTEMPT_TOKEN,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("outboundSnapshots", {
      organizationId,
      projectId,
      operationId,
      grantId,
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
    return { organizationId, operationId, jobId };
  });

  // One organization-wide provider allowance ledger shared by all families.
  // Its basis label is deliberately not any single family's reservation
  // basis: it funds an unresolved Jev reservation, an unresolved OpenAI
  // reservation, and this operation's reconciliation reservation.
  const rows = await t.run(async (ctx) => {
    const now = Date.now();
    const budgetId = await ctx.db.insert("providerBudgets", {
      organizationId: ids.organizationId,
      ceilingMicroUsd: 200,
      reservedMicroUsd: READ_COST_MICRO_USD * 2,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 50,
      pricingBasis: SHARED_BUDGET_BASIS,
      updatedAt: now,
    });
    const jevReservationId = await ctx.db.insert("reservations", {
      organizationId: ids.organizationId,
      jobId: ids.jobId,
      budgetId,
      ceilingMicroUsd: 200,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 30,
      pricingBasis: jevBasis,
      state: "open",
      updatedAt: now,
    });
    const openaiReservationId = await ctx.db.insert("reservations", {
      organizationId: ids.organizationId,
      jobId: ids.jobId,
      budgetId,
      ceilingMicroUsd: 200,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 20,
      pricingBasis: openaiBasis,
      state: "open",
      updatedAt: now,
    });
    const reconciliationReservationId = await ctx.db.insert("reservations", {
      organizationId: ids.organizationId,
      jobId: ids.jobId,
      budgetId,
      ceilingMicroUsd: READ_COST_MICRO_USD * 2,
      reservedMicroUsd: READ_COST_MICRO_USD * 2,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: reconciliationPricingBasis(READ_COST_MICRO_USD),
      state: "open",
      updatedAt: now,
    });
    await ctx.db.patch(ids.operationId, {
      state: "outcomeUnknown",
      reservationId: reconciliationReservationId,
    });
    await ctx.db.insert("attempts", {
      operationId: ids.operationId,
      token: ATTEMPT_TOKEN,
      state: "outcomeUnknown",
      createdAt: now,
    });
    return { budgetId, jevReservationId, openaiReservationId, reconciliationReservationId };
  });

  return {
    t,
    organizationId: ids.organizationId,
    operationId: ids.operationId,
    budgetId: rows.budgetId,
    jevReservationId: rows.jevReservationId,
    openaiReservationId: rows.openaiReservationId,
    reconciliationReservationId: rows.reconciliationReservationId,
    jevBasis,
    openaiBasis,
  };
}

function admitRead(
  fixture: Fixture,
  operationId: Id<"operations">,
  readNumber: number,
): Promise<MutationReturn<typeof attempts.reconcileAfterCrash>> {
  return fixture.t.mutation(reconcileAfterCrashRef, {
    operationId,
    mode: "admitRead",
    attemptToken: ATTEMPT_TOKEN,
    readNumber,
  });
}

async function reservationRows(
  fixture: Fixture,
): Promise<readonly {
  readonly id: Id<"reservations">;
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly unresolvedMicroUsd: number;
  readonly state: string;
}[]> {
  return await fixture.t.run(async (ctx) => {
    const [jevReservation, openaiReservation, reconciliationReservation] = await Promise.all([
      ctx.db.get(fixture.jevReservationId),
      ctx.db.get(fixture.openaiReservationId),
      ctx.db.get(fixture.reconciliationReservationId),
    ]);
    if (jevReservation === null || openaiReservation === null || reconciliationReservation === null) {
      throw new Error("reservation missing");
    }
    return [
      {
        id: fixture.jevReservationId,
        reservedMicroUsd: jevReservation.reservedMicroUsd,
        spentMicroUsd: jevReservation.spentMicroUsd,
        unresolvedMicroUsd: jevReservation.unresolvedMicroUsd,
        state: jevReservation.state,
      },
      {
        id: fixture.openaiReservationId,
        reservedMicroUsd: openaiReservation.reservedMicroUsd,
        spentMicroUsd: openaiReservation.spentMicroUsd,
        unresolvedMicroUsd: openaiReservation.unresolvedMicroUsd,
        state: openaiReservation.state,
      },
      {
        id: fixture.reconciliationReservationId,
        reservedMicroUsd: reconciliationReservation.reservedMicroUsd,
        spentMicroUsd: reconciliationReservation.spentMicroUsd,
        unresolvedMicroUsd: reconciliationReservation.unresolvedMicroUsd,
        state: reconciliationReservation.state,
      },
    ];
  });
}

async function budgetRow(
  fixture: Fixture,
): Promise<{ readonly reservedMicroUsd: number; readonly spentMicroUsd: number; readonly unresolvedMicroUsd: number }> {
  const budget = await fixture.t.run(async (ctx) => await ctx.db.get(fixture.budgetId));
  if (budget === null) throw new Error("budget missing");
  return {
    reservedMicroUsd: budget.reservedMicroUsd,
    spentMicroUsd: budget.spentMicroUsd,
    unresolvedMicroUsd: budget.unresolvedMicroUsd,
  };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(CONTROLLED_ENV)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of CONTROLLED_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("F1 shared-allowance reconciliation", () => {
  test("an unresolved Jev and an unresolved OpenAI reservation share one budget row while their reconciliation read admits and accounts exactly", async () => {
    const fixture = await createSharedReconciliationFixture();

    const first = await admitRead(fixture, fixture.operationId, 1);
    expect(first).toMatchObject({ ok: true, allowed: true });
    expect(await budgetRow(fixture)).toEqual({ reservedMicroUsd: 7, spentMicroUsd: 7, unresolvedMicroUsd: 50 });
    let rows = await reservationRows(fixture);
    expect(rows[0]).toMatchObject({ state: "open", reservedMicroUsd: 0, spentMicroUsd: 0, unresolvedMicroUsd: 30 });
    expect(rows[1]).toMatchObject({ state: "open", reservedMicroUsd: 0, spentMicroUsd: 0, unresolvedMicroUsd: 20 });
    expect(rows[2]).toMatchObject({ state: "open", reservedMicroUsd: 7, spentMicroUsd: 7, unresolvedMicroUsd: 0 });

    // A prior admitted read that never returned a validated outcome keeps
    // its charge unknown; the next admitted read is then funded from the
    // reservation's unknown exposure against the same shared row.
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.reconciliationReservationId, {
        reservedMicroUsd: 0,
        unresolvedMicroUsd: READ_COST_MICRO_USD,
        spentMicroUsd: 7,
      });
      await ctx.db.patch(fixture.budgetId, {
        reservedMicroUsd: 7,
        unresolvedMicroUsd: 50 + READ_COST_MICRO_USD,
        spentMicroUsd: 7,
        updatedAt: Date.now(),
      });
    });
    const second = await admitRead(fixture, fixture.operationId, 2);
    expect(second).toMatchObject({ ok: true, allowed: true });
    expect(await budgetRow(fixture)).toEqual({ reservedMicroUsd: 7, spentMicroUsd: 14, unresolvedMicroUsd: 50 });
    rows = await reservationRows(fixture);
    expect(rows[0]).toMatchObject({ state: "open", reservedMicroUsd: 0, unresolvedMicroUsd: 30 });
    expect(rows[1]).toMatchObject({ state: "open", reservedMicroUsd: 0, unresolvedMicroUsd: 20 });
    expect(rows[2]).toMatchObject({ state: "open", reservedMicroUsd: 0, spentMicroUsd: 14, unresolvedMicroUsd: 0 });

    const exhausted = await admitRead(fixture, fixture.operationId, 3);
    expect(exhausted).toMatchObject({ ok: false, code: "allowance-exhausted" });
  });

  test("a cross-family reservation basis is denied closed before any read token or ledger movement", async () => {
    const fixture = await createSharedReconciliationFixture();
    const reservationsBefore = await reservationRows(fixture);
    const budgetBefore = await budgetRow(fixture);

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.reconciliationReservationId, { pricingBasis: fixture.jevBasis });
    });
    const jevDenied = await admitRead(fixture, fixture.operationId, 1);
    expect(jevDenied).toMatchObject({ ok: false, code: "stale-pricing-basis" });
    expect(await reservationRows(fixture)).toEqual(reservationsBefore);
    expect(await budgetRow(fixture)).toEqual(budgetBefore);

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.reconciliationReservationId, { pricingBasis: fixture.openaiBasis });
    });
    const openaiDenied = await admitRead(fixture, fixture.operationId, 1);
    expect(openaiDenied).toMatchObject({ ok: false, code: "stale-pricing-basis" });
    expect(await reservationRows(fixture)).toEqual(reservationsBefore);
    expect(await budgetRow(fixture)).toEqual(budgetBefore);

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.reconciliationReservationId, { pricingBasis: "caller-invented-pricing" });
    });
    const inventedDenied = await admitRead(fixture, fixture.operationId, 1);
    expect(inventedDenied).toMatchObject({ ok: false, code: "stale-pricing-basis" });
    expect(await reservationRows(fixture)).toEqual(reservationsBefore);
    expect(await budgetRow(fixture)).toEqual(budgetBefore);

    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.reconciliationReservationId, {
        pricingBasis: reconciliationPricingBasis(READ_COST_MICRO_USD),
      });
    });
    const restored = await admitRead(fixture, fixture.operationId, 1);
    expect(restored).toMatchObject({ ok: true, allowed: true });
  });

  test("a missing shared budget row fails closed before any read token or ledger movement", async () => {
    const fixture = await createSharedReconciliationFixture();
    const reservationsBefore = await reservationRows(fixture);
    await fixture.t.run(async (ctx) => {
      await ctx.db.delete(fixture.budgetId);
    });

    const denied = await admitRead(fixture, fixture.operationId, 1);
    expect(denied).toMatchObject({ ok: false, code: "stale-pricing-basis" });
    expect(await reservationRows(fixture)).toEqual(reservationsBefore);
  });
});

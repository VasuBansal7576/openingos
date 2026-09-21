/**
 * Negotiation authority binding regressions (Devin findings
 * 4060796830/4060796928).
 *
 * Prepared negotiation sends carry an immutable server-derived authority
 * binding (exact mandate, quote version/content hash, consumed roundsUsed,
 * and mandate-approved conversation version/state) that the atomic claim
 * rechecks immediately before provider effect. A revoked, expired,
 * superseded, reply-changed, or round-moved mandate denies the claim with
 * zero provider transport, and an active but round-exhausted mandate cannot
 * prepare or claim. Historical operations without the binding claim exactly
 * as before, and an old-format binding without the conversation pins stays
 * fail-closed.
 *
 * Controlled convex-test boundaries only; every row here is synthetic and
 * no test performs a provider call of any kind.
 */

import { convexTest, type TestConvex } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import { beforeEach, describe, expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "./jobs.js";
import * as reservations from "./reservations.js";
import * as operations from "./operations.js";
import * as sourcing from "../domain/sourcing.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import { canonicalJson, payloadHash } from "../shared/hashing.js";

const modules = {
  "./_generated/server.js": async () => await import("../_generated/server.js"),
  "./access/checks.ts": async () => await import("../access/checks.js"),
  "./access/memberships.ts": async () => await import("../access/memberships.js"),
  "./access/grants.ts": async () => await import("../access/grants.js"),
  "./communication/contracts.ts": async () => await import("../communication/contracts.js"),
  "./domain/guards.ts": async () => await import("../domain/guards.js"),
  "./domain/sourcing.ts": async () => await import("../domain/sourcing.js"),
  "./execution/jobs.ts": async () => await import("./jobs.js"),
  "./execution/attempts.ts": async () => await import("./attempts.js"),
  "./execution/operations.ts": async () => await import("./operations.js"),
  "./execution/reservations.ts": async () => await import("./reservations.js"),
  "./purchasing/contracts/quotes.ts": async () => await import("../purchasing/contracts/quotes.js"),
  "./shared/scope.ts": async () => await import("../shared/scope.js"),
  "./shared/hashing.ts": async () => await import("../shared/hashing.js"),
  "./shared/sha256.ts": async () => await import("../shared/sha256.js"),
  "./shared/time.ts": async () => await import("../shared/time.js"),
  "./shared/denials.ts": async () => await import("../shared/denials.js"),
  "./shared/provenance.ts": async () => await import("../shared/provenance.js"),
  "./shared/mailbox.ts": async () => await import("../shared/mailbox.js"),
  "./shared/domainContracts.ts": async () => await import("../shared/domainContracts.js"),
  "./shared/quoteSemantics.ts": async () => await import("../shared/quoteSemantics.js"),
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
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");
const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.start>,
  MutationReturn<typeof jobs.start>
>("execution/jobs:start");
const reserveRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.reserve>,
  MutationReturn<typeof reservations.reserve>
>("execution/reservations:reserve");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const openNegotiationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.openNegotiation>,
  MutationReturn<typeof sourcing.openNegotiation>
>("domain/sourcing:openNegotiation");
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");

const OWNER = { tokenIdentifier: "negotiation-authority-owner" };
const RESERVATION_AMOUNT_MICRO_USD = 1000;

const DRAFT = {
  profile: "ownerRoleplay",
  to: "owner@example.test",
  cc: [],
  bcc: [],
  subject: "Clarification request",
  body: "Send an RFQ clarification to the supplier.",
};
const CANONICAL_DRAFT = canonicalJson(DRAFT);

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly conversationId: Id<"conversations">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly quoteId: Id<"quotes">;
  readonly quoteContentHash: string;
  readonly negotiationId: Id<"negotiations">;
  readonly budgetId: Id<"providerBudgets">;
}

async function createMandateFixture(roundLimit: number): Promise<Fixture> {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(OWNER);
  const now = Date.now();
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Negotiation authority controlled org",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Negotiation authority controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const ids = {
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };
  await t.run(async (ctx) => {
    await ctx.db.insert("recipientConfigs", {
      version: 1,
      mailboxNormalized: "owner@example.test",
      mailboxHash: "controlled-mailbox",
      active: true,
      configuredAt: now,
      configuredBy: "controlled-test",
    });
  });

  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    operations: ["communication.send"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 1,
    inputVersions: { brief: "v1" },
    payloadJson: CANONICAL_DRAFT,
    costCeilingMicroUsd: 100_000,
    roundLimit: 8,
    expiresAt: now + 60 * 60 * 1000,
  });
  if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
  const conversationId = await t.run(async (ctx) => await ctx.db.insert("conversations", {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    grantId: grant.grantId,
    version: 1,
    state: "awaitingReply",
    recipientConfigVersion: 1,
    updatedAt: now,
  }));
  await t.run(async (ctx) => {
    await ctx.db.patch(grant.grantId, { conversationId });
  });
  const quote = await asOwner.mutation(recordQuoteRef, {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    version: "v1",
    currency: "EUR",
    lines: [{
      lineId: "machine",
      description: "machine",
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 795000 },
      evidenceRefs: [],
    }],
    charges: [],
    taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
    comparisonScope: {
      requirementId: "req-negotiation-authority",
      scopeId: "scope-authority",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
  });
  if (!quote.ok) throw new Error(`quote setup failed: ${quote.message}`);
  await t.run(async (ctx) => {
    await ctx.db.patch(quote.quoteId, { conversationId });
  });

  const started = await asOwner.mutation(startJobRef, {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    text: DRAFT.body,
    operationId: "communication.send",
    kind: "communication",
    grantId: grant.grantId,
  });
  if (!started.ok) throw new Error(`job setup failed: ${started.message}`);

  const negotiation = await asOwner.mutation(openNegotiationRef, {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    quoteId: quote.quoteId,
    mandateHash: "controlled-mandate-hash",
    roundLimit,
    expiresAt: now + 60_000,
  });
  if (!negotiation.ok) throw new Error(`mandate setup failed: ${negotiation.message}`);

  const budgetId = await t.run(async (ctx) => await ctx.db.insert("providerBudgets", {
    organizationId: ids.organizationId,
    ceilingMicroUsd: 100_000,
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    unresolvedMicroUsd: 0,
    pricingBasis: "controlled-shared-ledger",
    updatedAt: now,
  }));

  return {
    t,
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    conversationId,
    grantId: grant.grantId,
    jobId: started.jobId,
    quoteId: quote.quoteId,
    quoteContentHash: quote.contentHash,
    negotiationId: negotiation.negotiationId,
    budgetId,
  };
}

interface FixtureWithReservation extends Fixture {
  readonly reservationId: Id<"reservations">;
}

interface PreparedOperationFixture extends FixtureWithReservation {
  readonly operationId: Id<"operations">;
}

async function prepareOperation(
  fixture: FixtureWithReservation,
  requestId: string,
): Promise<PreparedOperationFixture> {
  const asOwner = fixture.t.withIdentity(OWNER);
  const created = await asOwner.mutation(createOperationRef, {
    jobId: fixture.jobId,
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    kind: "communication.send",
    requestId,
    payloadJson: CANONICAL_DRAFT,
    grantId: fixture.grantId,
    reservationId: fixture.reservationId,
    negotiationId: fixture.negotiationId,
  });
  if (!created.ok) throw new Error(`operation setup failed: ${created.message}`);
  return { ...fixture, operationId: created.operationId };
}

async function insertLegacyBoundOperation(
  fixture: FixtureWithReservation,
  withConversationPins = false,
): Promise<PreparedOperationFixture> {
  // An old-format row: an authority binding without the approved
  // conversation pins, exactly as a pre-foundation worker could have
  // written it.
  const operationId = await fixture.t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("operations", {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      jobId: fixture.jobId,
      kind: "communication.send",
      requestId: "legacy-bound-request",
      requestKey: `${fixture.organizationId}:communication.send:legacy-bound-request`,
      normalizedPayload: CANONICAL_DRAFT,
      normalizedPayloadHash: payloadHash(DRAFT),
      inputVersions: { brief: "v1" },
      grantId: fixture.grantId,
      grantVersion: 1,
      recipientConfigVersion: 1,
      conversationVersion: 1,
      workflowAuthority: {
        operationId: "communication.send" as const,
        projectId: fixture.projectId,
        conversationId: fixture.conversationId,
      },
      negotiationAuthority: withConversationPins
        ? {
          negotiationId: fixture.negotiationId,
          quoteId: fixture.quoteId,
          quoteVersion: "v1",
          quoteContentHash: fixture.quoteContentHash,
          roundsUsed: 0,
          conversationId: fixture.conversationId,
          conversationVersion: 1,
          conversationState: "awaitingReply" as const,
        }
        : {
          negotiationId: fixture.negotiationId,
          quoteId: fixture.quoteId,
          quoteVersion: "v1",
          quoteContentHash: fixture.quoteContentHash,
          roundsUsed: 0,
          conversationId: fixture.conversationId,
        },
      reservationId: fixture.reservationId,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    });
  });
  return { ...fixture, operationId };
}

async function reserveFor(
  fixture: Fixture,
): Promise<FixtureWithReservation> {
  const asOwner = fixture.t.withIdentity(OWNER);
  const reservation = await asOwner.mutation(reserveRef, {
    jobId: fixture.jobId,
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    amountMicroUsd: RESERVATION_AMOUNT_MICRO_USD,
    pricingBasis: "controlled-shared-ledger",
  });
  if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
  return { ...fixture, reservationId: reservation.reservationId };
}

async function attemptCount(fixture: { t: Fixture["t"]; operationId: Id<"operations"> }): Promise<number> {
  return await fixture.t.run(async (ctx) =>
    (await ctx.db
      .query("attempts")
      .withIndex("by_operation", (q) => q.eq("operationId", fixture.operationId))
      .collect()).length,
  );
}

async function operationState(
  fixture: { t: Fixture["t"]; operationId: Id<"operations"> },
): Promise<{ readonly state?: string; readonly negotiationAuthority?: Record<string, unknown> } | null> {
  return await fixture.t.run(async (ctx) => await ctx.db.get(fixture.operationId));
}

function claim(
  fixture: Fixture,
  operationId: Id<"operations">,
): Promise<MutationReturn<typeof operations.claim>> {
  return fixture.t.mutation(claimRef, {
    operationId,
    identity: OWNER.tokenIdentifier,
  });
}

describe("F1 negotiation authority binding", () => {
  test("an operation bound to an active mandate pins the exact mandate facts and claims once", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-bind-1");

    const row = await operationState(fixture);
    const authority = row?.negotiationAuthority as Record<string, unknown> | undefined;
    expect(authority).toMatchObject({
      negotiationId: fixture.negotiationId,
      quoteId: fixture.quoteId,
      quoteVersion: "v1",
      quoteContentHash: fixture.quoteContentHash,
      roundsUsed: 0,
      conversationId: fixture.conversationId,
      conversationVersion: 1,
      conversationState: "awaitingReply",
    });

    const claim1 = await claim(fixture, fixture.operationId);
    expect(claim1).toMatchObject({ ok: true });
    const claim2 = await claim(fixture, fixture.operationId);
    expect(claim2).toMatchObject({ ok: false, code: "already-claimed" });
  });

  test("a created-bound operation deduplicates on identical retry without consuming the mandate round", async () => {
    const fixture = await reserveFor(await createMandateFixture(3));
    const asOwner = fixture.t.withIdentity(OWNER);
    const first = await asOwner.mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: "req-dedupe",
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
      negotiationId: fixture.negotiationId,
    });
    expect(first).toMatchObject({ ok: true, deduped: false });
    const second = await asOwner.mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: "req-dedupe",
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
      negotiationId: fixture.negotiationId,
    });
    expect(second).toMatchObject({ ok: true, deduped: true, operationId: first.operationId });
    const firstOperationId = first.ok ? first.operationId : undefined;
    if (firstOperationId === undefined) throw new Error("first operation missing");
    const row = await operationState({ t: fixture.t, operationId: firstOperationId });
    expect(row?.negotiationAuthority).toBeDefined();
  });

  test.each([
    ["revoked", "mandate-revoked"],
    ["concluded", "mandate-not-active"],
    ["paused", "mandate-not-active"],
    ["expired", "mandate-expired"],
  ] as const)("a %s mandate cannot prepare an operation", async (state, code) => {
    const fixture = await reserveFor(await createMandateFixture(3));
    if (state === "expired") {
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(fixture.negotiationId, { expiresAt: Date.now() - 1 });
      });
    } else {
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(fixture.negotiationId, { state });
      });
    }
    const created = await fixture.t.withIdentity(OWNER).mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: `req-${state}`,
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
      negotiationId: fixture.negotiationId,
    });
    expect(created).toMatchObject({ ok: false, code });
  });

  test("an expired-after-preparation mandate denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-expiry-race");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.negotiationId, { expiresAt: Date.now() - 1 });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-expired" });
    const state = await operationState(fixture);
    expect(state?.state).toBe("prepared");
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a round-moved mandate denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-round-race");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.negotiationId, { roundsUsed: 1 });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-round-changed" });
    const state = await operationState(fixture);
    expect(state?.state).toBe("prepared");
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("an active mandate with an exhausted round limit cannot prepare or claim", async () => {
    const fixture = await reserveFor(await createMandateFixture(2));
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.negotiationId, { roundsUsed: 2 });
    });
    const created = await fixture.t.withIdentity(OWNER).mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: "req-round-exhausted-create",
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
      negotiationId: fixture.negotiationId,
    });
    expect(created).toMatchObject({ ok: false, code: "mandate-round-limit-reached" });

    const claimFixture = await prepareOperation(await reserveFor(await createMandateFixture(2)), "req-round-exhausted-claim");
    await claimFixture.t.run(async (ctx) => {
      await ctx.db.patch(claimFixture.negotiationId, { roundsUsed: 2 });
    });
    const denied = await claim(claimFixture, claimFixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-round-limit-reached" });
    expect(await attemptCount(claimFixture)).toBe(0);
  });

  test("a quote-drifted mandate denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-quote-drift");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.quoteId, { version: "v2" });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-quote-changed" });
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a superseded mandate quote denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-quote-superseded");
    await fixture.t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("quotes", {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        conversationId: fixture.conversationId,
        version: "v2",
        contentHash: "successor-quote-hash",
        currency: "EUR",
        lines: [],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
        evidenceRefs: [],
        counterpartyRole: "ownerStandIn",
        executionMode: "recorded" as const,
        supersedes: fixture.quoteContentHash,
        createdAt: now,
      });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-quote-superseded" });
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a reply recorded after preparation denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-reply-changed");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.conversationId, { version: 2, state: "replyReceived" });
    });
    const denied = await claim(fixture, fixture.operationId);
    // The exact operation-mirror fence denies first; the mandate fence
    // repeats the same fail-closed rule immediately before transport.
    expect(denied).toMatchObject({ ok: false, code: "relevant-reply-superseded" });
    const state = await operationState(fixture);
    expect(state?.state).toBe("prepared");
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a reply recorded before preparation leaves the mandate pin stale and denies claim", async () => {
    const fixture = await reserveFor(await createMandateFixture(3));
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.conversationId, { version: 2, state: "replyReceived", updatedAt: Date.now() });
    });
    const asOwner = fixture.t.withIdentity(OWNER);
    const created = await asOwner.mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: "req-reply-before-create",
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
      negotiationId: fixture.negotiationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const denied = await claim(fixture, created.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-conversation-changed" });
    expect(await attemptCount({ t: fixture.t, operationId: created.operationId })).toBe(0);
  });

  test("a same-version conversation state drift denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-state-drift");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.conversationId, { state: "replyReceived" });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-conversation-changed" });
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a closed bound conversation denies claim with zero provider transport", async () => {
    const fixture = await prepareOperation(await reserveFor(await createMandateFixture(3)), "req-conversation-closed");
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.conversationId, { state: "closed" });
    });
    const denied = await claim(fixture, fixture.operationId);
    // The existing workflow-authority fence denies a closed conversation
    // first; the mandate fence repeats the same explicit closed/cancelled
    // denial immediately before transport.
    expect(denied).toMatchObject({ ok: false, code: "denied-membership" });
    const state = await operationState(fixture);
    expect(state?.state).toBe("prepared");
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("openNegotiation persists the approved conversation pin and a later reply never advances it", async () => {
    const fixture = await reserveFor(await createMandateFixture(3));
    const pinBefore = await fixture.t.run(async (ctx) => await ctx.db.get(fixture.negotiationId));
    expect(pinBefore).toMatchObject({ conversationVersion: 1, conversationState: "awaitingReply" });
    // Raw inbound callback ingestion increments the live conversation and
    // sets replyReceived; the approved pin must stay untouched.
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.conversationId, { version: 2, state: "replyReceived", updatedAt: Date.now() });
    });
    const pinAfter = await fixture.t.run(async (ctx) => await ctx.db.get(fixture.negotiationId));
    expect(pinAfter).toMatchObject({ conversationVersion: 1, conversationState: "awaitingReply" });
  });

  test("a closed bound conversation denies claim through the mandate fence when the operation carries no mirror", async () => {
    const base = await reserveFor(await createMandateFixture(3));
    const fixture = await insertLegacyBoundOperation(base, true);
    // The historical row carries the approved pins but no live conversation
    // mirror and no bound workflow-authority conversation, so the mandate
    // fence itself must deny closed.
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(fixture.operationId, { conversationVersion: undefined });
      await ctx.db.patch(fixture.operationId, {
        workflowAuthority: {
          operationId: "communication.send" as const,
          projectId: fixture.projectId,
        },
      });
      await ctx.db.patch(fixture.grantId, { conversationId: undefined });
      await ctx.db.patch(fixture.conversationId, { state: "closed" });
    });
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-conversation-closed" });
    expect(await attemptCount(fixture)).toBe(0);
  });

  test("a prepared operation without a mandate binding keeps its historical claim path", async () => {
    const fixture = await reserveFor(await createMandateFixture(3));
    const asOwner = fixture.t.withIdentity(OWNER);
    const created = await asOwner.mutation(createOperationRef, {
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      kind: "communication.send",
      requestId: "req-historical",
      payloadJson: CANONICAL_DRAFT,
      grantId: fixture.grantId,
      reservationId: fixture.reservationId,
    });
    if (!created.ok) throw new Error("operation setup failed");
    const row = await operationState({ t: fixture.t, operationId: created.operationId });
    expect(row?.negotiationAuthority).toBeUndefined();
    const claimed = await claim(fixture, created.operationId);
    expect(claimed).toMatchObject({ ok: true });
  });

  test("an old-format bound operation without the approved conversation pin stays fail-closed", async () => {
    const base = await reserveFor(await createMandateFixture(3));
    const fixture = await insertLegacyBoundOperation(base);
    // The mandate carries the exact quote facts; only the conversation pins
    // are missing from the historical row.
    const denied = await claim(fixture, fixture.operationId);
    expect(denied).toMatchObject({ ok: false, code: "mandate-approval-unpinned" });
    expect(await attemptCount(fixture)).toBe(0);
  });
});

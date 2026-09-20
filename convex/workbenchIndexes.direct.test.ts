/// <reference types="vite/client" />
/**
 * S1 bounded workbench index amendment (controlled Convex evidence).
 *
 * These tests run the actual membership, quote, and selection handlers against
 * the real schema, then exercise the two U1 projection indexes directly. The
 * 300-row fixtures are unrelated records, not live provider or customer data.
 */

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import * as memberships from "./access/memberships.js";
import { membershipScopeKey, PERMANENT_AUTHORITY_UNTIL } from "./access/checks.js";
import * as quotes from "./purchasing/contracts/quotes.js";
import * as decisions from "./domain/decisions.js";

type ConvexTest = TestConvex<typeof schema>;

const modules = import.meta.glob([
  "./access/**/*.ts",
  "./domain/**/*.ts",
  "./execution/**/*.ts",
  "./purchasing/**/*.ts",
  "./shared/**/*.ts",
  "./server.ts",
  "./auth.ts",
  "./models/**/*.ts",
  "./_generated/*.js",
  "!./access/**/*.test.ts",
  "!./domain/**/*.test.ts",
  "!./execution/**/*.test.ts",
  "!./purchasing/**/*.test.ts",
  "!./shared/**/*.test.ts",
]);

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
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const recordSelectionRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.recordSelection>,
  MutationReturn<typeof decisions.recordSelection>
>("domain/decisions:recordSelection");

const OWNER = { tokenIdentifier: "s1-workbench-index-owner" };
const PAGED_IDENTITY = "s1-workbench-index-paged";
const EXPIRED_IDENTITY = "s1-workbench-index-expired";
const REVOKED_IDENTITY = "s1-workbench-index-revoked";
const FOREIGN_IDENTITY = "s1-workbench-index-foreign";
const UNRELATED_COUNT = 300;
const BOUNDED_DOCUMENT_BUDGET = 64;

type Workspace = {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
};

async function setupWorkspace(
  t: ConvexTest,
  name: string,
): Promise<Workspace> {
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: `${name} organization`,
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: `${name} project`,
    visibility: "restricted",
  });
  if (!project.ok) throw new Error("project setup failed");
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

async function createSiblingProject(
  t: ConvexTest,
  workspace: Workspace,
  name: string,
): Promise<Id<"projects">> {
  const project = await t.withIdentity(OWNER).mutation(createProjectRef, {
    organizationId: workspace.organizationId,
    name,
    visibility: "restricted",
  });
  if (!project.ok) throw new Error("sibling project setup failed");
  return project.projectId;
}

async function insertUnrelatedAuthorities(
  t: ConvexTest,
  workspace: Workspace,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let index = 0; index < UNRELATED_COUNT; index += 1) {
      const identity = `s1-unrelated-authority-${index}`;
      const membershipId = await ctx.db.insert("memberships", {
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        identity,
        role: "viewer",
        status: "active",
        version: 1,
        updatedAt: now,
      });
      await ctx.db.insert("membershipAuthorities", {
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        identity,
        scopeKey: membershipScopeKey(workspace.projectId),
        role: "viewer",
        membershipId,
        authorityUntil: PERMANENT_AUTHORITY_UNTIL,
        updatedAt: now,
      });
    }
  });
}

async function authorityPage(
  t: ConvexTest,
  identity: string,
  cursor: string | null,
) {
  return t.run((ctx) =>
    ctx.db
      .query("membershipAuthorities")
      .withIndex("by_identity_and_authority_until_and_organization_and_project", (q) =>
        q.eq("identity", identity),
      )
      .order("desc")
      .paginate({ numItems: 1, cursor, maximumRowsRead: 4 }),
  );
}

async function consumerAuthorityRows(
  t: ConvexTest,
  identity: string,
  workspace: Workspace,
  now: number,
) {
  const page = await t.run((ctx) =>
    ctx.db
      .query("membershipAuthorities")
      .withIndex("by_identity_and_authority_until_and_organization_and_project", (q) =>
        q.eq("identity", identity),
      )
      .order("desc")
      .paginate({ numItems: 16, cursor: null, maximumRowsRead: 16 }),
  );
  return page.page.filter(
    (row) =>
      row.organizationId === workspace.organizationId &&
      row.projectId === workspace.projectId &&
      row.authorityUntil > now &&
      (row.expiresAt === undefined || row.expiresAt > now),
  );
}

test("identity-first authority pages stay bounded and fail closed for stale scopes", async () => {
  const t = convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: BOUNDED_DOCUMENT_BUDGET },
  });
  const workspace = await setupWorkspace(t, "authority");
  const siblingProjectId = await createSiblingProject(t, workspace, "authority sibling project");
  const asOwner = t.withIdentity(OWNER);

  const targetGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    targetIdentity: PAGED_IDENTITY,
    role: "viewer",
  });
  if (!targetGrant.ok) throw new Error("target grant setup failed");
  const siblingGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: siblingProjectId,
    targetIdentity: PAGED_IDENTITY,
    role: "viewer",
  });
  if (!siblingGrant.ok) throw new Error("sibling grant setup failed");
  const expiredGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    targetIdentity: EXPIRED_IDENTITY,
    role: "viewer",
    expiresAt: Date.now() + 3_600_000,
  });
  if (!expiredGrant.ok) throw new Error("expired grant setup failed");
  const revokedGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    targetIdentity: REVOKED_IDENTITY,
    role: "viewer",
  });
  if (!revokedGrant.ok) throw new Error("revoked grant setup failed");
  const foreignGrant = await asOwner.mutation(grantProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: siblingProjectId,
    targetIdentity: FOREIGN_IDENTITY,
    role: "viewer",
  });
  if (!foreignGrant.ok) throw new Error("foreign grant setup failed");

  await t.run(async (ctx) => {
    const now = Date.now() - 1;
    const authority = await ctx.db
      .query("membershipAuthorities")
      .withIndex("by_membership", (q) => q.eq("membershipId", expiredGrant.membershipId))
      .unique();
    if (authority === null) throw new Error("expired authority projection missing");
    await ctx.db.patch(authority._id, {
      authorityUntil: now,
      expiresAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(expiredGrant.membershipId, { expiresAt: now, updatedAt: now });
  });
  const revoked = await asOwner.mutation(revokeProjectAccessRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    membershipId: revokedGrant.membershipId,
  });
  expect(revoked).toMatchObject({ ok: true, revoked: true });

  await insertUnrelatedAuthorities(t, workspace);

  // A project-wide scan cannot fit this budget once the 300 unrelated rows
  // exist, while the identity-first index can return both paged rows.
  await expect(
    t.run((ctx) => ctx.db.query("membershipAuthorities").collect()),
  ).rejects.toThrow(/too many documents/i);
  const firstPage = await authorityPage(t, PAGED_IDENTITY, null);
  expect(firstPage.page).toHaveLength(1);
  expect(firstPage.isDone).toBe(false);
  const secondPage = await authorityPage(t, PAGED_IDENTITY, firstPage.continueCursor);
  expect(secondPage.page).toHaveLength(1);
  expect(secondPage.isDone).toBe(true);
  const pagedRows = [...firstPage.page, ...secondPage.page];
  expect(new Set(pagedRows.map((row) => row.projectId))).toEqual(
    new Set([workspace.projectId, siblingProjectId]),
  );
  expect(pagedRows.every((row) => row.organizationId === workspace.organizationId)).toBe(true);
  expect(pagedRows.every((row) => row.authorityUntil === PERMANENT_AUTHORITY_UNTIL)).toBe(true);

  const now = Date.now();
  expect(await consumerAuthorityRows(t, PAGED_IDENTITY, workspace, now)).toHaveLength(1);
  expect(await consumerAuthorityRows(t, EXPIRED_IDENTITY, workspace, now)).toHaveLength(0);
  expect(await consumerAuthorityRows(t, REVOKED_IDENTITY, workspace, now)).toHaveLength(0);
  expect(await consumerAuthorityRows(t, FOREIGN_IDENTITY, workspace, now)).toHaveLength(0);

  const activeRole = await t.withIdentity({ tokenIdentifier: PAGED_IDENTITY }).query(myProjectRoleRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
  });
  expect(activeRole).toMatchObject({ ok: true, role: "viewer" });
  const expiredRole = await t.withIdentity({ tokenIdentifier: EXPIRED_IDENTITY }).query(myProjectRoleRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
  });
  expect(expiredRole).toMatchObject({ ok: false, code: "expired-membership" });
  const revokedRole = await t.withIdentity({ tokenIdentifier: REVOKED_IDENTITY }).query(myProjectRoleRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
  });
  expect(revokedRole).toMatchObject({ ok: false, code: "revoked-membership" });
  const foreignRole = await t.withIdentity({ tokenIdentifier: FOREIGN_IDENTITY }).query(myProjectRoleRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
  });
  expect(foreignRole).toMatchObject({ ok: false, code: "denied-membership" });
});

function quoteArgs(
  workspace: Workspace,
  graph: { readonly requirementId: Id<"requirements">; readonly vendorId: Id<"vendors"> },
  version: string,
  supersedes?: string,
) {
  return {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    version,
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
    evidenceRefs: [],
    requirementId: graph.requirementId,
    vendorId: graph.vendorId,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

async function setupQuoteGraph(
  t: ConvexTest,
  workspace: Workspace,
): Promise<{ readonly requirementId: Id<"requirements">; readonly vendorId: Id<"vendors">; readonly candidateId: Id<"candidates"> }> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const requirementId = await ctx.db.insert("requirements", {
      organizationId: workspace.organizationId,
      projectId: workspace.projectId,
      key: "espresso-machine",
      title: "Espresso machine",
      category: "coffee",
      quantity: "1",
      unit: "piece",
      priority: "P0",
      state: "approved",
      fulfillment: "notOrdered",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const vendorId = await ctx.db.insert("vendors", {
      organizationId: workspace.organizationId,
      name: "Target vendor",
      regions: ["NL"],
      createdAt: now,
    });
    const candidateId = await ctx.db.insert("candidates", {
      organizationId: workspace.organizationId,
      projectId: workspace.projectId,
      requirementId,
      vendorId,
      productModel: "Target model",
      variant: "220V",
      variantKey: "target-model-220v",
      compatibility: "pass",
      conversationState: "quoteReceived",
      createdAt: now,
    });
    return { requirementId, vendorId, candidateId };
  });
}

async function insertUnrelatedQuotes(
  t: ConvexTest,
  workspace: Workspace,
  requirementId: Id<"requirements">,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    for (let index = 0; index < UNRELATED_COUNT; index += 1) {
      await ctx.db.insert("quotes", {
        organizationId: workspace.organizationId,
        projectId: workspace.projectId,
        requirementId,
        version: `unrelated-${index}`,
        contentHash: `unrelated-content-${index}`,
        currency: "EUR",
        lines: [{
          lineId: "machine",
          description: "unrelated machine",
          quantity: "1",
          unitPrice: { currency: "EUR", minorUnits: 1 },
          evidenceRefs: [],
        }],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
        evidenceRefs: [],
        counterpartyRole: "userImport",
        executionMode: "recorded",
        createdAt: now + index,
      });
    }
  });
}

test("candidate quote lookup and successor fencing stay bounded by the tuple index", async () => {
  const t = convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: BOUNDED_DOCUMENT_BUDGET },
  });
  const workspace = await setupWorkspace(t, "quote");
  const graph = await setupQuoteGraph(t, workspace);
  const asOwner = t.withIdentity(OWNER);
  const first = await asOwner.mutation(recordQuoteRef, quoteArgs(workspace, graph, "v1-target"));
  if (!first.ok) throw new Error("first quote setup failed");
  await insertUnrelatedQuotes(t, workspace, graph.requirementId);
  const successor = await asOwner.mutation(
    recordQuoteRef,
    quoteArgs(workspace, graph, "v2-successor", first.contentHash),
  );
  if (!successor.ok) throw new Error("successor quote setup failed");

  // The old project-history scan cannot fit this budget, while the tuple
  // index returns the newest matching revision directly.
  await expect(
    t.run((ctx) =>
      ctx.db
        .query("quotes")
        .withIndex("by_project", (q) => q.eq("projectId", workspace.projectId))
        .collect(),
    ),
  ).rejects.toThrow(/too many documents/i);
  const latest = await t.run((ctx) =>
    ctx.db
      .query("quotes")
      .withIndex("by_project_and_requirement_and_vendor_and_created_at", (q) =>
        q
          .eq("projectId", workspace.projectId)
          .eq("requirementId", graph.requirementId)
          .eq("vendorId", graph.vendorId),
      )
      .order("desc")
      .first(),
  );
  expect(latest?._id).toBe(successor.quoteId);
  expect(latest?.version).toBe("v2-successor");

  const staleSelection = await asOwner.mutation(recordSelectionRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    requirementId: graph.requirementId,
    candidateId: graph.candidateId,
    quoteId: first.quoteId,
    quoteVersion: "v1-target",
    quantity: "1",
    requirementVersion: 1,
    idempotencyKey: "s1-stale-selection",
  });
  expect(staleSelection).toMatchObject({ ok: false, code: "stale-quote-version" });

  const currentSelection = await asOwner.mutation(recordSelectionRef, {
    organizationId: workspace.organizationId,
    projectId: workspace.projectId,
    requirementId: graph.requirementId,
    candidateId: graph.candidateId,
    quoteId: successor.quoteId,
    quoteVersion: "v2-successor",
    quantity: "1",
    requirementVersion: 1,
    idempotencyKey: "s1-current-selection",
  });
  expect(currentSelection).toMatchObject({ ok: true, deduplicated: false });
});

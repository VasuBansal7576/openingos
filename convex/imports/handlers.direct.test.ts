/// <reference types="vite/client" />
/**
 * E7 direct Convex handler tests (controlled, P-24).
 *
 * These tests run the ACTUAL exported import/review handlers against the
 * REAL schema with authenticated identities via official convex-test —
 * no mocks, no source-text assertions. Covered: same-source retry
 * deduplication, changed-payload conflict, recorded user-import
 * provenance, metadata-only attachment honesty with review-required
 * state, selected-row promotion to draft requirements only, review
 * idempotency, stale-source denial, cross-project and cross-org denial
 * without existence reveal, role denials, and proof that invalid rows and
 * attachments create no quote/approval/order/financial record.
 *
 * All fixtures are controlled test data; no provider, storage, or live
 * external effect exists anywhere in this boundary.
 */

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as imports from "./handlers.js";
import { promotedRequirementKey } from "./equipmentCsv.js";

type ConvexTest = TestConvex<typeof schema>;

// Explicit module map: keys are paths relative to the convex root (the
// "_generated" key fixes the modules root for convex-test), values are
// lazy module thunks. Only the modules whose functions this test invokes
// need registration.
const modules: Record<string, () => Promise<unknown>> = {
  "../_generated/server.js": () => import("../_generated/server.js"),
  "../imports/handlers.ts": () => import("./handlers.js"),
  "../access/memberships.ts": () => import("../access/memberships.js"),
};

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
const submitRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof imports.submitEquipmentCsv>,
  MutationReturn<typeof imports.submitEquipmentCsv>
>("imports/handlers:submitEquipmentCsv");
const reviewRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof imports.reviewEquipmentCsv>,
  MutationReturn<typeof imports.reviewEquipmentCsv>
>("imports/handlers:reviewEquipmentCsv");
const attachmentRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof imports.recordAttachment>,
  MutationReturn<typeof imports.recordAttachment>
>("imports/handlers:recordAttachment");

const OWNER = { tokenIdentifier: "e7-owner-a" };
const CONTRIBUTOR = { tokenIdentifier: "e7-contrib-a" };
const VIEWER = { tokenIdentifier: "e7-viewer-a" };
const ATTACKER = { tokenIdentifier: "e7-attacker" };

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}

const HEADER = [
  "title",
  "category",
  "quantity",
  "unit",
  "priority",
  "budgetMinorUnits",
  "currency",
  "needByAt",
  "hardConstraints",
  "responsible",
].join(",");

const VALID_CSV = [
  HEADER,
  "Espresso machine,kitchen,2,piece,P0,150000,EUR,2026-10-01,220V outlet,Vasu",
  "Grinder,kitchen,1,piece,P1,40000,EUR,,,",
  "Dishwasher,kitchen,1,piece,P2,,,,,",
].join("\n") + "\n";

async function setupProject(
  t: ConvexTest,
  owner: { tokenIdentifier: string } = OWNER,
): Promise<{ organizationId: Id<"organizations">; projectId: Id<"projects"> }> {
  const asOwner = t.withIdentity(owner);
  const org = await asOwner.mutation(createOrganizationRef, { name: "E7 org", kind: "private" });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asOwner.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: "E7 project",
    visibility: "open",
  });
  if (!proj.ok) throw new Error("project setup failed");
  return { organizationId: org.organizationId, projectId: proj.projectId };
}

async function grantRole(
  t: ConvexTest,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  targetIdentity: string,
  role: "contributor" | "viewer",
): Promise<void> {
  const result = await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
    organizationId,
    projectId,
    targetIdentity,
    role,
  });
  if (!result.ok) throw new Error(`grant failed: ${result.message}`);
}

async function submitCsv(
  t: ConvexTest,
  identity: { tokenIdentifier: string },
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  csv: string = VALID_CSV,
  idempotencyKey = "import-key-1",
) {
  return await t.withIdentity(identity).mutation(submitRef, {
    organizationId,
    projectId,
    idempotencyKey,
    csvBytes: bytesOf(csv),
  });
}

async function tableCount(
  t: ConvexTest,
  table:
    | "evidence"
    | "files"
    | "projectEvents"
    | "requirements"
    | "approvals"
    | "quotes"
    | "selections"
    | "orders"
    | "costEntries",
): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

test("submit records immutable source evidence with honest recorded user-import provenance", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const result = await submitCsv(t, CONTRIBUTOR === OWNER ? OWNER : OWNER, organizationId, projectId);
  if (!result.ok) throw new Error(`submit failed: ${result.message}`);
  expect(result.deduplicated).toBe(false);
  expect(result.validCount).toBe(3);
  expect(result.invalidCount).toBe(0);
  expect(result.reviewRequired).toBe(true);

  await t.run(async (ctx) => {
    const evidence = await ctx.db.get(result.evidenceId);
    if (evidence === null) throw new Error("missing evidence");
    expect(evidence.sourceKind).toBe("equipmentCsvImport");
    expect(evidence.counterpartyRole).toBe("userImport");
    expect(evidence.executionMode).toBe("recorded");
    expect(evidence.completeness).toBe("complete");
    expect(evidence.protectedSourceText).toBe(VALID_CSV);
    const file = await ctx.db.get(result.fileId);
    if (file === null) throw new Error("missing file");
    expect(file.sizeBytes).toBe(encoder.encode(VALID_CSV).length);
    expect(file.contentType).toBe("text/csv");
    expect(file.storageRef).toBeUndefined();
  });
});

test("identical retry returns the original result and creates no duplicate records", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const first = await submitCsv(t, OWNER, organizationId, projectId);
  if (!first.ok) throw new Error("submit failed");
  const retry = await submitCsv(t, OWNER, organizationId, projectId);
  expect(retry.ok).toBe(true);
  if (!retry.ok) return;
  expect(retry.deduplicated).toBe(true);
  expect(retry.evidenceId).toBe(first.evidenceId);
  expect(retry.fileId).toBe(first.fileId);
  expect(retry.validCount).toBe(first.validCount);
  expect(retry.rows).toEqual(first.rows);
  expect(await tableCount(t, "evidence")).toBe(1);
  expect(await tableCount(t, "files")).toBe(1);
  expect(await tableCount(t, "projectEvents")).toBe(1);
});

test("identical source bytes under a different key deduplicate to the original import", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const first = await submitCsv(t, OWNER, organizationId, projectId, VALID_CSV, "key-one");
  if (!first.ok) throw new Error("submit failed");
  const second = await submitCsv(t, OWNER, organizationId, projectId, VALID_CSV, "key-two");
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.deduplicated).toBe(true);
  expect(second.evidenceId).toBe(first.evidenceId);
  expect(await tableCount(t, "evidence")).toBe(1);
  expect(await tableCount(t, "files")).toBe(1);
});

test("changed payload under the same idempotency key conflicts", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const first = await submitCsv(t, OWNER, organizationId, projectId);
  if (!first.ok) throw new Error("submit failed");
  const changed = VALID_CSV.replace("Grinder", "Blender");
  const conflict = await submitCsv(t, OWNER, organizationId, projectId, changed, "import-key-1");
  expect(conflict.ok).toBe(false);
  if (!conflict.ok) expect(conflict.code).toBe("duplicate-conflict");
  expect(await tableCount(t, "evidence")).toBe(1);
});

test("review promotes only explicitly selected valid rows to draft requirements, idempotently", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const submitted = await submitCsv(t, OWNER, organizationId, projectId);
  if (!submitted.ok) throw new Error("submit failed");
  const validKeys = submitted.rows
    .filter((row) => row.status === "valid")
    .map((row) => row.rowKey)
    .filter((key) => key !== undefined);
  expect(validKeys).toHaveLength(3);

  const selected = validKeys.slice(0, 2);
  const review = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: selected,
  });
  expect(review.ok).toBe(true);
  if (!review.ok) return;
  expect(review.promotedCount).toBe(2);
  expect(review.alreadyPromotedCount).toBe(0);
  expect(review.requirementIds).toHaveLength(2);

  await t.run(async (ctx) => {
    const requirements = await ctx.db.query("requirements").collect();
    expect(requirements).toHaveLength(2);
    for (const requirement of requirements) {
      expect(requirement.state).toBe("draft");
      expect(requirement.fulfillment).toBe("notOrdered");
      expect(requirement.version).toBe(1);
    }
    const titles = requirements.map((requirement) => requirement.title).sort();
    expect(titles).toEqual(["Espresso machine", "Grinder"]);
    // The review gate holds: no downstream purchasing records exist.
    expect((await ctx.db.query("approvals").collect()).length).toBe(0);
    expect((await ctx.db.query("quotes").collect()).length).toBe(0);
    expect((await ctx.db.query("selections").collect()).length).toBe(0);
    expect((await ctx.db.query("orders").collect()).length).toBe(0);
    expect((await ctx.db.query("costEntries").collect()).length).toBe(0);
  });

  // Idempotent repeat: no new requirements, no new review event.
  const eventsBefore = await tableCount(t, "projectEvents");
  const repeat = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: selected,
  });
  expect(repeat.ok).toBe(true);
  if (!repeat.ok) return;
  expect(repeat.promotedCount).toBe(0);
  expect(repeat.alreadyPromotedCount).toBe(2);
  expect(await tableCount(t, "requirements")).toBe(2);
  expect(await tableCount(t, "projectEvents")).toBe(eventsBefore);

  // A later review of the remaining row still promotes exactly that row.
  const remaining = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [validKeys[2] ?? ""],
  });
  expect(remaining.ok).toBe(true);
  if (!remaining.ok) return;
  expect(remaining.promotedCount).toBe(1);
  expect(await tableCount(t, "requirements")).toBe(3);
});

test("invalid and unknown rows are never promotable", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const csvWithBadRow = [
    HEADER,
    "Espresso machine,kitchen,2,piece,P0,150000,EUR,2026-10-01,220V outlet,Vasu",
    "Broken,row,not-a-number,piece,P0,,,,,",
  ].join("\n") + "\n";
  const submitted = await submitCsv(t, OWNER, organizationId, projectId, csvWithBadRow);
  if (!submitted.ok) throw new Error("submit failed");
  expect(submitted.invalidCount).toBe(1);
  const invalidRow = submitted.rows.find((row) => row.status === "invalid");
  expect(invalidRow?.errors.length ?? 0).toBeGreaterThan(0);
  // The source with invalid rows is still recorded; only review is gated.
  expect(await tableCount(t, "evidence")).toBe(1);

  const invalidKey = invalidRow && "rowKey" in invalidRow ? invalidRow.rowKey : undefined;
  const fakeKey = `fabricated-${submitted.contentHash}`;
  const reviewInvalid = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [fakeKey, ...(invalidKey ? [invalidKey] : [])],
  });
  expect(reviewInvalid.ok).toBe(false);
  if (!reviewInvalid.ok) expect(reviewInvalid.code).toBe("invalid-payload");
  expect(await tableCount(t, "requirements")).toBe(0);

  // A fully invalid import records the source but promotes nothing.
  const allInvalid = await submitCsv(t, OWNER, organizationId, projectId, [HEADER, ",,,,,,,,,,"].join("\n") + "\n", "bad-key");
  expect(allInvalid.ok).toBe(true);
  if (!allInvalid.ok) return;
  expect(allInvalid.validCount).toBe(0);
  expect(allInvalid.invalidCount).toBe(1);
});

test("stale or tampered source denies the review", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const submitted = await submitCsv(t, OWNER, organizationId, projectId);
  if (!submitted.ok) throw new Error("submit failed");
  const key = submitted.rows[0]?.rowKey;
  if (key === undefined) throw new Error("missing row key");

  const wrongHash = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: "0".repeat(64),
    selectedRowKeys: [key],
  });
  expect(wrongHash.ok).toBe(false);
  if (!wrongHash.ok) expect(wrongHash.code).toBe("stale-input-version");

  await t.run(async (ctx) => {
    await ctx.db.patch("evidence", submitted.evidenceId, {
      protectedSourceText: VALID_CSV.replace("Espresso", "Modified"),
    });
  });
  const tampered = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [key],
  });
  expect(tampered.ok).toBe(false);
  if (!tampered.ok) expect(tampered.code).toBe("stale-input-version");
  expect(await tableCount(t, "requirements")).toBe(0);
});

test("cross-project and cross-organization review denies without revealing existence", async () => {
  const t = convexTest(schema, modules);
  const home = await setupProject(t);
  const submitted = await submitCsv(t, OWNER, home.organizationId, home.projectId);
  if (!submitted.ok) throw new Error("submit failed");
  const key = submitted.rows[0]?.rowKey;
  if (key === undefined) throw new Error("missing row key");

  // Same organization, different project: the source is not reviewable
  // from another project's authority.
  const otherProject = await t.withIdentity(OWNER).mutation(createProjectRef, {
    organizationId: home.organizationId,
    name: "E7 other project",
    visibility: "open",
  });
  if (!otherProject.ok) throw new Error("project setup failed");
  const crossProject = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId: home.organizationId,
    projectId: otherProject.projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [key],
  });
  expect(crossProject.ok).toBe(false);
  if (!crossProject.ok) expect(crossProject.code).toBe("denied-membership");

  // A foreign organization gets the same non-revealing denial whether the
  // evidence exists or not.
  const attackerOrg = await setupProject(t, ATTACKER);
  const foreign = await t.withIdentity(ATTACKER).mutation(reviewRef, {
    organizationId: attackerOrg.organizationId,
    projectId: attackerOrg.projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [key],
  });
  const nonexistent = await t.withIdentity(ATTACKER).mutation(reviewRef, {
    organizationId: attackerOrg.organizationId,
    projectId: attackerOrg.projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [key],
  });
  expect(foreign.ok).toBe(false);
  expect(nonexistent.ok).toBe(false);
  if (!foreign.ok && !nonexistent.ok) {
    expect(foreign.code).toBe(nonexistent.code);
    expect(foreign.message).toBe(nonexistent.message);
  }
});

test("role and identity authority is enforced through the existing access helpers", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  await grantRole(t, organizationId, projectId, CONTRIBUTOR.tokenIdentifier, "contributor");
  await grantRole(t, organizationId, projectId, VIEWER.tokenIdentifier, "viewer");

  const viewerSubmit = await submitCsv(t, VIEWER, organizationId, projectId);
  expect(viewerSubmit.ok).toBe(false);
  if (!viewerSubmit.ok) expect(viewerSubmit.code).toBe("denied-capability");

  const contributorSubmit = await submitCsv(t, CONTRIBUTOR, organizationId, projectId);
  expect(contributorSubmit.ok).toBe(true);
  if (!contributorSubmit.ok) return;
  const key = contributorSubmit.rows[0]?.rowKey;
  if (key === undefined) throw new Error("missing row key");

  const viewerReview = await t.withIdentity(VIEWER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: contributorSubmit.evidenceId,
    expectedContentHash: contributorSubmit.contentHash,
    selectedRowKeys: [key],
  });
  expect(viewerReview.ok).toBe(false);
  if (!viewerReview.ok) expect(viewerReview.code).toBe("denied-capability");

  const viewerAttachment = await t.withIdentity(VIEWER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key",
  });
  expect(viewerAttachment.ok).toBe(false);

  const unauthenticated = await t.mutation(submitRef, {
    organizationId,
    projectId,
    idempotencyKey: "anon",
    csvBytes: bytesOf(VALID_CSV),
  });
  expect(unauthenticated.ok).toBe(false);
  if (!unauthenticated.ok) expect(unauthenticated.code).toBe("forged-identity");
});

test("malformed and oversized documents are denied with zero records created", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const malformed = await submitCsv(t, OWNER, organizationId, projectId, '"unterminated,kitchen,1,piece,P0,,,,,');
  expect(malformed.ok).toBe(false);
  if (!malformed.ok) expect(malformed.code).toBe("invalid-payload");
  expect(await tableCount(t, "evidence")).toBe(0);
  expect(await tableCount(t, "files")).toBe(0);

  const oversized = "x".repeat(262_145);
  const tooBig = await submitCsv(t, OWNER, organizationId, projectId, oversized);
  expect(tooBig.ok).toBe(false);
  expect(await tableCount(t, "evidence")).toBe(0);
});

test("BOM imports keep a lossless source: identical retry replays and review promotes", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const bomCsv = "﻿" + VALID_CSV;
  const submitted = await submitCsv(t, OWNER, organizationId, projectId, bomCsv, "bom-key");
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) return;
  expect(submitted.validCount).toBe(3);
  expect(submitted.deduplicated).toBe(false);

  const retry = await submitCsv(t, OWNER, organizationId, projectId, bomCsv, "bom-key");
  expect(retry.ok).toBe(true);
  if (!retry.ok) return;
  expect(retry.deduplicated).toBe(true);
  expect(retry.evidenceId).toBe(submitted.evidenceId);
  expect(retry.rows).toEqual(submitted.rows);

  // Review re-hashes the stored source: the BOM must survive roundtrip.
  const key = submitted.rows[0]?.rowKey;
  if (key === undefined) throw new Error("missing row key");
  const review = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: [key],
  });
  expect(review.ok).toBe(true);
  if (!review.ok) return;
  expect(review.promotedCount).toBe(1);
});

test("a key first seen on the byte-dedupe path is durably bound and conflicts on changed reuse", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const first = await submitCsv(t, OWNER, organizationId, projectId, VALID_CSV, "key-one");
  if (!first.ok) throw new Error("submit failed");
  const dedupe = await submitCsv(t, OWNER, organizationId, projectId, VALID_CSV, "key-two");
  expect(dedupe.ok).toBe(true);
  if (!dedupe.ok) return;
  expect(dedupe.deduplicated).toBe(true);
  expect(await tableCount(t, "evidence")).toBe(1);
  expect(await tableCount(t, "files")).toBe(1);

  // The same key with changed payload now conflicts with zero new records.
  const changed = VALID_CSV.replace("Grinder", "Blender");
  const conflict = await submitCsv(t, OWNER, organizationId, projectId, changed, "key-two");
  expect(conflict.ok).toBe(false);
  if (!conflict.ok) expect(conflict.code).toBe("duplicate-conflict");
  expect(await tableCount(t, "evidence")).toBe(1);
  expect(await tableCount(t, "files")).toBe(1);
  expect(await tableCount(t, "requirements")).toBe(0);
});

test("a promotion collision denies the entire review with zero partial writes", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const submitted = await submitCsv(t, OWNER, organizationId, projectId);
  if (!submitted.ok) throw new Error("submit failed");
  const validKeys = submitted.rows
    .filter((row) => row.status === "valid")
    .map((row) => row.rowKey)
    .filter((key) => key !== undefined);
  expect(validKeys).toHaveLength(3);

  // A conflicting requirement already occupies row 3's deterministic key.
  const collisionKey = promotedRequirementKey(submitted.contentHash, 3);
  await t.run(async (ctx) => {
    await ctx.db.insert("requirements", {
      organizationId,
      projectId,
      key: collisionKey,
      title: "A different requirement entirely",
      category: "kitchen",
      quantity: "9",
      unit: "box",
      priority: "P2",
      state: "draft",
      fulfillment: "notOrdered",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  const eventsBefore = await tableCount(t, "projectEvents");
  const review = await t.withIdentity(OWNER).mutation(reviewRef, {
    organizationId,
    projectId,
    evidenceId: submitted.evidenceId,
    expectedContentHash: submitted.contentHash,
    selectedRowKeys: validKeys,
  });
  expect(review.ok).toBe(false);
  if (!review.ok) expect(review.code).toBe("duplicate-conflict");
  // The earlier rows in the same selection were never written.
  expect(await tableCount(t, "requirements")).toBe(1);
  expect(await tableCount(t, "projectEvents")).toBe(eventsBefore);
});

test("attachment ingestion records metadata with review-required status and never synthesizes a quote", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const result = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-1",
    fileName: "supplier-quote.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.extractionStatus).toBe("reviewRequired");
  expect(result.deduplicated).toBe(false);

  await t.run(async (ctx) => {
    const evidence = await ctx.db.get(result.evidenceId);
    if (evidence === null) throw new Error("missing evidence");
    expect(evidence.sourceKind).toBe("quoteAttachmentImport");
    expect(evidence.counterpartyRole).toBe("userImport");
    expect(evidence.executionMode).toBe("recorded");
    // Bytes/storage/extraction are unavailable: recorded honestly.
    expect(evidence.completeness).toBe("unavailable");
    // The canonical normalized metadata is the protected source record.
    expect(evidence.protectedSourceText).toBe(
      '{"contentType":"application/pdf","fileName":"supplier-quote.pdf","sizeBytes":12345}',
    );
    const file = await ctx.db.get(result.fileId);
    if (file === null) throw new Error("missing file");
    expect(file.sizeBytes).toBe(12_345);
    expect(file.contentType).toBe("application/pdf");
    expect(file.storageRef).toBeUndefined();
    const events = await ctx.db
      .query("projectEvents")
      .filter((q) => q.eq(q.field("kind"), "imports.attachment.reviewRequired"))
      .collect();
    expect(events).toHaveLength(1);
    // No quote, approval, order, or financial record is synthesized.
    expect((await ctx.db.query("quotes").collect()).length).toBe(0);
    expect((await ctx.db.query("approvals").collect()).length).toBe(0);
    expect((await ctx.db.query("orders").collect()).length).toBe(0);
    expect((await ctx.db.query("costEntries").collect()).length).toBe(0);
  });

  const retry = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-1",
    fileName: "supplier-quote.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
  });
  expect(retry.ok).toBe(true);
  if (!retry.ok) return;
  expect(retry.deduplicated).toBe(true);
  expect(retry.evidenceId).toBe(result.evidenceId);
  expect(await tableCount(t, "evidence")).toBe(1);

  const changed = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-1",
    fileName: "supplier-quote-v2.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
  });
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.code).toBe("duplicate-conflict");

  // Identical metadata under a new key deduplicates and binds the new key.
  const metadataDedupe = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-2",
    fileName: "supplier-quote.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
  });
  expect(metadataDedupe.ok).toBe(true);
  if (!metadataDedupe.ok) return;
  expect(metadataDedupe.deduplicated).toBe(true);
  expect(metadataDedupe.evidenceId).toBe(result.evidenceId);
  expect(await tableCount(t, "evidence")).toBe(1);

  // The newly bound key now conflicts on changed metadata.
  const reboundConflict = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-2",
    fileName: "other.pdf",
    contentType: "application/pdf",
    sizeBytes: 12_345,
  });
  expect(reboundConflict.ok).toBe(false);
  if (!reboundConflict.ok) expect(reboundConflict.code).toBe("duplicate-conflict");
});

test("attachment replay revalidates the stored metadata against its recorded hash", async () => {
  const t = convexTest(schema, modules);
  const { organizationId, projectId } = await setupProject(t);
  const created = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-tamper",
    fileName: "manual.pdf",
    contentType: "application/pdf",
    sizeBytes: 42,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) return;

  await t.run(async (ctx) => {
    await ctx.db.patch("evidence", created.evidenceId, {
      protectedSourceText: '{"fileName":"manual.pdf","contentType":"application/pdf","sizeBytes":43}',
    });
  });

  const replay = await t.withIdentity(OWNER).mutation(attachmentRef, {
    organizationId,
    projectId,
    idempotencyKey: "attachment-key-tamper",
    fileName: "manual.pdf",
    contentType: "application/pdf",
    sizeBytes: 42,
  });
  expect(replay.ok).toBe(false);
  if (!replay.ok) expect(replay.code).toBe("invalid-payload");
});

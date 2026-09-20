import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import WorkbenchView from "../Workbench";
import { formatMoney, parseWorkbenchSnapshot } from "../workbench-state";

const projection = {
  ok: true,
  project: {
    id: "project-w1-1",
    organizationId: "organization-w1-1",
    name: "Northside café",
    visibility: "open",
    location: {
      id: "location-w1-1",
      name: "Northside",
      region: "Netherlands",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    },
    currency: "EUR",
    budgetMinorUnits: 900000,
    needByAt: Date.UTC(2026, 9, 12),
    createdAt: Date.UTC(2026, 8, 1),
  },
  effectiveRole: "approver",
  capabilities: {
    canResearch: true,
    canRecordEvidence: true,
    canRecordQuote: true,
    canCompare: true,
    canCommunicate: true,
    canClarify: true,
  },
  requirements: [{
    id: "requirement-w1-1",
    key: "ESP-01",
    title: "Two-group espresso machine",
    category: "equipment",
    quantity: "1",
    unit: "unit",
    priority: "P0",
    state: "readyForDecision",
    fulfillment: "notOrdered",
    version: 3,
    budgetMinorUnits: 900000,
    currency: "EUR",
    needByAt: Date.UTC(2026, 9, 12),
  }],
  candidates: [{
    id: "candidate-w1-1",
    requirementId: "requirement-w1-1",
    productModel: "Atlas 2G",
    variant: "new · two-group",
    compatibility: "pass",
    conversationState: "quoteReceived",
    vendor: { id: "vendor-w1-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
    latestValidQuote: {
      id: "quote-w1-1",
      version: "2",
      currency: "EUR",
      lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 795000 } }],
      charges: [
        { chargeId: "charge-equipment", label: "equipment", scope: { kind: "line", lineId: "machine" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 795000 } } },
        { chargeId: "charge-delivery", label: "delivery", scope: { kind: "quote" }, state: { kind: "included", coveringId: "charge-equipment" } },
        { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "unknown", reason: "Supplier did not confirm installation." } },
      ],
      taxBasis: { kind: "inclusive", basisId: "tax-w1-1" },
      createdAt: Date.UTC(2026, 8, 20),
      provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
    },
    evidence: [{
      id: "product-evidence-w1-1",
      field: "installation",
      sourceKind: "owner mailbox exchange",
      capturedAt: Date.UTC(2026, 8, 20),
      completeness: "complete",
      verification: "verified",
      freshness: "fresh",
      lastCheckedAt: Date.UTC(2026, 8, 20),
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
    }],
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
  }],
  jobs: [
    { id: "job-queued", kind: "research", status: "queued", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
    { id: "job-sent", kind: "communication", status: "sent", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-delivered", kind: "communication", status: "delivered", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20), observedAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-unknown", kind: "communication", status: "unknown", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "outcomeUnknown", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-partial", kind: "recovery", status: "partial", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-paused", kind: "recovery", status: "paused", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
  ],
  decisions: [{ id: "approval-w1-1", kind: "approval", state: "requested", quoteId: "quote-w1-1", createdAt: Date.UTC(2026, 8, 20) }],
  activity: { page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }], continueCursor: null, isDone: true },
  requirementsTruncated: false,
  candidatesTruncated: false,
  jobsTruncated: false,
  decisionsTruncated: false,
  provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
};

test("accepts the exact W1 projection without inventing aggregates or authority", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  expect(snapshot?.project.id).toBe(projection.project.id);
  expect(snapshot?.offers[0]?.quote?.comparableTotalMinorUnits).toBeNull();
  expect(snapshot?.committedMinorUnits).toBeNull();
  expect(snapshot?.access.capabilities.canApprove).toBeNull();
  expect(snapshot?.jobs.map((job) => job.delivery)).toEqual(["queued", "sent", "delivered", "unknown", "partial", "paused"]);
  expect(snapshot?.activity.items[0]?.summary).toBeNull();
});

test("renders a project-scoped workbench from W1 state with honest provenance", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("Everything on the table.");
  expect(html).toContain("Recorded owner exchange");
  expect(html).toContain("Unknown charges stay visible.");
  expect(html).toContain("Unknown");
  expect(html).toContain("Selecting an offer does not place an order.");
  expect(html).not.toContain("owner-supplier@example");
  expect(html).not.toContain("providerId");
});

test("keeps a connected app honest when no projection is available", () => {
  const html = renderToStaticMarkup(createElement(App, {
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
  }));
  expect(html).toContain("Waiting for an authorized project.");
  expect(html).toContain("No vendors, quotes or provider outcomes are shown");
  expect(html).not.toContain("Harbor Equipment");
});

test("rejects malformed, cross-project, and private W1 projection payloads", () => {
  expect(parseWorkbenchSnapshot(projection, "different-project")).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, project: { ...projection.project, ownerEmail: "private@example.test" } }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, candidates: [{ ...projection.candidates[0], latestValidQuote: { ...projection.candidates[0]!.latestValidQuote!, charges: [{ ...projection.candidates[0]!.latestValidQuote!.charges[0], state: { kind: "known", amount: null } }] } }] }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, activity: { ...projection.activity, page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: "not-a-time" }] } }, projection.project.id)).toBeNull();
});

test("formats unknown money without turning missing charges into zero", () => {
  expect(formatMoney(null, "EUR")).toBe("Unknown");
  expect(formatMoney(795000, "EUR")).toContain("7,950");
});

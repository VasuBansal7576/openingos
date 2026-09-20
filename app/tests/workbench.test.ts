import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import WorkbenchView from "../Workbench";
import {
  formatMoney,
  parseWorkbenchSnapshot,
  type WorkbenchSnapshot,
} from "../workbench-state";

const snapshot: WorkbenchSnapshot = {
  project: {
    id: "project-controlled-1",
    name: "Northside café",
    region: "Netherlands",
    currency: "EUR",
    budgetMinorUnits: 900000,
    needByAt: Date.UTC(2026, 9, 12),
  },
  access: {
    role: "approver",
    capabilities: {
      canResearch: true,
      canApprove: true,
      canCommunicate: true,
      canRecordOrder: false,
      canResolveRisk: true,
    },
  },
  requirements: [{
    id: "requirement-machine",
    key: "ESP-01",
    title: "Two-group espresso machine",
    quantity: "1",
    unit: "unit",
    priority: "P0",
    state: "readyForDecision",
    fulfillment: "notOrdered",
    version: 3,
    budgetMinorUnits: 900000,
    needByAt: Date.UTC(2026, 9, 12),
  }],
  offers: [{
    id: "offer-controlled-1",
    requirementId: "requirement-machine",
    vendor: { id: "vendor-controlled-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
    productModel: "Atlas 2G",
    variant: "new · two-group",
    compatibility: "pass",
    conversationState: "quoteReceived",
    quote: {
      id: "quote-controlled-1",
      version: "2",
      currency: "EUR",
      lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unit: "unit", unitMinorUnits: 795000, evidenceIds: ["evidence-controlled-1"] }],
      charges: [
        { kind: "equipment", state: "known", minorUnits: 795000, currency: "EUR", scope: "line", evidenceIds: ["evidence-controlled-1"] },
        { kind: "delivery", state: "included", minorUnits: null, currency: "EUR", scope: "quote", evidenceIds: ["evidence-controlled-1"] },
        { kind: "installation", state: "unknown", minorUnits: null, currency: "EUR", scope: "quote", evidenceIds: [] },
      ],
      totalMinorUnits: null,
      comparableTotalMinorUnits: null,
      validUntil: null,
      taxBasis: "inclusive",
      superseded: false,
    },
    evidence: [{
      id: "evidence-controlled-1",
      label: "Supplier terms, version 2",
      sourceKind: "owner mailbox exchange",
      freshness: "fresh",
      verification: "verified",
      executionMode: "recorded",
      counterpartyRole: "ownerStandIn",
      origin: "ownerImport",
      sourceUrl: null,
    }],
    provenance: "recorded",
    ownerAuthoredTerms: true,
    recommendationNote: "Installation still needs confirmation.",
  }],
  jobs: [
    { id: "job-queued", kind: "research", state: "queued", delivery: "queued", progress: 0.2, attempts: 1, updatedAt: Date.UTC(2026, 8, 20), failureCode: null, lastCheckedAt: null, summary: "Research branch is queued", evidenceIds: [] },
    { id: "job-sent", kind: "communication", state: "waiting", delivery: "sent", progress: null, attempts: 1, updatedAt: Date.UTC(2026, 8, 20), failureCode: null, lastCheckedAt: Date.UTC(2026, 8, 20), summary: "Owner-only RFQ was sent", evidenceIds: [] },
    { id: "job-delivered", kind: "communication", state: "completed", delivery: "delivered", progress: 1, attempts: 1, updatedAt: Date.UTC(2026, 8, 20), failureCode: null, lastCheckedAt: Date.UTC(2026, 8, 20), summary: "Reply receipt was recorded", evidenceIds: ["evidence-controlled-1"] },
    { id: "job-unknown", kind: "communication", state: "failed", delivery: "unknown", progress: null, attempts: 2, updatedAt: Date.UTC(2026, 8, 20), failureCode: "provider-outcome-unknown", lastCheckedAt: Date.UTC(2026, 8, 20), summary: "Send outcome needs reconciliation", evidenceIds: [] },
    { id: "job-partial", kind: "recovery", state: "paused", delivery: "partial", progress: 0.5, attempts: 2, updatedAt: Date.UTC(2026, 8, 20), failureCode: "partial-result", lastCheckedAt: Date.UTC(2026, 8, 20), summary: "Completed evidence retained", evidenceIds: [] },
    { id: "job-paused", kind: "recovery", state: "paused", delivery: "paused", progress: null, attempts: 1, updatedAt: Date.UTC(2026, 8, 20), failureCode: "approval-required", lastCheckedAt: null, summary: "Recovery waits for approval", evidenceIds: [] },
  ],
  decisions: [{ id: "decision-1", type: "approval", state: "requested", requirementId: "requirement-machine", offerId: "offer-controlled-1", quoteId: "quote-controlled-1", quoteVersion: "2", requestedAt: Date.UTC(2026, 8, 20), evidenceIds: ["evidence-controlled-1"], summary: "Review Atlas 2G quote v2", authorizationRequired: true }],
  activity: { items: [{ id: "event-1", type: "quote", occurredAt: Date.UTC(2026, 8, 20), actorLabel: "Project owner", state: "recorded", summary: "Quote v2 was recorded", evidenceIds: ["evidence-controlled-1"] }], continueCursor: null, isDone: true },
  provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
  selectedOfferId: null,
  selectedForecastMinorUnits: null,
  committedMinorUnits: 0,
  paidMinorUnits: 0,
  deliveredQuantityByRequirement: { "requirement-machine": "0" },
};

test("renders a project-scoped workbench from server state with honest provenance", () => {
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

test("rejects cross-project and private projection payloads at the adapter boundary", () => {
  expect(parseWorkbenchSnapshot(snapshot, "different-project")).toBeNull();
  expect(parseWorkbenchSnapshot({ ...snapshot, project: { ...snapshot.project }, ownerEmail: "private@example.test" }, snapshot.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot(snapshot, snapshot.project.id)?.project.id).toBe(snapshot.project.id);
});

test("formats unknown money without turning missing charges into zero", () => {
  expect(formatMoney(null, "EUR")).toBe("Unknown");
  expect(formatMoney(795000, "EUR")).toContain("7,950");
});

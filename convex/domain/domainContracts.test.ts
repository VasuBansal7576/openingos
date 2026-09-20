/**
 * F1 shared-domain contract tests (controlled, PRD section 30).
 *
 * Pure validator/predicate proofs: cycle-safe dependency input shape,
 * exact variant and evidence identity, immutable version/idempotency
 * key rules, ownerStandIn provenance preservation, no historical
 * order/payment copy in reuse contracts, and presence of every named
 * core record validator plus its handoff types.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTROLLED_COUNTERPARTY_ROLES,
  TEMPLATE_REUSE_COLLECTIONS,
  acceptanceLineInputValidator,
  approvalInputValidator,
  assetDocumentInputValidator,
  assetInputValidator,
  browserObservationValidator,
  candidateInputValidator,
  candidateVariantKey,
  compatibilityVerificationInputValidator,
  costEntryInputValidator,
  dependencyCreatesCycle,
  dependencyInputValidator,
  financialEvidenceRefValidator,
  inboundClassificationValidator,
  isActionableApproval,
  isReusableFreshness,
  isTerminalFulfillmentState,
  isTerminalRequirementState,
  jevDecisionValidator,
  locationInputValidator,
  negotiationInputValidator,
  normalizeLineQuantity,
  normalizeLineUnit,
  openAIDraftValidator,
  openAIExtractionValidator,
  orderEventInputValidator,
  orderInputValidator,
  orderLineInputValidator,
  outboundBriefValidator,
  productEvidenceInputValidator,
  projectEventInputValidator,
  providerProductEvidenceInputValidator,
  quoteUpdateValidator,
  requirementInputValidator,
  researchCollectionValidator,
  rfqInputValidator,
  riskInputValidator,
  scopedLineUnit,
  selectionInputValidator,
  selectionLineInputValidator,
  serviceCaseInputValidator,
  sortLinesById,
  templateInputValidator,
  templateReuseExcludesHistoricFinancials,
  uiProjectionValidator,
  vendorContactInputValidator,
  vendorInputValidator,
  watchInputValidator,
} from "../shared/domainContracts.js";

describe("cycle-safe dependency input shape", () => {
  test("self-edges always close a cycle", () => {
    expect(dependencyCreatesCycle([], "req-a", "req-a")).toBe(true);
  });

  test("direct back-edges close a cycle", () => {
    expect(
      dependencyCreatesCycle([{ from: "req-b", to: "req-a" }], "req-a", "req-b"),
    ).toBe(true);
  });

  test("indirect paths close a cycle", () => {
    const edges = [
      { from: "req-b", to: "req-c" },
      { from: "req-c", to: "req-a" },
    ];
    expect(dependencyCreatesCycle(edges, "req-a", "req-b")).toBe(true);
  });

  test("acyclic edges pass", () => {
    const edges = [{ from: "req-a", to: "req-b" }];
    expect(dependencyCreatesCycle(edges, "req-b", "req-c")).toBe(false);
    expect(dependencyCreatesCycle(edges, "req-a", "req-c")).toBe(false);
  });

  test("dependency input validator requires the typed edge shape", () => {
    expect(dependencyInputValidator.fields.kind).toBeDefined();
    expect(dependencyInputValidator.fields.fromRequirementId).toBeDefined();
    expect(dependencyInputValidator.fields.toRequirementId).toBeDefined();
  });
});

describe("exact variant and evidence identity", () => {
  const base = {
    requirementId: "req-1",
    productModel: "La Marzocco Linea Mini",
    vendorId: "vendor-1",
  };

  test("byte-different variants never collapse", () => {
    const left = candidateVariantKey({ ...base, variant: "  Black / 220V " });
    const right = candidateVariantKey({ ...base, variant: "black / 220v" });
    expect(left).not.toBe(right);
  });

  test("a different variant never merges", () => {
    const left = candidateVariantKey({ ...base, variant: "black / 220v" });
    const right = candidateVariantKey({ ...base, variant: "white / 220v" });
    expect(left).not.toBe(right);
  });

  test("the same variant from another seller is another identity", () => {
    const left = candidateVariantKey({ ...base, variant: "black" });
    const right = candidateVariantKey({ ...base, variant: "black", vendorId: "vendor-2" });
    expect(left).not.toBe(right);
  });

  test("candidate input carries no client compatibility claim", () => {
    const fields = Object.keys(candidateInputValidator.fields);
    expect(fields).not.toContain("compatibility");
    expect(fields).not.toContain("compatibilityEvidenceRefs");
    expect(candidateInputValidator.fields.conversationState).toBeDefined();
    expect(compatibilityVerificationInputValidator.fields.result).toBeDefined();
    expect(compatibilityVerificationInputValidator.fields.evidenceRefs).toBeDefined();
  });
});

describe("immutable version and idempotency keys", () => {
  test("requirements key on the creation shape", () => {
    expect(requirementInputValidator.fields.key).toBeDefined();
  });

  test("rfqs, orders, and cost entries carry idempotency keys", () => {
    expect(rfqInputValidator.fields.idempotencyKey).toBeDefined();
    expect(orderInputValidator.fields.idempotencyKey).toBeDefined();
    expect(costEntryInputValidator.fields.idempotencyKey).toBeDefined();
  });

  test("externally repeatable recorders carry idempotency keys", () => {
    expect(orderEventInputValidator.fields.idempotencyKey).toBeDefined();
    expect(assetInputValidator.fields.idempotencyKey).toBeDefined();
    expect(assetDocumentInputValidator.fields.idempotencyKey).toBeDefined();
    expect(serviceCaseInputValidator.fields.idempotencyKey).toBeDefined();
    expect(vendorContactInputValidator.fields.idempotencyKey).toBeDefined();
    expect(watchInputValidator.fields.idempotencyKey).toBeDefined();
    expect(productEvidenceInputValidator.fields.idempotencyKey).toBeDefined();
  });

  test("watches and risks carry allowance, schedule, and provenance links", () => {
    expect("jobId" in watchInputValidator.fields).toBe(true);
    expect("counterpartyRole" in watchInputValidator.fields).toBe(true);
    expect("dependencyIds" in riskInputValidator.fields).toBe(true);
  });

  test("approvals and templates bind immutable snapshot/version identity", () => {
    expect(approvalInputValidator.fields.snapshotHash).toBeDefined();
    expect(approvalInputValidator.fields.snapshotCanonical).toBeDefined();
    expect(templateInputValidator.fields.version).toBeDefined();
  });

  test("selections pin the exact quote version and requirement version", () => {
    expect(selectionInputValidator.fields.idempotencyKey).toBeDefined();
    expect(selectionInputValidator.fields.quoteVersion).toBeDefined();
    expect(selectionInputValidator.fields.requirementVersion).toBeDefined();
  });

  test("selections, orders, and events carry explicit line arrays with units", () => {
    expect(selectionLineInputValidator.fields.quoteLineId).toBeDefined();
    expect(selectionLineInputValidator.fields.quantity).toBeDefined();
    expect(selectionLineInputValidator.fields.unit).toBeDefined();
    expect(orderLineInputValidator.fields.quoteLineId).toBeDefined();
    expect(orderLineInputValidator.fields.quantity).toBeDefined();
    expect(orderLineInputValidator.fields.unit).toBeDefined();
    expect(acceptanceLineInputValidator.fields.quoteLineId).toBeDefined();
    expect(acceptanceLineInputValidator.fields.acceptedQuantity).toBeDefined();
    expect(acceptanceLineInputValidator.fields.unit).toBeDefined();
    expect("selectionLines" in selectionInputValidator.fields).toBe(true);
    expect("orderLines" in orderInputValidator.fields).toBe(true);
    expect("acceptanceLines" in orderEventInputValidator.fields).toBe(true);
  });

  test("cost entries carry line, affected quantity, and evidence lineage", () => {
    expect("quoteLineId" in costEntryInputValidator.fields).toBe(true);
    expect("affectedQuantity" in costEntryInputValidator.fields).toBe(true);
    expect("affectedUnit" in costEntryInputValidator.fields).toBe(true);
    expect("evidenceRefs" in costEntryInputValidator.fields).toBe(true);
    expect(financialEvidenceRefValidator.fields.evidenceId).toBeDefined();
    expect(financialEvidenceRefValidator.fields.contentHash).toBeDefined();
  });

  test("line normalization keeps canonical decimals and requires units", () => {
    expect(normalizeLineQuantity("2.0", "qty")).toBe("2");
    expect(normalizeLineQuantity("8.00", "qty")).toBe("8");
    expect(normalizeLineUnit(" piece ", "unit")).toBe("piece");
    expect(() => normalizeLineQuantity("0", "qty")).toThrow();
    expect(() => normalizeLineQuantity("abc", "qty")).toThrow();
    expect(() => normalizeLineUnit("  ", "unit")).toThrow();
  });

  test("line replay order is deterministic and scope units resolve", () => {
    const lines = [
      { quoteLineId: "machine", quantity: "2", unit: "piece" },
      { quoteLineId: "chair", quantity: "10", unit: "piece" },
    ];
    expect(sortLinesById([...lines].reverse()).map((line) => line.quoteLineId)).toEqual([
      "chair",
      "machine",
    ]);
    expect(
      scopedLineUnit(
        { items: [{ lineId: "machine", unit: "piece" }] },
        "machine",
      ),
    ).toBe("piece");
    expect(
      scopedLineUnit(
        { items: [{ lineId: "machine", unit: "piece" }] },
        "ghost",
      ),
    ).toBeUndefined();
    expect(scopedLineUnit(undefined, "machine")).toBeUndefined();
  });
});

describe("closed counterparty provenance", () => {
  test("the controlled label set is fixed and explicit", () => {
    expect([...CONTROLLED_COUNTERPARTY_ROLES]).toEqual(["ownerStandIn", "userImport"]);
  });

  test("product evidence input declares the closed union explicitly", () => {
    const fields = Object.keys(productEvidenceInputValidator.fields);
    expect(fields).toContain("counterpartyRole");
    expect(fields).toContain("idempotencyKey");
    expect(fields).not.toContain("executionMode");
    expect(fields).not.toContain("origin");
    expect(fields).not.toContain("providerIds");
    expect(providerProductEvidenceInputValidator.fields.executionMode).toBeDefined();
  });
});

describe("no historical order/payment copy in reuse contracts", () => {
  test("reuse scope is requirements and constraints only", () => {
    expect([...TEMPLATE_REUSE_COLLECTIONS]).toEqual(["requirements", "constraints"]);
  });

  test("financial collections are excluded from reuse", () => {
    expect(templateReuseExcludesHistoricFinancials([...TEMPLATE_REUSE_COLLECTIONS])).toBe(true);
    expect(
      templateReuseExcludesHistoricFinancials(["requirements", "orders"]),
    ).toBe(false);
    expect(
      templateReuseExcludesHistoricFinancials(["constraints", "costEntries"]),
    ).toBe(false);
    expect(
      templateReuseExcludesHistoricFinancials(["requirements", "payments"]),
    ).toBe(false);
    expect(
      templateReuseExcludesHistoricFinancials(["requirements", "orderEvents"]),
    ).toBe(false);
  });
});

describe("state discriminants", () => {
  test("terminal requirement states close sourcing", () => {
    expect(isTerminalRequirementState("selected")).toBe(true);
    expect(isTerminalRequirementState("fulfilled")).toBe(true);
    expect(isTerminalRequirementState("cancelled")).toBe(true);
    expect(isTerminalRequirementState("sourcing")).toBe(false);
    expect(isTerminalRequirementState("readyForDecision")).toBe(false);
  });

  test("terminal fulfillment states close quantity tracking", () => {
    expect(isTerminalFulfillmentState("commissioned")).toBe(true);
    expect(isTerminalFulfillmentState("cancelled")).toBe(true);
    expect(isTerminalFulfillmentState("delivered")).toBe(false);
  });

  test("only approved decisions authorize actions", () => {
    expect(isActionableApproval("pending")).toBe(false);
    expect(isActionableApproval("approved")).toBe(true);
    expect(isActionableApproval("rejected")).toBe(false);
    expect(isActionableApproval("invalidated")).toBe(false);
  });

  test("only fresh evidence reuses without re-verification", () => {
    expect(isReusableFreshness("fresh")).toBe(true);
    expect(isReusableFreshness("stale")).toBe(false);
    expect(isReusableFreshness("expired")).toBe(false);
    expect(isReusableFreshness("unknown")).toBe(false);
  });
});

describe("every named core record has a creation contract", () => {
  test("all twenty-one record validators are exported", () => {
    const validators = [
      locationInputValidator,
      requirementInputValidator,
      dependencyInputValidator,
      candidateInputValidator,
      productEvidenceInputValidator,
      vendorInputValidator,
      vendorContactInputValidator,
      rfqInputValidator,
      negotiationInputValidator,
      selectionInputValidator,
      approvalInputValidator,
      orderInputValidator,
      orderEventInputValidator,
      costEntryInputValidator,
      assetInputValidator,
      assetDocumentInputValidator,
      serviceCaseInputValidator,
      watchInputValidator,
      projectEventInputValidator,
      riskInputValidator,
      templateInputValidator,
    ];
    expect(validators).toHaveLength(21);
    for (const validator of validators) {
      expect(validator.fields.organizationId).toBeDefined();
    }
    // Organization-scoped records carry no project: locations bind
    // projects through attachProject, vendors serve every project, and
    // vendor contacts describe a vendor's channels org-wide. Templates
    // are organization-owned with the source project kept as a
    // derivable parent reference.
    expect("projectId" in locationInputValidator.fields).toBe(false);
    expect("projectId" in vendorInputValidator.fields).toBe(false);
    expect("projectId" in vendorContactInputValidator.fields).toBe(false);
    expect("projectId" in templateInputValidator.fields).toBe(false);
    expect("sourceProjectId" in templateInputValidator.fields).toBe(true);
    const projectScoped = validators.filter(
      (validator) =>
        validator !== locationInputValidator &&
        validator !== vendorInputValidator &&
        validator !== vendorContactInputValidator &&
        validator !== templateInputValidator,
    );
    expect(projectScoped).toHaveLength(17);
    for (const validator of projectScoped) {
      expect("projectId" in validator.fields).toBe(true);
    }
  });

  test("every typed handoff validator is exported", () => {
    const handoffs = [
      researchCollectionValidator,
      browserObservationValidator,
      jevDecisionValidator,
      openAIExtractionValidator,
      openAIDraftValidator,
      outboundBriefValidator,
      inboundClassificationValidator,
      quoteUpdateValidator,
      uiProjectionValidator,
    ];
    expect(handoffs).toHaveLength(9);
    for (const handoff of handoffs) {
      expect(handoff.fields).toBeDefined();
    }
  });

  test("handoffs carry tenancy so R1/C1/U1 cannot float workspaces", () => {
    const handoffs = [
      researchCollectionValidator,
      browserObservationValidator,
      jevDecisionValidator,
      openAIExtractionValidator,
      openAIDraftValidator,
      outboundBriefValidator,
      inboundClassificationValidator,
      quoteUpdateValidator,
      uiProjectionValidator,
    ];
    for (const handoff of handoffs) {
      expect("organizationId" in handoff.fields).toBe(true);
      expect("projectId" in handoff.fields).toBe(true);
    }
  });

  test("handoffs bind versions, status, provenance, and exact terms", () => {
    expect("inputVersion" in researchCollectionValidator.fields).toBe(true);
    expect("completeness" in researchCollectionValidator.fields).toBe(true);
    expect("status" in browserObservationValidator.fields).toBe(true);
    expect("evidenceRefs" in browserObservationValidator.fields).toBe(true);
    expect("inputVersion" in openAIExtractionValidator.fields).toBe(true);
    expect("evidenceRefs" in openAIExtractionValidator.fields).toBe(true);
    expect("status" in openAIDraftValidator.fields).toBe(true);
    // Scenario vendors are context, never transport authority.
    expect("scenarioVendorIds" in outboundBriefValidator.fields).toBe(true);
    expect("recipientVendorIds" in outboundBriefValidator.fields).toBe(false);
    expect("counterpartyRole" in inboundClassificationValidator.fields).toBe(true);
    expect("status" in inboundClassificationValidator.fields).toBe(true);
    expect("contentHash" in quoteUpdateValidator.fields).toBe(true);
    expect("status" in uiProjectionValidator.fields).toBe(true);
  });

  test("rfq vendors are scenario context with line items and binding", () => {
    expect("scenarioVendorIds" in rfqInputValidator.fields).toBe(true);
    expect("recipientVendorIds" in rfqInputValidator.fields).toBe(false);
    expect("lineItems" in rfqInputValidator.fields).toBe(true);
    expect("conversationId" in rfqInputValidator.fields).toBe(true);
  });
});

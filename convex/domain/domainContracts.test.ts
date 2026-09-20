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
  TEMPLATE_REUSE_COLLECTIONS,
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
  inboundClassificationValidator,
  isActionableApproval,
  isControlledCounterparty,
  isReusableFreshness,
  isTerminalFulfillmentState,
  isTerminalRequirementState,
  jevDecisionValidator,
  locationInputValidator,
  negotiationInputValidator,
  openAIDraftValidator,
  openAIExtractionValidator,
  orderEventInputValidator,
  orderInputValidator,
  outboundBriefValidator,
  preserveCounterpartyRole,
  productEvidenceInputValidator,
  projectEventInputValidator,
  quoteUpdateValidator,
  requirementInputValidator,
  researchCollectionValidator,
  rfqInputValidator,
  riskInputValidator,
  selectionInputValidator,
  serviceCaseInputValidator,
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

  test("approvals and templates bind immutable snapshot/version identity", () => {
    expect(approvalInputValidator.fields.snapshotHash).toBeDefined();
    expect(approvalInputValidator.fields.snapshotCanonical).toBeDefined();
    expect(templateInputValidator.fields.version).toBeDefined();
  });

  test("selections pin the exact quote version and requirement version", () => {
    expect(selectionInputValidator.fields.quoteVersion).toBeDefined();
    expect(selectionInputValidator.fields.requirementVersion).toBeDefined();
  });
});

describe("ownerStandIn provenance preservation", () => {
  test("owner-authored roles pass through unchanged", () => {
    expect(preserveCounterpartyRole("ownerStandIn")).toBe("ownerStandIn");
    expect(preserveCounterpartyRole("vendor")).toBe("vendor");
  });

  test("controlled counterparties stay labeled", () => {
    expect(isControlledCounterparty("ownerStandIn")).toBe(true);
    expect(isControlledCounterparty("userImport")).toBe(true);
    expect(isControlledCounterparty("vendor")).toBe(false);
  });

  test("product evidence input carries no client provenance field", () => {
    const fields = Object.keys(productEvidenceInputValidator.fields);
    expect(fields).not.toContain("counterpartyRole");
    expect(fields).not.toContain("executionMode");
    expect(fields).not.toContain("providerIds");
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
    // projects through attachProject, and vendors serve every project in
    // the organization. Templates are organization-owned with the source
    // project kept as a derivable parent reference.
    expect("projectId" in locationInputValidator.fields).toBe(false);
    expect("projectId" in vendorInputValidator.fields).toBe(false);
    expect("projectId" in templateInputValidator.fields).toBe(false);
    expect("sourceProjectId" in templateInputValidator.fields).toBe(true);
    const projectScoped = validators.filter(
      (validator) =>
        validator !== locationInputValidator &&
        validator !== vendorInputValidator &&
        validator !== templateInputValidator,
    );
    expect(projectScoped).toHaveLength(18);
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
});

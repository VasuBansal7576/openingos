/// <reference types="vite/client" />

/**
 * Focused scope-gate tests for the narrow semantic contract
 * (Astra finding 1): purchasing/opening action intent plus a supported
 * coffee-shop real-estate/equipment/supplier object intent.
 *
 * Pure classifier tests only: no grants, jobs, reservations, operations,
 * schedules, or provider effects. Zero-effect refusal is covered by the
 * authority-blocker suite; this file pins the accept/refuse boundary,
 * including the three named adversarial briefs and close variants.
 * Unrelated primary-intent wrappers refuse even when they borrow
 * source/equipment tokens.
 */

import { describe, expect, test } from "vitest";
import { classifyOpeningBriefForResearch } from "./researchScope.js";

const SF_BRIEF =
  "Open a coffee shop in San Francisco; rent a place and buy everything needed for the coffee shop; budget USD 250,000-500,000.";

function verdict(text: string): string {
  return classifyOpeningBriefForResearch(text).verdict;
}

describe("narrow semantic scope contract", () => {
  test("supports the exact SF owner brief and punctuation variants", () => {
    expect(verdict(SF_BRIEF)).toBe("supported");
    expect(
      verdict(
        "Open a coffee shop in San Francisco. Rent a place and buy everything needed. Budget USD 250,000-500,000.",
      ),
    ).toBe("supported");
    expect(
      verdict(
        "Open a coffee shop in San Francisco! Rent a place and buy everything needed! Budget USD 250,000-500,000!",
      ),
    ).toBe("supported");
    expect(
      verdict(`Primary region: San Francisco, CA\nOpening brief: ${SF_BRIEF}`),
    ).toBe("supported");
  });

  test("supports legitimate terse purchasing briefs", () => {
    expect(
      verdict("Open a café on the Northside; rent a place and buy everything needed."),
    ).toBe("supported");
    expect(
      verdict("Open a second counter; rent a place and buy everything needed."),
    ).toBe("supported");
    expect(
      verdict("Open another tenant workspace; rent a place and buy everything needed."),
    ).toBe("supported");
    expect(verdict("Source a two-group espresso machine for the Northside cafe")).toBe(
      "supported",
    );
    // Legacy/test fixture title fallback without a stored brief.
    expect(verdict("Two-group espresso machine\nequipment")).toBe("supported");
  });

  test("refuses the named adversarial briefs with zero authority", () => {
    expect(verdict("Write a poem about coffee in the Netherlands")).toBe(
      "unrelatedRefused",
    );
    expect(
      verdict("Explain quantum entanglement using coffee equipment analogies"),
    ).toBe("unrelatedRefused");
    expect(verdict("Book a vacation in Hawaii with a coffee budget")).toBe(
      "unrelatedRefused",
    );
  });

  test("refuses close variants of the adversarial briefs", () => {
    for (const variant of [
      "Write a poem about coffee in the Netherlands.",
      "write a poem about coffee in the netherlands",
      "Explain quantum entanglement",
      "Explain quantum entanglement using espresso equipment analogies.",
      "explain quantum entanglement with coffee equipment analogies",
      "Book a vacation in Hawaii",
      "Book a vacation in Hawaii with a coffee budget for the team.",
      "book a vacation in hawaii with a coffee budget",
      `Primary region: Hawaii\nOpening brief: Book a vacation in Hawaii with a coffee budget`,
      `Primary region: San Francisco, CA\nOpening brief: Explain quantum entanglement`,
    ]) {
      expect(verdict(variant)).toBe("unrelatedRefused");
    }
  });

  test("refuses unrelated primary-intent wrappers even with source/equipment tokens", () => {
    for (const wrapper of [
      "Explain how to source coffee equipment analogies",
      "Explain how to source coffee equipment analogies.",
      "Book a vacation and source espresso equipment in Hawaii",
      "Book a vacation and source espresso equipment in Hawaii.",
      "book a vacation and source espresso equipment in hawaii",
      `Primary region: Hawaii\nOpening brief: Book a vacation and source espresso equipment in Hawaii`,
    ]) {
      expect(verdict(wrapper)).toBe("unrelatedRefused");
    }
  });

  test("bare nouns alone never authorize", () => {
    expect(verdict("coffee")).toBe("unrelatedRefused");
    expect(verdict("Netherlands")).toBe("unrelatedRefused");
    expect(verdict("budget")).toBe("unrelatedRefused");
    expect(verdict("")).toBe("unrelatedRefused");
    expect(verdict("   ")).toBe("unrelatedRefused");
  });
});

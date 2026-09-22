/**
 * Allowance parsing tests for the narrowly scoped shared-budget module.
 *
 * The server-only allowance funds a fresh organization's capped ledger and
 * nothing else: it is never exposed to the browser, and an existing ledger
 * is never refilled. These pure parsing checks run under `bun test` with no
 * database or provider access.
 */

import { describe, expect, test } from "bun:test";
import {
  parseResearchAllowance,
  RESEARCH_ALLOWANCE_ENV_VAR,
  RESEARCH_ALLOWANCE_MAX_MICRO_USD,
  RESEARCH_ALLOWANCE_PRICING_BASIS,
} from "./allowance.js";

const MINIMUM = 25_000;

describe("research allowance parsing", () => {
  test("accepts a capped integer allowance covering one bounded call", () => {
    expect(parseResearchAllowance("100000", MINIMUM)).toEqual({
      ok: true,
      ceilingMicroUsd: 100000,
    });
    expect(parseResearchAllowance(String(MINIMUM), MINIMUM)).toEqual({
      ok: true,
      ceilingMicroUsd: MINIMUM,
    });
    expect(parseResearchAllowance(`  ${MINIMUM}  `, MINIMUM)).toEqual({
      ok: true,
      ceilingMicroUsd: MINIMUM,
    });
  });

  test("rejects a missing, blank, or non-integer allowance", () => {
    for (const raw of [undefined, null, "", "   ", "not-a-number", "12.5", "0x10", "-5", "10,000"]) {
      const parsed = parseResearchAllowance(raw, MINIMUM);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("allowance-exhausted");
    }
  });

  test("rejects a zero, below-minimum, or over-cap allowance", () => {
    for (const raw of ["0", "1", String(MINIMUM - 1), String(RESEARCH_ALLOWANCE_MAX_MICRO_USD + 1)]) {
      const parsed = parseResearchAllowance(raw, MINIMUM);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("allowance-exhausted");
    }
    expect(parseResearchAllowance(String(RESEARCH_ALLOWANCE_MAX_MICRO_USD), MINIMUM).ok).toBe(true);
  });

  test("the allowance value stays server-only", () => {
    expect(RESEARCH_ALLOWANCE_ENV_VAR).toBe("RESEARCH_PROVIDER_ALLOWANCE_MICRO_USD");
    expect(RESEARCH_ALLOWANCE_ENV_VAR.startsWith("NEXT_PUBLIC_")).toBe(false);
    expect(RESEARCH_ALLOWANCE_ENV_VAR.startsWith("VITE_")).toBe(false);
    expect(RESEARCH_ALLOWANCE_PRICING_BASIS.trim().length).toBeGreaterThan(0);
  });
});

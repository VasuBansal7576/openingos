/**
 * E7 pure CSV parser tests (controlled, P-24).
 *
 * Covers the documented supported template boundary: valid parsing with
 * deterministic normalization, quoted commas/newlines, BOM policy, invalid
 * UTF-8, malformed quoting, duplicate/missing/unknown headers, blank and
 * formula-injection cells, safe integer and quantity validation, and all
 * bounds including bound-plus-one. Pure only: no Convex context, no
 * persistence, no provider calls.
 */

import { describe, expect, test } from "bun:test";
import {
  EQUIPMENT_CSV_HEADERS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CELL_BYTES,
  IMPORT_MAX_ROWS,
  decodeEquipmentCsvBytes,
  equipmentCsvRowKey,
  parseEquipmentCsv,
  promotedRequirementKey,
  validateDraftRowForPromotion,
  type EquipmentCsvDraftRow,
} from "./equipmentCsv.js";

const encoder = new TextEncoder();

const HEADER = EQUIPMENT_CSV_HEADERS.join(",");

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

function validRow(overrides: Partial<Record<string, string>> = {}): string {
  const values: Record<string, string> = {
    title: "Espresso machine",
    category: "kitchen",
    quantity: "2",
    unit: "piece",
    priority: "P0",
    budgetMinorUnits: "150000",
    currency: "EUR",
    needByAt: "2026-10-01",
    hardConstraints: "220V outlet",
    responsible: "Vasu",
    ...overrides,
  };
  return EQUIPMENT_CSV_HEADERS.map((header) => values[header] ?? "").join(",");
}

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function planOf(text: string) {
  const decoded = decodeEquipmentCsvBytes(bytesOf(text));
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.message}`);
  const parsed = parseEquipmentCsv(decoded.text);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.message}`);
  return parsed.plan;
}

function validRowsOf(text: string): EquipmentCsvDraftRow[] {
  return planOf(text).rows
    .filter((entry) => entry.status === "valid")
    .map((entry) => (entry.status === "valid" ? entry.row : neverHappens()));
}

function neverHappens(): never {
  throw new Error("unreachable");
}

describe("E7 valid template parsing and deterministic normalization", () => {
  test("parses a full valid document and normalizes deterministically", () => {
    const rows = validRowsOf(csv(validRow()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      title: "Espresso machine",
      category: "kitchen",
      quantity: "2",
      unit: "piece",
      priority: "P0",
      budgetMinorUnits: 150000,
      currency: "EUR",
      needByAt: Date.UTC(2026, 9, 1),
      hardConstraints: "220V outlet",
      responsible: "Vasu",
    });
  });

  test("normalization is deterministic: trims, canonical quantity, upper-case currency", () => {
    const first = validRowsOf(csv(validRow({ title: "  Grinder  ", quantity: "2.50", currency: "eur" })));
    const second = validRowsOf(csv(validRow({ title: "Grinder", quantity: "2.5", currency: "EUR" })));
    expect(first[0]?.title).toBe("Grinder");
    expect(first[0]?.quantity).toBe("2.5");
    expect(first[0]?.currency).toBe("EUR");
    expect(first[0]).toEqual(second[0]);
  });

  test("optional columns may be empty", () => {
    const rows = validRowsOf(csv("Mixer,kitchen,1,piece,P2,,,,,"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.budgetMinorUnits).toBeUndefined();
    expect(rows[0]?.currency).toBeUndefined();
    expect(rows[0]?.needByAt).toBeUndefined();
  });

  test("quoted commas, newlines, and escaped quotes parse as data", () => {
    const rows = validRowsOf(csv('"Blender, 1200W","kitchen","1",piece,P1,"",,,"Watts ""peak""",'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Blender, 1200W");
    expect(rows[0]?.hardConstraints).toBe('Watts "peak"');
  });

  test("quoted newlines stay inside one cell and one row", () => {
    const rows = validRowsOf(csv('"Multi\nline\ntitle",kitchen,1,piece,P0,,,,,'));
    expect(planOf(csv('"Multi\nline\ntitle",kitchen,1,piece,P0,,,,,')).validCount).toBe(1);
    expect(rows[0]?.title).toBe("Multi\nline\ntitle");
  });
});

describe("E7 encoding and BOM policy", () => {
  test("a single leading UTF-8 BOM is kept in the lossless source and stripped for parsing", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(csv(validRow()))]);
    const decoded = decodeEquipmentCsvBytes(withBom);
    if (!decoded.ok) throw new Error("decode failed");
    // Lossless: re-encoding the decoded text reproduces the exact bytes.
    expect(Array.from(encoder.encode(decoded.text))).toEqual(Array.from(withBom));
    // The parse view strips the BOM.
    const parsed = parseEquipmentCsv(decoded.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.validCount).toBe(1);
    expect(parsed.plan.rows[0]?.status).toBe("valid");
  });

  test("parsed text with a literal BOM character parses with the BOM stripped", () => {
    const parsed = parseEquipmentCsv("﻿" + csv(validRow()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.validCount).toBe(1);
  });

  test("invalid UTF-8 bytes reject the whole input", () => {
    const bad = new Uint8Array([0x61, 0x2c, 0x62, 0xff, 0xfe, 0x0a]);
    const decoded = decodeEquipmentCsvBytes(bad);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.message).toContain("UTF-8");
  });

  test("empty input is rejected", () => {
    expect(decodeEquipmentCsvBytes(new Uint8Array(0)).ok).toBe(false);
  });
});

describe("E7 header contract", () => {
  test("duplicate headers are rejected", () => {
    const text = `${HEADER},title\nA,kitchen,1,piece,P0,,,,,\n`;
    const parsed = parseEquipmentCsv(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("duplicate header");
  });

  test("missing headers are rejected", () => {
    const text = "title,category,quantity,unit,priority\nA,kitchen,1,piece,P0\n";
    const parsed = parseEquipmentCsv(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("missing header");
  });

  test("unknown headers are rejected", () => {
    const text = `${HEADER},mystery\n${validRow()},x\n`;
    const parsed = parseEquipmentCsv(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("unknown header");
  });

  test("malformed quoting in the header row is rejected", () => {
    const parsed = parseEquipmentCsv(`ti"tle,category,quantity,unit,priority,budgetMinorUnits,currency,needByAt,hardConstraints,responsible\nA,kitchen,1,piece,P0,,,,,\n`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("malformed quoting in the header");
  });

  test("a document without a header row is rejected", () => {
    const parsed = parseEquipmentCsv("A,kitchen,1,piece,P0,,,,,\n");
    expect(parsed.ok).toBe(false);
  });
});

describe("E7 quoting defects", () => {
  test("unterminated quotes fail the document", () => {
    const parsed = parseEquipmentCsv(csv('"Unterminated,kitchen,1,piece,P0,,,,,'));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("malformed quoting");
  });

  test("malformed quoting is reported row-locally and never silently dropped", () => {
    const parsed = parseEquipmentCsv(csv(validRow(), '"Bad"x,kitchen,1,piece,P0,,,,,'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.invalidCount).toBe(1);
    const bad = parsed.plan.rows.find((entry) => entry.rowIndex === 2);
    expect(bad?.status).toBe("invalid");
  });
});

describe("E7 cell validation", () => {
  test("blank required cells are row errors", () => {
    const plan = planOf(csv(",,1,piece,P0,,,,,"));
    expect(plan.invalidCount).toBe(1);
    const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(errors.some((error) => error.column === "title")).toBe(true);
    expect(errors.some((error) => error.column === "category")).toBe(true);
  });

  test("blank rows are explicit invalid entries, not dropped", () => {
    const plan = planOf(csv(validRow(), "", validRow()));
    expect(plan.rows).toHaveLength(3);
    expect(plan.rows[1]?.status).toBe("invalid");
    expect(plan.validCount).toBe(2);
  });

  test("formula-injection cells are rejected in text columns", () => {
    for (const poison of ["=cmd", "+31", "@risk", "-lead"]) {
      const plan = planOf(csv(validRow({ title: poison })));
      const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
      expect(errors.some((error) => error.message.includes("formula-injection"))).toBe(true);
    }
  });

  test("invalid quantities are rejected: non-finite, non-decimal, zero, negative, exponent", () => {
    for (const bad of ["abc", "NaN", "Infinity", "0", "-1", "1e3", "1.2.3", ""]) {
      const plan = planOf(csv(validRow({ quantity: bad })));
      const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
      expect(errors.some((error) => error.column === "quantity"), `quantity "${bad}"`).toBe(true);
    }
  });

  test("budget must be a non-negative safe integer and requires currency", () => {
    for (const bad of ["-1", "1.5", "abc", "9007199254740992"]) {
      const plan = planOf(csv(validRow({ budgetMinorUnits: bad })));
      const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
      expect(errors.some((error) => error.column === "budgetMinorUnits"), `budget "${bad}"`).toBe(true);
    }
    const noCurrency = planOf(csv(validRow({ currency: "" })));
    const noCurrencyErrors = noCurrency.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(noCurrencyErrors.some((error) => error.column === "currency")).toBe(true);
  });

  test("invalid currency and needByAt are rejected", () => {
    const plan = planOf(csv(validRow({ currency: "EURO" })));
    const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(errors.some((error) => error.column === "currency")).toBe(true);

    for (const badDate of ["2026-13-01", "01-01-2026", "not-a-date"]) {
      const dated = planOf(csv(validRow({ needByAt: badDate })));
      const datedErrors = dated.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
      expect(datedErrors.some((error) => error.column === "needByAt"), `date "${badDate}"`).toBe(true);
    }
  });

  test("unsupported units and priorities are rejected", () => {
    const unitPlan = planOf(csv(validRow({ unit: "furlong" })));
    const unitErrors = unitPlan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(unitErrors.some((error) => error.column === "unit")).toBe(true);

    const priorityPlan = planOf(csv(validRow({ priority: "P3" })));
    const priorityErrors = priorityPlan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(priorityErrors.some((error) => error.column === "priority")).toBe(true);
  });
});

describe("E7 bounds", () => {
  test("overlong cells are rejected", () => {
    const longTitle = "A".repeat(IMPORT_MAX_CELL_BYTES + 1);
    const plan = planOf(csv(validRow({ title: longTitle })));
    const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(errors.some((error) => error.message.includes("cell size"))).toBe(true);
  });

  test("overlong titles beyond the requirement contract are rejected", () => {
    const plan = planOf(csv(validRow({ title: "A".repeat(300) })));
    const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(errors.some((error) => error.column === "title")).toBe(true);
  });

  test("oversized inputs are rejected before parsing", () => {
    const oversized = "x".repeat(IMPORT_MAX_BYTES + 1);
    const decoded = decodeEquipmentCsvBytes(bytesOf(oversized));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.message).toContain("bound");
  });

  test("column-count mismatches are row errors", () => {
    const plan = planOf(csv("OnlyThree,Cells,Here"));
    expect(plan.invalidCount).toBe(1);
    const errors = plan.rows.flatMap((entry) => entry.status === "invalid" ? entry.errors : []);
    expect(errors.some((error) => error.message.includes("cells"))).toBe(true);
  });

  test("bound-plus-one rows reject the extra data instead of truncating", () => {
    const rows: string[] = [];
    for (let index = 0; index < IMPORT_MAX_ROWS + 1; index += 1) {
      rows.push(`Machine ${index},kitchen,1,piece,P1,,,,,`);
    }
    const parsed = parseEquipmentCsv(csv(...rows));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("import bound");
  });

  test("exactly the row bound parses completely", () => {
    const rows: string[] = [];
    for (let index = 0; index < IMPORT_MAX_ROWS; index += 1) {
      rows.push(`Machine ${index},kitchen,1,piece,P1,,,,,`);
    }
    const plan = planOf(csv(...rows));
    expect(plan.validCount).toBe(IMPORT_MAX_ROWS);
    expect(plan.rows).toHaveLength(IMPORT_MAX_ROWS);
  });
});

describe("E7 review identity", () => {
  test("row keys depend only on source hash and row index", () => {
    expect(equipmentCsvRowKey("abc", 1)).toBe(equipmentCsvRowKey("abc", 1));
    expect(equipmentCsvRowKey("abc", 1)).not.toBe(equipmentCsvRowKey("abc", 2));
    expect(equipmentCsvRowKey("abc", 1)).not.toBe(equipmentCsvRowKey("abd", 1));
  });

  test("promotion keys are deterministic, unique per row, and bounded", () => {
    expect(promotedRequirementKey("a".repeat(64), 3)).toBe(promotedRequirementKey("a".repeat(64), 3));
    expect(promotedRequirementKey("a".repeat(64), 3)).not.toBe(promotedRequirementKey("a".repeat(64), 4));
    expect(promotedRequirementKey("a".repeat(64), 3).length).toBeLessThanOrEqual(128);
  });

  test("promotion re-validation accepts a normalized row and rejects tampering", () => {
    const row: EquipmentCsvDraftRow = {
      title: "Grinder",
      category: "kitchen",
      quantity: "2",
      unit: "piece",
      priority: "P1",
      budgetMinorUnits: 100,
      currency: "EUR",
    };
    expect(validateDraftRowForPromotion(row).ok).toBe(true);
    const tampered = { ...row, quantity: "two" };
    expect(validateDraftRowForPromotion(tampered).ok).toBe(false);
    const badUnit = { ...row, unit: "furlong" };
    expect(validateDraftRowForPromotion(badUnit).ok).toBe(false);
  });
});

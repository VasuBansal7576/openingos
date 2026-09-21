/**
 * E7 supported equipment CSV import: pure parser and typed review plan
 * (controlled contract, P-24).
 *
 * This module parses ONLY the documented supported equipment CSV template:
 * strict UTF-8 (with a single leading UTF-8 BOM stripped, documented
 * policy), RFC-4180-style quoting, an exact header contract, bounded rows,
 * columns, cells and total bytes. Every violation is reported — malformed
 * quoting, duplicate/missing/unknown headers, blank or formula-injection
 * cells, overlong fields, non-finite or invalid quantities and budgets,
 * unsupported units/priorities — and invalid rows are never silently
 * dropped: the plan carries one entry per data row.
 *
 * Normalization of accepted rows is deterministic, and the row identity
 * (`equipmentCsvRowKey`) is derived from the immutable source content hash
 * plus the row index, so a review action can re-parse the stored source
 * and promote exactly the same rows the contributor selected. This module
 * is pure: no Convex context, no persistence, no provider calls.
 */

import {
  REQUIREMENT_CATEGORY_MAX_LENGTH,
  REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
  REQUIREMENT_RESPONSIBLE_MAX_LENGTH,
  REQUIREMENT_TITLE_MAX_LENGTH,
  REQUIREMENT_UNIT_MAX_LENGTH,
  normalizeBoundedText,
  normalizeRequirementDate,
} from "../shared/domainContracts.js";
import { decimalToString, quantity } from "../../proofs/money/decimal.js";
import { currencyCode, money } from "../../proofs/money/money.js";
import { canonicalJson } from "../shared/hashing.js";
import { sha256HexSync } from "../shared/sha256.js";

/** Total input bound: nothing above this size is parsed at all. */
export const IMPORT_MAX_BYTES = 262_144;
/** Maximum data rows (excluding the header) accepted per import. */
export const IMPORT_MAX_ROWS = 500;
/** Maximum columns per row: exactly the documented template header count. */
export const IMPORT_MAX_COLUMNS = 10;
/** Maximum encoded size of one cell. */
export const IMPORT_MAX_CELL_BYTES = 1024;
/** Maximum selected rows per review action. */
export const IMPORT_MAX_SELECTED_ROWS = IMPORT_MAX_ROWS;

/** Evidence `sourceKind` recorded for equipment CSV imports. */
export const EQUIPMENT_CSV_SOURCE_KIND = "equipmentCsvImport";
/** Evidence `sourceKind` recorded for quote/manual attachment imports. */
export const ATTACHMENT_SOURCE_KIND = "quoteAttachmentImport";

/**
 * The documented template header. The header row must contain exactly
 * these names — any order, but no missing, duplicate, or unknown names.
 * Required columns: title, category, quantity, unit, priority.
 * Optional columns: budgetMinorUnits (requires currency), currency,
 * needByAt (ISO date), hardConstraints, responsible.
 */
export const EQUIPMENT_CSV_HEADERS = [
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
] as const;

export type EquipmentCsvHeader = (typeof EQUIPMENT_CSV_HEADERS)[number];

const REQUIRED_HEADERS: readonly string[] = [
  "title",
  "category",
  "quantity",
  "unit",
  "priority",
];

/**
 * Documented unit vocabulary for the supported template. Units are
 * trimmed and lower-cased before comparison; anything outside this set
 * is rejected as unsupported rather than guessed.
 */
export const SUPPORTED_EQUIPMENT_UNITS = [
  "piece",
  "unit",
  "box",
  "pack",
  "set",
  "kg",
  "litre",
  "metre",
  "m2",
  "m3",
  "hour",
  "day",
] as const;

const SUPPORTED_UNITS_SET: ReadonlySet<string> = new Set(SUPPORTED_EQUIPMENT_UNITS);

const SUPPORTED_PRIORITIES: readonly string[] = ["P0", "P1", "P2"];

/** A single accepted, deterministically normalized draft row. */
export interface EquipmentCsvDraftRow {
  readonly title: string;
  readonly category: string;
  /** Canonical decimal string from the proofs/money contract. */
  readonly quantity: string;
  readonly unit: string;
  readonly priority: "P0" | "P1" | "P2";
  readonly budgetMinorUnits?: number;
  readonly currency?: string;
  /** Epoch milliseconds for an ISO YYYY-MM-DD cell. */
  readonly needByAt?: number;
  readonly hardConstraints?: string;
  readonly responsible?: string;
}

export interface EquipmentCsvCellError {
  readonly column?: string;
  readonly message: string;
}

/** One entry per data row — valid or invalid. Invalid rows are explicit. */
export type EquipmentCsvRowPlan =
  | { readonly rowIndex: number; readonly status: "valid"; readonly row: EquipmentCsvDraftRow }
  | {
    readonly rowIndex: number;
    readonly status: "invalid";
    readonly errors: readonly EquipmentCsvCellError[];
  };

export interface EquipmentCsvPlan {
  readonly rows: readonly EquipmentCsvRowPlan[];
  readonly validCount: number;
  readonly invalidCount: number;
}

/** A document-level import rejection; row-level problems live in the plan. */
export interface EquipmentCsvImportFailure {
  readonly ok: false;
  readonly code: "invalid-payload";
  readonly message: string;
}

export type EquipmentCsvParseOutcome =
  | { readonly ok: true; readonly plan: EquipmentCsvPlan }
  | EquipmentCsvImportFailure;

const encoder = new TextEncoder();

function invalid(message: string): EquipmentCsvImportFailure {
  return { ok: false, code: "invalid-payload", message };
}

function cellError(column: string | undefined, message: string): EquipmentCsvCellError {
  return column === undefined ? { message } : { column, message };
}

/**
 * Strict UTF-8 decode of the exact source bytes. The returned text is a
 * lossless representation: re-encoding it yields byte-identical source
 * bytes, including an allowed leading UTF-8 BOM, so the recorded
 * `contentHash` stays verifiable from the stored source. The BOM is a
 * parsing concern only — `parseEquipmentCsv` strips one leading BOM to
 * produce the normalized parse view. Invalid UTF-8 sequences reject the
 * whole input; partial decoding would silently corrupt source bytes.
 */
export function decodeEquipmentCsvBytes(
  bytes: Uint8Array,
): { readonly ok: true; readonly text: string } | EquipmentCsvImportFailure {
  if (bytes.length === 0) return invalid("csv input is empty");
  if (bytes.length > IMPORT_MAX_BYTES) {
    return invalid(`csv input exceeds the ${IMPORT_MAX_BYTES}-byte import bound`);
  }
  try {
    // `ignoreBOM: true` preserves a leading BOM in the decoded output
    // (it is not interpreted as a byte-order mark), keeping the text a
    // lossless stand-in for the source bytes.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return invalid("csv input is not valid UTF-8");
  }
}

interface CsvRecord {
  readonly cells: string[];
  /** 1-based overall row number including the header row. */
  readonly rowNumber: number;
}

interface CsvSplit {
  readonly records: CsvRecord[];
  /** Row-level quoting defects whose record boundaries stayed clear. */
  readonly malformedRows: readonly { readonly rowNumber: number; readonly message: string }[];
}

/**
 * RFC-4180-style record splitter over decoded text. Accepts CRLF and LF
 * record separators; a quote may only open a field at its first character,
 * `""` escapes a literal quote, and a closing quote must be followed by a
 * separator or end of input. An unterminated quote destroys the remaining
 * record boundaries and fails the whole document; defects that leave the
 * boundaries clear are reported row-locally.
 */
function splitCsvRecords(text: string): CsvSplit | EquipmentCsvImportFailure {
  const records: CsvRecord[] = [];
  const malformedRows: { rowNumber: number; message: string }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoteClosed = false;
  let rowNumber = 1;
  let sawContent = false;

  const endCell = (): void => {
    cells.push(cell);
    cell = "";
    quoteClosed = false;
  };
  const endRecord = (): void => {
    endCell();
    // Interior blank lines stay explicit empty records so row numbering
    // remains aligned with the file; the row validator reports them
    // instead of silently renumbering or dropping them.
    records.push({ cells, rowNumber });
    cells = [];
    sawContent = false;
    rowNumber += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        cell += character;
      }
      sawContent = true;
      continue;
    }
    if (character === '"') {
      if (cell.length === 0 && !quoteClosed) {
        inQuotes = true;
      } else {
        // A quote inside an unquoted field or after a closed quote.
        malformedRows.push({ rowNumber, message: "malformed quoting: unexpected quote character" });
      }
      sawContent = true;
      continue;
    }
    if (character === ",") {
      endCell();
      sawContent = true;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      continue;
    }
    if (quoteClosed) {
      // Anything but a separator directly after a closing quote is a
      // quoting defect; the record boundaries remain clear, so the row
      // stays locatable and is reported instead of silently accepted.
      malformedRows.push({ rowNumber, message: "malformed quoting: content after a closed quoted field" });
      quoteClosed = false;
    }
    cell += character;
    sawContent = true;
  }
  if (inQuotes) {
    return invalid("malformed quoting: quoted field is not terminated");
  }
  if (cell.length > 0 || cells.length > 0 || sawContent) {
    endRecord();
  }
  return { records, malformedRows };
}

function isFormulaInjectionCell(raw: string): boolean {
  const first = raw.trimStart().charAt(0);
  return first === "=" || first === "+" || first === "-" || first === "@";
}

function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

function normalizeOptionalText(
  raw: string,
  column: string,
  maxLength: number,
  errors: EquipmentCsvCellError[],
): string | undefined {
  if (raw.trim().length === 0) return undefined;
  if (utf8Length(raw) > IMPORT_MAX_CELL_BYTES) {
    errors.push(cellError(column, "cell exceeds the supported cell size"));
    return undefined;
  }
  if (isFormulaInjectionCell(raw)) {
    errors.push(cellError(column, "formula-injection cell rejected"));
    return undefined;
  }
  try {
    return normalizeBoundedText(raw, column, maxLength);
  } catch (error) {
    errors.push(
      cellError(column, error instanceof Error ? error.message : `${column} is invalid`),
    );
    return undefined;
  }
}

function parseRow(
  rowIndex: number,
  cells: readonly string[],
  columnIndex: ReadonlyMap<string, number>,
): EquipmentCsvRowPlan {
  if (cells.every((cell) => cell.trim() === "")) {
    return {
      rowIndex,
      status: "invalid",
      errors: [cellError(undefined, "blank row is not a valid equipment entry")],
    };
  }
  if (cells.length > IMPORT_MAX_COLUMNS) {
    return {
      rowIndex,
      status: "invalid",
      errors: [cellError(undefined, `row exceeds the ${IMPORT_MAX_COLUMNS}-column template`)],
    };
  }
  if (cells.length !== columnIndex.size) {
    return {
      rowIndex,
      status: "invalid",
      errors: [
        cellError(undefined, `row has ${cells.length} cells but the template has ${columnIndex.size}`),
      ],
    };
  }
  const errors: EquipmentCsvCellError[] = [];
  const value = (column: string): string => {
    const index = columnIndex.get(column);
    const cell = index === undefined ? "" : cells[index] ?? "";
    if (utf8Length(cell) > IMPORT_MAX_CELL_BYTES) {
      errors.push(cellError(column, "cell exceeds the supported cell size"));
      return "";
    }
    return cell;
  };
  const requireText = (column: string, maxLength: number): string | undefined => {
    const raw = value(column);
    if (raw.trim().length === 0) {
      errors.push(cellError(column, `${column} is required`));
      return undefined;
    }
    return normalizeOptionalText(raw, column, maxLength, errors);
  };

  const title = requireText("title", REQUIREMENT_TITLE_MAX_LENGTH);
  const category = requireText("category", REQUIREMENT_CATEGORY_MAX_LENGTH);

  let normalizedQuantity: string | undefined;
  const quantityCell = value("quantity");
  if (quantityCell.trim().length === 0) {
    errors.push(cellError("quantity", "quantity is required"));
  } else {
    try {
      const parsed = quantity(quantityCell);
      normalizedQuantity = decimalToString(parsed);
    } catch (error) {
      errors.push(
        cellError(
          "quantity",
          error instanceof Error ? error.message : "quantity is not a valid positive decimal",
        ),
      );
    }
  }

  let normalizedUnit: string | undefined;
  const unitCell = value("unit");
  if (unitCell.trim().length === 0) {
    errors.push(cellError("unit", "unit is required"));
  } else if (isFormulaInjectionCell(unitCell)) {
    errors.push(cellError("unit", "formula-injection cell rejected"));
  } else {
    const unit = unitCell.trim().toLowerCase();
    if (unit.length > REQUIREMENT_UNIT_MAX_LENGTH) {
      errors.push(cellError("unit", "unit exceeds the supported length"));
    } else if (!SUPPORTED_UNITS_SET.has(unit)) {
      errors.push(cellError("unit", `unsupported unit; supported units: ${SUPPORTED_EQUIPMENT_UNITS.join(", ")}`));
    } else {
      normalizedUnit = unit;
    }
  }

  let priority: EquipmentCsvDraftRow["priority"] | undefined;
  const priorityCell = value("priority").trim();
  if (priorityCell.length === 0) {
    errors.push(cellError("priority", "priority is required"));
  } else if (!SUPPORTED_PRIORITIES.includes(priorityCell)) {
    errors.push(cellError("priority", `unsupported priority; supported priorities: ${SUPPORTED_PRIORITIES.join(", ")}`));
  } else {
    priority = priorityCell as EquipmentCsvDraftRow["priority"];
  }

  let budgetMinorUnits: number | undefined;
  const budgetCell = value("budgetMinorUnits").trim();
  if (budgetCell.length > 0) {
    if (!/^\d+$/.test(budgetCell)) {
      errors.push(cellError("budgetMinorUnits", "budget must be a non-negative safe integer of minor units"));
    } else if (!Number.isSafeInteger(Number(budgetCell))) {
      errors.push(cellError("budgetMinorUnits", "budget exceeds the safe integer range"));
    } else {
      budgetMinorUnits = Number(budgetCell);
    }
  }

  let normalizedCurrency: string | undefined;
  const currencyCell = value("currency").trim();
  if (currencyCell.length > 0) {
    try {
      normalizedCurrency = currencyCode(currencyCell.toUpperCase());
    } catch {
      errors.push(cellError("currency", "currency must be a three-letter ISO code"));
    }
  }
  if (budgetMinorUnits !== undefined && normalizedCurrency === undefined && errors.every((e) => e.column !== "currency")) {
    errors.push(cellError("currency", "currency is required when budgetMinorUnits is set"));
  }

  let needByAt: number | undefined;
  const needByCell = value("needByAt").trim();
  if (needByCell.length > 0) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(needByCell);
    if (match === null) {
      errors.push(cellError("needByAt", "needByAt must be an ISO YYYY-MM-DD date"));
    } else {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const parsed = Date.UTC(year, month - 1, day);
      const roundTrip = new Date(parsed);
      if (
        roundTrip.getUTCFullYear() !== year ||
        roundTrip.getUTCMonth() !== month - 1 ||
        roundTrip.getUTCDate() !== day
      ) {
        errors.push(cellError("needByAt", "needByAt is not a supported date"));
      } else {
        try {
          needByAt = normalizeRequirementDate(parsed, "needByAt");
        } catch {
          errors.push(cellError("needByAt", "needByAt is not a supported date"));
        }
      }
    }
  }

  const hardConstraints = normalizeOptionalText(
    value("hardConstraints"),
    "hardConstraints",
    REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
    errors,
  );
  const responsible = normalizeOptionalText(
    value("responsible"),
    "responsible",
    REQUIREMENT_RESPONSIBLE_MAX_LENGTH,
    errors,
  );

  if (errors.length > 0 || title === undefined || category === undefined || normalizedQuantity === undefined || normalizedUnit === undefined || priority === undefined) {
    return { rowIndex, status: "invalid", errors };
  }
  return {
    rowIndex,
    status: "valid",
    row: {
      title,
      category,
      quantity: normalizedQuantity,
      unit: normalizedUnit,
      priority,
      ...(budgetMinorUnits === undefined ? {} : { budgetMinorUnits }),
      ...(normalizedCurrency === undefined ? {} : { currency: normalizedCurrency }),
      ...(needByAt === undefined ? {} : { needByAt }),
      ...(hardConstraints === undefined ? {} : { hardConstraints }),
      ...(responsible === undefined ? {} : { responsible }),
    },
  };
}

/**
 * Parse a decoded template document into the typed review plan. The
 * header must exactly match the documented template (no missing,
 * duplicate, or unknown names). Every data row appears in the plan;
 * invalid rows carry row-specific errors and are never silently dropped.
 */
export function parseEquipmentCsv(text: string): EquipmentCsvParseOutcome {
  // Documented BOM policy: exactly one leading UTF-8 BOM is stripped for
  // the parse view; the lossless stored source keeps it.
  const withoutBom = text.startsWith("﻿") ? text.slice(1) : text;
  const split = splitCsvRecords(withoutBom);
  if (!("records" in split)) return split;

  const headerRecord = split.records[0];
  if (headerRecord === undefined) {
    return invalid("csv input has no header row");
  }
  if (split.malformedRows.some((malformed) => malformed.rowNumber === headerRecord.rowNumber)) {
    return invalid("malformed quoting in the header row");
  }
  const headerCells = headerRecord.cells;
  const columnIndex = new Map<string, number>();
  for (let index = 0; index < headerCells.length; index += 1) {
    const name = headerCells[index]?.trim() ?? "";
    if (columnIndex.has(name)) {
      return invalid(`duplicate header column ${name}`);
    }
    columnIndex.set(name, index);
  }
  for (const required of EQUIPMENT_CSV_HEADERS) {
    if (!columnIndex.has(required)) {
      return invalid(`missing header column ${required}`);
    }
  }
  for (const present of columnIndex.keys()) {
    if (!(EQUIPMENT_CSV_HEADERS as readonly string[]).includes(present)) {
      return invalid(`unknown header column ${present}`);
    }
  }

  const dataRecords = split.records.slice(1);
  const malformedByRow = new Map<number, string>();
  for (const malformed of split.malformedRows) {
    if (malformed.rowNumber > headerRecord.rowNumber) {
      malformedByRow.set(malformed.rowNumber, malformed.message);
    }
  }
  // Data rows keep their source order; malformed-quoting rows re-enter the
  // plan as invalid so nothing is silently dropped.
  const rows: EquipmentCsvRowPlan[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let dataIndex = 0;
  for (const record of dataRecords) {
    dataIndex += 1;
    if (dataIndex > IMPORT_MAX_ROWS) {
      return invalid(
        `csv input has more than ${IMPORT_MAX_ROWS} data rows; the import bound rejects the extra data`,
      );
    }
    const malformed = malformedByRow.get(record.rowNumber);
    const plan = malformed === undefined
      ? parseRow(dataIndex, record.cells, columnIndex)
      : {
        rowIndex: dataIndex,
        status: "invalid" as const,
        errors: [cellError(undefined, malformed)],
      };
    rows.push(plan);
    if (plan.status === "valid") validCount += 1;
    else invalidCount += 1;
  }

  return { ok: true, plan: { rows, validCount, invalidCount } };
}

/**
 * Stable review identity for one row of one immutable import source. The
 * key depends only on the source content hash and the row index, so a
 * review action re-parsing the stored source selects exactly the rows the
 * contributor reviewed, and promotion idempotency holds across retries.
 */
export function equipmentCsvRowKey(contentHash: string, rowIndex: number): string {
  return sha256HexSync(encoder.encode(canonicalJson({ source: contentHash, row: rowIndex })));
}

/**
 * Deterministic requirement key for one promoted row, unique per project
 * and stable across review retries.
 */
export function promotedRequirementKey(contentHash: string, rowIndex: number): string {
  return `imports-${contentHash.slice(0, 24)}-r${rowIndex}`;
}

/**
 * Validate a normalized draft row once more at the promotion boundary.
 * The parser already enforced these rules; this re-check keeps promotion
 * safe even if a caller reached it with rows from elsewhere.
 */
export function validateDraftRowForPromotion(
  row: EquipmentCsvDraftRow,
): { readonly ok: true; readonly normalized: EquipmentCsvDraftRow } | EquipmentCsvImportFailure {
  try {
    const title = normalizeBoundedText(row.title, "title", REQUIREMENT_TITLE_MAX_LENGTH);
    const category = normalizeBoundedText(row.category, "category", REQUIREMENT_CATEGORY_MAX_LENGTH);
    const unit = normalizeBoundedText(row.unit, "unit", REQUIREMENT_UNIT_MAX_LENGTH).toLowerCase();
    if (!SUPPORTED_UNITS_SET.has(unit)) {
      return invalid(`unsupported unit ${unit}`);
    }
    const parsedQuantity = decimalToString(quantity(row.quantity));
    if (row.budgetMinorUnits !== undefined) {
      money(row.currency, row.budgetMinorUnits);
    }
    const needByAt = row.needByAt === undefined
      ? undefined
      : normalizeRequirementDate(row.needByAt, "needByAt");
    const hardConstraints = row.hardConstraints === undefined
      ? undefined
      : normalizeBoundedText(row.hardConstraints, "hardConstraints", REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH);
    const responsible = row.responsible === undefined
      ? undefined
      : normalizeBoundedText(row.responsible, "responsible", REQUIREMENT_RESPONSIBLE_MAX_LENGTH);
    return {
      ok: true,
      normalized: {
        title,
        category,
        quantity: parsedQuantity,
        unit,
        priority: row.priority,
        ...(row.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: row.budgetMinorUnits }),
        ...(row.currency === undefined ? {} : { currency: row.currency }),
        ...(needByAt === undefined ? {} : { needByAt }),
        ...(hardConstraints === undefined ? {} : { hardConstraints }),
        ...(responsible === undefined ? {} : { responsible }),
      },
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "draft row is invalid");
  }
}

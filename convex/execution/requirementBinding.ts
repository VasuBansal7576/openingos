/**
 * Requirement-revision binding for grant/job/operation inputVersions.
 *
 * One canonical key carries the exact requirement revision that authorized
 * a grant: `requirement` -> `<requirementId>@v<version>`. Jobs and
 * operations copy the grant map verbatim, so the atomic claim can compare
 * the bound revision against the live requirement row and reject stale
 * authorization after a requirement edit. Rows without the key are legacy
 * and stay claimable exactly as before.
 */

import type { Id } from "../_generated/dataModel.js";

export const REQUIREMENT_INPUT_VERSION_KEY = "requirement" as const;

export function formatRequirementInputVersion(
  requirementId: Id<"requirements">,
  version: number,
): string {
  return `${requirementId}@v${version}`;
}

export function parseRequirementInputVersion(
  value: string,
): { readonly requirementId: string; readonly version: number } | null {
  const at = value.lastIndexOf("@v");
  if (at <= 0) return null;
  const requirementId = value.slice(0, at);
  const versionText = value.slice(at + 2);
  if (requirementId.length === 0 || !/^\d+$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 0) return null;
  return { requirementId, version };
}

export function requirementBindingOf(
  inputVersions: Record<string, string>,
): { readonly requirementId: string; readonly version: number } | null {
  const raw = inputVersions[REQUIREMENT_INPUT_VERSION_KEY];
  if (typeof raw !== "string") return null;
  return parseRequirementInputVersion(raw);
}

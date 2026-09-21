import type { ConvexReactClient, Watch } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  parseWorkbenchSnapshot,
  type WorkbenchAction,
  type WorkbenchActionResult,
  type WorkbenchServerAdapter,
  type WorkbenchSnapshot,
} from "./workbench-state";

export type W1ListAccessibleProjectsArgs = Record<string, unknown> & {
  readonly cursor?: string;
  readonly limit?: number;
};

export type W1GetProjectionArgs = Record<string, unknown> & {
  readonly projectId: Id<"projects">;
  readonly cursor?: string;
  readonly limit?: number;
};

type SelectionLinePayload = {
  readonly quoteLineId: string;
  readonly quantity: string;
  readonly unit: string;
};

type W1RecordSelectionArgs = Record<string, unknown> & {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
  readonly candidateId: Id<"candidates">;
  readonly quoteId: Id<"quotes">;
  readonly quoteVersion: string;
  readonly selectionLines: readonly SelectionLinePayload[];
  readonly requirementVersion: number;
};

type W1DecideApprovalArgs = Record<string, unknown> & {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly approvalId: Id<"approvals">;
  readonly decision: "approved" | "rejected";
};

type W1CancelJobArgs = Record<string, unknown> & {
  readonly jobId: Id<"jobs">;
  readonly reason: string;
};

type W1StartJobArgs = Record<string, unknown> & {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly text: string;
  readonly operationId: "research.collect";
  readonly kind: "research";
};

type W1OpenServiceCaseArgs = Record<string, unknown> & {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly assetId: Id<"assets">;
  readonly urgency: "urgent" | "high" | "normal" | "low";
  readonly summary: string;
  readonly idempotencyKey: string;
};

type W1PublicApi = {
  readonly "workbench/projection": {
    readonly listAccessibleProjects: FunctionReference<
      "query",
      "public",
      W1ListAccessibleProjectsArgs,
      unknown
    >;
    readonly getProjection: FunctionReference<"query", "public", W1GetProjectionArgs, unknown>;
  };
  readonly "domain/decisions": {
    readonly recordSelection: FunctionReference<"mutation", "public", W1RecordSelectionArgs, unknown>;
    readonly decideApproval: FunctionReference<"mutation", "public", W1DecideApprovalArgs, unknown>;
  };
  readonly "execution/jobs": {
    readonly cancel: FunctionReference<"mutation", "public", W1CancelJobArgs, unknown>;
    readonly start: FunctionReference<"mutation", "public", W1StartJobArgs, unknown>;
  };
  readonly "domain/fulfillment": {
    readonly openServiceCase: FunctionReference<"mutation", "public", W1OpenServiceCaseArgs, unknown>;
  };
};

/**
 * Convex's checked-in API declaration predates W1 because this checkout has no
 * configured deployment for codegen. The generated runtime proxy still owns
 * function routing; this narrow declaration records the two public validators
 * consumed here until deployment-backed codegen refreshes the declaration.
 */
const workbenchApi = (api as unknown as W1PublicApi)["workbench/projection"];
const listAccessibleProjectsReference = workbenchApi.listAccessibleProjects;
const getProjectionReference = workbenchApi.getProjection;
const decisionsApi = (api as unknown as W1PublicApi)["domain/decisions"];
const recordSelectionReference = decisionsApi.recordSelection;
const decideApprovalReference = decisionsApi.decideApproval;
const jobsApi = (api as unknown as W1PublicApi)["execution/jobs"];
const cancelJobReference = jobsApi.cancel;
const startJobReference = jobsApi.start;
const fulfillmentApi = (api as unknown as W1PublicApi)["domain/fulfillment"];
const openServiceCaseReference = fulfillmentApi.openServiceCase;

const WORKBENCH_PROJECTION_LIMIT = 12;
const PROJECT_DISCOVERY_LIMIT = 1;
const MAX_PROJECT_DISCOVERY_PAGES = 32;

/** The narrow client surface used by the adapter and its controlled tests. */
export type ConvexWorkbenchClient = Pick<ConvexReactClient, "query" | "watchQuery" | "mutation">;

export interface ConvexWorkbenchAdapter extends WorkbenchServerAdapter {
  readonly discoverProject: () => Promise<string | null>;
  readonly dispose: () => void;
}

type WorkbenchWatch = Watch<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return options.some((option) => option === value);
}

/**
 * A project id comes from either a build-time environment value or a public
 * list response. Both are opaque Convex ids at this boundary. The non-empty
 * check is the runtime invariant that permits the Id-table conversion.
 */
function projectIdForQuery(value: string): Id<"projects"> {
  if (value.trim().length === 0) throw new Error("A non-empty project id is required.");
  return value as Id<"projects">;
}

function containsPrivateProjectionKey(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined || /"(?:[^"\\]*email[^"\\]*|[^"\\]*mailbox[^"\\]*|[^"\\]*rawHeaders?|providerId|recipientAddress|secret)"\s*:/i.test(serialized);
  } catch {
    return true;
  }
}

function projectionArgs(projectId: string, cursor?: string | null): W1GetProjectionArgs {
  const base = { projectId: projectIdForQuery(projectId), limit: WORKBENCH_PROJECTION_LIMIT };
  return cursor === undefined || cursor === null ? base : { ...base, cursor };
}

function invalidProjectionError(): Error {
  return new Error("Convex returned a malformed or cross-project workbench projection.");
}

const ACTION_UNAVAILABLE = "This workbench action is unavailable. Nothing was sent.";
const ACTION_REQUIRES_CURRENT_PROJECTION = "This action requires a current validated project projection. Nothing was sent.";
const ACTION_ALREADY_IN_FLIGHT = "This action is already in progress. Wait for the current server response.";
const RETRY_UNAVAILABLE = "Retry is unavailable because no safe retry contract is configured. Nothing was sent.";
const SERVICE_CASE_SUMMARY_MAX_LENGTH = 800;
const IDEMPOTENCY_KEY_MAX_LENGTH = 160;
const SERVICE_CASE_URGENCIES = ["urgent", "high", "normal", "low"] as const;

function positiveDecimal(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  return value.replace(/[.0]/g, "").length > 0;
}

function mutationFailure(value: unknown, fallback: string): WorkbenchActionResult | null {
  if (!isRecord(value)) return { ok: false, message: fallback };
  if (value.ok === false) {
    const message = typeof value.message === "string" && value.message.trim().length > 0
      ? value.message
      : fallback;
    return { ok: false, message };
  }
  return value.ok === true ? null : { ok: false, message: fallback };
}

interface AccessibleProjectPage {
  readonly projectId: string | null;
  readonly continueCursor: string | null;
  readonly isDone: boolean;
}

function parseAccessibleProjectPage(value: unknown): AccessibleProjectPage {
  if (!isRecord(value)) throw new Error("Convex returned an invalid accessible-project response.");
  if (containsPrivateProjectionKey(value)) throw new Error("Convex returned an invalid accessible-project response.");
  if (value.ok === false) return { projectId: null, continueCursor: null, isDone: true };
  if (value.ok !== true) throw new Error("Convex returned an invalid accessible-project response.");
  if (
    !Array.isArray(value.projects) ||
    typeof value.isDone !== "boolean" ||
    (value.isDone ? value.continueCursor !== null : typeof value.continueCursor !== "string")
  ) {
    throw new Error("Convex returned an invalid accessible-project response.");
  }
  const continueCursor = value.continueCursor === null
    ? null
    : typeof value.continueCursor === "string"
      ? value.continueCursor
      : null;
  if (value.projects.length === 0) {
    return { projectId: null, continueCursor, isDone: value.isDone };
  }
  const first = value.projects[0];
  if (!isRecord(first)) throw new Error("Convex returned an invalid accessible-project response.");
  const id = requiredString(first.id);
  const access = first.access;
  const capabilities = isRecord(access) ? access.capabilities : null;
  if (
    id === null ||
    !isRecord(access) ||
    !isOneOf(access.role, ["owner", "approver", "contributor", "viewer"] as const) ||
    !isRecord(capabilities) ||
    ![
      "canResearch",
      "canRecordEvidence",
      "canRecordQuote",
      "canCompare",
      "canCommunicate",
      "canClarify",
      "canApprove",
      "canOpenServiceCase",
    ].every((key) => typeof capabilities[key] === "boolean")
  ) {
    throw new Error("Convex returned an invalid accessible-project response.");
  }
  return { projectId: id, continueCursor, isDone: value.isDone };
}

function noop(): void {}

/**
 * Build the project-scoped workbench adapter around the actual Convex React
 * client. The cache stores only the latest raw projection that passed the
 * exact parser; mutations re-parse that raw value before constructing their
 * payload, so stale or malformed inputs cannot reach Convex.
 */
export function createConvexWorkbenchAdapter(client: ConvexWorkbenchClient): ConvexWorkbenchAdapter {
  let disposed = false;
  const subscriptions = new Set<() => void>();
  const projectionCache = new Map<string, { readonly raw: unknown }>();
  const readVersions = new Map<string, number>();
  const inFlightMutations = new Set<string>();

  const nextReadVersion = (projectId: string): number => {
    const next = (readVersions.get(projectId) ?? 0) + 1;
    readVersions.set(projectId, next);
    return next;
  };

  const invalidateProjection = (projectId: string): void => {
    projectionCache.delete(projectId);
    nextReadVersion(projectId);
  };

  const mutationKey = (projectId: string, action: WorkbenchAction): string => {
    switch (action.type) {
      case "selectOffer":
        return `${projectId}:selectOffer:${action.offerId}:${action.quoteId}:${action.quoteVersion}`;
      case "approveDecision":
        return `${projectId}:approveDecision:${action.decisionId}`;
      case "cancelJob":
        return `${projectId}:cancelJob:${action.jobId}`;
      case "startResearch":
        return `${projectId}:startResearch`;
      case "openServiceCase":
        return `${projectId}:openServiceCase:${action.assetId}:${action.idempotencyKey}`;
      case "retryJob":
      case "openEvidence":
        return `${projectId}:${action.type}`;
    }
  };

  const claimMutation = (projectId: string, action: WorkbenchAction): string | null => {
    const key = mutationKey(projectId, action);
    if (inFlightMutations.has(key)) return null;
    // This synchronous claim must happen before invoking the async Convex
    // client. It prevents same-project double clicks from sharing a cached
    // projection while the first mutation is still in flight.
    inFlightMutations.add(key);
    return key;
  };

  const finishMutation = (projectId: string, key: string): void => {
    inFlightMutations.delete(key);
    invalidateProjection(projectId);
  };

  const readCachedSnapshot = (projectId: string) => {
    const cached = projectionCache.get(projectId);
    if (cached === undefined) return null;
    const snapshot = parseWorkbenchSnapshot(cached.raw, projectId);
    if (snapshot === null) {
      invalidateProjection(projectId);
      return null;
    }
    return snapshot;
  };

  const currentSnapshotOrFailure = (projectId: string): WorkbenchSnapshot | WorkbenchActionResult => {
    if (disposed || projectId.trim().length === 0) return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
    const snapshot = readCachedSnapshot(projectId);
    return snapshot ?? { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of [...subscriptions]) unsubscribe();
    subscriptions.clear();
    projectionCache.clear();
    readVersions.clear();
    inFlightMutations.clear();
  };

  const discoverProject = async (): Promise<string | null> => {
    if (disposed) return null;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let pageNumber = 0; pageNumber < MAX_PROJECT_DISCOVERY_PAGES; pageNumber += 1) {
      const args: W1ListAccessibleProjectsArgs = cursor === undefined
        ? { limit: PROJECT_DISCOVERY_LIMIT }
        : { cursor, limit: PROJECT_DISCOVERY_LIMIT };
      const result = await client.query(listAccessibleProjectsReference, args);
      if (disposed) return null;
      const page = parseAccessibleProjectPage(result);
      if (page.projectId !== null) return page.projectId;
      if (page.isDone || page.continueCursor === null) return null;
      if (seenCursors.has(page.continueCursor)) {
        throw new Error("Convex returned a repeated accessible-project cursor.");
      }
      seenCursors.add(page.continueCursor);
      cursor = page.continueCursor;
    }
    throw new Error("Accessible-project discovery exceeded its page safety limit.");
  };

  const load = async (projectId: string, cursor?: string | null): Promise<unknown> => {
    if (disposed) return null;
    const version = nextReadVersion(projectId);
    let result: unknown;
    try {
      result = await client.query(getProjectionReference, projectionArgs(projectId, cursor));
    } catch (error) {
      if (!disposed && readVersions.get(projectId) === version) invalidateProjection(projectId);
      throw error;
    }
    if (disposed) return null;
    if (readVersions.get(projectId) !== version) return null;
    const snapshot = parseWorkbenchSnapshot(result, projectId);
    if (snapshot === null) {
      invalidateProjection(projectId);
      return null;
    }
    projectionCache.set(projectId, { raw: result });
    return result;
  };

  const subscribe = (
    projectId: string,
    onSnapshot: (snapshot: unknown) => void,
    onError: (error: unknown) => void,
  ): (() => void) => {
    if (disposed) return noop;

    let watch: WorkbenchWatch;
    try {
      watch = client.watchQuery(getProjectionReference, projectionArgs(projectId));
    } catch (error) {
      invalidateProjection(projectId);
      onError(error);
      return noop;
    }
    let active = true;
    let stop: (() => void) | undefined;

    const reportError = (error: unknown): void => {
      if (!disposed) invalidateProjection(projectId);
      onError(error);
    };

    const emit = () => {
      if (!active || disposed) return;
      try {
        const result = watch.localQueryResult();
        // Convex commonly has no local value during initial subscription;
        // keep an in-flight head load/cache alive until the first value.
        if (result === undefined) return;
        const parsed = parseWorkbenchSnapshot(result, projectId);
        if (parsed === null) {
          invalidateProjection(projectId);
          onError(invalidProjectionError());
          return;
        }
        // A watch emission is newer than every in-flight query started before
        // it. Advance the same per-project fence before caching so a late
        // query cannot regress this mutation basis.
        nextReadVersion(projectId);
        projectionCache.set(projectId, { raw: result });
        onSnapshot(result);
      } catch (error) {
        reportError(error);
      }
    };

    try {
      stop = watch.onUpdate(emit);
      // Convex does not invoke onUpdate for a value already in the local
      // cache, so inspect it once after registering the listener as well.
      emit();
    } catch (error) {
      if (!disposed) invalidateProjection(projectId);
      onError(error);
    }

    const unsubscribe = () => {
      if (!active) return;
      active = false;
      invalidateProjection(projectId);
      try {
        stop?.();
      } catch (error) {
        onError(error);
      }
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  };

  const act = async (action: WorkbenchAction): Promise<WorkbenchActionResult> => {
    if (action.type === "retryJob") return { ok: false, message: RETRY_UNAVAILABLE };
    if (action.type === "openEvidence") return { ok: false, message: ACTION_UNAVAILABLE };

    const current = currentSnapshotOrFailure(action.projectId);
    if (!("project" in current)) return current;
    const projectId = projectIdForQuery(current.project.id);
    const organizationId = current.project.organizationId as Id<"organizations">;

    if (action.type === "selectOffer") {
      const offer = current.offers.find((candidate) => candidate.id === action.offerId);
      if (offer === undefined || offer.quote === null || offer.requirementId.trim().length === 0) {
        return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
      }
      const requirement = current.requirements.find((candidate) => candidate.id === offer.requirementId);
      if (
        requirement === undefined ||
        requirement.id !== offer.requirementId ||
        !Number.isSafeInteger(requirement.version) ||
        requirement.version < 0 ||
        offer.quote.id !== action.quoteId ||
        offer.quote.version !== action.quoteVersion ||
        offer.quote.lines.length === 0 ||
        offer.quote.superseded === true
      ) {
        return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
      }
      const seenLines = new Set<string>();
      const selectionLines: SelectionLinePayload[] = [];
      for (const line of offer.quote.lines) {
        if (seenLines.has(line.lineId) || !positiveDecimal(line.quantity)) {
          return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
        }
        seenLines.add(line.lineId);
        const unit = line.unit ?? requirement.unit;
        if (unit.trim().length === 0) return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
        selectionLines.push({ quoteLineId: line.lineId, quantity: line.quantity, unit });
      }
      const args: W1RecordSelectionArgs = {
        organizationId,
        projectId,
        requirementId: requirement.id as Id<"requirements">,
        candidateId: offer.id as Id<"candidates">,
        quoteId: offer.quote.id as Id<"quotes">,
        quoteVersion: offer.quote.version,
        selectionLines,
        requirementVersion: requirement.version,
      };
      const mutationKey = claimMutation(projectId, action);
      if (mutationKey === null) return { ok: false, message: ACTION_ALREADY_IN_FLIGHT };
      try {
        const result = await client.mutation(recordSelectionReference, args);
        const failure = mutationFailure(result, "The server did not record this selection.");
        if (failure !== null) return failure;
        return { ok: true, message: "Selection recorded by the server; no order was placed." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "The server did not record this selection." };
      } finally {
        finishMutation(projectId, mutationKey);
      }
    }

    if (action.type === "approveDecision") {
      const decision = current.decisions.find((candidate) => candidate.id === action.decisionId);
      if (decision === undefined || decision.type !== "approval" || decision.state !== "requested") {
        return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
      }
      const args: W1DecideApprovalArgs = {
        organizationId,
        projectId,
        approvalId: decision.id as Id<"approvals">,
        decision: "approved",
      };
      const mutationKey = claimMutation(projectId, action);
      if (mutationKey === null) return { ok: false, message: ACTION_ALREADY_IN_FLIGHT };
      try {
        const result = await client.mutation(decideApprovalReference, args);
        const failure = mutationFailure(result, "The server did not decide this approval.");
        if (failure !== null) return failure;
        return { ok: true, message: "Approval recorded by the server." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "The server did not decide this approval." };
      } finally {
        finishMutation(projectId, mutationKey);
      }
    }

    if (action.type === "openServiceCase") {
      if (current.access.capabilities.canOpenServiceCase !== true) {
        return { ok: false, message: "Service-case creation is not authorized for this project. Nothing was sent." };
      }
      const asset = current.equipment.assets.find((candidate) => candidate.id === action.assetId);
      const summary = requiredString(action.summary)?.trim() ?? null;
      const idempotencyKey = requiredString(action.idempotencyKey)?.trim() ?? null;
      if (
        asset === undefined ||
        asset.id !== action.assetId ||
        !isOneOf(action.urgency, SERVICE_CASE_URGENCIES) ||
        summary === null ||
        summary.length > SERVICE_CASE_SUMMARY_MAX_LENGTH ||
        idempotencyKey === null ||
        idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
      ) {
        return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
      }
      const args: W1OpenServiceCaseArgs = {
        organizationId,
        projectId,
        assetId: asset.id as Id<"assets">,
        urgency: action.urgency,
        summary,
        idempotencyKey,
      };
      const mutationKey = claimMutation(projectId, action);
      if (mutationKey === null) return { ok: false, message: ACTION_ALREADY_IN_FLIGHT };
      try {
        const result = await client.mutation(openServiceCaseReference, args);
        const failure = mutationFailure(result, "The server did not record this service case.");
        if (failure !== null) return failure;
        if (!isRecord(result) || requiredString(result.caseId) === null || typeof result.deduplicated !== "boolean") {
          return { ok: false, message: "The server did not return a valid service-case state." };
        }
        return {
          ok: true,
          message: result.deduplicated
            ? "Service case already recorded by the server; this submission was deduplicated."
            : "Service case recorded by the server.",
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "The server did not record this service case." };
      } finally {
        finishMutation(projectId, mutationKey);
      }
    }

    if (action.type === "cancelJob") {
      const job = current.jobs.find((candidate) => candidate.id === action.jobId);
      if (job === undefined || job.cancellable !== true) {
        return { ok: false, message: ACTION_REQUIRES_CURRENT_PROJECTION };
      }
      const args: W1CancelJobArgs = {
        jobId: job.id as Id<"jobs">,
        reason: "Cancelled from the purchasing workbench",
      };
      const mutationKey = claimMutation(projectId, action);
      if (mutationKey === null) return { ok: false, message: ACTION_ALREADY_IN_FLIGHT };
      try {
        const result = await client.mutation(cancelJobReference, args);
        const failure = mutationFailure(result, "The server did not accept this cancellation.");
        if (failure !== null) return failure;
        if (!isRecord(result) || (result.state !== "cancelling" && result.state !== "cancelled")) {
          return { ok: false, message: "The server did not return a valid queued cancellation state." };
        }
        return { ok: true, message: result.state === "cancelled" ? "Cancellation recorded by the server." : "Cancellation queued by the server." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "The server did not accept this cancellation." };
      } finally {
        finishMutation(projectId, mutationKey);
      }
    }

    if (action.type === "startResearch") {
      if (current.access.capabilities.canResearch !== true) {
        return { ok: false, message: "Research is not authorized for this project. Nothing was sent." };
      }
      if (current.truncation.requirements) {
        return { ok: false, message: "Research is unavailable while the project requirements are truncated. Nothing was sent." };
      }
      const currentRequirements = current.requirements.filter((requirement) =>
        requirement.state !== "selected" && requirement.state !== "fulfilled" && requirement.state !== "cancelled",
      );
      if (currentRequirements.length !== 1) {
        return { ok: false, message: "Research needs one unambiguous current requirement. Nothing was sent." };
      }
      const requirement = currentRequirements[0];
      if (
        requirement === undefined ||
        requirement.key.trim().length === 0 ||
        requirement.title.trim().length === 0 ||
        requirement.category.trim().length === 0 ||
        requirement.quantity.trim().length === 0 ||
        requirement.unit.trim().length === 0
      ) {
        return { ok: false, message: "The current requirement is incomplete, so research was not started." };
      }
      const text = `Research suppliers for purchasing requirement ${requirement.key}: ${requirement.title} (${requirement.category}).`;
      const args: W1StartJobArgs = {
        organizationId,
        projectId,
        text,
        operationId: "research.collect",
        kind: "research",
      };
      const mutationKey = claimMutation(projectId, action);
      if (mutationKey === null) return { ok: false, message: ACTION_ALREADY_IN_FLIGHT };
      try {
        const result = await client.mutation(startJobReference, args);
        const failure = mutationFailure(result, "The server did not queue research.");
        if (failure !== null) return failure;
        if (!isRecord(result) || result.state !== "queued") {
          return { ok: false, message: "The server did not return a queued research state." };
        }
        return { ok: true, message: "Research queued by the server; provider outcome is still pending." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "The server did not queue research." };
      } finally {
        finishMutation(projectId, mutationKey);
      }
    }

    return { ok: false, message: ACTION_UNAVAILABLE };
  };

  return { load, subscribe, act, discoverProject, dispose };
}

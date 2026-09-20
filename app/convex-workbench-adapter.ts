import type { ConvexReactClient, Watch } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import {
  parseWorkbenchSnapshot,
  type WorkbenchAction,
  type WorkbenchActionResult,
  type WorkbenchServerAdapter,
} from "./workbench-state";

/**
 * These references intentionally stay local until the generated API contains
 * the W1 module on the integration branch. The argument types mirror the
 * accepted `workbench/projection` validators, while projection values remain
 * unknown until the exact UI boundary parser validates them.
 */
export type W1ListAccessibleProjectsArgs = Record<string, unknown> & {
  readonly cursor?: string;
  readonly limit?: number;
};

export type W1GetProjectionArgs = Record<string, unknown> & {
  readonly projectId: Id<"projects">;
  readonly cursor?: string;
  readonly limit?: number;
};

const listAccessibleProjectsReference = makeFunctionReference<
  "query",
  W1ListAccessibleProjectsArgs,
  unknown
>("workbench/projection:listAccessibleProjects");

const getProjectionReference = makeFunctionReference<
  "query",
  W1GetProjectionArgs,
  unknown
>("workbench/projection:getProjection");

const WORKBENCH_PROJECTION_LIMIT = 12;

/** The narrow client surface used by the adapter and its controlled tests. */
export type ConvexWorkbenchClient = Pick<ConvexReactClient, "query" | "watchQuery">;

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

/**
 * Keep the wire payload intact for the existing UI adapter contract, but only
 * return it after the exact W1 parser has accepted it for this project.
 */
function validatedProjection(value: unknown, projectId: string): unknown | null {
  return parseWorkbenchSnapshot(value, projectId) === null ? null : value;
}

function parseAccessibleProjectId(value: unknown): string | null {
  if (!isRecord(value)) throw new Error("Convex returned an invalid accessible-project response.");
  if (containsPrivateProjectionKey(value)) throw new Error("Convex returned an invalid accessible-project response.");
  if (value.ok === false) return null;
  if (value.ok !== true) throw new Error("Convex returned an invalid accessible-project response.");
  if (
    !Array.isArray(value.projects) ||
    typeof value.isDone !== "boolean" ||
    (value.isDone ? value.continueCursor !== null : typeof value.continueCursor !== "string")
  ) {
    throw new Error("Convex returned an invalid accessible-project response.");
  }
  if (value.projects.length === 0) return null;
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
    ].every((key) => typeof capabilities[key] === "boolean")
  ) {
    throw new Error("Convex returned an invalid accessible-project response.");
  }
  return id;
}

function noop(): void {}

/**
 * Build the read-only U1 adapter around the actual Convex React client.
 * Actions intentionally return a typed unavailable result until an
 * authority-bearing backend command exists for the complete action inputs.
 */
export function createConvexWorkbenchAdapter(client: ConvexWorkbenchClient): ConvexWorkbenchAdapter {
  let disposed = false;
  const subscriptions = new Set<() => void>();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of [...subscriptions]) unsubscribe();
    subscriptions.clear();
  };

  const discoverProject = async (): Promise<string | null> => {
    if (disposed) return null;
    const result = await client.query(listAccessibleProjectsReference, { limit: 1 });
    if (disposed) return null;
    return parseAccessibleProjectId(result);
  };

  const load = async (projectId: string, cursor?: string | null): Promise<unknown> => {
    if (disposed) return null;
    const result = await client.query(getProjectionReference, projectionArgs(projectId, cursor));
    if (disposed) return null;
    return validatedProjection(result, projectId);
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
      onError(error);
      return noop;
    }
    let active = true;
    let stop: (() => void) | undefined;

    const emit = () => {
      if (!active || disposed) return;
      try {
        const result = watch.localQueryResult();
        if (result === undefined) return;
        const snapshot = validatedProjection(result, projectId);
        if (snapshot === null) {
          onError(invalidProjectionError());
          return;
        }
        onSnapshot(snapshot);
      } catch (error) {
        onError(error);
      }
    };

    try {
      stop = watch.onUpdate(emit);
      // Convex does not invoke onUpdate for a value already in the local
      // cache, so inspect it once after registering the listener as well.
      emit();
    } catch (error) {
      onError(error);
    }

    const unsubscribe = () => {
      if (!active) return;
      active = false;
      stop?.();
      subscriptions.delete(unsubscribe);
    };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  };

  const act = async (_action: WorkbenchAction): Promise<WorkbenchActionResult> => ({
    ok: false,
    message: "This workbench action is unavailable until an authority-bearing backend command is configured. Nothing was sent.",
  });

  return { load, subscribe, act, discoverProject, dispose };
}

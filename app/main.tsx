import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexConnectionState } from "convex/react";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { statusFromConnection } from "./backend-state";
import { createConvexWorkbenchAdapter } from "./convex-workbench-adapter";
import {
  parseWorkbenchSnapshot,
  type WorkbenchActionResult,
  type WorkbenchActivityItem,
  type WorkbenchLoadState,
  type WorkbenchServerAdapter,
  type WorkbenchSnapshot,
} from "./workbench-state";
import "./styles.css";

type RuntimeWorkbenchAdapter = WorkbenchServerAdapter & {
  readonly discoverProject?: () => Promise<string | null>;
  readonly dispose?: () => void;
};

/**
 * Append a validated activity page to the latest snapshot without replacing
 * the other W1 fields with the page response's partial snapshot.
 */
export function appendWorkbenchActivity(current: WorkbenchSnapshot, next: WorkbenchSnapshot): WorkbenchSnapshot {
  const seen = new Set<string>();
  const items: WorkbenchActivityItem[] = [];
  for (const item of [...current.activity.items, ...next.activity.items]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return {
    ...current,
    activity: {
      items,
      continueCursor: next.activity.continueCursor,
      isDone: next.activity.isDone,
    },
  };
}

/**
 * Monotonic fence for concurrent "Load older activity" pages racing each other
 * and racing live projection updates.
 *
 * Every load-more dispatch takes the next request generation; the applied
 * generation only moves forward. A response whose generation is older than the
 * applied generation still contributes its unseen items (so no page is
 * skipped) but never moves continueCursor/isDone backwards (so an older
 * response cannot regress, repeat, or re-open pagination).
 */
export function mergeFencedActivityPage(
  current: WorkbenchSnapshot,
  next: WorkbenchSnapshot,
  requestGeneration: number,
  appliedGeneration: number,
): { readonly snapshot: WorkbenchSnapshot; readonly appliedGeneration: number } {
  const merged = appendWorkbenchActivity(current, next);
  if (requestGeneration < appliedGeneration) {
    return {
      snapshot: {
        ...merged,
        activity: {
          items: merged.activity.items,
          continueCursor: current.activity.continueCursor,
          isDone: current.activity.isDone,
        },
      },
      appliedGeneration,
    };
  }
  return { snapshot: merged, appliedGeneration: requestGeneration };
}

/**
 * Apply a live (head) projection refresh without dropping activity pages the
 * user already paged through. Head fields come from the live snapshot; tail
 * items already appended stay appended with dedupe. The deeper pagination
 * cursor is kept while a tail exists so the live refresh cannot regress
 * continueCursor or re-open a finished list.
 */
export function applyLiveWorkbenchSnapshot(current: WorkbenchSnapshot, live: WorkbenchSnapshot): WorkbenchSnapshot {
  const liveIds = new Set(live.activity.items.map((item) => item.id));
  const tail = current.activity.items.filter((item) => !liveIds.has(item.id));
  const items = [...live.activity.items, ...tail];
  const hasTail = tail.length > 0;
  return {
    ...live,
    activity: {
      items,
      continueCursor: hasTail ? current.activity.continueCursor : live.activity.continueCursor,
      isDone: hasTail ? current.activity.isDone : live.activity.isDone,
    },
  };
}

function ConnectionAwareApp({ onRetry, projectId, workbenchAdapter }: { readonly onRetry: () => void; readonly projectId?: string | undefined; readonly workbenchAdapter?: RuntimeWorkbenchAdapter | undefined }) {
  const connection = useConvexConnectionState();
  const auth = useConvexAuth();
  const backendStatus = statusFromConnection({
    isWebSocketConnected: connection.isWebSocketConnected,
    hasEverConnected: connection.hasEverConnected,
    connectionRetries: connection.connectionRetries,
    authLoading: auth.isLoading,
  });

  return <AdapterAwareApp backendStatus={backendStatus} onRetry={onRetry} projectId={projectId} workbenchAdapter={workbenchAdapter} />;
}

export function AdapterAwareApp({
  backendStatus,
  onRetry,
  projectId,
  workbenchAdapter,
}: {
  readonly backendStatus: ReturnType<typeof statusFromConnection>;
  readonly onRetry: () => void;
  readonly projectId?: string | undefined;
  readonly workbenchAdapter?: RuntimeWorkbenchAdapter | undefined;
}) {
  const [workbench, setWorkbench] = useState<WorkbenchLoadState | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvedProjectId, setResolvedProjectId] = useState<string | undefined>(normaliseProjectId(projectId));
  const previousContext = useRef<{ readonly projectId: string | undefined; readonly adapter: RuntimeWorkbenchAdapter | undefined }>({ projectId: undefined, adapter: undefined });
  const backendStatusRef = useRef(backendStatus);
  backendStatusRef.current = backendStatus;
  // Monotonic fence: every head load, load-more page, and live update takes a
  // request generation at dispatch/event time; appliedGeneration only moves
  // forward so a stale page can add unseen items but never regress
  // continueCursor/isDone. Stale head responses and failures are discarded
  // entirely against the latest requested generation.
  const activityFence = useRef({ requested: 0, applied: 0 });

  useEffect(() => {
    let disposed = false;
    const configuredProjectId = normaliseProjectId(projectId);
    const contextChanged = previousContext.current.projectId !== configuredProjectId || previousContext.current.adapter !== workbenchAdapter;
    previousContext.current = { projectId: configuredProjectId, adapter: workbenchAdapter };
    if (contextChanged) setWorkbench(undefined);
    setResolvedProjectId(configuredProjectId);
    if (configuredProjectId !== undefined) return () => { disposed = true; };
    if (workbenchAdapter?.discoverProject === undefined || backendStatus !== "connected") return () => { disposed = true; };

    void workbenchAdapter.discoverProject().then((discoveredProjectId) => {
      if (disposed) return;
      setResolvedProjectId(discoveredProjectId ?? undefined);
      if (discoveredProjectId === null) {
        setWorkbench({ state: "empty", message: "No authorized project projection is available yet." });
      }
    }).catch((error: unknown) => {
      if (disposed) return;
      setWorkbench({ state: "error", message: error instanceof Error ? error.message : "Authorized projects could not be discovered." });
    });
    return () => { disposed = true; };
  }, [backendStatus, projectId, workbenchAdapter]);

  useEffect(() => {
    if (workbenchAdapter === undefined || (resolvedProjectId === undefined && workbenchAdapter.discoverProject === undefined)) {
      setWorkbench(undefined);
      return;
    }
    if (resolvedProjectId === undefined) return;
    if (backendStatus !== "connected" && backendStatus !== "reconnecting") return;

    let disposed = false;
    const load = async (cursor?: string | null) => {
      if (!disposed) {
        setWorkbench((current) => current?.state === "ready" && backendStatus === "reconnecting"
          ? { state: "reconnecting", lastKnown: current.snapshot }
          : { state: "loading", ...(current?.state === "ready" ? { lastKnown: current.snapshot } : {}) });
      }
      activityFence.current.requested += 1;
      const loadGeneration = activityFence.current.requested;
      try {
        const response = await workbenchAdapter.load(resolvedProjectId, cursor);
        if (disposed || backendStatusRef.current !== "connected") return;
        // A newer request, page, or live update was dispatched after this
        // head load: discard the stale response entirely so it cannot replace
        // newer head fields or move the activity cursor.
        if (loadGeneration < activityFence.current.requested) return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, resolvedProjectId);
        if (snapshot === null) {
          activityFence.current.applied = loadGeneration;
          setWorkbench({ state: "empty", message: "No authorized project projection is available yet." });
          return;
        }
        activityFence.current.applied = loadGeneration;
        setWorkbench((current) => {
          if (current?.state !== "ready" || current.snapshot.project.id !== resolvedProjectId) return { state: "ready", snapshot };
          return { state: "ready", snapshot: applyLiveWorkbenchSnapshot(current.snapshot, snapshot) };
        });
      } catch (error) {
        if (disposed || backendStatusRef.current !== "connected") return;
        // A newer request superseded this head load: a stale failure must not
        // overwrite a newer successful projection with an error.
        if (loadGeneration < activityFence.current.requested) return;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be read." });
      }
    };
    void load();
    const unsubscribe = workbenchAdapter.subscribe?.(
      resolvedProjectId,
      (response) => {
        if (disposed || backendStatusRef.current !== "connected") return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, resolvedProjectId);
        activityFence.current.requested += 1;
        activityFence.current.applied = activityFence.current.requested;
        setWorkbench((current) => {
          if (snapshot === null) return { state: "empty", message: "No authorized project projection is available yet." };
          if (current?.state !== "ready" || current.snapshot.project.id !== resolvedProjectId) return { state: "ready", snapshot };
          return { state: "ready", snapshot: applyLiveWorkbenchSnapshot(current.snapshot, snapshot) };
        });
      },
      (error: unknown) => {
        if (disposed || backendStatusRef.current !== "connected") return;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be refreshed." });
      },
    );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [backendStatus, resolvedProjectId, workbenchAdapter]);

  const handleAction = async (action: Parameters<NonNullable<typeof workbenchAdapter>["act"]>[0]): Promise<WorkbenchActionResult> => {
    if (backendStatusRef.current !== "connected" || workbench?.state !== "ready") return { ok: false, message: "Actions wait for a fresh connected projection. Nothing was sent." };
    if (workbenchAdapter === undefined) return { ok: false, message: "No server action route is configured. Nothing was sent." };
    try {
      const result = await workbenchAdapter.act(action);
      setActionError(result.ok ? null : result.message ?? "The server did not accept this action.");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The server action could not be completed.";
      setActionError(message);
      return { ok: false, message };
    }
  };

  const handleLoadMore = () => {
    if (backendStatusRef.current !== "connected") return;
    const cursor = workbench?.state === "ready" ? workbench.snapshot.activity.continueCursor : null;
    if (cursor === null || cursor === undefined || workbenchAdapter === undefined || resolvedProjectId === undefined) return;
    activityFence.current.requested += 1;
    const requestGeneration = activityFence.current.requested;
    void workbenchAdapter.load(resolvedProjectId, cursor).then((response) => {
      if (response === null || backendStatusRef.current !== "connected") return;
      const snapshot = parseWorkbenchSnapshot(response, resolvedProjectId);
      if (snapshot === null || backendStatusRef.current !== "connected") return;
      setWorkbench((current) => {
        if (backendStatusRef.current !== "connected") return current;
        if (current?.state !== "ready" || current.snapshot.project.id !== resolvedProjectId) return { state: "ready", snapshot };
        const merged = mergeFencedActivityPage(current.snapshot, snapshot, requestGeneration, activityFence.current.applied);
        activityFence.current.applied = merged.appliedGeneration;
        return { state: "ready", snapshot: merged.snapshot };
      });
    }).catch((error: unknown) => {
      if (backendStatusRef.current !== "connected") return;
      setWorkbench({ state: "error", message: error instanceof Error ? error.message : "More project activity could not be loaded." });
    });
  };

  const connectedLoadMore = workbench?.state === "ready" && backendStatus === "connected" ? handleLoadMore : undefined;
  const appWorkbench = backendStatus === "reconnecting" && workbench?.state === "ready"
    ? { state: "reconnecting" as const, lastKnown: workbench.snapshot }
    : workbench;
  return <><App backendStatus={backendStatus} onRetry={onRetry} workbench={appWorkbench} onAction={handleAction} onLoadMore={connectedLoadMore} />{actionError ? <span className="wb-visually-hidden" role="alert">{actionError}</span> : null}</>;
}

function normaliseProjectId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export type ConvexClientFactory = (url: string) => ConvexReactClient;

const defaultClientFactory: ConvexClientFactory = (url) => new ConvexReactClient(url);

type ClientState = ConvexReactClient | "unavailable" | null;

function ConvexClientBoundary({
  clientFactory,
  onRetry,
  url,
  projectId,
  workbenchAdapter,
}: {
  clientFactory: ConvexClientFactory;
  onRetry: () => void;
  url: string;
  projectId?: string | undefined;
  workbenchAdapter?: RuntimeWorkbenchAdapter | undefined;
}) {
  const [clientState, setClientState] = useState<ClientState>(null);
  const [adapterState, setAdapterState] = useState<RuntimeWorkbenchAdapter | undefined>(undefined);

  useEffect(() => {
    let client: ConvexReactClient | null = null;
    let adapter: RuntimeWorkbenchAdapter | null = null;
    try {
      client = clientFactory(url);
      adapter = workbenchAdapter ?? createConvexWorkbenchAdapter(client);
      setClientState(client);
      setAdapterState(adapter);
    } catch {
      setClientState("unavailable");
      setAdapterState(undefined);
    }

    return () => {
      const adapterToDispose = adapter;
      adapter = null;
      adapterToDispose?.dispose?.();
      setAdapterState((current) => (current === adapterToDispose ? undefined : current));
      const clientToClose = client;
      client = null;
      if (clientToClose === null) return;

      void clientToClose.close().catch(() => undefined);
      setClientState((current) => (current === clientToClose ? null : current));
    };
  }, [clientFactory, url, workbenchAdapter]);

  if (clientState === "unavailable") {
    return <App backendStatus="unavailable" onRetry={onRetry} />;
  }
  if (clientState === null) {
    return <App backendStatus="configured-unverified" />;
  }

  return (
    <ConvexAuthProvider client={clientState}>
      <ConnectionAwareApp onRetry={onRetry} projectId={projectId} workbenchAdapter={adapterState} />
    </ConvexAuthProvider>
  );
}

function ConfiguredApplication({
  clientFactory,
  url,
  projectId,
  workbenchAdapter,
}: {
  clientFactory: ConvexClientFactory;
  url: string;
  projectId?: string | undefined;
  workbenchAdapter?: RuntimeWorkbenchAdapter | undefined;
}) {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = () => setRetryGeneration((generation) => generation + 1);

  return (
    <ConvexClientBoundary
      key={retryGeneration}
      clientFactory={clientFactory}
      onRetry={retry}
      url={url}
      projectId={projectId}
      workbenchAdapter={workbenchAdapter}
    />
  );
}

export interface RootApplicationProps {
  configuredUrl?: string;
  clientFactory?: ConvexClientFactory;
  projectId?: string;
  workbenchAdapter?: RuntimeWorkbenchAdapter;
}

export function RootApplication({ configuredUrl, clientFactory = defaultClientFactory, projectId, workbenchAdapter }: RootApplicationProps) {
  const configuredUrlFromBuild = configuredUrl ?? import.meta.env.VITE_CONVEX_URL;
  const url = typeof configuredUrlFromBuild === "string" ? configuredUrlFromBuild.trim() : "";
  const projectIdFromBuild = projectId ?? import.meta.env.VITE_OPENINGOS_PROJECT_ID;
  return url.length > 0 ? <ConfiguredApplication clientFactory={clientFactory} url={url} projectId={projectIdFromBuild} workbenchAdapter={workbenchAdapter} /> : <App backendStatus="unconfigured" />;
}

export function mountRootApplication(container: Element, props: RootApplicationProps = {}) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <RootApplication {...props} />
    </React.StrictMode>,
  );
  return root;
}

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement === null) throw new Error("OpeningOS root element is missing");

  mountRootApplication(rootElement);
}

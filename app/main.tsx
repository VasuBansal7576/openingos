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

function AdapterAwareApp({
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
      try {
        const response = await workbenchAdapter.load(resolvedProjectId, cursor);
        if (disposed || backendStatusRef.current !== "connected") return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, resolvedProjectId);
        setWorkbench(snapshot === null ? { state: "empty", message: "No authorized project projection is available yet." } : { state: "ready", snapshot });
      } catch (error) {
        if (disposed || backendStatusRef.current !== "connected") return;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be read." });
      }
    };
    void load();
    const unsubscribe = workbenchAdapter.subscribe?.(
      resolvedProjectId,
      (response) => {
        if (disposed || backendStatusRef.current !== "connected") return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, resolvedProjectId);
        setWorkbench(snapshot === null ? { state: "empty", message: "No authorized project projection is available yet." } : { state: "ready", snapshot });
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
    void workbenchAdapter.load(resolvedProjectId, cursor).then((response) => {
      if (response === null || backendStatusRef.current !== "connected") return;
      const snapshot = parseWorkbenchSnapshot(response, resolvedProjectId);
      if (snapshot === null || backendStatusRef.current !== "connected") return;
      setWorkbench((current) => {
        if (backendStatusRef.current !== "connected") return current;
        if (current?.state !== "ready" || current.snapshot.project.id !== resolvedProjectId) return { state: "ready", snapshot };
        return { state: "ready", snapshot: appendWorkbenchActivity(current.snapshot, snapshot) };
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

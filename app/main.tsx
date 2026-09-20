import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexConnectionState } from "convex/react";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { statusFromConnection } from "./backend-state";
import {
  parseWorkbenchSnapshot,
  type WorkbenchActionResult,
  type WorkbenchLoadState,
  type WorkbenchServerAdapter,
} from "./workbench-state";
import "./styles.css";

function ConnectionAwareApp({ onRetry, projectId, workbenchAdapter }: { readonly onRetry: () => void; readonly projectId?: string | undefined; readonly workbenchAdapter?: WorkbenchServerAdapter | undefined }) {
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
  readonly workbenchAdapter?: WorkbenchServerAdapter | undefined;
}) {
  const [workbench, setWorkbench] = useState<WorkbenchLoadState | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (workbenchAdapter === undefined || projectId === undefined || projectId.trim().length === 0) {
      setWorkbench(undefined);
      return;
    }
    if (backendStatus !== "connected" && backendStatus !== "reconnecting") return;

    let disposed = false;
    const load = async (cursor?: string | null) => {
      if (!disposed) {
        setWorkbench((current) => current?.state === "ready" && backendStatus === "reconnecting"
          ? { state: "reconnecting", lastKnown: current.snapshot }
          : { state: "loading", ...(current?.state === "ready" ? { lastKnown: current.snapshot } : {}) });
      }
      try {
        const response = await workbenchAdapter.load(projectId, cursor);
        if (disposed) return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, projectId);
        setWorkbench(snapshot === null ? { state: "empty", message: "No authorized project projection is available yet." } : { state: "ready", snapshot });
      } catch (error) {
        if (disposed) return;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be read." });
      }
    };
    void load();
    const unsubscribe = workbenchAdapter.subscribe?.(
      projectId,
      (response) => {
        if (disposed) return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, projectId);
        setWorkbench(snapshot === null ? { state: "empty", message: "No authorized project projection is available yet." } : { state: "ready", snapshot });
      },
      (error: unknown) => {
        if (disposed) return;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be refreshed." });
      },
    );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [backendStatus, projectId, workbenchAdapter]);

  const handleAction = async (action: Parameters<NonNullable<typeof workbenchAdapter>["act"]>[0]): Promise<WorkbenchActionResult> => {
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
    const cursor = workbench?.state === "ready" ? workbench.snapshot.activity.continueCursor : null;
    if (cursor === null || cursor === undefined || workbenchAdapter === undefined || projectId === undefined) return;
    void workbenchAdapter.load(projectId, cursor).then((response) => {
      if (response === null) return;
      const snapshot = parseWorkbenchSnapshot(response, projectId);
      if (snapshot !== null) setWorkbench({ state: "ready", snapshot });
    }).catch((error: unknown) => setWorkbench({ state: "error", message: error instanceof Error ? error.message : "More project activity could not be loaded." }));
  };

  return <><App backendStatus={backendStatus} onRetry={onRetry} workbench={workbench} onAction={handleAction} onLoadMore={handleLoadMore} />{actionError ? <span className="wb-visually-hidden" role="alert">{actionError}</span> : null}</>;
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
  workbenchAdapter?: WorkbenchServerAdapter | undefined;
}) {
  const [clientState, setClientState] = useState<ClientState>(null);

  useEffect(() => {
    let client: ConvexReactClient | null = null;
    try {
      client = clientFactory(url);
      setClientState(client);
    } catch {
      setClientState("unavailable");
    }

    return () => {
      const clientToClose = client;
      client = null;
      if (clientToClose === null) return;

      void clientToClose.close().catch(() => undefined);
      setClientState((current) => (current === clientToClose ? null : current));
    };
  }, [clientFactory, url]);

  if (clientState === "unavailable") {
    return <App backendStatus="unavailable" onRetry={onRetry} />;
  }
  if (clientState === null) {
    return <App backendStatus="configured-unverified" />;
  }

  return (
    <ConvexAuthProvider client={clientState}>
      <ConnectionAwareApp onRetry={onRetry} projectId={projectId} workbenchAdapter={workbenchAdapter} />
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
  workbenchAdapter?: WorkbenchServerAdapter | undefined;
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
  workbenchAdapter?: WorkbenchServerAdapter;
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

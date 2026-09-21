import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
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
  type WorkbenchIntakeInput,
  type WorkbenchIntakeResult,
  type WorkbenchLoadState,
  type WorkbenchSampleInput,
  type WorkbenchSampleResult,
  type WorkbenchServerAdapter,
  type WorkbenchSnapshot,
} from "./workbench-state";
import "./styles.css";

type RuntimeWorkbenchAdapter = WorkbenchServerAdapter & {
  readonly discoverProject?: () => Promise<string | null>;
  readonly dispose?: () => void;
};

interface WorkbenchRequestContext {
  readonly generation: number;
  readonly projectId: string;
  readonly adapter: RuntimeWorkbenchAdapter;
  readonly fence: { requested: number; applied: number };
  disposed: boolean;
}

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

const ANONYMOUS_SIGN_IN_FAILED =
  "Anonymous sign-in failed, so this browser has no authorized backend identity. No project state was read and nothing was sent. Retry to sign in again.";

function ConnectionAwareApp({ onRetry, projectId, workbenchAdapter }: { readonly onRetry: () => void; readonly projectId?: string | undefined; readonly workbenchAdapter?: RuntimeWorkbenchAdapter | undefined }) {
  const connection = useConvexConnectionState();
  const auth = useConvexAuth();
  const authActions = useAuthActions();
  const [anonymousSignIn, setAnonymousSignIn] = useState<"idle" | "establishing" | "failed">("idle");
  const attemptedAnonymousRef = useRef(false);
  // A server-side denial (for example a rejected token discovered by project
  // discovery) clears the stale local session on retry so the remounted
  // session re-establishes a fresh identity instead of replaying the denial.
  const authDenialRef = useRef(false);

  // A fresh visitor holds no session. Establish the real anonymous identity
  // through the registered Convex Auth provider before any discovery, load,
  // or creation mutation runs, so the backend sees an authenticated caller.
  // Without this, the backend denies forged-identity requests and project
  // discovery would disguise that denial as an empty project list.
  // Readiness keys on the Convex Auth session flag, never on a locally
  // stored token alone: a token can exist locally while the server still
  // rejects it, and only a successful server round-trip confirms the backend
  // identity.
  useEffect(() => {
    if (auth.isLoading || auth.isAuthenticated || attemptedAnonymousRef.current) return;
    attemptedAnonymousRef.current = true;
    setAnonymousSignIn("establishing");
    authActions.signIn("anonymous").then((result) => {
      // The anonymous provider signs in immediately; the stored token flips
      // the auth context. A non-signing result created no session.
      setAnonymousSignIn(result.signingIn ? "idle" : "failed");
    }).catch(() => {
      setAnonymousSignIn("failed");
    });
  }, [auth.isLoading, auth.isAuthenticated, authActions]);

  const backendStatus = statusFromConnection({
    isWebSocketConnected: connection.isWebSocketConnected,
    hasEverConnected: connection.hasEverConnected,
    connectionRetries: connection.connectionRetries,
    authLoading: auth.isLoading,
  });

  // Auth failure stays honest: an explicit error with a retry path, never a
  // fake identity and never an "empty" project list that hides the denial.
  if (backendStatus === "connected" && !auth.isAuthenticated && anonymousSignIn === "failed") {
    return <App backendStatus="connected" onRetry={onRetry} workbench={{ state: "error", message: ANONYMOUS_SIGN_IN_FAILED }} />;
  }
  // Discovery and creation wait for the established session; the honest
  // authenticating state replaces "connected" while the identity is pending.
  // A locally stored token alone is not enough: the session flag flips only
  // after the provider stored the identity, and creation additionally waits
  // for a successful server round-trip (tracked inside AdapterAwareApp).
  const connectedWithoutIdentity = backendStatus === "connected" && !auth.isAuthenticated;
  const handleRetry = () => {
    if (!authDenialRef.current) {
      onRetry();
      return;
    }
    authDenialRef.current = false;
    // The server rejected the stored token, so drop the stale local session
    // before remounting; the fresh mount then establishes a new identity
    // instead of replaying the same denial.
    Promise.resolve(authActions.signOut()).then(onRetry, onRetry);
  };
  return <AdapterAwareApp backendStatus={connectedWithoutIdentity ? "authenticating" : backendStatus} onRetry={handleRetry} projectId={projectId} workbenchAdapter={workbenchAdapter} onAuthDenial={() => { authDenialRef.current = true; }} />;
}

export function AdapterAwareApp({
  backendStatus,
  onRetry,
  projectId,
  workbenchAdapter,
  onAuthDenial,
}: {
  readonly backendStatus: ReturnType<typeof statusFromConnection>;
  readonly onRetry: () => void;
  readonly projectId?: string | undefined;
  readonly workbenchAdapter?: RuntimeWorkbenchAdapter | undefined;
  readonly onAuthDenial?: (() => void) | undefined;
}) {
  const [workbench, setWorkbench] = useState<WorkbenchLoadState | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvedProjectId, setResolvedProjectId] = useState<string | undefined>(normaliseProjectId(projectId));
  const previousContext = useRef<{ readonly projectId: string | undefined; readonly adapter: RuntimeWorkbenchAdapter | undefined }>({ projectId: undefined, adapter: undefined });
  const backendStatusRef = useRef(backendStatus);
  backendStatusRef.current = backendStatus;
  const adapterRef = useRef(workbenchAdapter);
  adapterRef.current = workbenchAdapter;
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  // Server-confirmed authentication: a locally established session is not
  // enough to send creation mutations. This latch flips only after a
  // discovery or projection round-trip succeeds against the backend, so a
  // rejected token can never reach intake/sample creation. It resets when
  // the project or adapter identity changes; the fresh discovery/load then
  // re-confirms before creation is offered again.
  const serverConfirmedRef = useRef(false);
  const onAuthDenialRef = useRef(onAuthDenial);
  onAuthDenialRef.current = onAuthDenial;
  // A request context is tied to one project, adapter and connected client
  // generation. Reconnects, revocations and adapter replacement invalidate the
  // context before an old load can apply to a fresh snapshot for the same ID.
  const activeContextRef = useRef<WorkbenchRequestContext | null>(null);
  const contextGenerationRef = useRef(0);
  const invalidateActiveContext = () => {
    const context = activeContextRef.current;
    if (context === null) return;
    context.disposed = true;
    activeContextRef.current = null;
  };
  const isCurrentContext = (context: WorkbenchRequestContext): boolean =>
    activeContextRef.current === context && !context.disposed && backendStatusRef.current === "connected";

  useEffect(() => {
    let disposed = false;
    const configuredProjectId = normaliseProjectId(projectId);
    const contextChanged = previousContext.current.projectId !== configuredProjectId || previousContext.current.adapter !== workbenchAdapter;
    previousContext.current = { projectId: configuredProjectId, adapter: workbenchAdapter };
    if (contextChanged) {
      setWorkbench(undefined);
      serverConfirmedRef.current = false;
    }
    setResolvedProjectId(configuredProjectId);
    if (configuredProjectId !== undefined) return () => { disposed = true; };
    if (workbenchAdapter?.discoverProject === undefined || backendStatus !== "connected") return () => { disposed = true; };

    void workbenchAdapter.discoverProject().then((discoveredProjectId) => {
      if (disposed) return;
      // Any resolved discovery (a project id or an authenticated empty
      // result) is the server confirmation. A denial rejects and lands in
      // the error branch below instead of masquerading as an empty list.
      serverConfirmedRef.current = true;
      setResolvedProjectId(discoveredProjectId ?? undefined);
      if (discoveredProjectId === null) {
        setWorkbench({ state: "empty", message: "No authorized project projection is available yet." });
      }
    }).catch((error: unknown) => {
      if (disposed) return;
      if (error instanceof Error && /forged-identity|unauthenticated/i.test(error.message)) {
        onAuthDenialRef.current?.();
      }
      setWorkbench({ state: "error", message: error instanceof Error ? error.message : "Authorized projects could not be discovered." });
    });
    return () => { disposed = true; };
  }, [backendStatus, projectId, workbenchAdapter]);

  useEffect(() => {
    invalidateActiveContext();
    if (workbenchAdapter === undefined || (resolvedProjectId === undefined && workbenchAdapter.discoverProject === undefined)) {
      setWorkbench(undefined);
      return;
    }
    if (resolvedProjectId === undefined) return;
    // Keep the last snapshot visible through the outer reconnecting state, but
    // do not dispatch or retain work under a disconnected client generation.
    if (backendStatus !== "connected") return;

    let disposed = false;
    const context: WorkbenchRequestContext = {
      generation: contextGenerationRef.current + 1,
      projectId: resolvedProjectId,
      adapter: workbenchAdapter,
      fence: { requested: 0, applied: 0 },
      disposed: false,
    };
    contextGenerationRef.current = context.generation;
    activeContextRef.current = context;
    const isCurrent = () => !disposed && isCurrentContext(context);
    const nextRequestGeneration = () => {
      context.fence.requested += 1;
      return context.fence.requested;
    };
    const load = async (cursor?: string | null) => {
      if (!disposed) {
        setWorkbench((current) => ({ state: "loading", ...(current?.state === "ready" ? { lastKnown: current.snapshot } : {}) }));
      }
      const loadGeneration = nextRequestGeneration();
      try {
        const response = await context.adapter.load(context.projectId, cursor);
        if (!isCurrent()) return;
        // A newer request, page, or live update was dispatched after this
        // head load: discard the stale response entirely so it cannot replace
        // newer head fields or move the activity cursor.
        if (loadGeneration < context.fence.requested) return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, context.projectId);
        if (snapshot === null) {
          context.fence.applied = loadGeneration;
          setWorkbench({ state: "empty", message: "No authorized project projection is available yet." });
          return;
        }
        context.fence.applied = loadGeneration;
        serverConfirmedRef.current = true;
        setWorkbench((current) => {
          if (current?.state !== "ready" || current.snapshot.project.id !== context.projectId) return { state: "ready", snapshot };
          return { state: "ready", snapshot: applyLiveWorkbenchSnapshot(current.snapshot, snapshot) };
        });
      } catch (error) {
        if (!isCurrent()) return;
        // A newer request superseded this head load: a stale failure must not
        // overwrite a newer successful projection with an error.
        if (loadGeneration < context.fence.requested) return;
        if (error instanceof Error && /forged-identity|unauthenticated/i.test(error.message)) {
          onAuthDenialRef.current?.();
        }
        setWorkbench((current) => ({
          state: "error",
          message: error instanceof Error ? error.message : "The project projection could not be read.",
          ...(current?.state === "ready" ? { lastKnown: current.snapshot } : {}),
        }));
      }
    };
    void load();
    const unsubscribe = context.adapter.subscribe?.(
      context.projectId,
      (response) => {
        if (!isCurrent()) return;
        const snapshot = response === null ? null : parseWorkbenchSnapshot(response, context.projectId);
        const updateGeneration = nextRequestGeneration();
        context.fence.applied = updateGeneration;
        if (snapshot !== null) serverConfirmedRef.current = true;
        setWorkbench((current) => {
          if (snapshot === null) return { state: "empty", message: "No authorized project projection is available yet." };
          if (current?.state !== "ready" || current.snapshot.project.id !== context.projectId) return { state: "ready", snapshot };
          return { state: "ready", snapshot: applyLiveWorkbenchSnapshot(current.snapshot, snapshot) };
        });
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        // A revoked or malformed subscription invalidates all in-flight loads
        // for this client generation. A later reconnect creates a new context.
        context.disposed = true;
        if (activeContextRef.current === context) activeContextRef.current = null;
        setWorkbench({ state: "error", message: error instanceof Error ? error.message : "The project projection could not be refreshed." });
      },
    );
    return () => {
      disposed = true;
      context.disposed = true;
      if (activeContextRef.current === context) activeContextRef.current = null;
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
    const context = activeContextRef.current;
    const cursor = workbench?.state === "ready" ? workbench.snapshot.activity.continueCursor : null;
    if (context === null || cursor === null || cursor === undefined || context.projectId !== resolvedProjectId || context.adapter !== workbenchAdapter) return;
    const requestGeneration = context.fence.requested + 1;
    context.fence.requested = requestGeneration;
    void context.adapter.load(context.projectId, cursor).then((response) => {
      if (!isCurrentContext(context)) return;
      if (response === null) {
        if (requestGeneration < context.fence.requested) return;
        context.fence.applied = requestGeneration;
        setWorkbench({ state: "empty", message: "No authorized project projection is available yet." });
        return;
      }
      const snapshot = parseWorkbenchSnapshot(response, context.projectId);
      if (snapshot === null || !isCurrentContext(context)) return;
      setWorkbench((current) => {
        if (!isCurrentContext(context)) return current;
        if (current?.state !== "ready" || current.snapshot.project.id !== context.projectId) return current;
        const merged = mergeFencedActivityPage(current.snapshot, snapshot, requestGeneration, context.fence.applied);
        context.fence.applied = merged.appliedGeneration;
        return { state: "ready", snapshot: merged.snapshot };
      });
    }).catch((error: unknown) => {
      if (!isCurrentContext(context) || requestGeneration < context.fence.requested) return;
      setWorkbench((current) => {
        if (current?.state !== "ready" || current.snapshot.project.id !== context.projectId) return current;
        return {
          state: "error",
          message: error instanceof Error ? error.message : "More project activity could not be loaded.",
          lastKnown: current.snapshot,
        };
      });
    });
  };

  const handleIntake = async (input: WorkbenchIntakeInput): Promise<WorkbenchIntakeResult> => {
    if (backendStatusRef.current !== "connected") {
      return { ok: false, message: "Intake waits for a live backend connection. Nothing was sent." };
    }
    // Creation mutations additionally wait for server-confirmed
    // authentication: a locally stored session alone never authorizes a send.
    if (!serverConfirmedRef.current) {
      return { ok: false, message: "Intake waits for server-confirmed authentication. Nothing was sent." };
    }
    if (workbenchAdapter?.createIntake === undefined) {
      return { ok: false, message: "No server intake route is configured. Nothing was sent." };
    }
    try {
      const result = await workbenchAdapter.createIntake(input);
      if (result.ok && result.projectId !== undefined) {
        setResolvedProjectId(result.projectId);
      } else if (!result.ok) {
        setActionError(result.message ?? "The server did not create this workspace.");
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The server did not create this workspace.";
      setActionError(message);
      return { ok: false, message };
    }
  };

  const handleSample = async (input: WorkbenchSampleInput): Promise<WorkbenchSampleResult> => {
    if (backendStatusRef.current !== "connected") {
      return { ok: false, message: "Sample creation waits for a live backend connection. Nothing was sent." };
    }
    // Creation mutations additionally wait for server-confirmed
    // authentication: a locally stored session alone never authorizes a send.
    if (!serverConfirmedRef.current) {
      return { ok: false, message: "Sample creation waits for server-confirmed authentication. Nothing was sent." };
    }
    if (workbenchRef.current?.state !== "empty") {
      return { ok: false, message: "Sample creation is available only with no authorized project. Nothing was sent." };
    }
    const callingAdapter = adapterRef.current;
    if (callingAdapter?.createSample === undefined) {
      return { ok: false, message: "No server sample route is configured. Nothing was sent." };
    }
    try {
      const result = await callingAdapter.createSample(input);
      if (result.ok && result.projectId !== undefined) {
        if (backendStatusRef.current !== "connected" || adapterRef.current !== callingAdapter || workbenchRef.current?.state !== "empty") {
          const message = "The sample project may have been created but could not be loaded in this session. Reconnect or discovery can find authorized projects.";
          setActionError(message);
          return { ok: false, message };
        }
        setResolvedProjectId(result.projectId);
      } else if (!result.ok) {
        setActionError(result.message ?? "The server did not create this sample project.");
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The server did not create this sample project.";
      setActionError(message);
      return { ok: false, message };
    }
  };

  const connectedLoadMore = workbench?.state === "ready" && backendStatus === "connected" ? handleLoadMore : undefined;
  // Creation flows are offered only after server-confirmed authentication,
  // never on a merely connected socket with a local-only session. An empty
  // state produced without a successful server round-trip keeps the honest
  // empty message with no enabled creation flow.
  const serverConfirmedCreation = backendStatus === "connected" && serverConfirmedRef.current;
  const connectedIntake = workbench?.state === "empty" && serverConfirmedCreation ? handleIntake : undefined;
  const connectedSample = workbench?.state === "empty" && serverConfirmedCreation ? handleSample : undefined;
  const appWorkbench = backendStatus === "reconnecting" && workbench?.state === "ready"
    ? { state: "reconnecting" as const, lastKnown: workbench.snapshot }
    : workbench;
  return <><App backendStatus={backendStatus} onRetry={onRetry} workbench={appWorkbench} onAction={handleAction} onLoadMore={connectedLoadMore} onIntake={connectedIntake} onSample={connectedSample} />{actionError ? <span className="wb-visually-hidden" role="alert">{actionError}</span> : null}</>;
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

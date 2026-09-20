import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexConnectionState } from "convex/react";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { statusFromConnection } from "./backend-state";
import "./styles.css";

function ConnectionAwareApp({ onRetry }: { onRetry: () => void }) {
  const connection = useConvexConnectionState();
  const auth = useConvexAuth();
  const backendStatus = statusFromConnection({
    isWebSocketConnected: connection.isWebSocketConnected,
    hasEverConnected: connection.hasEverConnected,
    connectionRetries: connection.connectionRetries,
    authLoading: auth.isLoading,
  });

  return <App backendStatus={backendStatus} onRetry={onRetry} />;
}

export type ConvexClientFactory = (url: string) => ConvexReactClient;

const defaultClientFactory: ConvexClientFactory = (url) => new ConvexReactClient(url);

type ClientState = ConvexReactClient | "unavailable" | null;

function ConvexClientBoundary({
  clientFactory,
  onRetry,
  url,
}: {
  clientFactory: ConvexClientFactory;
  onRetry: () => void;
  url: string;
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
      <ConnectionAwareApp onRetry={onRetry} />
    </ConvexAuthProvider>
  );
}

function ConfiguredApplication({
  clientFactory,
  url,
}: {
  clientFactory: ConvexClientFactory;
  url: string;
}) {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = () => setRetryGeneration((generation) => generation + 1);

  return (
    <ConvexClientBoundary
      key={retryGeneration}
      clientFactory={clientFactory}
      onRetry={retry}
      url={url}
    />
  );
}

export interface RootApplicationProps {
  configuredUrl?: string;
  clientFactory?: ConvexClientFactory;
}

export function RootApplication({ configuredUrl, clientFactory = defaultClientFactory }: RootApplicationProps) {
  const configuredUrlFromBuild = configuredUrl ?? import.meta.env.VITE_CONVEX_URL;
  const url = typeof configuredUrlFromBuild === "string" ? configuredUrlFromBuild.trim() : "";
  return url.length > 0 ? <ConfiguredApplication clientFactory={clientFactory} url={url} /> : <App backendStatus="unconfigured" />;
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

import { ConvexAuthProvider, useConvexAuth } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexConnectionState } from "convex/react";
import React, { useMemo, useState } from "react";
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

function ConfiguredApplication({ url }: { url: string }) {
  const [retryGeneration, setRetryGeneration] = useState(0);
  const client = useMemo(() => {
    try {
      return new ConvexReactClient(url);
    } catch {
      return null;
    }
  }, [retryGeneration, url]);
  const retry = () => setRetryGeneration((generation) => generation + 1);

  if (client === null) return <App backendStatus="unavailable" onRetry={retry} />;

  return (
    <ConvexAuthProvider key={retryGeneration} client={client}>
      <ConnectionAwareApp onRetry={retry} />
    </ConvexAuthProvider>
  );
}

export interface RootApplicationProps {
  configuredUrl?: string;
}

export function RootApplication({ configuredUrl }: RootApplicationProps) {
  const configuredUrlFromBuild = configuredUrl ?? import.meta.env.VITE_CONVEX_URL;
  const url = typeof configuredUrlFromBuild === "string" ? configuredUrlFromBuild.trim() : "";
  return url.length > 0 ? <ConfiguredApplication url={url} /> : <App backendStatus="unconfigured" />;
}

if (typeof document !== "undefined") {
  const rootElement = document.getElementById("root");
  if (rootElement === null) throw new Error("OpeningOS root element is missing");

  createRoot(rootElement).render(
    <React.StrictMode>
      <RootApplication />
    </React.StrictMode>,
  );
}

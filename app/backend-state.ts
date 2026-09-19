export type BackendStatus =
  | "unconfigured"
  | "configured-unverified"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "unavailable";

export interface BackendConnectionSnapshot {
  isWebSocketConnected: boolean;
  hasEverConnected: boolean;
  connectionRetries: number;
  authLoading: boolean;
}

/**
 * Reduce the live Convex/auth signals to the small set of user-facing states.
 * A configured URL is deliberately not treated as ready until the client has
 * observed a backend connection.
 */
export function statusFromConnection(snapshot: BackendConnectionSnapshot): Exclude<BackendStatus, "unconfigured"> {
  if (snapshot.isWebSocketConnected) {
    return snapshot.authLoading ? "authenticating" : "connected";
  }
  if (snapshot.hasEverConnected) return "reconnecting";
  if (snapshot.connectionRetries > 0) return "unavailable";
  return "configured-unverified";
}

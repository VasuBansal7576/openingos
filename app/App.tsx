import type { BackendStatus } from "./backend-state";
import WorkbenchView, { WorkbenchUnavailableView, type WorkbenchViewProps } from "./Workbench";
import type { WorkbenchLoadState } from "./workbench-state";

export interface AppProps extends Pick<WorkbenchViewProps, "onAction" | "onLoadMore"> {
  readonly backendStatus?: BackendStatus;
  readonly onRetry?: () => void;
  readonly workbench?: WorkbenchLoadState | undefined;
}

type StatusCopy = {
  eyebrow: string;
  title: string;
  message: string;
  tone: "neutral" | "pending" | "success" | "warning" | "error";
  action?: string;
};

function statusCopy(status: BackendStatus): StatusCopy {
  switch (status) {
    case "unconfigured":
      return {
        eyebrow: "BACKEND NOT CONFIGURED",
        title: "OpeningOS is ready to connect.",
        message: "Add a Convex deployment URL before starting application work. No provider calls or customer data are available in this state.",
        tone: "neutral",
      };
    case "configured-unverified":
      return {
        eyebrow: "BACKEND CONFIGURED / UNVERIFIED",
        title: "Waiting for the first backend response.",
        message: "A Convex URL is configured, but this browser has not observed a connection or identity result yet. Application readiness is not claimed.",
        tone: "pending",
      };
    case "authenticating":
      return {
        eyebrow: "AUTHENTICATING",
        title: "Connecting your workspace.",
        message: "The Convex connection is responding while authentication is still being established. Your workflow will appear after the current identity is known.",
        tone: "pending",
      };
    case "connected":
      return {
        eyebrow: "BACKEND CONNECTED",
        title: "Waiting for the project projection.",
        message: "Convex has reported a live connection, but no authorized project projection is attached to this browser yet. No vendors, quotes or provider outcomes are shown.",
        tone: "pending",
      };
    case "reconnecting":
      return {
        eyebrow: "CONNECTION INTERRUPTED",
        title: "Reconnecting to OpeningOS.",
        message: "The last backend connection was lost. Completed work remains on the server; new actions wait until the connection is observed again.",
        tone: "warning",
        action: "Retry connection",
      };
    case "unavailable":
      return {
        eyebrow: "BACKEND UNAVAILABLE",
        title: "The configured deployment did not respond.",
        message: "OpeningOS cannot verify this backend right now. No provider action or live outcome is reported; retry when the deployment is reachable.",
        tone: "error",
        action: "Retry connection",
      };
  }
}

function WorkbenchConnectionStatus({ status, onRetry }: { readonly status: BackendStatus; readonly onRetry?: (() => void) | undefined }) {
  const copy = statusCopy(status);
  return <WorkbenchUnavailableView {...copy} onRetry={copy.action !== undefined ? onRetry : undefined} />;
}

export default function App({ backendStatus = "unconfigured", onRetry, workbench, onAction, onLoadMore }: AppProps) {
  if (workbench !== undefined && (backendStatus === "connected" || backendStatus === "reconnecting")) {
    return <WorkbenchView loadState={workbench} onRetry={onRetry} onAction={onAction} onLoadMore={onLoadMore} />;
  }
  return <WorkbenchConnectionStatus status={backendStatus} onRetry={onRetry} />;
}

import type { BackendStatus } from "./backend-state";
import LandingView from "./Landing";
import WorkbenchView, { type WorkbenchViewProps } from "./Workbench";
import type { WorkbenchLoadState, WorkbenchSampleInput, WorkbenchSampleResult } from "./workbench-state";

export type AppSampleHandler = (input: WorkbenchSampleInput) => Promise<WorkbenchSampleResult>;

export interface AppProps extends Pick<WorkbenchViewProps, "onAction" | "onLoadMore" | "onIntake"> {
  readonly backendStatus?: BackendStatus;
  readonly onRetry?: () => void;
  readonly workbench?: WorkbenchLoadState | undefined;
  readonly onSample?: AppSampleHandler | undefined;
}

/**
 * Public entry routing for the purchasing workbench.
 *
 * A live connected projection renders the full workbench directly so
 * returning users enter their current project and due decisions. Every other
 * backend lifecycle state renders the public purchasing-workbench landing:
 * static landing content needs no configured backend, and the backend status
 * stays a compact integrated notice that never replaces the whole design and
 * never implies a live connection.
 */
export default function App({ backendStatus = "unconfigured", onRetry, workbench, onAction, onLoadMore, onIntake, onSample }: AppProps) {
  if (workbench !== undefined && (backendStatus === "connected" || backendStatus === "reconnecting")) {
    // Intake and the controlled sample demo are offered only on a live
    // connected empty state through their real adapter routes, rendered
    // inside the landing below. Ready and last-known projections render
    // the full workbench directly.
    const connectedIntake = workbench.state === "empty" && backendStatus === "connected" ? onIntake : undefined;
    const connectedSample = workbench.state === "empty" && backendStatus === "connected" ? onSample : undefined;
    if (workbench.state === "ready" || workbench.state === "reconnecting" || "lastKnown" in workbench) {
      return <WorkbenchView loadState={workbench} onRetry={onRetry} onAction={onAction} onLoadMore={onLoadMore} onIntake={connectedIntake} />;
    }
    return <LandingView backendStatus={backendStatus} onRetry={onRetry} workbench={workbench} onIntake={connectedIntake} onSample={connectedSample} />;
  }
  return <LandingView backendStatus={backendStatus} onRetry={onRetry} workbench={workbench} onIntake={undefined} onSample={undefined} />;
}

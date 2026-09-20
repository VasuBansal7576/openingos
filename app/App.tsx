import type { BackendStatus } from "./backend-state";

export interface AppProps {
  backendStatus?: BackendStatus;
  onRetry?: () => void;
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
        title: "The purchasing workbench can stay in sync.",
        message: "Convex has reported a live connection. Customer workflows remain governed by backend identity, capability, and current authority checks.",
        tone: "success",
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

export default function App({ backendStatus = "unconfigured", onRetry }: AppProps) {
  const copy = statusCopy(backendStatus);

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">OPENINGOS / PURCHASING WORKBENCH</div>
        <h1 id="page-title">Turn supplier uncertainty into a clear next move.</h1>
        <p className="lede">
          A production foundation for bounded research, evidence review, and owner-approved purchasing work.
        </p>
        <div className={`status-card ${copy.tone}`} role="status" aria-live="polite">
          <span className={`status-dot ${copy.tone}`} aria-hidden="true" />
          <div>
            <div className="status-eyebrow">{copy.eyebrow}</div>
            <strong>{copy.title}</strong>
            <p>{copy.message}</p>
            {copy.action !== undefined && onRetry !== undefined ? (
              <button type="button" className="retry-button" onClick={onRetry}>
                {copy.action}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="principles" aria-labelledby="principles-title">
        <div>
          <div className="eyebrow">FOUNDATION STATUS</div>
          <h2 id="principles-title">Built for evidence, authority, and honest waiting.</h2>
        </div>
        <div className="principle-grid">
          <article>
            <span>01</span>
            <h3>Evidence first</h3>
            <p>Every later decision can point back to a bounded source and a reviewable state.</p>
          </article>
          <article>
            <span>02</span>
            <h3>Authority enforced</h3>
            <p>Server-side capabilities and grants remain the source of truth for external effects.</p>
          </article>
          <article>
            <span>03</span>
            <h3>Waiting is visible</h3>
            <p>Unavailable providers stay unavailable until real credentials and allowances exist.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

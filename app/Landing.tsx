import { useEffect, useId, useRef, useState } from "react";
import type { BackendStatus } from "./backend-state";
import { WorkbenchIntakeView, type WorkbenchIntakeHandler } from "./Workbench";
import type { WorkbenchLoadState } from "./workbench-state";

/**
 * Espresso-machine visual for the landing polaroid. Resolved as a relative
 * URL so unit runtimes never load the binary as a module; Vite rewrites this
 * reference into the production bundle at build time.
 */
const espressoMachineUrl = new URL("./assets/espresso-machine.png", import.meta.url).toString();

export interface LandingViewProps {
  readonly backendStatus: BackendStatus;
  readonly onRetry?: (() => void) | undefined;
  readonly workbench?: WorkbenchLoadState | undefined;
  readonly onIntake?: WorkbenchIntakeHandler | undefined;
}

type LandingPanel = "none" | "briefBlocked" | "demo";

interface StatusNotice {
  readonly eyebrow: string;
  readonly message: string;
  readonly tone: "neutral" | "pending" | "warning" | "error";
  readonly action?: string;
}

/**
 * Compact honest backend notice for the public landing. Static landing
 * content renders without a configured backend; this strip names the exact
 * connection state without replacing the design and never implies a live
 * connection.
 */
function statusNotice(backendStatus: BackendStatus, workbench: WorkbenchLoadState | undefined): StatusNotice {
  switch (backendStatus) {
    case "unconfigured":
      return {
        eyebrow: "BACKEND NOT CONFIGURED",
        message: "Landing preview only. Add a Convex deployment URL to start application work. No provider calls or customer data are available in this state.",
        tone: "neutral",
      };
    case "configured-unverified":
      return {
        eyebrow: "BACKEND CONFIGURED / UNVERIFIED",
        message: "A Convex URL is configured, but this browser has not observed a connection yet. Application readiness is not claimed.",
        tone: "pending",
      };
    case "authenticating":
      return {
        eyebrow: "AUTHENTICATING",
        message: "Connecting your workspace. The workbench appears after the current identity is known.",
        tone: "pending",
      };
    case "connected":
      if (workbench?.state === "error") {
        return { eyebrow: "PROJECT STATE UNAVAILABLE", message: workbench.message, tone: "error", action: "Retry project state" };
      }
      if (workbench?.state === "loading") {
        return { eyebrow: "LOADING AUTHORIZED PROJECT", message: "Reading the latest authorized state. No provider outcome is inferred while this is pending.", tone: "pending" };
      }
      return {
        eyebrow: "NO AUTHORIZED PROJECT",
        message: "No authorized project projection is available yet. No vendors, quotes or provider outcomes are shown until server state is available.",
        tone: "neutral",
      };
    case "reconnecting":
      return {
        eyebrow: "CONNECTION INTERRUPTED",
        message: "The last backend connection was lost. Completed work remains on the server; new actions wait until the projection is current again.",
        tone: "warning",
        action: "Retry connection",
      };
    case "unavailable":
      return {
        eyebrow: "BACKEND UNAVAILABLE",
        message: "The configured deployment did not respond. No provider action or live outcome is reported.",
        tone: "error",
        action: "Retry connection",
      };
  }
}

const HOW_IT_WORKS: readonly { readonly step: string; readonly title: string; readonly detail: string }[] = [
  { step: "01", title: "Tell us what you\u2019re opening.", detail: "One short brief. Your equipment, budget and opening date." },
  { step: "02", title: "See the full picture.", detail: "Comparable prices, missing terms and the evidence behind them." },
  { step: "03", title: "Make your next move.", detail: "Ask a supplier, choose an offer, handle a change. Stay in control." },
];

/**
 * Public purchasing-workbench landing. Composition, hierarchy, and visual
 * language follow the accepted `design/purchasing-workbench.html` reference:
 * sage desk canvas, cream quote papers, forest-green controls, warm yellow
 * actions, and editorial serif/sans pairing. Every displayed outcome comes
 * from real application state; the sample demo has no backend route and stays
 * an explicit unavailable state instead of fixture data.
 *
 * When a live connected intake route is attached, the real intake form is
 * embedded below the hero so "Start your own brief" enters the configured
 * flow. Without that route the brief entry stays an honest blocked state.
 */
export default function LandingView({ backendStatus, onRetry, workbench, onIntake }: LandingViewProps) {
  const [panel, setPanel] = useState<LandingPanel>("none");
  const idPrefix = useId().replace(/:/g, "");
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const briefSectionRef = useRef<HTMLElement | null>(null);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const notice = statusNotice(backendStatus, workbench);

  useEffect(() => {
    if (panel !== "none") {
      panelHeadingRef.current?.focus();
      document.getElementById(`${idPrefix}-entry-panel`)?.scrollIntoView({ block: "nearest" });
    }
  }, [panel, idPrefix]);

  const closePanel = (): void => {
    setPanel("none");
    lastTriggerRef.current?.focus();
  };

  useEffect(() => {
    if (panel === "none") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [panel]);

  const openBrief = (trigger: HTMLButtonElement | null): void => {
    lastTriggerRef.current = trigger;
    if (onIntake !== undefined) {
      setPanel("none");
      briefSectionRef.current?.scrollIntoView({ block: "start" });
      briefSectionRef.current?.focus({ preventScroll: true });
      return;
    }
    // No configured intake route: stay on the landing and say exactly why
    // instead of navigating to a fake flow.
    setPanel("briefBlocked");
  };

  const openDemo = (trigger: HTMLButtonElement | null): void => {
    lastTriggerRef.current = trigger;
    setPanel("demo");
  };

  return (
    <div className="wb-app wb-landing">
      <a className="wb-skip-link" href="#workbench-main">Skip to content</a>
      <div className={`wb-landing-status wb-landing-status-${notice.tone}`} role="status" aria-live="polite">
        <span className="wb-landing-status-dot" aria-hidden="true" />
        <span className="wb-landing-status-eyebrow">{notice.eyebrow}</span>
        <span className="wb-landing-status-message">{notice.message}</span>
        {notice.action !== undefined && onRetry !== undefined ? (
          <button type="button" className="wb-landing-status-retry retry-button" onClick={onRetry}>{notice.action}</button>
        ) : null}
      </div>
      <header className="wb-landing-nav">
        <span className="wb-brand" aria-label="OpeningOS">OpeningOS<span className="wb-brand-dot">.</span></span>
        <nav aria-label="Landing navigation">
          <a href="#how-it-works">How it works</a>
        </nav>
        <button
          type="button"
          className="wb-button wb-button-secondary wb-landing-nav-cta"
          onClick={(event) => openDemo(event.currentTarget)}
        >
          Open demo <span aria-hidden="true">&rarr;</span>
        </button>
      </header>
      <main id="workbench-main" tabIndex={-1}>
        <section className="wb-landing-hero" aria-labelledby={`${idPrefix}-hero-title`}>
          <div className="wb-hero-copy">
            <p className="wb-eyebrow wb-hero-eyebrow">
              <span className="wb-landing-status-dot" aria-hidden="true" /> FOR THE PEOPLE OPENING SOMETHING GOOD
            </p>
            <h1 id={`${idPrefix}-hero-title`}>Everything<br />on the table.</h1>
            <p className="wb-hero-description">Your plans, your suppliers, your next move. A little less chasing. A lot more opening.</p>
            <div className="wb-hero-actions">
              <button
                type="button"
                className="wb-button wb-button-primary wb-hero-primary"
                onClick={(event) => openDemo(event.currentTarget)}
              >
                Try the Northside caf&eacute; demo <span aria-hidden="true">&rarr;</span>
              </button>
              <button
                type="button"
                className="wb-text-button wb-hero-brief"
                onClick={(event) => openBrief(event.currentTarget)}
              >
                Start your own brief <span aria-hidden="true">&rarr;</span>
              </button>
            </div>
            <p className="wb-hero-note">No sign-up. No card. Just a good place to start.</p>
          </div>
          <div className="wb-hero-workbench" aria-label="Purchasing desk preview">
            <div className="wb-polaroid">
              <img src={espressoMachineUrl} alt="Unbranded two-group espresso machine" />
              <strong>A good place to begin.</strong>
              <small>Atlas 2G &middot; your first decision</small>
            </div>
            <div className="wb-landing-paper">
              <p className="wb-eyebrow">AN OPENING, IN GOOD HANDS</p>
              <h2>Less chasing.<br />More choosing.</h2>
              <ul className="wb-landing-checks">
                <li>Quotes you can actually compare.</li>
                <li>The small print, brought forward.</li>
                <li>Your next move, ready.</li>
              </ul>
              <button
                type="button"
                className="wb-landing-paper-cta"
                onClick={(event) => openBrief(event.currentTarget)}
              >
                Pull up a chair <span aria-hidden="true">&rarr;</span>
              </button>
            </div>
            <span className="wb-yellow-note" aria-hidden="true">Your next chapter starts here.</span>
          </div>
        </section>

        {panel !== "none" ? (
          <section className="wb-landing-entry" id={`${idPrefix}-entry-panel`} aria-label={panel === "demo" ? "Sample demo status" : "Start your own brief"}>
            {panel === "demo" ? (
              <div className="wb-landing-entry-card wb-landing-entry-unavailable" role="status">
                <p className="wb-eyebrow">NORTHSIDE CAF&Eacute; DEMO &middot; UNAVAILABLE</p>
                <h2 ref={panelHeadingRef} tabIndex={-1}>The sample demo is not available in this build.</h2>
                <p>
                  The Northside caf&eacute; demo needs a real isolated backend-created sample guest project.
                  This backend does not provide a sample-project route, so the demo cannot start without
                  inventing fixture vendors, quotes, or savings, which OpeningOS will not do.
                </p>
                <p className="wb-micro">
                  Missing backend contract: isolated sample-guest-project creation. Only workspace creation
                  through the intake flow (<code>domain/intake:createWorkspace</code>) is configured. This
                  blocker has been reported and no fixture data was substituted.
                </p>
                <div className="wb-landing-entry-actions">
                  {onIntake !== undefined ? (
                    <button type="button" className="wb-button wb-button-primary" onClick={(event) => openBrief(event.currentTarget)}>
                      Start your own brief instead
                    </button>
                  ) : null}
                  <button type="button" className="wb-button wb-button-secondary" onClick={closePanel}>Back to the landing</button>
                </div>
              </div>
            ) : (
              <div className="wb-landing-entry-card wb-landing-entry-unavailable" role="status">
                <p className="wb-eyebrow">YOUR OWN BRIEF &middot; BACKEND REQUIRED</p>
                <h2 ref={panelHeadingRef} tabIndex={-1}>Connect a backend to open a real workspace.</h2>
                <p>
                  Starting your own brief writes a real project through the configured intake flow.{" "}
                  {backendStatus === "unconfigured"
                    ? "No Convex deployment URL is configured in this browser, so nothing was created."
                    : backendStatus === "connected"
                      ? "No intake route is attached to this connected session, so nothing was created."
                      : "The backend connection is not live yet, so nothing was created."}
                </p>
                <div className="wb-landing-entry-actions">
                  <button type="button" className="wb-button wb-button-secondary" onClick={closePanel}>Back to the landing</button>
                </div>
              </div>
            )}
          </section>
        ) : null}

        {onIntake !== undefined ? (
          <section className="wb-landing-brief" id="landing-brief" ref={briefSectionRef} tabIndex={-1} aria-label="Start your own brief">
            <WorkbenchIntakeView onIntake={onIntake} />
          </section>
        ) : null}

        <section className="wb-landing-bottom" id="how-it-works" aria-labelledby={`${idPrefix}-how-title`}>
          <div>
            <p className="wb-eyebrow">FROM IDEA TO OPENING DAY</p>
            <h2 id={`${idPrefix}-how-title`}>A clearer way<br />to get there.</h2>
          </div>
          {HOW_IT_WORKS.map((item) => (
            <article key={item.step}>
              <span>{item.step}</span>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
            </article>
          ))}
        </section>
      </main>
      <footer className="wb-landing-footer">
        <span className="wb-brand">OpeningOS<span className="wb-brand-dot">.</span></span>
        <p>Made for your opening. Useful long after.</p>
        <span>Connected views use authorized backend state</span>
      </footer>
    </div>
  );
}

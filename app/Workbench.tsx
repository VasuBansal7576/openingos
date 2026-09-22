import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DeliveryState,
  WorkbenchAction,
  WorkbenchActionResult,
  WorkbenchActivityItem,
  WorkbenchAsset,
  WorkbenchEvidence,
  WorkbenchImpact,
  WorkbenchIntakeInput,
  WorkbenchIntakeMode,
  WorkbenchIntakeResult,
  WorkbenchLoadState,
  WorkbenchOffer,
  WorkbenchQuote,
  WorkbenchSnapshot,
  WorkbenchSubstitute,
  ProvenanceMode,
} from "./workbench-state";
import {
  deliveryLabel,
  formatDate,
  formatMoney,
  formatStateLabel,
  hasCurrentReviewableQuote,
  provenanceLabel,
} from "./workbench-state";

type Tab = "project" | "suppliers" | "inbox" | "recovery" | "equipment";

type WorkbenchConnectionTone = "neutral" | "pending" | "success" | "warning" | "error";

export interface WorkbenchViewProps {
  readonly loadState: WorkbenchLoadState;
  readonly onRetry?: (() => void) | undefined;
  readonly onAction?: ((action: WorkbenchAction) => Promise<WorkbenchActionResult> | WorkbenchActionResult) | undefined;
  readonly onLoadMore?: (() => void) | undefined;
  readonly onIntake?: ((input: WorkbenchIntakeInput) => Promise<WorkbenchIntakeResult>) | undefined;
}

export type WorkbenchIntakeHandler = NonNullable<WorkbenchViewProps["onIntake"]>;

function Icon({ name, size = 18 }: { readonly name: string; readonly size?: number }) {
  const paths: Record<string, string> = {
    arrow: "M5 12h13m-5-5 5 5-5 5",
    check: "m5 12 4 4L19 6",
    chevron: "m8 5 7 7-7 7",
    close: "m6 6 12 12M18 6 6 18",
    compass: "m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z",
    dots: "M5 12h.01M12 12h.01M19 12h.01",
    file: "M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6",
    inbox: "M4 5h16v14H4zM4 9h5l2 3h2l2-3h5",
    link: "M10 13a5 5 0 0 0 7.1.1l1.4-1.4a5 5 0 0 0-7.1-7.1L10.6 5.4M14 11a5 5 0 0 0-7.1-.1l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8",
    lock: "M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3",
    refresh: "M20 11a8.1 8.1 0 0 0-14.8-3L3 11m0-5v5h5M4 13a8.1 8.1 0 0 0 14.8 3L21 13m0 5v-5h-5",
    search: "m20 20-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z",
    shield: "M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6zM9 12l2 2 4-4",
    spark: "m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4zm6 12 .5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z",
    sync: "M4 12a8 8 0 0 1 13.7-5.6L20 8m0-4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16m0 4v-4h4",
    trend: "M4 17 9 12l3 3 8-8M15 7h5v5",
    truck: "M3 6h11v10H3zM14 10h4l3 3v3h-7zM7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    warning: "M12 3 2.5 20h19zM12 9v5m0 3h.01",
    wrench: "m15 6 3-3 3 3-3 3m-3-3L4 17a2.1 2.1 0 1 0 3 3L18 9",
  };
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.dots} />
    </svg>
  );
}

function Pill({ tone = "neutral", children }: { readonly tone?: "neutral" | "success" | "warning" | "danger" | "live"; readonly children: string }) {
  return <span className={`wb-pill wb-pill-${tone}`}>{children}</span>;
}

function ProvenancePill({ mode, ownerAuthoredTerms = false }: { readonly mode: ProvenanceMode; readonly ownerAuthoredTerms?: boolean }) {
  return (
    <Pill tone={mode === "live" ? "live" : mode === "recorded" ? "warning" : "neutral"}>
      {ownerAuthoredTerms ? `Owner-authored terms · ${provenanceLabel(mode)}` : provenanceLabel(mode)}
    </Pill>
  );
}

function ActionButton({
  children,
  disabled = false,
  kind = "primary",
  className,
  onClick,
  title,
  type = "button",
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly disabled?: boolean;
  readonly kind?: "primary" | "secondary" | "text" | "danger";
  readonly onClick?: () => void;
  readonly title?: string | undefined;
  readonly type?: "button" | "submit";
}) {
  return (
    <button className={`wb-button wb-button-${kind}${className === undefined ? "" : ` ${className}`}`} disabled={disabled} onClick={onClick} title={title} type={type}>
      {children}
    </button>
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    return !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true";
  });
}

type ModalElementRef = { readonly current: HTMLElement | null };

/**
 * Shared modal contract for every workbench overlay.  The overlay can be a
 * direct child of the workbench root (assistant, evidence, selection panels)
 * or nested deep inside page content (the equipment service-case dialog), so
 * the whole background is derived by walking the dialog's ancestor chain:
 * every sibling of every ancestor up to the document body becomes inert and
 * hidden from assistive technology, while the ancestor chain itself stays
 * interactive so the dialog is never hidden by its own background handling.
 * Each mounted dialog records the prior state it observed, so stacked dialogs
 * restore exactly what the dialog beneath them left behind.
 */
function useModalAccessibility(dialogRef: ModalElementRef, onClose: () => void, closeDisabled = false): void {
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || typeof document === "undefined") return;
    const previousActiveElement = document.activeElement as HTMLElement | null;
    // Walk from the overlay to the document body so deeply nested dialogs
    // hide the header, navigation, and every sibling background layer while
    // the dialog's own ancestor chain stays interactive.
    const modalRoot = dialog.closest<HTMLElement>(".wb-overlay") ?? dialog;
    const chain: HTMLElement[] = [];
    let cursor: HTMLElement | null = modalRoot;
    while (cursor !== null && cursor !== document.body) {
      chain.push(cursor);
      cursor = cursor.parentElement;
    }
    const previousBackgroundState: { readonly element: HTMLElement; readonly hadInert: boolean; readonly ariaHidden: string | null }[] = [];
    const seen = new Set<HTMLElement>();
    for (const chainElement of chain) {
      const parent = chainElement.parentElement;
      if (parent === null) continue;
      for (const child of Array.from(parent.children)) {
        const element = child as HTMLElement;
        if (element === chainElement || seen.has(element)) continue;
        seen.add(element);
        previousBackgroundState.push({
          element,
          hadInert: element.hasAttribute("inert"),
          ariaHidden: element.getAttribute("aria-hidden"),
        });
        element.setAttribute("inert", "");
        element.setAttribute("aria-hidden", "true");
      }
    }

    const focusFirst = (): void => {
      const first = focusableElements(dialog)[0];
      (first ?? dialog).focus();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (!closeDisabledRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey ? active === first || !dialog.contains(active) : active === last || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (target === null || !dialog.contains(target as HTMLElement)) focusFirst();
    };

    dialog.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    focusFirst();
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      for (const { element, hadInert, ariaHidden } of previousBackgroundState) {
        if (!hadInert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      previousActiveElement?.focus();
    };
  }, [dialogRef]);
}

function StatusDot({ state }: { readonly state: DeliveryState }) {
  return <span className={`wb-status-dot wb-status-${state}`} aria-hidden="true" />;
}

function EmptyState({ icon, title, message, action }: { readonly icon: string; readonly title: string; readonly message: string; readonly action?: ReactNode }) {
  return (
    <div className="wb-empty">
      <span className="wb-empty-icon"><Icon name={icon} size={24} /></span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { readonly eyebrow: string; readonly title: string; readonly description: string; readonly action?: ReactNode }) {
  return (
    <div className="wb-page-heading">
      <div>
        <div className="wb-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function LoadNotice({ loadState, onRetry }: { readonly loadState: WorkbenchLoadState; readonly onRetry?: (() => void) | undefined }) {
  if (loadState.state === "ready" || loadState.state === "empty") return null;
  const lastKnown = "lastKnown" in loadState ? loadState.lastKnown : undefined;
  const copy = loadState.state === "loading"
    ? { tone: "pending", title: "Loading the project record", message: "Reading the latest authorized state. No provider outcome is inferred while this is pending." }
    : loadState.state === "reconnecting"
      ? { tone: "warning", title: "Connection interrupted", message: "Completed work remains on the server. New actions wait until the projection is current again." }
      : { tone: "danger", title: "Project state needs another check", message: loadState.message };
  return (
    <div className={`wb-load-notice wb-load-${copy.tone}`} role="status" aria-live="polite">
      <StatusDot state={copy.tone === "danger" ? "unknown" : copy.tone === "warning" ? "paused" : "queued"} />
      <div><strong>{copy.title}</strong><p>{copy.message}</p></div>
      {lastKnown ? <Pill tone="warning">Showing last known state</Pill> : null}
      {onRetry && loadState.state !== "loading" ? <ActionButton kind="secondary" onClick={onRetry}><Icon name="refresh" size={15} /> Retry</ActionButton> : null}
    </div>
  );
}

function isControlledSampleProject(project: Pick<WorkbenchSnapshot["project"], "sampleKind" | "sampleLabel">): project is Pick<WorkbenchSnapshot["project"], "sampleKind" | "sampleLabel"> & { readonly sampleKind: "controlledSample"; readonly sampleLabel: string } {
  return project.sampleKind === "controlledSample" && typeof project.sampleLabel === "string" && project.sampleLabel.trim().length > 0;
}

function Header({ activeTab, project, onTabChange, onOpenAssistant, disabled = false }: { readonly activeTab: Tab; readonly project: Pick<WorkbenchSnapshot["project"], "name" | "region" | "currency" | "sampleKind" | "sampleLabel">; readonly onTabChange: (tab: Tab) => void; readonly onOpenAssistant: () => void; readonly disabled?: boolean }) {
  const tabs: readonly [Tab, string, string][] = [
    ["project", "Project", "compass"],
    ["suppliers", "Results", "search"],
    ["inbox", "Inbox", "inbox"],
    ["recovery", "Recovery", "sync"],
    ["equipment", "Equipment", "wrench"],
  ];
  return (
    <>
      <div className="wb-demo-banner">
        <span><span className="wb-live-dot" /> PROJECT WORKBENCH</span>
        <span>Server projection · provider effects remain authorization-bound</span>
        <span className="wb-banner-lock"><Icon name="lock" size={12} /> private project data</span>
      </div>
      <header className="wb-header">
        <button className="wb-brand" type="button" aria-label="OpeningOS project workbench" onClick={() => onTabChange("project")}>
          <span>OpeningOS<span className="wb-brand-dot">.</span></span>
        </button>
        <div className="wb-project-picker" aria-label="Current project">
          <span className="wb-eyebrow">PROJECT</span>
          <strong>{project.name}</strong>
          {isControlledSampleProject(project) ? <span className="wb-sample-pill"><Pill>{project.sampleLabel}</Pill></span> : null}
          <span>{project.region ?? "Region unknown"} · {project.currency ?? "Currency unknown"}</span>
        </div>
        <nav className="wb-nav" aria-label="Project navigation">
          {tabs.map(([tab, label, icon]) => (
            <button key={tab} className={activeTab === tab ? "active" : ""} type="button" aria-current={activeTab === tab ? "page" : undefined} onClick={() => onTabChange(tab)} disabled={disabled}>
              <Icon name={icon} size={16} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="wb-assistant-button" type="button" onClick={onOpenAssistant} aria-label="Open project assistant" disabled={disabled}><Icon name="spark" size={18} /></button>
      </header>
    </>
  );
}

export interface WorkbenchUnavailableViewProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly message: string;
  readonly tone: WorkbenchConnectionTone;
  readonly action?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Keep every connection and configuration state inside the selected purchasing
 * workbench visual system. The shell contains no fixture project, supplier, or
 * financial data, and all controls remain disabled until a real authorized
 * projection is available.
 */
export function WorkbenchUnavailableView({ eyebrow, title, message, tone, action, onRetry }: WorkbenchUnavailableViewProps) {
  const unavailableProject = { name: "No project connected", region: null, currency: null } as const;
  return (
    <div className="wb-app wb-connection-app">
      <Header activeTab="project" project={unavailableProject} onTabChange={() => undefined} onOpenAssistant={() => undefined} disabled />
      <main id="workbench-main" className="wb-page wb-connection-page" tabIndex={-1}>
        <PageHeading
          eyebrow="OPENINGOS / PURCHASING WORKBENCH"
          title="Everything on the table."
          description="Your requirements, suppliers, evidence and next move belong in one decision desk. OpeningOS will not invent any of them while the server record is unavailable."
        />
        <div className="wb-connection-layout">
          <section className={`wb-connection-paper wb-connection-${tone}`} aria-labelledby="connection-title" role="status" aria-live="polite">
            <div className="wb-connection-paper-head">
              <span className={`wb-connection-dot wb-connection-dot-${tone}`} aria-hidden="true" />
              <span className="wb-eyebrow">{eyebrow}</span>
              <span className="wb-paper-version">SERVER STATE<br />NO SAMPLE DATA</span>
            </div>
            <h2 id="connection-title">{title}</h2>
            <p>{message}</p>
            <div className="wb-connection-rule"><span>Provider effects</span><strong>Unavailable</strong></div>
            <div className="wb-connection-rule"><span>Customer data</span><strong>Not displayed</strong></div>
            {action !== undefined && onRetry !== undefined ? <ActionButton className="retry-button" kind="secondary" onClick={onRetry}><Icon name="refresh" size={15} /> {action}</ActionButton> : null}
          </section>
          <aside className="wb-connection-note" aria-label="What happens next">
            <span className="wb-eyebrow">WHAT HAPPENS NEXT</span>
            <h2>The workbench fills from server truth.</h2>
            <p>Once an authorized project projection is connected, this same workspace shows comparable quotes, source evidence, delivery states and the next permitted action.</p>
            <div className="wb-honesty-card"><Icon name="lock" size={18} /><div><strong>Private and fail-closed</strong><p>Missing configuration never falls back to sample vendors, invented prices, or simulated provider success.</p></div></div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function OverviewStrip({ snapshot }: { readonly snapshot: WorkbenchSnapshot }) {
  const budget = snapshot.project.budgetMinorUnits;
  const forecast = snapshot.selectedForecastMinorUnits;
  const requirementsTruncated = snapshot.truncation.requirements;
  const readinessLabel = requirementsTruncated ? "Unavailable" : "Not assessed";
  const readinessDescription = requirementsTruncated
    ? `Showing ${snapshot.requirements.length} visible requirement${snapshot.requirements.length === 1 ? "" : "s"} · complete project scope unavailable`
    : snapshot.requirements.length === 0
      ? "No requirements in scope"
      : `${snapshot.requirements.length} requirement${snapshot.requirements.length === 1 ? "" : "s"} · authoritative result not supplied`;
  return (
    <>
      <section className="wb-overview-strip" aria-label="Project financial overview">
        <div className="wb-overview-intro"><span className="wb-eyebrow">PROCUREMENT READINESS</span><strong>{readinessLabel}</strong><span>{readinessDescription}</span>{isControlledSampleProject(snapshot.project) ? <span className="wb-sample-pill"><Pill>{snapshot.project.sampleLabel}</Pill></span> : null}</div>
      <div className="wb-metric"><span>Approved budget</span><strong>{formatMoney(budget, snapshot.project.currency)}</strong><small>Planning allocation</small></div>
      <div className="wb-metric"><span>Selected forecast</span><strong>{formatMoney(forecast, snapshot.project.currency)}</strong><small>Expected, not yet ordered</small></div>
      <div className="wb-metric"><span>Committed</span><strong>{formatMoney(snapshot.committedMinorUnits, snapshot.project.currency)}</strong><small>Recorded orders only</small></div>
      <div className="wb-metric"><span>Paid</span><strong>{formatMoney(snapshot.paidMinorUnits, snapshot.project.currency)}</strong><small>Confirmed payments</small></div>
      </section>
      {requirementsTruncated ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> Readiness unavailable: the requirements page is truncated and no complete authoritative aggregate was supplied.</div> : null}
    </>
  );
}

function chargeAmountLabel(charge: WorkbenchQuote["charges"][number], fallbackCurrency: string): string {
  switch (charge.state) {
    case "included":
      return "Included";
    case "unknown":
      return "Unknown";
    case "estimated":
      return charge.minorUnits === null
        ? "Estimated range"
        : `Estimated ${formatMoney(charge.minorUnits, charge.currency ?? fallbackCurrency)}`;
    case "notApplicable":
      return "Not applicable";
    default:
      return formatMoney(charge.minorUnits, charge.currency ?? fallbackCurrency);
  }
}

function taxBasisLabel(taxBasis: WorkbenchQuote["taxBasis"]): string {
  switch (taxBasis) {
    case "inclusive":
      return "Tax inclusive";
    case "exclusive":
      return "Tax exclusive";
    default:
      return "Tax basis unknown";
  }
}

/**
 * Concise controlled-fixture card heading. A trailing parenthetical qualifier
 * (for example " (controlled demo)") is omitted from the visible heading only
 * while the same card keeps a visible provenance pill carrying the controlled
 * evidence identity, so no honesty is lost and headings recover source
 * density. The full original name always stays available through the heading
 * title and the review control's accessible label.
 */
function displayVendorName(offer: WorkbenchOffer): string {
  const full = offer.vendor?.name ?? "Unnamed research result";
  if (offer.vendor === null) return full;
  if (offer.provenance !== "fixture" && offer.ownerAuthoredTerms !== true) return full;
  const concise = full.replace(/\s*\([^()]*\)\s*$/, "");
  return concise.length > 0 ? concise : full;
}

/**
 * The source link may call the cited record an original quote document only
 * when a quote exists on the offer AND the cited record itself is
 * quote-bearing (a supplier message, reply, email, or document). A generic
 * research record — a Firecrawl page, article, or directory entry — stays a
 * source record even when the offer happens to carry quote terms.
 */
function isQuoteBearingSourceKind(sourceKind: string): boolean {
  const kind = sourceKind.toLowerCase();
  if (kind.startsWith("firecrawl.") || kind.startsWith("controlled.")) return false;
  return /quote|message|reply|email|document|credit-note|attachment|mailbox|exchange/.test(kind);
}

function sourceLinkLabel(offer: WorkbenchOffer): string {
  const first = offer.evidence[0];
  if (offer.quote !== null && first !== undefined && isQuoteBearingSourceKind(first.sourceKind)) {
    return "Original quote document · View original";
  }
  return "Source record · View source";
}

function QuoteSummary({ quote }: { readonly quote: WorkbenchQuote | null }) {
  if (!quote) return <div className="wb-quote-unknown"><Icon name="warning" size={16} /> Quote terms have not arrived.</div>;
  const unknownCharges = quote.charges.filter((charge) => charge.state === "unknown");
  const totalCurrency = quote.total?.currency ?? quote.currency;
  return (
    <div className="wb-quote-summary">
      <div className="wb-charge-list">{quote.charges.map((charge) => <div key={`${charge.kind}-${charge.scope}`} className={charge.state === "unknown" ? "missing" : undefined}><span>{formatStateLabel(charge.kind)}</span><strong>{chargeAmountLabel(charge, quote.currency)}</strong></div>)}</div>
      <div className="wb-quote-total"><span>{quote.total === null ? "Exact total unavailable" : `Total (${totalCurrency})`}</span><strong>{formatMoney(quote.total?.minorUnits ?? null, totalCurrency)}</strong></div>
      <div className="wb-paper-meta"><span>{taxBasisLabel(quote.taxBasis)}</span></div>
      {unknownCharges.length > 0 ? <div className="wb-unknown-note"><Icon name="warning" size={14} /> {unknownCharges.length} charge{unknownCharges.length === 1 ? "" : "s"} still needs confirmation.</div> : null}
    </div>
  );
}

function OfferCard({ offer, index, selected, onReview, onOpenEvidence }: { readonly offer: WorkbenchOffer; readonly index: number; readonly selected: boolean; readonly onReview: () => void; readonly onOpenEvidence?: ((evidence: WorkbenchEvidence) => void) | undefined }) {
  const isIncompatible = offer.compatibility === "fail";
  const hasUnknown = offer.quote?.charges.some((charge) => charge.state === "unknown") ?? true;
  // Quote-review actions stay disabled until a current compatible quote from
  // a real vendor with an exact decision basis exists. An incomplete live
  // source stays inspectable through its source-record action below.
  const reviewable = hasCurrentReviewableQuote(offer);
  const vendorName = offer.vendor?.name ?? "Unnamed research result";
  const conciseVendorName = displayVendorName(offer);
  const vendorRegions = offer.vendor?.regions.join(", ") || "Service region unknown";
  const firstEvidence = offer.evidence[0];
  const reviewBlockedTitle = offer.vendor === null
    ? "Vendor details are not present in this projection"
    : isIncompatible
      ? "An incompatible result cannot be reviewed as a quote"
      : "Quote review needs a current compatible quote with an exact total";
  return (
    <article className={`wb-offer-card wb-paper-${index % 3} ${selected ? "selected" : ""} ${isIncompatible ? "incompatible" : ""}`}>
      <div className="wb-offer-header wb-paper-head"><div><button type="button" onClick={onReview} aria-label={reviewable ? `Review quote from ${vendorName}` : `Quote review unavailable for ${vendorName}`} disabled={!reviewable} title={reviewable ? undefined : reviewBlockedTitle}><h3 title={vendorName}>{conciseVendorName}</h3></button><p>{offer.productModel} · {offer.variant}</p><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div><span className="wb-paper-version">{offer.quote ? `Quote v${offer.quote.version}` : "No quote yet"}</span></div>
      <p className="wb-paper-kicker">{vendorRegions === "Service region unknown" ? "SERVICE REGION UNKNOWN" : `SERVICE REGION · ${vendorRegions.toUpperCase()}`}</p>
      <div className="wb-paper-rule">QUOTE <span>{offer.quote === null ? "NO QUOTE YET" : offer.quote.superseded ? "SUPERSEDED" : "CURRENT"}</span></div>
      <div className="wb-offer-tags"><Pill tone={offer.compatibility === "pass" ? "success" : offer.compatibility === "fail" ? "danger" : "warning"}>{offer.compatibility === "pass" ? "Fit evidence passed" : offer.compatibility === "fail" ? "Incompatible" : "Fit unknown"}</Pill><Pill>{formatStateLabel(offer.conversationState)}</Pill></div>
      <QuoteSummary quote={offer.quote} />
      <div className="wb-paper-ready"><Icon name="truck" size={14} /><span>{offer.quote?.validUntil ? `Valid through ${formatDate(offer.quote.validUntil)}` : "Validity not confirmed"}</span></div>
      {hasUnknown && !isIncompatible ? <button className="wb-missing-terms" type="button" onClick={firstEvidence && onOpenEvidence ? () => onOpenEvidence(firstEvidence) : onReview}><span>Missing terms</span><Icon name="arrow" size={13} /></button> : null}
      {firstEvidence && onOpenEvidence ? <button className="wb-paper-source" type="button" onClick={() => onOpenEvidence(firstEvidence)}><span>{sourceLinkLabel(offer)}</span><Icon name="link" size={12} /></button> : null}
      <div className="wb-paper-bottom"><span>{offer.quote ? taxBasisLabel(offer.quote.taxBasis) : "No quote terms"}</span><ActionButton kind="secondary" disabled={!reviewable} onClick={onReview} title={reviewable ? undefined : reviewBlockedTitle}>{selected ? "Selected offer" : reviewable ? "Review quote" : "Review unavailable"}<Icon name="arrow" size={15} /></ActionButton></div>
      {hasUnknown && !isIncompatible ? <p className="wb-card-footnote"><Icon name="warning" size={13} /> Unknown charges block an unqualified saving claim.</p> : null}
    </article>
  );
}

function ActivityList({ items, compact = false }: { readonly items: readonly WorkbenchActivityItem[]; readonly compact?: boolean }) {
  if (items.length === 0) return <EmptyState icon="file" title="No activity recorded" message="Server events will appear here when this project changes." />;
  return <div className={`wb-activity-list ${compact ? "compact" : ""}`}>{items.map((item) => <div className="wb-activity-item" key={item.id}><span className={`wb-activity-icon wb-activity-${item.state}`}><Icon name={item.state === "failed" ? "warning" : item.state === "pending" ? "sync" : item.state === "unknown" ? "dots" : "check"} size={14} /></span><div><strong>{item.summary ?? "Activity detail unavailable"}</strong><p>{item.actorLabel ?? "Actor unavailable"} · {formatDate(item.occurredAt)}</p></div><Pill tone={item.state === "failed" ? "danger" : item.state === "unknown" ? "warning" : item.state === "pending" ? "neutral" : "success"}>{formatStateLabel(item.state)}</Pill></div>)}</div>;
}

function AssistantRail({ snapshot, onClose }: { readonly snapshot: WorkbenchSnapshot; readonly onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string[]>([]);
  const dialogRef = useRef<HTMLElement | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-assistant-title`;
  const prompts = ["Why is the complete total unknown?", "What still needs fit confirmation?", "Which terms are owner-authored?"];
  const submit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setAsked((current) => [...current, trimmed]);
    setQuestion("");
  };
  useModalAccessibility(dialogRef, onClose);
  return <div className="wb-overlay"><section className="wb-assistant-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">CONTEXTUAL ASSISTANT</span><h2 id={titleId}>Ask about this decision.</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close assistant"><Icon name="close" size={18} /></button></div><p className="wb-assistant-copy">Answers must use the current project, selected rows and supporting evidence. This panel cannot authorize a send or an order.</p><div className="wb-prompt-grid">{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => submit(prompt)}>{prompt}<Icon name="arrow" size={13} /></button>)}</div><div className="wb-asked" aria-live="polite">{asked.map((item, index) => <div key={`${item}-${index}`}><p className="wb-question">{item}</p><div className="wb-answer"><Pill>{snapshot.provenance.mode === "live" ? "Current project evidence" : "Evidence available, model answer pending"}</Pill><p>{snapshot.provenance.mode === "live" ? "The authorized answer route is not represented in this projection. Review the cited quote and evidence before taking action." : "This project has not supplied a verified live model answer. The UI keeps the question open instead of inventing one."}</p></div></div>)}</div><form className="wb-assistant-input" onSubmit={(event) => { event.preventDefault(); submit(question); }}><label className="wb-visually-hidden" htmlFor={`${idPrefix}-assistant-question`}>Ask about this project</label><input id={`${idPrefix}-assistant-question`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about results, quotes or fit…" maxLength={500} /><button type="submit" disabled={!question.trim()} aria-label="Ask question"><Icon name="arrow" size={17} /></button></form><p className="wb-micro"><Icon name="lock" size={12} /> Server authority remains separate from assistant suggestions.</p></section></div>;
}

function EvidencePanel({ evidence, onClose }: { readonly evidence: WorkbenchEvidence; readonly onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-evidence-title`;
  useModalAccessibility(dialogRef, onClose);
  return <div className="wb-overlay"><section className="wb-evidence-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">SOURCE RECORD</span><h2 id={titleId}>{evidence.label}</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close evidence"><Icon name="close" size={18} /></button></div><div className="wb-document"><div className="wb-document-head"><span>{evidence.sourceKind}</span><ProvenancePill mode={evidence.executionMode} /></div><div className="wb-document-row"><span>Verification</span><strong>{formatStateLabel(evidence.verification)}</strong></div><div className="wb-document-row"><span>Freshness</span><strong>{formatStateLabel(evidence.freshness)}</strong></div><div className="wb-document-row"><span>Counterparty</span><strong>{evidence.counterpartyRole === "ownerStandIn" ? "Owner stand-in · controlled" : formatStateLabel(evidence.counterpartyRole)}</strong></div><div className="wb-document-watermark">PUBLIC PROJECTION · PRIVATE HEADERS REDACTED</div></div>{evidence.sourceUrl !== null ? <p className="wb-evidence-source"><a className="wb-paper-source" href={evidence.sourceUrl} target="_blank" rel="noreferrer">Source record · Open original</a></p> : <p className="wb-micro" role="status">No public source URL was included in this projection. The record above is the complete projected evidence.</p>}<p className="wb-micro">Raw headers, mailbox addresses and provider IDs are never shown in the workbench.</p></section></div>;
}

function SelectionPanel({ offer, snapshot, onClose, onAction, onMessage }: { readonly offer: WorkbenchOffer; readonly snapshot: WorkbenchSnapshot; readonly onClose: () => void; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const quote = offer.quote;
  const vendorName = offer.vendor?.name ?? "Unnamed research result";
  const vendorRegions = offer.vendor?.regions.join(", ") || "Service region unknown";
  const canSelect = snapshot.access.capabilities.canApprove === true && offer.vendor !== null && offer.compatibility === "pass" && quote !== null && quote.comparableTotalMinorUnits !== null && quote.superseded === false;
  const dialogRef = useRef<HTMLElement | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-selection-title`;
  useModalAccessibility(dialogRef, onClose);
  const choose = async () => {
    if (!canSelect || !quote || !onAction) {
      onMessage("Selection waits for an authorized server action and a complete compatible quote.");
      return;
    }
    const result = await onAction({ type: "selectOffer", projectId: snapshot.project.id, offerId: offer.id, quoteId: quote.id, quoteVersion: quote.version });
    onMessage(result.ok ? "Selection request recorded by the server." : result.message ?? "Selection was not recorded.");
    if (result.ok) onClose();
  };
  return <div className="wb-overlay"><section className="wb-selection-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">DECISION REVIEW</span><h2 id={titleId}>{vendorName} · quote v{quote?.version ?? "unknown"}</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close decision review"><Icon name="close" size={18} /></button></div><div className="wb-selection-content"><div className="wb-selection-brand"><span className="wb-vendor-monogram large">{vendorName.slice(0, 1).toUpperCase()}</span><div><h3>{offer.productModel}</h3><p>{offer.variant} · {vendorRegions}</p></div><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div><QuoteSummary quote={quote} /><div className="wb-decision-explanation"><Icon name="shield" size={19} /><div><strong>Selection is not an order.</strong><p>This exact quote would change the selected forecast only. It does not create a commitment, place an order or take payment.</p></div></div>{snapshot.access.capabilities.canApprove === null ? <div className="wb-inline-warning"><Icon name="lock" size={16} /> Approval authority is not represented in this projection.</div> : snapshot.access.capabilities.canApprove === false ? <div className="wb-inline-warning"><Icon name="lock" size={16} /> Your role cannot approve this decision. An authorized approver must review it.</div> : null}{quote?.superseded === true ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> This quote version is superseded. Refresh the projection before approving.</div> : quote?.superseded === null ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> Quote successor status is not represented in this projection. The server must project authoritative successor state before selection can proceed.</div> : null}{quote?.comparableTotalMinorUnits === null ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> An accepted comparison scope is not represented in this projection. Selection stays blocked until the server supplies one.</div> : null}<ActionButton disabled={!onAction || !canSelect} onClick={() => { void choose(); }} title={!onAction ? "No server action is attached" : !canSelect ? "A complete, compatible, current quote and authorized capability are required" : undefined}>Select exact quote <Icon name="check" size={16} /></ActionButton><p className="wb-micro">No order will be placed. No payment will be taken.</p></div></section></div>;
}

interface ComparisonTape {
  readonly text: string;
  readonly exact: boolean;
}

function comparisonTapeFor(offers: readonly WorkbenchOffer[]): ComparisonTape | null {
  for (const offer of offers) {
    for (const verdict of offer.comparisons) {
      const other = offers.find((candidate) => candidate.id === verdict.againstOfferId);
      if (other === undefined) continue;
      // Strict consumer binding: a verdict is displayable only when it names
      // both the opposing candidate and the exact opposing quote currently
      // shown. A null, missing, or mismatched quote identity fails closed so
      // a stale verdict for the same candidate but an unrelated quote is
      // never rendered as the current comparison.
      const displayedOpposingQuoteId = other.quote?.id ?? null;
      if (displayedOpposingQuoteId === null) continue;
      if (verdict.againstQuoteId === null) continue;
      if (verdict.againstQuoteId !== displayedOpposingQuoteId) continue;
      const offerName = offer.vendor?.name ?? "First result";
      const otherName = other.vendor?.name ?? "Second result";
      if (verdict.status === "comparable") {
        const difference = verdict.differenceMinorUnits;
        const cheaper = verdict.cheaper;
        const currency = offer.quote?.total?.currency ?? offer.quote?.currency ?? null;
        const otherCurrency = other.quote?.total?.currency ?? other.quote?.currency ?? null;
        if (difference === null || cheaper === null || currency === null || currency !== otherCurrency) continue;
        if (cheaper === "equal") {
          return { text: `${offerName} and ${otherName} are equal on the accepted comparison scope.`, exact: true };
        }
        const cheaperName = cheaper === "self" ? offerName : otherName;
        const dearerName = cheaper === "self" ? otherName : offerName;
        return { text: `${cheaperName} is ${formatMoney(difference, currency)} lower than ${dearerName} on the accepted comparison scope.`, exact: true };
      }
      if (verdict.status === "estimated" && verdict.estimatedDeltaMinorUnits !== null) {
        const currency = offer.quote?.currency ?? null;
        const otherCurrency = other.quote?.currency ?? null;
        const range = currency !== null && currency === otherCurrency
          ? `${formatMoney(verdict.estimatedDeltaMinorUnits.minimum, currency)} to ${formatMoney(verdict.estimatedDeltaMinorUnits.maximum, currency)}`
          : "an estimated range";
        return { text: `Estimate only: ${range}. No offer is ranked.`, exact: false };
      }
      const label = verdict.status === "incompatible" ? "Not comparable" : "Comparison incomplete";
      return { text: `${label}: ${verdict.reason}. No offer is ranked.`, exact: false };
    }
  }
  return null;
}

function ProjectView({ snapshot, onReview, onAction, onLoadMore, onTabChange, onOpenAssistant, onOpenEvidence, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onReview: (offer: WorkbenchOffer) => void; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onLoadMore?: (() => void) | undefined; readonly onTabChange: (tab: Tab) => void; readonly onOpenAssistant: () => void; readonly onOpenEvidence: (evidence: WorkbenchEvidence) => void; readonly onMessage: (message: string) => void }) {
  const primaryRequirement = snapshot.requirements[0];
  const offers = primaryRequirement ? snapshot.offers.filter((offer) => offer.requirementId === primaryRequirement.id) : [];
  const selected = snapshot.selectedOfferId;
  const [showAll, setShowAll] = useState(false);
  const [researchPending, setResearchPending] = useState(false);
  const researchPendingRef = useRef(false);
  const visibleOffers = showAll ? offers : offers.slice(0, 3);
  const researchDisabled = !onAction || !snapshot.access.capabilities.canResearch || snapshot.truncation.requirements;
  const comparisonTape = comparisonTapeFor(visibleOffers);
  const reviewTarget = visibleOffers.find((offer) => offer.id === selected && hasCurrentReviewableQuote(offer))
    ?? visibleOffers.find((offer) => hasCurrentReviewableQuote(offer))
    ?? null;
  const action = async () => {
    if (researchPendingRef.current) return;
    if (!onAction) { onMessage("This connected view has no server action attached yet. No external effect occurred."); return; }
    researchPendingRef.current = true;
    setResearchPending(true);
    try {
      const result = await onAction({ type: "startResearch", projectId: snapshot.project.id });
      onMessage(result.ok ? "Request accepted by the server." : result.message ?? "Request was not accepted.");
    } finally {
      researchPendingRef.current = false;
      setResearchPending(false);
    }
  };
  return <div className="wb-page wb-compare"><div className="wb-bench-heading"><div><div className="wb-eyebrow">{snapshot.project.name} / YOUR DECISION DESK</div><h1>Everything on the table.</h1><p>Compare results. Check the small print. Choose with confidence. Unknown charges stay visible. An incomplete result is not ranked as a saving.</p><div className="wb-scope-row"><span><Icon name="lock" size={13} /> {snapshot.project.region ?? "Region unknown"} · {snapshot.project.currency ?? "Currency unknown"}</span><span>Need by {formatDate(snapshot.project.needByAt)}</span><ProvenancePill mode={snapshot.provenance.mode} ownerAuthoredTerms={snapshot.provenance.ownerAuthoredTerms} /></div></div><div className="wb-bench-heading-actions"><button className="wb-text-button" type="button" onClick={() => onTabChange("suppliers")}>All {offers.length} results <Icon name="arrow" size={14} /></button><ActionButton kind="secondary" onClick={() => { void action(); }} disabled={researchDisabled || researchPending} title={!onAction ? "Actions wait for a connected projection" : !snapshot.access.capabilities.canResearch ? "Your role cannot start research" : snapshot.truncation.requirements ? "Research waits for a complete requirements projection" : undefined}><Icon name="spark" size={15} /> {researchPending ? "Starting…" : "Start bounded research"}</ActionButton></div></div>{(snapshot.substitutes.some((proposal) => proposal.state === "pending") || snapshot.impacts.some((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown")) ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> Changed terms need review: {snapshot.substitutes.filter((proposal) => proposal.state === "pending").length} substitute {snapshot.substitutes.filter((proposal) => proposal.state === "pending").length === 1 ? "proposal awaits" : "proposals await"} fresh approval and {snapshot.impacts.filter((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown").length} impact {snapshot.impacts.filter((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown").length === 1 ? "assessment needs" : "assessments need"} review. See the Inbox and Recovery tabs. No order was placed.</div> : null}{primaryRequirement ? <><div className="wb-desk-layout"><aside className="wb-desk-product" aria-label={`Requirement under review: ${primaryRequirement.title}`}><div className="wb-polaroid"><div className="wb-polaroid-photo" role="img" aria-label={`Illustrative equipment photo for ${primaryRequirement.title}`} /><strong>{primaryRequirement.title}</strong><small>{primaryRequirement.quantity} {primaryRequirement.unit} · {primaryRequirement.key}</small></div><div className="wb-scope-note"><span className="wb-eyebrow">ON YOUR LIST</span><h2>{primaryRequirement.title}</h2><p>{primaryRequirement.quantity} {primaryRequirement.unit} · Need by {formatDate(primaryRequirement.needByAt)}</p><dl><div><dt>Fulfillment</dt><dd>{formatStateLabel(primaryRequirement.fulfillment)}</dd></div><div><dt>Delivered</dt><dd>{snapshot.deliveredQuantityByRequirement[primaryRequirement.id] ?? "Unknown"} / {primaryRequirement.quantity} {primaryRequirement.unit}</dd></div><div><dt>Allocation</dt><dd>{formatMoney(primaryRequirement.budgetMinorUnits, snapshot.project.currency)}</dd></div><div><dt>State</dt><dd>{formatStateLabel(primaryRequirement.state)}</dd></div></dl></div></aside><div className="wb-desk-papers">{visibleOffers.length > 0 ? <div className="wb-offer-grid">{visibleOffers.map((offer, index) => <OfferCard key={offer.id} offer={offer} index={index} selected={offer.id === selected} onReview={() => onReview(offer)} onOpenEvidence={onOpenEvidence} />)}</div> : <EmptyState icon="search" title="No results have arrived" message="Research can continue independently, but this project has no verified quote to compare yet." action={<ActionButton kind="secondary" onClick={() => onTabChange("suppliers")}>Open results view</ActionButton>} />}{offers.length > 3 ? <button className="wb-load-more" type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer results" : `Show ${offers.length - 3} more results`} <Icon name="chevron" size={14} /></button> : null}</div>{comparisonTape !== null ? <div className={`wb-comparison-tape ${comparisonTape.exact ? "" : "not-ranked"}`} role="status"><Icon name={comparisonTape.exact ? "arrow" : "warning"} size={15} /><span>{comparisonTape.text}</span><Icon name={comparisonTape.exact ? "arrow" : "lock"} size={15} /></div> : null}<div className="wb-bench-action"><div className="wb-bench-selected"><Icon name="check" size={19} /><div><span>{selected ? "Selected" : "Considering"}</span><strong>{selected ? visibleOffers.find((offer) => offer.id === selected)?.vendor?.name ?? "Selected result" : reviewTarget ? `${reviewTarget.vendor?.name ?? "Unnamed research result"} · ${formatMoney(reviewTarget.quote?.total?.minorUnits ?? null, reviewTarget.quote?.total?.currency ?? reviewTarget.quote?.currency ?? null)}` : "No reviewable result"}</strong></div></div><button className="wb-assistant-launch" type="button" onClick={onOpenAssistant}><Icon name="spark" size={21} /><span>Ask about these results…</span><Icon name="arrow" size={17} /></button><div className="wb-bench-cta"><ActionButton kind="primary" disabled={reviewTarget === null} onClick={() => { if (reviewTarget) onReview(reviewTarget); }} title={reviewTarget === null ? "No current compatible quote with an exact total is available in this projection" : undefined}>Review selected result <Icon name="arrow" size={15} /></ActionButton><p className="wb-micro">No order is placed.</p></div></div></div></> : <EmptyState icon="compass" title="No requirements in scope" message="This project has no server-recorded requirement yet. OpeningOS will not invent one from the page brief." action={<ActionButton kind="secondary" disabled title="Requirement creation is a server-authorized workflow">Add a requirement</ActionButton>} />}<OverviewStrip snapshot={snapshot} /><div className="wb-project-lower"><section className="wb-panel wb-financial-panel"><div className="wb-panel-heading"><div><span className="wb-eyebrow">FORECAST, NOT COMMITMENT</span><h2>One decision at a time.</h2></div><Icon name="trend" size={20} /></div><div className="wb-forecast-lines"><div><span>Selected forecast</span><strong>{formatMoney(snapshot.selectedForecastMinorUnits, snapshot.project.currency)}</strong></div><div><span>Committed expenditure</span><strong>{formatMoney(snapshot.committedMinorUnits, snapshot.project.currency)}</strong></div><div><span>Paid amount</span><strong>{formatMoney(snapshot.paidMinorUnits, snapshot.project.currency)}</strong></div></div><p className="wb-micro">Selecting an offer does not place an order. Only a recorded external order changes committed expenditure.</p></section><section className="wb-panel"><div className="wb-panel-heading"><div><span className="wb-eyebrow">RECENT CHANGES</span><h2>Activity with evidence.</h2></div><button className="wb-text-button" type="button" onClick={() => onTabChange("inbox")}>Open inbox <Icon name="arrow" size={14} /></button></div><ActivityList items={snapshot.activity.items.slice(0, 4)} compact />{!snapshot.activity.isDone && onLoadMore ? <ActionButton kind="secondary" onClick={onLoadMore}><Icon name="refresh" size={15} /> Load older activity</ActionButton> : null}</section></div></div>;
}

function SuppliersView({ snapshot, onReview, onOpenEvidence }: { readonly snapshot: WorkbenchSnapshot; readonly onReview: (offer: WorkbenchOffer) => void; readonly onOpenEvidence: (evidence: WorkbenchEvidence) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "compatible" | "needsReview">("all");
  const offers = useMemo(() => snapshot.offers.filter((offer) => { const matchesQuery = `${offer.vendor?.name ?? "Unnamed research result"} ${offer.productModel} ${offer.variant}`.toLowerCase().includes(query.toLowerCase()); const matchesFilter = filter === "all" || filter === "compatible" && offer.compatibility === "pass" || filter === "needsReview" && (offer.compatibility === "unknown" || offer.quote?.charges.some((charge) => charge.state === "unknown")); return matchesQuery && matchesFilter; }), [filter, query, snapshot.offers]);
  return <div className="wb-page"><PageHeading eyebrow="RESEARCH RESULTS / AUTHORIZED PROJECT" title="The whole shortlist." description="Every result remains inspectable, including incomplete and incompatible results." /><div className="wb-tools"><label className="wb-search"><Icon name="search" size={16} /><span className="wb-visually-hidden">Search results</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search results…" /></label><div className="wb-segmented" role="group" aria-label="Filter results"><button className={filter === "all" ? "active" : ""} type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All ({snapshot.offers.length})</button><button className={filter === "compatible" ? "active" : ""} type="button" aria-pressed={filter === "compatible"} onClick={() => setFilter("compatible")}>Fit passed</button><button className={filter === "needsReview" ? "active" : ""} type="button" aria-pressed={filter === "needsReview"} onClick={() => setFilter("needsReview")}>Needs review</button></div></div>{offers.length === 0 ? <EmptyState icon="search" title="No results match that search" message="Clear the filter or wait for the next server projection. No unverified vendor is added to fill the gap." action={<ActionButton kind="text" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</ActionButton>} /> : <div className="wb-supplier-list">{offers.map((offer) => { const vendorName = offer.vendor?.name ?? "Unnamed research result"; const reviewable = hasCurrentReviewableQuote(offer); return <article className="wb-supplier-row" key={offer.id}><div className="wb-vendor-monogram">{vendorName.slice(0, 1).toUpperCase()}</div><div className="wb-supplier-name"><h2>{vendorName}</h2><p>{offer.productModel} · {offer.variant}</p><span>{offer.vendor?.serviceCoverage ?? "Service coverage unknown"}</span></div><div className="wb-supplier-status"><Pill tone={offer.compatibility === "pass" ? "success" : offer.compatibility === "fail" ? "danger" : "warning"}>{offer.compatibility === "pass" ? "Compatible" : offer.compatibility === "fail" ? "Excluded" : "Unknown fit"}</Pill><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div><div className="wb-supplier-price"><strong>{formatMoney(offer.quote?.total?.minorUnits ?? null, offer.quote?.total?.currency ?? offer.quote?.currency ?? null)}</strong><span>{offer.quote?.total === null || offer.quote === null ? "Exact total unavailable" : "Quoted in native currency"}</span></div><div className="wb-supplier-actions"><ActionButton kind="secondary" disabled={!reviewable} onClick={() => onReview(offer)} title={reviewable ? undefined : "Quote review needs a current compatible quote with an exact total"}>{reviewable ? "Review quote" : "Review unavailable"}</ActionButton>{offer.evidence[0] ? <button className="wb-icon-button" type="button" onClick={() => onOpenEvidence(offer.evidence[0]!)} aria-label={`Inspect source for ${vendorName}`}><Icon name="file" size={16} /></button> : null}</div></article>; })}</div>}<p className="wb-micro wb-page-footnote">Showing authorized records for {snapshot.project.name}. Public projections redact owner mailbox addresses, raw headers and provider correlation IDs.</p></div>;
}

function impactTone(impact: WorkbenchImpact): "neutral" | "success" | "warning" | "danger" {
  if (impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown") return "warning";
  if (impact.state === "unknown" || impact.state === "incomplete") return "warning";
  return "neutral";
}

function ImpactCard({ impact }: { readonly impact: WorkbenchImpact }) {
  return (
    <article className="wb-panel wb-impact-card" aria-label={`Changed-term impact for requirement ${impact.requirementId}`}>
      <div className="wb-panel-heading">
        <div>
          <span className="wb-eyebrow">CHANGED TERMS · {impact.trigger === "quoteRevision" ? "QUOTE REVISION" : "WATCH OBSERVATION"}</span>
          <h2>{impact.predecessorQuoteVersion && impact.quoteVersion ? `Quote ${impact.predecessorQuoteVersion} superseded by ${impact.quoteVersion}` : impact.watchResult ? `Watch reported ${impact.watchResult}` : "Terms changed under review"}</h2>
        </div>
        <Pill tone={impactTone(impact)}>{formatStateLabel(impact.orderImpact === "none" ? impact.state : impact.orderImpact)}</Pill>
      </div>
      <p className="wb-asset-note">{impact.reason}</p>
      <div className="wb-case-facts">
        <span>State <strong>{formatStateLabel(impact.state)}</strong></span>
        <span>Order impact <strong>{formatStateLabel(impact.orderImpact)}</strong></span>
        <span>Placed orders <strong>{String(impact.placedOrderCount)}</strong></span>
        <span>Observed <strong>{formatDate(impact.createdAt)}</strong></span>
      </div>
      {impact.state === "unknown" ? <p className="wb-card-footnote"><Icon name="warning" size={13} /> Availability stays unknown and placed orders are unchanged. No delivery outcome is claimed.</p> : null}
      {impact.state === "incomplete" ? <p className="wb-card-footnote"><Icon name="warning" size={13} /> The re-evaluation is incomplete; the truncated scope is not shown as complete.</p> : null}
      {impact.orderImpact === "reviewRequired" ? <p className="wb-card-footnote"><Icon name="shield" size={13} /> Placed orders keep their history. Any substitute needs fresh approval.</p> : null}
    </article>
  );
}

function SubstituteCard({ substitute, snapshot, onAction, onMessage }: { readonly substitute: WorkbenchSubstitute; readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const [pending, setPending] = useState<"approved" | "rejected" | null>(null);
  const hasAuthority = snapshot.access.capabilities.canApprove === true && onAction !== undefined && substitute.state === "pending";
  // Approval acts on the proposed terms and needs a current basis; rejection
  // only closes the proposal, so it stays available on a stale basis.
  const canApprove = hasAuthority && !substitute.basisStale;
  const canReject = hasAuthority;
  const decide = async (decision: "approved" | "rejected") => {
    if (pending !== null || !onAction) return;
    if (snapshot.access.capabilities.canApprove !== true) { onMessage("Substitute approval is blocked until the server confirms approver authority. Nothing was sent."); return; }
    if (decision === "approved" && substitute.basisStale) { onMessage(`This substitute basis changed (${substitute.basisReason}); renewed authority required. Nothing was sent.`); return; }
    setPending(decision);
    try {
      const result = await onAction({ type: "decideSubstituteProposal", projectId: snapshot.project.id, proposalId: substitute.id, decision });
      onMessage(result.ok ? result.message ?? "Substitute decision recorded by the server." : result.message ?? "Substitute decision was not recorded.");
    } finally {
      setPending(null);
    }
  };
  return (
    <article className="wb-panel wb-substitute-card" aria-label={`Substitute proposal ${substitute.id}`}>
      <div className="wb-panel-heading">
        <div>
          <span className="wb-eyebrow">SUBSTITUTE PROPOSAL · {formatStateLabel(substitute.state)}</span>
          <h2>Fresh approval {substitute.state === "pending" ? "required" : `recorded: ${substitute.state}`}</h2>
        </div>
        <Pill tone={substitute.state === "pending" ? (substitute.basisStale ? "danger" : "warning") : substitute.state === "approved" ? "success" : "neutral"}>{substitute.state === "pending" ? (substitute.basisStale ? "Stale basis" : "Awaiting approval") : formatStateLabel(substitute.state)}</Pill>
      </div>
      <p className="wb-asset-note">{substitute.reason}</p>
      <div className="wb-case-facts">
        <span>Proposed quote <strong>{substitute.proposedQuoteVersion}</strong></span>
        <span>Basis <strong>{substitute.basisStale ? "Stale" : "Current"}</strong></span>
        <span>Proposed <strong>{formatDate(substitute.createdAt)}</strong></span>
      </div>
      <p className="wb-micro"><Icon name={substitute.basisStale ? "warning" : "shield"} size={12} /> {substitute.basisReason}</p>
      {substitute.state === "pending" ? (
        <div className="wb-job-actions">
          <ActionButton kind="secondary" disabled={!canApprove || pending !== null} onClick={() => { void decide("approved"); }} title={!onAction ? "Decisions wait for a connected projection" : snapshot.access.capabilities.canApprove !== true ? "Your role cannot approve substitutes" : substitute.basisStale ? substitute.basisReason : undefined}>{pending === "approved" ? "Approving…" : "Approve substitute"}</ActionButton>
          <ActionButton kind="text" disabled={!canReject || pending !== null} onClick={() => { void decide("rejected"); }} title={!onAction ? "Decisions wait for a connected projection" : snapshot.access.capabilities.canApprove !== true ? "Your role cannot reject substitutes" : undefined}>{pending === "rejected" ? "Rejecting…" : "Reject"}</ActionButton>
        </div>
      ) : (
        <p className="wb-micro"><Icon name="lock" size={12} /> This proposal is decided. Executing an approved substitute remains an explicit new selection; history is preserved.</p>
      )}
    </article>
  );
}

function DueDecisionsSection({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const pendingSubstitutes = snapshot.substitutes.filter((proposal) => proposal.state === "pending");
  const reviewImpacts = snapshot.impacts.filter((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown" || impact.state !== "recorded");
  if (pendingSubstitutes.length === 0 && reviewImpacts.length === 0) {
    return <EmptyState icon="inbox" title="No changed terms need review" message="Stored impact assessments and substitute proposals will appear here with their reason and currentness. Nothing is invented while the projection is empty." />;
  }
  return (
    <div className="wb-recovery-list">
      {snapshot.truncation.impacts ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> More changed-term assessments exist than this projection shows. The list is truncated.</div> : null}
      {snapshot.truncation.substitutes ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> More substitute proposals exist than this projection shows. The list is truncated.</div> : null}
      {reviewImpacts.map((impact) => <ImpactCard key={impact.id} impact={impact} />)}
      {pendingSubstitutes.map((substitute) => <SubstituteCard key={substitute.id} substitute={substitute} snapshot={snapshot} onAction={onAction} onMessage={onMessage} />)}
    </div>
  );
}

function InboxView({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const openDecisions = snapshot.decisions.filter((decision) => decision.state === "requested");
  const jobs = snapshot.jobs;
  const pendingE8Substitutes = snapshot.substitutes.filter((proposal) => proposal.state === "pending");
  const reviewE8Impacts = snapshot.impacts.filter((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown" || impact.state !== "recorded");
  const inboxIsEmpty = openDecisions.length === 0 && jobs.length === 0 && pendingE8Substitutes.length === 0 && reviewE8Impacts.length === 0;
  const approve = async (decisionId: string) => {
    if (snapshot.access.capabilities.canApprove !== true || !onAction) { onMessage(snapshot.access.capabilities.canApprove === null ? "Approval is blocked because authority is not represented in this projection." : "Approval is blocked until the server confirms an approver and a current action route."); return; }
    const result = await onAction({ type: "approveDecision", projectId: snapshot.project.id, decisionId });
    onMessage(result.ok ? "Approval request recorded by the server." : result.message ?? "Approval was not recorded.");
  };
  return <div className="wb-page"><PageHeading eyebrow="PROJECT CONVERSATION" title="Ask once. Keep the answer." description="Every reply belongs to the decision. Every message starts with your approval." />{inboxIsEmpty ? <EmptyState icon="inbox" title="Nothing needs your review" message="When a quote, provider outcome or requirement changes, the server will add a decision with its evidence." /> : <div className="wb-inbox-layout"><aside className="wb-inbox-list"><span className="wb-eyebrow">OPEN ITEMS</span>{openDecisions.map((decision) => <button className="wb-thread-card" key={decision.id} type="button"><span className="wb-thread-icon"><Icon name={decision.type === "recovery" ? "sync" : "file"} size={17} /></span><span><strong>{formatStateLabel(decision.type)} review</strong><small>{decision.summary ?? "Decision detail unavailable"}</small></span><Pill tone="warning">Review</Pill></button>)}{jobs.map((job) => <div className="wb-thread-card readonly" key={job.id}><span className="wb-thread-icon"><StatusDot state={job.delivery} /></span><span><strong>{formatStateLabel(job.kind)} job</strong><small>{job.summary ?? jobStateSummary(job)}</small></span><Pill tone={job.delivery === "delivered" ? "success" : job.delivery === "unknown" ? "warning" : job.delivery === "paused" ? "danger" : "neutral"}>{deliveryLabel(job.delivery)}</Pill></div>)}</aside><section className="wb-panel wb-conversation"><div className="wb-conversation-head"><div><span className="wb-eyebrow">CURRENT REVIEW</span><h2>{openDecisions.length > 0 ? openDecisions[0]!.summary ?? "Decision detail unavailable" : "Provider activity"}</h2><p>Project-scoped view · {snapshot.provenance.label}</p></div><Pill tone={openDecisions.length > 0 ? "warning" : "neutral"}>{openDecisions.length > 0 ? "Authorization needed" : "No new decision"}</Pill></div>{openDecisions.length > 0 ? <div className="wb-decision-body"><div className="wb-decision-evidence"><Icon name="shield" size={19} /><div><strong>Immutable decision basis</strong><p>{openDecisions[0]!.scope ?? "Decision scope is not present in this projection."}</p>{openDecisions[0]!.snapshotHash ? <code>Snapshot hash · {openDecisions[0]!.snapshotHash}</code> : <p>Snapshot hash is not present in this projection.</p>}{openDecisions[0]!.quoteId ? <p>Current quote · {openDecisions[0]!.quoteId}{openDecisions[0]!.quoteVersion ? ` · version ${openDecisions[0]!.quoteVersion}` : ""}</p> : <p>Current quote identity is not present in this projection.</p>}</div></div><div className="wb-decision-rule"><Icon name="shield" size={18} /><p>Approval is bound to the exact project, offer and quote version. A changed quote invalidates the old request. Approval records authorization only; it does not place an order.</p></div><ActionButton disabled={!onAction || snapshot.access.capabilities.canApprove !== true} onClick={() => { void approve(openDecisions[0]!.id); }} title={!onAction ? "Actions wait for a connected projection" : snapshot.access.capabilities.canApprove === false ? "Approver capability required" : undefined}>Approve this decision <Icon name="check" size={16} /></ActionButton></div> : <ActivityList items={snapshot.activity.items} />}</section></div>}<div className="wb-delivery-table"><div className="wb-section-heading compact"><div><span className="wb-eyebrow">OUTBOUND AND RECOVERY STATES</span><h2>Outcome is a separate fact.</h2></div></div>{jobs.length === 0 ? <EmptyState icon="truck" title="No provider jobs recorded" message="Queued, sent, delivered, unknown, partial and paused states will appear here from server state." /> : jobs.map((job) => <JobRow key={job.id} job={job} snapshot={snapshot} retained={null} onAction={onAction} onMessage={onMessage} />)}</div><div className="wb-delivery-table"><div className="wb-section-heading compact"><div><span className="wb-eyebrow">CHANGED TERMS & SUBSTITUTES</span><h2>Due decisions with their reason and basis.</h2><p>Stored impact assessments keep their unknown and incomplete states. Substitute proposals require fresh approval while their basis is current.</p></div></div><DueDecisionsSection snapshot={snapshot} onAction={onAction} onMessage={onMessage} /></div></div>;
}

/**
 * Useful recovery copy derived only from projected job facts (kind, state,
 * delivery, attempts, updated time). The projection carries no free-text
 * summary, so each state explains itself instead of claiming detail that was
 * never projected. There is intentionally no retry control here: the backend
 * exposes no safe retry contract, and a button that always fails would be a
 * fake recovery action.
 */
function jobStateSummary(job: WorkbenchSnapshot["jobs"][number]): string {
  if (job.state === "partial") return "Partial provider outcome: completed branches are kept and the remaining branch did not report.";
  if (job.state === "pausedBudget") return "Paused before spending provider allowance: no provider cost accrues while paused.";
  if (job.delivery === "unknown") return "Provider outcome unknown: the reservation is retained while reconciliation runs.";
  if (job.state === "failed") return "Ended without a usable provider outcome: completed evidence stays visible.";
  if (job.state === "completed") return "Finished with a reported provider outcome.";
  if (job.state === "cancelled" || job.state === "cancelling") return "Cancellation recorded: already dispatched work may still reconcile.";
  if (job.state === "waitingForSupplier" || job.state === "waitingForUser") return "Waiting by design: active provider work is suspended, not lost.";
  return "Provider work recorded: the outcome is pending or delivered as labeled.";
}

/** Honest next step for recovery-relevant jobs; null keeps other rows quiet. */
function jobNextStep(job: WorkbenchSnapshot["jobs"][number]): string | null {
  if (job.state === "partial") return "Next step: keep the completed evidence below while the server re-drives only the failed branch. No model continuation is running.";
  if (job.delivery === "unknown" || job.state === "failed") return "Next step: wait for server reconciliation or an authorized review. An ambiguous external action is never resent automatically.";
  if (job.delivery === "paused") return "Next step: raise the provider allowance or resume from the server. Completed evidence remains visible meanwhile.";
  return null;
}

function JobRow({ job, snapshot, retained, onAction, onMessage }: { readonly job: WorkbenchSnapshot["jobs"][number]; readonly snapshot: WorkbenchSnapshot; readonly retained: { readonly results: number; readonly withEvidence: number } | null; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const canCancel = job.cancellable && (job.state === "queued" || job.state === "running" || job.state === "waitingForSupplier" || job.state === "waitingForUser");
  const cancel = async () => {
    if (!onAction || !job.cancellable) { onMessage("This action is not authorized in the current project role or connection state."); return; }
    const result = await onAction({ type: "cancelJob", projectId: snapshot.project.id, jobId: job.id });
    onMessage(result.ok ? "Cancel request recorded by the server." : result.message ?? "The server did not accept this action.");
  };
  const nextStep = jobNextStep(job);
  const showRetained = retained !== null && (job.state === "partial" || job.delivery === "unknown" || job.delivery === "paused" || job.state === "failed");
  return <article className="wb-job-row"><div className="wb-job-state"><StatusDot state={job.delivery} /><div><strong>{formatStateLabel(job.kind)} · {deliveryLabel(job.delivery)}</strong><p>{job.summary ?? jobStateSummary(job)}</p></div></div><div className="wb-job-progress"><span>{job.progress === null ? "Progress unknown" : `${Math.round(job.progress * 100)}%`}</span><div className="wb-progress-track"><span style={{ width: `${job.progress === null ? 0 : Math.max(0, Math.min(100, job.progress * 100))}%` }} /></div></div><div className="wb-job-meta"><span>Attempt {job.attempts}</span><span>Updated {formatDate(job.updatedAt)}</span></div>{showRetained && retained !== null ? <p className="wb-card-footnote"><Icon name="check" size={13} /> Retained in this projection: {retained.withEvidence} of {retained.results} visible results carry recorded evidence.</p> : null}{nextStep !== null ? <p className="wb-card-footnote"><Icon name="shield" size={13} /> {nextStep}</p> : null}<div className="wb-job-actions">{canCancel ? <ActionButton kind="text" disabled={!onAction || !job.cancellable} onClick={() => { void cancel(); }}>Cancel</ActionButton> : null}</div>{job.failureCode ? <p className="wb-card-footnote"><Icon name="warning" size={13} /> {job.failureCode} · completed results remain retained.</p> : null}</article>;
}

function RecoveryView({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const recoverable = snapshot.jobs.filter((job) => job.delivery === "unknown" || job.delivery === "partial" || job.delivery === "paused" || job.state === "failed");
  const retained = { results: snapshot.offers.length, withEvidence: snapshot.offers.filter((offer) => offer.evidence.length > 0).length };
  const reviewImpacts = snapshot.impacts.filter((impact) => impact.orderImpact === "reviewRequired" || impact.orderImpact === "unknown" || impact.state !== "recorded");
  const pendingSubstitutes = snapshot.substitutes.filter((proposal) => proposal.state === "pending");
  return <div className="wb-page"><PageHeading eyebrow="BOUNDED RECOVERY" title="A setback. Not a restart." description="Keep the context, preserve completed evidence, and expose the next authorized move." />{reviewImpacts.length > 0 || pendingSubstitutes.length > 0 ? <div className="wb-recovery-list">{reviewImpacts.map((impact) => <ImpactCard key={impact.id} impact={impact} />)}{pendingSubstitutes.map((substitute) => <SubstituteCard key={substitute.id} substitute={substitute} snapshot={snapshot} onAction={onAction} onMessage={onMessage} />)}</div> : null}{recoverable.length === 0 && reviewImpacts.length === 0 && pendingSubstitutes.length === 0 ? <div className="wb-recovery-empty"><EmptyState icon="sync" title="No recovery is waiting" message="The current server projection has no unknown, partial, paused or failed provider job, and no changed-term impact or substitute proposal needs review." /><div className="wb-honesty-card"><Icon name="shield" size={20} /><div><strong>Recovery stays bounded</strong><p>OpeningOS will not resend an ambiguous external action or erase the original outcome. It waits for reconciliation or an explicit authorized review.</p></div></div></div> : <div className="wb-recovery-list">{recoverable.map((job) => <JobRow key={job.id} job={job} snapshot={snapshot} retained={retained} onAction={onAction} onMessage={onMessage} />)}</div>}<div className="wb-recovery-story"><span className="wb-eyebrow">THE STORY, NOT JUST THE STATUS</span>{snapshot.activity.items.slice(0, 5).map((item) => <div key={item.id}><span className="wb-story-mark"><Icon name={item.state === "failed" ? "warning" : "check"} size={13} /></span><div><strong>{item.summary ?? "Activity detail unavailable"}</strong><p>{formatDate(item.occurredAt)} · {item.actorLabel ?? "Actor unavailable"}</p></div></div>)}</div></div>;
}

function AssetServiceCase({ serviceCase }: { readonly serviceCase: WorkbenchSnapshot["equipment"]["assets"][number]["serviceCases"][number] }) {
  return (
    <li className="wb-case-row">
      <div className="wb-case-head">
        <strong>{serviceCase.summary}</strong>
        <Pill tone={serviceCase.state === "resolved" || serviceCase.state === "closed" ? "success" : serviceCase.state === "open" ? "warning" : "neutral"}>{formatStateLabel(serviceCase.state)}</Pill>
      </div>
      <div className="wb-case-facts">
        <span>Urgency <strong>{formatStateLabel(serviceCase.urgency)}</strong></span>
        <span>Opened <strong>{formatDate(serviceCase.createdAt)}</strong></span>
        <span>Updated <strong>{formatDate(serviceCase.updatedAt)}</strong></span>
      </div>
      <p className="wb-case-outcome">{serviceCase.outcome === null ? "Outcome pending; no recorded result in this projection." : serviceCase.outcome}</p>
    </li>
  );
}

type ServiceCaseUrgency = "urgent" | "high" | "normal" | "low";
const SERVICE_CASE_SUMMARY_LIMIT = 800;

function createServiceCaseIdempotencyKey(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to a local opaque key in runtimes without Web Crypto.
  }
  return `service-case-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ServiceCaseDialog({
  asset,
  projectId,
  onAction,
  onMessage,
  onClose,
}: {
  readonly asset: WorkbenchAsset;
  readonly projectId: string;
  readonly onAction?: WorkbenchViewProps["onAction"];
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
}) {
  const [urgency, setUrgency] = useState<ServiceCaseUrgency>("normal");
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submittedFingerprint, setSubmittedFingerprint] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-service-case-title`;
  const descriptionId = `${idPrefix}-service-case-description`;
  const urgencyId = `${idPrefix}-service-case-urgency`;
  const summaryId = `${idPrefix}-service-case-summary`;
  const countId = `${idPrefix}-service-case-count`;
  const errorId = `${idPrefix}-service-case-error`;

  useModalAccessibility(dialogRef, onClose, pending);

  const fingerprintFor = (nextUrgency: ServiceCaseUrgency, nextSummary: string) => `${nextUrgency}\u0000${nextSummary.trim()}`;
  const updateUrgency = (nextUrgency: ServiceCaseUrgency) => {
    setUrgency(nextUrgency);
    if (submittedFingerprint !== null && fingerprintFor(nextUrgency, summary) !== submittedFingerprint) {
      setSubmittedFingerprint(null);
      setIdempotencyKey(null);
    }
  };
  const updateSummary = (nextSummary: string) => {
    setSummary(nextSummary);
    if (submittedFingerprint !== null && fingerprintFor(urgency, nextSummary) !== submittedFingerprint) {
      setSubmittedFingerprint(null);
      setIdempotencyKey(null);
    }
  };
  const submit = async () => {
    if (pending || submittingRef.current || !onAction) return;
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length === 0 || trimmedSummary.length > SERVICE_CASE_SUMMARY_LIMIT) {
      setError("Add a concise summary before opening the service case.");
      return;
    }
    const fingerprint = fingerprintFor(urgency, summary);
    const key = idempotencyKey ?? createServiceCaseIdempotencyKey();
    submittingRef.current = true;
    setIdempotencyKey(key);
    setSubmittedFingerprint(fingerprint);
    setError(null);
    setPending(true);
    try {
      const result = await onAction({
        type: "openServiceCase",
        projectId,
        assetId: asset.id,
        urgency,
        summary: trimmedSummary,
        idempotencyKey: key,
      });
      if (!result.ok) {
        setError(result.message ?? "The server did not record this service case.");
        return;
      }
      onMessage(result.message ?? "Service case recorded by the server.");
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The server did not record this service case.");
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="wb-overlay wb-service-case-overlay">
      <section
        className="wb-service-case-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error === null ? descriptionId : `${descriptionId} ${errorId}`}
        aria-busy={pending}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="wb-panel-head">
          <div>
            <span className="wb-eyebrow">SERVICE FOLLOW-THROUGH</span>
            <h2 id={titleId}>Open a service case for {asset.label}</h2>
          </div>
          <button className="wb-icon-button" type="button" onClick={onClose} disabled={pending} aria-label="Close service case dialog">
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="wb-service-case-description" id={descriptionId}>
          This records a project-scoped service request for the installed asset. It does not place an order or imply a provider outcome.
        </p>
        <form className="wb-service-case-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="wb-form-field">
            <label htmlFor={urgencyId}>Urgency</label>
            <select id={urgencyId} value={urgency} onChange={(event) => updateUrgency(event.target.value as ServiceCaseUrgency)} disabled={pending}>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="wb-form-field">
            <label htmlFor={summaryId}>What needs attention?</label>
            <textarea
              id={summaryId}
              value={summary}
              onChange={(event) => updateSummary(event.target.value)}
              maxLength={SERVICE_CASE_SUMMARY_LIMIT}
              rows={5}
              placeholder="Describe the issue or requested service"
              disabled={pending}
              aria-describedby={countId}
            />
            <span className="wb-character-count" id={countId} aria-live="polite">{summary.length}/{SERVICE_CASE_SUMMARY_LIMIT} characters</span>
          </div>
          {error !== null ? <p className="wb-form-error" id={errorId} role="alert">{error}</p> : null}
          <div className="wb-service-case-actions">
            <ActionButton kind="text" onClick={onClose} disabled={pending}>Cancel</ActionButton>
            <ActionButton kind="primary" type="submit" disabled={pending || !onAction || summary.trim().length === 0}>
              {pending ? "Recording…" : "Open service case"}
            </ActionButton>
          </div>
        </form>
      </section>
    </div>
  );
}

function AssetCard({ asset, projectId, canOpenServiceCase, onAction, onMessage }: { readonly asset: WorkbenchSnapshot["equipment"]["assets"][number]; readonly projectId: string; readonly canOpenServiceCase: boolean; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const headingId = `asset-${asset.id}-heading`;
  const [dialogOpen, setDialogOpen] = useState(false);
  const canOpen = canOpenServiceCase && onAction !== undefined;
  return (
    <>
      <article className="wb-panel wb-equipment-card" aria-labelledby={headingId}>
      <div className="wb-equipment-top">
        <span className="wb-equipment-icon"><Icon name="wrench" size={26} /></span>
        <Pill tone="success">Installed asset record</Pill>
      </div>
      <h2 id={headingId}>{asset.label}</h2>
      <p className="wb-asset-meta">Recorded {formatDate(asset.createdAt)}</p>
      <dl className="wb-asset-facts">
        <div><dt>Serial</dt><dd>{asset.serial ?? "Not recorded"}</dd></div>
        <div><dt>Constraints</dt><dd>{asset.constraints ?? "None recorded"}</dd></div>
        <div><dt>Purchase provenance</dt><dd>{asset.purchaseProvenance ?? "Not recorded"}</dd></div>
      </dl>
      <section className="wb-asset-section" aria-label={`Documents for ${asset.label}`}>
        <span className="wb-eyebrow">PURCHASE & WARRANTY DOCUMENTS</span>
        {asset.documents.length === 0 ? (
          <p className="wb-asset-note">No documents are attached to this asset in the current projection.</p>
        ) : (
          <ul className="wb-document-list">
            {asset.documents.map((document, index) => (
              <li key={`${document.kind}-${document.createdAt}-${index}`}>
                <Icon name="file" size={14} />
                <span>{formatStateLabel(document.kind)}</span>
                <span>{formatDate(document.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {asset.documentsTruncated ? <p className="wb-card-footnote" role="status"><Icon name="warning" size={13} /> More documents exist than this projection shows. The list is truncated.</p> : null}
      </section>
      <section className="wb-asset-section" aria-label={`Service cases for ${asset.label}`}>
        <span className="wb-eyebrow">SERVICE CASES</span>
        {asset.serviceCases.length === 0 ? (
          <p className="wb-asset-note">No service case is recorded for this asset in the current projection.</p>
        ) : (
          <ul className="wb-case-list">
            {asset.serviceCases.map((serviceCase) => <AssetServiceCase key={serviceCase.id} serviceCase={serviceCase} />)}
          </ul>
        )}
        {asset.serviceCasesTruncated ? <p className="wb-card-footnote" role="status"><Icon name="warning" size={13} /> More service cases exist than this projection shows. The list is truncated.</p> : null}
      </section>
        <div className="wb-asset-foot">
          <ActionButton
            kind="secondary"
            disabled={!canOpen}
            onClick={() => setDialogOpen(true)}
            title={!canOpen ? "Service-case creation waits for a connected authorized projection and contributor-or-higher authority." : undefined}
          >
            Open service case
          </ActionButton>
          <p className="wb-micro"><Icon name="lock" size={12} /> {canOpen ? "The server will record this request against the current asset." : "Service-case creation waits for a connected authorized contributor or higher role."}</p>
        </div>
      </article>
      {dialogOpen && canOpen ? <ServiceCaseDialog asset={asset} projectId={projectId} onAction={onAction} onMessage={onMessage} onClose={() => setDialogOpen(false)} /> : null}
    </>
  );
}

function EquipmentView({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const { assets, assetsTruncated } = snapshot.equipment;
  return (
    <div className="wb-page">
      <PageHeading
        eyebrow="EQUIPMENT & FOLLOW-THROUGH"
        title="Good equipment. A longer story."
        description="Installed assets with their purchase and warranty documents and service cases, read from the server projection. A selected, ordered, or fulfilled requirement never appears here on its own."
      />
      {assets.length === 0 ? (
        <div className="wb-equipment-empty">
          <EmptyState
            icon="wrench"
            title="No installed equipment in this project"
            message="This projection contains no installed-asset records. A selected, ordered, installed, or fulfilled requirement is not an asset until commissioning is recorded by an authorized user."
          />
          <div className="wb-honesty-card">
            <Icon name="lock" size={20} />
            <div>
              <strong>Asset creation is explicit</strong>
              <p>There is no installed-asset record in this projection. OpeningOS will not invent an asset or send a service request without one.</p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {assetsTruncated ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> More installed assets exist than this projection shows. Showing the first {assets.length}.</div> : null}
          <div className="wb-equipment-list">
            {assets.map((asset) => <AssetCard key={asset.id} asset={asset} projectId={snapshot.project.id} canOpenServiceCase={snapshot.access.capabilities.canOpenServiceCase} onAction={onAction} onMessage={onMessage} />)}
          </div>
        </>
      )}
    </div>
  );
}

function createIntakeKey(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to a local opaque key in runtimes without Web Crypto.
  }
  return `intake-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const INTAKE_MODES: readonly { readonly value: WorkbenchIntakeMode; readonly title: string; readonly detail: string }[] = [
  { value: "opening", title: "Plan an opening", detail: "Opening brief, budget ceiling, and deadline for a new location." },
  { value: "quoteComparison", title: "Compare quotes", detail: "Bring existing offers for one requirement." },
  { value: "equipment", title: "Equipment case", detail: "A service issue on installed equipment." },
];

function intakeFingerprint(values: {
  readonly mode: WorkbenchIntakeMode;
  readonly projectName: string;
  readonly workspaceKind: string;
  readonly region: string;
  readonly currency: string;
  readonly needBy: string;
  readonly budget: string;
  readonly detailTitle: string;
  readonly detailCategory: string;
  readonly detailSummary: string;
  readonly urgency: string;
}): string {
  return JSON.stringify(values);
}

/**
 * Exact decimal-string to minor-unit parsing for the intake budget. The
 * shape is digits with at most two fractional digits; the magnitude is
 * computed with BigInt so values near the safe-integer boundary are exact
 * and never pass through floating-point multiplication. Anything else —
 * exponents, signs, extra precision, NaN/Infinity text, or a magnitude
 * above Number.MAX_SAFE_INTEGER — returns null and the caller fails closed
 * without reaching the intake route.
 */
function parseIntakeBudgetMinorUnits(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1]!;
  const cents = (match[2] ?? "").padEnd(2, "0");
  let minor: bigint;
  try {
    minor = BigInt(whole) * 100n + BigInt(cents);
  } catch {
    return null;
  }
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

/**
 * P-01 connected intake inside the purchasing-desk visual system. The form
 * collects only the immediately relevant minimum facts for the chosen
 * entry point and submits once through the real Convex intake mutation.
 * No vendors, prices, quotes, or provider outcomes are invented here.
 */
interface IntakeFormValues {
  readonly projectName: string;
  readonly workspaceKind: string;
  readonly region: string;
  readonly currency: string;
  readonly needBy: string;
  readonly budget: string;
  readonly detailTitle: string;
  readonly detailCategory: string;
  readonly detailSummary: string;
  readonly urgency: string;
}

function readIntakeForm(form: HTMLFormElement | null): IntakeFormValues {
  const empty: IntakeFormValues = {
    projectName: "",
    workspaceKind: "private",
    region: "",
    currency: "",
    needBy: "",
    budget: "",
    detailTitle: "",
    detailCategory: "",
    detailSummary: "",
    urgency: "normal",
  };
  if (form === null) return empty;
  // Read named controls directly: this is the same DOM state the browser
  // submits and avoids coupling the submit path to a FormData global. The
  // duck-typed value check keeps this runnable wherever the DOM interfaces
  // are not installed as globals (component code never assumes them).
  const text = (name: string): string => {
    const control = form.querySelector(`[name="${name}"]`);
    if (control !== null && "value" in control && typeof control.value === "string") {
      return control.value;
    }
    return "";
  };
  return {
    projectName: text("projectName"),
    workspaceKind: text("workspaceKind"),
    region: text("region"),
    currency: text("currency"),
    needBy: text("needBy"),
    budget: text("budget"),
    detailTitle: text("detailTitle"),
    detailCategory: text("detailCategory"),
    detailSummary: text("detailSummary"),
    urgency: text("urgency"),
  };
}

export function WorkbenchIntakeView({ onIntake, onBack }: { readonly onIntake: WorkbenchIntakeHandler; readonly onBack?: (() => void) | undefined }) {
  const [mode, setMode] = useState<WorkbenchIntakeMode>("opening");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submittedFingerprint, setSubmittedFingerprint] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const errorId = `${idPrefix}-intake-error`;
  const noticeId = `${idPrefix}-intake-notice`;

  // Fields stay uncontrolled so entered values survive re-renders from
  // validation, recoverable failure, and pending states without a
  // framework round-trip per keystroke.
  const fingerprintFor = (values: IntakeFormValues): string =>
    intakeFingerprint({ mode, ...values });

  const noteMutation = (): void => {
    // A changed payload after a submission needs a fresh key so the server
    // never confuses an edited retry with a changed-key conflict replay.
    const form = formRef.current;
    if (form === null || submittedFingerprint === null) return;
    if (fingerprintFor(readIntakeForm(form)) !== submittedFingerprint) {
      setSubmittedFingerprint(null);
      setIdempotencyKey(null);
    }
  };

  const validateValues = (values: IntakeFormValues): string | null => {
    if (values.projectName.trim().length === 0) return "Name the project before starting intake.";
    if (values.projectName.trim().length > 100) return "Keep the project name within 100 characters.";
    if (mode === "opening" && values.region.trim().length === 0) return "Add the city or region for this opening.";
    if (values.region.trim().length > 128) return "Keep the region within 128 characters.";
    if (values.currency.trim().length > 0 && !/^[A-Za-z]{3}$/.test(values.currency.trim())) {
      return "Use a three-letter reporting currency such as USD.";
    }
    if (values.budget.trim().length > 0) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(values.budget.trim())) {
        return "Enter the budget ceiling as a number with up to two decimals, for example 45000 or 45000.50.";
      }
      // Exact decimal-string parsing (no floating-point multiplication); an
      // unsafe magnitude fails closed here so the submission below can never
      // silently omit it.
      if (parseIntakeBudgetMinorUnits(values.budget) === null) {
        return "That budget is too large to record safely. Enter a smaller amount.";
      }
    }
    if (values.needBy.trim().length > 0 && Number.isNaN(Date.parse(values.needBy))) {
      return "Enter a valid needed-by date or leave it empty.";
    }
    if (mode === "opening" && values.detailSummary.trim().length === 0) {
      return "Describe the opening brief before creating the workspace.";
    }
    if (mode === "quoteComparison" && values.detailTitle.trim().length === 0) {
      return "Describe the requirement these quotes cover.";
    }
    if (mode === "equipment" && values.detailTitle.trim().length === 0) {
      return "Label the equipment this case concerns.";
    }
    if (mode === "equipment" && values.detailSummary.trim().length === 0) {
      return "Describe the service issue before opening the case.";
    }
    if (values.detailTitle.trim().length > 256) return "Keep the subject within 256 characters.";
    if (values.detailCategory.trim().length > 128) return "Keep the category within 128 characters.";
    if (values.detailSummary.trim().length > 800 && mode === "equipment") {
      return "Keep the issue summary within 800 characters.";
    }
    if (values.detailSummary.trim().length > 2000) return "Keep the notes within 2000 characters.";
    return null;
  };

  const submit = async (event?: { preventDefault: () => void; currentTarget?: HTMLFormElement | null }): Promise<void> => {
    event?.preventDefault();
    if (pending || submittingRef.current) return;
    const form = event?.currentTarget ?? formRef.current;
    const values = readIntakeForm(form);
    const invalid = validateValues(values);
    if (invalid !== null) {
      setError(invalid);
      setNotice(null);
      return;
    }
    const currentFingerprint = fingerprintFor(values);
    if (submittedFingerprint !== null && currentFingerprint !== submittedFingerprint) {
      setSubmittedFingerprint(null);
      setIdempotencyKey(null);
    }
    const key = (submittedFingerprint !== null && currentFingerprint === submittedFingerprint && idempotencyKey !== null)
      ? idempotencyKey
      : createIntakeKey();
    submittingRef.current = true;
    setIdempotencyKey(key);
    setSubmittedFingerprint(currentFingerprint);
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const trimmedCurrency = values.currency.trim();
      const budgetMinorUnits = values.budget.trim().length === 0
        ? undefined
        : parseIntakeBudgetMinorUnits(values.budget);
      if (budgetMinorUnits === null) {
        // Fail closed: an unsafe budget keeps the entered values in place
        // and never reaches the intake route with an omission.
        setError("That budget is too large to record safely. Enter a smaller amount.");
        return;
      }
      const needByAt = values.needBy.trim().length === 0 ? undefined : Date.parse(values.needBy);
      const workspaceKind = values.workspaceKind === "guest" ? "guest" as const : "private" as const;
      const urgency = values.urgency === "urgent" || values.urgency === "high" || values.urgency === "low"
        ? values.urgency
        : "normal" as const;
      const input: WorkbenchIntakeInput = {
        mode,
        projectName: values.projectName.trim(),
        workspaceKind,
        ...(values.region.trim().length === 0 ? {} : { region: values.region.trim() }),
        ...(trimmedCurrency.length === 0 ? {} : { currency: trimmedCurrency.toUpperCase() }),
        ...(needByAt === undefined || Number.isNaN(needByAt) ? {} : { needByAt }),
        ...(budgetMinorUnits === undefined ? {} : { budgetMinorUnits }),
        ...(values.detailTitle.trim().length === 0 ? {} : { detailTitle: values.detailTitle.trim() }),
        ...(values.detailCategory.trim().length === 0 ? {} : { detailCategory: values.detailCategory.trim() }),
        ...(values.detailSummary.trim().length === 0 ? {} : { detailSummary: values.detailSummary.trim() }),
        ...(mode === "equipment" ? { urgency } : {}),
        idempotencyKey: key,
      };
      const result = await onIntake(input);
      if (!result.ok) {
        // Recoverable failure: uncontrolled fields keep their DOM values in
        // place under the same key so an unchanged retry replays
        // idempotently.
        setError(result.message ?? "The server did not create this workspace.");
        return;
      }
      setNotice("Workspace created. Loading the persisted project.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The server did not create this workspace.");
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <div className="wb-app wb-connection-app">
      <Header activeTab="project" project={{ name: "New project intake", region: null, currency: null }} onTabChange={() => undefined} onOpenAssistant={() => undefined} disabled />
      <main id="workbench-main" className="wb-page wb-intake-page" tabIndex={-1}>
        {onBack !== undefined ? (
          <div className="wb-intake-back">
            <button type="button" className="wb-text-button" onClick={onBack}>&larr; Back to the landing</button>
          </div>
        ) : null}
        <PageHeading
          eyebrow="OPENINGOS / NEW PROJECT INTAKE"
          title="Start with the job at hand."
          description="Choose one entry point and share only the facts needed to open a real workspace. Nothing is invented while the server record is created."
        />
        <div className="wb-intake-layout">
          <section className="wb-intake-paper" aria-labelledby={`${idPrefix}-intake-title`}>
            <div className="wb-connection-paper-head">
              <span className="wb-connection-dot wb-connection-dot-pending" aria-hidden="true" />
              <span className="wb-eyebrow">SERVER WORKSPACE · NO SAMPLE DATA</span>
              <span className="wb-paper-version">P-01<br />INTAKE</span>
            </div>
            <h2 id={`${idPrefix}-intake-title`}>Open a workspace</h2>
            <p className="wb-intake-lede">One submission creates one persisted project under your identity. Research, outreach, and spend start later under their own approvals.</p>
            <form
              className="wb-intake-form"
              ref={formRef}
              onSubmit={(formEvent) => { void submit(formEvent); }}
              onChange={noteMutation}
              onInput={noteMutation}
              aria-busy={pending}
            >
              <fieldset className="wb-intake-modes" disabled={pending}>
                <legend>Entry point</legend>
                {INTAKE_MODES.map((entry) => (
                  <label key={entry.value} className={mode === entry.value ? "wb-intake-mode active" : "wb-intake-mode"}>
                    <input
                      type="radio"
                      name={`${idPrefix}-intake-mode`}
                      value={entry.value}
                      defaultChecked={mode === entry.value}
                      onChange={() => setMode(entry.value)}
                    />
                    <span><strong>{entry.title}</strong><small>{entry.detail}</small></span>
                  </label>
                ))}
              </fieldset>
              <div className="wb-intake-grid">
                <div className="wb-form-field">
                  <label htmlFor={`${idPrefix}-project-name`}>Project name</label>
                  <input
                    id={`${idPrefix}-project-name`}
                    name="projectName"
                    defaultValue=""
                    maxLength={100}
                    placeholder="Northside café opening"
                    disabled={pending}
                    autoComplete="off"
                  />
                </div>
                <div className="wb-form-field">
                  <label htmlFor={`${idPrefix}-workspace-kind`}>Workspace</label>
                  <select
                    id={`${idPrefix}-workspace-kind`}
                    name="workspaceKind"
                    defaultValue="private"
                    disabled={pending}
                  >
                    <option value="private">Private project</option>
                    <option value="guest">Guest evaluation</option>
                  </select>
                </div>
                {mode === "opening" ? (
                  <div className="wb-form-field">
                    <label htmlFor={`${idPrefix}-region`}>City or region</label>
                    <input
                      id={`${idPrefix}-region`}
                      name="region"
                      defaultValue=""
                      maxLength={128}
                      placeholder="Amsterdam, Netherlands"
                      disabled={pending}
                      autoComplete="off"
                    />
                  </div>
                ) : null}
                {mode === "opening" || mode === "quoteComparison" ? (
                  <div className="wb-form-field">
                    <label htmlFor={`${idPrefix}-currency`}>Reporting currency</label>
                    <input
                      id={`${idPrefix}-currency`}
                      name="currency"
                      defaultValue="EUR"
                      maxLength={3}
                      placeholder="EUR"
                      disabled={pending}
                      autoComplete="off"
                    />
                  </div>
                ) : null}
                {mode === "opening" ? (
                  <>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-need-by`}>Needed by (optional)</label>
                      <input
                        id={`${idPrefix}-need-by`}
                        name="needBy"
                        type="date"
                        defaultValue=""
                        disabled={pending}
                      />
                    </div>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-budget`}>Budget upper limit in reporting currency (optional)</label>
                      <input
                        id={`${idPrefix}-budget`}
                        name="budget"
                        defaultValue=""
                        inputMode="decimal"
                        placeholder="500000"
                        disabled={pending}
                        autoComplete="off"
                        aria-describedby={`${idPrefix}-budget-help`}
                      />
                      <span className="wb-field-help" id={`${idPrefix}-budget-help`}>A single allocation ceiling in the reporting currency above. Put any range or lower bound in the opening brief below.</span>
                    </div>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-opening-title`}>Opening title (optional)</label>
                      <input
                        id={`${idPrefix}-opening-title`}
                        name="detailTitle"
                        defaultValue=""
                        maxLength={256}
                        placeholder="San Francisco coffee shop opening"
                        disabled={pending}
                        autoComplete="off"
                      />
                    </div>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-opening-category`}>Opening category (optional)</label>
                      <input
                        id={`${idPrefix}-opening-category`}
                        name="detailCategory"
                        defaultValue=""
                        maxLength={128}
                        placeholder="café opening"
                        disabled={pending}
                        autoComplete="off"
                      />
                    </div>
                    <div className="wb-form-field wb-form-field-full">
                      <label htmlFor={`${idPrefix}-opening-brief`}>Opening brief</label>
                      <textarea
                        id={`${idPrefix}-opening-brief`}
                        name="detailSummary"
                        defaultValue=""
                        maxLength={2000}
                        rows={5}
                        placeholder="Open a coffee shop in San Francisco; rent a place and buy everything needed; budget USD 250,000-500,000"
                        disabled={pending}
                        aria-describedby={`${idPrefix}-opening-brief-help`}
                      />
                      <span className="wb-field-help" id={`${idPrefix}-opening-brief-help`}>Describe the scope, place, and budget range in your own words. The brief is kept exactly as entered.</span>
                      <span className="wb-character-count">2000 characters maximum</span>
                    </div>
                  </>
                ) : null}
                {mode === "quoteComparison" ? (
                  <>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-detail-title`}>Requirement subject</label>
                      <input
                        id={`${idPrefix}-detail-title`}
                        name="detailTitle"
                        defaultValue=""
                        maxLength={256}
                        placeholder="Two-group espresso machine"
                        disabled={pending}
                        autoComplete="off"
                      />
                    </div>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-detail-category`}>Category (optional)</label>
                      <input
                        id={`${idPrefix}-detail-category`}
                        name="detailCategory"
                        defaultValue=""
                        maxLength={128}
                        placeholder="espresso"
                        disabled={pending}
                        autoComplete="off"
                      />
                    </div>
                    <div className="wb-form-field wb-form-field-full">
                      <label htmlFor={`${idPrefix}-detail-summary`}>Notes on the offers (optional)</label>
                      <textarea
                        id={`${idPrefix}-detail-summary`}
                        name="detailSummary"
                        defaultValue=""
                        maxLength={2000}
                        rows={3}
                        placeholder="What arrived so far, and what is still missing"
                        disabled={pending}
                      />
                    </div>
                  </>
                ) : null}
                {mode === "equipment" ? (
                  <>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-equipment-label`}>Equipment label</label>
                      <input
                        id={`${idPrefix}-equipment-label`}
                        name="detailTitle"
                        defaultValue=""
                        maxLength={256}
                        placeholder="Atlas grinder"
                        disabled={pending}
                        autoComplete="off"
                      />
                    </div>
                    <div className="wb-form-field">
                      <label htmlFor={`${idPrefix}-urgency`}>Urgency</label>
                      <select
                        id={`${idPrefix}-urgency`}
                        name="urgency"
                        defaultValue="normal"
                        disabled={pending}
                      >
                        <option value="urgent">Urgent</option>
                        <option value="high">High</option>
                        <option value="normal">Normal</option>
                        <option value="low">Low</option>
                      </select>
                    </div>
                    <div className="wb-form-field wb-form-field-full">
                      <label htmlFor={`${idPrefix}-issue-summary`}>What needs attention?</label>
                      <textarea
                        id={`${idPrefix}-issue-summary`}
                        name="detailSummary"
                        defaultValue=""
                        maxLength={800}
                        rows={4}
                        placeholder="Describe the service issue"
                        disabled={pending}
                      />
                      <span className="wb-character-count">800 characters maximum</span>
                    </div>
                  </>
                ) : null}
              </div>
              {error !== null ? <p className="wb-form-error" id={errorId} role="alert">{error}</p> : null}
              {notice !== null ? <p className="wb-form-notice" id={noticeId} role="status">{notice}</p> : null}
              <div className="wb-intake-actions">
                <ActionButton kind="primary" type="submit" disabled={pending}>
                  {pending ? "Creating workspace…" : "Create workspace"}
                </ActionButton>
                <p className="wb-micro"><Icon name="lock" size={12} /> One submission writes one workspace under your signed-in identity. Duplicate clicks share a single submission.</p>
              </div>
            </form>
          </section>
          <aside className="wb-connection-note" aria-label="What happens next">
            <span className="wb-eyebrow">WHAT HAPPENS NEXT</span>
            <h2>The workbench fills from server truth.</h2>
            <p>Once the workspace exists, this same desk loads its persisted project, requirements, and history. Research, quotes, and outreach start from there under their own approvals.</p>
            <div className="wb-honesty-card"><Icon name="lock" size={18} /><div><strong>Private and fail-closed</strong><p>Missing details block the submission instead of inventing vendors, prices, or provider success.</p></div></div>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default function WorkbenchView({ loadState, onRetry, onAction, onLoadMore, onIntake }: WorkbenchViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("project");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<WorkbenchOffer | null>(null);
  const [evidence, setEvidence] = useState<WorkbenchEvidence | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const snapshot = loadState.state === "ready" ? loadState.snapshot : "lastKnown" in loadState ? loadState.lastKnown : undefined;
  const connectedAction = loadState.state === "ready" ? onAction : undefined;
  if (!snapshot) {
    if (loadState.state === "empty" && onIntake !== undefined) {
      return <WorkbenchIntakeView onIntake={onIntake} />;
    }
    const message = loadState.state === "empty"
      ? `${loadState.message} No vendors, quotes or provider outcomes are shown until server state is available.`
      : loadState.state === "error"
        ? loadState.message
        : loadState.state === "reconnecting"
          ? "The last backend connection was lost. Completed work remains on the server; new actions wait until the projection is current again."
          : "The backend is connected, but no project-scoped projection has arrived yet. No vendors, quotes or provider outcomes are shown until server state is available.";
    return (
      <WorkbenchUnavailableView
        eyebrow={loadState.state === "error" ? "PROJECT STATE UNAVAILABLE" : loadState.state === "reconnecting" ? "CONNECTION INTERRUPTED" : loadState.state === "loading" ? "LOADING AUTHORIZED PROJECT" : "NO AUTHORIZED PROJECT"}
        title={loadState.state === "reconnecting" ? "Reconnecting to OpeningOS." : loadState.state === "error" ? "Project state needs another check." : "Waiting for an authorized project."}
        message={message}
        tone={loadState.state === "error" ? "error" : loadState.state === "reconnecting" ? "warning" : loadState.state === "loading" ? "pending" : "neutral"}
        action={loadState.state !== "loading" && onRetry !== undefined ? "Retry project state" : undefined}
        onRetry={onRetry}
      />
    );
  }
  const tabContent = activeTab === "project" ? <ProjectView snapshot={snapshot} onReview={setSelectedOffer} onAction={connectedAction} onLoadMore={onLoadMore} onTabChange={setActiveTab} onOpenAssistant={() => setAssistantOpen(true)} onOpenEvidence={setEvidence} onMessage={setMessage} /> : activeTab === "suppliers" ? <SuppliersView snapshot={snapshot} onReview={setSelectedOffer} onOpenEvidence={setEvidence} /> : activeTab === "inbox" ? <InboxView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} /> : activeTab === "recovery" ? <RecoveryView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} /> : <EquipmentView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} />;
  return <div className="wb-app"><Header activeTab={activeTab} project={snapshot.project} onTabChange={setActiveTab} onOpenAssistant={() => setAssistantOpen(true)} /><LoadNotice loadState={loadState} onRetry={onRetry} />{activeTab === "project" ? null : <OverviewStrip snapshot={snapshot} />}<main id="workbench-main" tabIndex={-1}>{tabContent}</main>{message ? <div className="wb-toast" role="status" aria-live="polite"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="Dismiss message"><Icon name="close" size={14} /></button></div> : null}{assistantOpen ? <AssistantRail snapshot={snapshot} onClose={() => setAssistantOpen(false)} /> : null}{evidence ? <EvidencePanel evidence={evidence} onClose={() => setEvidence(null)} /> : null}{selectedOffer ? <SelectionPanel offer={selectedOffer} snapshot={snapshot} onClose={() => setSelectedOffer(null)} onAction={connectedAction} onMessage={setMessage} /> : null}</div>;
}

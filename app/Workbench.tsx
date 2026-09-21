import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DeliveryState,
  WorkbenchAction,
  WorkbenchActionResult,
  WorkbenchActivityItem,
  WorkbenchAsset,
  WorkbenchEvidence,
  WorkbenchLoadState,
  WorkbenchOffer,
  WorkbenchQuote,
  WorkbenchSnapshot,
  ProvenanceMode,
} from "./workbench-state";
import {
  deliveryLabel,
  formatDate,
  formatMoney,
  formatStateLabel,
  provenanceLabel,
} from "./workbench-state";

type Tab = "project" | "suppliers" | "inbox" | "recovery" | "equipment";

export interface WorkbenchViewProps {
  readonly loadState: WorkbenchLoadState;
  readonly onRetry?: (() => void) | undefined;
  readonly onAction?: ((action: WorkbenchAction) => Promise<WorkbenchActionResult> | WorkbenchActionResult) | undefined;
  readonly onLoadMore?: (() => void) | undefined;
}

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
  onClick,
  title,
  type = "button",
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly kind?: "primary" | "secondary" | "text" | "danger";
  readonly onClick?: () => void;
  readonly title?: string | undefined;
  readonly type?: "button" | "submit";
}) {
  return (
    <button className={`wb-button wb-button-${kind}`} disabled={disabled} onClick={onClick} title={title} type={type}>
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
 * Shared modal contract for every workbench overlay.  The overlay is a child
 * of the workbench root, so its siblings can be made inert without hiding the
 * dialog itself from assistive technology.
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
    const modalRoot = dialog.closest<HTMLElement>(".wb-overlay");
    const backgroundElements = modalRoot?.parentElement === null || modalRoot?.parentElement === undefined
      ? []
      : Array.from(modalRoot.parentElement.children)
        .map((element) => element as HTMLElement)
        .filter((element) => element !== modalRoot);
    const previousBackgroundState = backgroundElements.map((element) => ({
      element,
      hadInert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of backgroundElements) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
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

function Header({ activeTab, project, onTabChange, onOpenAssistant }: { readonly activeTab: Tab; readonly project: WorkbenchSnapshot["project"]; readonly onTabChange: (tab: Tab) => void; readonly onOpenAssistant: () => void }) {
  const tabs: readonly [Tab, string, string][] = [
    ["project", "Project", "compass"],
    ["suppliers", "Suppliers", "search"],
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
          <span className="wb-brand-mark">O<span>.</span></span>
          <span>OpeningOS</span>
        </button>
        <div className="wb-project-picker" aria-label="Current project">
          <span className="wb-eyebrow">PROJECT</span>
          <strong>{project.name}</strong>
          <span>{project.region ?? "Region unknown"} · {project.currency ?? "Currency unknown"}</span>
        </div>
        <nav className="wb-nav" aria-label="Project navigation">
          {tabs.map(([tab, label, icon]) => (
            <button key={tab} className={activeTab === tab ? "active" : ""} type="button" aria-current={activeTab === tab ? "page" : undefined} onClick={() => onTabChange(tab)}>
              <Icon name={icon} size={16} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="wb-assistant-button" type="button" onClick={onOpenAssistant} aria-label="Open project assistant"><Icon name="spark" size={18} /></button>
      </header>
    </>
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
        <div className="wb-overview-intro"><span className="wb-eyebrow">PROCUREMENT READINESS</span><strong>{readinessLabel}</strong><span>{readinessDescription}</span></div>
      <div className="wb-metric"><span>Approved budget</span><strong>{formatMoney(budget, snapshot.project.currency)}</strong><small>Planning allocation</small></div>
      <div className="wb-metric"><span>Selected forecast</span><strong>{formatMoney(forecast, snapshot.project.currency)}</strong><small>Expected, not yet ordered</small></div>
      <div className="wb-metric"><span>Committed</span><strong>{formatMoney(snapshot.committedMinorUnits, snapshot.project.currency)}</strong><small>Recorded orders only</small></div>
      <div className="wb-metric"><span>Paid</span><strong>{formatMoney(snapshot.paidMinorUnits, snapshot.project.currency)}</strong><small>Confirmed payments</small></div>
      </section>
      {requirementsTruncated ? <div className="wb-inline-warning" role="status"><Icon name="warning" size={16} /> Readiness unavailable: the requirements page is truncated and no complete authoritative aggregate was supplied.</div> : null}
    </>
  );
}

function RequirementCard({ snapshot, requirement }: { readonly snapshot: WorkbenchSnapshot; readonly requirement: WorkbenchSnapshot["requirements"][number] }) {
  const delivered = snapshot.deliveredQuantityByRequirement[requirement.id] ?? "Unknown";
  const offers = snapshot.offers.filter((offer) => offer.requirementId === requirement.id);
  return (
    <article className="wb-requirement-card">
      <div className="wb-requirement-top"><div><span className="wb-eyebrow">{requirement.key} · {requirement.priority}</span><h2>{requirement.title}</h2><p>{requirement.quantity} {requirement.unit} · version {requirement.version}</p></div><Pill tone={requirement.state === "readyForDecision" ? "warning" : requirement.state === "fulfilled" ? "success" : "neutral"}>{formatStateLabel(requirement.state)}</Pill></div>
      <div className="wb-requirement-facts"><div><span>Fulfillment</span><strong>{formatStateLabel(requirement.fulfillment)}</strong></div><div><span>Delivered</span><strong>{delivered} / {requirement.quantity} {requirement.unit}</strong></div><div><span>Need by</span><strong>{formatDate(requirement.needByAt)}</strong></div><div><span>Allocation</span><strong>{formatMoney(requirement.budgetMinorUnits, snapshot.project.currency)}</strong></div></div>
      <div className="wb-requirement-offers"><span className="wb-eyebrow">CURRENT OFFERS</span><strong>{offers.length === 0 ? "No offers yet" : `${offers.length} offer${offers.length === 1 ? "" : "s"} in this project`}</strong><div className="wb-progress-track"><span style={{ width: `${offers.length === 0 ? 0 : Math.min(100, offers.length * 20)}%` }} /></div></div>
    </article>
  );
}

function QuoteSummary({ quote, currency }: { readonly quote: WorkbenchQuote | null; readonly currency: string | null }) {
  if (!quote) return <div className="wb-quote-unknown"><Icon name="warning" size={16} /> Quote terms have not arrived.</div>;
  const unknownCharges = quote.charges.filter((charge) => charge.state === "unknown");
  return (
    <div className="wb-quote-summary">
      <div className="wb-quote-total"><span>Comparable total</span><strong>{formatMoney(quote.comparableTotalMinorUnits, currency)}</strong></div>
      <div className="wb-charge-list">{quote.charges.slice(0, 4).map((charge) => <div key={`${charge.kind}-${charge.scope}`}><span>{formatStateLabel(charge.kind)}</span><strong>{charge.state === "included" ? "Included" : charge.state === "unknown" ? "Unknown" : formatMoney(charge.minorUnits, currency)}</strong></div>)}</div>
      {unknownCharges.length > 0 ? <div className="wb-unknown-note"><Icon name="warning" size={14} /> {unknownCharges.length} charge{unknownCharges.length === 1 ? "" : "s"} still needs confirmation.</div> : null}
    </div>
  );
}

function OfferCard({ offer, snapshot, selected, onReview }: { readonly offer: WorkbenchOffer; readonly snapshot: WorkbenchSnapshot; readonly selected: boolean; readonly onReview: () => void }) {
  const isIncompatible = offer.compatibility === "fail";
  const hasUnknown = offer.quote?.charges.some((charge) => charge.state === "unknown") ?? true;
  const vendorName = offer.vendor?.name ?? "Vendor unavailable";
  return (
    <article className={`wb-offer-card ${selected ? "selected" : ""} ${isIncompatible ? "incompatible" : ""}`}>
      <div className="wb-offer-header"><div className="wb-vendor-monogram">{vendorName.slice(0, 1).toUpperCase()}</div><div><h3>{vendorName}</h3><p>{offer.productModel} · {offer.variant}</p></div><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div>
      <div className="wb-offer-tags"><Pill tone={offer.compatibility === "pass" ? "success" : offer.compatibility === "fail" ? "danger" : "warning"}>{offer.compatibility === "pass" ? "Fit evidence passed" : offer.compatibility === "fail" ? "Incompatible" : "Fit unknown"}</Pill><Pill>{formatStateLabel(offer.conversationState)}</Pill></div>
      <QuoteSummary quote={offer.quote} currency={snapshot.project.currency} />
      <div className="wb-offer-foot"><span>{offer.quote?.validUntil ? `Valid through ${formatDate(offer.quote.validUntil)}` : "Validity not confirmed"}</span><ActionButton kind="secondary" disabled={isIncompatible || offer.vendor === null} onClick={onReview} title={isIncompatible ? "An incompatible offer cannot be selected" : offer.vendor === null ? "Vendor details are not present in this projection" : undefined}>{selected ? "Selected offer" : "Review quote"}<Icon name="arrow" size={15} /></ActionButton></div>
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
  return <div className="wb-overlay"><section className="wb-assistant-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">CONTEXTUAL ASSISTANT</span><h2 id={titleId}>Ask about this decision.</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close assistant"><Icon name="close" size={18} /></button></div><p className="wb-assistant-copy">Answers must use the current project, selected rows and supporting evidence. This panel cannot authorize a send or an order.</p><div className="wb-prompt-grid">{prompts.map((prompt) => <button key={prompt} type="button" onClick={() => submit(prompt)}>{prompt}<Icon name="arrow" size={13} /></button>)}</div><div className="wb-asked" aria-live="polite">{asked.map((item, index) => <div key={`${item}-${index}`}><p className="wb-question">{item}</p><div className="wb-answer"><Pill>{snapshot.provenance.mode === "live" ? "Current project evidence" : "Evidence available, model answer pending"}</Pill><p>{snapshot.provenance.mode === "live" ? "The authorized answer route is not represented in this projection. Review the cited quote and evidence before taking action." : "This project has not supplied a verified live model answer. The UI keeps the question open instead of inventing one."}</p></div></div>)}</div><form className="wb-assistant-input" onSubmit={(event) => { event.preventDefault(); submit(question); }}><label className="wb-visually-hidden" htmlFor={`${idPrefix}-assistant-question`}>Ask about this project</label><input id={`${idPrefix}-assistant-question`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask about suppliers, quotes or fit…" maxLength={500} /><button type="submit" disabled={!question.trim()} aria-label="Ask question"><Icon name="arrow" size={17} /></button></form><p className="wb-micro"><Icon name="lock" size={12} /> Server authority remains separate from assistant suggestions.</p></section></div>;
}

function EvidencePanel({ evidence, onClose }: { readonly evidence: WorkbenchEvidence; readonly onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const idPrefix = useId().replace(/:/g, "");
  const titleId = `${idPrefix}-evidence-title`;
  useModalAccessibility(dialogRef, onClose);
  return <div className="wb-overlay"><section className="wb-evidence-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">SOURCE RECORD</span><h2 id={titleId}>{evidence.label}</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close evidence"><Icon name="close" size={18} /></button></div><div className="wb-document"><div className="wb-document-head"><span>{evidence.sourceKind}</span><ProvenancePill mode={evidence.executionMode} /></div><div className="wb-document-row"><span>Verification</span><strong>{formatStateLabel(evidence.verification)}</strong></div><div className="wb-document-row"><span>Freshness</span><strong>{formatStateLabel(evidence.freshness)}</strong></div><div className="wb-document-row"><span>Counterparty</span><strong>{evidence.counterpartyRole === "ownerStandIn" ? "Owner stand-in · controlled" : formatStateLabel(evidence.counterpartyRole)}</strong></div><div className="wb-document-watermark">PUBLIC PROJECTION · PRIVATE HEADERS REDACTED</div></div><p className="wb-micro">{evidence.sourceUrl ? "The source link is available through the authorized evidence record." : "No public source URL was included in this projection."} Raw headers, mailbox addresses and provider IDs are never shown in the workbench.</p></section></div>;
}

function SelectionPanel({ offer, snapshot, onClose, onAction, onMessage }: { readonly offer: WorkbenchOffer; readonly snapshot: WorkbenchSnapshot; readonly onClose: () => void; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const quote = offer.quote;
  const vendorName = offer.vendor?.name ?? "Vendor unavailable";
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
  return <div className="wb-overlay"><section className="wb-selection-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}><div className="wb-panel-head"><div><span className="wb-eyebrow">DECISION REVIEW</span><h2 id={titleId}>{vendorName} · quote v{quote?.version ?? "unknown"}</h2></div><button className="wb-icon-button" type="button" onClick={onClose} aria-label="Close decision review"><Icon name="close" size={18} /></button></div><div className="wb-selection-content"><div className="wb-selection-brand"><span className="wb-vendor-monogram large">{vendorName.slice(0, 1).toUpperCase()}</span><div><h3>{offer.productModel}</h3><p>{offer.variant} · {vendorRegions}</p></div><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div><QuoteSummary quote={quote} currency={snapshot.project.currency} /><div className="wb-decision-explanation"><Icon name="shield" size={19} /><div><strong>Selection is not an order.</strong><p>This exact quote would change the selected forecast only. It does not create a commitment, place an order or take payment.</p></div></div>{snapshot.access.capabilities.canApprove === null ? <div className="wb-inline-warning"><Icon name="lock" size={16} /> Approval authority is not represented in this projection.</div> : snapshot.access.capabilities.canApprove === false ? <div className="wb-inline-warning"><Icon name="lock" size={16} /> Your role cannot approve this decision. An authorized approver must review it.</div> : null}{quote?.superseded === true ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> This quote version is superseded. Refresh the projection before approving.</div> : quote?.superseded === null ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> Quote successor status is not represented in this projection. The server must project authoritative successor state before selection can proceed.</div> : null}{quote?.comparableTotalMinorUnits === null ? <div className="wb-inline-warning"><Icon name="warning" size={16} /> Comparable total is not represented in this projection. Selection stays blocked until the server supplies an authoritative total.</div> : null}<ActionButton disabled={!onAction || !canSelect} onClick={() => { void choose(); }} title={!onAction ? "No server action is attached" : !canSelect ? "A complete, compatible, current quote and authorized capability are required" : undefined}>Select exact quote <Icon name="check" size={16} /></ActionButton><p className="wb-micro">No order will be placed. No payment will be taken.</p></div></section></div>;
}

function ProjectView({ snapshot, onReview, onAction, onLoadMore, onTabChange, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onReview: (offer: WorkbenchOffer) => void; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onLoadMore?: (() => void) | undefined; readonly onTabChange: (tab: Tab) => void; readonly onMessage: (message: string) => void }) {
  const primaryRequirement = snapshot.requirements[0];
  const offers = primaryRequirement ? snapshot.offers.filter((offer) => offer.requirementId === primaryRequirement.id) : [];
  const selected = snapshot.selectedOfferId;
  const [showAll, setShowAll] = useState(false);
  const [researchPending, setResearchPending] = useState(false);
  const researchPendingRef = useRef(false);
  const visibleOffers = showAll ? offers : offers.slice(0, 3);
  const researchDisabled = !onAction || !snapshot.access.capabilities.canResearch || snapshot.truncation.requirements;
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
  return <div className="wb-page"><PageHeading eyebrow="PURCHASING WORKBENCH" title="Everything on the table." description="Evidence, comparable offers and the next authorized move, kept together." action={<ActionButton kind="secondary" onClick={() => { void action(); }} disabled={researchDisabled || researchPending} title={!onAction ? "Actions wait for a connected projection" : !snapshot.access.capabilities.canResearch ? "Your role cannot start research" : snapshot.truncation.requirements ? "Research waits for a complete requirements projection" : undefined}><Icon name="spark" size={15} /> {researchPending ? "Starting…" : "Start bounded research"}</ActionButton>} /><div className="wb-scope-row"><span><Icon name="lock" size={13} /> {snapshot.project.region ?? "Region unknown"} · {snapshot.project.currency ?? "Currency unknown"}</span><span>Need by {formatDate(snapshot.project.needByAt)}</span><ProvenancePill mode={snapshot.provenance.mode} ownerAuthoredTerms={snapshot.provenance.ownerAuthoredTerms} /></div>{primaryRequirement ? <RequirementCard snapshot={snapshot} requirement={primaryRequirement} /> : <EmptyState icon="compass" title="No requirements in scope" message="This project has no server-recorded requirement yet. OpeningOS will not invent one from the page brief." action={<ActionButton kind="secondary" disabled title="Requirement creation is a server-authorized workflow">Add a requirement</ActionButton>} />}<section className="wb-section-heading"><div><span className="wb-eyebrow">COMPARABLE OFFERS</span><h2>Quotes you can actually compare.</h2><p>Unknown charges stay visible. An incomplete offer is not ranked as a saving.</p></div><button className="wb-text-button" type="button" onClick={() => onTabChange("suppliers")}>See all suppliers <Icon name="arrow" size={14} /></button></section>{visibleOffers.length > 0 ? <div className="wb-offer-grid">{visibleOffers.map((offer) => <OfferCard key={offer.id} offer={offer} snapshot={snapshot} selected={offer.id === selected} onReview={() => onReview(offer)} />)}</div> : <EmptyState icon="search" title="No offers have arrived" message="Research can continue independently, but this project has no verified quote to compare yet." action={<ActionButton kind="secondary" onClick={() => onTabChange("suppliers")}>Open supplier view</ActionButton>} />}{offers.length > 3 ? <button className="wb-load-more" type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show fewer offers" : `Show ${offers.length - 3} more offers`} <Icon name="chevron" size={14} /></button> : null}<div className="wb-project-lower"><section className="wb-panel wb-financial-panel"><div className="wb-panel-heading"><div><span className="wb-eyebrow">FORECAST, NOT COMMITMENT</span><h2>One decision at a time.</h2></div><Icon name="trend" size={20} /></div><div className="wb-forecast-lines"><div><span>Selected forecast</span><strong>{formatMoney(snapshot.selectedForecastMinorUnits, snapshot.project.currency)}</strong></div><div><span>Committed expenditure</span><strong>{formatMoney(snapshot.committedMinorUnits, snapshot.project.currency)}</strong></div><div><span>Paid amount</span><strong>{formatMoney(snapshot.paidMinorUnits, snapshot.project.currency)}</strong></div></div><p className="wb-micro">Selecting an offer does not place an order. Only a recorded external order changes committed expenditure.</p></section><section className="wb-panel"><div className="wb-panel-heading"><div><span className="wb-eyebrow">RECENT CHANGES</span><h2>Activity with evidence.</h2></div><button className="wb-text-button" type="button" onClick={() => onTabChange("inbox")}>Open inbox <Icon name="arrow" size={14} /></button></div><ActivityList items={snapshot.activity.items.slice(0, 4)} compact />{!snapshot.activity.isDone && onLoadMore ? <ActionButton kind="secondary" onClick={onLoadMore}><Icon name="refresh" size={15} /> Load older activity</ActionButton> : null}</section></div></div>;
}

function SuppliersView({ snapshot, onReview, onOpenEvidence }: { readonly snapshot: WorkbenchSnapshot; readonly onReview: (offer: WorkbenchOffer) => void; readonly onOpenEvidence: (evidence: WorkbenchEvidence) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "compatible" | "needsReview">("all");
  const offers = useMemo(() => snapshot.offers.filter((offer) => { const matchesQuery = `${offer.vendor?.name ?? "Vendor unavailable"} ${offer.productModel} ${offer.variant}`.toLowerCase().includes(query.toLowerCase()); const matchesFilter = filter === "all" || filter === "compatible" && offer.compatibility === "pass" || filter === "needsReview" && (offer.compatibility === "unknown" || offer.quote?.charges.some((charge) => charge.state === "unknown")); return matchesQuery && matchesFilter; }), [filter, query, snapshot.offers]);
  return <div className="wb-page"><PageHeading eyebrow="SUPPLIER DIRECTORY / AUTHORIZED PROJECT" title="The whole shortlist." description="Every result remains inspectable, including incomplete and incompatible offers." /><div className="wb-tools"><label className="wb-search"><Icon name="search" size={16} /><span className="wb-visually-hidden">Search suppliers</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search suppliers…" /></label><div className="wb-segmented" role="group" aria-label="Filter suppliers"><button className={filter === "all" ? "active" : ""} type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All ({snapshot.offers.length})</button><button className={filter === "compatible" ? "active" : ""} type="button" aria-pressed={filter === "compatible"} onClick={() => setFilter("compatible")}>Fit passed</button><button className={filter === "needsReview" ? "active" : ""} type="button" aria-pressed={filter === "needsReview"} onClick={() => setFilter("needsReview")}>Needs review</button></div></div>{offers.length === 0 ? <EmptyState icon="search" title="No suppliers match that search" message="Clear the filter or wait for the next server projection. No unverified vendor is added to fill the gap." action={<ActionButton kind="text" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</ActionButton>} /> : <div className="wb-supplier-list">{offers.map((offer) => { const vendorName = offer.vendor?.name ?? "Vendor unavailable"; return <article className="wb-supplier-row" key={offer.id}><div className="wb-vendor-monogram">{vendorName.slice(0, 1).toUpperCase()}</div><div className="wb-supplier-name"><h2>{vendorName}</h2><p>{offer.productModel} · {offer.variant}</p><span>{offer.vendor?.serviceCoverage ?? "Service coverage unknown"}</span></div><div className="wb-supplier-status"><Pill tone={offer.compatibility === "pass" ? "success" : offer.compatibility === "fail" ? "danger" : "warning"}>{offer.compatibility === "pass" ? "Compatible" : offer.compatibility === "fail" ? "Excluded" : "Unknown fit"}</Pill><ProvenancePill mode={offer.provenance} ownerAuthoredTerms={offer.ownerAuthoredTerms} /></div><div className="wb-supplier-price"><strong>{formatMoney(offer.quote?.comparableTotalMinorUnits ?? null, snapshot.project.currency)}</strong><span>{offer.quote?.comparableTotalMinorUnits === null || offer.quote === null ? "Incomplete commercial scope" : "Comparable acquisition cost"}</span></div><div className="wb-supplier-actions"><ActionButton kind="secondary" disabled={offer.compatibility === "fail" || offer.vendor === null} onClick={() => onReview(offer)}>Review quote</ActionButton>{offer.evidence[0] ? <button className="wb-icon-button" type="button" onClick={() => onOpenEvidence(offer.evidence[0]!)} aria-label={`Open evidence for ${vendorName}`}><Icon name="file" size={16} /></button> : null}</div></article>; })}</div>}<p className="wb-micro wb-page-footnote">Showing authorized records for {snapshot.project.name}. Public projections redact owner mailbox addresses, raw headers and provider correlation IDs.</p></div>;
}

function InboxView({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const openDecisions = snapshot.decisions.filter((decision) => decision.state === "requested");
  const jobs = snapshot.jobs;
  const approve = async (decisionId: string) => {
    if (snapshot.access.capabilities.canApprove !== true || !onAction) { onMessage(snapshot.access.capabilities.canApprove === null ? "Approval is blocked because authority is not represented in this projection." : "Approval is blocked until the server confirms an approver and a current action route."); return; }
    const result = await onAction({ type: "approveDecision", projectId: snapshot.project.id, decisionId });
    onMessage(result.ok ? "Approval request recorded by the server." : result.message ?? "Approval was not recorded.");
  };
  return <div className="wb-page"><PageHeading eyebrow="DECISIONS INBOX" title="Keep the consequential things visible." description="Review what changed, its effect, and the exact authorization still needed." />{openDecisions.length === 0 && jobs.length === 0 ? <EmptyState icon="inbox" title="Nothing needs your review" message="When a quote, provider outcome or requirement changes, the server will add a decision with its evidence." /> : <div className="wb-inbox-layout"><aside className="wb-inbox-list"><span className="wb-eyebrow">OPEN ITEMS</span>{openDecisions.map((decision) => <button className="wb-thread-card" key={decision.id} type="button"><span className="wb-thread-icon"><Icon name={decision.type === "recovery" ? "sync" : "file"} size={17} /></span><span><strong>{formatStateLabel(decision.type)} review</strong><small>{decision.summary ?? "Decision detail unavailable"}</small></span><Pill tone="warning">Review</Pill></button>)}{jobs.map((job) => <div className="wb-thread-card readonly" key={job.id}><span className="wb-thread-icon"><StatusDot state={job.delivery} /></span><span><strong>{formatStateLabel(job.kind)} job</strong><small>{job.summary ?? "Job detail unavailable"}</small></span><Pill tone={job.delivery === "delivered" ? "success" : job.delivery === "unknown" ? "warning" : job.delivery === "paused" ? "danger" : "neutral"}>{deliveryLabel(job.delivery)}</Pill></div>)}</aside><section className="wb-panel wb-conversation"><div className="wb-conversation-head"><div><span className="wb-eyebrow">CURRENT REVIEW</span><h2>{openDecisions.length > 0 ? openDecisions[0]!.summary ?? "Decision detail unavailable" : "Provider activity"}</h2><p>Project-scoped view · {snapshot.provenance.label}</p></div><Pill tone={openDecisions.length > 0 ? "warning" : "neutral"}>{openDecisions.length > 0 ? "Authorization needed" : "No new decision"}</Pill></div>{openDecisions.length > 0 ? <div className="wb-decision-body"><div className="wb-decision-evidence"><Icon name="shield" size={19} /><div><strong>Immutable decision basis</strong><p>{openDecisions[0]!.scope ?? "Decision scope is not present in this projection."}</p>{openDecisions[0]!.snapshotHash ? <code>Snapshot hash · {openDecisions[0]!.snapshotHash}</code> : <p>Snapshot hash is not present in this projection.</p>}{openDecisions[0]!.quoteId ? <p>Current quote · {openDecisions[0]!.quoteId}{openDecisions[0]!.quoteVersion ? ` · version ${openDecisions[0]!.quoteVersion}` : ""}</p> : <p>Current quote identity is not present in this projection.</p>}</div></div><div className="wb-decision-rule"><Icon name="shield" size={18} /><p>Approval is bound to the exact project, offer and quote version. A changed quote invalidates the old request. Approval records authorization only; it does not place an order.</p></div><ActionButton disabled={!onAction || snapshot.access.capabilities.canApprove !== true} onClick={() => { void approve(openDecisions[0]!.id); }} title={!onAction ? "Actions wait for a connected projection" : snapshot.access.capabilities.canApprove === false ? "Approver capability required" : undefined}>Approve this decision <Icon name="check" size={16} /></ActionButton></div> : <ActivityList items={snapshot.activity.items} />}</section></div>}<div className="wb-delivery-table"><div className="wb-section-heading compact"><div><span className="wb-eyebrow">OUTBOUND AND RECOVERY STATES</span><h2>Outcome is a separate fact.</h2></div></div>{jobs.length === 0 ? <EmptyState icon="truck" title="No provider jobs recorded" message="Queued, sent, delivered, unknown, partial and paused states will appear here from server state." /> : jobs.map((job) => <JobRow key={job.id} job={job} snapshot={snapshot} onAction={onAction} onMessage={onMessage} />)}</div></div>;
}

function JobRow({ job, snapshot, onAction, onMessage }: { readonly job: WorkbenchSnapshot["jobs"][number]; readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const canRetry = job.delivery === "unknown" || job.delivery === "paused" || job.state === "failed";
  const canCancel = job.cancellable && (job.state === "queued" || job.state === "running" || job.state === "waitingForSupplier" || job.state === "waitingForUser");
  const run = async (type: "retryJob" | "cancelJob") => {
    if (!onAction || (type === "retryJob" && !snapshot.access.capabilities.canResearch) || (type === "cancelJob" && !job.cancellable)) { onMessage("This action is not authorized in the current project role or connection state."); return; }
    const result = await onAction({ type, projectId: snapshot.project.id, jobId: job.id });
    onMessage(result.ok ? `${formatStateLabel(type)} request recorded by the server.` : result.message ?? "The server did not accept this action.");
  };
  return <article className="wb-job-row"><div className="wb-job-state"><StatusDot state={job.delivery} /><div><strong>{formatStateLabel(job.kind)} · {deliveryLabel(job.delivery)}</strong><p>{job.summary ?? "Job detail unavailable in this projection."}</p></div></div><div className="wb-job-progress"><span>{job.progress === null ? "Progress unknown" : `${Math.round(job.progress * 100)}%`}</span><div className="wb-progress-track"><span style={{ width: `${job.progress === null ? 0 : Math.max(0, Math.min(100, job.progress * 100))}%` }} /></div></div><div className="wb-job-meta"><span>Attempt {job.attempts}</span><span>Updated {formatDate(job.updatedAt)}</span></div><div className="wb-job-actions">{canRetry ? <ActionButton kind="secondary" disabled={!onAction || !snapshot.access.capabilities.canResearch} onClick={() => { void run("retryJob"); }}>Retry bounded branch</ActionButton> : null}{canCancel ? <ActionButton kind="text" disabled={!onAction || !job.cancellable} onClick={() => { void run("cancelJob"); }}>Cancel</ActionButton> : null}</div>{job.failureCode ? <p className="wb-card-footnote"><Icon name="warning" size={13} /> {job.failureCode} · completed results remain retained.</p> : null}</article>;
}

function RecoveryView({ snapshot, onAction, onMessage }: { readonly snapshot: WorkbenchSnapshot; readonly onAction?: WorkbenchViewProps["onAction"]; readonly onMessage: (message: string) => void }) {
  const recoverable = snapshot.jobs.filter((job) => job.delivery === "unknown" || job.delivery === "partial" || job.delivery === "paused" || job.state === "failed");
  return <div className="wb-page"><PageHeading eyebrow="BOUNDED RECOVERY" title="A setback. Not a restart." description="Keep the context, preserve completed evidence, and expose the next authorized move." />{recoverable.length === 0 ? <div className="wb-recovery-empty"><EmptyState icon="sync" title="No recovery is waiting" message="The current server projection has no unknown, partial, paused or failed provider job." /><div className="wb-honesty-card"><Icon name="shield" size={20} /><div><strong>Recovery stays bounded</strong><p>OpeningOS will not resend an ambiguous external action or erase the original outcome. It waits for reconciliation or an explicit authorized review.</p></div></div></div> : <div className="wb-recovery-list">{recoverable.map((job) => <JobRow key={job.id} job={job} snapshot={snapshot} onAction={onAction} onMessage={onMessage} />)}</div>}<div className="wb-recovery-story"><span className="wb-eyebrow">THE STORY, NOT JUST THE STATUS</span>{snapshot.activity.items.slice(0, 5).map((item) => <div key={item.id}><span className="wb-story-mark"><Icon name={item.state === "failed" ? "warning" : "check"} size={13} /></span><div><strong>{item.summary ?? "Activity detail unavailable"}</strong><p>{formatDate(item.occurredAt)} · {item.actorLabel ?? "Actor unavailable"}</p></div></div>)}</div></div>;
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
      <p className="wb-case-outcome">{serviceCase.outcome === null ? "Outcome pending — no recorded result in this projection." : serviceCase.outcome}</p>
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

export default function WorkbenchView({ loadState, onRetry, onAction, onLoadMore }: WorkbenchViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("project");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selectedOffer, setSelectedOffer] = useState<WorkbenchOffer | null>(null);
  const [evidence, setEvidence] = useState<WorkbenchEvidence | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const snapshot = loadState.state === "ready" ? loadState.snapshot : "lastKnown" in loadState ? loadState.lastKnown : undefined;
  const connectedAction = loadState.state === "ready" ? onAction : undefined;
  if (!snapshot) {
    return <main className="wb-connected-empty"><div className="wb-empty-hero"><span className="wb-brand-mark">O<span>.</span></span><span className="wb-eyebrow">OPENINGOS / PURCHASING WORKBENCH</span><h1>Waiting for an authorized project.</h1><p>{loadState.state === "empty" ? `${loadState.message} No vendors, quotes or provider outcomes are shown until server state is available.` : "The backend is connected, but no project-scoped projection has arrived yet. No vendors, quotes or provider outcomes are shown until server state is available."}</p><div className="wb-honesty-card"><Icon name="lock" size={18} /><div><strong>Private by default</strong><p>Project IDs, recipient details and raw provider headers stay out of the public projection. Ask the coordinator to wire the authorized project adapter before using this view.</p></div></div>{loadState.state !== "loading" && onRetry ? <ActionButton onClick={onRetry} kind="secondary"><Icon name="refresh" size={15} /> Retry project state</ActionButton> : null}</div></main>;
  }
  const tabContent = activeTab === "project" ? <ProjectView snapshot={snapshot} onReview={setSelectedOffer} onAction={connectedAction} onLoadMore={onLoadMore} onTabChange={setActiveTab} onMessage={setMessage} /> : activeTab === "suppliers" ? <SuppliersView snapshot={snapshot} onReview={setSelectedOffer} onOpenEvidence={setEvidence} /> : activeTab === "inbox" ? <InboxView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} /> : activeTab === "recovery" ? <RecoveryView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} /> : <EquipmentView snapshot={snapshot} onAction={connectedAction} onMessage={setMessage} />;
  return <div className="wb-app"><Header activeTab={activeTab} project={snapshot.project} onTabChange={setActiveTab} onOpenAssistant={() => setAssistantOpen(true)} /><LoadNotice loadState={loadState} onRetry={onRetry} /><OverviewStrip snapshot={snapshot} /><main id="workbench-main" tabIndex={-1}>{tabContent}</main>{message ? <div className="wb-toast" role="status" aria-live="polite"><span>{message}</span><button type="button" onClick={() => setMessage(null)} aria-label="Dismiss message"><Icon name="close" size={14} /></button></div> : null}{assistantOpen ? <AssistantRail snapshot={snapshot} onClose={() => setAssistantOpen(false)} /> : null}{evidence ? <EvidencePanel evidence={evidence} onClose={() => setEvidence(null)} /> : null}{selectedOffer ? <SelectionPanel offer={selectedOffer} snapshot={snapshot} onClose={() => setSelectedOffer(null)} onAction={connectedAction} onMessage={setMessage} /> : null}</div>;
}

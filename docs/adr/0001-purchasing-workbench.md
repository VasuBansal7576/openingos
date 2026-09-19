# ADR-0001: Purchasing workbench

Status: Accepted by the user on September 19, 2026.
Requirements: P-01, P-07, P-21, D-01, D-02, D-08.

## Decision

Use the purchasing workbench as OpeningOS's visual and interaction direction.
Preserve its complete clickable reference in `design/purchasing-workbench.html`.
The opening-scene and price-route alternatives are rejected and removed from the current checkout.
Their source remains recoverable from Git checkpoint `915844a`.

Keep the sage background, cream quote papers, forest-green action area, warm yellow primary actions, Manrope body text and DM Serif Display headings.
Supplier quotes, totals and controls are real semantic elements, not text painted into an image.
Paper rotation is decorative; using the app never requires dragging, precise pointer gestures or reading sideways text.
On phones, use stacked quote records with a persistent clear next action, not a miniature desktop desk.

The landing explains the product and offers sample-project and own-brief entry.
Returning users enter their current project and due decisions, rather than repeating the landing or onboarding.
Supplier discovery, comparison, evidence, conversation, selection, recovery and equipment history remain connected destinations.
Keep all discovered suppliers available in a list alongside the focused comparison.

## Improvements to carry into implementation

- Add a compact decision tray for changed prices, missing terms, approvals and delivery risks.
- Show the reason for each new quote version and what changed since the user's last visit.
- Pin the exact selected offer and its version while comparing new alternatives.
- Open evidence beside a quote on wide screens or in a focused sheet on phones without hiding the total.
- Preserve the distinction between research recovery and a purchasing substitution that needs approval.

These implement the existing PRD's decisions inbox and evidence requirements, not new launch scope.

## Alternatives

The spatial scene was inviting but made equipment placement look more authoritative than the evidence supported.
The price-route view explained costs well but was less suitable as the identity for correspondence and equipment history.
The user chose the workbench for the complete product.

## Consequences and verification

The single HTML file is a design reference, not source code to promote into production.
Its sample suppliers, scripted assistant, timing and prices must not become live behavior.
Check the real implementation against the reference at desktop and phone widths, then test keyboard focus, evidence access, quote revisions, unknown charges and recovery states.
No drag-and-drop library, canvas renderer or separate design-selection infrastructure is required.

# OpeningOS product requirements

Revision: 7, September 19, 2026.
Status: proposed product specification, revised from the supplied PRD and its review.
This document defines intended behavior, not implemented capabilities.
The original numbered sections retain their subject and numbering.
Section 52 adds acceptance criteria and hackathon delivery requirements.

## Product name

Working name: **OpeningOS**.
Alternative names remain FitOut, OpenReady, LaunchSpace, BuildReady, and SpaceOps.
Naming is not a prerequisite for implementation.

Tagline: **Open your next location with fewer surprises.**

OpeningOS helps café owners, operators, and hospitality professionals source compatible equipment, coordinate suppliers, and resolve purchasing problems across openings and operating locations.
It connects requirements, evidence, quotes, approvals, orders, equipment, and actual outcomes in one workspace.

### What changed in this revision

- Restricted the assistant to supported OpeningOS purchasing, supplier, and equipment workflows rather than general-purpose assistance.
- Distinguished unrelated requests, relevant but unimplemented capabilities, and legitimate contextual follow-ups.
- Required backend capability checks alongside request classification, with no expansion of authority through prompts, source content, or recovery.
- Added D-17 for product-scope enforcement while preserving all 51 existing acceptance criteria and launch-only planning sections.
- Recorded the user's selection of the purchasing workbench and rejection of the opening-scene and price-route alternatives.
- Preserved the complete selected fixture flow in `design/purchasing-workbench.html`; this is not production architecture or live functionality.

### Scope of this revision

This revision updates the agreed hackathon experience and its verification requirements.
ChatGPT Sites remains the hackathon frontend; this revision does not specify native mobile apps, a mobile framework, app-store delivery, paid-launch pricing, or billing implementation.
Existing launch-market, monetization, retention, and future-roadmap sections remain background planning and are not re-approved commercial decisions or additional hackathon delivery requirements.
The initial-product scope remains recorded rather than being silently reduced to the demonstration.
Section 52 defines the hackathon delivery boundary and identifies technical decisions still needed before implementation.
Platform constraints and conceptual records in this PRD are not a completed architecture or a substitute for ADRs and implementation contracts.

## 1. Executive summary

Opening a café involves expensive decisions whose consequences extend beyond the purchase price.
An espresso machine must suit demand, fit the counter, work with the recorded utilities, have appropriate water treatment, and arrive before installation.
Its supplier must provide usable commercial terms and service support.

Today, the information needed for these decisions is spread across websites, manuals, spreadsheets, quotes, and email threads.
OpeningOS turns that material into a live purchasing plan with evidence and accountable decisions.

The primary question during an opening is:

> What needs a decision or intervention today to get the equipment ready on time and within budget?

The same workspace remains useful after opening:

> What needs service, replacement, or supplier follow-up, and what is the best next action?

A single owner can use the product for one opening without needing an ongoing subscription.
A consultant or operator can use it continuously across several projects and locations.
Repeat use must come from recurring work the product resolves.

## 2. Product vision

OpeningOS connects physical-business requirements to supplier commitments and equipment outcomes.
It must preserve the context behind a decision so the next project does not start from an empty spreadsheet.

A future user can ask:

> Plan another location using our existing café, with a smaller seating area and a lower equipment budget.

The system reuses approved specifications, known suppliers, installation requirements, and actual costs.
It rechecks regional availability, current prices, service coverage, and delivery dates before recommending a new purchase.

The durable product advantage is the relationship between requirements, decisions, supplier promises, and observed outcomes.
Historical records do not automatically establish a competitive advantage or justify predictions.
The product must first demonstrate that those records improve a real purchasing or service decision.

## 3. Initial market

### Launch vertical

The initial vertical is specialty cafés and small coffee-shop groups.
Typical projects have 15–60 seats and an equipment or fit-out budget equivalent to roughly $30,000–$250,000.
These ranges describe the target customer, not eligibility restrictions or validated market size.

The primary subscription buyers are café consultants, hospitality designers who coordinate purchases, and small operators responsible for several locations.
First-time owners remain important users and can buy access for an individual project.

Equipment purchases offer observable requirements, meaningful supplier communication, and expensive compatibility mistakes.
Coffee equipment, refrigeration, water treatment, and furniture provide the initial category coverage.

### Initial supplier market

The first supported country and supplier region must be selected before implementing region-specific recommendations.
The decision should follow access to prospective customers, usable supplier information, and the ability to validate commercial terms.
Copenhagen remains an illustrative scenario and is not a confirmed launch market.

The initial release supports one defined supplier market and one reporting currency per project.
The data model retains country, currency, units, and source terms so expansion does not require rewriting purchase history.
Additional countries are future coverage, not a claim of initial support.

## 4. Expansion markets

The longer-term product can support restaurants, bars, bakeries, small hotels, salons, gyms, retail stores, offices, and coworking spaces.
Professional users can include franchisees, fit-out consultants, and design-build firms.

Expansion requires category-specific requirements, compatible supplier sources, and validation of installation and service assumptions.
A new vertical must not inherit café compatibility rules without review.

Repeat professional buyers are part of the initial market.
Enterprise procurement, broad construction coordination, and a supplier marketplace remain later possibilities.

## 5. Problem statement

Users need help with six connected problems:

- Determining what equipment and related infrastructure a project needs.
- Comparing suitable commercial products and suppliers.
- Obtaining missing prices, installation terms, and delivery commitments.
- Understanding the complete cost without treating unknown charges as zero.
- Identifying dependencies and interventions before a critical deadline is missed.
- Preserving purchase and equipment history for service, replacement, and another location.

The product must distinguish an attractive product listing from an actionable supplier offer.
A public price, a reported stock state, and a confirmed delivery commitment are different facts.

Public buyer discussions report differences between curbside and inside delivery, difficulty obtaining after-sales help, and uncertainty about repair versus replacement.
Supplier policies also expose return charges and delivery-damage reporting requirements that a headline price omits.
These reports motivate comparison and follow-through requirements; they do not establish market-wide prevalence or replace validation in the selected region.
Sources include [buyer delivery comparisons](https://www.reddit.com/r/restaurantowners/comments/1bcfts9), [after-sales experiences](https://www.reddit.com/r/restaurantowners/comments/1wduivf/im_on_the_equipment_side_not_the_restaurant_side/), [repair-versus-replacement experience](https://www.reddit.com/r/restaurantowners/comments/1qglzcd/equipment_replacement_schedule_does_anyone_do_this/), and [a supplier's published return and damage policy](https://www.webstaurantstore.com/blog/2754/returns-damages-and-restocking-fees.html).

## 6. Primary job to be done

> When I am opening, upgrading, or maintaining a café, help me make sound equipment decisions and coordinate suppliers so I can keep the location ready to operate within its budget and deadlines.

For professional buyers, the same job applies across multiple client projects.
For an individual owner, success may mean completing one opening and archiving the project.

## 7. Secondary jobs to be done

- Research suitable products without repeatedly collecting the same specifications.
- Explain tradeoffs using evidence the user can inspect.
- Collect missing commercial information from suppliers.
- Improve nonbinding offers within an approved negotiation mandate.
- Detect cost, compatibility, and timing risks.
- Find alternatives when equipment becomes unavailable or fails.
- Coordinate repair or warranty inquiries using existing equipment records.
- Reuse successful decisions without assuming old prices or availability still apply.

## 8. Target personas

### Persona A: first-time owner

The owner understands their concept but has limited experience with commercial equipment or fit-out procurement.
They need an approved requirements list, trustworthy comparisons, and a view of unresolved purchasing risks.
They can pay per project and retain access to purchase records after active work ends.

### Persona B: expanding operator

The operator is responsible for existing cafés and another opening or refurbishment.
They need location reuse, supplier history, equipment records, and visibility across pending purchases and service problems.
This is a primary subscription persona.

### Persona C: professional project manager

The consultant or designer coordinates several clients, suppliers, and approval chains.
They need a portfolio of projects, explicit client approvals, controlled access, and a record of commercial changes.
This is a primary subscription persona.

The workspace must support these roles without forcing a single-location owner through enterprise onboarding.

## 9. Core product principle

Recommend the best supported decision for the user's project and constraints.

Hard requirements determine whether an option is eligible.
Preferences rank the remaining options.
Missing evidence must remain visible and must not produce an unjustified recommendation.

The user's project remains authoritative.
A suggestion, a supplier reply, or a retrieved page cannot silently change an approved budget, specification, recipient, or purchase decision.

Users choose among inspectable options and delegate the work around those decisions.
They should not need to select models, configure browser plugins, troubleshoot provider failures, or repeat information already available to the project.
The product should resolve routine obstacles and report verified outcomes within the user's current authority and allowance.

### Product capability boundary

OpeningOS is a purpose-built application, not a general-purpose chatbot or browser agent.
It handles only supported workflows for the purchasing, supplier coordination, and equipment lifecycle described in this PRD.
Those workflows include requirements and compatibility, supplier research, quote comparison, permitted supplier communication, purchasing records, delivery risks, and equipment service or replacement.
Contextual explanations, calculations, source checks, and application-use help are allowed when they support one of those workflows.
Finding a previously unknown supplier within an approved research task is allowed; this boundary does not impose a fixed supplier list.

Unrelated requests such as homework, writing arbitrary code, general entertainment, personal errands, or browsing for an unrelated purpose receive a brief explanation of the product's scope and a relevant supported next step.
The assistant does not fulfill the unrelated task before adding a disclaimer.
For a clearly out-of-scope request, that response ends the request without research, browsing, outbound messages, or another execution job.
Do not treat the refusal as a recoverable agent failure, retry it through another model, or silently turn it into a different task.
A supported next step may be suggested, but the user must choose it before new work starts.
For example: "That is outside OpeningOS's scope. I can help with purchasing, suppliers, quotes, and equipment."
This is a guardrail around the existing product, not a reason to narrow its supported workflows or reject natural contextual follow-ups.
A relevant but unimplemented capability is identified as unavailable, not simulated or improvised as a new workflow.
Only shipped and enabled capabilities may execute; roadmap descriptions in this PRD do not make those capabilities available at runtime.

Interpret follow-ups using the authorized project context rather than rejecting them solely because they lack procurement keywords.
For a mixed request, handle the supported portion when it is safe to separate and explain which portion is outside scope.
Ask one focused question only when ambiguity materially changes the permissible work.
Use a concise redirect rather than scolding the user or repeatedly explaining policy.

Jev may classify requests against the product's supported capability catalog and identify uncertainty.
The catalog, valid inputs, project access, and permitted tool actions are defined and enforced by application code, not invented by the classifier or generating model.
An uncertain classification cannot grant an unknown capability or start unrelated external work.
The ADRs must specify the classification contract, decision thresholds, backend enforcement, and false-rejection tests before dependent implementation.

## 10. Key inputs during onboarding

### Start with the user's immediate job

Offer three entry points:

1. Plan an opening or equipment upgrade.
2. Compare existing quotes or product links.
3. Replace equipment or resolve a service issue.

All entry points create or attach work to an organization, location, and project or service case.
Users can import an existing equipment list through a supported CSV template and attach quotes or manuals.
They review extracted information before it becomes an approved requirement.

### Project and location information

Collect the project name, business type, country, city, reporting currency, required date, and location.
For openings, collect capacity, menu, expected demand, and floor area where relevant.
Distinguish equipment and furniture budgets from a total fit-out budget.

### Physical constraints

Collect dimensions, clearances, utilities, water supply, drainage, and installation constraints as needed for the category.
Floor plans and photographs are optional evidence.
Unknown utilities remain unknown and can block a compatibility conclusion.

### Financial preferences

Collect category allocations, contingency, new or used preferences, and any maximum spend.
Record whether figures include tax and which charges the user knows.
Do not infer financing authority from a project budget.

### Decision preferences

Users can prioritize price, reliability, serviceability, warranty, delivery, quality, appearance, sustainability, and resale value.
Use editable defaults rather than requiring a lengthy weighting exercise before first value.
Ask additional questions when they materially affect the shortlist.

### Progressive clarification

Start with the user's brief, selected dashboard records, and supplied documents.
Reuse known project facts and request missing supplier facts through an authorized supplier channel before asking the user to research them.
Begin independent work while a question remains unresolved.
Bundle decision-changing questions and approval requests into one short review where practical.
Show reversible assumptions with an edit action instead of stopping for every preference.
Do not guess critical site measurements, utilities, or permission to contact a new recipient.
An unanswered question is not consent, and an unknown specification remains unknown.

## 11. Core user journey

### Opening or upgrade

1. The user describes the location, purchasing scope, budget, and deadline.
2. OpeningOS proposes requirements, assumptions, and dependencies.
3. The user reviews material requirements and a job brief covering scope, research allowance, deadline, and any outbound authority before work expands.
4. Research uses Firecrawl and, where interaction is needed, Jev-guided browser work to produce source-backed product and supplier candidates.
5. The vendor dashboard and comparison show known costs, missing charges, lead times, compatibility findings, and evidence freshness.
6. The user approves recipients, disclosure, and content or a bounded communication brief for a request for quotation, called an RFQ.
7. A supplier response becomes a versioned quote with links to its original evidence.
8. OpeningOS compares equivalent commercial scopes, obtains permitted supplier clarification, and asks the user only about unresolved decision-changing choices.
9. If authorized, a bounded negotiation seeks an improved nonbinding offer.
10. The user selects a candidate and approves an exact quote version.
11. The user records an externally placed order and later confirms delivery and commissioning.
12. The system monitors relevant evidence, recovers from routine execution failures, and proposes approval-bound changes when a purchasing risk appears.

Selection changes the forecast.
Only a recorded order or another explicit binding commitment changes committed expenditure.
Payment records change cash paid.

### Existing café

The user can begin with a quote, equipment record, or replacement need.
OpeningOS reuses known specifications, purchase evidence, warranties, and suppliers.
It compares service or replacement options, obtains approved supplier clarification, and records the user's decision and outcome.

### Professional workspace

The user starts from an inbox of decisions and exceptions across authorized projects.
A completed project can provide a reusable template and installed-equipment records for later work.

### Hackathon evaluator path

This is the intended first-use path for a judge or fresh visitor, not a claim that the screens exist yet.
Screen names describe destinations and behavior; the UI decision will establish layout and navigation.
Offer an isolated sample café project so a visitor can evaluate the workflow without supplying private documents or completing account setup.
Also expose a new-project entry for the user's own brief within the allowed guest limits.
The sample project identifies its seeded records and controlled supplier exchange explicitly.
It must never imply that illustrative vendors are real discoveries or that a recorded reply just arrived live.

| Step and destination | What the visitor does | Required visible result | Existing criteria |
| --- | --- | --- | --- |
| 1. Entry | Opens the public site and chooses Try the sample project | A fresh isolated guest project opens with the task, sample-data label, and a clear next action | H-06, P-16 |
| 2. Project brief | Reviews equipment, location constraints, budget, deadline, and allowed research spend, then starts research | Editable assumptions and a bounded research job appear without unrelated onboarding questions | P-01, P-02, D-14, D-16 |
| 3. Vendors | Watches results arrive and opens a supplier row | Sources, exact variants, coverage, freshness, missing charges, and compatibility findings are inspectable while other research continues | P-03, P-04, D-01, D-03, D-04 |
| 4. Comparison and assistant | Selects two offers and asks why one costs more | The answer uses the selected current quotes and cites their evidence without asking for the project again | P-07, D-02, D-08 |
| 5. Outreach review | Reviews the controlled recipients, permitted disclosure, and communication brief, then approves | A real permitted AgentMail send has a traceable status; later covered clarification does not require repeated approval | P-05, D-07, D-14 |
| 6. Supplier reply | Opens the controlled reply and its extracted terms | A new quote version appears with its original evidence; permitted clarification or negotiation shows a sent message and either a verified reply or an honest waiting state | P-06, P-23, D-12, D-13 |
| 7. Decision | Compares equivalent totals and selects an exact offer version | The selected forecast changes, while committed and paid totals remain unchanged; the interface says no order was placed | P-07, P-08 |
| 8. Recovery | Runs a clearly labeled demonstration fault or opens a controlled delivery-change event | Completed results remain, a bounded recovery attempt is visible, and any substitute needs approval without erasing the old selection or order history | P-12, P-17, D-05, D-06, D-15 |
| 9. Equipment and return visit | Opens a labeled seeded installed-equipment record, starts a service case, and reloads the project | Purchase and warranty evidence remains accessible; the case and prior work persist without turning the newly selected offer into an installed asset | P-18, H-03, H-07 |

Use the existing section 39 comparison amounts for a reproducible controlled test: €7,950 with delivery and installation included versus €7,500 plus €600 delivery and €400 installation, totaling €8,500.
The equivalent-scope difference is €550; an incomplete third offer is not ranked as cheapest on missing charges alone.
Include an incompatible variant and a suitable vendor with an unpublished price in the evaluator dataset.
Show what Jev decided and what a subsequent independent check observed, without exposing private reasoning or credentials.
Do not require external suppliers to respond within the video duration.
Use a controlled responder for the demonstrated round trip and keep the real integration trace available; any previously captured exchange is labeled as recorded.
The sub-three-minute video can present selected moments from this path, but it does not impose a three-minute limit on asynchronous provider work.

### Companion failure and usability checks

These checks extend the main path and do not replace or renumber existing acceptance criteria.

- Interrupt research after partial results, retry the failed branch, and verify that completed results survive without duplicate messages or records.
- Change a quote after it is displayed and verify that old approvals cannot execute and the assistant no longer treats its cached answer as current.
- Revoke outreach authority before a queued send and verify that no message leaves; requesting a new external recipient must require review.
- Exercise provider exhaustion, cancellation, and an unrecoverable failure; each must display a truthful state and retain useful completed work.
- Open two guest sessions and a private test project; verify isolation through backend calls as well as the interface.
- Complete the comparison and approval steps by keyboard and on a narrow viewport, including loading, empty, missing-evidence, error, and recovery states.
- Check D-17 with an unrelated request, a relevant but unavailable feature, a legitimate short follow-up, a mixed request, a direct unsupported backend operation, and a supplier document that tries to redirect the task.
- For an entirely unrelated request, verify that the brief refusal ends that request with no execution job or recovery retry, while an independent legitimate job continues unaffected.

Tests record the relevant existing requirement IDs, environment, commit, fixture or live source, action, expected outcome, actual outcome, and evidence.
The complete integration path must run against the combined application, not only separate worker mocks.

## 12. Main product screens

### Workspace overview

Show active projects, locations, due decisions, critical risks, pending supplier replies, and service cases.
Prioritize actionable exceptions over a raw stream of agent activity.
Every exception has an owner, evidence, a due date where known, and a proposed next action.

### Project dashboard

Show procurement readiness, critical prerequisites, projected completion cost, selected forecast, committed expenditure, paid amounts, and contingency.
Show the purchasing scope and any external prerequisites that remain unassessed.
Provide category navigation, recent material changes, and approval requests.

### Vendor dashboard and contextual assistant

Show the discovered vendors and relevant product variants for the selected requirement, with filters, sorting, and side-by-side selection.
Keep the broader discovered list accessible instead of hiding every option outside a recommended shortlist.
Include item price, known delivered-and-installed cost, missing charges, availability basis, service coverage, quote validity, and last successful verification.
Distinguish discovered listings, comparable offers, and supplier-confirmed terms.
State the region, categories, and sources covered rather than claiming that every possible vendor has been found.

The assistant receives the authorized project, selected rows, current quote versions, and relevant evidence automatically.
A user can ask why one option costs more, what is excluded, who services it, or what changes if they choose another option without repeating the comparison context.
Prepare and cache answers to these likely questions while enriching shortlisted options, within the job's allowance.
Invalidate affected answers when their underlying quote, specification, or project constraint changes.
Return available evidence immediately and show any additional verification as work in progress.
Keep an answer, a proposed action, an approved action, and its verified external outcome distinct.
Use scoped prompts such as "Ask about suppliers, quotes or equipment" rather than "Ask anything".
Out-of-scope and unavailable-capability messages leave the current comparison and legitimate job intact.

### Decisions inbox

Show what changed, its effect on cost or timing, the evidence, and the decision requested.
Approvals identify the exact product, quantity, quote version, and commercial assumptions.
Group related unresolved questions into one review with the evidence already gathered and the proposed next action.
Keep routine automated clarification and recovery in activity history instead of making every uncertain model answer a user task.

### Location equipment view

Show installed equipment, purchase and warranty documents, service history, known compatibility constraints, and open replacement needs.

### General interface requirements

Provide usable loading, empty, partial-result, error, cancellation, and recovery states.
Preserve work when a provider fails or the user leaves the page.
Support keyboard navigation, clear focus, readable contrasts, and a responsive layout.
Show the last successful check when data is stale.

### Visual direction and implementation gate

The product is a web application with a procurement workspace, not a dashboard of charts or a chat-only interface.
Its primary destination combines supplier exploration, comparable offers, evidence, and contextual assistance.
Project status, decisions, and equipment history support that task.
On a narrow viewport, keep the same records and actions accessible through focused views rather than shrinking a desktop table beyond readability.

The first three exploratory concepts established possible screen structures but were not selected.
A further ChatGPT ImageGen pass explores stronger visual identity, typography, and purposeful imagery while keeping comparison and source inspection central.
Further exploration varies composition and interaction, including equipment-linked café imagery, visual cost comparisons, and a document workbench rather than only changing colors or fonts.
Illustrative spatial scenes do not establish measured site fit or add a floor-plan editing requirement.
The user accepted the purchasing workbench on September 19, 2026 and rejected the opening-scene and price-route directions.
The complete accepted flow is preserved as the self-contained `design/purchasing-workbench.html` reference.
Use the sage desk, cream quote papers, forest-green controls, warm yellow actions, and editorial typography as the visual direction.
Use real accessible text and controls, with focused stacked records on narrow screens, not a raster screenshot or mandatory drag-and-drop.
Illustrative suppliers, prices, timestamps, copy and asset specifications are not verified product data or additional requirements.
The prototype's fixture logic, research timing and scripted assistant are not production contracts.
Production navigation, evidence handling and missing states must satisfy the evaluator path and the accepted ADRs.
Validate the chosen flow with a clickable implementation and actual keyboard and narrow-screen checks; generated images cannot verify interaction or accessibility.

## 13. Requirement detail screen

Each requirement shows its quantity, hard constraints, budget allocation, required date, evidence, dependencies, and responsible person.
It includes candidate options, supplier communication, quotes, decisions, and related orders or equipment.

Keep three kinds of state distinct:

| State | Examples |
| --- | --- |
| Requirement progress | Draft, approved, sourcing, ready for decision, selected, fulfilled, cancelled |
| Supplier conversation | Draft RFQ, awaiting reply, clarification needed, quote received, negotiating, closed |
| Fulfillment | Not ordered, ordered, partially delivered, delivered, installed, commissioned, cancelled |

Risks such as blocked, delayed, or incompatible are separate flags with evidence.
Several vendors can be at different conversation stages for the same requirement.
Quantity fulfillment must account for partial deliveries and accepted units.

## 14. Comparison screen

Compare options on product and variant, vendor, quantity, unit price, freight, installation, required accessories, tax basis, duties, and commercial exclusions.
Include acquisition cost, delivery basis, warranty, service coverage, compatibility, and evidence freshness.

Distinguish curbside delivery, unloading, inside placement, installation, commissioning, and old-equipment removal when applicable.
Record the named warranty or service contact, documented service region, and whether responsibility is supplier reported or independently supported.
Show return eligibility, restocking charges, return freight, and relevant delivery-damage reporting requirements when available.
Prepare an order-specific receiving checklist from the applicable supplier terms when delivery information is recorded.
Receiving guidance and a prepared claim do not establish that a supplier has accepted a claim or refunded money.
Do not generalize one vendor's policy to other vendors or regions.

Every charge has one of these states:

- Known amount.
- Explicitly included elsewhere.
- Estimated amount or range.
- Unknown.
- Not applicable, with a reason.

An unknown charge prevents an unqualified claim that one complete offer costs less.
The interface can still compare known subtotals and show what must be clarified.

Recommendations explain the constraints met, the remaining uncertainty, and the tradeoffs.
Avoid a single unexplained score.

Illustrative complete comparison, on the same tax basis:

| Charge | Supplier A | Supplier B |
| --- | --- | --- |
| Equipment | €7,950 | €7,500 |
| Freight | Explicitly included | €600 |
| Installation | Explicitly included | €400 |
| Comparable acquisition cost | €7,950 | €8,500 |

The difference is €550 only when the quantities, scope, tax treatment, and exclusions are equivalent.
If A has not confirmed installation, the €550 saving must not be claimed.

## 15. Project graph

Model technical dependencies separately from scheduling dependencies.
An espresso machine can depend on electrical capacity, water treatment, drainage, counter dimensions, installation, and commissioning.

Each dependency has a type, responsible person, evidence, and verification state.
Changing a product or site constraint re-evaluates affected findings and invalidates approvals whose basis changed.
Changes to a product specification do not rewrite the original approved quote.

Reject dependency cycles in scheduling relationships.
Do not invent durations for unknown external activities.
Represent recorded external milestones without claiming to manage the contractor or permit process.

## 16. Compatibility engine

The initial rules cover dimensions and required clearance, supported electrical requirements, water-treatment prerequisites, required accessories, and documented commercial or regional coverage.
The engine can also flag capacity and serviceability concerns when evidence supports them.

Each finding is a pass, fail, or unknown with its input values and source evidence.
Missing data is never a pass.
Normalize units and retain the original source value.
Evaluate the exact product variant and required quantity.

Critical installation decisions require a qualified human confirmation when the available evidence cannot establish site suitability.
An override records the user, reason, and affected risk rather than changing the source evidence.

## 17. Budget engine

### Financial states

| Term | Meaning |
| --- | --- |
| Allocation | Planning allowance for a requirement or category |
| Estimate | Current forecast before a candidate is selected |
| Selected forecast | Expected cost of a selected offer that has not become a binding order |
| Committed expenditure | Order obligation after approved amendments and cost-reducing credits, regardless of payment state |
| Paid amount | Confirmed payments applied to a commitment, less recorded cash refunds |
| Actual acquisition cost | Settled purchase cost, including recorded adjustments and credits |

A deposit is a payment against an order, not a second purchase cost.
An approved selection does not establish an order.
An order entered by a user is distinguished from supplier-confirmed fulfillment evidence.

### Forecast calculation

Projected acquisition cost combines commitments and forecasts for quantities not yet committed.
Use the selected offer for an uncommitted quantity when available, otherwise use its current estimate.
Settled costs replace the corresponding commitment in the forecast.
Never add actual, committed, selected, and estimated amounts for the same units.

```text
Projected completion cost
= current cost of ordered quantities
+ forecast cost of uncommitted quantities

Projected headroom
= approved budget
- projected completion cost
- contingency reserve

Outstanding committed balance
= net recorded commitments
- net applied payments
```

Apply adjustments to the specific line item and financial state they affect.
A price-reducing credit changes the net commitment once.
A cash refund changes net applied payments once.
Link related credit and refund events without subtracting either twice.
For example, an €8,500 order with a €2,000 deposit has a €6,500 outstanding balance.
A subsequent €500 price reduction changes the obligation to €8,000 and the outstanding balance to €6,000.
When a final cost is unknown, show a range or an incomplete forecast.

Store money in integer minor units with its currency.
Use deterministic calculations for quantity, totals, and differences.
AI can extract and explain terms but cannot invent a missing charge.
Mixed-currency offers require an explicit dated conversion basis and remain indicative until that basis is accepted.
Automatic foreign-exchange sourcing and tax calculation are not initial requirements.

Budget recovery suggestions show the change in forecast and any effect on compatibility, deadline, quality, or service.
They never automatically change an approved selection.

## 18. Deadline engine

Track decision deadline, quote expiry, order-by date, shipment, expected arrival, installation, commissioning, and need-by date where applicable.
Record whether each date is estimated, supplier reported, or confirmed for an order.

Lead times retain their start condition and calendar basis.
For example, ten business days after deposit is not ten calendar days after the quote was received.
If the start condition is unknown, do not present an exact arrival date as confirmed.

For an opening-critical requirement, compare the expected ready-for-use date with its need-by date.
Include installation, commissioning, dependencies, and explicit buffers.
A late noncritical item remains a warning unless its dependencies make it critical.

## 19. Opening critical path

Keep the original priority meanings:

- P0: the declared operating scope depends on the requirement being ready.
- P1: missing the requirement materially degrades the intended operation.
- P2: the requirement can arrive later without blocking the declared operating scope.

The user approves the operating scope and can revise priority with an explanation.
Dependency analysis may reveal that an apparently minor item is a prerequisite for a P0 requirement.

Show procurement paths that determine the earliest supported equipment-ready date.
When durations or external milestones are missing, show an incomplete schedule instead of a precise full-project critical path.
Report unassessed external prerequisites separately.

## 20. Vendor discovery

Find vendors by category, delivery region, authorized-dealer evidence, commercial offering, support, and technical suitability.
Keep the manufacturer, product model, product variant, and seller as distinct records.
Several vendors can quote the same model.

Distinguish a manufacturer-confirmed dealer from a vendor's own claim.
Retain service-coverage evidence and the date it was checked.
Do not infer supplier reliability from a polished website.

Use customer-provided suppliers and existing relationships alongside discovery.
Avoid requiring vendors to create an OpeningOS account to answer an RFQ.

Track discovery coverage and distinguish an unknown price from a missing vendor.
Group offers for the same exact model without merging different variants or treating separate sellers as one supplier.
Jev can propose relevance, duplicate, and variant-match judgments for validation against identifiers and source evidence.
Keep uncertain matches separate and inspectable.

### Research prioritization

Jev assesses which candidate or next research action is worth pursuing before expensive browsing, extraction, or detailed reasoning begins.
Consider known fit, decision urgency, missing evidence, likely usefulness of another check, and the remaining research allowance.
Evaluate independent questions together when they use the same observed state.
Code applies known hard constraints before preference-based prioritization.

Distinguish a candidate rejected by evidence from one deferred for later research or still awaiting information.
An unpublished price, sparse website, or unresolved specification is not by itself a reason to reject a supplier.
Keep discovered alternatives and the reasons for deferral accessible, and let the user request deeper research within the job's authority and allowance.
Reconsider deferred paths when new evidence or changed requirements make them relevant.
This prioritization, also called branch pruning, limits further work without deleting the candidate or claiming that the whole market was searched.

## 21. Firecrawl requirements

Firecrawl provides external-web discovery, search, extraction, and monitoring.
It is used inside the product, not only during development.

Supported work includes product specifications, public prices, documentation, warranty terms, dealer research, availability checks, and replacement discovery.
Retain source URL, capture time, exact variant, extraction outcome, and supporting evidence for material claims.

Use the official `@firecrawl/firecrawl-convex` component when its current documented behavior fits the implementation.
Durable crawls should expose progress and usable partial results through Convex.

### Failure and freshness behavior

- A failed or blocked page check records an error or unknown result, not an out-of-stock transition.
- A stale result remains accessible with its last successful capture time.
- Rate limits and transient failures receive bounded retries.
- Exhausted credits stop additional work and give the user a clear recovery action.
- Duplicate research requests reuse appropriate recent evidence within the same organization's permissions.
- Monitoring cadence depends on decision urgency and the user's allowance.
- Users can stop a research job or watch and inspect its completed work.

Suppliers without accessible pages remain usable through approved email or user-provided documentation.

### Integrated collection and browser interaction

Use structured supplier interfaces when available, Firecrawl for suitable web collection, and Browser Use or an equivalent permitted browser executor for interactive pages.
Jev can choose relevant sources, available tools, and browser operations from the observed state.
The selected tool performs the network request or browser action; Jev does not replace the fetching service.
Firecrawl must continue to perform observable product work for the hackathon.

Customers do not install browser plugins, provide model-provider keys, or run a local developer process to use the deployed product.
Interactive work can include navigating supplier catalogs, selecting variants, reading dynamic terms, and submitting an authorized inquiry.
Treat browser form submission as external communication subject to the same scope, disclosure, and recipient checks as email.
Choose a browser execution environment reachable from the deployed application; a developer's logged-in Chrome is not a customer runtime.
The specific hosted service or isolated executor, supported browser interactions, and fallback route require a technical decision before implementation.

Reuse only the customer's authorized, isolated session for the relevant supplier.
Handle supported authentication and CAPTCHA flows through the selected provider within permitted access; do not promise universal completion or unrestricted bypasses.
When a site genuinely requires the user, offer a private handoff and resume from the saved job state afterwards.
Credentials, session cookies, browser recordings, and live-view links must not leak into public logs, another workspace, or a public judge session.
Browser Use Cloud capabilities and the open-source Jev Ultrafast implementation must be verified separately rather than assumed to be identical.

## 22. AgentMail requirements

AgentMail manages supplier RFQs, clarification, bounded negotiation, service inquiries, and replies.
Use the official `@agentmail/convex` component when it meets the required behavior.

Before the first message, the user approves the recipient, represented business, disclosed details, and purpose.
One review can authorize a named set of recipients and routine clarification or follow-up within an explicit brief and limit.
Do not ask for a new approval for each message already covered by that brief.
New recipients, sensitive disclosures, or material changes outside the brief require a fresh review.
The message asks for the exact variant, quantity, freight, installation, tax basis, lead-time basis, warranty, validity, and exclusions relevant to that decision.

### Follow-ups and delivery

Configure a follow-up interval and maximum count per conversation.
Stop follow-ups after a relevant reply, decline, cancellation, user takeover, or exhausted allowance.
Prevent a queued follow-up from sending after the stopping condition is recorded.

Track queued, sent, delivered where reported, bounced, and failed messages distinctly.
Use stable identifiers to prevent duplicate sends on retries.
Validate inbound webhooks and deduplicate events before changing application state.
Route conversations to their authorized organization and project without relying only on the email subject.

### Negotiation and service communication

Negotiation can request changes to price, freight, installation, accessories, warranty, or another explicitly permitted term.
It cannot accept an offer or create a purchase, financing agreement, subscription, or service contract.
The user completes binding transactions outside the initial product and can record their outcome.

## 23. Email understanding

Classify replies as quotes, clarification requests, declines, unavailability notices, partial responses, negotiation, order updates, service responses, or attachments.

Extract line items, product variants, quantity, currency, unit cost, charges, tax basis, lead time, exclusions, validity, and conditions.
Support a quote covering several requirements without charging shared freight repeatedly.
Preserve versions when a supplier revises an offer.

Original messages and supported attachments remain accessible only to authorized users.
Unsupported or unreadable attachments are marked for manual review.
Users can correct extracted fields while retaining both the source and the correction history.

An email requesting a payment or changing commercial terms creates a review item.
It does not authorize a payment or invalidate an existing record silently.
Email and web content are untrusted evidence and cannot issue instructions to the agent.

## 24. Negotiation guardrails

Each mandate specifies the offer version, recipient, desired outcome, target, hard limits, permitted concessions, expiry, and maximum rounds.
Users can pause or revoke it.

Increased quantity and flexible delivery are concessions only when explicitly authorized.
The system recalculates total cost and timing before proposing either concession.
It cannot disclose the internal maximum budget, competitors' identities, private quotes, or other restricted information.

Stop when the target is reached, the supplier makes a final offer, the round limit expires, a user takes over, or a material ambiguity appears.
Requests for deposits, acceptance, contractual terms, or commitments require human handling.

Changing the specification, quantity, recipient, or approved limits invalidates affected pending actions.
Recheck authority immediately before each send.

### Jev-guided negotiation

Jev chooses the next permitted move using the current quote, supplier reply, missing terms, and approved mandate.
Moves include requesting clarification, countering on price, requesting freight or installation inclusion, requesting warranty coverage, holding the current position, stopping, or requesting user review.
Resolve missing comparison terms before treating a lower headline price as a better offer.
The selected move identifies its target term and supporting evidence.
OpenAI drafts the message for that move, and the application checks the draft against the current mandate before sending.
Amounts, concessions, and recipients must remain within the approved limits regardless of model confidence.
Record the move, sent message, subsequent reply, and resulting quote version so the user can inspect what changed.
Count a negotiated improvement only when the supplier's revised terms support it on a comparable basis.

## 25. Recommendation model

First identify candidates that meet known hard constraints.
Then rank eligible candidates using the user's preferences and the available evidence.
An unresolved hard constraint produces conditional eligibility, not a hidden penalty that a low price can outweigh.

Consider acquisition cost, technical fit, deadline fit, quality evidence, commercial warranty, local service, availability, and uncertainty.
Show contradictory sources and weak comparisons.

For operating equipment, compare repair and replacement when both are relevant.
Use documented repair offers, warranty coverage, delivery timing, installation cost, and user-supplied downtime impact.
Do not invent expected lifetime, failure probabilities, or lost revenue to make an option appear superior.

## 26. Confidence levels

Keep source type, freshness, confirmation, and model confidence as separate attributes.

Use these user-facing evidence labels:

- Manufacturer published.
- Vendor published.
- Supplier reported for this inquiry or order.
- User confirmed.
- Inferred, with the derivation shown.
- Unknown or conflicting.

A manufacturer page establishes what was published, not that a site's installation will work.
A reported stock quantity is a time-bound statement, not an allocation to this customer.
Use "confirmed for this order" only when supporting order-specific evidence exists.

Freshness requirements depend on the field.
Stable dimensions and volatile stock status do not need the same checking interval.
Expiring evidence can trigger a new check before approval or reuse.

### Resolve uncertainty before interrupting the user

Jev helps choose whether to continue an authorized action, gather more evidence, use another permitted method, or request human review.
Consider the available evidence, model confidence, consequences of an error, reversibility, and remaining allowance together.
Use an existing record, another source, or an authorized supplier clarification when that can answer the question without the user.
Continue independent work while the uncertain item waits.
Escalate when the unresolved issue needs the user's preference, site knowledge, new authority, or review after bounded recovery is exhausted.
Present the precise unresolved fact, checks already attempted, affected decision, and proposed next step.
High confidence never overrides a required approval, and low confidence alone does not justify interrupting the user before permitted checks.
Set and test thresholds for each decision type in the implementation decisions rather than adopting one universal confidence cutoff.

## 27. Stock watch

Users can watch shortlisted or selected products for availability, price, or discontinuation changes.
A watch records its source, scope, last successful check, next check, and allowed cost.

Supported observations include available, low stock when evidenced, unavailable, discontinued, changed, and unknown.
A scrape error remains unknown.

An observed change prompts a project impact assessment.
Public listing availability affects an unplaced purchase differently from an already placed order.
For an existing order, request or inspect supplier confirmation before labeling that order delayed.

The system can research substitutes and propose approved supplier clarification.
It cannot cancel an order or buy a replacement automatically.

## 28. Substitute engine

Find replacements using the original requirement, current site constraints, remaining quantity, required date, and any recorded order commitments.
Hard constraints include fit, utilities, necessary certification evidence, quantity, region, and deadline.
Soft preferences include appearance, brand, material, price, and color.

Show what changes beyond the product price, including accessories, installation, warranty, service, and dependent requirements.
Treat cancellation fees or unused deposits as known, estimated, or unknown when an existing order is involved.
Do not present a substitute as a saving without accounting for those effects.

A replacement requires a new selection and approval.
The existing purchase history remains intact.

### Re-evaluate suppliers when facts change

When a quote, availability statement, delivery commitment, or documented service condition changes, re-evaluate the affected options.
Jev helps prioritize which alternatives need fresh evidence or an authorized supplier inquiry.
Apply the current hard constraints and compare equivalent commercial scopes before changing the recommendation.
Show the previous and current recommendation, the changed evidence, and any remaining uncertainty.
Do not invent cancellation risk or supplier reliability scores when supporting records are absent.
Re-ranking prepares a decision for the user and does not automatically replace a selection, cancel an order, or dispatch a service provider.

## 29. Opening readiness score

The interface calls this measure **procurement readiness** or **equipment readiness**.
It does not certify that the business can legally or operationally open.
Permits, construction, staffing, inspections, and other external prerequisites are shown separately with their assessment state.

Lead with critical blockers, unknown prerequisites, and due decisions.
A percentage is secondary.

For the initial calculation, an applicable requirement is ready only when its accepted quantity and required installation or commissioning milestones are complete.
Selected or ordered items remain work in progress.
Readiness also requires resolved blocking dependencies.

The default priority allocation remains P0 at 60%, P1 at 30%, and P2 at 10%.
Within each priority group, requirements receive equal weight unless an explicit, visible configuration overrides it.
Normalize weights across groups present in the declared scope.
Show the numerator, denominator, scope, and unresolved P0 count.

An empty scope shows "not assessed" rather than 100%.
An unresolved P0 requirement remains a blocker regardless of the percentage.
Reducing scope requires user confirmation and appears in the activity history.

## 30. Convex architecture

Convex owns durable application records, authorization, queries, mutations, actions, scheduled work, and realtime subscriptions.
ChatGPT Sites owns the frontend and public application URL.
Browser clients use the public Convex client and generated function references.
Backend credentials remain in backend configuration.
These are hackathon platform constraints, not final choices of every table, workflow component, authentication provider, or browser runtime.
Keep purchasing rules and durable workflows outside presentation components so the Sites interface does not own business state.
Convex initiates and records external browsing work through a defined provider boundary and remains authoritative for permissions, progress, evidence, and costs.
A browser executor must not become a second application database or independently grant itself new authority.

### Core records

| Record | Purpose and essential relationships |
| --- | --- |
| `users` | Application identity linked to the chosen authentication provider |
| `organizations` | Customer workspace, account plan, and usage allowances |
| `memberships` | User, organization, role, and explicit project access |
| `locations` | Organization, region, reporting defaults, utilities, and operating status |
| `projects` | Organization, location, opening or upgrade scope, budget, currency, and deadlines |
| `requirements` | Project, quantities, category, priority, approved constraints, and progress |
| `dependencies` | Typed prerequisite relationships, verification state, and evidence |
| `candidates` | Requirement, product model, exact variant, and supplier offer references |
| `productEvidence` | Field-level claims, source, capture time, normalized value, and conflicts |
| `vendors` | Supplier identity, regions, service coverage, and evidence |
| `vendorContacts` | Authorized contact details and communication preferences |
| `rfqs` | Organization, project, requested line items, recipients, and conversation references |
| `quotes` | Versioned supplier offers with line items, charges, conditions, and source evidence |
| `negotiations` | Quote version, approved mandate, limits, expiry, rounds, and execution state |
| `selections` | Chosen candidate, quantity, quote version, and selecting user |
| `approvals` | Exact decision snapshot, approver, time, scope, and invalidation state |
| `orders` | User-recorded commitments, ordered quantities, supplier references, and amendments |
| `orderEvents` | Confirmation, shipment, partial delivery, acceptance, installation, and commissioning |
| `costEntries` | Payments, settled costs, refunds, credits, and their linked order lines |
| `assets` | Installed equipment, serial where supplied, location, constraints, and purchase provenance |
| `assetDocuments` | Authorized links to manuals, warranty terms, and purchase documents |
| `serviceCases` | Equipment issue, urgency, warranty inquiry, repair or replacement options, and outcome |
| `watches` | Evidence being checked, last result, cadence, allowance, and active state |
| `jobs` | Durable research, browser, or communication work, input versions, progress, attempts, recovery, cancellation, costs, and verified outcomes |
| `projectEvents` | Append-only material changes with actor and evidence references |
| `risks` | Affected scope, severity, source, owner, resolution, and dependencies |
| `templates` | Organization-owned reusable requirements, constraints, and source-project references |

These records describe required concepts rather than a mandate for one physical table per row.
Reuse suitable official component storage for provider-specific inbox and workflow state.
Do not duplicate the full AgentMail message store without a product need.
Define the typed handoffs among research, browser execution, model decisions, messages, and record updates before assigning parallel implementation packages.

### Access and consistency

Every public function authenticates and authorizes the requested operation where customer data is involved.
Derive organization access from trusted identity and membership records.
Do not trust an organization identifier supplied by the browser as proof of membership.

Protect client projects from other clients and unauthorized team members.
Use indexed, bounded reads and pagination for growing records.
Keep approvals and immutable source evidence separate from mutable projections.
External events and retries must not create duplicate sends, quotes, commitments, or equipment records.

### Components and provider boundaries

Prefer suitable maintained Convex components for Firecrawl, AgentMail, durable workflows, queues, and usage limits.
Verify the current component contracts before implementation.
The intended sponsor packages are `@firecrawl/firecrawl-convex` and `@agentmail/convex`.
The actual installed and registered components are recorded in the build log only after implementation.

Authentication is required for private customer work, but a specific auth provider is not selected in this PRD.
The hackathon guest experience must use a separate, limited evaluation workspace.

## 31. Convex functions

Queries cover workspace decisions, project requirements, candidate comparison, financial state, procurement paths, activity, vendor history, equipment, and service cases.

Mutations cover approved project edits, requirement approval, decisions, quote corrections, order recording, delivery acceptance, equipment handover, service outcomes, and risk resolution.
Approvals and financial transitions enforce the invariants in sections 17 and 35.

Actions perform Firecrawl, AgentMail, OpenAI, Jev, document-processing, and external browser-service coordination.
External results are validated before mutations write them to application state.
Provider ingestion and privileged processing use internal functions where public access is unnecessary.

Durable work records preserve progress through retries and restarts.
Every external operation has an idempotency strategy, bounded attempts, cancellation behavior, and a user-visible terminal state.
Uncertain results of a state-changing external action require reconciliation before retrying that action.
Pending supplier replies are a waiting state, not a reason to keep running a browser or model loop.

## 32. Realtime requirements

New candidates, quote revisions, delivery events, approval requests, and material risks appear through Convex subscriptions.
Users do not need to refresh the page.

Distinguish a received quote from an approved selection and a recorded order.
A quote revision can change an indicative comparison without changing committed expenditure.
A stale approval becomes a review item rather than silently authorizing new terms.

Users can leave and return while work continues.
Show connection loss and stale data, then reconcile with server state after reconnection.
Do not display an email as sent until its send operation has the corresponding recorded result.

## 33. OpenAI and Jev responsibilities

### OpenAI

OpenAI interprets the project brief, proposes requirements, extracts commercial facts, drafts communication, compares evidence, and explains recommendations.
It can identify likely contradictions and propose substitute candidates.

Structured outputs receive schema validation before they affect records.
Material extracted fields link to their source text or document location.
Low-confidence extraction and ambiguous commercial terms enter the evidence-checking and review process in section 26.

Deterministic application logic owns arithmetic, authorization, approved limits, state transitions, and compatibility rules that can be expressed directly.
The model does not invent prices, supplier replies, delivery promises, or service outcomes.

Choose model identifiers during implementation based on measured quality, latency, and cost.
Record the models actually used in `hackathon.md`.
Do not assume that coding-agent access includes application API credits.

### Jev-first structured decisions

Jev is the intended primary fast decision model for suitable bounded decisions throughout the workflow, including decisions made during data collection.
Use it for source and tool selection, browser operation and target selection, page and message classification, candidate relevance, duplicate or variant-match proposals, and evidence checks.
It also prioritizes research paths, selects negotiation moves, routes uncertainty and recovery, and helps re-evaluate supplier options when facts change.
Evaluate independent questions against the same relevant state together when appropriate.
Use additional steps when a later decision depends on an earlier result rather than pretending those decisions are independent.
Break broad judgments into specific questions about fit, evidence, timing, and action consequences, then combine their results in code.

Provide observed options, relevant project constraints, and source-backed state.
Validate the returned choice against the permitted operation and current input version before execution.
Treat probabilities as model judgments, not proof of a fact, site suitability, or authority to act.
Use explicit task checks and representative examples to determine when a different model or collection method is needed.
Expand Jev's role as measured task results support it instead of limiting it to post-processing by default.
For consequential decisions, retain the model version, question version, relevant evidence references, returned choice and confidence, action taken, and observed outcome.
Record this trace in the authorized workspace without copying confidential inputs into the public build log.

### Division of work

Firecrawl, supplier APIs, and browser execution obtain data; Jev can decide how those tools are used.
OpenAI supplies generative text, commercial extraction, complex reasoning, and explanations where needed.
Ordinary code handles exact calculations, stable lookups, deterministic validation, authorization, and state transitions.
Reuse current authorized data directly instead of calling a model for a value already present.
Non-text documents and visual browser states need an appropriate parser or vision-capable route before text-only decision processing.
The final model versions, structured contracts, extraction formats, and fallback rules are implementation decisions, not assumed completed integrations.

## 34. Agent system

The user sees one assistant with named activities and accountable outputs.
Internally, separate planning, research, supplier communication, negotiation, risk assessment, recovery, and equipment-service workflows.

These responsibilities do not require separate autonomous processes or models.
Use the simplest maintainable workflow structure that supports progress, cancellation, review, and durable execution.

Each workflow records its trigger, scope, authorized actions, input versions, evidence, costs, and result.
Limits apply per job and per customer allowance.
Failures return actionable next steps instead of indefinite agent activity.

### Self-recovery during a job

Detect stale page state, invalid fields, provider errors, incomplete extraction, expired sessions, and repeated actions without useful progress.
Record the observed failure and choose a permitted recovery that addresses it rather than repeating the same failed attempt indefinitely.
Recovery can re-observe a page, correct an input format, retry a transient error, change an authorized source or tool, or use a different model.
Preserve verified results and resume the affected step without restarting unrelated work.
Continue independent research while another branch waits for a supplier or a necessary user action.

Jev can classify the obstacle and choose among defined recovery options, including waiting, switching an authorized provider, or escalating.
Prefer a recovery that addresses the observed failure and preserve the distinction between a chosen recovery and a verified result.
Code enforces the allowed actions, retry limits, elapsed-time limits, concurrency, and combined provider-spend cap.
Record which attempts made progress and why the method changed.
Recheck current authorization before any recovered action with external effects.
Cancellation or revoked authority prevents queued actions from taking effect.
An ambiguous send or submission result must be checked before another attempt can duplicate it.

A workflow is complete only when its observable completion conditions are satisfied.
A model's completion label or a clicked button is not sufficient evidence of a sent inquiry, received quote, or confirmed supplier commitment.
Show completed, partially completed, awaiting supplier, awaiting user, cancelled, and failed outcomes distinctly.
When automated recovery is exhausted, retain useful results and explain the exact remaining obstacle and next action.

### Boundaries of self-fixing

The hackathon requirement is recovery of the user's job, not unrestricted self-modification of the production application.
The agent cannot enlarge its permissions, spend beyond its allowance, change approved requirements, or alter billing policy to make a job succeed.
Repairing application code or a broken connector requires an isolated change and verification through the development workflow before deployment.
Do not make arbitrary runtime code generation a prerequisite for routine browser decisions.

### Development orchestration

Orca coordinates development workers and handoffs; it is not the runtime for customer purchasing jobs.
ADRs record shared decisions and constraints, while implementation packages define deliverables, interfaces, dependencies, allowed files, and acceptance checks.
Workers take ready implementation packages and follow every relevant ADR rather than treating each ADR as an independent coding task.
Shared contracts precede dependent parallel work, with integration and verification at each handoff.
The repository's `AGENTS.md` loads `skills/openingos-factory/SKILL.md` for the adapted isolate, build, prove, and ship workflow.
Authorized PR delivery retains an owner through current-commit CI checks and actionable reviews; a worker finishing its code is not proof that the integrated change passes.
The current repository workflow tests the CI inspection helper only, and does not constitute application CI or a persistent agent wake-up mechanism.
Greptile installation, repository access, and any paid usage require the user's authorization; a review score cannot replace tests or runtime evidence.

## 35. Human-in-the-loop requirements

Within its current authorization, the system can search, extract, compare, monitor, and prepare drafts.
It can send approved RFQs, permitted follow-ups, and nonbinding negotiation messages.
It can propose substitutions and equipment service options.

Users approve recipients and disclosure before outreach.
Batch these approvals where the same explicit job brief covers several actions.
Ask only for information or authority that materially changes the result and cannot be obtained responsibly from existing records or a permitted supplier inquiry.
Routine tool selection and recovery within an approved scope do not require the user to manage each step.
An authorized approver selects the supplier and exact offer version.
Users record orders, payments, and binding service bookings completed outside the initial product.

Changing product, quantity, cost scope, recipient, required date, or mandate limits invalidates an affected pending approval.
Concurrent edits cannot cause an older approval to authorize a newer offer.

The initial product never accepts an offer, places an order, pays, accepts financing, or signs a contract autonomously.
A confirmation button must not imply an external transaction that the product does not perform.

### Task-level permissions and consequential actions

Each job operates under a bounded grant covering permitted records, tools, recipients, disclosures, actions, allowance, and expiry.
Jev can choose or recommend the narrowest permissions needed for a step within that grant.
Application code enforces the grant and rejects requests outside it.
Completion, cancellation, expiry, or revocation prevents further job actions without erasing the evidence or the user's own access to the project.

Classify tool operations by their actual effects, including external communication, sensitive disclosure, financial commitment, deletion, and permission changes.
Use those known effects as the minimum review requirement, with Jev checking contextual risks in supplier replies and generated messages.
Payment requests, acceptance language, and disclosure outside the approved brief require particular scrutiny.
A model judgment cannot downgrade an operation's required review or grant itself broader access.
Unknown operations stop for review, and queued actions recheck current authority immediately before execution.
Temporary job authority does not require permanent provider credentials or broad customer-account access to be exposed to the model.

Product capability, project permission, and current job authority are separate checks; all must pass before a tool action executes.
Enforce them at the backend boundary as well as in the conversational interface, including direct API calls and queued retries.
Do not expose raw model, browser, email, or code-execution access as a way around supported product workflows.
User wording, retrieved pages, attachments, and supplier replies cannot enable new capabilities or redefine these checks.
Treat instructions inside external evidence as data to evaluate, not as application authority.
An approval or a recovery attempt cannot expand the product's capabilities; a new capability requires a reviewed implementation and verification through the development workflow.

## 36. User trust requirements

Every material recommendation explains its reason, source, freshness, uncertainty, and tradeoffs.
Users can inspect and correct the evidence without losing the original record.

Show what the system has done, what it is waiting for, and what it needs permission to do.
Expose a cancellation or pause action for ongoing external work.
Show the job's allowance, usage so far, and any change requiring approval before additional spending.
Include retries and recovery in accounting rather than hiding them from the user.
Keep budget ceilings and other confidential negotiation context out of supplier-visible messages.

### Provider-spend controls

Keep the equipment purchasing budget separate from the allowance for models, crawling, browsing, and communication.
Before another paid operation, check its permitted cost bound against the job's remaining allowance.
Concurrent branches, retries, provider changes, and speculative research share that allowance rather than each receiving the full amount.
Account for authorized work already in flight when deciding whether another operation can start.
If the next operation cannot fit a supported cost bound, pause the affected work and request an allowance change instead of assuming it is free.
Jev can recommend which remaining work is valuable, but code enforces the spending limit.
These controls cover internal provider usage and do not introduce customer billing, autonomous purchases, or a new pricing plan.

### Data and demonstration integrity

Customer records and communication are private by default.
Guest evaluation sessions cannot access real customer records or send unrestricted supplier email.
Exports and account closure have a defined data-retention policy before paid launch.

Any demonstrated supplier response or stock change that is controlled for testing is labeled as such.
Never present a test mailbox reply or simulated stock event as an independent commercial outcome.

## 37. MVP scope

The first usable product supports cafés in one selected supplier market.
It must serve a complete purchasing decision and preserve its outcome for subsequent work.

### Initial categories

1. Espresso machines.
2. Grinders.
3. Refrigeration.
4. Water treatment and required related accessories.
5. Chairs.
6. Tables.

Site utilities and installation prerequisites are modeled even when the product does not procure the associated contractor work.

### Opening and purchasing capabilities

- Progressive project onboarding and approved requirements.
- Source-backed research and a usable shortlist.
- Quote upload, product-link entry, and a supported equipment-list import.
- RFQs, inbound replies, commercial extraction, and corrections.
- Comparable costs with explicit missing terms.
- A limited, explicitly authorized negotiation workflow.
- Versioned selections and approvals.
- Deterministic budget and procurement-readiness views.
- User-recorded orders, delivery, installation, and commissioning.
- Stock or delay monitoring and a complete substitution workflow.

### Repeat-use capabilities

- An organization workspace covering several projects and locations.
- A decisions inbox across projects the user can access.
- Basic contributor and approver roles with project access boundaries.
- Equipment handover with purchase, warranty, and manual evidence.
- A service or replacement case using that equipment history.
- Basic reuse of an earlier project's requirements and decisions, with current facts revalidated.

These capabilities are part of the revised initial product, not merely future retention promises.
Implementation can proceed through smaller verified steps, but an early demonstration does not establish completion of this scope.
Section 52 distinguishes demonstrated hackathon behavior from the full initial product acceptance.

## 38. MVP non-goals

The initial product excludes payments, autonomous purchasing, accounting, tax calculation, financing, full construction management, contractor scheduling, permits, logistics brokerage, and inventory ERP.
It also excludes a vendor marketplace, mandatory supplier portals, comprehensive CAD reasoning, and every possible business vertical.

The service workflow coordinates inquiries, quotes, and outcomes.
It does not promise emergency dispatch, a managed repair workforce, predictive failure detection, or autonomous service booking.

Recurring consumables procurement and enterprise approval hierarchies are future work.
Public deployment for judging does not imply these capabilities are present.

## 39. Hackathon demo script

Target a recording of approximately 2 minutes 40 seconds and keep the final video under three minutes.
Use a working deployed product and identify any controlled test inputs.
The following amounts illustrate expected arithmetic and are not claimed supplier offers.

### Scene 1: the purchasing problem, 0:00–0:20

Open a café project with an equipment budget, required date, and a recorded counter or utility constraint.
Show the decision that needs attention.

### Scene 2: research and compatibility, 0:20–0:45

Show candidates collected through Firecrawl with source links and capture times.
Show the vendor dashboard and identify Jev's actual collection or classification work.
Include an observed interactive supplier step performed through the deployed browser integration.
Reject one unsuitable candidate using an observable compatibility constraint.
Keep unknown installation or service information visible.

### Scene 3: supplier communication, 0:45–1:15

Approve an RFQ to a controlled demonstration supplier inbox.
Show a real AgentMail round trip and the reply becoming a structured quote through OpenAI and Convex.
Use a controlled reply with a missing commercial term to show Jev selecting a covered clarification or negotiation move without another approval prompt.
Show the revised terms when a follow-up reply exists, or an honest awaiting-supplier state when it does not.
If the reply was received before recording, identify it as a recorded test exchange.
Do not imply that a real supplier answered within the compressed demonstration time.

### Scene 4: compare and approve, 1:15–1:40

Compare €7,950 with delivery and installation explicitly included against €7,500 plus €600 freight and €400 installation.
Use the same tax basis and equivalent quantities.
Show the supported €550 difference.
Approve a selection and show selected forecast changing while committed expenditure remains unchanged.
Call the result a quote comparison rather than a negotiated saving unless an actual negotiation produced the change.

### Scene 5: recover from a disruption, 1:40–2:15

Show an actual recorded supplier delay or a clearly labeled controlled availability event.
Explain its effect on a critical requirement and dependent work.
Find compatible substitutes and ask the user to approve a replacement.
Keep order-specific evidence separate from a public listing's stock state.
Show a labeled recoverable execution failure, the agent changing method or re-observing, and a verified result without duplicate outreach.
Distinguish workflow recovery from the separate decision to approve a purchasing substitute.

### Scene 6: demonstrate continuing value, 2:15–2:40

Open an equipment record with purchase and warranty evidence.
Start a service or replacement case, or reuse the requirements for a second location and show which facts need revalidation.
Finish with resolved decisions, remaining risks, and supported financial figures.
Do not hardcode a readiness increase or a savings total for presentation.
Keep longer provider waits and test traces inspectable outside the short video rather than presenting edited timing as live task speed.

## 40. Success metrics

### Activation and time to value

Track users who create or import a real purchasing need, confirm its constraints, and reach a useful comparison or next action.
The target for a first source-backed shortlist is under two minutes on the chosen initial market and category benchmark.
This is a target to measure, not a guarantee across inaccessible suppliers.

### Hackathon execution quality

Measure complete-job success, time to first useful result, end-to-end elapsed time, user interventions, provider cost, and automatic recovery outcomes on declared representative tasks.
Separate cached answers from fresh collection, model decision latency from total job time, and controlled fault tests from live supplier-site behavior.
Include failed runs and retries rather than reporting successful demonstrations alone.
Check decision correctness and evidence quality alongside speed, including unsupported matches, missed critical terms, and false completion claims.
Use matched tasks and equivalent completion conditions when comparing Jev-guided execution with another route.
Report the measured result without turning an upstream browser demo into an OpeningOS performance claim.
For research prioritization, measure retained suitable options and mistaken deferrals alongside avoided work on a labeled comparison set.
For uncertainty routing, measure unnecessary interruptions and missed required reviews, not confidence values alone.
For negotiation, check mandate compliance and evidence-backed changes to comparable offers rather than the number of messages sent.
Separate recovery-decision latency from the time needed to execute the recovery and verify completion.

### Quote quality and conversion

Measure the share of delivered RFQs that produce usable replies within a declared observation window.
Record missing terms, extraction corrections, unsupported documents, bounces, and time to a comparable offer.

### Decision outcomes

Track approved decisions, recorded order outcomes, and critical requirements ready by their need-by dates.
Count resolved risks only when evidence supports the resolution.

### Savings and effort

Separate advertised-to-quoted differences, negotiation changes, alternative-offer differences, and realized acquisition savings.
Use comparable scope and disclose the baseline.
Do not add overlapping savings measures.
Measure time saved through observed work or explicit user estimates and label which method was used.

### Repeat use and economics

Track a second substantive purchasing or service decision, another project, or a return to an equipment case.
Measure professional and one-project customer cohorts separately.
Measure paid conversion, renewal, completed-project satisfaction, and provider cost per resolved decision.
A user opening the dashboard without completing meaningful work is not evidence of retention value.

## 41. North star metric

The primary outcome is **critical purchasing or equipment decisions resolved by their need-by date**.
Resolution must satisfy the decision's acceptance conditions and preserve its supporting evidence.

Track confirmed procurement spend associated with completed decisions as a secondary measure.
Do not optimize for higher expenditure or count an unplaced selection as a purchase.

For professional customers, evaluate outcomes across their portfolio.
For individual openings, evaluate project completion and customer value even when active usage subsequently ends.

## 42. Monetization

Pricing remains a hypothesis until tested with prospective paying customers.
No checkout or billing implementation is required for the hackathon.

### Individual project

Retain the original test range of $49–$199 per project.
Define the active-work period and included research, outreach, and monitoring allowance before offering it.
Customers retain access to their decision and equipment records under the stated retention policy.

### Professional subscription

Retain the original test range of $99–$299 per month for a workspace.
Test packages around concurrent projects, locations, seats, decision volume, and included external work.
Additional usage must be visible and require acceptance before it incurs charges beyond the purchased allowance.

### Larger operators

Consider negotiated pricing when portfolio scale, support, access controls, or integration needs justify it.
Do not promise enterprise functionality before it exists.

Unlimited supplier outreach is not an initial promise.
Measure model, crawl, inbox, infrastructure, and support costs per useful outcome.
Paid supplier placement or commissions must not silently influence recommendations.

## 43. Long-term retention strategy

Recurring value starts in the initial product through professional portfolios, equipment records, and service or replacement work.
Opening completion creates useful operating records rather than an empty dashboard.

The continuing workflow is:

1. Preserve what was bought, its requirements, warranty, supplier, and actual cost.
2. Record an equipment issue, upcoming documented service need, or another purchasing decision.
3. Use that history to collect appropriate service or replacement options.
4. Obtain human approval and record the observed outcome.
5. Reuse the resulting evidence for another location or future decision.

Reminders can help trigger this workflow but are not the main paid value.
Intervals and recall notices require documented sources or user configuration.
The system must not invent maintenance schedules or predict failures without validated evidence.

Recurring consumable purchases, broader maintenance coordination, and deeper operating integrations remain later extensions.

## 44. Data moat

The product accumulates evidence about supplier response, promised and actual timing, commercial terms, equipment service, substitutions, and purchase outcomes.
Historical recommendations remain explainable through their input evidence.

Retain the sample size, period, geography, and category behind a performance claim.
Do not label a supplier unreliable because of one unanswered RFQ or an unconfirmed delay.
Distinguish user-reported outcomes from externally confirmed events.

Private customer quotes, identity, contacts, and negotiation ceilings remain within their permitted workspace.
Cross-customer benchmarking is future work requiring a defined permission and aggregation policy.
Accumulating private records alone does not authorize sharing them or training a model on them.

## 45. Future feature: clone a location

Basic requirement reuse is promoted into the initial product.
Copy approved specifications, quantities, dependency structure, and links to source decisions into a new draft project.
Adjust quantities and constraints explicitly for the new location.

Recheck current prices, availability, service coverage, geography, site constraints, and commercial validity.
Historical orders, payments, approvals, and delivered states remain attached to the original location.
They must not become current commitments at the new location.

Advanced brand standards, portfolio purchasing, and automated reusable-percentage claims remain future work.
Any reuse percentage needs a defined denominator and evidence of what was revalidated.

## 46. Future feature: project templates

The initial product provides a reviewed café starting template and organization-owned templates derived from completed work.
Requirements remain editable and explicitly approved.
Templates record their source, version, market, and assumptions.

Restaurant, salon, studio, and office templates are future vertical expansion.
A template must not present a complete regulatory or construction checklist unless that capability has been separately established.

## 47. Future feature: team collaboration

Basic collaboration is promoted into the initial product because professional buyers need client decisions and access boundaries.

| Role | Initial authority |
| --- | --- |
| Viewer | Read explicitly accessible projects and evidence |
| Contributor | Research, draft requirements, propose candidates, and prepare communication |
| Approver | Approve decisions and outbound authority within assigned projects and limits |
| Admin | Manage organization membership, project access, and workflow configuration |

A user can hold several roles, but membership alone does not grant access to every client project.
Changing membership or authority takes effect before the next protected action.
Account administration does not silently override an existing financial or communication mandate.

Advanced approval chains, enterprise identity, and cross-organization client portals remain future work.

## 48. Future feature: vendor portal

Suppliers can participate by email without registration.
An optional future portal can provide structured quotes, document uploads, or order updates.

Portal activity must preserve supplier identity, versioned terms, and project access boundaries.
The portal is not a dependency for the initial supplier workflow.

## 49. Key risks

| Risk | Required response |
| --- | --- |
| Incomplete or invented requirements | Show assumptions, keep suggestions reviewable, and require approval |
| Incorrect or stale supplier data | Preserve provenance, freshness, unknowns, and contradictions |
| Incompatible equipment | Apply explicit rules and require confirmation for unresolved critical site constraints |
| Incorrect comparisons | Preserve missing charges, quantity, currency, tax basis, and scope differences |
| Unauthorized communication | Bind sends to current recipient approval and a bounded mandate |
| Repeated provider events | Deduplicate before creating messages, quotes, commitments, or asset records |
| Slow supplier response | Make existing-quote comparison useful and provide bounded follow-up and manual progress |
| Private customer data exposure | Enforce organization and project access on every protected operation |
| Provider cost growth | Apply budgets, caching, cadence controls, cancellation, and transparent usage |
| Repeated recovery without progress | Detect loops, preserve checkpoints, change the permitted strategy, and enforce combined job limits |
| False completion or duplicated external action | Verify observable outcomes and reconcile ambiguous submissions before retrying |
| Browser-session leakage or excessive authority | Isolate supplier sessions, protect credentials and recordings, and recheck action scope |
| Research pruning hides a suitable supplier | Keep deferred candidates visible, test missed suitable options, and reconsider them when evidence changes |
| Confident model decision exceeds authority | Enforce known action effects, current job grants, and spending limits independently of model confidence |
| Weak retention | Test professional repeat decisions and actual service cases with paying users |
| Excessive initial coverage | Validate one supplier market and the declared categories before expansion |
| Existing competitors | Prove better compatibility, supplier coordination, or recovery outcomes for the chosen buyer |
| Unrealistic demonstration | Label controlled inputs and distinguish test exchanges from commercial results |

### Customer validation

Recruit five prospective professional users with current equipment decisions.
Ask them to use their own quotes or requirements and observe where the product helps or fails.
Measure whether they return with another substantive decision and accept a paid offer.
This is a validation plan, not a claim that those users have been recruited or that demand is established.

## 50. Product positioning

OpeningOS is an AI purchasing and equipment coordinator for cafés and the professionals who open and operate them.

The opening workflow remains the clearest initial story:

> Tell OpeningOS what you are opening.
> It helps determine the equipment requirements, gets comparable supplier offers, and tracks the purchasing decisions that threaten your schedule or budget.

The continuing-value story is:

> Keep the equipment history, resolve service and replacement needs, and reuse what worked at the next location.

Avoid claiming to replace an architect, contractor, regulator, accountant, or qualified installation professional.
Differentiate through demonstrated café constraints, supplier follow-through, and recovery outcomes.

## 51. Product thesis

Physical-business procurement is a connected decision problem that is often managed as separate searches, spreadsheets, and conversations.
OpeningOS preserves those connections and turns changes into specific decisions with evidence.

A useful daily workspace answers:

- What needs my decision?
- What changed and why does it matter?
- Which supplier is waiting for us, or needs a follow-up?
- What is estimated, selected, committed, and paid?
- Which equipment prerequisites are unresolved?
- What service or replacement problem needs attention?
- What can I safely reuse from another location?

The business succeeds when customers pay to resolve these recurring problems or to complete a valuable individual project.
Activity, generated plans, and accumulated records are not substitutes for those outcomes.

## 52. Acceptance criteria and hackathon delivery

Requirement identifiers below are stable.
Future revisions must not reuse an identifier for a different meaning.
No criterion is marked passed by this document.
Evidence must distinguish automated tests, controlled provider exchanges, deployed behavior, and real customer outcomes.

### Initial product acceptance

| ID | Required observable result |
| --- | --- |
| P-01 | A user creates an opening, quote-comparison task, or equipment case without completing irrelevant onboarding fields |
| P-02 | A user approves or edits generated requirements, assumptions, quantities, and dependencies before they govern purchasing |
| P-03 | Research produces usable candidates with source links, timestamps, exact variants, and visible missing information |
| P-04 | Compatibility tests distinguish pass, fail, and unknown, including unit conversion and a changed dependent constraint |
| P-05 | A user-approved RFQ completes a real provider send and inbound-reply flow that updates the correct project |
| P-06 | A revised or multi-item quote preserves versions, shared charges, source evidence, and user corrections |
| P-07 | A comparison refuses to treat missing installation or freight as zero and correctly calculates an equivalent complete offer |
| P-08 | Selection, order commitment, payment, partial quantities, and adjustment scenarios produce distinct, nonduplicated financial totals |
| P-09 | A late P2 item is not automatically a blocker, while a dependent P0 requirement reflects its full ready-for-use timing |
| P-10 | Procurement readiness remains incomplete until accepted quantities and required commissioning prerequisites are satisfied |
| P-11 | A failed stock check becomes unknown, and a public stockout alone does not mark a placed order delayed |
| P-12 | A disruption produces explained substitutes and a fresh approval without deleting the original order history |
| P-13 | Revocation, a reply, or changed offer terms prevent an obsolete queued communication or approval from taking effect |
| P-14 | Duplicate callbacks and retried jobs do not duplicate outgoing messages, financial commitments, or equipment records |
| P-15 | Two organizations and restricted client projects cannot read or modify each other's records through direct function calls |
| P-16 | A private user's quotes and financial limits are inaccessible from a guest evaluation session |
| P-17 | Provider errors, exhausted allowances, cancellation, and reconnection preserve completed work and expose a recovery action |
| P-18 | A commissioned equipment record retains purchase and warranty evidence and supports a service or replacement case through a recorded outcome |
| P-19 | A second-location draft reuses specifications while requiring current facts to be checked and creating no historical order or payment copies |
| P-20 | A professional user can manage due decisions across permitted projects, with contributor and approver authority enforced |
| P-21 | Key workflows are usable by keyboard and on a narrow viewport, with loading, empty, error, and success states checked |
| P-22 | Usage and outcome records support the metrics in sections 40–42 without claiming unmeasured savings or revenue |
| P-23 | Negotiation respects the current mandate, disclosure restrictions, round limit, and termination conditions without accepting an offer or creating a commitment |
| P-24 | Supported equipment imports and quote attachments preserve source records, identify invalid or unreadable inputs, and require review before extracted data becomes approved |

### Hackathon delivery acceptance

The selected frontend host is **ChatGPT Sites**, recorded as `Frontend: Codex Sites` in `hackathon.md`.
The required submission URL is a confirmed public `chatgpt.site` address.

| ID | Required evidence |
| --- | --- |
| H-01 | Participant or team confirms registration and eligibility, including the four-person team limit |
| H-02 | The application is original and began within the event's permitted new-app period |
| H-03 | Convex persists actual application state and demonstrates queries, mutations, and realtime updates |
| H-04 | OpenAI, Firecrawl, and AgentMail each perform observable work in the deployed product |
| H-05 | The public GitHub repository contains the delivered source and a factual root `hackathon.md` without secrets or private customer records |
| H-06 | A fresh unauthenticated visitor can open the confirmed `chatgpt.site` URL and evaluate meaningful functionality without an invitation |
| H-07 | The published frontend demonstrates a Convex read, write, and reactive update against the intended hosted deployment |
| H-08 | A video under three minutes demonstrates the actual product and labels controlled test inputs accurately |
| H-09 | An X or LinkedIn announcement tags Convex, OpenAI, Firecrawl, and AgentMail |
| H-10 | The exact event submission receives the repository, live URL, video, and all additional required form fields before the deadline |
| H-11 | The build log identifies implemented behavior, stack, live URL, and demo link and is updated after meaningful progress |

H-06 requires public evaluation access, not public access to real customer work.
Use an isolated guest session with restricted outbound recipients and bounded provider usage.
Authentication remains necessary for private customer projects even though the event does not mandate a particular auth system.

### Project-specific hackathon behavior

The following are OpeningOS delivery commitments for this hackathon, not extra requirements imposed by the organizers.
They complement the demonstrated purchasing journey and do not replace or renumber P-01 through P-24 or H-01 through H-11.

| ID | Required observable result |
| --- | --- |
| D-01 | The vendor dashboard exposes discovered alternatives, source-backed comparison fields, coverage, and freshness while preserving user selection |
| D-02 | A question about selected vendors uses the current authorized records and sources without asking the user to repeat known context; changed evidence invalidates affected cached answers |
| D-03 | Jev performs observable useful decisions during collection or browser execution and classification or evidence checking, with model, input version, latency, and outcome recorded |
| D-04 | A deployed product job performs a real interactive browser step without a customer-installed plugin, developer Chrome session, or customer-provided provider key |
| D-05 | A controlled recoverable failure triggers a suitable strategy change or refreshed observation, resumes saved work, and satisfies an independent result check without duplicating external effects |
| D-06 | Non-progress, cancellation, revocation, exhausted provider allowance, and an unrecoverable failure produce bounded, truthful job states while retaining completed results |
| D-07 | A scoped communication brief permits covered RFQs and clarification without repeated approval prompts, while a new recipient or material disclosure outside that brief requires review |
| D-08 | Applicable delivery scope, service responsibility, return costs, and receiving requirements remain inspectable or explicitly unknown rather than being hidden by a headline price |
| D-09 | Browser sessions and private evidence remain isolated between users and from guest evaluation, including a protected handoff when user participation is genuinely required |
| D-10 | Representative runs record completion quality, total elapsed time, interventions, cost, and recovery; reported performance distinguishes cached, controlled, and live external work |
| D-11 | Jev prioritizes deeper research on a labeled candidate set while a suitable supplier with an unpublished price remains inspectable and eligible for inquiry; changed evidence or a user request can resume a deferred path |
| D-12 | Given an incomplete supplier offer and a current mandate, Jev selects a permitted clarification or negotiation move, AgentMail sends the checked OpenAI draft, and the record shows a versioned reply or an honest waiting state without accepting terms or leaking restricted context |
| D-13 | Supplier-resolvable uncertainty triggers a permitted evidence check without a user question, while a decision-critical missing site fact or new authority produces one focused review; independent research continues |
| D-14 | Expiry, revocation, an out-of-scope recipient, or an unknown tool operation blocks execution even when Jev is confident; covered actions under a valid grant do not require repeated approval |
| D-15 | A changed delivery or commercial term triggers evidence-backed re-evaluation of affected alternatives without overwriting the user's selection or order history, and the dashboard shows the reason for the changed recommendation |
| D-16 | Concurrent research branches and retries cannot each spend the full shared allowance; a new paid operation pauses when its supported cost bound does not fit after accounting for work already in flight |
| D-17 | Unrelated and unavailable requests do not launch unsupported research, browser, communication, or execution jobs; supported contextual and separable mixed-request work remains usable, direct backend bypasses are rejected, and instructions inside supplier evidence cannot expand product capabilities |

Demonstrate the dashboard, contextual question, supplier round trip, interactive browser work, and recovery in the same coherent purchasing workflow.
Keep additional acceptance evidence accessible even when it cannot fit into the video.
Do not substitute a local-only Ultrafast recording for D-04 or treat one passing recovery example as proof that every website can be repaired.

Hackathon completion requires the delivered demonstration journey to work end to end.
It does not establish that every initial product criterion has passed.
Record any unimplemented product criteria explicitly rather than reducing their meaning to match the demonstration.

### Build-log maintenance

The official event page instructs participants to update `hackathon.md` after each work session and says judges read it.
Maintain one concise evidence-based summary for meaningful progress, not a transcript of every conversation, tool call, or edit.
Use the hackathon skill to summarize actual changed files, integration checks, tests, deployment evidence, and unresolved blockers.
Keep planning, implemented behavior, controlled tests, and independently observed outcomes distinct.
A no-change session needs no duplicate entry or timestamp-only update.
Before submission, verify that the log describes the delivered stack and includes the confirmed live URL and demo link.

### Technical decisions still required before implementation

ChatGPT Sites, Convex, useful Jev-led decisions, and genuine OpenAI, Firecrawl, and AgentMail product work are established directions.
The decisions below determine how to implement them and must not be silently invented by independent workers.

| Decision area | What must be settled |
| --- | --- |
| Browser runtime and access | Where Jev-guided browser execution runs for deployed jobs, how it is called from Convex, isolated profile ownership, supported controls, protected handoff, and the alternate route for unsupported pages |
| Durable execution and recovery | Convex workflow or queue mechanism, job and attempt states, checkpoint boundaries, event deduplication, ambiguous-write reconciliation, cancellation, concurrency, time limits, and shared cost accounting for work already in flight |
| Data and module contracts | Canonical product and variant identity, quote and evidence versioning, browser result schema, model-decision and negotiation-move contracts, deferral reasons, event ownership, and interfaces shared by workers |
| Identity and judge access | Authentication provider, organization and project permissions, isolated guest identity, demonstration mail routing, and guest/provider abuse limits |
| Task authority and action effects | Enabled capability catalog, scope classification and false-rejection handling, backend enforcement, job-grant scope, expiry and revocation, known tool effects, checks for commitments in generated messages, permitted cost bounds, and checks immediately before external execution |
| Models and document handling | Jev and OpenAI versions, structured questions and extraction contracts, supported PDF or image processing, decision-specific thresholds, research prioritization, independent-question batching, and escalation rules |
| Verification and environments | Representative supplier sites and task fixtures, independent outcome checks, missed-candidate tests, negotiation and review-routing cases, recovery faults, concurrent-spend checks, latency and cost targets, and isolated worker/test mailboxes and backend data |

Resolve these through ADRs and explicit contracts before their dependent implementation packages run in parallel.
This PRD revision does not select a mobile framework, implement billing, finalize paid-launch pricing, or create those ADRs.

### External dependencies and unresolved choices

- Select and validate the hackathon supplier region, currency, and representative sites without treating that choice as a finalized commercial launch market.
- Confirm Luma registration and eligibility through the participant.
- Confirm available Firecrawl credits and usable OpenAI and AgentMail application access without exposing credentials.
- Verify usable Jev API access and a deployable browser execution route, including any separate provider allowance or access requirement.
- Confirm actual outreach recipients and job-spend authority before enabling external customer actions; guest evaluation remains restricted.
- Verify activation of the installed Convex plugin after the required restart.
- Provision and verify the intended hosted Convex backend during the authorized build and publication workflow.
- Sign in to Vibe Apps before the final submission.
- Obtain real supplier and customer evidence separately from controlled demonstration exchanges.

The submission deadline is September 22, 2026, at 12:00 PM Pacific.
That is September 23, 2026, at 12:30 AM India Standard Time.
Eligible applications must have started on or after August 25, 2026, at 12:00 PM Pacific.
Participants must meet the published age, affiliation, and jurisdiction eligibility conditions.
Participant Firecrawl credits require registration.
The event does not provide OpenAI API or Convex credits during the build.
Convex Auth and the paid Convex AI Gateway are optional choices rather than mandatory dependencies.

### Official references

- [Hackathon requirements and judging](https://www.convex.dev/hackathons/all-gas)
- [Registration, team limits, and participant information](https://luma.com/convex-allgas-hackathon)
- [Exact hackathon submission form](https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit)
- [Convex agent setup](https://www.convex.dev/agent-setup.md)
- [Hackathon build-log skill](https://github.com/get-convex/convex-hackathon-skill)
- [ChatGPT Sites documentation](https://learn.chatgpt.com/docs/sites)
- [ChatGPT Sites with Convex skill](https://github.com/get-convex/Codex-Sites-Convex-Backend-Skill)
- [Official Firecrawl component](https://www.convex.dev/components/firecrawl/firecrawl-convex)
- [Official AgentMail component](https://www.convex.dev/components/agentmail/convex)

### Technical references for the agreed direction

- [Jev typed-decision interface](https://docs.typesafe.ai/introduction)
- [Jev model capabilities](https://docs.typesafe.ai/models)
- [Jev parallel-question pattern](https://docs.typesafe.ai/patterns/fan-out)
- [Jev confidence and risk-dependent routing](https://docs.typesafe.ai/confidence)
- [Open-source Browser Use Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)
- [Ultrafast measurements and capability boundaries](https://github.com/browser-use/jev-ultrafast/blob/main/docs/performance.md)
- [Browser Use hosted browser capabilities](https://browser-use.com/enterprise)

The open-source Ultrafast project is a concrete implementation reference, not proof of a completed OpeningOS integration.
Its hosted Ultrafast offering is listed with a waitlist at this revision, so the browser-runtime ADR must verify an execution route we can actually use.

### Product-pattern reference

Revision 4 applies relevant ideas from [Greg Isenberg's Jev product concepts](https://x.com/gregisenberg/status/2101284640828915995) to the purchasing workflow.
The adopted ideas cover recovery, negotiation, research prioritization, uncertainty routing, supplier re-evaluation, task permissions, consequential-action checks, and spending limits.
The post proposes use cases rather than providing OpeningOS benchmarks or evidence that one person can supervise a particular number of workflows.
Autonomous refund processing and production incident control do not become hackathon requirements through this reference.

Requirements above reflect the official sources checked on September 19, 2026.
Recheck the event and provider instructions before implementation choices or final submission when their current behavior matters.

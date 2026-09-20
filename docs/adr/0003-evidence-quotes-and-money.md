# ADR-0003: Evidence, quote versions and money

Status: Accepted for controlled contract implementation; application persistence and full product evidence pending.
Requirements: P-02, P-03, P-04, P-06, P-07, P-08, P-09, P-10, P-18, P-24, D-02, D-08, D-15.

## September 20, 2026 evidence amendment

The money and quote-snapshot contract is accepted as the F1 implementation basis.
Checkpoint `595d30c` passed 77 controlled money/Jev tests with 305 assertions and separate Astra review.
The money cases covered complete-offer comparison, unknown charges, included-charge chains, shared charges, partial quantities, deposits, credits/refunds, immutable inputs, obsolete selections and exact allocation/rounding checks.
This accepts P-07 and P-08 only under controlled evidence and partially supports P-06.
It does not prove persisted application records, source collection, quote ingestion, compatibility, equipment history or a live vendor outcome.

## Decision

Store immutable evidence and quote revisions alongside mutable current views.
Do not event-source the entire application or overwrite a supplier's old terms.
Keep manufacturer, model, variant, seller, discovered listing and supplier quote distinct.
One vendor can offer several variants and one exact variant can have many vendors.

Usage starts with domain commands, not editing arbitrary rows:

```text
captureEvidence(source, capturedAt, contentHash, claims)
recordQuoteRevision(conversation, sourceEvidence, parsedTerms)
compareOffers(requirementVersion, exactQuoteVersionIds)
selectOffer(requirementVersion, quoteVersionId, quantity, requestId)
recordExternalOrder(selectionId, evidence, orderedQuantities, requestId)
```

All commands derive organization/project access from trusted identity.
Foreign references must belong to the same authorized project or an explicitly permitted organization record.

## Canonical contracts

| Value | Required meaning |
| --- | --- |
| Money | Integer minor units plus ISO currency, never a floating-point display string |
| Quantity | Validated decimal quantity and unit; preserve source value and conversion |
| Charge | `known`, `included`, `estimated`, `unknown`, or `notApplicable` |
| Included charge | Reference to the covering line or scope, so it is not counted twice |
| Evidence claim | Source ID, captured time, locator or excerpt, original value, normalized value, source kind, verification state |
| Quote version | Immutable line items, quantities, charges, tax basis, validity, exclusions and evidence references |
| Compatibility finding | `pass`, `fail`, or `unknown`, with exact requirement/variant/evidence versions and rule version |
| Selection | Exact quote version, selected quantity, actor and requirement version |
| Financial adjustment | Kind, amount, affected order line/quantity, evidence, idempotency key and linked adjustment when relevant |

A quote-level shared freight charge stays quote-level unless an explicit allocation rule is recorded.
An unknown charge never becomes zero, and conditional compatibility never becomes a pass.
Unknown lead-time start conditions produce an incomplete schedule rather than an invented date.
Partial deliveries account for accepted quantities separately from ordered quantities.

## Storage and calculations

Use ordinary Convex records and indexes for the logical concepts in PRD section 30.
Group provider-specific messages in their official component storage when suitable; keep product references and evidence links locally.
Append material project events for audit and change explanations, not as the only way to reconstruct every screen.
Keep original documents in protected storage and user corrections as overlays with actor and reason.
Evidence completeness records transport truncation, missing bytes and unstored pages separately from claim verification.
Preserve the approved outbound payload, provider receipts and decision-linked source snapshots under the [sponsor contracts](../integrations/sponsor-contracts.md#evidence-lifetime).
Provider component cleanup must not erase purchasing history.

### Hackathon counterparty provenance

The owner plays the supplier through real email; live transport does not make their terms a real vendor quote.
Record execution evidence separately from counterparty provenance as specified in the [sponsor contracts](../integrations/sponsor-contracts.md#hackathon-owner-only-communication).
Each owner-authored quote version retains `counterpartyRole: ownerStandIn` and its source message evidence.
An optional researched-vendor reference supplies scenario context only, not authorship or commercial endorsement.
Comparison, selection, assistant answers and exports preserve the controlled-demo label.
Owner-authored terms must not overwrite researched vendor prices, public availability or genuine supplier performance records.
An owner counteroffer can prove a demo negotiation improvement but cannot establish realized savings or a binding vendor commitment.

### Financial state

Selection changes only selected forecast.
User-recorded external orders change commitments, payments change paid amounts, and commissioning creates installed equipment provenance.
Projected completion cost counts each quantity once: ordered quantities at current order cost, remaining quantities at selected cost or estimate.
Credits reduce obligations; refunds reduce applied payments.
Never subtract a linked credit and refund twice.

Comparison and assistant caches depend on the exact requirement, quote, source and calculation versions.
A new quote updates the comparison but does not silently replace a selection or order.
Changed inputs invalidate dependent findings, cached answers and pending approvals.

## Alternatives and acceptance

Mutable quote rows lose approval history.
Full event sourcing adds replay machinery without a demonstrated need.
Use immutable versions plus current projections and a material-event log.

Before acceptance, pass tests for €7,950 versus €8,500, missing installation, shared freight across items, mixed tax bases, partial quantities, a €2,000 deposit, a €500 credit/refund pair and concurrent selection against an obsolete quote.
Keep all 52 PRD requirement meanings unchanged.

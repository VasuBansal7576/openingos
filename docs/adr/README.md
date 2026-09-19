# OpeningOS architecture decisions

Drafted September 19, 2026; integration contracts clarified against PRD revision 8.
These documents specify implementation choices, not completed capabilities.
The user accepted the purchasing workbench and the existing hackathon platform direction.
Other recommendations remain proposed until reviewed and their blocking experiments pass.
Do not let workers silently turn a proposal into an accepted contract.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-purchasing-workbench.md) | Purchasing workbench and standalone design reference | Accepted |
| [0002](0002-platform-and-ownership.md) | Sites frontend, Convex authority, no second application backend | Accepted constraints, deployment proof pending |
| [0003](0003-evidence-quotes-and-money.md) | Evidence, quote versions, compatibility and financial records | Proposed |
| [0004](0004-durable-jobs-and-provider-effects.md) | Durable jobs, bounded recovery, communication and shared spend | Proposed |
| [0005](0005-jev-and-openai.md) | Jev-first typed decisions, OpenAI extraction and generation | Proposed |
| [0006](0006-remote-browser-execution.md) | Isolated hosted browser execution under Convex authority | Proposed, execution route unproven |
| [0007](0007-identity-capabilities-and-approval.md) | Guest identity, private access, capabilities and approvals | Proposed |
| [0008](0008-verification-and-worker-handoffs.md) | Environments, evidence, CI and Orca implementation packages | Proposed |

## What needs settling

1. Prove published Sites can read, write and subscribe to the intended hosted Convex deployment.
2. Prove a hosted Jev-guided browser operation with two isolated sessions, cancellation and an independent result check.
3. Approve the proposed identity choice and prove guest/private isolation on the published origin.
4. Confirm the hackathon research country, currency and representative supplier sites.
5. Confirm application API access, permitted test recipients and a total provider allowance through secure configuration.
6. Measure task-specific Jev thresholds and choose a tested OpenAI model snapshot.

The Netherlands/EUR in the prototype is a fixture, not a chosen supplier market.
No keys, account creation, provider purchases, external outreach, hosting changes or deployments are authorized by these documents.
The next implementation request should begin with these proof tasks and contract tests, not a production-wide coding fan-out.

## How workers use this

An ADR is a shared decision, not an individual worker ticket.
Implementation packages name user-visible behavior, owned files, input/output contracts, dependencies and tests.
The package map in ADR-0008 permits parallel work only after those inputs are stable.
New evidence updates a decision through a dated amendment or a superseding ADR; requirement identifiers keep their original meaning.

For Firecrawl, AgentMail and Convex integration, read the [sponsor contracts](../integrations/sponsor-contracts.md), then follow the [worker plan](../implementation/sponsor-integration-plan.md).
The contracts distinguish source-verified behavior, selected implementation rules and unproven runtime behavior.
ADR-0004 now specifies official-component collection and inbox handling, with outbound mail sent through the shared authorized workflow rather than a second independent queue.
Its remaining checks are concrete acceptance cases, not permission for each worker to invent a different integration.

## Current evidence

The accepted reference is [the complete standalone workbench](../../design/purchasing-workbench.html).
Open it in a browser as a local file; images, fonts and the fixture runtime are embedded.
It makes no external requests and resets fixture state on reload.
Four structural checks and the 19 existing delivery-helper tests pass locally.
The source walkthrough was browser-smoke-tested at checkpoint `915844a`, but the exported file was not browser-retested because the browser tool blocked local-file URLs.
These tests do not prove production security, live integrations or hackathon completion.

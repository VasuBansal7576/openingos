# OpeningOS

A purchasing workbench for café equipment, supplier comparisons and follow-through.
The planned product connects requirements, source evidence, quote versions, approved communication and equipment history.

## Current state

This repository contains the agreed PRD, architecture proposals, controlled foundation proofs, delivery tooling and selected clickable design.
It does not contain an implemented application or deployed Convex backend yet.
There is no live site or production start command.

Open [the standalone purchasing workbench](design/purchasing-workbench.html) in a browser to inspect the selected flow.
Its images, fonts and fixture runtime are embedded.
It uses fictional in-memory data, makes no external requests and resets on reload.
The prototype is a design reference, not a live product demo.

## Planned product and stack

The evaluator starts a café project, researches vendors, compares evidence-backed offers, approves an RFQ and follows a reply through negotiation and selection.
Convex owns persistent records, access checks, jobs and reactive updates.
ChatGPT Sites hosts the frontend.
Firecrawl collects public vendor information, AgentMail transports correspondence, Jev makes bounded typed decisions, and OpenAI extracts and drafts content.

All hackathon outreach goes only to the owner's privately configured mailbox.
The owner replies as the supplier through real email.
Research, model calls and transport must be real, while owner-authored offers remain clearly labeled controlled demo terms.
No real vendor is contacted through email, forms or another channel.

## Start here

| Document | Purpose |
| --- | --- |
| [PRD](PRD.md) | Product scope, evaluator journey and 52 stable acceptance requirements |
| [Architecture decisions](docs/adr/README.md) | Accepted constraints, proposals and remaining proof gates |
| [Sponsor contracts](docs/integrations/sponsor-contracts.md) | Convex, Firecrawl and AgentMail ownership and effects |
| [Jev integration](docs/adr/0005-jev-and-openai.md#api-contract) | Backend endpoint, request/response validation and retry policy |
| [Implementation packages](docs/implementation/sponsor-integration-plan.md) | Dependencies, owned files and acceptance evidence |
| [Coordinator roadmap](ROADMAP.md) | Astra's setup, build order and completion gates |
| [Agent instructions](AGENTS.md) | Repository rules and GitHub delivery responsibilities |
| [Build log](hackathon.md) | Factual progress, not planned capabilities presented as completed work |

## Run the existing checks

Use a recent Node.js release with the built-in test runner.
These checks do not require installing application packages:

```sh
node --test scripts/check-pr.test.mjs scripts/check-workbench.test.mjs
```

These 23 tests validate the CI-inspection helper and saved prototype structure only.
The independent contracts under `proofs/money` and `proofs/jev` use controlled data and injected HTTP responses.
They exercise financial calculations and Jev transport validation without provider credentials or live calls.
The controlled proof checkpoint `595d30c` passes 77 tests and independent Astra review with no remaining actionable findings.
The roadmap records the separate hosted and application gates that remain open.
Run them with the pinned Bun 1.3.11 toolchain:

```sh
bun install --frozen-lockfile
bun run typecheck:proofs
bun run test
```

CI requires `delivery-guard-tests`, `workbench-artifact-tests`, `foundation-typecheck` and `foundation-contract-tests`.
Application typechecking, build, backend tests and live integration checks remain foundation deliverables, not passing checks today.
Use Bun for the application unless the selected Sites starter specifies another package manager.

## Configuration and publication

No provider credentials or owner mailbox values belong in Git, the public build log or frontend bundles.
The integration documents name required settings without storing their values.
Coding-agent subscriptions and connected plugins do not automatically provide the deployed app's API access.

Orca coordinates local workers; it is not the customer application's runtime.
Standalone OpenCode and Codex CLI workers cannot claim publication to `chatgpt.site` without the ChatGPT Sites integration.
The coordinator hands the tested source revision back to ChatGPT for authorized publication and public-access verification.

## Hackathon submission

The [official event](https://www.convex.dev/hackathons/all-gas) requires a public repository, a root build log, an eligible public live URL and a demo under three minutes.
OpenAI, Firecrawl and AgentMail must perform observable product work alongside Convex.
Registration, participant eligibility, a social announcement tagging all four sponsors and submission through the [exact event form](https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit) remain separate checks.
The deadline is September 22, 2026 at noon Pacific, or September 23 at 00:30 India Standard Time.
The owner handles registration, eligibility, Firecrawl account/credits, video, announcement and submission; Astra owns the build and its verification.

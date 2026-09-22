# OpeningOS

A purchasing workbench for café equipment, supplier comparisons and follow-through.
The planned product connects requirements, source evidence, quote versions, approved communication and equipment history.

## Current state

This repository contains the agreed PRD, accepted controlled architecture contracts, the React/Convex purchasing application, controlled Jev and browser-executor modules, delivery tooling and the selected clickable design reference.
Combined code checkpoint `e40da16` integrates authenticated isolated intake and sample projects, source-backed purchasing records, comparisons, owner-only communication boundaries, negotiation, recovery, equipment history and the production workbench UI.
Its complete controlled local matrix, strict typechecks, production build and desktop/mobile browser QA pass.
The six findings from the earlier independent Astra review were repaired in the prior checkpoint.
The later seven-finding review described below remains the current integration gate.
The Astra repair line and Convex static hosting are merged to `main` at `e344106` (PRs #37, #33 and #38, all exact-head checks green, independent SWE-2 High ACCEPT on both the repair commits and the hosting diff).
The application is deployed to production Convex deployment `enchanted-caiman-248` and publicly served at `https://enchanted-caiman-248.convex.site` via `@convex-dev/static-hosting`.
All provider environment variables are configured on prod; `SITE_URL` points at the public origin.
A Playwright user journey against the public URL created a real Amsterdam/EUR workspace through intake and ran bounded live Firecrawl research, which returned ten live source records labeled honestly as sources (no supplier, quote, saving or order was created).
The dev deployment `polite-minnow-494` runs the same merged code.
No `OPENAI_API_KEY` is available, so OpenAI extraction and the complete Jev/OpenAI chain remain unexercised.
No AgentMail send/reply round trip has been observed, and no verified supplier quote or commercial outcome exists.
The Firecrawl app allowance is hard bounded at 100000 micro-USD with no paid overage authorized.
Greptile review is unavailable because the 50-credit trial is exhausted, and Devin review was skipped because its trial expired.

Open [the standalone purchasing workbench](design/purchasing-workbench.html) in a browser to inspect the selected flow.
Its images, fonts and fixture runtime are embedded.
It uses fictional in-memory data, makes no external requests and resets on reload.
The prototype is a design reference, not a live product demo.

## Planned product and stack

The evaluator starts a café project, researches vendors, compares evidence-backed offers, approves an RFQ and follows a reply through negotiation and selection.
Convex owns persistent records, access checks, jobs and reactive updates.
Convex static hosting serves the frontend on the production `convex.site` origin.
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
| [Coordinator roadmap](ROADMAP.md) | Coordinator setup, build order and completion gates |
| [Evidence matrix](docs/verification/evidence-matrix.md) | Current status for all 52 P/H/D requirements, 24 S-cases and 7 J-cases |
| [Agent instructions](AGENTS.md) | Repository rules and GitHub delivery responsibilities |
| [Build log](hackathon.md) | Factual progress, not planned capabilities presented as completed work |

## Run the existing checks

Use the pinned Bun 1.3.11 toolchain for the application and controlled contracts:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:browser
bun run build
bun run test
bun run test:provider-contracts
bun run test:user-path
```

The independent contracts under `proofs/money` and `proofs/jev` use controlled data and injected HTTP responses.
They exercise financial calculations and Jev transport validation without provider credentials or live calls.
The controlled proof checkpoint `595d30c` passes 77 tests and independent Astra review with no remaining actionable findings.
The application/browser checkpoint `6432e98` passes 23 repository tests, 77 proof tests, 155 browser-executor tests, 2 application tests, 19 provider-contract tests and 5 mounted user-path tests, with separate Astra acceptance.
Its exact-head GitHub application and repository workflows passed.
The current combined code checkpoint `e40da16` passes 23 repository tests, 77 proof tests, 15 evaluation tests, 342 F1 tests, 155 browser-executor tests, 152 application tests, 18 application Jev tests, 32 communication-contract tests and 554 direct Convex tests.
Controlled Chrome QA at 1440 × 1200 and exact 390 × 844 covers same-state prototype comparison, loading, empty, error recovery, navigation and keyboard dialog behavior without claiming a hosted backend or live provider effect.
CI now requires `delivery-guard-tests`, `workbench-artifact-tests`, `foundation-typecheck`, `foundation-contract-tests`, `app-typecheck`, `app-build`, `app-tests`, `app-provider-contracts` and `app-user-path`.
These results are controlled evidence only; the [roadmap](ROADMAP.md) and [evidence matrix](docs/verification/evidence-matrix.md) retain the hosted and live gates.

## Configuration and publication

No provider credentials or owner mailbox values belong in Git, the public build log or frontend bundles.
The integration documents name required settings without storing their values.
Coding-agent subscriptions and connected plugins do not automatically provide the deployed app's API access.

Orca coordinates local workers; it is not the customer application's runtime.
The frontend publishes to `https://enchanted-caiman-248.convex.site` with `bun run deploy` after `npx convex deploy` pushes functions to prod; both steps run from a checkout whose `.env.local` selects the project.
`SITE_URL` on prod is `https://enchanted-caiman-248.convex.site`.

## Hackathon submission

The [official event](https://www.convex.dev/hackathons/all-gas) requires a public repository, a root build log, an eligible public live URL and a demo under three minutes.
OpenAI, Firecrawl and AgentMail must perform observable product work alongside Convex.
Registration, participant eligibility, a social announcement tagging all four sponsors and submission through the [exact event form](https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit) remain separate checks.
The deadline is September 22, 2026 at noon Pacific, or September 23 at 00:30 India Standard Time.
The owner handles registration, eligibility, Firecrawl account/credits, video, announcement and submission; the active OpeningOS coordinator owns the build and its verification.

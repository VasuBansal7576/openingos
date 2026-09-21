# OpeningOS design QA

**Source visual truth**

- `design/purchasing-workbench.html` (accepted September 19, 2026; self-contained fixture prototype)
- Prior browser capture: `/tmp/openingos-design-qa/reference-workbench.png`
- Source pixels: 1440 × 1200 at device scale factor 1.

**Implementation evidence (this repair)**

- Production bundle built from this checkout: `dist/` via `bun run build`
  (renders `dist/assets/index-CEWej7NF.js`, contains the landing copy; the
  espresso-machine visual ships as `dist/assets/espresso-machine-Ci7aWQZ4.png`).
- Automated verification, all passing on this checkout:
  - `bun test app/tests/application.test.ts`: 11 pass, 103 assertions
    (landing composition per backend state, narrow-layout CSS rules,
    focus/reduced-motion rules, 4.5:1 contrast math on shipped tokens).
  - `bun test app/tests/user-path.test.ts`: 10 pass, 78 assertions
    (demo unavailable flow, brief gating, keyboard entry points, skip link,
    focus, status retry, plus the pre-existing recovery/disposal path).
  - `bun test app/tests/workbench.test.ts`: 57 pass, 331 assertions
    (ready/loading/empty/error/reconnecting projections, F4 source-URL link
    and unavailable states, F7 unsafe/over-precision/valid budget paths,
    selection gating, pagination fences, equipment honesty).
  - `bun test app/tests/intake.test.ts`: 10 pass, 48 assertions (unchanged,
    still green: intake contract and connected empty-state intake offer).
  - `bun test app/tests/convex-workbench-adapter.test.ts`: 28 pass.
  - `bun test app/tests/provider-contracts.test.ts`: 20 pass.
  - `bun run typecheck` (root `tsc --noEmit`): clean.
  - `bun run typecheck:browser`: clean.
  - `bun run build` (vite production): clean.
- Static audit: no fixed-pixel `width:` overflow offenders in landing rules;
  landing grids use fractional units with `minmax(0, …)`/`min-width: 0` and
  `overflow-wrap: break-word` on display headings.

**Target state**

- Public landing reproduces the accepted prototype's purchasing-workbench
  composition inside the production app: ivory nav shell, sage desk canvas,
  hero copy with serif display hierarchy, espresso-machine polaroid, rotated
  cream quote paper with "Less chasing. More choosing.", yellow chapter note,
  "Try the Northside café demo" primary action, "Start your own brief"
  text entry, "No sign-up. No card." note, how-it-works trio, and footer.
- Backend status is a compact integrated strip above the nav in every state
  (unconfigured, configured-unverified, authenticating, connected empty /
  loading / error, reconnecting, unavailable). It never replaces the design
  and never implies a live connection.
- "Start your own brief" enters the real configured intake flow: with a live
  connected intake route the real `WorkbenchIntakeView` (P-01,
  `domain/intake:createWorkspace`) is embedded below the hero; without that
  route it renders an honest blocked state naming the exact cause. No mutation
  is offered while unconfigured, unverified, authenticating, or unavailable.
- "Try the Northside café demo" renders a truthful unavailable state: no
  backend sample-guest-project route exists (only
  `domain/intake:createWorkspace`), so the demo cannot start without
  inventing fixture vendors, quotes, or savings. The panel names the missing
  contract (`isolated sample-guest-project creation`) and offers the real
  brief flow instead when a route is attached. No fixture data, browser-only
  fake project state, fake quotes, or fake savings were added.
- Connected production behavior is preserved unchanged: ready snapshots (and
  reconnecting last-known snapshots) render the full workbench with the real
  projections/actions for brief, sourcing, compare, inbox, review, recovery,
  and equipment flows; capability/job-authority enforcement and concise
  out-of-scope refusal behavior are untouched backend contracts.
- F4: the evidence panel now opens the validated projected HTTPS source URL
  in a new tab (`rel="noreferrer"`) when the projection includes one, and
  otherwise states truthfully that no public source URL was projected. Raw
  headers, mailbox addresses, and provider IDs remain redacted.
- F7: an unsafe-magnitude or over-precision budget shows an inline error,
  retains every entered value, and never calls `onIntake` (previously an
  unsafe value was silently omitted and the submission proceeded).
- F9: small text over the desk image now uses darker pine inks
  (`#1e3a2c` body/eyebrow copy, `#16402c` landing links) verified by
  computed contrast against the sage canvas (`#abbda7`): 6.2:1 and 5.9:1
  respectively, both above 4.5:1 on desktop and narrow widths. The warm
  yellow hero action (`#23382d` on `#ffe576`, 10.0:1) and body ink on cream
  paper (`#18362d` on `#f7f2e7`, 11.7:1) remain passing.

**Differences from the prototype (deliberate, honest)**

- The prototype's populated fixture vendors, quotes, scripted assistant, and
  simulated inbox/recovery/equipment states are not reproduced as content:
  every workbench route still renders only real authorized backend state.
- The prototype footer label ("Interactive prototype · simulated data and
  actions") is replaced with "Connected views use authorized backend state".
  This avoids claiming that the static public landing itself is live data.
- The prototype's "Pull up a chair" paper button enters the real brief flow
  instead of the fixture comparison.
- The prototype's demo button enters the fixture flow; production shows the
  unavailable state above because no sample-project backend contract exists.
- The unconfigured state deliberately uses no product claim beyond the
  landing preview and its compact status strip.

**Comparison history**

- P0 (fixed): the production route replaced the accepted landing with a
  giant "OpeningOS is ready to connect" backend error. Fixed: every
  non-ready backend state now renders the full landing composition with a
  compact honest status strip; the old full-page error copy is gone.
- P1 (fixed): `bun test` loaded `espresso-machine.png` as a module and
  failed the workbench suite. Fixed by resolving the visual as a relative
  asset URL (rewritten by Vite at build time); the suite passes and the
  production bundle ships the image.
- P1 (fixed): combined `bun test` of several app suites in one piped command
  exceeded 180s with no output. Diagnosed by running each suite alone:
  application 11/11, intake 10/10, workbench 57/57, user-path 10/10;
  no hanging test; the stall was the combined piped invocation, not product
  code. Suites are run individually.
- P1 (fixed): `tsc --noEmit` flagged a narrowed `empty`-state comparison in
  `App.tsx` and a happy-dom `activeElement` type mismatch in the new
  keyboard test. Both repaired; both typechecks are clean.
- P2 (fixed in code, browser verification pending): F2/F4/F7/F9 findings
  from the coordinator's Astra UI review are repaired with regression tests.
  F2 now renders native quote currency and exact minor units, consumes only
  backend-authored pairwise verdicts, and does not rank incompatible,
  incomplete, estimated, or absent comparisons.

**Responsive / accessibility findings**

- Desktop: two-column hero (47%/53%), polaroid + rotated paper + yellow
  note, and four-column how-it-works match the prototype's composition and
  hierarchy at wide widths.
- Narrow (≤800px): hero stacks, nav links collapse to brand + brief CTA,
  how-it-works goes two-column; at ≤540px the workbench preview becomes a
  `.9fr/1.1fr` grid with static yellow note, full-width capped primary
  action, single-column how-it-works. No fixed overflow widths; display
  headings wrap.
- Keyboard: skip link, native buttons/links throughout, visible
  `:focus-visible` outlines, Escape closes entry panels with focus returned
  to the invoking control, panel headings and the embedded brief section
  receive focus on open. Dialog, selection, evidence, assistant, and service
  panels keep the shared modal focus-trap contract.
- Reduced motion: landing rotations join the existing transform-none rule.

**Remaining blocker**

- Rendered-pixel comparison at 1440×1200 and 390×844 could not be captured
  in this worker environment (no browser available), so same-state
  screenshot parity rests on DOM composition, shipped-token contrast math,
  CSS overflow audit, and interaction tests rather than pixel diffs. A
  browser pass (Playwright or Computer Use against this exact commit, static
  landing states plus connected key routes: brief, compare, vendors, inbox,
  review, recovery, equipment) should confirm visual polish before handoff.
  Controlled prototype states remain labeled controlled; nothing here is
  live-integration evidence.

**Final result**

final result: pending browser verification. The sample-project backend route
also remains an open product dependency. The implementation must not be marked
passed until same-state desktop and mobile browser captures have been compared
with the accepted prototype, all resulting P0/P1/P2 issues are fixed, and the
real isolated sample-project path has been verified. No fixture data was
introduced in this checkpoint.

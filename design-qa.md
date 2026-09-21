# OpeningOS design QA

**Source visual truth**

- `design/purchasing-workbench.html#/compare`
- Browser capture: `/tmp/openingos-design-qa/reference-workbench.png`
- Source pixels: 1440 × 1200 at device scale factor 1.

**Implementation evidence**

- Local integrated branch at `http://127.0.0.1:4174/`.
- Desktop capture: `/tmp/openingos-design-qa/cdp-desktop.png`.
- Mobile capture: `/tmp/openingos-design-qa/cdp-mobile.png`.
- Side-by-side comparison: `/tmp/openingos-design-qa/workbench-comparison-final.png`.
- Desktop viewport: 1440 × 1200 CSS pixels at device scale factor 1.
- Mobile viewport: 390 × 844 CSS pixels at device scale factor 1.
- Chrome DevTools Protocol reported desktop `clientWidth = scrollWidth = 1440` and mobile `clientWidth = scrollWidth = 390`.
- Browser console errors: zero in both captures.

**State**

The source shows its fictional populated comparison state.
The production application capture shows the honest unconfigured-backend state because no Convex deployment URL or authorized project projection is available in this checkout.
No fixture vendor, quote, price, provider result, or customer data was introduced to make the production screenshot resemble a live result.

**Full-view comparison**

The application now retains the selected prototype's ivory navigation shell, sage desk canvas, serif display hierarchy, yellow accent, paper composition, and workbench navigation in the unconfigured, connecting, empty, error, and reconnecting paths.
The previous unrelated dark foundation page is removed from the visible path.
The ready-state quote papers cannot be compared in a real browser until a real authorized backend projection is configured.

**Focused comparison**

- Typography uses the bundled DM Serif Display and Manrope Variable fonts from the production application.
- Spacing and layout preserve the prototype's slim status banner, compact ivory header, desktop decision-desk proportions, and mobile stacked hierarchy.
- Colors use the selected pine, sage, ivory, and yellow workbench tokens.
- The unconfigured state deliberately uses no product image because no real requirement or product record is available.
- Copy describes the exact unavailable state and does not claim live integrations or outcomes.

**Comparison history**

- P1: the initial production route replaced the selected workbench with a dark marketing-style foundation page.
  Fixed by rendering every backend lifecycle state inside the workbench shell.
- P1: the production header rendered the duplicate brand `O.OpeningOS.`.
  Fixed to the selected `OpeningOS.` wordmark treatment.
- P1: the narrow header could not safely fit the banner, project selector, assistant control, and all five navigation tabs.
  Fixed with a three-row 390px grid, bounded project metadata, a compact five-way tab row, and a narrow banner.
  Post-fix browser evidence reports zero horizontal overflow and all five tabs present.

**Primary interactions tested**

- The unconfigured production state renders five disabled navigation controls and a disabled assistant control.
- No backend action is available and no provider call is made.
- Automated application coverage passes the ready, loading, empty, error, reconnecting, modal, keyboard, action-fence, and projection-validation paths.

**Remaining blocker**

The full populated user flow still requires Playwright or Orca Computer Use against a real authorized backend projection.
The Orca 1.4.205 runtime reports ready immediately after launch and then exits before the first orchestration or browser query, so Computer Use and supervised worker verification are currently unavailable.

**Final result**

final result: blocked

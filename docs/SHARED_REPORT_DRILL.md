# Drill levels in shared reports

A flag set to **drill** (click a bar to open the next level) can be drilled inside a shared report too, with no database: the levels are worked out when the report is saved, and the reader looks them up.

## What is in the file

When **Share as a report** saves a page, each drillable flag gets one saved result per level it can open: its top level (as before), then for each value the level below it (year, then quarter, month and day for dates; along the drill path in the catalog for categories). Code: `web/src/lib/report-drill.ts`, `src/core/reports.ts` (`FrozenFlag.drill`), the reader in `web/src/report.tsx`.

- **Breadth first, within a budget.** Up to 150 levels per flag and 600 per report. The upper levels always make it in; a very wide or deep flag loses its deepest levels first. A measured example: 37 levels for a three-year flag added about 90 KB (about 2.5 KB a level).
- **The same rule as the page.** Each saved level is the flag after those drill steps (`drillView` in `src/core/drill.ts`), computed by the same code path as on screen; a test checks the saved rows equal the live ones, and that a level adds up to the value it was opened from for an additive measure.
- **A comparison carries down**, as it does on the page (see [DRILL_COMPARISONS.md](DRILL_COMPARISONS.md)).

## What the reader sees

Clicking a bar of a drillable flag opens its next level with a breadcrumb (Back, the flag name, the path). A level past the budget says "This level was not saved in the file (it needs the database)". The rows behind the last level (the detail table) are never saved: "The rows behind this value are not saved in the file."

Page filters (clicks on other flags) do not apply below the top level in a file, the same as on the page, where a drill narrows one flag only; the flag says so when a filter is active. A flag that is not set to drill, or editions of recurring reports, are unchanged: editions carry no drill levels.

## Decisions to review

I chose these without waiting, as defaults: the budgets above; breadth-first order; no detail rows; no filters below the top level; levels are computed with the same data context the page used when saving (so a report saved from a page with database sources carries levels from the database as they were then).

Tests: `tests/report-drill.test.ts` (9). Not tried: opening a real saved file in a browser; the reader code is checked by types, a source check and the build.

# Comparisons under a drill and in shared reports

A flag can compare with an earlier window (`compare`: `previous-period` or `previous-year`, against its
"last N" date filter; see FLAG_SPEC.md). Until now that held only for the flag as drawn on the page:
a drilled flag dropped it, and a shared report lost it the moment the reader clicked something. This
note says what happens now, where the code is, and what it does not do.

## What a comparison means once the flag is narrowed

The earlier window is always the same question asked of an earlier time, so anything that narrows the
flag by time narrows the earlier window the same way, moved back with it.

| Narrowing | Current window | Earlier window |
|---|---|---|
| Drill step on the compared date (year, quarter, month) | the clicked period | the same period, moved back by the window's offset |
| Drill step on a category (class, then hull) | that class | that class (nothing moves) |
| Any other filter or page selection (region, ship class) | filtered | filtered the same |
| A period picked on another flag (`jobs.opened@month`) | that month | that month, moved back by the offset |

The offset is one year for `previous-year`, and the length of the "last N" window for
`previous-period`. Example, today 26 Oct 2026, flag "labor cost by year, last 12 months, versus a
year earlier", opened on 2026 and then Q3:

| View | Current rows | Earlier rows (matched row by row) |
|---|---|---|
| Years | 2025, 2026 | the year before each |
| 2026 by quarter | Q1 to Q4 2026 (Q4 to 26 Oct) | Q1 to Q4 2025 (Q4 to 26 Oct 2025) |
| Q3 2026 by month | Jul, Aug, Sep 2026 | Jul, Aug, Sep 2025 |

The grain is the drilled level's: the earlier window is read by quarter, then by month, and each row
is moved forward by the offset and cut back to its grain before it is matched (`comparisonShift`,
unchanged). The rows behind a value (the last level, a capped table) are a list rather than a series,
so the comparison ends there.

## How it is done

- `src/core/drill.ts` keeps `binding.compare` on the drilled flag (it used to delete it) except at the
  detail table, and tags each filter a drill step adds with `drill: true` (`Filter.drill` in
  `hoist.ts`). The tag is set only there: `parseFilters` never reads it from a saved hoist or an AI
  answer.
- `src/core/drill-compare.ts` (new) has the three pieces:
  - `comparisonPlanFor(plan, today)`: `comparisonPlan()` from the planner, then each drill-tagged filter on
    the compared date field is moved back (`shiftDrillFilter`). Without such a filter it returns
    exactly what `comparisonPlan()` returns, so nothing changes for flags that are not drilled.
    A `between` period is moved as whole periods (its first day, and the first day after it),
    so month and quarter ends never drift or clamp.
  - `comparisonSelections(plan, selections)`: a selection on `field@grain` is moved back by the offset
    and cut to its grain; other selections are unchanged.
  - `comparisonOffset(plan)`.
- `web/src/lib/data.ts` `computeFlag` uses `comparisonPlanFor` and `comparisonSelections`, and now also
  returns `previousRaw`, the earlier window's rows as the source sent them.
- `describe.ts` adds a sentence to the back of a drilled, comparing card; the breadcrumb says what the
  numbers are compared with.
- Nothing in `planner.ts`, `engine.ts`, `sql.ts` or `joins.ts` was edited, so none of this touches how
  tables join. The earlier window is an ordinary `QueryPlan`.

### Same answers from the page and the database

The earlier window is a plan like any other, with dates as bound parameters
(`"opened_on" >= ? AND "opened_on" < ?`), rendered by `renderSql` and run by `runPlan` from the very
same filters. `tests/drill-comparison.test.ts` loads the sample rows into SQLite, runs the SQL that
`renderSql` writes for the current and the earlier window of four drilled flags (year to quarter, quarter
to month, a three-month window, class to hull), and requires the rows to equal `runPlan`'s. (SQLite has no
`date_trunc`; the test registers one written apart from the engine's.)

## Shared reports

A report file holds every flag's saved answer and its pre-split rows, so clicks filter the other flags
with no database. For a comparing flag it now also holds the earlier window's pre-split rows
(`previousRaw`, with the plan that asked for them).

- With nothing selected the report shows the saved comparison, as before.
- With a selection, `web/src/lib/report-view.ts` (moved out of `report.tsx` so it can be run in tests)
  filters the current rows, filters the earlier rows with the selection moved back
  (`comparisonSelections`), and lines the two up again. The test compares this, for four selections
  and a bar and a KPI, with `computeFlag` asked live: rows and comparison are equal.
- If the selection needs the database (a distinct count cannot be re-added from pre-split rows), or the
  earlier rows were too many to keep (the same 20,000-row cap as the current rows, `RAW_ROWS_MAX`), the
  flag shows no comparison and says so, instead of a whole-page comparison beside narrowed numbers.
- Editions (the recurring Monday brief) never carry `raw` or `previousRaw`; they are read as they stand.
- Cost: a comparing flag adds up to one more row set to the file, bounded by the same cap.

## What it does not do

- The report has no drill levels. A flag set to drill acts as a page filter in the file (the file
  carries the top level only, as ARCHITECTURE.md says), so there is no drilled comparison to carry
  there. Pre-splitting each level would multiply the file, and the last level (the rows behind a
  value) cannot be pre-split at all. This is the remaining part of the roadmap line, if the reader
  should drill.
- When the window's offset is not a whole number of the grain being matched (a one-month window with a
  quarter drill or pick), rows are matched by the shift-and-cut that `lineUp` has always used, so an earlier
  row is the quarter the shifted date falls in rather than an exact like-for-like slice. A drilled
  period on the page is moved exactly (it is a date filter); a period picked on another flag, on the page
  or in a report, is moved as a value and cut to its grain, which is exact only when the offset is a whole
  number of that grain (every year offset, and a three-month window with quarter or month picks).
- A drill step on a different date field than the "last N" filter narrows both windows the same way and
  is not moved.
- The comparison is one metric deep, as before: the dashed series and the change column use the first
  metric.

## Tests

`tests/drill-comparison.test.ts` (14 tests): drilled values against a plain loop over the sample rows
(year to quarter to month, previous-year and previous-period, class to hull, the detail table), plan
filters and grain, the drill tag, whole-period shifts including a leap day, SQLite against the engine,
selection narrowing on the page, the report payload, the report read under four selections against the
live computation, and the notes when a comparison cannot follow a selection.

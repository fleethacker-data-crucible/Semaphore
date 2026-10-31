// Comparisons that follow a narrowing. A flag that compares ("versus the previous period / a year
// earlier") reads a second, earlier window. Anything that narrows the flag by time has to narrow
// that earlier window the same way, or the two sides stop being like for like:
//
//   - a drill step on the compared date (drill.ts tags its filter `drill`): the clicked year or
//     quarter moves back with the window, so "2026 Q3" is compared with "2025 Q3";
//   - a period picked on another flag (a selection on `jobs.opened@month`): the picked month is
//     looked up one window back in the earlier rows (the report reader does this offline).
//
// Everything else (a ship class, a region) narrows both windows the same way and needs no help.
// The functions here only build and move plans and selections; SQL still comes from renderSql()
// and the in-page engine runs the very same plan, so the two cannot disagree.

import type { Cell, Selections } from './crossfilter.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import { comparisonPlan, type QueryPlan } from './planner.ts';
import { periodStart } from './sql.ts';

/** How far back the earlier window sits from the current one. */
export function comparisonOffset(plan: QueryPlan): { unit: TimeGrain; by: number; field: string } | null {
  if (!plan.compare) return null;
  const f = plan.filters[plan.compare.filter];
  if (!f || f.op !== 'last' || !f.unit || typeof f.values[0] !== 'number') return null;
  return plan.compare.kind === 'previous-year' ? { unit: 'year', by: 1, field: f.field } : { unit: f.unit, by: f.values[0], field: f.field };
}

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}/;

function parse(v: string): Date | null {
  if (!DATE.test(v)) return null;
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Move a date by whole units; month ends clamp (31 May minus 3 months is 28 or 29 February). */
function shift(d: Date, unit: TimeGrain, by: number): Date {
  if (unit === 'day') return new Date(d.getTime() + by * DAY);
  if (unit === 'week') return new Date(d.getTime() + by * 7 * DAY);
  const months = unit === 'month' ? by : unit === 'quarter' ? 3 * by : 12 * by;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * A drill filter moved back with the comparison window. A `between` is a whole number of periods,
 * so its end is moved as the start of the next period and then stepped back a day. Moving the end
 * date itself would clamp at month ends (the last day of May shifted back three months lands on
 * 28 or 29 February, short of the real quarter end), while a period's first day never clamps.
 * The filter is returned unchanged if it holds no dates.
 */
export function shiftDrillFilter(f: Filter, offset: { unit: TimeGrain; by: number }): Filter {
  const back = (d: Date) => shift(d, offset.unit, -offset.by);
  if (f.op === 'eq') {
    const d = parse(String(f.values[0]));
    return d ? { ...f, values: [ymd(back(d))] } : f;
  }
  if (f.op !== 'between') return f;
  const from = parse(String(f.values[0]));
  const to = parse(String(f.values[1]));
  if (!from || !to) return f;
  const start = back(from);
  const endExclusive = back(new Date(to.getTime() + DAY));
  const end = new Date(Math.max(start.getTime(), endExclusive.getTime() - DAY));
  return { ...f, values: [ymd(start), ymd(end)] };
}

/**
 * The plan for a flag's comparison window, like comparisonPlan() but also moving the drill
 * steps that narrow the compared date field. Without such steps it is exactly comparisonPlan().
 */
export function comparisonPlanFor(plan: QueryPlan, today: Date = new Date()): QueryPlan | null {
  const earlier = comparisonPlan(plan, today);
  const offset = comparisonOffset(plan);
  if (!earlier || !offset) return earlier;
  const filters = earlier.filters.map((f, i) => (f.drill && i !== plan.compare!.filter && f.field === offset.field ? shiftDrillFilter(f, offset) : f));
  return { ...earlier, filters };
}

/**
 * Selections as they read in the earlier window. A period picked on a time dimension
 * (`field@grain`) is moved back by the window's offset and re-truncated to its grain, the
 * inverse of comparisonShift(); every other selection is unchanged.
 */
export function comparisonSelections(plan: QueryPlan, selections: Selections): Selections {
  const offset = comparisonOffset(plan);
  if (!offset) return selections;
  const out: Record<string, ReadonlyArray<Cell>> = {};
  for (const [key, values] of Object.entries(selections)) {
    const grain = key.split('@')[1] as TimeGrain | undefined;
    out[key] = grain
      ? values.map((v) => {
          const d = typeof v === 'string' ? parse(v) : null;
          return d ? periodStart(shift(d, offset.unit, -offset.by), grain, 0) : v;
        })
      : values;
  }
  return out;
}

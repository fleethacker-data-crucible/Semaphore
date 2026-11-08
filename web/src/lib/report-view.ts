// What a shared report shows for one flag under the reader's current selections. The report holds
// each flag's pre-split rows (and, for a comparing flag, the earlier window's pre-split rows), so
// a click filters every flag in the file with no database. Kept apart from report.tsx so it can be
// run, and tested, without a page.

import { applySelections, type Cell, lineUp, type Selections } from '../../../src/core/crossfilter.ts';
import { comparisonSelections } from '../../../src/core/drill-compare.ts';
import { comparisonShift } from '../../../src/core/planner.ts';
import type { FrozenFlag } from '../../../src/core/reports.ts';
import type { FlagResult } from './data.ts';

export interface ReportView {
  result: FlagResult | null;
  note?: string;
}

/** The selections that can change this flag: not the fields it ignores, and not empty ones. */
export function relevantSelections(selections: Selections, f: FrozenFlag): Selections {
  const out: Selections = {};
  for (const [k, v] of Object.entries(selections)) if (v.length && !f.flag.behavior.ignore.includes(k.split('@')[0]!)) out[k] = v;
  return out;
}

export function reportView(f: FrozenFlag, selections: Selections): ReportView {
  const r = f.result as (FlagResult & { raw?: Array<Record<string, Cell>> }) | null;
  if (!r) return { result: null };
  const relevant = relevantSelections(selections, f);
  if (!Object.keys(relevant).length) return { result: r };
  if (!r.raw) return { result: r, note: 'Shown as it was saved: this flag is too large to filter in the file.' };
  const display = applySelections(r.plan, r.raw, relevant, f.flag.behavior);
  let note = display.live.length ? 'Some of the selection needs the database, so it is not applied here.' : undefined;
  const { previous: saved, previousRaw, ...rest } = r;
  const out: FlagResult = { ...rest, display };
  // The comparison is looked up again for the narrowed rows: the earlier window's pre-split rows get
  // the same selections (a picked period moved back by the window's offset), and are lined up with
  // the rows now shown. Without those rows it cannot be, and the flag says so rather than show a
  // comparison for the whole page next to numbers for a part of it.
  if (saved) {
    if (previousRaw && !display.live.length) {
      const before = applySelections(previousRaw.plan, previousRaw.rows as Array<Record<string, Cell>>, comparisonSelections(r.plan, relevant), f.flag.behavior);
      out.previous = lineUp(display.rows, before.rows, comparisonShift(r.plan) ?? undefined);
      out.previousTotals = before.totals;
      out.previousRaw = previousRaw;
    } else if (!note) note = 'The comparison is not shown under a selection: it is too large to filter in the file.';
    else note = `${note} The comparison is not shown.`;
  }
  return { result: out, ...(note ? { note } : {}) };
}

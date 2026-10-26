// Snapshots let leadership read answers without ever connecting to a database. When an analyst
// (or an approved refresher) runs Semaphore, each playbook entry's query is run and its result
// saved: the small, already-aggregated rows the planner asks for, pre-split by the fields leaders
// are likely to pick (the short lists on that table), and stamped with when the data was read.
//
// Because the rows hold re-addable partials (crossfilter.ts), one snapshot answers more than its
// own question: "labor cost by region and ship class" also answers "labor cost by region", the
// total, and "labor cost for icebreakers". A snapshot never holds raw rows.

import type { CatalogIndex } from './catalog.ts';
import { applySelections, type CrossfilterResult, lineUp, type ResultRow, type Selections } from './crossfilter.ts';
import { type Binding, dimensionKey, type Filter, type Flag, type Hoist } from './hoist.ts';
import { comparisonPlan, comparisonShift, planFlag, type QueryPlan } from './planner.ts';
import { entryFlag, entryHoist, type PlaybookEntry } from './playbook.ts';

export interface Snapshot {
  version: 1;
  /** Same id as its playbook entry. */
  id: string;
  title: string;
  entryId: string;
  /** When the source was read. */
  asOf: string;
  plan: QueryPlan;
  rows: ResultRow[];
  /** The comparison window's rows, when the entry compares. */
  previous?: { plan: QueryPlan; rows: ResultRow[] };
  truncated: boolean;
  updated: string;
}

/** Rows a snapshot may hold; enough for any reasonable pre-split, small enough for a shared folder. */
export const SNAPSHOT_ROW_CAP = 10_000;
/** Short lists worth pre-splitting by: fields with at most this many values. */
export const SLICE_MAX_VALUES = 30;
/** At most this many extra fields are pre-split, cheapest first, within the row cap. */
export const SLICE_MAX_FIELDS = 4;
/** A snapshot older than this is refreshed when someone with access runs Semaphore. */
export const SNAPSHOT_MAX_AGE_HOURS = 6;

/**
 * The plan a snapshot runs: the entry's own query, without its top-N cut and sort (they are
 * re-applied when answering), pre-split by the short lists on its table.
 */
export function snapshotPlan(entry: PlaybookEntry, index: CatalogIndex): QueryPlan | null {
  const base = entryFlag(entry);
  const binding: Binding = { ...entry.binding };
  delete binding.limit;
  delete binding.sort;
  const flag: Flag = { ...base, binding };
  const own = new Set(binding.dimensions.map((d) => d.field));
  // Pickers for the short lists make the planner pre-split by them, within the row cap.
  const pickers: Flag[] = index.catalog.fields
    .filter((f) => f.table === entry.table && f.source === entry.source && (f.type === 'string' || f.type === 'boolean') && !own.has(f.key) && f.cardinality !== undefined && f.cardinality <= SLICE_MAX_VALUES)
    .sort((a, b) => (a.cardinality ?? 0) - (b.cardinality ?? 0))
    .slice(0, SLICE_MAX_FIELDS)
    .map((f, i) => ({ ...base, id: `slice-${i}`, kind: 'filter', binding: { metrics: [], dimensions: [{ field: f.key }], filters: [] }, behavior: { onClick: 'filter-page', ignore: [], thresholds: [] } }));
  const hoist: Hoist = { ...entryHoist(entry), flags: [flag, ...pickers] };
  const p = planFlag(hoist, flag, index, { rowCap: SNAPSHOT_ROW_CAP });
  return p.ok ? p.plan : null;
}

export function isStale(s: Snapshot | undefined, entry: PlaybookEntry, now: Date = new Date()): boolean {
  if (!s) return true;
  if (s.updated < entry.acceptedAt) return true; // the entry changed after the snapshot was taken
  return now.getTime() - Date.parse(s.asOf) > SNAPSHOT_MAX_AGE_HOURS * 3_600_000;
}

/** Run an entry's snapshot with whatever can reach its source. */
export async function takeSnapshot(
  entry: PlaybookEntry,
  index: CatalogIndex,
  run: (plan: QueryPlan) => Promise<{ rows: ResultRow[]; truncated: boolean }>,
  now: Date = new Date(),
): Promise<Snapshot | null> {
  const plan = snapshotPlan(entry, index);
  if (!plan) return null;
  const result = await run(plan);
  const snap: Snapshot = { version: 1, id: entry.id, title: entry.title, entryId: entry.id, asOf: now.toISOString(), plan, rows: result.rows, truncated: result.truncated || result.rows.length >= plan.rowCap, updated: now.toISOString() };
  const earlier = comparisonPlan(plan, now);
  if (earlier) snap.previous = { plan: earlier, rows: (await run(earlier)).rows };
  return snap;
}

export interface SnapshotAnswer {
  display: CrossfilterResult;
  previous?: Array<Record<string, number | null> | null>;
  plan: QueryPlan;
  snapshot: Snapshot;
}

function sameWindow(a: readonly Filter[], b: readonly Filter[]): boolean {
  const key = (fs: readonly Filter[]) => JSON.stringify(fs.filter((f) => f.op === 'last').map((f) => [f.field, f.values, f.unit]));
  return key(a) === key(b);
}

/**
 * Answer a binding from saved snapshots, without a query: find a snapshot that holds every
 * measure and field asked for under the same window, and re-add its partials. Values picked
 * out of a field ("in" or "eq" filters) are applied as selections. Returns null when no
 * snapshot can answer exactly.
 */
export function answerFromSnapshots(
  flag: Flag,
  filters: readonly Filter[],
  snapshots: readonly Snapshot[],
  selections: Selections = {},
): SnapshotAnswer | null {
  const b = flag.binding;
  if (!b || b.metrics.length === 0) return null;
  const wanted = b.dimensions.map(dimensionKey);
  const windowFilters = [...filters, ...b.filters].filter((f) => f.op === 'last');
  const picks = b.filters.filter((f) => f.op === 'in' || f.op === 'eq');
  if (b.filters.some((f) => f.op !== 'last' && f.op !== 'in' && f.op !== 'eq')) return null;
  const candidates = snapshots
    .filter((s) => !s.truncated)
    .filter((s) => {
      const p = s.plan;
      const keys = p.dimensions.map((d) => d.key);
      if (!b.metrics.every((k) => p.metrics.some((m) => m.key === k))) return false;
      if (!wanted.every((k) => keys.includes(k))) return false;
      if (!picks.every((f) => keys.includes(f.field))) return false;
      if (!sameWindow(p.filters, windowFilters)) return false;
      // The snapshot's other fixed filters narrow its numbers; only reuse it when the question has them too.
      const fixed = p.filters.filter((f) => f.op !== 'last').map((f) => JSON.stringify(f));
      const asked = b.filters.filter((f) => f.op !== 'last').map((f) => JSON.stringify(f));
      if (!fixed.every((f) => asked.includes(f))) return false;
      // A distinct count cannot be re-added: only an exact match on fields and no picks.
      const distinct = b.metrics.some((k) => p.metrics.find((m) => m.key === k)?.agg === 'count_distinct');
      if (distinct && (keys.length !== wanted.length || picks.length > 0)) return false;
      if (b.compare && !s.previous) return false;
      return true;
    })
    .sort((x, y) => x.plan.dimensions.length - y.plan.dimensions.length || y.asOf.localeCompare(x.asOf));
  const s = candidates[0];
  if (!s) return null;

  const plan: QueryPlan = {
    ...s.plan,
    own: wanted,
    slices: s.plan.dimensions.map((d) => d.key).filter((k) => !wanted.includes(k)),
    metrics: s.plan.metrics.filter((m) => b.metrics.includes(m.key)),
    live: [],
    selfFilter: true,
    rowCap: Number.MAX_SAFE_INTEGER,
  };
  delete plan.sort;
  delete plan.displayLimit;
  if (b.sort) plan.sort = b.sort;
  if (b.limit) plan.displayLimit = b.limit;
  if (b.share) plan.share = true;
  // Order the own dimensions as asked, so the chart reads the right way round.
  plan.dimensions = [...wanted.map((k) => s.plan.dimensions.find((d) => d.key === k)!), ...s.plan.dimensions.filter((d) => !wanted.includes(d.key))];
  const sel: Selections = { ...selections };
  for (const f of picks) sel[f.field] = f.values;
  const display = applySelections(plan, s.rows, sel, flag.behavior);
  const out: SnapshotAnswer = { display, plan, snapshot: s };
  if (b.compare && s.previous) {
    const prevPlan: QueryPlan = { ...plan, filters: s.previous.plan.filters };
    delete prevPlan.compare;
    delete prevPlan.displayLimit;
    const before = applySelections(prevPlan, s.previous.rows, sel, flag.behavior);
    out.previous = lineUp(display.rows, before.rows, comparisonShift(s.plan) ?? undefined);
  }
  return out;
}

export function isSnapshot(raw: unknown): raw is Snapshot {
  if (typeof raw !== 'object' || raw === null) return false;
  const s = raw as Record<string, unknown>;
  return s.version === 1 && typeof s.id === 'string' && typeof s.asOf === 'string' && typeof s.plan === 'object' && s.plan !== null && Array.isArray(s.rows);
}

// The planner turns one flag into one source query, sized for a thin client.
//
// The source database does the aggregation, so only summarised rows come back. Each flag's
// query is also split ("pre-sliced") by the fields other flags on the page can select, which
// lets a click elsewhere filter this flag locally with no round trip. Slices that would make
// the result too large are dropped; selections on those fields go back to the source instead.

import { type Aggregate, type CatalogIndex, metricTable } from './catalog.ts';
import { type Comparison, type DimensionRef, type Filter, type Flag, type Hoist, type TimeGrain, dimensionKey } from './hoist.ts';

export const DEFAULT_ROW_CAP = 50_000;

/** Aggregates that can be filtered and re-added locally. count_distinct cannot. */
export type Partial = 'sum' | 'count' | 'min' | 'max' | 'count_distinct';

export interface PlannedDimension {
  alias: string;
  key: string;
  field: string;
  grain?: TimeGrain;
}

export interface PlannedAggregate {
  alias: string;
  fn: Partial;
  /** Field key aggregated, or null for COUNT(*). */
  field: string | null;
}

export interface PlannedMetric {
  key: string;
  agg: Aggregate;
  /** Partial aliases the displayed value is rebuilt from. avg uses sum and count. */
  parts: { sum?: string; count?: string; min?: string; max?: string; distinct?: string };
}

export interface QueryPlan {
  flagId: string;
  source: string;
  table: string;
  /** The flag's own dimensions, then the slice dimensions. */
  dimensions: PlannedDimension[];
  aggregates: PlannedAggregate[];
  metrics: PlannedMetric[];
  filters: Filter[];
  /** Keys of the flag's own dimensions, in display order. */
  own: string[];
  /** Page-selectable keys this result is pre-split by, so selections on them apply locally. */
  slices: string[];
  /** Page-selectable keys that apply to this flag but need a new source query. */
  live: string[];
  sort?: { by: string; dir: 'asc' | 'desc' };
  /** Row limit for the source query. */
  limit: number;
  /** The row cap this plan was sized for. A result this long may be incomplete. */
  rowCap: number;
  /** Limit applied after local re-aggregation and sorting (a flag's "top 10"). */
  displayLimit?: number;
  /**
   * Whether selections on this flag's own fields filter the flag itself. False for filter
   * flags, so a picker keeps offering every value while one is selected.
   */
  selfFilter: boolean;
  estimatedRows: number;
  notes: string[];
  /** Set when the flag compares with an earlier window: which "last" filter gets shifted. */
  compare?: { kind: Comparison; filter: number };
  /** Show values as a share of the total. */
  share?: boolean;
}

export type PlanResult = { ok: true; plan: QueryPlan } | { ok: false; error: string };

export interface PlanOptions {
  rowCap?: number;
}

/** Dimension keys a user can select on this hoist: filter flags and flags that filter the page. */
export function selectableKeys(hoist: Hoist): DimensionRef[] {
  const out: DimensionRef[] = [];
  for (const f of hoist.flags) {
    if (!f.binding) continue;
    if (f.kind !== 'filter' && f.behavior.onClick !== 'filter-page') continue;
    for (const d of f.binding.dimensions) if (!out.some((x) => dimensionKey(x) === dimensionKey(d))) out.push(d);
  }
  return out;
}

export function planFlag(hoist: Hoist, flag: Flag, index: CatalogIndex, options: PlanOptions = {}): PlanResult {
  const rowCap = options.rowCap ?? DEFAULT_ROW_CAP;
  const b = flag.binding;
  if (!b) return { ok: false, error: 'This flag has no data binding yet.' };
  const notes: string[] = [];

  // One source and one table per query in v1. Joins come with the catalog's relationships.
  const tables = new Set<string>();
  let source: string | undefined;
  const useSource = (s: string, t: string, what: string): string | null => {
    if (source && source !== s) return `${what} is in a different source; a flag reads from one source.`;
    source = s;
    tables.add(t);
    return tables.size > 1 ? `${what} is in another table; joining tables is not supported yet.` : null;
  };
  for (const key of b.metrics) {
    const m = index.metric(key);
    if (!m) return { ok: false, error: `Unknown metric "${key}".` };
    const t = metricTable(index, m);
    if (!t) return { ok: false, error: `Metric "${key}" has no table.` };
    const problem = useSource(m.source, t, `Metric "${m.label}"`);
    if (problem) return { ok: false, error: problem };
  }
  for (const d of b.dimensions) {
    const f = index.field(d.field);
    if (!f) return { ok: false, error: `Unknown field "${d.field}".` };
    const problem = useSource(f.source, f.table, `Field "${f.label}"`);
    if (problem) return { ok: false, error: problem };
  }
  const table = [...tables][0];
  if (!source || !table) return { ok: false, error: 'This flag binds nothing that can be queried.' };

  const sameTable = (fieldKey: string): boolean => {
    const f = index.field(fieldKey);
    return !!f && f.source === source && f.table === table;
  };

  // Filters: the hoist's fixed filters, then the flag's own. Fixed filters on other tables
  // cannot apply here and are reported rather than silently dropped.
  const filters: Filter[] = [];
  for (const f of hoist.filters) {
    if (flag.behavior.ignore.includes(f.field)) continue;
    if (sameTable(f.field)) filters.push(f);
    else notes.push(`Page filter on "${labelOf(index, f.field)}" does not apply: it is in another table.`);
  }
  for (const f of b.filters) {
    if (!sameTable(f.field)) return { ok: false, error: `Filter on "${labelOf(index, f.field)}" is in another table.` };
    filters.push(f);
  }

  // Aggregates, as re-aggregable partials.
  const aggregates: PlannedAggregate[] = [];
  const metrics: PlannedMetric[] = [];
  const partial = (fn: Partial, field: string | null): string => {
    const found = aggregates.find((a) => a.fn === fn && a.field === field);
    if (found) return found.alias;
    const alias = `a${aggregates.length}`;
    aggregates.push({ alias, fn, field });
    return alias;
  };
  let reaggregable = true;
  for (const key of b.metrics) {
    const m = index.metric(key)!;
    const field = m.field ?? null;
    const pm: PlannedMetric = { key, agg: m.agg, parts: {} };
    if (m.agg === 'sum') pm.parts.sum = partial('sum', field);
    else if (m.agg === 'count') pm.parts.count = partial('count', field);
    else if (m.agg === 'min') pm.parts.min = partial('min', field);
    else if (m.agg === 'max') pm.parts.max = partial('max', field);
    else if (m.agg === 'avg') {
      pm.parts.sum = partial('sum', field);
      pm.parts.count = partial('count', field);
    } else {
      pm.parts.distinct = partial('count_distinct', field);
      reaggregable = false;
    }
    metrics.push(pm);
  }

  // Own dimensions, then candidate slices.
  const dimensions: PlannedDimension[] = b.dimensions.map((d, i) => ({ alias: `d${i}`, key: dimensionKey(d), ...d }));
  const own = dimensions.map((d) => d.key);
  const ownFields = new Set(b.dimensions.map((d) => d.field));
  const candidates: DimensionRef[] = [];
  const live: string[] = [];
  for (const d of selectableKeys(hoist)) {
    const key = dimensionKey(d);
    if (own.includes(key)) continue;
    if (flag.behavior.ignore.includes(d.field)) continue;
    if (!sameTable(d.field)) continue; // Selections on other tables do not reach this flag in v1.
    if (!reaggregable) {
      live.push(key);
      continue;
    }
    if (ownFields.has(d.field)) {
      // Same field at another grain (e.g. month vs quarter). Slicing works, but say so.
      notes.push(`Also split by ${labelOf(index, d.field)} at ${d.grain ?? 'value'} level for page selections.`);
    }
    candidates.push(d);
  }
  if (!reaggregable && live.length > 0) {
    notes.push('A distinct count cannot be re-added after filtering, so page selections re-query the source.');
  }

  const ownRows = estimateRows(b.dimensions, filters, index);
  if (ownRows > rowCap) notes.push(`This flag could return about ${fmt(ownRows)} rows; only the first ${fmt(rowCap)} are fetched.`);

  // Add slices cheapest first while the estimate stays under the cap.
  const sized = candidates
    .map((d) => ({ d, card: dimCardinality(d, filters, index) }))
    .sort((x, y) => x.card - y.card || dimensionKey(x.d).localeCompare(dimensionKey(y.d)));
  const chosen: DimensionRef[] = [];
  let estimate = ownRows;
  for (const { d, card } of sized) {
    if (estimate * card <= rowCap) {
      chosen.push(d);
      estimate *= card;
    } else {
      live.push(dimensionKey(d));
      notes.push(`Selections on ${labelOf(index, d.field)} re-query the source (pre-splitting would exceed ${fmt(rowCap)} rows).`);
    }
  }
  for (const d of chosen) dimensions.push({ alias: `d${dimensions.length}`, key: dimensionKey(d), ...d });

  const plan: QueryPlan = {
    flagId: flag.id,
    source,
    table,
    dimensions,
    aggregates,
    metrics,
    filters,
    own,
    slices: chosen.map(dimensionKey),
    live,
    limit: rowCap,
    rowCap,
    selfFilter: flag.kind !== 'filter',
    estimatedRows: Math.min(estimate, Number.MAX_SAFE_INTEGER),
    notes,
  };
  if (b.sort) plan.sort = b.sort;
  if (b.share) plan.share = true;
  if (b.compare) {
    // The flag's own "last" filter wins over the page's, so search from the end.
    let at = -1;
    for (let i = filters.length - 1; i >= 0; i--) if (filters[i]!.op === 'last') {
      at = i;
      break;
    }
    if (at >= 0) plan.compare = { kind: b.compare, filter: at };
    else notes.push('A comparison needs a "last N" date filter on the flag or the page, so it is not shown.');
  }
  if (b.limit) {
    // Always cut locally too: Access's TOP n returns ties, so the source may send more than n.
    plan.displayLimit = b.limit;
    // A "top N" is cut at the source only when nothing is re-aggregated locally, and not when it
    // ranks by an average (SQL would rank by the sum the average is rebuilt from).
    const sortAgg = b.sort ? index.metric(b.sort.by)?.agg : undefined;
    if (chosen.length === 0 && sortAgg !== 'avg') {
      plan.limit = Math.min(b.limit, rowCap);
      // The cut result holds only the top N, so selecting a value outside it needs the source.
      const selectable = new Set(selectableKeys(hoist).map(dimensionKey));
      for (const k of own) if (selectable.has(k) && !live.includes(k)) live.push(k);
    }
  }
  return { ok: true, plan };
}

const GRAIN_DEFAULT: Record<TimeGrain, number> = { year: 10, quarter: 40, month: 120, week: 520, day: 3650 };
const UNKNOWN_CARDINALITY = 100;

export function dimCardinality(d: DimensionRef, filters: readonly Filter[], index: CatalogIndex): number {
  const field = index.field(d.field);
  const inFilter = filters.find((f) => f.field === d.field && f.op === 'in');
  if (inFilter) return inFilter.values.length;
  if (filters.some((f) => f.field === d.field && f.op === 'eq')) return 1;
  if (d.grain) {
    const last = filters.find((f) => f.field === d.field && f.op === 'last');
    if (last && last.unit && typeof last.values[0] === 'number') return periodsIn(last.values[0], last.unit, d.grain);
    const byGrain = GRAIN_DEFAULT[d.grain];
    return field?.cardinality ? Math.min(field.cardinality, byGrain) : byGrain;
  }
  return field?.cardinality ?? UNKNOWN_CARDINALITY;
}

export function estimateRows(dims: readonly DimensionRef[], filters: readonly Filter[], index: CatalogIndex): number {
  return dims.reduce((n, d) => n * dimCardinality(d, filters, index), 1);
}

/**
 * Upper bound on how many `grain` periods "the last n `unit`s" touches. When the units differ,
 * one extra period is allowed for a partial period at the edge.
 */
export function periodsIn(n: number, unit: TimeGrain, grain: TimeGrain): number {
  const days: Record<TimeGrain, number> = { day: 1, week: 7, month: 31, quarter: 92, year: 366 };
  if (unit === grain) return n;
  return Math.ceil((n * days[unit]) / days[grain]) + 1;
}

function labelOf(index: CatalogIndex, key: string): string {
  return index.field(key)?.label ?? key;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The plan for a flag's comparison window: the same query with its "last N" filter replaced by
 * the earlier window. Like for like: "last 3 months" on 26 October compares 1 August–26 October
 * with 1 May–26 July (previous-period) or 1 August–26 October a year earlier (previous-year).
 * Every row is fetched so each category on screen can find its earlier value.
 */
export function comparisonPlan(plan: QueryPlan, today: Date = new Date()): QueryPlan | null {
  if (!plan.compare) return null;
  const f = plan.filters[plan.compare.filter];
  if (!f || f.op !== 'last' || !f.unit || typeof f.values[0] !== 'number') return null;
  const window = comparisonWindow(f.values[0], f.unit, plan.compare.kind, today);
  const filters = plan.filters.map((x, i) => (i === plan.compare!.filter ? { field: x.field, op: 'between' as const, values: [window.from, window.to] } : x));
  const { compare: _drop, displayLimit: _cut, ...rest } = plan;
  return { ...rest, filters, limit: plan.rowCap, live: [...plan.live] };
}

/** The earlier window a comparison reads, as inclusive YYYY-MM-DD dates (UTC). */
export function comparisonWindow(n: number, unit: TimeGrain, kind: Comparison, today: Date): { from: string; to: string } {
  const start = periodStartUtc(today, unit, n - 1);
  if (kind === 'previous-year') return { from: ymd(shift(start, 'year', -1)), to: ymd(shift(utcDay(today), 'year', -1)) };
  return { from: ymd(shift(start, unit, -n)), to: ymd(shift(utcDay(today), unit, -n)) };
}

/**
 * Moves a time value from the comparison window forward onto the current one, re-truncated to
 * its grain, so lineUp() can match periods. Values of other dimensions pass through.
 */
export function comparisonShift(plan: QueryPlan): ((key: string, value: string | number | boolean | null) => string | number | boolean | null) | null {
  if (!plan.compare) return null;
  const f = plan.filters[plan.compare.filter];
  if (!f || f.op !== 'last' || !f.unit || typeof f.values[0] !== 'number') return null;
  const unit: TimeGrain = plan.compare.kind === 'previous-year' ? 'year' : f.unit;
  const by = plan.compare.kind === 'previous-year' ? 1 : f.values[0];
  const grains = new Map(plan.dimensions.filter((d) => d.grain).map((d) => [d.key, d.grain!]));
  return (key, value) => {
    const grain = grains.get(key);
    if (!grain || typeof value !== 'string') return value;
    const t = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(t)) return value;
    return ymd(periodStartUtc(shift(new Date(t), unit, by), grain, 0));
  };
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function periodStartUtc(today: Date, unit: TimeGrain, back: number): Date {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  switch (unit) {
    case 'day':
      return new Date(Date.UTC(y, m, d - back));
    case 'week':
      return new Date(Date.UTC(y, m, d - ((today.getUTCDay() + 6) % 7) - 7 * back));
    case 'month':
      return new Date(Date.UTC(y, m - back, 1));
    case 'quarter':
      return new Date(Date.UTC(y, Math.floor(m / 3) * 3 - 3 * back, 1));
    case 'year':
      return new Date(Date.UTC(y - back, 0, 1));
  }
}

/** Move a date by whole units; month ends clamp (31 May minus 3 months is 28 or 29 February). */
function shift(d: Date, unit: TimeGrain, by: number): Date {
  if (unit === 'day') return new Date(d.getTime() + by * 86_400_000);
  if (unit === 'week') return new Date(d.getTime() + by * 7 * 86_400_000);
  const months = unit === 'month' ? by : unit === 'quarter' ? 3 * by : 12 * by;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

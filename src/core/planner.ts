// The planner turns one flag into one source query, sized for a thin client.
//
// The source database does the aggregation, so only summarised rows come back. Each flag's
// query is also split ("pre-sliced") by the fields other flags on the page can select, which
// lets a click elsewhere filter this flag locally with no round trip. Slices that would make
// the result too large are dropped; selections on those fields go back to the source instead.

import { type Aggregate, type CatalogIndex, type Metric, metricTable } from './catalog.ts';
import { dayStart } from './dates.ts';
import { baseInputs, type FormulaNode, type FormulaOp, parseFormula } from './formula.ts';
import { type Comparison, type DimensionRef, type Filter, type Flag, type Hoist, type TimeGrain, dimensionKey } from './hoist.ts';
import { type PlannedJoin, planJoins } from './joins.ts';
import { type ManyJoin, ManyScope, buildManyJoin } from './manyjoin.ts';

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

export type MetricParts = { sum?: string; count?: string; min?: string; max?: string; distinct?: string };

export interface PlannedMetric {
  key: string;
  agg: Aggregate;
  /** Partial aliases the displayed value is rebuilt from. avg uses sum and count. */
  parts: MetricParts;
  /** For a formula: its tree, with every input measure (through nested formulas) as a leaf of partials. */
  expr?: PlannedExpr;
}

/** A formula as planned: numbers, operators and plain measures read from the query's partials. */
export type PlannedExpr =
  | { t: 'num'; v: number }
  | { t: 'neg'; x: PlannedExpr }
  | { t: 'bin'; op: FormulaOp; l: PlannedExpr; r: PlannedExpr }
  | { t: 'leaf'; key: string; agg: Exclude<Aggregate, 'formula'>; parts: MetricParts; seen?: string };

/** Every plain measure a planned metric reads: itself, or the leaves of its formula. */
export function planLeaves(m: PlannedMetric): Array<{ agg: Aggregate; parts: MetricParts }> {
  if (!m.expr) return [m];
  const out: Array<{ agg: Aggregate; parts: MetricParts }> = [];
  const walk = (e: PlannedExpr): void => {
    if (e.t === 'leaf') out.push(e);
    else if (e.t === 'neg') walk(e.x);
    else if (e.t === 'bin') (walk(e.l), walk(e.r));
  };
  walk(m.expr);
  return out;
}

export interface QueryPlan {
  flagId: string;
  source: string;
  /** The base table: where the measures are. */
  table: string;
  /** Related tables joined in for fields to group or filter by (many-to-one only). */
  joins?: PlannedJoin[];
  /**
   * Set when a measure on the one side is split or filtered by a many-side field (manyjoin.ts):
   * the many side is reduced to distinct (key, group) pairs first, so no row is counted twice.
   */
  many?: ManyJoin;
  /** Read fields as stored, without the catalog's cleaning steps (data-quality profiling). */
  raw?: boolean;
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
  /**
   * Set when the measures come from several tables (across.ts, a drill-across): one query per table,
   * each grouped and filtered the same way, their rows lined up by the group values. The plan's own
   * table, joins and many side are then the parts'; dimensions, filters and aggregates are shared.
   */
  across?: AcrossPart[];
  /** Set when the flag compares with an earlier window: which "last" filter gets shifted. */
  compare?: { kind: Comparison; filter: number };
  /** Show values as a share of the total. */
  share?: boolean;
}

/** One table of a drill-across plan: what it reads its measures through, and which aggregates it gives. */
export interface AcrossPart {
  table: string;
  joins?: PlannedJoin[];
  many?: ManyJoin;
  /** The plan's aggregates computed on this table. */
  aggregates: PlannedAggregate[];
  /** Its COUNT(*): null in a lined-up row when the group has no rows in this table. */
  seen: string;
}

/** The query one table of a drill-across plan runs: the plan's groups and filters over that table. */
export function acrossPart(plan: QueryPlan, part: AcrossPart): QueryPlan {
  const { across: _a, joins: _j, many: _m, sort: _s, displayLimit: _d, ...rest } = plan;
  return { ...rest, table: part.table, aggregates: part.aggregates, metrics: [], limit: plan.rowCap, ...(part.joins ? { joins: part.joins } : {}), ...(part.many ? { many: part.many } : {}) };
}

/** Every table a plan reads (its parts', for a drill-across). */
export function planTables(plan: QueryPlan): string[] {
  return (plan.across ?? [plan]).flatMap((p) => [p.table, ...(p.joins ?? []).map((j) => j.table), ...(p.many?.tables ?? [])]);
}

/** Whether a row can sit in several groups (a split by a many-side field), so groups do not add up. */
export function overlaps(plan: QueryPlan): boolean {
  return (plan.across ?? [plan]).some((p) => !!p.many?.overlap);
}

/**
 * `reason` is set when the refusal is about a one-to-many join (ambiguous path, unsafe share), or
 * when the planning of measures from several tables is still loading (loadAcross, then plan again).
 */
export type PlanResult = { ok: true; plan: QueryPlan } | { ok: false; error: string; reason?: 'many-side' | 'loading' };

// Planning measures from several tables (across.ts) loads on first use, to keep the start small.
type Across = typeof import('./across.ts');
let across: Across | null = null;
const ACROSS_LOADING = 'Measures from several tables are still loading; try again in a moment.';

export function registerAcross(impl: Across): void {
  across = impl;
}

/** Loads the planning of measures from several tables; planFlag starts it itself when a flag needs it. */
export async function loadAcross(): Promise<void> {
  across ??= await import('./across.ts');
}

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

  // One source per query. Measures come from one table, the base; fields to group or filter by
  // may come from tables the base reaches through the catalog's relationships (joins.ts). Measures
  // (or a formula's inputs) from several tables are read one query per table (across.ts).
  let source: string | undefined;
  const tables: string[] = [];
  for (const key of b.metrics) {
    const m = index.metric(key);
    if (!m) return { ok: false, error: `Unknown metric "${key}".` };
    const inputs = m.agg === 'formula' ? baseInputs(key, index.metric) : [m];
    if (!inputs.length) return { ok: false, error: `Metric "${key}" has no table.` };
    for (const x of inputs) {
      const t = metricTable(index, x);
      if (!t) return { ok: false, error: `Metric "${x.key}" has no table.` };
      if (source && source !== x.source) {
        return { ok: false, error: x === m ? `Metric "${m.label}" is in a different source; a flag reads from one source.` : `"${m.label}" reads "${x.label}" from a different source; a flag, and a formula's inputs, read one source.` };
      }
      source = x.source;
      if (!tables.includes(t)) tables.push(t);
    }
  }
  if (tables.length > 1) {
    if (!across) {
      void loadAcross().catch(() => undefined);
      return { ok: false, error: ACROSS_LOADING, reason: 'loading' };
    }
    return across.planAcross(hoist, flag, index, options, tables, { plan: planFlag, metrics: planMetrics });
  }
  let table = tables[0];
  for (const d of b.dimensions) {
    const f = index.field(d.field);
    if (!f) return { ok: false, error: `Unknown field "${d.field}".` };
    if (source && source !== f.source) return { ok: false, error: `Field "${f.label}" is in a different source; a flag reads from one source.` };
    source = f.source;
    table ??= f.table;
  }
  if (!source || !table) return { ok: false, error: 'This flag binds nothing that can be queried.' };
  const base = table;
  const joined = new Set<string>();
  const manyTables = new Set<string>();
  // The many side of the base (opposite direction to joins.ts) is only searched when the base
  // holds the flag's measures: a measure on the one side, split by a many-side field.
  const scope = new ManyScope(index, source, base, b.metrics.length > 0);

  /** Whether a field can be read in this flag's query: its base table, or a table related to it. */
  const inScope = (fieldKey: string): boolean => {
    const f = index.field(fieldKey);
    return !!f && f.source === source && ['base', 'forward', 'many'].includes(scope.reach(f.table).kind);
  };
  const isMany = (fieldKey: string): boolean => {
    const f = index.field(fieldKey);
    return !!f && f.source === source && scope.isMany(f.table);
  };
  const use = (fieldKey: string): void => {
    const t = index.field(fieldKey)!.table;
    if (isMany(fieldKey)) manyTables.add(t);
    else if (t !== base) joined.add(t);
  };
  const refused = (fieldKey: string): PlanResult | null => {
    const error = scope.ambiguity(fieldKey);
    return error ? { ok: false, error, reason: 'many-side' } : null;
  };
  for (const d of b.dimensions) {
    const no = refused(d.field);
    if (no) return no;
    if (!inScope(d.field)) {
      return { ok: false, error: `"${labelOf(index, d.field)}" is in a table not related to ${base}. Add a relationship under Data > Relationships.` };
    }
    use(d.field);
  }

  // Filters: the hoist's fixed filters, then the flag's own. Fixed filters on unrelated tables
  // cannot apply here and are reported rather than silently dropped.
  const filters: Filter[] = [];
  for (const f of hoist.filters) {
    if (flag.behavior.ignore.includes(f.field)) continue;
    const no = refused(f.field);
    if (no) return no;
    if (inScope(f.field)) {
      filters.push(f);
      use(f.field);
    } else notes.push(`Page filter on "${labelOf(index, f.field)}" does not apply: it is in a table not related to this one.`);
  }
  for (const f of b.filters) {
    const no = refused(f.field);
    if (no) return no;
    if (!inScope(f.field)) return { ok: false, error: `Filter on "${labelOf(index, f.field)}" is in a table not related to ${base}.` };
    filters.push(f);
    use(f.field);
  }

  // Aggregates, as re-aggregable partials.
  const aggregates: PlannedAggregate[] = [];
  const partial = (fn: Partial, m: Metric): string => {
    const field = m.field ?? null;
    const found = aggregates.find((a) => a.fn === fn && a.field === field);
    if (found) return found.alias;
    const alias = `a${aggregates.length}`;
    aggregates.push({ alias, fn, field });
    return alias;
  };
  const metrics = planMetrics(index, b.metrics, partial);
  if (typeof metrics === 'string') return { ok: false, error: metrics };
  const reaggregable = !aggregates.some((a) => a.fn === 'count_distinct');

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
    if (scope.ambiguity(d.field)) {
      notes.push(`Selections on ${labelOf(index, d.field)} do not reach this flag: it relates to ${base} in more than one way.`);
      continue;
    }
    if (!inScope(d.field)) continue; // Selections on unrelated tables do not reach this flag.
    if (isMany(d.field)) {
      // A one-side row can sit in several many-side groups, so adding groups back up locally would
      // count it twice. Selections on a many-side field go back to the source as a filter instead.
      live.push(key);
      const note = `Selections on ${labelOf(index, d.field)} re-query the source (a row can appear in several of its groups, so they cannot be re-added locally).`;
      if (!notes.includes(note)) notes.push(note);
      continue;
    }
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
  for (const d of chosen) {
    dimensions.push({ alias: `d${dimensions.length}`, key: dimensionKey(d), ...d });
    use(d.field);
  }

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
  if (joined.size) plan.joins = planJoins(index, source, base, joined);
  if (manyTables.size) {
    const label = (k: string) => labelOf(index, k);
    const splitBy = [...new Set(dimensions.filter((d) => isMany(d.field)).map((d) => label(d.field)))];
    const built = buildManyJoin(index, source, base, [...manyTables], {
      splitBy,
      filterBy: [...new Set(filters.filter((f) => isMany(f.field)).map((f) => label(f.field)))],
    });
    if (!built.ok) return { ok: false, error: built.error, reason: 'many-side' };
    if (b.share && built.many.overlap) {
      return {
        ok: false,
        reason: 'many-side',
        error: `A share of the total cannot be shown when splitting by ${splitBy.join(', ')}: a row can appear in several groups, so the groups do not add up to a true total. Show the values instead, or filter rather than split.`,
      };
    }
    plan.many = built.many;
    notes.push(...built.many.warnings);
  }
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
    // A "top N" is cut at the source only when nothing is re-aggregated locally, not when it
    // ranks by an average (SQL would rank by the sum the average is rebuilt from), and not when
    // values are shown as a share of the total (the total is taken across every row, before the cut).
    // A formula is computed locally too, so it is ranked there.
    const sortAgg = b.sort ? index.metric(b.sort.by)?.agg : undefined;
    if (chosen.length === 0 && sortAgg !== 'avg' && sortAgg !== 'formula' && !b.share) {
      plan.limit = Math.min(b.limit, rowCap);
      // The cut result holds only the top N, so selecting a value outside it needs the source.
      const selectable = new Set(selectableKeys(hoist).map(dimensionKey));
      for (const k of own) if (selectable.has(k) && !live.includes(k)) live.push(k);
    }
  }
  return { ok: true, plan };
}

class PlanRefusal extends Error {}

/**
 * The flag's measures as planned: each plain measure as its partials (`partial` names one), a
 * formula as a tree whose leaves are its plain inputs, nested formulas folded in. `seen` gives each
 * leaf the alias that says its table has rows in a group (a drill-across). A message when a formula
 * cannot be read.
 */
export function planMetrics(index: CatalogIndex, keys: readonly string[], partial: (fn: Partial, m: Metric) => string, seen?: (m: Metric) => string): PlannedMetric[] | string {
  const plain = (m: Metric): MetricParts => {
    const parts: MetricParts = {};
    if (m.agg === 'sum') parts.sum = partial('sum', m);
    else if (m.agg === 'count') parts.count = partial('count', m);
    else if (m.agg === 'min') parts.min = partial('min', m);
    else if (m.agg === 'max') parts.max = partial('max', m);
    else if (m.agg === 'avg') {
      parts.sum = partial('sum', m);
      parts.count = partial('count', m);
    } else parts.distinct = partial('count_distinct', m);
    return parts;
  };
  // A formula's inputs become hidden partials; nested formulas are folded into one tree.
  const expand = (node: FormulaNode, path: string[]): PlannedExpr => {
    if (node.t === 'num') return node;
    if (node.t === 'neg') return { t: 'neg', x: expand(node.x, path) };
    if (node.t === 'bin') return { t: 'bin', op: node.op, l: expand(node.l, path), r: expand(node.r, path) };
    const m = index.metric(node.key);
    if (!m || path.includes(node.key)) throw new PlanRefusal(`The formula of "${index.metric(path[0]!)?.label ?? path[0]}" cannot be read: check its measures under Data > Measures.`);
    if (m.agg !== 'formula') return { t: 'leaf', key: m.key, agg: m.agg, parts: plain(m), ...(seen ? { seen: seen(m) } : {}) };
    const p = parseFormula(m.formula ?? '');
    if (!p.ok) throw new PlanRefusal(`The formula of "${m.label}" cannot be read: ${p.error}`);
    return expand(p.node, [...path, node.key]);
  };
  try {
    return keys.map((key): PlannedMetric => {
      const m = index.metric(key)!;
      return m.agg === 'formula' ? { key, agg: 'formula', parts: {}, expr: expand({ t: 'ref', key }, []) } : { key, agg: m.agg, parts: plain(m) };
    });
  } catch (e) {
    if (e instanceof PlanRefusal) return e.message;
    throw e;
  }
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
    const day = dayStart(value); // the calendar day the text names, whatever zone it carries (dates.ts)
    if (day === null) return value;
    return ymd(periodStartUtc(shift(day, unit, by), grain, 0));
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

// Runs a query plan against rows held in memory. This is the "database" for the sample data and
// for CSV files read in the browser, so a hoist works the same way before any server or source
// exists. It answers exactly what renderSql() would ask a database for: the plan's dimensions
// (dates truncated to their grain), its aggregate partials, its filters, sort and row limit.

import type { CatalogIndex, FieldType } from './catalog.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import type { QueryPlan } from './planner.ts';
import type { Cell, ResultRow } from './crossfilter.ts';
import { cleanType, cleanValue, dedupes, stepsFor } from './cleaning.ts';
import { hasMaking, reshapedTable, reshaping } from './reshape.ts';
import { calendarDay, dayStart } from './dates.ts';
import { aliasOf, BASE_ALIAS } from './joins.ts';
import { type ManyRows, prepareManyRows } from './manyjoin.ts';
import { periodStart, TILES_ELSEWHERE } from './sql.ts';

/** Rows per table, keyed by the catalog's table name. Values are keyed by column name. */
export type TableRows = Record<string, ReadonlyArray<Record<string, Cell>>>;

export interface RunResult {
  rows: ResultRow[];
  truncated: boolean;
  ms: number;
}

export class EngineError extends Error {}

export function runPlan(plan: QueryPlan, index: CatalogIndex, stored: TableRows, today: Date = new Date()): RunResult {
  const started = Date.now();
  const making = hasMaking(index.catalog);
  const tables = making ? withReshaped(plan, index, stored) : stored;
  const loaded = tables[plan.table];
  if (!loaded) throw new EngineError(`No rows are loaded for table "${plan.table}".`);
  const source = !plan.raw && dedupes(index, plan.source, plan.table) ? distinctRows(loaded) : loaded;

  // A joined row is the base row and, per join, the matching row of the related table (or none,
  // as with LEFT JOIN). Related tables are looked up by key; a key that appears twice keeps its
  // first row, so a join never repeats a base row.
  const joins = plan.joins ?? [];
  const lookups = joins.map((j) => {
    const rows = tables[j.table];
    if (!rows) throw new EngineError(`No rows are loaded for table "${j.table}".`);
    const byKey = new Map<string, Record<string, Cell>>();
    for (const r of rows) {
      const k = r[j.column];
      if (k === null || k === undefined || k === '') continue;
      if (!byKey.has(String(k))) byKey.set(String(k), r);
    }
    return byKey;
  });
  const slot = new Map<string, number>([[BASE_ALIAS, 0]]);
  joins.forEach((j, i) => slot.set(j.alias, i + 1));
  type Joined = Array<Record<string, Cell> | undefined>;
  const joinRow = (base: Record<string, Cell>): Joined => {
    const out: Joined = [base];
    joins.forEach((j, i) => {
      const left = out[slot.get(j.left.alias)!];
      const k = left?.[j.left.column];
      out.push(k === null || k === undefined ? undefined : lookups[i]!.get(String(k)));
    });
    return out;
  };

  const col = (fieldKey: string): { get: (row: Joined) => Cell; type: FieldType } => {
    const f = index.field(fieldKey);
    if (!f) throw new EngineError(`Unknown field "${fieldKey}".`);
    const alias = f.source === plan.source ? aliasOf(plan.table, joins, f.table) : undefined;
    if (!alias) throw new EngineError(`Field "${fieldKey}" is not in ${plan.table} or a table joined to it.`);
    const at = slot.get(alias)!;
    const type = plan.raw ? f.type : cleanType(index, fieldKey);
    if (making) {
      // Fields made by a step (reshape-impl.ts). Equal-count groups rank every row of the base table, as the SQL's inner query does.
      const r = reshaping();
      if (r.usesTiles(index, fieldKey) && (f.table !== plan.table || plan.many)) throw new EngineError(TILES_ELSEWHERE);
      const read = r.fieldReader(index, fieldKey, !!plan.raw, (t) => (t === plan.table ? source : (tables[t] ?? [])));
      return { get: (row) => read(row[at]), type };
    }
    const steps = plan.raw ? [] : stepsFor(index, fieldKey);
    const read = (row: Joined): Cell => row[at]?.[f.column] ?? null;
    return { get: steps.length ? (row) => cleanValue(steps, read(row)) : read, type };
  };

  // A one-to-many split: each one-side row expands to the distinct many-side groups it belongs to
  // (manyjoin.ts), and filters on the many side are applied while those groups are built.
  const many: ManyRows | null = plan.many ? prepareManyRows(plan, index, tables, today, joins.length + 1, { filterTest, truncateDate, EngineError }) : null;
  const tests = plan.filters.filter((f) => !many?.owns(f.field)).map((f) => filterTest(f, col(f.field), today));
  const dims = plan.dimensions.map((d) => {
    const fromMany = many?.dim(d);
    return fromMany ? { alias: d.alias, get: fromMany, grain: undefined } : { alias: d.alias, get: col(d.field).get, grain: d.grain };
  });
  const aggs = plan.aggregates.map((a) => ({ alias: a.alias, fn: a.fn, get: a.field === null ? null : col(a.field).get }));

  interface Group {
    dims: Record<string, Cell>;
    acc: Record<string, number | null>;
    distinct: Record<string, Set<string>>;
  }
  const groups = new Map<string, Group>();
  const joinedRows = function* () {
    for (const base of source) {
      const row = joinRow(base);
      if (many) yield* many.expand(row);
      else yield row;
    }
  };
  for (const row of joinedRows()) {
    if (!tests.every((t) => t(row))) continue;
    const values = dims.map((d) => {
      const v = d.get(row);
      return d.grain ? truncateDate(v, d.grain) : v;
    });
    const key = JSON.stringify(values);
    let g = groups.get(key);
    if (!g) {
      g = { dims: {}, acc: {}, distinct: {} };
      dims.forEach((d, i) => (g!.dims[d.alias] = values[i] ?? null));
      for (const a of aggs) {
        g.acc[a.alias] = a.fn === 'count' || a.fn === 'count_distinct' ? 0 : null;
        if (a.fn === 'count_distinct') g.distinct[a.alias] = new Set();
      }
      groups.set(key, g);
    }
    for (const a of aggs) {
      const raw = a.get === null ? 1 : a.get(row);
      if (raw === null || raw === '') continue;
      if (a.fn === 'count') {
        g.acc[a.alias] = (g.acc[a.alias] ?? 0) + 1;
        continue;
      }
      if (a.fn === 'count_distinct') {
        g.distinct[a.alias]!.add(String(raw));
        continue;
      }
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) continue;
      const prev = g.acc[a.alias];
      if (prev === null || prev === undefined) g.acc[a.alias] = n;
      else if (a.fn === 'sum') g.acc[a.alias] = prev + n;
      else if (a.fn === 'min') g.acc[a.alias] = Math.min(prev, n);
      else if (a.fn === 'max') g.acc[a.alias] = Math.max(prev, n);
    }
  }

  let rows: ResultRow[] = [...groups.values()].map((g) => {
    const r: ResultRow = { ...g.dims };
    for (const a of aggs) r[a.alias] = a.fn === 'count_distinct' ? g.distinct[a.alias]!.size : (g.acc[a.alias] ?? null);
    return r;
  });
  // SQL with aggregates and no GROUP BY returns one row even when nothing matched.
  if (dims.length === 0 && rows.length === 0 && aggs.length > 0) {
    const r: ResultRow = {};
    for (const a of aggs) r[a.alias] = a.fn === 'count' || a.fn === 'count_distinct' ? 0 : null;
    rows = [r];
  }

  if (plan.sort) {
    const dim = plan.dimensions.find((d) => d.key === plan.sort!.by);
    const metric = plan.metrics.find((m) => m.key === plan.sort!.by);
    const alias = dim?.alias ?? (metric && metric.agg !== 'avg' ? (metric.parts.sum ?? metric.parts.count ?? metric.parts.min ?? metric.parts.max ?? metric.parts.distinct) : undefined);
    if (alias) {
      const sign = plan.sort.dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => compareCells(a[alias] ?? null, b[alias] ?? null) * sign);
    }
  }
  const limit = Math.max(1, Math.floor(plan.limit));
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);
  return { rows, truncated, ms: Date.now() - started };
}

/** The stored tables, plus the reshaped tables (unpivot steps) this plan reads, built from theirs. */
function withReshaped(plan: QueryPlan, index: CatalogIndex, stored: TableRows): TableRows {
  let out = stored;
  for (const name of [plan.table, ...(plan.joins ?? []).map((j) => j.table)]) {
    const step = reshapedTable(index, plan.source, name);
    if (!step || stored[name]) continue;
    const from = stored[index.field(step.field)!.table];
    if (!from) continue;
    const r = reshaping();
    out = { ...out, [name]: r.unpivotRows(index, step, r.dedupesStored(index, step) ? distinctRows(from) : from) };
  }
  return out;
}

export function filterTest<R>(f: Filter, c: { get: (row: R) => Cell; type: FieldType }, today: Date): (row: R) => boolean {
  const get = c.get;
  if (c.type === 'date') {
    // Filter values are YYYY-MM-DD (or longer text whose first ten characters are); cells read as the calendar day they name.
    const day = (v: unknown) => String(v).slice(0, 10);
    const val = (row: R) => calendarDay(get(row));
    switch (f.op) {
      case 'eq':
        return (r) => val(r) === day(f.values[0]);
      case 'in': {
        const set = new Set(f.values.map(day));
        return (r) => set.has(val(r) ?? '');
      }
      case 'gte':
        return (r) => (val(r) ?? '') >= day(f.values[0]);
      case 'lte':
        return (r) => {
          const v = val(r);
          return v !== null && v <= day(f.values[0]);
        };
      case 'between':
        return (r) => {
          const v = val(r);
          return v !== null && v >= day(f.values[0]) && v <= day(f.values[1]);
        };
      case 'last': {
        const from = periodStart(today, f.unit as TimeGrain, Number(f.values[0]) - 1);
        return (r) => (val(r) ?? '') >= from;
      }
    }
  }
  const num = c.type === 'number';
  const norm = (v: unknown): string | number | boolean | null => {
    if (v === null || v === undefined || v === '') return null;
    if (num) return typeof v === 'number' ? v : Number(v);
    if (c.type === 'boolean') return v === true || v === 'true' || v === 1;
    return String(v);
  };
  // A value that is not a number on a number field matches nothing (NaN would otherwise match
  // every non-numeric cell, since a Set treats NaN as equal to NaN).
  const values = f.values.map(norm).filter((v) => !(typeof v === 'number' && Number.isNaN(v)));
  switch (f.op) {
    case 'eq':
      return (r) => norm(get(r)) === values[0];
    case 'in': {
      const set = new Set(values);
      return (r) => {
        const v = norm(get(r));
        return !(typeof v === 'number' && Number.isNaN(v)) && set.has(v);
      };
    }
    case 'gte':
      return (r) => {
        const v = norm(get(r));
        return v !== null && v >= values[0]!;
      };
    case 'lte':
      return (r) => {
        const v = norm(get(r));
        return v !== null && v <= values[0]!;
      };
    case 'between':
      return (r) => {
        const v = norm(get(r));
        return v !== null && v >= values[0]! && v <= values[1]!;
      };
    case 'last':
      return () => false;
  }
}

/**
 * Start of the period a date falls in, as YYYY-MM-DD. Weeks start on Monday. The cell's calendar
 * text decides the day (dates.ts), so a row a filter keeps lands in the bucket the filter named.
 */
export function truncateDate(v: Cell, grain: TimeGrain): Cell {
  const day = dayStart(v);
  return day === null ? null : periodStart(day, grain, 0);
}

function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

/** Rows with exact duplicates removed, first one kept (a dedupe cleaning step). */
function distinctRows(rows: ReadonlyArray<Record<string, Cell>>): Array<Record<string, Cell>> {
  const seen = new Set<string>();
  const out: Array<Record<string, Cell>> = [];
  for (const r of rows) {
    const k = JSON.stringify(Object.keys(r).sort().map((c) => r[c] ?? null));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

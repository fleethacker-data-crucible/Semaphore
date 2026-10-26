// Runs a query plan against rows held in memory. This is the "database" for the sample data and
// for CSV files read in the browser, so a hoist works the same way before any server or source
// exists. It answers exactly what renderSql() would ask a database for: the plan's dimensions
// (dates truncated to their grain), its aggregate partials, its filters, sort and row limit.

import type { CatalogIndex, FieldType } from './catalog.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import type { QueryPlan } from './planner.ts';
import type { Cell, ResultRow } from './crossfilter.ts';
import { periodStart } from './sql.ts';

/** Rows per table, keyed by the catalog's table name. Values are keyed by column name. */
export type TableRows = Record<string, ReadonlyArray<Record<string, Cell>>>;

export interface RunResult {
  rows: ResultRow[];
  truncated: boolean;
  ms: number;
}

export class EngineError extends Error {}

export function runPlan(plan: QueryPlan, index: CatalogIndex, tables: TableRows, today: Date = new Date()): RunResult {
  const started = Date.now();
  const source = tables[plan.table];
  if (!source) throw new EngineError(`No rows are loaded for table "${plan.table}".`);
  const col = (fieldKey: string): { column: string; type: FieldType } => {
    const f = index.field(fieldKey);
    if (!f) throw new EngineError(`Unknown field "${fieldKey}".`);
    return { column: f.column, type: f.type };
  };

  const tests = plan.filters.map((f) => filterTest(f, col(f.field), today));
  const dims = plan.dimensions.map((d) => ({ alias: d.alias, column: col(d.field).column, grain: d.grain }));
  const aggs = plan.aggregates.map((a) => ({ alias: a.alias, fn: a.fn, column: a.field === null ? null : col(a.field).column }));

  interface Group {
    dims: Record<string, Cell>;
    acc: Record<string, number | null>;
    distinct: Record<string, Set<string>>;
  }
  const groups = new Map<string, Group>();
  for (const row of source) {
    if (!tests.every((t) => t(row))) continue;
    const values = dims.map((d) => {
      const v = row[d.column] ?? null;
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
      const raw = a.column === null ? 1 : (row[a.column] ?? null);
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

function filterTest(f: Filter, c: { column: string; type: FieldType }, today: Date): (row: Record<string, Cell>) => boolean {
  const get = (row: Record<string, Cell>) => row[c.column] ?? null;
  if (c.type === 'date') {
    const day = (v: unknown) => String(v).slice(0, 10);
    const val = (row: Record<string, Cell>) => {
      const v = get(row);
      return v === null ? null : day(v);
    };
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
  const values = f.values.map(norm);
  switch (f.op) {
    case 'eq':
      return (r) => norm(get(r)) === values[0];
    case 'in': {
      const set = new Set(values);
      return (r) => set.has(norm(get(r)));
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

/** Start of the period a date falls in, as YYYY-MM-DD (UTC). Weeks start on Monday. */
export function truncateDate(v: Cell, grain: TimeGrain): Cell {
  if (v === null || typeof v === 'boolean') return null;
  const s = String(v);
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) return null;
  return periodStart(new Date(t), grain, 0);
}

function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

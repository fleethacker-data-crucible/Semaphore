// Applies page selections to a flag's cached result without going back to the source.
//
// A result row holds the flag's own dimensions, any slice dimensions and aggregate partials.
// Filtering keeps the rows whose slice values are selected; re-aggregation then adds the
// partials back up to the flag's own dimensions. Selections the result cannot answer are
// returned in `live` so the caller re-queries the source for just this flag.

import type { Behavior } from './hoist.ts';
import type { QueryPlan } from './planner.ts';

export type Cell = string | number | boolean | null;
export type ResultRow = Record<string, Cell>;

/** Selected values per dimension key, e.g. { "orders.region": ["Northeast"] }. */
export type Selections = Record<string, ReadonlyArray<string | number | boolean | null>>;

export interface DisplayRow {
  /** Own dimension values, keyed by dimension key. */
  dims: Record<string, Cell>;
  /** Metric values, keyed by metric key. null when there was nothing to aggregate. */
  values: Record<string, number | null>;
}

export interface CrossfilterResult {
  rows: DisplayRow[];
  /** Selection keys applied locally. */
  applied: string[];
  /** Selection keys this flag needs a new source query for. */
  live: string[];
  /**
   * The result hit the row cap, so it may be missing rows. Totals are incomplete and every
   * selection that applies to this flag is sent to the source instead of filtered locally.
   */
  truncated: boolean;
}

export function applySelections(plan: QueryPlan, rows: readonly ResultRow[], selections: Selections, behavior: Behavior): CrossfilterResult {
  const applied: string[] = [];
  const live: string[] = [];
  const truncated = rows.length >= plan.rowCap;
  const tests: Array<{ alias: string; allowed: Set<string> }> = [];
  for (const [key, values] of Object.entries(selections)) {
    if (values.length === 0) continue;
    const field = key.split('@')[0]!;
    if (behavior.ignore.includes(field)) continue;
    const dim = plan.dimensions.find((d) => d.key === key);
    const isOwn = plan.own.includes(key);
    if (isOwn && !plan.selfFilter) continue; // a picker keeps listing every value
    if (plan.live.includes(key) || (truncated && dim)) {
      live.push(key);
    } else if (dim) {
      tests.push({ alias: dim.alias, allowed: new Set(values.map(norm)) });
      applied.push(key);
    }
    // Any other key is a selection on a table this flag does not read; it does not apply.
  }

  const kept = tests.length === 0 ? rows : rows.filter((r) => tests.every((t) => t.allowed.has(norm(r[t.alias] ?? null))));

  const ownDims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const groups = new Map<string, { dims: Record<string, Cell>; acc: Map<string, number | null> }>();
  const needsRegroup = plan.slices.length > 0;
  let order = 0;
  for (const r of kept) {
    const dims: Record<string, Cell> = {};
    for (const d of ownDims) dims[d.key] = r[d.alias] ?? null;
    // Without slices every source row is already one display row; keep them apart.
    const gk = needsRegroup ? JSON.stringify(ownDims.map((d) => norm(r[d.alias] ?? null))) : String(order);
    order++;
    let g = groups.get(gk);
    if (!g) {
      g = { dims, acc: new Map() };
      groups.set(gk, g);
    }
    for (const a of plan.aggregates) {
      const v = toNumber(r[a.alias]);
      const prev = g.acc.get(a.alias);
      if (v === null) {
        if (!g.acc.has(a.alias)) g.acc.set(a.alias, null);
        continue;
      }
      if (prev === undefined || prev === null) g.acc.set(a.alias, v);
      else if (a.fn === 'min') g.acc.set(a.alias, Math.min(prev, v));
      else if (a.fn === 'max') g.acc.set(a.alias, Math.max(prev, v));
      else g.acc.set(a.alias, prev + v); // sum, count; count_distinct never regroups (planner rule)
    }
  }

  // A KPI with no own dimensions always shows one row, even when everything is filtered out.
  if (ownDims.length === 0 && groups.size === 0) groups.set('[]', { dims: {}, acc: new Map() });

  let out: DisplayRow[] = [...groups.values()].map((g) => {
    const values: Record<string, number | null> = {};
    for (const m of plan.metrics) {
      const get = (alias?: string): number | null => (alias === undefined ? null : (g.acc.get(alias) ?? null));
      switch (m.agg) {
        case 'sum':
          values[m.key] = get(m.parts.sum);
          break;
        case 'count':
          values[m.key] = get(m.parts.count) ?? 0;
          break;
        case 'min':
          values[m.key] = get(m.parts.min);
          break;
        case 'max':
          values[m.key] = get(m.parts.max);
          break;
        case 'avg': {
          const s = get(m.parts.sum);
          const c = get(m.parts.count);
          values[m.key] = s === null || !c ? null : s / c;
          break;
        }
        case 'count_distinct':
          values[m.key] = get(m.parts.distinct) ?? 0;
          break;
      }
    }
    return { dims: g.dims, values };
  });

  if (plan.sort) {
    const { by, dir } = plan.sort;
    const sign = dir === 'desc' ? -1 : 1;
    const isMetric = plan.metrics.some((m) => m.key === by);
    out = out
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const av = isMetric ? a.row.values[by] : a.row.dims[by];
        const bv = isMetric ? b.row.values[by] : b.row.dims[by];
        const an = av === null || av === undefined;
        const bn = bv === null || bv === undefined;
        if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1; // nulls last either way
        return compare(av, bv) * sign || a.i - b.i;
      })
      .map((x) => x.row);
  }
  if (plan.displayLimit) out = out.slice(0, plan.displayLimit);
  return { rows: out, applied, live, truncated };
}

/** Values compare as text so a selection made on one flag matches the same value on another. */
function norm(v: Cell): string {
  if (v === null) return '\u0000null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Dates arrive as ISO strings; drivers differ on whether a UTC midnight time is included
  // and how the zero offset is written. Other offsets are left alone (they are real times).
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|[+-]00:?00)?$/.test(v) ? v.slice(0, 10) : v;
}

function toNumber(v: Cell | undefined): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function compare(a: string | number | boolean, b: string | number | boolean): number {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

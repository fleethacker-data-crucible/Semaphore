// Measures from several tables in one flag (a drill-across): "cost per hull" with labor cost on
// jobs and hulls on a hulls table, or labor hours on one fact table and parts cost on another.
//
// A join between two fact tables would repeat each one's rows once per row of the other, so the
// tables are never joined to each other. Each is asked on its own for its own measures, grouped and
// filtered by the same fields (each reaching them through its own relationships), and the rows are
// lined up by the group values afterwards, like a full outer join: a group one table has and the
// other does not gets nothing for the other's measures, so a formula that needs both shows nothing
// there. Totals come from each table's own totals, as for one table (crossfilter.ts).
//
// The parts share the plan's dimensions, filters and aggregates (each part computes its own share
// of the aggregates), so a comparison window, a drill or a page selection changes them all alike.
// In SQL the parts are one statement: each part a SELECT grouped by the same columns, joined with
// UNION ALL and grouped once more outside (sql.ts); in the page, each part runs and the rows are
// lined up the same way (engine.ts).

import { type CatalogIndex, type Metric, metricTable } from './catalog.ts';
import { baseInputs } from './formula.ts';
import type { Flag, Hoist } from './hoist.ts';
import type { AcrossPart, Partial, PlanOptions, PlannedAggregate, PlannedMetric, PlanResult, QueryPlan } from './planner.ts';

export interface AcrossKit {
  plan(hoist: Hoist, flag: Flag, index: CatalogIndex, options: PlanOptions): PlanResult;
  metrics(index: CatalogIndex, keys: readonly string[], partial: (fn: Partial, m: Metric) => string, seen?: (m: Metric) => string): PlannedMetric[] | string;
}

export function planAcross(hoist: Hoist, flag: Flag, index: CatalogIndex, options: PlanOptions, tables: readonly string[], kit: AcrossKit): PlanResult {
  const b = flag.binding!;
  const label = (k: string) => index.field(k.split('@')[0]!)?.label ?? k;
  const tableOf = (m: Metric) => metricTable(index, m)!;
  const intro = `${list(b.metrics.map((k) => `"${index.metric(k)?.label ?? k}"`))} ${b.metrics.length > 1 ? 'are' : 'is'} worked out from ${list(tables)}, so each of them must reach every field it is split or filtered by.`;

  // Each table's own measures (a formula's plain inputs), planned as a flag of their own.
  const parts: QueryPlan[] = [];
  for (const t of tables) {
    const keys = [...new Set(b.metrics.flatMap((k) => baseInputs(k, index.metric)).filter((m) => tableOf(m) === t).map((m) => m.key))];
    const { limit: _l, sort: _s, ...rest } = b;
    const p = kit.plan(hoist, { ...flag, binding: { ...rest, metrics: keys } }, index, options);
    if (!p.ok) return { ...p, error: `${intro} From ${t}: ${p.error}` };
    parts.push(p.plan);
  }
  const first = parts[0]!;
  // A page filter one table cannot reach would compare filtered rows with unfiltered ones.
  for (const p of parts) {
    const odd = [...first.filters, ...p.filters].find((f) => !first.filters.includes(f) || !p.filters.includes(f));
    if (odd) return { ok: false, error: `${intro} The page filter on "${label(odd.field)}" does not reach ${first.filters.includes(odd) ? p.table : first.table}.` };
  }

  // Page selections apply only when every table can answer them: pre-split in all, or re-queried.
  const notes: string[] = [];
  const slices: string[] = [];
  const live: string[] = [];
  for (const k of new Set(parts.flatMap((p) => [...p.slices, ...p.live]))) {
    if (parts.every((p) => p.slices.includes(k))) slices.push(k);
    else if (parts.every((p) => p.live.includes(k) || p.slices.includes(k))) live.push(k);
    else notes.push(`Selections on ${label(k)} do not reach this flag: not every table it reads is related to it.`);
  }
  const dimensions = first.dimensions.filter((d) => first.own.includes(d.key) || slices.includes(d.key)).map((d, i) => ({ ...d, alias: `d${i}` }));

  // The aggregates of every table, each computed on its own table.
  const aggregates: PlannedAggregate[] = [];
  const on = new Map<PlannedAggregate, string>();
  const partial = (fn: Partial, field: string | null, t: string): string => {
    const found = aggregates.find((a) => a.fn === fn && a.field === field && on.get(a) === t);
    if (found) return found.alias;
    const a: PlannedAggregate = { alias: `a${aggregates.length}`, fn, field };
    aggregates.push(a);
    on.set(a, t);
    return a.alias;
  };
  const seen = (t: string) => partial('count', null, t);
  const metrics = kit.metrics(index, b.metrics, (fn, m) => partial(fn, m.field ?? null, tableOf(m)), (m) => seen(tableOf(m)));
  if (typeof metrics === 'string') return { ok: false, error: metrics };
  const across: AcrossPart[] = parts.map((p) => {
    const s = seen(p.table);
    return { table: p.table, ...(p.joins ? { joins: p.joins } : {}), ...(p.many ? { many: p.many } : {}), aggregates: aggregates.filter((a) => on.get(a) === p.table), seen: s };
  });

  const plan: QueryPlan = {
    flagId: flag.id,
    source: first.source,
    table: first.table,
    across,
    dimensions,
    aggregates,
    metrics,
    filters: first.filters,
    own: first.own,
    slices,
    live,
    // Every row is fetched: a formula is ranked and cut in the page (planner.ts).
    limit: first.rowCap,
    rowCap: first.rowCap,
    selfFilter: first.selfFilter,
    estimatedRows: Math.max(...parts.map((p) => p.estimatedRows)),
    notes: [...new Set([acrossNote(first.own, tables, label), ...parts.flatMap((p) => p.notes), ...notes])],
  };
  if (first.compare) plan.compare = first.compare;
  if (b.sort) plan.sort = b.sort;
  if (b.share) plan.share = true;
  if (b.limit) plan.displayLimit = b.limit;
  return { ok: true, plan };
}

/** "Worked out from jobs and hulls, lined up by Region: ...": the plan's first note, also read back (describe.ts). */
function acrossNote(own: readonly string[], tables: readonly string[], label: (key: string) => string): string {
  const by = list(own.map(label));
  return own.length
    ? `Worked out from ${list(tables)}, lined up by ${by}: each table is read on its own, never joined to the other, and a ${by} found in only one of them shows nothing for a measure that needs the other.`
    : `Worked out from ${list(tables)}: each table is read on its own, never joined to the other.`;
}

function list(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

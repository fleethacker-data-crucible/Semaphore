// Measures from several tables in one flag (src/core/across.ts, a drill-across): "cost per hull"
// with labor cost on jobs and hulls on a hulls table, or labor cost plus parts cost from two fact
// tables. One query per table, grouped and filtered alike, lined up by the group values. Checked
// per group, for a group one table lacks, in totals (a distinct count's from the data), comparisons,
// shares, pivot levels, ranking, page selections, snapshots, lineage and the readback; refusals for
// a field one table cannot reach, a many-side ambiguity and two sources. The SQLite SQL runs in
// Node's own SQLite against the in-page engine; the other dialects are checked by their text.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { type Catalog, type Dialect, indexCatalog, SQL_DIALECTS } from '../src/core/catalog.ts';
import { applySelections, lineUp } from '../src/core/crossfilter.ts';
import { describeFlag } from '../src/core/describe.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Filter, Flag, Hoist } from '../src/core/hoist.ts';
import { buildLineage } from '../src/core/lineage.ts';
import { buildPivot, levelKey } from '../src/core/pivot.ts';
import { comparisonPlan, comparisonShift, loadAcross, planFlag, type PlanResult, type QueryPlan } from '../src/core/planner.ts';
import type { PlaybookEntry } from '../src/core/playbook.ts';
import { answerFromSnapshots, takeSnapshot } from '../src/core/snapshot.ts';
import { renderSql } from '../src/core/sql.ts';
import { computeFlag, type DataContext } from '../web/src/lib/data.ts';

const today = new Date('2025-06-15T00:00:00Z');

function catalogFor(dialect: Dialect = 'sqlite'): Catalog {
  const f = (table: string, column: string, label: string, type: 'string' | 'number' | 'date' = 'string', cardinality?: number) => ({
    key: `${table}.${column}`,
    label,
    source: 's',
    table,
    column,
    type,
    ...(cardinality ? { cardinality } : {}),
  });
  return {
    version: 1,
    sources: [{ id: 's', label: 'Yard', kind: dialect === 'sqlite' ? 'csv' : 'other', dialect }],
    fields: [
      f('regions', 'name', 'Region', 'string', 4),
      f('regions', 'zone', 'Zone', 'string', 2),
      f('days', 'day', 'Day', 'date'),
      f('jobs', 'status', 'Status', 'string', 2),
      f('jobs', 'cost', 'Labor cost', 'number'),
      f('jobs', 'opened', 'Opened', 'date'),
      f('hulls', 'hull', 'Hull'),
      f('parts', 'amount', 'Parts cost', 'number'),
      f('parts', 'opened', 'Ordered', 'date'),
    ],
    metrics: [
      { key: 'labor_cost', label: 'Labor cost', agg: 'sum', field: 'jobs.cost', source: 's' },
      { key: 'jobs', label: 'Work orders', agg: 'count', table: 'jobs', source: 's' },
      { key: 'hulls', label: 'Hulls', agg: 'count_distinct', field: 'hulls.hull', source: 's' },
      { key: 'parts_cost', label: 'Parts cost', agg: 'sum', field: 'parts.amount', source: 's' },
      { key: 'cost_per_hull', label: 'Cost per hull', agg: 'formula', formula: 'labor_cost / hulls', source: 's' },
      { key: 'all_cost', label: 'Labor and parts', agg: 'formula', formula: 'labor_cost + parts_cost', source: 's' },
      { key: 'parts_per_job', label: 'Parts per job', agg: 'formula', formula: 'parts_cost / jobs', source: 's' },
    ],
    relationships: [
      { id: 'r1', source: 's', from: { table: 'jobs', column: 'region_id' }, to: { table: 'regions', column: 'id' } },
      { id: 'r2', source: 's', from: { table: 'hulls', column: 'region_id' }, to: { table: 'regions', column: 'id' } },
      { id: 'r3', source: 's', from: { table: 'parts', column: 'region_id' }, to: { table: 'regions', column: 'id' } },
      { id: 'r4', source: 's', from: { table: 'jobs', column: 'opened' }, to: { table: 'days', column: 'day' } },
      { id: 'r5', source: 's', from: { table: 'parts', column: 'opened' }, to: { table: 'days', column: 'day' } },
    ],
  };
}

// East has jobs, hulls and parts; West too; North has hulls and parts but no jobs; South has jobs only.
const ROWS: TableRows = {
  regions: [
    { id: 'R1', name: 'East', zone: 'coast' },
    { id: 'R2', name: 'West', zone: 'coast' },
    { id: 'R3', name: 'North', zone: 'inland' },
    { id: 'R4', name: 'South', zone: 'inland' },
  ],
  jobs: [
    { id: 'j1', region_id: 'R1', status: 'open', cost: 10, opened: '2025-06-02' },
    { id: 'j2', region_id: 'R1', status: 'closed', cost: 20, opened: '2025-06-10' },
    { id: 'j3', region_id: 'R2', status: 'open', cost: 40, opened: '2025-06-03' },
    { id: 'j4', region_id: 'R4', status: 'open', cost: 5, opened: '2025-06-05' },
    { id: 'j5', region_id: 'R1', status: 'closed', cost: 12, opened: '2025-05-10' },
    { id: 'j6', region_id: 'R2', status: 'open', cost: 30, opened: '2025-05-03' },
  ],
  hulls: [
    { id: 'x1', region_id: 'R1', hull: 'h1' },
    { id: 'x2', region_id: 'R1', hull: 'h2' },
    { id: 'x3', region_id: 'R1', hull: 'h1' },
    { id: 'x4', region_id: 'R2', hull: 'h3' },
    { id: 'x5', region_id: 'R3', hull: 'h9' },
  ],
  parts: [
    { id: 'p1', region_id: 'R1', amount: 7, opened: '2025-06-04' },
    { id: 'p2', region_id: 'R2', amount: 3, opened: '2025-06-06' },
    { id: 'p3', region_id: 'R1', amount: 2, opened: '2025-05-02' },
    { id: 'p4', region_id: 'R3', amount: 4, opened: '2025-05-20' },
  ],
};
ROWS.days = [...new Set([...ROWS.jobs!, ...ROWS.parts!].map((r) => String(r.opened)))].map((day) => ({ day }));

await loadAcross();
const catalog = catalogFor();
const index = indexCatalog(catalog);
const BEHAVIOR = { onClick: 'none' as const, ignore: [], thresholds: [] };
const REGION = { field: 'regions.name' };
const JUNE: Filter = { field: 'days.day', op: 'last', values: [1], unit: 'month' };

function page(binding: Partial<Binding>, opts: { kind?: Flag['kind']; filters?: Filter[]; others?: Flag[] } = {}): { hoist: Hoist; flag: Flag } {
  const flag: Flag = { id: 'f', kind: opts.kind ?? 'table', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior: BEHAVIOR, binding: { metrics: [], dimensions: [], filters: [], ...binding } };
  return { flag, hoist: { version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: opts.filters ?? [], flags: [flag, ...(opts.others ?? [])], updated: '' } };
}

function picker(field: string, id = `pick-${field}`): Flag {
  return { id, kind: 'filter', title: '', brief: '', layout: { x: 0, y: 0, w: 2, h: 2 }, status: 'ready', notes: [], behavior: { onClick: 'filter-page', ignore: [], thresholds: [] }, binding: { metrics: [], dimensions: [{ field }], filters: [] } };
}

function attempt(binding: Partial<Binding>, opts: Parameters<typeof page>[1] = {}, c: Catalog = catalog): PlanResult {
  const { hoist, flag } = page(binding, opts);
  return planFlag(hoist, flag, indexCatalog(c));
}

function planOf(binding: Partial<Binding>, opts: Parameters<typeof page>[1] = {}, c: Catalog = catalog): QueryPlan {
  const p = attempt(binding, opts, c);
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

function show(plan: QueryPlan, selections = {}) {
  return applySelections(plan, runPlan(plan, index, ROWS, today).rows, selections, BEHAVIOR);
}

/** Metric values by the first own dimension's value. */
function byRegion(r: ReturnType<typeof show>, key: string): Record<string, number | null> {
  return Object.fromEntries(r.rows.map((x) => [String(Object.values(x.dims)[0]), x.values[key] ?? null]));
}

function near(a: number | null | undefined, b: number) {
  assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
}

const ctx: DataContext = { index, local: ROWS, localSources: new Set(['s']), server: null, today, version: 1 };

test('per group: each table read on its own, lined up by region; a region one table lacks shows nothing', () => {
  const plan = planOf({ metrics: ['labor_cost', 'cost_per_hull'], dimensions: [REGION] });
  assert.deepEqual(plan.across!.map((p) => p.table), ['jobs', 'hulls']);
  // Each table's aggregates, plus the count that says it has rows in a group.
  assert.deepEqual(plan.across!.map((p) => p.aggregates.map((a) => `${a.fn}:${a.field}`)), [['sum:jobs.cost', 'count:null'], ['count_distinct:hulls.hull', 'count:null']]);
  assert.match(plan.notes[0]!, /^Worked out from jobs and hulls, lined up by Region/);
  const r = show(plan);
  assert.deepEqual(byRegion(r, 'cost_per_hull'), { East: 42 / 2, West: 70, North: null, South: null });
  assert.deepEqual(byRegion(r, 'labor_cost'), { East: 42, West: 70, North: null, South: 5 });
  assert.equal(r.gaps, 2);
  // Two fact tables: labor plus parts, and parts per work order.
  const both = show(planOf({ metrics: ['all_cost', 'parts_per_job'], dimensions: [REGION] }));
  assert.deepEqual(byRegion(both, 'all_cost'), { East: 51, West: 73, North: null, South: null });
  assert.deepEqual(byRegion(both, 'parts_per_job'), { East: 3, West: 1.5, North: null, South: null });
  // A total with no split needs no relationship at all, and has no gaps.
  const kpi = show(planOf({ metrics: ['cost_per_hull'] }, { kind: 'kpi' }));
  near(kpi.rows[0]!.values.cost_per_hull, 117 / 4);
  assert.equal(kpi.gaps, undefined);
});

test('totals: from each table’s own totals; a distinct count’s total is read from the data', async () => {
  const sums = show(planOf({ metrics: ['all_cost', 'labor_cost', 'parts_cost'], dimensions: [REGION] }));
  assert.equal(sums.totals.labor_cost, 117);
  assert.equal(sums.totals.parts_cost, 16);
  assert.equal(sums.totals.all_cost, 133); // never the sum of the rows' values (124 over the rows that have both)
  // Hulls are a distinct count: no total from the rows (h1 could be in two regions) ...
  const rows = show(planOf({ metrics: ['cost_per_hull'], dimensions: [REGION] }));
  assert.equal(rows.totals.cost_per_hull, null);
  // ... so the page reads it with one more query per table, grouped by nothing.
  const { hoist, flag } = page({ metrics: ['cost_per_hull'], dimensions: [REGION] });
  const result = await computeFlag(hoist, flag, {}, ctx);
  near(result.display.totals.cost_per_hull, 117 / 4);
  assert.ok(result.plan.notes.some((n) => /^2 of these groups are found in only some of jobs, hulls/.test(n)), result.plan.notes.join(' | '));
});

test('comparisons: the earlier window is lined up the same way, each window from its own tables', async () => {
  const plan = planOf({ metrics: ['all_cost'], dimensions: [REGION], filters: [JUNE], compare: 'previous-period' });
  const now = show(plan);
  assert.deepEqual(byRegion(now, 'all_cost'), { East: 37, West: 43, South: null });
  const earlier = comparisonPlan(plan, today)!;
  assert.ok(earlier.across && earlier.filters[0]!.op === 'between');
  const before = show(earlier);
  const prev = lineUp(now.rows, before.rows, comparisonShift(plan) ?? undefined);
  const at = (name: string) => prev[now.rows.findIndex((r) => r.dims['regions.name'] === name)];
  assert.equal(at('East')!.all_cost, 14); // 12 labor + 2 parts, 1-15 May
  assert.equal(at('West')!.all_cost, null); // labor in May, no parts
  assert.equal(at('South'), null);
  // Through the page: the same numbers, and the earlier totals are the earlier window's own.
  const { hoist, flag } = page({ metrics: ['all_cost'], dimensions: [REGION], filters: [JUNE], compare: 'previous-period' });
  const r = await computeFlag(hoist, flag, {}, ctx);
  assert.equal(r.previousTotals!.all_cost, 44);
  assert.equal(r.display.totals.all_cost, 85);
});

test('share of the total, ranking and top N: worked out in the page from the lined-up rows', () => {
  const share = show(planOf({ metrics: ['all_cost'], dimensions: [REGION], share: true }));
  near(byRegion(share, 'all_cost').East! / share.totals.all_cost!, 51 / 133);
  const top = planOf({ metrics: ['cost_per_hull'], dimensions: [REGION], sort: { by: 'cost_per_hull', dir: 'desc' }, limit: 1 });
  assert.equal(top.limit, top.rowCap); // never cut at the source
  assert.deepEqual(show(top).rows.map((r) => [r.dims['regions.name'], r.values.cost_per_hull]), [['West', 70]]);
  const bottom = show(planOf({ metrics: ['cost_per_hull'], dimensions: [REGION], sort: { by: 'cost_per_hull', dir: 'asc' }, limit: 2 }));
  assert.deepEqual(bottom.rows.map((r) => r.dims['regions.name']), ['East', 'West']); // nothing-to-show rows last
});

test('pivot levels: subtotals are read at their own level, one query per table there too', async () => {
  const dims = [{ field: 'regions.zone' }, REGION];
  const { hoist, flag } = page({ metrics: ['cost_per_hull', 'labor_cost'], dimensions: dims }, { kind: 'pivot' });
  const r = await computeFlag(hoist, flag, {}, ctx);
  assert.ok(r.levels);
  const grid = buildPivot({ rows: ['regions.zone'], column: 'regions.name', measures: [{ key: 'cost_per_hull', agg: 'formula' }, { key: 'labor_cost', agg: 'sum' }], cells: r.display.rows, levels: r.levels });
  near(grid.total.total.cost_per_hull!.value, 117 / 4);
  const inland = grid.lines.find((l) => l.kind === 'leaf' && l.label === 'inland')!;
  // Inland: South's labor over North's hull, though no single region has both.
  near(inland.total.cost_per_hull!.value, 5);
  const coast = grid.lines.find((l) => l.kind === 'leaf' && l.label === 'coast')!;
  near(coast.total.cost_per_hull!.value, 112 / 3);
  assert.ok(r.levels[levelKey(0, false)]);
});

test('page selections: pre-split when every table reaches the field; not applied when one cannot', () => {
  const plan = planOf({ metrics: ['all_cost'], dimensions: [REGION] }, { others: [picker('regions.zone'), picker('jobs.status')] });
  assert.deepEqual(plan.slices, ['regions.zone']);
  assert.ok(plan.notes.some((n) => /Selections on Status do not reach this flag/.test(n)), plan.notes.join(' | '));
  const r = show(plan, { 'regions.zone': ['coast'], 'jobs.status': ['open'] });
  assert.deepEqual(byRegion(r, 'all_cost'), { East: 51, West: 73 });
  assert.deepEqual(r.applied, ['regions.zone']);
  // A distinct count cannot be re-added: the selection goes back to the source, still lined up.
  const live = planOf({ metrics: ['cost_per_hull'], dimensions: [REGION] }, { others: [picker('regions.zone')] });
  assert.deepEqual(live.live, ['regions.zone']);
  const narrowed = planOf({ metrics: ['cost_per_hull'], dimensions: [REGION], filters: [{ field: 'regions.zone', op: 'in', values: ['inland'] }] });
  assert.deepEqual(byRegion(show(narrowed), 'cost_per_hull'), { North: null, South: null });
});

test('refused, with the field and the table named: unreachable splits and filters, page filters, many-side ambiguity, two sources', () => {
  const split = attempt({ metrics: ['cost_per_hull'], dimensions: [{ field: 'jobs.status' }] });
  assert.ok(!split.ok && /"Cost per hull" is worked out from jobs and hulls/.test(split.error) && /From hulls: "Status" is in a table not related to hulls/.test(split.error), !split.ok ? split.error : '');
  const filtered = attempt({ metrics: ['cost_per_hull'], filters: [{ field: 'jobs.status', op: 'eq', values: ['open'] }] });
  assert.ok(!filtered.ok && /Filter on "Status" is in a table not related to hulls/.test(filtered.error));
  const pageFilter = attempt({ metrics: ['all_cost'], dimensions: [REGION] }, { filters: [{ field: 'jobs.status', op: 'eq', values: ['open'] }] });
  assert.ok(!pageFilter.ok && /page filter on "Status" does not reach parts/.test(pageFilter.error), !pageFilter.ok ? pageFilter.error : '');
  // Crews point at hulls twice (crew and backup crew): from hulls, a crew field is on its many side in two ways.
  const crews: Catalog = {
    ...catalog,
    fields: [...catalog.fields, { key: 'crews.name', label: 'Crew', source: 's', table: 'crews', column: 'name', type: 'string' }],
    relationships: [
      ...catalog.relationships!,
      { id: 'c1', source: 's', from: { table: 'jobs', column: 'crew_id' }, to: { table: 'crews', column: 'id' } },
      { id: 'c2', source: 's', from: { table: 'crews', column: 'hull_id' }, to: { table: 'hulls', column: 'id' } },
      { id: 'c3', source: 's', from: { table: 'crews', column: 'backup_hull_id' }, to: { table: 'hulls', column: 'id' } },
    ],
  };
  const ambiguous = attempt({ metrics: ['cost_per_hull'], dimensions: [{ field: 'crews.name' }] }, {}, crews);
  assert.ok(!ambiguous.ok && ambiguous.reason === 'many-side' && /From hulls: "Crew" is in crews, which relates to hulls in 2 ways/.test(ambiguous.error), !ambiguous.ok ? ambiguous.error : '');
  // Inputs on two sources: still refused, with a reason.
  const two: Catalog = {
    ...catalog,
    sources: [...catalog.sources, { id: 'w', label: 'Warehouse', kind: 'postgres', dialect: 'postgres' }],
    fields: [...catalog.fields, { key: 'stock.qty', label: 'Stock', source: 'w', table: 'stock', column: 'qty', type: 'number' }],
    metrics: [...catalog.metrics, { key: 'stock', label: 'Stock', agg: 'sum', field: 'stock.qty', source: 'w' }, { key: 'cost_per_stock', label: 'Cost per stock', agg: 'formula', formula: 'labor_cost / stock', source: 's' }],
  };
  const sources = attempt({ metrics: ['cost_per_stock'] }, { kind: 'kpi' }, two);
  assert.ok(!sources.ok && /"Cost per stock" reads "Stock" from a different source/.test(sources.error), !sources.ok ? sources.error : '');
});

test('readback, lineage and snapshots name and use both tables', async () => {
  const { hoist, flag } = page({ metrics: ['cost_per_hull'], dimensions: [REGION] });
  const words = describeFlag(flag, hoist, index).join(' ');
  assert.match(words, /Worked out from jobs and hulls, lined up by Region: each table is read on its own/);
  const lineage = buildLineage(catalog, hoist);
  const tables = lineage.nodes.filter((n) => n.kind === 'table').map((n) => n.label).sort();
  assert.deepEqual(tables, ['hulls', 'jobs', 'regions']);
  const joins = lineage.edges.filter((e) => e.join).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(joins, ['t:s|hulls>t:s|regions', 't:s|jobs>t:s|regions']);
  // A snapshot keeps the lined-up rows, and they answer the flag again without a query.
  const entry: PlaybookEntry = {
    version: 1,
    id: 'h--f',
    title: 'Labor and parts by region',
    question: 'labor and parts by region',
    phrasings: [],
    kind: 'bar',
    binding: { metrics: ['all_cost'], dimensions: [REGION], filters: [] },
    thresholds: [],
    pageFilters: [],
    source: 's',
    table: 'jobs',
    hoist: { id: 'h', title: '' },
    acceptedBy: 'a',
    acceptedAt: today.toISOString(),
    revisions: 0,
    status: 'active',
    uses: 0,
    updated: today.toISOString(),
  };
  const snap = (await takeSnapshot(entry, index, async (p) => runPlan(p, index, ROWS, today), today))!;
  assert.ok(snap.plan.across);
  const answer = answerFromSnapshots({ ...flag, binding: entry.binding }, [], [snap])!;
  assert.deepEqual(byRegion(answer.display, 'all_cost'), { East: 51, West: 73, North: null, South: null });
  assert.equal(answer.display.totals.all_cost, 133);
});

// ---------------------------------------------------------------------------------------------
// SQL: one statement, each table's SELECT joined with UNION ALL and grouped once more.

const db = new sqlite.DatabaseSync(':memory:');
for (const [table, rows] of Object.entries(ROWS)) {
  const cols = Object.keys(rows[0]!);
  db.exec(`CREATE TABLE ${table} (${cols.map((c) => `${c} ${typeof rows[0]![c] === 'number' ? 'REAL' : 'TEXT'}`).join(', ')})`);
  const ins = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of rows) ins.run(...cols.map((c) => r[c] as string | number | null));
}
const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, typeof r[k] === 'number' ? Math.round((r[k] as number) * 1000) / 1000 : (r[k] ?? null)]))).sort();

test('SQLite: the drill-across SQL returns the engine’s rows (run for real)', () => {
  const cases: Array<{ name: string; plan: QueryPlan }> = [
    { name: 'by region', plan: planOf({ metrics: ['labor_cost', 'cost_per_hull'], dimensions: [REGION] }) },
    { name: 'kpi', plan: planOf({ metrics: ['cost_per_hull', 'all_cost'] }, { kind: 'kpi' }) },
    { name: 'two facts, June', plan: planOf({ metrics: ['all_cost', 'parts_per_job'], dimensions: [REGION], filters: [JUNE] }) },
    { name: 'zone and region', plan: planOf({ metrics: ['all_cost'], dimensions: [{ field: 'regions.zone' }, REGION] }) },
    { name: 'pre-split by zone', plan: planOf({ metrics: ['all_cost'], dimensions: [REGION] }, { others: [picker('regions.zone')] }) },
    { name: 'filtered to nothing', plan: planOf({ metrics: ['cost_per_hull'], dimensions: [REGION], filters: [{ field: 'regions.name', op: 'eq', values: ['Nowhere'] }] }) },
    { name: 'by day', plan: planOf({ metrics: ['all_cost'], dimensions: [{ field: 'days.day', grain: 'month' }] }) },
  ];
  const compared = planOf({ metrics: ['all_cost'], dimensions: [REGION], filters: [JUNE], compare: 'previous-period' });
  cases.push({ name: 'comparison window', plan: comparisonPlan(compared, today)! });
  for (const c of cases) {
    const q = renderSql(c.plan, index, today);
    assert.match(q.sql, / UNION ALL /, c.name);
    const fromSql = db.prepare(q.sql).all(...(q.params.map((p) => p.value) as Array<string | number>)) as Array<Record<string, unknown>>;
    assert.deepEqual(norm(fromSql), norm(runPlan(c.plan, index, ROWS, today).rows), `${c.name}: ${q.sql}`);
  }
});

test('every dialect: one statement, NULL for the other table’s aggregates, placeholders numbered across the parts', () => {
  for (const dialect of SQL_DIALECTS) {
    const c = catalogFor(dialect);
    const metrics = dialect === 'access' ? ['all_cost'] : ['all_cost', 'cost_per_hull'];
    const q = renderSql(planOf({ metrics, dimensions: [REGION], filters: [{ field: 'regions.zone', op: 'in', values: ['coast', 'inland'] }] }, {}, c), indexCatalog(c), today);
    assert.equal(q.sql.split(' UNION ALL ').length, metrics.length === 1 ? 2 : 3, `${dialect}: ${q.sql}`);
    assert.match(q.sql, /NULL AS /, dialect);
    assert.match(q.sql, /MAX\(/, dialect);
    assert.equal(q.params.length, 2 * (metrics.length === 1 ? 2 : 3), dialect);
    const markers = q.sql.match(/\$\d+|:p\d+|@p\d+|\?/g) ?? [];
    assert.equal(markers.length, q.params.length, dialect);
    if (dialect === 'postgres') assert.deepEqual(markers, q.params.map((_, i) => `$${i + 1}`));
    if (dialect === 'oracle') assert.match(q.sql, /\) "x" GROUP BY "x"\."d0" FETCH FIRST \d+ ROWS ONLY$/);
    if (dialect === 'tsql' || dialect === 'synapse' || dialect === 'access') assert.match(q.sql, /^SELECT TOP \d+ /);
    if (dialect === 'access') assert.match(q.sql, /AS \[x\] GROUP BY \[x\]\.\[d0\]$/);
    if (dialect === 'mysql' || dialect === 'spark') assert.match(q.sql, /AS `x` GROUP BY `x`\.`d0` LIMIT \d+$/);
    // Only the outer statement is limited.
    assert.equal((q.sql.match(/LIMIT|FETCH FIRST|TOP /g) ?? []).length, 1, dialect);
  }
});

// Calculated measures (src/core/formula.ts): the grammar, catalog checks, how the planner expands a
// formula into its inputs' aggregates, and the numbers per group, in totals, in comparisons, as a
// share and in pivot totals, all through the in-page engine. Ratios are never added up.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Catalog, checkCatalog, indexCatalog, metricTable } from '../src/core/catalog.ts';
import { applySelections, lineUp } from '../src/core/crossfilter.ts';
import { describeFlag } from '../src/core/describe.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import { checkFormulas, parseFormula, printFormula } from '../src/core/formula.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { buildPivot, levelKey, neededLevels } from '../src/core/pivot.ts';
import { comparisonPlan, comparisonShift, planFlag, type QueryPlan } from '../src/core/planner.ts';
import { renderSql } from '../src/core/sql.ts';
import { proposeMeasure } from '../src/core/formula-words.ts';
import { applyModelImport } from '../src/core/model-import.ts';
import { mapPowerBi, readBim } from '../src/core/powerbi.ts';
import { proposeCatalog } from '../src/core/profile.ts';

const base: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'sqlite' }],
  fields: [
    { key: 'jobs.region', label: 'Region', source: 's', table: 'jobs', column: 'region', type: 'string' },
    { key: 'jobs.cls', label: 'Ship class', source: 's', table: 'jobs', column: 'cls', type: 'string' },
    { key: 'jobs.hull', label: 'Hull', source: 's', table: 'jobs', column: 'hull', type: 'string' },
    { key: 'jobs.opened', label: 'Opened', source: 's', table: 'jobs', column: 'opened', type: 'date' },
    { key: 'jobs.cost', label: 'Labor cost', source: 's', table: 'jobs', column: 'cost', type: 'number' },
    { key: 'jobs.days', label: 'Days open', source: 's', table: 'jobs', column: 'days', type: 'number' },
  ],
  metrics: [
    { key: 'labor_cost', label: 'Labor cost', agg: 'sum', field: 'jobs.cost', source: 's', format: 'currency' },
    { key: 'hulls', label: 'Hulls affected', agg: 'count_distinct', field: 'jobs.hull', source: 's' },
    { key: 'jobs', label: 'Work orders', agg: 'count', source: 's', table: 'jobs' },
    { key: 'avg_days', label: 'Average days open', agg: 'avg', field: 'jobs.days', source: 's' },
    { key: 'cost_per_hull', label: 'Cost per hull', agg: 'formula', formula: 'labor_cost / hulls', format: 'currency', source: 's' },
    { key: 'cost_per_job', label: 'Cost per job', agg: 'formula', formula: 'labor_cost / jobs', source: 's' },
    { key: 'per_job_day', label: 'Cost per job day', agg: 'formula', formula: 'cost_per_job / avg_days', source: 's' },
    { key: 'margin', label: 'Margin', agg: 'formula', formula: '-(labor_cost - 2 * jobs) / (jobs - jobs)', source: 's' },
  ],
};

// East: h1 twice and h2 (2 hulls); West: h3 twice (1 hull). Cost by hand: East 10+20+0 = 30, West 40+25 = 65.
const JOBS = [
  { region: 'East', cls: 'A', hull: 'h1', opened: '2025-06-02', cost: 10, days: 2 },
  { region: 'East', cls: 'A', hull: 'h1', opened: '2025-05-10', cost: 20, days: 4 },
  { region: 'East', cls: 'B', hull: 'h2', opened: '2025-06-10', cost: 0, days: 6 },
  { region: 'West', cls: 'A', hull: 'h3', opened: '2025-06-03', cost: 40, days: 8 },
  { region: 'West', cls: 'C', hull: 'h3', opened: '2025-06-12', cost: 25, days: 1 },
  // The earlier window (May): for the comparison.
  { region: 'East', cls: 'A', hull: 'h1', opened: '2025-04-20', cost: 12, days: 3 },
  { region: 'West', cls: 'A', hull: 'h4', opened: '2025-04-22', cost: 30, days: 3 },
  { region: 'West', cls: 'A', hull: 'h5', opened: '2025-04-25', cost: 30, days: 3 },
];
const tables: TableRows = { jobs: JOBS as unknown as TableRows[string] };
const today = new Date('2025-06-15T00:00:00Z');
const index = indexCatalog(base);

function flagOf(binding: Partial<Binding>, kind: Flag['kind'] = 'table'): { hoist: Hoist; flag: Flag } {
  const flag: Flag = { id: 'f', kind, title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: [], dimensions: [], filters: [], ...binding } };
  return { flag, hoist: { version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' } };
}

function planOf(binding: Partial<Binding>, kind: Flag['kind'] = 'table'): QueryPlan {
  const { hoist, flag } = flagOf(binding, kind);
  const p = planFlag(hoist, flag, index);
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

function show(binding: Partial<Binding>, kind: Flag['kind'] = 'table') {
  const plan = planOf(binding, kind);
  return applySelections(plan, runPlan(plan, index, tables, today).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
}

const near = (a: number | null | undefined, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('the grammar: keys, numbers, + - * /, unary minus and parentheses, and nothing else', () => {
  const tree = (text: string) => {
    const p = parseFormula(text);
    assert.ok(p.ok, text);
    return p.node;
  };
  assert.equal(printFormula(tree('-(a + b.c) * 2 / (x - .5)')), '-(a + b.c) * 2 / (x - 0.5)');
  assert.equal(printFormula(tree('a - (b - c)')), 'a - (b - c)');
  assert.equal(printFormula(tree('(a - b) - c')), 'a - b - c');
  assert.equal(printFormula(tree('a / b * c'), (k) => k.toUpperCase()), 'A ÷ B × C');
  for (const bad of ['', 'a +', 'sum(a)', 'a % b', 'a ^ 2', '(a', 'a b', "a + 'x'", 'a; drop table', 'a'.repeat(2001), `${'('.repeat(70)}a${')'.repeat(70)}`]) {
    const r = parseFormula(bad);
    assert.equal(r.ok, false, bad.slice(0, 40));
  }
  assert.match((parseFormula('a % b') as { error: string }).error, /"%" is not part of a calculated measure/);
  assert.match((parseFormula('sum(a)') as { error: string }).error, /Uses the function sum\(\)/);
});

test('catalog checks: unknown inputs, another source, cycles and depth, with clear messages', () => {
  assert.deepEqual(checkCatalog(base), []);
  const withBad = (formula: string, extra: Catalog['metrics'] = []): string[] =>
    checkFormulas({ ...base, metrics: [...base.metrics, ...extra, { key: 'bad', label: 'Bad', agg: 'formula', formula, source: 's' }] });
  assert.match(withBad('labor_cost / nope')[0]!, /"nope", which is not a measure/);
  assert.match(withBad('labor_cost +')[0]!, /cannot read/);
  assert.match(withBad('other_cost', [{ key: 'other_cost', label: 'O', agg: 'sum', field: 'jobs.cost', source: 't' }])[0]!, /from another source/);
  const cyc = withBad('loop_a', [
    { key: 'loop_a', label: 'A', agg: 'formula', formula: 'loop_b + 1', source: 's' },
    { key: 'loop_b', label: 'B', agg: 'formula', formula: 'bad * 2', source: 's' },
  ]);
  assert.ok(cyc.some((p) => /in a circle/.test(p)), cyc.join('\n'));
  const chain: Catalog['metrics'] = Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, label: `D${i}`, agg: 'formula' as const, formula: i ? `d${i - 1} + 1` : 'labor_cost', source: 's' }));
  assert.ok(withBad('d7', chain).some((p) => /deep/.test(p)));
  // A formula measure needs no field or table, and its table is its inputs' table.
  assert.equal(metricTable(index, index.metric('per_job_day')!), 'jobs');
});

test('per group: a ratio of each row’s own aggregates (sum over a distinct count), nested formulas too', () => {
  const r = show({ metrics: ['cost_per_hull', 'per_job_day'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }] });
  const east = r.rows.find((x) => x.dims['jobs.region'] === 'East')!;
  const west = r.rows.find((x) => x.dims['jobs.region'] === 'West')!;
  near(east.values.cost_per_hull, 30 / 2);
  near(west.values.cost_per_hull, 65 / 1);
  // (cost / jobs) / avg days: East (30/3) / (12/3) = 2.5; West (65/2) / (9/2) = 7.222…
  near(east.values.per_job_day, 10 / 4);
  near(west.values.per_job_day, 32.5 / 4.5);
  // Inputs are hidden partials: the result holds the formula's value, never the inputs as measures.
  assert.deepEqual(Object.keys(east.values).sort(), ['cost_per_hull', 'per_job_day']);
});

test('totals come from the totals: the ratio of the sums, never the sum of the ratios', () => {
  const r = show({ metrics: ['cost_per_job', 'labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }] });
  near(r.totals.cost_per_job, 95 / 5);
  const summed = r.rows.reduce((n, x) => n + (x.values.cost_per_job ?? 0), 0);
  assert.notEqual(r.totals.cost_per_job, summed);
  // A top-1 cut still totals every row.
  const top = show({ metrics: ['cost_per_job'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }], sort: { by: 'cost_per_job', dir: 'desc' }, limit: 1 });
  assert.equal(top.rows.length, 1);
  near(top.rows[0]!.values.cost_per_job, 32.5);
  near(top.totals.cost_per_job, 19);
  // Over a distinct count the total cannot be worked out from the rows (the page reads it from the data):
  // never the sum of the ratios.
  const hulls = show({ metrics: ['cost_per_hull'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }] });
  assert.equal(hulls.totals.cost_per_hull, null);
  const kpi = show({ metrics: ['cost_per_hull'], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }] }, 'kpi');
  near(kpi.rows[0]!.values.cost_per_hull, 95 / 3);
  near(kpi.totals.cost_per_hull, 95 / 3);
});

test('division by zero, and an input with no value, give null', () => {
  const r = show({ metrics: ['margin', 'cost_per_hull'], dimensions: [{ field: 'jobs.cls' }] });
  for (const row of r.rows) assert.equal(row.values.margin, null);
  assert.equal(r.totals.margin, null);
  // No rows at all: the KPI shows no ratio rather than 0/0.
  const none = show({ metrics: ['cost_per_job'], filters: [{ field: 'jobs.region', op: 'eq', values: ['North'] }] }, 'kpi');
  assert.equal(none.rows[0]!.values.cost_per_job, null);
});

test('the planner: inputs as hidden aggregates shared with plain measures; ranking and cuts stay local', () => {
  const plan = planOf({ metrics: ['labor_cost', 'cost_per_hull', 'cost_per_job'], dimensions: [{ field: 'jobs.region' }], sort: { by: 'cost_per_hull', dir: 'desc' }, limit: 1 });
  assert.deepEqual(plan.aggregates.map((a) => `${a.fn}:${a.field}`), ['sum:jobs.cost', 'count_distinct:jobs.hull', 'count:null']);
  assert.equal(plan.metrics.length, 3);
  // A formula is never ranked or cut at the source: the source has no column for it.
  assert.equal(plan.limit, plan.rowCap);
  const sql = renderSql(plan, index, today).sql;
  assert.doesNotMatch(sql, /ORDER BY/);
  assert.match(sql, /SUM\("cost"\) AS "a0", COUNT\(DISTINCT "hull"\) AS "a1", COUNT\(\*\) AS "a2"/);
  // Inputs from two tables are refused with a reason.
  const two: Catalog = {
    ...base,
    fields: [...base.fields, { key: 'parts.qty', label: 'Qty', source: 's', table: 'parts', column: 'qty', type: 'number' }],
    metrics: [...base.metrics, { key: 'qty', label: 'Qty', agg: 'sum', field: 'parts.qty', source: 's' }, { key: 'mix', label: 'Mix', agg: 'formula', formula: 'labor_cost / qty', source: 's' }],
  };
  const { hoist, flag } = flagOf({ metrics: ['mix'] });
  const refused = planFlag(hoist, flag, indexCatalog(two));
  assert.ok(!refused.ok && /different tables/.test(refused.error));
});

test('comparisons: the earlier window’s ratio is its own ratio, lined up per row', () => {
  const plan = planOf({ metrics: ['cost_per_hull'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'last', values: [1], unit: 'month' }], compare: 'previous-period' });
  const now = applySelections(plan, runPlan(plan, index, tables, today).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  const earlier = comparisonPlan(plan, today)!;
  const before = applySelections(earlier, runPlan(earlier, index, tables, today).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  const prev = lineUp(now.rows, before.rows, comparisonShift(plan) ?? undefined);
  const east = now.rows.findIndex((r) => r.dims['jobs.region'] === 'East');
  const west = now.rows.findIndex((r) => r.dims['jobs.region'] === 'West');
  near(now.rows[east]!.values.cost_per_hull, 10 / 2); // June: h1 10, h2 0
  near(prev[east]!.cost_per_hull!, 20 / 1); // May: h1 20
  near(now.rows[west]!.values.cost_per_hull, 65 / 1);
  assert.equal(prev[west], null); // no West jobs in May
});

test('share of the total: each row over the formula’s own total', () => {
  const r = show({ metrics: ['cost_per_job'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2025-05-01', '2025-06-30'] }], share: true });
  const east = r.rows.find((x) => x.dims['jobs.region'] === 'East')!;
  near(east.values.cost_per_job! / r.totals.cost_per_job!, 10 / 19);
});

test('pivot totals: a formula is not added up from its cells, its subtotals are read at their own level', () => {
  const dims = [{ field: 'jobs.region' }, { field: 'jobs.cls' }];
  const filters = [{ field: 'jobs.opened', op: 'between' as const, values: ['2025-05-01', '2025-06-30'] }];
  const cells = show({ metrics: ['cost_per_hull', 'labor_cost'], dimensions: dims, filters }).rows;
  const levels: Record<string, ReturnType<typeof show>['rows']> = {};
  for (const [d, c] of neededLevels(1, true)) levels[levelKey(d, c)] = show({ metrics: ['cost_per_hull', 'labor_cost'], dimensions: [...dims.slice(0, d), ...(c ? [dims[1]!] : [])], filters }, d || c ? 'table' : 'kpi').rows;
  const grid = buildPivot({ rows: ['jobs.region'], column: 'jobs.cls', measures: [{ key: 'cost_per_hull', agg: 'formula' }, { key: 'labor_cost', agg: 'sum' }], cells, levels });
  near(grid.total.total.cost_per_hull!.value, 95 / 3);
  near(grid.total.total.labor_cost!.value, 95);
  const east = grid.lines.find((l) => l.kind === 'leaf' && l.label === 'East')!;
  near(east.total.cost_per_hull!.value, 30 / 2);
  // Without the level rows the total is left empty with the reason, never summed.
  const blind = buildPivot({ rows: ['jobs.region'], column: 'jobs.cls', measures: [{ key: 'cost_per_hull', agg: 'formula' }], cells });
  assert.equal(blind.total.total.cost_per_hull!.value, null);
  assert.match(blind.total.total.cost_per_hull!.why ?? '', /calculated measure/);
});

test('readback and drafting: the formula in words; a brief finds the measure by its label', () => {
  const { hoist, flag } = flagOf({ metrics: ['cost_per_hull'], dimensions: [{ field: 'jobs.region' }] });
  const lines = describeFlag(flag, hoist, index);
  assert.ok(lines.some((l) => /Cost per hull is Labor cost ÷ Hulls affected/.test(l)), lines.join('\n'));
  const draft = draftFlagLocally('cost per hull by region', 'bar', index);
  assert.deepEqual(draft.binding?.metrics, ['cost_per_hull']);
  // The brief that defined it means the new measure, not the two it is made of.
  const defined = draftFlagLocally('cost per hull = labor cost / hulls affected by region', 'bar', index);
  assert.deepEqual(defined.binding?.metrics, ['cost_per_hull']);
});

test('a sentence proposes a formula measure: "=", "divided by", "difference between", "as a percent of"', () => {
  const plainIndex = indexCatalog({ ...base, metrics: base.metrics.filter((m) => m.agg !== 'formula') });
  const a = proposeMeasure('cost per hull = labor cost / hulls', plainIndex);
  assert.ok(a.ok, a.ok ? '' : a.error);
  assert.equal(a.metric.agg, 'formula');
  assert.equal(a.metric.formula, 'labor_cost / hulls');
  assert.equal(a.metric.label, 'Cost per hull');
  assert.equal(a.metric.key, 'cost_per_hull');
  assert.equal(a.metric.format, 'currency');
  assert.match(a.sentence, /Cost per hull = Labor cost ÷ Hulls affected/);
  const b = proposeMeasure('cost per job is labor cost divided by work orders', plainIndex);
  assert.ok(b.ok && b.metric.formula === 'labor_cost / jobs' && b.metric.label === 'Cost per job');
  const c = proposeMeasure('the difference between labor cost and work orders', plainIndex);
  assert.ok(c.ok && c.metric.formula === 'labor_cost - jobs', JSON.stringify(c));
  const d = proposeMeasure('hull share: hulls affected as a percent of work orders', plainIndex);
  assert.ok(d.ok && d.metric.formula === 'hulls / jobs' && d.metric.format === 'percent' && d.metric.label === 'Hull share', JSON.stringify(d));
  const e = proposeMeasure('labor cost times 1.2 plus work orders', plainIndex);
  assert.ok(e.ok && e.metric.formula === 'labor_cost * 1.2 + jobs', JSON.stringify(e));
  const no = proposeMeasure('cost per hull = labor cost / widgets', plainIndex);
  assert.ok(!no.ok && /widgets/.test(no.error));
  // The proposed measure passes the catalog's own checks.
  assert.deepEqual(checkCatalog({ ...plainIndex.catalog, metrics: [...plainIndex.catalog.metrics, a.metric] }), []);
});

test('an imported Power BI model: its calculated measures compute on a flag, per group and in total', () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'models');
  const read = mapPowerBi(readBim(readFileSync(path.join(fixtures, 'model.bim'), 'utf8')));
  const profile = proposeCatalog(
    {
      source: { id: 'wh', label: 'Warehouse', kind: 'csv', dialect: 'sqlite' },
      tables: [{ name: 'work_orders', rows: 4, columns: [{ name: 'wo_id', type: 'number' }, { name: 'hull_no', type: 'string', distinct: 2 }, { name: 'region', type: 'string', distinct: 2 }, { name: 'labor_cost', type: 'number' }, { name: 'parts_cost', type: 'number' }] }],
    },
    { version: 1, sources: [], fields: [], metrics: [] },
  ).catalog;
  const imported = applyModelImport(profile, read, [{ model: 'Work Orders', source: 'wh', table: 'work_orders' }]).catalog;
  assert.deepEqual(checkCatalog(imported), []);
  const margin = imported.metrics.find((m) => m.label === 'Labor Margin')!;
  assert.equal(margin.formula, '(labor_cost - parts_cost) / labor_cost');
  const wo = [
    { wo_id: 1, hull_no: 'h1', region: 'East', labor_cost: 100, parts_cost: 20 },
    { wo_id: 2, hull_no: 'h1', region: 'East', labor_cost: 100, parts_cost: 60 },
    { wo_id: 3, hull_no: 'h2', region: 'West', labor_cost: 50, parts_cost: 0 },
    { wo_id: 4, hull_no: 'h2', region: 'West', labor_cost: 0, parts_cost: 10 },
  ];
  const ix = indexCatalog(imported);
  const region = imported.fields.find((f) => f.column === 'region')!.key;
  const flag: Flag = { id: 'f', kind: 'table', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: [margin.key], dimensions: [{ field: region }], filters: [] } };
  const p = planFlag({ version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' }, flag, ix);
  assert.ok(p.ok, p.ok ? '' : p.error);
  const r = applySelections(p.plan, runPlan(p.plan, ix, { work_orders: wo }, today).rows, {}, flag.behavior);
  near(r.rows.find((x) => x.dims[region] === 'East')!.values[margin.key], (200 - 80) / 200);
  near(r.rows.find((x) => x.dims[region] === 'West')!.values[margin.key], (50 - 10) / 50);
  near(r.totals[margin.key], (250 - 90) / 250);
});

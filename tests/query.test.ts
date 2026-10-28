import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexCatalog } from '../src/core/catalog.ts';
import { applySelections, type ResultRow } from '../src/core/crossfilter.ts';
import type { Flag } from '../src/core/hoist.ts';
import { periodsIn, planFlag, type QueryPlan, selectableKeys } from '../src/core/planner.ts';
import { periodStart, renderSql, SqlError, truncate } from '../src/core/sql.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const TODAY = new Date(Date.UTC(2026, 9, 25)); // 2026-10-25

function plan(f: Flag, rowCap?: number): QueryPlan {
  const r = planFlag(hoist, f, index, rowCap === undefined ? {} : { rowCap });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

test('selectable keys come from filter flags and flags that filter the page', () => {
  assert.deepEqual(selectableKeys(hoist).map((d) => d.field).sort(), ['jobs.region', 'jobs.ship_class']);
});

test('a KPI is pre-split by every page-selectable field, cheapest first', () => {
  const p = plan(flag(hoist, 'kpi-orders'));
  assert.deepEqual(p.own, []);
  assert.deepEqual(p.slices, ['jobs.region', 'jobs.ship_class']);
  assert.deepEqual(p.live, []);
  assert.equal(p.estimatedRows, 72);
  assert.deepEqual(p.aggregates, [{ alias: 'a0', fn: 'count', field: null }]);
});

test('a distinct count cannot be re-added, so its page selections go live', () => {
  const p = plan(flag(hoist, 'kpi-hulls'));
  assert.deepEqual(p.slices, []);
  assert.deepEqual(p.live.sort(), ['jobs.region', 'jobs.ship_class']);
  assert.match(p.notes.join(' '), /distinct count/);
});

test('"ignore the region filter" keeps region out of the plan entirely', () => {
  const p = plan(flag(hoist, 'line-trend'));
  assert.deepEqual(p.own, ['jobs.opened@month']);
  assert.deepEqual(p.slices, ['jobs.ship_class']);
  assert.ok(!p.live.includes('jobs.region'));
  assert.equal(p.estimatedRows, 12 * 12, 'last 12 months × 12 classes');
  const avg = p.metrics.find((m) => m.key === 'avg_days_open')!;
  assert.ok(avg.parts.sum && avg.parts.count, 'avg is carried as sum and count');
});

test('slices that would blow the row cap are dropped to live, largest first', () => {
  const p = plan(flag(hoist, 'kpi-orders'), 10);
  assert.deepEqual(p.slices, ['jobs.region']);
  assert.deepEqual(p.live, ['jobs.ship_class']);
});

test('a top-N is cut at the source only when nothing is re-aggregated locally', () => {
  const top: Flag = { ...flag(hoist, 'bar-region'), id: 'top', behavior: { onClick: 'none', ignore: [], thresholds: [] } };
  top.binding = { ...top.binding!, limit: 3 };
  const sliced = plan(top);
  assert.deepEqual(sliced.slices, ['jobs.ship_class']);
  assert.equal(sliced.displayLimit, 3);
  assert.equal(sliced.limit, 50_000);
  const unsliced = plan({ ...top, behavior: { ...top.behavior, ignore: ['jobs.ship_class'] } });
  assert.equal(unsliced.limit, 3);
  assert.equal(unsliced.displayLimit, 3, 'cut locally too, because Access TOP n returns ties');
});

test('flags mixing sources or tables are refused with a reason', () => {
  const mixed: Flag = { ...flag(hoist, 'kpi-orders'), binding: { metrics: ['work_orders', 'parts_on_hand'], dimensions: [], filters: [] } };
  const r = planFlag(hoist, mixed, index);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /different source/);
});

test('period estimates', () => {
  assert.equal(periodsIn(12, 'month', 'month'), 12);
  assert.equal(periodsIn(1, 'year', 'month'), 13);
  assert.equal(periodsIn(30, 'day', 'month'), 2);
});

test('periodStart: last N periods include the current one', () => {
  assert.equal(periodStart(TODAY, 'month', 11), '2025-11-01');
  assert.equal(periodStart(TODAY, 'quarter', 0), '2026-10-01');
  assert.equal(periodStart(TODAY, 'quarter', 1), '2026-07-01');
  assert.equal(periodStart(TODAY, 'year', 1), '2025-01-01');
  assert.equal(periodStart(TODAY, 'week', 0), '2026-10-19', 'Monday of the current week');
  assert.equal(periodStart(TODAY, 'day', 6), '2026-10-19');
  assert.equal(periodStart(new Date(Date.UTC(2026, 0, 15)), 'month', 2), '2025-11-01', 'crosses a year');
});

test('Postgres SQL: quoted identifiers, bound parameters, grouped partials', () => {
  const q = renderSql(plan(flag(hoist, 'kpi-orders')), index, TODAY);
  assert.equal(
    q.sql,
    'SELECT "region" AS "d0", "ship_class" AS "d1", COUNT(*) AS "a0" FROM "ops"."work_orders" WHERE "opened_on" >= $1 GROUP BY "region", "ship_class" LIMIT 50000',
  );
  assert.deepEqual(q.params, [{ value: '2025-11-01', type: 'date' }]);
});

test('Oracle SQL: TRUNC for months, :p binds, FETCH FIRST', () => {
  const oracle = structuredClone(index.catalog);
  oracle.sources[0]!.dialect = 'oracle';
  const q = renderSql(plan(flag(hoist, 'line-trend')), indexCatalog(oracle), TODAY);
  assert.match(q.sql, /^SELECT TRUNC\("opened_on", 'MM'\) AS "d0", "ship_class" AS "d1", COUNT\(\*\) AS "a0", SUM\("days_open"\) AS "a1", COUNT\("days_open"\) AS "a2" FROM "ops"\."work_orders"/);
  assert.match(q.sql, /WHERE "opened_on" >= :p1 GROUP BY TRUNC\("opened_on", 'MM'\), "ship_class" ORDER BY TRUNC\("opened_on", 'MM'\) ASC FETCH FIRST 50000 ROWS ONLY$/);
});

test('Access SQL: brackets, TOP, positional binds; page filters on other tables do not leak in', () => {
  const f: Flag = {
    ...flag(hoist, 'kpi-orders'),
    id: 'parts-top',
    binding: { metrics: ['parts_on_hand'], dimensions: [{ field: 'parts.item' }], filters: [{ field: 'parts.item', op: 'in', values: ["O'Ring", 'Gasket'] }], sort: { by: 'parts_on_hand', dir: 'desc' }, limit: 10 },
  };
  const p = plan(f);
  assert.match(p.notes.join(' '), /Opened date.*not related/);
  const q = renderSql(p, index, TODAY);
  assert.equal(
    q.sql,
    'SELECT TOP 10 [Item Name] AS [d0], SUM([QtyOnHand]) AS [a0] FROM [Parts] WHERE [Item Name] IN (?, ?) GROUP BY [Item Name] ORDER BY SUM([QtyOnHand]) DESC',
  );
  assert.deepEqual(q.params.map((x) => x.value), ["O'Ring", 'Gasket'], 'values never reach the SQL text');
});

test('Access refuses distinct counts instead of producing wrong SQL', () => {
  const access = structuredClone(index.catalog);
  access.sources[0]!.dialect = 'access';
  assert.throws(() => renderSql(plan(flag(hoist, 'kpi-hulls')), indexCatalog(access), TODAY), SqlError);
});

test('a filter flag asks for distinct values, split by the other selectable fields', () => {
  const f = flag(hoist, 'filter-class');
  const p = plan(f);
  const q = renderSql(p, index, TODAY);
  assert.match(q.sql, /^SELECT DISTINCT "ship_class" AS "d0", "region" AS "d1" FROM/);
  assert.doesNotMatch(q.sql, /GROUP BY/);
  // Selecting a region narrows the class list to classes that have work there.
  const rows: ResultRow[] = [
    { d0: 'DDG', d1: 'NE' },
    { d0: 'CG', d1: 'NE' },
    { d0: 'DDG', d1: 'SE' },
    { d0: 'LHD', d1: 'SE' },
  ];
  assert.deepEqual(applySelections(p, rows, {}, f.behavior).rows.map((r) => r.dims['jobs.ship_class']), ['DDG', 'CG', 'LHD']);
  assert.deepEqual(applySelections(p, rows, { 'jobs.region': ['SE'] }, f.behavior).rows.map((r) => r.dims['jobs.ship_class']), ['DDG', 'LHD']);
});

test('date truncation per dialect', () => {
  assert.equal(truncate('c', 'quarter', 'postgres'), "date_trunc('quarter', c)");
  assert.equal(truncate('c', 'week', 'oracle'), "TRUNC(c, 'IW')");
  assert.equal(truncate('c', 'quarter', 'access'), "DateSerial(Year(c), (DatePart('q', c) - 1) * 3 + 1, 1)");
});

// ---- cross-filter ---------------------------------------------------------------------------

const regions = ['NE', 'SE', 'MW'];
const classes = ['DDG', 'CG', 'LHD'];

test('KPI: selections filter the pre-split result locally', () => {
  const p = plan(flag(hoist, 'kpi-orders'));
  const rows: ResultRow[] = [];
  let n = 1;
  for (const r of regions) for (const c of classes) rows.push({ d0: r, d1: c, a0: n++ });
  const b = flag(hoist, 'kpi-orders').behavior;
  assert.equal(applySelections(p, rows, {}, b).rows[0]!.values.work_orders, 45);
  const ne = applySelections(p, rows, { 'jobs.region': ['NE'] }, b);
  assert.equal(ne.rows[0]!.values.work_orders, 1 + 2 + 3);
  assert.deepEqual(ne.applied, ['jobs.region']);
  const both = applySelections(p, rows, { 'jobs.region': ['NE', 'MW'], 'jobs.ship_class': ['CG'] }, b);
  assert.equal(both.rows[0]!.values.work_orders, 2 + 8);
  const none = applySelections(p, rows, { 'jobs.region': ['Nowhere'] }, b);
  assert.deepEqual(none.rows, [{ dims: {}, values: { work_orders: 0 } }], 'a KPI still shows one row');
});

test('avg is rebuilt from sum and count, not averaged twice', () => {
  const f = flag(hoist, 'line-trend');
  const p = plan(f);
  const rows: ResultRow[] = [
    { d0: '2026-09-01', d1: 'DDG', a0: 2, a1: 10, a2: 2 },
    { d0: '2026-09-01', d1: 'CG', a0: 8, a1: 80, a2: 8 },
    { d0: '2026-10-01', d1: 'DDG', a0: 1, a1: 3, a2: 1 },
  ];
  const all = applySelections(p, rows, {}, f.behavior);
  assert.deepEqual(all.rows.map((r) => r.values), [
    { work_orders: 10, avg_days_open: 9 }, // (10 + 80) / (2 + 8), not (5 + 10) / 2
    { work_orders: 1, avg_days_open: 3 },
  ]);
  const region = applySelections(p, rows, { 'jobs.region': ['NE'] }, f.behavior);
  assert.deepEqual(region.applied, [], 'this flag ignores the region filter');
  assert.deepEqual(region.live, []);
  const ddg = applySelections(p, rows, { 'jobs.ship_class': ['DDG'] }, f.behavior);
  assert.deepEqual(ddg.rows.map((r) => r.values.avg_days_open), [5, 3]);
});

test('selections the cached result cannot answer are reported as live', () => {
  const f = flag(hoist, 'kpi-hulls');
  const p = plan(f);
  const r = applySelections(p, [{ a0: 40 }], { 'jobs.region': ['NE'] }, f.behavior);
  assert.deepEqual(r.live, ['jobs.region']);
  assert.equal(r.rows[0]!.values.hulls_affected, 40, 'the stale value is still shown until the live result arrives');
});

test('sort and display limit are applied after re-aggregation; nulls sort last', () => {
  const top: Flag = { ...flag(hoist, 'bar-region'), behavior: { onClick: 'none', ignore: [], thresholds: [] } };
  top.binding = { ...top.binding!, limit: 2 };
  const p = plan(top);
  const rows: ResultRow[] = [
    { d0: 'NE', d1: 'DDG', a0: 5 },
    { d0: 'NE', d1: 'CG', a0: 6 },
    { d0: 'SE', d1: 'DDG', a0: 20 },
    { d0: 'MW', d1: 'CG', a0: null },
    { d0: 'WC', d1: 'CG', a0: 1 },
  ];
  const r = applySelections(p, rows, {}, top.behavior);
  assert.deepEqual(r.rows.map((x) => [x.dims['jobs.region'], x.values.labor_cost]), [['SE', 20], ['NE', 11]]);
  const asc = { ...p, sort: { by: 'labor_cost', dir: 'asc' as const }, displayLimit: undefined };
  assert.deepEqual(applySelections(asc, rows, {}, top.behavior).rows.map((x) => x.dims['jobs.region']), ['WC', 'NE', 'SE', 'MW']);
});

test('dates match across drivers that do and do not append midnight', () => {
  const f = flag(hoist, 'line-trend');
  const p = plan(f);
  const rows: ResultRow[] = [{ d0: '2026-09-01T00:00:00.000Z', d1: 'DDG', a0: 1, a1: 1, a2: 1 }];
  const r = applySelections(p, rows, { 'jobs.opened@month': ['2026-09-01'] }, f.behavior);
  assert.equal(r.rows.length, 1);
});

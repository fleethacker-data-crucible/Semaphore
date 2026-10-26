import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, indexCatalog } from '../src/core/catalog.ts';
import { applySelections, lineUp } from '../src/core/crossfilter.ts';
import { parseCsvRecords, readCsv } from '../src/core/csv.ts';
import { runPlan, truncateDate } from '../src/core/engine.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { findInsights, periodName } from '../src/core/insights.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { comparisonPlan, comparisonShift, comparisonWindow, planFlag } from '../src/core/planner.ts';
import { humanize, proposeCatalog } from '../src/core/profile.ts';
import { renderSql } from '../src/core/sql.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const today = new Date('2026-10-26T12:00:00Z');
const tables = fleetSampleRows(today);
const orders = tables['ops.work_orders']!;

function plan(h: Hoist, f: Flag) {
  const p = planFlag(h, f, index);
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

test('sample data: deterministic, inside the window, and shaped like the catalog', () => {
  const again = fleetSampleRows(today);
  assert.deepEqual(again['ops.work_orders']!.slice(0, 5), orders.slice(0, 5));
  assert.equal(orders.length, 6000);
  for (const r of orders.slice(0, 200)) {
    assert.ok(String(r.opened_on) <= '2026-10-26' && String(r.opened_on) >= '2024-10-26');
    assert.equal(typeof r.labor_cost, 'number');
  }
});

test('engine: totals and groups match a hand count, with the page filter applied', () => {
  const p = plan(hoist, flag(hoist, 'bar-region'));
  const { rows } = runPlan(p, index, tables, today);
  const from = '2025-11-01'; // last 12 months on 26 Oct 2026 starts 1 Nov 2025
  const want = new Map<string, number>();
  for (const r of orders) if (String(r.opened_on) >= from) want.set(String(r.region), (want.get(String(r.region)) ?? 0) + Number(r.labor_cost));
  // The bar is pre-split by the ship-class picker, so add the slices back up locally.
  const shown = applySelections(p, rows, {}, flag(hoist, 'bar-region').behavior);
  assert.equal(shown.rows.length, want.size);
  for (const r of shown.rows) assert.equal(r.values.labor_cost, want.get(String(r.dims['jobs.region'])));
  // Sorted by cost, highest first.
  const costs = shown.rows.map((r) => r.values.labor_cost as number);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a));
});

test('engine + crossfilter: a selection applied locally equals asking the source again', () => {
  const f = flag(hoist, 'bar-region');
  const p = plan(hoist, f);
  const local = applySelections(p, runPlan(p, index, tables, today).rows, { 'jobs.ship_class': ['Icebreaker', 'Tug'] }, f.behavior);
  assert.deepEqual(local.applied, ['jobs.ship_class']);
  const asked = { ...f, binding: { ...f.binding!, filters: [{ field: 'jobs.ship_class', op: 'in' as const, values: ['Icebreaker', 'Tug'] }] } };
  const h2 = { ...hoist, flags: hoist.flags.filter((x) => x.id !== 'filter-class') };
  const p2 = plan(h2, asked);
  const direct = applySelections(p2, runPlan(p2, index, tables, today).rows, {}, f.behavior);
  assert.deepEqual(local.rows, direct.rows);
});

test('engine: averages rebuilt from partials, distinct counts, KPIs with nothing matched', () => {
  const kpi = (metric: string, extra: Partial<Flag> = {}): Flag => ({ ...flag(hoist, 'kpi-orders'), binding: { metrics: [metric], dimensions: [], filters: [] }, ...extra });
  const h = { ...hoist, flags: [] };
  const avg = applySelections(plan(h, kpi('avg_days_open')), runPlan(plan(h, kpi('avg_days_open')), index, tables, today).rows, {}, kpi('x').behavior);
  const recent = orders.filter((r) => String(r.opened_on) >= '2025-11-01');
  const mean = recent.reduce((s, r) => s + Number(r.days_open), 0) / recent.length;
  assert.ok(Math.abs((avg.rows[0]!.values.avg_days_open as number) - mean) < 1e-9);
  const hulls = runPlan(plan(h, kpi('hulls_affected')), index, tables, today).rows[0]!;
  assert.equal(Object.values(hulls)[0], new Set(recent.map((r) => r.hull_no)).size);
  const none = { ...h, filters: [{ field: 'jobs.region', op: 'eq' as const, values: ['Atlantis'] }] };
  const empty = runPlan(plan(none, kpi('work_orders')), index, tables, today);
  assert.deepEqual(Object.values(empty.rows[0]!), [0]);
});

test('engine: date grains truncate like the SQL dialects (UTC, weeks from Monday)', () => {
  assert.equal(truncateDate('2026-10-26', 'week'), '2026-10-26'); // a Monday
  assert.equal(truncateDate('2026-11-01', 'week'), '2026-10-26'); // the Sunday after
  assert.equal(truncateDate('2026-08-17T15:30:00', 'quarter'), '2026-07-01');
  assert.equal(truncateDate('2026-08-17', 'year'), '2026-01-01');
  assert.equal(truncateDate('not a date', 'month'), null);
});

test('engine: row limits mark the result truncated', () => {
  const f: Flag = { ...flag(hoist, 'bar-region'), binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.hull' }], filters: [] } };
  const p = { ...plan({ ...hoist, flags: [] }, f), limit: 10 };
  const r = runPlan(p, index, tables, today);
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, true);
});

test('comparison windows are like for like', () => {
  assert.deepEqual(comparisonWindow(3, 'month', 'previous-period', today), { from: '2026-05-01', to: '2026-07-26' });
  assert.deepEqual(comparisonWindow(3, 'month', 'previous-year', today), { from: '2025-08-01', to: '2025-10-26' });
  assert.deepEqual(comparisonWindow(1, 'quarter', 'previous-period', today), { from: '2026-07-01', to: '2026-07-26' });
  // Month ends clamp.
  assert.deepEqual(comparisonWindow(1, 'month', 'previous-period', new Date('2026-03-31T00:00:00Z')), { from: '2026-02-01', to: '2026-02-28' });
});

test('comparison: a KPI against the previous year, through SQL and the engine', () => {
  const f: Flag = { ...flag(hoist, 'kpi-cost'), binding: { metrics: ['labor_cost'], dimensions: [], filters: [], compare: 'previous-year' } };
  const p = plan(hoist, f);
  assert.deepEqual(p.compare, { kind: 'previous-year', filter: 0 });
  const prev = comparisonPlan(p, today)!;
  assert.deepEqual(prev.filters[0], { field: 'jobs.opened', op: 'between', values: ['2024-11-01', '2025-10-26'] });
  const sql = renderSql(prev, index, today);
  assert.match(sql.sql, /"opened_on" >= \$1 AND "opened_on" < \$2/);
  assert.deepEqual(sql.params.map((x) => x.value), ['2024-11-01', '2025-10-27']);
  const now = applySelections(p, runPlan(p, index, tables, today).rows, {}, f.behavior);
  const before = applySelections(prev, runPlan(prev, index, tables, today).rows, {}, f.behavior);
  const lined = lineUp(now.rows, before.rows);
  assert.equal(typeof lined[0]?.labor_cost, 'number');
  // The sample's costs climb in the Gulf, so this year is up on last.
  const insights = findInsights({ flag: f, rows: now.rows, previous: lined, today }, index);
  assert.match(insights[0]!.text, /^Labor cost is up \d+% on a year earlier/);
  // Without a "last" filter there is nothing to compare, and the plan says so.
  const bare = plan({ ...hoist, filters: [] }, f);
  assert.equal(bare.compare, undefined);
  assert.match(bare.notes.join(' '), /needs a "last N" date filter/);
});

test('comparison: a monthly line lines up each month with the same month a year earlier', () => {
  const f: Flag = { ...flag(hoist, 'line-trend'), binding: { metrics: ['work_orders'], dimensions: [{ field: 'jobs.opened', grain: 'month' }], filters: [], compare: 'previous-year' } };
  const p = plan(hoist, f);
  const prev = comparisonPlan(p, today)!;
  const now = applySelections(p, runPlan(p, index, tables, today).rows, {}, f.behavior);
  const before = applySelections(prev, runPlan(prev, index, tables, today).rows, {}, f.behavior);
  const lined = lineUp(now.rows, before.rows, comparisonShift(p)!);
  const matched = lined.filter((x) => x !== null).length;
  assert.equal(matched, now.rows.length);
});

test('totals are taken before a top-N cut', () => {
  const f: Flag = { ...flag(hoist, 'bar-region'), binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.hull' }], filters: [], sort: { by: 'labor_cost', dir: 'desc' }, limit: 5, share: true } };
  const p = plan(hoist, f);
  assert.equal(p.share, true);
  const r = applySelections(p, runPlan(p, index, tables, today).rows, {}, f.behavior);
  assert.equal(r.rows.length, 5);
  const shownSum = r.rows.reduce((s, x) => s + (x.values.labor_cost as number), 0);
  assert.ok((r.totals.labor_cost as number) > shownSum);
});

test('positional placeholders for ODBC and OLE DB', () => {
  const p = plan(hoist, flag(hoist, 'bar-region'));
  assert.match(renderSql(p, index, today).sql, /\$1/);
  const q = renderSql(p, index, today, { placeholders: 'question' });
  assert.doesNotMatch(q.sql, /\$\d/);
  assert.match(q.sql, /\?/);
});

test('insights: trends skip the running period, categories show leaders and outliers', () => {
  const line: Flag = { ...flag(hoist, 'line-trend'), binding: { metrics: ['work_orders'], dimensions: [{ field: 'jobs.opened', grain: 'month' }], filters: [] } };
  const rows = [
    ['2026-07-01', 100],
    ['2026-08-01', 110],
    ['2026-09-01', 150],
    ['2026-10-01', 20],
  ].map(([at, v]) => ({ dims: { 'jobs.opened@month': at as string }, values: { work_orders: v as number } }));
  const t = findInsights({ flag: line, rows, today }, index).map((i) => i.text);
  assert.ok(t.includes('Work orders rose 36% in September 2026 on the month before.'), t.join(' | '));
  assert.ok(t.some((x) => /October 2026 is still running/.test(x)));

  const bar = flag(hoist, 'bar-region');
  const cats = [['A', 1000], ['B', 100], ['C', 110], ['D', 90], ['E', 105], ['F', 95]].map(([k, v]) => ({ dims: { 'jobs.region': k as string }, values: { labor_cost: v as number } }));
  const c = findInsights({ flag: bar, rows: cats }, index).map((i) => i.text);
  assert.ok(c.some((x) => /^A is 67% of all labor cost\.$/.test(x)), c.join(' | '));
  assert.ok(c.some((x) => /^A stands out/.test(x)), c.join(' | '));
  assert.equal(periodName('2026-04-01', 'quarter'), 'Q2 2026');
});

test('CSV: quoting, delimiters, types, and names made safe', () => {
  assert.deepEqual(parseCsvRecords('a,b\r\n"x, y","he said ""hi"""\n1,2'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  assert.deepEqual(parseCsvRecords('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
  const csv = 'Ship Name,Cost ($),Opened,Active,Zip\nAlpha,"$1,200.50",3/4/2026,yes,02134\nBeta,300,2026-05-01,no,10001\nAlpha,,2026-05-02T00:00:00Z,no,94105\n';
  const t = readCsv('C:\\data\\Q3 work-orders.csv', csv);
  assert.equal(t.name, 'Q3_work_orders');
  assert.deepEqual(t.columns, [
    { name: 'Ship Name', type: 'string' },
    { name: 'Cost', type: 'number' },
    { name: 'Opened', type: 'date' },
    { name: 'Active', type: 'boolean' },
    { name: 'Zip', type: 'string' },
  ]);
  assert.deepEqual(t.rows[0], { 'Ship Name': 'Alpha', Cost: 1200.5, Opened: '2026-03-04', Active: true, Zip: '02134' });
  assert.equal(t.rows[2]!.Opened, '2026-05-02');
  assert.equal(t.rows[2]!.Cost, null);
  assert.equal(t.profile.columns[0]!.distinct, 2);
});

test('auto-catalog: labels, synonyms and measures from a profile, and it checks clean', () => {
  assert.equal(humanize('QtyOnHand'), 'quantity on hand');
  assert.equal(humanize('hull_no'), 'hull number');
  const { catalog, notes } = proposeCatalog({
    source: { id: 'wh', label: 'Warehouse', kind: 'postgres', dialect: 'postgres' },
    tables: [
      {
        name: 'ops.work_orders',
        rows: 50000,
        columns: [
          { name: 'wo_id', type: 'number', distinct: 50000 },
          { name: 'hull_no', type: 'string', distinct: 180 },
          { name: 'region', type: 'string', distinct: 6 },
          { name: 'opened_on', type: 'date', distinct: 700 },
          { name: 'labor_cost', type: 'number' },
          { name: 'days_open', type: 'number' },
          { name: 'fiscal_year', type: 'number', distinct: 4 },
          { name: 'bad;name', type: 'string' },
        ],
      },
    ],
  });
  assert.deepEqual(checkCatalog(catalog), []);
  const fields = Object.fromEntries(catalog.fields.map((f) => [f.column, f]));
  assert.equal(fields.hull_no!.label, 'Hull number');
  assert.ok(fields.hull_no!.synonyms!.includes('hull'));
  assert.equal(fields.wo_id!.type, 'string', 'an id is grouped by, not added');
  assert.equal(fields.fiscal_year!.type, 'string');
  assert.equal(fields.region!.cardinality, 6);
  const metrics = Object.fromEntries(catalog.metrics.map((m) => [m.label, m]));
  assert.equal(metrics['Work orders']!.agg, 'count');
  assert.equal(metrics['Labor cost']!.agg, 'sum');
  assert.equal(metrics['Labor cost']!.format, 'currency');
  assert.equal(metrics['Average days open']!.agg, 'avg');
  assert.equal(metrics['Hulls affected']!.agg, 'count_distinct');
  assert.ok(notes.some((n) => /bad;name/.test(n)));
  // The proposed catalog is good enough to draft from straight away.
  const i2 = indexCatalog(catalog);
  const brief = 'Labor cost by region';
  const d = draftFlagLocally(brief, 'bar', i2);
  assert.deepEqual(d.binding?.dimensions.map((x) => x.field), [fields.region!.key]);
});

test('CSV to catalog to chart, end to end in memory', () => {
  const lines = ['Region,Cost,Opened'];
  for (let i = 0; i < 60; i++) lines.push(`${['North', 'South', 'East'][i % 3]},${100 + i},2026-0${1 + (i % 9)}-15`);
  const t = readCsv('costs.csv', lines.join('\n'));
  const { catalog } = proposeCatalog({ source: { id: 'csv', label: 'costs.csv', kind: 'csv', dialect: 'ansi' }, tables: [t.profile] });
  const i2 = indexCatalog(catalog);
  const d = draftFlagLocally('Cost by region', 'bar', i2);
  assert.ok(d.binding);
  const h: Hoist = { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters: [], flags: [], updated: '' };
  const f: Flag = { id: 'f', kind: d.kind, title: d.title, brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, binding: d.binding, behavior: d.behavior, status: 'drafted', notes: [] };
  const p = planFlag(h, f, i2);
  assert.ok(p.ok);
  const r = applySelections(p.plan, runPlan(p.plan, i2, { [t.name]: t.rows }, today).rows, {}, f.behavior);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.reduce((s, x) => s + (x.values[d.binding!.metrics[0]!] as number), 0), lines.slice(1).reduce((s, l) => s + Number(l.split(',')[1]), 0));
});

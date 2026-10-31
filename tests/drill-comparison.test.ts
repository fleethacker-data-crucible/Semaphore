// Comparisons under a drill and in shared reports. The oracle is a plain loop over the sample
// rows, so a number is checked against the data and not against the code that produced it; the SQL
// the planner renders is run in SQLite and must return what the in-page engine returns.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexCatalog } from '../src/core/catalog.ts';
import type { Selections } from '../src/core/crossfilter.ts';
import { describeFlag } from '../src/core/describe.ts';
import { drillView, type DrillStep } from '../src/core/drill.ts';
import { comparisonOffset, comparisonPlanFor, comparisonSelections, shiftDrillFilter } from '../src/core/drill-compare.ts';
import { runPlan } from '../src/core/engine.ts';
import { type Flag, type Hoist, parseFilters } from '../src/core/hoist.ts';
import { findInsights } from '../src/core/insights.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import { renderSql } from '../src/core/sql.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { computeFlag, type DataContext } from '../web/src/lib/data.ts';
import { reportView } from '../web/src/lib/report-view.ts';
import { freezeHoist } from '../web/src/lib/reports.ts';
import { reportPayload } from '../web/src/lib/share.ts';
import { loadCatalog, loadHoist } from './fixtures.ts';

const today = new Date('2026-10-26T12:00:00Z');
const tables = fleetSampleRows(today);
type Order = { region: string; ship_class: string; hull_no: string; opened_on: string; labor_cost: number };
const orders = tables['ops.work_orders']! as unknown as Order[];

const catalog = { ...loadCatalog(), hierarchies: [{ id: 'h1', label: 'Class → hull', levels: ['jobs.ship_class', 'jobs.hull'] }] };
const index = indexCatalog(catalog);
const baseHoist = loadHoist();
const ctx: DataContext = { index, local: tables, localSources: new Set(['maint', 'parts']), server: null, today, version: 1 };

const COST = 'labor_cost';
const OPENED = 'jobs.opened';

function makeFlag(id: string, binding: Partial<NonNullable<Flag['binding']>>, extra: Partial<Flag> = {}): Flag {
  return {
    id,
    kind: 'bar',
    title: id,
    brief: '',
    layout: { x: 0, y: 40, w: 6, h: 4 },
    binding: { metrics: [COST], dimensions: [], filters: [], ...binding },
    behavior: { onClick: 'drill', ignore: [], thresholds: [] },
    status: 'ready',
    notes: [],
    ...extra,
  };
}

function hoistWith(flags: Flag[], filters: Hoist['filters'] = baseHoist.filters): Hoist {
  return { ...baseHoist, filters, flags: [...baseHoist.flags.filter((f) => f.kind === 'filter'), ...flags] };
}

// --- the oracle: plain loops over the rows ----------------------------------------------------

const day = (d: Date) => d.toISOString().slice(0, 10);
const quarterOf = (s: string) => day(new Date(Date.UTC(+s.slice(0, 4), Math.floor((+s.slice(5, 7) - 1) / 3) * 3, 1)));
const monthOf = (s: string) => `${s.slice(0, 7)}-01`;
/** The same calendar day `months` months on, for days that exist in both months (true of every date used below). */
const addMonths = (s: string, months: number) => day(new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1 + months, +s.slice(8, 10))));

function sumBy(keep: (r: Order) => boolean, key: (r: Order) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of orders) if (keep(r)) out.set(key(r), (out.get(key(r)) ?? 0) + r.labor_cost);
  return out;
}
const total = (keep: (r: Order) => boolean) => sumBy(keep, () => 'x').get('x');

const cost = (r: { values: Record<string, number | null> } | null | undefined) => r?.values?.[COST] ?? null;

function plan(h: Hoist, f: Flag): QueryPlan {
  const p = planFlag(h, f, index);
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

const byYear = () => makeFlag('by-year', { dimensions: [{ field: OPENED, grain: 'year' }], compare: 'previous-year' });
const year2026: DrillStep = { field: OPENED, grain: 'year', value: '2026-01-01' };
const q3: DrillStep = { field: OPENED, grain: 'quarter', value: '2026-07-01' };
const recentFlag = () => makeFlag('recent', { dimensions: [{ field: OPENED, grain: 'year' }], filters: [{ field: OPENED, op: 'last', values: [3], unit: 'month' }], compare: 'previous-period' });
const classFlag = () => makeFlag('by-class', { dimensions: [{ field: 'jobs.ship_class' }], compare: 'previous-period' });

// --- drilled comparisons: values --------------------------------------------------------------

test('a year bar drilled to quarters compares each quarter with the same quarter a year earlier', async () => {
  const h = hoistWith([byYear()]);
  const view = drillView(byYear(), [year2026], index);
  assert.equal(view.flag.binding?.compare, 'previous-year', 'the comparison is kept going down');
  assert.deepEqual(view.flag.binding?.dimensions, [{ field: OPENED, grain: 'quarter' }]);
  const r = await computeFlag(h, view.flag, {}, ctx);

  // Current window: last 12 months from 1 Nov 2025, narrowed to 2026. Earlier: 1 Nov 2024 to 26 Oct 2025, narrowed to 2025.
  const now = sumBy((o) => o.opened_on >= '2025-11-01' && o.opened_on.startsWith('2026'), (o) => quarterOf(o.opened_on));
  const before = sumBy((o) => o.opened_on >= '2024-11-01' && o.opened_on <= '2025-10-26' && o.opened_on.startsWith('2025'), (o) => quarterOf(o.opened_on));
  const key = `${OPENED}@quarter`;
  assert.deepEqual(r.display.rows.map((x) => x.dims[key]).sort(), ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
  r.display.rows.forEach((row, i) => {
    const q = String(row.dims[key]);
    assert.equal(cost(row), now.get(q), `now ${q}`);
    assert.equal(typeof r.previous![i]?.[COST], 'number');
    assert.equal(r.previous![i]?.[COST], before.get(addMonths(q, -12)), `a year before ${q}`);
  });
  // Q4 is still running, and its earlier side stops at the same day last year (like for like).
  const q4 = r.display.rows.findIndex((x) => x.dims[key] === '2026-10-01');
  assert.equal(r.previous![q4]![COST], total((o) => o.opened_on >= '2025-10-01' && o.opened_on <= '2025-10-26'));

  // The plan behind it: the "last 12 months" filter and the drilled year both moved back.
  const earlier = comparisonPlanFor(r.plan, today)!;
  assert.deepEqual(earlier.filters.map((f) => [f.field, f.op, ...f.values]), [[OPENED, 'between', '2024-11-01', '2025-10-26'], [OPENED, 'between', '2025-01-01', '2025-12-31']]);
  assert.deepEqual(comparisonOffset(r.plan), { unit: 'year', by: 1, field: OPENED });
});

test('drilling on keeps the comparison at the grain of each level, down to months', async () => {
  const h = hoistWith([byYear()]);
  const view = drillView(byYear(), [year2026, q3], index);
  assert.deepEqual(view.flag.binding?.dimensions, [{ field: OPENED, grain: 'month' }]);
  assert.equal(view.detail, false);
  const r = await computeFlag(h, view.flag, {}, ctx);
  const key = `${OPENED}@month`;
  assert.deepEqual(r.display.rows.map((x) => x.dims[key]).sort(), ['2026-07-01', '2026-08-01', '2026-09-01']);
  assert.equal(r.previousRaw!.plan.dimensions.find((d) => d.field === OPENED)?.grain, 'month', 'the earlier window is read by month too');
  const before = sumBy((o) => o.opened_on >= '2025-07-01' && o.opened_on <= '2025-09-30', (o) => monthOf(o.opened_on));
  r.display.rows.forEach((row, i) => assert.equal(r.previous![i]?.[COST], before.get(addMonths(String(row.dims[key]), -12))));
  assert.deepEqual(comparisonPlanFor(r.plan, today)!.filters.map((f) => f.values), [['2024-11-01', '2025-10-26'], ['2025-01-01', '2025-12-31'], ['2025-07-01', '2025-09-30']]);
});

test('a previous-period comparison moves the drilled year back by the window, and the grain lines it up', async () => {
  // Last 3 months (1 Aug to 26 Oct 2026) against 1 May to 26 Jul 2026, three months earlier.
  const f = recentFlag();
  const h = hoistWith([f], []);
  const r = await computeFlag(h, drillView(f, [year2026], index).flag, {}, ctx);
  const earlier = comparisonPlanFor(r.plan, today)!;
  assert.deepEqual(earlier.filters.map((x) => x.values), [['2026-05-01', '2026-07-26'], ['2025-10-01', '2026-09-30']]);
  const key = `${OPENED}@quarter`;
  assert.deepEqual(r.display.rows.map((x) => x.dims[key]).sort(), ['2026-07-01', '2026-10-01']);
  const sum = (from: string, to: string) => total((o) => o.opened_on >= from && o.opened_on <= to);
  const q3Row = r.display.rows.findIndex((x) => x.dims[key] === '2026-07-01');
  const q4Row = r.display.rows.findIndex((x) => x.dims[key] === '2026-10-01');
  // Aug to Sep (Q3) against May to Jun; 1 to 26 Oct (Q4) against 1 to 26 Jul.
  assert.equal(cost(r.display.rows[q3Row]), sum('2026-08-01', '2026-09-30'));
  assert.equal(r.previous![q3Row]![COST], sum('2026-05-01', '2026-06-30'));
  assert.equal(cost(r.display.rows[q4Row]), sum('2026-10-01', '2026-10-26'));
  assert.equal(r.previous![q4Row]![COST], sum('2026-07-01', '2026-07-26'));
});

test('a category drill narrows both windows to the same class, and the rows behind a value end the comparison', async () => {
  const f = classFlag();
  const h = hoistWith([f]);
  const view = drillView(f, [{ field: 'jobs.ship_class', value: 'Icebreaker' }], index);
  assert.deepEqual(view.flag.binding?.dimensions, [{ field: 'jobs.hull' }]);
  const r = await computeFlag(h, view.flag, {}, ctx);
  // Last 12 months is 1 Nov 2025 on; the window before it is 1 Nov 2024 to 26 Oct 2025.
  const before = sumBy((o) => o.ship_class === 'Icebreaker' && o.opened_on >= '2024-11-01' && o.opened_on <= '2025-10-26', (o) => o.hull_no);
  const now = sumBy((o) => o.ship_class === 'Icebreaker' && o.opened_on >= '2025-11-01', (o) => o.hull_no);
  assert.ok(r.display.rows.length > 5);
  r.display.rows.forEach((row, i) => {
    const hull = String(row.dims['jobs.hull']);
    assert.equal(cost(row), now.get(hull));
    assert.equal(r.previous![i]?.[COST] ?? null, before.get(hull) ?? null);
  });
  assert.ok(r.previous!.some((p) => typeof p?.[COST] === 'number'));
  // The class filter is the same on both sides: nothing was moved.
  assert.deepEqual(comparisonPlanFor(r.plan, today)!.filters.filter((x) => x.field === 'jobs.ship_class'), [{ field: 'jobs.ship_class', op: 'eq', values: ['Icebreaker'], drill: true }]);

  const rows = drillView(f, [{ field: 'jobs.ship_class', value: 'Icebreaker' }, { field: 'jobs.hull', value: 'H-107' }], index);
  assert.equal(rows.detail, true);
  assert.equal(rows.flag.kind, 'table');
  assert.equal(rows.flag.binding?.compare, undefined, 'a list of rows is not a series to compare');
  assert.equal((await computeFlag(h, rows.flag, {}, ctx)).previous, undefined);
});

test('insights read the drilled comparison like the top level one', async () => {
  const f = classFlag();
  const view = drillView(f, [{ field: 'jobs.ship_class', value: 'Icebreaker' }], index).flag;
  const r = await computeFlag(hoistWith([f]), view, {}, ctx);
  assert.match(findInsights({ flag: view, rows: r.display.rows, previous: r.previous!, today }, index).map((i) => i.text).join(' '), /Biggest move: H-\d+/);
});

test('a flag with no "last N" window says why it does not compare, drilled or not', async () => {
  const f = makeFlag('no-window', { dimensions: [{ field: OPENED, grain: 'year' }], compare: 'previous-year' });
  const r = await computeFlag(hoistWith([f], []), drillView(f, [year2026], index).flag, {}, ctx);
  assert.equal(r.previous, undefined);
  assert.match(r.plan.notes.join(' '), /needs a "last N" date filter/);
});

test('the drill tag is set by drill steps only, never read from a saved hoist, and the back of the card says so', () => {
  const view = drillView(byYear(), [year2026], index).flag;
  assert.deepEqual(view.binding!.filters.map((f) => f.drill), [true]);
  assert.deepEqual(parseFilters([{ field: OPENED, op: 'between', values: ['2026-01-01', '2026-12-31'], drill: true }], index, [], 'x'), [{ field: OPENED, op: 'between', values: ['2026-01-01', '2026-12-31'] }]);
  assert.match(describeFlag(view, baseHoist, index).join(' '), /comparison follows the drill/);
  assert.doesNotMatch(describeFlag(byYear(), baseHoist, index).join(' '), /follows the drill/);
});

test('periods move back whole: month and quarter ends do not drift, and leap days hold', () => {
  const back = (from: string, to: string, unit: 'year' | 'quarter' | 'month', by: number) => shiftDrillFilter({ field: OPENED, op: 'between', values: [from, to], drill: true }, { unit, by }).values;
  assert.deepEqual(back('2026-07-01', '2026-09-30', 'month', 3), ['2026-04-01', '2026-06-30']);
  assert.deepEqual(back('2026-03-01', '2026-03-31', 'month', 1), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(back('2024-02-01', '2024-02-29', 'year', 1), ['2023-02-01', '2023-02-28']);
  assert.deepEqual(back('2026-01-01', '2026-12-31', 'quarter', 4), ['2025-01-01', '2025-12-31']);
  assert.deepEqual(back('x', 'y', 'year', 1), ['x', 'y']);
});

// --- the page's engine and the SQL agree ------------------------------------------------------

test('engine and SQL agree on the current and the earlier window of drilled flags', async (t) => {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    t.skip('node:sqlite is not in this Node');
    return;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS ops");
  db.exec('CREATE TABLE ops.work_orders (region TEXT, ship_class TEXT, status TEXT, opened_on TEXT, hull_no TEXT, labor_cost INTEGER, days_open INTEGER)');
  const ins = db.prepare('INSERT INTO ops.work_orders VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const o of tables['ops.work_orders']!) ins.run(o.region as string, o.ship_class as string, o.status as string, o.opened_on as string, o.hull_no as string, o.labor_cost as number, o.days_open as number);
  db.exec('COMMIT');
  // SQLite has no date_trunc; this one is written here, apart from the engine's, for the grains used.
  db.function('date_trunc', (grain, value) => {
    const s = String(value);
    const y = +s.slice(0, 4);
    const m = +s.slice(5, 7) - 1;
    return new Date(Date.UTC(y, grain === 'year' ? 0 : grain === 'quarter' ? Math.floor(m / 3) * 3 : m, 1)).toISOString().slice(0, 10);
  });

  const viaSql = (p: QueryPlan) => {
    const q = renderSql(p, index, today, { placeholders: 'question' });
    return db.prepare(q.sql).all(...q.params.map((x) => x.value as string | number)) as Array<Record<string, unknown>>;
  };
  const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();

  const cases: Array<[string, Hoist, Flag]> = [
    ['year to quarter, a year earlier', hoistWith([byYear()]), drillView(byYear(), [year2026], index).flag],
    ['quarter to month, a year earlier', hoistWith([byYear()]), drillView(byYear(), [year2026, q3], index).flag],
    ['year to quarter, three months earlier', hoistWith([recentFlag()], []), drillView(recentFlag(), [year2026], index).flag],
    ['class to hull', hoistWith([classFlag()]), drillView(classFlag(), [{ field: 'jobs.ship_class', value: 'Icebreaker' }], index).flag],
  ];
  for (const [name, h, f] of cases) {
    const current = plan(h, f);
    const earlier = comparisonPlanFor(current, today)!;
    assert.ok(earlier, name);
    for (const [label, p] of [['current', current], ['earlier', earlier]] as const) {
      const fromEngine = runPlan(p, index, tables, today).rows;
      assert.ok(fromEngine.length > 0, `${name} ${label} has rows`);
      assert.deepEqual(norm(viaSql(p)), norm(fromEngine), `${name}: ${label} window`);
    }
    // The earlier window's dates are bound, never spliced into the SQL.
    const q = renderSql(earlier, index, today);
    assert.doesNotMatch(q.sql, /20\d\d-\d\d-\d\d/);
    assert.ok(q.params.some((x) => x.type === 'date'));
  }
  db.close();
});

// --- selections narrow the comparison ---------------------------------------------------------

test('a period picked on another flag is looked up one window back', () => {
  const p = plan(hoistWith([byYear()]), byYear());
  assert.deepEqual(comparisonSelections(p, { [`${OPENED}@month`]: ['2026-03-01'], 'jobs.region': ['Gulf'] }), { [`${OPENED}@month`]: ['2025-03-01'], 'jobs.region': ['Gulf'] });
  const recent = makeFlag('recent', { dimensions: [{ field: OPENED, grain: 'month' }], filters: [{ field: OPENED, op: 'last', values: [3], unit: 'month' }], compare: 'previous-period' });
  assert.deepEqual(comparisonSelections(plan(hoistWith([recent], []), recent), { [`${OPENED}@quarter`]: ['2026-10-01'], [`${OPENED}@month`]: ['2026-10-01', null] }), { [`${OPENED}@quarter`]: ['2026-07-01'], [`${OPENED}@month`]: ['2026-07-01', null] });
  const x = makeFlag('x', { dimensions: [{ field: 'jobs.region' }] });
  const sel = { [`${OPENED}@month`]: ['2026-03-01'] };
  assert.equal(comparisonSelections(plan(hoistWith([x]), x), sel), sel, 'no comparison: nothing to move');
});

// A page where the month picker filters the others, and three flags compare.
const monthPicker = makeFlag('pick-month', { metrics: ['work_orders'], dimensions: [{ field: OPENED, grain: 'month' }] }, { behavior: { onClick: 'filter-page', ignore: [], thresholds: [] }, layout: { x: 6, y: 40, w: 6, h: 4 } });
const regionCmp = makeFlag('region-cmp', { dimensions: [{ field: 'jobs.region' }], compare: 'previous-year' }, { behavior: { onClick: 'filter-page', ignore: [], thresholds: [] } });
const costCmp = makeFlag('cost-cmp', { dimensions: [], compare: 'previous-year' }, { kind: 'kpi', behavior: { onClick: 'none', ignore: [], thresholds: [] }, layout: { x: 0, y: 44, w: 3, h: 2 } });
const hullsCmp = makeFlag('hulls-cmp', { metrics: ['hulls_affected'], dimensions: [], compare: 'previous-year' }, { kind: 'kpi', behavior: { onClick: 'none', ignore: [], thresholds: [] }, layout: { x: 3, y: 44, w: 3, h: 2 } });
const pageHoist = hoistWith([monthPicker, regionCmp, costCmp, hullsCmp]);

test('under a picked month the comparison shows the same month a year earlier', async () => {
  const r = await computeFlag(pageHoist, regionCmp, { [`${OPENED}@month`]: ['2026-03-01'] }, ctx);
  const now = sumBy((o) => monthOf(o.opened_on) === '2026-03-01', (o) => o.region);
  const before = sumBy((o) => monthOf(o.opened_on) === '2025-03-01', (o) => o.region);
  assert.equal(r.display.rows.length, now.size);
  r.display.rows.forEach((row, i) => {
    assert.equal(cost(row), now.get(String(row.dims['jobs.region'])));
    assert.equal(r.previous![i]?.[COST], before.get(String(row.dims['jobs.region'])));
  });
});

// --- shared reports ---------------------------------------------------------------------------

const SELECTIONS: Selections[] = [
  { 'jobs.ship_class': ['Icebreaker', 'Tug'] },
  { [`${OPENED}@month`]: ['2026-03-01'] },
  { 'jobs.region': ['Gulf'], [`${OPENED}@month`]: ['2026-01-01', '2026-02-01'] },
  { 'jobs.ship_class': ['Icebreaker'], 'jobs.region': ['Gulf', 'Southwest'] },
];

async function sharedReport() {
  const frozen = await freezeHoist(pageHoist, ctx, index, { keepRaw: true });
  // Through JSON, as the file holds it.
  return JSON.parse(JSON.stringify(reportPayload(pageHoist, frozen, catalog, 'tester', 'light', 'night-watch'))) as ReturnType<typeof reportPayload>;
}

test('a shared report carries each comparison with its earlier rows, and an edition does not', async () => {
  const payload = await sharedReport();
  for (const id of ['region-cmp', 'cost-cmp']) {
    const res = payload.flags.find((x) => x.flag.id === id)!.result as { previous: unknown[]; previousRaw: { plan: QueryPlan; rows: unknown[] } };
    assert.ok(res.previous.length > 0, `${id} carries its comparison`);
    assert.ok(res.previousRaw.rows.length > 0, `${id} carries the earlier window's rows`);
    assert.equal(res.previousRaw.plan.filters.some((x) => x.op === 'between'), true, 'the earlier window, as dates');
  }
  const edition = JSON.stringify(await freezeHoist(pageHoist, ctx, index));
  assert.equal(edition.includes('previousRaw'), false);
  assert.equal(edition.includes('"raw"'), false);
});

test('the report, read offline under a selection, shows what the page computes live', async () => {
  const payload = await sharedReport();
  for (const sel of SELECTIONS) {
    for (const id of ['region-cmp', 'cost-cmp']) {
      const f = payload.flags.find((x) => x.flag.id === id)!;
      const flag = pageHoist.flags.find((x) => x.id === id)!;
      const offline = reportView(f, sel);
      const live = await computeFlag(pageHoist, flag, sel, ctx);
      assert.equal(offline.note, undefined, `${id} ${JSON.stringify(sel)}`);
      assert.deepEqual(offline.result!.display.rows, live.display.rows, `${id} rows ${JSON.stringify(sel)}`);
      assert.deepEqual(offline.result!.previous, live.previous, `${id} comparison ${JSON.stringify(sel)}`);
      assert.ok(offline.result!.previous!.some((p) => typeof p?.[COST] === 'number'), `${id} has an earlier value to show`);
    }
  }
  // No selection: the saved answer, comparison included, untouched.
  const whole = payload.flags.find((x) => x.flag.id === 'region-cmp')!;
  assert.equal(reportView(whole, {}).result, whole.result);
  // A selection on a field the flag ignores changes nothing about it.
  const ignoring = { ...whole, flag: { ...whole.flag, behavior: { ...whole.flag.behavior, ignore: ['jobs.ship_class'] } } };
  assert.equal(reportView(ignoring, { 'jobs.ship_class': ['Tug'] }).result, whole.result);
});

test('the report says so when a comparison cannot follow a selection', async () => {
  const payload = await sharedReport();
  const pick = { 'jobs.ship_class': ['Icebreaker'] };
  // A distinct count is not re-added from pre-split rows, so the database is needed, and the earlier window with it.
  const hulls = reportView(payload.flags.find((x) => x.flag.id === 'hulls-cmp')!, pick);
  assert.equal(hulls.result!.previous, undefined);
  assert.match(hulls.note ?? '', /needs the database.*comparison is not shown/);
  // The earlier rows were too many to keep: the flag is filtered, and shows no comparison for the whole page beside it.
  const kpi = payload.flags.find((x) => x.flag.id === 'cost-cmp')!;
  const { previousRaw: _drop, ...rest } = kpi.result as Record<string, unknown>;
  const trimmed = reportView({ ...kpi, result: rest }, pick);
  assert.equal(trimmed.result!.previous, undefined);
  assert.match(trimmed.note ?? '', /comparison is not shown under a selection.*too large/);
  assert.equal(typeof trimmed.result!.display.rows[0]!.values[COST], 'number');
});

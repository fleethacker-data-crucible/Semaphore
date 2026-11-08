// Regressions from the core review: dates read as written, shares over the true total, blank
// drills in SQL, shared-folder guards, reserved CSV names, previous-window shares, prototype-safe
// lookups, NaN filters, typed filter values and a default order for a top N.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import { applySelections, lineUp } from '../src/core/crossfilter.ts';
import { readCsv, tableName } from '../src/core/csv.ts';
import { calendarDay } from '../src/core/dates.ts';
import { drilledFlag } from '../src/core/drill.ts';
import { filterTest, runPlan, truncateDate } from '../src/core/engine.ts';
import { type Flag, type Hoist, parseBinding, parseFilters } from '../src/core/hoist.ts';
import { comparisonShift, planFlag } from '../src/core/planner.ts';
import { coverage, isEntry } from '../src/core/playbook.ts';
import { humanize } from '../src/core/profile.ts';
import { labelKey } from '../src/core/quality.ts';
import { isSnapshot } from '../src/core/snapshot.ts';
import { renderSql } from '../src/core/sql.ts';
import { learnStyle } from '../src/core/style.ts';
import { flagChartOption } from '../web/src/lib/chart-option.ts';
import { keepValid } from '../web/src/lib/playbook.ts';

const catalog: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'ansi' }],
  fields: [
    { key: 't.region', label: 'Region', source: 's', table: 't', column: 'region', type: 'string', cardinality: 4 },
    { key: 't.amt', label: 'Amount', source: 's', table: 't', column: 'amt', type: 'number' },
    { key: 't.when', label: 'When', source: 's', table: 't', column: 'when', type: 'date' },
    { key: 't.ok', label: 'Ok', source: 's', table: 't', column: 'ok', type: 'boolean' },
  ],
  metrics: [{ key: 'sales', label: 'Sales', agg: 'sum', field: 't.amt', source: 's' }],
  hierarchies: [{ id: 'h', label: 'Region then amount', levels: ['t.region', 't.amt'] }],
};
const index = indexCatalog(catalog);
const behavior = { onClick: 'none' as const, ignore: [], thresholds: [] };
const base: Flag = { id: 'f', kind: 'bar', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior, binding: null };
const hoistFor = (f: Flag): Hoist => ({ version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [f], updated: '' });
const planOf = (f: Flag) => {
  const p = planFlag(hoistFor(f), f, index);
  if (!p.ok) throw new Error(p.error);
  return p.plan;
};

function inZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test('dates: a cell means the calendar day it is written as, east or west of UTC', () => {
  for (const tz of ['Australia/Sydney', 'America/New_York', 'UTC']) {
    inZone(tz, () => {
      assert.equal(truncateDate('2024-03-01T05:00:00', 'month'), '2024-03-01', `${tz}: a morning east of UTC stays in March`);
      assert.equal(truncateDate('2024-02-29T22:00:00', 'month'), '2024-02-01', `${tz}: an evening west of UTC stays in February`);
      assert.equal(truncateDate('2024-02-29T22:00:00', 'day'), '2024-02-29', tz);
      assert.equal(truncateDate('2024-03-01T00:30:00+05:00', 'month'), '2024-03-01', `${tz}: the text wins over its offset`);
      assert.equal(truncateDate('2024-02-29 22:00:00', 'week'), '2024-02-26', tz);
      assert.equal(calendarDay('2024-03-01T00:30:00+05:00'), '2024-03-01');
      // The filter and the bucket agree on the same cell.
      const eq = filterTest({ field: 't.when', op: 'eq', values: ['2024-02-29'] }, { get: (r: { when: string }) => r.when, type: 'date' }, new Date());
      assert.equal(eq({ when: '2024-02-29T22:00:00' }), true, tz);
      // The comparison shift reads a driver's zone-less midnight as that day.
      const plan = planOf({ ...base, binding: { metrics: ['sales'], dimensions: [{ field: 't.when', grain: 'month' }], filters: [{ field: 't.when', op: 'last', values: [3], unit: 'month' }], compare: 'previous-year' } });
      assert.equal(comparisonShift(plan)!('t.when@month', '2025-03-01T00:00:00'), '2026-03-01', tz);
    });
  }
  assert.equal(truncateDate('not a date', 'month'), null);
  assert.equal(calendarDay(null), null);
});

test('share: a top N is never cut at the source, so shares are of the true total', () => {
  const flag: Flag = { ...base, binding: { metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [], sort: { by: 'sales', dir: 'desc' }, limit: 2, share: true } };
  const plan = planOf(flag);
  assert.equal(plan.displayLimit, 2);
  assert.equal(plan.limit, plan.rowCap, 'the source query is not cut');
  assert.doesNotMatch(renderSql(plan, index).sql, /LIMIT 2\b/);
  const rows = [{ region: 'A', amt: 50 }, { region: 'B', amt: 30 }, { region: 'C', amt: 15 }, { region: 'D', amt: 5 }];
  const ran = runPlan(plan, index, { t: rows });
  const display = applySelections(plan, ran.rows, {}, behavior);
  assert.equal(display.rows.length, 2);
  assert.equal(display.totals.sales, 100);
  assert.equal(display.rows[0]!.values.sales! / display.totals.sales!, 0.5);
  // Without share, the cut still happens at the source.
  const cut = planOf({ ...flag, binding: { ...flag.binding!, share: false } });
  assert.equal(cut.limit, 2);
});

test('blank: an eq on an empty value reads as IS NULL in SQL and matches null in the engine', () => {
  const drill: Flag = { ...base, behavior: { ...behavior, onClick: 'drill' }, binding: { metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [] } };
  const drilled = drilledFlag(drill, [{ field: 't.region', value: null }], index);
  assert.deepEqual(drilled.binding!.filters[0], { field: 't.region', op: 'eq', values: [''], drill: true });
  const plan = planOf(drilled);
  const sql = renderSql(plan, index);
  assert.match(sql.sql, /WHERE \("region" IS NULL OR "region" = \?\)/);
  assert.deepEqual(sql.params, [{ value: '', type: 'string' }]);
  const rows = [{ region: null, amt: 7 }, { region: '', amt: 3 }, { region: 'A', amt: 1 }];
  assert.deepEqual(runPlan(plan, index, { t: rows }).rows.map((r) => r.a0), [7, 3]);
  // On a date or a number, blank is IS NULL alone and binds nothing.
  for (const field of ['t.when', 't.amt', 't.ok']) {
    const p = planOf({ ...base, binding: { metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [{ field, op: 'eq', values: [''] }] } });
    const col = index.field(field)!.column;
    const r = renderSql(p, index);
    assert.match(r.sql, new RegExp(`WHERE "${col}" IS NULL`));
    assert.deepEqual(r.params, []);
  }
});

test('shared folder: a malformed entry or snapshot is dropped with a warning, not thrown', () => {
  const good = { version: 1, id: 'e1', question: 'sales by region', kind: 'bar', binding: { metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [] }, pageFilters: [], thresholds: [], phrasings: [], acceptedBy: 'a', acceptedAt: '2026-01-01T00:00:00Z', status: 'active', uses: 0, updated: '' };
  const bad = { ...good, id: 'e2', binding: {} };
  assert.equal(isEntry(good), true);
  assert.equal(isEntry(bad), false);
  assert.equal(isEntry({ ...good, phrasings: [1] }), false);
  assert.equal(isEntry({ ...good, thresholds: [{ metric: 'sales' }] }), false);
  assert.equal(isEntry({ ...good, pageFilters: [{ op: 'last' }] }), false);
  assert.equal(isEntry({ ...good, binding: { ...good.binding, dimensions: ['t.region'] } }), false);
  assert.equal(isSnapshot({ version: 1, id: 's', asOf: '2026-01-01', plan: {}, rows: [] }), false);
  assert.equal(isSnapshot({ version: 1, id: 's', asOf: '2026-01-01', plan: planOf({ ...base, binding: good.binding }), rows: [] }), true);
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => void warned.push(String(m));
  try {
    const kept = keepValid([good, bad, 'junk'], 'playbook entry', isEntry);
    assert.deepEqual(kept.map((e) => e.id), ['e1']);
    assert.equal(warned.length, 2);
    assert.match(warned[0]!, /"e2"/);
    // What survives the guard runs through the code that reads it without a catalog.
    assert.doesNotThrow(() => coverage(kept, index));
    assert.doesNotThrow(() => learnStyle(kept, index));
  } finally {
    console.warn = orig;
  }
});

test('CSV: a column or file named like an object\'s machinery is prefixed, so no row loses a column', () => {
  const t = readCsv('__proto__.csv', 'id,__proto__,constructor\n1,abc,x\n2,,y\n');
  assert.equal(t.name, 'c___proto__');
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'c __proto__', 'c constructor']);
  assert.deepEqual(t.rows[0], { id: 1, 'c __proto__': 'abc', 'c constructor': 'x' });
  assert.equal(t.rows[1]!['c __proto__'], null);
  assert.equal(Object.getPrototypeOf(t.rows[1]), Object.prototype);
  assert.equal(tableName('prototype.csv'), 'c_prototype');
  assert.equal(tableName('jobs.csv'), 'jobs');
});

test('chart: the earlier window of a share flag is a share of its own total', () => {
  const c = { ink: '#111111', ink2: '#222222', ink3: '#333333', line: '#dddddd', panel: '#ffffff', good: '#008000', warn: '#aa7700', bad: '#cc0000' };
  const dims = [{ key: 't.region', field: 't.region', alias: 'd0' }];
  const rows = [{ dims: { 't.region': 'A' }, values: { sales: 100 } }, { dims: { 't.region': 'B' }, values: { sales: 100 } }];
  const previous = lineUp(rows, [{ dims: { 't.region': 'A' }, values: { sales: 50 } }, { dims: { 't.region': 'B' }, values: { sales: 50 } }]);
  const input = (previousTotals?: Record<string, number | null>) =>
    ({
      flag: { ...base, binding: { metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [], share: true, compare: 'previous-period' } },
      result: { plan: { dimensions: dims, own: ['t.region'] }, display: { rows, totals: { sales: 200 } }, previous, ...(previousTotals ? { previousTotals } : {}) },
      index,
      selections: {},
      style: {},
      c,
      colors: ['#2a78d6', '#eb6834'],
    }) as never as Parameters<typeof flagChartOption>[0];
  const series = (o: Record<string, unknown>) => o.series as Array<{ name: string; data: Array<{ value: number } | number> }>;
  const withTotals = series(flagChartOption(input({ sales: 100 })));
  assert.deepEqual(withTotals[0]!.data.map((d) => (d as { value: number }).value), [0.5, 0.5]);
  assert.deepEqual(withTotals[1]!.data, [0.5, 0.5], 'earlier shares use the earlier total');
  const without = series(flagChartOption(input()));
  assert.deepEqual(without[1]!.data, [0.25, 0.25], 'with no earlier total the current one is the fallback');
});

test('lookups: a word that is also Object\'s machinery is just a word', () => {
  assert.equal(humanize('constructor'), 'constructor');
  assert.equal(humanize('qty_on_hand'), 'quantity on hand');
  assert.equal(labelKey('Constructor'), 'constructor');
  assert.equal(labelKey('N.E.'), 'northeast');
});

test('filters: a value that is not a number matches nothing on a number field', () => {
  const inTest = filterTest({ field: 't.amt', op: 'in', values: ['abc', 5] }, { get: (r: { amt: unknown }) => r.amt as never, type: 'number' }, new Date());
  assert.equal(inTest({ amt: 'N/A' }), false);
  assert.equal(inTest({ amt: 5 }), true);
  assert.equal(inTest({ amt: '5' }), true);
  const eq = filterTest({ field: 't.amt', op: 'eq', values: ['abc'] }, { get: (r: { amt: unknown }) => r.amt as never, type: 'number' }, new Date());
  assert.equal(eq({ amt: 'N/A' }), false);
});

test('parse: filter values must read as the field\'s type; a limit gets an order', () => {
  const warnings: string[] = [];
  const filters = parseFilters(
    [
      { field: 't.when', op: 'eq', values: ['2024-3-1'] },
      { field: 't.when', op: 'between', values: ['2024-03-01', '2024-03-31T00:00:00Z'] },
      { field: 't.ok', op: 'eq', values: ['yes'] },
      { field: 't.ok', op: 'in', values: ['true', 'false'] },
      { field: 't.amt', op: 'gte', values: ['ten'] },
      { field: 't.amt', op: 'gte', values: ['10'] },
      { field: 't.region', op: 'eq', values: [''] },
      { field: 't.when', op: 'eq', values: [''] },
    ],
    index,
    warnings,
    'Flag "f"',
  );
  assert.deepEqual(filters.map((f) => `${f.field}:${f.op}`), ['t.when:between', 't.ok:in', 't.amt:gte', 't.region:eq', 't.when:eq']);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0]!, /not a date \(YYYY-MM-DD\)/);
  assert.match(warnings[1]!, /not true or false/);
  assert.match(warnings[2]!, /not a number/);

  const w2: string[] = [];
  const b = parseBinding({ metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [], limit: 5 }, index, w2, 'Flag "f"');
  assert.deepEqual(b!.sort, { by: 'sales', dir: 'desc' });
  assert.equal(b!.limit, 5);
  // No warning: one would mark a reviewed flag as drafted again when its page loads.
  assert.equal(w2.length, 0);
  const w3: string[] = [];
  const kept = parseBinding({ metrics: ['sales'], dimensions: [{ field: 't.region' }], filters: [], limit: 5, sort: { by: 't.region', dir: 'asc' } }, index, w3, 'Flag "f"');
  assert.deepEqual(kept!.sort, { by: 't.region', dir: 'asc' });
  assert.equal(w3.length, 0);
});

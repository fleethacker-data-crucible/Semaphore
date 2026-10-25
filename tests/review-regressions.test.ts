// Regression tests for the issues found in the first independent code review.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, indexCatalog } from '../src/core/catalog.ts';
import { applySelections, type ResultRow } from '../src/core/crossfilter.ts';
import { type Flag, type Hoist, LIMITS, parseHoist } from '../src/core/hoist.ts';
import { validateFlagDraft } from '../src/core/intelligence/contract.ts';
import { draftHoistLocally, draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { ContractProvider, OpenAICompatibleProvider, stripFence, type FetchLike } from '../src/core/intelligence/remote.ts';
import { compact, isValidLayout, place } from '../src/core/layout.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import { renderSql, SqlError } from '../src/core/sql.ts';
import { flag, loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const TODAY = new Date(Date.UTC(2026, 9, 25));
const quiet = { onClick: 'none' as const, ignore: [], thresholds: [] };

function plan(h: Hoist, f: Flag, rowCap?: number): QueryPlan {
  const r = planFlag(h, f, index, rowCap === undefined ? {} : { rowCap });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}

function timed<T>(fn: () => T, maxMs: number, what: string): T {
  const t = performance.now();
  const out = fn();
  const ms = performance.now() - t;
  assert.ok(ms < maxMs, `${what} took ${ms.toFixed(0)} ms`);
  return out;
}

test('#1 a top-N ranked by an average is never cut at the source', () => {
  const f: Flag = {
    ...flag(hoist, 'bar-region'),
    id: 'avg-top',
    behavior: { ...quiet, ignore: ['jobs.ship_class'] },
    binding: { metrics: ['avg_days_open'], dimensions: [{ field: 'jobs.region' }], filters: [], sort: { by: 'avg_days_open', dir: 'desc' }, limit: 3 },
  };
  const p = plan(hoist, f);
  assert.equal(p.limit, 50_000, 'all regions come back');
  assert.equal(p.displayLimit, 3);
  const q = renderSql(p, index, TODAY);
  assert.doesNotMatch(q.sql, /ORDER BY SUM/);
  // Region B has the largest total but a small average; it must not make the top 1.
  const rows: ResultRow[] = [
    { d0: 'A', a0: 30, a1: 3 },
    { d0: 'B', a0: 100, a1: 50 },
    { d0: 'C', a0: 40, a1: 2 },
  ];
  const r = applySelections({ ...p, displayLimit: 1 }, rows, {}, f.behavior);
  assert.deepEqual(r.rows.map((x) => x.dims['jobs.region']), ['C']);
});

test('#2 selecting a value outside a source-cut top-N goes to the source', () => {
  const f: Flag = {
    ...flag(hoist, 'bar-region'),
    behavior: { onClick: 'filter-page', ignore: ['jobs.ship_class'], thresholds: [] },
    binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [], sort: { by: 'labor_cost', dir: 'desc' }, limit: 3 },
  };
  const h: Hoist = { ...hoist, flags: hoist.flags.map((x) => (x.id === f.id ? f : x)) };
  const p = plan(h, f);
  assert.equal(p.limit, 3);
  assert.ok(p.live.includes('jobs.region'));
  const r = applySelections(p, [{ d0: 'A', a0: 9 }, { d0: 'B', a0: 8 }, { d0: 'C', a0: 7 }], { 'jobs.region': ['D'] }, f.behavior);
  assert.deepEqual(r.live, ['jobs.region']);
  assert.deepEqual(r.applied, []);
});

test('#2 a picker keeps listing every value while one is selected', () => {
  const f = flag(hoist, 'filter-class');
  const p = plan(hoist, f);
  const rows: ResultRow[] = [{ d0: 'DDG', d1: 'NE' }, { d0: 'CG', d1: 'NE' }];
  const r = applySelections(p, rows, { 'jobs.ship_class': ['DDG'] }, f.behavior);
  assert.deepEqual(r.rows.map((x) => x.dims['jobs.ship_class']), ['DDG', 'CG']);
});

test('#3 sum/avg/min/max on a non-number field are refused by the catalog check', () => {
  const c = loadCatalog();
  c.metrics.push({ key: 'last_opened', label: 'Last opened', agg: 'max', field: 'jobs.opened', source: 'maint' });
  assert.match(checkCatalog(c).join(' '), /max on a field that is not a number/);
});

test('#4 filter values are bound with their field type; date upper bounds cover the whole day', () => {
  const h: Hoist = { ...hoist, filters: [{ field: 'jobs.opened', op: 'between', values: ['2026-01-01', '2026-03-31'] }] };
  const f: Flag = { ...flag(hoist, 'kpi-orders'), binding: { metrics: ['work_orders'], dimensions: [], filters: [{ field: 'jobs.days_open', op: 'gte', values: ['30'] }] } };
  const q = renderSql(plan(h, f), index, TODAY);
  assert.match(q.sql, /"opened_on" >= \$1 AND "opened_on" < \$2/);
  assert.match(q.sql, /"days_open" >= \$3/);
  assert.deepEqual(q.params.slice(0, 3), [
    { value: '2026-01-01', type: 'date' },
    { value: '2026-04-01', type: 'date' },
    { value: 30, type: 'number' },
  ]);
  const bad: Hoist = { ...hoist, filters: [{ field: 'jobs.opened', op: 'gte', values: ['last tuesday'] }] };
  assert.throws(() => renderSql(plan(bad, f), index, TODAY), SqlError);
});

test('#5 an "in" filter that is too long is removed with a warning, not silently cut', () => {
  const values = Array.from({ length: LIMITS.filterValues + 100 }, (_, i) => `v${i}`);
  const { hoist: h, warnings } = parseHoist({ version: 1, filters: [{ field: 'jobs.hull', op: 'in', values }] }, index);
  assert.equal(h?.filters.length, 0);
  assert.match(warnings.join(' '), /more than 500 values/);
});

test('#6 fence stripping is linear on hostile provider output', () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFence('```\n{"a":1}```'), '{"a":1}');
  assert.equal(stripFence('{"a":1}'), '{"a":1}');
  timed(() => stripFence('```' + ' '.repeat(200_000) + 'x'), 100, 'stripFence');
});

test('#7 local rules stay fast on huge or hostile briefs', () => {
  timed(() => draftHoistLocally('ignore '.repeat(32_000), index), 1500, 'ignore spam');
  timed(() => draftHoistLocally('labor cost red over ' + '1'.repeat(40_000) + 'x over ' + '1'.repeat(40_000) + 'x', index), 1500, 'number spam');
  timed(() => draftHoistLocally('region '.repeat(32_000), index), 1500, 'field spam');
  timed(() => draftFlagLocally('clicking ' + 'a'.repeat(4000), 'bar', index), 500, 'click spam');
  const { hoist: h, warnings } = parseHoist({ version: 1, brief: 'x'.repeat(10_000) }, index);
  assert.equal(h?.brief.length, LIMITS.briefChars);
  assert.match(warnings.join(' '), /brief was cut/);
});

test('#8 non-finite layout input is clamped; no hang, no NaN', () => {
  const items = [{ id: 'a', layout: { x: 0, y: 0, w: 3, h: 2 } }, { id: 'b', layout: { x: 3, y: 0, w: 3, h: 2 } }];
  for (const bad of [{ x: 0, y: Infinity, w: 3, h: 2 }, { x: NaN, y: 0, w: 3, h: 2 }, { x: 0, y: 2e7, w: NaN, h: -Infinity }]) {
    const out = timed(() => place(items, 'a', bad, 12), 200, JSON.stringify(bad));
    assert.ok(isValidLayout(out, 12), JSON.stringify(out));
  }
  assert.equal(isValidLayout([{ id: 'n', layout: { x: NaN, y: 0, w: 1, h: 1 } }], 12), false);
});

test('#9 overlapping layouts from a file are repaired on load', () => {
  const mk = (id: string, x: number, y: number) => ({ id, kind: 'kpi', layout: { x, y, w: 6, h: 4 }, binding: null, status: 'empty' });
  const { hoist: h, warnings } = parseHoist({ version: 1, flags: [mk('a', 0, 0), mk('b', 3, 2), mk('c', 0, 1)] }, index);
  assert.ok(h && isValidLayout(h.flags, 12));
  assert.match(warnings.join(' '), /overlapped/);
  assert.ok(isValidLayout(compact([{ id: 'p', layout: { x: 0, y: 0, w: 4, h: 4 } }, { id: 'q', layout: { x: 2, y: 1, w: 4, h: 4 } }]), 12));
});

test('#10 untrusted arrays are capped and warnings are bounded', () => {
  const draft = { kind: 'bar', binding: { metrics: Array.from({ length: 1_000_000 }, (_, i) => `m${i}`).concat('labor_cost'), dimensions: [{ field: 'jobs.region' }] } };
  const d = timed(() => validateFlagDraft(draft, index, 'bar'), 1000, 'huge metric list');
  assert.ok(d.notes.length <= LIMITS.warnings + 1);
  assert.deepEqual(d.binding?.metrics, [], 'labor_cost was past the cap, so it was not read');
  assert.match(d.notes.join(' '), /only the first 50/);
  const flags = Array.from({ length: 50_000 }, (_, i) => ({ id: `f${i}`, kind: 'kpi', layout: { x: 0, y: i % 1000, w: 1, h: 1 } }));
  const { hoist: h, warnings } = timed(() => parseHoist({ version: 1, flags }, index), 3000, 'many flags');
  assert.equal(h?.flags.length, LIMITS.flags);
  assert.ok(warnings.length <= LIMITS.warnings + 1);
});

test('#11 a result that hit the row cap is marked truncated and selections go to the source', () => {
  const f = flag(hoist, 'kpi-orders');
  const p = plan(hoist, f, 72);
  const rows: ResultRow[] = Array.from({ length: 72 }, (_, i) => ({ d0: `r${i % 6}`, d1: `c${i}`, a0: 1 }));
  const r = applySelections(p, rows, { 'jobs.region': ['r0'] }, f.behavior);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.live, ['jobs.region']);
  assert.deepEqual(r.applied, []);
  assert.equal(applySelections(p, rows.slice(0, 10), {}, f.behavior).truncated, false);
});

test('booleans can be selected', () => {
  const c = loadCatalog();
  c.fields.push({ key: 'jobs.urgent', label: 'Urgent', source: 'maint', table: 'ops.work_orders', column: 'urgent', type: 'boolean', cardinality: 2 });
  const idx = indexCatalog(c);
  const picker: Flag = { ...flag(hoist, 'filter-class'), id: 'urgent', binding: { metrics: [], dimensions: [{ field: 'jobs.urgent' }], filters: [] } };
  const h: Hoist = { ...hoist, flags: [...hoist.flags, picker] };
  const r = planFlag(h, flag(hoist, 'kpi-orders'), idx);
  assert.ok(r.ok);
  const alias = r.plan.dimensions.find((d) => d.key === 'jobs.urgent')!.alias;
  const rows: ResultRow[] = [{ [alias]: true, a0: 3 }, { [alias]: false, a0: 4 }].map((x) => ({ d0: 'NE', d1: 'DDG', d2: 'x', ...x }));
  const out = applySelections(r.plan, rows, { 'jobs.urgent': [true] }, quiet);
  assert.equal(out.rows[0]!.values.work_orders, 3);
});

test('Azure SQL gets T-SQL: brackets, TOP, @p binds, DATETRUNC; mismatched dialects are flagged', () => {
  const c = loadCatalog();
  c.sources[0]!.kind = 'azure-sql';
  c.sources[0]!.dialect = 'ansi';
  assert.match(checkCatalog(c).join(' '), /use tsql/);
  c.sources[0]!.dialect = 'tsql';
  const q = renderSql(plan(hoist, flag(hoist, 'line-trend')), indexCatalog(c), TODAY);
  assert.match(q.sql, /^SELECT TOP 50000 DATETRUNC\(month, \[opened_on\]\) AS \[d0\]/);
  assert.match(q.sql, /FROM \[ops\]\.\[work_orders\] WHERE \[opened_on\] >= @p1 GROUP BY/);
  assert.doesNotMatch(q.sql, /LIMIT|FETCH/);
});

test('provider drafts are reshaped to fit their kind', () => {
  const pick = validateFlagDraft({ kind: 'filter', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.status' }] } }, index, 'filter');
  assert.deepEqual(pick.binding, { metrics: [], dimensions: [{ field: 'jobs.region' }], filters: [] });
  assert.equal(pick.behavior.onClick, 'filter-page');
  const kpi = validateFlagDraft({ kind: 'kpi', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }] } }, index, 'kpi');
  assert.equal(kpi.kind, 'bar');
  const pie = validateFlagDraft({ kind: 'pie', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.status' }] } }, index, 'pie');
  assert.equal(pie.binding?.dimensions.length, 1);
});

test('oversized provider responses are refused', async () => {
  const big = 'x'.repeat(2_000_001);
  const fetch: FetchLike = () => Promise.resolve({ ok: true, status: 200, text: async () => big });
  await assert.rejects(new ContractProvider({ id: 'g', label: 'G', url: 'https://g.example.mil', fetch }).ping(), /larger than Semaphore accepts/);
  await assert.rejects(new OpenAICompatibleProvider({ id: 'o', label: 'O', url: 'https://o.example.mil/v1', fetch }).listModels(), /larger/);
});

test('compact floats a far-away flag up in one step', () => {
  const out = timed(() => compact([{ id: 'a', layout: { x: 0, y: 0, w: 4, h: 2 } }, { id: 'b', layout: { x: 2, y: 20_000_000, w: 4, h: 2 } }]), 50, 'compact');
  assert.deepEqual(out[1]!.layout, { x: 2, y: 2, w: 4, h: 2 });
});

test('dates written with a +00:00 offset match plain dates', () => {
  const f = flag(hoist, 'line-trend');
  const p = plan(hoist, f);
  const rows: ResultRow[] = [{ d0: '2026-01-01T00:00:00+00:00', d1: 'DDG', a0: 5, a1: 1, a2: 1 }];
  assert.equal(applySelections(p, rows, { 'jobs.opened@month': ['2026-01-01'] }, f.behavior).rows.length, 1);
});

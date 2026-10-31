import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DrillStep, drillView } from '../src/core/drill.ts';
import type { Flag } from '../src/core/hoist.ts';
import { drillKey, type FrozenFlag, findDrillNode } from '../src/core/reports.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { computeFlag, type DataContext, type FlagResult } from '../web/src/lib/data.ts';
import { freezeDrill } from '../web/src/lib/report-drill.ts';
import { freezeHoist } from '../web/src/lib/reports.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const today = new Date('2026-10-26T12:00:00Z');
const ctx: DataContext = { index, local: fleetSampleRows(today), localSources: new Set(['maint', 'parts']), server: null, today, version: 1 };

/** Labor cost by year of the opened date, set to drill: year, then quarter, month, day, then the rows. */
const byYear: Flag = {
  ...flag(hoist, 'bar-region'),
  id: 'by-year',
  binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened', grain: 'year' }], filters: [] },
  behavior: { onClick: 'drill', ignore: [], thresholds: [] },
};
const h = { ...hoist, filters: [], flags: [byYear] };

const cost = (r: FlagResult) => r.display.rows.reduce((a, x) => a + (x.values['labor_cost'] ?? 0), 0);
const lite = (r: unknown) => r as FlagResult;
const budget = (n: number) => ({ left: n });

async function top(): Promise<FlagResult> {
  return computeFlag(h, byYear, {}, ctx);
}

test('levels below a drillable flag are saved breadth first: year, then its quarters, then their months', async () => {
  const t = await top();
  const nodes = await freezeDrill(h, byYear, t, ctx, index, budget(500));
  assert.ok(nodes.length > t.display.rows.length, 'more than the top level');
  const depth = (n: { steps: DrillStep[] }) => n.steps.length;
  assert.deepEqual(nodes.map(depth), [...nodes.map(depth)].sort((a, b) => a - b), 'upper levels come first');
  assert.equal(nodes.filter((n) => depth(n) === 1).length, t.display.rows.length, 'one level per year shown');
  assert.ok(nodes.some((n) => depth(n) === 3), 'down to the day level');
  assert.ok(nodes.every((n) => !drillView(byYear, n.steps, index).detail), 'the rows behind a value are never saved');
});

test('a level adds up to the value it was opened from (labor cost is additive)', async () => {
  const t = await top();
  const nodes = await freezeDrill(h, byYear, t, ctx, index, budget(500));
  const key = 'jobs.opened@year';
  for (const row of t.display.rows) {
    const quarters = nodes.find((n) => n.steps.length === 1 && String(n.steps[0]!.value) === String(row.dims[key]));
    assert.ok(quarters, `year ${row.dims[key]}`);
    assert.ok(Math.abs(cost(lite(quarters.result)) - (row.values['labor_cost'] ?? 0)) < 0.01, `the quarters of ${row.dims[key]} add up to the year`);
  }
  const first = nodes.find((n) => n.steps.length === 2)!;
  const parent = nodes.find((n) => n.steps.length === 1 && drillKey(n.steps) === drillKey(first.steps.slice(0, 1)))!;
  const quarterRow = lite(parent.result).display.rows.find((r) => String(r.dims['jobs.opened@quarter']) === String(first.steps[1]!.value))!;
  assert.ok(Math.abs(cost(lite(first.result)) - (quarterRow.values['labor_cost'] ?? 0)) < 0.01, 'the months add up to the quarter');
});

test('a saved level is exactly what the page shows when it drills the same way', async () => {
  const t = await top();
  const nodes = await freezeDrill(h, byYear, t, ctx, index, budget(60));
  for (const n of nodes.slice(0, 8)) {
    const live = await computeFlag(h, drillView(byYear, n.steps, index).flag, {}, ctx);
    assert.deepEqual(lite(n.result).display.rows, live.display.rows, drillKey(n.steps));
  }
});

test('the budget is respected and the upper levels are the ones that make it in', async () => {
  const t = await top();
  const b = budget(t.display.rows.length + 2);
  const nodes = await freezeDrill(h, byYear, t, ctx, index, b);
  assert.equal(nodes.length, t.display.rows.length + 2);
  assert.equal(b.left, 0);
  assert.equal(nodes.filter((n) => n.steps.length === 1).length, t.display.rows.length);
  assert.deepEqual(await freezeDrill(h, byYear, t, ctx, index, budget(0)), []);
  assert.equal((await freezeDrill(h, byYear, t, ctx, index, budget(500), 3)).length, 3, 'a per-flag cap');
});

test('a flag that does not drill saves nothing, and nodes carry no SQL or raw rows', async () => {
  const plain: Flag = { ...byYear, behavior: { onClick: 'filter-page', ignore: [], thresholds: [] } };
  assert.deepEqual(await freezeDrill(h, plain, await top(), ctx, index, budget(50)), []);
  const nodes = await freezeDrill(h, byYear, await top(), ctx, index, budget(10));
  for (const n of nodes) for (const k of ['sql', 'raw', 'previousRaw']) assert.ok(!(k in (n.result as object)), k);
});

test('the same inputs give the same saved levels', async () => {
  const a = await freezeDrill(h, byYear, await top(), ctx, index, budget(40));
  const b = await freezeDrill(h, byYear, await top(), ctx, index, budget(40));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a reader\'s click finds its level; a level that is not saved is simply not found', async () => {
  const nodes = await freezeDrill(h, byYear, await top(), ctx, index, budget(40));
  const f: FrozenFlag = { flag: byYear, result: null, insights: [], drill: nodes };
  const n = nodes[0]!;
  assert.ok(findDrillNode(f, n.steps));
  assert.ok(findDrillNode(f, [{ ...n.steps[0]!, value: String(n.steps[0]!.value) }]), 'values compare as text, as they do after JSON');
  assert.equal(findDrillNode(f, [{ field: 'jobs.opened', grain: 'year', value: '1999-01-01' }]), null);
  assert.equal(findDrillNode({ drill: undefined }, n.steps), null);
});

test('a shared report carries the levels, and an edition does not', async () => {
  const shared = await freezeHoist(h, ctx, index, { keepRaw: true, keepDrill: true });
  assert.ok((shared[0]!.drill?.length ?? 0) > 0);
  assert.ok(JSON.stringify(shared).length < 5_000_000, 'the file stays a sensible size');
  const edition = await freezeHoist(h, ctx, index);
  assert.equal(edition[0]!.drill, undefined);
  const plainShared = await freezeHoist({ ...h, flags: [{ ...byYear, behavior: { onClick: 'none', ignore: [], thresholds: [] } }] }, ctx, index, { keepRaw: true, keepDrill: true });
  assert.equal(plainShared[0]!.drill, undefined);
});

test('the report reader opens saved levels only for flags that drill (source check)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/src/report.tsx', import.meta.url), 'utf8');
  assert.match(src, /findDrillNode\(f, steps\)/);
  assert.match(src, /drillable = !!f\.drill && f\.flag\.behavior\.onClick === 'drill'/);
  assert.match(src, /This level was not saved in the file/);
  assert.match(src, /The rows behind this value are not saved in the file/);
});

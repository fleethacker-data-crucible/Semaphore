// Pivot maths (src/core/pivot.ts): totals and subtotals, which totals may be added up and which come
// from the data, percentages, ordering, folding, caps, heat shading and the flat table for files.
// Also the pivot kind's place in parsing, fitting and drafting.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import type { DisplayRow } from '../src/core/crossfilter.ts';
import { parseHoist } from '../src/core/hoist.ts';
import { fitShape } from '../src/core/intelligence/contract.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { buildPivot, cellKey, heatLevels, levelKey, neededLevels, needsLevels, type PivotInput, pivotTable } from '../src/core/pivot.ts';
import { parsePivotSpec } from '../src/core/pivot-spec.ts';

// Jobs: region, class, status, cost, days open, hull. Every expected total below is worked out from
// these rows by hand, never from the cells.
const JOBS = [
  { region: 'East', cls: 'A', status: 'open', cost: 10, days: 2, hull: 'h1' },
  { region: 'East', cls: 'A', status: 'done', cost: 20, days: 4, hull: 'h1' },
  { region: 'East', cls: 'A', status: 'done', cost: 0, days: 6, hull: 'h2' },
  { region: 'East', cls: 'B', status: 'open', cost: 5, days: 10, hull: 'h1' },
  { region: 'West', cls: 'A', status: 'done', cost: 40, days: 8, hull: 'h3' },
  { region: 'West', cls: 'C', status: 'open', cost: 25, days: 1, hull: 'h3' },
];
type Job = (typeof JOBS)[number];
type Key = 'region' | 'cls' | 'status';

/** What the source would return for a grouping: the result rows of one level query. */
function group(by: Key[]): DisplayRow[] {
  const groups = new Map<string, Job[]>();
  for (const j of JOBS) {
    const k = JSON.stringify(by.map((f) => j[f]));
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  return [...groups.values()].map((js) => ({
    dims: Object.fromEntries(by.map((f) => [f, js[0]![f]])),
    values: {
      cost: js.reduce((n, j) => n + j.cost, 0),
      jobs: js.length,
      days: js.reduce((n, j) => n + j.days, 0) / js.length,
      hulls: new Set(js.map((j) => j.hull)).size,
      most: Math.max(...js.map((j) => j.cost)),
    },
  }));
}

const ALL = [
  { key: 'cost', agg: 'sum' as const },
  { key: 'jobs', agg: 'count' as const },
  { key: 'days', agg: 'avg' as const },
  { key: 'hulls', agg: 'count_distinct' as const },
  { key: 'most', agg: 'max' as const },
];

function levelsFor(rows: Key[], column: Key | null): Record<string, DisplayRow[]> {
  const out: Record<string, DisplayRow[]> = {};
  for (const [d, c] of neededLevels(rows.length, column !== null)) out[levelKey(d, c)] = group([...rows.slice(0, d), ...(c ? [column!] : [])]);
  return out;
}

function input(extra: Partial<PivotInput> = {}, withLevels = true): PivotInput {
  const rows: Key[] = ['region', 'cls'];
  return { rows, column: 'status', measures: ALL, cells: group(['region', 'cls', 'status']), ...(withLevels ? { levels: levelsFor(rows, 'status') } : {}), ...extra };
}

const line = (g: ReturnType<typeof buildPivot>, ...path: string[]) => g.lines.find((l) => JSON.stringify(l.path) === JSON.stringify(path))!;
const OPEN = cellKey('open');
const DONE = cellKey('done');

test('the levels a pivot needs: every grouping by fewer fields, with and without the column', () => {
  assert.deepEqual(neededLevels(2, true), [[0, false], [0, true], [1, false], [1, true], [2, false]]);
  assert.deepEqual(neededLevels(1, false), [[0, false]]);
  assert.equal(needsLevels([{ key: 'a', agg: 'sum' }, { key: 'b', agg: 'max' }]), false);
  assert.equal(needsLevels([{ key: 'a', agg: 'avg' }]), true);
  assert.equal(needsLevels([{ key: 'a', agg: 'count_distinct' }]), true);
  assert.equal(needsLevels([{ key: 'a', agg: 'sum' }], true), true, 'a many-side split adds nothing up');
});

test('sums, counts and maxima add up from the cells: subtotals, row totals, column totals, grand total', () => {
  const g = buildPivot(input());
  assert.deepEqual(g.columns.map((c) => c.value), ['done', 'open']);
  const eastA = line(g, 'East', 'A');
  assert.equal(eastA.kind, 'leaf');
  assert.equal(eastA.cells[DONE]!.cost!.value, 20);
  assert.equal(eastA.total.cost!.value, 30);
  assert.equal(eastA.total.jobs!.value, 3);
  assert.equal(eastA.total.most!.value, 20);
  const east = line(g, 'East');
  assert.equal(east.kind, 'group');
  assert.equal(east.size, 2);
  assert.equal(east.cells[OPEN]!.cost!.value, 15);
  assert.equal(east.total.cost!.value, 35);
  assert.equal(g.total.cells[DONE]!.cost!.value, 60);
  assert.equal(g.total.cells[OPEN]!.cost!.value, 40);
  assert.equal(g.total.total.cost!.value, 100);
  assert.equal(g.total.total.jobs!.value, 6);
  assert.equal(g.total.total.most!.value, 40);
  // Groups come before their rows.
  assert.deepEqual(g.lines.map((l) => l.path.join('/')), ['East', 'East/A', 'East/B', 'West', 'West/A', 'West/C']);
});

test('an average total is the average of the rows, read from the data, never the sum or the mean of the cells', () => {
  const g = buildPivot(input());
  const eastA = line(g, 'East', 'A');
  // East/A: 2, 4, 6 days. The cells are open 2 and done 5; their sum (7) and mean (3.5) are both wrong.
  assert.equal(eastA.total.days!.value, 4);
  const east = line(g, 'East');
  assert.equal(east.total.days!.value, (2 + 4 + 6 + 10) / 4);
  assert.equal(east.cells[OPEN]!.days!.value, 6, 'East open: 2 and 10');
  assert.equal(g.total.total.days!.value, 31 / 6);
  assert.equal(g.total.cells[DONE]!.days!.value, 6, 'done: 4, 6, 8');
});

test('a distinct count total comes from the data: hull h1 is in two classes but counts once', () => {
  const g = buildPivot(input());
  assert.equal(line(g, 'East', 'A').total.hulls!.value, 2);
  assert.equal(line(g, 'East').total.hulls!.value, 2, 'h1 and h2, not 2 + 1');
  assert.equal(line(g, 'East').cells[OPEN]!.hulls!.value, 1, 'h1 twice is one hull');
  assert.equal(g.total.total.hulls!.value, 3);
});

test('without the level queries, average and distinct-count totals are a dash with the reason, and sums still add up', () => {
  const g = buildPivot(input({}, false));
  const east = line(g, 'East');
  assert.equal(east.total.days!.value, null);
  assert.match(east.total.days!.why!, /average cannot be added up/);
  assert.equal(east.total.hulls!.value, null);
  assert.match(east.total.hulls!.why!, /distinct count/);
  assert.equal(east.total.cost!.value, 35);
  // The cells themselves are still there.
  assert.equal(line(g, 'East', 'A').cells[OPEN]!.days!.value, 2);
  // An empty cell has no number and needs no reason.
  const westC = line(g, 'West', 'C');
  assert.equal(westC.cells[DONE]!.cost!.value, null);
  assert.equal(westC.cells[DONE]!.cost!.why, undefined);
  const table = pivotTable(g, input({}, false), { dim: (_f, v) => String(v), num: (_m, v) => (v === null ? '' : String(v)), fieldLabel: (f) => f, measureLabel: (m) => m });
  const grand = table.rows[table.rows.length - 1]!;
  assert.ok(grand.some((c) => c.text === '—'), 'files write a dash for a total that cannot be had');
});

test('split by a many-side field nothing adds up: sums come from the data too, or a dash', () => {
  const sums = [{ key: 'cost', agg: 'sum' as const }];
  const without = buildPivot(input({ measures: sums, overlap: true }, false));
  assert.equal(line(without, 'East').total.cost!.value, null);
  assert.match(line(without, 'East').total.cost!.why!, /several of these groups/);
  const withLevels = buildPivot(input({ measures: sums, overlap: true }));
  assert.equal(line(withLevels, 'East').total.cost!.value, 35);
});

test('percentages of the row, the column and the whole table, for the cells and the totals', () => {
  const row = buildPivot(input({ spec: { show: { cost: 'row' } } }));
  const eastA = line(row, 'East', 'A');
  assert.equal(eastA.cells[OPEN]!.cost!.shown, 10 / 30);
  assert.equal(eastA.total.cost!.shown, 1);
  assert.equal(eastA.cells[OPEN]!.cost!.value, 10, 'the value stays');
  const col = buildPivot(input({ spec: { show: { cost: 'column' } } }));
  assert.equal(line(col, 'East', 'A').cells[OPEN]!.cost!.shown, 10 / 40);
  assert.equal(line(col, 'East', 'A').total.cost!.shown, 30 / 100);
  assert.equal(col.total.cells[OPEN]!.cost!.shown, 1);
  const all = buildPivot(input({ spec: { show: { cost: 'total', hulls: 'row' } } }));
  assert.equal(line(all, 'East').cells[OPEN]!.cost!.shown, 15 / 100);
  assert.equal(all.total.total.cost!.shown, 1);
  assert.equal(line(all, 'East').cells[OPEN]!.hulls!.shown, 1 / 2, 'a distinct count share uses its true row total');
});

test('an average, a minimum or a maximum is never shown as a share', () => {
  const g = buildPivot(input({ spec: { show: { days: 'row', most: 'total' } } }));
  assert.equal(line(g, 'East', 'A').cells[OPEN]!.days!.shown, 2);
  assert.equal(line(g, 'East', 'A').total.most!.shown, 20);
  assert.ok(g.notes.some((n) => /Only sums and counts/.test(n)));
});

test('rows order by label or by a value in one column or the total; groups order by their subtotal', () => {
  const byLabel = buildPivot(input({ sort: { by: '', dir: 'desc' } }));
  assert.deepEqual(byLabel.lines.map((l) => l.path.join('/')), ['West', 'West/C', 'West/A', 'East', 'East/B', 'East/A']);
  const byTotal = buildPivot(input({ sort: { by: 'cost', dir: 'desc' } }));
  // West 65 before East 35; inside West: A 40, C 25; inside East: A 30, B 5.
  assert.deepEqual(byTotal.lines.map((l) => l.path.join('/')), ['West', 'West/A', 'West/C', 'East', 'East/A', 'East/B']);
  const byOpen = buildPivot(input({ sort: { by: 'cost', col: OPEN, dir: 'asc' } }));
  // Open: East 15, West 25; East/B 5, East/A 10; West/C 25, and West/A has no open cost so it goes last.
  assert.deepEqual(byOpen.lines.map((l) => l.path.join('/')), ['East', 'East/B', 'East/A', 'West', 'West/C', 'West/A']);
  const byAvg = buildPivot(input({ sort: { by: 'days', dir: 'desc' } }));
  // East averages 5.5 days, West 4.5 (from the data, not the cells).
  assert.equal(byAvg.lines[0]!.path[0], 'East');
  // The spec's order is the default; a header click (sort) wins.
  const spec = buildPivot(input({ spec: { sort: { by: 'cost', dir: 'desc' } }, sort: { by: '', dir: 'asc' } }));
  assert.equal(spec.lines[0]!.path[0], 'East');
});

test('columns order by label or by their total', () => {
  assert.deepEqual(buildPivot(input()).columns.map((c) => c.value), ['done', 'open']);
  assert.deepEqual(buildPivot(input({ colSort: { by: '', dir: 'desc' } })).columns.map((c) => c.value), ['open', 'done']);
  assert.deepEqual(buildPivot(input({ colSort: { by: 'jobs', dir: 'desc' } })).columns.map((c) => c.value), ['done', 'open'], 'done 3 jobs, open 3: a tie keeps A to Z');
  assert.deepEqual(buildPivot(input({ colSort: { by: 'cost', dir: 'asc' } })).columns.map((c) => c.value), ['open', 'done']);
});

test('folding a group hides its rows and keeps its subtotal', () => {
  const east = JSON.stringify(['East']);
  const g = buildPivot(input({ collapsed: new Set([east]) }));
  assert.deepEqual(g.lines.map((l) => l.path.join('/')), ['East', 'West', 'West/A', 'West/C']);
  assert.equal(line(g, 'East').open, false);
  assert.equal(line(g, 'East').total.cost!.value, 35);
  assert.equal(g.rowCount, 4, 'every leaf row is still counted');
});

test('the column cap keeps the first 200 columns with a note, and the totals still count every column', () => {
  const cells: DisplayRow[] = [];
  for (let i = 0; i < 250; i++) cells.push({ dims: { r: 'x', c: `c${String(i).padStart(3, '0')}` }, values: { v: 1 } });
  const g = buildPivot({ rows: ['r'], column: 'c', measures: [{ key: 'v', agg: 'sum' }], cells });
  assert.equal(g.columns.length, 200);
  assert.equal(g.columnCount, 250);
  assert.ok(g.notes.some((n) => /first 200 of 250 columns/.test(n)));
  assert.equal(g.lines[0]!.total.v!.value, 250);
  assert.equal(g.total.total.v!.value, 250);
  const capped = buildPivot({ rows: ['r'], column: 'c', measures: [{ key: 'v', agg: 'sum' }], cells, maxColumns: 3 });
  assert.equal(capped.columns.length, 3);
});

test('the row cap draws the first rows with a note', () => {
  const cells: DisplayRow[] = Array.from({ length: 30 }, (_, i) => ({ dims: { r: i }, values: { v: i } }));
  const g = buildPivot({ rows: ['r'], column: null, measures: [{ key: 'v', agg: 'sum' }], cells, maxRows: 10 });
  assert.equal(g.lines.length, 10);
  assert.equal(g.rowCount, 30);
  assert.ok(g.notes.some((n) => /first 10 rows of 30/.test(n)));
  assert.equal(g.total.total.v!.value, 435);
});

test('one field is a one-way table with a grand total', () => {
  const cells = group(['region']);
  const g = buildPivot({ rows: ['region'], column: null, measures: ALL, cells, levels: { [levelKey(0, false)]: group([]) } });
  assert.deepEqual(g.columns, []);
  assert.deepEqual(g.lines.map((l) => [l.kind, l.label, l.total.cost!.value]), [['leaf', 'East', 35], ['leaf', 'West', 65]]);
  assert.equal(g.total.total.cost!.value, 100);
  assert.equal(g.total.total.days!.value, 31 / 6);
  const heat = heatLevels(g, 'cost', 'column');
  assert.equal(heat.get(`${g.lines[0]!.id}\u0000`), 0);
  assert.equal(heat.get(`${g.lines[1]!.id}\u0000`), 1);
});

test('heat shading by row, by column and over the whole table, on leaf cells only', () => {
  const g = buildPivot(input({ measures: [{ key: 'cost', agg: 'sum' }] }));
  const at = (h: Map<string, number>, path: string[], col: string) => h.get(`${line(g, ...path).id}\u0000${col}`);
  const byRow = heatLevels(g, 'cost', 'row');
  assert.equal(at(byRow, ['East', 'A'], DONE), 1);
  assert.equal(at(byRow, ['East', 'A'], OPEN), 0);
  assert.equal(at(byRow, ['East'], OPEN), undefined, 'subtotals are not shaded');
  const byCol = heatLevels(g, 'cost', 'column');
  assert.equal(at(byCol, ['West', 'A'], DONE), 1);
  assert.equal(at(byCol, ['East', 'A'], DONE), 0);
  const whole = heatLevels(g, 'cost', 'table');
  assert.equal(at(whole, ['West', 'A'], DONE), 1);
  assert.equal(at(whole, ['East', 'B'], OPEN), 0);
  assert.equal(at(whole, ['East', 'A'], DONE), (20 - 5) / (40 - 5));
});

test('the flat table for files: field columns, a column per value and measure, totals, subtotal and grand total rows', () => {
  const inp = input({ measures: [{ key: 'cost', agg: 'sum' }, { key: 'days', agg: 'avg' }], spec: { show: { cost: 'row' } } });
  const t = pivotTable(buildPivot(inp), inp, { dim: (_f, v) => String(v), num: (_m, v, share) => (v === null ? '' : share ? `${Math.round(v * 100)}%` : String(v)), fieldLabel: (f) => f.toUpperCase(), measureLabel: (m) => m });
  assert.deepEqual(t.columns.map((c) => c.label), ['REGION', 'CLS', 'done · cost', 'done · days', 'open · cost', 'open · days', 'Total · cost', 'Total · days']);
  assert.equal(t.columns[2]!.share, true);
  assert.equal(t.columns[3]!.share, false);
  assert.deepEqual(t.rows[0]!.map((c) => c.text), ['East', 'Subtotal', '57%', '5', '43%', '6', '100%', '5.5']);
  assert.deepEqual(t.rows[1]!.map((c) => c.text), ['East', 'A', '67%', '5', '33%', '2', '100%', '4']);
  const grand = t.rows[t.rows.length - 1]!;
  assert.equal(grand[0]!.text, 'Grand total');
  assert.equal(grand[7]!.value, 31 / 6);
  assert.equal(t.rows.length, 7);
});

test('a hoist keeps a pivot flag and its settings, and drops settings it does not know', () => {
  const index = indexCatalog(catalog);
  const raw = {
    version: 1,
    id: 'h',
    title: 'P',
    brief: '',
    grid: { cols: 12 },
    filters: [],
    updated: '',
    flags: [{ id: 'p', kind: 'pivot', title: '', brief: '', layout: { x: 0, y: 0, w: 6, h: 5 }, binding: { metrics: ['cost'], dimensions: [{ field: 't.region' }, { field: 't.class' }], filters: [] }, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'ready', notes: [], pivot: { show: { cost: 'row', x: 'nope' }, heat: { cost: 'table' }, sort: { by: 'cost', dir: 'desc', col: '"open"' }, colSort: { by: 1 }, junk: true } }],
  };
  const parsed = parseHoist(raw, index);
  const flag = parsed.hoist?.flags[0];
  assert.equal(flag?.kind, 'pivot');
  assert.deepEqual(flag?.pivot, { show: { cost: 'row' }, heat: { cost: 'table' }, sort: { by: 'cost', dir: 'desc', col: '"open"' } });
  assert.equal(parsePivotSpec('x'), undefined);
  assert.equal(parsePivotSpec({ show: {} }), undefined);
});

const catalog: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'ansi' }],
  fields: [
    { key: 't.region', label: 'Region', source: 's', table: 't', column: 'region', type: 'string', cardinality: 4 },
    { key: 't.class', label: 'Class', source: 's', table: 't', column: 'class', type: 'string', cardinality: 3 },
    { key: 't.status', label: 'Status', source: 's', table: 't', column: 'status', type: 'string', cardinality: 3 },
    { key: 't.amt', label: 'Amount', source: 's', table: 't', column: 'amt', type: 'number' },
  ],
  metrics: [
    { key: 'cost', label: 'Cost', agg: 'sum', field: 't.amt', source: 's' },
    { key: 'jobs', label: 'Jobs', agg: 'count', source: 's' },
  ],
};
const behavior = { onClick: 'none' as const, ignore: [], thresholds: [] };

test('fitShape keeps a pivot with fields, makes it a KPI without, and drops a top-N cut and a sixth field', () => {
  const index = indexCatalog(catalog);
  const ok = fitShape('pivot', { metrics: ['cost'], dimensions: [{ field: 't.region' }, { field: 't.status' }], filters: [] }, behavior, index);
  assert.equal(ok.kind, 'pivot');
  assert.deepEqual(ok.notes, []);
  const none = fitShape('pivot', { metrics: ['cost'], dimensions: [], filters: [] }, behavior, index);
  assert.equal(none.kind, 'kpi');
  assert.match(none.notes.join(' '), /A pivot needs a field/);
  const cut = fitShape('pivot', { metrics: ['cost'], dimensions: [{ field: 't.region' }], filters: [], limit: 10 }, behavior, index);
  assert.equal(cut.kind, 'pivot');
  assert.equal(cut.binding?.limit, undefined);
  assert.match(cut.notes.join(' '), /top-N cut was dropped/);
  const six = fitShape('pivot', { metrics: ['cost'], dimensions: Array.from({ length: 6 }, () => ({ field: 't.region' })), filters: [] }, behavior, index);
  assert.equal(six.binding?.dimensions.length, 5);
});

test('drafting picks a pivot from "pivot", "crosstab", "matrix of" and "by X across Y"', () => {
  const index = indexCatalog(catalog);
  for (const brief of ['Pivot of cost by region and status', 'crosstab of jobs by region and class', 'matrix of cost by region and status', 'cost by region across status']) {
    const d = draftFlagLocally(brief, 'bar', index);
    assert.equal(d.kind, 'pivot', brief);
    assert.deepEqual(d.binding?.dimensions.map((x) => x.field), brief.includes('class') ? ['t.region', 't.class'] : ['t.region', 't.status'], brief);
  }
  assert.equal(draftFlagLocally('heatmap of cost by region and status', 'bar', index).kind, 'heatmap', 'a heatmap is still a heatmap');
  const none = draftFlagLocally('pivot of total cost', 'bar', index);
  assert.equal(none.kind, 'kpi');
  assert.ok(none.notes.some((n) => /A pivot needs a field/.test(n)));
});

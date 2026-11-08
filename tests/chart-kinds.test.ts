// The richer chart kinds: what each needs, what drafting picks from the brief's words, the fallback
// when the fields do not fit, and the options they draw.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import { fitShape } from '../src/core/intelligence/contract.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { drilledFlag } from '../src/core/drill.ts';
import { FLAG_KINDS, type Flag, type FlagKind } from '../src/core/hoist.ts';
import { CHART_KINDS, fitRichKind, RICH_KINDS } from '../src/core/kinds.ts';
import { DEFAULT_SIZE } from '../src/core/layout.ts';
import { richChartOption } from '../web/src/lib/chart-kinds.ts';
import { flagChartOption, setRichBuilder } from '../web/src/lib/chart-option.ts';

const catalog: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'ansi' }],
  fields: [
    { key: 't.region', label: 'Region', source: 's', table: 't', column: 'region', type: 'string', cardinality: 4 },
    { key: 't.class', label: 'Class', source: 's', table: 't', column: 'class', type: 'string', cardinality: 3 },
    { key: 't.amt', label: 'Amount', source: 's', table: 't', column: 'amt', type: 'number' },
    { key: 't.hrs', label: 'Hours', source: 's', table: 't', column: 'hrs', type: 'number' },
    { key: 't.when', label: 'When', source: 's', table: 't', column: 'when', type: 'date' },
  ],
  metrics: [
    { key: 'cost', label: 'Cost', agg: 'sum', field: 't.amt', source: 's' },
    { key: 'hours', label: 'Hours', agg: 'sum', field: 't.hrs', source: 's' },
    { key: 'jobs', label: 'Jobs', agg: 'count', source: 's' },
  ],
  hierarchies: [{ id: 'h', label: 'Region then class', levels: ['t.region', 't.class'] }],
};
const index = indexCatalog(catalog);
const behavior = { onClick: 'filter-page' as const, ignore: [], thresholds: [] };
const c = { ink: '#111111', ink2: '#333333', ink3: '#666666', line: '#dddddd', panel: '#ffffff', good: '#2e7d4f', warn: '#b7791f', bad: '#c0392b' };

test('every new kind is a flag kind, has a size and is drawn as a chart', () => {
  for (const k of RICH_KINDS) {
    assert.ok(FLAG_KINDS.includes(k), k);
    assert.ok(DEFAULT_SIZE[k].w >= 4, k);
    assert.ok(CHART_KINDS.includes(k), k);
  }
});

test('each kind keeps fields that fit and falls back, with a reason, when they do not', () => {
  const b = (dims: string[], metrics: string[]) => ({ metrics, dimensions: dims.map((f) => (f === 't.when' ? { field: f, grain: 'day' as const } : { field: f })), filters: [] });
  const fits: Array<[FlagKind, ReturnType<typeof b>]> = [
    ['radar', b(['t.region'], ['cost', 'hours', 'jobs'])],
    ['radar', b(['t.region', 't.class'], ['cost'])],
    ['scatter', b(['t.region'], ['cost', 'hours'])],
    ['scatter', b(['t.region'], ['cost', 'hours', 'jobs'])],
    ['heatmap', b(['t.region', 't.class'], ['cost'])],
    ['calendar', b(['t.when'], ['jobs'])],
    ['waterfall', b(['t.region'], ['cost'])],
    ['pareto', b(['t.class'], ['cost'])],
    ['sankey', b(['t.region', 't.class'], ['cost'])],
    ['sunburst', b(['t.region', 't.class'], ['cost'])],
    ['stream', b(['t.when', 't.region'], ['cost'])],
  ];
  for (const [k, binding] of fits) assert.deepEqual(fitRichKind(k as never, binding, index), { kind: k }, k);

  const scatter = fitRichKind('scatter', b(['t.region'], ['cost']), index);
  assert.equal(scatter.kind, 'bar');
  assert.match(scatter.note!, /two or three measures/);
  assert.equal(fitRichKind('calendar', b(['t.region'], ['cost']), index).kind, 'bar', 'no date: bars');
  assert.equal(fitRichKind('stream', b(['t.when'], ['cost']), index).kind, 'area', 'one date and nothing to split by: an area');
  assert.equal(fitRichKind('heatmap', b([], ['cost']), index).kind, 'kpi');
});

test('fitShape runs the same check on a draft', () => {
  const r = fitShape('sankey', { metrics: ['cost'], dimensions: [{ field: 't.region' }], filters: [] }, behavior, index);
  assert.equal(r.kind, 'bar');
  assert.ok(r.notes.some((n) => /sankey needs two fields/.test(n)));
});

test('the brief\'s words ask for each kind', () => {
  const kindOf = (brief: string) => draftFlagLocally(brief, 'bar', index).kind;
  assert.equal(kindOf('Spider chart of cost, hours and jobs by region'), 'radar');
  assert.equal(kindOf('Scatter of cost against hours by region'), 'scatter');
  assert.equal(kindOf('Heatmap of cost by region and class'), 'heatmap');
  assert.equal(kindOf('Pareto of cost by class'), 'pareto');
  assert.equal(kindOf('Waterfall of cost by region'), 'waterfall');
  assert.equal(kindOf('Sankey of cost by region and class'), 'sankey');
  assert.equal(kindOf('Sunburst of cost by region and class'), 'sunburst');
  // A scatter needs two measures: one is not enough, so it is drawn as bars and says why.
  const one = draftFlagLocally('Scatter of cost by region', 'bar', index);
  assert.equal(one.kind, 'bar');
  assert.ok(one.notes.some((n) => /scatter needs/.test(n)));
});

test('a drill from a richer kind lands on bars', () => {
  const flag: Flag = { id: 'f', kind: 'pareto', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 4 }, status: 'ready', notes: [], behavior: { ...behavior, onClick: 'drill' }, binding: { metrics: ['cost'], dimensions: [{ field: 't.region' }], filters: [] } };
  const d = drilledFlag(flag, [{ field: 't.region', value: 'North' }], index);
  assert.equal(d.kind, 'bar');
});

// ---- the options ------------------------------------------------------------------------------

type Opt = Record<string, unknown>;
const series = (o: Opt) => o.series as Array<Record<string, unknown>>;

function input(kind: FlagKind, dims: Array<{ field: string; grain?: 'day' | 'month' }>, metrics: string[], rows: Array<{ dims: Record<string, unknown>; values: Record<string, number | null> }>, selections = {}) {
  const keyed = dims.map((d) => ({ ...d, key: d.grain ? `${d.field}@${d.grain}` : d.field }));
  return {
    flag: { id: 'f', kind, title: 'T', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', notes: [], behavior, binding: { metrics, dimensions: dims, filters: [] } },
    result: { plan: { dimensions: keyed, own: keyed.map((d) => d.key) }, display: { rows, totals: {} } },
    index,
    selections,
    style: {},
    c,
    colors: ['#2a78d6', '#eb6834', '#2e7d4f'],
  } as never as Parameters<typeof flagChartOption>[0];
}
const regions = [
  { dims: { 't.region': 'North' }, values: { cost: 120, hours: 30, jobs: 4 } },
  { dims: { 't.region': 'South' }, values: { cost: -40, hours: 10, jobs: 2 } },
  { dims: { 't.region': 'East' }, values: { cost: 60, hours: 50, jobs: 9 } },
];
const grid = [
  { dims: { 't.region': 'North', 't.class': 'A' }, values: { cost: 5 } },
  { dims: { 't.region': 'North', 't.class': 'B' }, values: { cost: 3 } },
  { dims: { 't.region': 'South', 't.class': 'A' }, values: { cost: 2 } },
];

test('before chart-extras.ts loads, a richer kind draws nothing rather than the wrong chart', () => {
  setRichBuilder(null as never);
  assert.deepEqual(series(flagChartOption(input('pareto', [{ field: 't.region' }], ['cost'], regions))), []);
});

test('the richer kinds draw their own series, with each value carried for clicks', () => {
  setRichBuilder(richChartOption);
  const radar = flagChartOption(input('radar', [{ field: 't.region' }], ['cost', 'hours', 'jobs'], regions));
  assert.equal(series(radar)[0]!.type, 'radar');
  assert.equal(((radar.radar as Opt).indicator as unknown[]).length, 3, 'three measures are the spokes');
  assert.deepEqual((series(radar)[0]!.data as Array<{ raw: unknown }>).map((d) => d.raw), ['North', 'South', 'East']);

  const scatter = flagChartOption(input('scatter', [{ field: 't.region' }], ['cost', 'hours', 'jobs'], regions));
  const points = series(scatter)[0]!.data as Array<{ value: number[]; symbolSize: number }>;
  assert.deepEqual(points[0]!.value, [120, 30, 4]);
  assert.ok(points[2]!.symbolSize > points[1]!.symbolSize, 'more jobs, a bigger bubble');

  const heat = flagChartOption(input('heatmap', [{ field: 't.region' }, { field: 't.class' }], ['cost'], grid));
  assert.equal(series(heat)[0]!.type, 'heatmap');
  assert.ok(heat.visualMap);
  assert.deepEqual((series(heat)[0]!.data as Array<{ value: unknown[] }>)[1]!.value, [0, 1, 3]);

  const cal = flagChartOption(input('calendar', [{ field: 't.when', grain: 'day' }], ['jobs'], [{ dims: { 't.when@day': '2026-03-02' }, values: { jobs: 3 } }, { dims: { 't.when@day': '2026-01-05' }, values: { jobs: 1 } }]));
  assert.deepEqual((cal.calendar as Opt).range, ['2026-01-05', '2026-03-02']);

  const walk = flagChartOption(input('waterfall', [{ field: 't.region' }], ['cost'], regions));
  const [lift, step] = series(walk) as [Opt, Opt];
  assert.deepEqual(lift.data, [0, 80, 80, 0], 'each step starts where the last ended');
  assert.deepEqual((step.data as Array<{ value: number }>).map((d) => d.value), [120, 40, 60, 140]);
  assert.equal(((step.data as Array<{ itemStyle: { color: string } }>)[1]!).itemStyle.color, c.bad, 'a fall is drawn in the bad colour');

  const pareto = flagChartOption(input('pareto', [{ field: 't.region' }], ['cost'], regions));
  assert.deepEqual((pareto.xAxis as { data: string[] }).data, ['North', 'East', 'South'], 'largest first');
  assert.deepEqual(series(pareto)[1]!.data, [120 / 180, 1, 1]);

  const sankey = flagChartOption(input('sankey', [{ field: 't.region' }, { field: 't.class' }], ['cost'], grid));
  assert.equal((series(sankey)[0]!.links as unknown[]).length, 3);

  const sun = flagChartOption(input('sunburst', [{ field: 't.region' }, { field: 't.class' }], ['cost'], grid));
  const rings = series(sun)[0]!.data as Array<{ name: string; children: unknown[] }>;
  assert.deepEqual(rings.map((r) => [r.name, r.children.length]), [['North', 2], ['South', 1]]);

  const stream = flagChartOption(input('stream', [{ field: 't.when', grain: 'month' }, { field: 't.region' }], ['cost'], [{ dims: { 't.when@month': '2026-01-01', 't.region': 'North' }, values: { cost: 4 } }]));
  assert.deepEqual(series(stream)[0]!.data, [['2026-01-01', 4, 'North']]);
});

test('a richer kind whose fields do not fit is drawn as bars', () => {
  setRichBuilder(richChartOption);
  const o = flagChartOption(input('sankey', [{ field: 't.region' }], ['cost'], regions));
  assert.equal(series(o)[0]!.type, 'bar');
});

test('a value the page is filtered away from is dimmed', () => {
  setRichBuilder(richChartOption);
  const o = flagChartOption(input('pareto', [{ field: 't.region' }], ['cost'], regions, { 't.region': ['East'] }));
  const bars = series(o)[0]!.data as Array<{ raw: string; itemStyle: { opacity?: number } }>;
  assert.equal(bars.find((d) => d.raw === 'North')!.itemStyle.opacity, 0.35);
  assert.equal(bars.find((d) => d.raw === 'East')!.itemStyle.opacity, undefined);
});

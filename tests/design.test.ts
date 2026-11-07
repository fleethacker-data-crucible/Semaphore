import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartLookOf, colorDistance, colorWarnings, contrastRatio, designAttrs, designVars, LOOKS, PALETTES, paletteColors, parseDesign, parseFlagStyle, resolveStyle, withoutChartLook } from '../src/core/design.ts';
import { flagChartOption, formatDim, gaugeOption } from '../web/src/lib/chart-option.ts';
import { chartMotion } from '../web/src/lib/motion.ts';

const c = { ink: '#111111', ink2: '#222222', ink3: '#333333', line: '#dddddd', panel: '#ffffff', good: '#008000', warn: '#aa7700', bad: '#cc0000' };
const colors = ['#2a78d6', '#eb6834', '#1baf7a'];
const index = { metric: (k: string) => ({ key: k, label: k, format: 'number' }), field: (k: string) => ({ key: k, label: k }) } as never;

function setup(kind: string, rows: Array<{ dims: Record<string, unknown>; values: Record<string, number> }>, two = false, thresholds: unknown[] = []) {
  const dims = two ? [{ key: 'region', field: 'region' }, { key: 'kind', field: 'kind' }] : [{ key: 'region', field: 'region' }];
  return {
    flag: { id: 'a', kind, title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 4 }, binding: { metrics: ['cost'], dimensions: [], filters: [] }, behavior: { onClick: 'none', ignore: [], thresholds }, status: 'ready', notes: [] },
    result: { plan: { dimensions: dims, own: dims.map((d) => d.key) }, display: { rows, totals: {} } },
    index,
    selections: {},
    c,
    colors,
  } as never as Parameters<typeof flagChartOption>[0];
}
const rows = [{ dims: { region: 'East' }, values: { cost: 10 } }, { dims: { region: 'West' }, values: { cost: 30 } }];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const series = (o: Record<string, unknown>) => o.series as Array<Record<string, any>>;

test('a look from a shared file keeps only known values', () => {
  const s = parseFlagStyle({ palette: 'ember', fill: 'url(evil)', corners: 999, colors: ['#123456', 'red;}', '#abcdef'], accent: 'expression(1)', target: { value: 5, label: 'x'.repeat(99) }, gaugeMax: -1, unknown: 1 });
  assert.deepEqual(Object.keys(s!).sort(), ['colors', 'palette', 'target']);
  assert.deepEqual(s!.colors, ['#123456', '#abcdef']);
  assert.equal(s!.target!.label.length, 40);
  assert.equal(parseFlagStyle({ nothing: true }), undefined);
  assert.equal(parseFlagStyle('x'), undefined);
  assert.deepEqual(parseDesign({ card: 'glass', radius: 500, backdrop: "x'", look: 'nope', charts: { motion: 'lively' } }), { card: 'glass', charts: { motion: 'lively' } });
});

test('every look survives being read back', () => {
  for (const l of LOOKS.slice(1)) assert.deepEqual(parseDesign({ ...l.design, look: l.id }), { ...l.design, look: l.id });
});

test('a flag overrides the page, and a page-wide copy leaves what belongs to the flag', () => {
  assert.equal(resolveStyle({ charts: { fill: 'gradient', glow: true } }, { glow: false }).glow, false);
  assert.equal(resolveStyle({ charts: { fill: 'gradient' } }, undefined).fill, 'gradient');
  const style = { fill: 'gradient' as const, target: { value: 5, label: '' }, gaugeMax: 10 };
  assert.deepEqual(chartLookOf(style), { fill: 'gradient' });
  assert.deepEqual(withoutChartLook(style), { target: { value: 5, label: '' }, gaugeMax: 10 });
  assert.equal(withoutChartLook({ fill: 'solid' }), undefined);
});

test('palettes follow the mode, and a custom one with no colours falls back to the skin', () => {
  assert.deepEqual(paletteColors({ palette: 'ember' }, 'dark', ['#000000']), [...PALETTES.ember.dark]);
  assert.deepEqual(paletteColors({}, 'light', ['#000000']), ['#000000']);
  assert.deepEqual(paletteColors({ palette: 'custom' }, 'light', ['#000000']), ['#000000']);
  assert.deepEqual(paletteColors({ palette: 'custom', colors: ['#111111'] }, 'light', ['#000000']), ['#111111']);
});

test('a hand-picked palette is warned about, not refused', () => {
  assert.ok(colorDistance('#2a78d6', '#2b79d7') < 2);
  assert.ok(contrastRatio('#000000', '#ffffff') > 20);
  assert.deepEqual(colorWarnings(['#2a78d6', '#eb6834'], '#ffffff'), []);
  assert.deepEqual(colorWarnings(['#2a78d6', '#2b79d7', '#fefefe'], '#ffffff'), ['Colours 1 and 2 are hard to tell apart.', 'Colour 3 is faint against the card.']);
});

test('the page attributes only ever hold fixed values', () => {
  assert.deepEqual(designAttrs(undefined), { 'data-design-card': 'standard', 'data-design-backdrop': 'plain', 'data-design-motion': 'calm' });
  assert.deepEqual(designVars({ radius: 4, font: 'serif' }), { '--design-radius': '4px', '--design-font': "Georgia, 'Times New Roman', serif" });
});

test('the default look draws as it always did', () => {
  const o = flagChartOption({ ...setup('bar', rows), style: {} });
  assert.equal(series(o)[0]!.type, 'bar');
  assert.equal(o.legend, undefined);
  assert.equal(o.dataZoom, undefined);
  assert.equal(series(o)[0]!.markLine, undefined);
});

test('a colour rule beats the palette and keeps its pattern', () => {
  const o = flagChartOption({ ...setup('bar', rows, false, [{ metric: 'cost', op: 'gt', value: 20, tone: 'bad' }]), style: { palette: 'ember', fill: 'gradient' } });
  const west = series(o)[0]!.data[1];
  assert.equal(west.itemStyle.color, c.bad);
  assert.ok(west.itemStyle.decal);
  assert.equal(series(o)[0]!.data[0].itemStyle.color, undefined);
});

test('bars keep zero; only a line may leave it', () => {
  const bar = flagChartOption({ ...setup('bar', rows), style: { zeroBase: false } });
  const line = flagChartOption({ ...setup('line', rows), style: { zeroBase: false } });
  assert.equal((bar.yAxis as Array<Record<string, unknown>>)[0]!.scale, undefined);
  assert.equal((line.yAxis as Array<Record<string, unknown>>)[0]!.scale, true);
});

test('a target and an average are drawn on the value axis, sideways too', () => {
  const up = flagChartOption({ ...setup('bar', rows), style: { orientation: 'vertical', target: { value: 25, label: 'Goal' }, average: true } });
  const data = series(up)[0]!.markLine.data;
  assert.equal(data[0].yAxis, 25);
  assert.equal(data[1].type, 'average');
  const across = flagChartOption({ ...setup('bar', rows), style: { orientation: 'horizontal', target: { value: 25, label: '' }, average: true } });
  assert.equal(series(across)[0]!.markLine.data[0].xAxis, 25);
  assert.equal(series(across)[0]!.markLine.data[0].name, 'Target');
  assert.equal(series(across)[0]!.markLine.data[1].valueDim, 'x');
});

test('stacks can be side by side or shares of 100%', () => {
  const two = [{ dims: { region: 'East', kind: 'A' }, values: { cost: 1 } }, { dims: { region: 'East', kind: 'B' }, values: { cost: 3 } }];
  assert.equal(series(flagChartOption({ ...setup('bar', two, true), style: {} }))[0]!.stack, 'all');
  assert.equal(series(flagChartOption({ ...setup('bar', two, true), style: { barLayout: 'grouped' } }))[0]!.stack, undefined);
  const pct = flagChartOption({ ...setup('bar', two, true), style: { barLayout: 'percent' } });
  assert.deepEqual([series(pct)[0]!.data[0], series(pct)[1]!.data[0]], [0.25, 0.75]);
});

test('each pie form draws its own chart, and every mark keeps its value for a click', () => {
  for (const [form, type] of [['donut', 'pie'], ['pie', 'pie'], ['rose', 'pie'], ['funnel', 'funnel'], ['treemap', 'treemap']] as const) {
    const o = flagChartOption({ ...setup('pie', rows), style: { pieForm: form } });
    assert.equal(series(o)[0]!.type, type);
    assert.equal(series(o)[0]!.data[1].raw, 'West');
  }
  assert.equal(series(flagChartOption({ ...setup('pie', rows), style: { pieForm: 'rose' } }))[0]!.roseType, 'radius');
});

test('treemap labels stay readable on light and dark colours', () => {
  const s = series(flagChartOption({ ...setup('pie', rows), colors: ['#104281', '#eda100'], style: { pieForm: 'treemap' } }))[0]!;
  assert.equal(s.data[0].label.color, '#ffffff');
  assert.equal(s.data[1].label.color, '#111111');
});

test('the zoom slider is along the category axis and leaves the wheel to the page', () => {
  const o = flagChartOption({ ...setup('line', rows), style: { zoom: true } });
  const zoom = o.dataZoom as Array<Record<string, unknown>>;
  assert.equal(zoom[0]!.xAxisIndex, 0);
  assert.equal(zoom[0]!.zoomOnMouseWheel, 'ctrl');
  assert.equal(flagChartOption({ ...setup('line', rows.slice(0, 1)), style: { zoom: true } }).dataZoom, undefined);
});

test('line looks reach the series', () => {
  const s = series(flagChartOption({ ...setup('area', rows), style: { curve: 'step', lineWidth: 4, markers: 'off', fill: 'gradient', glow: true } }))[0]!;
  assert.equal(s.step, 'middle');
  assert.equal(s.lineStyle.width, 4);
  assert.equal(s.showSymbol, false);
  assert.equal(s.areaStyle.color.type, 'linear');
  assert.ok(s.lineStyle.shadowBlur > 0);
});

test('a gauge shows the true value, however it is scaled', () => {
  const s = series(gaugeOption({ value: 150, max: 100, color: '#2a78d6', c, text: '150' }))[0]!;
  assert.equal(s.data[0].value, 150);
  assert.equal(s.detail.formatter(), '150');
});

test('no mark moves for over 200 ms, and none at all if asked', () => {
  assert.deepEqual(chartMotion('none'), { animation: false });
  assert.equal(chartMotion('calm').animationDuration, 180);
  assert.equal(chartMotion('lively').animationDuration, 200);
  assert.equal(formatDim(null), '(blank)');
});

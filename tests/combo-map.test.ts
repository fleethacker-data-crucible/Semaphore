// The combo (bars and a line) and map kinds: what each needs, the brief's words that ask for them,
// the options they draw, the state tile map and its matching, region files (GeoJSON and TopoJSON),
// points from latitude and longitude, and the combo's editable Excel chart.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import { comboRoles } from '../src/core/combo.ts';
import { parseFlagStyle } from '../src/core/design.ts';
import { drilledFlag } from '../src/core/drill.ts';
import { toXlsx } from '../src/core/export/xlsx.ts';
import { aliasLines, combine, looksLikeLatLon, matchRegions, matchState, matchStates, parseAliases, parseLatLon, parseRegionFile, STATES, tileGeoJSON, unmatchedNote } from '../src/core/geo.ts';
import { FLAG_KINDS, type Flag, type FlagKind } from '../src/core/hoist.ts';
import { fitShape } from '../src/core/intelligence/contract.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { CHART_KINDS, fitRichKind, KIND_WORDS, latLonFields, latLonRole } from '../src/core/kinds.ts';
import { DEFAULT_SIZE } from '../src/core/layout.ts';
import { richChartNote, richChartOption } from '../web/src/lib/chart-kinds.ts';
import { flagChartOption, setRichBuilder } from '../web/src/lib/chart-option.ts';
import { chartMapName, setMapEntry } from '../web/src/lib/map-registry.ts';

const catalog: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'ansi' }],
  fields: [
    { key: 't.region', label: 'Region', source: 's', table: 't', column: 'region', type: 'string', cardinality: 4 },
    { key: 't.state', label: 'Home state', source: 's', table: 't', column: 'state', type: 'string' },
    { key: 't.lat', label: 'Latitude', source: 's', table: 't', column: 'lat', type: 'number' },
    { key: 't.lon', label: 'Longitude', source: 's', table: 't', column: 'lon', type: 'number' },
    { key: 't.amt', label: 'Amount', source: 's', table: 't', column: 'amt', type: 'number' },
    { key: 't.days', label: 'Days', source: 's', table: 't', column: 'days', type: 'number' },
    { key: 't.when', label: 'When', source: 's', table: 't', column: 'when', type: 'date' },
  ],
  metrics: [
    { key: 'cost', label: 'Cost', agg: 'sum', field: 't.amt', source: 's', format: 'currency' },
    { key: 'days_open', label: 'Days open', agg: 'avg', field: 't.days', source: 's' },
    { key: 'jobs', label: 'Jobs', agg: 'count', table: 't', source: 's' },
  ],
};
const index = indexCatalog(catalog);
const behavior = { onClick: 'filter-page' as const, ignore: [], thresholds: [] };
const c = { ink: '#111111', ink2: '#333333', ink3: '#666666', line: '#dddddd', panel: '#ffffff', good: '#2e7d4f', warn: '#b7791f', bad: '#c0392b' };
const b = (dims: string[], metrics: string[]) => ({ metrics, dimensions: dims.map((f) => ({ field: f })), filters: [] });

type Opt = Record<string, unknown>;
type Row = { dims: Record<string, unknown>; values: Record<string, number | null> };
const series = (o: Opt) => o.series as Array<Record<string, unknown>>;

function input(kind: FlagKind, dims: string[], metrics: string[], rows: Row[], extra: { style?: Opt; selections?: Opt; thresholds?: unknown[] } = {}) {
  const keyed = dims.map((f) => ({ field: f, key: f }));
  return {
    flag: { id: 'f', kind, title: 'T', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', notes: [], behavior: { ...behavior, thresholds: extra.thresholds ?? [] }, binding: b(dims, metrics) },
    result: { plan: { dimensions: keyed, own: keyed.map((d) => d.key) }, display: { rows, totals: {} } },
    index,
    selections: extra.selections ?? {},
    style: extra.style ?? {},
    c,
    colors: ['#2a78d6', '#eb6834', '#1baf7a'],
  } as never as Parameters<typeof flagChartOption>[0];
}

// ---- kinds ------------------------------------------------------------------------------------

test('combo and map are flag kinds drawn as charts, with a size', () => {
  for (const k of ['combo', 'map'] as const) {
    assert.ok(FLAG_KINDS.includes(k), k);
    assert.ok(CHART_KINDS.includes(k), k);
    assert.ok(DEFAULT_SIZE[k].w >= 6, k);
  }
});

test('fitRichKind: a combo needs one field and two or more measures, a map one field (or latitude and longitude) and a measure', () => {
  assert.deepEqual(fitRichKind('combo', b(['t.region'], ['cost', 'days_open']), index), { kind: 'combo' });
  assert.deepEqual(fitRichKind('combo', b(['t.region'], ['cost', 'days_open', 'jobs']), index), { kind: 'combo' });
  const one = fitRichKind('combo', b(['t.region'], ['cost']), index);
  assert.equal(one.kind, 'bar');
  assert.match(one.note!, /A combo needs one field along the axis and two or more measures/);
  assert.equal(fitRichKind('combo', b(['t.region', 't.state'], ['cost', 'jobs']), index).kind, 'bar');
  assert.equal(fitRichKind('combo', b([], ['cost', 'jobs']), index).kind, 'kpi');

  assert.deepEqual(fitRichKind('map', b(['t.state'], ['cost']), index), { kind: 'map' });
  assert.deepEqual(fitRichKind('map', b(['t.lat', 't.lon'], ['cost']), index), { kind: 'map' }, 'latitude and longitude fields');
  assert.deepEqual(fitRichKind('map', b(['t.lon', 't.lat'], ['jobs']), index), { kind: 'map' }, 'in either order');
  const two = fitRichKind('map', b(['t.region', 't.state'], ['cost']), index);
  assert.equal(two.kind, 'bar');
  assert.match(two.note!, /A map needs one field \(states, regions or latitude and longitude\) and one measure, so this is drawn as a bar/);
  assert.equal(fitRichKind('map', b([], ['cost']), index).kind, 'kpi');
  assert.equal(fitShape('map', b(['t.state'], []), behavior, index).kind, 'table', 'no measure: a list');
});

test('latitude and longitude fields are known by their names', () => {
  assert.equal(latLonRole('Latitude'), 'lat');
  assert.equal(latLonRole('home_lat'), 'lat');
  assert.equal(latLonRole('LNG'), 'lon');
  assert.equal(latLonRole('Long'), 'lon');
  assert.equal(latLonRole('Longitude (deg)'), 'lon');
  assert.equal(latLonRole('Plateau'), null, 'not inside a word');
  assert.equal(latLonRole('Longest'), null);
  assert.deepEqual(latLonFields(b(['t.lon', 't.lat'], ['cost']), index), { lat: 1, lon: 0 });
  assert.equal(latLonFields(b(['t.region', 't.lat'], ['cost']), index), null);
});

test('the brief\'s words ask for a combo or a map', () => {
  const kindOf = (brief: string) => draftFlagLocally(brief, 'bar', index).kind;
  assert.equal(kindOf('Cost and days open by region as bars and a line'), 'combo');
  assert.equal(kindOf('Combo of cost and jobs by region'), 'combo');
  assert.equal(kindOf('Cost as bars and days open as a line by region'), 'combo');
  assert.equal(kindOf('Cost by region with a line for days open'), 'combo');
  assert.equal(kindOf('Cost by home state on a map'), 'map');
  assert.equal(kindOf('Map of jobs by home state'), 'map');
  assert.equal(kindOf('Cost by state'), 'map');
  assert.equal(kindOf('Jobs by region on a map'), 'map');
  // Not a map or a combo.
  assert.equal(kindOf('Heat map of cost by region and home state'), 'heatmap');
  assert.equal(kindOf('Cost by region as a line'), 'line');
  assert.equal(kindOf('Cost by region'), 'bar');
  // One measure is not enough for a combo: bars, and the note says why.
  const one = draftFlagLocally('Combo of cost by region', 'bar', index);
  assert.equal(one.kind, 'bar');
  assert.ok(one.notes.some((n) => /combo needs/.test(n)));
  // The order of the measures is the order of the brief: the last is the line.
  const d = draftFlagLocally('Cost as bars and days open as a line by region', 'bar', index);
  assert.deepEqual(d.binding?.metrics, ['cost', 'days_open']);
  assert.ok(KIND_WORDS.some(([, k]) => k === 'combo') && KIND_WORDS.some(([, k]) => k === 'map'));
});

test('a drill from a combo stays a combo; from a map it lands on bars', () => {
  const flag = (kind: FlagKind): Flag => ({ id: 'f', kind, title: 'T', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', notes: [], behavior: { ...behavior, onClick: 'drill' }, binding: b(['t.region'], ['cost', 'jobs']) });
  const local: Catalog = { ...catalog, hierarchies: [{ id: 'h', label: 'Region then state', levels: ['t.region', 't.state'] }] };
  const idx = indexCatalog(local);
  assert.equal(drilledFlag(flag('combo'), [{ field: 't.region', value: 'North' }], idx).kind, 'combo');
  assert.equal(drilledFlag(flag('map'), [{ field: 't.region', value: 'North' }], idx).kind, 'bar');
});

test('the Look\'s combo and map settings are checked when read', () => {
  const s = parseFlagStyle({ combo: { cost: { as: 'line', axis: 'right' }, jobs: { as: 'pie' }, days: 'x', __proto__: { as: 'bar' } }, map: 'fleet-regions' });
  assert.deepEqual(s, { combo: { cost: { as: 'line', axis: 'right' } }, map: 'fleet-regions' });
  assert.equal(parseFlagStyle({ map: '../etc' }), undefined);
  assert.equal(parseFlagStyle({ map: 'x'.repeat(65) }), undefined);
});

// ---- combo ------------------------------------------------------------------------------------

const regions: Row[] = [
  { dims: { 't.region': 'North' }, values: { cost: 1200, days_open: 30, jobs: 4 } },
  { dims: { 't.region': 'South' }, values: { cost: 400, days_open: 10, jobs: 2 } },
  { dims: { 't.region': 'East' }, values: { cost: 600, days_open: 50, jobs: 9 } },
];

test('comboRoles: bars first, the last measure a line on the right, unless picked', () => {
  assert.deepEqual(comboRoles(['a', 'b', 'c'], undefined).map((r) => `${r.as}/${r.axis}`), ['bar/left', 'bar/left', 'line/right']);
  assert.deepEqual(comboRoles(['a'], undefined).map((r) => `${r.as}/${r.axis}`), ['bar/left']);
  assert.deepEqual(comboRoles(['a', 'b'], { a: { as: 'line' }, b: { axis: 'left' } }).map((r) => `${r.as}/${r.axis}`), ['line/left', 'line/left']);
});

test('a combo draws bars on the left scale and the line on its own scale on the right', () => {
  setRichBuilder(richChartOption, richChartNote);
  const o = flagChartOption(input('combo', ['t.region'], ['cost', 'days_open'], regions));
  const [bars, line] = series(o) as [Opt, Opt];
  assert.equal(bars.type, 'bar');
  assert.equal(bars.yAxisIndex, 0);
  assert.equal(line.type, 'line');
  assert.equal(line.yAxisIndex, 1);
  assert.equal((o.yAxis as Opt[]).length, 2);
  assert.equal(((o.yAxis as Opt[])[1]!.splitLine as Opt).show, false, 'one set of grid lines');
  assert.deepEqual((o.xAxis as { data: string[] }).data, ['North', 'South', 'East']);
  assert.deepEqual((bars.data as Array<{ value: number; raw: string }>).map((d) => [d.value, d.raw]), [[1200, 'North'], [400, 'South'], [600, 'East']], 'each bar carries its value for clicks');
  assert.deepEqual((line.data as Array<{ value: number }>).map((d) => d.value), [30, 10, 50]);
  assert.ok(o.legend, 'two measures, a legend');
  // The scale's labels are in each measure's own format.
  const left = ((o.yAxis as Opt[])[0]!.axisLabel as { formatter: (n: number) => string }).formatter;
  assert.match(left(1200), /\$/);
});

test('the analyst picks bars or a line and the scale per measure; all on the left is one scale', () => {
  setRichBuilder(richChartOption, richChartNote);
  const o = flagChartOption(input('combo', ['t.region'], ['cost', 'days_open', 'jobs'], regions, { style: { combo: { days_open: { as: 'line', axis: 'right' }, jobs: { as: 'bar', axis: 'left' } } } }));
  assert.deepEqual(series(o).map((s) => `${s.type}/${s.yAxisIndex}`), ['bar/0', 'line/1', 'bar/0']);
  const flat = flagChartOption(input('combo', ['t.region'], ['cost', 'jobs'], regions, { style: { combo: { jobs: { axis: 'left' } } } }));
  assert.deepEqual(series(flat).map((s) => `${s.type}/${s.yAxisIndex}`), ['bar/0', 'line/0']);
  assert.equal((flat.yAxis as Opt[]).length, 1);
  // Everything on the right is drawn on one scale too: there is no empty left one.
  const right = flagChartOption(input('combo', ['t.region'], ['cost', 'jobs'], regions, { style: { combo: { cost: { axis: 'right' } } } }));
  assert.deepEqual(series(right).map((s) => s.yAxisIndex), [0, 0]);
});

test('a combo\'s target and average lines go on the bars\' scale, and the look applies', () => {
  setRichBuilder(richChartOption, richChartNote);
  const o = flagChartOption(input('combo', ['t.region'], ['cost', 'days_open'], regions, { style: { target: { value: 800, label: 'Budget' }, average: true, labels: 'on', corners: 6, barLayout: 'stacked' } }));
  const [bars, line] = series(o) as [Opt, Opt];
  const marks = (bars.markLine as { data: Opt[] }).data;
  assert.equal(marks.length, 2);
  assert.equal(marks[0]!.yAxis, 800);
  assert.equal(marks[1]!.type, 'average');
  assert.equal(line.markLine, undefined);
  assert.equal((bars.label as Opt).show, true);
  assert.deepEqual((bars.itemStyle as Opt).borderRadius, [6, 6, 0, 0]);
  assert.equal(bars.stack, 'bars-0');
});

test('a combo dims what the page is filtered away from and keeps the colour rules', () => {
  setRichBuilder(richChartOption, richChartNote);
  const o = flagChartOption(input('combo', ['t.region'], ['cost', 'days_open'], regions, { selections: { 't.region': ['East'] }, thresholds: [{ metric: 'cost', op: 'gt', value: 1000, tone: 'bad' }] }));
  const bars = series(o)[0]!.data as Array<{ raw: string; itemStyle: { opacity?: number; color?: string; decal?: unknown } }>;
  assert.equal(bars[0]!.itemStyle.opacity, 0.35);
  assert.equal(bars[2]!.itemStyle.opacity, undefined);
  assert.equal(bars[0]!.itemStyle.color, c.bad);
  assert.ok(bars[0]!.itemStyle.decal, 'a broken rule carries a pattern too');
});

test('a combo with one measure is drawn as bars', () => {
  setRichBuilder(richChartOption, richChartNote);
  const o = flagChartOption(input('combo', ['t.region'], ['cost'], regions));
  assert.deepEqual(series(o).map((s) => s.type), ['bar']);
});

test('xlsx: a combo is one Excel chart, bars and a line, the line on a second scale', async () => {
  const flag = {
    id: 'f',
    title: 'Cost and days open',
    kind: 'combo',
    table: { columns: [{ label: 'Region', numeric: false }, { label: 'Cost', numeric: true }, { label: 'Days open', numeric: true }], rows: regions.map((r) => [{ text: String(r.dims['t.region']), value: String(r.dims['t.region']) }, { text: String(r.values.cost), value: r.values.cost ?? null }, { text: String(r.values.days_open), value: r.values.days_open ?? null }]) },
    image: null,
    chart: { type: 'combo' as const, categories: ['North', 'South', 'East'], series: [{ name: 'Cost', values: [1200, 400, 600], color: '#2a78d6', as: 'bar' as const }, { name: 'Days open', values: [30, 10, 50], color: '#eb6834', as: 'line' as const, axis: 'right' as const }] },
    insights: [],
  };
  const bytes = await toXlsx({ title: 'T', brief: '', takenAt: '2026-11-08T00:00:00Z', by: 'me', filters: [], accent: '#1f6f8b', flags: [flag] });
  // The parts are deflated: read the chart back through the zip.
  const { inflated } = await unzipChart(bytes);
  assert.match(inflated, /<c:barChart>.*<c:ser><c:idx val="0"\/>.*<\/c:barChart><c:lineChart>.*<c:ser><c:idx val="1"\/>.*<c:axId val="333333333"\/><c:axId val="444444444"\/><\/c:lineChart>/);
  assert.match(inflated, /<c:valAx><c:axId val="444444444"\/>.*<c:axPos val="r"\/>.*<c:crosses val="max"\/>/, 'the second scale is on the right');
  assert.match(inflated, /<c:catAx><c:axId val="333333333"\/>.*<c:delete val="1"\/>/, 'with its own hidden category axis');
  assert.match(inflated, /<c:f>&apos;Cost and days open&apos;!\$C\$2:\$C\$4<\/c:f>/, 'the line reads its column of the table');
});

/** The first chart part of an xlsx, inflated. */
async function unzipChart(bytes: Uint8Array): Promise<{ inflated: string }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const packedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (name.startsWith('xl/charts/')) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const packed = bytes.subarray(start, start + packedSize);
      if (method !== 8) return { inflated: new TextDecoder().decode(packed) };
      const stream = new Blob([packed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return { inflated: new TextDecoder().decode(await new Response(stream).arrayBuffer()) };
    }
    at += 46 + nameLength;
  }
  throw new Error('no chart part');
}

// ---- the state tile map ---------------------------------------------------------------------

test('the tile map has the 50 states and DC, each at its own place', () => {
  assert.equal(STATES.length, 51);
  assert.equal(new Set(STATES.map((s) => s[0])).size, 51, 'unique codes');
  assert.equal(new Set(STATES.map((s) => `${s[2]},${s[3]}`)).size, 51, 'unique positions');
  assert.ok(STATES.every((s) => s[2] >= 0 && s[2] <= 11 && s[3] >= 0 && s[3] <= 7), 'on a 12 by 8 grid');
  const geo = tileGeoJSON();
  assert.equal(geo.features.length, 51);
  const va = geo.features.find((f) => f.properties.name === 'VA')!;
  assert.deepEqual((va.geometry.coordinates as number[][][])[0]![0], [8, -4], 'column across, row down');
});

test('states are recognised by name, USPS code and common abbreviations', () => {
  const cases: Array<[string, string]> = [
    ['Virginia', 'VA'],
    ['virginia', 'VA'],
    ['  VA ', 'VA'],
    ['va', 'VA'],
    ['Calif.', 'CA'],
    ['Mass.', 'MA'],
    ['N.H.', 'NH'],
    ['N. Carolina', 'NC'],
    ['W. Va.', 'WV'],
    ['Wash.', 'WA'],
    ['Washington', 'WA'],
    ['D.C.', 'DC'],
    ['Washington, D.C.', 'DC'],
    ['District of Columbia', 'DC'],
    ['US-TX', 'TX'],
    ["Hawai'i", 'HI'],
    ['Penna.', 'PA'],
    ['New York', 'NY'],
    ['NewYork', 'NY'],
  ];
  for (const [v, code] of cases) assert.equal(matchState(v), code, v);
  for (const v of ['Guam', 'Puerto Rico', 'Nowhere', '', null, 'Washingtonia']) assert.equal(matchState(v), null, String(v));
});

test('a state map shades each state by the measure, combines spellings of one state, and lists what is not on the map', () => {
  setRichBuilder(richChartOption, richChartNote);
  const rows: Row[] = [
    { dims: { 't.state': 'Virginia' }, values: { cost: 100 } },
    { dims: { 't.state': 'VA' }, values: { cost: 50 } },
    { dims: { 't.state': 'Calif.' }, values: { cost: 300 } },
    { dims: { 't.state': 'Guam' }, values: { cost: 20 } },
    { dims: { 't.state': null }, values: { cost: 5 } },
  ];
  const i = input('map', ['t.state'], ['cost'], rows);
  const o = flagChartOption(i);
  const s = series(o)[0]!;
  assert.equal(s.type, 'map');
  assert.equal(s.map, chartMapName('us-states'));
  assert.equal(s.aspectScale, 1, 'squares stay square');
  const data = s.data as Array<{ name: string; value: number; raw: unknown }>;
  assert.deepEqual(data.map((d) => [d.name, d.value, d.raw]), [['VA', 150, 'Virginia'], ['CA', 300, 'Calif.']]);
  const vm = o.visualMap as { min: number; max: number; inRange: { color: string[] } };
  assert.equal(vm.max, 300);
  assert.equal(vm.inRange.color[1], '#2a78d6', 'the scale ends in the look\'s first colour');
  assert.equal(richChartNote(i), 'Not on the map: Guam, (blank).');
  // The tooltip names the state in full.
  assert.match((s.tooltip as { formatter: (p: { name: string; value: number }) => string }).formatter({ name: 'VA', value: 150 }), /^Virginia<br\/>Cost: \$150/);
  // An average is averaged across spellings, not added.
  const avg = flagChartOption(input('map', ['t.state'], ['days_open'], [{ dims: { 't.state': 'Texas' }, values: { days_open: 10 } }, { dims: { 't.state': 'TX' }, values: { days_open: 20 } }]));
  assert.equal((series(avg)[0]!.data as Array<{ value: number }>)[0]!.value, 15);
  // Dimmed when the page is filtered to another state.
  const dim = flagChartOption(input('map', ['t.state'], ['cost'], rows.slice(0, 3), { selections: { 't.state': ['Calif.'] } }));
  assert.deepEqual((series(dim)[0]!.data as Array<{ itemStyle?: { opacity: number } }>).map((d) => d.itemStyle?.opacity), [0.35, undefined]);
});

test('unmatched values are listed, six at most', () => {
  assert.equal(unmatchedNote([]), null);
  assert.equal(unmatchedNote(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), 'Not on the map: a, b, c, d, e, f and 2 more.');
  assert.deepEqual([...matchStates(['TX', 'Texas', 'Mars']).matched], [['TX', 'TX'], ['Texas', 'TX']]);
  assert.equal(combine('sum', [1, 2]), 3);
  assert.equal(combine('max', [1, 2]), 2);
  assert.equal(combine('min', [1, 2]), 1);
});

// ---- region files ------------------------------------------------------------------------------

const square = (x: number, y: number) => [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]];
const geojson = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });

test('a GeoJSON region file keeps each named polygon\'s outline and name, and nothing else', () => {
  const r = parseRegionFile(
    geojson([
      { type: 'Feature', properties: { NAME: 'Northeast', pop: 5, junk: 'x' }, geometry: { type: 'Polygon', coordinates: square(-75.123456789, 40) } },
      { type: 'Feature', properties: { NAME: 'Gulf' }, geometry: { type: 'MultiPolygon', coordinates: [square(-90, 29), square(-88, 30)] } },
      { type: 'Feature', properties: { NAME: 'Port A' }, geometry: { type: 'Point', coordinates: [-76, 36] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: square(0, 0) } },
    ]),
  );
  assert.deepEqual(r.regions, ['Northeast', 'Gulf']);
  assert.equal(r.lonLat, true);
  assert.deepEqual(r.geojson.features[0]!.properties, { name: 'Northeast' });
  assert.equal((r.geojson.features[0]!.geometry.coordinates as number[][][])[0]![0]![0], -75.12346, 'five decimals');
  assert.equal(r.geojson.features[1]!.geometry.type, 'MultiPolygon');
  assert.ok(r.notes.some((n) => /1 shape was not a region/.test(n)));
  assert.ok(r.notes.some((n) => /1 region has no name/.test(n)));
  // A single Feature, a name from the feature id, and positions that are not longitude and latitude.
  const one = parseRegionFile(JSON.stringify({ type: 'Feature', id: 'Bay', properties: null, geometry: { type: 'Polygon', coordinates: square(500000, 4000000) } }));
  assert.deepEqual(one.regions, ['Bay']);
  assert.equal(one.lonLat, false);
  assert.ok(one.notes.some((n) => /not longitude and latitude/.test(n)));
});

test('a region file that cannot be a map says why', () => {
  const fails = (text: string, re: RegExp) => assert.throws(() => parseRegionFile(text), re);
  fails('not json', /not JSON/);
  fails('[1,2]', /not a GeoJSON or TopoJSON object/);
  fails(JSON.stringify({ type: 'Point', coordinates: [1, 2] }), /not a GeoJSON FeatureCollection/);
  fails(geojson([]), /no named regions/);
  fails(geojson([{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }]), /fewer than four positions/);
  fails(geojson([{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 'x'], [1, 1], [0, 0]]] } }]), /not a pair of numbers/);
  fails(geojson(Array.from({ length: 2001 }, (_, i) => ({ type: 'Feature', properties: { name: `R${i}` }, geometry: { type: 'Polygon', coordinates: square(0, 0) } }))), /more than 2000 regions/);
  const ring = Array.from({ length: 250_001 }, (_, i) => [i / 1e6, 0]);
  fails(geojson([{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [ring] } }]), /more than 250,000 points/);
});

test('a TopoJSON file is turned into GeoJSON: arcs stitched, reversed arcs walked backwards, positions decoded', () => {
  // Two squares sharing an edge: arc 0 is the shared edge, quantized with a transform and delta-encoded.
  const topo = {
    type: 'Topology',
    transform: { scale: [0.5, 0.5], translate: [-80, 30] },
    arcs: [
      [[2, 0], [0, 2]], // shared edge (1,30)->(1,31) in degrees: x=2*0.5-80=-79, y=30..31
      [[2, 2], [-2, 0], [0, -2], [2, 0]], // left square's other three sides, closing back at (2,0)
      [[2, 0], [2, 0], [0, 2], [-2, 0]], // right square's other three sides
    ],
    objects: {
      regions: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', properties: { name: 'West' }, arcs: [[0, 1]] },
          { type: 'Polygon', properties: { name: 'East' }, arcs: [[2, -1]] },
          { type: 'Point', properties: { name: 'Port' }, coordinates: [1, 1] },
        ],
      },
    },
  };
  const r = parseRegionFile(JSON.stringify(topo));
  assert.deepEqual(r.regions, ['West', 'East']);
  const west = (r.geojson.features[0]!.geometry.coordinates as number[][][])[0]!;
  assert.deepEqual(west[0], [-79, 30]);
  assert.deepEqual(west[1], [-79, 31]);
  assert.equal(west.length, 5, 'the joining point is not doubled');
  assert.deepEqual(west[west.length - 1], west[0], 'closed');
  const east = (r.geojson.features[1]!.geometry.coordinates as number[][][])[0]!;
  assert.deepEqual(east.slice(-2), [[-79, 31], [-79, 30]], 'the shared edge walked backwards');
  assert.ok(r.notes.some((n) => /not a region/.test(n)));
});

test('region names are matched with the alias list, and the list reads back as typed', () => {
  const aliases = parseAliases('NE = Northeast\nGulf Coast=Gulf\n\nno equals sign\n = nothing\nX = \n__proto__ = Gulf');
  assert.deepEqual(aliases, { NE: 'Northeast', 'Gulf Coast': 'Gulf' });
  assert.equal(aliasLines(aliases), 'NE = Northeast\nGulf Coast = Gulf');
  const { matched, unmatched } = matchRegions(['northeast', 'NE', 'gulf coast', 'Pacific'], ['Northeast', 'Gulf'], { ...aliases, Bad: 'Nowhere' });
  assert.deepEqual([...matched], [['northeast', 'Northeast'], ['NE', 'Northeast'], ['gulf coast', 'Gulf']]);
  assert.deepEqual(unmatched, ['Pacific']);
});

test('a custom region map draws once it is registered, and as bars with a reason when it cannot be read', () => {
  setRichBuilder(richChartOption, richChartNote);
  const rows: Row[] = [
    { dims: { 't.region': 'Northeast' }, values: { cost: 10 } },
    { dims: { 't.region': 'NE' }, values: { cost: 5 } },
    { dims: { 't.region': 'Pacific' }, values: { cost: 3 } },
  ];
  setMapEntry('fleet', null);
  const loading = flagChartOption(input('map', ['t.region'], ['cost'], rows, { style: { map: 'fleet' } }));
  assert.deepEqual(series(loading), [], 'nothing until the map is read');
  setMapEntry('fleet', { state: 'ready', regions: ['Northeast', 'Gulf'], aliases: { NE: 'Northeast' }, lonLat: true, name: 'Fleet' });
  const i = input('map', ['t.region'], ['cost'], rows, { style: { map: 'fleet' } });
  const o = flagChartOption(i);
  assert.equal(series(o)[0]!.map, chartMapName('fleet'));
  assert.deepEqual((series(o)[0]!.data as Array<{ name: string; value: number }>).map((d) => [d.name, d.value]), [['Northeast', 15]]);
  assert.equal(series(o)[0]!.aspectScale, undefined, 'longitude and latitude keep the usual aspect');
  assert.equal(richChartNote(i), 'Not on the map: Pacific.');
  setMapEntry('fleet', { state: 'missing', regions: [], aliases: {}, lonLat: false, name: 'fleet', error: "No region map 'fleet'." });
  const gone = input('map', ['t.region'], ['cost'], rows, { style: { map: 'fleet' } });
  assert.equal(series(flagChartOption(gone))[0]!.type, 'bar');
  assert.match(richChartNote(gone)!, /could not be loaded .*so this is drawn as bars/);
  setMapEntry('fleet', null);
});

// ---- points ----------------------------------------------------------------------------------

test('latitude, longitude pairs are recognised in a field\'s values', () => {
  assert.deepEqual(parseLatLon('36.85, -76.29'), { lat: 36.85, lon: -76.29 });
  assert.deepEqual(parseLatLon('(36.85 -76.29)'), { lat: 36.85, lon: -76.29 });
  assert.deepEqual(parseLatLon('36.85;-76.29'), { lat: 36.85, lon: -76.29 });
  assert.deepEqual(parseLatLon('POINT(-76.29 36.85)'), { lat: 36.85, lon: -76.29 }, 'WKT is longitude first');
  for (const v of ['Norfolk', '95, 10', '36.85', '1,2,3', 3685, null]) assert.equal(parseLatLon(v), null, String(v));
  assert.equal(looksLikeLatLon(['36.8, -76.2', '32.7, -117.1', null, '', '47.6, -122.3', '21.3, -157.9', 'n/a']), true, 'four in five, blanks aside');
  assert.equal(looksLikeLatLon(['36.8, -76.2', '32.7, -117.1', '47.6, -122.3', 'n/a']), false, 'three in four is not enough');
  assert.equal(looksLikeLatLon(['36.8, -76.2', 'Norfolk', 'San Diego']), false);
  assert.equal(looksLikeLatLon([]), false);
});

test('points from pairs draw on a plain longitude and latitude frame when there is no map to put them on', () => {
  setRichBuilder(richChartOption, richChartNote);
  const rows: Row[] = [
    { dims: { 't.region': '36.85, -76.29' }, values: { cost: 100 } },
    { dims: { 't.region': '32.71, -117.16' }, values: { cost: 400 } },
    { dims: { 't.region': '47.6, -122.3' }, values: { cost: 50 } },
    { dims: { 't.region': '21.3, -157.9' }, values: { cost: 50 } },
    { dims: { 't.region': 'unknown' }, values: { cost: 1 } },
  ];
  const i = input('map', ['t.region'], ['cost'], rows);
  const o = flagChartOption(i);
  const s = series(o)[0]!;
  assert.equal(s.type, 'scatter');
  assert.equal(s.coordinateSystem, undefined);
  const data = s.data as Array<{ value: number[]; raw: string; symbolSize: number }>;
  assert.deepEqual(data.map((d) => d.value), [[-76.29, 36.85, 100], [-117.16, 32.71, 400], [-122.3, 47.6, 50], [-157.9, 21.3, 50]]);
  assert.equal(data[0]!.raw, '36.85, -76.29');
  assert.ok(data[1]!.symbolSize > data[0]!.symbolSize);
  assert.equal((o.xAxis as Opt).name, 'Longitude');
  assert.equal((o.yAxis as Opt).name, 'Latitude');
  assert.ok((o.xAxis as { min: number }).min < -157.9 && (o.xAxis as { max: number }).max > -76.29);
  assert.equal((o.visualMap as Opt).dimension, 2);
  assert.equal(richChartNote(i), '1 row has no latitude and longitude, so it is not on the map.');
});

test('latitude and longitude fields draw points, on a custom map that is in longitude and latitude', () => {
  setRichBuilder(richChartOption, richChartNote);
  const rows: Row[] = [
    { dims: { 't.lat': 36.85, 't.lon': -76.29 }, values: { jobs: 4 } },
    { dims: { 't.lat': '47.6', 't.lon': '-122.3' }, values: { jobs: 2 } },
  ];
  setMapEntry('coast', { state: 'ready', regions: ['East', 'West'], aliases: {}, lonLat: true, name: 'Coast' });
  const o = flagChartOption(input('map', ['t.lat', 't.lon'], ['jobs'], rows, { style: { map: 'coast' } }));
  assert.equal((o.geo as Opt).map, chartMapName('coast'));
  assert.equal(series(o)[0]!.coordinateSystem, 'geo');
  assert.deepEqual((series(o)[0]!.data as Array<{ value: number[] }>).map((d) => d.value), [[-76.29, 36.85, 4], [-122.3, 47.6, 2]]);
  // A map whose positions are not longitude and latitude cannot hold them: the plain frame.
  setMapEntry('coast', { state: 'ready', regions: ['East'], aliases: {}, lonLat: false, name: 'Coast' });
  const plain = flagChartOption(input('map', ['t.lat', 't.lon'], ['jobs'], rows, { style: { map: 'coast' } }));
  assert.equal(plain.geo, undefined);
  assert.equal((plain.xAxis as Opt).name, 'Longitude');
  setMapEntry('coast', null);
});

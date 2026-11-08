// The richer chart kinds (src/core/kinds.ts) as ECharts options: spider, scatter, heatmap, calendar,
// waterfall, Pareto, Sankey, sunburst, stream, combo (bars and a line) and map. Loaded with
// chart-extras.ts the first time a flag needs one, so a page of bars and lines never pays for them
// (web/size-budget.json).
//
// The same rules as chart-option.ts: text stays in the ink colours, a value the page is filtered
// away from is dimmed rather than hidden, and every mark that stands for a value of the flag's first
// field carries it as `raw`, so a click filters or drills by that value.

import type { Cell } from '../../../src/core/crossfilter.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { combine, coord, looksLikeLatLon, matchRegions, matchStates, parseLatLon, stateName, unmatchedNote, US_STATES } from '../../../src/core/geo.ts';
import { toneFor } from '../../../src/core/hoist.ts';
import { comboRoles } from '../../../src/core/combo.ts';
import { latLonFields, type RichKind } from '../../../src/core/kinds.ts';
import { type ChartInput, chartCategories, flagChartOption, formatDim, isSelected, legendFor } from './chart-option.ts';
import { chartMapName, mapEntry } from './map-registry.ts';

type Option = Record<string, unknown>;

const DIM = 0.35;
const isPlainHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
const withAlpha = (hex: string, alpha: number) => (isPlainHex(hex) ? `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : hex);

function distinct(rows: ChartInput['result']['display']['rows'], key: string): Cell[] {
  const out: Cell[] = [];
  for (const r of rows) {
    const v = r.dims[key] ?? null;
    if (!out.some((x) => String(x) === String(v))) out.push(v);
  }
  return out;
}

interface MapPoint {
  name: string;
  raw: Cell;
  lat: number;
  lon: number;
  v: number | null;
}
type MapPlan =
  | { mode: 'points'; points: MapPoint[]; missing: number; onMap: boolean }
  | { mode: 'regions'; regions: Array<{ name: string; value: number; raw: Cell }>; unmatched: string[] }
  | { mode: 'loading' }
  | { mode: 'missing'; error: string };

/** What a map flag draws: points (latitude and longitude) or regions, matched to the map's names. */
function mapPlan(input: ChartInput): MapPlan {
  const { flag, result, index, style } = input;
  const b = flag.binding!;
  const plan = result.plan;
  const own = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const x = own[0]!;
  const rows = result.display.rows;
  const m0 = b.metrics[0]!;
  const id = style.map ?? US_STATES;
  const tile = id === US_STATES;
  const entry = tile ? undefined : mapEntry(id);
  if (!tile && entry?.state === 'missing') return { mode: 'missing', error: entry.error ?? 'it is not in the Semaphore folder' };
  const ll = latLonFields(b, index);
  if (ll || looksLikeLatLon(rows.map((r) => r.dims[x.key] ?? null))) {
    if (!tile && entry?.state !== 'ready') return { mode: 'loading' };
    const points: MapPoint[] = [];
    for (const r of rows) {
      const raw = r.dims[x.key] ?? null;
      const p = ll ? { lat: coord(r.dims[own[ll.lat]!.key], 90), lon: coord(r.dims[own[ll.lon]!.key], 180) } : parseLatLon(raw);
      if (!p || p.lat === null || p.lon === null) continue;
      const v = r.values[m0];
      points.push({ name: ll ? `${p.lat}, ${p.lon}` : formatDim(raw), raw, lat: p.lat, lon: p.lon, v: typeof v === 'number' ? v : null });
    }
    return { mode: 'points', points, missing: rows.length - points.length, onMap: !tile && !!entry?.lonLat };
  }
  if (!tile && entry?.state !== 'ready') return { mode: 'loading' };
  const values = rows.map((r) => r.dims[x.key] ?? null);
  const { matched, unmatched } = tile ? matchStates(values) : matchRegions(values, entry!.regions, entry!.aliases);
  const agg = index.metric(m0)?.agg;
  const groups = new Map<string, { vals: number[]; raw: Cell }>();
  for (const r of rows) {
    const raw = r.dims[x.key] ?? null;
    const region = matched.get(String(raw ?? ''));
    const v = r.values[m0];
    if (!region || typeof v !== 'number') continue;
    const g = groups.get(region) ?? { vals: [], raw };
    g.vals.push(b.share && result.display.totals[m0] ? v / (result.display.totals[m0] as number) : v);
    groups.set(region, g);
  }
  return { mode: 'regions', regions: [...groups].map(([name, g]) => ({ name, value: combine(agg, g.vals), raw: g.raw })), unmatched: unmatched.map((u) => (u === '' ? '(blank)' : u)) };
}

/** The line under a map: values that are on no region, or rows with no position. */
export function richChartNote(input: ChartInput): string | null {
  if (input.flag.kind !== 'map' || !input.flag.binding?.metrics.length || !input.result.plan.own.length) return null;
  const p = mapPlan(input);
  if (p.mode === 'regions') return unmatchedNote(p.unmatched);
  if (p.mode === 'points') return p.missing ? `${p.missing} row${p.missing === 1 ? ' has' : 's have'} no latitude and longitude, so ${p.missing === 1 ? 'it is' : 'they are'} not on the map.` : null;
  if (p.mode === 'missing') return `The region map "${input.style.map}" could not be loaded (${p.error}), so this is drawn as bars.`;
  return null;
}

export function richChartOption(input: ChartInput, base: Option): Option {
  const { flag, result, index, selections, style, c, colors } = input;
  const b = flag.binding!;
  const plan = result.plan;
  const ownDims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const x = ownDims[0]!;
  const y = ownDims[1];
  const rows = result.display.rows;
  const m0 = b.metrics[0]!;
  const label = (k: string) => index.metric(k)?.label ?? k;
  const fmt = (k: string) => (n: number | null | undefined) => (n === null || n === undefined ? '–' : formatNumber(n, b.share ? 'percent' : index.metric(k)?.format));
  const dimLabel = (d: { field: string }) => index.field(d.field)?.label ?? d.field;
  const labelled = style.labels !== 'off';
  const item = { ...(base.tooltip as Option), trigger: 'item' };
  const valueAxis = (k: string, extra: Option = {}) => ({ type: 'value', splitLine: { show: style.gridLines !== false, lineStyle: { color: c.line } }, axisLabel: { color: c.ink3, formatter: fmt(k), hideOverlap: true }, ...extra });
  const catAxis = (data: string[], extra: Option = {}) => ({ type: 'category', data, axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false }, axisLabel: { color: c.ink2, hideOverlap: true }, ...extra });
  const dimmed = (key: string, v: Cell) => (isSelected(selections, key, v) === false ? { opacity: DIM } : {});
  // A fill from the panel to the look's first colour: the scale for heatmaps and the calendar.
  const scale = (values: number[]) => {
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values) || 1;
    return {
    min,
    max,
    text: [fmt(m0)(max), fmt(m0)(min)],
    textGap: 6,
    calculable: false,
    orient: 'horizontal',
    left: 'center',
    bottom: 0,
    itemWidth: 10,
    itemHeight: 120,
    textStyle: { color: c.ink3 },
    formatter: (n: number) => fmt(m0)(n),
    inRange: { color: [withAlpha(colors[0]!, 0.08), colors[0]!] },
    };
  };

  switch (flag.kind as RichKind) {
    case 'radar': {
      const cats = chartCategories(flag, result);
      // Three or more measures read best as spokes, one shape per value; otherwise each value is a spoke.
      const spokesAreMetrics = !y && b.metrics.length >= 3 && cats.length <= 8;
      if (spokesAreMetrics) {
        const max = b.metrics.map((k) => Math.max(0, ...rows.map((r) => r.values[k] ?? 0)) || 1);
        return {
          ...base,
          tooltip: item,
          legend: legendFor(style, cats.length, c.ink2).legend,
          radar: { indicator: b.metrics.map((k, i) => ({ name: label(k), max: max[i]! * 1.05 })), radius: '64%', axisName: { color: c.ink2 }, splitLine: { lineStyle: { color: c.line } }, splitArea: { show: false }, axisLine: { lineStyle: { color: c.line } } },
          series: [
            {
              type: 'radar',
              symbolSize: 4,
              areaStyle: { opacity: 0.12 },
              data: rows.map((r, i) => {
                const v = r.dims[x.key] ?? null;
                return { name: formatDim(v, x.grain), raw: v, value: b.metrics.map((k) => r.values[k] ?? 0), itemStyle: { color: colors[i % colors.length] }, lineStyle: { color: colors[i % colors.length], width: style.lineWidth ?? 2, ...dimmed(x.key, v) }, ...dimmed(x.key, v) };
              }),
              tooltip: { formatter: (p: { name: string; value: number[] }) => [p.name, ...b.metrics.map((k, i) => `${label(k)}: ${fmt(k)(p.value[i])}`)].join('<br/>') },
            },
          ],
        };
      }
      const shapes = y ? distinct(rows, y.key).map((s) => ({ name: formatDim(s, y.grain), values: cats.map((cat) => rows.find((r) => String(r.dims[x.key]) === String(cat) && String(r.dims[y.key]) === String(s))?.values[m0] ?? 0), k: m0 })) : b.metrics.map((k) => ({ name: label(k), values: cats.map((cat) => rows.find((r) => String(r.dims[x.key]) === String(cat))?.values[k] ?? 0), k }));
      const top = Math.max(0, ...shapes.flatMap((s) => s.values)) || 1;
      return {
        ...base,
        tooltip: item,
        legend: legendFor(style, shapes.length, c.ink2).legend,
        radar: { indicator: cats.map((v) => ({ name: formatDim(v, x.grain), max: top * 1.05 })), radius: '64%', axisName: { color: c.ink2 }, splitLine: { lineStyle: { color: c.line } }, splitArea: { show: false }, axisLine: { lineStyle: { color: c.line } } },
        series: [{ type: 'radar', symbolSize: 4, areaStyle: { opacity: 0.15 }, lineStyle: { width: style.lineWidth ?? 2 }, data: shapes.map((s, i) => ({ name: s.name, value: s.values, itemStyle: { color: colors[i % colors.length] } })), tooltip: { formatter: (p: { name: string; value: number[] }) => [p.name, ...cats.map((v, i) => `${formatDim(v, x.grain)}: ${fmt(shapes[0]!.k)(p.value[i])}`)].join('<br/>') } }],
      };
    }

    case 'scatter': {
      const [mx, my, ms] = b.metrics as [string, string, string?];
      const sizes = ms ? rows.map((r) => Math.abs(r.values[ms] ?? 0)) : [];
      const big = Math.max(1, ...sizes);
      return {
        ...base,
        tooltip: { ...item, formatter: (p: { name: string; value: number[] }) => [p.name, `${label(mx)}: ${fmt(mx)(p.value[0])}`, `${label(my)}: ${fmt(my)(p.value[1])}`, ...(ms ? [`${label(ms)}: ${fmt(ms)(p.value[2])}`] : [])].join('<br/>') },
        grid: { left: 30, right: 16, top: 12, bottom: 24, containLabel: true },
        xAxis: valueAxis(mx, { name: label(mx), nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: c.ink2 }, scale: style.zeroBase === false }),
        yAxis: valueAxis(my, { name: label(my), nameLocation: 'middle', nameRotate: 90, nameGap: 44, nameTextStyle: { color: c.ink2 }, scale: style.zeroBase === false }),
        series: [
          {
            type: 'scatter',
            data: rows.map((r) => {
              const v = r.dims[x.key] ?? null;
              const size = ms ? 8 + 32 * Math.sqrt(Math.abs(r.values[ms] ?? 0) / big) : 12;
              return { name: formatDim(v, x.grain), raw: v, value: [r.values[mx] ?? 0, r.values[my] ?? 0, ...(ms ? [r.values[ms] ?? 0] : [])], symbolSize: size, itemStyle: { color: withAlpha(colors[0]!, 0.75), borderColor: colors[0], ...dimmed(x.key, v) } };
            }),
            label: { show: labelled && rows.length <= 12, formatter: '{b}', position: 'right', color: c.ink2, fontSize: 11 },
            labelLayout: { hideOverlap: true },
            emphasis: { focus: style.focus ? 'self' : 'none' },
          },
        ],
      };
    }

    case 'heatmap': {
      const across = distinct(rows, x.key);
      const down = distinct(rows, y!.key);
      const data = rows.map((r) => [across.findIndex((v) => String(v) === String(r.dims[x.key])), down.findIndex((v) => String(v) === String(r.dims[y!.key])), r.values[m0] ?? null]);
      const values = data.map((d) => d[2]).filter((v): v is number => typeof v === 'number');
      return {
        ...base,
        tooltip: { ...item, formatter: (p: { value: [number, number, number | null] }) => `${formatDim(across[p.value[0]] ?? null, x.grain)} · ${formatDim(down[p.value[1]] ?? null, y!.grain)}<br/>${label(m0)}: ${fmt(m0)(p.value[2])}` },
        grid: { left: 8, right: 12, top: 10, bottom: 40, containLabel: true },
        xAxis: catAxis(across.map((v) => formatDim(v, x.grain)), { splitArea: { show: false }, axisLabel: { color: c.ink2, interval: 0, width: 84, overflow: 'truncate' } }),
        yAxis: catAxis(down.map((v) => formatDim(v, y!.grain)), { splitArea: { show: false } }),
        visualMap: scale(values),
        series: [
          {
            type: 'heatmap',
            data: data.map((d) => ({ value: d, raw: across[d[0] as number] ?? null, ...(isSelected(selections, x.key, across[d[0] as number] ?? null) === false ? { itemStyle: { opacity: DIM } } : {}) })),
            itemStyle: { borderColor: c.panel, borderWidth: 1, ...(style.corners ? { borderRadius: Math.min(4, style.corners) } : {}) },
            label: { show: labelled && across.length * down.length <= 60, color: c.ink, fontSize: 10, formatter: (p: { value: [number, number, number | null] }) => fmt(m0)(p.value[2]) },
          },
        ],
      };
    }

    case 'calendar': {
      const days = rows.map((r) => ({ day: String(r.dims[x.key] ?? '').slice(0, 10), raw: r.dims[x.key] ?? null, v: r.values[m0] ?? null })).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)).sort((a, z) => (a.day < z.day ? -1 : 1));
      const range = days.length ? [days[0]!.day, days[days.length - 1]!.day] : [new Date().toISOString().slice(0, 10)];
      const values = days.map((d) => d.v).filter((v): v is number => typeof v === 'number');
      return {
        ...base,
        tooltip: { ...item, formatter: (p: { value: [string, number | null] }) => `${p.value[0]}<br/>${label(m0)}: ${fmt(m0)(p.value[1])}` },
        visualMap: scale(values),
        calendar: { range, top: 26, left: 36, right: 12, bottom: 34, cellSize: ['auto', 'auto'], splitLine: { lineStyle: { color: c.line } }, itemStyle: { color: c.panel, borderColor: c.line, borderWidth: 1 }, dayLabel: { color: c.ink3, firstDay: 1, nameMap: 'en' }, monthLabel: { color: c.ink2 }, yearLabel: { show: false } },
        series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: days.map((d) => ({ value: [d.day, d.v], raw: d.raw, ...(isSelected(selections, x.key, d.raw) === false ? { itemStyle: { opacity: DIM } } : {}) })) }],
      };
    }

    case 'waterfall': {
      // Each value steps from where the last one ended; the last bar is the total. An invisible bar
      // under each step lifts it to its start.
      const cats = chartCategories(flag, result);
      let run = 0;
      const steps = cats.map((v) => {
        const n = rows.find((r) => String(r.dims[x.key]) === String(v))?.values[m0] ?? 0;
        const start = run;
        run += n;
        return { v, n, low: Math.min(start, run), high: Math.max(start, run) };
      });
      const names = [...cats.map((v) => formatDim(v, x.grain)), 'Total'];
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: Array<{ dataIndex: number }>) => { const i = ps[0]?.dataIndex ?? 0; const s = steps[i]; return s ? `${names[i]}<br/>${label(m0)}: ${s.n >= 0 ? '+' : ''}${fmt(m0)(s.n)}<br/>Running total: ${fmt(m0)(s.n >= 0 ? s.high : s.low)}` : `Total<br/>${fmt(m0)(run)}`; } },
        grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
        xAxis: catAxis(names),
        yAxis: valueAxis(m0),
        series: [
          { type: 'bar', stack: 'walk', silent: true, itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, data: [...steps.map((s) => s.low), Math.min(0, run)] },
          {
            type: 'bar',
            stack: 'walk',
            name: label(m0),
            data: [
              ...steps.map((s) => ({ value: s.high - s.low, raw: s.v, itemStyle: { color: s.n >= 0 ? c.good : c.bad, ...(style.corners ? { borderRadius: Math.min(4, style.corners) } : {}), ...dimmed(x.key, s.v) } })),
              { value: Math.abs(run), itemStyle: { color: colors[0] } },
            ],
            label: { show: labelled && steps.length <= 16, position: 'top', color: c.ink2, fontSize: 11, formatter: (p: { dataIndex: number }) => (steps[p.dataIndex] ? `${steps[p.dataIndex]!.n >= 0 ? '+' : ''}${fmt(m0)(steps[p.dataIndex]!.n)}` : fmt(m0)(run)) },
          },
        ],
      };
    }

    case 'pareto': {
      // Largest first, with the running share on its own 0–100% scale and the 80% line drawn.
      const sorted = rows.map((r) => ({ v: r.dims[x.key] ?? null, n: r.values[m0] ?? 0 })).sort((a, z) => z.n - a.n);
      const total = sorted.reduce((s, r) => s + Math.max(0, r.n), 0) || 1;
      let run = 0;
      const cumulative = sorted.map((r) => (run += Math.max(0, r.n)) / total);
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: legendFor(style, 2, c.ink2).legend,
        grid: { left: 8, right: 12, top: legendFor(style, 2, c.ink2).top, bottom: 4, containLabel: true },
        xAxis: catAxis(sorted.map((r) => formatDim(r.v, x.grain))),
        yAxis: [valueAxis(m0), { type: 'value', min: 0, max: 1, splitLine: { show: false }, axisLabel: { color: c.ink3, formatter: (n: number) => `${Math.round(n * 100)}%` } }],
        series: [
          { type: 'bar', name: label(m0), tooltip: { valueFormatter: fmt(m0) }, data: sorted.map((r, i) => ({ value: r.n, raw: r.v, itemStyle: { color: colors[0], ...(style.corners ? { borderRadius: [style.corners, style.corners, 0, 0] } : {}), ...dimmed(x.key, r.v), ...(cumulative[i - 1] !== undefined && cumulative[i - 1]! >= 0.8 ? { opacity: 0.55 } : {}) } })) },
          { type: 'line', name: 'Running share', yAxisIndex: 1, symbolSize: 5, smooth: false, data: cumulative, itemStyle: { color: colors[1] ?? c.ink }, lineStyle: { width: style.lineWidth ?? 2 }, tooltip: { valueFormatter: (n: number) => `${(n * 100).toFixed(1)}%` }, markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0.8, name: '80%' }], label: { formatter: '80%', color: c.ink2, position: 'insideEndTop' }, lineStyle: { color: c.ink3, type: 'dashed', width: 1.5 } } },
        ],
      };
    }

    case 'sankey': {
      // A value can appear on both sides; the right-hand copy is marked so the flow has no loop.
      const left = new Set(rows.map((r) => formatDim(r.dims[x.key] ?? null, x.grain)));
      const right = (v: Cell) => {
        const name = formatDim(v, y!.grain);
        return left.has(name) ? `${name} ›` : name;
      };
      const links = rows.filter((r) => (r.values[m0] ?? 0) > 0).map((r) => ({ source: formatDim(r.dims[x.key] ?? null, x.grain), target: right(r.dims[y!.key] ?? null), value: r.values[m0]!, raw: r.dims[x.key] ?? null }));
      const names = [...new Set(links.flatMap((l) => [l.source, l.target]))];
      const sourceRaw = new Map(links.map((l) => [l.source, l.raw]));
      return {
        ...base,
        tooltip: { ...item, valueFormatter: fmt(m0) },
        series: [
          {
            type: 'sankey',
            left: 8,
            right: 90,
            top: 8,
            bottom: 8,
            nodeGap: 8,
            nodeWidth: 12,
            draggable: false,
            emphasis: { focus: 'adjacency' },
            data: names.map((n, i) => ({ name: n, ...(sourceRaw.has(n) ? { raw: sourceRaw.get(n) } : {}), itemStyle: { color: colors[i % colors.length], borderColor: c.panel, ...(sourceRaw.has(n) ? dimmed(x.key, sourceRaw.get(n) ?? null) : {}) } })),
            links,
            lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
            label: { show: labelled, color: c.ink2, fontSize: 11 },
          },
        ],
      };
    }

    case 'sunburst': {
      const inner = distinct(rows, x.key);
      const data = inner.map((v, i) => ({
        name: formatDim(v, x.grain),
        raw: v,
        itemStyle: { color: colors[i % colors.length], ...dimmed(x.key, v) },
        children: rows.filter((r) => String(r.dims[x.key]) === String(v) && (r.values[m0] ?? 0) > 0).map((r) => ({ name: formatDim(r.dims[y!.key] ?? null, y!.grain), value: r.values[m0]!, raw: v })),
      }));
      return {
        ...base,
        tooltip: { ...item, valueFormatter: fmt(m0) },
        series: [{ type: 'sunburst', radius: ['14%', '92%'], nodeClick: false, sort: undefined, data, itemStyle: { borderColor: c.panel, borderWidth: 2, ...(style.corners ? { borderRadius: Math.min(6, style.corners) } : {}) }, label: { show: labelled, color: c.ink, fontSize: 11, minAngle: 12, rotate: 'radial' }, levels: [{}, { label: { rotate: 'tangential' } }, { itemStyle: { opacity: 0.75 } }], emphasis: { focus: 'ancestor' } }],
      };
    }

    case 'stream': {
      // Along the date field, one band per value of the other field.
      const dateFirst = !!x.grain || index.field(x.field)?.type === 'date';
      const when = dateFirst ? x : y!;
      const band = dateFirst ? y! : x;
      const bands = distinct(rows, band.key);
      const data = rows.map((r) => [String(r.dims[when.key] ?? '').slice(0, 10), r.values[m0] ?? 0, formatDim(r.dims[band.key] ?? null, band.grain)]);
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: c.line } }, valueFormatter: fmt(m0) },
        legend: { ...(legendFor(style, bands.length, c.ink2).legend ?? { show: false }), data: bands.map((v) => formatDim(v, band.grain)) },
        singleAxis: { type: 'time', top: legendFor(style, bands.length, c.ink2).top, bottom: 28, left: 12, right: 12, axisLine: { lineStyle: { color: c.line } }, axisLabel: { color: c.ink2, hideOverlap: true }, splitLine: { show: style.gridLines !== false, lineStyle: { color: c.line, type: 'dashed' } }, name: dimLabel(when), nameTextStyle: { color: c.ink3 } },
        series: [{ type: 'themeRiver', data, label: { show: false }, emphasis: { focus: 'self' }, itemStyle: { opacity: 0.9 } }],
      };
    }

    case 'combo': {
      // Bars and a line along one field: each measure on the left or the right scale (combo.ts comboRoles).
      const cats = chartCategories(flag, result);
      const roles = comboRoles(b.metrics, style.combo);
      const hasLeft = roles.some((r) => r.axis === 'left');
      const axisOf = (r: { axis: 'left' | 'right' }) => (hasLeft && r.axis === 'right' ? 1 : 0);
      const twoScales = roles.some((r) => axisOf(r) === 1);
      const share = (k: string, v: number | null) => (b.share && typeof v === 'number' && result.display.totals[k] ? v / (result.display.totals[k] as number) : v);
      const decal = (tone: 'good' | 'warn' | 'bad') => ({ symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: (tone === 'warn' ? 1 : -1) * (Math.PI / 4), color: c.panel });
      const curve = style.curve === 'straight' ? { smooth: false } : style.curve === 'step' ? { step: 'middle' } : { smooth: 0.2 };
      const showSymbol = style.markers === 'on' ? true : style.markers === 'off' ? false : cats.length <= 24;
      const fill = (color: string) => (style.fill === 'gradient' && isPlainHex(color) ? { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color }, { offset: 1, color: withAlpha(color, 0.55) }] } : color);
      const seriesList: Option[] = roles.map((r, i) => {
        const k = r.metric;
        const color = colors[i % colors.length]!;
        const bar = r.as === 'bar';
        return {
          name: label(k),
          type: r.as,
          yAxisIndex: axisOf(r),
          ...(bar ? { barMaxWidth: 42, ...(style.barLayout === 'stacked' ? { stack: `bars-${axisOf(r)}` } : {}) } : { ...curve, showSymbol, symbolSize: 6, lineStyle: { width: style.lineWidth ?? 2 }, z: 3 }),
          itemStyle: { color: bar ? fill(color) : color, ...(bar && style.corners ? { borderRadius: [style.corners, style.corners, 0, 0] } : {}) },
          tooltip: { valueFormatter: (n: number | null) => fmt(k)(n) },
          ...(style.labels === 'on' ? { label: { show: true, position: 'top', color: c.ink2, fontSize: 11, formatter: (p: { value: unknown }) => { const v = typeof p.value === 'object' && p.value !== null ? (p.value as { value: unknown }).value : p.value; return typeof v === 'number' ? fmt(k)(v) : ''; } }, labelLayout: { hideOverlap: true } } : {}),
          ...(style.focus ? { emphasis: { focus: 'series' } } : {}),
          data: cats.map((cat) => {
            const row = rows.find((rr) => String(rr.dims[x.key]) === String(cat));
            const v = row ? (row.values[k] ?? null) : null;
            const tone = typeof v === 'number' ? toneFor(flag.behavior, k, v) : null;
            const sel = isSelected(selections, x.key, cat);
            return { value: share(k, v), raw: cat, itemStyle: { ...(tone ? { color: c[tone] } : {}), ...(tone && bar ? { decal: decal(tone) } : {}), ...(sel === false ? { opacity: DIM } : {}) } };
          }),
        };
      });
      // A goal line and the average go on the bars' scale: the first bar on the left, else the first measure.
      const anchorAt = Math.max(0, roles.findIndex((r) => r.as === 'bar' && axisOf(r) === 0));
      const anchorKey = roles[anchorAt]!.metric;
      const lines: Option[] = [];
      if (style.target && !b.share) {
        const name = style.target.label || 'Target';
        lines.push({ yAxis: style.target.value, name, label: { formatter: () => name, position: 'insideEndTop', color: c.ink }, lineStyle: { color: c.ink, type: 'dashed', width: 1.5 } });
      }
      if (style.average && !b.share) lines.push({ type: 'average', name: 'Average', label: { formatter: (p: { value: number }) => `Average ${fmt(anchorKey)(p.value)}`, position: 'insideEndBottom', color: c.ink2 }, lineStyle: { color: c.ink3, type: 'dotted', width: 1.5 } });
      if (lines.length) seriesList[anchorAt]!.markLine = { silent: true, symbol: 'none', data: lines };
      const place = legendFor(style, seriesList.length, c.ink2);
      const first = (axis: number) => roles.find((r) => axisOf(r) === axis)!.metric;
      const scaleName = (axis: number) => roles.filter((r) => axisOf(r) === axis).map((r) => label(r.metric)).join(', ');
      const named = (axis: number) => (twoScales ? { name: scaleName(axis), nameTextStyle: { color: c.ink3, align: axis ? 'right' : 'left' }, nameGap: 8 } : {});
      const zoom = style.zoom && cats.length > 1;
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: place.legend,
        grid: { left: 8, right: place.right, top: place.top + (twoScales ? 16 : 0), bottom: place.bottom + (zoom ? 26 : 0), containLabel: true },
        // Every name when there are few, wrapped onto two lines rather than skipped.
        xAxis: catAxis(cats.map((v) => formatDim(v, x.grain)), cats.length <= 12 ? { axisLabel: { color: c.ink2, interval: 0, width: 80, overflow: 'break', lineHeight: 13 } } : {}),
        yAxis: [valueAxis(first(0), named(0)), ...(twoScales ? [valueAxis(first(1), { ...named(1), splitLine: { show: false } })] : [])],
        series: seriesList,
        ...(zoom
          ? { dataZoom: [{ type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true, preventDefaultMouseMove: false }, { type: 'slider', xAxisIndex: 0, height: 16, bottom: place.bottom + 2, brushSelect: false, showDetail: false, borderColor: c.line, textStyle: { color: c.ink3 } }] }
          : {}),
      };
    }

    case 'map': {
      const p = mapPlan(input);
      if (p.mode === 'missing') return flagChartOption({ ...input, flag: { ...flag, kind: 'bar' } });
      if (p.mode === 'loading') return { ...base, series: [] };
      const id = style.map ?? US_STATES;
      const tile = id === US_STATES;
      const tip = (name: string, v: number | null | undefined) => `${name}<br/>${label(m0)}: ${typeof v === 'number' && Number.isFinite(v) ? fmt(m0)(v) : 'no value'}`;
      if (p.mode === 'points') {
        const values = p.points.map((pt) => pt.v).filter((v): v is number => v !== null);
        const big = Math.max(1, ...values.map((v) => Math.abs(v)));
        const data = p.points.map((pt) => ({ name: pt.name, raw: pt.raw, value: [pt.lon, pt.lat, pt.v ?? 0], symbolSize: 6 + 22 * Math.sqrt(Math.abs(pt.v ?? 0) / big), itemStyle: { borderColor: c.panel, borderWidth: 1, ...dimmed(x.key, pt.raw) } }));
        const dots = { type: 'scatter', data, label: { show: labelled && data.length <= 12, formatter: '{b}', position: 'right', color: c.ink2, fontSize: 11 }, labelLayout: { hideOverlap: true }, tooltip: { formatter: (q: { name: string; value: number[] }) => tip(q.name, q.value[2]) } };
        const visualMap = { ...scale(values), dimension: 2, seriesIndex: 0 };
        if (p.onMap) {
          return {
            ...base,
            tooltip: item,
            visualMap,
            geo: { map: chartMapName(id), roam: false, top: 8, bottom: 40, left: 8, right: 8, silent: true, itemStyle: { areaColor: withAlpha(c.line, 0.6), borderColor: c.ink3, borderWidth: 0.6 }, label: { show: false } },
            series: [{ ...dots, coordinateSystem: 'geo' }],
          };
        }
        // No map with longitude and latitude to put them on: a plain frame, longitude across and latitude up.
        const lons = p.points.map((pt) => pt.lon);
        const lats = p.points.map((pt) => pt.lat);
        const pad = (xs: number[], lo: number, hi: number) => {
          const a = Math.min(...xs);
          const z = Math.max(...xs);
          const m = Math.max(0.5, (z - a) * 0.08);
          return { min: Math.max(lo, Math.floor((a - m) * 10) / 10), max: Math.min(hi, Math.ceil((z + m) * 10) / 10) };
        };
        const deg = (n: number) => `${Math.round(n * 10) / 10}°`;
        const axis = (name: string, range: object, extra: Option = {}) => ({ type: 'value', name, nameLocation: 'middle', nameTextStyle: { color: c.ink3 }, ...range, splitLine: { show: style.gridLines !== false, lineStyle: { color: c.line } }, axisLabel: { color: c.ink3, formatter: deg, hideOverlap: true }, ...extra });
        return {
          ...base,
          tooltip: item,
          visualMap,
          grid: { left: 30, right: 16, top: 12, bottom: 56, containLabel: true },
          xAxis: axis('Longitude', data.length ? pad(lons, -180, 180) : {}, { nameGap: 24 }),
          yAxis: axis('Latitude', data.length ? pad(lats, -90, 90) : {}, { nameGap: 36, nameRotate: 90 }),
          series: [dots],
        };
      }
      const values = p.regions.map((r) => r.value);
      return {
        ...base,
        tooltip: item,
        visualMap: { ...scale(values), seriesIndex: 0 },
        series: [
          {
            type: 'map',
            map: chartMapName(id),
            roam: false,
            ...(tile ? { aspectScale: 1 } : {}),
            top: 8,
            bottom: 40,
            left: 8,
            right: 8,
            selectedMode: false,
            itemStyle: { areaColor: withAlpha(c.line, 0.6), borderColor: c.panel, borderWidth: tile ? 2 : 0.8 },
            label: { show: labelled && (tile || (mapEntry(id)?.regions.length ?? 0) <= 40), color: c.ink, fontSize: tile ? 10 : 11 },
            emphasis: { label: { show: true, color: c.ink }, itemStyle: { areaColor: withAlpha(colors[1] ?? colors[0]!, 0.85), borderColor: c.ink, borderWidth: 1 } },
            tooltip: { formatter: (q: { name: string; value: number }) => tip(tile ? stateName(q.name) : q.name, q.value) },
            data: p.regions.map((r) => ({ name: r.name, value: r.value, raw: r.raw, ...(isSelected(selections, x.key, r.raw) === false ? { itemStyle: { opacity: DIM } } : {}) })),
          },
        ],
      };
    }
  }
  return base;
}

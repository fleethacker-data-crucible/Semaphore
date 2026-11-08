// The richer chart kinds (src/core/kinds.ts) as ECharts options: spider, scatter, heatmap, calendar,
// waterfall, Pareto, Sankey, sunburst and stream. Loaded with chart-extras.ts the first time a flag
// needs one, so a page of bars and lines never pays for them (web/size-budget.json).
//
// The same rules as chart-option.ts: text stays in the ink colours, a value the page is filtered
// away from is dimmed rather than hidden, and every mark that stands for a value of the flag's first
// field carries it as `raw`, so a click filters or drills by that value.

import type { Cell } from '../../../src/core/crossfilter.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import type { RichKind } from '../../../src/core/kinds.ts';
import { type ChartInput, chartCategories, formatDim, isSelected, legendFor } from './chart-option.ts';

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
  }
  return base;
}

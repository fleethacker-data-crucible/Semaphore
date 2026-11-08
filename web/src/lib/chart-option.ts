// A flag's chart as an ECharts option. One function, so the page, a shared report and every export
// draw the same chart. Plain data in, plain option out: no DOM and no chart library here.
//
// Rules that a look cannot change: a mark that breaks a colour rule keeps the rule's colour and its
// pattern, bars start at zero, and text stays in the ink colours rather than the series colour.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import { contrastRatio, type FlagStyle } from '../../../src/core/design.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { type Flag, type TimeGrain, type Tone, toneFor } from '../../../src/core/hoist.ts';
import type { FlagResult } from './data.ts';

export interface ChartColors {
  ink: string;
  ink2: string;
  ink3: string;
  line: string;
  panel: string;
  good: string;
  warn: string;
  bad: string;
}

export interface ChartInput {
  flag: Flag;
  result: FlagResult;
  index: CatalogIndex;
  selections: Selections;
  style: FlagStyle;
  c: ChartColors;
  /** The series colours for this look. */
  colors: readonly string[];
  fontFamily?: string;
}

type Option = Record<string, unknown>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDim(v: Cell, grain?: TimeGrain): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (!grain) return String(v);
  const s = String(v);
  const y = s.slice(0, 4);
  const m = Number(s.slice(5, 7));
  if (grain === 'year') return y;
  if (grain === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (grain === 'week') return `Wk of ${s.slice(5, 10)}`;
  return s.slice(0, 10);
}

export function isSelected(selections: Selections, key: string, v: Cell): boolean | null {
  const sel = selections[key];
  if (!sel || sel.length === 0) return null;
  return sel.some((x) => String(x) === String(v));
}

/** Distinct values along the chart, in order. */
export function chartCategories(flag: Flag, result: FlagResult): Cell[] {
  const plan = result.plan;
  const x = plan.dimensions.filter((d) => plan.own.includes(d.key))[0];
  const out: Cell[] = [];
  if (!x) return out;
  for (const r of result.display.rows) {
    const v = r.dims[x.key] ?? null;
    if (!out.some((c2) => String(c2) === String(v))) out.push(v);
  }
  return out;
}

const withAlpha = (hex: string, alpha: number) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
const isPlainHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);

/** A fill along the bar or down the area, fading away from the mark's end. */
function gradient(color: string, sideways: boolean, from: number, to: number) {
  if (!isPlainHex(color)) return color;
  return { type: 'linear', x: 0, y: 0, x2: sideways ? 1 : 0, y2: sideways ? 0 : 1, colorStops: [{ offset: 0, color: withAlpha(color, sideways ? to : from) }, { offset: 1, color: withAlpha(color, sideways ? from : to) }] };
}

function legendFor(style: FlagStyle, seriesCount: number, ink2: string): { legend: Option | undefined; top: number; right: number; bottom: number } {
  const place = style.legend ?? 'auto';
  const none = { legend: undefined, top: 10, right: 12, bottom: 4 };
  if (place === 'off' || (place === 'auto' && seriesCount < 2)) return none;
  const common = { type: 'scroll', textStyle: { color: ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 };
  if (place === 'bottom') return { legend: { ...common, bottom: 0 }, top: 10, right: 12, bottom: 28 };
  if (place === 'right') return { legend: { ...common, orient: 'vertical', right: 0, top: 'middle' }, top: 10, right: 120, bottom: 4 };
  return { legend: { ...common, top: 0 }, top: 28, right: 12, bottom: 4 };
}

function pieOption(input: ChartInput, base: Option, x: { key: string; grain?: TimeGrain }): Option {
  const { flag, result, index, selections, style, c, colors } = input;
  const k = flag.binding!.metrics[0]!;
  const format = (n: number) => formatNumber(n, index.metric(k)?.format);
  const form = style.pieForm ?? 'donut';
  const labelled = style.labels !== 'off';
  const glow = style.glow ? { shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.3)' } : {};
  const data = result.display.rows.map((r, i) => {
    const v = r.dims[x.key] ?? null;
    const sel = isSelected(selections, x.key, v);
    const color = colors[i % colors.length]!;
    return { name: formatDim(v, x.grain), value: r.values[k], raw: v, ...(form === 'treemap' ? { label: { color: isPlainHex(color) && contrastRatio(color, '#ffffff') >= 3 ? '#ffffff' : '#111111' } } : {}), itemStyle: { color: style.fill === 'gradient' ? gradient(color, false, 1, 0.6) : color, ...(sel === false ? { opacity: 0.35 } : {}) } };
  });
  const tooltip = { ...(base.tooltip as Option), trigger: 'item', valueFormatter: format };
  const emphasis = style.focus ? { focus: 'self' } : undefined;
  const legend = style.legend && style.legend !== 'auto' ? legendFor(style, 2, c.ink2).legend : undefined;
  if (form === 'funnel') {
    return { ...base, tooltip, legend, series: [{ type: 'funnel', sort: 'descending', gap: 2, left: '10%', width: '80%', top: 8, bottom: 8, minSize: '12%', itemStyle: { borderColor: c.panel, borderWidth: 1, ...glow }, label: { show: labelled, color: c.ink, formatter: '{b}' }, emphasis, data }] };
  }
  if (form === 'treemap') {
    return { ...base, tooltip, series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 2, right: 2, top: 2, bottom: 2, itemStyle: { gapWidth: 2, borderColor: c.panel }, label: { show: labelled, formatter: '{b}', overflow: 'truncate' }, data }] };
  }
  // A legend down the right takes room, so the pie moves left and shrinks rather than sit under it.
  const beside = style.legend === 'right';
  const shrink = (r: string) => (beside ? `${Math.round(Number.parseInt(r, 10) * 0.85)}%` : r);
  const radius = (form === 'pie' ? ['0%', '72%'] : form === 'rose' ? ['16%', '76%'] : ['42%', '72%']).map(shrink);
  return {
    ...base,
    tooltip,
    legend,
    series: [{ type: 'pie', radius, ...(beside ? { center: ['40%', '50%'] } : {}), ...(form === 'rose' ? { roseType: 'radius' } : {}), itemStyle: { borderColor: c.panel, borderWidth: 2, ...(style.corners ? { borderRadius: style.corners } : {}), ...glow }, label: { show: labelled, color: c.ink2, formatter: '{b}\n{d}%' }, labelLine: { show: labelled }, emphasis, data }],
  };
}

/** The chart for a flag that has a field of its own to draw along. */
export function flagChartOption(input: ChartInput): Option {
  const { flag, result, index, selections, style, c, colors } = input;
  const b = flag.binding!;
  const plan = result.plan;
  const ownDims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const x = ownDims[0]!;
  const series = ownDims[1];
  const rows = result.display.rows;
  const categories = chartCategories(flag, result);
  const metricFormat = (k: string) => index.metric(k)?.format;

  // Marks that break a colour rule carry a pattern as well as the colour, so they read in greyscale.
  const decal = (tone: Tone) =>
    tone === 'bad'
      ? { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: c.panel }
      : tone === 'warn'
        ? { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: c.panel }
        : { symbol: 'circle', symbolSize: 0.6, dashArrayX: [[1, 3]], dashArrayY: [3, 1], color: c.panel };

  const isLine = flag.kind === 'line' || flag.kind === 'area';
  const layout = style.barLayout ?? 'auto';
  const percent = !isLine && !!series && layout === 'percent';
  const asPercent = b.share || percent;
  const fmt = (k: string) => (n: number) => formatNumber(n, asPercent ? 'percent' : metricFormat(k));
  const share = (k: string, v: number | null) => (b.share && typeof v === 'number' && result.display.totals[k] ? v / (result.display.totals[k] as number) : v);
  // The earlier window's values are shares of the earlier window's own total (data.ts previousTotals).
  const previousShare = (k: string, v: number | null) => {
    const total = result.previousTotals?.[k] ?? result.display.totals[k];
    return b.share && typeof v === 'number' && total ? v / total : v;
  };

  const base: Option = {
    textStyle: { color: c.ink2, fontFamily: input.fontFamily ?? 'Segoe UI, system-ui, sans-serif' },
    tooltip: { trigger: 'axis', backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink } },
    color: [...colors],
  };
  if (flag.kind === 'pie') return pieOption(input, base, x);

  // Long or many category names read better down the side than squeezed along the bottom.
  const longest = Math.max(0, ...categories.map((v) => formatDim(v, x.grain).length));
  const autoSideways = !x.grain && (categories.length > 6 || (categories.length > 3 && longest > 9));
  const orientation = style.orientation ?? 'auto';
  const horizontal = !isLine && (orientation === 'horizontal' || (orientation === 'auto' && autoSideways));

  const curve = isLine ? (style.curve === 'straight' ? { smooth: false } : style.curve === 'step' ? { step: 'middle' } : { smooth: 0.2 }) : {};
  const lineLook = (color: string) => (isLine ? { lineStyle: { width: style.lineWidth ?? 2, ...(style.glow ? { shadowBlur: 10, shadowColor: withAlpha(color, 0.7) } : {}) } } : {});
  const areaLook = (color: string) => (flag.kind === 'area' ? { areaStyle: style.fill === 'gradient' ? { color: gradient(color, false, 0.55, 0.03), opacity: 1 } : { opacity: 0.25 } } : {});
  const radius = style.corners ? (horizontal ? [0, style.corners, style.corners, 0] : [style.corners, style.corners, 0, 0]) : undefined;
  const barLook = (color: string) =>
    isLine ? {} : { ...(radius ? { borderRadius: radius } : {}), ...(style.fill === 'gradient' ? { color: gradient(color, horizontal, 1, 0.55) } : {}), ...(style.glow ? { shadowBlur: 10, shadowColor: withAlpha(color, 0.55) } : {}) };
  const markers = (auto: boolean) => (style.markers === 'on' ? true : style.markers === 'off' ? false : auto);
  const labels = (k: string) =>
    style.labels === 'on'
      ? { label: { show: true, position: isLine ? 'top' : horizontal ? 'right' : 'top', color: c.ink2, fontSize: 11, formatter: (p: { value: unknown }) => { const v = typeof p.value === 'object' && p.value !== null ? (p.value as { value: unknown }).value : p.value; return typeof v === 'number' ? fmt(k)(v) : ''; } }, labelLayout: { hideOverlap: true } }
      : {};

  const seriesList: Array<Record<string, unknown>> = [];
  // Whether every share of the 100% layout fell in 0..1 (a negative part can push one outside).
  let sharesInRange = true;
  if (series) {
    const names: Cell[] = [];
    for (const r of rows) {
      const v = r.dims[series.key] ?? null;
      if (!names.some((n) => String(n) === String(v))) names.push(v);
    }
    const k = b.metrics[0]!;
    // Each part's size, so a negative part takes its share of the stack rather than shrinking the whole.
    const totalAt = (cat: Cell) => rows.filter((r) => String(r.dims[x.key]) === String(cat)).reduce((sum, r) => sum + (typeof r.values[k] === 'number' ? Math.abs(r.values[k] as number) : 0), 0);
    const stacked = !isLine && layout !== 'grouped';
    names.forEach((n, ni) => {
      const color = colors[ni % colors.length]!;
      seriesList.push({
        name: formatDim(n, series.grain),
        type: isLine ? 'line' : 'bar',
        stack: stacked ? 'all' : undefined,
        ...areaLook(color),
        ...curve,
        ...lineLook(color),
        ...labels(k),
        showSymbol: markers(false),
        itemStyle: { color, ...barLook(color) },
        data: categories.map((cat) => {
          const r = rows.find((row) => String(row.dims[x.key]) === String(cat) && String(row.dims[series.key]) === String(n));
          const v = r ? (r.values[k] ?? null) : null;
          if (percent) {
            const total = totalAt(cat);
            const part = typeof v === 'number' && total ? v / total : null;
            if (part !== null && (part < 0 || part > 1)) sharesInRange = false;
            return part;
          }
          return r ? share(k, v) : null;
        }),
      });
    });
  } else {
    b.metrics.forEach((k, mi) => {
      const label = index.metric(k)?.label ?? k;
      const color = colors[mi % colors.length]!;
      seriesList.push({
        name: label,
        type: isLine ? 'line' : 'bar',
        yAxisIndex: mi > 0 && b.metrics.length === 2 ? 1 : 0,
        ...areaLook(color),
        ...curve,
        ...lineLook(color),
        ...labels(k),
        showSymbol: markers(isLine && categories.length <= 24),
        barMaxWidth: 42,
        itemStyle: { color, ...barLook(color) },
        data: categories.map((cat, i) => {
          const r = rows.find((row) => String(row.dims[x.key]) === String(cat));
          const v = r ? (r.values[k] ?? null) : null;
          const tone = typeof v === 'number' ? toneFor(flag.behavior, k, v) : null;
          const sel = isSelected(selections, x.key, cat);
          const toned = tone ? c[tone] : undefined;
          return { value: share(k, v), itemStyle: { ...(toned ? { color: toned } : {}), ...(tone && !isLine ? { decal: decal(tone) } : {}), ...(sel === false ? { opacity: 0.35 } : {}) }, raw: cat, i };
        }),
      });
      if (result.previous && mi === 0) {
        seriesList.push({
          name: `${label}, ${b.compare === 'previous-year' ? 'a year earlier' : 'previous period'}`,
          type: isLine ? 'line' : 'bar',
          lineStyle: { type: 'dashed' },
          itemStyle: { color: c.ink3, opacity: isLine ? 1 : 0.45 },
          showSymbol: false,
          barMaxWidth: 42,
          data: categories.map((cat) => {
            const ri = rows.findIndex((row) => String(row.dims[x.key]) === String(cat));
            return ri >= 0 ? previousShare(k, result.previous![ri]?.[k] ?? null) : null;
          }),
        });
      }
    });
  }

  // Hovering dims the rest, on the page and in a shared report.
  if (style.focus) for (const s of seriesList) s.emphasis = { focus: seriesList.length > 1 ? 'series' : 'self' };

  // A goal line and the average, on the first series' scale. Neither applies when the axis is a
  // share of a whole (a share flag or the 100% layout): a target of 500 would flatten shares of 0..1.
  const lines: Array<Record<string, unknown>> = [];
  if (style.target && !asPercent) {
    const name = style.target.label || 'Target';
    // A function, so braces in the label are text rather than ECharts' {a} {b} {c} templates.
    lines.push({ [horizontal ? 'xAxis' : 'yAxis']: style.target.value, name, label: { formatter: () => name, position: 'insideEndTop', color: c.ink }, lineStyle: { color: c.ink, type: 'dashed', width: 1.5 } });
  }
  if (style.average && !asPercent && seriesList[0]) {
    lines.push({ type: 'average', name: 'Average', ...(horizontal ? { valueDim: 'x' } : {}), label: { formatter: (p: { value: number }) => `Average ${fmt(b.metrics[0]!)(p.value)}`, position: 'insideEndBottom', color: c.ink2 }, lineStyle: { color: c.ink3, type: 'dotted', width: 1.5 } });
  }
  if (lines.length) seriesList[0]!.markLine = { silent: true, symbol: 'none', data: lines };

  const catAxis = {
    type: 'category',
    data: categories.map((v) => formatDim(v, x.grain)),
    axisLine: { lineStyle: { color: c.line } },
    axisTick: { show: false },
    axisLabel: { color: c.ink2, hideOverlap: !horizontal, ...(horizontal ? { width: 120, overflow: 'truncate', interval: 0 } : {}) },
    inverse: horizontal,
  };
  const valueAxes = (b.metrics.length === 2 && !series ? b.metrics : [b.metrics[0]!]).map((k) => ({
    type: 'value',
    splitLine: { show: style.gridLines !== false, lineStyle: { color: c.line } },
    axisLabel: { color: c.ink3, formatter: fmt(k), hideOverlap: true },
    splitNumber: horizontal ? 3 : 5,
    // Shares stop at 100% unless a negative part pushed one outside 0..1; then the axis is left free.
    ...(percent && sharesInRange ? { max: 1 } : {}),
    // Only a line may leave zero out: a bar's length is its value.
    ...(isLine && style.zeroBase === false ? { scale: true } : {}),
  }));
  // Bars laid sideways swap the axes: the second measure's own scale is then a second x axis.
  if (horizontal) {
    for (const s of seriesList) {
      if (s.yAxisIndex !== undefined) {
        s.xAxisIndex = s.yAxisIndex;
        delete s.yAxisIndex;
      }
    }
  }
  const place = legendFor(style, seriesList.length, c.ink2);
  const zoom = style.zoom && categories.length > 1;
  const axisKey = horizontal ? 'yAxisIndex' : 'xAxisIndex';
  return {
    ...base,
    tooltip: { ...(base.tooltip as Option), valueFormatter: (n: number | null) => (n === null || n === undefined ? '–' : fmt(b.metrics[0]!)(n)) },
    legend: place.legend,
    grid: { left: 8, right: horizontal && zoom ? 36 : place.right, top: place.top, bottom: place.bottom + (zoom && !horizontal ? 26 : 0), containLabel: true },
    xAxis: horizontal ? valueAxes : catAxis,
    yAxis: horizontal ? catAxis : valueAxes,
    series: seriesList,
    ...(zoom
      ? {
          dataZoom: [
            { type: 'inside', [axisKey]: 0, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true, preventDefaultMouseMove: false },
            { type: 'slider', [axisKey]: 0, height: horizontal ? undefined : 16, width: horizontal ? 16 : undefined, bottom: horizontal ? undefined : place.bottom + 2, right: horizontal ? 4 : undefined, brushSelect: false, showDetail: false, borderColor: c.line, textStyle: { color: c.ink3 } },
          ],
        }
      : {}),
  };
}

/** The KPI as a dial: one number against the top of its scale. */
export function gaugeOption(input: { value: number; max: number; color: string; c: ChartColors; text: string; fontFamily?: string }): Option {
  const { value, max, color, c, text } = input;
  return {
    textStyle: { fontFamily: input.fontFamily ?? 'Segoe UI, system-ui, sans-serif' },
    series: [
      {
        type: 'gauge',
        min: 0,
        max,
        startAngle: 200,
        endAngle: -20,
        radius: '96%',
        center: ['50%', '62%'],
        pointer: { show: false },
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color } },
        axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, c.line]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: { valueAnimation: false, offsetCenter: [0, '6%'], fontSize: 24, fontWeight: 600, color: c.ink, formatter: () => text },
        data: [{ value }],
      },
    ],
  };
}

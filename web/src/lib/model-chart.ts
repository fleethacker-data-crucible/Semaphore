// A model's chart (src/core/predict ModelChart) as an ECharts option. Same rules as chart-option.ts:
// text stays in the ink colours, the look's series colours draw the data, and a mark that breaks a
// rule keeps its tone. Plain data in, plain option out, so the page, exports and tests share it.

import { fmt } from '../../../src/core/predict/format.ts';
import type { ModelChart, Tone, ValueFormat } from '../../../src/core/predict/types.ts';
import type { ChartColors } from './chart-option.ts';

type Option = Record<string, unknown>;

export interface ModelChartInput {
  chart: ModelChart;
  c: ChartColors;
  colors: readonly string[];
  /** The first measure's format, for values marked 'metric'. */
  metricFormat?: 'number' | 'currency' | 'percent';
  fontFamily?: string;
}

const isPlainHex = (s: string) => /^#[0-9a-f]{6}$/i.test(s);
const withAlpha = (hex: string, a: number) => (isPlainHex(hex) ? `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}` : hex);

export function modelChartOption({ chart, c, colors, metricFormat, fontFamily }: ModelChartInput): Option {
  const f = (format: ValueFormat | undefined) => (n: number | null | undefined) => fmt(n, format ?? 'metric', metricFormat);
  const tone = (t: Tone | undefined) => (t === 'bad' ? c.bad : t === 'warn' ? c.warn : t === 'good' ? c.good : c.ink);
  const base: Option = {
    textStyle: { color: c.ink2, fontFamily: fontFamily ?? 'Segoe UI, system-ui, sans-serif' },
    tooltip: { trigger: 'axis', backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink } },
    color: [...colors],
    animationDuration: 180,
  };
  const valueAxis = (format: ValueFormat | undefined, extra: Option = {}) => ({ type: 'value', splitLine: { lineStyle: { color: c.line } }, axisLabel: { color: c.ink3, formatter: f(format), hideOverlap: true }, scale: true, ...extra });
  const catAxis = (data: string[], extra: Option = {}) => ({ type: 'category', data, axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false }, axisLabel: { color: c.ink2, hideOverlap: true }, ...extra });
  const legend = (n: number) => (n > 1 ? { type: 'scroll', top: 0, textStyle: { color: c.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 } : undefined);

  switch (chart.kind) {
    case 'series': {
      const series: Option[] = [];
      if (chart.band) {
        // The band: an invisible line at the lower edge and a filled one stacked on it to the upper edge.
        const lower = chart.band.lower;
        const width = chart.band.upper.map((u, i) => (u === null || lower[i] === null || lower[i] === undefined ? null : u - (lower[i] as number)));
        series.push({ type: 'line', name: '_band_low', stack: 'band', data: lower, symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false }, silent: true, legendHoverLink: false });
        series.push({ type: 'line', name: chart.band.name, stack: 'band', data: width, symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: withAlpha(colors[0] ?? '#5fb3d0', 0.18) }, tooltip: { show: false }, silent: true });
      }
      let colour = 0;
      for (const s of chart.series) {
        const color = s.role === 'limit' ? c.bad : s.role === 'line' ? c.ink3 : s.role === 'fit' ? (colors[1] ?? c.ink2) : (colors[colour++ % colors.length] ?? c.ink);
        series.push({
          type: 'line',
          name: s.name,
          data: s.values,
          symbol: s.role === 'actual' ? 'circle' : 'none',
          symbolSize: 4,
          showSymbol: s.role === 'actual' && chart.x.length <= 60,
          connectNulls: false,
          lineStyle: { color, width: s.role === 'actual' || s.role === 'forecast' ? 2 : 1.5, type: s.role === 'forecast' || s.role === 'limit' ? 'dashed' : s.role === 'line' || s.role === 'fit' ? 'dotted' : 'solid' },
          itemStyle: { color },
        });
      }
      if (chart.marks?.length) {
        const actual = chart.series.find((s) => s.role === 'actual') ?? chart.series[0];
        series.push({
          type: 'scatter',
          name: 'Flagged',
          symbolSize: 10,
          data: chart.marks.map((m) => ({ value: [m.index, actual?.values[m.index] ?? null], name: m.label ?? '', itemStyle: { color: tone(m.tone), borderColor: c.panel, borderWidth: 1.5 } })),
          tooltip: { trigger: 'item', formatter: (p: { name: string; value: [number, number] }) => `${chart.x[p.value[0]] ?? ''}<br/>${p.name}${p.name ? ': ' : ''}${f(chart.yFormat)(p.value[1])}` },
          z: 5,
        });
      }
      const shown = chart.series.length + (chart.marks?.length ? 1 : 0) + (chart.band ? 1 : 0);
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), valueFormatter: f(chart.yFormat) },
        legend: { ...(legend(shown) ?? { show: false }), data: [...(chart.band ? [chart.band.name] : []), ...chart.series.map((s) => s.name), ...(chart.marks?.length ? ['Flagged'] : [])] },
        grid: { left: 8, right: 12, top: shown > 1 ? 28 : 10, bottom: 4, containLabel: true },
        xAxis: catAxis(chart.x, { boundaryGap: false }),
        yAxis: valueAxis(chart.yFormat),
        series,
      };
    }

    case 'panels': {
      const n = chart.panels.length;
      const gap = 4;
      const h = (100 - gap * (n + 1)) / n;
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), valueFormatter: f(chart.yFormat) },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        grid: chart.panels.map((_, i) => ({ left: 8, right: 84, top: `${gap + i * (h + gap)}%`, height: `${h}%`, containLabel: true })),
        xAxis: chart.panels.map((_, i) => catAxis(chart.x, { gridIndex: i, boundaryGap: false, axisLabel: { show: i === n - 1, color: c.ink2, hideOverlap: true } })),
        yAxis: chart.panels.map((_, i) => valueAxis(chart.yFormat, { gridIndex: i, splitNumber: 2 })),
        series: chart.panels.map((p, i) => ({ type: 'line', name: p.name, xAxisIndex: i, yAxisIndex: i, data: p.values, symbol: 'none', lineStyle: { width: 1.5 }, itemStyle: { color: colors[i % colors.length] }, endLabel: { show: true, formatter: p.name, color: c.ink2, fontSize: 11 } })),
      };
    }

    case 'histogram': {
      const labels = chart.bins.map((b) => f(chart.xFormat)((b.x0 + b.x1) / 2));
      const at = (v: number) => {
        const i = chart.bins.findIndex((b) => v >= b.x0 && v <= b.x1);
        return i < 0 ? (v < (chart.bins[0]?.x0 ?? 0) ? 0 : chart.bins.length - 1) : i;
      };
      const span = Math.max(1e-9, (chart.bins.at(-1)?.x1 ?? 1) - (chart.bins[0]?.x0 ?? 0));
      const order = chart.markers.map((m, i) => ({ v: m.value, i })).sort((a, b) => a.v - b.v);
      const lift = new Array<number>(chart.markers.length).fill(0);
      order.forEach((m, k) => {
        const prev = order[k - 1];
        if (prev && (m.v - prev.v) / span < 0.09) lift[m.i] = lift[prev.i]! + 1;
      });
      const top = 24 + 26 * Math.max(0, ...lift);
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: Array<{ dataIndex: number; value: number }>) => { const b = chart.bins[ps[0]?.dataIndex ?? 0]; return b ? `${f(chart.xFormat)(b.x0)} – ${f(chart.xFormat)(b.x1)}<br/>${ps[0]!.value.toLocaleString('en-US')} trials` : ''; } },
        grid: { left: 8, right: 12, top, bottom: chart.xLabel ? 24 : 4, containLabel: true },
        xAxis: catAxis(labels, { name: chart.xLabel, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: c.ink2 } }),
        yAxis: { type: 'value', splitLine: { lineStyle: { color: c.line } }, axisLabel: { color: c.ink3 } },
        series: [
          {
            type: 'bar',
            name: 'Trials',
            barCategoryGap: '4%',
            data: chart.bins.map((b) => b.count),
            itemStyle: { color: withAlpha(colors[0] ?? '#5fb3d0', 0.8) },
            markLine: {
              silent: true,
              symbol: 'none',
              data: chart.markers.map((m, i) => ({ xAxis: at(m.value), name: m.label, lineStyle: { color: m.tone ? tone(m.tone) : c.ink, type: 'dashed', width: 1.5 }, label: { formatter: `${m.label}\n${f(chart.xFormat)(m.value)}`, color: m.tone ? tone(m.tone) : c.ink, fontSize: 11, distance: [0, 4 + 26 * lift[i]!] } })),
            },
          },
        ],
      };
    }

    case 'bars': {
      // Largest at the top: category axes draw from the bottom, so the order is reversed.
      const order = chart.labels.map((_, i) => i).reverse();
      const labels = order.map((i) => chart.labels[i]!);
      if (chart.low && chart.high) {
        const baseV = chart.base ?? 0;
        const lo = order.map((i) => Math.min(chart.low![i]!, chart.high![i]!));
        const hi = order.map((i) => Math.max(chart.low![i]!, chart.high![i]!));
        const isTornado = chart.base !== undefined;
        return {
          ...base,
          tooltip: { ...(base.tooltip as Option), trigger: 'item', formatter: (p: { dataIndex: number }) => { const k = p.dataIndex; const i = order[k]!; return `${chart.labels[i]}<br/>${f(chart.xFormat)(chart.values[i])} (${f(chart.xFormat)(lo[k])} to ${f(chart.xFormat)(hi[k])})`; } },
          grid: { left: 8, right: 16, top: isTornado ? 22 : 8, bottom: chart.xLabel ? 24 : 4, containLabel: true },
          yAxis: catAxis(labels, { axisLabel: { color: c.ink2, width: 140, overflow: 'truncate', interval: 0 } }),
          xAxis: valueAxis(chart.xFormat, { name: chart.xLabel, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: c.ink2 } }),
          // Each range is a thick line segment from low to high on its row, broken between rows, so
          // ranges either side of zero draw correctly (stacked bars cannot cross zero).
          series: [
            {
              type: 'line',
              name: 'Range',
              data: lo.flatMap((l, k) => [[l, k], [hi[k]!, k], '-']),
              symbol: 'none',
              connectNulls: false,
              lineStyle: { color: withAlpha(colors[0] ?? '#5fb3d0', isTornado ? 0.85 : 0.45), width: isTornado ? 14 : 4, cap: 'butt' },
              tooltip: { show: false },
              // The base (tornado) or zero (coefficients and intervals) as a reference line.
              markLine: { silent: true, symbol: 'none', data: [{ xAxis: baseV, name: isTornado ? 'Base' : '' }], lineStyle: { color: c.ink2, type: 'dashed', width: 1.5 }, label: { formatter: isTornado ? `Base ${f(chart.xFormat)(baseV)}` : '', color: c.ink2, fontSize: 11 } },
            },
            // A tornado's values are swings, not positions: hovering a bar reads them, nothing is drawn for them.
            { type: 'scatter', name: isTornado ? 'Swing' : 'Estimate', data: order.map((i, k) => [isTornado ? (lo[k]! + hi[k]!) / 2 : chart.values[i]!, k]), symbol: 'diamond', symbolSize: isTornado ? 0 : 10, itemStyle: { color: colors[0] } },
          ],
        };
      }
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: f(chart.xFormat) },
        grid: { left: 8, right: 16, top: 8, bottom: chart.xLabel ? 24 : 4, containLabel: true },
        yAxis: catAxis(labels, { axisLabel: { color: c.ink2, width: 140, overflow: 'truncate', interval: 0 } }),
        xAxis: valueAxis(chart.xFormat, { name: chart.xLabel, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: c.ink2 }, scale: false }),
        series: [{ type: 'bar', name: chart.xLabel ?? 'Value', data: order.map((i) => ({ value: chart.values[i]!, itemStyle: { color: chart.values[i]! < 0 ? c.bad : colors[0], borderRadius: 2 } })) }],
      };
    }

    case 'scatter': {
      const groups = chart.groups ?? [];
      const byGroup = groups.length ? groups.map((name, g) => ({ name, points: chart.points.filter((p) => (p.group ?? 0) === g) })) : [{ name: 'Points', points: chart.points }];
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'item', formatter: (p: { data: { name?: string; value: [number, number] } }) => `${p.data.name ? `${p.data.name}<br/>` : ''}${chart.xLabel}: ${f(chart.xFormat)(p.data.value[0])}<br/>${chart.yLabel}: ${f(chart.yFormat)(p.data.value[1])}` },
        legend: legend(byGroup.length),
        grid: { left: 30, right: 16, top: byGroup.length > 1 ? 28 : 12, bottom: 24, containLabel: true },
        xAxis: valueAxis(chart.xFormat, { name: chart.xLabel, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: c.ink2 } }),
        yAxis: valueAxis(chart.yFormat, { name: chart.yLabel, nameLocation: 'middle', nameRotate: 90, nameGap: 44, nameTextStyle: { color: c.ink2 } }),
        series: [
          ...byGroup.map((g, i) => ({ type: 'scatter', name: g.name, symbolSize: 9, data: g.points.map((p) => ({ name: p.label ?? '', value: [p.x, p.y], ...(p.tone ? { itemStyle: { color: tone(p.tone) } } : {}) })), itemStyle: { color: withAlpha(colors[i % colors.length] ?? '#5fb3d0', 0.85) } })),
          ...(chart.line ? [{ type: 'line', name: 'Fit', data: chart.line, symbol: 'none', lineStyle: { color: c.ink2, type: 'dashed', width: 1.5 }, tooltip: { show: false } }] : []),
        ],
      };
    }

    case 'curves': {
      const series: Option[] = [];
      chart.curves.forEach((cv, i) => {
        const color = colors[i % colors.length] ?? c.ink;
        const pts = (ys: number[]) => cv.x.map((x, j) => [x, ys[j] ?? null]);
        if (cv.lower && cv.upper) {
          series.push({ type: 'line', name: `${cv.name} lower`, data: pts(cv.lower), step: cv.step ? 'end' : undefined, symbol: 'none', lineStyle: { color, opacity: 0.35, type: 'dotted', width: 1 }, tooltip: { show: false } });
          series.push({ type: 'line', name: `${cv.name} upper`, data: pts(cv.upper), step: cv.step ? 'end' : undefined, symbol: 'none', lineStyle: { color, opacity: 0.35, type: 'dotted', width: 1 }, tooltip: { show: false } });
        }
        series.push({ type: 'line', name: cv.name, data: pts(cv.y), step: cv.step ? 'end' : undefined, symbol: 'none', smooth: !cv.step && cv.x.length > 2 ? 0.2 : false, lineStyle: { color, width: 2 }, itemStyle: { color } });
      });
      const yf = (n: number) => (chart.yPercent ? fmt(n, 'percent') : fmt(n));
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), valueFormatter: (n: number | null) => (n === null ? '–' : yf(n)) },
        legend: { ...(legend(chart.curves.length) ?? { show: false }), data: chart.curves.map((cv) => cv.name) },
        grid: { left: 30, right: 16, top: chart.curves.length > 1 ? 28 : 12, bottom: 24, containLabel: true },
        xAxis: { type: 'value', name: chart.xLabel, nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: c.ink2 }, splitLine: { lineStyle: { color: c.line } }, axisLabel: { color: c.ink3 } },
        yAxis: { type: 'value', name: chart.yLabel, nameLocation: 'middle', nameRotate: 90, nameGap: 44, nameTextStyle: { color: c.ink2 }, ...(chart.yPercent ? { min: 0, max: 1 } : {}), splitLine: { lineStyle: { color: c.line } }, axisLabel: { color: c.ink3, formatter: yf } },
        series,
      };
    }

    case 'matrix': {
      const data: Array<[number, number, number]> = [];
      chart.values.forEach((row, i) => row.forEach((v, j) => data.push([j, i, v])));
      const max = Math.max(1e-9, ...data.map((d) => d[2]));
      const vf = (n: number) => (chart.percent ? fmt(n, 'percent') : fmt(n));
      return {
        ...base,
        tooltip: { ...(base.tooltip as Option), trigger: 'item', formatter: (p: { value: [number, number, number] }) => `${chart.rows[p.value[1]]} → ${chart.cols[p.value[0]]}<br/>${vf(p.value[2])}` },
        grid: { left: 8, right: 12, top: 10, bottom: 24, containLabel: true },
        xAxis: catAxis(chart.cols, { name: 'to', nameLocation: 'middle', nameGap: 22, nameTextStyle: { color: c.ink3 }, axisLabel: { color: c.ink2, interval: 0, width: 80, overflow: 'truncate' } }),
        yAxis: catAxis(chart.rows, { inverse: true, name: 'from', nameTextStyle: { color: c.ink3 } }),
        visualMap: { show: false, min: 0, max, inRange: { color: [withAlpha(colors[0] ?? '#5fb3d0', 0.06), colors[0] ?? '#5fb3d0'] } },
        series: [{ type: 'heatmap', data, label: { show: chart.rows.length * chart.cols.length <= 100, color: c.ink, fontSize: 10, formatter: (p: { value: [number, number, number] }) => (p.value[2] ? vf(p.value[2]) : '') }, itemStyle: { borderColor: c.panel, borderWidth: 1 } }],
      };
    }
  }
}

// ECharts, imported piece by piece so the bundle carries only the charts Semaphore draws.

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { chartMotion } from '../lib/motion.ts';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, MarkLineComponent, SVGRenderer]);

export interface ChartClick {
  name: string;
  seriesName?: string;
  dataIndex: number;
}

/**
 * The parts of an option that decide how the chart is built rather than what it shows. When only
 * the data changes (a selection, a refresh) the chart is updated in place, not redrawn from scratch.
 */
function shapeOf(option: EChartsCoreOption): string {
  const o = option as { series?: Array<Record<string, unknown>>; xAxis?: unknown; yAxis?: unknown; legend?: unknown; color?: unknown };
  const axis = (a: unknown) => (Array.isArray(a) ? a : a ? [a] : []).map((x) => (x as { type?: string; inverse?: boolean }).type + String((x as { inverse?: boolean }).inverse ?? ''));
  return JSON.stringify([(o.series ?? []).map((s) => [s.type, s.name, s.stack, s.yAxisIndex, s.xAxisIndex]), axis(o.xAxis), axis(o.yAxis), !!o.legend, o.color]);
}

export function EChart({ option, onClick, label, describedBy }: { option: EChartsCoreOption; onClick?: (e: ChartClick) => void; label: string; describedBy?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const shape = useRef<string | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = echarts.init(el.current, undefined, { renderer: 'svg' });
    chart.current = c;
    c.on('click', (p) => click.current?.({ name: String((p as { name?: unknown }).name ?? ''), seriesName: (p as { seriesName?: string }).seriesName, dataIndex: (p as { dataIndex: number }).dataIndex }));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
      shape.current = null;
    };
  }, []);

  useEffect(() => {
    // A chart that cannot be drawn says so in its own card; it must never take the page down with it.
    const c = chart.current;
    if (!c) return;
    try {
      // Motion: none under reduced motion, otherwise at most 180 ms (UNIFIED-UI 7).
      const full = { ...option, ...chartMotion() };
      const next = shapeOf(full);
      if (shape.current === next) c.setOption(full, { replaceMerge: ['series'] });
      else c.setOption(full, { notMerge: true });
      shape.current = next;
      setFailed(null);
    } catch (e) {
      c.clear();
      shape.current = null;
      setFailed((e as Error).message);
    }
  }, [option]);

  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" role="img" aria-label={label} aria-describedby={describedBy} />
      {failed && <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-warn" title={failed}>This chart could not be drawn. Try another kind for it.</p>}
    </div>
  );
}

/**
 * Fallback series colours, in the same order as the skins' --series-n: red and green are never
 * neighbours (series 3 green, series 5 red, with purple between), for red-green colour blindness.
 */
const SERIES_FALLBACK = {
  dark: ['#5fb3d0', '#c9a66b', '#8fd18b', '#b39ddb', '#f07163', '#4db6ac', '#f0b429', '#e57fa8'],
  light: ['#1f6f8b', '#a8834a', '#2e7d4f', '#6a4fa3', '#c0392b', '#00796b', '#b7791f', '#ad1457'],
};

/** Colours read from the skin's tokens (--ink, --series-1..8 ...), so charts follow the skin and light or dark. */
export function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ink: v('--ink'),
    ink2: v('--ink-2'),
    ink3: v('--ink-3'),
    line: v('--line'),
    panel: v('--panel'),
    good: v('--good'),
    warn: v('--warn'),
    bad: v('--bad'),
    accent: v('--accent'),
    // Canvas colours: a skin's --series-n must be a plain colour (no color-mix), or the fallback is used.
    series: SERIES_FALLBACK[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'].map((fallback, i) => {
      const value = v(`--series-${i + 1}`);
      return value && !value.includes('(') ? value : fallback;
    }),
  };
}

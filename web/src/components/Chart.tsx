// ECharts, imported piece by piece so the bundle carries only the charts Semaphore draws.

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, MarkLineComponent, SVGRenderer]);

export interface ChartClick {
  name: string;
  seriesName?: string;
  dataIndex: number;
}

export function EChart({ option, onClick, label }: { option: EChartsCoreOption; onClick?: (e: ChartClick) => void; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;

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
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={el} className="h-full w-full" role="img" aria-label={label} />;
}

const SERIES_FALLBACK = {
  dark: ['#5fb3d0', '#c9a66b', '#8fd18b', '#f07163', '#b39ddb', '#f0b429', '#4db6ac', '#e57fa8'],
  light: ['#1f6f8b', '#a8834a', '#2e7d4f', '#c0392b', '#6a4fa3', '#b7791f', '#00796b', '#ad1457'],
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

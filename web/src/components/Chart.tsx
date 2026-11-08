// ECharts, imported piece by piece so the bundle carries only the charts Semaphore draws.

import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
// Direct paths, not the echarts/charts index: importing the index would carry chart-extras.ts into the page's start.
import 'echarts/lib/chart/bar';
import 'echarts/lib/chart/line';
import 'echarts/lib/chart/pie';
import 'echarts/lib/component/grid';
import 'echarts/lib/component/legend';
import 'echarts/lib/component/tooltip';
import 'echarts/lib/component/markLine';
import { SVGRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import type { Motion } from '../../../src/core/design.ts';
import { chartMotion } from '../lib/motion.ts';

echarts.use([SVGRenderer]);

let extras: Promise<unknown> | null = null;
let extrasReady = false;
/** Loads the forms in chart-extras.ts, once. */
function loadExtras(): Promise<unknown> {
  extras ??= import('./chart-extras.ts').then(() => {
    extrasReady = true;
  });
  return extras;
}

function needsExtras(option: EChartsCoreOption): boolean {
  const o = option as { series?: Array<{ type?: string }>; dataZoom?: unknown };
  return !!o.dataZoom || (o.series ?? []).some((s) => s.type === 'gauge' || s.type === 'funnel' || s.type === 'treemap');
}

export interface ChartClick {
  name: string;
  seriesName?: string;
  dataIndex: number;
  /** The mark's own value, when it carries one. */
  raw?: unknown;
}

/**
 * How each option is applied. Series, axes, zoom and legend are replaced outright, so a setting
 * that a look expresses by leaving a key out (an axis `max`, a floating `scale`) really goes away
 * when it is left out again; everything else (grid, tooltip, text) merges, so the chart updates in
 * place rather than being redrawn from scratch.
 */
export const APPLY_OPTION: { replaceMerge: string[] } = { replaceMerge: ['series', 'xAxis', 'yAxis', 'dataZoom', 'legend'] };

export function EChart({ option, onClick, label, describedBy, motion = 'calm' }: { option: EChartsCoreOption; onClick?: (e: ChartClick) => void; label: string; describedBy?: string; motion?: Motion }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const [failed, setFailed] = useState<string | null>(null);
  const hasExtras = useRef(false);

  // A chart keeps the steps that existed when it was made, so one made before chart-extras.ts loaded
  // has to be made again to draw those forms.
  const create = () => {
    const c = echarts.init(el.current!, undefined, { renderer: 'svg' });
    chart.current = c;
    hasExtras.current = extrasReady;
    c.on('click', (p) => click.current?.({ name: String((p as { name?: unknown }).name ?? ''), seriesName: (p as { seriesName?: string }).seriesName, dataIndex: (p as { dataIndex: number }).dataIndex, raw: ((p as { data?: { raw?: unknown } }).data ?? {}).raw }));
    return c;
  };

  useEffect(() => {
    if (!el.current) return;
    create();
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    // A chart that cannot be drawn says so in its own card; it must never take the page down with it.
    if (!chart.current) return;
    let live = true;
    const draw = () => {
    let c = chart.current!;
    if (needsExtras(option) && !hasExtras.current) {
      c.dispose();
      c = create();
    }
    try {
      // Motion: none under reduced motion, otherwise no mark moves for over 200 ms (UNIFIED-UI 7).
      c.setOption({ ...option, ...chartMotion(motion) }, APPLY_OPTION);
      setFailed(null);
    } catch (e) {
      c.clear();
      setFailed((e as Error).message);
    }
    };
    if (needsExtras(option) && !extrasReady) {
      loadExtras().then(() => live && draw(), (e: Error) => live && setFailed(e.message));
    } else draw();
    return () => {
      live = false;
    };
  }, [option, motion]);

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

/** The chart as an SVG document at a fixed size, drawn off the page and with no motion, for exports. */
export async function chartToSvg(option: EChartsCoreOption, width: number, height: number): Promise<string> {
  if (needsExtras(option)) await loadExtras();
  const c = echarts.init(null as unknown as HTMLElement, undefined, { renderer: 'svg', ssr: true, width, height });
  try {
    c.setOption({ ...option, animation: false });
    return c.renderToSVGString();
  } finally {
    c.dispose();
  }
}

/** Whether the page is light or dark now. */
export const themeMode = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/** Colours for paper: what an export uses whatever the screen's theme, since it is read on white. */
export function paperColors() {
  return { ink: '#17212b', ink2: '#3d4a56', ink3: '#5a6773', line: '#d6dce2', panel: '#ffffff', good: '#2e7d4f', warn: '#b7791f', bad: '#c0392b', accent: '#1f6f8b', series: [...SERIES_FALLBACK.light] };
}

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

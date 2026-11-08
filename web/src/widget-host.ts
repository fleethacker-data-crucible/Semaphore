// The inside of a custom widget's frame: web/sandbox/widget.html loads this bundle (built to
// dist/sandbox/widget-host.<hash>.js by web/build.mjs). It runs in <iframe sandbox="allow-scripts">
// with an opaque origin and its own CSP (server/Http.ps1 $script:SemSandboxCsp: no network, no
// storage of the page's, no way to the page's DOM). It holds no data until the page posts some.
//
// Page -> frame: render { code, css, data, theme }, ping { seq }, picture { seq }.
// Frame -> page: ready, pong { seq }, rendered, error { message, line }, select { key, value },
// picture { seq, url, width, height }. Each carries the nonce from this frame's URL (#n=<nonce>).
//
// ECharts is the full build, so a widget can draw any series; the page's own start never loads it.

import * as echarts from 'echarts';
import { formatNumber } from '../../src/core/describe.ts';
import { acceptHostMessage, errorLine, type FrameMessage, isNonce, type WidgetCell, type WidgetColumn, type WidgetData, type WidgetTheme } from '../../src/core/widget-protocol.ts';

type Outgoing = FrameMessage extends infer M ? (M extends { nonce: string } ? Omit<M, 'nonce'> : never) : never;

const nonce = /^#n=([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] ?? '';
const host = window.parent;

function post(m: Outgoing): void {
  // The page's origin cannot be named from an opaque origin's side, and nothing secret goes out:
  // render errors, a selected value and a picture of the widget. frame-ancestors 'self' keeps any
  // other page from embedding this one.
  host.postMessage({ ...m, nonce }, '*');
}

// The code is wrapped in a function so `render` and the analyst's top-level names stay local. The
// lines the wrapper adds before the code are measured once, so error lines point at the editor's.
const HEAD = '"use strict";\n';
const TAIL = '\n;return typeof render === "function" ? render : null;';
type Render = (api: WidgetApi) => unknown;
function compile(code: string): (lib: typeof echarts) => Render | null {
  // eslint-disable-next-line no-new-func
  return new Function('echarts', HEAD + code + TAIL) as (lib: typeof echarts) => Render | null;
}
const OFFSET = (() => {
  try {
    // eslint-disable-next-line no-new-func
    new Function('echarts', HEAD + 'throw new Error("line")')();
  } catch (e) {
    const at = errorLine((e as Error).stack, 0);
    if (at) return at - 1;
  }
  return 2;
})();

interface WidgetApi {
  data: WidgetData;
  el: HTMLElement;
  echarts: typeof echarts;
  theme: WidgetTheme;
  readonly size: { width: number; height: number };
  chart(): echarts.ECharts;
  select(key: string, value: WidgetCell): void;
  format(n: unknown, format?: string): string;
  label(value: unknown, column?: WidgetColumn): string;
  onResize(fn: () => void): void;
}

const charts = new Set<echarts.ECharts>();
const resizers = new Set<() => void>();
let cleanup: (() => void) | null = null;
let compiled: { code: string; render: Render | null } | null = null;
let theme: WidgetTheme | null = null;
let el: HTMLElement | null = null;

// Charts a widget makes with echarts.init are tracked, so they resize with the frame and are
// disposed before the next render.
const library: typeof echarts = Object.freeze({
  ...echarts,
  init: ((dom: HTMLElement, t?: string | object | null, opts?: echarts.EChartsInitOpts) => {
    const c = echarts.init(dom, t ?? null, { renderer: 'svg', ...(opts ?? {}) });
    charts.add(c);
    return c;
  }) as typeof echarts.init,
});

function message(e: unknown): string {
  if (e instanceof Error) return `${e.name === 'Error' ? '' : `${e.name}: `}${e.message}`;
  return String(e);
}

function fail(e: unknown): void {
  const line = e instanceof Error ? errorLine(e.stack, OFFSET) : undefined;
  post({ type: 'error', message: message(e).slice(0, 500), ...(line ? { line } : {}) });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** As the page shows a field value (web/src/lib/chart-option.ts formatDim). */
function label(v: unknown, column?: WidgetColumn): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const grain = column?.grain;
  const s = String(v);
  if (!grain) return s;
  const y = s.slice(0, 4);
  const m = Number(s.slice(5, 7));
  if (grain === 'year') return y;
  if (grain === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === 'month') return `${MONTHS[m - 1] ?? ''} ${y}`;
  if (grain === 'week') return `Wk of ${s.slice(5, 10)}`;
  return s.slice(0, 10);
}

function applyTheme(t: WidgetTheme, css: string): void {
  theme = t;
  const root = document.documentElement.style;
  const vars: Record<string, string> = { '--ink': t.ink, '--ink-2': t.ink2, '--ink-3': t.ink3, '--panel': t.panel, '--line': t.line, '--accent': t.accent, '--good': t.good, '--warn': t.warn, '--bad': t.bad, '--font': t.font };
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, String(v));
  t.colors.forEach((c, i) => root.setProperty(`--series-${i + 1}`, String(c)));
  root.colorScheme = t.dark ? 'dark' : 'light';
  let style = document.getElementById('widget-css') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'widget-css';
    document.head.appendChild(style);
  }
  style.textContent = css;
}

function teardown(): void {
  try {
    cleanup?.();
  } catch (e) {
    fail(e);
  }
  cleanup = null;
  for (const c of charts) c.dispose();
  charts.clear();
  resizers.clear();
  el = document.createElement('div');
  el.id = 'widget';
  document.body.replaceChildren(el);
}

// A widget that selects in a loop must not flood the page: ten in five seconds at most.
const selects: number[] = [];
function select(key: unknown, value: unknown): void {
  if (typeof key !== 'string') throw new TypeError('api.select(key, value): key is a column key, from api.data.columns.');
  const ok = value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (!ok) throw new TypeError('api.select(key, value): value is a text, a number, true/false or null.');
  const now = Date.now();
  while (selects.length && now - selects[0]! > 5000) selects.shift();
  if (selects.length >= 10) return;
  selects.push(now);
  post({ type: 'select', key, value: value as WidgetCell });
}

function makeApi(data: WidgetData, t: WidgetTheme, target: HTMLElement): WidgetApi {
  let main: echarts.ECharts | null = null;
  return {
    data,
    el: target,
    echarts: library,
    theme: t,
    get size() {
      return { width: target.clientWidth, height: target.clientHeight };
    },
    chart() {
      main ??= library.init(target);
      return main;
    },
    select,
    format: (n, f) => formatNumber(typeof n === 'number' ? n : n === null || n === undefined || n === '' ? null : Number(n), f === 'currency' || f === 'percent' || f === 'number' ? f : undefined),
    label,
    onResize: (fn) => {
      if (typeof fn === 'function') resizers.add(fn);
    },
  };
}

function run(code: string, css: string, data: WidgetData, t: WidgetTheme): void {
  applyTheme(t, css);
  teardown();
  try {
    if (!compiled || compiled.code !== code) {
      compiled = null;
      compiled = { code, render: compile(code)(library) };
    }
    if (!compiled.render) throw new Error('Define a function render(api) that draws the widget.');
    const out = compiled.render(makeApi(data, t, el!));
    if (typeof out === 'function') cleanup = out as () => void;
    if (out && typeof (out as Promise<unknown>).then === 'function') {
      (out as Promise<unknown>).then(
        () => post({ type: 'rendered' }),
        (e) => fail(e),
      );
      return;
    }
    post({ type: 'rendered' });
  } catch (e) {
    fail(e);
  }
}

function picture(seq: number): void {
  const first = [...charts][0];
  try {
    if (first) {
      const url = first.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme?.panel ?? '#ffffff' });
      post({ type: 'picture', seq, url, width: first.getWidth(), height: first.getHeight() });
      return;
    }
    const svg = el?.querySelector('svg');
    if (svg) {
      const box = svg.getBoundingClientRect();
      const text = new XMLSerializer().serializeToString(svg);
      post({ type: 'picture', seq, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, width: box.width, height: box.height });
      return;
    }
  } catch {
    /* no picture: the export carries the table alone */
  }
  post({ type: 'picture', seq, url: null, width: 0, height: 0 });
}

if (isNonce(nonce) && host !== window) {
  const base = document.createElement('style');
  base.textContent = 'html,body{margin:0;height:100%;overflow:hidden;background:var(--panel);color:var(--ink);font:12px/1.4 var(--font,system-ui,sans-serif)}#widget{width:100%;height:100%;overflow:auto}';
  document.head.appendChild(base);
  window.addEventListener('message', (e) => {
    const m = acceptHostMessage(e, host, nonce);
    if (!m) return;
    if (m.type === 'ping') post({ type: 'pong', seq: m.seq });
    else if (m.type === 'picture') picture(m.seq);
    else run(m.code, m.css, m.data, m.theme);
  });
  // Errors after render (a click handler, a timer) are the widget's too.
  window.addEventListener('error', (e) => fail(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => fail(e.reason));
  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const c of charts) c.resize();
      for (const fn of resizers) {
        try {
          fn();
        } catch (e) {
          fail(e);
        }
      }
    });
  }).observe(document.documentElement);
  teardown();
  post({ type: 'ready' });
}

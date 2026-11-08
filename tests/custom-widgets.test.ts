// Custom chart widgets: the flag's widget is parsed and capped, library entries are checked, every
// message between the page and a sandboxed frame is validated, the data handed to a widget is plain,
// and the three starter templates draw on fleet data (run here against a stub chart).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFlagDraft } from '../src/core/intelligence/index.ts';
import { fitShape } from '../src/core/intelligence/contract.ts';
import { DEFAULT_SIZE } from '../src/core/layout.ts';
import { emptyBehavior, FLAG_KINDS, type Flag, parseHoist } from '../src/core/hoist.ts';
import { parseWidget, sanitizeWidgetName, utf8Bytes, WIDGET_LIMITS } from '../src/core/widget.ts';
import { parseLibraryWidget, widgetIdFor } from '../src/core/widget-library.ts';
import { acceptFrameMessage, acceptHostMessage, errorLine, isNonce, newNonce, selectAllowed, type WidgetColumn, type WidgetData, type WidgetTheme } from '../src/core/widget-protocol.ts';
import type { FlagResult } from '../web/src/lib/data.ts';
import { widgetData, widgetTheme } from '../web/src/lib/widget-data.ts';
import { STARTER_CODE, WIDGET_TEMPLATES } from '../web/src/lib/widget-templates.ts';
import { finishStart, queueStart, reportSandboxStall, SANDBOX_REST_MS, sandboxRestLeft, setRendering, stallCulprit } from '../web/src/lib/widget-bus.ts';
import { applyKit, makeKit, parseKit } from '../src/core/kits.ts';
import { loadIndex } from './fixtures.ts';

const customFlag = (widget: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  kind: 'custom',
  title: 'Mine',
  brief: '',
  layout: { x: 0, y: 0, w: 6, h: 5 },
  binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] },
  behavior: { onClick: 'filter-page', ignore: [], thresholds: [] },
  status: 'ready',
  notes: [],
  widget,
  ...extra,
});
const hoistWith = (...flags: unknown[]) => ({ version: 1, id: 'h', title: 'H', brief: '', grid: { cols: 12 }, filters: [], flags, updated: '2026-11-08T00:00:00.000Z' });

test('custom is a flag kind with a default size', () => {
  assert.ok(FLAG_KINDS.includes('custom'));
  assert.deepEqual(DEFAULT_SIZE.custom, { w: 6, h: 5 });
});

test('a saved custom flag keeps its code, CSS, library id and name', () => {
  const { hoist, warnings } = parseHoist(hoistWith(customFlag({ code: 'function render(api) {}', css: '.a{}', libraryId: 'fleet-bullet', name: '  Fleet\nbullet  ' })), loadIndex());
  assert.deepEqual(warnings, []);
  assert.deepEqual(hoist!.flags[0]!.widget, { code: 'function render(api) {}', css: '.a{}', libraryId: 'fleet-bullet', name: 'Fleet bullet' });
});

test('code over 64 KB drops the widget with a warning; it is never cut to half a program', () => {
  const big = 'x'.repeat(WIDGET_LIMITS.codeBytes + 1);
  const { hoist, warnings } = parseHoist(hoistWith(customFlag({ code: big })), loadIndex());
  assert.equal(hoist!.flags[0]!.widget, undefined);
  assert.match(warnings.join(' '), /code is over 64 KB, removed/);
  // Bytes, not characters: 32 769 two-byte characters are over the cap.
  assert.equal(parseWidget({ code: 'é'.repeat(32769) }, [], 'F'), undefined);
  assert.ok(parseWidget({ code: 'é'.repeat(32768) }, [], 'F'));
});

test('CSS over 16 KB, a bad library id and a non-string code are refused one by one', () => {
  const w: string[] = [];
  assert.deepEqual(parseWidget({ code: 'a', css: 'y'.repeat(WIDGET_LIMITS.cssBytes + 1), libraryId: '../etc' }, w, 'F'), { code: 'a' });
  assert.match(w.join(' '), /CSS is over 16 KB/);
  assert.match(w.join(' '), /library id is not valid/);
  assert.equal(parseWidget({ code: 42 }, w, 'F'), undefined);
  assert.equal(parseWidget('function render() {}', w, 'F'), undefined);
  assert.equal(parseWidget(undefined, w, 'F'), undefined);
});

test('only custom flags carry a widget', () => {
  const { hoist } = parseHoist(hoistWith({ ...customFlag({ code: 'x' }), kind: 'bar' }), loadIndex());
  assert.equal(hoist!.flags[0]!.widget, undefined);
});

test('a flag kit carries the code of a custom flag to another page', () => {
  const index = loadIndex();
  const widget = { code: 'function render(api) { api.el.textContent = 1; }', css: '.a{}', libraryId: 'fleet-bullet', name: 'Fleet bullet' };
  const { hoist } = parseHoist(hoistWith(customFlag(widget)), index);
  const { kit } = makeKit(hoist!, index, { name: 'Widgets', now: new Date('2026-11-08T00:00:00Z') });
  assert.deepEqual(kit!.flags[0]!.widget, widget);
  const parsed = parseKit(JSON.parse(JSON.stringify(kit)));
  assert.deepEqual(parsed.errors, []);
  const blank = { version: 1 as const, id: 't', title: 'T', brief: '', grid: { cols: 12 }, filters: [], flags: [], updated: '2026-11-08T00:00:00.000Z' };
  const out = applyKit(parsed.kit!, blank, index, {}).hoist;
  assert.deepEqual(out.flags[0]!.widget, widget);
  assert.equal(out.flags[0]!.kind, 'custom');
  // Code over the cap makes the kit invalid, as any malformed part does.
  const big = JSON.parse(JSON.stringify(kit));
  big.flags[0].widget.code = 'x'.repeat(WIDGET_LIMITS.codeBytes + 1);
  assert.match(parseKit(big).errors.join(' '), /over 64 KB/);
});

test('names are cleaned of control and line-separator characters and capped at 80; ids follow the server rule', () => {
  assert.equal(sanitizeWidgetName('  A\u0000b\u2028c\td  '), 'A b c d');
  assert.equal(sanitizeWidgetName('n'.repeat(200)).length, 80);
  assert.equal(sanitizeWidgetName(42), '');
  assert.equal(widgetIdFor('Fleet bullet (v2)!'), 'fleet-bullet-v2');
  assert.equal(widgetIdFor('***'), 'widget');
  assert.equal(widgetIdFor('a'.repeat(100)).length, 48);
  assert.equal(utf8Bytes('é'), 2);
});

test('a library entry needs an id, a name and code, within the caps', () => {
  const ok = parseLibraryWidget({ version: 1, id: 'fleet-bullet', name: 'Fleet bullet', code: 'function render(api) {}', css: '', by: 'anthony', updated: '2026-11-08T00:00:00.000Z', description: 'd' });
  assert.equal(ok?.name, 'Fleet bullet');
  const problems: string[] = [];
  assert.equal(parseLibraryWidget({ id: 'a b', name: '', code: '' }, problems), null);
  assert.equal(problems.length, 3);
  assert.equal(parseLibraryWidget({ id: 'x', name: 'X', code: 'y'.repeat(WIDGET_LIMITS.codeBytes + 1) }), null);
  assert.equal(parseLibraryWidget([1, 2]), null);
});

test('drafting a custom flag fills in its data but keeps its kind and its click behaviour', () => {
  const flag: Flag = { id: 'c', kind: 'custom', title: '', brief: 'cost by region', layout: { x: 0, y: 0, w: 6, h: 5 }, binding: null, behavior: { ...emptyBehavior(), onClick: 'filter-page' }, status: 'empty', notes: [] };
  const drafted = applyFlagDraft(flag, { kind: 'bar', title: 'Labor cost by region', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] }, behavior: emptyBehavior(), confidence: 0.8, notes: [] });
  assert.equal(drafted.kind, 'custom');
  assert.equal(drafted.behavior.onClick, 'filter-page');
  assert.equal(drafted.status, 'drafted');
  // Fields are kept as asked: no metric, three fields is fine for a timeline.
  const shaped = fitShape('custom', { metrics: [], dimensions: [{ field: 'jobs.hull' }, { field: 'jobs.opened', grain: 'day' }, { field: 'jobs.status' }], filters: [] }, emptyBehavior());
  assert.equal(shaped.kind, 'custom');
  assert.equal(shaped.binding!.dimensions.length, 3);
});

// ---------------------------------------------------------------------------------------------
// Messages

const win = { name: 'the frame window' };
const nonce = 'abcdefghijklmnop0123';
const frame = { window: win, nonce };
const ev = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({ origin: 'null', source: win, data, ...over });

test('the page takes a message only from its own frame window, from the opaque origin, with the nonce', () => {
  assert.deepEqual(acceptFrameMessage(ev({ type: 'ready', nonce }), frame), { type: 'ready', nonce });
  assert.equal(acceptFrameMessage(ev({ type: 'ready', nonce }, { origin: 'http://127.0.0.1:8800' }), frame), null, 'a same-origin sender is not the sandbox');
  assert.equal(acceptFrameMessage(ev({ type: 'ready', nonce }, { origin: 'http://evil.example' }), frame), null);
  assert.equal(acceptFrameMessage(ev({ type: 'ready', nonce }, { source: { other: true } }), frame), null, 'another window');
  assert.equal(acceptFrameMessage(ev({ type: 'ready', nonce }, { source: null }), frame), null);
  assert.equal(acceptFrameMessage(ev({ type: 'ready', nonce: 'wrong-nonce-0000000' }), frame), null);
  assert.equal(acceptFrameMessage(ev({ type: 'ready' }), frame), null);
  assert.equal(acceptFrameMessage(ev({ type: 'eval', nonce, code: 'x' }), frame), null, 'unknown types are ignored');
  assert.equal(acceptFrameMessage(ev([{ type: 'ready', nonce }]), frame), null);
  assert.equal(acceptFrameMessage(ev('ready'), frame), null);
});

test('frame messages are checked field by field', () => {
  assert.deepEqual(acceptFrameMessage(ev({ type: 'pong', nonce, seq: 3 }), frame), { type: 'pong', nonce, seq: 3 });
  assert.equal(acceptFrameMessage(ev({ type: 'pong', nonce, seq: -1 }), frame), null);
  const err = acceptFrameMessage(ev({ type: 'error', nonce, message: 'x'.repeat(5000), line: 7 }), frame);
  assert.equal(err?.type === 'error' && err.message.length, WIDGET_LIMITS.errorChars);
  assert.equal(err?.type === 'error' && err.line, 7);
  const noLine = acceptFrameMessage(ev({ type: 'error', nonce, message: 'm', line: 1.5 }), frame);
  assert.deepEqual(noLine, { type: 'error', nonce, message: 'm' });
  assert.deepEqual(acceptFrameMessage(ev({ type: 'select', nonce, key: 'jobs.region', value: 'Gulf' }), frame), { type: 'select', nonce, key: 'jobs.region', value: 'Gulf' });
  for (const value of [{ a: 1 }, ['Gulf'], Number.NaN, Infinity, 'v'.repeat(WIDGET_LIMITS.valueChars + 1), undefined]) {
    assert.equal(acceptFrameMessage(ev({ type: 'select', nonce, key: 'jobs.region', value }), frame), null, String(value));
  }
  assert.equal(acceptFrameMessage(ev({ type: 'select', nonce, key: '', value: 1 }), frame), null);
  const pic = acceptFrameMessage(ev({ type: 'picture', nonce, seq: 1, url: 'data:image/png;base64,AAAA', width: 300.4, height: 200 }), frame);
  assert.deepEqual(pic, { type: 'picture', nonce, seq: 1, url: 'data:image/png;base64,AAAA', width: 300, height: 200 });
  const notImage = acceptFrameMessage(ev({ type: 'picture', nonce, seq: 1, url: 'https://evil.example/x.png', width: 1, height: 1 }), frame);
  assert.equal(notImage?.type === 'picture' && notImage.url, null, 'only a data: image is taken as a picture');
  const html = acceptFrameMessage(ev({ type: 'picture', nonce, seq: 1, url: 'data:text/html,<script>', width: 1, height: 1 }), frame);
  assert.equal(html?.type === 'picture' && html.url, null);
});

test('a select() reaches the page only for one of the flag\'s own fields', () => {
  const columns: WidgetColumn[] = [
    { key: 'jobs.region', label: 'Region', type: 'string', role: 'dimension' },
    { key: 'labor_cost', label: 'Labor cost', type: 'number', role: 'measure' },
  ];
  assert.ok(selectAllowed('jobs.region', columns));
  assert.equal(selectAllowed('labor_cost', columns), false, 'a measure is not a selection');
  assert.equal(selectAllowed('jobs.ship_class', columns), false, 'a field the widget was not given');
});

const theme: WidgetTheme = { colors: ['#1f6f8b'], ink: '#111', ink2: '#333', ink3: '#666', panel: '#fff', line: '#ddd', accent: '#1f6f8b', good: '#2e7d4f', warn: '#b7791f', bad: '#c0392b', font: 'system-ui', dark: false };
const emptyData: WidgetData = { columns: [], rows: [], selections: {}, truncated: false };

test('the frame takes messages only from its parent, with its nonce', () => {
  const parent = { name: 'page' };
  assert.deepEqual(acceptHostMessage({ source: parent, data: { type: 'ping', nonce, seq: 2 } }, parent, nonce), { type: 'ping', nonce, seq: 2 });
  assert.equal(acceptHostMessage({ source: { name: 'other' }, data: { type: 'ping', nonce, seq: 2 } }, parent, nonce), null);
  assert.equal(acceptHostMessage({ source: parent, data: { type: 'ping', nonce: 'x', seq: 2 } }, parent, nonce), null);
  const render = acceptHostMessage({ source: parent, data: { type: 'render', nonce, code: 'function render(){}', css: 5, data: emptyData, theme } }, parent, nonce);
  assert.equal(render?.type === 'render' && render.css, '', 'CSS that is not text is dropped');
  assert.equal(acceptHostMessage({ source: parent, data: { type: 'render', nonce, code: 'x'.repeat(WIDGET_LIMITS.codeBytes + 1), data: emptyData, theme } }, parent, nonce), null);
  assert.equal(acceptHostMessage({ source: parent, data: { type: 'render', nonce, code: 'x', data: {}, theme } }, parent, nonce), null);
});

test('a stalled frame rests every widget frame on the page, and later stalls extend the rest', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(sandboxRestLeft(t0), 0);
  reportSandboxStall(t0);
  assert.equal(sandboxRestLeft(t0), SANDBOX_REST_MS);
  assert.equal(sandboxRestLeft(t0 + 5000), SANDBOX_REST_MS - 5000);
  reportSandboxStall(t0 + 5000);
  assert.equal(sandboxRestLeft(t0 + 5000), SANDBOX_REST_MS);
  assert.equal(sandboxRestLeft(t0 + 5000 + SANDBOX_REST_MS + 1), 0);
});

test('a stall is pinned on the one widget that was drawing; with two drawing, nobody is blamed', () => {
  setRendering('a', true);
  setRendering('b', true);
  setRendering('a', false);
  reportSandboxStall();
  assert.equal(stallCulprit(), 'b');
  setRendering('a', true);
  setRendering('b', true);
  reportSandboxStall();
  assert.equal(stallCulprit(), null);
  reportSandboxStall();
  assert.equal(stallCulprit(), null, 'the drawing set is cleared at each stall');
});

test('after a stall widgets start one at a time: the next starts when the first has answered', () => {
  const started: string[] = [];
  queueStart('one', () => started.push('one'));
  queueStart('two', () => started.push('two'));
  const withdraw = queueStart('three', () => started.push('three'));
  assert.deepEqual(started, ['one']);
  finishStart('two');
  assert.deepEqual(started, ['one'], 'only the widget holding the turn can pass it on');
  finishStart('one');
  assert.deepEqual(started, ['one', 'two']);
  withdraw();
  finishStart('two');
  assert.deepEqual(started, ['one', 'two'], 'a withdrawn request never starts');
});

test('nonces are 128 random bits in base64url, different each time', () => {
  const a = newNonce();
  assert.ok(isNonce(a), a);
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, newNonce());
  assert.equal(isNonce('short'), false);
});

test('an error line is read from the evaluated code\'s stack frame, less the wrapper\'s lines', () => {
  const chromium = 'TypeError: Cannot read properties of undefined\n    at render (eval at compile (http://127.0.0.1:8800/sandbox/widget-host.abcdef1234.js:1:5000), <anonymous>:5:20)\n    at run (http://127.0.0.1:8800/sandbox/widget-host.abcdef1234.js:1:6000)';
  assert.equal(errorLine(chromium, 2), 3);
  assert.equal(errorLine('Error: x\n    at Function:9:1', 2), 7);
  assert.equal(errorLine('SecurityError: Blocked a frame with origin "null"', 2), undefined, 'no stack frames, no line');
  assert.equal(errorLine(undefined, 2), undefined);
  // The widget's code is loaded as a blob: script now; its frames name the blob URL.
  const blobStack = ['TypeError: x is undefined', '    at render (blob:null/6f1c9a2e-0b7d-4f3e-9a1b-2c3d4e5f6a7b:7:12)', '    at run (https://localhost/sandbox/widget-host.js:1:900)'].join('\n');
  assert.equal(errorLine(blobStack, 2), 5);
  assert.equal(errorLine('at blob:null/abc:2:1', 2), undefined, "a line inside the wrapper is not the analyst's");
  assert.equal(errorLine('at <anonymous>:1:1', 2), undefined, 'a line inside the wrapper is not the analyst\'s');
});

// ---------------------------------------------------------------------------------------------
// What the widget is given

const index = loadIndex();
function fakeResult(dims: Array<{ key: string; field: string; grain?: 'day' | 'month' }>, metrics: string[], rows: Array<{ dims: Record<string, string | null>; values: Record<string, number | null> }>, truncated = false): FlagResult {
  return {
    plan: { dimensions: dims.map((d, i) => ({ alias: `d${i}`, ...d })), own: dims.map((d) => d.key), metrics: metrics.map((key) => ({ key, agg: 'sum', parts: {} })) },
    display: { rows, applied: [], live: [], truncated, totals: {} },
    sql: null,
    origin: 'page',
    ms: 1,
    requeried: [],
  } as unknown as FlagResult;
}

test('a widget gets plain columns and rows, with labels, types, formats and its own selections only', () => {
  const result = fakeResult([{ key: 'jobs.region', field: 'jobs.region' }, { key: 'jobs.opened@month', field: 'jobs.opened', grain: 'month' }], ['labor_cost'], [{ dims: { 'jobs.region': 'Gulf', 'jobs.opened@month': '2026-01-01' }, values: { labor_cost: 1200 } }, { dims: { 'jobs.region': 'Pacific', 'jobs.opened@month': '2026-01-01' }, values: { labor_cost: Number.NaN } }], true);
  const d = widgetData(result, index, { 'jobs.region': ['Gulf'], 'jobs.ship_class': ['DDG'] });
  assert.deepEqual(d.columns, [
    { key: 'jobs.region', label: 'Region', type: 'string', role: 'dimension' },
    { key: 'jobs.opened@month', label: 'Opened date (month)', type: 'date', role: 'dimension', grain: 'month' },
    { key: 'labor_cost', label: 'Labor cost', type: 'number', role: 'measure', format: 'currency' },
  ]);
  assert.deepEqual(d.rows, [
    { 'jobs.region': 'Gulf', 'jobs.opened@month': '2026-01-01', labor_cost: 1200 },
    { 'jobs.region': 'Pacific', 'jobs.opened@month': '2026-01-01', labor_cost: null },
  ]);
  assert.deepEqual(d.selections, { 'jobs.region': ['Gulf'] }, 'a selection on a field the flag does not show stays on the page');
  assert.equal(d.truncated, true);
  // Nothing else crosses: no SQL, no plan, no source.
  assert.deepEqual(Object.keys(d).sort(), ['columns', 'rows', 'selections', 'truncated']);
  assert.deepEqual(widgetData(undefined, index, {}), emptyData);
  assert.deepEqual(widgetTheme({ ink: 'a', ink2: 'b', ink3: 'c', line: 'd', panel: 'e', accent: 'f', good: 'g', warn: 'h', bad: 'i' }, ['#1', '#2'], 'serif', true).colors, ['#1', '#2']);
});

// ---------------------------------------------------------------------------------------------
// The starter templates, run against a stub chart

interface Run {
  options: Array<Record<string, unknown>>;
  html: string;
  selects: Array<[string, unknown]>;
  clicks: Array<(p: unknown) => void>;
  resizers: Array<() => void>;
}
function runWidget(code: string, data: WidgetData): Run {
  const run: Run = { options: [], html: '', selects: [], clicks: [], resizers: [] };
  const chart = { setOption: (o: Record<string, unknown>) => void run.options.push(o), on: (_e: string, fn: (p: unknown) => void) => void run.clicks.push(fn) };
  const el = {
    set innerHTML(v: string) {
      run.html = v;
    },
    get innerHTML() {
      return run.html;
    },
  };
  const api = {
    data,
    el,
    echarts: { graphic: { clipRectByRect: (a: unknown) => a } },
    theme,
    size: { width: 600, height: 300 },
    chart: () => chart,
    select: (k: string, v: unknown) => void run.selects.push([k, v]),
    format: (n: unknown) => String(n),
    label: (v: unknown) => String(v),
    onResize: (fn: () => void) => void run.resizers.push(fn),
  };
  // The frame wraps the code the same way (web/src/widget-host.ts).
  const render = new Function('echarts', `"use strict";\n${code}\n;return typeof render === "function" ? render : null;`)(api.echarts) as (a: typeof api) => unknown;
  render(api);
  return run;
}
const col = (key: string, type: WidgetColumn['type'], role: WidgetColumn['role'], extra: Partial<WidgetColumn> = {}): WidgetColumn => ({ key, label: key, type, role, ...extra });
const template = (id: string) => WIDGET_TEMPLATES.find((t) => t.id === id)!.code;

test('there are three starter templates, each with code under the cap', () => {
  assert.deepEqual(WIDGET_TEMPLATES.map((t) => t.name), ['Bullet chart', 'Gantt timeline', 'Small multiples']);
  for (const t of WIDGET_TEMPLATES) assert.ok(utf8Bytes(t.code) < WIDGET_LIMITS.codeBytes / 4, t.id);
});

test('Bullet chart: actual against the fleet average, banded, and a click selects the region', () => {
  const data: WidgetData = {
    columns: [col('jobs.region', 'string', 'dimension'), col('labor_cost', 'number', 'measure', { format: 'currency' })],
    rows: [
      { 'jobs.region': 'Gulf', labor_cost: 300 },
      { 'jobs.region': 'Pacific', labor_cost: 100 },
      { 'jobs.region': 'Atlantic', labor_cost: 200 },
    ],
    selections: {},
    truncated: false,
  };
  const r = runWidget(template('bullet'), data);
  const o = r.options[0] as { series: Array<{ name: string; type: string; data: unknown[] }> };
  assert.equal(o.series.length, 5, 'three bands, the actual bar and the target mark');
  const target = o.series.find((s) => s.name === 'Target')!;
  // No second measure and no TARGET: the target is the average, 200, for every row.
  assert.deepEqual(target.data.map((d) => (d as number[])[0]), [200, 200, 200]);
  // Rows are reversed so the first is at the top; Atlantic (100% of target) is good, Pacific (50%) poor.
  const actual = o.series.find((s) => s.name === 'labor_cost')!.data as Array<{ value: number; itemStyle: { color: string } }>;
  assert.deepEqual(actual.map((a) => a.value), [200, 100, 300]);
  assert.deepEqual(actual.map((a) => a.itemStyle.color), [theme.good, theme.bad, theme.good]);
  r.clicks[0]!({ dataIndex: 1 });
  assert.deepEqual(r.selects, [['jobs.region', 'Pacific']]);
});

test('Bullet chart: a second measure is the target; with no measure it says what it needs', () => {
  const data: WidgetData = { columns: [col('jobs.ship_class', 'string', 'dimension'), col('labor_cost', 'number', 'measure'), col('budget', 'number', 'measure')], rows: [{ 'jobs.ship_class': 'DDG', labor_cost: 80, budget: 100 }], selections: {}, truncated: false };
  const o = runWidget(template('bullet'), data).options[0] as { series: Array<{ name: string; data: unknown[] }> };
  assert.deepEqual((o.series.find((s) => s.name === 'Target')!.data[0] as number[])[0], 100);
  assert.match(runWidget(template('bullet'), emptyData).html, /needs one field and one or two measures/);
});

test('Gantt timeline: bars from the opened date for the days open, one line per hull, a click selects the hull', () => {
  const data: WidgetData = {
    columns: [col('jobs.hull', 'string', 'dimension'), col('jobs.opened@day', 'date', 'dimension', { grain: 'day' }), col('avg_days_open', 'number', 'measure')],
    rows: [
      { 'jobs.hull': 'DDG-51', 'jobs.opened@day': '2026-03-01', avg_days_open: 10 },
      { 'jobs.hull': 'LHD-1', 'jobs.opened@day': '2026-02-01', avg_days_open: 30 },
      { 'jobs.hull': 'DDG-51', 'jobs.opened@day': '2026-04-01', avg_days_open: null },
    ],
    selections: {},
    truncated: false,
  };
  const r = runWidget(template('gantt'), data);
  const o = r.options[0] as { yAxis: { data: string[] }; series: Array<{ type: string; data: Array<{ value: number[] }> }> };
  assert.deepEqual(o.yAxis.data, ['LHD-1', 'DDG-51'], 'items in order of their first start');
  const bars = o.series[0]!.data.map((d) => d.value);
  assert.equal(o.series[0]!.type, 'custom');
  const day = 86400000;
  assert.deepEqual(bars[0]!.slice(1, 3), [Date.parse('2026-02-01T00:00:00Z'), Date.parse('2026-02-01T00:00:00Z') + 30 * day]);
  for (const b of bars) assert.ok(b[2]! > b[1]!, 'every bar has some length');
  r.clicks[0]!({ value: [0, 0, 0, 0] });
  assert.deepEqual(r.selects, [['jobs.hull', 'LHD-1']]);
  assert.match(runWidget(template('gantt'), { ...data, columns: [col('jobs.hull', 'string', 'dimension')] }).html, /needs an item field, a start date/);
});

test('Small multiples: one panel per region on one scale, laid out to the frame, a click selects the panel', () => {
  const months = ['2026-01-01', '2026-02-01', '2026-03-01'];
  const regions = ['Gulf', 'Pacific', 'Atlantic', 'Great Lakes'];
  const rows = regions.flatMap((reg, i) => months.map((m, j) => ({ 'jobs.opened@month': m, 'jobs.region': reg, work_orders: (i + 1) * 10 + j })));
  const data: WidgetData = { columns: [col('jobs.opened@month', 'date', 'dimension', { grain: 'month' }), col('jobs.region', 'string', 'dimension'), col('work_orders', 'number', 'measure')], rows, selections: { 'jobs.region': ['Gulf'] }, truncated: false };
  const r = runWidget(template('multiples'), data);
  const o = r.options[0] as { grid: unknown[]; title: Array<{ text: string }>; yAxis: Array<{ max: number }>; series: Array<{ data: Array<number | null>; itemStyle: { opacity: number } }> };
  assert.equal(o.grid.length, 4);
  assert.deepEqual(o.title.map((t) => t.text), ['Great Lakes', 'Atlantic', 'Pacific', 'Gulf'], 'the biggest first');
  assert.ok(o.yAxis.every((y) => y.max === 42), 'one scale for every panel');
  assert.deepEqual(o.series[3]!.data, [10, 11, 12]);
  assert.equal(o.series[3]!.itemStyle.opacity, 1, 'the selected region stands out');
  assert.equal(o.series[0]!.itemStyle.opacity, 0.3);
  assert.equal(r.resizers.length, 1, 'it lays the panels out again when the frame changes size');
  r.clicks[0]!({ seriesIndex: 2 });
  assert.deepEqual(r.selects, [['jobs.region', 'Pacific']]);
  assert.match(runWidget(template('multiples'), { ...data, columns: data.columns.slice(1) }).html, /need two fields and a measure/);
});

test('the starter code draws a bar of the first measure, or says to describe the data first', () => {
  const data: WidgetData = { columns: [col('jobs.region', 'string', 'dimension'), col('work_orders', 'number', 'measure')], rows: [{ 'jobs.region': 'Gulf', work_orders: 4 }], selections: {}, truncated: false };
  assert.equal(runWidget(STARTER_CODE, data).options.length, 1);
  assert.match(runWidget(STARTER_CODE, emptyData).html, /Describe the data in the brief first/);
});

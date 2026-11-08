// What crosses between the page and a custom widget's sandboxed frame (web/src/widget-host.ts,
// web/src/components/CustomWidget.tsx): the data and colours the widget is given, and the checks on
// every message both ways. Loaded with the frame host, not with the page.

import { utf8Bytes, WIDGET_LIMITS } from './widget.ts';

export type WidgetCell = string | number | boolean | null;

export interface WidgetColumn {
  /** The key rows are read by: a field key (with "@grain" for a date period) or a measure key. */
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  /** A field the flag groups by, or a measure it adds up. */
  role: 'dimension' | 'measure';
  /** For measures: how the page shows the number. */
  format?: 'number' | 'currency' | 'percent';
  /** For date fields: the period each value stands for. */
  grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface WidgetTheme {
  /** The page's series colours, in order. */
  colors: string[];
  ink: string;
  ink2: string;
  ink3: string;
  panel: string;
  line: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  font: string;
  dark: boolean;
}

export interface WidgetData {
  columns: WidgetColumn[];
  rows: Array<Record<string, WidgetCell>>;
  /** The page's selections on this flag's own fields, by column key. */
  selections: Record<string, WidgetCell[]>;
  /** The result hit the row cap, so some rows may be missing. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------------------------
// Messages. Page -> frame: render, ping, picture. Frame -> page: ready, pong, rendered, error,
// select, picture. Every message carries the frame's nonce (it is in the frame's URL, #n=<nonce>).

export type HostMessage =
  | { type: 'render'; nonce: string; code: string; css: string; data: WidgetData; theme: WidgetTheme }
  | { type: 'ping'; nonce: string; seq: number }
  | { type: 'picture'; nonce: string; seq: number };

export type FrameMessage =
  | { type: 'ready'; nonce: string }
  | { type: 'pong'; nonce: string; seq: number }
  | { type: 'rendered'; nonce: string }
  | { type: 'error'; nonce: string; message: string; line?: number }
  | { type: 'select'; nonce: string; key: string; value: WidgetCell }
  | { type: 'picture'; nonce: string; seq: number; url: string | null; width: number; height: number };

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const isNonce = (v: unknown): v is string => typeof v === 'string' && NONCE_RE.test(v);

/** A new nonce for one frame: 128 random bits, base64url. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isCell = (v: unknown): v is WidgetCell => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= WIDGET_LIMITS.valueChars);
const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The page's check on a message event from a widget frame: it must come from that frame's own
 * window, from an opaque origin (the sandbox), with that frame's nonce and a known shape. Anything
 * else is ignored (null).
 */
export function acceptFrameMessage(e: { origin: string; source: unknown; data: unknown }, frame: { window: unknown; nonce: string }): FrameMessage | null {
  if (e.origin !== 'null' || e.source === null || e.source !== frame.window) return null;
  const d = e.data;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const m = d as Record<string, unknown>;
  if (m.nonce !== frame.nonce) return null;
  const nonce = frame.nonce;
  switch (m.type) {
    case 'ready':
    case 'rendered':
      return { type: m.type, nonce };
    case 'pong':
      return isSeq(m.seq) ? { type: 'pong', nonce, seq: m.seq } : null;
    case 'error': {
      if (typeof m.message !== 'string') return null;
      const message = m.message.slice(0, WIDGET_LIMITS.errorChars);
      const line = typeof m.line === 'number' && Number.isInteger(m.line) && m.line > 0 && m.line < 100000 ? m.line : undefined;
      return { type: 'error', nonce, message, ...(line ? { line } : {}) };
    }
    case 'select':
      return typeof m.key === 'string' && m.key.length > 0 && m.key.length <= 200 && isCell(m.value) ? { type: 'select', nonce, key: m.key, value: m.value } : null;
    case 'picture': {
      if (!isSeq(m.seq)) return null;
      const size = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000 ? Math.round(v) : 0);
      const url = typeof m.url === 'string' && m.url.length <= WIDGET_LIMITS.pictureChars && /^data:image\/(png|svg\+xml)[;,]/.test(m.url) ? m.url : null;
      return { type: 'picture', nonce, seq: m.seq, url, width: size(m.width), height: size(m.height) };
    }
    default:
      return null;
  }
}

/** The frame's check on a message from the page: from its parent window, with its nonce and a known shape. */
export function acceptHostMessage(e: { source: unknown; data: unknown }, parent: unknown, nonce: string): HostMessage | null {
  if (e.source === null || e.source !== parent) return null;
  const d = e.data;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const m = d as Record<string, unknown>;
  if (m.nonce !== nonce) return null;
  if (m.type === 'ping' || m.type === 'picture') return isSeq(m.seq) ? { type: m.type, nonce, seq: m.seq } : null;
  if (m.type === 'render') {
    if (typeof m.code !== 'string' || utf8Bytes(m.code) > WIDGET_LIMITS.codeBytes) return null;
    const css = typeof m.css === 'string' && utf8Bytes(m.css) <= WIDGET_LIMITS.cssBytes ? m.css : '';
    const data = m.data as WidgetData | undefined;
    const theme = m.theme as WidgetTheme | undefined;
    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows) || !theme || !Array.isArray(theme.colors)) return null;
    return { type: 'render', nonce, code: m.code, css, data, theme };
  }
  return null;
}

/**
 * Whether a select() from a widget may reach the page: the key must be one of the flag's own
 * fields (a widget cannot set selections on fields it was not given).
 */
export function selectAllowed(key: string, columns: readonly WidgetColumn[]): boolean {
  return columns.some((c) => c.role === 'dimension' && c.key === key);
}

/**
 * The line in the analyst's code an error points at, from a stack: the first frame in the
 * evaluated code ("<anonymous>:L:C" in Chromium, "Function:L:C" elsewhere), less the lines the
 * wrapper adds before the code (`offset`, measured by the frame at start).
 */
export function errorLine(stack: unknown, offset: number): number | undefined {
  if (typeof stack !== 'string') return undefined;
  const m = /(?:<anonymous>|Function|eval)[^:\n]*:(\d+):(\d+)/.exec(stack);
  if (!m) return undefined;
  const line = Number(m[1]) - offset;
  return line > 0 ? line : undefined;
}

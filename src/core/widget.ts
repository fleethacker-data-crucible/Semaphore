// Custom chart widgets: code an analyst writes, run in a sandboxed frame (web/src/widget-host.ts).
// This file is shared by the page, the frame and the tests: the size caps, the parser for a flag's
// widget and for a team library entry, and the checks on every message between the page and a frame.
//
// The frame is an <iframe sandbox="allow-scripts"> (no allow-same-origin, so its origin is opaque)
// loading /sandbox/widget.html, which has its own CSP (server/Http.ps1 $script:SemSandboxCsp). The
// widget never sees the session token, the page's storage or the page's DOM: it gets plain data in
// a message and answers with render errors, a size, a picture and select() events.

export const WIDGET_LIMITS = {
  /** A widget's code, as UTF-8 bytes. */
  codeBytes: 64 * 1024,
  /** A widget's CSS, as UTF-8 bytes. */
  cssBytes: 16 * 1024,
  /** A library widget's name. */
  nameChars: 80,
  /** A library widget's description. */
  descriptionChars: 500,
  /** One error message from a frame. */
  errorChars: 500,
  /** A selected value posted by a frame (strings longer than this are refused). */
  valueChars: 500,
  /** A picture handed back by a frame, as a data: URL. */
  pictureChars: 8 * 1024 * 1024,
} as const;

/** What a custom flag carries: its code, its CSS, and the library entry it came from. */
export interface FlagWidget {
  code: string;
  css?: string;
  /** The team library entry this code came from (an id in SEMAPHORE_HOME\widgets). */
  libraryId?: string;
  /** The library entry's name, shown in the inspector. */
  name?: string;
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isWidgetId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

/**
 * A name a person can read anywhere: control and line-separator characters removed, runs of space
 * made one, trimmed and cut to 80 characters. Empty when nothing is left. The server applies the
 * same rule (ConvertTo-SemWidgetName).
 */
export function sanitizeWidgetName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, WIDGET_LIMITS.nameChars).join('').trim();
}

/**
 * A flag's widget from untrusted JSON (a saved hoist, an import). Code or CSS over its cap is not
 * cut (half a program is a broken program): the widget is dropped with a warning instead.
 */
export function parseWidget(raw: unknown, warnings: string[], where: string): FlagWidget | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${where}: the custom widget is not an object, removed.`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string') {
    warnings.push(`${where}: the custom widget has no code, removed.`);
    return undefined;
  }
  if (utf8Bytes(r.code) > WIDGET_LIMITS.codeBytes) {
    warnings.push(`${where}: the custom widget's code is over ${WIDGET_LIMITS.codeBytes / 1024} KB, removed.`);
    return undefined;
  }
  const out: FlagWidget = { code: r.code };
  if (typeof r.css === 'string' && r.css !== '') {
    if (utf8Bytes(r.css) > WIDGET_LIMITS.cssBytes) warnings.push(`${where}: the custom widget's CSS is over ${WIDGET_LIMITS.cssBytes / 1024} KB, left out.`);
    else out.css = r.css;
  }
  if (r.libraryId !== undefined) {
    if (isWidgetId(r.libraryId)) out.libraryId = r.libraryId;
    else warnings.push(`${where}: the custom widget's library id is not valid, left out.`);
  }
  const name = sanitizeWidgetName(r.name);
  if (name) out.name = name;
  return out;
}

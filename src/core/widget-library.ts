// The team widget library's entries (server/Routes.ps1, SEMAPHORE_HOME\widgets\<id>.json), as the page
// reads them back. Loaded with the custom widget editor, not with the page.

import { isWidgetId, sanitizeWidgetName, utf8Bytes, WIDGET_LIMITS } from './widget.ts';

/** A team library entry, as the server stores it (server/Routes.ps1, SEMAPHORE_HOME\widgets\<id>.json). */
export interface LibraryWidget {
  version: 1;
  id: string;
  name: string;
  description: string;
  code: string;
  css: string;
  by: string;
  updated: string;
}

/**
 * The library id a name is saved under: lower-case letters, digits and dashes, at most 48
 * characters, "widget" when nothing is left. The server makes the same id (ConvertTo-SemWidgetId).
 */
export function widgetIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'widget';
}

/** A library entry from the server (or a file): null when it is not one, with the reason in `problems`. */
export function parseLibraryWidget(raw: unknown, problems: string[] = []): LibraryWidget | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('Not a library widget.');
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (!isWidgetId(r.id)) problems.push('The widget id is missing or not valid.');
  const name = sanitizeWidgetName(r.name);
  if (!name) problems.push('The widget has no name.');
  if (typeof r.code !== 'string' || r.code.trim() === '') problems.push('The widget has no code.');
  else if (utf8Bytes(r.code) > WIDGET_LIMITS.codeBytes) problems.push(`The code is over ${WIDGET_LIMITS.codeBytes / 1024} KB.`);
  const css = typeof r.css === 'string' ? r.css : '';
  if (utf8Bytes(css) > WIDGET_LIMITS.cssBytes) problems.push(`The CSS is over ${WIDGET_LIMITS.cssBytes / 1024} KB.`);
  if (problems.length) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? [...v].slice(0, max).join('') : '');
  return {
    version: 1,
    id: r.id as string,
    name,
    description: text(r.description, WIDGET_LIMITS.descriptionChars),
    code: r.code as string,
    css,
    by: text(r.by, 64),
    updated: text(r.updated, 40),
  };
}

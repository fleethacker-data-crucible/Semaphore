// What a custom widget is given: the flag's answer as plain columns and rows (no plan, no SQL, no
// catalog), the page's selections on its own fields, and the page's colours. Pure, so tests can
// check exactly what crosses into the sandbox.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Selections } from '../../../src/core/crossfilter.ts';
import type { WidgetCell, WidgetColumn, WidgetData, WidgetTheme } from '../../../src/core/widget-protocol.ts';
import type { FlagResult } from './data.ts';

/** Columns for the flag's own fields, then its measures; one plain object per row. */
export function widgetData(result: FlagResult | undefined, index: CatalogIndex, selections: Selections): WidgetData {
  if (!result) return { columns: [], rows: [], selections: {}, truncated: false };
  const plan = result.plan;
  const dims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const columns: WidgetColumn[] = [
    ...dims.map((d): WidgetColumn => {
      const f = index.field(d.field);
      const type = d.grain ? 'date' : (f?.type ?? 'string');
      return { key: d.key, label: `${f?.label ?? d.field}${d.grain ? ` (${d.grain})` : ''}`, type, role: 'dimension', ...(d.grain ? { grain: d.grain } : {}) };
    }),
    ...plan.metrics.map((m): WidgetColumn => {
      const meta = index.metric(m.key);
      return { key: m.key, label: meta?.label ?? m.key, type: 'number', role: 'measure', ...(meta?.format ? { format: meta.format } : {}) };
    }),
  ];
  const rows = result.display.rows.map((r) => {
    const o: Record<string, WidgetCell> = {};
    for (const d of dims) o[d.key] = r.dims[d.key] ?? null;
    for (const m of plan.metrics) {
      const v = r.values[m.key];
      o[m.key] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    return o;
  });
  const sel: Record<string, WidgetCell[]> = {};
  for (const d of dims) {
    const s = selections[d.key];
    if (s && s.length) sel[d.key] = [...s];
  }
  return { columns, rows, selections: sel, truncated: result.display.truncated };
}

/** The page's colours and font for a widget, read from the skin (themeColors) and the page's palette. */
export function widgetTheme(c: { ink: string; ink2: string; ink3: string; line: string; panel: string; accent: string; good: string; warn: string; bad: string }, colors: readonly string[], font: string, dark: boolean): WidgetTheme {
  return { colors: [...colors], ink: c.ink, ink2: c.ink2, ink3: c.ink3, panel: c.panel, line: c.line, accent: c.accent, good: c.good, warn: c.warn, bad: c.bad, font, dark };
}

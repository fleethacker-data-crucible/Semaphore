// The richer chart kinds and what each needs from a binding. One place, so drafting (contract.ts,
// local-rules.ts), the page (FlagView) and the inspector agree: a kind whose data does not fit falls
// back to the nearest kind that does, and the note says why.

import type { Binding, FlagKind } from './hoist.ts';
import type { CatalogIndex } from './catalog.ts';

/** The kinds added beside bar, line, area and pie. All draw with ECharts. */
export const RICH_KINDS = ['radar', 'scatter', 'heatmap', 'calendar', 'waterfall', 'pareto', 'sankey', 'sunburst', 'stream'] as const;
export type RichKind = (typeof RICH_KINDS)[number];

export const isRichKind = (k: string): k is RichKind => (RICH_KINDS as readonly string[]).includes(k);

/** Every kind drawn as a chart (FlagCard's table toggle, exports, the inspector's PNG and SVG). */
export const CHART_KINDS: readonly FlagKind[] = ['bar', 'line', 'area', 'pie', ...RICH_KINDS];

export const KIND_NEEDS: Record<RichKind, string> = {
  radar: 'one field (the spokes) and one or more measures, or two fields and one measure',
  scatter: 'one field (the points) and two or three measures (across, up, and size)',
  heatmap: 'two fields (across and down) and one measure',
  calendar: 'one date field and one measure',
  waterfall: 'one field and one measure',
  pareto: 'one field and one measure',
  sankey: 'two fields (from and to) and one measure',
  sunburst: 'two fields (inner and outer ring) and one measure',
  stream: 'a date field, a second field and one measure',
};

/**
 * The kind a binding can be drawn as, starting from the one asked for. Returns the kind and, when it
 * changed, a sentence saying why.
 */
export function fitRichKind(kind: RichKind, b: Binding, index: CatalogIndex | undefined): { kind: FlagKind; note?: string } {
  const dims = b.dimensions.length;
  const metrics = b.metrics.length;
  const isDate = (i: number) => {
    const d = b.dimensions[i];
    if (!d) return false;
    if (d.grain) return true;
    return index?.field(d.field)?.type === 'date';
  };
  const ok = (() => {
    switch (kind) {
      case 'radar':
        return (dims === 1 && metrics >= 1) || (dims === 2 && metrics === 1);
      case 'scatter':
        return dims === 1 && metrics >= 2 && metrics <= 3;
      case 'heatmap':
      case 'sankey':
      case 'sunburst':
        return dims === 2 && metrics >= 1;
      case 'calendar':
        return dims === 1 && metrics >= 1 && isDate(0);
      case 'waterfall':
      case 'pareto':
        return dims === 1 && metrics >= 1;
      case 'stream':
        return dims === 2 && metrics >= 1 && (isDate(0) || isDate(1));
    }
  })();
  if (ok) return { kind };
  const fallback: FlagKind = dims === 0 ? 'kpi' : kind === 'calendar' || kind === 'stream' ? (isDate(0) ? (kind === 'stream' ? 'area' : 'line') : 'bar') : 'bar';
  return { kind: fallback, note: `A ${KIND_LABEL[kind].toLowerCase()} needs ${KIND_NEEDS[kind]}, so this is drawn as a ${fallback === 'kpi' ? 'KPI' : fallback}.` };
}

/**
 * A pivot nests its rows by every field but the last and spreads the last across: it needs a field
 * (one makes a one-way table with totals) and a measure. At most five fields; a top-N cut is dropped,
 * since a pivot shows every row and its totals. Trims `b` in place.
 */
export function fitPivot(b: Binding): { kind: FlagKind; note?: string } {
  if (!b.dimensions.length) return { kind: 'kpi', note: 'A pivot needs a field for its rows (and another for its columns), so this is drawn as a KPI.' };
  const notes: string[] = [];
  if (b.dimensions.length > 5) {
    b.dimensions = b.dimensions.slice(0, 5);
    notes.push('A pivot nests at most four row fields and one column field, so the rest were left out.');
  }
  if (b.limit) {
    delete b.limit;
    notes.push('A pivot shows every row with its totals, so the top-N cut was dropped.');
  }
  return { kind: 'pivot', ...(notes.length ? { note: notes.join(' ') } : {}) };
}

export const KIND_LABEL: Record<RichKind, string> = {
  radar: 'Spider',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  calendar: 'Calendar',
  waterfall: 'Waterfall',
  pareto: 'Pareto',
  sankey: 'Sankey',
  sunburst: 'Sunburst',
  stream: 'Stream',
};

/** Words in a brief that ask for each kind (local-rules.ts reads them before its own). */
export const KIND_WORDS: Array<[RegExp, RichKind]> = [
  [/\b(radar|spider|spiderweb|web chart|star chart)\b/, 'radar'],
  [/\b(scatter|scatterplot|bubble|correlat\w*|plotted against)\b/, 'scatter'],
  [/\b(heat ?map|heat-map|matrix|grid of)\b/, 'heatmap'],
  [/\b(calendar|day by day calendar)\b/, 'calendar'],
  [/\b(waterfall|bridge chart|walk from)\b/, 'waterfall'],
  [/\b(pareto|80\/20|eighty twenty)\b/, 'pareto'],
  [/\b(sankey|flows? from|flow chart of)\b/, 'sankey'],
  [/\b(sunburst|rings? of)\b/, 'sunburst'],
  [/\b(stream ?graph|streamgraph|theme ?river|stream chart)\b/, 'stream'],
];

// Picks a flag kind from the shape of its data, the way an analyst would: one number is a KPI,
// anything over time is a line, a handful of parts of a whole is a pie, a long list of
// categories is a ranked bar cut to the top few, and a crossing of two long lists is a table.

import type { CatalogIndex } from './catalog.ts';
import type { Binding, FlagKind } from './hoist.ts';
import { dimCardinality } from './planner.ts';

export interface KindSuggestion {
  kind: FlagKind;
  /** A top-N cut worth applying when the brief did not ask for one. */
  limit?: number;
  /** Plain-language reason, shown on the flag. */
  reason: string;
}

/** Categories a pie can show before slices get too thin to read. */
export const PIE_MAX = 6;
/** Bars a chart can label legibly; longer lists are cut to the top ones. */
export const BAR_MAX = 15;
/** Series a line or grouped bar can colour apart. */
export const SERIES_MAX = 8;

export function suggestKind(binding: Pick<Binding, 'metrics' | 'dimensions' | 'filters' | 'share'>, index: CatalogIndex): KindSuggestion {
  const dims = binding.dimensions;
  if (binding.metrics.length === 0) {
    return dims.length === 1 ? { kind: 'filter', reason: 'A field with no measure becomes a picker.' } : { kind: 'table', reason: 'Fields with no measure become a list.' };
  }
  if (dims.length === 0) return { kind: 'kpi', reason: 'One number, so a KPI.' };
  const card = (i: number) => dimCardinality(dims[i]!, binding.filters, index);
  const time = dims.findIndex((d) => d.grain);
  if (time >= 0) {
    if (dims.length === 1) return { kind: 'line', reason: 'Over time, so a line.' };
    const other = dims.findIndex((d, i) => i !== time && !d.grain);
    if (dims.length === 2 && other >= 0 && card(other) <= SERIES_MAX) return { kind: 'line', reason: 'Over time with a few series, so a line per series.' };
    return { kind: 'table', reason: 'Over time across many categories, so a table.' };
  }
  if (dims.length >= 2) {
    if (dims.length === 2 && card(1) <= SERIES_MAX && card(0) <= BAR_MAX * 2) return { kind: 'bar', reason: 'Two fields with a few values each, so grouped bars.' };
    return { kind: 'table', reason: 'Several fields with many values, so a table.' };
  }
  const n = card(0);
  const additive = binding.metrics.every((k) => {
    const agg = index.metric(k)?.agg;
    return agg === 'sum' || agg === 'count';
  });
  if (binding.share && additive && binding.metrics.length === 1 && n <= PIE_MAX) return { kind: 'pie', reason: `Parts of a whole across ${n} values, so a pie.` };
  if (n > BAR_MAX) return { kind: 'bar', limit: BAR_MAX, reason: `About ${n} values is too many to read, so the top ${BAR_MAX} are shown.` };
  return { kind: 'bar', reason: 'Compared across categories, so bars.' };
}

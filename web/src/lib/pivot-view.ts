// What the page and the exports share about a pivot flag: how its result becomes a pivot input, and
// the order and folds the analyst set on the page this session (a header click), so a file holds the
// rows in the order they were seen. Loaded with the first pivot flag or the first export.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import type { PivotInput } from '../../../src/core/pivot.ts';
import type { PivotSort } from '../../../src/core/pivot-spec.ts';
import { overlaps } from '../../../src/core/planner.ts';
import type { FlagResult } from './data.ts';

export interface PivotView {
  sort?: PivotSort;
  colSort?: PivotSort;
  collapsed: Set<string>;
}

const views = new Map<string, PivotView>();

/** This session's view of one pivot flag (the same object every time, so the page can change it). */
export function pivotView(flagId: string): PivotView {
  let v = views.get(flagId);
  if (!v) {
    v = { collapsed: new Set() };
    views.set(flagId, v);
  }
  return v;
}

export interface PivotFields {
  /** Own dimensions in binding order: key, field and grain. */
  rows: Array<{ key: string; field: string; grain?: string }>;
  column: { key: string; field: string; grain?: string } | null;
}

/** Rows are every field but the last, the column is the last; one field makes a one-way table. */
export function pivotFields(result: FlagResult): PivotFields {
  const own = result.plan.own.map((k) => result.plan.dimensions.find((d) => d.key === k)!).filter(Boolean);
  const pick = (d: (typeof own)[number]) => ({ key: d.key, field: d.field, ...(d.grain ? { grain: d.grain } : {}) });
  if (own.length <= 1) return { rows: own.map(pick), column: null };
  return { rows: own.slice(0, -1).map(pick), column: pick(own[own.length - 1]!) };
}

export function pivotInput(flag: Flag, result: FlagResult, index: CatalogIndex, view?: PivotView): PivotInput {
  const f = pivotFields(result);
  return {
    rows: f.rows.map((r) => r.key),
    column: f.column?.key ?? null,
    measures: (flag.binding?.metrics ?? []).map((key) => ({ key, agg: index.metric(key)?.agg ?? 'sum' })),
    cells: result.display.rows,
    ...(result.levels ? { levels: result.levels } : {}),
    ...(overlaps(result.plan) ? { overlap: true } : {}),
    ...(flag.pivot ? { spec: flag.pivot } : {}),
    ...(view?.sort ? { sort: view.sort } : {}),
    ...(view?.colSort ? { colSort: view.colSort } : {}),
    ...(view ? { collapsed: view.collapsed } : {}),
  };
}

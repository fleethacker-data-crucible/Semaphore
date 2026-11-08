// Drilling down: a click on a bar of a flag set to "drill" narrows that flag only. Dates go year →
// quarter → month → day with no setup; categories follow a drill path in the catalog (ship class →
// hull). At the end of a path the flag opens the rows behind the clicked value as a detail table.
// The flag itself is never changed: the drilled version is derived from it and a list of steps.

import type { CatalogIndex } from './catalog.ts';
import { isRichKind } from './kinds.ts';
import type { Cell } from './crossfilter.ts';
import type { DimensionRef, Filter, Flag, TimeGrain } from './hoist.ts';
import { periodStart } from './sql.ts';

export interface DrillStep {
  field: string;
  grain?: TimeGrain;
  value: Cell;
}

const GRAINS: TimeGrain[] = ['year', 'quarter', 'month', 'day'];
export const DETAIL_ROWS = 500;

/** The level below a dimension, or 'detail' at the end of a path, or null when it cannot drill. */
export function nextLevel(index: CatalogIndex, d: DimensionRef): DimensionRef | 'detail' | null {
  const f = index.field(d.field);
  if (!f) return null;
  if (f.type === 'date') {
    const at = GRAINS.indexOf(d.grain ?? 'day');
    if (d.grain === 'week') return { field: d.field, grain: 'day' };
    return at >= 0 && at < GRAINS.length - 1 ? { field: d.field, grain: GRAINS[at + 1]! } : 'detail';
  }
  for (const h of index.catalog.hierarchies ?? []) {
    const i = h.levels.indexOf(d.field);
    if (i < 0) continue;
    return i < h.levels.length - 1 ? { field: h.levels[i + 1]! } : 'detail';
  }
  return null;
}

/** Whether a click on this flag can drill. */
export function canDrill(index: CatalogIndex, flag: Flag): boolean {
  const d = flag.binding?.dimensions[0];
  return !!d && flag.behavior.onClick === 'drill' && nextLevel(index, d) !== null;
}

/** The filter a clicked value stands for: one category, or the whole period a date bar covers. */
function stepFilter(step: DrillStep): Filter {
  // Tagged so a comparison can move a drilled period back with its earlier window (drill-compare.ts).
  return { ...rawStepFilter(step), drill: true };
}

function rawStepFilter(step: DrillStep): Filter {
  if (!step.grain || step.value === null) return { field: step.field, op: 'eq', values: [step.value === null ? '' : (step.value as string | number)] };
  const start = String(step.value).slice(0, 10);
  const from = new Date(`${start}T00:00:00Z`);
  const months = { year: 12, quarter: 3, month: 1 }[step.grain as 'year' | 'quarter' | 'month'];
  const next = months ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1)) : new Date(from.getTime() + (step.grain === 'week' ? 7 : 1) * 86_400_000);
  const end = new Date(next.getTime() - 86_400_000);
  return { field: step.field, op: 'between', values: [periodStart(from, step.grain, 0), end.toISOString().slice(0, 10)] };
}

/**
 * The flag as seen after these drill steps: each step filters to the clicked value and moves the
 * first dimension one level down. Past the last level it becomes a detail table.
 */
export function drilledFlag(flag: Flag, steps: readonly DrillStep[], index: CatalogIndex): Flag {
  return drillView(flag, steps, index).flag;
}

/** The drilled flag, and whether it has reached the detail table (no further drilling). */
export function drillView(flag: Flag, steps: readonly DrillStep[], index: CatalogIndex): { flag: Flag; detail: boolean } {
  if (!flag.binding || !steps.length) return { flag, detail: false };
  let detail = false;
  let dims = [...flag.binding.dimensions];
  const filters = [...flag.binding.filters];
  let kind = flag.kind;
  let limit = flag.binding.limit;
  let sort = flag.binding.sort;
  for (const step of steps) {
    filters.push(stepFilter(step));
    const first = dims[0];
    if (!first) break;
    const next = nextLevel(index, first);
    if (next === 'detail' || next === null) {
      // The rows behind the value: the table's other descriptive fields, a few hundred at most.
      const at = index.field(first.field);
      const extra = index.catalog.fields
        .filter((f) => at && f.source === at.source && f.table === at.table && f.key !== first.field && (f.type === 'string' || f.type === 'date') && !filters.some((x) => x.field === f.key))
        .slice(0, 5)
        .map((f): DimensionRef => (f.type === 'date' ? { field: f.key, grain: 'day' } : { field: f.key }));
      dims = [first, ...extra];
      kind = 'table';
      detail = true;
      limit = DETAIL_ROWS;
      sort = flag.binding.metrics[0] ? { by: flag.binding.metrics[0], dir: 'desc' } : undefined;
      break;
    }
    dims = [next, ...dims.slice(1).filter((d) => d.field !== next.field)];
    // A ranking ("top 5 classes") does not carry down to the next level.
    if (limit && limit < DETAIL_ROWS) limit = undefined;
    if (sort && sort.by.startsWith(first.field)) sort = undefined;
  }
  const binding = { ...flag.binding, dimensions: dims, filters, ...(limit ? { limit } : {}), ...(sort ? { sort } : {}) };
  if (!limit) delete binding.limit;
  if (!sort) delete binding.sort;
  // A comparison carries down a drill: the earlier window is narrowed by the same steps, moved back
  // with it (drill-compare.ts). The rows behind a value are a list, not a series, so it ends there.
  if (detail) delete binding.compare;
  return { flag: { ...flag, kind: kind === 'kpi' || kind === 'pie' || isRichKind(kind) ? 'bar' : kind, binding }, detail };
}

/** "Destroyer › 2026 Q3" for the breadcrumb. */
export function drillLabel(steps: readonly DrillStep[]): string {
  return steps
    .map((s) => {
      if (s.value === null) return '(blank)';
      if (!s.grain) return String(s.value);
      const d = new Date(`${String(s.value).slice(0, 10)}T00:00:00Z`);
      const y = d.getUTCFullYear();
      if (s.grain === 'year') return String(y);
      if (s.grain === 'quarter') return `${y} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      if (s.grain === 'month') return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      return String(s.value).slice(0, 10);
    })
    .join(' › ');
}

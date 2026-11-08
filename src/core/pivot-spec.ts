// What a pivot flag remembers beyond its binding: how each measure is shown, its heat shading, and
// the default order of rows and columns. Kept apart from pivot.ts so a saved hoist parses without
// loading the pivot maths (web/size-budget.json).

/** A measure's values as they are, or as a share of their row, column or the whole table. */
export type PivotShow = 'value' | 'row' | 'column' | 'total';
/** Heat shading compares a cell with the others in its row, its column, or the whole table. */
export type PivotHeat = 'row' | 'column' | 'table';

/** Rows by label (`by` empty) or by a measure, in one column (`col`, a column key) or the row total. */
export interface PivotSort {
  by: string;
  col?: string;
  dir: 'asc' | 'desc';
}

export interface PivotSpec {
  /** Measure key: how its values are shown. Missing means 'value'. */
  show?: Record<string, PivotShow>;
  /** Measure key: heat shading. Missing means off. */
  heat?: Record<string, PivotHeat>;
  /** Default row order. Missing: by label, A to Z. */
  sort?: PivotSort;
  /** Column order: by label (`by` empty) or by a measure's column total. */
  colSort?: PivotSort;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick<T extends string>(raw: unknown, allowed: readonly T[]): Record<string, T> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 20)) if (k.length <= 200 && allowed.includes(v as T)) out[k] = v as T;
  return Object.keys(out).length ? out : undefined;
}

function sortOf(raw: unknown): PivotSort | undefined {
  if (!isObj(raw) || typeof raw.by !== 'string' || raw.by.length > 200 || (raw.dir !== 'asc' && raw.dir !== 'desc')) return undefined;
  return { by: raw.by, dir: raw.dir, ...(typeof raw.col === 'string' && raw.col.length <= 500 ? { col: raw.col } : {}) };
}

export function parsePivotSpec(raw: unknown): PivotSpec | undefined {
  if (!isObj(raw)) return undefined;
  const out: PivotSpec = {};
  const show = pick<PivotShow>(raw.show, ['value', 'row', 'column', 'total']);
  const heat = pick<PivotHeat>(raw.heat, ['row', 'column', 'table']);
  const sort = sortOf(raw.sort);
  const colSort = sortOf(raw.colSort);
  if (show) out.show = show;
  if (heat) out.heat = heat;
  if (sort) out.sort = sort;
  if (colSort) out.colSort = colSort;
  return Object.keys(out).length ? out : undefined;
}

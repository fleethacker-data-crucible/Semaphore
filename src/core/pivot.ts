// Pivot tables: rows nested by every field but the last, columns by the last field, and the measures
// side by side under each column value. With one field it is a one-way table with a grand total.
//
// Totals are only ever added up where adding up is right. A sum or a count of a group is the sum of
// its cells, and a min or max is the min or max of its cells. An average or a distinct count is not:
// the average of averages is wrong, and the same hull can be in two cells. Those totals come from the
// data itself, grouped by fewer fields (`levels`, read by web/src/lib/pivot-levels.ts as extra
// queries); when a level could not be read the total is left empty with the reason, never guessed.
// A split by a many-side field counts a row in several groups, so then nothing is added up.
//
// Pure: no DOM, no data access. Tested in tests/pivot.test.ts.

import type { Aggregate } from './catalog.ts';
import type { Cell, DisplayRow } from './crossfilter.ts';
import type { PivotHeat, PivotShow, PivotSort, PivotSpec } from './pivot-spec.ts';

export const MAX_COLUMNS = 200;
export const MAX_ROWS = 2000;

export interface PivotMeasure {
  key: string;
  agg: Aggregate;
}

export interface PivotInput {
  /** Row field keys, outermost first (at least one). */
  rows: readonly string[];
  /** The column field key, or null for a one-way table. */
  column: string | null;
  measures: readonly PivotMeasure[];
  /** The flag's result: one row per (row fields..., column) combination. */
  cells: readonly DisplayRow[];
  /** The same measures grouped by fewer fields, keyed by levelKey(). */
  levels?: Readonly<Record<string, readonly DisplayRow[]>>;
  /** A split by a many-side field: a row can sit in several groups, so nothing adds up. */
  overlap?: boolean;
  spec?: PivotSpec;
  /** Overrides spec.sort (a header click on the page). */
  sort?: PivotSort;
  colSort?: PivotSort;
  /** Group ids (PivotLine.id) whose rows are folded away. */
  collapsed?: ReadonlySet<string>;
  maxColumns?: number;
  maxRows?: number;
}

export interface PivotValue {
  value: number | null;
  /** The value as shown: the value, or its share of the row, column or table. */
  shown: number | null;
  /** Why there is no number, when there should have been one. */
  why?: string;
}

export interface PivotColumn {
  key: string;
  value: Cell;
}

export interface PivotLine {
  kind: 'leaf' | 'group' | 'total';
  id: string;
  /** 0 for the outermost row field. The grand total is -1. */
  depth: number;
  path: Cell[];
  label: Cell;
  /** Groups: whether their rows are showing. */
  open?: boolean;
  /** Groups: how many leaf rows are inside. */
  size?: number;
  /** Column key, then measure key. */
  cells: Record<string, Record<string, PivotValue>>;
  /** Across every column (all of them, also those past the column cap). */
  total: Record<string, PivotValue>;
}

export interface PivotGrid {
  columns: PivotColumn[];
  /** Distinct column values before the cap. */
  columnCount: number;
  /** Visible lines in order: group (subtotal) lines above their rows, then leaf lines. */
  lines: PivotLine[];
  total: PivotLine;
  /** Leaf rows before the row cap. */
  rowCount: number;
  notes: string[];
}

/** The key a level's rows are stored under: grouped by the first `depth` row fields, with or without the column. */
export const levelKey = (depth: number, withColumn: boolean): string => `r${depth}${withColumn ? 'c' : ''}`;

/** The groupings a pivot needs beyond its own result, as [depth, withColumn]. */
export function neededLevels(rowFields: number, hasColumn: boolean): Array<[number, boolean]> {
  const out: Array<[number, boolean]> = [];
  for (let d = 0; d < rowFields; d++) {
    out.push([d, false]);
    if (hasColumn) out.push([d, true]);
  }
  if (hasColumn) out.push([rowFields, false]);
  return out;
}

/** Whether a measure's group totals can be worked out from its cells. */
export function combinable(agg: Aggregate, overlap = false): boolean {
  return !overlap && (agg === 'sum' || agg === 'count' || agg === 'min' || agg === 'max');
}

/** Whether a pivot of these measures needs the extra level queries. */
export function needsLevels(measures: readonly PivotMeasure[], overlap = false): boolean {
  return measures.some((m) => !combinable(m.agg, overlap));
}

/** Only sums and counts (distinct or not) can be shown as a share; averages, mins and maxes cannot. */
export function canShare(agg: Aggregate): boolean {
  return agg === 'sum' || agg === 'count' || agg === 'count_distinct';
}

/** A stable text key for a field value (null, numbers and text never collide). */
export const cellKey = (v: Cell): string => JSON.stringify(v ?? null);

const pathKey = (path: readonly Cell[]): string => JSON.stringify(path.map((v) => v ?? null));

function combine(agg: Aggregate, values: Array<number | null>): number | null {
  let out: number | null = null;
  for (const v of values) {
    if (typeof v !== 'number') continue;
    if (out === null) out = v;
    else if (agg === 'min') out = Math.min(out, v);
    else if (agg === 'max') out = Math.max(out, v);
    else out += v;
  }
  if (out === null && agg === 'count') return values.length ? 0 : null;
  return out;
}

export function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function why(agg: Aggregate, overlap: boolean): string {
  if (overlap) return 'A row can sit in several of these groups, so the groups do not add up to a total, and the total could not be read.';
  if (agg === 'avg') return 'An average cannot be added up from its cells, and the total could not be read from the data.';
  return 'A distinct count cannot be added up from its cells (the same item can be in several), and the total could not be read from the data.';
}

interface Node {
  path: Cell[];
  children: Map<string, Node>;
  leaves: DisplayRow[];
}

export function buildPivot(input: PivotInput): PivotGrid {
  const { rows, column, measures } = input;
  const k = rows.length;
  const overlap = !!input.overlap;
  const notes: string[] = [];
  const maxColumns = input.maxColumns ?? MAX_COLUMNS;
  const maxRows = input.maxRows ?? MAX_ROWS;
  const show: Record<string, PivotShow> = {};
  for (const m of measures) {
    const want = input.spec?.show?.[m.key] ?? 'value';
    show[m.key] = want !== 'value' && !canShare(m.agg) ? 'value' : want;
  }
  if (measures.some((m) => (input.spec?.show?.[m.key] ?? 'value') !== 'value' && !canShare(m.agg))) notes.push('Only sums and counts can be shown as a percentage; averages, minimums and maximums show their values.');

  // Rows grouped by fewer fields, looked up by [path..., column].
  const levelIndex = new Map<string, Map<string, DisplayRow>>();
  const level = (depth: number, withColumn: boolean): Map<string, DisplayRow> | undefined => {
    const key = levelKey(depth, withColumn);
    if (levelIndex.has(key)) return levelIndex.get(key);
    const own = depth === k && withColumn === (column !== null);
    const list = own ? input.cells : input.levels?.[key];
    if (!list) return undefined;
    const map = new Map<string, DisplayRow>();
    for (const r of list) map.set(pathKey([...rows.slice(0, depth).map((f) => r.dims[f] ?? null), ...(withColumn && column ? [r.dims[column] ?? null] : [])]), r);
    levelIndex.set(key, map);
    return map;
  };

  // The tree of row paths over the cells.
  const root: Node = { path: [], children: new Map(), leaves: [] };
  const colValues = new Map<string, Cell>();
  for (const cell of input.cells) {
    let node = root;
    node.leaves.push(cell);
    for (let d = 0; d < k; d++) {
      const v = cell.dims[rows[d]!] ?? null;
      const ck = cellKey(v);
      let next = node.children.get(ck);
      if (!next) {
        next = { path: [...node.path, v], children: new Map(), leaves: [] };
        node.children.set(ck, next);
      }
      next.leaves.push(cell);
      node = next;
    }
    if (column) {
      const v = cell.dims[column] ?? null;
      colValues.set(cellKey(v), v);
    }
  }

  // A node's cells split by column value, worked out once per node.
  const split = new WeakMap<Node, Map<string, DisplayRow[]>>();
  const inColumn = (node: Node, col: string): DisplayRow[] => {
    let by = split.get(node);
    if (!by) {
      by = new Map();
      for (const r of node.leaves) {
        const ck = cellKey(r.dims[column!] ?? null);
        const list = by.get(ck);
        if (list) list.push(r);
        else by.set(ck, [r]);
      }
      split.set(node, by);
    }
    return by.get(col) ?? [];
  };

  // A value of one measure for the rows under `node`, in one column (`col`) or across all of them (null).
  const valueOf = (node: Node, m: PivotMeasure, col: string | null): PivotValue => {
    const depth = node.path.length;
    const withColumn = col !== null;
    const at = () => pathKey([...node.path, ...(withColumn ? [JSON.parse(col!) as Cell] : [])]);
    if (depth === k && withColumn === (column !== null)) {
      // A cell of the flag's own result.
      const v = level(depth, withColumn)?.get(at())?.values[m.key] ?? null;
      return { value: v, shown: v };
    }
    const scoped = withColumn ? inColumn(node, col) : node.leaves;
    if (combinable(m.agg, overlap)) {
      const v = scoped.length ? combine(m.agg, scoped.map((r) => r.values[m.key] ?? null)) : null;
      return { value: v, shown: v };
    }
    const lv = level(depth, withColumn);
    if (lv) {
      const v = lv.get(at())?.values[m.key] ?? null;
      return { value: v, shown: v };
    }
    // An empty cell needs no reason; a total that could not be read does.
    return scoped.length ? { value: null, shown: null, why: why(m.agg, overlap) } : { value: null, shown: null };
  };

  // Shares: of the line's own total, of the column's grand total, or of the whole table.
  const share = (line: PivotLine, grand: PivotLine, columns: readonly PivotColumn[]) => {
    const set = (v: PivotValue, denom: PivotValue | undefined) => {
      if (v.value === null) return;
      const d = denom?.value ?? null;
      if (d === null || d === 0) {
        v.shown = null;
        v.why ??= denom?.why ?? 'There is no total to divide by.';
      } else v.shown = v.value / d;
    };
    for (const m of measures) {
      const mode = show[m.key]!;
      if (mode === 'value') continue;
      const own = { ...line.total[m.key]! };
      for (const c of columns) set(line.cells[c.key]![m.key]!, mode === 'row' ? own : mode === 'column' ? grand.cells[c.key]?.[m.key] : grand.total[m.key]);
      // The total column: a share of itself (row), or of the grand total (column and table).
      set(line.total[m.key]!, mode === 'row' ? own : grand.total[m.key]);
    }
  };

  const lineOf = (node: Node, kind: PivotLine['kind'], columns: readonly PivotColumn[], grand?: PivotLine): PivotLine => {
    const cells: PivotLine['cells'] = {};
    for (const c of columns) {
      const per: Record<string, PivotValue> = {};
      for (const m of measures) per[m.key] = valueOf(node, m, c.key);
      cells[c.key] = per;
    }
    const total: Record<string, PivotValue> = {};
    for (const m of measures) total[m.key] = valueOf(node, m, null);
    const depth = node.path.length - 1;
    const line: PivotLine = { kind, id: kind === 'total' ? 'total' : pathKey(node.path), depth, path: node.path, label: kind === 'total' ? null : (node.path[depth] ?? null), cells, total };
    if (grand) share(line, grand, columns);
    return line;
  };

  // Columns: in order, then capped. The grand total (before shares) orders them and is every share's whole.
  const colSort = input.colSort ?? input.spec?.colSort;
  const unordered: PivotColumn[] = [...colValues].map(([key, value]) => ({ key, value }));
  const grand = lineOf(root, 'total', unordered);
  const allColumns = unordered
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      if (colSort?.by) {
        const av = grand.cells[a.c.key]?.[colSort.by]?.value ?? null;
        const bv = grand.cells[b.c.key]?.[colSort.by]?.value ?? null;
        if (av === null || bv === null) return av === bv ? compareCells(a.c.value, b.c.value) : av === null ? 1 : -1;
        return (colSort.dir === 'desc' ? bv - av : av - bv) || compareCells(a.c.value, b.c.value);
      }
      return (colSort?.dir === 'desc' ? -1 : 1) * compareCells(a.c.value, b.c.value) || a.i - b.i;
    })
    .map((x) => x.c);
  const columnCount = allColumns.length;
  const columns = allColumns.slice(0, maxColumns);
  if (columnCount > columns.length) notes.push(`Showing the first ${columns.length} of ${columnCount} columns; the totals count every column.`);

  // Rows: sorted among their siblings on what is shown, groups (with their subtotals) above their rows.
  const sort = input.sort ?? input.spec?.sort;
  const sortValue = (line: PivotLine): number | null => {
    const v = sort!.col !== undefined ? line.cells[sort!.col]?.[sort!.by] : line.total[sort!.by];
    return v?.shown ?? null;
  };
  const ordered = (nodes: Node[], kind: PivotLine['kind']): Array<{ node: Node; line: PivotLine }> =>
    nodes
      .map((node) => ({ node, line: lineOf(node, kind, columns, grand) }))
      .sort((a, b) => {
        if (sort?.by) {
          const av = sortValue(a.line);
          const bv = sortValue(b.line);
          if (av !== null || bv !== null) {
            if (av === null) return 1;
            if (bv === null) return -1;
            const d = sort.dir === 'desc' ? bv - av : av - bv;
            if (d) return d;
          }
          return compareCells(a.line.label, b.line.label);
        }
        return (sort?.dir === 'desc' ? -1 : 1) * compareCells(a.line.label, b.line.label);
      });

  const lines: PivotLine[] = [];
  let rowCount = 0;
  let shownRows = 0;
  const countLeaves = (node: Node): number => (node.path.length === k ? 1 : [...node.children.values()].reduce((n, c) => n + countLeaves(c), 0));
  const walk = (node: Node) => {
    const atLeaf = node.path.length === k - 1;
    for (const { node: child, line } of ordered([...node.children.values()], atLeaf ? 'leaf' : 'group')) {
      if (atLeaf) {
        rowCount++;
        if (shownRows < maxRows) {
          lines.push(line);
          shownRows++;
        }
        continue;
      }
      line.open = !input.collapsed?.has(line.id);
      line.size = countLeaves(child);
      if (shownRows < maxRows) lines.push(line);
      if (line.open) walk(child);
      else rowCount += line.size;
    }
  };
  walk(root);
  if (shownRows >= maxRows && rowCount > shownRows) notes.push(`Showing the first ${shownRows} rows of ${rowCount}; the totals count every row.`);

  const total = lineOf(root, 'total', columns, grand);
  return { columns, columnCount, lines, total, rowCount, notes };
}

/**
 * Heat shading for one measure: 0 for the lowest shown value in its scope, 1 for the highest, keyed
 * `${line.id}\u0000${column key}` (column key '' for the total column of a one-way table). Only leaf
 * cells are shaded; subtotal and total lines are not part of any scope.
 */
export function heatLevels(grid: PivotGrid, measure: string, mode: PivotHeat): Map<string, number> {
  const out = new Map<string, number>();
  const leaves = grid.lines.filter((l) => l.kind === 'leaf');
  const oneWay = grid.columns.length === 0;
  const cols = oneWay ? [''] : grid.columns.map((c) => c.key);
  const get = (l: PivotLine, c: string) => (oneWay ? l.total[measure]?.shown : l.cells[c]?.[measure]?.shown) ?? null;
  const scopes: Array<Array<[PivotLine, string]>> = [];
  if (mode === 'table' || (oneWay && mode === 'row')) scopes.push(leaves.flatMap((l) => cols.map((c) => [l, c] as [PivotLine, string])));
  else if (mode === 'row') for (const l of leaves) scopes.push(cols.map((c) => [l, c]));
  else for (const c of cols) scopes.push(leaves.map((l) => [l, c]));
  for (const scope of scopes) {
    const vals = scope.map(([l, c]) => get(l, c)).filter((v): v is number => v !== null);
    if (!vals.length) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    for (const [l, c] of scope) {
      const v = get(l, c);
      if (v === null) continue;
      out.set(`${l.id}\u0000${c}`, hi === lo ? 0.5 : (v - lo) / (hi - lo));
    }
  }
  return out;
}

export interface PivotTableText {
  /** A field value as text (dates by grain, blanks). */
  dim: (field: string, v: Cell) => string;
  /** A measure's value as text; `share` when it is a percentage. */
  num: (measure: string, v: number | null, share: boolean) => string;
  fieldLabel: (field: string) => string;
  measureLabel: (measure: string) => string;
}

export interface PivotTableOut {
  /** Value columns carry their measure, and whether they hold shares. */
  columns: Array<{ label: string; numeric: boolean; measure?: string; share?: boolean }>;
  rows: Array<Array<{ text: string; value: string | number | boolean | null }>>;
}

/**
 * The pivoted grid as one flat table for files (CSV, Excel and the rest): one column per row field,
 * then one per (column value, measure) and the row totals; subtotal lines and the grand total included,
 * every group open. A total that cannot be had is written as an em dash.
 */
export function pivotTable(grid: PivotGrid, input: Pick<PivotInput, 'rows' | 'column' | 'measures' | 'spec'>, t: PivotTableText): PivotTableOut {
  const many = input.measures.length > 1;
  const share = (m: string) => (input.spec?.show?.[m] ?? 'value') !== 'value' && canShare(input.measures.find((x) => x.key === m)!.agg);
  const head = (col: string, m: string) => (many ? `${col} · ${t.measureLabel(m)}` : col);
  const columns: PivotTableOut['columns'] = input.rows.map((f) => ({ label: t.fieldLabel(f), numeric: false }));
  if (input.column) {
    for (const c of grid.columns) for (const m of input.measures) columns.push({ label: head(t.dim(input.column, c.value), m.key), numeric: true, measure: m.key, share: share(m.key) });
    for (const m of input.measures) columns.push({ label: many ? `Total · ${t.measureLabel(m.key)}` : 'Total', numeric: true, measure: m.key, share: share(m.key) });
  } else for (const m of input.measures) columns.push({ label: t.measureLabel(m.key), numeric: true, measure: m.key, share: share(m.key) });
  const value = (m: string, v: PivotValue | undefined) => {
    const n = v?.shown ?? null;
    return { text: n === null && v?.why ? '—' : t.num(m, n, share(m)), value: n };
  };
  const line = (l: PivotLine) => {
    const out: PivotTableOut['rows'][number] = input.rows.map((f, i) => {
      if (l.kind === 'total') return { text: i === 0 ? 'Grand total' : '', value: null };
      if (i <= l.depth) return { text: t.dim(f, l.path[i] ?? null), value: l.path[i] ?? null };
      return { text: l.kind === 'group' && i === l.depth + 1 ? 'Subtotal' : '', value: null };
    });
    if (input.column) for (const c of grid.columns) for (const m of input.measures) out.push(value(m.key, l.cells[c.key]?.[m.key]));
    for (const m of input.measures) out.push(value(m.key, l.total[m.key]));
    return out;
  };
  return { columns, rows: [...grid.lines.map(line), line(grid.total)] };
}

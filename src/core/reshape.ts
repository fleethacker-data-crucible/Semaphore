// Cleaning steps that make new fields or a new table, kept in the catalog like every other step:
//
//   split    "split full name on the comma into last and first"     new fields, one per part
//   merge    "join city and state with ', ' as location"            one new field
//   bucket   "group days open into 0-7, 8-30, 31-90, 90+"           one new field of labels
//            "bucket cost into quartiles"                            equal-count groups (NTILE)
//   unpivot  "turn the month columns Jan..Dec into rows of month and value"
//            a new long table: the table's other columns, the column's name, its value
//
// The source data is never changed. A made field (Field.derived = the step's id) is computed
// wherever it is read: in Semaphore's own SQL as an expression over its inputs, for every dialect,
// and in the in-page engine by the same rules. A reshaped table is a derived table (UNION ALL of one
// SELECT per column) in SQL and a list of rows built from the stored table in the page.
//
// One rule everywhere: a part, a merged value or a label that comes out blank is null.

import type { CatalogIndex, Dialect, Field } from './catalog.ts';
import { type CleaningStep, cleanSql, cleanType, cleanValue, dedupes, stepsFor } from './cleaning.ts';
import type { Cell } from './crossfilter.ts';

type Rec = Record<string, Cell> | undefined;
type Bind = (value: string | number, type: 'string' | 'number') => string;
export type Thunk = () => string;

/** At most this many parts from a delimiter split (the SQL of some dialects doubles per part). */
export const SPLIT_MAX = 4;
export const BUCKETS_MAX = 20;
export const UNPIVOT_MAX = 60;
const DEPTH_MAX = 6;

export interface Bucket {
  label: string;
  /** from <= value < to; either may be left open. */
  from?: number;
  to?: number;
}

export class ReshapeError extends Error {}

/** The step that makes a computed field (split, merge, bucket), and which part of it the field is. */
export function makerOf(index: CatalogIndex, key: string): { step: CleaningStep; part: number } | null {
  const f = index.field(key);
  if (!f?.derived) return null;
  const step = (index.catalog.cleaning ?? []).find((s) => s.id === f.derived);
  if (!step || step.kind === 'unpivot') return null;
  return { step, part: Math.max(0, (step.into ?? []).indexOf(key)) };
}

/** The unpivot step that makes a table, when the table is a reshaped one. */
export function reshapedTable(index: CatalogIndex, source: string, table: string): CleaningStep | null {
  return (index.catalog.cleaning ?? []).find((s) => s.kind === 'unpivot' && s.table === table && index.field(s.field)?.source === source) ?? null;
}

/** The stored tables behind a list of tables (a reshaped table reads its original). */
export function storedTables(index: CatalogIndex, source: string, tables: readonly string[]): string[] {
  return [...new Set(tables.map((t) => {
    const step = reshapedTable(index, source, t);
    return step ? index.field(step.field)!.table : t;
  }))];
}

/** The inputs a step reads. */
export function inputsOf(step: CleaningStep): string[] {
  return step.kind === 'merge' || step.kind === 'unpivot' ? (step.fields ?? [step.field]) : [step.field];
}

// ---------------------------------------------------------------------------------------------
// In the page.

/**
 * A reader for one field over a record of its table: the stored column, or a made field computed
 * from its inputs, then the field's own cleaning steps (unless `raw`). `rowsOf` gives a table's rows
 * for equal-count buckets, which rank every row of their table.
 */
export function fieldReader(index: CatalogIndex, key: string, raw: boolean, rowsOf: (table: string) => ReadonlyArray<Record<string, Cell>>, depth = 0): (rec: Rec) => Cell {
  const f = index.field(key);
  if (!f) throw new ReshapeError(`Unknown field "${key}".`);
  if (depth > DEPTH_MAX) throw new ReshapeError(`"${f.label}" is made from fields made from fields too many times over.`);
  const made = makerOf(index, key);
  let read: (rec: Rec) => Cell = (rec) => rec?.[f.column] ?? null;
  if (made) {
    const { step, part } = made;
    const ins = inputsOf(step).map((k) => fieldReader(index, k, raw, rowsOf, depth + 1));
    const one = ins[0]!;
    switch (step.kind) {
      case 'split':
        read = (rec) => splitPart(one(rec), step, part);
        break;
      case 'merge':
        read = (rec) => mergeValues(ins.map((g) => g(rec)), step.separator ?? ' ');
        break;
      case 'bucket':
        if (step.tiles) {
          let rank: ((v: number) => number) | null = null;
          read = (rec) => {
            const v = toNum(one(rec));
            if (v === null) return null;
            rank ??= tileRanker(rowsOf(f.table).map((r) => toNum(one(r))), step.tiles!);
            return tileLabel(rank(v), step.tiles!);
          };
        } else read = (rec) => bucketOf(toNum(one(rec)), step.buckets ?? []);
        break;
      default:
        break;
    }
  }
  const steps = raw ? [] : stepsFor(index, key);
  return steps.length ? (rec) => cleanValue(steps, read(rec)) : read;
}

export function splitPart(v: Cell, step: CleaningStep, part: number): Cell {
  if (v === null) return null;
  const s = String(v);
  let piece: string | undefined;
  if (step.widths?.length) {
    const start = step.widths.slice(0, part).reduce((n, w) => n + w, 0);
    piece = part < step.widths.length ? s.slice(start, start + step.widths[part]!) : s.slice(start);
  } else piece = s.split(step.delimiter ?? ',')[part];
  const t = piece?.trim();
  return t ? t : null;
}

export function mergeValues(values: readonly Cell[], separator: string): Cell {
  const parts = values.map((v) => (v === null ? '' : String(v).trim())).filter(Boolean);
  return parts.length ? parts.join(separator) : null;
}

export function bucketOf(v: number | null, buckets: readonly Bucket[]): Cell {
  if (v === null) return null;
  for (const b of buckets) if ((b.from === undefined || v >= b.from) && (b.to === undefined || v < b.to)) return b.label;
  return null;
}

/** Labels of equal-count groups: Q1…Q4 for quartiles, "1 of 5"… otherwise. */
export function tileLabel(tile: number, tiles: number): string {
  return tiles === 4 ? `Q${tile}` : `${tile} of ${tiles}`;
}

/**
 * NTILE(k) over the non-blank values in ascending order: the first n mod k groups hold one row more.
 * A value shared by several rows takes the group of its first row.
 */
export function tileRanker(values: ReadonlyArray<number | null>, k: number): (v: number) => number {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = sorted.length;
  const q = Math.floor(n / k);
  const r = n % k;
  const tileAt = (i: number) => (i < r * (q + 1) ? Math.floor(i / (q + 1)) + 1 : r + Math.floor((i - r * (q + 1)) / Math.max(q, 1)) + 1);
  return (v) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(k, tileAt(Math.min(lo, n - 1)));
  };
}

/** Upper bounds of each group but the last, from the values and their counts (for Access, which has no NTILE). */
export function tileBounds(values: ReadonlyArray<{ value: Cell; count: number }>, k: number): number[] {
  const all: number[] = [];
  for (const v of values) {
    const n = toNum(v.value);
    if (n !== null) for (let i = 0; i < Math.min(v.count, 100_000); i++) all.push(n);
  }
  const rank = tileRanker(all, k);
  const bounds: number[] = [];
  for (const v of [...new Set(all)].sort((a, b) => a - b)) {
    const t = rank(v);
    if (t < k) bounds[t - 1] = v;
  }
  for (let i = 0; i < k - 1; i++) bounds[i] ??= i ? bounds[i - 1]! : -Infinity;
  return bounds.slice(0, k - 1).map((b) => (Number.isFinite(b) ? b : 0));
}

/** The rows of a reshaped table, from its stored table's rows. */
export function unpivotRows(index: CatalogIndex, step: CleaningStep, rows: ReadonlyArray<Record<string, Cell>>): Array<Record<string, Cell>> {
  const none = (): ReadonlyArray<Record<string, Cell>> => [];
  const keep = keptFields(index, step).map((k) => ({ col: index.field(k.made)!.column, get: fieldReader(index, k.from, false, none) }));
  const cols = (step.fields ?? []).map((k, i) => ({ name: step.names?.[i] ?? index.field(k)?.label ?? k, get: fieldReader(index, k, false, none) }));
  const [nameKey, valueKey] = step.into ?? [];
  const nameCol = index.field(nameKey ?? '')?.column ?? 'name';
  const valueCol = index.field(valueKey ?? '')?.column ?? 'value';
  const out: Array<Record<string, Cell>> = [];
  for (const c of cols) {
    for (const r of rows) {
      const row: Record<string, Cell> = {};
      for (const k of keep) row[k.col] = k.get(r);
      row[nameCol] = c.name;
      row[valueCol] = c.get(r);
      out.push(row);
    }
  }
  return out;
}

/** The fields a reshaped table carries over from its stored table: (made key, original key). */
export function keptFields(index: CatalogIndex, step: CleaningStep): Array<{ made: string; from: string }> {
  const into = new Set(step.into ?? []);
  const out: Array<{ made: string; from: string }> = [];
  for (const f of index.catalog.fields) {
    if (f.derived !== step.id || into.has(f.key)) continue;
    const from = index.catalog.fields.find((o) => o.source === f.source && o.table === index.field(step.field)?.table && o.column === f.column && !o.derived);
    if (from) out.push({ made: f.key, from: from.key });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// SQL. Values (delimiters, separators, bounds, labels) are bound parameters; part positions and
// lengths are whole numbers Semaphore works out itself. Every expression is a thunk, so a value
// written twice is bound twice, in the order the "?" dialects read the text.

/** A text expression of a column of any type. */
export function textSql(x: Thunk, type: string, dialect: Dialect): Thunk {
  if (type === 'string') return x;
  if (dialect === 'access') return () => `IIf(${x()} Is Null, Null, CStr(${x()}))`;
  if (dialect === 'oracle') return () => `TO_CHAR(${x()})`;
  const as = { postgres: 'TEXT', sqlite: 'TEXT', tsql: 'NVARCHAR(4000)', synapse: 'NVARCHAR(4000)', spark: 'STRING', mysql: 'CHAR', ansi: 'VARCHAR' }[dialect];
  // These write a whole double as "30.0"; the page (and the other dialects) write "30".
  if (type === 'number' && (dialect === 'sqlite' || dialect === 'spark' || dialect === 'ansi')) {
    const int = dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
    return () => `CASE WHEN ${x()} = CAST(${x()} AS ${int}) THEN CAST(CAST(${x()} AS ${int}) AS ${as}) ELSE CAST(${x()} AS ${as}) END`;
  }
  return () => `CAST(${x()} AS ${as})`;
}

/** Trimmed, and null when blank. */
function blankNull(x: Thunk, dialect: Dialect): string {
  return dialect === 'access' ? `IIf(Trim(${x()}) = '', Null, Trim(${x()}))` : `NULLIF(TRIM(${x()}), '')`;
}

function substr(x: string, start: string | number, length: string | number | null, dialect: Dialect): string {
  if (dialect === 'access') return length === null ? `Mid(${x}, ${start})` : `Mid(${x}, ${start}, ${length})`;
  if (dialect === 'tsql' || dialect === 'synapse') return `SUBSTRING(${x}, ${start}, ${length ?? 4000})`;
  if (dialect === 'mysql') return length === null ? `SUBSTRING(${x}, ${start})` : `SUBSTRING(${x}, ${start}, ${length})`;
  return length === null ? `SUBSTR(${x}, ${start})` : `SUBSTR(${x}, ${start}, ${length})`;
}

export function splitSql(step: CleaningStep, part: number, x: Thunk, dialect: Dialect, bind: Bind): string {
  if (step.widths?.length) {
    const start = 1 + step.widths.slice(0, part).reduce((n, w) => n + w, 0);
    const len = part < step.widths.length ? step.widths[part]! : null;
    return blankNull(() => substr(x(), start, len, dialect), dialect);
  }
  const delim = step.delimiter ?? ',';
  const d = () => bind(delim, 'string');
  const L = delim.length;
  const n = part + 1;
  switch (dialect) {
    case 'postgres':
    case 'spark':
    case 'ansi':
      return blankNull(() => `SPLIT_PART(${x()}, ${d()}, ${n})`, dialect);
    case 'mysql':
      return `CASE WHEN (CHAR_LENGTH(${x()}) - CHAR_LENGTH(REPLACE(${x()}, ${d()}, ''))) / ${L} >= ${n - 1} THEN ${blankNull(() => `SUBSTRING_INDEX(SUBSTRING_INDEX(${x()}, ${d()}, ${n}), ${d()}, -1)`, dialect)} END`;
    case 'oracle': {
      const at = (k: number) => `INSTR(${x()}, ${d()}, 1, ${k})`;
      const start = () => (n === 1 ? '1' : `${at(n - 1)} + ${L}`);
      const body = () => `TRIM(SUBSTR(${x()}, ${start()}, CASE WHEN ${at(n)} = 0 THEN LENGTH(${x()}) + 1 ELSE ${at(n)} END - (${start()})))`;
      return n === 1 ? body() : `CASE WHEN ${at(n - 1)} > 0 THEN ${body()} END`;
    }
    default: {
      // T-SQL, Synapse, SQLite and Access: the text after each delimiter in turn, then what comes before the next.
      // Each piece is written left to right, so values are bound in the order they appear.
      const find = (r: Thunk, needle: Thunk): string => (dialect === 'sqlite' ? `instr(${r()}, ${needle()})` : dialect === 'access' ? `InStr(${r()}, ${needle()})` : `CHARINDEX(${needle()}, ${r()})`);
      const cat = (a: Thunk, b: Thunk): Thunk => () => (dialect === 'access' ? `${a()} & ${b()}` : dialect === 'sqlite' ? `${a()} || ${b()}` : `${a()} + ${b()}`);
      const rest = (r: Thunk): Thunk =>
        dialect === 'access' ? () => `IIf(${find(r, d)} = 0, Null, Mid(${r()}, ${find(r, d)} + ${L}))` : () => substr(r(), `NULLIF(${find(r, d)}, 0) + ${L}`, null, dialect);
      let r: Thunk = x;
      for (let i = 1; i < n; i++) r = rest(r);
      const at = r;
      const head = () => (dialect === 'sqlite' ? `substr(${at()}, 1, ${find(cat(at, d), d)} - 1)` : `LEFT(${at()}, ${find(cat(at, d), d)} - 1)`);
      return blankNull(head, dialect);
    }
  }
}

export function mergeSql(inputs: readonly Thunk[], separator: string, dialect: Dialect, bind: Bind): string {
  // Each present value with the separator in front, then the first separator cut off.
  const s = () => bind(separator, 'string');
  const piece = (v: Thunk): string => {
    if (dialect === 'access') return `IIf(${blankNull(v, dialect)} Is Null, '', ${s()} & ${blankNull(v, dialect)})`;
    if (dialect === 'oracle') return `NVL2(${blankNull(v, dialect)}, ${s()} || ${blankNull(v, dialect)}, '')`;
    if (dialect === 'mysql' || dialect === 'spark') return `COALESCE(CONCAT(${s()}, ${blankNull(v, dialect)}), '')`;
    if (dialect === 'tsql' || dialect === 'synapse') return `COALESCE(${s()} + ${blankNull(v, dialect)}, '')`;
    return `COALESCE(${s()} || ${blankNull(v, dialect)}, '')`;
  };
  const joined = (): string => {
    const ps = inputs.map(piece);
    if (dialect === 'access') return ps.join(' & ');
    if (dialect === 'mysql' || dialect === 'spark') return `CONCAT(${ps.join(', ')})`;
    if (dialect === 'tsql' || dialect === 'synapse') return ps.join(' + ');
    return ps.join(' || ');
  };
  const cut = () => substr(joined(), separator.length + 1, null, dialect);
  return dialect === 'access' ? `IIf(${cut()} = '', Null, ${cut()})` : `NULLIF(${cut()}, '')`;
}

export function bucketSql(step: CleaningStep, x: Thunk, dialect: Dialect, bind: Bind): string {
  if (step.tiles) {
    const k = step.tiles;
    const labels = Array.from({ length: k }, (_, i) => tileLabel(i + 1, k));
    if (dialect === 'access') {
      // No NTILE: the group bounds read from the data when the step was accepted.
      const bounds = step.bounds ?? [];
      const arms = () => [...bounds.map((b, i) => `${x()} <= ${bind(b, 'number')}, ${bind(labels[i]!, 'string')}`), `True, ${bind(labels[k - 1]!, 'string')}`].join(', ');
      return `IIf(${x()} Is Null, Null, Switch(${arms()}))`;
    }
    const tile = () => `NTILE(${k}) OVER (PARTITION BY CASE WHEN ${x()} IS NULL THEN 1 ELSE 0 END ORDER BY ${x()})`;
    return `CASE WHEN ${x()} IS NULL THEN NULL ELSE CASE ${tile()} ${labels.map((l, i) => `WHEN ${i + 1} THEN ${bind(l, 'string')}`).join(' ')} END END`;
  }
  const buckets = (step.buckets ?? []).slice(0, BUCKETS_MAX);
  if (!buckets.length) return 'NULL';
  const cond = (b: Bucket): string => {
    const parts = [...(b.from !== undefined ? [`${x()} >= ${bind(b.from, 'number')}`] : []), ...(b.to !== undefined ? [`${x()} < ${bind(b.to, 'number')}`] : [])];
    return parts.length ? parts.join(dialect === 'access' ? ' And ' : ' AND ') : dialect === 'access' ? 'True' : '1 = 1';
  };
  if (dialect === 'access') return `Switch(${buckets.map((b) => `${cond(b)}, ${bind(b.label, 'string')}`).join(', ')})`;
  return `CASE ${buckets.map((b) => `WHEN ${cond(b)} THEN ${bind(b.label, 'string')}`).join(' ')} END`;
}

/**
 * A field's expression for a query: the stored column (`stored`), or a made field built from its
 * inputs, then its own cleaning steps (unless `raw`).
 */
export function fieldSql(index: CatalogIndex, key: string, raw: boolean, stored: (key: string) => string, dialect: Dialect, bind: Bind, depth = 0): Thunk {
  const f = index.field(key);
  if (!f) throw new ReshapeError(`Unknown field "${key}".`);
  if (depth > DEPTH_MAX) throw new ReshapeError(`"${f.label}" is made from fields made from fields too many times over.`);
  const made = makerOf(index, key);
  let expr: Thunk = () => stored(key);
  if (made) {
    const { step, part } = made;
    const ins = inputsOf(step).map((k) => fieldSql(index, k, raw, stored, dialect, bind, depth + 1));
    const type = (k: string) => (raw ? (index.field(k)?.type ?? 'string') : cleanType(index, k));
    if (step.kind === 'split') {
      const x = textSql(ins[0]!, type(step.field), dialect);
      expr = () => splitSql(step, part, x, dialect, bind);
    } else if (step.kind === 'merge') {
      const xs = inputsOf(step).map((k, i) => textSql(ins[i]!, type(k), dialect));
      expr = () => mergeSql(xs, step.separator ?? ' ', dialect, bind);
    } else if (step.kind === 'bucket') expr = () => bucketSql(step, ins[0]!, dialect, bind);
  }
  const steps = raw ? [] : stepsFor(index, key);
  if (!steps.length) return expr;
  return () => cleanSql(steps, expr, dialect, bind);
}

/**
 * A reshaped table as a derived table: one SELECT per column turned into rows, joined with UNION ALL.
 * `q` quotes a name; `table` is the stored table, already quoted (or deduplicated).
 */
export function unpivotSql(index: CatalogIndex, step: CleaningStep, dialect: Dialect, bind: Bind, q: (name: string) => string, table: Thunk): string {
  const keep = keptFields(index, step);
  const [nameKey, valueKey] = step.into ?? [];
  const nameCol = q(index.field(nameKey ?? '')?.column ?? 'name');
  const valueCol = q(index.field(valueKey ?? '')?.column ?? 'value');
  const stored = (k: string) => q(index.field(k)!.column);
  const text = (i: number): string => {
    const p = bind(step.names?.[i] ?? index.field(step.fields?.[i] ?? '')?.label ?? '', 'string');
    if (dialect === 'access' || dialect === 'sqlite' || dialect === 'mysql') return p;
    return `CAST(${p} AS ${dialect === 'oracle' ? 'VARCHAR2(200)' : dialect === 'spark' ? 'STRING' : dialect === 'tsql' || dialect === 'synapse' ? 'NVARCHAR(200)' : 'VARCHAR(200)'})`;
  };
  const selects = (step.fields ?? []).map((k, i) => () => {
    const cols = keep.map((x) => `${fieldSql(index, x.from, false, stored, dialect, bind)()} AS ${q(index.field(x.made)!.column)}`);
    return `SELECT ${[...cols, `${text(i)} AS ${nameCol}`, `${fieldSql(index, k, false, stored, dialect, bind)()} AS ${valueCol}`].join(', ')} FROM ${table()}`;
  });
  return `(${selects.map((s) => s()).join(' UNION ALL ')})`;
}

/** Whether a field is, or is made from, an equal-count bucket (ranked over every row of its table). */
export function usesTiles(index: CatalogIndex, key: string, depth = 0): boolean {
  const made = makerOf(index, key);
  if (!made || depth > DEPTH_MAX) return false;
  return (made.step.kind === 'bucket' && !!made.step.tiles) || inputsOf(made.step).some((k) => usesTiles(index, k, depth + 1));
}

/** Whether a table's rows are deduplicated first (the reshaped table follows its stored table). */
export function dedupesStored(index: CatalogIndex, step: CleaningStep): boolean {
  const f = index.field(step.field);
  return !!f && dedupes(index, f.source, f.table);
}

function toNum(v: Cell): number | null {
  if (v === null || typeof v === 'boolean' || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** New field names for made fields: unique keys in the table and safe column names. */
export function newField(index: CatalogIndex, base: Pick<Field, 'source' | 'table'>, label: string, type: Field['type'], derived: string, taken: Set<string>): Field {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'part';
  const columns = new Set(index.catalog.fields.filter((f) => f.source === base.source && f.table === base.table).map((f) => f.column));
  let column = /^[a-z_]/.test(slug) ? slug : `f_${slug}`;
  for (let i = 2; columns.has(column) || taken.has(`${base.table}.${column}`); i++) column = `${column.replace(/_\d+$/, '')}_${i}`;
  taken.add(`${base.table}.${column}`);
  let key = `${base.table}.${column}`;
  for (let i = 2; index.field(key) || index.metric(key); i++) key = `${base.table}.${column}_${i}`;
  return { key, label, source: base.source, table: base.table, column, type, derived };
}

/** Problems with the steps that make fields or tables, for checkCatalog. */
export function checkReshape(catalog: { fields: Field[]; cleaning?: CleaningStep[] }): string[] {
  const problems: string[] = [];
  const fields = new Map(catalog.fields.map((f) => [f.key, f]));
  const steps = new Map((catalog.cleaning ?? []).map((s) => [s.id, s]));
  for (const f of catalog.fields) {
    if (f.derived && !steps.has(f.derived)) problems.push(`Field "${f.key}" was made by cleaning step "${f.derived}", which is not in the catalog.`);
  }
  for (const s of catalog.cleaning ?? []) {
    if (s.kind !== 'split' && s.kind !== 'merge' && s.kind !== 'bucket' && s.kind !== 'unpivot') continue;
    const first = fields.get(s.field);
    const into = s.into ?? [];
    const inputs = s.kind === 'merge' || s.kind === 'unpivot' ? (s.fields ?? []) : [s.field];
    if (!first) continue; // reported by checkCatalog
    for (const k of inputs) {
      const f = fields.get(k);
      if (!f) problems.push(`Cleaning step "${s.id}" names unknown field "${k}".`);
      else if (f.source !== first.source || f.table !== first.table) problems.push(`Cleaning step "${s.id}" reads fields of different tables.`);
      if (into.includes(k)) problems.push(`Cleaning step "${s.id}" reads a field it makes.`);
    }
    for (const k of into) {
      const f = fields.get(k);
      if (!f || f.derived !== s.id) problems.push(`Cleaning step "${s.id}" makes field "${k}", which is not in the catalog as its field.`);
      else if (s.kind !== 'unpivot' && (f.source !== first.source || f.table !== first.table)) problems.push(`Field "${k}" must be in the table of the field it is made from.`);
    }
    if (s.kind === 'split') {
      const n = into.length;
      if (s.widths?.length) {
        if (!s.widths.every((w) => Number.isInteger(w) && w > 0 && w < 4000) || s.widths.length !== n - 1) problems.push(`Cleaning step "${s.id}" splits by position with part lengths that do not fit its ${n} parts.`);
      } else if (!s.delimiter || s.delimiter.length > 10) problems.push(`Cleaning step "${s.id}" splits on a delimiter of 1 to 10 characters.`);
      if (n < 2 || (!s.widths?.length && n > SPLIT_MAX) || n > 8) problems.push(`Cleaning step "${s.id}" splits into ${n} parts; a split makes 2 to ${SPLIT_MAX} (8 by position).`);
    } else if (s.kind === 'merge') {
      if (inputs.length < 2 || inputs.length > 6 || into.length !== 1) problems.push(`Cleaning step "${s.id}" joins 2 to 6 fields into one.`);
      if ((s.separator ?? ' ').length > 10) problems.push(`Cleaning step "${s.id}" puts more than 10 characters between values.`);
    } else if (s.kind === 'bucket') {
      if (into.length !== 1) problems.push(`Cleaning step "${s.id}" makes one field of groups.`);
      if (s.tiles !== undefined) {
        if (!Number.isInteger(s.tiles) || s.tiles < 2 || s.tiles > 10) problems.push(`Cleaning step "${s.id}" makes 2 to 10 equal-count groups.`);
      } else if (!s.buckets?.length || s.buckets.length > BUCKETS_MAX || s.buckets.some((b) => !b.label || (b.from !== undefined && !Number.isFinite(b.from)) || (b.to !== undefined && !Number.isFinite(b.to)))) {
        problems.push(`Cleaning step "${s.id}" needs 1 to ${BUCKETS_MAX} groups, each with a name and number bounds.`);
      }
    } else {
      const names = s.names ?? [];
      if (inputs.length < 2 || inputs.length > UNPIVOT_MAX || names.length !== inputs.length) problems.push(`Cleaning step "${s.id}" turns 2 to ${UNPIVOT_MAX} columns, each with a name, into rows.`);
      if (!s.table || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s.table)) problems.push(`Cleaning step "${s.id}" names its new table with letters, digits and underscores only.`);
      else if (catalog.fields.some((f) => f.source === first.source && f.table === s.table && f.derived !== s.id)) problems.push(`Cleaning step "${s.id}" makes table "${s.table}", which already exists.`);
      if (into.length !== 2) problems.push(`Cleaning step "${s.id}" makes a name field and a value field.`);
    }
  }
  return problems;
}

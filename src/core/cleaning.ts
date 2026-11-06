// Cleaning steps: the fixes an analyst accepted for messy data, kept in the catalog and applied
// wherever a field is read, in Semaphore's own SQL and in the in-page engine alike. The source data
// is never changed. Each step reads as a sentence, so a reviewer can see what was done and undo it.
//
// Steps on one field always apply in the same order, whatever order they were accepted in:
// trim, then map, then blank-as, then number or date.

import type { CatalogIndex, Dialect, FieldType } from './catalog.ts';
import type { Cell } from './crossfilter.ts';

export type CleaningKind = 'trim' | 'map' | 'blank-as' | 'number' | 'date' | 'dedupe';

export interface CleaningStep {
  id: string;
  /** The field cleaned; for dedupe, any field of the table (the table is what is deduplicated). */
  field: string;
  kind: CleaningKind;
  /** map: stored value → value to use. */
  map?: Record<string, string>;
  /** blank-as: what a blank means. */
  value?: string | number;
  /** date: how day and month are ordered in the stored text. */
  order?: 'mdy' | 'dmy' | 'ymd';
  /** The step in plain words: "Read “N.E.” and “north east” as “Northeast”". */
  sentence: string;
  origin?: 'analyst' | 'rules' | 'ai' | 'qlik';
}

export class CleaningError extends Error {}

const ORDER: Record<CleaningKind, number> = { dedupe: 0, trim: 1, map: 2, 'blank-as': 3, number: 4, date: 4 };
export const MAP_MAX = 200;

export function stepsFor(index: CatalogIndex, fieldKey: string): CleaningStep[] {
  return (index.catalog.cleaning ?? []).filter((s) => s.field === fieldKey && s.kind !== 'dedupe').sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/** Whether a table's rows are deduplicated before anything is counted. */
export function dedupes(index: CatalogIndex, source: string, table: string): boolean {
  return (index.catalog.cleaning ?? []).some((s) => {
    if (s.kind !== 'dedupe') return false;
    const f = index.field(s.field);
    return !!f && f.source === source && f.table === table;
  });
}

/** The type a field has once cleaned: text holding numbers becomes a number, text dates a date. */
export function cleanType(index: CatalogIndex, fieldKey: string): FieldType {
  const f = index.field(fieldKey);
  if (!f) return 'string';
  for (const s of stepsFor(index, fieldKey)) {
    if (s.kind === 'number') return 'number';
    if (s.kind === 'date') return 'date';
  }
  return f.type;
}

/** One value through a field's steps, for data held in the page. */
export function cleanValue(steps: readonly CleaningStep[], raw: Cell): Cell {
  let v = raw;
  for (const s of steps) {
    switch (s.kind) {
      case 'trim':
        if (typeof v === 'string') v = v.trim().replace(/\s{2,}/g, ' ');
        break;
      case 'map':
        if (v !== null && s.map && Object.hasOwn(s.map, String(v))) v = s.map[String(v)]!;
        break;
      case 'blank-as':
        if (v === null || v === '') v = s.value ?? null;
        break;
      case 'number':
        v = toNumber(v);
        break;
      case 'date':
        v = toIsoDate(v, s.order ?? 'mdy');
        break;
      case 'dedupe':
        break;
    }
  }
  return v;
}

export function toNumber(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[$,\s]/g, '');
  const negative = /^\(.*\)$/.test(s);
  if (negative) s = s.slice(1, -1);
  if (!/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Text dates in mixed formats to YYYY-MM-DD; null when the text is not a real date. */
export function toIsoDate(v: Cell, order: 'mdy' | 'dmy' | 'ymd'): string | null {
  if (v === null || typeof v === 'boolean') return null;
  const s = String(v).trim();
  let y: number;
  let m: number;
  let d: number;
  let hit: RegExpExecArray | null;
  if ((hit = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/.exec(s))) [d, m, y] = [Number(hit[1]), MONTHS.indexOf(hit[2]!.toLowerCase()) + 1, Number(hit[3])];
  else if ((hit = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(s))) [m, d, y] = [MONTHS.indexOf(hit[1]!.toLowerCase()) + 1, Number(hit[2]), Number(hit[3])];
  else if ((hit = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/.exec(s))) {
    const [a, b, c] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (hit[1]!.length === 4) [y, m, d] = [a, b, c];
    else if (order === 'dmy') [d, m, y] = [a, b, c];
    else [m, d, y] = [a, b, c];
  } else return null;
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * A column expression with the field's steps applied, for one dialect. Values in the steps are
 * bound parameters, like every other value Semaphore sends.
 */
export function cleanSql(steps: readonly CleaningStep[], col: string, dialect: Dialect, bind: (value: string | number, type: 'string' | 'number') => string): string {
  // Several steps write the incoming expression more than once (CASE x … ELSE x, IIf(x …, x)). The
  // expression is rebuilt, and its values bound again, each time it is written, so with positional
  // "?" placeholders the parameters stay in the order the markers appear in the text.
  let x: () => string = () => col;
  for (const s of steps) {
    const prev = x;
    switch (s.kind) {
      case 'trim':
        x = () => `TRIM(${prev()})`;
        break;
      case 'map': {
        const pairs = Object.entries(s.map ?? {}).slice(0, MAP_MAX);
        if (!pairs.length) break;
        if (dialect === 'access') x = () => `Switch(${pairs.map(([from, to]) => `${prev()} = ${bind(from, 'string')}, ${bind(to, 'string')}`).join(', ')}, True, ${prev()})`;
        else x = () => `CASE ${prev()} ${pairs.map(([from, to]) => `WHEN ${bind(from, 'string')} THEN ${bind(to, 'string')}`).join(' ')} ELSE ${prev()} END`;
        break;
      }
      case 'blank-as': {
        const value = s.value ?? '';
        const type = typeof value === 'number' ? 'number' : 'string';
        if (dialect === 'access') x = type === 'number' ? () => `IIf(${prev()} Is Null, ${bind(value, type)}, ${prev()})` : () => `IIf(${prev()} Is Null Or ${prev()} = '', ${bind(value, type)}, ${prev()})`;
        else x = type === 'number' ? () => `COALESCE(${prev()}, ${bind(value, type)})` : () => `COALESCE(NULLIF(${prev()}, ''), ${bind(value, type)})`;
        break;
      }
      case 'number':
        x = () => numberSql(prev, dialect);
        break;
      case 'date':
        throw new CleaningError('Mixed date formats are cleaned in data held in the page only; ask for the column to be fixed at the source.');
      case 'dedupe':
        break;
    }
  }
  return x();
}

function numberSql(x: () => string, dialect: Dialect): string {
  const bare = (): string => `REPLACE(REPLACE(${x()}, ',', ''), '$', '')`;
  switch (dialect) {
    case 'ansi':
    case 'spark':
      return `TRY_CAST(${bare()} AS DOUBLE)`;
    case 'tsql':
    case 'synapse':
      return `TRY_CAST(${bare()} AS FLOAT)`;
    case 'oracle':
      return `TO_NUMBER(${bare()} DEFAULT NULL ON CONVERSION ERROR)`;
    case 'access':
      return `IIf(IsNumeric(${bare()}), CDbl(${bare()}), Null)`;
    case 'postgres':
      return `CASE WHEN ${bare()} ~ '^\\s*-?[0-9]*\\.?[0-9]+\\s*$' THEN CAST(${bare()} AS DOUBLE PRECISION) END`;
  }
}

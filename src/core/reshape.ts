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

import type { CatalogIndex, Field } from './catalog.ts';
import type { CleaningStep } from './cleaning.ts';


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

// The readers and SQL for made fields and reshaped tables (reshape-impl.ts) load only for a catalog
// that has such steps: the page loads them before it runs a query (web/src/lib/data.ts), the worker
// and the tests register them up front.
type Impl = typeof import('./reshape-impl.ts');
let impl: Impl | null = null;

export function registerReshaping(i: Impl): void {
  impl = i;
}

export function reshaping(): Impl {
  if (!impl) throw new ReshapeError('Fields made by cleaning steps are still loading; try again in a moment.');
  return impl;
}

/** Whether a catalog has steps that make fields or tables. */
export function hasMaking(catalog: { cleaning?: CleaningStep[] }): boolean {
  return (catalog.cleaning ?? []).some((s) => s.kind === 'split' || s.kind === 'merge' || s.kind === 'bucket' || s.kind === 'unpivot');
}

/** Loads the readers and SQL when the catalog needs them. */
export async function loadReshaping(catalog: { cleaning?: CleaningStep[] }): Promise<void> {
  if (!impl && hasMaking(catalog)) registerReshaping(await import('./reshape-impl.ts'));
}

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


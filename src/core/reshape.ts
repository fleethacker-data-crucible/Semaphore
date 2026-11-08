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

/**
 * The catalog check for these steps that runs at load: every made field names a step that is in the
 * catalog. The full check of each step (checkReshape, reshape-impl.ts) runs before any of them is
 * read, and when one is proposed.
 */
export function checkMade(catalog: { fields: Field[]; cleaning?: CleaningStep[] }): string[] {
  const ids = new Set((catalog.cleaning ?? []).map((s) => s.id));
  return catalog.fields.filter((f) => f.derived && !ids.has(f.derived)).map((f) => `Field "${f.key}" was made by cleaning step "${f.derived}", which is not in the catalog.`);
}

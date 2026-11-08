// The CSV worker: CSV files are parsed and kept here, off the page's thread, and flags over them are
// answered here, so a file of a million rows never freezes the page. Only small results go back
// (aggregated rows, value counts, a profile). Same code as the page would run: src/core.

import { type Catalog, indexCatalog } from '../../src/core/catalog.ts';
import { checkCsvSize, readCsv } from '../../src/core/csv.ts';
import { runPlan, type TableRows } from '../../src/core/engine.ts';
import type { QueryPlan } from '../../src/core/planner.ts';
import { registerReshaping } from '../../src/core/reshape.ts';
import * as reshapingImpl from '../../src/core/reshape-impl.ts';

// Fields made by cleaning steps are read here too, so their code is part of the worker.
registerReshaping(reshapingImpl);
import { countValues, findDuplicates } from '../../src/core/quality.ts';

// No prototype: a table name can only ever be a table, never Object's machinery (csv.ts also
// prefixes such names, so this is the second lock on the same door).
const tables: TableRows = Object.create(null) as TableRows;

type Request =
  | { id: number; type: 'load'; name: string; blob: Blob }
  | { id: number; type: 'drop'; name: string }
  | { id: number; type: 'clear' }
  | { id: number; type: 'run'; plan: QueryPlan; catalog: Catalog; today: string }
  | { id: number; type: 'values'; table: string; column: string }
  | { id: number; type: 'duplicates'; catalog: Catalog; source: string; table: string };

async function answer(m: Request): Promise<unknown> {
  switch (m.type) {
    case 'load': {
      // The Blob is read here, so the page never holds the text; it is let go once the rows are built.
      checkCsvSize(m.blob.size);
      const t = readCsv(m.name, await m.blob.text());
      tables[t.name] = t.rows;
      return { name: t.name, rows: t.rows.length, columns: t.columns, profile: t.profile, notes: t.notes };
    }
    case 'drop':
      delete tables[m.name];
      return true;
    case 'clear':
      for (const k of Object.keys(tables)) delete tables[k];
      return true;
    case 'run':
      return runPlan(m.plan, indexCatalog(m.catalog), tables, new Date(m.today));
    case 'values':
      return countValues(tables[m.table] ?? [], m.column);
    case 'duplicates':
      return findDuplicates(indexCatalog(m.catalog), m.source, m.table, tables[m.table] ?? []);
  }
}

// The page tsconfig has the DOM library, not the WebWorker one: the two members used here, typed.
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown): void };

// One request at a time, in order: a flag asked for while a file is still being read waits for it.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  queue = queue.then(() => answer(m)).then(
    (value) => scope.postMessage({ id: m.id, ok: true, value }),
    (err: Error) => scope.postMessage({ id: m.id, ok: false, error: err.message, name: err.name }),
  );
};

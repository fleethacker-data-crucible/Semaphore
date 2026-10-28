// The CSV worker: CSV files are parsed and kept here, off the page's thread, and flags over them are
// answered here, so a file of a million rows never freezes the page. Only small results go back
// (aggregated rows, value counts, a profile). Same code as the page would run: src/core.

import { type Catalog, indexCatalog } from '../../src/core/catalog.ts';
import { readCsv } from '../../src/core/csv.ts';
import { runPlan, type TableRows } from '../../src/core/engine.ts';
import type { QueryPlan } from '../../src/core/planner.ts';
import { countValues, findDuplicates } from '../../src/core/quality.ts';

const tables: TableRows = {};

type Request =
  | { id: number; type: 'load'; name: string; text: string }
  | { id: number; type: 'drop'; name: string }
  | { id: number; type: 'clear' }
  | { id: number; type: 'run'; plan: QueryPlan; catalog: Catalog; today: string }
  | { id: number; type: 'values'; table: string; column: string }
  | { id: number; type: 'duplicates'; catalog: Catalog; source: string; table: string };

function answer(m: Request): unknown {
  switch (m.type) {
    case 'load': {
      const t = readCsv(m.name, m.text);
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

scope.onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  try {
    scope.postMessage({ id: m.id, ok: true, value: answer(m) });
  } catch (err) {
    scope.postMessage({ id: m.id, ok: false, error: (err as Error).message, name: (err as Error).name });
  }
};

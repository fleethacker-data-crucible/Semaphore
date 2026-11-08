// Each person's SQL language (Settings > SQL): the dialect they read and write. Generated SQL is shown
// in it, and SQL they write in the SQL desk is translated from it into the source's dialect before it
// runs (src/core/sql-translate.ts). 'source' means as each source speaks, with no translation.
// Kept in this browser.

import { useSyncExternalStore } from 'react';
import { type Dialect, isSqlDialect } from '../../../src/core/catalog.ts';

export type SqlPref = Dialect | 'source';

const KEY = 'semaphore.sqlLanguage';
const listeners = new Set<() => void>();

export function readSqlPref(): SqlPref {
  try {
    const v = localStorage.getItem(KEY);
    return isSqlDialect(v) ? v : 'source';
  } catch {
    return 'source';
  }
}

export function setSqlPref(pref: SqlPref): void {
  try {
    if (pref === 'source') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const l of listeners) l();
}

export function useSqlPref(): SqlPref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readSqlPref,
    () => 'source' as const,
  );
}

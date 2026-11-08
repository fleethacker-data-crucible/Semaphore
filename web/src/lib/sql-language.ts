import type { CatalogIndex, Dialect } from '../../../src/core/catalog.ts';
import type { QueryPlan } from '../../../src/core/planner.ts';
import { type RenderedSql, renderSql } from '../../../src/core/sql.ts';
import type { SqlPref } from './sql-pref.ts';

const languages: Record<Dialect, { name: string; syntax: string }> = {
  postgres: { name: 'PostgreSQL', syntax: 'Double quotes name columns and tables. date_trunc groups dates; LIMIT caps rows.' },
  oracle: { name: 'Oracle SQL', syntax: 'Double quotes name columns and tables. TRUNC groups dates; FETCH FIRST caps rows.' },
  access: { name: 'Microsoft Access SQL', syntax: 'Square brackets name columns and tables. DateSerial and DatePart group dates; TOP caps rows.' },
  tsql: { name: 'T-SQL (SQL Server / Azure SQL)', syntax: 'Square brackets name columns and tables. TOP caps rows. Date grouping uses DATETRUNC and requires SQL Server 2022+ or a compatible Azure SQL engine.' },
  synapse: { name: 'T-SQL (Azure Synapse)', syntax: 'Square brackets name columns and tables. TOP caps rows. Synapse has no DATETRUNC, so dates group with DATEADD and DATEDIFF.' },
  spark: { name: 'Spark SQL (Foundry, Databricks)', syntax: 'Backticks name columns and tables. date_trunc groups dates; LIMIT caps rows. Foundry takes no bound values, so Semaphore writes each value as a checked literal.' },
  ansi: { name: 'ANSI-like SQL profile', syntax: 'This profile uses double-quoted names, date_trunc and LIMIT. It is not universal ANSI SQL; confirm those features with your database.' },
};

export function sqlLanguage(sql: RenderedSql): { name: string; syntax: string; parameters: string } {
  const language = languages[sql.dialect];
  const parameters = sql.params.length === 0
    ? 'This query has no bound values.'
    : sql.sql.includes('?')
      ? '? marks a value supplied separately, in order, by the database driver. The parameters below are not pasted into the SQL.'
      : sql.dialect === 'postgres'
        ? '$1, $2 and so on mark values supplied separately. The parameters below are not pasted into the SQL.'
        : sql.dialect === 'oracle'
          ? ':p1, :p2 and so on mark values supplied separately. The parameters below are not pasted into the SQL.'
          : '@p1, @p2 and so on mark values supplied separately. The parameters below are not pasted into the SQL.';
  return { ...language, parameters };
}

/**
 * The flag's SQL as the person reads it: in their SQL language (Settings > SQL) when they chose one
 * and it differs from the source's, else as it runs. `runs` is always what the source receives.
 */
export function shownSql(runs: RenderedSql, plan: QueryPlan, index: CatalogIndex, today: Date, pref: SqlPref): { shown: RenderedSql; translated: boolean } {
  if (pref === 'source' || pref === runs.dialect) return { shown: runs, translated: false };
  try {
    return { shown: renderSql(plan, index, today, { dialect: pref }), translated: true };
  } catch {
    return { shown: runs, translated: false };
  }
}

export const dialectName = (d: Dialect): string => languages[d].name;

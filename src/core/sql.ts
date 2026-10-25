// Renders a query plan as SQL for one database dialect.
//
// Safety rules: identifiers come only from the catalog, are checked by isIdentifier() and are
// always quoted; every value is a bound parameter, never text spliced into the SQL. The local
// server binds the parameters with the driver's own API.

import { type CatalogIndex, type Dialect, isIdentifier } from './catalog.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import type { PlannedAggregate, PlannedDimension, QueryPlan } from './planner.ts';

export interface SqlParam {
  value: string | number;
  type: 'string' | 'number' | 'date';
}

export interface RenderedSql {
  dialect: Dialect;
  sql: string;
  params: SqlParam[];
}

export class SqlError extends Error {}

export function renderSql(plan: QueryPlan, index: CatalogIndex, today: Date = new Date()): RenderedSql {
  const source = index.source(plan.source);
  if (!source) throw new SqlError(`Unknown source "${plan.source}".`);
  const dialect = source.dialect;
  const params: SqlParam[] = [];
  const bind = (p: SqlParam): string => {
    params.push(p);
    const n = params.length;
    return dialect === 'postgres' ? `$${n}` : dialect === 'oracle' ? `:p${n}` : '?';
  };

  const column = (fieldKey: string): string => {
    const f = index.field(fieldKey);
    if (!f) throw new SqlError(`Unknown field "${fieldKey}".`);
    if (f.table !== plan.table || f.source !== plan.source) throw new SqlError(`Field "${fieldKey}" is not in ${plan.table}.`);
    return quote(f.column, dialect);
  };

  const dimExpr = (d: PlannedDimension): string => (d.grain ? truncate(column(d.field), d.grain, dialect) : column(d.field));
  const aggExpr = (a: PlannedAggregate): string => {
    const col = a.field === null ? '*' : column(a.field);
    if (a.fn === 'count_distinct') {
      if (dialect === 'access') throw new SqlError('Access has no COUNT(DISTINCT …); use a count metric or another source.');
      if (col === '*') throw new SqlError('A distinct count needs a field.');
      return `COUNT(DISTINCT ${col})`;
    }
    if (col === '*' && a.fn !== 'count') throw new SqlError(`${a.fn} needs a field.`);
    return `${a.fn.toUpperCase()}(${col})`;
  };

  const select = [
    ...plan.dimensions.map((d) => `${dimExpr(d)} AS ${quote(d.alias, dialect)}`),
    ...plan.aggregates.map((a) => `${aggExpr(a)} AS ${quote(a.alias, dialect)}`),
  ];
  if (select.length === 0) throw new SqlError('Nothing to select.');

  const where = plan.filters.map((f) => filterSql(f, column(f.field), bind, today));
  const groupBy = plan.dimensions.map(dimExpr);

  let orderBy = '';
  if (plan.sort) {
    const dim = plan.dimensions.find((d) => d.key === plan.sort!.by);
    const metric = plan.metrics.find((m) => m.key === plan.sort!.by);
    let expr: string | null = null;
    if (dim) expr = dimExpr(dim);
    else if (metric) {
      const alias = metric.parts.sum ?? metric.parts.count ?? metric.parts.min ?? metric.parts.max ?? metric.parts.distinct;
      const a = plan.aggregates.find((x) => x.alias === alias);
      // avg sorts by its sum; that matches only within one group size, so it is ordered locally too.
      if (a) expr = aggExpr(a);
    }
    if (expr) orderBy = ` ORDER BY ${expr} ${plan.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  }

  const limit = Math.max(1, Math.floor(plan.limit));
  const table = quoteTable(plan.table, dialect);
  let sql = `SELECT ${dialect === 'access' ? `TOP ${limit} ` : ''}${select.join(', ')} FROM ${table}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (groupBy.length && plan.aggregates.length) sql += ` GROUP BY ${groupBy.join(', ')}`;
  // A flag with fields and no metrics (a filter list) asks for the distinct values.
  else if (groupBy.length) sql = sql.replace(/^SELECT /, 'SELECT DISTINCT ');
  sql += orderBy;
  if (dialect === 'postgres' || dialect === 'ansi') sql += ` LIMIT ${limit}`;
  else if (dialect === 'oracle') sql += ` FETCH FIRST ${limit} ROWS ONLY`;
  return { dialect, sql, params };
}

function filterSql(f: Filter, col: string, bind: (p: SqlParam) => string, today: Date): string {
  const p = (v: string | number): string => bind({ value: v, type: typeof v === 'number' ? 'number' : 'string' });
  switch (f.op) {
    case 'eq':
      return `${col} = ${p(f.values[0]!)}`;
    case 'in':
      return `${col} IN (${f.values.map(p).join(', ')})`;
    case 'gte':
      return `${col} >= ${p(f.values[0]!)}`;
    case 'lte':
      return `${col} <= ${p(f.values[0]!)}`;
    case 'between':
      return `${col} >= ${p(f.values[0]!)} AND ${col} <= ${p(f.values[1]!)}`;
    case 'last': {
      const n = f.values[0];
      if (typeof n !== 'number' || !f.unit) throw new SqlError('A "last" filter needs a count and a unit.');
      return `${col} >= ${bind({ value: periodStart(today, f.unit, n - 1), type: 'date' })}`;
    }
  }
}

/**
 * Start of the period `back` periods before the one containing `today`, as YYYY-MM-DD (UTC).
 * "Last 12 months" is the current month plus the 11 before it.
 */
export function periodStart(today: Date, unit: TimeGrain, back: number): string {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  let date: Date;
  switch (unit) {
    case 'day':
      date = new Date(Date.UTC(y, m, d - back));
      break;
    case 'week': {
      const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
      date = new Date(Date.UTC(y, m, d - dow - 7 * back));
      break;
    }
    case 'month':
      date = new Date(Date.UTC(y, m - back, 1));
      break;
    case 'quarter':
      date = new Date(Date.UTC(y, Math.floor(m / 3) * 3 - 3 * back, 1));
      break;
    case 'year':
      date = new Date(Date.UTC(y - back, 0, 1));
      break;
  }
  return date.toISOString().slice(0, 10);
}

export function quote(name: string, dialect: Dialect): string {
  if (!isIdentifier(name) || name.includes('.')) throw new SqlError(`Unsafe identifier "${name}".`);
  return dialect === 'access' ? `[${name}]` : `"${name}"`;
}

function quoteTable(name: string, dialect: Dialect): string {
  if (!isIdentifier(name)) throw new SqlError(`Unsafe table name "${name}".`);
  return name
    .split('.')
    .map((part) => quote(part, dialect))
    .join('.');
}

/** Truncate a date column to the start of its period. Weeks start on Monday everywhere. */
export function truncate(col: string, grain: TimeGrain, dialect: Dialect): string {
  if (dialect === 'oracle') {
    const fmt = { day: 'DD', week: 'IW', month: 'MM', quarter: 'Q', year: 'YYYY' }[grain];
    return `TRUNC(${col}, '${fmt}')`;
  }
  if (dialect === 'access') {
    switch (grain) {
      case 'day':
        return `DateValue(${col})`;
      case 'week':
        return `DateAdd('d', 1 - Weekday(${col}, 2), DateValue(${col}))`;
      case 'month':
        return `DateSerial(Year(${col}), Month(${col}), 1)`;
      case 'quarter':
        return `DateSerial(Year(${col}), (DatePart('q', ${col}) - 1) * 3 + 1, 1)`;
      case 'year':
        return `DateSerial(Year(${col}), 1, 1)`;
    }
  }
  return `date_trunc('${grain}', ${col})`;
}

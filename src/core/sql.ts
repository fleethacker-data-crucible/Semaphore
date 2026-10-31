// Renders a query plan as SQL for one database dialect.
//
// Safety rules: identifiers come only from the catalog, are checked by isIdentifier() and are
// always quoted; every value is a bound parameter, never text spliced into the SQL. The local
// server binds the parameters with the driver's own API.

import { type CatalogIndex, type Dialect, type FieldType, isIdentifier, isSqlDialect } from './catalog.ts';
import { cleanSql, cleanType, dedupes, stepsFor } from './cleaning.ts';
import { aliasOf, BASE_ALIAS } from './joins.ts';
import { MANY_ALIAS, manyJoinSql, manyParts, renderManyBlock, type SqlKit } from './manyjoin.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import type { PlannedAggregate, PlannedDimension, QueryPlan } from './planner.ts';

export interface SqlParam {
  /** Dates are YYYY-MM-DD; the server binds them as real date values. */
  value: string | number | boolean;
  type: 'string' | 'number' | 'date' | 'boolean';
}

export interface RenderedSql {
  dialect: Dialect;
  sql: string;
  params: SqlParam[];
}

export class SqlError extends Error {}

export interface RenderOptions {
  /**
   * `native` uses the dialect's own markers ($1, :p1, @p1, ?). `question` uses ? everywhere,
   * for ODBC and OLE DB, which bind positionally whatever the database.
   */
  placeholders?: 'native' | 'question';
}

export function renderSql(plan: QueryPlan, index: CatalogIndex, today: Date = new Date(), options: RenderOptions = {}): RenderedSql {
  const source = index.source(plan.source);
  if (!source) throw new SqlError(`Unknown source "${plan.source}".`);
  const dialect = source.dialect;
  if (!isSqlDialect(dialect)) throw new SqlError('This source uses an unsupported SQL dialect. Configure a supported SQL profile before generating a query.');
  const params: SqlParam[] = [];
  const bind = (p: SqlParam): string => {
    params.push(p);
    const n = params.length;
    if (options.placeholders === 'question') return '?';
    return dialect === 'postgres' ? `$${n}` : dialect === 'oracle' ? `:p${n}` : dialect === 'tsql' || dialect === 'synapse' ? `@p${n}` : '?';
  };

  const joins = plan.joins ?? [];
  const dedupe = !plan.raw && dedupes(index, plan.source, plan.table);
  // Columns are qualified by table alias whenever more than one table, or a subquery, is read.
  const aliased = joins.length > 0 || dedupe || !!plan.many;
  // A one-to-many split reads the many side through a derived table of distinct pairs (manyjoin.ts).
  const many = plan.many ? manyParts(plan, index) : null;
  const kit: SqlKit = { quote, quoteTable, truncate, filterSql, SqlError };
  // Oracle takes no AS before a table alias; the others accept it.
  const as = (alias: string) => `${dialect === 'oracle' ? '' : 'AS '}${quote(alias, dialect)}`;
  const stored = (fieldKey: string): string => {
    const f = index.field(fieldKey);
    if (!f) throw new SqlError(`Unknown field "${fieldKey}".`);
    const alias = f.source === plan.source ? aliasOf(plan.table, joins, f.table) : undefined;
    if (!alias) throw new SqlError(`Field "${fieldKey}" is not in ${plan.table} or a table joined to it.`);
    return aliased ? `${quote(alias, dialect)}.${quote(f.column, dialect)}` : quote(f.column, dialect);
  };
  const typeOf = (fieldKey: string): FieldType => (plan.raw ? (index.field(fieldKey)?.type ?? 'string') : cleanType(index, fieldKey));

  let from = quoteTable(plan.table, dialect);
  if (dedupe) from = `(SELECT DISTINCT * FROM ${from}) ${as(BASE_ALIAS)}`;
  else if (aliased) from = `${from} ${as(BASE_ALIAS)}`;
  for (const j of joins) {
    const on = `${quote(j.left.alias, dialect)}.${quote(j.left.column, dialect)} = ${quote(j.alias, dialect)}.${quote(j.column, dialect)}`;
    const joined = `LEFT JOIN ${quoteTable(j.table, dialect)} ${as(j.alias)} ON ${on}`;
    // Access needs each join but the last wrapped: FROM ((a LEFT JOIN b ON …) LEFT JOIN c ON …).
    from = dialect === 'access' && j !== joins[0] ? `(${from}) ${joined}` : `${from} ${joined}`;
  }

  // The derived table is added after the cleaning columns are written, because the "?" dialects
  // need values bound in the order they appear in the text.
  const withMany = (f: string): string => {
    if (!plan.many) return f;
    const j = manyJoinSql(plan, renderManyBlock(plan, index, dialect, bind, today, kit), dialect, kit);
    return dialect === 'access' && joins.length > 0 ? `(${f}) ${j}` : `${f} ${j}`;
  };

  // Cleaning steps are applied once, in an inner query, and everything else reads its columns.
  // Repeating a cleaned expression in GROUP BY would bind its values twice, and Postgres would not
  // accept "CASE x WHEN $1 …" in SELECT as the same expression as "CASE x WHEN $5 …" in GROUP BY.
  const used = [
    ...new Set([
      ...plan.dimensions.filter((d) => !many?.owns(d.field)).map((d) => d.field),
      ...plan.aggregates.flatMap((a) => (a.field ? [a.field] : [])),
      ...plan.filters.filter((f) => !many?.owns(f.field)).map((f) => f.field),
    ]),
  ];
  const inner = new Map<string, string>();
  if (!plan.raw && used.some((k) => stepsFor(index, k).length)) {
    const cols = used.map((k, i) => {
      inner.set(k, `c${i}`);
      const steps = stepsFor(index, k);
      let expr = stored(k);
      if (steps.length) {
        try {
          expr = cleanSql(steps, expr, dialect, (value, type) => bind({ value, type }));
        } catch (e) {
          throw new SqlError((e as Error).message);
        }
      }
      return `${expr} AS ${quote(`c${i}`, dialect)}`;
    });
    // The group values of the many side pass through unchanged (cleaned inside the derived table).
    for (const g of many?.dims ?? []) cols.push(`${quote(MANY_ALIAS, dialect)}.${quote(g.col, dialect)} AS ${quote(g.col, dialect)}`);
    from = `(SELECT ${cols.join(', ')} FROM ${withMany(from)}) ${as('q')}`;
  } else from = withMany(from);
  const column = (fieldKey: string): string => {
    if (!inner.size) return stored(fieldKey);
    const c = inner.get(fieldKey);
    if (!c) throw new SqlError(`Field "${fieldKey}" is not read by this query.`);
    return `${quote('q', dialect)}.${quote(c, dialect)}`;
  };

  const dimExpr = (d: PlannedDimension): string => {
    // Many-side group values arrive already cleaned and truncated to their grain.
    const g = many?.dims.find((x) => x.dim.alias === d.alias);
    if (g) return `${quote(inner.size ? 'q' : MANY_ALIAS, dialect)}.${quote(g.col, dialect)}`;
    return d.grain ? truncate(column(d.field), d.grain, dialect) : column(d.field);
  };
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

  // Filters on the many side already apply inside the derived table.
  const where = plan.filters.filter((f) => !many?.owns(f.field)).map((f) => filterSql(f, column(f.field), typeOf(f.field), bind, today));
  const groupBy = plan.dimensions.map(dimExpr);

  let orderBy = '';
  if (plan.sort) {
    const dim = plan.dimensions.find((d) => d.key === plan.sort!.by);
    const metric = plan.metrics.find((m) => m.key === plan.sort!.by);
    let expr: string | null = null;
    if (dim) expr = dimExpr(dim);
    else if (metric && metric.agg !== 'avg') {
      // An average is rebuilt locally from its sum and count, and sorted there; the planner never
      // cuts an average-ranked top N at the source.
      const alias = metric.parts.sum ?? metric.parts.count ?? metric.parts.min ?? metric.parts.max ?? metric.parts.distinct;
      const a = plan.aggregates.find((x) => x.alias === alias);
      if (a) expr = aggExpr(a);
    }
    if (expr) orderBy = ` ORDER BY ${expr} ${plan.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
  }

  const limit = Math.max(1, Math.floor(plan.limit));
  let sql = `SELECT ${dialect === 'access' || dialect === 'tsql' || dialect === 'synapse' ? `TOP ${limit} ` : ''}${select.join(', ')} FROM ${from}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (groupBy.length && plan.aggregates.length) sql += ` GROUP BY ${groupBy.join(', ')}`;
  // A flag with fields and no metrics (a filter list) asks for the distinct values.
  else if (groupBy.length) sql = sql.replace(/^SELECT /, 'SELECT DISTINCT ');
  sql += orderBy;
  if (dialect === 'postgres' || dialect === 'ansi') sql += ` LIMIT ${limit}`;
  else if (dialect === 'oracle') sql += ` FETCH FIRST ${limit} ROWS ONLY`;
  return { dialect, sql, params };
}

export function filterSql(f: Filter, col: string, type: FieldType, bind: (p: SqlParam) => string, today: Date): string {
  const p = (v: string | number): string => bind(typedParam(v, type));
  // On a date field, "up to 31 March" means the whole of 31 March, including times that day.
  const upTo = (v: string | number): string =>
    type === 'date' ? `${col} < ${bind({ value: nextDay(String(v)), type: 'date' })}` : `${col} <= ${p(v)}`;
  switch (f.op) {
    case 'eq':
      if (type === 'date') return `${col} >= ${p(f.values[0]!)} AND ${upTo(f.values[0]!)}`;
      return `${col} = ${p(f.values[0]!)}`;
    case 'in':
      return `${col} IN (${f.values.map(p).join(', ')})`;
    case 'gte':
      return `${col} >= ${p(f.values[0]!)}`;
    case 'lte':
      return upTo(f.values[0]!);
    case 'between':
      return `${col} >= ${p(f.values[0]!)} AND ${upTo(f.values[1]!)}`;
    case 'last': {
      const n = f.values[0];
      if (typeof n !== 'number' || !f.unit) throw new SqlError('A "last" filter needs a count and a unit.');
      return `${col} >= ${bind({ value: periodStart(today, f.unit, n - 1), type: 'date' })}`;
    }
  }
}

/** A filter value typed by its field, so drivers bind real dates and numbers. */
export function typedParam(v: string | number, type: FieldType): SqlParam {
  switch (type) {
    case 'date': {
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new SqlError(`"${s}" is not a date (YYYY-MM-DD).`);
      return { value: s, type: 'date' };
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n) || (typeof v === 'string' && v.trim() === '')) throw new SqlError(`"${v}" is not a number.`);
      return { value: n, type: 'number' };
    }
    case 'boolean': {
      const b = v === 1 || v === 'true' ? true : v === 0 || v === 'false' ? false : null;
      if (b === null) throw new SqlError(`"${v}" is not true or false.`);
      return { value: b, type: 'boolean' };
    }
    case 'string':
      return { value: String(v), type: 'string' };
  }
}

function nextDay(ymd: string): string {
  const { value } = typedParam(ymd, 'date');
  const d = new Date(`${value as string}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
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
  if (dialect === 'spark') return `\`${name}\``;
  return dialect === 'access' || dialect === 'tsql' || dialect === 'synapse' ? `[${name}]` : `"${name}"`;
}

export function quoteTable(name: string, dialect: Dialect): string {
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
  if (dialect === 'tsql') {
    // DATETRUNC is in Azure SQL and SQL Server 2022+. iso_week starts on Monday regardless of DATEFIRST.
    return `DATETRUNC(${grain === 'week' ? 'iso_week' : grain}, ${col})`;
  }
  if (dialect === 'synapse') {
    // Synapse pools have no DATETRUNC. DATEADD/DATEDIFF counts whole periods from a fixed origin; 1900-01-01 was a Monday.
    return grain === 'week' ? `DATEADD(week, DATEDIFF(day, '19000101', ${col}) / 7, '19000101')` : `DATEADD(${grain}, DATEDIFF(${grain}, 0, ${col}), 0)`;
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

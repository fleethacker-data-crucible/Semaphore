// The catalog is Semaphore's semantic layer: every source, field and metric is defined once,
// and flags refer to them by key. The AI and the planner only ever see the catalog, never rows.

import type { CleaningStep } from './cleaning.ts';
import type { Relationship } from './joins.ts';

/**
 * ansi covers engines with date_trunc and LIMIT: Athena, Redshift, DuckDB, Trino. tsql is Azure SQL / SQL Server 2022+.
 * synapse is T-SQL without DATETRUNC (Azure Synapse pools). spark is Spark SQL with backtick names (Palantir Foundry, Databricks).
 */
export const SQL_DIALECTS = ['postgres', 'oracle', 'access', 'tsql', 'synapse', 'spark', 'ansi'] as const;
export type Dialect = typeof SQL_DIALECTS[number];

export function isSqlDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}

export type SourceKind =
  | 'postgres'
  | 'oracle'
  | 'access'
  | 'csv'
  | 'aws-athena'
  | 'aws-redshift'
  | 'azure-sql'
  | 'azure-synapse'
  | 'foundry'
  /** Semaphore's built-in local database (server/LocalDb.ps1): SQLite, the engine that ships with Windows. */
  | 'local'
  | 'other';

/** The SQL profile a source kind uses; unknown kinds fall back to the ansi profile. */
export function dialectForKind(kind: SourceKind): Dialect {
  // TODO(sqlite dialect): map local to 'sqlite' once sql.ts and sql-translate.ts render SQLite; ansi until then.
  const map: Partial<Record<SourceKind, Dialect>> = { postgres: 'postgres', oracle: 'oracle', access: 'access', 'azure-sql': 'tsql', 'azure-synapse': 'synapse', foundry: 'spark', local: 'ansi' };
  return map[kind] ?? 'ansi';
}

export interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  dialect: Dialect;
  /** Name of the Lazarette vault item that holds the connection secret. Never the secret itself. */
  vaultItem?: string;
}

export type FieldType = 'number' | 'string' | 'date' | 'boolean';

export interface Field {
  /** Stable key, unique across the catalog, e.g. "orders.region". */
  key: string;
  label: string;
  source: string;
  table: string;
  column: string;
  type: FieldType;
  /** Distinct values, if profiled. The planner uses it to estimate result sizes. */
  cardinality?: number;
  synonyms?: string[];
}

export type Aggregate = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';

export interface Metric {
  key: string;
  label: string;
  agg: Aggregate;
  /** Field key the aggregate runs over. Omitted only for count, meaning count of rows. */
  field?: string;
  /** Table the metric counts rows of when `field` is omitted. */
  table?: string;
  source: string;
  format?: 'number' | 'currency' | 'percent';
  synonyms?: string[];
}

export interface Catalog {
  version: 1;
  sources: Source[];
  fields: Field[];
  metrics: Metric[];
  /** Many-to-one links between tables of one source (joins.ts). */
  relationships?: Relationship[];
  /** Accepted cleaning steps, applied wherever a field is read (cleaning.ts). */
  cleaning?: CleaningStep[];
  /** Drill paths for categories: ship class → hull (hoist flags drill along these). */
  hierarchies?: Hierarchy[];
}

export interface Hierarchy {
  id: string;
  label: string;
  /** Field keys, broadest first. */
  levels: string[];
}

export interface CatalogIndex {
  catalog: Catalog;
  source(id: string): Source | undefined;
  field(key: string): Field | undefined;
  metric(key: string): Metric | undefined;
}

export function indexCatalog(catalog: Catalog): CatalogIndex {
  const sources = new Map(catalog.sources.map((s) => [s.id, s]));
  const fields = new Map(catalog.fields.map((f) => [f.key, f]));
  const metrics = new Map(catalog.metrics.map((m) => [m.key, m]));
  return {
    catalog,
    source: (id) => sources.get(id),
    field: (key) => fields.get(key),
    metric: (key) => metrics.get(key),
  };
}

/** Table a metric reads from, whether it aggregates a field or counts rows. */
export function metricTable(index: CatalogIndex, metric: Metric): string | undefined {
  if (metric.field) return index.field(metric.field)?.table;
  return metric.table;
}

/** Problems that make a catalog unsafe to plan against. An empty list means it is usable. */
export function checkCatalog(catalog: Catalog): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const sourceIds = new Set(catalog.sources.map((s) => s.id));
  const expected: Partial<Record<Source['kind'], Dialect>> = { postgres: 'postgres', oracle: 'oracle', access: 'access', 'azure-sql': 'tsql', 'azure-synapse': 'synapse', 'aws-redshift': 'ansi', foundry: 'spark' };
  for (const s of catalog.sources) {
    if (!isSqlDialect(s.dialect)) problems.push(`Source "${s.id}" uses an unsupported SQL dialect; supported profiles: ${SQL_DIALECTS.join(', ')}.`);
    if (seen.has(`source:${s.id}`)) problems.push(`Duplicate source id "${s.id}".`);
    seen.add(`source:${s.id}`);
    const want = expected[s.kind];
    if (want && s.dialect !== want) problems.push(`Source "${s.id}" is ${s.kind} but uses the ${s.dialect} dialect; use ${want}.`);
  }
  const fieldKeys = new Set<string>();
  for (const f of catalog.fields) {
    if (fieldKeys.has(f.key)) problems.push(`Duplicate field key "${f.key}".`);
    fieldKeys.add(f.key);
    if (!sourceIds.has(f.source)) problems.push(`Field "${f.key}" names unknown source "${f.source}".`);
    if (!isIdentifier(f.table) || !isIdentifier(f.column)) {
      problems.push(`Field "${f.key}" has a table or column name Semaphore will not quote safely.`);
    }
  }
  const metricKeys = new Set<string>();
  for (const m of catalog.metrics) {
    if (metricKeys.has(m.key) || fieldKeys.has(m.key)) problems.push(`Duplicate key "${m.key}".`);
    metricKeys.add(m.key);
    if (!sourceIds.has(m.source)) problems.push(`Metric "${m.key}" names unknown source "${m.source}".`);
    if (m.field === undefined) {
      if (m.agg !== 'count') problems.push(`Metric "${m.key}" needs a field for ${m.agg}.`);
      if (!m.table || !isIdentifier(m.table)) problems.push(`Metric "${m.key}" counts rows but names no valid table.`);
    } else if (!fieldKeys.has(m.field)) {
      problems.push(`Metric "${m.key}" names unknown field "${m.field}".`);
    } else if (
      m.agg !== 'count' &&
      m.agg !== 'count_distinct' &&
      catalog.fields.find((f) => f.key === m.field)?.type !== 'number' &&
      !(catalog.cleaning ?? []).some((c) => c.field === m.field && c.kind === 'number')
    ) {
      problems.push(`Metric "${m.key}" uses ${m.agg} on a field that is not a number.`);
    }
  }
  for (const r of catalog.relationships ?? []) {
    if (!sourceIds.has(r.source)) problems.push(`Relationship "${r.id}" names unknown source "${r.source}".`);
    for (const c of [r.from, r.to]) {
      if (!isIdentifier(c.table) || !isIdentifier(c.column) || c.column.includes('.')) problems.push(`Relationship "${r.id}" has a table or column name Semaphore will not quote safely.`);
    }
    if (r.from.table === r.to.table) problems.push(`Relationship "${r.id}" joins "${r.from.table}" to itself.`);
  }
  for (const c of catalog.cleaning ?? []) {
    if (!fieldKeys.has(c.field)) problems.push(`Cleaning step "${c.id}" names unknown field "${c.field}".`);
  }
  for (const h of catalog.hierarchies ?? []) {
    if (h.levels.length < 2) problems.push(`Drill path "${h.label}" needs at least two levels.`);
    for (const l of h.levels) if (!fieldKeys.has(l)) problems.push(`Drill path "${h.label}" names unknown field "${l}".`);
  }
  return problems;
}

/**
 * Drops cleaning steps, drill paths and relationships that point at fields, tables or sources no
 * longer in the catalog (a CSV loaded again without a column, a source removed).
 */
export function pruneCatalog(catalog: Catalog): Catalog {
  const fields = new Set(catalog.fields.map((f) => f.key));
  const sources = new Set(catalog.sources.map((s) => s.id));
  const tables = new Set(catalog.fields.map((f) => `${f.source}|${f.table}`));
  const out: Catalog = { ...catalog };
  if (catalog.cleaning) out.cleaning = catalog.cleaning.filter((c) => fields.has(c.field));
  if (catalog.hierarchies) out.hierarchies = catalog.hierarchies.filter((h) => h.levels.every((l) => fields.has(l)));
  if (catalog.relationships) out.relationships = catalog.relationships.filter((r) => sources.has(r.source) && tables.has(`${r.source}|${r.from.table}`) && tables.has(`${r.source}|${r.to.table}`));
  return out;
}

/**
 * Table and column names come from profiling a source, not from users, but they are still
 * checked: only names that can be quoted without escaping reach generated SQL.
 * Letters, digits, underscore, space and a single dot for schema-qualified tables.
 */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_ ]{0,127}(\.[A-Za-z_][A-Za-z0-9_ ]{0,127})?$/.test(name);
}

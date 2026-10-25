// The catalog is Semaphore's semantic layer: every source, field and metric is defined once,
// and flags refer to them by key. The AI and the planner only ever see the catalog, never rows.

export type Dialect = 'postgres' | 'oracle' | 'access' | 'ansi';

export type SourceKind =
  | 'postgres'
  | 'oracle'
  | 'access'
  | 'csv'
  | 'aws-athena'
  | 'aws-redshift'
  | 'azure-sql'
  | 'foundry'
  | 'other';

export interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  dialect: Dialect;
  /** Name of the ARC vault item that holds the connection secret. Never the secret itself. */
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
  for (const s of catalog.sources) {
    if (seen.has(`source:${s.id}`)) problems.push(`Duplicate source id "${s.id}".`);
    seen.add(`source:${s.id}`);
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
    }
  }
  return problems;
}

/**
 * Table and column names come from profiling a source, not from users, but they are still
 * checked: only names that can be quoted without escaping reach generated SQL.
 * Letters, digits, underscore, space and a single dot for schema-qualified tables.
 */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_ ]{0,127}(\.[A-Za-z_][A-Za-z0-9_ ]{0,127})?$/.test(name);
}

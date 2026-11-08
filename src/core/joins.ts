// Relationships between tables, and the joins a flag needs to follow them.
//
// A relationship is many-to-one: each row of `from` (jobs) points at one row of `to` (ships) by a
// key column. A flag's measures stay on one table, its base; fields it groups or filters by may
// come from any table the base reaches by following relationships forward. Following them only
// from many to one means a join never repeats a base row, so totals stay right. The opposite
// direction (a measure on the one side, split by the many side) is manyjoin.ts.

import type { CatalogIndex } from './catalog.ts';

export interface ColumnRef {
  table: string;
  column: string;
}

export interface Relationship {
  id: string;
  source: string;
  /** The many side: the table holding the key (jobs.ship_id). */
  from: ColumnRef;
  /** The one side: the table the key identifies (ships.id). */
  to: ColumnRef;
  /** When it was discovered or checked: share of `from` values found in `to`, 0..1. */
  match?: number;
  /** Where it came from: a person, discovery, a Qlik association, or an imported dbt or Power BI model. */
  origin?: 'analyst' | 'discovered' | 'qlik' | 'dbt' | 'powerbi';
}

export interface PlannedJoin {
  table: string;
  alias: string;
  /** The alias and column on the side already joined. */
  left: { alias: string; column: string };
  /** The column on `table`. */
  column: string;
}

export const BASE_ALIAS = 't0';

/** Relationships of one source leaving `table`, in catalog order. */
function outgoing(index: CatalogIndex, source: string, table: string): Relationship[] {
  return (index.catalog.relationships ?? []).filter((r) => r.source === source && r.from.table === table);
}

/**
 * The chain of relationships from `base` to `table`, shortest first (breadth-first), or null when
 * `table` cannot be reached from `base` going many-to-one.
 */
export function joinPath(index: CatalogIndex, source: string, base: string, table: string): Relationship[] | null {
  if (base === table) return [];
  const seen = new Set([base]);
  const queue: Array<{ table: string; path: Relationship[] }> = [{ table: base, path: [] }];
  while (queue.length) {
    const at = queue.shift()!;
    for (const r of outgoing(index, source, at.table)) {
      if (seen.has(r.to.table)) continue;
      const path = [...at.path, r];
      if (r.to.table === table) return path;
      seen.add(r.to.table);
      queue.push({ table: r.to.table, path });
    }
  }
  return null;
}

export function reachable(index: CatalogIndex, source: string, base: string, table: string): boolean {
  return joinPath(index, source, base, table) !== null;
}

/** The joins that bring `tables` into a query on `base`, each table once, in a valid order. */
export function planJoins(index: CatalogIndex, source: string, base: string, tables: Iterable<string>): PlannedJoin[] {
  const joins: PlannedJoin[] = [];
  const alias = new Map<string, string>([[base, BASE_ALIAS]]);
  for (const t of tables) {
    const path = joinPath(index, source, base, t);
    if (!path) throw new Error(`"${t}" is not related to "${base}".`);
    for (const r of path) {
      if (alias.has(r.to.table)) continue;
      const a = `t${alias.size}`;
      joins.push({ table: r.to.table, alias: a, left: { alias: alias.get(r.from.table)!, column: r.from.column }, column: r.to.column });
      alias.set(r.to.table, a);
    }
  }
  return joins;
}

/** Alias of a table inside a joined query. */
export function aliasOf(base: string, joins: readonly PlannedJoin[], table: string): string | undefined {
  if (table === base) return BASE_ALIAS;
  return joins.find((j) => j.table === table)?.alias;
}

/** A readable sentence for a relationship: "Each job belongs to one ship (ship_id → id)". */
export function describeRelationship(r: Relationship): string {
  const name = (t: string) => t.split('.').at(-1)!.replace(/_/g, ' ');
  const one = (t: string) => name(t).replace(/ies$/, 'y').replace(/s$/, '');
  return `Each ${one(r.from.table)} row belongs to one ${one(r.to.table)} (${r.from.column} → ${r.to.column})`;
}

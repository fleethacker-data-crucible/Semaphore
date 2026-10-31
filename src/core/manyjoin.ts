// One-to-many joins: a measure on the one side (customers.credit_limit) split or filtered by a
// field on the many side (orders.status), without counting anything twice.
//
// A plain join would repeat each customer once per order, so a sum would be too big. Instead the
// many side is first reduced to the distinct (key, group values) pairs it holds, and that small
// derived table is joined to the one side. A customer then appears at most once per group, however
// many orders it has. The exact rules are in docs/ONE_TO_MANY_JOINS.md:
//
//   * a one-side row counts once in every group it has at least one many-side row in;
//   * a filter on the many side keeps one-side rows that have at least one matching many-side row;
//   * several many-side filters must hold on the same many-side row;
//   * with no filter, one-side rows with no many-side row land in the blank group;
//   * a split can put a row in several groups, so groups may add up to more than the true total.
//     That is warned about, and no total or share is built by adding such groups up.
//
// This file holds the planning half (which tables, which path, what to tell the analyst) and the
// in-page half (the same distinct set built from rows in memory). The SQL half is renderManyBlock().
// Neither half imports sql.ts or engine.ts: the helpers they need are passed in, so there are no
// import cycles.

import type { CatalogIndex, Dialect, FieldType } from './catalog.ts';
import { cleanSql, cleanType, cleanValue, stepsFor } from './cleaning.ts';
import type { Cell } from './crossfilter.ts';
import type { Filter, TimeGrain } from './hoist.ts';
import { BASE_ALIAS, type Relationship, reachable } from './joins.ts';
import type { PlannedDimension, QueryPlan } from './planner.ts';

/** Alias of the derived many-side table in SQL: columns "k" (the key) and "g0", "g1", … (group values). */
export const MANY_ALIAS = 'mx';
/** Most relationship hops searched from the one side to a many-side field. */
export const MAX_MANY_HOPS = 6;

export interface ManyStep {
  table: string;
  alias: string;
  /** reverse: toward more rows (one → many). forward: a many-to-one lookup from a many-side table. */
  direction: 'reverse' | 'forward';
  /** The alias and column already in the block. */
  left: { alias: string; column: string };
  /** The column on `table`. */
  column: string;
}

export interface ManyJoin {
  /** The first many-side table: the one that points at the base table. */
  root: {
    table: string;
    alias: string;
    /** Its column holding the base table's key (orders.customer_id). */
    column: string;
    /** The key column on the base (one-side) table (customers.id). */
    keyColumn: string;
  };
  /** Further tables of the many-side block, in join order. */
  steps: ManyStep[];
  /** Every table of the block (root first). The in-page worker needs all of them loaded. */
  tables: string[];
  /** Tables whose fields this query reads from the many side (groups and filters). */
  targets: string[];
  /** A split by a many-side field: a one-side row may appear in several groups. */
  overlap: boolean;
  /** A many-side filter: one-side rows with no matching many-side row are left out. */
  semi: boolean;
  /** The semantics in plain English, for the flag readback. */
  explain: string[];
  /** Cautions, also added to the plan's notes. */
  warnings: string[];
}

interface Hop {
  rel: Relationship;
  dir: 'reverse' | 'forward';
}

export type Reach =
  | { kind: 'base' | 'forward' | 'unrelated' }
  | { kind: 'many'; path: Hop[] }
  | { kind: 'ambiguous'; paths: string[] };

function relationshipsOf(index: CatalogIndex, source: string): Relationship[] {
  return (index.catalog.relationships ?? []).filter((r) => r.source === source);
}

/**
 * Every way from `base` to `target` that first goes one → many (against a relationship) and then
 * only many → one (with a relationship): customers ← orders → products. Never revisits a table.
 */
export function manyPaths(index: CatalogIndex, source: string, base: string, target: string): Hop[][] {
  const rels = relationshipsOf(index, source);
  const found: Hop[][] = [];
  const walk = (at: string, path: Hop[], seen: ReadonlySet<string>, reversing: boolean): void => {
    if (path.length >= MAX_MANY_HOPS) return;
    const step = (r: Relationship, dir: Hop['dir'], next: string) => {
      if (seen.has(next)) return;
      const hops = [...path, { rel: r, dir }];
      if (next === target) found.push(hops);
      else walk(next, hops, new Set([...seen, next]), dir === 'reverse');
    };
    if (reversing) for (const r of rels) if (r.to.table === at) step(r, 'reverse', r.from.table);
    if (path.length > 0) for (const r of rels) if (r.from.table === at) step(r, 'forward', r.to.table);
  };
  walk(base, [], new Set([base]), true);
  return found;
}

function hopText(h: Hop): string {
  return `${h.rel.from.table}.${h.rel.from.column} → ${h.rel.to.table}.${h.rel.to.column}`;
}

/**
 * How a table relates to the base of a query. Following relationships many-to-one from the base
 * (the existing rule) always wins. Only a table that cannot be reached that way is looked for on
 * the many side, and it must be reached in exactly one way: more than one is `ambiguous`.
 */
export function reachOf(index: CatalogIndex, source: string, base: string, table: string, manySide = true): Reach {
  if (table === base) return { kind: 'base' };
  if (reachable(index, source, base, table)) return { kind: 'forward' };
  if (!manySide) return { kind: 'unrelated' };
  const paths = manyPaths(index, source, base, table);
  if (paths.length === 0) return { kind: 'unrelated' };
  if (paths.length > 1) return { kind: 'ambiguous', paths: paths.map((p) => p.map(hopText).join(', then ')) };
  return { kind: 'many', path: paths[0]! };
}

/** Reach of each table, remembered for one query. */
export class ManyScope {
  private readonly seen = new Map<string, Reach>();
  private readonly index: CatalogIndex;
  readonly source: string;
  readonly base: string;
  private readonly manySide: boolean;

  constructor(index: CatalogIndex, source: string, base: string, manySide: boolean) {
    this.index = index;
    this.source = source;
    this.base = base;
    this.manySide = manySide;
  }

  reach(table: string): Reach {
    let r = this.seen.get(table);
    if (!r) {
      r = reachOf(this.index, this.source, this.base, table, this.manySide);
      this.seen.set(table, r);
    }
    return r;
  }

  /** Whether the table is on the many side of the base (read through the derived table). */
  isMany(table: string): boolean {
    return this.reach(table).kind === 'many';
  }

  /** A readable refusal when the field's table relates to the base in several ways, else null. */
  ambiguity(fieldKey: string): string | null {
    const f = this.index.field(fieldKey);
    if (!f || f.source !== this.source) return null;
    const r = this.reach(f.table);
    if (r.kind !== 'ambiguous') return null;
    return (
      `"${f.label}" is in ${f.table}, which relates to ${this.base} in ${r.paths.length} ways (${r.paths.join('; or ')}). ` +
      `Semaphore will not guess which one you mean, because each gives different answers. Remove the relationship you do not want under Data > Relationships, or build this flag on another table.`
    );
  }
}

export type ManyBuild = { ok: true; many: ManyJoin } | { ok: false; error: string };

export interface ManyUse {
  /** Labels of the many-side fields the query splits by (empty when it only filters). */
  splitBy: string[];
  /** Labels of the many-side fields the query filters by. */
  filterBy: string[];
}

/** The many-side block that brings `targets` into a query on `base`, or the reason it cannot. */
export function buildManyJoin(index: CatalogIndex, source: string, base: string, targets: readonly string[], use: ManyUse): ManyBuild {
  const scope = new ManyScope(index, source, base, true);
  const paths: Hop[][] = [];
  for (const t of targets) {
    const r = scope.reach(t);
    if (r.kind !== 'many') return { ok: false, error: `"${t}" is not on the many side of ${base}.` };
    paths.push(r.path);
  }
  const first = paths[0]![0]!;
  const sameRoot = paths.every((p) => p[0]!.rel === first.rel);
  if (!sameRoot) {
    const roots = [...new Set(paths.map((p) => p[0]!.rel.from.table))];
    return {
      ok: false,
      error:
        `The fields come from ${roots.length > 1 ? `different many-side tables of ${base} (${roots.join(' and ')})` : `${roots[0]} through different relationships`}. ` +
        `Splitting by two unrelated many-side tables at once would pair their rows up, so Semaphore refuses it. Use fields from one many-side table in a flag.`,
    };
  }
  const root: ManyJoin['root'] = { table: first.rel.from.table, alias: 'm0', column: first.rel.from.column, keyColumn: first.rel.to.column };
  const aliasOf = new Map<string, string>([[root.table, root.alias]]);
  const via = new Map<string, Hop>();
  const steps: ManyStep[] = [];
  for (const p of paths) {
    let parent = root.table;
    for (const h of p.slice(1)) {
      const table = h.dir === 'reverse' ? h.rel.from.table : h.rel.to.table;
      const known = via.get(table);
      if (table === root.table || (known && known.rel !== h.rel)) {
        return { ok: false, error: `${table} is reached in two different ways from ${base}. Semaphore will not guess which one you mean; remove one relationship under Data > Relationships.` };
      }
      if (!known) {
        const alias = `m${aliasOf.size}`;
        aliasOf.set(table, alias);
        via.set(table, h);
        steps.push({
          table,
          alias,
          direction: h.dir,
          left: { alias: aliasOf.get(parent)!, column: h.dir === 'reverse' ? h.rel.to.column : h.rel.from.column },
          column: h.dir === 'reverse' ? h.rel.from.column : h.rel.to.column,
        });
      }
      parent = table;
    }
  }
  const overlap = use.splitBy.length > 0;
  const semi = use.filterBy.length > 0;
  const { explain, warnings } = explainMany(base, root.table, use, overlap, semi);
  return { ok: true, many: { root, steps, tables: [root.table, ...steps.map((s) => s.table)], targets: [...targets], overlap, semi, explain, warnings } };
}

function words(table: string): string {
  return table.split('.').at(-1)!.replace(/_/g, ' ');
}

function singular(table: string): string {
  return words(table).replace(/ies$/, 'y').replace(/s$/, '');
}

function listOf(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

function explainMany(base: string, many: string, use: ManyUse, overlap: boolean, semi: boolean): { explain: string[]; warnings: string[] } {
  const one = singular(base);
  const row = singular(many);
  const explain: string[] = [`${cap(words(base))} is the one side of ${words(many)}: a ${one} can have several ${words(many)}. Each ${one} is counted from its own row once, never once per ${row}.`];
  const warnings: string[] = [];
  if (overlap) {
    const by = listOf(use.splitBy);
    explain.push(
      `Split by ${by}, each ${one} is counted once in every group it has at least one ${row} in, so a ${one} with ${row}s in two groups appears in both.` +
        (semi ? '' : ` A ${one} with no ${words(many)} falls in the blank group.`),
    );
    warnings.push(
      `${cap(by)} splits ${words(base)}: a ${one} with ${words(many)} in several groups is counted in each, so the groups can add up to more than the real total of ${words(base)}. Totals and shares are not built by adding the groups up.`,
    );
  }
  if (semi) {
    explain.push(
      `Only ${words(base)} with at least one ${row} matching ${listOf(use.filterBy)} are included, each once however many ${words(many)} match` +
        (use.filterBy.length > 1 ? '; every one of those conditions must hold on the same ' + row + '.' : '.'),
    );
  }
  return { explain, warnings };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------------------------
// What the plan reads from the many side.

export interface ManyParts {
  /** Dimensions read from the many side, with their column in the derived table ("g0", …). */
  dims: Array<{ dim: PlannedDimension; col: string }>;
  /** Filters on many-side fields; they apply inside the block, to a many-side row. */
  filters: Filter[];
  /** Whether a field is read from the many side. */
  owns(field: string): boolean;
}

export function manyParts(plan: QueryPlan, index: CatalogIndex): ManyParts {
  const many = plan.many!;
  const targets = new Set(many.targets);
  const owns = (field: string): boolean => {
    const f = index.field(field);
    return !!f && f.source === plan.source && targets.has(f.table);
  };
  return {
    dims: plan.dimensions.filter((d) => owns(d.field)).map((dim, i) => ({ dim, col: `g${i}` })),
    filters: plan.filters.filter((f) => owns(f.field)),
    owns,
  };
}

// ---------------------------------------------------------------------------------------------
// SQL: the derived table of distinct (key, group values) pairs.

/** The pieces of sql.ts this file needs, passed in so the two files do not import each other. */
export interface SqlKit {
  quote(name: string, dialect: Dialect): string;
  quoteTable(name: string, dialect: Dialect): string;
  truncate(col: string, grain: TimeGrain, dialect: Dialect): string;
  filterSql(f: Filter, col: string, type: FieldType, bind: (p: { value: string | number | boolean; type: 'string' | 'number' | 'date' | 'boolean' }) => string, today: Date): string;
  SqlError: new (message: string) => Error;
}

/**
 * `(SELECT DISTINCT <key> AS k, <group values> AS g0, … FROM <many-side tables> WHERE <many-side filters>)`.
 * Cleaning steps on a many-side field run in an inner query, once, as the main query does.
 * Binds happen in the order the values appear in the text, which the "?" dialects depend on.
 */
export function renderManyBlock(plan: QueryPlan, index: CatalogIndex, dialect: Dialect, bind: Parameters<SqlKit['filterSql']>[3], today: Date, kit: SqlKit): string {
  const many = plan.many!;
  const parts = manyParts(plan, index);
  const q = (n: string) => kit.quote(n, dialect);
  const as = (alias: string) => `${dialect === 'oracle' ? '' : 'AS '}${q(alias)}`;
  const aliasOf = new Map([[many.root.table, many.root.alias], ...many.steps.map((s) => [s.table, s.alias] as const)]);

  let from = `${kit.quoteTable(many.root.table, dialect)} ${as(many.root.alias)}`;
  for (const s of many.steps) {
    const on = `${q(s.left.alias)}.${q(s.left.column)} = ${q(s.alias)}.${q(s.column)}`;
    const joined = `LEFT JOIN ${kit.quoteTable(s.table, dialect)} ${as(s.alias)} ON ${on}`;
    from = dialect === 'access' && s !== many.steps[0] ? `(${from}) ${joined}` : `${from} ${joined}`;
  }

  const stored = (field: string): string => {
    const f = index.field(field)!;
    const alias = aliasOf.get(f.table);
    if (!alias) throw new kit.SqlError(`Field "${field}" is not in the many-side tables of this query.`);
    return `${q(alias)}.${q(f.column)}`;
  };
  const used = [...new Set([...parts.dims.map((d) => d.dim.field), ...parts.filters.map((f) => f.field)])];
  const cleaned = !plan.raw && used.some((k) => stepsFor(index, k).length > 0);
  let key = `${q(many.root.alias)}.${q(many.root.column)}`;
  let col = stored;
  if (cleaned) {
    const at = new Map<string, string>();
    const cols = used.map((k, i) => {
      at.set(k, `c${i}`);
      let expr = stored(k);
      const steps = stepsFor(index, k);
      if (steps.length) {
        try {
          expr = cleanSql(steps, expr, dialect, (value, type) => bind({ value, type }));
        } catch (e) {
          throw new kit.SqlError((e as Error).message);
        }
      }
      return `${expr} AS ${q(`c${i}`)}`;
    });
    from = `(SELECT ${key} AS ${q('k')}, ${cols.join(', ')} FROM ${from}) ${as('mi')}`;
    key = `${q('mi')}.${q('k')}`;
    col = (field) => `${q('mi')}.${q(at.get(field)!)}`;
  }
  const typeOf = (field: string): FieldType => (plan.raw ? (index.field(field)?.type ?? 'string') : cleanType(index, field));
  const select = [`${key} AS ${q('k')}`, ...parts.dims.map(({ dim, col: g }) => `${dim.grain ? kit.truncate(col(dim.field), dim.grain, dialect) : col(dim.field)} AS ${q(g)}`)];
  const where = parts.filters.map((f) => kit.filterSql(f, col(f.field), typeOf(f.field), bind, today));
  return `(SELECT DISTINCT ${select.join(', ')} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`;
}

/** The JOIN that adds the derived table: INNER when a many-side filter must be matched, else LEFT. */
export function manyJoinSql(plan: QueryPlan, block: string, dialect: Dialect, kit: SqlKit): string {
  const many = plan.many!;
  const q = (n: string) => kit.quote(n, dialect);
  const on = `${q(BASE_ALIAS)}.${q(many.root.keyColumn)} = ${q(MANY_ALIAS)}.${q('k')}`;
  return `${many.semi ? 'INNER' : 'LEFT'} JOIN ${block} ${dialect === 'oracle' ? '' : 'AS '}${q(MANY_ALIAS)} ON ${on}`;
}

// ---------------------------------------------------------------------------------------------
// In the page: the same distinct set, built from rows in memory.

export type JoinedRow = Array<Record<string, Cell> | undefined>;

export interface ManyRows {
  /** What a (joined) one-side row expands to: one entry per group it belongs to. */
  expand(row: JoinedRow): JoinedRow[];
  /** Reader for a dimension that comes from the many side, or null for any other. */
  dim(d: PlannedDimension): ((row: JoinedRow) => Cell) | null;
  /** Whether a field is read from the many side. */
  owns(field: string): boolean;
}

export interface RowKit {
  filterTest<R>(f: Filter, c: { get: (row: R) => Cell; type: FieldType }, today: Date): (row: R) => boolean;
  truncateDate(v: Cell, grain: TimeGrain): Cell;
  EngineError: new (message: string) => Error;
}

/**
 * Builds the many-side groups once for a run. `slot` is where the group record goes in a joined
 * row (after the one-side row and its many-to-one joins).
 */
export function prepareManyRows(
  plan: QueryPlan,
  index: CatalogIndex,
  tables: Record<string, ReadonlyArray<Record<string, Cell>> | undefined>,
  today: Date,
  slot: number,
  kit: RowKit,
): ManyRows {
  const many = plan.many!;
  const parts = manyParts(plan, index);
  const aliasSlot = new Map<string, number>([[many.root.alias, 0], ...many.steps.map((s, i) => [s.alias, i + 1] as const)]);
  const tableSlot = new Map<string, number>([[many.root.table, 0], ...many.steps.map((s, i) => [s.table, i + 1] as const)]);
  const need = (table: string) => {
    const rows = tables[table];
    if (!rows) throw new kit.EngineError(`No rows are loaded for table "${table}".`);
    return rows;
  };

  // The block: every root row, each step a LEFT JOIN that can repeat the row (one-to-many) or not.
  let rows: JoinedRow[] = need(many.root.table).map((r) => [r]);
  for (const s of many.steps) {
    const byKey = new Map<string, Array<Record<string, Cell>>>();
    for (const r of need(s.table)) {
      const k = r[s.column];
      if (k === null || k === undefined) continue;
      const list = byKey.get(String(k));
      if (list) list.push(r);
      else byKey.set(String(k), [r]);
    }
    const next: JoinedRow[] = [];
    for (const row of rows) {
      const v = row[aliasSlot.get(s.left.alias)!]?.[s.left.column];
      const hit = v === null || v === undefined ? undefined : byKey.get(String(v));
      if (hit?.length) for (const r of hit) next.push([...row, r]);
      else next.push([...row, undefined]);
    }
    rows = next;
  }

  const reader = (field: string): { get: (row: JoinedRow) => Cell; type: FieldType } => {
    const f = index.field(field)!;
    const at = tableSlot.get(f.table);
    if (at === undefined) throw new kit.EngineError(`Field "${field}" is not in the many-side tables of this query.`);
    const steps = plan.raw ? [] : stepsFor(index, field);
    const read = (row: JoinedRow): Cell => row[at]?.[f.column] ?? null;
    return { get: steps.length ? (row) => cleanValue(steps, read(row)) : read, type: plan.raw ? f.type : cleanType(index, field) };
  };
  const tests = parts.filters.map((f) => kit.filterTest(f, reader(f.field), today));
  const dimReaders = parts.dims.map(({ dim }) => ({ get: reader(dim.field).get, grain: dim.grain }));

  // Distinct (key, group values) pairs, grouped by key.
  const byKey = new Map<string, Array<Record<string, Cell>>>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (!tests.every((t) => t(row))) continue;
    const k = row[0]?.[many.root.column];
    if (k === null || k === undefined) continue;
    const values = dimReaders.map((d) => {
      const v = d.get(row);
      return d.grain ? kit.truncateDate(v, d.grain) : v;
    });
    const id = JSON.stringify([String(k), values]);
    if (seen.has(id)) continue;
    seen.add(id);
    const rec: Record<string, Cell> = {};
    parts.dims.forEach(({ col }, i) => (rec[col] = values[i] ?? null));
    const list = byKey.get(String(k));
    if (list) list.push(rec);
    else byKey.set(String(k), [rec]);
  }

  const blank: Record<string, Cell> = {};
  const columnOf = new Map(parts.dims.map(({ dim, col }) => [dim.alias, col]));
  return {
    owns: parts.owns,
    expand(row) {
      const k = row[0]?.[many.root.keyColumn];
      const hit = k === null || k === undefined ? undefined : byKey.get(String(k));
      if (!hit?.length) return many.semi ? [] : [withSlot(row, slot, blank)];
      return hit.map((rec) => withSlot(row, slot, rec));
    },
    dim(d) {
      const col = columnOf.get(d.alias);
      return col === undefined ? null : (row) => row[slot]?.[col] ?? null;
    },
  };
}

function withSlot(row: JoinedRow, slot: number, rec: Record<string, Cell>): JoinedRow {
  const out = row.slice();
  out[slot] = rec;
  return out;
}

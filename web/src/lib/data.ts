// Where a flag's numbers come from. Sources held in this page (the sample data and CSV files)
// are answered by the in-memory engine; every other source goes to the loopback server as SQL
// with bound parameters. Either way the flag gets the same result rows, so cross-filtering,
// comparisons and insights work the same.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { applySelections, type CrossfilterResult, type DisplayRow, lineUp, type Selections } from '../../../src/core/crossfilter.ts';
import { runPlan, type TableRows } from '../../../src/core/engine.ts';
import { comparisonPlanFor, comparisonSelections } from '../../../src/core/drill-compare.ts';
import type { Filter, Flag, Hoist } from '../../../src/core/hoist.ts';
import { comparisonShift, planFlag, planLeaves, type QueryPlan } from '../../../src/core/planner.ts';
import { type RenderedSql, renderSql } from '../../../src/core/sql.ts';
import { ApiError, runServerQuery, type ServerInfo } from './api.ts';
import type { CsvWorker } from './worker.ts';

export interface DataContext {
  index: CatalogIndex;
  /** Rows held in the page, by table name. */
  local: TableRows;
  /** Source ids answered from `local`. */
  localSources: ReadonlySet<string>;
  server: ServerInfo | null;
  today: Date;
  /** Changes whenever local rows change, so cached results are not reused across data. */
  version: number;
  /** CSV files held in the CSV worker (lib/worker.ts), by table name; their flags run there. */
  worker?: CsvWorker | null;
  workerTables?: ReadonlySet<string>;
}

export interface FlagResult {
  plan: QueryPlan;
  sql: RenderedSql | null;
  display: CrossfilterResult;
  /** Earlier values per displayed row, when the flag compares. */
  previous?: Array<Record<string, number | null> | null>;
  /** Totals of the earlier window (as `display.totals`), so a share flag's earlier shares are shares of their own whole. */
  previousTotals?: Record<string, number | null>;
  /**
   * The comparison window's rows as the source returned them (pre-split, like `raw`), with the
   * plan that asked for them. A shared report keeps them so it can line the comparison up again
   * under a selection (web/src/lib/report-view.ts).
   */
  previousRaw?: { plan: QueryPlan; rows: ReadonlyArray<Record<string, string | number | boolean | null>> };
  /** Where the numbers came from and how long they took. */
  origin: 'page' | 'server';
  ms: number;
  /** Selections that needed a fresh query for this flag. */
  requeried: string[];
  /** The rows as the source returned them (pre-split), so a shared report can filter offline. */
  raw?: ReadonlyArray<Record<string, string | number | boolean | null>>;
  /** Lake sources: how the numbers were paid for (or that they came from the result cache). */
  lake?: { cached: boolean; asOf?: string; scannedBytes?: number; warnings: string[] };
  /** Pivot flags: the same measures grouped by fewer fields, for totals that cannot be added up (src/core/pivot.ts levelKey). */
  levels?: Record<string, DisplayRow[]>;
}

export class DataError extends Error {}

/**
 * A lake query the cost guard holds until the analyst approves it (the server's 409 lake-approval).
 * `key` identifies the query; approveQuery(key) lets it run, once per page session.
 */
export class ApprovalNeeded extends DataError {
  readonly key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = 'ApprovalNeeded';
    this.key = key;
  }
}

const approved = new Set<string>();

/** Let a held lake query run (and drop the failed attempt so it is asked again). */
export function approveQuery(key: string): void {
  approved.add(key);
  cache.delete(key);
}

type Answer = { rows: Array<Record<string, string | number | boolean | null>>; truncated: boolean; ms: number };

/** How long a server answer is reused before the source is asked again. */
export const SERVER_RESULT_TTL_MS = 15 * 60 * 1000;

/**
 * Results by query, least recently used first. Page results never go stale (their key carries the
 * data version); server results expire, and a failed query is dropped so it is asked again.
 */
export class ResultCache<T> {
  private readonly entries = new Map<string, { p: Promise<T>; expires: number }>();
  private readonly max: number;
  private readonly now: () => number;
  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }

  /**
   * The cached promise for `key`, or `make()`'s. `ttl` is how long it is good for, in ms
   * (Infinity: until cleared); given the result, so a source can say how long its answer stays true.
   */
  remember(key: string, make: () => Promise<T>, ttl: number | ((result: T) => number) = Infinity): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) {
      // Least recently used goes first: a hit moves to the end.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.p;
    }
    if (hit) this.entries.delete(key);
    const p = make();
    const entry = { p, expires: typeof ttl === 'number' ? this.now() + ttl : Infinity };
    this.entries.set(key, entry);
    p.then(
      (result) => {
        if (typeof ttl === 'function') entry.expires = this.now() + ttl(result);
      },
      () => {
        // Only this attempt is dropped: a newer one under the same key stays.
        if (this.entries.get(key)?.p === p) this.entries.delete(key);
      },
    );
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return p;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const cache = new ResultCache<Answer>(300);

/**
 * Forget every result, so each flag asks its source again. The "Refresh data" action; also used
 * when CSV files change.
 */
export function clearResultCache(): void {
  cache.clear();
}

/**
 * How long a lake answer is reused. The server keeps lake results for its `cacheHours`; when it
 * says so (on the source in /api/info), the answer is good until then, counted from `asOf`.
 * Otherwise 15 minutes, like any server answer.
 */
export function lakeTtl(result: { asOf?: string }, cacheHours: number | undefined, now = Date.now()): number {
  if (typeof cacheHours !== 'number' || !(cacheHours > 0)) return SERVER_RESULT_TTL_MS;
  const taken = result.asOf ? Date.parse(result.asOf) : NaN;
  const from = Number.isFinite(taken) && taken <= now ? taken : now;
  return Math.max(0, from + cacheHours * 3600_000 - now);
}

function sourceSql(plan: QueryPlan, ctx: DataContext): RenderedSql | null {
  const server = ctx.server?.sources.find((s) => s.id === plan.source);
  try {
    return renderSql(plan, ctx.index, ctx.today, { placeholders: server && server.placeholders !== 'native' ? 'question' : 'native' });
  } catch {
    return null;
  }
}

async function run(plan: QueryPlan, ctx: DataContext) {
  if (ctx.localSources.has(plan.source)) {
    // Cleaning steps and relationships change answers without changing the plan, so they are in the key.
    const key = `page|${ctx.version}|${ctx.today.toISOString().slice(0, 10)}|${JSON.stringify(plan)}|${JSON.stringify([ctx.index.catalog.cleaning ?? [], ctx.index.catalog.relationships ?? []])}`;
    const inWorker = !!ctx.worker && [plan.table, ...(plan.joins ?? []).map((j) => j.table), ...(plan.many?.tables ?? [])].every((t) => ctx.workerTables?.has(t));
    return { origin: 'page' as const, result: await cache.remember(key, async () => (inWorker ? ctx.worker!.run(plan, ctx.index.catalog, ctx.today) : runPlan(plan, ctx.index, ctx.local, ctx.today))) };
  }
  const server = ctx.server?.sources.find((s) => s.id === plan.source);
  if (!server) {
    const label = ctx.index.source(plan.source)?.label ?? plan.source;
    throw new DataError(ctx.server ? `"${label}" is not set up on this computer (sources.json).` : `"${label}" needs the Semaphore server. Start Semaphore with Launch-Semaphore.bat.`);
  }
  const sql = sourceSql(plan, ctx);
  if (!sql) throw new DataError('This flag cannot be turned into SQL for its source.');
  const key = `server|${plan.source}|${sql.sql}|${JSON.stringify(sql.params)}|${plan.rowCap}`;
  try {
    const lake = server.provider === 'athena';
    const cacheHours = (server as { cacheHours?: number }).cacheHours;
    const ttl = lake ? (r: Answer) => lakeTtl(r as { asOf?: string }, cacheHours) : SERVER_RESULT_TTL_MS;
    return { origin: 'server' as const, result: await cache.remember(key, () => runServerQuery(plan.source, sql.sql, sql.params, plan.rowCap, { approve: approved.has(key) }), ttl) };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'lake-approval') throw new ApprovalNeeded(e.message, key);
    throw e;
  }
}

/** A selected value that can be sent to the source as an "in" filter value. */
function expressible(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

/**
 * Selections the plan cannot answer locally and the source can be asked for: not a period picked
 * on another flag, and only string or number values (a blank or true/false pick has no "in" value,
 * so it stays reported as not applied rather than silently showing the unfiltered total).
 */
function requeryable(keys: readonly string[], selections: Selections): string[] {
  return keys.filter((k) => !k.includes('@') && (selections[k] ?? []).length > 0 && (selections[k] ?? []).every(expressible));
}

/** Selections the plan cannot answer locally, turned into filters on the flag itself. */
function withSelectionFilters(flag: Flag, keys: string[], selections: Selections): Flag {
  const extra: Filter[] = [];
  for (const k of keys) {
    const values = (selections[k] ?? []).filter(expressible);
    if (values.length) extra.push({ field: k, op: 'in', values });
  }
  return { ...flag, binding: { ...flag.binding!, filters: [...flag.binding!.filters, ...extra] } };
}

export async function computeFlag(hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext): Promise<FlagResult> {
  const first = planFlag(hoist, flag, ctx.index);
  if (!first.ok) throw new DataError(first.error);
  let plan = first.plan;
  let ran = await run(plan, ctx);
  let display = applySelections(plan, ran.result.rows, selections, flag.behavior);
  const requeried: string[] = [];
  if (display.live.length) {
    // Ask the source again with those selections as filters. The rest still apply locally.
    const keys = requeryable(display.live, selections);
    if (keys.length) {
      const narrowed = withSelectionFilters(flag, keys, selections);
      const again = planFlag(hoist, narrowed, ctx.index);
      if (again.ok) {
        plan = again.plan;
        ran = await run(plan, ctx);
        const rest: Selections = Object.fromEntries(Object.entries(selections).filter(([k]) => !keys.includes(k)));
        display = { ...applySelections(plan, ran.result.rows, rest, flag.behavior), live: display.live.filter((k) => !keys.includes(k)) };
        requeried.push(...keys);
      }
    }
  }
  const out: FlagResult = { plan, sql: sourceSql(plan, ctx), display, origin: ran.origin, ms: ran.result.ms, requeried, raw: ran.result.rows };
  const lake = ran.result as { cached?: boolean; asOf?: string; scannedBytes?: number; estimate?: { warnings: string[] } };
  if (lake.cached || lake.scannedBytes !== undefined) {
    out.lake = { cached: !!lake.cached, ...(lake.asOf ? { asOf: lake.asOf } : {}), ...(lake.scannedBytes !== undefined ? { scannedBytes: lake.scannedBytes } : {}), warnings: lake.estimate?.warnings ?? [] };
  }
  // The comparison reads the earlier window under the same narrowing: drill steps on the compared
  // date move back with it, and a period picked elsewhere is looked up one window back.
  const earlier = comparisonPlanFor(plan, ctx.today);
  if (earlier) {
    const prev = await run(earlier, ctx);
    const prevDisplay = applySelections(earlier, prev.result.rows, comparisonSelections(plan, selections), flag.behavior);
    out.previous = lineUp(display.rows, prevDisplay.rows, comparisonShift(plan) ?? undefined);
    out.previousTotals = prevDisplay.totals;
    out.previousRaw = { plan: earlier, rows: prev.result.rows };
  }
  await formulaTotals(hoist, flag, selections, ctx, out);
  if (flag.kind === 'pivot') {
    const levels = await (await import('./pivot-levels.ts')).pivotLevels(hoist, flag, selections, ctx, out, computeFlag);
    if (levels) out.levels = levels;
  }
  return out;
}

/**
 * A calculated measure that reads a distinct count has no total that can be worked out from its
 * rows (the same hull is in several groups). Its total is read from the data instead: the same
 * measures, filters and selections with no grouping, and the same comparison window.
 */
async function formulaTotals(hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext, out: FlagResult): Promise<void> {
  const b = flag.binding;
  const { plan, display } = out;
  if (!b || !b.dimensions.length || plan.many?.overlap || display.rows.length < 2) return;
  const keys = plan.metrics.filter((m) => m.agg === 'formula' && display.totals[m.key] === null && planLeaves(m).some((l) => l.agg === 'count_distinct')).map((m) => m.key);
  if (!keys.length) return;
  const whole: Flag = { ...flag, kind: 'kpi', binding: { metrics: keys, dimensions: [], filters: b.filters, ...(b.compare ? { compare: b.compare } : {}) } };
  try {
    const t = await computeFlag(hoist, whole, selections, ctx);
    for (const k of keys) {
      display.totals[k] = t.display.rows[0]?.values[k] ?? null;
      if (out.previousTotals) out.previousTotals[k] = t.previous?.[0]?.[k] ?? null;
    }
  } catch {
    // Left empty: a total that could not be read is never guessed.
  }
}

/**
 * Only the selections that can change this plan's numbers, in a stable key order: those on its own
 * dimensions or slices (unless the flag ignores the field, or it is the flag's own picker field),
 * and those it sends back to the source (`plan.live`). A selection on a table the plan does not
 * read is dropped, so `JSON.stringify(selectionsFor(...))` is a key that changes only when the
 * flag's result would. computeFlag gives the same result for these as for all the selections.
 */
export function selectionsFor(plan: QueryPlan, selections: Selections, ignore: readonly string[] = []): Selections {
  const out: Record<string, Selections[string]> = {};
  for (const key of Object.keys(selections).sort()) {
    const values = selections[key]!;
    if (!values.length || ignore.includes(key.split('@')[0]!)) continue;
    const own = plan.own.includes(key);
    if (own && !plan.selfFilter) continue;
    if (plan.live.includes(key) || plan.dimensions.some((d) => d.key === key)) out[key] = values;
  }
  return out;
}

/** Values a filter flag lists, with no selection applied to itself. */
export function distinctValues(result: FlagResult): Array<string | number | boolean | null> {
  const key = result.plan.own[0];
  if (!key) return [];
  return result.display.rows.map((r) => r.dims[key] ?? null);
}

/** Whether this page can read a source: held in the page, or set up on this computer's server. */
export function canReach(source: string, ctx: DataContext): boolean {
  return ctx.localSources.has(source) || !!ctx.server?.sources.some((s) => s.id === source);
}

/** Run a plan wherever its source is, for snapshots. */
export async function runAnywhere(plan: QueryPlan, ctx: DataContext): Promise<{ rows: Array<Record<string, string | number | boolean | null>>; truncated: boolean }> {
  const r = await run(plan, ctx);
  return { rows: r.result.rows, truncated: r.result.truncated };
}

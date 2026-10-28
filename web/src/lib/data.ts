// Where a flag's numbers come from. Sources held in this page (the sample data and CSV files)
// are answered by the in-memory engine; every other source goes to the loopback server as SQL
// with bound parameters. Either way the flag gets the same result rows, so cross-filtering,
// comparisons and insights work the same.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { applySelections, type CrossfilterResult, lineUp, type Selections } from '../../../src/core/crossfilter.ts';
import { runPlan, type TableRows } from '../../../src/core/engine.ts';
import type { Filter, Flag, Hoist } from '../../../src/core/hoist.ts';
import { comparisonPlan, comparisonShift, planFlag, type QueryPlan } from '../../../src/core/planner.ts';
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
  /** Where the numbers came from and how long they took. */
  origin: 'page' | 'server';
  ms: number;
  /** Selections that needed a fresh query for this flag. */
  requeried: string[];
  /** Lake sources: how the numbers were paid for (or that they came from the result cache). */
  lake?: { cached: boolean; asOf?: string; scannedBytes?: number; warnings: string[] };
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

const cache = new Map<string, Promise<{ rows: Array<Record<string, string | number | boolean | null>>; truncated: boolean; ms: number }>>();
const CACHE_MAX = 300;

function remember<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = make();
  cache.set(key, p as never);
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

export function clearResultCache(): void {
  cache.clear();
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
    const inWorker = !!ctx.worker && [plan.table, ...(plan.joins ?? []).map((j) => j.table)].every((t) => ctx.workerTables?.has(t));
    return { origin: 'page' as const, result: await remember(key, async () => (inWorker ? ctx.worker!.run(plan, ctx.index.catalog, ctx.today) : runPlan(plan, ctx.index, ctx.local, ctx.today))) };
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
    return { origin: 'server' as const, result: await remember(key, () => runServerQuery(plan.source, sql.sql, sql.params, plan.rowCap, { approve: approved.has(key) })) };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'lake-approval') throw new ApprovalNeeded(e.message, key);
    throw e;
  }
}

/** Selections the plan cannot answer locally, turned into filters on the flag itself. */
function withSelectionFilters(flag: Flag, keys: string[], selections: Selections): Flag {
  const extra: Filter[] = [];
  for (const k of keys) {
    if (k.includes('@')) continue; // a period picked on another flag; not expressible as a filter here
    const values = (selections[k] ?? []).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
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
    const keys = display.live.filter((k) => !k.includes('@'));
    if (keys.length) {
      const narrowed = withSelectionFilters(flag, keys, selections);
      const again = planFlag(hoist, narrowed, ctx.index);
      if (again.ok) {
        plan = again.plan;
        ran = await run(plan, ctx);
        const rest: Selections = Object.fromEntries(Object.entries(selections).filter(([k]) => !keys.includes(k)));
        display = { ...applySelections(plan, ran.result.rows, rest, flag.behavior), live: [] };
        requeried.push(...keys);
      }
    }
  }
  const out: FlagResult = { plan, sql: sourceSql(plan, ctx), display, origin: ran.origin, ms: ran.result.ms, requeried };
  const lake = ran.result as { cached?: boolean; asOf?: string; scannedBytes?: number; estimate?: { warnings: string[] } };
  if (lake.cached || lake.scannedBytes !== undefined) {
    out.lake = { cached: !!lake.cached, ...(lake.asOf ? { asOf: lake.asOf } : {}), ...(lake.scannedBytes !== undefined ? { scannedBytes: lake.scannedBytes } : {}), warnings: lake.estimate?.warnings ?? [] };
  }
  const earlier = comparisonPlan(plan, ctx.today);
  if (earlier) {
    const prev = await run(earlier, ctx);
    const prevDisplay = applySelections(earlier, prev.result.rows, selections, flag.behavior);
    out.previous = lineUp(display.rows, prevDisplay.rows, comparisonShift(plan) ?? undefined);
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

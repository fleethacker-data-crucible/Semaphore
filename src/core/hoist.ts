// A hoist is a dashboard; a flag is one block on it. In naval signalling a hoist is the set of
// flags flown together to send one message, and each flag carries one part of it.

import type { CatalogIndex } from './catalog.ts';

export type FlagKind = 'kpi' | 'bar' | 'line' | 'area' | 'pie' | 'table' | 'filter' | 'text';
export const FLAG_KINDS: readonly FlagKind[] = ['kpi', 'bar', 'line', 'area', 'pie', 'table', 'filter', 'text'];

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const TIME_GRAINS: readonly TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

export interface DimensionRef {
  field: string;
  /** Only for date fields: the period values are truncated to. */
  grain?: TimeGrain;
}

export type FilterOp = 'in' | 'eq' | 'gte' | 'lte' | 'between' | 'last';
export const FILTER_OPS: readonly FilterOp[] = ['in', 'eq', 'gte', 'lte', 'between', 'last'];

export interface Filter {
  field: string;
  op: FilterOp;
  /** For `last`: one number, the count of `unit` periods back from today. */
  values: Array<string | number>;
  unit?: TimeGrain;
}

export type Tone = 'good' | 'warn' | 'bad';

export interface Threshold {
  metric: string;
  op: 'lt' | 'lte' | 'gt' | 'gte';
  value: number;
  tone: Tone;
}

export interface Binding {
  metrics: string[];
  dimensions: DimensionRef[];
  filters: Filter[];
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface Behavior {
  /** What a click on a mark does. `filter-page` selects that value for every other flag. */
  onClick: 'filter-page' | 'drill' | 'none';
  /** Field keys whose page selections this flag ignores ("ignore the region filter"). */
  ignore: string[];
  thresholds: Threshold[];
}

export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FlagStatus = 'empty' | 'drafted' | 'ready' | 'error';

export interface Flag {
  id: string;
  kind: FlagKind;
  title: string;
  /** What the analyst asked this flag to show and how it should behave, in their words. */
  brief: string;
  layout: Layout;
  binding: Binding | null;
  behavior: Behavior;
  status: FlagStatus;
  /** 0–1, how sure the provider was about the binding. Shown as a badge; low means "verify". */
  confidence?: number;
  notes: string[];
  /** Body for `text` flags. */
  text?: string;
}

export interface Hoist {
  version: 1;
  id: string;
  title: string;
  /** The brief for the whole dashboard. Flag briefs refine it and win where they disagree. */
  brief: string;
  grid: { cols: number };
  /** Fixed filters every flag inherits, e.g. "fiscal year 2026". */
  filters: Filter[];
  flags: Flag[];
  updated: string;
}

export const GRID_COLS = 12;

export function emptyBehavior(): Behavior {
  return { onClick: 'none', ignore: [], thresholds: [] };
}

export function dimensionKey(d: DimensionRef): string {
  return d.grain ? `${d.field}@${d.grain}` : d.field;
}

/** Everything the intelligence layer needs to know about the intent behind one flag. */
export interface EffectiveBrief {
  hoist: string;
  flag: string;
  pageFilters: Filter[];
  kind: FlagKind;
}

export function effectiveBrief(hoist: Hoist, flag: Flag): EffectiveBrief {
  return { hoist: hoist.brief.trim(), flag: flag.brief.trim(), pageFilters: hoist.filters, kind: flag.kind };
}

// ---------------------------------------------------------------------------------------------
// Validation. Hoists come from disk, from imports and from AI providers, so nothing is trusted.
// A bad flag is dropped and reported; a bad reference inside a flag is removed and reported;
// only a document that is not a hoist at all is rejected.

export interface ParseResult {
  hoist: Hoist | null;
  warnings: string[];
}

export function parseHoist(raw: unknown, index?: CatalogIndex): ParseResult {
  const warnings: string[] = [];
  if (!isObject(raw) || raw.version !== 1) {
    return { hoist: null, warnings: ['Not a Semaphore hoist (version 1).'] };
  }
  const cols = isObject(raw.grid) && isInt(raw.grid.cols) && raw.grid.cols >= 4 && raw.grid.cols <= 24 ? raw.grid.cols : GRID_COLS;
  const flags: Flag[] = [];
  const ids = new Set<string>();
  const rawFlags = Array.isArray(raw.flags) ? raw.flags : [];
  rawFlags.forEach((rf, i) => {
    const flag = parseFlag(rf, cols, index, warnings, `Flag ${i + 1}`);
    if (!flag) return;
    if (ids.has(flag.id)) {
      warnings.push(`Flag ${i + 1}: duplicate id "${flag.id}", dropped.`);
      return;
    }
    ids.add(flag.id);
    flags.push(flag);
  });
  const filters = parseFilters(raw.filters, index, warnings, 'Hoist filters');
  return {
    hoist: {
      version: 1,
      id: str(raw.id) || 'hoist',
      title: str(raw.title) || 'Untitled hoist',
      brief: str(raw.brief),
      grid: { cols },
      filters,
      flags,
      updated: str(raw.updated) || new Date(0).toISOString(),
    },
    warnings,
  };
}

function parseFlag(raw: unknown, cols: number, index: CatalogIndex | undefined, warnings: string[], where: string): Flag | null {
  if (!isObject(raw)) {
    warnings.push(`${where}: not an object, dropped.`);
    return null;
  }
  const id = str(raw.id);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    warnings.push(`${where}: missing or invalid id, dropped.`);
    return null;
  }
  where = `Flag "${id}"`;
  const kind = FLAG_KINDS.includes(raw.kind as FlagKind) ? (raw.kind as FlagKind) : null;
  if (!kind) {
    warnings.push(`${where}: unknown kind "${String(raw.kind)}", dropped.`);
    return null;
  }
  const layout = parseLayout(raw.layout, cols);
  if (!layout) {
    warnings.push(`${where}: invalid layout, dropped.`);
    return null;
  }
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string').slice(0, 20) : [];
  let binding: Binding | null = null;
  let status: FlagStatus = (['empty', 'drafted', 'ready', 'error'] as const).includes(raw.status as FlagStatus)
    ? (raw.status as FlagStatus)
    : 'empty';
  if (raw.binding !== undefined && raw.binding !== null) {
    const before = warnings.length;
    binding = parseBinding(raw.binding, index, warnings, where);
    if (!binding) status = 'error';
    else if (warnings.length > before && status === 'ready') status = 'drafted';
  } else if (status === 'ready' && kind !== 'text') {
    status = 'empty';
  }
  const confidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : undefined;
  const flag: Flag = {
    id,
    kind,
    title: str(raw.title).slice(0, 200),
    brief: str(raw.brief).slice(0, 4000),
    layout,
    binding,
    behavior: parseBehavior(raw.behavior, index, warnings, where),
    status,
    notes,
  };
  if (confidence !== undefined) flag.confidence = confidence;
  if (kind === 'text') flag.text = str(raw.text).slice(0, 20000);
  return flag;
}

function parseLayout(raw: unknown, cols: number): Layout | null {
  if (!isObject(raw)) return null;
  const { x, y, w, h } = raw;
  if (!isInt(x) || !isInt(y) || !isInt(w) || !isInt(h)) return null;
  if (x < 0 || y < 0 || w < 1 || h < 1 || h > 24 || y > 1000) return null;
  const width = Math.min(w, cols);
  return { x: Math.min(x, cols - width), y, w: width, h };
}

export function parseBinding(raw: unknown, index: CatalogIndex | undefined, warnings: string[], where: string): Binding | null {
  if (!isObject(raw)) {
    warnings.push(`${where}: binding is not an object.`);
    return null;
  }
  const metrics: string[] = [];
  for (const m of Array.isArray(raw.metrics) ? raw.metrics : []) {
    if (typeof m !== 'string') continue;
    if (index && !index.metric(m)) {
      warnings.push(`${where}: unknown metric "${m}" removed.`);
      continue;
    }
    if (!metrics.includes(m)) metrics.push(m);
  }
  const dimensions: DimensionRef[] = [];
  for (const d of Array.isArray(raw.dimensions) ? raw.dimensions : []) {
    if (!isObject(d) || typeof d.field !== 'string') continue;
    const field = index?.field(d.field);
    if (index && !field) {
      warnings.push(`${where}: unknown field "${d.field}" removed.`);
      continue;
    }
    const ref: DimensionRef = { field: d.field };
    if (TIME_GRAINS.includes(d.grain as TimeGrain)) {
      if (field && field.type !== 'date') warnings.push(`${where}: grain ignored on non-date field "${d.field}".`);
      else ref.grain = d.grain as TimeGrain;
    }
    if (!dimensions.some((x) => dimensionKey(x) === dimensionKey(ref))) dimensions.push(ref);
  }
  if (metrics.length === 0 && dimensions.length === 0) {
    warnings.push(`${where}: binding has no usable metric or field.`);
    return null;
  }
  const binding: Binding = { metrics, dimensions, filters: parseFilters(raw.filters, index, warnings, where) };
  if (isObject(raw.sort) && typeof raw.sort.by === 'string' && (raw.sort.dir === 'asc' || raw.sort.dir === 'desc')) {
    const by = raw.sort.by;
    if (metrics.includes(by) || dimensions.some((d) => dimensionKey(d) === by)) binding.sort = { by, dir: raw.sort.dir };
    else warnings.push(`${where}: sort on "${by}", which the flag does not show, removed.`);
  }
  if (isInt(raw.limit) && raw.limit > 0) binding.limit = Math.min(raw.limit, 10000);
  return binding;
}

export function parseFilters(raw: unknown, index: CatalogIndex | undefined, warnings: string[], where: string): Filter[] {
  const out: Filter[] = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!isObject(f) || typeof f.field !== 'string' || !FILTER_OPS.includes(f.op as FilterOp)) {
      warnings.push(`${where}: malformed filter removed.`);
      continue;
    }
    const field = index?.field(f.field);
    if (index && !field) {
      warnings.push(`${where}: filter on unknown field "${f.field}" removed.`);
      continue;
    }
    const values = (Array.isArray(f.values) ? f.values : []).filter(
      (v): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
    );
    const op = f.op as FilterOp;
    const arity = op === 'between' ? 2 : op === 'in' ? -1 : 1;
    if ((arity === -1 && values.length === 0) || (arity > 0 && values.length !== arity)) {
      warnings.push(`${where}: filter on "${f.field}" has the wrong number of values, removed.`);
      continue;
    }
    const filter: Filter = { field: f.field, op, values: values.slice(0, 500) };
    if (op === 'last') {
      const unit = TIME_GRAINS.includes(f.unit as TimeGrain) ? (f.unit as TimeGrain) : null;
      const n = values[0];
      if (!unit || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000 || (field && field.type !== 'date')) {
        warnings.push(`${where}: "last" filter on "${f.field}" needs a date field, a whole count and a unit; removed.`);
        continue;
      }
      filter.unit = unit;
    }
    out.push(filter);
  }
  return out;
}

export function parseBehavior(raw: unknown, index: CatalogIndex | undefined, warnings: string[], where: string): Behavior {
  const b = emptyBehavior();
  if (!isObject(raw)) return b;
  if (raw.onClick === 'filter-page' || raw.onClick === 'drill' || raw.onClick === 'none') b.onClick = raw.onClick;
  for (const k of Array.isArray(raw.ignore) ? raw.ignore : []) {
    if (typeof k !== 'string') continue;
    if (index && !index.field(k)) {
      warnings.push(`${where}: ignores unknown field "${k}", removed.`);
      continue;
    }
    if (!b.ignore.includes(k)) b.ignore.push(k);
  }
  for (const t of Array.isArray(raw.thresholds) ? raw.thresholds : []) {
    if (
      isObject(t) &&
      typeof t.metric === 'string' &&
      ['lt', 'lte', 'gt', 'gte'].includes(t.op as string) &&
      typeof t.value === 'number' &&
      Number.isFinite(t.value) &&
      ['good', 'warn', 'bad'].includes(t.tone as string)
    ) {
      if (index && !index.metric(t.metric)) {
        warnings.push(`${where}: threshold on unknown metric "${t.metric}" removed.`);
        continue;
      }
      b.thresholds.push({ metric: t.metric, op: t.op as Threshold['op'], value: t.value, tone: t.tone as Tone });
    }
  }
  return b;
}

/** The tone a value earns from a flag's thresholds; the first matching threshold wins. */
export function toneFor(behavior: Behavior, metric: string, value: number): Tone | null {
  for (const t of behavior.thresholds) {
    if (t.metric !== metric) continue;
    const hit = t.op === 'lt' ? value < t.value : t.op === 'lte' ? value <= t.value : t.op === 'gt' ? value > t.value : value >= t.value;
    if (hit) return t.tone;
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

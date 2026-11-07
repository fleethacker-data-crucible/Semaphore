// A hoist is a dashboard; a flag is one block on it. In naval signalling a hoist is the set of
// flags flown together to send one message, and each flag carries one part of it.

import type { CatalogIndex } from './catalog.ts';
import { type FlagStyle, type HoistDesign, parseDesign, parseFlagStyle } from './design.ts';
import { compact, isValidLayout } from './layout.ts';

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
  /**
   * Set by drill.ts on the filter a drill step adds (never read from a saved hoist). A comparison
   * moves such a filter back with its earlier window, so a drilled period is compared with the
   * same period one window earlier (drill-compare.ts).
   */
  drill?: true;
}

export type Tone = 'good' | 'warn' | 'bad';

export interface Threshold {
  metric: string;
  op: 'lt' | 'lte' | 'gt' | 'gte';
  value: number;
  tone: Tone;
}

export type Comparison = 'previous-period' | 'previous-year';
export const COMPARISONS: readonly Comparison[] = ['previous-period', 'previous-year'];

export interface Binding {
  metrics: string[];
  dimensions: DimensionRef[];
  filters: Filter[];
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit?: number;
  /**
   * Compare with the window just before the "last N" date filter (previous-period) or the same
   * window a year earlier (previous-year). Needs a "last" filter on the flag or the page.
   */
  compare?: Comparison;
  /** Show each value as a share of the total across all rows, before any top-N cut. */
  share?: boolean;
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
  /** false: the analyst marked this flag "do not learn", so the playbook never takes it. */
  learn?: boolean;
  /** How this flag is drawn, over the page's design. Never changes what it means. */
  style?: FlagStyle;
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
  /** An experiment page: the analyst is trying things out, so the playbook and the team style never learn from it. */
  experiment?: boolean;
  /** How the page looks: palette, cards, backdrop, font and chart defaults. */
  design?: HoistDesign;
  updated: string;
}

export const GRID_COLS = 12;

/**
 * Limits on untrusted input (files, imports, AI output) and on what the analyst types. The UI puts the
 * character limits on its inputs as maxLength; the document limit is the server's (server/Routes.ps1
 * SemDocMaxBytes), checked before a save or an import so it never fails late.
 */
export const LIMITS = {
  /** A hoist's or a flag's title. */
  titleChars: 120,
  /** The hoist brief and a flag's brief. */
  briefChars: 2000,
  /** A catalog label (measure, field, source). */
  labelChars: 80,
  /** One taught word or synonym. */
  synonymChars: 40,
  /** A quick-chart question or a search box. */
  questionChars: 400,
  /** One saved document (a hoist or the catalog), as the JSON the server stores. */
  docBytes: 2 * 1024 * 1024,
  flags: 200,
  metrics: 50,
  dimensions: 20,
  filters: 50,
  filterValues: 500,
  ignore: 50,
  thresholds: 20,
  warnings: 200,
} as const;

/** Bytes of `value` as the JSON a save sends (UTF-8). */
export function docBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Megabytes for a person, one decimal: 2.3 MB. */
export function formatMb(bytes: number): string {
  const mb = Math.ceil((bytes / 1048576) * 10) / 10;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * Null when the document fits the server's limit; otherwise what to tell the analyst, with the next
 * step. `noun` is "hoist" or "catalog".
 */
export function oversize(value: unknown, noun: 'hoist' | 'catalog'): string | null {
  const bytes = docBytes(value);
  if (bytes <= LIMITS.docBytes) return null;
  const fix = noun === 'hoist' ? 'Remove some flags or split the page into two hoists.' : 'Remove sources or measures you no longer use.';
  return `This ${noun} is ${formatMb(bytes)}, over the ${formatMb(LIMITS.docBytes)} limit, so it was not saved to the Semaphore folder. ${fix}`;
}

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
  /** The analyst left the kind to Semaphore: pick it from the shape of the data. */
  auto?: boolean;
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
  if (rawFlags.length > LIMITS.flags) warnings.push(`Only the first ${LIMITS.flags} of ${rawFlags.length} flags were loaded.`);
  rawFlags.slice(0, LIMITS.flags).forEach((rf, i) => {
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
  if (!isValidLayout(flags, cols)) {
    const fixed = new Map(compact(flags).map((p) => [p.id, p.layout]));
    for (const f of flags) f.layout = fixed.get(f.id) ?? f.layout;
    warnings.push('Some flags overlapped, so they were moved down to fit.');
  }
  const brief = str(raw.brief);
  if (brief.length > LIMITS.briefChars) warnings.push(`The hoist brief was cut to ${LIMITS.briefChars} characters.`);
  const design = parseDesign(raw.design);
  return {
    hoist: {
      version: 1,
      id: str(raw.id).slice(0, 64) || 'hoist',
      title: str(raw.title).slice(0, LIMITS.titleChars) || 'Untitled hoist',
      brief: brief.slice(0, LIMITS.briefChars),
      grid: { cols },
      filters,
      flags,
      ...(raw.experiment === true ? { experiment: true } : {}),
      ...(design ? { design } : {}),
      updated: str(raw.updated).slice(0, 40) || new Date(0).toISOString(),
    },
    warnings: capWarnings(warnings),
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
    title: str(raw.title).slice(0, LIMITS.titleChars),
    brief: str(raw.brief).slice(0, LIMITS.briefChars),
    layout,
    binding,
    behavior: parseBehavior(raw.behavior, index, warnings, where),
    status,
    notes,
  };
  if (confidence !== undefined) flag.confidence = confidence;
  if (kind === 'text') flag.text = str(raw.text).slice(0, 20000);
  if (raw.learn === false) flag.learn = false;
  const style = parseFlagStyle(raw.style);
  if (style) flag.style = style;
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
  const seenMetrics = new Set<string>();
  for (const m of capped(raw.metrics, LIMITS.metrics, warnings, `${where}: metrics`)) {
    if (typeof m !== 'string' || seenMetrics.has(m)) continue;
    seenMetrics.add(m);
    if (index && !index.metric(m)) {
      warnings.push(`${where}: unknown metric "${m.slice(0, 80)}" removed.`);
      continue;
    }
    metrics.push(m);
  }
  const dimensions: DimensionRef[] = [];
  for (const d of capped(raw.dimensions, LIMITS.dimensions, warnings, `${where}: fields`)) {
    if (!isObject(d) || typeof d.field !== 'string') continue;
    const field = index?.field(d.field);
    if (index && !field) {
      warnings.push(`${where}: unknown field "${d.field.slice(0, 80)}" removed.`);
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
  if (COMPARISONS.includes(raw.compare as Comparison)) binding.compare = raw.compare as Comparison;
  else if (raw.compare !== undefined) warnings.push(`${where}: unknown comparison "${String(raw.compare).slice(0, 40)}" removed.`);
  if (raw.share === true) binding.share = true;
  return binding;
}

export function parseFilters(raw: unknown, index: CatalogIndex | undefined, warnings: string[], where: string): Filter[] {
  const out: Filter[] = [];
  for (const f of capped(raw, LIMITS.filters, warnings, `${where}: filters`)) {
    if (!isObject(f) || typeof f.field !== 'string' || !FILTER_OPS.includes(f.op as FilterOp)) {
      warnings.push(`${where}: malformed filter removed.`);
      continue;
    }
    const field = index?.field(f.field);
    if (index && !field) {
      warnings.push(`${where}: filter on unknown field "${f.field.slice(0, 80)}" removed.`);
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
    if (values.length > LIMITS.filterValues) {
      warnings.push(`${where}: filter on "${f.field}" lists more than ${LIMITS.filterValues} values, removed.`);
      continue;
    }
    const filter: Filter = { field: f.field, op, values };
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
  for (const k of capped(raw.ignore, LIMITS.ignore, warnings, `${where}: ignored fields`)) {
    if (typeof k !== 'string') continue;
    if (index && !index.field(k)) {
      warnings.push(`${where}: ignores unknown field "${k.slice(0, 80)}", removed.`);
      continue;
    }
    if (!b.ignore.includes(k)) b.ignore.push(k);
  }
  for (const t of capped(raw.thresholds, LIMITS.thresholds, warnings, `${where}: thresholds`)) {
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

/** The first `max` items of an untrusted array, with a warning when it was longer. */
function capped(v: unknown, max: number, warnings: string[], what: string): unknown[] {
  if (!Array.isArray(v)) return [];
  if (v.length > max) warnings.push(`${what}: only the first ${max} of ${v.length} were kept.`);
  return v.slice(0, max);
}

export function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= LIMITS.warnings) return warnings;
  return [...warnings.slice(0, LIMITS.warnings), `…and ${warnings.length - LIMITS.warnings} more problems.`];
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

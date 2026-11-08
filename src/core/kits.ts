// Flag kits: a saved set of flags that can be flown on a different catalog.
//
// A kit is taken from a hoist and keeps what each flag *means* rather than only what it is wired
// to: every metric and field the flags use is stored with its key, label, type and synonyms. To
// apply a kit to another catalog, each reference is remapped to the best match there:
//
//   1. exact     the same key, and the same kind of thing (same aggregate / same field type)
//   2. label     the same label (ignoring case, punctuation and plurals)
//   3. synonym   a synonym or the key's column name matches a label or synonym
//   4. similar   the words overlap enough; only used when the caller asks for close matches
//
// Nothing is ever invented. A target must be a real metric or field of the new catalog, must be
// the same type as what the kit asked for (a date stays a date, a sum stays a sum), and must be
// the only candidate at its tier; otherwise the reference is reported as unmatched, with
// suggestions, and the flag is left unbound (kept, with its title and brief, so it can be
// drafted again) instead of being guessed. The remapped hoist is run through parseHoist against
// the target catalog before it is returned.
//
// Pure functions: no I/O, no clock unless passed in. The UI stores kits (web/src/lib/kits.ts).

import type { Aggregate, CatalogIndex, Field, FieldType, Metric } from './catalog.ts';
import {
  type Binding,
  type Comparison,
  COMPARISONS,
  type DimensionRef,
  dimensionKey,
  type Filter,
  FILTER_OPS,
  type FilterOp,
  type Flag,
  type FlagKind,
  FLAG_KINDS,
  type FlagStatus,
  type Hoist,
  LIMITS,
  type Layout,
  parseHoist,
  type Threshold,
  type TimeGrain,
  TIME_GRAINS,
  type Tone,
} from './hoist.ts';
import { clampLayout, compact, DEFAULT_SIZE, findSlot, isValidLayout, MAX_Y, snapAll } from './layout.ts';
import { type FlagWidget, parseWidget } from './widget.ts';

export const KIT_VERSION = 1;

/** Limits on untrusted kit input (imported files, stored documents). */
export const KIT_LIMITS = {
  /** Characters of JSON text accepted by parseKitText. */
  chars: 1_000_000,
  flags: LIMITS.flags,
  nameChars: 80,
  descriptionChars: 1000,
  titleChars: 200,
  labelChars: 200,
  keyChars: 200,
  synonyms: 20,
  synonymChars: 80,
  textChars: 20000,
  errors: 20,
  /** Kits kept at once by the web app. */
  stored: 100,
} as const;

// ---------------------------------------------------------------------------------------------
// The kit

export interface KitField {
  key: string;
  label: string;
  type: FieldType;
  synonyms: string[];
}

export interface KitMetric {
  key: string;
  label: string;
  agg: Aggregate;
  format?: 'number' | 'currency' | 'percent';
  synonyms: string[];
}

export interface KitDimension {
  field: KitField;
  grain?: TimeGrain;
}

export interface KitFilter {
  field: KitField;
  op: FilterOp;
  values: Array<string | number>;
  unit?: TimeGrain;
}

export interface KitThreshold {
  metric: KitMetric;
  op: Threshold['op'];
  value: number;
  tone: Tone;
}

export interface KitBinding {
  metrics: KitMetric[];
  dimensions: KitDimension[];
  filters: KitFilter[];
  /** Which of the flag's own metrics or fields it sorts by, by position, so it survives a remap. */
  sort?: { by: { kind: 'metric' | 'dimension'; index: number }; dir: 'asc' | 'desc' };
  limit?: number;
  compare?: Comparison;
  share?: boolean;
}

export interface KitFlag {
  kind: FlagKind;
  title: string;
  brief: string;
  /** Absent when the kit was saved without sizes and positions. */
  layout?: Layout;
  binding: KitBinding | null;
  behavior: { onClick: 'filter-page' | 'drill' | 'none'; ignore: KitField[]; thresholds: KitThreshold[] };
  /** The flag was accepted (ready) in the hoist the kit came from. */
  reviewed: boolean;
  text?: string;
  learn?: false;
  /** A custom flag's own chart code (src/core/widget.ts), carried as it is. */
  widget?: FlagWidget;
}

export interface Kit {
  version: 1;
  kind: 'flag-kit';
  id: string;
  name: string;
  description: string;
  created: string;
  /** Where it was taken from, for the list; not used to match anything. */
  from?: { hoist: string; title: string };
  cols: number;
  /** The page's fixed filters, if they were saved with the kit. */
  filters: KitFilter[];
  flags: KitFlag[];
}

// ---------------------------------------------------------------------------------------------
// Making a kit

export interface MakeKitOptions {
  name: string;
  description?: string;
  /** Flags to include, in hoist order. Default: every flag. */
  flagIds?: readonly string[];
  /** Keep sizes and positions (default true). Without them, applied flags get their default size. */
  layout?: boolean;
  /** Keep the page's fixed filters (default false). */
  pageFilters?: boolean;
  id?: string;
  now?: Date;
}

export interface MakeKitResult {
  kit: Kit | null;
  warnings: string[];
}

export function makeKit(hoist: Hoist, index: CatalogIndex, options: MakeKitOptions): MakeKitResult {
  const warnings: string[] = [];
  const name = options.name.trim().slice(0, KIT_LIMITS.nameChars);
  if (!name) return { kit: null, warnings: ['A kit needs a name.'] };
  const wanted = options.flagIds ? new Set(options.flagIds) : null;
  const flags: KitFlag[] = [];
  for (const f of hoist.flags) {
    if (wanted && !wanted.has(f.id)) continue;
    const k = kitFlag(f, index, options.layout !== false, warnings);
    if (k) flags.push(k);
  }
  if (flags.length === 0) return { kit: null, warnings: [...warnings, 'Pick at least one flag to save.'] };
  if (flags.length > KIT_LIMITS.flags) return { kit: null, warnings: [`A kit holds at most ${KIT_LIMITS.flags} flags.`] };
  let filters: KitFilter[] = [];
  if (options.pageFilters) {
    filters = hoist.filters.flatMap((f) => {
      const k = kitFilter(f, index);
      if (!k) warnings.push(`A page filter on "${f.field}" was left out: the field is not in the catalog.`);
      return k ? [k] : [];
    });
  }
  const kit: Kit = {
    version: 1,
    kind: 'flag-kit',
    id: options.id ?? kitId(name, []),
    name,
    description: (options.description ?? '').trim().slice(0, KIT_LIMITS.descriptionChars),
    created: (options.now ?? new Date()).toISOString(),
    from: { hoist: hoist.id.slice(0, 64), title: hoist.title.slice(0, KIT_LIMITS.titleChars) },
    cols: hoist.grid.cols,
    filters,
    flags,
  };
  return { kit, warnings };
}

/** A storage id for a kit name that is not in `taken`: "kit-labor-cost", then "kit-labor-cost-2". */
export function kitId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `kit-${slug(name) || 'kit'}`.slice(0, 56);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function kitField(key: string, index: CatalogIndex): KitField | null {
  const f = index.field(key);
  return f ? { key: f.key, label: f.label, type: f.type, synonyms: (f.synonyms ?? []).slice(0, KIT_LIMITS.synonyms).map((s) => s.slice(0, KIT_LIMITS.synonymChars)) } : null;
}

function kitMetric(key: string, index: CatalogIndex): KitMetric | null {
  const m = index.metric(key);
  if (!m) return null;
  return {
    key: m.key,
    label: m.label,
    agg: m.agg,
    ...(m.format ? { format: m.format } : {}),
    synonyms: (m.synonyms ?? []).slice(0, KIT_LIMITS.synonyms).map((s) => s.slice(0, KIT_LIMITS.synonymChars)),
  };
}

function kitFilter(f: Filter, index: CatalogIndex): KitFilter | null {
  const field = kitField(f.field, index);
  return field ? { field, op: f.op, values: [...f.values], ...(f.unit ? { unit: f.unit } : {}) } : null;
}

function kitFlag(f: Flag, index: CatalogIndex, withLayout: boolean, warnings: string[]): KitFlag | null {
  const where = `Flag "${f.title || f.id}"`;
  let binding: KitBinding | null = null;
  const refs = (keys: string[]): KitField[] | null => {
    const out: KitField[] = [];
    for (const k of keys) {
      const r = kitField(k, index);
      if (!r) return null;
      out.push(r);
    }
    return out;
  };
  if (f.binding) {
    const b = f.binding;
    const metrics = b.metrics.map((m) => kitMetric(m, index));
    const dims = b.dimensions.map((d) => kitField(d.field, index));
    const filters = b.filters.map((x) => kitFilter(x, index));
    if (metrics.some((m) => !m) || dims.some((d) => !d) || filters.some((x) => !x)) {
      warnings.push(`${where} was left out: it uses a metric or field that is not in the catalog.`);
      return null;
    }
    binding = {
      metrics: metrics as KitMetric[],
      dimensions: b.dimensions.map((d, i) => ({ field: dims[i] as KitField, ...(d.grain ? { grain: d.grain } : {}) })),
      filters: filters as KitFilter[],
    };
    if (b.sort) {
      const mi = b.metrics.indexOf(b.sort.by);
      const di = b.dimensions.findIndex((d) => dimensionKey(d) === b.sort?.by);
      if (mi >= 0) binding.sort = { by: { kind: 'metric', index: mi }, dir: b.sort.dir };
      else if (di >= 0) binding.sort = { by: { kind: 'dimension', index: di }, dir: b.sort.dir };
    }
    if (b.limit) binding.limit = b.limit;
    if (b.compare) binding.compare = b.compare;
    if (b.share) binding.share = true;
  }
  const ignore = refs(f.behavior.ignore);
  const thresholds = f.behavior.thresholds.map((t) => ({ t, m: kitMetric(t.metric, index) }));
  if (!ignore || thresholds.some((x) => !x.m)) {
    warnings.push(`${where} was left out: its behaviour names a metric or field that is not in the catalog.`);
    return null;
  }
  const out: KitFlag = {
    kind: f.kind,
    title: f.title.slice(0, KIT_LIMITS.titleChars),
    brief: f.brief.slice(0, LIMITS.briefChars),
    binding,
    behavior: {
      onClick: f.behavior.onClick,
      ignore,
      thresholds: thresholds.map(({ t, m }) => ({ metric: m as KitMetric, op: t.op, value: t.value, tone: t.tone })),
    },
    reviewed: f.status === 'ready',
  };
  // Kits hold whole-cell layouts, so a flag placed freely rounds to the nearest cell and any hoist can take it.
  if (withLayout) out.layout = { x: Math.round(f.layout.x), y: Math.round(f.layout.y), w: Math.max(1, Math.round(f.layout.w)), h: Math.max(1, Math.round(f.layout.h)) };
  if (f.kind === 'text' && f.text) out.text = f.text.slice(0, KIT_LIMITS.textChars);
  if (f.kind === 'custom' && f.widget) out.widget = { ...f.widget };
  if (f.learn === false) out.learn = false;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Export and import

/** The kit as a file: pretty JSON with its version field. */
export function exportKit(kit: Kit): string {
  return JSON.stringify(kit, null, 2);
}

export interface KitParse {
  kit: Kit | null;
  /** Why it was rejected. Empty when kit is set. */
  errors: string[];
}

/** Parse the text of a kit file. Rejects oversized text, bad JSON and anything that is not a valid kit. */
export function parseKitText(text: string): KitParse {
  if (typeof text !== 'string') return reject('Not a kit file.');
  if (text.length > KIT_LIMITS.chars) return reject(`This file is larger than the ${Math.round(KIT_LIMITS.chars / 1000)} KB a kit may be.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reject('This file is not valid JSON.');
  }
  return parseKit(raw);
}

const reject = (...errors: string[]): KitParse => ({ kit: null, errors });

/**
 * Validate an untrusted kit. Strict: any malformed part rejects the whole kit, so a kit that
 * parses is one that can be applied. Unknown properties are dropped; the result is rebuilt.
 */
export function parseKit(raw: unknown): KitParse {
  const errors: string[] = [];
  const bad = (m: string) => {
    if (errors.length < KIT_LIMITS.errors) errors.push(m);
  };
  if (!isObject(raw)) return reject('Not a Semaphore flag kit.');
  if (raw.kind !== 'flag-kit') return reject('Not a Semaphore flag kit.');
  if (raw.version !== KIT_VERSION) {
    return reject(typeof raw.version === 'number' && raw.version > KIT_VERSION ? `This kit was made by a newer Semaphore (kit version ${raw.version}).` : 'Unsupported kit version.');
  }
  const id = text(raw.id, 64, 'id', bad, true);
  if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) bad('The kit id may use letters, digits, _ and - only.');
  const name = text(raw.name, KIT_LIMITS.nameChars, 'name', bad, true).trim();
  if (!name) bad('The kit needs a name.');
  const description = text(raw.description ?? '', KIT_LIMITS.descriptionChars, 'description', bad, false);
  const created = text(raw.created ?? '', 40, 'created', bad, false);
  const cols = raw.cols;
  if (!isInt(cols) || cols < 4 || cols > 24) bad('The grid width must be a whole number from 4 to 24.');
  let from: Kit['from'];
  if (raw.from !== undefined) {
    if (isObject(raw.from)) from = { hoist: text(raw.from.hoist ?? '', 64, 'from.hoist', bad, false), title: text(raw.from.title ?? '', KIT_LIMITS.titleChars, 'from.title', bad, false) };
    else bad('"from" must be an object.');
  }
  const filters = list(raw.filters ?? [], LIMITS.filters, 'page filters', bad).map((f, i) => parseKitFilter(f, `Page filter ${i + 1}`, bad));
  const rawFlags = list(raw.flags, KIT_LIMITS.flags, 'flags', bad);
  if (rawFlags.length === 0) bad('A kit needs at least one flag.');
  const flags = rawFlags.map((f, i) => parseKitFlag(f, `Flag ${i + 1}`, bad));
  if (errors.length) return { kit: null, errors };
  const kit: Kit = {
    version: 1,
    kind: 'flag-kit',
    id,
    name,
    description,
    created,
    ...(from ? { from } : {}),
    cols: cols as number,
    filters: filters as KitFilter[],
    flags: flags as KitFlag[],
  };
  return { kit, errors: [] };
}

/** A quick shape test for documents read from a store that holds other kinds of notes too. */
export function isKitDocument(raw: unknown): boolean {
  return isObject(raw) && raw.version === KIT_VERSION && raw.kind === 'flag-kit' && typeof raw.id === 'string';
}

type Bad = (m: string) => void;

function parseKitField(raw: unknown, where: string, bad: Bad): KitField | null {
  if (!isObject(raw)) {
    bad(`${where}: a field reference is not an object.`);
    return null;
  }
  const key = text(raw.key, KIT_LIMITS.keyChars, `${where}: field key`, bad, true);
  const label = text(raw.label ?? '', KIT_LIMITS.labelChars, `${where}: field label`, bad, false);
  if (!FIELD_TYPES.includes(raw.type as FieldType)) bad(`${where}: field "${key.slice(0, 40)}" has an unknown type.`);
  return { key, label: label || key, type: raw.type as FieldType, synonyms: parseSynonyms(raw.synonyms, where, bad) };
}

function parseKitMetric(raw: unknown, where: string, bad: Bad): KitMetric | null {
  if (!isObject(raw)) {
    bad(`${where}: a metric reference is not an object.`);
    return null;
  }
  const key = text(raw.key, KIT_LIMITS.keyChars, `${where}: metric key`, bad, true);
  const label = text(raw.label ?? '', KIT_LIMITS.labelChars, `${where}: metric label`, bad, false);
  if (!AGGREGATES.includes(raw.agg as Aggregate)) bad(`${where}: metric "${key.slice(0, 40)}" has an unknown aggregate.`);
  if (raw.format !== undefined && !FORMATS.includes(raw.format as 'number')) bad(`${where}: metric "${key.slice(0, 40)}" has an unknown format.`);
  return {
    key,
    label: label || key,
    agg: raw.agg as Aggregate,
    ...(raw.format !== undefined ? { format: raw.format as KitMetric['format'] & string } : {}),
    synonyms: parseSynonyms(raw.synonyms, where, bad),
  };
}

function parseSynonyms(raw: unknown, where: string, bad: Bad): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > KIT_LIMITS.synonyms) {
    bad(`${where}: synonyms must be a list of at most ${KIT_LIMITS.synonyms}.`);
    return [];
  }
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || s.length > KIT_LIMITS.synonymChars) bad(`${where}: a synonym is not text of at most ${KIT_LIMITS.synonymChars} characters.`);
    else out.push(s);
  }
  return out;
}

function parseKitFilter(raw: unknown, where: string, bad: Bad): KitFilter | null {
  if (!isObject(raw)) {
    bad(`${where}: not an object.`);
    return null;
  }
  const field = parseKitField(raw.field, where, bad);
  const op = raw.op as FilterOp;
  if (!FILTER_OPS.includes(op)) bad(`${where}: unknown filter operator.`);
  const values = list(raw.values, LIMITS.filterValues, `${where}: values`, bad);
  if (!values.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) bad(`${where}: values must be text or numbers.`);
  const arity = op === 'between' ? 2 : op === 'in' ? -1 : 1;
  if ((arity === -1 && values.length === 0) || (arity > 0 && values.length !== arity)) bad(`${where}: wrong number of values for "${String(op)}".`);
  const out: KitFilter = { field: field as KitField, op, values: values as Array<string | number> };
  if (raw.unit !== undefined) {
    if (TIME_GRAINS.includes(raw.unit as TimeGrain)) out.unit = raw.unit as TimeGrain;
    else bad(`${where}: unknown time unit.`);
  }
  if (op === 'last' && !(out.unit && typeof values[0] === 'number' && Number.isInteger(values[0]) && values[0] >= 1 && values[0] <= 1000)) bad(`${where}: a "last" filter needs a whole count and a unit.`);
  return out;
}

function parseKitFlag(raw: unknown, where: string, bad: Bad): KitFlag | null {
  if (!isObject(raw)) {
    bad(`${where}: not an object.`);
    return null;
  }
  if (!FLAG_KINDS.includes(raw.kind as FlagKind)) bad(`${where}: unknown kind.`);
  const kind = raw.kind as FlagKind;
  const out: KitFlag = {
    kind,
    title: text(raw.title ?? '', KIT_LIMITS.titleChars, `${where}: title`, bad, false),
    brief: text(raw.brief ?? '', LIMITS.briefChars, `${where}: brief`, bad, false),
    binding: null,
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    reviewed: raw.reviewed === true,
  };
  if (raw.layout !== undefined) {
    const l = raw.layout;
    if (isObject(l) && isInt(l.x) && isInt(l.y) && isInt(l.w) && isInt(l.h) && l.x >= 0 && l.y >= 0 && l.y <= MAX_Y && l.w >= 1 && l.w <= 24 && l.h >= 1 && l.h <= 24 && l.x + l.w <= 24) out.layout = { x: l.x, y: l.y, w: l.w, h: l.h };
    else bad(`${where}: invalid layout.`);
  }
  if (kind === 'text') out.text = text(raw.text ?? '', KIT_LIMITS.textChars, `${where}: text`, bad, false);
  if (kind === 'custom' && raw.widget !== undefined) {
    const problems: string[] = [];
    const widget = parseWidget(raw.widget, problems, where);
    if (widget) out.widget = widget;
    for (const p of problems) bad(p);
  }
  if (raw.learn === false) out.learn = false;
  if (raw.binding !== undefined && raw.binding !== null) {
    const b = raw.binding;
    if (!isObject(b)) bad(`${where}: binding is not an object.`);
    else {
      const metrics = list(b.metrics ?? [], LIMITS.metrics, `${where}: metrics`, bad).map((m) => parseKitMetric(m, where, bad));
      const dimensions = list(b.dimensions ?? [], LIMITS.dimensions, `${where}: fields`, bad).map((d): KitDimension | null => {
        if (!isObject(d)) {
          bad(`${where}: a field entry is not an object.`);
          return null;
        }
        const field = parseKitField(d.field, where, bad);
        if (d.grain !== undefined && !TIME_GRAINS.includes(d.grain as TimeGrain)) bad(`${where}: unknown grain.`);
        if (d.grain !== undefined && field && field.type !== 'date') bad(`${where}: a grain on a field that is not a date.`);
        return { field: field as KitField, ...(d.grain !== undefined ? { grain: d.grain as TimeGrain } : {}) };
      });
      if (metrics.length === 0 && dimensions.length === 0) bad(`${where}: binding has no metric or field.`);
      const binding: KitBinding = {
        metrics: metrics as KitMetric[],
        dimensions: dimensions as KitDimension[],
        filters: list(b.filters ?? [], LIMITS.filters, `${where}: filters`, bad).map((f) => parseKitFilter(f, where, bad)) as KitFilter[],
      };
      if (b.sort !== undefined) {
        const s = b.sort;
        const by = isObject(s) && isObject(s.by) ? s.by : null;
        const size = by?.kind === 'metric' ? metrics.length : by?.kind === 'dimension' ? dimensions.length : -1;
        if (by && isInt(by.index) && by.index >= 0 && by.index < size && isObject(s) && (s.dir === 'asc' || s.dir === 'desc')) {
          binding.sort = { by: { kind: by.kind as 'metric' | 'dimension', index: by.index }, dir: s.dir };
        } else bad(`${where}: invalid sort.`);
      }
      if (b.limit !== undefined) {
        if (isInt(b.limit) && b.limit > 0 && b.limit <= 10000) binding.limit = b.limit;
        else bad(`${where}: invalid limit.`);
      }
      if (b.compare !== undefined) {
        if (COMPARISONS.includes(b.compare as Comparison)) binding.compare = b.compare as Comparison;
        else bad(`${where}: unknown comparison.`);
      }
      if (b.share === true) binding.share = true;
      out.binding = binding;
    }
  }
  if (raw.behavior !== undefined) {
    const be = raw.behavior;
    if (!isObject(be)) bad(`${where}: behaviour is not an object.`);
    else {
      if (be.onClick === 'filter-page' || be.onClick === 'drill' || be.onClick === 'none') out.behavior.onClick = be.onClick;
      else if (be.onClick !== undefined) bad(`${where}: unknown click behaviour.`);
      out.behavior.ignore = list(be.ignore ?? [], LIMITS.ignore, `${where}: ignored fields`, bad).map((f) => parseKitField(f, where, bad)) as KitField[];
      out.behavior.thresholds = list(be.thresholds ?? [], LIMITS.thresholds, `${where}: thresholds`, bad).map((t): KitThreshold | null => {
        if (!isObject(t)) {
          bad(`${where}: a threshold is not an object.`);
          return null;
        }
        if (!['lt', 'lte', 'gt', 'gte'].includes(t.op as string) || typeof t.value !== 'number' || !Number.isFinite(t.value) || !['good', 'warn', 'bad'].includes(t.tone as string)) bad(`${where}: malformed threshold.`);
        return { metric: parseKitMetric(t.metric, where, bad) as KitMetric, op: t.op as Threshold['op'], value: t.value as number, tone: t.tone as Tone };
      }) as KitThreshold[];
    }
  }
  return out;
}

const FIELD_TYPES: readonly FieldType[] = ['number', 'string', 'date', 'boolean'];
const AGGREGATES: readonly Aggregate[] = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'];
const FORMATS = ['number', 'currency', 'percent'];

function text(v: unknown, max: number, what: string, bad: Bad, required: boolean): string {
  if (typeof v !== 'string') {
    if (required || v !== undefined) bad(`${what} must be text.`);
    return '';
  }
  if (v.length > max) {
    bad(`${what} is longer than ${max} characters.`);
    return '';
  }
  if (required && v === '') bad(`${what} is empty.`);
  return v;
}

function list(v: unknown, max: number, what: string, bad: Bad): unknown[] {
  if (!Array.isArray(v)) {
    bad(`${what} must be a list.`);
    return [];
  }
  if (v.length > max) {
    bad(`${what}: more than ${max} entries.`);
    return [];
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Matching

export type MatchTier = 'exact' | 'label' | 'synonym' | 'similar';

export interface Suggestion {
  key: string;
  label: string;
}

/** What one reference in the kit became in the new catalog. */
export interface Mapping {
  role: 'metric' | 'field';
  from: { key: string; label: string };
  /** Set when the reference was remapped (or found unchanged). */
  to?: { key: string; label: string };
  tier?: MatchTier;
  /** Why it was not remapped. */
  reason?: string;
  /** Close candidates that were not used, best first. */
  suggestions: Suggestion[];
}

export interface KitApplyOptions {
  /** Use a "similar" match (words overlap, nothing else agrees). Default false: report it as a suggestion. */
  closeMatches?: boolean;
  /** Also add the kit's page filters to the hoist (default false). */
  pageFilters?: boolean;
  now?: Date;
}

const SIMILAR_MIN = 0.5;

const STOP = new Set(['of', 'the', 'by', 'per', 'a', 'an', 'and', 'total', 'count', 'number']);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Lowercase words with plurals folded: "Work Orders" and "work_order" both become "work order". */
function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

const phrase = (s: string) => words(s).join(' ');
const tail = (key: string) => key.slice(key.lastIndexOf('.') + 1);
const scope = (key: string) => (key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '');

interface Ref {
  key: string;
  label: string;
  synonyms?: readonly string[];
}

/** The phrases that name a thing outright (its label), and those that only hint at it (synonyms, column name). */
function names(r: Ref): { label: Set<string>; alias: Set<string> } {
  const label = new Set([phrase(r.label)].filter(Boolean));
  const alias = new Set([...(r.synonyms ?? []).map(phrase), phrase(tail(r.key))].filter(Boolean));
  return { label, alias };
}

function wordSet(r: Ref): Set<string> {
  const out = new Set<string>();
  for (const s of [r.label, tail(r.key), ...(r.synonyms ?? [])]) for (const w of words(s)) if (!STOP.has(w)) out.add(w);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

interface Found<T> {
  target: T;
  tier: MatchTier;
}

/**
 * Finds the one target for `src` among `targets` that satisfies `compat`, trying each tier in turn.
 * A tier with several candidates is ambiguous and is not guessed from: it ends the search.
 */
interface MatchResult<T> {
  found?: Found<T>;
  reason?: string;
  suggestions: Suggestion[];
}

function match<T extends Ref>(src: Ref, targets: readonly T[], compat: (t: T) => boolean, why: (t: T) => string, closeMatches: boolean): MatchResult<T> {
  const ok = targets.filter(compat);
  const sn = names(src);
  const sugg = (list: readonly T[]): Suggestion[] => list.slice(0, 3).map((t) => ({ key: t.key, label: t.label }));
  const pick = (list: T[], tier: MatchTier): MatchResult<T> | null => {
    if (list.length === 1) return { found: { target: list[0] as T, tier }, suggestions: [] };
    if (list.length > 1) {
      const near = list.filter((t) => scope(t.key) === scope(src.key));
      if (near.length === 1) return { found: { target: near[0] as T, tier }, suggestions: [] };
      return { reason: `Matches ${list.length} in the new catalog (${list.slice(0, 3).map((t) => `"${t.label}"`).join(', ')}); not guessed.`, suggestions: sugg(list) };
    }
    return null;
  };
  const exact = ok.filter((t) => t.key === src.key);
  const r1 = pick(exact, 'exact');
  if (r1) return r1;
  const r2 = pick(ok.filter((t) => [...names(t).label].some((p) => sn.label.has(p))), 'label');
  if (r2) return r2;
  const r3 = pick(
    ok.filter((t) => {
      const tn = names(t);
      return [...sn.label, ...sn.alias].some((p) => tn.alias.has(p)) || [...sn.alias].some((p) => tn.label.has(p));
    }),
    'synonym',
  );
  if (r3) return r3;
  const sw = wordSet(src);
  const scored = ok
    .map((t) => ({ t, s: jaccard(sw, wordSet(t)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (best && best.s >= SIMILAR_MIN && (scored.length === 1 || best.s > (scored[1] as { s: number }).s)) {
    if (closeMatches) return { found: { target: best.t, tier: 'similar' }, suggestions: [] };
    return { reason: `Only a close match, "${best.t.label}", and close matches are off.`, suggestions: sugg(scored.map((x) => x.t)) };
  }
  // Nothing usable. If the same name exists but is the wrong kind of thing, say so rather than "not found".
  const wrong = targets.find((t) => {
    if (compat(t)) return false;
    const tn = names(t);
    return t.key === src.key || [...sn.label].some((p) => tn.label.has(p) || tn.alias.has(p)) || [...sn.alias].some((p) => tn.label.has(p) || tn.alias.has(p));
  });
  return { reason: wrong ? why(wrong) : 'Nothing in the new catalog has this name.', suggestions: sugg(scored.map((x) => x.t)) };
}

class Resolver {
  private metrics = new Map<string, Mapping>();
  private fields = new Map<string, Mapping>();
  private metricList: readonly Metric[];
  private fieldList: readonly Field[];
  private closeMatches: boolean;

  constructor(index: CatalogIndex, closeMatches: boolean) {
    this.closeMatches = closeMatches;
    this.metricList = index.catalog.metrics;
    this.fieldList = index.catalog.fields;
  }

  metric(ref: KitMetric): Mapping {
    const hit = this.metrics.get(ref.key);
    if (hit) return hit;
    const compat = (t: Metric) => t.agg === ref.agg && (!ref.format || !t.format || t.format === ref.format);
    const why = (t: Metric) =>
      t.agg !== ref.agg ? `"${t.label}" exists but is a ${aggName(t.agg)}; the kit needs a ${aggName(ref.agg)}.` : `"${t.label}" exists but is shown as ${t.format}; the kit needs ${ref.format}.`;
    const r = match<Metric>(ref, this.metricList, compat, why, this.closeMatches);
    const m = mapping('metric', ref, r);
    this.metrics.set(ref.key, m);
    return m;
  }

  field(ref: KitField): Mapping {
    const hit = this.fields.get(ref.key);
    if (hit) return hit;
    const compat = (t: Field) => t.type === ref.type;
    const why = (t: Field) => `"${t.label}" exists but is a ${t.type} field; the kit needs a ${ref.type} field.`;
    const r = match<Field>(ref, this.fieldList, compat, why, this.closeMatches);
    const m = mapping('field', ref, r);
    this.fields.set(ref.key, m);
    return m;
  }
}

const aggName = (a: Aggregate) => (a === 'count_distinct' ? 'distinct count' : a === 'avg' ? 'average' : a);

function mapping(role: Mapping['role'], ref: Ref, r: MatchResult<Ref>): Mapping {
  const out: Mapping = { role, from: { key: ref.key, label: ref.label }, suggestions: r.suggestions };
  if (r.found) {
    out.to = { key: r.found.target.key, label: r.found.target.label };
    out.tier = r.found.tier;
  } else out.reason = r.reason ?? 'No match.';
  return out;
}

// ---------------------------------------------------------------------------------------------
// Applying

export type FlagOutcome =
  /** Every reference found under its own key: the flag is as it was. */
  | 'kept'
  /** Remapped by label, synonym or close match; the flag is a draft to check. */
  | 'remapped'
  /** Bound, but a filter, ignore rule, threshold or comparison could not follow; a draft. */
  | 'partial'
  /** A metric or field could not be matched: the flag keeps its title and brief and has no binding. */
  | 'unbound';

export interface FlagReport {
  /** Title in the kit. */
  title: string;
  kind: FlagKind;
  outcome: FlagOutcome;
  /** Id of the new flag in the hoist. */
  flagId: string;
  mappings: Mapping[];
  /** Parts left out of a bound flag, in words. */
  dropped: string[];
}

export interface KitReport {
  applied: boolean;
  /** Why nothing was applied, or what the check after remapping found. */
  problems: string[];
  flags: FlagReport[];
  counts: Record<FlagOutcome, number>;
  /** The page filters, when asked for. */
  pageFilters: Mapping[];
  pageFiltersAdded: number;
}

export interface KitApplied {
  hoist: Hoist;
  report: KitReport;
}

const CONFIDENCE: Record<MatchTier, number> = { exact: 1, label: 0.9, synonym: 0.8, similar: 0.5 };

/**
 * Adds the kit's flags to `hoist`, remapped to `index`'s catalog, below the flags already there.
 * `hoist` itself is not changed. The result passes parseHoist against the same catalog.
 */
export function applyKit(kit: Kit, hoist: Hoist, index: CatalogIndex, options: KitApplyOptions = {}): KitApplied {
  const resolver = new Resolver(index, options.closeMatches === true);
  const report: KitReport = { applied: false, problems: [], flags: [], counts: { kept: 0, remapped: 0, partial: 0, unbound: 0 }, pageFilters: [], pageFiltersAdded: 0 };
  if (hoist.flags.length + kit.flags.length > LIMITS.flags) {
    report.problems.push(`A hoist holds at most ${LIMITS.flags} flags; this kit would make ${hoist.flags.length + kit.flags.length}.`);
    return { hoist, report };
  }

  // Page filters first: a flag's comparison needs a "last" filter on the flag or the page.
  const pageFilters: Filter[] = [];
  if (options.pageFilters) {
    for (const f of kit.filters) {
      const m = resolver.field(f.field);
      report.pageFilters.push(m);
      if (m.to) pageFilters.push({ field: m.to.key, op: f.op, values: [...f.values], ...(f.unit ? { unit: f.unit } : {}) });
    }
  }
  const pageHasLast = [...hoist.filters, ...pageFilters].some((f) => f.op === 'last');

  const used = new Set(hoist.flags.map((f) => f.id));
  const prefix = slug(kit.name) || 'kit';
  const newId = () => {
    for (let n = 1; ; n++) {
      const id = `${prefix}-${n}`.slice(0, 64);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };

  const flags: Flag[] = [];
  for (const kf of kit.flags) {
    const { flag, flagReport } = remapFlag(kf, newId(), resolver, pageHasLast, kit.name);
    flags.push(flag);
    report.flags.push(flagReport);
    report.counts[flagReport.outcome]++;
  }

  // Layout: below what is already on the page, keeping the kit's arrangement when it has one.
  const cols = hoist.grid.cols;
  const baseY = hoist.flags.reduce((y, f) => Math.max(y, f.layout.y + f.layout.h), 0);
  const withLayout = kit.flags.filter((f) => f.layout);
  const minY = withLayout.reduce((y, f) => Math.min(y, (f.layout as Layout).y), Number.POSITIVE_INFINITY);
  const placed: Flag[] = [];
  flags.forEach((flag, i) => {
    const l = kit.flags[i]?.layout;
    if (l) {
      flag.layout = clampLayout({ x: l.x, y: l.y - minY + baseY, w: l.w, h: l.h }, cols);
    } else {
      const size = DEFAULT_SIZE[flag.kind];
      flag.layout = findSlot([...hoist.flags, ...placed], size.w, size.h, cols);
    }
    placed.push(flag);
  });

  let next: Hoist = {
    ...hoist,
    filters: [...hoist.filters],
    flags: [...hoist.flags, ...flags],
    updated: (options.now ?? new Date()).toISOString(),
  };
  for (const f of pageFilters) {
    if (!next.filters.some((x) => JSON.stringify(x) === JSON.stringify(f))) {
      next.filters.push(f);
      report.pageFiltersAdded++;
    }
  }
  const mode = hoist.grid.mode ?? 'snap';
  if (!isValidLayout(next.flags, cols, mode)) {
    const fixed = new Map((mode === 'auto' ? compact(next.flags) : snapAll(next.flags, cols)).map((p) => [p.id, p.layout]));
    next = { ...next, flags: next.flags.map((f) => ({ ...f, layout: fixed.get(f.id) ?? f.layout })) };
  }

  // The check that matters: the result must be a valid hoist for this catalog, with no repairs.
  const checked = parseHoist(JSON.parse(JSON.stringify(next)), index);
  if (!checked.hoist) {
    report.problems.push(...checked.warnings);
    return { hoist, report };
  }
  report.problems.push(...checked.warnings);
  report.applied = true;
  return { hoist: checked.hoist, report };
}

function remapFlag(kf: KitFlag, id: string, resolver: Resolver, pageHasLast: boolean, kitName: string): { flag: Flag; flagReport: FlagReport } {
  const mappings: Mapping[] = [];
  const dropped: string[] = [];
  const base: Flag = {
    id,
    kind: kf.kind,
    title: kf.title,
    brief: kf.brief,
    layout: kf.layout ? { ...kf.layout } : { x: 0, y: 0, ...DEFAULT_SIZE[kf.kind] },
    binding: null,
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    status: 'empty',
    notes: [],
  };
  if (kf.learn === false) base.learn = false;
  if (kf.kind === 'custom' && kf.widget) base.widget = { ...kf.widget };
  const finish = (outcome: FlagOutcome): { flag: Flag; flagReport: FlagReport } => ({ flag: base, flagReport: { title: kf.title, kind: kf.kind, outcome, flagId: id, mappings, dropped } });

  if (kf.kind === 'text') {
    base.text = kf.text ?? '';
    base.status = 'ready';
    return finish('kept');
  }
  base.behavior.onClick = kf.behavior.onClick;
  if (!kf.binding) return finish('kept');

  // Required parts: every metric and field the flag shows. One missing and the flag is not bound.
  const kb = kf.binding;
  const metricMaps = kb.metrics.map((m) => resolver.metric(m));
  const dimMaps = kb.dimensions.map((d) => resolver.field(d.field));
  mappings.push(...metricMaps, ...dimMaps);
  const missing = mappings.filter((m) => !m.to);
  if (missing.length) {
    base.notes.push(`From kit "${kitName}": not bound. ${missing.map((m) => `"${m.from.label}" ${m.reason ?? 'has no match'}`).join(' ')}`.slice(0, 600));
    return finish('unbound');
  }

  const metrics: string[] = [];
  kb.metrics.forEach((_, i) => {
    const to = (metricMaps[i] as Mapping).to?.key as string;
    if (!metrics.includes(to)) metrics.push(to);
  });
  const dimRefs: DimensionRef[] = kb.dimensions.map((d, i) => ({ field: (dimMaps[i] as Mapping).to?.key as string, ...(d.grain ? { grain: d.grain } : {}) }));
  const dimensions: DimensionRef[] = [];
  for (const ref of dimRefs) if (!dimensions.some((x) => dimensionKey(x) === dimensionKey(ref))) dimensions.push(ref);
  const binding: Binding = { metrics, dimensions, filters: [] };

  // Optional parts follow when they can and are reported when they cannot.
  for (const f of kb.filters) {
    const m = resolver.field(f.field);
    mappings.push(m);
    if (m.to) binding.filters.push({ field: m.to.key, op: f.op, values: [...f.values], ...(f.unit ? { unit: f.unit } : {}) });
    else dropped.push(`filter on "${f.field.label}": ${m.reason ?? 'no match'}`);
  }
  if (kb.sort) {
    const target = kb.sort.by.kind === 'metric' ? (metricMaps[kb.sort.by.index] as Mapping).to?.key : dimRefs[kb.sort.by.index] && dimensionKey(dimRefs[kb.sort.by.index] as DimensionRef);
    if (target) binding.sort = { by: target, dir: kb.sort.dir };
    else dropped.push('the sort order');
  }
  if (kb.limit) binding.limit = kb.limit;
  if (kb.share) binding.share = true;
  if (kb.compare) {
    if (binding.filters.some((f) => f.op === 'last') || pageHasLast) binding.compare = kb.compare;
    else dropped.push('the comparison with an earlier period (no "last N" date window to compare)');
  }
  for (const f of kf.behavior.ignore) {
    const m = resolver.field(f);
    mappings.push(m);
    if (m.to) {
      if (!base.behavior.ignore.includes(m.to.key)) base.behavior.ignore.push(m.to.key);
    } else dropped.push(`ignoring "${f.label}": ${m.reason ?? 'no match'}`);
  }
  for (const t of kf.behavior.thresholds) {
    const m = resolver.metric(t.metric);
    mappings.push(m);
    if (m.to) base.behavior.thresholds.push({ metric: m.to.key, op: t.op, value: t.value, tone: t.tone });
    else dropped.push(`the colour rule on "${t.metric.label}": ${m.reason ?? 'no match'}`);
  }
  base.binding = binding;

  const tiers = mappings.filter((m) => m.to).map((m) => m.tier as MatchTier);
  const changed = mappings.filter((m) => m.to && m.from.key !== m.to.key);
  const kept = dropped.length === 0 && tiers.every((t) => t === 'exact');
  for (const m of changed) base.notes.push(`From kit "${kitName}": "${m.from.label}" became "${m.to?.label}" (${m.tier} match).`);
  for (const d of dropped) base.notes.push(`From kit "${kitName}": left out ${d}.`);
  base.notes = base.notes.slice(0, 20);
  if (kept) {
    base.status = kf.reviewed ? 'ready' : 'drafted';
    return finish('kept');
  }
  base.status = 'drafted';
  const worst = tiers.reduce((c, t) => Math.min(c, CONFIDENCE[t]), 1);
  base.confidence = dropped.length ? Math.min(worst, 0.6) : worst;
  return finish(dropped.length ? 'partial' : 'remapped');
}

/** One line for each flag of a report, for logs and tests. */
export function describeReport(report: KitReport): string[] {
  return report.flags.map((f) => {
    const bits = f.mappings.filter((m) => m.to && m.from.key !== m.to.key).map((m) => `${m.from.label} -> ${m.to?.label}`);
    const miss = f.mappings.filter((m) => !m.to).map((m) => `${m.from.label}: ${m.reason}`);
    return `${f.title || '(untitled)'}: ${f.outcome}${bits.length ? ` [${bits.join(', ')}]` : ''}${miss.length ? ` {${miss.join('; ')}}` : ''}${f.dropped.length ? ` left out: ${f.dropped.join('; ')}` : ''}`;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

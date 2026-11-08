// What every intelligence provider receives and returns, and the one validation path all
// provider output goes through. Providers see the catalog summary below and the analyst's
// briefs. They never see rows, connection details, table or column names, or credentials. The one
// exception is a cleaning suggestion the analyst asks for: one field's distinct values (TaskRequest).

import type { Catalog, CatalogIndex } from '../catalog.ts';
import { fitRichKind, isRichKind } from '../kinds.ts';
import { parseModelSpec } from '../predict/spec.ts';
import type { ModelSpec } from '../predict/types.ts';
import {
  type Behavior,
  type Binding,
  type EffectiveBrief,
  capWarnings,
  FLAG_KINDS,
  type Filter,
  type FlagKind,
  LIMITS,
  parseBehavior,
  parseBinding,
  parseFilters,
} from '../hoist.ts';

export const CONTRACT_VERSION = 1;

export interface CatalogSummary {
  /** `set` numbers the sources (1, 2, ...) without naming them: a flag reads from one set. `table` numbers the tables the same way, so a metric can be paired with fields of its own table without a table or column name leaving the machine. */
  metrics: Array<{ key: string; label: string; agg: string; set: number; table?: number; synonyms?: string[] }>;
  fields: Array<{ key: string; label: string; type: string; set: number; table?: number; synonyms?: string[] }>;
}

/** Strip a catalog down to what a provider may see: keys, labels, types, synonyms and set numbers. */
export function summarizeCatalog(catalog: Catalog): CatalogSummary {
  const set = (source: string) => catalog.sources.findIndex((s) => s.id === source) + 1;
  const tables = new Map<string, number>();
  const tableNo = (source: string, table: string | undefined): number | undefined => {
    if (!table) return undefined;
    const id = `${source}|${table}`;
    if (!tables.has(id)) tables.set(id, tables.size + 1);
    return tables.get(id);
  };
  const fieldByKey = new Map(catalog.fields.map((f) => [f.key, f]));
  const fields = catalog.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, set: set(f.source), ...(tableNo(f.source, f.table) ? { table: tableNo(f.source, f.table) } : {}), ...(f.synonyms?.length ? { synonyms: f.synonyms } : {}) }));
  const metrics = catalog.metrics.map((m) => {
    const t = tableNo(m.source, m.table ?? (m.field ? fieldByKey.get(m.field)?.table : undefined));
    return { key: m.key, label: m.label, agg: m.agg, set: set(m.source), ...(t ? { table: t } : {}), ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}) };
  });
  return { metrics, fields };
}

/**
 * A reviewed playbook entry stripped down to what a provider may see as a worked example: the
 * analyst's brief and the answer they accepted, as catalog keys and labels. Built only by
 * selectExamples() (examples.ts), field by field. Never rows, snapshots, results, filter values,
 * table or source names, or the names of the people who built or accepted the entry.
 */
export interface WorkedExample {
  /** The question in the analyst's words, with people's names taken out and capped. */
  brief: string;
  kind: FlagKind;
  metrics: Array<{ key: string; label: string }>;
  dimensions: Array<{ key: string; label: string; grain?: string }>;
  /** Which fields were filtered and how. Values are left out, except the length of a "last N" window. */
  filters: Array<{ field: string; label: string; op: string; last?: { count: number; unit: string } }>;
  /** The page window the entry was accepted under ("last 12 months"), when it had one. */
  window?: { field: string; label: string; count: number; unit: string };
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit?: number;
  compare?: string;
  share?: boolean;
  thresholds?: Array<{ metric: string; op: string; value: number; tone: string }>;
}

export interface DraftFlagRequest {
  task: 'draft-flag';
  brief: EffectiveBrief;
  catalog: CatalogSummary;
  /** The team style card in plain sentences (src/core/style.ts), when there is one. */
  teamStyle?: string[];
  /**
   * Reviewed examples most like the brief, only when the analyst switched them on (examples.ts).
   * Optional and additive: a provider that does not know the field ignores it, and contract
   * version 1 is unchanged.
   */
  examples?: WorkedExample[];
}

export interface DraftHoistRequest {
  task: 'draft-hoist';
  brief: string;
  catalog: CatalogSummary;
  teamStyle?: string[];
  examples?: WorkedExample[];
}

export interface FlagDraft {
  kind: FlagKind;
  title: string;
  binding: Binding | null;
  behavior: Behavior;
  confidence: number;
  notes: string[];
  /** The model that actually answered, when Fairlead fell back from the one asked for. */
  answeredBy?: string;
  /** For a `model` draft: which predictive model, and its settings. */
  model?: ModelSpec;
}

export interface HoistDraft {
  title: string;
  filters: Filter[];
  flags: Array<FlagDraft & { brief: string }>;
  notes: string[];
  answeredBy?: string;
}

/** The model a provider says actually answered (remote.ts sets it on a fallback), if any. */
export function answeredBy(raw: unknown): string | undefined {
  return isObject(raw) && typeof raw.answeredBy === 'string' ? raw.answeredBy.slice(0, 200) : undefined;
}

export interface IntelligenceProvider {
  id: string;
  label: string;
  /** True when nothing leaves the workstation. */
  local: boolean;
  ping(): Promise<string>;
  listModels?(): Promise<string[]>;
  /** Raw output; always passed through validateFlagDraft() before use. */
  draftFlag(request: DraftFlagRequest): Promise<unknown>;
  /** Raw output; always passed through validateHoistDraft() before use. */
  draftHoist(request: DraftHoistRequest): Promise<unknown>;
  /** A smaller JSON task (tasks.ts), validated by its caller. Absent for local rules. */
  runTask?(request: TaskRequest): Promise<unknown>;
}

/**
 * The smaller tasks: cleaning proposals, reading a Qlik expression, writing a briefing. Each says
 * what it sends. Cleaning is the one task that carries data: one field's distinct labels (never
 * rows), sent only when the analyst presses the button that says so.
 */
export interface TaskRequest {
  task: 'propose-cleaning' | 'read-qlik-expression' | 'write-briefing';
  /** Instructions for an OpenAI-compatible model; contract endpoints know their tasks. */
  system: string;
  payload: Record<string, unknown>;
}

export class IntelligenceError extends Error {}

export interface ValidateOptions {
  /** The analyst's words (page and flag brief). A colour rule is kept only when they ask for one. */
  brief?: string;
  /** The draft came from a model, whose own confidence is capped: it has not seen the data. */
  remote?: boolean;
}

const COLOUR_WORD = /\b(red|amber|green|yellow|orange|colou?rs?|highlight|thresholds?|warn|warning|alert)\b/i;
export const MODEL_CONFIDENCE_CAP = 0.8;

/** Turn untrusted provider output into a draft. Unknown keys are dropped and reported. */
export function validateFlagDraft(raw: unknown, index: CatalogIndex, fallbackKind: FlagKind, options: ValidateOptions = {}): FlagDraft {
  if (!isObject(raw)) throw new IntelligenceError('The provider returned something that is not a flag draft.');
  const notes = strings(raw.notes, 10, 400);
  const warnings: string[] = [];
  const kind = FLAG_KINDS.includes(raw.kind as FlagKind) ? (raw.kind as FlagKind) : fallbackKind;
  let binding = raw.binding === null || raw.binding === undefined ? null : parseBinding(raw.binding, index, warnings, 'Draft');
  if (raw.binding === null || raw.binding === undefined) {
    const loose = looseBinding(raw);
    if (loose) binding = parseBinding(loose, index, warnings, 'Draft');
  }
  let behavior = parseBehavior(raw.behavior, index, warnings, 'Draft');
  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;
  if (options.remote) confidence = Math.min(confidence, MODEL_CONFIDENCE_CAP);
  if (binding) {
    const one = keepOneSource(binding, behavior, index);
    ({ binding, behavior } = one);
    warnings.push(...one.dropped);
    notes.push(...one.swapped);
    if (one.swapped.length) confidence = Math.min(confidence, 0.7);
  }
  if (options.brief !== undefined && behavior.thresholds.length && !COLOUR_WORD.test(options.brief)) {
    behavior = { ...behavior, thresholds: [] };
    notes.push('Colour rules were left out: the brief did not ask for any.');
  }
  if (warnings.length) confidence = Math.min(confidence, 0.4);
  const shaped = fitShape(kind, binding, behavior, index);
  const by = answeredBy(raw);
  const model = shaped.kind === 'model' ? parseModelSpec(raw.model, warnings, 'Draft') : null;
  return {
    ...shaped,
    ...(model ? { model } : {}),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    confidence,
    notes: capWarnings([...notes, ...warnings, ...shaped.notes]),
    ...(by ? { answeredBy: by } : {}),
  };
}

/**
 * A flag reads from one source. When a draft mixes sources, keep the one most of its fields and
 * filters come from (the first metric's on a tie), swap in the same-named metric or field from that
 * source where there is one, and leave out the rest. `dropped` and `swapped` are notes for the analyst.
 */
export function keepOneSource(binding: Binding, behavior: Behavior, index: CatalogIndex): { binding: Binding; behavior: Behavior; dropped: string[]; swapped: string[] } {
  const metricSource = (k: string) => index.metric(k)?.source;
  const fieldSource = (k: string) => index.field(k)?.source;
  const firstMetric = binding.metrics[0] ? metricSource(binding.metrics[0]) : undefined;
  const votes = new Map<string, number>();
  for (const k of [...binding.dimensions.map((d) => d.field), ...binding.filters.map((f) => f.field)]) {
    const s = fieldSource(k);
    if (s) votes.set(s, (votes.get(s) ?? 0) + 1);
  }
  let anchor = firstMetric;
  let best = 0;
  for (const [s, n] of votes) if (n > best || (n === best && s === firstMetric)) [anchor, best] = [s, n];
  const all = [...binding.metrics.map(metricSource), ...binding.dimensions.map((d) => fieldSource(d.field)), ...binding.filters.map((f) => fieldSource(f.field))];
  if (!anchor || all.every((s) => s === anchor)) return { binding, behavior, dropped: [], swapped: [] };

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const where = index.source(anchor)?.label ?? anchor;
  const dropped: string[] = [];
  const swapped: string[] = [];
  // Old key -> key in the kept source, or undefined when it was left out.
  const metricMap = new Map<string, string | undefined>();
  const fieldMap = new Map<string, string | undefined>();
  const mapMetric = (k: string): string | undefined => {
    if (metricMap.has(k)) return metricMap.get(k);
    const m = index.metric(k)!;
    let out: string | undefined = k;
    if (m.source !== anchor) {
      out = index.catalog.metrics.find((x) => x.source === anchor && same(x.label, m.label))?.key;
      if (out) swapped.push(`Used "${m.label}" from ${where}, so it reads with the other fields.`);
      else dropped.push(`Metric "${m.label}" is in another source and was left out: a flag reads from one source.`);
    }
    metricMap.set(k, out);
    return out;
  };
  const mapField = (k: string): string | undefined => {
    if (fieldMap.has(k)) return fieldMap.get(k);
    const f = index.field(k)!;
    let out: string | undefined = k;
    if (f.source !== anchor) {
      out = index.catalog.fields.find((x) => x.source === anchor && same(x.label, f.label) && x.type === f.type)?.key;
      if (out) swapped.push(`Used "${f.label}" from ${where}, so it reads with the other fields.`);
      else dropped.push(`Field "${f.label}" is in another source and was left out: a flag reads from one source.`);
    }
    fieldMap.set(k, out);
    return out;
  };

  const metrics = [...new Set(binding.metrics.map(mapMetric).filter((k): k is string => !!k))];
  const dimensions = binding.dimensions.flatMap((d) => {
    const field = mapField(d.field);
    return field ? [{ ...d, field }] : [];
  });
  const filters = binding.filters.flatMap((f) => {
    const field = mapField(f.field);
    return field ? [{ ...f, field }] : [];
  });
  const out: Binding = { ...binding, metrics, dimensions, filters };
  if (binding.sort) {
    const [key, grain] = binding.sort.by.split('@') as [string, string | undefined];
    const by = metricMap.has(key) ? metricMap.get(key) : fieldMap.has(key) ? fieldMap.get(key) : key;
    if (by) out.sort = { ...binding.sort, by: grain ? `${by}@${grain}` : by };
    else delete out.sort;
  }
  const thresholds = behavior.thresholds.flatMap((t) => {
    const metric = metricMap.has(t.metric) ? metricMap.get(t.metric) : t.metric;
    return metric ? [{ ...t, metric }] : [];
  });
  const ignore = behavior.ignore.filter((k) => fieldSource(k) === anchor);
  return { binding: out, behavior: { ...behavior, ignore, thresholds }, dropped, swapped: [...new Set(swapped)] };
}

/**
 * Make a draft's kind and binding agree: a KPI has no fields, a pie and a picker have one, a
 * picker has no metrics and filters the page, and a text flag binds nothing.
 */
export function fitShape(kind: FlagKind, binding: Binding | null, behavior: Behavior, index?: CatalogIndex): { kind: FlagKind; binding: Binding | null; behavior: Behavior; notes: string[] } {
  const notes: string[] = [];
  if (kind === 'text') return { kind, binding: null, behavior, notes };
  if (!binding) return { kind, binding, behavior, notes };
  const b: Binding = { ...binding, metrics: [...binding.metrics], dimensions: [...binding.dimensions] };
  if (kind === 'filter') {
    if (b.dimensions.length === 0) return { kind, binding: null, behavior, notes: ['A picker needs a field to list.'] };
    if (b.metrics.length || b.dimensions.length > 1) notes.push('A picker lists one field, so the rest was left out.');
    b.metrics = [];
    b.dimensions = b.dimensions.slice(0, 1);
    delete b.sort;
    return { kind, binding: b, behavior: { ...behavior, onClick: 'filter-page' }, notes };
  }
  if (b.metrics.length === 0) {
    // Fields with no metric make a list of values.
    return { kind: 'table', binding: b, behavior, notes: kind === 'table' ? notes : ['With no metric this shows a list of values.'] };
  }
  if (kind === 'kpi' && b.dimensions.length > 0) {
    notes.push('A KPI shows one number, so this became a chart because it is split by a field.');
    kind = b.dimensions.some((d) => d.grain) ? 'line' : 'bar';
  } else if ((kind === 'bar' || kind === 'line' || kind === 'area' || kind === 'pie') && b.dimensions.length === 0) {
    kind = 'kpi';
  }
  if (kind === 'pie' && b.dimensions.length > 1) {
    notes.push('A pie shows one field; extra fields were left out.');
    b.dimensions = b.dimensions.slice(0, 1);
  }
  if (isRichKind(kind)) {
    const fit = fitRichKind(kind, b, index);
    kind = fit.kind;
    if (fit.note) notes.push(fit.note);
  }
  if (b.sort && !b.metrics.includes(b.sort.by) && !b.dimensions.some((d) => (d.grain ? `${d.field}@${d.grain}` : d.field) === b.sort!.by)) delete b.sort;
  return { kind, binding: b, behavior, notes };
}

export function validateHoistDraft(raw: unknown, index: CatalogIndex, options: ValidateOptions = {}): HoistDraft {
  if (!isObject(raw)) throw new IntelligenceError('The provider returned something that is not a hoist draft.');
  const warnings: string[] = [];
  const flags: HoistDraft['flags'] = [];
  for (const f of Array.isArray(raw.flags) ? raw.flags.slice(0, 24) : []) {
    try {
      const brief = isObject(f) && typeof f.brief === 'string' ? f.brief.slice(0, LIMITS.briefChars) : '';
      const d = validateFlagDraft(f, index, 'bar', { ...options, ...(options.brief !== undefined ? { brief: `${options.brief} ${brief}` } : {}) });
      flags.push({ ...d, brief });
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  const by = answeredBy(raw);
  return {
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    filters: parseFilters(raw.filters, index, warnings, 'Draft'),
    flags: by ? flags.map((f) => ({ ...f, answeredBy: by })) : flags,
    notes: capWarnings([...strings(raw.notes, 10, 400), ...warnings]),
    ...(by ? { answeredBy: by } : {}),
  };
}

/**
 * Models sometimes put metrics, dimensions, filters and sort beside the flag instead of inside "binding",
 * and give a dimension as a bare field key. Read that shape too: it means the same thing. Returns null when the flag
 * names no metric or field at all (a text flag, say).
 */
function looseBinding(raw: Record<string, unknown>): unknown {
  if (!Array.isArray(raw.metrics) && !Array.isArray(raw.dimensions)) return null;
  const dimensions = (Array.isArray(raw.dimensions) ? raw.dimensions : []).map((d) => (typeof d === 'string' ? { field: d } : d));
  const out: Record<string, unknown> = { metrics: Array.isArray(raw.metrics) ? raw.metrics : [], dimensions, filters: Array.isArray(raw.filters) ? raw.filters : [] };
  if (isObject(raw.sort)) out.sort = raw.sort;
  if (typeof raw.limit === 'number') out.limit = raw.limit;
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, max).map((s) => s.slice(0, len)) : [];
}

// What every intelligence provider receives and returns, and the one validation path all
// provider output goes through. Providers see the catalog summary below and the analyst's
// briefs. They never see rows, connection details, table or column names, or credentials.

import type { Catalog, CatalogIndex } from '../catalog.ts';
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
  metrics: Array<{ key: string; label: string; agg: string; synonyms?: string[] }>;
  fields: Array<{ key: string; label: string; type: string; synonyms?: string[] }>;
}

/** Strip a catalog down to what a provider may see: keys, labels, types and synonyms. */
export function summarizeCatalog(catalog: Catalog): CatalogSummary {
  return {
    metrics: catalog.metrics.map((m) => ({ key: m.key, label: m.label, agg: m.agg, ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}) })),
    fields: catalog.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.synonyms?.length ? { synonyms: f.synonyms } : {}) })),
  };
}

export interface DraftFlagRequest {
  task: 'draft-flag';
  brief: EffectiveBrief;
  catalog: CatalogSummary;
}

export interface DraftHoistRequest {
  task: 'draft-hoist';
  brief: string;
  catalog: CatalogSummary;
}

export interface FlagDraft {
  kind: FlagKind;
  title: string;
  binding: Binding | null;
  behavior: Behavior;
  confidence: number;
  notes: string[];
}

export interface HoistDraft {
  title: string;
  filters: Filter[];
  flags: Array<FlagDraft & { brief: string }>;
  notes: string[];
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
}

export class IntelligenceError extends Error {}

/** Turn untrusted provider output into a draft. Unknown keys are dropped and reported. */
export function validateFlagDraft(raw: unknown, index: CatalogIndex, fallbackKind: FlagKind): FlagDraft {
  if (!isObject(raw)) throw new IntelligenceError('The provider returned something that is not a flag draft.');
  const notes = strings(raw.notes, 10, 400);
  const warnings: string[] = [];
  const kind = FLAG_KINDS.includes(raw.kind as FlagKind) ? (raw.kind as FlagKind) : fallbackKind;
  const binding = raw.binding === null || raw.binding === undefined ? null : parseBinding(raw.binding, index, warnings, 'Draft');
  const behavior = parseBehavior(raw.behavior, index, warnings, 'Draft');
  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;
  if (warnings.length) confidence = Math.min(confidence, 0.4);
  const shaped = fitShape(kind, binding, behavior);
  return {
    ...shaped,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    confidence,
    notes: capWarnings([...notes, ...warnings, ...shaped.notes]),
  };
}

/**
 * Make a draft's kind and binding agree: a KPI has no fields, a pie and a picker have one, a
 * picker has no metrics and filters the page, and a text flag binds nothing.
 */
export function fitShape(kind: FlagKind, binding: Binding | null, behavior: Behavior): { kind: FlagKind; binding: Binding | null; behavior: Behavior; notes: string[] } {
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
  if (b.sort && !b.metrics.includes(b.sort.by) && !b.dimensions.some((d) => (d.grain ? `${d.field}@${d.grain}` : d.field) === b.sort!.by)) delete b.sort;
  return { kind, binding: b, behavior, notes };
}

export function validateHoistDraft(raw: unknown, index: CatalogIndex): HoistDraft {
  if (!isObject(raw)) throw new IntelligenceError('The provider returned something that is not a hoist draft.');
  const warnings: string[] = [];
  const flags: HoistDraft['flags'] = [];
  for (const f of Array.isArray(raw.flags) ? raw.flags.slice(0, 24) : []) {
    try {
      const d = validateFlagDraft(f, index, 'bar');
      flags.push({ ...d, brief: isObject(f) && typeof f.brief === 'string' ? f.brief.slice(0, LIMITS.briefChars) : '' });
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return {
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    filters: parseFilters(raw.filters, index, warnings, 'Draft'),
    flags,
    notes: capWarnings([...strings(raw.notes, 10, 400), ...warnings]),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, max).map((s) => s.slice(0, len)) : [];
}

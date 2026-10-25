// What every intelligence provider receives and returns, and the one validation path all
// provider output goes through. Providers see the catalog summary below and the analyst's
// briefs. They never see rows, connection details, table or column names, or credentials.

import type { Catalog, CatalogIndex } from '../catalog.ts';
import {
  type Behavior,
  type Binding,
  type EffectiveBrief,
  FLAG_KINDS,
  type Filter,
  type FlagKind,
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
  return {
    kind,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    binding,
    behavior,
    confidence,
    notes: [...notes, ...warnings],
  };
}

export function validateHoistDraft(raw: unknown, index: CatalogIndex): HoistDraft {
  if (!isObject(raw)) throw new IntelligenceError('The provider returned something that is not a hoist draft.');
  const warnings: string[] = [];
  const flags: HoistDraft['flags'] = [];
  for (const f of Array.isArray(raw.flags) ? raw.flags.slice(0, 24) : []) {
    try {
      const d = validateFlagDraft(f, index, 'bar');
      flags.push({ ...d, brief: isObject(f) && typeof f.brief === 'string' ? f.brief.slice(0, 4000) : '' });
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  return {
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    filters: parseFilters(raw.filters, index, warnings, 'Draft'),
    flags,
    notes: [...strings(raw.notes, 10, 400), ...warnings],
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown, max: number, len: number): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, max).map((s) => s.slice(0, len)) : [];
}

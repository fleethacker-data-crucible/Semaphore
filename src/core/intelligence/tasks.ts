// The smaller AI tasks. Each builds its request, sends it through the provider's runTask, and
// validates the answer as untrusted input before anything reaches the analyst. When there is no
// model, or the answer does not hold up, the caller keeps what the local rules found.

import type { Aggregate, Catalog, Metric } from '../catalog.ts';
import { type Briefing, BRIEFING_PROMPT, type BriefingFact, localBriefing, validateBriefing } from '../briefing.ts';
import type { CleaningStep } from '../cleaning.ts';
import type { ValueCount } from '../quality.ts';
import { answeredBy, IntelligenceError, type IntelligenceProvider, summarizeCatalog } from './contract.ts';

export const CLEANING_VALUES_MAX = 300;

const CLEANING_PROMPT = `You help an analyst clean one column of a dataset in Semaphore, a BI tool. The request has the column's label and its distinct values with how many rows hold each. Find values that mean the same thing but are written differently: abbreviations ("N.E." for "Northeast", "Mgmt" for "Management"), misspellings, singular and plural, different case or punctuation. Group them and pick, for each group, the value already in the list that should be kept (usually the clearest and most common). Do not group values that are genuinely different (two different ships, two different people with similar names, "North" and "Northeast"). Return {"groups":[{"keep":"<a value from the list>","merge":["<other values from the list>"],"why":"<a few words>"}]}. Use only values from the list, exactly as written. Return {"groups":[]} if nothing should be merged. Answer with JSON only.`;

export interface AiCleaningResult {
  step: CleaningStep | null;
  /** Groups the answer proposed that were dropped, and why. */
  rejected: string[];
  /** The model that actually answered, when Fairlead fell back from the one asked for. */
  answeredBy?: string;
}

/**
 * Ask the model which labels of one field mean the same thing. Sends the field's label and up to
 * CLEANING_VALUES_MAX distinct values with counts, never rows or other columns.
 */
export async function proposeCleaningWithAi(provider: IntelligenceProvider, field: { key: string; label: string }, values: readonly ValueCount[]): Promise<AiCleaningResult> {
  if (!provider.runTask) throw new IntelligenceError(`${provider.label} cannot propose cleaning.`);
  const list = values
    .filter((v): v is { value: string; count: number } => typeof v.value === 'string' && v.value.trim() !== '')
    .slice(0, CLEANING_VALUES_MAX);
  const raw = await provider.runTask({
    task: 'propose-cleaning',
    system: CLEANING_PROMPT,
    payload: { column: field.label, values: list.map((v) => ({ value: v.value, rows: v.count })) },
  });
  const by = answeredBy(raw);
  return { ...validateCleaning(raw, field, list), ...(by ? { answeredBy: by } : {}) };
}

export function validateCleaning(raw: unknown, field: { key: string; label: string }, list: ReadonlyArray<{ value: string; count: number }>): AiCleaningResult {
  const known = new Set(list.map((v) => v.value));
  const rejected: string[] = [];
  const map: Record<string, string> = {};
  const parts: string[] = [];
  const groups = isObject(raw) && Array.isArray(raw.groups) ? raw.groups.slice(0, 100) : null;
  if (!groups) throw new IntelligenceError('The model did not return groups of values.');
  for (const g of groups) {
    if (!isObject(g) || typeof g.keep !== 'string' || !Array.isArray(g.merge)) {
      rejected.push('An answer that was not a group of values was ignored.');
      continue;
    }
    const keep = g.keep;
    if (!known.has(keep)) {
      rejected.push(`“${keep.slice(0, 60)}” is not one of the values, so its group was ignored.`);
      continue;
    }
    if (map[keep] !== undefined) {
      rejected.push(`“${keep}” was both kept and merged; that group was ignored.`);
      continue;
    }
    const merged: string[] = [];
    for (const m of g.merge.slice(0, 50)) {
      if (typeof m !== 'string' || m === keep) continue;
      if (!known.has(m)) {
        rejected.push(`“${String(m).slice(0, 60)}” is not one of the values and was left out.`);
        continue;
      }
      if (map[m] !== undefined || Object.values(map).includes(m)) {
        rejected.push(`“${m}” was in two groups and was left out.`);
        continue;
      }
      map[m] = keep;
      merged.push(m);
    }
    if (merged.length) parts.push(`${merged.map((m) => `“${m}”`).join(', ')} as “${keep}”`);
  }
  if (!parts.length) return { step: null, rejected };
  return {
    step: {
      id: `ai-map-${Date.now().toString(36)}`,
      field: field.key,
      kind: 'map',
      map,
      sentence: `In ${field.label}, read ${parts.slice(0, 3).join('; ')}${parts.length > 3 ? ` and ${parts.length - 3} more` : ''}`,
      origin: 'ai',
    },
    rejected,
  };
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Qlik expressions ----------

const QLIK_PROMPT = `You translate one Qlik chart expression into measures for Semaphore, a BI tool whose measures are a single aggregate over one field: sum, avg, min, max, count or count_distinct. The request has the expression, the name it had in Qlik and a catalog of fields (key, label, type). Return {"measures":[{"label","agg","field":"<a field key from the catalog>","filters":[{"field":"<field key>","op":"in|eq|gte|lte|between","values":[]}]}],"explanation":"<one or two plain sentences>"}. Set analysis such as {<Region={'Gulf'}>} becomes "filters". A ratio or difference of aggregates becomes one measure per aggregate, and the explanation says how they combine (Semaphore shows them side by side). If the expression cannot be expressed this way, return {"measures":[],"explanation":"<why>"}. Use only field keys from the catalog. Answer with JSON only.`;

export interface AiQlikResult {
  metrics: Metric[];
  /** Filters from set analysis, to put on the flags that use the measure. */
  filterNotes: string[];
  explanation: string;
  rejected: string[];
}

/** Ask the model to read one Qlik expression. Sends the expression, its name and the catalog's field keys, labels and types. */
export async function readQlikExpressionWithAi(provider: IntelligenceProvider, label: string, expression: string, catalog: Catalog): Promise<AiQlikResult> {
  if (!provider.runTask) throw new IntelligenceError(`${provider.label} cannot read Qlik expressions.`);
  const raw = await provider.runTask({
    task: 'read-qlik-expression',
    system: QLIK_PROMPT,
    payload: { name: label.slice(0, 80), expression: expression.slice(0, 2000), fields: summarizeCatalog(catalog).fields },
  });
  return validateQlikReading(raw, label, expression, catalog);
}

const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct']);
const OPS: ReadonlySet<string> = new Set(['in', 'eq', 'gte', 'lte', 'between']);

export function validateQlikReading(raw: unknown, label: string, expression: string, catalog: Catalog): AiQlikResult {
  if (!isObject(raw) || !Array.isArray(raw.measures)) throw new IntelligenceError('The model did not return measures.');
  const fields = new Map(catalog.fields.map((f) => [f.key, f]));
  const numeric = (key: string) => fields.get(key)?.type === 'number' || (catalog.cleaning ?? []).some((c) => c.field === key && c.kind === 'number');
  const taken = new Set([...catalog.metrics.map((m) => m.key), ...catalog.fields.map((f) => f.key)]);
  const out: AiQlikResult = { metrics: [], filterNotes: [], explanation: typeof raw.explanation === 'string' ? raw.explanation.slice(0, 400) : '', rejected: [] };
  for (const m of raw.measures.slice(0, 6)) {
    if (!isObject(m) || typeof m.agg !== 'string' || !AGGS.has(m.agg) || typeof m.field !== 'string') {
      out.rejected.push('A measure without a known aggregate and field was left out.');
      continue;
    }
    const field = fields.get(m.field);
    if (!field) {
      out.rejected.push(`"${m.field.slice(0, 60)}" is not a field in the catalog.`);
      continue;
    }
    const agg = m.agg as Aggregate;
    if ((agg === 'sum' || agg === 'avg' || agg === 'min' || agg === 'max') && !numeric(field.key)) {
      out.rejected.push(`${agg} of ${field.label} was left out: ${field.label} is not a number.`);
      continue;
    }
    const name = (typeof m.label === 'string' && m.label.trim() ? m.label.trim() : `${label} (${agg} of ${field.label})`).slice(0, 80);
    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'measure';
    for (let i = 2; taken.has(key); i++) key = `${key.replace(/_\d+$/, '')}_${i}`;
    taken.add(key);
    out.metrics.push({ key, label: name, agg, field: field.key, source: field.source, synonyms: [expression.slice(0, 80).toLowerCase()] });
    const filters = Array.isArray(m.filters) ? m.filters.slice(0, 10) : [];
    const said = filters
      .filter((x): x is Record<string, unknown> => isObject(x) && typeof x.field === 'string' && fields.has(x.field) && typeof x.op === 'string' && OPS.has(x.op) && Array.isArray(x.values))
      .map((x) => `${fields.get(x.field as string)!.label} ${x.op} ${(x.values as unknown[]).filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, 20).join(', ')}`);
    if (said.length) out.filterNotes.push(`"${name}" applies only where ${said.join('; ')}: add that as a filter on the flags that use it.`);
  }
  return out;
}

// ---------- Briefings ----------

/**
 * Ask the model to write the briefing. Sends the page title and the facts (flag ids, chart titles,
 * and the sentences Semaphore computed), not rows. Falls back to the local briefing when the answer
 * does not hold up.
 */
export async function writeBriefingWithAi(provider: IntelligenceProvider, title: string, facts: readonly BriefingFact[]): Promise<Briefing> {
  const local = localBriefing(facts);
  if (!provider.runTask || !facts.length) return local;
  try {
    const raw = await provider.runTask({
      task: 'write-briefing',
      system: BRIEFING_PROMPT,
      payload: { page: title.slice(0, 120), facts: facts.slice(0, 40).map((f) => ({ flag: f.flagId, chart: f.flagTitle, fact: f.text })) },
    });
    return validateBriefing(raw, facts) ?? { ...local, dropped: 1 };
  } catch {
    return local;
  }
}

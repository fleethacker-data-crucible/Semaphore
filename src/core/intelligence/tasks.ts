// The smaller AI tasks. Each builds its request, sends it through the provider's runTask, and
// validates the answer as untrusted input before anything reaches the analyst. When there is no
// model, or the answer does not hold up, the caller keeps what the local rules found.

import type { CleaningStep } from '../cleaning.ts';
import type { ValueCount } from '../quality.ts';
import { IntelligenceError, type IntelligenceProvider } from './contract.ts';

export const CLEANING_VALUES_MAX = 300;

const CLEANING_PROMPT = `You help an analyst clean one column of a dataset in Semaphore, a BI tool. The request has the column's label and its distinct values with how many rows hold each. Find values that mean the same thing but are written differently: abbreviations ("N.E." for "Northeast", "Mgmt" for "Management"), misspellings, singular and plural, different case or punctuation. Group them and pick, for each group, the value already in the list that should be kept (usually the clearest and most common). Do not group values that are genuinely different (two different ships, two different people with similar names, "North" and "Northeast"). Return {"groups":[{"keep":"<a value from the list>","merge":["<other values from the list>"],"why":"<a few words>"}]}. Use only values from the list, exactly as written. Return {"groups":[]} if nothing should be merged. Answer with JSON only.`;

export interface AiCleaningResult {
  step: CleaningStep | null;
  /** Groups the answer proposed that were dropped, and why. */
  rejected: string[];
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
  return validateCleaning(raw, field, list);
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

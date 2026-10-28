// Data quality: what is messy in a field, and the cleaning step that would fix it, in words an
// analyst can accept or leave. Works from a field's distinct values and how often each occurs,
// which every source can answer with one small query (valuesPlan), so nothing here needs rows.
//
// The local rules catch what can be caught for certain: stray spaces, case and punctuation
// variants, compass abbreviations, numbers kept as text, mixed date formats, blanks, duplicate
// rows. The AI proposes the rest (abbreviations and misspellings) through the same step format.

import type { CatalogIndex, Field } from './catalog.ts';
import { type CleaningStep, cleanValue, stepsFor, toIsoDate, toNumber } from './cleaning.ts';
import type { Cell } from './crossfilter.ts';
import type { Relationship } from './joins.ts';
import type { QueryPlan } from './planner.ts';

export interface ValueCount {
  value: Cell;
  count: number;
}

export type FindingKind = 'spaces' | 'variants' | 'number-text' | 'mixed-dates' | 'blanks' | 'duplicates';

export interface Finding {
  id: string;
  field: string;
  kind: FindingKind;
  /** What is wrong, in plain words. */
  problem: string;
  /** Up to five stored values that show it. */
  examples: string[];
  /** Rows affected, when known. */
  rows: number;
  /** The fix, ready to accept. Its sentence says what it does. */
  step: CleaningStep;
}

export const VALUES_CAP = 1000;

/** One query for a field's stored values and how many rows hold each, most common first. */
export function valuesPlan(index: CatalogIndex, fieldKey: string, cap = VALUES_CAP): QueryPlan {
  const f = index.field(fieldKey);
  if (!f) throw new Error(`Unknown field "${fieldKey}".`);
  return {
    flagId: `quality:${fieldKey}`,
    source: f.source,
    table: f.table,
    raw: true,
    dimensions: [{ alias: 'd0', key: fieldKey, field: fieldKey }],
    aggregates: [{ alias: 'a0', fn: 'count', field: null }],
    metrics: [{ key: '__rows', agg: 'count', parts: { count: 'a0' } }],
    filters: [],
    own: [fieldKey],
    slices: [],
    live: [],
    sort: { by: '__rows', dir: 'desc' },
    limit: cap,
    rowCap: cap,
    selfFilter: true,
    estimatedRows: cap,
    notes: [],
  };
}

/** Result rows of valuesPlan() as value counts. */
export function toValueCounts(rows: ReadonlyArray<Record<string, Cell>>): ValueCount[] {
  return rows.map((r) => ({ value: r.d0 ?? null, count: Number(r.a0 ?? 0) })).sort((a, b) => b.count - a.count);
}

/** Value counts straight from rows held in the page. */
export function countValues(rows: ReadonlyArray<Record<string, Cell>>, column: string): ValueCount[] {
  const counts = new Map<string, ValueCount>();
  for (const r of rows) {
    const v = r[column] ?? null;
    const k = v === null ? '\u0000null' : `${typeof v}:${String(v)}`;
    const hit = counts.get(k);
    if (hit) hit.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

const SHORT: Record<string, string> = {
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
  no: 'north', so: 'south', dept: 'department', div: 'division', mgmt: 'management', maint: 'maintenance', ops: 'operations',
  intl: 'international', natl: 'national', hq: 'headquarters', ctr: 'center', centre: 'center',
};

/** Two labels that mean the same thing get the same key: case, spaces, punctuation and compass abbreviations. */
export function labelKey(v: string): string {
  const tokens = v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.map((t) => SHORT[t] ?? t).join('');
}

const tidy = (s: string) => s.trim().replace(/\s{2,}/g, ' ');
const show = (v: Cell) => (v === null ? '(blank)' : `“${String(v)}”`);
const ID_LIKE = /\b(id|key|code|number|no|zip|postcode|phone|serial|hull)\b/i;
let seq = 0;
const nextId = (kind: string) => `${kind}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export interface FindOptions {
  /** Rows held in the page: date formats can be cleaned (not in SQL). */
  pageData?: boolean;
  /** The values list was cut at VALUES_CAP, so rare variants may be missing. */
  partial?: boolean;
}

/** What is messy in one field. Fields already cleaned for a problem are not flagged again for it. */
export function findIssues(index: CatalogIndex, fieldKey: string, values: readonly ValueCount[], options: FindOptions = {}): Finding[] {
  const f = index.field(fieldKey);
  if (!f) return [];
  const have = new Set((index.catalog.cleaning ?? []).filter((s) => s.field === fieldKey).map((s) => s.kind));
  const out: Finding[] = [];
  const strings = values.filter((v): v is { value: string; count: number } => typeof v.value === 'string' && v.value !== '');
  const blanks = values.filter((v) => v.value === null || v.value === '').reduce((n, v) => n + v.count, 0);
  const total = values.reduce((n, v) => n + v.count, 0);

  if (f.type === 'string' && !have.has('trim')) {
    const spaced = strings.filter((v) => v.value !== tidy(v.value));
    if (spaced.length) {
      out.push({
        id: nextId('spaces'),
        field: fieldKey,
        kind: 'spaces',
        problem: `${count(spaced.length, 'value')} of ${f.label} ${spaced.length === 1 ? 'has' : 'have'} stray spaces, so they show as separate entries.`,
        examples: spaced.slice(0, 5).map((v) => show(v.value)),
        rows: spaced.reduce((n, v) => n + v.count, 0),
        step: { id: nextId('trim'), field: fieldKey, kind: 'trim', sentence: `Remove stray spaces from ${f.label}`, origin: 'rules' },
      });
    }
  }

  if (f.type === 'string' && !ID_LIKE.test(f.label)) {
    // Look at the values as the accepted steps already read them, so a fixed variant is not offered again.
    const earlier = stepsFor(index, fieldKey).filter((x) => x.kind === 'trim' || x.kind === 'map');
    const seenAs = strings.map((v) => ({ value: String(cleanValue(earlier, v.value) ?? ''), count: v.count })).filter((v) => v.value !== '');
    const groups = new Map<string, Array<{ value: string; count: number }>>();
    for (const v of seenAs) {
      const k = labelKey(v.value);
      if (!k) continue;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(v);
    }
    const map: Record<string, string> = {};
    const merged: string[] = [];
    let rows = 0;
    for (const g of groups.values()) {
      const forms = new Map<string, number>();
      for (const v of g) forms.set(tidy(v.value), (forms.get(tidy(v.value)) ?? 0) + v.count);
      if (forms.size < 2) continue;
      // Most rows wins; on a tie, the form written like a name ("Northeast", not "northeast" or "NE").
      const named = (s: string) => (/^[A-Z]/.test(s) && /[a-z]/.test(s) ? 1 : 0);
      const canon = [...forms.entries()].sort((a, b) => b[1] - a[1] || named(b[0]) - named(a[0]) || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]![0];
      for (const v of g) {
        const t = tidy(v.value);
        if (t === canon) continue;
        map[t] = canon;
        if (v.value !== t) map[v.value] = canon;
        rows += v.count;
      }
      merged.push(`${[...forms.keys()].filter((x) => x !== canon).map((x) => show(x)).join(', ')} as ${show(canon)}`);
    }
    if (merged.length) {
      out.push({
        id: nextId('variants'),
        field: fieldKey,
        kind: 'variants',
        problem: `${f.label} spells ${count(merged.length, 'value')} more than one way, which splits ${count(rows, 'row')} into extra groups.`,
        examples: merged.slice(0, 5),
        rows,
        step: { id: nextId('map'), field: fieldKey, kind: 'map', map, sentence: `In ${f.label}, read ${merged.slice(0, 3).join('; ')}${merged.length > 3 ? ` and ${merged.length - 3} more` : ''}`, origin: 'rules' },
      });
    }
  }

  if (f.type === 'string' && !have.has('number') && !ID_LIKE.test(f.label) && strings.length) {
    const nums = strings.filter((v) => toNumber(v.value) !== null);
    const share = nums.reduce((n, v) => n + v.count, 0) / strings.reduce((n, v) => n + v.count, 0);
    if (share >= 0.8 && nums.length >= 2) {
      const bad = strings.filter((v) => toNumber(v.value) === null);
      out.push({
        id: nextId('number'),
        field: fieldKey,
        kind: 'number-text',
        problem: `${f.label} holds numbers stored as text${bad.length ? `, with ${count(bad.length, 'value')} that ${bad.length === 1 ? 'is' : 'are'} not a number (${bad.slice(0, 3).map((v) => show(v.value)).join(', ')})` : ''}, so it cannot be added up.`,
        examples: nums.filter((v) => /[,$()\s]/.test(v.value)).slice(0, 5).map((v) => show(v.value)),
        rows: bad.reduce((n, v) => n + v.count, 0),
        step: { id: nextId('num'), field: fieldKey, kind: 'number', sentence: `Read ${f.label} as a number${bad.length ? ' (values that are not numbers count as blank)' : ''}`, origin: 'rules' },
      });
    }
  }

  if (f.type === 'string' && options.pageData && !have.has('date') && strings.length) {
    const shapes = new Set<string>();
    let parsed = 0;
    let dmy = false;
    for (const v of strings) {
      if (toIsoDate(v.value, 'mdy') === null && toIsoDate(v.value, 'dmy') === null) continue;
      parsed += v.count;
      shapes.add(v.value.replace(/\d/g, '9').replace(/[A-Za-z]+/g, 'a'));
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/.exec(v.value.trim());
      if (m && Number(m[1]) > 12) dmy = true;
    }
    const all = strings.reduce((n, v) => n + v.count, 0);
    if (parsed / all >= 0.8 && shapes.size > 1) {
      const order = dmy ? 'dmy' : 'mdy';
      out.push({
        id: nextId('dates'),
        field: fieldKey,
        kind: 'mixed-dates',
        problem: `${f.label} holds dates written ${shapes.size} different ways, so it cannot be used as a date.`,
        examples: [...new Set(strings.map((v) => v.value))].slice(0, 5).map((v) => show(v)),
        rows: all - parsed,
        step: { id: nextId('date'), field: fieldKey, kind: 'date', order, sentence: `Read ${f.label} as a date (${order === 'dmy' ? 'day before month' : 'month before day'} where it is written with slashes)`, origin: 'rules' },
      });
    }
  }

  if (blanks > 0 && total > 0 && !have.has('blank-as')) {
    const share = blanks / total;
    if (f.type === 'number' && share <= 0.6) {
      out.push({
        id: nextId('blanks'),
        field: fieldKey,
        kind: 'blanks',
        problem: `${count(blanks, 'row')} ${blanks === 1 ? 'has' : 'have'} no ${f.label}. If a blank means none, totals are right but averages and counts are not.`,
        examples: ['(blank)'],
        rows: blanks,
        step: { id: nextId('blank'), field: fieldKey, kind: 'blank-as', value: 0, sentence: `Count a blank ${f.label} as 0`, origin: 'rules' },
      });
    } else if (f.type === 'string' && strings.length <= 50) {
      out.push({
        id: nextId('blanks'),
        field: fieldKey,
        kind: 'blanks',
        problem: `${count(blanks, 'row')} ${blanks === 1 ? 'has' : 'have'} no ${f.label}, shown as an empty group.`,
        examples: ['(blank)'],
        rows: blanks,
        step: { id: nextId('blank'), field: fieldKey, kind: 'blank-as', value: 'Unknown', sentence: `Show a blank ${f.label} as “Unknown”`, origin: 'rules' },
      });
    }
  }
  if (options.partial) for (const x of out) x.problem += ' (Checked on the most common values only.)';
  return out;
}

/** Exact duplicate rows in data held in the page. */
export function findDuplicates(index: CatalogIndex, source: string, table: string, rows: ReadonlyArray<Record<string, Cell>>): Finding | null {
  const field = index.catalog.fields.find((f) => f.source === source && f.table === table);
  if (!field || (index.catalog.cleaning ?? []).some((s) => s.kind === 'dedupe' && s.field === field.key)) return null;
  const seen = new Set<string>();
  let dupes = 0;
  for (const r of rows) {
    const k = JSON.stringify(Object.keys(r).sort().map((c) => r[c] ?? null));
    if (seen.has(k)) dupes++;
    else seen.add(k);
  }
  if (!dupes) return null;
  const name = table.split('.').at(-1)!;
  return {
    id: nextId('dupes'),
    field: field.key,
    kind: 'duplicates',
    problem: `${count(dupes, 'row')} in ${name} ${dupes === 1 ? 'is an exact copy' : 'are exact copies'} of another row, so counts and totals include them twice.`,
    examples: [],
    rows: dupes,
    step: { id: nextId('dedupe'), field: field.key, kind: 'dedupe', sentence: `Count repeated rows in ${name} once`, origin: 'rules' },
  };
}

/** A cleaning step with an analyst's change of mind: a map entry dropped before accepting. */
export function withoutMapEntry(step: CleaningStep, from: string): CleaningStep {
  const map = { ...(step.map ?? {}) };
  const target = map[from];
  for (const [k, v] of Object.entries(map)) if (k === from || (tidy(k) === tidy(from) && v === target)) delete map[k];
  return { ...step, map };
}

// ---------- relationships ----------

export interface RelationshipCandidate {
  from: Field;
  to: Field;
}

const singular = (w: string) => w.replace(/ies$/, 'y').replace(/(ss|us)$/, '$1').replace(/s$/, '');
const tableWord = (t: string) => singular(t.split('.').at(-1)!.toLowerCase().replace(/^(tbl|dim|fact)_?/, ''));

/**
 * Pairs of columns that look like a key and what it points at: ship_id → ships.id, or the same
 * key name in two tables (hull_no in jobs and in ships). Checked against the data before use.
 */
export function relationshipCandidates(index: CatalogIndex): RelationshipCandidate[] {
  const out: RelationshipCandidate[] = [];
  const fields = index.catalog.fields.filter((f) => f.type === 'string' || f.type === 'number');
  const have = new Set((index.catalog.relationships ?? []).map((r) => `${r.source}|${r.from.table}|${r.from.column}|${r.to.table}`));
  for (const a of fields) {
    for (const b of fields) {
      if (a.source !== b.source || a.table === b.table) continue;
      if (have.has(`${a.source}|${a.table}|${a.column}|${b.table}`)) continue;
      const ac = a.column.toLowerCase();
      const bc = b.column.toLowerCase();
      const named = /^(id|key|code)$/.test(bc) && (ac === `${tableWord(b.table)}_${bc}` || ac === `${tableWord(b.table)}${bc}`);
      const shared = ac === bc && /(_?id|_?no|_?code|_?key|number|hull)$/.test(ac);
      if (named || shared) out.push({ from: a, to: b });
    }
  }
  return out;
}

export interface RelationshipCheck {
  /** Distinct `from` values found among `to` values, 0..1. */
  match: number;
  matched: number;
  distinct: number;
  /** Every `to` value occurs once: it identifies one row, so the join keeps totals right. */
  toUnique: boolean;
}

export function checkRelationship(fromValues: readonly ValueCount[], toValues: readonly ValueCount[]): RelationshipCheck {
  const key = (v: Cell) => (v === null || v === '' ? null : String(v).trim());
  const to = new Set(toValues.map((v) => key(v.value)).filter((v): v is string => v !== null));
  const from = [...new Set(fromValues.map((v) => key(v.value)).filter((v): v is string => v !== null))];
  const matched = from.filter((v) => to.has(v)).length;
  return { match: from.length ? matched / from.length : 0, matched, distinct: from.length, toUnique: toValues.every((v) => v.count <= 1) };
}

/** A checked candidate as a relationship to propose, or null when the data does not back it. */
export function proposeRelationship(c: RelationshipCandidate, check: RelationshipCheck): Relationship | null {
  if (check.distinct === 0 || check.match < 0.5) return null;
  // If the target repeats keys, the join would repeat rows; the other direction may still work.
  if (!check.toUnique) return null;
  return {
    id: `rel-${c.from.table}-${c.from.column}-${c.to.table}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    source: c.from.source,
    from: { table: c.from.table, column: c.from.column },
    to: { table: c.to.table, column: c.to.column },
    match: Math.round(check.match * 1000) / 1000,
    origin: 'discovered',
  };
}

function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

// Reads a brief back to the analyst while they type: which words matched a metric or a field,
// which set the time, the ranking, the behaviour or a colour rule, and which words matched
// nothing, with "did you mean" suggestions from the catalog. The UI draws these as highlights
// under the text, so the analyst sees what Semaphore understood before anything is drafted.

import type { Catalog, CatalogIndex } from '../catalog.ts';
import { LIMITS } from '../hoist.ts';
import { COMPARE_RE, GRAIN_WORDS, KIND_WORDS, type Mention, mentions, SHARE_RE } from './local-rules.ts';

export type SpanKind = 'metric' | 'field' | 'time' | 'range' | 'rank' | 'kind' | 'click' | 'ignore' | 'threshold' | 'compare' | 'share' | 'unknown';

export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
  /** Catalog key for metric and field spans. */
  key?: string;
  /** What the span means, in plain words: "Labor cost (metric)", "per month". */
  label: string;
}

export interface Suggestion {
  key: string;
  kind: 'metric' | 'field';
  label: string;
}

export interface Unknown {
  start: number;
  end: number;
  word: string;
  suggestions: Suggestion[];
}

export interface Annotation {
  spans: Span[];
  unknown: Unknown[];
  /** Short reasons behind the confidence: what matched and what did not. */
  reasons: string[];
}

const STOP = new Set(
  (
    'a an the and or but of for to in on at by per with without from into over under than then that this these those it its is are was were be been ' +
    'show shows showing give me us our we i you your my all any each every some what which who how many much most more less least fewest top bottom ' +
    'highest lowest best worst largest biggest smallest greatest total totals overall number count sum average avg mean so as if when where while ' +
    'should would could can will want wants need needs see look at glance whole page flag flags hoist dashboard chart graph view please also just ' +
    'only always never not no yes leadership boss team picture month months year years week weeks day days quarter quarters last past previous ' +
    'prior trailing since ago current this next one two three four five six seven eight nine ten twelve bar bars line lines pie table list trend ' +
    'filter filters filtering filtered selection selections click clicking clicks drill drills ignore ignores ignoring red green amber yellow orange ' +
    'turn turns go goes over under above below exceeds exceed less greater least most k m b million billion thousand percent share vs versus compared ' +
    'change growth split broken down grouped breakdown across both between had has have do does did about around'
  ).split(' '),
);

export function annotateBrief(raw: string, index: CatalogIndex): Annotation {
  const text = raw.slice(0, LIMITS.briefChars);
  // Same length as the input, so every offset found here is an offset into what was typed.
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s/g, ' ');
  const spans: Span[] = [];
  const taken = (s: number, e: number) => spans.some((x) => s < x.end && x.start < e);
  const add = (start: number, end: number, kind: SpanKind, label: string, key?: string) => {
    if (end <= start || taken(start, end)) return;
    spans.push(key ? { start, end, kind, label, key } : { start, end, kind, label });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (let m = g.exec(lower); m; m = g.exec(lower)) {
      if (m[0].length === 0) g.lastIndex++;
      else fn(m);
    }
  };

  // Clauses first, so the fields inside them read as part of the clause, not as groupings.
  each(/\bignor\w{0,6}\s+(?:the\s+|any\s+)?[a-z0-9 '/-]{1,60}?\s+(?:filters?|selections?|slicers?)\b/, (m) => add(m.index, m.index + m[0].length, 'ignore', 'skips page selections on this field'));
  each(/\bclick\w{0,6}\b[^.;]{0,160}?\b(?:filters?|filtering|drills?|drilling)\b(?:\s+(?:the\s+)?(?:whole\s+)?(?:page|dashboard|hoist))?/, (m) =>
    add(m.index, m.index + m[0].length, 'click', /drill/.test(m[0]) ? 'clicking drills down' : 'clicking filters the page'),
  );
  each(/\b(?:red|green|amber|yellow|orange)\b[^.;]{0,60}?\b(?:under|below|less than|over|above|more than|greater than|exceeds?|at least|at most)\s+\$?\s?-?\d[\d,]{0,20}(?:\.\d{1,6})?\s?(?:k|m|b|thousand|million|billion|%|percent)?(?![a-z0-9])/, (m) =>
    add(m.index, m.index + m[0].length, 'threshold', 'colour rule'),
  );
  each(COMPARE_RE, (m) => add(m.index, m.index + m[0].length, 'compare', /year|yoy/.test(m[0]) ? 'compared with a year earlier' : 'compared with the previous period'));
  each(SHARE_RE, (m) => add(m.index, m.index + m[0].length, 'share', 'as a share of the total'));

  for (const m of mentions(lower, index)) {
    if (taken(m.start, m.end)) continue;
    add(m.start, m.end, m.kind, mentionLabel(m, index), m.key);
  }

  each(/\b(?:last|past|previous|trailing|prior)\s+(?:\d{1,4}\s+)?(?:day|week|month|quarter|year)s?\b/, (m) => add(m.index, m.index + m[0].length, 'range', m[0].trim()));
  for (const [re, grain] of GRAIN_WORDS) each(re, (m) => add(m.index, m.index + m[0].length, 'time', `per ${grain}`));
  each(/\b(?:trend|trending|over time)\b/, (m) => add(m.index, m.index + m[0].length, 'time', 'over time'));
  each(/\b(?:top|bottom|highest|lowest|worst|best)\s+\d{1,4}\b/, (m) => add(m.index, m.index + m[0].length, 'rank', m[0].trim()));
  each(/\b(?:most|highest|largest|biggest|greatest|least|fewest|lowest|smallest)\b/, (m) => {
    if (/\b(?:which|what)\b/.test(lower)) add(m.index, m.index + m[0].length, 'rank', `ranked, ${/most|high|larg|big|great/.test(m[0]) ? 'highest' : 'lowest'} first`);
  });
  for (const [re, kind] of KIND_WORDS) each(re, (m) => add(m.index, m.index + m[0].length, 'kind', `as a ${kind}`));
  spans.sort((a, b) => a.start - b.start);

  // Words nothing matched. A word right after "by"/"per" was meant as a field; any other word
  // is only reported when it looks like a misspelt catalog term.
  const unknown: Unknown[] = [];
  each(/[a-z][a-z'-]{2,}/, (m) => {
    const start = m.index;
    const end = start + m[0].length;
    if (taken(start, end)) return;
    const word = m[0].replace(/'s$/, '');
    if (STOP.has(word)) return;
    const cued = /\b(?:by|per|across|vs\.?|versus|which|what)\s+(?:the\s+|each\s+)?$/.test(lower.slice(Math.max(0, start - 20), start));
    const suggestions = suggest(word, index);
    if (!cued && suggestions.length === 0) return;
    unknown.push({ start, end, word: text.slice(start, end), suggestions });
    spans.push({ start, end, kind: 'unknown', label: suggestions.length ? `did you mean ${suggestions[0]!.label}?` : 'not in the catalog' });
  });
  spans.sort((a, b) => a.start - b.start);

  const reasons: string[] = [];
  const matched = spans.filter((s) => s.kind === 'metric' || s.kind === 'field');
  if (matched.length) reasons.push(`Matched ${unique(matched.map((s) => s.label)).join(', ')}.`);
  else if (text.trim()) reasons.push('No metric or field in the catalog was named.');
  for (const u of unknown) reasons.push(u.suggestions.length ? `"${u.word}" is not in the catalog; did you mean ${u.suggestions.map((s) => s.label).join(' or ')}?` : `"${u.word}" is not in the catalog.`);
  return { spans, unknown, reasons };
}

function mentionLabel(m: Mention, index: CatalogIndex): string {
  if (m.kind === 'metric') return `${index.metric(m.key)?.label ?? m.key} (measure)`;
  return `${index.field(m.key)?.label ?? m.key} (field)`;
}

/** Catalog terms within a small edit distance of a word: typos and near-misses. */
export function suggest(word: string, index: CatalogIndex, max = 3): Suggestion[] {
  const w = word.toLowerCase();
  if (w.length < 3) return [];
  const best = new Map<string, { s: Suggestion; d: number }>();
  const consider = (key: string, kind: 'metric' | 'field', label: string, phrase: string) => {
    const candidates = [phrase, ...phrase.split(/[\s_.]+/).filter((t) => t.length >= 4)];
    for (const c of candidates) {
      const p = c.toLowerCase();
      if (Math.abs(p.length - w.length) > 2) continue;
      const d = distance(w, p);
      // A prefix of at least four letters counts too ("maint" for "maintenance").
      const prefix = w.length >= 4 && p.startsWith(w) ? 1 : Infinity;
      const allowed = w.length <= 4 ? 1 : 2;
      const score = Math.min(d <= allowed && d > 0 ? d : Infinity, prefix);
      if (score === Infinity) continue;
      const id = `${kind}:${key}`;
      const prev = best.get(id);
      if (!prev || score < prev.d) best.set(id, { s: { key, kind, label }, d: score });
    }
  };
  for (const m of index.catalog.metrics) for (const p of [m.label, ...(m.synonyms ?? [])]) consider(m.key, 'metric', m.label, p);
  for (const f of index.catalog.fields) for (const p of [f.label, f.column, ...(f.synonyms ?? [])]) consider(f.key, 'field', f.label, p);
  return [...best.values()].sort((a, b) => a.d - b.d || a.s.label.localeCompare(b.s.label)).slice(0, max).map((x) => x.s);
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), capped for speed. */
export function distance(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > cap) return cap + 1;
  }
  return rows[a.length]![b.length]!;
}

/**
 * Teach the catalog a word: the analyst picked a "did you mean" suggestion or corrected a
 * draft, so the next brief that uses the word resolves by itself. Returns a new catalog, or
 * null when the word is unusable or already means something else.
 */
export function learnSynonym(catalog: Catalog, word: string, target: { kind: 'metric' | 'field'; key: string }): Catalog | null {
  const w = word.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/^[a-z][a-z0-9 '-]{1,39}$/.test(w) || STOP.has(w)) return null;
  const owner = [
    ...catalog.metrics.map((m) => ({ kind: 'metric' as const, key: m.key, words: [m.label, m.key, ...(m.synonyms ?? [])] })),
    ...catalog.fields.map((f) => ({ kind: 'field' as const, key: f.key, words: [f.label, f.key.split('.').at(-1)!, ...(f.synonyms ?? [])] })),
  ].find((o) => o.words.some((x) => x.toLowerCase().replace(/[_.]/g, ' ') === w));
  if (owner) return owner.kind === target.kind && owner.key === target.key ? catalog : null;
  if (target.kind === 'metric') {
    if (!catalog.metrics.some((m) => m.key === target.key)) return null;
    return { ...catalog, metrics: catalog.metrics.map((m) => (m.key === target.key ? { ...m, synonyms: [...(m.synonyms ?? []), w].slice(-30) } : m)) };
  }
  if (!catalog.fields.some((f) => f.key === target.key)) return null;
  return { ...catalog, fields: catalog.fields.map((f) => (f.key === target.key ? { ...f, synonyms: [...(f.synonyms ?? []), w].slice(-30) } : f)) };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

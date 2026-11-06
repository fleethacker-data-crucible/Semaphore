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

// ---- Teaching the brief language ------------------------------------------------------------
// The brief understands more than anyone guesses from a blank box. These helpers turn the grammar
// into next steps built from the catalog's own names: "+ by Region", "+ vs last year". Each hint's
// phrase is one the annotator above reads as its kind, so clicking a hint shows exactly which words
// cause which behaviour (tests/brief-language.test.ts holds every kind to that).

/** The constructions a brief can use, in the order a brief usually grows. */
export const GRAMMAR_KINDS = ['metric', 'field', 'range', 'compare', 'threshold', 'click', 'time', 'rank', 'share', 'kind', 'ignore'] as const;
export type GrammarKind = (typeof GRAMMAR_KINDS)[number];

export interface Hint {
  kind: GrammarKind;
  /** What the button says, e.g. "+ by Region". */
  label: string;
  /** The words added to the brief, e.g. "by region". */
  phrase: string;
  /** A clause starts its own sentence ("Turn red over $1M."); the rest join the current one. */
  clause: boolean;
}

export interface SuggestOptions {
  /** At most this many hints (default 3). */
  max?: number;
  /** Kinds the analyst no longer needs to be shown (they have used them often). */
  skip?: readonly string[];
}

/** Which grammar kind each annotated span teaches. Spans of kind "unknown" teach nothing. */
const SPAN_GRAMMAR: Partial<Record<SpanKind, GrammarKind>> = {
  metric: 'metric', field: 'field', time: 'time', range: 'range', compare: 'compare', share: 'share',
  rank: 'rank', kind: 'kind', click: 'click', ignore: 'ignore', threshold: 'threshold',
};

/** The grammar kinds a brief already uses. */
export function usedKinds(annotation: Annotation): Set<GrammarKind> {
  const out = new Set<GrammarKind>();
  for (const s of annotation.spans) {
    const k = SPAN_GRAMMAR[s.kind];
    if (k) out.add(k);
  }
  return out;
}

/** A round number in the measure's own format, for the colour-rule example. */
function ruleValue(format: 'number' | 'currency' | 'percent' | undefined): string {
  return format === 'currency' ? '$1M' : format === 'percent' ? '90%' : '100';
}

interface Words {
  metric: { key: string; label: string; format?: 'number' | 'currency' | 'percent' } | undefined;
  /** A short category field in reach of the measure, not yet in the brief. */
  field: { key: string; label: string } | undefined;
  /** A category field to show "ignore ... filter" with (the brief's own field when it has one). */
  ignoreField: { key: string; label: string } | undefined;
  date: boolean;
}

function wordsFor(annotation: Annotation, index: CatalogIndex): Words {
  const named = annotation.spans.filter((s) => s.kind === 'metric' && s.key).map((s) => index.metric(s.key!)).find((m) => m);
  const metric = named ?? index.catalog.metrics.find((m) => m.agg === 'sum') ?? index.catalog.metrics[0];
  const table = metric ? (metric.field ? index.field(metric.field)?.table : metric.table) : undefined;
  const inReach = index.catalog.fields.filter((f) => (!metric || f.source === metric.source) && (table === undefined || f.table === table));
  const usedFields = new Set(annotation.spans.filter((s) => s.kind === 'field' && s.key).map((s) => s.key!));
  const categories = inReach
    .filter((f) => f.type === 'string')
    .sort((a, b) => (a.cardinality ?? 50) - (b.cardinality ?? 50) || a.label.localeCompare(b.label));
  const field = categories.find((f) => !usedFields.has(f.key) && (f.cardinality ?? 50) <= 50) ?? categories.find((f) => !usedFields.has(f.key));
  const ignoreField = categories.find((f) => usedFields.has(f.key)) ?? field;
  return {
    metric: metric ? { key: metric.key, label: metric.label, ...(metric.format ? { format: metric.format } : {}) } : undefined,
    field: field ? { key: field.key, label: field.label } : undefined,
    ignoreField: ignoreField ? { key: ignoreField.key, label: ignoreField.label } : undefined,
    date: inReach.some((f) => f.type === 'date'),
  };
}

/** The hint for one kind, from the catalog's names; null when the catalog has nothing to say it with. */
function hintFor(kind: GrammarKind, w: Words, hasField: boolean): Hint | null {
  const low = (s: string) => s.toLowerCase();
  switch (kind) {
    case 'metric':
      return w.metric ? { kind, label: `+ ${w.metric.label}`, phrase: low(w.metric.label), clause: false } : null;
    case 'field':
      return w.field ? { kind, label: `+ by ${w.field.label}`, phrase: `by ${low(w.field.label)}`, clause: false } : null;
    case 'range':
      return w.date ? { kind, label: '+ last 12 months', phrase: 'for the last 12 months', clause: false } : null;
    case 'compare':
      return w.date ? { kind, label: '+ vs last year', phrase: 'vs last year', clause: false } : null;
    case 'threshold':
      return w.metric ? { kind, label: `+ turn red over ${ruleValue(w.metric.format)}`, phrase: `Turn red over ${ruleValue(w.metric.format)}`, clause: true } : null;
    case 'click':
      return hasField ? { kind, label: '+ click to filter', phrase: 'Clicking a bar filters the page', clause: true } : null;
    case 'time':
      return w.date ? { kind, label: '+ per month', phrase: 'per month', clause: false } : null;
    case 'rank':
      return hasField ? { kind, label: '+ top 10 only', phrase: 'top 10 only', clause: false } : null;
    case 'share':
      return hasField ? { kind, label: '+ % of total', phrase: 'as a share of the total', clause: false } : null;
    case 'kind':
      return { kind, label: '+ as a table', phrase: 'as a table', clause: false };
    case 'ignore':
      return w.ignoreField ? { kind, label: `+ ignore ${w.ignoreField.label} filter`, phrase: `Ignore the ${low(w.ignoreField.label)} filter`, clause: true } : null;
  }
}

/**
 * The next grammar moves this brief does not use yet, as hints built from catalog names. Pure:
 * the same brief and catalog always give the same hints. A brief with no measure is offered one
 * first; moves that need a breakdown (click, rank, share) wait until the brief has one.
 */
export function suggestNext(annotation: Annotation, index: CatalogIndex, options: SuggestOptions = {}): Hint[] {
  const max = options.max ?? 3;
  const skip = new Set(options.skip ?? []);
  const used = usedKinds(annotation);
  const w = wordsFor(annotation, index);
  const hasField = used.has('field');
  const out: Hint[] = [];
  for (const kind of GRAMMAR_KINDS) {
    if (out.length >= max) break;
    if (used.has(kind) || skip.has(kind)) continue;
    // A word the brief names but the catalog does not know is taught first, not talked over.
    if (kind === 'field' && annotation.unknown.length > 0) continue;
    const h = hintFor(kind, w, hasField);
    if (h) out.push(h);
  }
  return out;
}

/**
 * The brief with a hint's words added. A joining phrase ("by region", "vs last year") goes at the
 * end of the first sentence, which says what the flag shows; a clause ("Turn red over $1M") is a
 * sentence of its own at the end.
 */
export function appendHint(brief: string, hint: Pick<Hint, 'phrase' | 'clause'>): string {
  const trimmed = brief.replace(/\s+$/, '');
  if (!trimmed) return hint.clause ? `${hint.phrase}.` : hint.phrase.charAt(0).toUpperCase() + hint.phrase.slice(1);
  if (hint.clause) return `${trimmed}${/[.!?]$/.test(trimmed) ? '' : '.'} ${hint.phrase}.`;
  const end = /[.!?](?=\s|$)/.exec(trimmed);
  if (!end) return `${trimmed} ${hint.phrase}`;
  return `${trimmed.slice(0, end.index)} ${hint.phrase}${trimmed.slice(end.index)}`;
}

export interface Phrase {
  kind: GrammarKind;
  /** The construction's name, e.g. "Compare". */
  name: string;
  /** What it does, in a few words. */
  what: string;
  /** A whole brief that uses it, written with this catalog's names. */
  example: string;
}

const PHRASE_TEXT: Record<GrammarKind, { name: string; what: string }> = {
  metric: { name: 'Measure', what: 'The number to show. Name it as the catalog does, or teach Semaphore your word.' },
  field: { name: 'Breakdown', what: '"by" or "per" a field splits the number into one bar, row or slice per value.' },
  range: { name: 'Time window', what: '"last 12 months", "past 6 weeks": only that window is counted.' },
  compare: { name: 'Compare', what: '"vs last year" or "vs the previous period" shows the earlier window beside it.' },
  threshold: { name: 'Colour rule', what: '"Turn red over …" or "green under …" marks values that break a rule.' },
  click: { name: 'Click to filter', what: '"Clicking a bar filters the page": a click selects that value on every flag.' },
  time: { name: 'Over time', what: '"per month", "weekly", "quarterly": a trend along the calendar.' },
  rank: { name: 'Top N', what: '"top 10" or "bottom 5" keeps the highest or lowest values only.' },
  share: { name: 'Share of total', what: '"as a share of the total" or "% of total" shows each part of the whole.' },
  kind: { name: 'Chart kind', what: '"as a table", "as a line", "as a pie" picks how it is drawn.' },
  ignore: { name: 'Ignore a filter', what: '"Ignore the region filter": page selections on that field leave this flag alone.' },
};

/** Every construction the brief understands, each with a working example from this catalog. */
export function phrasebook(index: CatalogIndex): Phrase[] {
  const base = annotateBrief('', index);
  const w = wordsFor(base, index);
  if (!w.metric) return [];
  const metric = w.metric.label;
  const withField = w.field ? `${metric} by ${w.field.label.toLowerCase()}` : metric;
  const fieldWords = annotateBrief(withField, index);
  const fw = wordsFor(fieldWords, index);
  const out: Phrase[] = [];
  for (const kind of GRAMMAR_KINDS) {
    const needsField = kind === 'click' || kind === 'rank' || kind === 'share' || kind === 'ignore' || kind === 'kind';
    const start = kind === 'metric' ? '' : kind === 'field' ? metric : needsField ? withField : metric;
    const h = hintFor(kind, kind === 'field' ? w : needsField ? fw : w, needsField && !!w.field);
    if (!h) continue;
    out.push({ kind, ...PHRASE_TEXT[kind], example: appendHint(start, h) });
  }
  return out;
}

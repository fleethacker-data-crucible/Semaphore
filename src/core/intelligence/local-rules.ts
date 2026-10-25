// Local rules: the default provider. A deterministic reading of the analyst's brief against the
// catalog's labels and synonyms. It runs in the browser, needs no model, and is what every
// remote provider falls back to. It understands a useful subset of plain English:
//
//   "labor cost by region and ship class"          metrics, "by" fields
//   "monthly work orders", "orders per quarter"    a date field at a grain
//   "last 12 months", "past 2 quarters"            a relative date filter
//   "top 10 hulls by cost"                         a limit and sort
//   "as a table", "pie", "trend"                   the flag kind
//   "clicking a bar filters the page", "drill"     click behaviour
//   "ignore the region filter"                     selections this flag skips
//   "turn red over $5M", "amber under 80%"         thresholds

import { type CatalogIndex, type Field, metricTable } from '../catalog.ts';
import type { Behavior, Binding, DimensionRef, Filter, FlagKind, Threshold, TimeGrain, Tone } from '../hoist.ts';
import type { DraftFlagRequest, DraftHoistRequest, FlagDraft, HoistDraft, IntelligenceProvider } from './contract.ts';

export class LocalRulesProvider implements IntelligenceProvider {
  readonly id = 'local-rules';
  readonly label = 'Local rules';
  readonly local = true;
  private readonly index: CatalogIndex;
  constructor(index: CatalogIndex) {
    this.index = index;
  }

  async ping(): Promise<string> {
    return 'Local rules are built in and always available.';
  }

  async draftFlag(request: DraftFlagRequest): Promise<FlagDraft> {
    return draftFlagLocally(request.brief.flag, request.brief.kind, this.index);
  }

  async draftHoist(request: DraftHoistRequest): Promise<HoistDraft> {
    return draftHoistLocally(request.brief, this.index);
  }
}

// ---------------------------------------------------------------------------------------------

interface Mention {
  key: string;
  kind: 'metric' | 'field';
  start: number;
  end: number;
}

interface Analysis {
  text: string;
  metrics: string[];
  dims: DimensionRef[];
  grain: TimeGrain | null;
  last: { n: number; unit: TimeGrain } | null;
  top: { n: number; dir: 'asc' | 'desc' } | null;
  kindWord: FlagKind | null;
  onClick: Behavior['onClick'];
  /** Fields named in a "clicking … filters" clause. */
  clickFields: string[];
  ignore: string[];
  thresholds: Threshold[];
  dateField: Field | undefined;
  table: string | undefined;
  notes: string[];
  unresolved: string[];
}

const GRAIN_WORDS: Array<[RegExp, TimeGrain]> = [
  [/\b(daily|per day|by day|each day|every day)\b/, 'day'],
  [/\b(weekly|per week|by week|each week|every week)\b/, 'week'],
  [/\b(monthly|per month|by month|each month|every month|month over month|mom)\b/, 'month'],
  [/\b(quarterly|per quarter|by quarter|each quarter|every quarter)\b/, 'quarter'],
  [/\b(yearly|annual|annually|per year|by year|each year|every year|year over year|yoy)\b/, 'year'],
];

const KIND_WORDS: Array<[RegExp, FlagKind]> = [
  [/\b(table|list|rows|grid|spreadsheet)\b/, 'table'],
  [/\b(pie|donut|doughnut|share of|mix)\b/, 'pie'],
  [/\barea\b(?!\s+(manager|office))/, 'area'],
  [/\b(line|trend|trending|over time)\b/, 'line'],
  [/\b(bar|bars|column chart|ranking|ranked)\b/, 'bar'],
];

const TONES: Record<string, Tone> = { red: 'bad', green: 'good', amber: 'warn', yellow: 'warn', orange: 'warn' };

function analyze(raw: string, index: CatalogIndex): Analysis {
  const text = ` ${raw.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')} `;
  const notes: string[] = [];
  const blocked: Array<[number, number]> = [];

  // Clauses that name fields for a reason other than grouping.
  const ignore: string[] = [];
  for (const m of text.matchAll(/\bignor\w*\s+(?:the\s+|any\s+)?([a-z0-9 '/-]+?)\s+(?:filters?|selections?|slicers?)\b/g)) {
    const key = matchField(m[1]!, index);
    blocked.push([m.index!, m.index! + m[0].length]);
    if (key) ignore.push(key);
    else notes.push(`No field matches "${m[1]}" in "ignore the … filter".`);
  }
  let onClick: Behavior['onClick'] = 'none';
  const clickFields: string[] = [];
  const click = /\bclick\w*\b([^.;]*?)\b(filters?|filtering|drills?|drilling)\b([^.;]*)/.exec(text);
  if (click) {
    onClick = click[2]!.startsWith('drill') ? 'drill' : 'filter-page';
    blocked.push([click.index, click.index + click[0].length]);
    for (const mention of mentions(click[1]!, index)) if (mention.kind === 'field') clickFields.push(mention.key);
  } else if (/\bdrill\w*\s+(down|into|in)\b/.test(text)) {
    onClick = 'drill';
  }

  const all = mentions(text, index).filter((m) => !blocked.some(([s, e]) => m.start >= s && m.end <= e));
  const metricKeys = unique(all.filter((m) => m.kind === 'metric').map((m) => m.key));

  // Keep to the first metric's table; a flag reads one table.
  const first = metricKeys[0] ? index.metric(metricKeys[0]) : undefined;
  let table = first ? metricTable(index, first) : undefined;
  const metrics = metricKeys.filter((k) => {
    const m = index.metric(k)!;
    if (metricTable(index, m) === table && m.source === first!.source) return true;
    notes.push(`"${m.label}" lives in another table, so it is left out of this flag.`);
    return false;
  });

  // Grouping fields: a field named right after "by", "per", "across", "for each", "vs", or after
  // "and"/"," that follows one of those.
  const dims: DimensionRef[] = [];
  let lastDimEnd = -1;
  for (const m of all) {
    if (m.kind !== 'field') continue;
    const before = text.slice(Math.max(0, m.start - 30), m.start);
    const cued =
      /\b(by|per|across|each|every|vs\.?|versus|split by|broken down by|grouped by|breakdown of)\s+(the\s+|each\s+)?$/.test(before) ||
      /\b(top|bottom|highest|lowest|best|worst)\s+\d{1,4}\s+$/.test(before);
    const chained = lastDimEnd >= 0 && /^(\s*,\s*|\s+and\s+|\s*,\s*and\s+|\s*&\s*)(the\s+)?$/.test(text.slice(lastDimEnd, m.start));
    if (!cued && !chained) continue;
    const f = index.field(m.key)!;
    if (f.type === 'number') continue;
    if (table === undefined) table = f.table;
    if (f.table !== table) {
      notes.push(`"${f.label}" is in another table, so the flag cannot split by it.`);
      continue;
    }
    if (!dims.some((d) => d.field === m.key)) dims.push({ field: m.key });
    lastDimEnd = m.end;
  }

  // "by <words>" that matched nothing.
  const unresolved: string[] = [];
  for (const m of text.matchAll(/\b(?:by|per)\s+(?:the\s+|each\s+)?([a-z][a-z'-]*(?:\s[a-z][a-z'-]*)?)/g)) {
    const at = m.index! + m[0].length - m[1]!.length;
    const word = m[1]!;
    if (all.some((x) => at >= x.start && at < x.end)) continue;
    if (/^(day|week|month|quarter|year|default|itself|then|hand|far|value|count)\b/.test(word)) continue;
    if (blocked.some(([s, e]) => at >= s && at <= e)) continue;
    unresolved.push(word.split(' ')[0]!);
  }

  // Time.
  let grain: TimeGrain | null = null;
  for (const [re, g] of GRAIN_WORDS) if (re.test(text)) {
    grain = g;
    break;
  }
  if (!grain && /\b(trend|trending|over time)\b/.test(text)) grain = 'month';
  let last: Analysis['last'] = null;
  const lm = /\b(last|past|previous|trailing|prior)\s+(\d{1,4}\s+)?(day|week|month|quarter|year)s?\b/.exec(text);
  if (lm) last = { n: lm[2] ? Number(lm[2]) : 1, unit: lm[3] as TimeGrain };
  const mentionedDate = all.find((m) => m.kind === 'field' && index.field(m.key)?.type === 'date');
  const dateField = (mentionedDate && index.field(mentionedDate.key)?.table === table ? index.field(mentionedDate.key) : undefined) ??
    index.catalog.fields.find((f) => f.type === 'date' && (table === undefined || f.table === table));
  if (grain) {
    if (dateField) {
      const existing = dims.findIndex((d) => d.field === dateField.key);
      if (existing >= 0) dims[existing] = { field: dateField.key, grain };
      else dims.unshift({ field: dateField.key, grain });
    } else notes.push('There is no date field in this table to show it over time.');
  }

  // Top / bottom N.
  let top: Analysis['top'] = null;
  const tm = /\b(top|bottom|highest|lowest|worst|best)\s+(\d{1,4})\b/.exec(text);
  if (tm) top = { n: Number(tm[2]), dir: /^(bottom|lowest)/.test(tm[1]!) ? 'asc' : 'desc' };

  let kindWord: FlagKind | null = null;
  for (const [re, k] of KIND_WORDS) if (re.test(text)) {
    kindWord = k;
    break;
  }

  // Thresholds: "<colour> … under/over <number>".
  const thresholds: Threshold[] = [];
  const target = metrics[0];
  for (const m of text.matchAll(/\b(red|green|amber|yellow|orange)\b[^.;]*?\b(under|below|less than|over|above|more than|greater than|exceeds?|at least|at most)\s+\$?\s*(-?[\d,]*\.?\d+)\s*(k|m|b|thousand|million|billion|%|percent)?\b/g)) {
    if (!target) break;
    const word = m[2]!;
    const op: Threshold['op'] = /under|below|less/.test(word) ? 'lt' : word === 'at most' ? 'lte' : word === 'at least' ? 'gte' : 'gt';
    const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, '%': 0.01, percent: 0.01 }[m[4] ?? ''] ?? 1;
    const value = Number(m[3]!.replace(/,/g, '')) * scale;
    if (Number.isFinite(value)) thresholds.push({ metric: target, op, value, tone: TONES[m[1]!]! });
  }

  return { text, metrics, dims, grain, last, top, kindWord, onClick, clickFields, ignore, thresholds, dateField, table, notes, unresolved };
}

export function draftFlagLocally(brief: string, currentKind: FlagKind, index: CatalogIndex): FlagDraft {
  if (!brief.trim()) {
    return { kind: currentKind, title: '', binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, confidence: 0, notes: ['Describe what this flag should show.'] };
  }
  const a = analyze(brief, index);
  const notes = [...a.notes];
  const behavior: Behavior = { onClick: a.onClick, ignore: unique(a.ignore), thresholds: a.thresholds };

  const asksForPicker = /\b(pick|choose|select|filter by|slicer|dropdown|picker)\b/.test(a.text);
  if (currentKind === 'filter' || (a.metrics.length === 0 && asksForPicker)) {
    // A filter flag lists the values of one field.
    const field = a.dims[0]?.field ?? firstFieldMention(a, index);
    if (!field) return unmatched(currentKind, index, notes);
    return {
      kind: 'filter',
      title: index.field(field)!.label,
      binding: { metrics: [], dimensions: [{ field }], filters: [] },
      behavior: { ...behavior, onClick: 'filter-page' },
      confidence: 0.8,
      notes,
    };
  }
  if (a.metrics.length === 0) return unmatched(currentKind, index, notes);

  const filters: Filter[] = [];
  if (a.last) {
    if (a.dateField) filters.push({ field: a.dateField.key, op: 'last', values: [a.last.n], unit: a.last.unit });
    else notes.push(`No date field to apply "last ${a.last.n} ${a.last.unit}" to.`);
  }

  const hasTime = a.dims.some((d) => d.grain);
  const inferred: FlagKind = a.dims.length === 0 ? 'kpi' : hasTime ? 'line' : 'bar';
  let kind: FlagKind = a.kindWord ?? (currentKind === 'text' ? inferred : currentKind);
  if (kind === 'kpi' && a.dims.length > 0) {
    notes.push('A KPI shows one number, so this became a chart because the brief splits it by a field.');
    kind = inferred;
  }
  if ((kind === 'bar' || kind === 'line' || kind === 'area' || kind === 'pie') && a.dims.length === 0) kind = 'kpi';
  if (kind === 'pie' && a.dims.length > 1) {
    notes.push('A pie shows one field; extra fields were left out.');
    a.dims.splice(1);
  }

  const binding: Binding = { metrics: a.metrics, dimensions: a.dims, filters };
  if (a.top) {
    binding.limit = a.top.n;
    binding.sort = { by: a.metrics[0]!, dir: a.top.dir };
  } else if (hasTime) {
    const t = a.dims.find((d) => d.grain)!;
    binding.sort = { by: `${t.field}@${t.grain}`, dir: 'asc' };
  } else if (kind === 'bar' || kind === 'table') {
    binding.sort = { by: a.metrics[0]!, dir: 'desc' };
  }

  let confidence = 0.8;
  for (const word of a.unresolved) {
    notes.push(`No field matches "${word}".`);
    confidence -= 0.25;
  }
  if (a.notes.length) confidence -= 0.1;
  return { kind, title: titleFor(a.metrics, a.dims, index), binding, behavior, confidence: Math.max(0.05, Math.round(confidence * 100) / 100), notes };
}

export function draftHoistLocally(brief: string, index: CatalogIndex): HoistDraft {
  const a = analyze(brief, index);
  const notes = [...a.notes];
  const flags: HoistDraft['flags'] = [];
  const filters: Filter[] = [];
  if (a.last && a.dateField) filters.push({ field: a.dateField.key, op: 'last', values: [a.last.n], unit: a.last.unit });
  const label = (k: string) => index.metric(k)?.label ?? index.field(k)?.label ?? k;
  const push = (brief: string, kind: FlagKind) => {
    const d = draftFlagLocally(brief, kind, index);
    if (d.binding) flags.push({ ...d, brief });
  };

  for (const m of a.metrics.slice(0, 4)) push(`${label(m)}.`, 'kpi');
  for (const f of unique(a.clickFields).slice(0, 3)) push(`Pick ${label(f).toLowerCase()}.`, 'filter');
  const main = a.metrics[0];
  if (main) {
    // Bars for the fields the brief groups by; failing that, for the first field it filters by.
    const splitBy = a.dims.filter((d) => !d.grain).map((d) => d.field);
    const bars = splitBy.length ? splitBy : a.clickFields.slice(0, 1);
    for (const f of bars.slice(0, 2)) {
      push(`${label(main)} by ${label(f).toLowerCase()}.${a.onClick === 'filter-page' ? ' Clicking a bar filters the page.' : ''}`, 'bar');
    }
    if (a.grain || a.last) push(`${label(main)} per ${a.grain ?? 'month'}.`, 'line');
  }
  if (flags.length === 0) notes.push('Nothing in the brief matched the catalog, so no flags were drafted.');
  const title = a.metrics.length ? `${a.metrics.slice(0, 2).map(label).join(' and ')} overview` : 'New hoist';
  return { title, filters, flags, notes };
}

// ---------------------------------------------------------------------------------------------

function unmatched(kind: FlagKind, index: CatalogIndex, notes: string[]): FlagDraft {
  const known = index.catalog.metrics.slice(0, 8).map((m) => m.label).join(', ');
  return {
    kind,
    title: '',
    binding: null,
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    confidence: 0.05,
    notes: [...notes, `No metric in the catalog matches this brief. Known metrics include: ${known}.`],
  };
}

function titleFor(metrics: string[], dims: DimensionRef[], index: CatalogIndex): string {
  const m = metrics.map((k) => index.metric(k)?.label ?? k);
  let title = m.length > 2 ? `${m.slice(0, -1).join(', ')} and ${m.at(-1)}` : m.join(' and ');
  const time = dims.find((d) => d.grain);
  const by = dims.filter((d) => !d.grain).map((d) => (index.field(d.field)?.label ?? d.field).toLowerCase());
  if (by.length) title += ` by ${by.join(' and ')}`;
  if (time) title += ` per ${time.grain}`;
  return title;
}

function firstFieldMention(a: Analysis, index: CatalogIndex): string | undefined {
  return mentions(a.text, index).find((m) => m.kind === 'field' && index.field(m.key)?.type !== 'number')?.key;
}

function matchField(phrase: string, index: CatalogIndex): string | undefined {
  return mentions(` ${phrase} `, index).find((m) => m.kind === 'field')?.key;
}

const phraseCache = new WeakMap<CatalogIndex, Array<{ key: string; kind: 'metric' | 'field'; re: RegExp; len: number }>>();

function phrases(index: CatalogIndex) {
  let list = phraseCache.get(index);
  if (list) return list;
  list = [];
  const add = (key: string, kind: 'metric' | 'field', text: string) => {
    const p = text.toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (p.length < 2) return;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    list!.push({ key, kind, re: new RegExp(`(?<![a-z0-9])${esc}(?:s|es)?(?![a-z0-9])`, 'g'), len: p.length + (kind === 'metric' ? 0.5 : 0) });
  };
  for (const m of index.catalog.metrics) {
    add(m.key, 'metric', m.label);
    add(m.key, 'metric', m.key);
    for (const s of m.synonyms ?? []) add(m.key, 'metric', s);
  }
  for (const f of index.catalog.fields) {
    add(f.key, 'field', f.label);
    add(f.key, 'field', f.key.split('.').at(-1)!);
    for (const s of f.synonyms ?? []) add(f.key, 'field', s);
  }
  list.sort((x, y) => y.len - x.len);
  phraseCache.set(index, list);
  return list;
}

/** Longest-first, non-overlapping catalog mentions in reading order. Metrics win ties. */
function mentions(text: string, index: CatalogIndex): Mention[] {
  const found: Mention[] = [];
  for (const p of phrases(index)) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (found.some((f) => start < f.end && f.start < end)) continue;
      found.push({ key: p.key, kind: p.kind, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

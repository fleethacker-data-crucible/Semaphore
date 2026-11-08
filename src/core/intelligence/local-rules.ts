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
//   "which region had the most cost"               a question: top 5, highest first
//   "vs last year", "change from the prior period" a comparison with an earlier window
//   "as a % of total", "share of"                  values as a share of the total

import { type CatalogIndex, type Field, metricTable } from '../catalog.ts';
import { LIMITS } from '../hoist.ts';
import { fitPivot, fitRichKind, isRichKind, KIND_WORDS as RICH_WORDS } from '../kinds.ts';
import type { ModelSpec } from '../predict/types.ts';
import { DATE_MODELS, MODEL_WORDS } from '../predict/words.ts';
import { reachOf } from '../manyjoin.ts';
import type { Behavior, Binding, Comparison, DimensionRef, Filter, FlagKind, Threshold, TimeGrain, Tone } from '../hoist.ts';
import { suggestKind } from '../shape.ts';
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
    return draftFlagLocally(request.brief.flag, request.brief.kind, this.index, { auto: request.brief.auto === true });
  }

  async draftHoist(request: DraftHoistRequest): Promise<HoistDraft> {
    return draftHoistLocally(request.brief, this.index);
  }
}

// ---------------------------------------------------------------------------------------------

export interface Mention {
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
  compare: Comparison | null;
  share: boolean;
  dateField: Field | undefined;
  table: string | undefined;
  notes: string[];
  unresolved: string[];
}

export const GRAIN_WORDS: Array<[RegExp, TimeGrain]> = [
  [/\b(daily|per day|by day|each day|every day)\b/, 'day'],
  [/\b(weekly|per week|by week|each week|every week)\b/, 'week'],
  [/\b(monthly|per month|by month|each month|every month|month over month|mom)\b/, 'month'],
  [/\b(quarterly|per quarter|by quarter|each quarter|every quarter)\b/, 'quarter'],
  [/\b(yearly|annual|annually|per year|by year|each year|every year|year over year|yoy)\b/, 'year'],
];

export const KIND_WORDS: Array<[RegExp, FlagKind]> = [
  // Read before the chart words, so "matrix of cost by region" is a pivot, not a heatmap.
  [/\b(pivot|pivot table|crosstab|cross-tab|cross tab|matrix of)\b|\bby\s+[a-z][a-z' -]*?\s+across\s+[a-z]/, 'pivot'],
  [/\b(table|list|rows|grid|spreadsheet)\b/, 'table'],
  [/\b(pie|donut|doughnut|share of|mix)\b/, 'pie'],
  [/\barea\b(?!\s+(manager|office))/, 'area'],
  [/\b(line|trend|trending|over time)\b/, 'line'],
  [/\b(bar|bars|column chart|ranking|ranked)\b/, 'bar'],
];

/** "vs last year", "compared with the previous quarter", "year over year", "growth". */
export const COMPARE_RE =
  /\b(?:(?:vs\.?|versus|compared (?:to|with)|against|from)\s+(?:the\s+)?(?:same\s+(?:period|time)\s+)?(last|previous|prior)\s+(year|period|month|quarter|week|day)|(?:same\s+(?:period|time)\s+)?last\s+year's|year over year|yoy|(?:change|growth|trend)\s+(?:from|since|over|on)\s+(?:the\s+)?(?:previous|prior|last)\s+(?:period|month|quarter|week|year)|(?:period|month|quarter) over (?:period|month|quarter)|change|growth)\b/;

/** "% of total", "share of", "as a percentage". */
export const SHARE_RE = /(?:%|\bpercent(?:age)?)\s+of\s+(?:the\s+)?(?:total|all)\b|\bas\s+a\s+(?:share|percent(?:age)?)\b|\bshare\s+of\b|\bproportion\b/;

/** Questions: "which region had the most…", "what class has the lowest…". */
const QUESTION_RE = /\b(?:which|what)\b[^.?;]{0,80}?\b(most|highest|largest|biggest|greatest|top|least|fewest|lowest|smallest)\b/;

const TONES: Record<string, Tone> = { red: 'bad', green: 'good', amber: 'warn', yellow: 'warn', orange: 'warn' };

function analyze(raw: string, index: CatalogIndex): Analysis {
  // Briefs are capped like everywhere else, which also bounds the work every regex below does.
  const text = ` ${raw.slice(0, LIMITS.briefChars).toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')} `;
  const notes: string[] = [];
  const blocked: Array<[number, number]> = [];

  // Clauses that name fields for a reason other than grouping.
  const ignore: string[] = [];
  for (const m of text.matchAll(/\bignor\w{0,6}\s+(?:the\s+|any\s+)?([a-z0-9 '/-]{1,60}?)\s+(?:filters?|selections?|slicers?)\b/g)) {
    const key = matchField(m[1]!, index);
    blocked.push([m.index!, m.index! + m[0].length]);
    if (key) ignore.push(key);
    else notes.push(`No field matches "${m[1]}" in "ignore the … filter".`);
  }
  let onClick: Behavior['onClick'] = 'none';
  const clickFields: string[] = [];
  const click = /\bclick\w{0,6}\b([^.;]{0,160}?)\b(filters?|filtering|drills?|drilling)\b([^.;]{0,160})/.exec(text);
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
  let manyTable: string | undefined; // the one many-side table this flag may split by (manyjoin.ts refuses two)
  for (const m of all) {
    if (m.kind !== 'field') continue;
    const before = text.slice(Math.max(0, m.start - 30), m.start);
    const cued =
      /\b(by|per|across|each|every|vs\.?|versus|split by|broken down by|grouped by|breakdown of|which|what)\s+(the\s+|each\s+)?$/.test(before) ||
      /\b(top|bottom|highest|lowest|best|worst)\s+\d{1,4}\s+$/.test(before);
    const chained = lastDimEnd >= 0 && /^(\s*,\s*|\s+and\s+|\s*,\s*and\s+|\s*&\s*)(the\s+)?$/.test(text.slice(lastDimEnd, m.start));
    if (!cued && !chained) continue;
    const f = index.field(m.key)!;
    if (f.type === 'number') continue;
    if (table === undefined) table = f.table;
    const src = first?.source ?? f.source;
    if (f.table !== table) {
      const reach = f.source !== src ? ({ kind: 'unrelated' } as const) : reachOf(index, src, table, f.table);
      if (reach.kind === 'unrelated') {
        notes.push(`"${f.label}" is in a table not related to this one, so the flag cannot split by it.`);
        continue;
      }
      if (reach.kind === 'ambiguous') {
        notes.push(`"${f.label}" relates to this table in more than one way, so Semaphore will not guess which: the flag does not split by it.`);
        continue;
      }
      if (reach.kind === 'many') {
        if (manyTable !== undefined && manyTable !== f.table) {
          notes.push(`"${f.label}" is on a different many-side table than another field in this brief, and a flag may split by only one, so it is left out.`);
          continue;
        }
        if (manyTable === undefined) {
          manyTable = f.table;
          notes.push(`Splitting by "${f.label}" counts each row of ${table} once in every group it appears in, so the groups can add up to more than the total.`);
        }
      }
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
  // Comparisons first: "vs last year" is a comparison, not a "last 1 year" filter.
  let compare: Comparison | null = null;
  const cm = COMPARE_RE.exec(text);
  let timeText = text;
  if (cm) {
    const unit = cm[2];
    compare = unit === 'year' || /year|yoy/.test(cm[0]) ? 'previous-year' : 'previous-period';
    timeText = text.slice(0, cm.index) + ' '.repeat(cm[0].length) + text.slice(cm.index + cm[0].length);
  }
  const share = SHARE_RE.test(text);
  let last: Analysis['last'] = null;
  const lm = /\b(last|past|previous|trailing|prior)\s+(\d{1,4}\s+)?(day|week|month|quarter|year)s?\b/.exec(timeText);
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
  else {
    const qm = QUESTION_RE.exec(text);
    if (qm && dims.length > 0) top = { n: 5, dir: /^(least|fewest|lowest|smallest)$/.test(qm[1]!) ? 'asc' : 'desc' };
  }

  // "Clicking a bar filters the page" names a bar to click, not the chart to draw.
  let kindText = text;
  for (const [s0, e0] of blocked) kindText = kindText.slice(0, s0) + ' '.repeat(e0 - s0) + kindText.slice(e0);
  let kindWord: FlagKind | null = null;
  for (const [re, k] of [KIND_WORDS[0]!, ...RICH_WORDS, ...KIND_WORDS.slice(1)]) if (re.test(kindText)) {
    kindWord = k;
    break;
  }

  // Thresholds: "<colour> … under/over <number>".
  const thresholds: Threshold[] = [];
  const target = metrics[0];
  for (const m of text.matchAll(/\b(red|green|amber|yellow|orange)\b[^.;]{0,60}?\b(under|below|less than|over|above|more than|greater than|exceeds?|at least|at most)\s+\$?\s?(-?\d[\d,]{0,20}(?:\.\d{1,6})?)\s?(k|m|b|thousand|million|billion|%|percent)?(?![a-z0-9])/g)) {
    if (!target) break;
    const word = m[2]!;
    const op: Threshold['op'] = /under|below|less/.test(word) ? 'lt' : word === 'at most' ? 'lte' : word === 'at least' ? 'gte' : 'gt';
    const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, '%': 0.01, percent: 0.01 }[m[4] ?? ''] ?? 1;
    const value = Number(m[3]!.replace(/,/g, '')) * scale;
    if (Number.isFinite(value)) thresholds.push({ metric: target, op, value, tone: TONES[m[1]!]! });
  }

  return { text, metrics, dims, grain, last, top, kindWord, onClick, clickFields, ignore, thresholds, compare, share, dateField, table, notes, unresolved };
}

export interface LocalDraftOptions {
  /** Pick the kind from the shape of the data unless the brief names one. */
  auto?: boolean;
}

export function draftFlagLocally(brief: string, currentKind: FlagKind, index: CatalogIndex, options: LocalDraftOptions = {}): FlagDraft {
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
  const shaped = suggestKind({ metrics: a.metrics, dimensions: a.dims, filters, ...(a.share ? { share: true } : {}) }, index);
  const inferred: FlagKind = shaped.kind;
  let kind: FlagKind = a.kindWord ?? (currentKind === 'text' || options.auto ? inferred : currentKind);
  // "Forecast cost for the next 6 months", "simulate the total": a predictive model flag.
  let model: ModelSpec | undefined;
  const modelWord = MODEL_WORDS.find(([re]) => re.test(a.text));
  if (modelWord) {
    kind = 'model';
    model = { type: modelWord[1] };
    const ahead = /\bnext (\d{1,3}) (?:days?|weeks?|months?|quarters?|years?)\b/.exec(a.text);
    if (ahead) model.params = { horizon: Number(ahead[1]) };
    if (DATE_MODELS.includes(model.type) && !a.dims.some((d) => d.grain) && a.dateField) {
      a.dims.unshift({ field: a.dateField.key, grain: a.grain ?? 'month' });
      notes.push(`A forecast reads ${a.dateField.label.toLowerCase()} by ${a.grain ?? 'month'}.`);
    }
  }
  if (kind === 'kpi' && a.dims.length > 0) {
    notes.push('A KPI shows one number, so this became a chart because the brief splits it by a field.');
    kind = inferred;
  }
  if ((kind === 'bar' || kind === 'line' || kind === 'area' || kind === 'pie') && a.dims.length === 0) kind = 'kpi';
  if (kind === 'pie' && a.dims.length > 1) {
    notes.push('A pie shows one field; extra fields were left out.');
    a.dims.splice(1);
  }
  if (isRichKind(kind)) {
    const fit = fitRichKind(kind, { metrics: a.metrics, dimensions: a.dims, filters }, index);
    kind = fit.kind;
    if (fit.note) notes.push(fit.note);
  }

  const binding: Binding = { metrics: a.metrics, dimensions: a.dims, filters };
  if (a.compare) binding.compare = a.compare;
  if (a.share) binding.share = true;
  if (!a.top && !a.kindWord && shaped.limit && (kind === 'bar' || kind === 'pie')) {
    a.top = { n: shaped.limit, dir: 'desc' };
    notes.push(shaped.reason);
  }
  if (a.top) {
    binding.limit = a.top.n;
    binding.sort = { by: a.metrics[0]!, dir: a.top.dir };
  } else if (hasTime) {
    const t = a.dims.find((d) => d.grain)!;
    binding.sort = { by: `${t.field}@${t.grain}`, dir: 'asc' };
  } else if (kind === 'bar' || kind === 'table') {
    binding.sort = { by: a.metrics[0]!, dir: 'desc' };
  }
  if (kind === 'pivot') {
    const fit = fitPivot(binding);
    kind = fit.kind;
    if (fit.note) notes.push(fit.note);
  }

  let confidence = 0.8;
  for (const word of a.unresolved) {
    notes.push(`No field matches "${word}".`);
    confidence -= 0.25;
  }
  if (a.notes.length) confidence -= 0.1;
  return { kind, title: titleFor(a.metrics, a.dims, index), binding, behavior, confidence: Math.max(0.05, Math.round(confidence * 100) / 100), notes, ...(model ? { model } : {}) };
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
    // A flag that came out the same as one already drafted (a split that could not apply) is dropped.
    if (d.binding && !flags.some((f) => f.kind === d.kind && JSON.stringify(f.binding) === JSON.stringify(d.binding))) flags.push({ ...d, brief });
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
  if (flags.length === 0) {
    const starter = starterHoistLocally(index);
    if (!brief.trim()) return starter;
    return { ...starter, notes: ['Nothing in the brief matched the catalog, so this is a starter page built from the catalog instead.', ...starter.notes] };
  }
  const title = a.metrics.length ? `${a.metrics.slice(0, 2).map(label).join(' and ')} overview` : 'New hoist';
  return { title, filters, flags, notes };
}

/**
 * A first page with no brief at all, read off the catalog: headline numbers, pickers for the
 * short lists, a trend over the main date, the main measure split by its most useful field, and
 * the top items of the longest list. The table with the most measures is the subject.
 */
export function starterHoistLocally(index: CatalogIndex, table?: string): HoistDraft {
  const cat = index.catalog;
  const tableOf = (m: (typeof cat.metrics)[number]) => metricTable(index, m);
  const byTable = new Map<string, number>();
  for (const m of cat.metrics) {
    const t = tableOf(m);
    if (t) byTable.set(t, (byTable.get(t) ?? 0) + 1);
  }
  const subject = table ?? [...byTable.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!subject) return { title: 'New hoist', filters: [], flags: [], notes: ['The catalog has no measures yet, so there is nothing to draft.'] };
  const metrics = cat.metrics.filter((m) => tableOf(m) === subject);
  const fields = cat.fields.filter((f) => f.table === subject);
  // Headline order: a row count, totals, averages, distinct counts.
  const rank = { count: 0, sum: 1, avg: 2, count_distinct: 3, max: 4, min: 5 } as const;
  const headline = [...metrics].sort((x, y) => rank[x.agg] - rank[y.agg]).slice(0, 4);
  const main = metrics.find((m) => m.agg === 'sum') ?? headline[0]!;
  const date = fields.find((f) => f.type === 'date');
  const groups = fields.filter((f) => (f.type === 'string' || f.type === 'boolean') && f.key !== main.field);
  const known = (f: (typeof fields)[number]) => f.cardinality ?? 50;
  const pickers = groups.filter((f) => known(f) >= 2 && known(f) <= 30).sort((x, y) => known(x) - known(y)).slice(0, 2);
  const long = groups.filter((f) => known(f) > 30).sort((x, y) => known(x) - known(y))[0];
  const splitBy = pickers[0] ?? groups[0];

  const notes: string[] = [];
  const flags: HoistDraft['flags'] = [];
  const add = (brief: string, kind: FlagKind, d: Omit<FlagDraft, 'notes' | 'confidence'>) => flags.push({ ...d, kind, brief, confidence: 0.7, notes: [] });
  const none: Behavior = { onClick: 'none', ignore: [], thresholds: [] };
  for (const m of headline) add(`${m.label}.`, 'kpi', { kind: 'kpi', title: m.label, binding: { metrics: [m.key], dimensions: [], filters: [] }, behavior: none });
  for (const f of pickers) {
    add(`Pick ${f.label.toLowerCase()}.`, 'filter', { kind: 'filter', title: f.label, binding: { metrics: [], dimensions: [{ field: f.key }], filters: [] }, behavior: { ...none, onClick: 'filter-page' } });
  }
  if (date) {
    add(`${main.label} per month.`, 'line', {
      kind: 'line',
      title: `${main.label} per month`,
      binding: { metrics: [main.key], dimensions: [{ field: date.key, grain: 'month' }], filters: [], sort: { by: `${date.key}@month`, dir: 'asc' } },
      behavior: none,
    });
  }
  if (splitBy) {
    add(`${main.label} by ${splitBy.label.toLowerCase()}. Clicking a bar filters the page.`, 'bar', {
      kind: 'bar',
      title: `${main.label} by ${splitBy.label.toLowerCase()}`,
      binding: { metrics: [main.key], dimensions: [{ field: splitBy.key }], filters: [], sort: { by: main.key, dir: 'desc' } },
      behavior: { ...none, onClick: 'filter-page' },
    });
  }
  if (long) {
    add(`Top 10 ${long.label.toLowerCase()} by ${main.label.toLowerCase()}.`, 'table', {
      kind: 'table',
      title: `Top 10 ${long.label.toLowerCase()} by ${main.label.toLowerCase()}`,
      binding: { metrics: [main.key], dimensions: [{ field: long.key }], filters: [], sort: { by: main.key, dir: 'desc' }, limit: 10 },
      behavior: none,
    });
  }
  const filters: Filter[] = date ? [{ field: date.key, op: 'last', values: [12], unit: 'month' }] : [];
  if (date) notes.push(`The page shows the last 12 months of ${date.label}; change it in the page brief.`);
  notes.push('A starter page, built from the catalog. Rewrite any flag\'s brief to change it.');
  const subjectWords = subject.split('.').at(-1)!.replace(/_/g, ' ');
  return { title: `${subjectWords.charAt(0).toUpperCase()}${subjectWords.slice(1)} overview`, filters, flags, notes };
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

interface Phrase {
  key: string;
  kind: 'metric' | 'field';
  re: RegExp;
  len: number;
  /** The phrase is the name itself (label or key), not a synonym. */
  own: boolean;
}

const phraseCache = new WeakMap<CatalogIndex, Phrase[]>();

function phrases(index: CatalogIndex): Phrase[] {
  let list = phraseCache.get(index);
  if (list) return list;
  list = [];
  const add = (key: string, kind: 'metric' | 'field', text: string, own: boolean) => {
    const p = text.toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
    if (p.length < 2) return;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    list!.push({ key, kind, re: new RegExp(`(?<![a-z0-9])${esc}(?:s|es)?(?![a-z0-9])`, 'g'), len: p.length + (kind === 'metric' ? 0.5 : 0), own });
  };
  for (const m of index.catalog.metrics) {
    add(m.key, 'metric', m.label, true);
    add(m.key, 'metric', m.key, true);
    for (const s of m.synonyms ?? []) add(m.key, 'metric', s, false);
  }
  for (const f of index.catalog.fields) {
    add(f.key, 'field', f.label, true);
    add(f.key, 'field', f.key.split('.').at(-1)!, true);
    for (const s of f.synonyms ?? []) add(f.key, 'field', s, false);
  }
  list.sort((x, y) => y.len - x.len);
  phraseCache.set(index, list);
  return list;
}

/**
 * Longest-first, non-overlapping catalog mentions in reading order. Metrics win ties of length.
 * When several entries answer to the same words ("spend" in two tables), the one in the table
 * the brief's other words point to wins, then one whose own name it is over a synonym.
 */
export function mentions(text: string, index: CatalogIndex): Mention[] {
  const spans: Array<{ start: number; end: number; len: number; candidates: Phrase[] }> = [];
  for (const p of phrases(index)) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      const same = spans.find((f) => f.start === start && f.end === end && f.len === p.len);
      if (same) {
        if (!same.candidates.some((c) => c.key === p.key && c.kind === p.kind)) same.candidates.push(p);
        continue;
      }
      if (spans.some((f) => start < f.end && f.start < end)) continue;
      spans.push({ start, end, len: p.len, candidates: [p] });
    }
  }
  const tableOf = (c: Phrase) => (c.kind === 'metric' ? (() => {
    const m = index.metric(c.key);
    return m ? metricTable(index, m) : undefined;
  })() : index.field(c.key)?.table);
  const votes = new Map<string, number>();
  for (const s of spans) {
    const tables = new Set(s.candidates.map(tableOf).filter((t): t is string => !!t));
    // Unambiguous words count fully; ambiguous ones split their vote.
    for (const t of tables) votes.set(t, (votes.get(t) ?? 0) + 1 / tables.size);
  }
  const found: Mention[] = spans.map((s) => {
    let best = s.candidates[0]!;
    if (s.candidates.length > 1) {
      const score = (c: Phrase) => (votes.get(tableOf(c) ?? '') ?? 0) * 10 + (c.own ? 1 : 0);
      best = [...s.candidates].sort((a, b) => score(b) - score(a))[0]!;
    }
    return { key: best.key, kind: best.kind, start: s.start, end: s.end };
  });
  return found.sort((a, b) => a.start - b.start);
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

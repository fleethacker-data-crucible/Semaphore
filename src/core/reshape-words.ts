// Sentences for the steps that make fields or a table (reshape.ts), proposed the way the other
// cleaning fixes are: the analyst types what they want, Semaphore says it back as a step with a
// preview of what it makes, and nothing changes until they accept. Undo takes the step, the fields
// it made and anything built on them back out. Loaded with the Clean tab.
//
//   "split full name on the comma into last and first"
//   "split code at 3 into prefix and number"           (by position: the first 3 characters, then the rest)
//   "join city and state with ', ' as location"
//   "turn the month columns Jan..Dec into rows of month and value"
//   "group days open into 0-7, 8-30, 31-90, 90+"
//   "bucket cost into quartiles"

import { type Catalog, type CatalogIndex, type Field, indexCatalog, type Metric, pruneCatalog } from './catalog.ts';
import { type CleaningStep, cleanType } from './cleaning.ts';
import type { Cell } from './crossfilter.ts';
import { dropBrokenFormulas } from './formula-words.ts';
import type { QueryPlan } from './planner.ts';
import { type Bucket, BUCKETS_MAX, registerReshaping, SPLIT_MAX, UNPIVOT_MAX } from './reshape.ts';
import * as impl from './reshape-impl.ts';
import { newField, tileBounds } from './reshape-impl.ts';

// Previews run the proposed step, so the readers and SQL are needed from here on.
registerReshaping(impl);

export interface ReshapeProposal {
  step: CleaningStep;
  fields: Field[];
  metrics: Metric[];
  /** The field whose values an equal-count bucket needs for its bounds (withBounds). */
  needsValues?: string;
}

export type ReshapeResult = ({ ok: true } & ReshapeProposal) | { ok: false; error: string };

const TILE_WORDS: Record<string, number> = { halves: 2, tertiles: 3, terciles: 3, thirds: 3, quartiles: 4, quarters: 4, quintiles: 5, fifths: 5, sextiles: 6, deciles: 10, tenths: 10 };
const DELIMS: Record<string, string> = { comma: ',', dash: '-', hyphen: '-', slash: '/', backslash: '\\', space: ' ', semicolon: ';', colon: ':', pipe: '|', underscore: '_', period: '.', dot: '.', 'at sign': '@', tab: '\t' };

/** Whether a sentence reads as one of these steps, so the Clean tab knows which parser to try. */
export const RESHAPE_RE = /^\s*(?:split|separate|join|merge|combine|concatenate|turn|unpivot|reshape|group|bucket|band|bin)\b/i;

export function proposeReshape(sentence: string, index: CatalogIndex, scope?: { source: string; table: string }): ReshapeResult {
  const text = sentence.slice(0, 400).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  const field = (phrase: string) => findField(phrase, index, scope);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const taken = new Set<string>();
  let m: RegExpExecArray | null;

  // Split.
  if ((m = /^(?:split|separate) (?:the )?(.+?) (?:on|by|at) (?:the |a |an |each |every )?(.+?) into (.+)$/i.exec(text))) {
    const f = field(m[1]!);
    if (!f) return unknown(m[1]!);
    const names = list(m[3]!);
    const at = /^(?:positions? |characters? )?((?:\d+)(?:(?:\s*,\s*|\s+and\s+)\d+)*)(?: characters?)?$/i.exec(m[2]!.trim());
    let step: CleaningStep;
    const outs = (n: number) => names.slice(0, n).map((label) => newField(index, f, cap(label), 'string', `split-${id}`, taken));
    if (at) {
      const cuts = at[1]!.split(/\s*,\s*|\s+and\s+/).map(Number);
      if (cuts.some((c, i) => !(c > 0) || (i > 0 && c <= cuts[i - 1]!))) return { ok: false, error: 'Positions go up from 1, for example “at 3 and 5”.' };
      if (names.length !== cuts.length + 1) return { ok: false, error: `Cutting at ${cuts.length} position${cuts.length === 1 ? '' : 's'} makes ${cuts.length + 1} parts: name each, for example “into prefix and number”.` };
      if (names.length > 8) return { ok: false, error: 'A split makes at most 8 parts by position.' };
      const widths = cuts.map((c, i) => c - (cuts[i - 1] ?? 0));
      const fields = outs(names.length);
      step = { id: `split-${id}`, field: f.key, kind: 'split', widths, into: fields.map((x) => x.key), sentence: `Split ${f.label} after character ${listWords(cuts.map(String))} into ${listWords(fields.map((x) => x.label))}`, origin: 'analyst' };
      return { ok: true, step, fields, metrics: [] };
    }
    const delimiter = delimiterOf(m[2]!);
    if (!delimiter) return { ok: false, error: `Say what to split on: a comma, a dash, a space, or the text in quotes, for example “on ' - '”.` };
    if (names.length < 2 || names.length > SPLIT_MAX) return { ok: false, error: `Name 2 to ${SPLIT_MAX} parts, for example “into last and first”.` };
    const fields = outs(names.length);
    step = { id: `split-${id}`, field: f.key, kind: 'split', delimiter, into: fields.map((x) => x.key), sentence: `Split ${f.label} on ${showDelimiter(delimiter)} into ${listWords(fields.map((x) => x.label))}`, origin: 'analyst' };
    return { ok: true, step, fields, metrics: [] };
  }

  // Merge.
  if ((m = /^(?:join|merge|combine|concatenate) (?:the )?(.+?)(?: (?:with|using|separated by) (.+?))? (?:as|into|called|to make) (?:a |an |the )?(?:new )?(?:field )?(?:called )?(.+)$/i.exec(text))) {
    const ins = list(m[1]!).map((p) => ({ p, f: field(p) }));
    const missing = ins.find((x) => !x.f);
    if (missing) return unknown(missing.p);
    const fs = ins.map((x) => x.f!);
    if (fs.length < 2 || fs.length > 6) return { ok: false, error: 'Join 2 to 6 fields, for example “join city and state with ", " as location”.' };
    if (fs.some((f) => f.source !== fs[0]!.source || f.table !== fs[0]!.table)) return { ok: false, error: 'The fields joined must be in one table.' };
    const separator = m[2] === undefined ? ' ' : (delimiterOf(m[2]) ?? (/^(?:nothing|no space)$/i.test(m[2].trim()) ? '' : null));
    if (separator === null) return { ok: false, error: 'Say what goes between the values: a space, a comma, or the text in quotes.' };
    const made = newField(index, fs[0]!, cap(m[3]!.trim()), 'string', `merge-${id}`, taken);
    const step: CleaningStep = { id: `merge-${id}`, field: fs[0]!.key, kind: 'merge', fields: fs.map((f) => f.key), separator, into: [made.key], sentence: `Join ${listWords(fs.map((f) => f.label))} with ${showDelimiter(separator)} as ${made.label}`, origin: 'analyst' };
    return { ok: true, step, fields: [made], metrics: [] };
  }

  // Unpivot.
  if ((m = /^(?:turn|unpivot|reshape) (?:the )?(.+?) into (?:rows(?: of| with)? )?(?:a |an |the )?(.+?) and (?:a |an |the )?(.+?)(?: columns?| fields?)?$/i.exec(text))) {
    const cols = columnsOf(m[1]!, index, scope);
    if (typeof cols === 'string') return { ok: false, error: cols };
    if (cols.length < 2 || cols.length > UNPIVOT_MAX) return { ok: false, error: `Turn 2 to ${UNPIVOT_MAX} columns into rows, for example “turn Jan..Dec into rows of month and value”.` };
    const first = cols[0]!;
    if (cols.some((f) => f.source !== first.source || f.table !== first.table)) return { ok: false, error: 'The columns must be in one table.' };
    const valueType = cleanType(index, first.key);
    if (cols.some((f) => cleanType(index, f.key) !== valueType)) return { ok: false, error: 'The columns hold different kinds of value (numbers and text, say); turn columns of one kind into rows.' };
    const nameLabel = cap(m[2]!.trim());
    const valueLabel = cap(m[3]!.trim());
    const stem = `${first.table.split('.').pop()!.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}_by_${nameLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 60);
    const tables = new Set(index.catalog.fields.filter((f) => f.source === first.source).map((f) => f.table));
    let table = /^[a-z_]/.test(stem) ? stem : `t_${stem}`;
    for (let i = 2; tables.has(table); i++) table = `${stem}_${i}`;
    const stepId = `unpivot-${id}`;
    const at = { source: first.source, table };
    const keep = index.catalog.fields.filter((f) => f.source === first.source && f.table === first.table && !f.derived && !cols.includes(f));
    const kept = keep.map((f): Field => ({ key: uniqueKey(index, `${table}.${f.column}`), label: f.label, source: f.source, table, column: f.column, type: cleanType(index, f.key), derived: stepId, ...(f.synonyms ? { synonyms: f.synonyms } : {}), ...(f.cardinality !== undefined ? { cardinality: f.cardinality } : {}) }));
    for (const f of kept) taken.add(`${table}.${f.column}`);
    const nameField = { ...newField(index, at, nameLabel, 'string', stepId, taken), cardinality: cols.length };
    const valueField = newField(index, at, valueLabel, valueType, stepId, taken);
    const fields = [...kept, nameField, valueField];
    const metrics: Metric[] = valueType === 'number' ? [{ key: uniqueKey(index, `${table}_${valueField.column}`), label: `Total ${valueLabel.toLowerCase()} (by ${nameLabel.toLowerCase()})`, agg: 'sum', field: valueField.key, source: first.source }] : [];
    metrics.push({ key: uniqueKey(index, `${table}_rows`), label: `${cap(table.replace(/_/g, ' '))} rows`, agg: 'count', table, source: first.source });
    const step: CleaningStep = {
      id: stepId,
      field: first.key,
      kind: 'unpivot',
      fields: cols.map((f) => f.key),
      names: cols.map((f) => f.label),
      table,
      into: [nameField.key, valueField.key],
      sentence: `Turn ${listWords(cols.length > 4 ? [cols[0]!.label, `…`, cols.at(-1)!.label] : cols.map((f) => f.label))} (${cols.length} columns) into rows of ${nameLabel.toLowerCase()} and ${valueLabel.toLowerCase()}, as the table ${table}`,
      origin: 'analyst',
    };
    return { ok: true, step, fields, metrics };
  }

  // Bucket.
  if ((m = /^(?:group|bucket|band|bin) (?:the )?(.+?) into (.+)$/i.exec(text))) {
    const f = field(m[1]!);
    if (!f) return unknown(m[1]!);
    if (cleanType(index, f.key) !== 'number') return { ok: false, error: `${f.label} is not a number, so it cannot be grouped into ranges. Read it as a number first (a cleaning fix), or group it another way.` };
    const how = m[2]!.trim().toLowerCase();
    const tiles = TILE_WORDS[how.replace(/^(?:equal )?/, '')] ?? (/^(\d{1,2}) (?:equal(?:-count)? )?(?:groups|buckets|bands)$/.exec(how) ? Number(/^(\d{1,2})/.exec(how)![1]) : undefined);
    if (tiles !== undefined) {
      if (tiles < 2 || tiles > 10) return { ok: false, error: 'Make 2 to 10 equal-count groups.' };
      const made = newField(index, f, `${f.label} ${tiles === 4 ? 'quartile' : 'group'}`, 'string', `bucket-${id}`, taken);
      const step: CleaningStep = { id: `bucket-${id}`, field: f.key, kind: 'bucket', tiles, into: [made.key], sentence: `Group ${f.label} into ${tiles === 4 ? 'quartiles (Q1 lowest to Q4 highest)' : `${tiles} groups with as many rows in each`} as ${made.label}`, origin: 'analyst' };
      return { ok: true, step, fields: [{ ...made, cardinality: tiles }], metrics: [], needsValues: f.key };
    }
    const buckets = parseBuckets(how);
    if (typeof buckets === 'string') return { ok: false, error: buckets };
    const made = newField(index, f, `${f.label} group`, 'string', `bucket-${id}`, taken);
    const step: CleaningStep = { id: `bucket-${id}`, field: f.key, kind: 'bucket', buckets, into: [made.key], sentence: `Group ${f.label} into ${listWords(buckets.map((b) => b.label))} as ${made.label}`, origin: 'analyst' };
    return { ok: true, step, fields: [{ ...made, cardinality: buckets.length }], metrics: [] };
  }
  return { ok: false, error: 'Semaphore can split a field (“split full name on the comma into last and first”), join fields (“join city and state with ", " as location”), turn columns into rows (“turn Jan..Dec into rows of month and value”) or group a number (“group days open into 0-7, 8-30, 31-90, 90+”).' };
}

/** Equal-count groups' bounds, from the values of the field grouped (for dialects with no NTILE). */
export function withBounds(p: ReshapeProposal, values: ReadonlyArray<{ value: Cell; count: number }>): ReshapeProposal {
  if (!p.step.tiles) return p;
  return { ...p, step: { ...p.step, bounds: tileBounds(values, p.step.tiles) } };
}

/** The catalog with a proposal accepted. */
export function acceptReshape(catalog: Catalog, p: ReshapeProposal): Catalog {
  return { ...catalog, cleaning: [...(catalog.cleaning ?? []), p.step], fields: [...catalog.fields, ...p.fields], metrics: [...catalog.metrics, ...p.metrics] };
}

/**
 * The catalog with a step undone: the step, the fields it made, steps and measures built on those
 * fields (and the fields they made), and drill paths through them.
 */
export function undoStep(catalog: Catalog, id: string): Catalog {
  const step = (catalog.cleaning ?? []).find((s) => s.id === id);
  if (!step) return catalog;
  const gone = new Set(catalog.fields.filter((f) => f.derived === id).map((f) => f.key));
  const pruned = pruneCatalog({ ...catalog, cleaning: (catalog.cleaning ?? []).filter((s) => s.id !== id), fields: catalog.fields.filter((f) => !gone.has(f.key)) });
  const left = new Set(pruned.fields.map((f) => f.key));
  const tables = new Set(pruned.fields.map((f) => `${f.source}|${f.table}`));
  // Measures on what went: a field gone, or a row count of a table gone.
  const kept = pruned.metrics.filter((m) => (m.field ? left.has(m.field) : m.agg !== 'count' || !m.table || tables.has(`${m.source}|${m.table}`)));
  // Formulas built on a measure that went go too.
  const metrics = dropBrokenFormulas(kept);
  return { ...pruned, metrics };
}

/** A small query that shows what a proposed step makes: its inputs and outputs, most common first. */
export function previewPlan(catalog: Catalog, p: ReshapeProposal, rows = 8): { plan: QueryPlan; index: CatalogIndex; columns: Array<{ key: string; label: string }> } {
  const next = acceptReshape(catalog, p);
  const index = indexCatalog(next);
  const s = p.step;
  const keys = s.kind === 'unpivot' ? [...p.fields.slice(0, Math.max(0, p.fields.length - 2)).slice(0, 1).map((f) => f.key), ...(s.into ?? [])] : s.kind === 'bucket' ? (s.into ?? []) : [...(s.kind === 'merge' ? (s.fields ?? []) : [s.field]), ...(s.into ?? [])];
  const table = s.kind === 'unpivot' ? s.table! : index.field(s.field)!.table;
  const plan: QueryPlan = {
    flagId: `preview:${s.id}`,
    source: index.field(s.field)!.source,
    table,
    dimensions: keys.map((k, i) => ({ alias: `d${i}`, key: k, field: k })),
    aggregates: [{ alias: 'a0', fn: 'count', field: null }],
    metrics: [{ key: '__rows', agg: 'count', parts: { count: 'a0' } }],
    filters: [],
    own: keys,
    slices: [],
    live: [],
    sort: s.kind === 'bucket' ? { by: keys[0]!, dir: 'asc' } : { by: '__rows', dir: 'desc' },
    limit: s.kind === 'bucket' ? BUCKETS_MAX + 1 : rows,
    rowCap: s.kind === 'bucket' ? BUCKETS_MAX + 1 : rows,
    selfFilter: true,
    estimatedRows: rows,
    notes: [],
  };
  return { plan, index, columns: [...keys.map((k) => ({ key: k, label: index.field(k)!.label })), { key: '__rows', label: 'Rows' }] };
}

// ---------------------------------------------------------------------------------------------

export function findField(phrase: string, index: CatalogIndex, scope?: { source: string; table: string }): Field | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const p = norm(phrase.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:field|column)$/i, '').replace(/^["']|["']$/g, ''));
  const all = index.catalog.fields;
  const pool = scope ? [...all.filter((f) => f.source === scope.source && f.table === scope.table), ...all.filter((f) => f.source !== scope.source || f.table !== scope.table)] : all;
  const names = (f: Field) => [f.label, f.column, f.key, ...(f.synonyms ?? [])].map(norm);
  return pool.find((f) => names(f).includes(p)) ?? pool.find((f) => names(f).some((n) => n.startsWith(`${p} `) || n === `${p}s`)) ?? pool.find((f) => p.length > 3 && names(f).some((n) => n.includes(p)));
}

/** "Jan..Dec", "Jan to Dec", "the month columns Jan-Dec", or a list "jan, feb and mar". */
function columnsOf(phrase: string, index: CatalogIndex, scope?: { source: string; table: string }): Field[] | string {
  const words = phrase.replace(/\b(?:the|columns?|fields?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const range = /(\S+)\s*(?:\.\.\.?|…|\bto\b|\bthrough\b|\bthru\b|-|–)\s*(\S+)$/i.exec(words);
  if (range) {
    const a = findField(range[1]!, index, scope);
    const b = a ? findField(range[2]!, index, { source: a.source, table: a.table }) : undefined;
    if (!a) return `“${range[1]}” is not a column Semaphore knows.`;
    if (!b) return `“${range[2]}” is not a column Semaphore knows.`;
    const inTable = index.catalog.fields.filter((f) => f.source === a.source && f.table === a.table && !f.derived);
    const [i, j] = [inTable.indexOf(a), inTable.indexOf(b)];
    if (i < 0 || j < 0 || j <= i) return `${a.label} and ${b.label} are not a run of columns in one table, first to last.`;
    return inTable.slice(i, j + 1);
  }
  const out: Field[] = [];
  for (const p of list(words)) {
    const f = findField(p, index, scope);
    if (!f) return `“${p}” is not a column Semaphore knows.`;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * "0-7, 8-30, 31-90, 90+", "under 10, 10-50, over 50". Each group holds from <= value < to. Whole-number
 * ranges close at the next whole number, so 7.5 falls in 0-7, and a group never starts inside the one
 * before it ("31-90, 90+": 90 is in 31-90).
 */
export function parseBuckets(text: string): Bucket[] | string {
  const items = text.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.length > BUCKETS_MAX) return `Name 1 to ${BUCKETS_MAX} ranges, for example “0-7, 8-30, 31-90, 90+”.`;
  const num = (s: string) => Number(s.replace(/[$,\s]/g, ''));
  const N = String.raw`-?\$?\d[\d,]*(?:\.\d+)?`;
  const out: Bucket[] = [];
  for (const label of items) {
    let m: RegExpExecArray | null;
    let from: number | undefined;
    let to: number | undefined;
    if ((m = new RegExp(String.raw`^(${N})\s*(?:-|–|to)\s*(${N})$`, 'i').exec(label))) {
      [from, to] = [num(m[1]!), num(m[2]!)];
      if (Number.isInteger(from) && Number.isInteger(to)) to += 1;
    } else if ((m = new RegExp(String.raw`^(${N})\s*\+$|^(?:over|above|more than|at least|>=?)\s*(${N})$|^(${N}) (?:or|and) (?:more|over|above)$`, 'i').exec(label))) from = num(m[1] ?? m[2] ?? m[3]!);
    else if ((m = new RegExp(String.raw`^(?:under|below|less than|<)\s*(${N})$`, 'i').exec(label))) to = num(m[1]!);
    else return `“${label}” is not a range Semaphore can read; write ranges like “0-7”, “90+” or “under 10”.`;
    const prev = out.at(-1)?.to;
    if (prev !== undefined && (from === undefined || from < prev)) from = prev;
    if (from !== undefined && to !== undefined && to <= from) return `“${label}” is empty once the range before it is taken out.`;
    out.push({ label, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
  }
  return out;
}

function delimiterOf(phrase: string): string | null {
  const p = phrase.trim();
  const quoted = /^(["'])(.{1,10}?)\1$/.exec(p);
  if (quoted) return quoted[2]!;
  const word = p.toLowerCase().replace(/^(?:a|an|the|each|every)\s+/, '').replace(/s$/, '');
  if (DELIMS[word] !== undefined) return DELIMS[word]!;
  if (p.length === 1 && !/[A-Za-z0-9]/.test(p)) return p;
  return null;
}

function showDelimiter(d: string): string {
  const named = Object.entries(DELIMS).find(([, v]) => v === d)?.[0];
  if (d === ' ') return 'a space';
  if (d === '') return 'nothing between';
  return named ? `the ${named}` : `“${d}”`;
}

function list(text: string): string[] {
  return text
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
    .map((s) => s.trim().replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:fields?|columns?)$/i, ''))
    .filter(Boolean);
}

function listWords(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function uniqueKey(index: CatalogIndex, base: string): string {
  let key = base;
  for (let i = 2; index.field(key) || index.metric(key); i++) key = `${base}_${i}`;
  return key;
}

function unknown(p: string): { ok: false; error: string } {
  return { ok: false, error: `“${p}” is not a field Semaphore knows. Use a field's name from Data > Fields.` };
}

// Importing a semantic model someone already built: a dbt project (dbt.ts) or a Power BI model
// (powerbi.ts) is read into the shape below, the analyst reviews it and says which Semaphore source
// holds each table, Semaphore profiles those tables for their real columns and types, and
// applyModelImport carries the model's names, measures, links and drill paths into the catalog.
//
// Measures that combine other measures (a ratio, a margin) become calculated measures: a metric with
// agg 'formula' whose formula references other metric keys with + - * /, unary minus, parentheses and
// numbers only (division by zero gives null). Anything the model says that the catalog cannot hold
// is a warning with the original expression; nothing is guessed.

import type { Catalog, Field, FieldType, Hierarchy, Metric } from './catalog.ts';
import type { Relationship } from './joins.ts';

export type ModelTool = 'dbt' | 'powerbi';

export interface ModelColumn {
  /** The name the model uses (a dbt dimension, a Power BI column). */
  name: string;
  /** The database column it reads. */
  column: string;
  /** The label analysts know it by, when the model gives one. */
  label?: string;
  /** The type the model declares; the database's profile decides, this is checked against it. */
  type?: FieldType;
  /** For time dimensions: the grain the model reads it at (day, month...). */
  grain?: string;
  description?: string;
  /** Power BI display folder. */
  folder?: string;
}

export interface ModelTable {
  /** The name the model uses for the table (a semantic model, a Power BI table). */
  name: string;
  /** The database table it reads, as best the model says (schema.table or table). */
  relation: string;
  /** A connection hint (Power BI's Sql.Database server and database), for matching a Semaphore source. */
  connection?: string;
  description?: string;
  columns: ModelColumn[];
}

export type Formula = { num: number } | { ref: string } | { neg: Formula } | { op: '+' | '-' | '*' | '/'; a: Formula; b: Formula };

export type ModelMeasure =
  | { kind: 'agg'; name: string; label: string; agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'; table: string; column?: string; format?: Metric['format']; expression: string; description?: string }
  | { kind: 'formula'; name: string; label: string; formula: Formula; format?: Metric['format']; expression: string; description?: string };

export interface ModelRelationship {
  /** The many side. */
  from: { table: string; column: string };
  /** The one side. */
  to: { table: string; column: string };
  /** Why it is worth knowing (both-direction filtering, one-to-one). */
  note?: string;
}

export interface ModelHierarchy {
  label: string;
  table: string;
  /** Column names (model names), broadest first. */
  levels: string[];
}

export interface ModelRead {
  tool: ModelTool;
  /** The project or model name. */
  name: string;
  tables: ModelTable[];
  measures: ModelMeasure[];
  relationships: ModelRelationship[];
  hierarchies: ModelHierarchy[];
  /** What was not imported and why, each with the original expression where there is one. */
  warnings: string[];
  /** The files that were read. */
  files: string[];
}

/** A file the analyst picked, as text (relative path from the picked folder). */
export interface ModelFile {
  path: string;
  text: string;
}

export const MODEL_LIMITS = { files: 2000, bytes: 20_000_000, fileBytes: 10_000_000, measures: 2000, formulaChars: 2000 };

export function emptyRead(tool: ModelTool, name: string): ModelRead {
  return { tool, name, tables: [], measures: [], relationships: [], hierarchies: [], warnings: [], files: [] };
}

// ---------------------------------------------------------------------------------------------
// Formulas: the calculated-measure grammar, parsed and printed.
// ---------------------------------------------------------------------------------------------

/**
 * Parses `+ - * /`, unary minus, parentheses, numbers and names into a formula. `name` says which
 * words are references (and may rename them, e.g. a dbt alias to its metric); a word it refuses or
 * any other character makes the whole formula unreadable: the error says what was found.
 */
export function parseFormula(text: string, name: (word: string) => string | null = (w) => w): { ok: true; formula: Formula } | { ok: false; reason: string } {
  if (text.length > MODEL_LIMITS.formulaChars) return { ok: false, reason: 'The expression is too long to read' };
  const tokens: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/()]|\S)/gy;
  for (let m = re.exec(text); m; m = re.exec(text)) tokens.push(m[1]!);
  if (!text.trim()) return { ok: false, reason: 'The expression is empty' };
  let i = 0;
  let fail: string | null = null;
  const expr = (depth: number): Formula | null => {
    if (depth > 64) return ((fail = 'The expression is nested too deeply'), null);
    let a = term(depth);
    while (a && (tokens[i] === '+' || tokens[i] === '-')) {
      const op = tokens[i++] as '+' | '-';
      const b = term(depth);
      if (!b) return null;
      a = { op, a, b };
    }
    return a;
  };
  const term = (depth: number): Formula | null => {
    let a = unary(depth);
    while (a && (tokens[i] === '*' || tokens[i] === '/')) {
      const op = tokens[i++] as '*' | '/';
      const b = unary(depth);
      if (!b) return null;
      a = { op, a, b };
    }
    return a;
  };
  const unary = (depth: number): Formula | null => {
    if (tokens[i] === '-') {
      i++;
      const x = unary(depth + 1);
      return x ? { neg: x } : null;
    }
    if (tokens[i] === '+') {
      i++;
      return unary(depth + 1);
    }
    const t = tokens[i];
    if (t === undefined) return ((fail ??= 'The expression ends too soon'), null);
    if (t === '(') {
      i++;
      const x = expr(depth + 1);
      if (!x) return null;
      if (tokens[i] !== ')') return ((fail ??= 'Unbalanced parentheses'), null);
      i++;
      return x;
    }
    if (/^[\d.]/.test(t)) {
      i++;
      return { num: Number(t) };
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (tokens[i + 1] === '(') return ((fail ??= `Uses the function ${t}(), which a calculated measure cannot`), null);
      const ref = name(t);
      if (ref === null) return ((fail ??= `"${t}" is not a measure in this model`), null);
      i++;
      return { ref };
    }
    return ((fail ??= `"${t}" is not part of a calculated measure (only + - * /, parentheses, numbers and measures)`), null);
  };
  const f = expr(0);
  if (!f) return { ok: false, reason: fail ?? 'The expression could not be read' };
  if (i < tokens.length) return { ok: false, reason: tokens[i] === ')' ? 'Unbalanced parentheses' : `"${tokens[i]}" is not part of a calculated measure (only + - * /, parentheses, numbers and measures)` };
  return { ok: true, formula: f };
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 } as const;

/** The formula as text, with each reference printed by `key` and only the parentheses it needs. */
export function printFormula(f: Formula, key: (ref: string) => string = (r) => r): string {
  const go = (x: Formula, parent: number, right: boolean): string => {
    if ('num' in x) return String(x.num);
    if ('ref' in x) return key(x.ref);
    if ('neg' in x) return `-${go(x.neg, 3, false)}`;
    const p = PREC[x.op];
    const s = `${go(x.a, p, false)} ${x.op} ${go(x.b, p, true)}`;
    return p < parent || (right && p === parent) ? `(${s})` : s;
  };
  return go(f, 0, false);
}

export function formulaRefs(f: Formula, out: Set<string> = new Set()): Set<string> {
  if ('ref' in f) out.add(f.ref);
  else if ('neg' in f) formulaRefs(f.neg, out);
  else if ('op' in f) (formulaRefs(f.a, out), formulaRefs(f.b, out));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers for the readers.
// ---------------------------------------------------------------------------------------------

export function slugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'measure';
}

/** "order_total" -> "Order total". */
export function humanize(name: string): string {
  const s = name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : name;
}

/** Shortens an expression for a warning line. */
export function shown(expression: string): string {
  const s = expression.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

// ---------------------------------------------------------------------------------------------
// Into the catalog.
// ---------------------------------------------------------------------------------------------

/** Where one model table now is in the catalog: its source and the table Semaphore profiled. */
export interface PlacedTable {
  model: string;
  source: string;
  table: string;
}

export interface ModelApplied {
  catalog: Catalog;
  /** What happened, one line each, for the analyst. */
  lines: string[];
  added: { metrics: number; formulas: number; relationships: number; hierarchies: number; labels: number };
}

const AGG_WORDS: Record<string, string> = { sum: 'sum', avg: 'average', min: 'minimum', max: 'maximum', count: 'count', count_distinct: 'distinct count' };

/** One line describing a measure, for the review list. */
export function describeMeasure(m: ModelMeasure): string {
  if (m.kind === 'formula') return `calculated: ${printFormula(m.formula)}`;
  return m.column ? `${AGG_WORDS[m.agg]} of ${m.table}.${m.column}` : `count of ${m.table} rows`;
}

/**
 * Carries a read model into a catalog in which the placed tables have just been profiled. Field
 * labels come from the model (the profiled label is kept as a synonym); measures are added over
 * the profiled fields, calculated ones over the measures added; relationships and drill paths join
 * the catalog when both ends were placed in one source. Anything that cannot be placed is a line.
 */
export function applyModelImport(catalog: Catalog, read: ModelRead, placed: readonly PlacedTable[]): ModelApplied {
  const lines: string[] = [];
  const added = { metrics: 0, formulas: 0, relationships: 0, hierarchies: 0, labels: 0 };
  const origin = read.tool;
  const what = read.tool === 'dbt' ? 'the dbt project' : 'the Power BI model';
  const place = new Map(placed.map((p) => [p.model, p]));
  let fields = [...catalog.fields];
  const tableOf = (model: string) => read.tables.find((t) => t.name === model);
  const fieldAt = (p: PlacedTable, column: string): Field | undefined => {
    const c = column.toLowerCase();
    return fields.find((f) => f.source === p.source && f.table.toLowerCase() === p.table.toLowerCase() && f.column.toLowerCase() === c);
  };
  /** A model column (by its model name or its database column) to the catalog field. */
  const columnField = (model: string, name: string): Field | undefined => {
    const p = place.get(model);
    if (!p) return undefined;
    const col = tableOf(model)?.columns.find((c) => c.name === name || c.column === name || c.name.toLowerCase() === name.toLowerCase());
    return fieldAt(p, col?.column ?? name);
  };

  // Field labels and checks against the model's declared types.
  for (const t of read.tables) {
    const p = place.get(t.name);
    if (!p) continue;
    const missing: string[] = [];
    for (const c of t.columns) {
      const f = fieldAt(p, c.column);
      if (!f) {
        missing.push(c.column);
        continue;
      }
      const label = c.label?.trim();
      if (label && label !== f.label) {
        const synonyms = [...new Set([...(f.synonyms ?? []), f.label.toLowerCase(), c.name.toLowerCase()].filter((s) => s && s !== label.toLowerCase()))].slice(0, 12);
        fields = fields.map((x) => (x.key === f.key ? { ...x, label, synonyms } : x));
        added.labels++;
      }
      // Dates read as text are worth a cleaning step; an identifier profiled as text is not news.
      if ((c.type === 'date' && f.type !== 'date') || (c.type === 'number' && f.type === 'string' && !/(^|_)(id|no|num|nbr|number|code|key)$/i.test(c.column))) lines.push(`${t.name}.${c.name}: ${what} has it as ${c.type === 'date' ? 'a date' : `a ${c.type}`}, the database reads ${f.type === 'date' ? 'a date' : `a ${f.type}`}. Add a cleaning step under Data > Clean if it should be ${c.type === 'date' ? 'a date' : `a ${c.type}`}.`);
    }
    if (missing.length) lines.push(`${t.name}: ${missing.length} column${missing.length === 1 ? '' : 's'} the model names ${missing.length === 1 ? 'is' : 'are'} not in ${p.table} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', ...' : ''}).`);
  }
  let cat: Catalog = { ...catalog, fields };

  // Measures: plain aggregates first, then calculated ones in the order their references allow.
  const taken = new Set([...cat.metrics.map((m) => m.key), ...cat.fields.map((f) => f.key)]);
  const keyFor = new Map<string, string>();
  const sourceOf = new Map<string, string>();
  const metrics: Metric[] = [];
  /** Measures already in the catalog that the model defines the same way, and the format it gives them. */
  const reused = new Map<string, Metric['format']>();
  const uniqueKey = (name: string) => {
    let key = slugKey(name);
    for (let i = 2; taken.has(key); i++) key = `${slugKey(name).slice(0, 44)}_${i}`;
    taken.add(key);
    return key;
  };
  for (const m of read.measures) {
    if (m.kind !== 'agg') continue;
    const p = place.get(m.table);
    if (!p) {
      lines.push(`Not added, ${m.label}: its table ${m.table} was not imported.`);
      continue;
    }
    let field: Field | undefined;
    if (m.column) {
      field = columnField(m.table, m.column);
      if (!field) {
        lines.push(`Not added, ${m.label}: no column ${m.column} in ${p.table}.`);
        continue;
      }
      if (m.agg !== 'count' && m.agg !== 'count_distinct' && field.type !== 'number' && !(cat.cleaning ?? []).some((c) => c.field === field!.key && c.kind === 'number')) {
        lines.push(`Not added, ${m.label}: ${field.label} is not a number in the database (${m.expression}).`);
        continue;
      }
    }
    // The same measure imported again is not added twice.
    const same = cat.metrics.find((x) => x.agg === m.agg && x.source === p.source && (field ? x.field === field.key : !x.field && x.table === p.table) && x.label.toLowerCase() === m.label.toLowerCase());
    if (same) {
      keyFor.set(m.name, same.key);
      sourceOf.set(m.name, same.source);
      reused.set(same.key, same.format ?? m.format);
      continue;
    }
    const key = uniqueKey(m.name);
    const metric: Metric = { key, label: m.label, agg: m.agg, source: p.source, ...(field ? { field: field.key } : { table: p.table }), ...(m.format ? { format: m.format } : {}), synonyms: [...new Set([m.name.toLowerCase(), m.expression.slice(0, 80).toLowerCase()])].filter((s) => s !== m.label.toLowerCase()) };
    metrics.push(metric);
    keyFor.set(m.name, key);
    sourceOf.set(m.name, p.source);
    added.metrics++;
  }
  const pending = read.measures.filter((m): m is Extract<ModelMeasure, { kind: 'formula' }> => m.kind === 'formula');
  for (let progress = true; progress && pending.length; ) {
    progress = false;
    for (let k = 0; k < pending.length; k++) {
      const m = pending[k]!;
      const refs = [...formulaRefs(m.formula)];
      if (!refs.every((r) => keyFor.has(r))) continue;
      pending.splice(k--, 1);
      progress = true;
      const sources = new Set(refs.map((r) => sourceOf.get(r)!));
      if (sources.size !== 1) {
        lines.push(`Not added, ${m.label}: ${refs.length ? 'its measures are in different sources' : 'it uses no measure'} (${m.expression}).`);
        continue;
      }
      const source = [...sources][0]!;
      const formula = printFormula(m.formula, (r) => keyFor.get(r)!);
      const same = cat.metrics.find((x) => x.agg === 'formula' && x.formula === formula && x.source === source);
      if (same) {
        keyFor.set(m.name, same.key);
        sourceOf.set(m.name, source);
        reused.set(same.key, same.format ?? m.format);
        continue;
      }
      const key = uniqueKey(m.name);
      metrics.push({ key, label: m.label, agg: 'formula', formula, source, ...(m.format ? { format: m.format } : {}), synonyms: [m.name.toLowerCase()].filter((s) => s !== m.label.toLowerCase()) });
      keyFor.set(m.name, key);
      sourceOf.set(m.name, source);
      added.formulas++;
    }
  }
  for (const m of pending) {
    const missing = [...formulaRefs(m.formula)].filter((r) => !keyFor.has(r));
    lines.push(`Not added, ${m.label}: it needs ${missing.join(', ')}, which ${missing.length === 1 ? 'was' : 'were'} not added (${m.expression}).`);
  }
  cat = { ...cat, metrics: [...cat.metrics.map((x) => (reused.get(x.key) && !x.format ? { ...x, format: reused.get(x.key)! } : x)), ...metrics] };

  // Relationships: both ends placed in one source, and both columns found.
  const rels: Relationship[] = [...(cat.relationships ?? [])];
  for (const r of read.relationships) {
    const a = place.get(r.from.table);
    const b = place.get(r.to.table);
    if (!a || !b) continue;
    if (a.source !== b.source) {
      lines.push(`The link ${r.from.table} -> ${r.to.table} was not added: the tables are in different sources.`);
      continue;
    }
    const fa = columnField(r.from.table, r.from.column);
    const fb = columnField(r.to.table, r.to.column);
    if (!fa || !fb) {
      lines.push(`The link ${r.from.table}.${r.from.column} -> ${r.to.table}.${r.to.column} was not added: ${!fa ? r.from.column : r.to.column} is not in the database table.`);
      continue;
    }
    if (fa.table === fb.table) continue;
    const id = `rel-${fa.table}-${fa.column}-${fb.table}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (rels.some((x) => x.id === id || (x.source === a.source && x.from.table === fa.table && x.from.column === fa.column && x.to.table === fb.table))) continue;
    rels.push({ id, source: a.source, from: { table: fa.table, column: fa.column }, to: { table: fb.table, column: fb.column }, origin });
    added.relationships++;
    lines.push(`Linked ${fa.table} to ${fb.table} on ${fa.label}, as ${what} does.${r.note ? ` ${r.note}` : ''}`);
  }
  if (rels.length) cat = { ...cat, relationships: rels };

  // Drill paths.
  const hier: Hierarchy[] = [...(cat.hierarchies ?? [])];
  for (const h of read.hierarchies) {
    if (!place.get(h.table)) continue;
    const levels = h.levels.map((l) => columnField(h.table, l));
    if (levels.some((l) => !l)) {
      lines.push(`The drill path ${h.label} was not added: ${h.levels.filter((_, i) => !levels[i]).join(', ')} not in the database table.`);
      continue;
    }
    const keys = [...new Set(levels.map((l) => l!.key))];
    if (keys.length < 2) continue;
    const id = `${origin}-${slugKey(h.table)}-${slugKey(h.label)}`.replace(/_/g, '-');
    if (hier.some((x) => x.id === id)) continue;
    hier.push({ id, label: h.label, levels: keys });
    added.hierarchies++;
  }
  if (hier.length) cat = { ...cat, hierarchies: hier };

  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  if (added.metrics || added.formulas || reused.size) lines.unshift(`${n(added.metrics, 'measure')} and ${n(added.formulas, 'calculated measure')} added from ${what}${reused.size ? `; ${n(reused.size, 'measure')} it defines ${reused.size === 1 ? 'was' : 'were'} already in the catalog and ${reused.size === 1 ? 'is' : 'are'} used as ${reused.size === 1 ? 'it is' : 'they are'}` : ''}.`);
  if (added.hierarchies) lines.push(`${n(added.hierarchies, 'drill path')} added.`);
  return { catalog: cat, lines, added };
}

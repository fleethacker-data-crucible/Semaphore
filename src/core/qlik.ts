// Porting from Qlik. Qlik already knows what the data means: its load script names the tables and
// fields (and renames columns into the words analysts use), its associations say which fields link
// tables, its mapping loads clean messy values, and its chart expressions define the measures.
// This module reads all of that deterministically, with no model:
//
//   parseLoadScript   load script text -> connections, tables (SQL, file, resident, inline,
//                     mapping) with their fields and renames, and warnings for what it skipped
//   qlikLabels        table -> column -> the label Qlik gave it (labels and synonyms for profiling)
//   qlikAssociations  fields with the same name in two or more tables: Qlik's implicit joins
//   qlikMappings      mapping tables (ApplyMap) with their value pairs: proposed cleaning steps
//   parseQlikExpression  Sum/Avg/Min/Max/Count(DISTINCT) with simple set analysis -> a measure
//                     and filters; anything else is returned as unsupported with the reason, for the
//                     AI or the analyst
//
// Types are not taken from Qlik: Semaphore profiles the real tables for those. Everything here is
// a proposal the analyst reviews before it reaches the catalog. Input is capped and the parser uses
// no backtracking-prone regular expressions on whole statements.

import type { Aggregate, Catalog, Field, Metric } from './catalog.ts';
import type { CleaningStep } from './cleaning.ts';
import type { RelationshipCandidate } from './quality.ts';

export const QLIK_LIMITS = { scriptChars: 500_000, statements: 2000, fields: 500, mappingPairs: 5000, expressionChars: 2000 };

export interface QlikField {
  /** The column (or Qlik field) read, without brackets or quotes; '' for a computed field. */
  column: string;
  /** The field name Qlik gives it (after AS), or the column. */
  name: string;
  /** The source expression when it is not a plain column, e.g. "Date(OpenedOn)". */
  expression?: string;
  /** The mapping table used, when the field is ApplyMap('Map', column). */
  mapping?: string;
}

export type QlikTableKind = 'sql' | 'file' | 'resident' | 'inline' | 'mapping' | 'autogenerate';

export interface QlikTable {
  /** The Qlik table label ("Orders:"), or a generated one. */
  label: string;
  kind: QlikTableKind;
  /** schema.table for SQL, the file path for files, the source table for RESIDENT. */
  from?: string;
  /** The connection the statement ran under (LIB CONNECT TO / ODBC CONNECT TO). */
  connection?: string;
  fields: QlikField[];
  /** True when the field list was "*": the columns come from profiling. */
  star: boolean;
  where?: string;
  /** The table it is joined or concatenated into, when the statement says so. */
  into?: { how: 'join' | 'left join' | 'right join' | 'inner join' | 'outer join' | 'concatenate' | 'keep'; table?: string };
  /** For inline and mapping tables: the rows, header first. */
  rows?: string[][];
  line: number;
}

export interface QlikScript {
  connections: string[];
  tables: QlikTable[];
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Lexing: comments out, statements split on ';' outside quotes, brackets and INLINE blocks.
// ---------------------------------------------------------------------------------------------

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '[' || c === '`') {
      quote = c === '[' ? ']' : c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  // REM comments run to the next semicolon at the start of a statement.
  return out.replace(/(^|;)\s*REM\b[^;]*/gi, '$1');
}

function splitStatements(text: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let start = 0;
  let quote: string | null = null;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') line++;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[') quote = ']';
    else if (c === ';') {
      const s = text.slice(start, i).trim();
      if (s) out.push({ text: s, line: startLine });
      start = i + 1;
      startLine = line;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ text: tail, line: startLine });
  return out;
}

/** Split on top-level commas (outside quotes, brackets and parentheses). */
function splitTop(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[') quote = ']';
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** [Field Name], "Field Name", `Field`, Field -> Field Name. */
export function unquote(name: string): string {
  const s = name.trim();
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) return s.slice(1, -1).trim();
  return s;
}

const PLAIN = /^(\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_%$#@][\w.%$#@]*)$/;

/** Find a keyword at top level (outside quotes and parentheses), case-insensitive, whole word. */
function findTop(text: string, keyword: string, from = 0): number {
  const kw = keyword.toLowerCase();
  let depth = 0;
  let quote: string | null = null;
  const lower = text.toLowerCase();
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[') quote = ']';
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && lower.startsWith(kw, i) && !/[\w]/.test(text[i - 1] ?? ' ') && !/[\w]/.test(text[i + kw.length] ?? ' ')) return i;
  }
  return -1;
}

function parseFieldList(list: string, warnings: string[], label: string): { fields: QlikField[]; star: boolean } {
  const fields: QlikField[] = [];
  let star = false;
  for (const item of splitTop(list).slice(0, QLIK_LIMITS.fields)) {
    if (item === '*') {
      star = true;
      continue;
    }
    const as = findTop(item, 'as');
    const expr = (as >= 0 ? item.slice(0, as) : item).trim();
    const name = unquote(as >= 0 ? item.slice(as + 2) : item);
    if (PLAIN.test(expr)) {
      const col = unquote(expr);
      fields.push({ column: col.includes('.') && !expr.startsWith('[') ? col.split('.').pop()! : col, name });
      continue;
    }
    const applyMap = /^ApplyMap\s*\(\s*'([^']+)'\s*,\s*([^,()]+?)\s*(?:,[^()]*)?\)$/i.exec(expr);
    if (applyMap) {
      fields.push({ column: unquote(applyMap[2]!), name, mapping: applyMap[1]!, expression: expr.slice(0, 300) });
      continue;
    }
    // A computed field: keep the expression, and the one column it reads when there is exactly one.
    const cols = [...new Set(expr.match(/\[[^\]]+\]|\b[A-Za-z_][\w]*\b(?!\s*\()/g)?.map(unquote) ?? [])].filter((c) => !/^(and|or|not|if|null|true|false)$/i.test(c));
    fields.push({ column: cols.length === 1 ? cols[0]! : '', name, expression: expr.slice(0, 300) });
  }
  if (splitTop(list).length > QLIK_LIMITS.fields) warnings.push(`${label}: only the first ${QLIK_LIMITS.fields} fields were read.`);
  return { fields, star };
}

function parseInline(block: string): string[][] {
  // INLINE [ header \n row \n row ] or with quotes; comma separated, simple quoting.
  const body = block.replace(/^\s*\[|\]\s*$/g, '');
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, QLIK_LIMITS.mappingPairs + 1)
    .map((l) => splitTop(l).map((c) => unquote(c.replace(/^'|'$/g, ''))));
}

const PREFIXES: Array<[RegExp, QlikTable['into'] | 'mapping' | 'skip']> = [
  [/^mapping\b/i, 'mapping'],
  [/^noconcatenate\b/i, 'skip'],
  [/^(left|right|inner|outer)\s+join\s*(?:\(\s*([^)]+)\s*\))?/i, { how: 'join' }],
  [/^join\s*(?:\(\s*([^)]+)\s*\))?/i, { how: 'join' }],
  [/^concatenate\s*(?:\(\s*([^)]+)\s*\))?/i, { how: 'concatenate' }],
  [/^(left|right|inner)?\s*keep\s*(?:\(\s*([^)]+)\s*\))?/i, { how: 'keep' }],
];

export function parseLoadScript(text: string): QlikScript {
  const warnings: string[] = [];
  if (text.length > QLIK_LIMITS.scriptChars) warnings.push(`Only the first ${QLIK_LIMITS.scriptChars.toLocaleString()} characters were read.`);
  const statements = splitStatements(stripComments(text.slice(0, QLIK_LIMITS.scriptChars)));
  if (statements.length > QLIK_LIMITS.statements) warnings.push(`Only the first ${QLIK_LIMITS.statements} statements were read.`);
  const connections: string[] = [];
  const tables: QlikTable[] = [];
  let connection: string | undefined;
  let pending: { table: QlikTable } | null = null; // a LOAD with no source: a preceding load for the next SELECT
  let unnamed = 0;

  for (const st of statements.slice(0, QLIK_LIMITS.statements)) {
    let s = st.text;
    const conn = /^(?:lib\s+connect\s+to|odbc\s+connect(?:32|64)?\s+to|oledb\s+connect(?:32|64)?\s+to|connect\s+to)\s+(\[[^\]]+\]|'[^']+'|"[^"]+"|\S+)/i.exec(s);
    if (conn) {
      connection = unquote(conn[1]!.replace(/^'|'$/g, ''));
      if (!connections.includes(connection)) connections.push(connection);
      continue;
    }
    if (/^(set|let|trace|exit|sleep|drop|rename|store|qualify|unqualify|section|binary|directory|disconnect|tag|untag|comment|alias|switch|if|else|end|for|next|do|loop|call|sub|include|\$\()/i.test(s)) continue;

    // Label "Name:" (not a drive letter or a URL).
    let label: string | undefined;
    const lab = /^(\[[^\]]+\]|[A-Za-z_][\w ]*?)\s*:(?![\\/])\s*/.exec(s);
    if (lab) {
      label = unquote(lab[1]!);
      s = s.slice(lab[0].length);
    }
    let into: QlikTable['into'];
    let mapping = false;
    for (let guard = 0; guard < 4; guard++) {
      let matched = false;
      for (const [re, what] of PREFIXES) {
        const m = re.exec(s);
        if (!m) continue;
        matched = true;
        if (what === 'mapping') mapping = true;
        else if (what !== 'skip') {
          type How = NonNullable<QlikTable['into']>['how'];
          const side = /^(left|right|inner|outer)/i.exec(m[0])?.[1]?.toLowerCase();
          const how = (what!.how === 'join' && side ? `${side} join` : what!.how) as How;
          // The target table is the last group; group 1 is the join side when there is one.
          const target = unquote((m[2] ?? (/^(left|right|inner|outer)$/i.test(m[1] ?? '') ? '' : m[1]) ?? '').trim());
          into = target ? { how, table: target } : { how };
        }
        s = s.slice(m[0].length).trim();
        break;
      }
      if (!matched) break;
    }

    const isSql = /^sql\s+select\b/i.test(s) || /^select\b/i.test(s);
    const isLoad = /^load\b/i.test(s);
    if (!isSql && !isLoad) {
      if (/^\w+/.test(s)) warnings.push(`Line ${st.line}: skipped "${s.slice(0, 40)}${s.length > 40 ? '…' : ''}" (not a LOAD or SELECT).`);
      continue;
    }

    if (isSql) {
      const body = s.replace(/^sql\s+/i, '').replace(/^select\s+/i, '');
      const from = findTop(body, 'from');
      if (from < 0) {
        warnings.push(`Line ${st.line}: a SELECT without FROM was skipped.`);
        continue;
      }
      const whereAt = findTop(body, 'where', from);
      const fromText = body.slice(from + 4, whereAt < 0 ? undefined : whereAt).trim().split(/\s+(?:as\s+)?\w+\s*$/i)[0]!.trim();
      const src = fromText.split(',')[0]!.trim().replace(/[[\]"`]/g, '');
      const { fields, star } = parseFieldList(body.slice(0, from).replace(/^distinct\s+/i, ''), warnings, `Line ${st.line}`);
      const table: QlikTable = {
        label: label ?? pending?.table.label ?? src.split('.').pop()!,
        kind: 'sql',
        from: src,
        ...(connection ? { connection } : {}),
        fields,
        star,
        ...(whereAt >= 0 ? { where: body.slice(whereAt + 5).trim().slice(0, 500) } : {}),
        ...(into ?? pending?.table.into ? { into: into ?? pending!.table.into } : {}),
        line: st.line,
      };
      if (pending) {
        // A preceding LOAD renames and computes on top of the SELECT: its names win.
        const byCol = new Map(table.fields.map((f) => [f.name.toLowerCase(), f]));
        table.fields = pending.table.star
          ? table.fields
          : pending.table.fields.map((f) => {
              const under = byCol.get(f.column.toLowerCase());
              return under ? { ...f, column: under.column } : f;
            });
        if (mapping || pending.table.kind === 'mapping') table.kind = 'mapping';
        pending = null;
      }
      if (mapping) table.kind = 'mapping';
      tables.push(table);
      continue;
    }

    // LOAD ... [FROM file | RESIDENT t | INLINE [...] | AUTOGENERATE n] [WHERE ...]
    const body = s.replace(/^load\s+/i, '').replace(/^distinct\s+/i, '');
    const fromAt = findTop(body, 'from');
    const resAt = findTop(body, 'resident');
    const inlineAt = findTop(body, 'inline');
    const autoAt = findTop(body, 'autogenerate');
    const cut = [fromAt, resAt, inlineAt, autoAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    const { fields, star } = parseFieldList(cut < 0 ? body : body.slice(0, cut), warnings, `Line ${st.line}`);
    const base = { label: label ?? `Table ${++unnamed}`, fields, star, ...(into ? { into } : {}), line: st.line };
    if (cut < 0) {
      pending = { table: { ...base, kind: mapping ? 'mapping' : 'sql' } };
      continue;
    }
    const whereAt = findTop(body, 'where', cut);
    const tail = body.slice(cut, whereAt < 0 ? undefined : whereAt).trim();
    const where = whereAt >= 0 ? { where: body.slice(whereAt + 5).trim().slice(0, 500) } : {};
    let table: QlikTable;
    if (cut === inlineAt) {
      const rows = parseInline(tail.replace(/^inline\s*/i, '').replace(/\([^)]*\)\s*$/, ''));
      const header = rows[0] ?? [];
      table = { ...base, kind: mapping ? 'mapping' : 'inline', fields: star || !fields.length ? header.map((h) => ({ column: h, name: h })) : fields, star: false, rows, ...where };
    } else if (cut === resAt) {
      table = { ...base, kind: mapping ? 'mapping' : 'resident', from: unquote(tail.replace(/^resident\s+/i, '').split(/\s/)[0] ?? ''), ...where };
    } else if (cut === autoAt) {
      table = { ...base, kind: 'autogenerate', ...where };
    } else {
      const path = tail.replace(/^from\s+/i, '').replace(/\s*\([^)]*\)\s*$/, '');
      table = { ...base, kind: mapping ? 'mapping' : 'file', from: unquote(path).slice(0, 300), ...(connection ? { connection } : {}), ...where };
    }
    tables.push(table);
  }
  if (pending) warnings.push(`A LOAD with no FROM, RESIDENT or SELECT after it was skipped (line ${pending.table.line}).`);
  return { connections, tables, warnings };
}

// ---------------------------------------------------------------------------------------------
// What the script tells us
// ---------------------------------------------------------------------------------------------

/** Tables Semaphore can read (SQL and files), keyed by `from`: column -> the name Qlik gives it. */
export function qlikLabels(script: QlikScript): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const t of script.tables) {
    if ((t.kind !== 'sql' && t.kind !== 'file') || !t.from) continue;
    const cols = out.get(t.from) ?? new Map<string, string>();
    for (const f of t.fields) if (f.column && !f.expression) cols.set(f.column.toLowerCase(), f.name);
    out.set(t.from, cols);
  }
  return out;
}

export interface QlikAssociation {
  /** The shared field name. */
  field: string;
  /** Tables (labels) that hold it, with the column it comes from in each. */
  tables: Array<{ label: string; from?: string; column: string }>;
}

/** Qlik links tables on fields with the same name: those are the joins it was making. */
export function qlikAssociations(script: QlikScript): QlikAssociation[] {
  const byName = new Map<string, QlikAssociation>();
  for (const t of script.tables) {
    if (t.kind === 'mapping' || t.into?.how === 'concatenate') continue;
    for (const f of t.fields) {
      const key = f.name.toLowerCase();
      const a = byName.get(key) ?? { field: f.name, tables: [] };
      if (!a.tables.some((x) => x.label === t.label)) a.tables.push({ label: t.label, ...(t.from ? { from: t.from } : {}), column: f.column || f.name });
      byName.set(key, a);
    }
  }
  return [...byName.values()].filter((a) => a.tables.length > 1);
}

export interface QlikMapping {
  name: string;
  /** "N.E." -> "Northeast", from an inline mapping table. Empty when the pairs come from a query. */
  pairs: Array<[string, string]>;
  from?: string;
  /** Fields that use it through ApplyMap, as "table.field". */
  usedBy: string[];
}

export function qlikMappings(script: QlikScript): QlikMapping[] {
  const maps = script.tables.filter((t) => t.kind === 'mapping');
  return maps.map((m) => {
    const pairs: Array<[string, string]> = (m.rows ?? [])
      .slice(1)
      .filter((r) => r.length >= 2)
      .slice(0, QLIK_LIMITS.mappingPairs)
      .map((r) => [r[0]!, r[1]!]);
    const usedBy = script.tables.flatMap((t) => t.fields.filter((f) => f.mapping?.toLowerCase() === m.label.toLowerCase()).map((f) => `${t.label}.${f.name}`));
    return { name: m.label, pairs, ...(m.from ? { from: m.from } : {}), usedBy };
  });
}

// ---------------------------------------------------------------------------------------------
// Chart expressions
// ---------------------------------------------------------------------------------------------

export interface QlikSetFilter {
  field: string;
  op: 'in' | 'not-in' | 'between' | 'gte' | 'lte' | 'gt' | 'lt';
  values: Array<string | number>;
}

export type QlikExpression =
  | { ok: true; agg: Aggregate; field?: string; filters: QlikSetFilter[]; label: string }
  | { ok: false; reason: string };

const AGGS: Record<string, Aggregate> = { sum: 'sum', avg: 'avg', min: 'min', max: 'max', count: 'count' };

function parseSetValue(v: string): string | number {
  const s = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return unquote(s.replace(/^'|'$/g, '').replace(/^"|"$/g, ''));
}

/**
 * One aggregate over one field with an optional set expression of literal selections, e.g.
 * Sum({<Year={2025}, Region={'Gulf','Northeast'}>} [Labor Cost]) or Count(DISTINCT HullNo).
 * Ratios, nested aggregates, dollar expansions, Aggr() and the like are unsupported: the reason
 * says what was found, for the AI or the analyst.
 */
export function parseQlikExpression(expr: string): QlikExpression {
  const s = expr.trim().replace(/^=/, '').trim();
  if (!s) return { ok: false, reason: 'Empty expression.' };
  if (s.length > QLIK_LIMITS.expressionChars) return { ok: false, reason: 'The expression is too long to read.' };
  if (s.includes('$(')) return { ok: false, reason: 'Uses a dollar-sign expansion, which needs the script variables.' };
  const head = /^(sum|avg|min|max|count)\s*\(/i.exec(s);
  if (!head) return { ok: false, reason: 'Not a single Sum, Avg, Min, Max or Count.' };
  // The call must span the whole expression: find its closing parenthesis.
  let depth = 0;
  let end = -1;
  let quote: string | null = null;
  for (let i = head[0].length - 1; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[') quote = ']';
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: 'Unbalanced parentheses.' };
  if (s.slice(end + 1).trim()) return { ok: false, reason: 'A calculation across aggregates (for example a ratio); add it as two measures or ask the AI.' };
  let inner = s.slice(head[0].length, end).trim();
  const fn = head[1]!.toLowerCase();
  const filters: QlikSetFilter[] = [];
  if (inner.startsWith('{')) {
    const close = inner.indexOf('}', inner.lastIndexOf('>'));
    if (close < 0) return { ok: false, reason: 'Unbalanced set expression.' };
    const set = inner.slice(1, close).trim();
    inner = inner.slice(close + 1).trim();
    const body = /^(?:\$|1)?\s*<(.*)>$/s.exec(set);
    if (!body) return { ok: false, reason: 'A set expression with set operators or bookmarks.' };
    for (const part of splitTop(body[1]!)) {
      const m = /^(\[[^\]]+\]|[A-Za-z_][\w.]*)\s*(-?=)\s*\{(.*)\}$/s.exec(part);
      if (!m) return { ok: false, reason: `A set modifier Semaphore cannot read: ${part.slice(0, 60)}` };
      const field = unquote(m[1]!);
      const rawValues = splitTop(m[3]!);
      const range = rawValues.length === 1 ? /^"([<>]=?)\s*([^"]+)"$/.exec(rawValues[0]!) : null;
      if (range) {
        const op = ({ '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' } as const)[range[1] as '>=' | '<=' | '>' | '<'];
        filters.push({ field, op, values: [parseSetValue(range[2]!)] });
        continue;
      }
      if (rawValues.some((v) => /[*?]|^"|\(/.test(v))) return { ok: false, reason: `Searches or functions inside the set for ${field}.` };
      filters.push({ field, op: m[2] === '-=' ? 'not-in' : 'in', values: rawValues.map(parseSetValue) });
    }
  }
  let agg = AGGS[fn]!;
  const distinct = /^distinct\s+/i.exec(inner);
  if (distinct) {
    if (fn !== 'count') return { ok: false, reason: 'DISTINCT is only read with Count.' };
    agg = 'count_distinct';
    inner = inner.slice(distinct[0].length).trim();
  }
  if (inner === '*' || inner === '1') {
    if (fn !== 'count') return { ok: false, reason: `${fn}(${inner}) is not a measure of a field.` };
    return { ok: true, agg: 'count', filters, label: 'Count' };
  }
  if (!PLAIN.test(inner)) return { ok: false, reason: 'Aggregates a calculation, not a field; add the calculation as a field first or ask the AI.' };
  const field = unquote(inner);
  const word = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count of', count_distinct: 'Distinct' }[agg];
  return { ok: true, agg, field, filters, label: `${word} ${field}` };
}

// ---------------------------------------------------------------------------------------------
// Into the catalog: after Semaphore has profiled a table, Qlik's words become its labels.
// ---------------------------------------------------------------------------------------------

/**
 * Give the fields of one profiled table the names Qlik gave their columns. The label Semaphore
 * proposed is kept as a synonym, so both the analysts' words and the column's own name work.
 */
export function applyQlikLabels(catalog: Catalog, source: string, table: string, labels: ReadonlyMap<string, string>): { catalog: Catalog; renamed: number } {
  let renamed = 0;
  const fields = catalog.fields.map((f) => {
    if (f.source !== source || f.table.toLowerCase() !== table.toLowerCase()) return f;
    const name = labels.get(f.column.toLowerCase());
    if (!name || name === f.label) return f;
    renamed++;
    const synonyms = [...new Set([...(f.synonyms ?? []), f.label.toLowerCase()].filter((s) => s && s !== name.toLowerCase()))].slice(0, 12);
    return { ...f, label: name, synonyms };
  });
  return { catalog: { ...catalog, fields }, renamed };
}

export interface QlikMeasureResult {
  metrics: Metric[];
  /** Expressions turned into a measure whose set analysis must become a flag or page filter. */
  filterNotes: string[];
  /** Expressions not read, with why (for the AI or the analyst). */
  skipped: Array<{ label: string; expression: string; reason: string }>;
}

/**
 * Chart expressions ("Label: expression" or just "expression", one per line) into measures over
 * fields already in the catalog. A Qlik field is found by its label (Qlik's name after
 * applyQlikLabels), then its column, then a synonym. `prefer` lists the tables just imported: a
 * name found there wins over the same name elsewhere in the catalog (another source may well have a
 * "Labor cost" too). A name that still matches fields in two tables is not guessed: it is skipped.
 */
export function qlikMeasures(lines: string, catalog: Catalog, prefer: ReadonlyArray<{ source: string; table: string }> = []): QlikMeasureResult {
  const metrics: Metric[] = [];
  const filterNotes: string[] = [];
  const skipped: QlikMeasureResult['skipped'] = [];
  const taken = new Set([...catalog.metrics.map((m) => m.key), ...catalog.fields.map((f) => f.key)]);
  const preferred = (f: Field) => prefer.some((p) => p.source === f.source && p.table.toLowerCase() === f.table.toLowerCase());
  const findField = (name: string): Field | 'ambiguous' | undefined => {
    const n = name.toLowerCase();
    const tests: Array<(f: Field) => boolean> = [(f) => f.label.toLowerCase() === n, (f) => f.column.toLowerCase() === n, (f) => (f.synonyms ?? []).includes(n)];
    for (const pool of [catalog.fields.filter(preferred), catalog.fields]) {
      for (const t of tests) {
        const hits = pool.filter(t);
        if (!hits.length) continue;
        return new Set(hits.map((f) => `${f.source}\u0000${f.table}`)).size > 1 ? 'ambiguous' : hits[0];
      }
    }
    return undefined;
  };
  for (const raw of lines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200)) {
    // "Labor cost: Sum(...)" names the measure; a bare expression gets a name from it.
    const colon = /^([^:(){}=]{1,80}):\s*(.+)$/.exec(raw);
    const given = colon ? colon[1]!.trim() : undefined;
    const expression = colon ? colon[2]!.trim() : raw;
    const parsed = parseQlikExpression(expression);
    if (!parsed.ok) {
      skipped.push({ label: given ?? expression.slice(0, 60), expression, reason: parsed.reason });
      continue;
    }
    let field: Field | undefined;
    if (parsed.field) {
      const found = findField(parsed.field);
      if (found === 'ambiguous') {
        skipped.push({ label: given ?? parsed.label, expression, reason: `"${parsed.field}" matches fields in more than one table: add this measure under Data, picking the field.` });
        continue;
      }
      if (!found) {
        skipped.push({ label: given ?? parsed.label, expression, reason: `No field "${parsed.field}" in the catalog yet: import its table first.` });
        continue;
      }
      field = found;
    }
    // Count(*) counts rows of the first imported table, else of the catalog's first source.
    const table = field?.table ?? prefer[0]?.table ?? catalog.fields.find((f) => f.source === catalog.sources[0]?.id)?.table;
    const source = field?.source ?? prefer[0]?.source ?? catalog.sources[0]?.id;
    if (!source) {
      skipped.push({ label: given ?? parsed.label, expression, reason: 'No source in the catalog yet.' });
      continue;
    }
    const label = given ?? (field ? parsed.label.replace(parsed.field!, field.label) : parsed.label);
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'measure';
    for (let i = 2; taken.has(key); i++) key = `${key.replace(/_\d+$/, '')}_${i}`;
    taken.add(key);
    metrics.push({ key, label, agg: parsed.agg, source, ...(field ? { field: field.key } : table ? { table } : {}), synonyms: [expression.slice(0, 80).toLowerCase()] });
    if (parsed.filters.length) {
      const f = parsed.filters.map((x) => `${x.field} ${x.op === 'in' ? 'in' : x.op === 'not-in' ? 'not in' : x.op} ${x.values.join(', ')}`).join('; ');
      filterNotes.push(`"${label}" had set analysis (${f}): add it as a filter on the flags that use it.`);
    }
  }
  return { metrics, filterNotes, skipped };
}

// ---------------------------------------------------------------------------------------------
// The work the load script was doing, carried over: mapping loads become cleaning steps, and the
// links Qlik made between same-named fields become relationship candidates (checked on the data).
// ---------------------------------------------------------------------------------------------

/** A Qlik table that was imported: its label in the script and where it now is in the catalog. */
export interface QlikImported {
  qlik: string;
  source: string;
  table: string;
}

function catalogField(catalog: Catalog, at: QlikImported, column: string): Field | undefined {
  const c = column.toLowerCase();
  return catalog.fields.find((f) => f.source === at.source && f.table.toLowerCase() === at.table.toLowerCase() && f.column.toLowerCase() === c);
}

/** ApplyMap('Region map', region) over an inline mapping table → a map step on that field. */
export function qlikCleaningSteps(script: QlikScript, catalog: Catalog, imported: readonly QlikImported[]): { steps: CleaningStep[]; notes: string[] } {
  const steps: CleaningStep[] = [];
  const notes: string[] = [];
  for (const m of qlikMappings(script)) {
    for (const use of m.usedBy) {
      const dot = use.lastIndexOf('.');
      const label = use.slice(0, dot);
      const name = use.slice(dot + 1);
      const at = imported.find((i) => i.qlik === label);
      if (!at) continue;
      const qf = script.tables.find((t) => t.label === label)?.fields.find((f) => f.name === name);
      const field = qf ? catalogField(catalog, at, qf.column) : undefined;
      if (!field) {
        notes.push(`The mapping "${m.name}" on ${name} was not carried over: its column is not in the catalog.`);
        continue;
      }
      if (!m.pairs.length) {
        notes.push(`The mapping "${m.name}" on ${field.label} reads its pairs from ${m.from ?? 'a query'}; add it under Data > Clean once that table is in the catalog.`);
        continue;
      }
      const map = Object.fromEntries(m.pairs.filter(([a, b]) => a !== b));
      steps.push({
        id: `qlik-${m.name}-${field.key}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        field: field.key,
        kind: 'map',
        map,
        sentence: `Read ${field.label} through the Qlik mapping “${m.name}” (${Object.keys(map).length} value${Object.keys(map).length === 1 ? '' : 's'}, e.g. ${m.pairs.slice(0, 2).map(([a, b]) => `“${a}” as “${b}”`).join(', ')})`,
        origin: 'qlik',
      });
    }
  }
  return { steps, notes };
}

/** Each association between two imported tables of one source, in both directions; the data decides which holds. */
export function qlikRelationshipCandidates(script: QlikScript, catalog: Catalog, imported: readonly QlikImported[]): RelationshipCandidate[] {
  const out: RelationshipCandidate[] = [];
  for (const a of qlikAssociations(script)) {
    const ends = a.tables
      .map((t) => {
        const at = imported.find((i) => i.qlik === t.label);
        const field = at ? catalogField(catalog, at, t.column) : undefined;
        return field ? { field } : null;
      })
      .filter((x): x is { field: Field } => x !== null);
    for (const x of ends) for (const y of ends) if (x !== y && x.field.source === y.field.source && x.field.table !== y.field.table) out.push({ from: x.field, to: y.field });
  }
  return out;
}

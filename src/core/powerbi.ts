// Reading a Power BI model from its text formats: a Power BI Project's TMDL folder
// (definition/tables/*.tmdl, relationships.tmdl, model.tmdl) or a model.bim / Tabular JSON file
// (Tabular Editor, SSAS, Analysis Services). A .pbix keeps its model in a compressed binary format
// (VertiPaq); it is refused with what to do instead. Both text formats are read into one shape
// (PbiModel) and mapped into a ModelRead (model-import.ts):
//
//   table             -> a table; its database table from the partition's M query (Schema/Item),
//                        a DirectLake entity, or a simple SELECT * FROM; calculated tables are warnings
//   column            -> a column (sourceColumn), dataType -> field type; calculated columns warn
//   measure           -> SUM(T[c]), AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTROWS(T), DISTINCTCOUNT(T[c]);
//                        DIVIDE(a, b), a / b, a + b, a - b, a * b over measures and those aggregates ->
//                        a calculated measure; CALCULATE with filters, time intelligence and any other
//                        DAX -> a warning with the DAX
//   relationship      -> a link, many to one (cardinality turns it round when needed); many-to-many
//                        and inactive relationships warn
//   hierarchy         -> a drill path
//   format string     -> currency, percent or number

import type { FieldType, Metric } from './catalog.ts';
import { emptyRead, shown, type Formula, type ModelFile, type ModelHierarchy, type ModelMeasure, type ModelRead, type ModelRelationship, type ModelTable } from './model-import.ts';

export interface PbiColumn {
  name: string;
  dataType?: string;
  sourceColumn?: string;
  /** A calculated column's DAX. */
  expression?: string;
  displayFolder?: string;
  description?: string;
  isHidden?: boolean;
  type?: string;
}
export interface PbiMeasure {
  name: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
  description?: string;
}
export interface PbiPartition {
  /** m, query, calculated, entity, ... */
  kind: string;
  source: string;
  entity?: string;
  schema?: string;
}
export interface PbiTable {
  name: string;
  description?: string;
  columns: PbiColumn[];
  measures: PbiMeasure[];
  hierarchies: Array<{ name: string; levels: Array<{ name: string; column: string }> }>;
  partitions: PbiPartition[];
}
export interface PbiRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality?: string;
  toCardinality?: string;
  crossFilteringBehavior?: string;
  isActive?: boolean;
}
export interface PbiModel {
  name: string;
  tables: PbiTable[];
  relationships: PbiRelationship[];
  warnings: string[];
}

export const PBIX_REFUSAL =
  'A .pbix file keeps its model in a compressed binary format that Semaphore does not open. In Power BI Desktop choose File > Save as > Power BI Project (.pbip) and pick its .SemanticModel folder here, or open the model in Tabular Editor and save it as a model.bim file.';

// ---------------------------------------------------------------------------------------------
// model.bim / Tabular JSON
// ---------------------------------------------------------------------------------------------

type J = Record<string, unknown>;
const isJ = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join('\n') : undefined);

/** A .bim or Tabular JSON document (database with a model, or the model itself). */
export function readBim(text: string, file = 'model.bim'): PbiModel {
  const out: PbiModel = { name: file.replace(/^.*[\\/]/, '').replace(/\.(bim|json)$/i, ''), tables: [], relationships: [], warnings: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    out.warnings.push(`${file}: not valid JSON (${(e as Error).message.slice(0, 80)}).`);
    return out;
  }
  const model = isJ(doc) && isJ(doc['model']) ? doc['model'] : isJ(doc) && Array.isArray(doc['tables']) ? doc : null;
  if (!model) {
    out.warnings.push(`${file}: no "model" with tables in it; is it a Tabular model (.bim)?`);
    return out;
  }
  if (isJ(doc) && typeof doc['name'] === 'string') out.name = doc['name'];
  for (const t of arr(model['tables'])) {
    if (!isJ(t) || typeof t['name'] !== 'string') continue;
    const table: PbiTable = { name: t['name'], columns: [], measures: [], hierarchies: [], partitions: [], ...(s(t['description']) ? { description: s(t['description'])! } : {}) };
    for (const c of arr(t['columns'])) {
      if (!isJ(c) || typeof c['name'] !== 'string') continue;
      table.columns.push({
        name: c['name'],
        ...(s(c['dataType']) ? { dataType: s(c['dataType'])! } : {}),
        ...(s(c['sourceColumn']) ? { sourceColumn: s(c['sourceColumn'])! } : {}),
        ...(s(c['expression']) ? { expression: s(c['expression'])! } : {}),
        ...(s(c['displayFolder']) ? { displayFolder: s(c['displayFolder'])! } : {}),
        ...(s(c['description']) ? { description: s(c['description'])! } : {}),
        ...(s(c['type']) ? { type: s(c['type'])! } : {}),
        ...(c['isHidden'] === true ? { isHidden: true } : {}),
      });
    }
    for (const m of arr(t['measures'])) {
      if (!isJ(m) || typeof m['name'] !== 'string') continue;
      table.measures.push({ name: m['name'], expression: s(m['expression']) ?? '', ...(s(m['formatString']) ? { formatString: s(m['formatString'])! } : {}), ...(s(m['displayFolder']) ? { displayFolder: s(m['displayFolder'])! } : {}), ...(s(m['description']) ? { description: s(m['description'])! } : {}) });
    }
    for (const h of arr(t['hierarchies'])) {
      if (!isJ(h) || typeof h['name'] !== 'string') continue;
      const levels = arr(h['levels'])
        .filter(isJ)
        .sort((a, b) => Number(a['ordinal'] ?? 0) - Number(b['ordinal'] ?? 0))
        .map((l) => ({ name: String(l['name'] ?? ''), column: String(l['column'] ?? '') }));
      table.hierarchies.push({ name: h['name'], levels });
    }
    for (const p of arr(t['partitions'])) {
      if (!isJ(p)) continue;
      const src = isJ(p['source']) ? p['source'] : {};
      table.partitions.push({ kind: String(src['type'] ?? 'query'), source: s(src['expression']) ?? s(src['query']) ?? '', ...(s(src['entityName']) ? { entity: s(src['entityName'])! } : {}), ...(s(src['schemaName']) ? { schema: s(src['schemaName'])! } : {}) });
    }
    out.tables.push(table);
  }
  for (const r of arr(model['relationships'])) {
    if (!isJ(r)) continue;
    const [fromTable, fromColumn, toTable, toColumn] = [s(r['fromTable']), s(r['fromColumn']), s(r['toTable']), s(r['toColumn'])];
    if (!fromTable || !fromColumn || !toTable || !toColumn) continue;
    out.relationships.push({ fromTable, fromColumn, toTable, toColumn, ...(s(r['fromCardinality']) ? { fromCardinality: s(r['fromCardinality'])! } : {}), ...(s(r['toCardinality']) ? { toCardinality: s(r['toCardinality'])! } : {}), ...(s(r['crossFilteringBehavior']) ? { crossFilteringBehavior: s(r['crossFilteringBehavior'])! } : {}), ...(r['isActive'] === false ? { isActive: false } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TMDL
// ---------------------------------------------------------------------------------------------

export interface TmdlNode {
  kind: string;
  name: string;
  /** The text after "=" on the object line (and the lines that continue it). */
  expr?: string;
  props: Record<string, string>;
  children: TmdlNode[];
  description?: string;
  line: number;
}

function level(raw: string): number {
  const lead = /^[\t ]*/.exec(raw)![0];
  let tabs = 0;
  let spaces = 0;
  for (const c of lead) c === '\t' ? tabs++ : spaces++;
  return tabs + Math.floor(spaces / 4);
}

/** A TMDL name at the start of `text`: 'quoted ''name''' or a run of characters up to a space, '=', '.' or ':'. */
function tmdlName(text: string): { name: string; rest: string } {
  if (text.startsWith("'")) {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { name: out, rest: text.slice(i + 1) };
      }
      out += text[i];
    }
    return { name: out, rest: '' };
  }
  const m = /^[^\s=.:]+/.exec(text);
  return { name: m ? m[0] : '', rest: text.slice(m ? m[0].length : 0) };
}

function dedent(lines: string[]): string {
  const body = lines.map((l) => l.replace(/\s+$/, ''));
  while (body.length && !body[body.length - 1]) body.pop();
  const widths = body.filter((l) => l.trim()).map((l) => /^[\t ]*/.exec(l)![0].length);
  const cut = widths.length ? Math.min(...widths) : 0;
  return body.map((l) => l.slice(Math.min(cut, /^[\t ]*/.exec(l)![0].length))).join('\n');
}

/** Parses one TMDL document into its top-level objects. */
export function parseTmdl(text: string): { nodes: TmdlNode[]; warnings: string[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const warnings: string[] = [];
  const roots: TmdlNode[] = [];
  const stack: Array<{ node: TmdlNode; level: number }> = [];
  let description: string[] = [];
  /** Reads the lines that continue an expression begun on line `at`: deeper than `min`, or a ``` fence. */
  const continuation = (first: string, at: number, min: number): { text: string; next: number } => {
    const head = first.trim();
    if (head.startsWith('```')) {
      const body: string[] = [];
      let k = at + 1;
      for (; k < lines.length && !/^\s*```\s*$/.test(lines[k]!); k++) body.push(lines[k]!);
      return { text: dedent(body), next: k + 1 };
    }
    const body: string[] = head ? [head] : [];
    let k = at + 1;
    for (; k < lines.length; k++) {
      const l = lines[k]!;
      if (!l.trim()) {
        body.push('');
        continue;
      }
      if (level(l) <= min) break;
      body.push(l);
    }
    // Blank lines before the next property are not part of the expression.
    while (body.length && !body[body.length - 1]!.trim()) {
      body.pop();
    }
    return { text: head ? [head, dedent(body.slice(1))].filter(Boolean).join('\n') : dedent(body), next: k };
  };
  for (let i = 0; i < lines.length; ) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!t) {
      i++;
      continue;
    }
    const lv = level(raw);
    if (t.startsWith('///')) {
      description.push(t.slice(3).trim());
      i++;
      continue;
    }
    if (t.startsWith('//')) {
      i++;
      continue;
    }
    while (stack.length && stack[stack.length - 1]!.level >= lv) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    // A property: "key: value", "key = expression" or a bare flag word ("isHidden").
    const prop = /^([A-Za-z][A-Za-z0-9_]*)\s*(:|=)\s?(.*)$/.exec(t);
    if (prop && parent) {
      if (prop[2] === ':') {
        parent.props[prop[1]!] = prop[3]!.trim();
        i++;
      } else {
        const c = continuation(prop[3]!, i, lv);
        parent.props[prop[1]!] = c.text;
        i = c.next;
      }
      description = [];
      continue;
    }
    const word = /^([A-Za-z][A-Za-z0-9_]*)(\s+|$)/.exec(t);
    if (!word) {
      warnings.push(`Line ${i + 1}: "${t.slice(0, 40)}" was not read.`);
      i++;
      continue;
    }
    const kind = word[1]!;
    const after = t.slice(word[0].length);
    if (!after) {
      if (parent) parent.props[kind] = 'true';
      i++;
      continue;
    }
    if (kind === 'ref') {
      i++;
      continue;
    }
    const nm = tmdlName(after);
    const node: TmdlNode = { kind, name: nm.name, props: {}, children: [], line: i + 1, ...(description.length ? { description: description.join('\n') } : {}) };
    description = [];
    const eq = /^\s*=\s?(.*)$/.exec(nm.rest);
    if (eq) {
      const c = continuation(eq[1]!, i, lv + 1);
      node.expr = c.text;
      i = c.next;
    } else i++;
    (parent ? parent.children : roots).push(node);
    stack.push({ node, level: lv });
  }
  return { nodes: roots, warnings };
}

/** 'Work Orders'.hull_no or Hulls.'Hull No' -> [table, column]. */
export function tmdlColumnRef(ref: string): [string, string] | null {
  const a = tmdlName(ref.trim());
  if (!a.rest.startsWith('.')) return null;
  const b = tmdlName(a.rest.slice(1));
  return a.name && b.name ? [a.name, b.name] : null;
}

/** The TMDL files of a Power BI Project (any of them; tables and relationships may be in any file). */
export function readTmdl(files: readonly ModelFile[]): PbiModel {
  const out: PbiModel = { name: 'Power BI model', tables: [], relationships: [], warnings: [] };
  for (const f of files) {
    const p = parseTmdl(f.text);
    for (const w of p.warnings.slice(0, 10)) out.warnings.push(`${f.path}: ${w}`);
    const project = /(?:^|\/)([^/]+)\.(?:SemanticModel|Dataset)\//i.exec(f.path.replace(/\\/g, '/'));
    if (project) out.name = project[1]!;
    for (const n of p.nodes) {
      if (n.kind === 'model' && !project && n.name && n.name !== 'Model') out.name = n.name;
      if (n.kind === 'table') out.tables.push(tmdlTable(n));
      if (n.kind === 'relationship') {
        const from = tmdlColumnRef(n.props['fromColumn'] ?? '');
        const to = tmdlColumnRef(n.props['toColumn'] ?? '');
        if (!from || !to) {
          out.warnings.push(`${f.path}: the relationship ${n.name} has no fromColumn or toColumn.`);
          continue;
        }
        out.relationships.push({
          fromTable: from[0],
          fromColumn: from[1],
          toTable: to[0],
          toColumn: to[1],
          ...(n.props['fromCardinality'] ? { fromCardinality: n.props['fromCardinality'] } : {}),
          ...(n.props['toCardinality'] ? { toCardinality: n.props['toCardinality'] } : {}),
          ...(n.props['crossFilteringBehavior'] ? { crossFilteringBehavior: n.props['crossFilteringBehavior'] } : {}),
          ...(n.props['isActive'] === 'false' ? { isActive: false } : {}),
        });
      }
    }
  }
  return out;
}

function unquoteProp(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return /^".*"$/s.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t;
}

function tmdlTable(n: TmdlNode): PbiTable {
  const table: PbiTable = { name: n.name, columns: [], measures: [], hierarchies: [], partitions: [], ...(n.description ? { description: n.description } : {}) };
  for (const c of n.children) {
    if (c.kind === 'column') {
      table.columns.push({
        name: c.name,
        ...(c.props['dataType'] ? { dataType: c.props['dataType'] } : {}),
        ...(c.props['sourceColumn'] ? { sourceColumn: unquoteProp(c.props['sourceColumn'])! } : {}),
        ...(c.expr !== undefined ? { expression: c.expr, type: 'calculated' } : {}),
        ...(c.props['displayFolder'] ? { displayFolder: unquoteProp(c.props['displayFolder'])! } : {}),
        ...(c.description ? { description: c.description } : {}),
        ...(c.props['isHidden'] === 'true' ? { isHidden: true } : {}),
      });
    } else if (c.kind === 'measure') {
      table.measures.push({ name: c.name, expression: c.expr ?? '', ...(c.props['formatString'] ? { formatString: unquoteProp(c.props['formatString'])! } : {}), ...(c.props['displayFolder'] ? { displayFolder: unquoteProp(c.props['displayFolder'])! } : {}), ...(c.description ? { description: c.description } : {}) });
    } else if (c.kind === 'hierarchy') {
      table.hierarchies.push({ name: c.name, levels: c.children.filter((l) => l.kind === 'level').map((l) => ({ name: l.name, column: tmdlName(l.props['column'] ?? l.name).name })) });
    } else if (c.kind === 'partition') {
      table.partitions.push({ kind: (c.expr ?? 'm').trim().split(/\s/)[0]!, source: c.props['source'] ?? '', ...(c.props['entityName'] ? { entity: unquoteProp(c.props['entityName'])! } : {}), ...(c.props['schemaName'] ? { schema: unquoteProp(c.props['schemaName'])! } : {}) });
    }
  }
  return table;
}

// ---------------------------------------------------------------------------------------------
// DAX: a tokenizer and an expression parser for the subset measures are written in.
// ---------------------------------------------------------------------------------------------

export type Dax =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'call'; fn: string; args: Dax[] }
  | { t: 'col'; table?: string; col: string }
  | { t: 'tab'; name: string }
  | { t: 'neg'; x: Dax }
  | { t: 'bin'; op: string; a: Dax; b: Dax };

type Tok = { k: 'num' | 'str' | 'tab' | 'col' | 'id' | 'op'; v: string };

export function daxTokens(text: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((c === '/' && text[i + 1] === '/') || (c === '-' && text[i + 1] === '-')) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '[') {
      const close = c === '[' ? ']' : c;
      let v = '';
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === close) {
          if (text[j + 1] === close) {
            v += close;
            j++;
            continue;
          }
          break;
        }
        v += text[j];
      }
      if (j >= text.length) return `An unclosed ${c === '[' ? '[' : 'quote'}.`;
      out.push({ k: c === '"' ? 'str' : c === "'" ? 'tab' : 'col', v });
      i = j + 1;
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?/.exec(text.slice(i, i + 40));
    if (num) {
      out.push({ k: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i, i + 200));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = /^(<>|<=|>=|&&|\|\||[-+*/^(),=<>&{}])/.exec(text.slice(i, i + 2));
    if (op) {
      out.push({ k: 'op', v: op[0] });
      i += op[0].length;
      continue;
    }
    return `The character "${c}" was not expected.`;
  }
  return out;
}

/** Parses a DAX expression, or says why not. VAR / RETURN and table constructors are not read. */
export function parseDax(text: string): Dax | string {
  if (text.length > 20_000) return 'The expression is too long to read.';
  const toks = daxTokens(text);
  if (typeof toks === 'string') return toks;
  if (!toks.length) return 'The expression is empty.';
  let i = 0;
  let err: string | null = null;
  const fail = (m: string) => ((err ??= m), null);
  const peekOp = (v: string) => toks[i]?.k === 'op' && toks[i]!.v === v;
  const bin = (next: (d: number) => Dax | null, ops: string[]) => (d: number): Dax | null => {
    let a = next(d);
    while (a && toks[i]?.k === 'op' && ops.includes(toks[i]!.v)) {
      const op = toks[i++]!.v;
      const b = next(d);
      if (!b) return null;
      a = { t: 'bin', op, a, b };
    }
    return a;
  };
  const primary = (d: number): Dax | null => {
    if (d > 64) return fail('The expression is nested too deeply.');
    const t = toks[i];
    if (!t) return fail('The expression ends too soon.');
    if (t.k === 'op' && t.v === '-') {
      i++;
      const x = primary(d + 1);
      return x ? { t: 'neg', x } : null;
    }
    if (t.k === 'op' && t.v === '+') {
      i++;
      return primary(d + 1);
    }
    if (t.k === 'op' && t.v === '(') {
      i++;
      const x = expr(d + 1);
      if (!x) return null;
      if (!peekOp(')')) return fail('Unbalanced parentheses.');
      i++;
      return x;
    }
    if (t.k === 'num') return (i++, { t: 'num', v: Number(t.v) });
    if (t.k === 'str') return (i++, { t: 'str', v: t.v });
    if (t.k === 'col') return (i++, { t: 'col', col: t.v });
    if (t.k === 'id' && /^(VAR|RETURN|EVALUATE|DEFINE)$/i.test(t.v)) return fail(`Uses ${t.v.toUpperCase()}.`);
    if (t.k === 'id' && toks[i + 1]?.k === 'op' && toks[i + 1]!.v === '(') {
      i += 2;
      const args: Dax[] = [];
      if (!peekOp(')')) {
        for (;;) {
          // An empty argument (DIVIDE(a, b, )) reads as BLANK.
          if (peekOp(',') || peekOp(')')) args.push({ t: 'call', fn: 'BLANK', args: [] });
          else {
            const a = expr(d + 1);
            if (!a) return null;
            args.push(a);
          }
          if (peekOp(',')) {
            i++;
            continue;
          }
          break;
        }
      }
      if (!peekOp(')')) return fail('Unbalanced parentheses.');
      i++;
      return { t: 'call', fn: t.v.toUpperCase(), args };
    }
    if (t.k === 'tab' || t.k === 'id') {
      i++;
      if (toks[i]?.k === 'col') return { t: 'col', table: t.v, col: toks[i++]!.v };
      return { t: 'tab', name: t.v };
    }
    if (t.k === 'op' && t.v === '{') return fail('Uses a table constructor { }.');
    return fail(`"${t.v}" was not expected.`);
  };
  const pow = bin(primary, ['^']);
  const mul = bin(pow, ['*', '/']);
  const add = bin(mul, ['+', '-']);
  const cat = bin(add, ['&']);
  const cmp = bin(cat, ['=', '<>', '<', '>', '<=', '>=']);
  const expr = bin(cmp, ['&&', '||']);
  const out = expr(0);
  if (!out) return err ?? 'The expression could not be read.';
  if (i < toks.length) return `"${toks[i]!.v}" was not expected.`;
  return out;
}

const TIME_INTELLIGENCE = /\b(TOTALYTD|TOTALQTD|TOTALMTD|SAMEPERIODLASTYEAR|DATEADD|PARALLELPERIOD|PREVIOUSYEAR|PREVIOUSQUARTER|PREVIOUSMONTH|PREVIOUSDAY|NEXTYEAR|NEXTQUARTER|NEXTMONTH|NEXTDAY|DATESYTD|DATESQTD|DATESMTD|DATESBETWEEN|DATESINPERIOD|OPENINGBALANCE\w*|CLOSINGBALANCE\w*|STARTOFYEAR|ENDOFYEAR)\s*\(/i;
const TIME_NOTE = "time intelligence is not a measure in Semaphore: add the base measure and use the flag's comparisons (previous period, previous year) or a running total";

const DAX_AGG: Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'> = { SUM: 'sum', AVERAGE: 'avg', MIN: 'min', MAX: 'max', COUNT: 'count', COUNTA: 'count', DISTINCTCOUNT: 'count_distinct' };

export interface DaxContext {
  /** Every measure name in the model (DAX measure names are unique across tables). */
  measures: ReadonlySet<string>;
  /** Table -> its column names. */
  columns: ReadonlyMap<string, ReadonlySet<string>>;
}

export type DaxMapped =
  | { ok: true; agg: { agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'; table: string; column?: string } }
  | { ok: true; formula: Formula; parts: Array<{ ref: string; agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'; table: string; column?: string; dax: string }> }
  | { ok: false; reason: string };

function daxText(d: Dax): string {
  switch (d.t) {
    case 'num':
      return String(d.v);
    case 'str':
      return `"${d.v}"`;
    case 'tab':
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name) ? d.name : `'${d.name}'`;
    case 'col':
      return `${d.table !== undefined ? daxText({ t: 'tab', name: d.table }) : ''}[${d.col}]`;
    case 'neg':
      return `-${daxText(d.x)}`;
    case 'bin':
      return `${daxText(d.a)} ${d.op} ${daxText(d.b)}`;
    case 'call':
      return `${d.fn}(${d.args.map(daxText).join(', ')})`;
  }
}

/**
 * One measure's DAX into a Semaphore measure: a single aggregate of a column (or a row count), or a
 * calculated measure over other measures and inline aggregates (`parts`, each its own measure).
 */
export function mapDax(expression: string, ctx: DaxContext, partName: (n: number) => string = (n) => `part_${n}`): DaxMapped {
  if (TIME_INTELLIGENCE.test(expression)) return { ok: false, reason: TIME_NOTE };
  const tree = parseDax(expression);
  if (typeof tree === 'string') return { ok: false, reason: `the DAX could not be read: ${tree.replace(/\.$/, '')}` };
  const parts: Array<{ ref: string; agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'; table: string; column?: string; dax: string }> = [];
  let reason: string | null = null;
  const no = (r: string): null => ((reason ??= r), null);

  /** An aggregate call, or null with the reason. */
  const aggOf = (d: Dax): { agg: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'; table: string; column?: string } | null => {
    if (d.t !== 'call') return null;
    if (d.fn === 'COUNTROWS') {
      const a = d.args[0];
      if (d.args.length === 1 && a?.t === 'tab' && ctx.columns.has(a.name)) return { agg: 'count', table: a.name };
      return no(`COUNTROWS over ${a ? daxText(a) : 'nothing'} is not a count of one table's rows`);
    }
    const agg = DAX_AGG[d.fn];
    if (!agg) return null;
    const a = d.args[0];
    if (d.args.length !== 1) return no(`${d.fn} with ${d.args.length} arguments is not an aggregate of one column`);
    if (a?.t !== 'col' || a.table === undefined) return no(`${d.fn} of ${a ? daxText(a) : 'nothing'} is not an aggregate of a column (write it as ${d.fn}('Table'[Column]))`);
    const cols = ctx.columns.get(a.table);
    if (!cols) return no(`${a.table} is not a table in this model`);
    if (!cols.has(a.col)) return no(`${a.table}[${a.col}] is not a column in this model`);
    return { agg, table: a.table, column: a.col };
  };

  const unwrap = (d: Dax): Dax => (d.t === 'call' && d.fn === 'CALCULATE' && d.args.length === 1 ? unwrap(d.args[0]!) : d);

  const conv = (d0: Dax): Formula | null => {
    const d = unwrap(d0);
    switch (d.t) {
      case 'num':
        return { num: d.v };
      case 'neg': {
        const x = conv(d.x);
        return x ? { neg: x } : null;
      }
      case 'bin': {
        if (!['+', '-', '*', '/'].includes(d.op)) return no(`the operator ${d.op} is not part of a calculated measure`);
        const a = conv(d.a);
        const b = a && conv(d.b);
        return a && b ? { op: d.op as '+' | '-' | '*' | '/', a, b } : null;
      }
      case 'col': {
        if (ctx.measures.has(d.col) && (d.table === undefined || !ctx.columns.get(d.table)?.has(d.col))) return { ref: d.col };
        return no(`${daxText(d)} is a column without an aggregate`);
      }
      case 'call': {
        if (d.fn === 'DIVIDE') {
          if (d.args.length < 2 || d.args.length > 3) return no('DIVIDE needs two or three arguments');
          const alt = d.args[2];
          if (alt && !(alt.t === 'call' && alt.fn === 'BLANK' && !alt.args.length)) return no(`DIVIDE with an alternate result (${daxText(alt)}): a calculated measure gives an empty value when dividing by zero`);
          const a = conv(d.args[0]!);
          const b = a && conv(d.args[1]!);
          return a && b ? { op: '/', a, b } : null;
        }
        if (d.fn === 'CALCULATE' || d.fn === 'CALCULATETABLE') return no(`CALCULATE with filters (${d.args.slice(1).map(daxText).join(', ')}): Semaphore measures do not carry a fixed filter, so add the filter to the flags that use it`);
        const agg = aggOf(d);
        if (agg) {
          const ref = partName(parts.length + 1);
          parts.push({ ref, ...agg, dax: daxText(d) });
          return { ref };
        }
        if (reason) return null;
        return no(`${d.fn}() is not something Semaphore reads (it reads SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTROWS, DISTINCTCOUNT, DIVIDE and + - * /)`);
      }
      case 'str':
        return no('a text value is not part of a measure');
      case 'tab':
        return no(`the table ${d.name} on its own is not a measure`);
    }
  };

  const top = unwrap(tree);
  const single = aggOf(top);
  if (single) return { ok: true, agg: single };
  if (reason) return { ok: false, reason };
  const formula = conv(top);
  if (!formula) return { ok: false, reason: reason ?? 'the DAX could not be read' };
  return { ok: true, formula, parts };
}

// ---------------------------------------------------------------------------------------------
// Into a ModelRead.
// ---------------------------------------------------------------------------------------------

const DATA_TYPES: Record<string, FieldType> = { int64: 'number', double: 'number', decimal: 'number', currency: 'number', string: 'string', datetime: 'date', date: 'date', boolean: 'boolean' };

export function formatOf(formatString: string | undefined): Metric['format'] | undefined {
  if (!formatString) return undefined;
  if (/[$€£¥]|\\\$|\[\$/.test(formatString)) return 'currency';
  if (/%/.test(formatString)) return 'percent';
  return 'number';
}

/** The database table a partition reads, when its source says so plainly, and a connection hint. */
export function partitionRelation(p: PbiPartition): { relation?: string; connection?: string; note?: string } {
  if (p.kind === 'entity' && p.entity) return { relation: p.schema ? `${p.schema}.${p.entity}` : p.entity };
  const src = p.source;
  const conn = /\b([A-Za-z]+(?:\.[A-Za-z]+)?)\.Database\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/.exec(src);
  const connection = conn ? `${conn[2]}${conn[3] ? `/${conn[3]}` : ''}` : undefined;
  const hint = connection ? { connection } : {};
  if (p.kind === 'query' || p.kind === 'sql') {
    const m = /^\s*select\s+\*\s+from\s+([\w.[\]"]+)\s*;?\s*$/i.exec(src);
    if (m) return { relation: m[1]!.replace(/[[\]"]/g, ''), ...hint };
    return { ...hint, note: `its query is not a plain table (${shown(src)})` };
  }
  if (/Value\.NativeQuery|Sql\.Database\([^)]*\[\s*Query\s*=/i.test(src)) return { ...hint, note: 'it reads a native SQL query, not a table' };
  const item = /\bItem\s*=\s*"([^"]+)"/.exec(src);
  const schema = /\bSchema\s*=\s*"([^"]+)"/.exec(src);
  if (item) return { relation: schema ? `${schema[1]}.${item[1]}` : item[1]!, ...hint };
  const nav = /\{\s*\[\s*Name\s*=\s*"([^"]+)"/.exec(src);
  if (nav && connection) return { relation: nav[1]!, ...hint };
  return hint;
}

/** Power BI's own date tables (auto date/time) are not part of the analysts' model. */
const AUTO_DATE = /^(LocalDateTable_|DateTableTemplate_)/;

export function mapPowerBi(model: PbiModel): ModelRead {
  const read = emptyRead('powerbi', model.name);
  const warn = (w: string) => read.warnings.length < 500 && read.warnings.push(w);
  for (const w of model.warnings) warn(w);
  const measures = new Set(model.tables.flatMap((t) => t.measures.map((m) => m.name)));
  const columns = new Map(model.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const ctx: DaxContext = { measures, columns };
  const kept = new Set<string>();
  let autoDates = 0;
  for (const t of model.tables) {
    if (AUTO_DATE.test(t.name)) {
      autoDates++;
      continue;
    }
    const calc = t.partitions.find((p) => p.kind === 'calculated' || p.kind === 'calculationGroup');
    if (calc) {
      if (t.columns.length) warn(`${t.name}: a calculated table (${shown(calc.source || 'DAX')}) is made by Power BI, not read from the database; it was not imported.`);
      continue;
    }
    const cols: ModelTable['columns'] = [];
    for (const c of t.columns) {
      if (c.type === 'rowNumber' || c.name.startsWith('RowNumber-')) continue;
      if (c.type === 'calculated' || c.type === 'calculatedTableColumn' || (c.expression && !c.sourceColumn)) {
        warn(`${t.name}[${c.name}]: a calculated column (${shown(c.expression ?? '')}); add it in the database or as a cleaning step.`);
        continue;
      }
      const type = c.dataType ? DATA_TYPES[c.dataType.toLowerCase()] : undefined;
      const column = c.sourceColumn ?? c.name;
      cols.push({ name: c.name, column, ...(c.name !== column ? { label: c.name } : {}), ...(type ? { type } : {}), ...(c.description ? { description: c.description } : {}), ...(c.displayFolder ? { folder: c.displayFolder } : {}) });
    }
    if (!cols.length) continue;
    const where = t.partitions.length ? partitionRelation(t.partitions[0]!) : {};
    if (where.note) warn(`${t.name}: ${where.note}; check the database table name before importing.`);
    read.tables.push({ name: t.name, relation: where.relation ?? t.name, ...(where.connection ? { connection: where.connection } : {}), ...(t.description ? { description: t.description } : {}), columns: cols });
    kept.add(t.name);
  }
  if (autoDates) warn(`${autoDates} automatic date table${autoDates === 1 ? '' : 's'} (Power BI's auto date/time) left out: Semaphore groups dates by day, week, month, quarter and year itself.`);

  // Measures. Inline aggregates in a calculated measure become measures of their own, reused when an
  // identical plain measure exists.
  const plain = new Map<string, string>();
  const mapped: Array<{ m: PbiMeasure; r: DaxMapped }> = [];
  for (const t of model.tables) {
    for (const m of t.measures) {
      const r = mapDax(m.expression, ctx, (n) => `${m.name} (part ${n})`);
      mapped.push({ m, r });
      if (r.ok && 'agg' in r) plain.set(`${r.agg.agg}|${r.agg.table}|${r.agg.column ?? ''}`, m.name);
    }
  }
  const out: ModelMeasure[] = [];
  const AGG_WORD = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count of', count_distinct: 'Distinct' } as const;
  for (const { m, r } of mapped) {
    const format = formatOf(m.formatString);
    const base = { name: m.name, label: m.name, expression: m.expression.trim(), ...(format ? { format } : {}), ...(m.description ? { description: m.description } : {}) };
    if (!r.ok) {
      warn(`Not imported, ${m.name}: ${r.reason}. DAX: ${shown(m.expression)}`);
      continue;
    }
    if ('agg' in r) {
      if (!kept.has(r.agg.table)) {
        warn(`Not imported, ${m.name}: its table ${r.agg.table} is not imported. DAX: ${shown(m.expression)}`);
        continue;
      }
      out.push({ kind: 'agg', ...base, ...r.agg });
      continue;
    }
    const rename = new Map<string, string>();
    for (const p of r.parts) {
      const same = plain.get(`${p.agg}|${p.table}|${p.column ?? ''}`);
      if (same) {
        rename.set(p.ref, same);
        continue;
      }
      const label = `${AGG_WORD[p.agg]} ${p.column ?? p.table}`;
      out.push({ kind: 'agg', name: p.ref, label: `${label} (for ${m.name})`, agg: p.agg, table: p.table, ...(p.column ? { column: p.column } : {}), expression: p.dax });
      plain.set(`${p.agg}|${p.table}|${p.column ?? ''}`, p.ref);
    }
    const swap = (f: Formula): Formula => ('ref' in f ? { ref: rename.get(f.ref) ?? f.ref } : 'neg' in f ? { neg: swap(f.neg) } : 'op' in f ? { op: f.op, a: swap(f.a), b: swap(f.b) } : f);
    out.push({ kind: 'formula', ...base, formula: swap(r.formula) });
  }
  read.measures = out;

  // Relationships: many to one, turned round when Power BI has the one side first.
  for (const r of model.relationships) {
    if (!kept.has(r.fromTable) || !kept.has(r.toTable)) continue;
    const label = `${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}]`;
    if (r.isActive === false) {
      warn(`The relationship ${label} is inactive in Power BI (used only through USERELATIONSHIP); it was not added.`);
      continue;
    }
    const from = (r.fromCardinality ?? 'many').toLowerCase();
    const to = (r.toCardinality ?? 'one').toLowerCase();
    if (from === 'many' && to === 'many') {
      warn(`The relationship ${label} is many-to-many; Semaphore links tables many to one, so it was not added.`);
      continue;
    }
    const both = (r.crossFilteringBehavior ?? '').toLowerCase() === 'bothdirections';
    const note = [from === 'one' && to === 'one' ? 'Power BI has it one to one.' : '', both ? 'Power BI filters both ways here; Semaphore follows it from many to one and splits a measure on the one side by the many side with its one-to-many joins.' : ''].filter(Boolean).join(' ');
    const rel: ModelRelationship = from === 'one' && to === 'many' ? { from: { table: r.toTable, column: r.toColumn }, to: { table: r.fromTable, column: r.fromColumn } } : { from: { table: r.fromTable, column: r.fromColumn }, to: { table: r.toTable, column: r.toColumn } };
    read.relationships.push(note ? { ...rel, note } : rel);
  }

  // Hierarchies.
  const hierarchies: ModelHierarchy[] = [];
  for (const t of model.tables) {
    if (!kept.has(t.name)) continue;
    for (const h of t.hierarchies) {
      if (h.levels.length < 2) continue;
      hierarchies.push({ label: h.name, table: t.name, levels: h.levels.map((l) => l.column) });
    }
  }
  read.hierarchies = hierarchies;
  const folders = model.tables.flatMap((t) => [...t.measures, ...t.columns].map((x) => x.displayFolder).filter(Boolean));
  if (folders.length) warn(`Display folders (${[...new Set(folders)].slice(0, 4).join(', ')}${new Set(folders).size > 4 ? ', ...' : ''}) are not kept: Semaphore lists measures and fields by table.`);
  return read;
}

/** Reads the picked Power BI files: a .bim / Tabular JSON, or the .tmdl files of a project. */
export function readPowerBi(files: readonly ModelFile[]): ModelRead {
  const bim = files.filter((f) => /\.bim$/i.test(f.path) || (/\.json$/i.test(f.path) && /"model"\s*:\s*\{|"tables"\s*:\s*\[/.test(f.text.slice(0, 5000)) && !/(^|\/)(report|definition\.pbir|\.pbi)\b/i.test(f.path)));
  const tmdl = files.filter((f) => /\.tmdl$/i.test(f.path));
  let model: PbiModel;
  if (tmdl.length) {
    model = readTmdl(tmdl);
    if (bim.length) model.warnings.push('Both TMDL files and a .bim were picked; the TMDL files were read.');
  } else if (bim.length) {
    model = readBim(bim[0]!.text, bim[0]!.path);
    if (bim.length > 1) model.warnings.push(`${bim.length} .bim files were picked; only ${bim[0]!.path} was read.`);
  } else {
    const read = emptyRead('powerbi', 'Power BI model');
    read.warnings.push('No Power BI model files were picked: choose a Power BI Project .SemanticModel folder (its .tmdl files) or a model.bim.');
    return read;
  }
  const read = mapPowerBi(model);
  read.files = (tmdl.length ? tmdl : bim.slice(0, 1)).map((f) => f.path);
  return read;
}

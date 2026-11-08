// A small YAML reader for the subset dbt projects use: block maps and lists (including "- key: value"
// list items), flow lists and maps ([a, b], {a: 1}), plain, single- and double-quoted scalars,
// multi-line plain scalars, literal (|) and folded (>) blocks with their chomping indicators, comments
// and several documents separated by ---. It is not a general YAML parser: anchors, aliases, merge
// keys and tags are not resolved; each is reported as a warning (an alias reads as null) so the
// analyst knows what was not read. No new package: Semaphore ships without npm dependencies.
//
// Input is capped (YAML_LIMITS) and every loop advances by a line or a character, so a hostile file
// cannot make it run for long.

export const YAML_LIMITS = { chars: 2_000_000, depth: 64 };

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface YamlResult {
  /** One value per document (most files have one). */
  documents: YamlValue[];
  warnings: string[];
}

interface Line {
  /** Column of the first non-space character. */
  indent: number;
  /** The line without its indentation and without a trailing comment. */
  text: string;
  /** The raw line, for block scalars. */
  raw: string;
  no: number;
}

/** Text from '#' on, when the '#' starts a comment (line start or after a space, outside quotes). */
export function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:[{,\-]/.test(s[i - 1]!))) quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

class Reader {
  lines: Line[] = [];
  i = 0;
  warnings: string[] = [];
  private warned = new Set<string>();

  warn(message: string): void {
    if (this.warned.has(message) || this.warnings.length >= 50) return;
    this.warned.add(message);
    this.warnings.push(message);
  }

  /** The next line that has content, skipping blank and comment-only lines. */
  peek(): Line | undefined {
    while (this.i < this.lines.length && !this.lines[this.i]!.text) this.i++;
    return this.lines[this.i];
  }

  block(indent: number, depth: number): YamlValue {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (depth > YAML_LIMITS.depth) {
      this.warn(`Line ${line.no}: nested too deeply; the rest was not read.`);
      this.i = this.lines.length;
      return null;
    }
    if (isSeqItem(line.text)) return this.seq(line.indent, depth);
    if (keyOf(line.text) !== null) return this.map(line.indent, depth);
    // A lone scalar (a document that is just a value, or a value on its own line under a key).
    this.i++;
    return this.scalarAt(line, line.text, line.indent - 1, depth);
  }

  seq(indent: number, depth: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || !isSeqItem(line.text)) break;
      const rest = line.text.slice(1).replace(/^\s+/, '');
      if (!rest) {
        this.i++;
        out.push(this.block(indent + 1, depth + 1));
        continue;
      }
      // "- key: value" or "- - x": the rest of the line is the first line of a nested block.
      const at = indent + (line.text.length - rest.length);
      if (isSeqItem(rest) || keyOf(rest) !== null) {
        this.lines[this.i] = { ...line, indent: at, text: rest };
        out.push(this.block(at, depth + 1));
        continue;
      }
      this.i++;
      out.push(this.scalarAt(line, rest, indent, depth));
    }
    return out;
  }

  map(indent: number, depth: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || isSeqItem(line.text)) break;
      const kv = keyOf(line.text);
      if (kv === null) {
        this.warn(`Line ${line.no}: "${line.text.slice(0, 40)}" is not a key: value pair; it was skipped.`);
        this.i++;
        continue;
      }
      const [key, rest] = kv;
      this.i++;
      if (key === '<<') this.warn(`Line ${line.no}: merge keys (<<) are not read.`);
      if (Object.prototype.hasOwnProperty.call(out, key)) this.warn(`Line ${line.no}: "${key}" appears twice; the last one is used.`);
      let value: YamlValue;
      if (!rest) {
        const next = this.peek();
        if (next && next.indent > indent) value = this.block(next.indent, depth + 1);
        else if (next && next.indent === indent && isSeqItem(next.text)) value = this.seq(indent, depth + 1);
        else value = null;
      } else {
        value = this.scalarAt(line, rest, indent, depth);
      }
      if (key !== '<<') defineKey(out, key, value);
    }
    return out;
  }

  /** The value written after "key:" or "- " on `line`; may read following lines (blocks, flows, folded plain text). */
  scalarAt(line: Line, rest: string, indent: number, depth: number): YamlValue {
    let s = rest;
    const prop = /^([&!][^\s]*)\s*/.exec(s);
    if (prop) {
      this.warn(prop[1]!.startsWith('&') ? `Line ${line.no}: anchors (&) are not read; the value is used as written.` : `Line ${line.no}: tags (${prop[1]}) are not read.`);
      s = s.slice(prop[0].length);
      if (!s) {
        const next = this.peek();
        return next && next.indent > indent ? this.block(next.indent, depth + 1) : null;
      }
    }
    if (s.startsWith('*')) {
      this.warn(`Line ${line.no}: aliases (${s.split(/\s/)[0]}) are not read; the value is left empty.`);
      return null;
    }
    const blockHead = /^([|>])([+-]?)(\d?)([+-]?)$/.exec(s);
    if (blockHead) return this.blockScalar(blockHead[1] as '|' | '>', (blockHead[2] || blockHead[4]) as '' | '+' | '-', blockHead[3] ? Number(blockHead[3]) : 0, indent);
    if (s.startsWith('[') || s.startsWith('{')) {
      let text = s;
      // A flow collection may run over several lines: read on until the brackets balance.
      while (!balanced(text)) {
        const next = this.peek();
        if (!next || next.indent <= indent) break;
        text += ' ' + next.text;
        this.i++;
      }
      const flow = new Flow(text, line.no, this);
      const v = flow.value(depth);
      flow.end();
      return v;
    }
    if (s.startsWith('"') || s.startsWith("'")) {
      let text = s;
      while (!closedQuote(text)) {
        const next = this.lines[this.i];
        if (!next) break;
        text += next.raw.trim() ? ' ' + next.raw.trim() : '\n';
        this.i++;
      }
      const q = readQuoted(text, 0);
      if (!q) {
        this.warn(`Line ${line.no}: a quoted value is not closed.`);
        return text.slice(1);
      }
      if (text.slice(q.end).trim()) this.warn(`Line ${line.no}: text after a quoted value was ignored.`);
      return q.value;
    }
    // A plain scalar may continue on more-indented lines (folded with spaces).
    let text = s;
    for (;;) {
      const next = this.peek();
      if (!next || next.indent <= indent || isSeqItem(next.text) || keyOf(next.text) !== null) break;
      text += ' ' + next.text;
      this.i++;
    }
    return plain(text);
  }

  blockScalar(style: '|' | '>', chomp: '' | '+' | '-', explicit: number, parent: number): string {
    const body: string[] = [];
    let width = explicit ? parent + explicit : -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      const blank = !l.raw.trim();
      if (!blank) {
        const ind = l.raw.length - l.raw.replace(/^ +/, '').length;
        if (width < 0) width = ind;
        if (ind < width || ind <= parent) break;
        body.push(l.raw.slice(width));
      } else body.push('');
      this.i++;
    }
    // Trailing blank lines belong to the chomping, not the text.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text: string;
    if (style === '|') text = body.join('\n');
    else {
      // Folded: lines join with spaces; blank lines and more-indented lines keep their breaks.
      text = '';
      let prev: 'start' | 'line' | 'blank' | 'more' = 'start';
      for (const cur of body) {
        if (cur === '') {
          text += '\n';
          prev = 'blank';
          continue;
        }
        const more = /^\s/.test(cur);
        if (prev === 'start' || prev === 'blank') text += cur;
        else if (prev === 'line' && !more) text += ' ' + cur;
        else text += '\n' + cur;
        prev = more ? 'more' : 'line';
      }
    }
    if (!body.length) return '';
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return text + '\n';
  }
}

function defineKey(out: { [key: string]: YamlValue }, key: string, value: YamlValue): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ') || text.startsWith('-\t');
}

/** [key, rest] when `text` is "key: rest" (key plain or quoted), else null. */
function keyOf(text: string): [string, string] | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = readQuoted(text, 0);
    if (!q) return null;
    const after = text.slice(q.end);
    const m = /^\s*:(?:\s+|$)/.exec(after);
    return m ? [q.value, after.slice(m[0].length).trim()] : null;
  }
  if (/^[[{]/.test(text) || text.startsWith('? ')) return null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\t')) {
      const key = text.slice(0, i).trim();
      if (!key) return null;
      return [key, text.slice(i + 1).trim()];
    }
  }
  return null;
}

function readQuoted(s: string, at: number): { value: string; end: number } | null {
  const q = s[at];
  let out = '';
  for (let i = at + 1; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      continue;
    }
    if (c === '\\') {
      const n = s[++i];
      const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' };
      if (n === 'u' || n === 'x') {
        const len = n === 'u' ? 4 : 2;
        const hex = s.slice(i + 1, i + 1 + len);
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === len) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += len;
          continue;
        }
      }
      out += n !== undefined ? (esc[n] ?? n) : '';
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    out += c;
  }
  return null;
}

function closedQuote(s: string): boolean {
  return readQuoted(s, 0) !== null;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

/** A plain scalar: null, booleans and numbers as YAML 1.2's core schema reads them, else the text. */
function plain(text: string): YamlValue {
  const s = text.trim();
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  return s;
}

/** Flow collections: [a, b], {key: value}, nested, with quoted or plain scalars. */
class Flow {
  i = 0;
  private s: string;
  private no: number;
  private r: Reader;
  constructor(s: string, no: number, r: Reader) {
    this.s = s;
    this.no = no;
    this.r = r;
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  value(depth: number): YamlValue {
    this.ws();
    if (depth > YAML_LIMITS.depth) {
      this.r.warn(`Line ${this.no}: nested too deeply; the rest was not read.`);
      this.i = this.s.length;
      return null;
    }
    const c = this.s[this.i];
    if (c === '[') {
      this.i++;
      const out: YamlValue[] = [];
      for (;;) {
        this.ws();
        if (this.i >= this.s.length) {
          this.r.warn(`Line ${this.no}: a [list] is not closed.`);
          return out;
        }
        if (this.s[this.i] === ']') {
          this.i++;
          return out;
        }
        const v = this.value(depth + 1);
        this.ws();
        // [a: 1] is a list holding a one-pair map.
        if (this.s[this.i] === ':' && typeof v === 'string') {
          this.i++;
          const o: { [k: string]: YamlValue } = {};
          defineKey(o, v, this.value(depth + 1));
          out.push(o);
        } else out.push(v);
        this.ws();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== ']') {
          this.r.warn(`Line ${this.no}: unexpected "${this.s[this.i] ?? ''}" in a [list].`);
          this.i++;
        }
      }
    }
    if (c === '{') {
      this.i++;
      const out: { [k: string]: YamlValue } = {};
      for (;;) {
        this.ws();
        if (this.i >= this.s.length) {
          this.r.warn(`Line ${this.no}: a {map} is not closed.`);
          return out;
        }
        if (this.s[this.i] === '}') {
          this.i++;
          return out;
        }
        const k = this.value(depth + 1);
        this.ws();
        let v: YamlValue = null;
        if (this.s[this.i] === ':') {
          this.i++;
          v = this.value(depth + 1);
        }
        defineKey(out, String(k), v);
        this.ws();
        if (this.s[this.i] === ',') this.i++;
        else if (this.s[this.i] !== '}') {
          this.r.warn(`Line ${this.no}: unexpected "${this.s[this.i] ?? ''}" in a {map}.`);
          this.i++;
        }
      }
    }
    if (c === '"' || c === "'") {
      const q = readQuoted(this.s, this.i);
      if (!q) {
        this.r.warn(`Line ${this.no}: a quoted value is not closed.`);
        const rest = this.s.slice(this.i + 1);
        this.i = this.s.length;
        return rest;
      }
      this.i = q.end;
      return q.value;
    }
    if (c === '*') this.r.warn(`Line ${this.no}: aliases are not read; the value is left empty.`);
    // A plain scalar in a flow ends at , ] } or ": ".
    const start = this.i;
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (ch === ':' && (this.i + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.i + 1]!))) break;
      this.i++;
    }
    const text = this.s.slice(start, this.i).trim();
    return c === '*' ? null : plain(text);
  }

  end(): void {
    this.ws();
    if (this.i < this.s.length) this.r.warn(`Line ${this.no}: text after a flow value was ignored.`);
  }
}

/** Reads YAML text into one value per document; problems are warnings, never exceptions. */
export function parseYaml(text: string): YamlResult {
  const r = new Reader();
  let src = text.replace(/^﻿/, '');
  if (src.length > YAML_LIMITS.chars) {
    r.warn(`The file is longer than ${YAML_LIMITS.chars.toLocaleString('en-US')} characters; only the start was read.`);
    src = src.slice(0, YAML_LIMITS.chars);
  }
  const docs: Line[][] = [[]];
  const raw = src.split(/\r?\n/);
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n]!;
    if (/^---(\s|$)/.test(line)) {
      if (docs[docs.length - 1]!.some((l) => l.text)) docs.push([]);
      const rest = stripComment(line.slice(3)).trim();
      if (rest) docs[docs.length - 1]!.push({ indent: 0, text: rest, raw: rest, no: n + 1 });
      continue;
    }
    if (/^\.\.\.(\s|$)/.test(line)) continue;
    if (/^%/.test(line)) {
      r.warn(`Line ${n + 1}: directives (%) are not read.`);
      continue;
    }
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.includes('\t') && line.trim()) r.warn(`Line ${n + 1}: tabs in the indentation; YAML expects spaces.`);
    const indent = lead.replace(/\t/g, '  ').length;
    docs[docs.length - 1]!.push({ indent, text: stripComment(line.slice(lead.length)), raw: line, no: n + 1 });
  }
  const documents: YamlValue[] = [];
  for (const lines of docs) {
    if (!lines.some((l) => l.text)) continue;
    r.lines = lines;
    r.i = 0;
    const first = r.peek();
    const v = r.block(first?.indent ?? 0, 0);
    const left = r.peek();
    if (left) r.warn(`Line ${left.no}: the indentation does not fit the lines above; the rest of the document was not read.`);
    documents.push(v);
  }
  return { documents, warnings: r.warnings };
}

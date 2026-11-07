// Reads a CSV file in the browser into rows the in-memory engine can query, and profiles it so
// proposeCatalog() can draft a catalog. Nothing leaves the page. RFC 4180 quoting; the first row
// is the header. Types are inferred from the values: numbers (with $ , % allowed), dates
// (YYYY-MM-DD, with or without a time, or M/D/YYYY), true/false, else text.

import type { Cell } from './crossfilter.ts';
import type { TableProfile } from './profile.ts';
import type { FieldType } from './catalog.ts';

export interface CsvTable {
  name: string;
  columns: Array<{ name: string; type: FieldType }>;
  rows: Array<Record<string, Cell>>;
  profile: TableProfile;
  notes: string[];
}

export const CSV_LIMITS = { bytes: 200 * 1024 * 1024, rows: 2_000_000, columns: 500 } as const;

export class CsvError extends Error {}

/** Throws before anything is read when a file is over the size cap (bytes on disk). */
export function checkCsvSize(bytes: number): void {
  if (bytes > CSV_LIMITS.bytes) throw new CsvError(`The file is larger than ${CSV_LIMITS.bytes / 1024 / 1024} MB.`);
}

/** The busy line while a file is read: which one, how far through the batch, and how big when that matters. */
export function readingLabel(name: string, at: number, total: number, bytes: number): string {
  const size = bytes >= 1024 * 1024 ? `, ${Math.round(bytes / 1024 / 1024)} MB` : '';
  const place = total > 1 ? `${at} of ${total}` : '';
  const detail = `${place}${place ? size : size.slice(2)}`;
  return `Reading ${name}${detail ? ` (${detail})` : ''}…`;
}

/** Data rows read to decide each column's type. The same rows are checked for leading zeros. */
const SAMPLE_ROWS = 5000;
const QUOTE = 34;
const LF = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;

export function parseCsvRecords(text: string, maxRows: number = CSV_LIMITS.rows): string[][] {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const out: string[][] = [];
  eachRecord(text, start, sniffDelimiter(text, start), (r) => {
    out.push(r);
    return out.length <= maxRows;
  });
  return out;
}

/**
 * Calls `onRecord` for every non-blank record, in order, until it returns false. Cells are slices of
 * the text, so nothing but the current record is built. RFC 4180 quoting; spaces before an opening
 * quote are allowed (`a, "x,y"`), and text after a closing quote is kept as it was.
 */
function eachRecord(text: string, start: number, delim: string, onRecord: (r: string[]) => boolean | void): void {
  const D = delim.charCodeAt(0);
  const n = text.length;
  let i = start;
  let row: string[] = [];
  for (;;) {
    // One field, starting at i; i ends on its delimiter, its line break or the end of the text.
    let j = i;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === SPACE || (c === TAB && D !== TAB)) j++;
      else break;
    }
    if (j < n && text.charCodeAt(j) === QUOTE) {
      let cell = '';
      let k = j + 1;
      for (;;) {
        const q = text.indexOf('"', k);
        if (q === -1) {
          cell += text.slice(k);
          k = n;
          break;
        }
        cell += text.slice(k, q);
        if (text.charCodeAt(q + 1) === QUOTE) {
          cell += '"';
          k = q + 2;
        } else {
          k = q + 1;
          break;
        }
      }
      let e = k;
      while (e < n) {
        const c = text.charCodeAt(e);
        if (c === D || c === LF || c === CR) break;
        e++;
      }
      row.push(e > k ? cell + text.slice(k, e) : cell);
      i = e;
    } else {
      let e = i;
      while (e < n) {
        const c = text.charCodeAt(e);
        if (c === D || c === LF || c === CR) break;
        e++;
      }
      row.push(text.slice(i, e));
      i = e;
    }
    if (i >= n) {
      if (row.length > 1 || row[0] !== '') onRecord(row);
      return;
    }
    const c = text.charCodeAt(i);
    if (c === D) {
      i++;
      continue;
    }
    if (row.length > 1 || row[0] !== '') {
      if (onRecord(row) === false) return;
    }
    row = [];
    i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
    if (i >= n) return;
  }
}

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * The delimiter, from the first few lines: delimiters inside quotes do not count, and one that
 * appears the same number of times on every line wins over one that appears more often on the first.
 */
function sniffDelimiter(text: string, start = 0): string {
  const head = text.slice(start, start + 65536);
  const lines: number[][] = [];
  let counts = DELIMITERS.map(() => 0);
  let quoted = false;
  let blank = true;
  for (let i = 0; i < head.length && lines.length < 5; i++) {
    const ch = head[i]!;
    if (ch === '"') {
      quoted = !quoted;
      blank = false;
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (!blank) lines.push(counts);
      counts = DELIMITERS.map(() => 0);
      blank = true;
    } else if (!quoted) {
      const d = DELIMITERS.indexOf(ch);
      if (d >= 0) counts[d]!++;
      if (ch !== ' ') blank = false;
    }
  }
  // The last line counts only when the text ends there (it was not cut off by the window).
  if (!blank && lines.length < 5 && start + head.length >= text.length) lines.push(counts);
  if (!lines.length && !blank) lines.push(counts); // one very long first line
  if (!lines.length) return ',';
  const first = lines[0]!;
  let best = -1;
  for (let d = 0; d < DELIMITERS.length; d++) {
    if (first[d]! > 0 && lines.every((l) => l[d] === first[d]) && (best < 0 || first[d]! > first[best]!)) best = d;
  }
  if (best < 0) {
    for (let d = 0; d < DELIMITERS.length; d++) if (first[d]! > 0 && (best < 0 || first[d]! > first[best]!)) best = d;
  }
  return best < 0 ? ',' : DELIMITERS[best]!;
}

const NUMBER = /^[-+]?\$?\s?[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function realDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCMonth() === m - 1;
}

/** A whole number of 16 or more digits: beyond what a double holds exactly, so kept as text. */
function longInteger(v: string): boolean {
  if (v.length < 16 || v.includes('.')) return false;
  let digits = 0;
  let leading = true;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 48 || c > 57) continue;
    if (leading && c === 48) continue;
    leading = false;
    digits++;
  }
  return digits >= 16;
}

export function readCsv(fileName: string, text: string): CsvTable {
  checkCsvSize(text.length);
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const delim = sniffDelimiter(text, start);

  // First pass: the header and the sample rows the types are decided from.
  let first: string[] | null = null;
  let sample: string[][] = [];
  eachRecord(text, start, delim, (r) => {
    if (!first) first = r;
    else sample.push(r);
    return sample.length < SAMPLE_ROWS;
  });
  const headerRow = first as string[] | null;
  if (!headerRow || sample.length === 0) throw new CsvError('The file needs a header row and at least one data row.');
  const notes: string[] = [];
  let header = headerRow.map((h, i) => cleanName(h) || `Column ${i + 1}`);
  if (header.length > CSV_LIMITS.columns) {
    notes.push(`Only the first ${CSV_LIMITS.columns} of ${header.length} columns were read.`);
    header = header.slice(0, CSV_LIMITS.columns);
  }
  // Duplicate names get a number, so every column has its own key.
  const seen = new Map<string, number>();
  header = header.map((h) => {
    const k = h.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c > 1 ? `${h} ${c}` : h;
  });
  const types: FieldType[] = header.map((_, c) => inferType(sample, c));
  sample = [];

  // Second pass: each record becomes a row as it is read; no array of records is kept.
  const rows: Array<Record<string, Cell>> = [];
  const failed = header.map(() => 0);
  const width = header.length;
  const shared = types.map((t) => (t === 'string' || t === 'date' ? new Map<string, string>() : null));
  let atHeader = true;
  let over = false;
  eachRecord(text, start, delim, (r) => {
    if (atHeader) {
      atHeader = false;
      return true;
    }
    if (rows.length >= CSV_LIMITS.rows) {
      over = true;
      return false;
    }
    const o: Record<string, Cell> = {};
    for (let c = 0; c < width; c++) {
      let v = convert(r[c] ?? '', types[c]!);
      if (typeof v === 'string') v = own(v, shared[c]!);
      if (v === undefined) {
        failed[c]!++;
        o[header[c]!] = null;
      } else o[header[c]!] = v;
    }
    rows.push(o);
    return true;
  });
  if (over) notes.push(`Only the first ${CSV_LIMITS.rows.toLocaleString('en-US')} rows were read.`);
  header.forEach((h, c) => {
    const n = failed[c]!;
    if (n) notes.push(`${h}: ${failedNote(n, types[c]!)} See Data > Clean.`);
  });

  const profile: TableProfile = {
    name: tableName(fileName),
    rows: rows.length,
    columns: header.map((h, c) => {
      const distinct = new Set<string>();
      const samples: string[] = [];
      for (const r of rows) {
        const v = r[h];
        if (v === null || v === undefined) continue;
        const s = String(v);
        if (!distinct.has(s) && samples.length < 5) samples.push(s);
        distinct.add(s);
        if (distinct.size > 100_000) break;
      }
      return { name: h, type: types[c]!, distinct: distinct.size, samples };
    }),
  };
  return { name: profile.name, columns: header.map((h, c) => ({ name: h, type: types[c]! })), rows, profile, notes };
}

/**
 * Text cells: a repeated value is stored once (most text columns repeat a few values), and a long
 * cell is copied rather than kept as a slice of the file's text, which would keep the whole text
 * alive as long as the rows.
 */
function own(v: string, seen: Map<string, string>): string {
  const hit = seen.get(v);
  if (hit !== undefined) return hit;
  // Short slices are already copies (V8 copies substrings under 13 characters).
  const copy = v.length < 13 ? v : (' ' + v).slice(1);
  if (seen.size < 50_000) seen.set(copy, copy);
  return copy;
}

function failedNote(n: number, type: FieldType): string {
  const one = n === 1;
  const count = n.toLocaleString('en-US');
  const what = type === 'number' ? (one ? 'a number' : 'numbers') : type === 'date' ? (one ? 'a date' : 'dates') : 'yes or no';
  return one ? `1 value was not ${what} and is shown blank.` : `${count} values were not ${what} and are shown blank.`;
}

function isDate(v: string): boolean {
  const us = US_DATE.exec(v);
  if (us) return realDate(Number(us[3]), Number(us[1]), Number(us[2]));
  const iso = ISO_DATE.exec(v);
  return !!iso && realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
}

function inferType(rows: string[][], c: number): FieldType {
  let seen = 0;
  let num = 0;
  let date = 0;
  let bool = 0;
  // Leading zeros mean a code ("00123"), and 16+ digit whole numbers are ids: both stay text.
  let code = false;
  for (const r of rows) {
    const v = (r[c] ?? '').trim();
    if (v === '') continue;
    seen++;
    if (NUMBER.test(v) && /\d/.test(v)) {
      num++;
      if (/^[-+]?0\d/.test(v) || longInteger(v)) code = true;
    } else if (isDate(v)) date++;
    else if (/^(true|false|yes|no)$/i.test(v)) bool++;
  }
  if (seen === 0) return 'string';
  if (num === seen && !code) return 'number';
  if (date === seen) return 'date';
  if (bool === seen) return 'boolean';
  return 'string';
}

/** The cell as its column's type; undefined when it is not one (counted, and shown blank). */
function convert(raw: string, type: FieldType): Cell | undefined {
  const v = raw.trim();
  if (v === '') return null;
  switch (type) {
    case 'number': {
      if (longInteger(v)) return undefined;
      const pct = v.endsWith('%');
      const n = Number(v.replace(/[$,%\s]/g, ''));
      return Number.isFinite(n) ? (pct ? n / 100 : n) : undefined;
    }
    case 'date': {
      const us = US_DATE.exec(v);
      if (us) return realDate(Number(us[3]), Number(us[1]), Number(us[2])) ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : undefined;
      const iso = ISO_DATE.exec(v);
      if (!iso || !realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return undefined;
      return v.length > 10 && /[T ]00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(v) ? v.slice(0, 10) : v.replace(' ', 'T');
    }
    case 'boolean':
      if (/^(true|yes)$/i.test(v)) return true;
      if (/^(false|no)$/i.test(v)) return false;
      return undefined;
    case 'string':
      return v;
  }
}

/** Column names must pass isIdentifier(): letters, digits, underscore and space. */
function cleanName(h: string): string {
  let s = h.trim().replace(/[^A-Za-z0-9_ ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (/^[0-9]/.test(s)) s = `c ${s}`;
  return s;
}

export function tableName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return cleanName(base).replace(/ /g, '_') || 'data';
}

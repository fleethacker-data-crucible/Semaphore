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

export function parseCsvRecords(text: string, maxRows: number = CSV_LIMITS.rows): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = sniffDelimiter(text);
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i++;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') out.push(row);
      if (out.length > maxRows) break;
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i++;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') out.push(row);
  }
  return out;
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, 4096).split(/\r?\n/)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => ({ d, n: head.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ',';
}

const NUMBER = /^[-+]?\$?\s?[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function readCsv(fileName: string, text: string): CsvTable {
  if (text.length > CSV_LIMITS.bytes) throw new CsvError(`The file is larger than ${CSV_LIMITS.bytes / 1024 / 1024} MB.`);
  const records = parseCsvRecords(text);
  if (records.length < 2) throw new CsvError('The file needs a header row and at least one data row.');
  const notes: string[] = [];
  let header = records[0]!.map((h, i) => cleanName(h) || `Column ${i + 1}`);
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
  const body = records.slice(1, CSV_LIMITS.rows + 1);
  if (records.length - 1 > CSV_LIMITS.rows) notes.push(`Only the first ${CSV_LIMITS.rows.toLocaleString('en-US')} rows were read.`);

  const types: FieldType[] = header.map((_, c) => inferType(body, c));
  const rows: Array<Record<string, Cell>> = body.map((r) => {
    const o: Record<string, Cell> = {};
    header.forEach((h, c) => (o[h] = convert(r[c] ?? '', types[c]!)));
    return o;
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

function inferType(rows: string[][], c: number): FieldType {
  let seen = 0;
  let num = 0;
  let date = 0;
  let bool = 0;
  for (const r of rows) {
    const v = (r[c] ?? '').trim();
    if (v === '') continue;
    seen++;
    if (NUMBER.test(v) && /\d/.test(v)) num++;
    else if (ISO_DATE.test(v) || US_DATE.test(v)) date++;
    else if (/^(true|false|yes|no)$/i.test(v)) bool++;
    if (seen >= 5000) break;
  }
  if (seen === 0) return 'string';
  // Leading zeros mean a code ("00123"), not a number.
  if (num === seen && !rows.slice(0, 2000).some((r) => /^0\d/.test((r[c] ?? '').trim()))) return 'number';
  if (date === seen) return 'date';
  if (bool === seen) return 'boolean';
  return 'string';
}

function convert(raw: string, type: FieldType): Cell {
  const v = raw.trim();
  if (v === '') return null;
  switch (type) {
    case 'number': {
      const pct = v.endsWith('%');
      const n = Number(v.replace(/[$,%\s]/g, ''));
      return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
    }
    case 'date': {
      const us = US_DATE.exec(v);
      if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
      return v.length > 10 && /[T ]00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(v) ? v.slice(0, 10) : v.replace(' ', 'T');
    }
    case 'boolean':
      return /^(true|yes)$/i.test(v);
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

// Reads the JSON exports of sibling Fleet apps as data sources. A recognised export is flattened to
// CSV text and then goes through the same reader, type inference and catalog proposal as any CSV file,
// so nothing new reaches the engine and nothing leaves the page.
//
//   packetrat.usage-counts/1   PacketRat `stats export`: { schema, since, exportedAt, counts: { action: n } }
//   Eight Bells eLog export    { watch, entries: [ { timestamp, equipment, category, text, status } ] }
//   any other JSON             a top-level array of objects, or one array of objects under
//                              records / items / rows / entries / data
//
// Only flat records are read: a nested object is flattened one level (a_b), an array is joined with "; ".

import { CSV_LIMITS, CsvError } from './csv.ts';

export interface FleetExportCsv {
  /** Name to give the table: the CSV reader turns it into the table name. */
  fileName: string;
  csv: string;
  /** Which app's export this is. */
  origin: string;
  /** One line for the analyst. */
  note: string;
}

const LISTS = ['records', 'items', 'rows', 'entries', 'data'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function columnName(raw: string): string {
  let n = raw.replace(/[^A-Za-z0-9_ ]+/g, '_').replace(/^_+|_+$/g, '').trim();
  if (!n || !/^[A-Za-z_]/.test(n)) n = `col_${n}`;
  return n.slice(0, 127);
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.filter((x) => x === null || typeof x !== 'object').map(cellText).join('; ');
  return '';
}

function flatten(record: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(record)) {
    if (isObject(v)) {
      for (const [k2, v2] of Object.entries(v)) if (!isObject(v2)) out.set(`${k}_${k2}`, cellText(v2));
    } else out.set(k, cellText(v));
  }
  return out;
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(records: Array<Record<string, unknown>>): string {
  if (records.length > CSV_LIMITS.rows) throw new CsvError(`This export has more than ${CSV_LIMITS.rows.toLocaleString('en-US')} rows.`);
  const flat = records.map(flatten);
  const raw: string[] = [];
  const seen = new Set<string>();
  for (const f of flat) for (const k of f.keys()) if (!seen.has(k)) { seen.add(k); raw.push(k); }
  if (raw.length === 0) throw new CsvError('This export has no columns.');
  if (raw.length > CSV_LIMITS.columns) throw new CsvError(`This export has more than ${CSV_LIMITS.columns} columns.`);
  const names: string[] = [];
  const used = new Set<string>();
  for (const r of raw) {
    const base = columnName(r);
    let n = base;
    let i = 2;
    while (used.has(n.toLowerCase())) n = `${base}_${i++}`;
    used.add(n.toLowerCase());
    names.push(n);
  }
  const lines = [names.map(csvCell).join(',')];
  for (const f of flat) lines.push(raw.map((k) => csvCell(f.get(k) ?? '')).join(','));
  return lines.join('\n') + '\n';
}

function objectsOf(list: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(list) && list.length > 0 && list.every(isObject) ? (list as Array<Record<string, unknown>>) : null;
}

/** null when the file is not a JSON export; a CsvError when it is one and cannot be read. */
export function fleetExportToCsv(fileName: string, text: string): FleetExportCsv | null {
  if (!/\.json$/i.test(fileName)) return null;
  if (text.length > CSV_LIMITS.bytes) throw new CsvError('That file is too large.');
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new CsvError('That file is not valid JSON.');
  }
  const base = fileName.replace(/\.json$/i, '');

  if (isObject(data) && data['schema'] === 'packetrat.usage-counts/1') {
    const counts = data['counts'];
    if (!isObject(counts)) throw new CsvError('This PacketRat export has no counts.');
    const rows = Object.entries(counts)
      .filter(([, n]) => typeof n === 'number' && Number.isFinite(n))
      .map(([action, count]) => ({ action, count, since: data['since'] ?? null, exported_at: data['exportedAt'] ?? null, estimate: data['estimate'] === true }));
    if (rows.length === 0) throw new CsvError('This PacketRat export has no counts yet.');
    return {
      fileName: 'packetrat_usage_counts.csv',
      csv: toCsv(rows),
      origin: 'PacketRat',
      note: `${fileName}: PacketRat usage counts (actions performed; the minutes saved are an estimate, not a measurement).`,
    };
  }

  let records: Array<Record<string, unknown>> | null = null;
  let origin = 'JSON';
  let table = base;
  if (Array.isArray(data)) records = objectsOf(data);
  else if (isObject(data)) {
    const found = LISTS.filter((k) => objectsOf(data[k]));
    if (found.length === 1) {
      records = objectsOf(data[found[0]!]);
      if (found[0] === 'entries' && 'watch' in data) {
        origin = 'Eight Bells';
        table = 'eight_bells_entries';
      }
    }
  }
  if (!records) throw new CsvError('Semaphore reads JSON that is a list of records, or an object holding one list of records (records, items, rows, entries or data).');
  return {
    fileName: `${table}.csv`,
    csv: toCsv(records),
    origin,
    note: `${fileName}: ${records.length.toLocaleString('en-US')} ${origin === 'JSON' ? 'records' : `${origin} records`} read as a table.`,
  };
}

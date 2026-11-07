// CSV as RFC 4180 describes it. Spreadsheets run a cell that looks like a formula, so text that
// starts like one is written with a leading apostrophe; real numbers are written raw.

import { fileStem } from './model.ts';
import type { ExportDocument, ExportFlag, ExportTable } from './model.ts';
import { cellNumber, cellText, filtersWords, flagTable, noAnswer, NOTHING_TO_SHOW, takenAtWords, validDate } from './shared.ts';
import { zip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

const CRLF = '\r\n';
const BOM = '\uFEFF';

/** Text a spreadsheet would run as a formula gets a leading apostrophe. */
export function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function field(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One table as CSV text. Pass `bom: true` for a file Excel should read as UTF-8. */
export function toCsv(table: ExportTable, options: { bom?: boolean } = {}): string {
  const lines = [table.columns.map((c) => field(guardFormula(c.label))).join(',')];
  for (const row of table.rows) {
    lines.push(
      table.columns
        .map((column, i) => {
          const n = cellNumber(column, row[i]);
          return n !== null ? String(n) : field(guardFormula(cellText(row[i])));
        })
        .join(','),
    );
  }
  return (options.bom ? BOM : '') + lines.join(CRLF) + CRLF;
}

function headlinesTable(flag: ExportFlag): ExportTable {
  return {
    columns: [
      { label: 'Measure', numeric: false },
      { label: 'Value', numeric: true },
      { label: 'Shown as', numeric: false },
      { label: 'Change', numeric: false },
    ],
    rows: (flag.headlines ?? []).map((h) => [
      { text: h.label, value: h.label },
      { text: h.value === null ? '' : h.text, value: h.value },
      { text: h.text, value: h.text },
      { text: h.change ?? '', value: h.change ?? null },
    ]),
  };
}

/** A ZIP with one CSV per flag that has numbers, and a README saying what each file is. */
export async function flagsToCsvZip(doc: ExportDocument): Promise<Uint8Array> {
  const entries: ZipEntry[] = [];
  const contents: string[] = [];
  doc.flags.forEach((flag, index) => {
    const table = flagTable(flag) ?? (flag.headlines?.length ? headlinesTable(flag) : null);
    if (table) {
      // The number in front keeps names unique, and in page order, whatever the titles are.
      const name = `${String(index + 1).padStart(2, '0')}-${fileStem(flag.title, 'flag')}.csv`;
      entries.push({ name, data: toCsv(table, { bom: true }) });
      contents.push(`${name}: ${flag.title}${flag.error ? `. ${noAnswer(flag)}` : ''}`);
    } else {
      const why = flag.error ? noAnswer(flag) : flag.text ? 'It is a note with no table.' : flag.image ? 'It has a picture and no table.' : NOTHING_TO_SHOW;
      contents.push(`No file for "${flag.title}". ${why}`);
    }
  });
  const readme = [
    doc.title,
    ...(doc.brief ? [doc.brief] : []),
    `Taken at: ${takenAtWords(doc.takenAt)}`,
    `By: ${doc.by}`,
    `Filters: ${filtersWords(doc)}`,
    '',
    ...(contents.length > 0 ? contents : ['This export has no flags.']),
    '',
    'Text that starts with = + - or @ has a leading apostrophe so a spreadsheet will not run it as a formula.',
    '',
  ].join(CRLF);
  entries.unshift({ name: 'README.txt', data: BOM + readme });
  return zip(entries, { date: validDate(doc.takenAt) ?? undefined });
}

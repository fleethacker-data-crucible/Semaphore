// Small things more than one writer needs: text cleaning, colours, the words used for missing
// answers, and the parts that are the same in every Office package.

import type { ExportCell, ExportChart, ExportColumn, ExportDocument, ExportFlag, ExportImage, ExportTable, ExportTone } from './model.ts';

/** Drops what XML 1.0 forbids: control characters, lone surrogates, U+FFFE and U+FFFF. */
export function cleanText(text: string): string {
  return String(text ?? '').replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '');
}

/** Text ready to sit in XML content or a double-quoted attribute. */
export function xml(text: string): string {
  return cleanText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Shortens text to at most `max` UTF-16 units, ending in an ellipsis, without splitting a character. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** 'RRGGBB' in upper case from #rgb, #rrggbb or #rrggbbaa; the fallback for anything else. */
export function hexColor(color: string | undefined, fallback = '1F4E79'): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(color ?? '').trim());
  if (!m) return fallback;
  const h = m[1]!;
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6);
  return full.toUpperCase();
}

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `amount` 0 keeps the colour, 1 gives the target. */
export function mix(hex: string, target: string, amount: number): string {
  const a = rgb(hex);
  const b = rgb(target);
  return a
    .map((v, i) => Math.round(v + (b[i]! - v) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** The text colour that reads on this fill. */
export function inkOn(fill: string): string {
  return luminance(fill) > 0.4 ? '1A1A1A' : 'FFFFFF';
}

/** The accent, darkened when it is too pale to read as text on white. */
export function accentInk(accent: string): string {
  let hex = accent;
  for (let i = 0; i < 6 && luminance(hex) > 0.25; i += 1) hex = mix(hex, '000000', 0.2);
  return hex;
}

export const TONE_FILL: Record<ExportTone, string> = { good: 'DFF3E4', warn: 'FDF0CF', bad: 'FBDDDD' };
export const BAD_INK = 'A61B1B';
export const MUTED_INK = '5F6B76';

export const NO_FLAGS = 'This report has no flags.';
export const NOTHING_TO_SHOW = 'Nothing to show for this flag.';
export const BAD_IMAGE = 'The chart picture could not be read, so it is left out.';

export function noAnswer(flag: ExportFlag): string {
  return `No answer: ${flag.error}`;
}

const count = new Intl.NumberFormat('en-US');

export function moreRows(n: number): string {
  return `and ${count.format(n)} more ${n === 1 ? 'row' : 'rows'}. The full table is in the Excel and CSV exports.`;
}

export function moreColumns(n: number): string {
  return `and ${count.format(n)} more ${n === 1 ? 'column' : 'columns'}. The full table is in the Excel and CSV exports.`;
}

/** "7 Nov 2026, 14:05 UTC", or the text as given when it is not a time. */
export function takenAtWords(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export function validDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function filtersWords(doc: ExportDocument): string {
  return doc.filters.length > 0 ? doc.filters.join('; ') : 'None';
}

/**
 * The number to write for a cell, or null when it should be written as text. A number counts when
 * its column is numeric, or when the page shows it plainly ("-5", "1,200"); a number behind a label
 * such as "Jan 2026" in a text column stays that label.
 */
export function cellNumber(column: ExportColumn | undefined, cell: ExportCell | undefined): number | null {
  if (!cell || typeof cell.value !== 'number' || !Number.isFinite(cell.value)) return null;
  if (column?.numeric) return cell.value;
  return Number(cell.text.replace(/,/g, '')) === cell.value ? cell.value : null;
}

export function cellText(cell: ExportCell | undefined): string {
  return cell ? String(cell.text ?? '') : '';
}

export function hasTable(table: ExportTable | null): table is ExportTable {
  return !!table && table.columns.length > 0;
}

/** The chart cut to its categories and padded to match, or null if there is nothing to plot. */
export function usableChart(chart: ExportChart | null): ExportChart | null {
  if (!chart || chart.categories.length === 0 || chart.series.length === 0) return null;
  const series = (chart.type === 'pie' ? chart.series.slice(0, 1) : chart.series).map((s) => ({
    ...s,
    values: chart.categories.map((_, i) => {
      const v = s.values[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }),
  }));
  return { ...chart, series };
}

/** A chart's numbers as a table, for a flag that has no table of its own. */
export function chartTable(chart: ExportChart): ExportTable {
  return {
    columns: [{ label: 'Category', numeric: false }, ...chart.series.map((s) => ({ label: s.name, numeric: true }))],
    rows: chart.categories.map((category, i) => [
      { text: category, value: category },
      ...chart.series.map((s) => {
        const value = s.values[i] ?? null;
        return { text: value === null ? '' : count.format(value), value };
      }),
    ]),
  };
}

/** The table to show for a flag: its own, or else its chart's numbers. */
export function flagTable(flag: ExportFlag): ExportTable | null {
  if (hasTable(flag.table)) return flag.table;
  const chart = usableChart(flag.chart);
  return chart ? chartTable(chart) : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Pixel size from the PNG header, or null when these bytes are not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || PNG_SIGNATURE.some((b, i) => png[i] !== b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The flag's picture, if its bytes really are a PNG, with its size taken from the file. */
export function readableImage(image: ExportImage | null): ExportImage | null {
  if (!image) return null;
  const size = pngSize(image.png);
  return size ? { ...image, ...size } : null;
}

/** Scales a box to fit inside another, keeping its shape. */
export function fitBox(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function relationships(items: Array<{ id: string; type: string; target: string }>): string {
  const rows = items.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : `${REL}/${r.type}`}" Target="${xml(r.target)}"/>`);
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.join('')}</Relationships>`;
}

/** The package-level relationships every Office file has. */
export function packageRels(mainPart: string): string {
  return relationships([
    { id: 'rId1', type: 'officeDocument', target: mainPart },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
  ]);
}

export function contentTypes(overrides: Array<{ part: string; type: string }>, png: boolean): string {
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...(png ? ['<Default Extension="png" ContentType="image/png"/>'] : []),
  ];
  const all = [
    ...overrides,
    { part: '/docProps/core.xml', type: 'application/vnd.openxmlformats-package.core-properties+xml' },
    { part: '/docProps/app.xml', type: 'application/vnd.openxmlformats-officedocument.extended-properties+xml' },
  ];
  const rows = all.map((o) => `<Override PartName="${xml(o.part)}" ContentType="${o.type}"/>`);
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${rows.join('')}</Types>`;
}

export function coreProps(doc: ExportDocument): string {
  const when = validDate(doc.takenAt);
  const stamp = when ? when.toISOString().replace(/\.\d+Z$/, 'Z') : null;
  return (
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(doc.title)}</dc:title><dc:creator>${xml(doc.by)}</dc:creator>` +
    (stamp
      ? `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`
      : '') +
    '</cp:coreProperties>'
  );
}

export function appProps(): string {
  return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Semaphore</Application></Properties>`;
}

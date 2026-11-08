// A PDF 1.7 report, written by hand. Text is real, selectable text in the standard Helvetica fonts
// with WinAnsiEncoding, measured with the published Helvetica widths. Those fonts have no glyphs
// outside Western European text; such characters are replaced here, and kept in full in the file's
// metadata and bookmarks, which are UTF-16.

import type { ExportDocument, ExportFlag, ExportHeadline, ExportTable, ExportTone } from './model.ts';
import {
  accentInk,
  BAD_IMAGE,
  BAD_INK,
  cellText,
  cleanText,
  filtersWords,
  fitBox,
  flagTable,
  hexColor,
  inkOn,
  moreColumns,
  moreRows,
  MUTED_INK,
  NO_FLAGS,
  noAnswer,
  NOTHING_TO_SHOW,
  rgb,
  takenWords,
  TONE_FILL,
  validDate,
} from './shared.ts';
import { crc32, deflateZlib, inflateZlib, joinBytes, zlibSupported } from './zip.ts';

/** Deflates a stream's bytes when the runtime can; otherwise they go in plain, with no filter. */
async function flate(data: Uint8Array, options: { store?: boolean } = {}): Promise<{ bytes: Uint8Array; filter: string }> {
  if (options.store || !zlibSupported) return { bytes: data, filter: '' };
  return { bytes: await deflateZlib(data), filter: ' /Filter /FlateDecode' };
}

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN + 14;
const MAX_IMAGE_HEIGHT = 300;
const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLUMNS = 12;
const MIN_COLUMN_WIDTH = 40;
const MAX_NATURAL_COLUMN = 240;
const MAX_CELL_LINES = 3;
const TEXT_SIZE = 10.5;

type Font = 'F1' | 'F2' | 'F3';

// Widths per 1000 units of type size, from the Adobe Helvetica and Helvetica-Bold metrics, in
// WinAnsi order: 32-126, then 128-159, then 160-255. The oblique shares the regular widths.
const REGULAR_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const REGULAR_HIGH = [
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];
const BOLD_HIGH = [
  556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

/** The characters at WinAnsi 128-159, where it differs from Latin-1. */
const WIN_ANSI_HIGH = '€\u0000‚ƒ„…†‡ˆ‰Š‹Œ\u0000Ž\u0000\u0000‘’“”•–—˜™š›œ\u0000žŸ';

const UNICODE_TO_WIN_ANSI = (() => {
  const map = new Map<number, number>();
  for (let code = 32; code <= 126; code += 1) map.set(code, code);
  for (let code = 160; code <= 255; code += 1) map.set(code, code);
  [...WIN_ANSI_HIGH].forEach((ch, i) => {
    if (ch !== '\u0000') map.set(ch.codePointAt(0)!, 128 + i);
  });
  return map;
})();

/** Close stand-ins for common characters the fonts lack. */
const STAND_INS: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '‒': '-', '―': '—', '−': '-',
  '‛': '’', '‟': '”', '′': "'", '″': '"', '⁄': '/',
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '←': '<-', '→': '->',
  '↑': '^', '↓': 'v', '∙': '·', '•': '•', '✓': 'Yes', '✗': 'No',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h',
};

/** A plain replacement for each character the fonts lack; what is left over becomes "?". */
export function toWinAnsiText(text: string, onLost?: () => void): string {
  let out = '';
  for (const ch of cleanText(text)) {
    const code = ch.codePointAt(0)!;
    if (UNICODE_TO_WIN_ANSI.has(code)) {
      out += code === 0xad ? '' : ch;
    } else if (ch === '\t' || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x3000) {
      out += ' ';
    } else if (ch === '\n' || ch === '\r') {
      out += ch;
    } else if ((code >= 0x200b && code <= 0x200f) || code === 0xfeff || (code >= 0xfe00 && code <= 0xfe0f)) {
      // Zero-width marks: nothing to show.
    } else if (STAND_INS[ch] !== undefined) {
      out += STAND_INS[ch];
    } else {
      // "ā" to "a", "ﬁ" to "fi": letters that decompose into ones the fonts have.
      const plain = ch.normalize('NFKD').replace(/\p{M}/gu, '');
      if (plain && [...plain].every((c) => UNICODE_TO_WIN_ANSI.has(c.codePointAt(0)!))) {
        out += plain;
      } else {
        out += '?';
        onLost?.();
      }
    }
  }
  return out;
}

function charWidth(ch: string, font: Font): number {
  const code = UNICODE_TO_WIN_ANSI.get(ch.codePointAt(0)!) ?? 63;
  const bold = font === 'F2';
  if (code < 127) return (bold ? BOLD_ASCII : REGULAR_ASCII)[code - 32] ?? 556;
  return (bold ? BOLD_HIGH : REGULAR_HIGH)[code - 128] ?? 556;
}

/** Width in points of text that has been through toWinAnsiText. */
export function textWidth(text: string, font: Font, size: number): number {
  let sum = 0;
  for (const ch of text) sum += charWidth(ch, font);
  return (sum * size) / 1000;
}

function clipToWidth(text: string, font: Font, size: number, width: number): string {
  if (textWidth(text, font, size) <= width) return text;
  const room = width - textWidth('…', font, size);
  let out = '';
  let used = 0;
  for (const ch of text) {
    used += (charWidth(ch, font) * size) / 1000;
    if (used > room) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Word-wraps text, breaking a word only when it is wider than the line. */
export function wrapText(text: string, font: Font, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const joined = line ? `${line} ${word}` : word;
      if (textWidth(joined, font, size) <= width) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      let rest = word;
      while (textWidth(rest, font, size) > width) {
        let cut = '';
        for (const ch of rest) {
          if (textWidth(cut + ch, font, size) > width) break;
          cut += ch;
        }
        if (!cut) cut = [...rest][0]!;
        lines.push(cut);
        rest = rest.slice(cut.length);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function limitLines(lines: string[], max: number, font: Font, size: number, width: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = clipToWidth(`${kept[max - 1]!}…`, font, size, width);
  return kept;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

function colorOp(hex: string, op: 'rg' | 'RG'): string {
  const [r, g, b] = rgb(hex);
  return `${num(r / 255)} ${num(g / 255)} ${num(b / 255)} ${op}`;
}

/** Text as a PDF literal string for a content stream, bytes in WinAnsi. Every byte comes out ASCII. */
function literal(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = UNICODE_TO_WIN_ANSI.get(ch.codePointAt(0)!) ?? 63;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

/** Text for the file's own dictionaries: plain when it can be, otherwise UTF-16 with a byte order mark. */
function infoString(text: string): string {
  const clean = cleanText(text);
  if (/^[\x20-\x7e]*$/.test(clean)) return `(${clean.replace(/([()\\])/g, '\\$1')})`;
  let hex = 'FEFF';
  for (let i = 0; i < clean.length; i += 1) hex += clean.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

interface DecodedImage {
  width: number;
  height: number;
  /** `width * height * 3` bytes of RGB, deflated in a zlib wrapper when `filter` says so. */
  rgb: Uint8Array;
  /** One byte of alpha a pixel, stored the same way. Null when every pixel is opaque. */
  alpha: Uint8Array | null;
  /** ' /Filter /FlateDecode', or '' when the bytes are plain. */
  filter: string;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undoes PNG's per-row filters. Returns `height * rowBytes` bytes. */
function unfilter(data: Uint8Array, height: number, rowBytes: number, pixelBytes: number): Uint8Array {
  if (data.length < height * (rowBytes + 1)) throw new Error('The PNG has less image data than its size says.');
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (rowBytes + 1)]!;
    const from = y * (rowBytes + 1) + 1;
    const at = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= pixelBytes ? out[at + x - pixelBytes]! : 0;
      const up = y > 0 ? out[at + x - rowBytes]! : 0;
      const corner = x >= pixelBytes && y > 0 ? out[at + x - rowBytes - pixelBytes]! : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) add = paeth(left, up, corner);
      else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`);
      out[at + x] = (data[from + x]! + add) & 255;
    }
  }
  return out;
}

/** Reads an 8-bit RGB or RGBA PNG and prepares it for embedding. Throws on anything else. */
export async function decodePng(png: Uint8Array, options: { store?: boolean } = {}): Promise<DecodedImage> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || view.getUint32(0) !== 0x89504e47) throw new Error('Not a PNG.');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error('Only 8-bit RGB or RGBA PNGs without interlacing can be embedded.');
  }
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const pixels = unfilter(await inflateZlib(joinBytes(idat)), height, width * channels, channels);
  if (channels === 3) {
    const rgb = await flate(pixels, options);
    return { width, height, rgb: rgb.bytes, alpha: null, filter: rgb.filter };
  }

  const count = width * height;
  const colour = new Uint8Array(count * 3);
  const alpha = new Uint8Array(count);
  let opaque = true;
  for (let i = 0; i < count; i += 1) {
    colour[i * 3] = pixels[i * 4]!;
    colour[i * 3 + 1] = pixels[i * 4 + 1]!;
    colour[i * 3 + 2] = pixels[i * 4 + 2]!;
    const a = pixels[i * 4 + 3]!;
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }
  const rgb = await flate(colour, options);
  return { width, height, rgb: rgb.bytes, alpha: opaque ? null : (await flate(alpha, options)).bytes, filter: rgb.filter };
}

interface Page {
  ops: string[];
}

interface Bookmark {
  title: string;
  page: number;
  y: number;
}

export async function toPdf(doc: ExportDocument, options: { store?: boolean } = {}): Promise<Uint8Array> {
  const accent = hexColor(doc.accent);
  const ink = accentInk(accent);
  const pages: Page[] = [{ ops: [] }];
  const bookmarks: Bookmark[] = [];
  let y = TOP;
  let lostCharacters = false;

  const safe = (text: string) =>
    toWinAnsiText(text, () => {
      lostCharacters = true;
    });
  const ops = () => pages[pages.length - 1]!.ops;
  const newPage = () => {
    pages.push({ ops: [] });
    y = TOP;
  };
  const ensure = (height: number) => {
    if (y - height < BOTTOM) newPage();
  };

  function drawText(text: string, x: number, baseline: number, font: Font, size: number, color = '1A1A1A') {
    if (!text) return;
    ops().push(`BT ${colorOp(color, 'rg')} /${font} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${literal(text)} Tj ET`);
  }

  function fillRect(x: number, top: number, width: number, height: number, color: string) {
    ops().push(`${colorOp(color, 'rg')} ${num(x)} ${num(top - height)} ${num(width)} ${num(height)} re f`);
  }

  function rule(x: number, at: number, width: number, color: string, thickness = 0.75) {
    ops().push(`${colorOp(color, 'RG')} ${num(thickness)} w ${num(x)} ${num(at)} m ${num(x + width)} ${num(at)} l S`);
  }

  /** Flowing text, moving to a new page between lines when it has to. */
  function paragraph(text: string, options: { font?: Font; size?: number; color?: string; indent?: number; bullet?: boolean; maxLines?: number; after?: number } = {}) {
    const font = options.font ?? 'F1';
    const size = options.size ?? TEXT_SIZE;
    const indent = options.indent ?? 0;
    const leading = size * 1.3;
    const width = CONTENT_WIDTH - indent;
    let lines = wrapText(safe(text), font, size, width);
    if (options.maxLines) lines = limitLines(lines, options.maxLines, font, size, width);
    lines.forEach((line, i) => {
      ensure(leading);
      y -= leading;
      if (options.bullet && i === 0) drawText('•', MARGIN + indent - 10, y + leading * 0.22, font, size, options.color);
      drawText(line, MARGIN + indent, y + leading * 0.22, font, size, options.color);
    });
    y -= options.after ?? 4;
  }

  function fact(label: string, value: string) {
    const width = CONTENT_WIDTH - 80;
    const leading = TEXT_SIZE * 1.35;
    const lines = limitLines(wrapText(safe(value), 'F1', TEXT_SIZE, width), 12, 'F1', TEXT_SIZE, width);
    lines.forEach((line, i) => {
      ensure(leading);
      y -= leading;
      if (i === 0) drawText(label, MARGIN, y + 3, 'F2', TEXT_SIZE, MUTED_INK);
      drawText(line, MARGIN + 80, y + 3, 'F1', TEXT_SIZE);
    });
  }

  function cover() {
    const size = 26;
    const leading = size * 1.2;
    const title = doc.title.trim() || 'Report';
    const lines = limitLines(wrapText(safe(title), 'F2', size, CONTENT_WIDTH), 5, 'F2', size, CONTENT_WIDTH);
    for (const line of lines) {
      y -= leading;
      drawText(line, MARGIN, y + 6, 'F2', size, ink);
    }
    y -= 6;
    rule(MARGIN, y, CONTENT_WIDTH, accent, 1.5);
    y -= 8;
    if (doc.brief) paragraph(doc.brief, { size: 12, maxLines: 10, after: 10 });
    fact('Taken at', takenWords(doc));
    fact('By', doc.by);
    fact('Filters', filtersWords(doc));
    y -= 14;
    if (doc.flags.length === 0) paragraph(NO_FLAGS, { color: MUTED_INK });
  }

  function headlines(items: ExportHeadline[]) {
    const perRow = Math.min(4, items.length);
    const gap = 8;
    const width = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow;
    const height = 58;
    const pad = 8;
    for (let start = 0; start < items.length; start += perRow) {
      ensure(height + gap);
      items.slice(start, start + perRow).forEach((h, i) => {
        const x = MARGIN + i * (width + gap);
        fillRect(x, y, width, height, h.tone ? TONE_FILL[h.tone] : 'F2F4F6');
        const inner = width - pad * 2;
        drawText(clipToWidth(safe(h.label), 'F1', 9, inner), x + pad, y - 15, 'F1', 9, MUTED_INK);
        const value = safe(h.text);
        const size = Math.max(10, Math.min(20, (20 * inner) / Math.max(1, textWidth(value, 'F2', 20))));
        drawText(clipToWidth(value, 'F2', size, inner), x + pad, y - 36, 'F2', size);
        if (h.change) drawText(clipToWidth(safe(h.change), 'F1', 8.5, inner), x + pad, y - 50, 'F1', 8.5, MUTED_INK);
      });
      y -= height + gap;
    }
    y -= 4;
  }

  function table(source: ExportTable) {
    const size = 8.5;
    const leading = size * 1.25;
    const pad = 4;
    const columns = source.columns.slice(0, MAX_TABLE_COLUMNS);
    const rows = source.rows.slice(0, MAX_TABLE_ROWS);
    const labels = columns.map((c) => safe(c.label));
    const cells = rows.map((row) => columns.map((_, c) => safe(cellText(row[c]))));

    const natural = columns.map((_, c) => {
      const widest = Math.max(textWidth(labels[c]!, 'F2', size), ...cells.map((row) => textWidth(row[c]!, 'F1', size)));
      return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_NATURAL_COLUMN, widest + pad * 2 + 1));
    });
    const total = natural.reduce((a, b) => a + b, 0);
    const floor = MIN_COLUMN_WIDTH * columns.length;
    const widths =
      total > CONTENT_WIDTH
        ? natural.map((w) => MIN_COLUMN_WIDTH + ((w - MIN_COLUMN_WIDTH) * (CONTENT_WIDTH - floor)) / (total - floor))
        : natural.map((w) => w + (CONTENT_WIDTH - total) / columns.length);
    const lefts = widths.map((_, c) => MARGIN + widths.slice(0, c).reduce((a, b) => a + b, 0));

    const fit = (text: string, c: number, font: Font, max: number) => {
      const inner = widths[c]! - pad * 2;
      return limitLines(wrapText(text, font, size, inner), max, font, size, inner);
    };
    const headerLines = labels.map((label, c) => fit(label, c, 'F2', 2));
    const headerHeight = Math.max(...headerLines.map((l) => l.length)) * leading + pad * 2;
    const headerInk = inkOn(accent);

    function cellLines(lines: string[], c: number, top: number, font: Font, color: string) {
      lines.forEach((line, i) => {
        const baseline = top - pad - (i + 1) * leading + 2.5;
        const x = columns[c]!.numeric ? lefts[c]! + widths[c]! - pad - textWidth(line, font, size) : lefts[c]! + pad;
        drawText(line, x, baseline, font, size, color);
      });
    }

    function header() {
      fillRect(MARGIN, y, CONTENT_WIDTH, headerHeight, accent);
      headerLines.forEach((lines, c) => cellLines(lines, c, y, 'F2', headerInk));
      y -= headerHeight;
    }

    ensure(headerHeight + leading * 2 + pad * 2);
    header();
    rows.forEach((row, r) => {
      const lines = cells[r]!.map((text, c) => fit(text, c, 'F1', MAX_CELL_LINES));
      const height = Math.max(1, ...lines.map((l) => l.length)) * leading + pad * 2;
      if (y - height < BOTTOM) {
        newPage();
        header();
      }
      columns.forEach((_, c) => {
        const tone: ExportTone | undefined = row[c]?.tone;
        if (tone) fillRect(lefts[c]!, y, widths[c]!, height, TONE_FILL[tone]);
      });
      lines.forEach((l, c) => cellLines(l, c, y, 'F1', '1A1A1A'));
      y -= height;
      rule(MARGIN, y, CONTENT_WIDTH, 'E3E6EA', 0.5);
    });
    y -= 6;
    if (source.rows.length > rows.length) paragraph(moreRows(source.rows.length - rows.length), { font: 'F3', size: 9, color: MUTED_INK });
    if (source.columns.length > columns.length) paragraph(moreColumns(source.columns.length - columns.length), { font: 'F3', size: 9, color: MUTED_INK });
    if (source.rows.length === 0) paragraph('The table has no rows.', { font: 'F3', size: 9, color: MUTED_INK });
  }

  // Images are read first: a bad one must not stop the report, it becomes a line in it.
  const imageNames = new Map<ExportFlag, string>();
  const imageFailed = new Set<ExportFlag>();
  const images: Array<{ name: string; decoded: DecodedImage }> = [];
  for (const flag of doc.flags) {
    if (!flag.image) continue;
    try {
      const decoded = await decodePng(flag.image.png, options);
      const name = `Im${images.length + 1}`;
      images.push({ name, decoded });
      imageNames.set(flag, name);
    } catch {
      imageFailed.add(flag);
    }
  }

  function picture(flag: ExportFlag) {
    const name = imageNames.get(flag)!;
    const { decoded } = images.find((i) => i.name === name)!;
    const size = fitBox(decoded.width, decoded.height, CONTENT_WIDTH, MAX_IMAGE_HEIGHT);
    ensure(size.height + 8);
    y -= size.height;
    const x = MARGIN + (CONTENT_WIDTH - size.width) / 2;
    ops().push(`q ${num(size.width)} 0 0 ${num(size.height)} ${num(x)} ${num(y)} cm /${name} Do Q`);
    y -= 8;
  }

  function flagBlock(flag: ExportFlag) {
    const titleSize = 15;
    const title = flag.title.trim() || 'Untitled flag';
    const lines = limitLines(wrapText(safe(title), 'F2', titleSize, CONTENT_WIDTH), 3, 'F2', titleSize, CONTENT_WIDTH);
    const titleHeight = lines.length * titleSize * 1.25 + 8;
    // Keep the title with what follows it: the picture when there is one, otherwise a few lines.
    const decoded = imageNames.has(flag) ? images.find((i) => i.name === imageNames.get(flag))!.decoded : null;
    const follow = decoded ? fitBox(decoded.width, decoded.height, CONTENT_WIDTH, MAX_IMAGE_HEIGHT).height + 10 : 70;
    const cards = flag.headlines?.length ? Math.ceil(flag.headlines.length / 4) * 66 : 0;
    ensure(titleHeight + cards + follow);
    bookmarks.push({ title, page: pages.length - 1, y: Math.min(TOP, y + 4) });
    for (const line of lines) {
      y -= titleSize * 1.25;
      drawText(line, MARGIN, y + 4, 'F2', titleSize, ink);
    }
    y -= 2;
    rule(MARGIN, y, CONTENT_WIDTH, 'D9DDE2');
    y -= 8;

    const before = `${pages.length}:${y}`;
    if (flag.headlines?.length) headlines(flag.headlines);
    if (imageNames.has(flag)) picture(flag);
    if (imageFailed.has(flag)) paragraph(BAD_IMAGE, { color: BAD_INK });
    const data = flagTable(flag);
    if (data) table(data);
    if (flag.insights.length > 0) {
      y -= 2;
      paragraph('Findings', { font: 'F2', size: 10.5, after: 1 });
      for (const insight of flag.insights) paragraph(insight, { indent: 14, bullet: true, after: 2 });
      y -= 2;
    }
    if (flag.text) paragraph(flag.text);
    if (flag.error) paragraph(noAnswer(flag), { font: 'F2', color: BAD_INK });
    if (`${pages.length}:${y}` === before) paragraph(NOTHING_TO_SHOW, { font: 'F3', color: MUTED_INK });
    y -= 14;
  }

  cover();
  doc.flags.forEach(flagBlock);
  if (lostCharacters) {
    paragraph('Some characters are not in this PDF’s fonts and show as "?". The Word, Excel and PowerPoint exports keep them.', { font: 'F3', size: 9, color: MUTED_INK });
  }

  // Footer, now that the page count is known.
  const footerTitle = clipToWidth(safe(doc.title), 'F1', 8, CONTENT_WIDTH * 0.7);
  pages.forEach((page, i) => {
    const label = `Page ${i + 1} of ${pages.length}`;
    const baseline = MARGIN - 8;
    page.ops.push(`${colorOp('D9DDE2', 'RG')} 0.5 w ${MARGIN} ${baseline + 12} m ${PAGE_WIDTH - MARGIN} ${baseline + 12} l S`);
    page.ops.push(`BT ${colorOp(MUTED_INK, 'rg')} /F1 8 Tf ${MARGIN} ${baseline} Td ${literal(footerTitle)} Tj ET`);
    page.ops.push(`BT ${colorOp(MUTED_INK, 'rg')} /F1 8 Tf ${num(PAGE_WIDTH - MARGIN - textWidth(label, 'F1', 8))} ${baseline} Td ${literal(label)} Tj ET`);
  });

  return assemble(doc, pages, bookmarks, images, options);
}

async function assemble(doc: ExportDocument, pages: Page[], bookmarks: Bookmark[], images: Array<{ name: string; decoded: DecodedImage }>, options: { store?: boolean }): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const bodies: Array<Uint8Array | undefined> = [];
  const reserve = () => {
    bodies.push(undefined);
    return bodies.length;
  };
  const put = (id: number, dict: string, stream?: Uint8Array) => {
    bodies[id - 1] = stream
      ? joinBytes([encoder.encode(`${dict.slice(0, -2)} /Length ${stream.length} >>\nstream\n`), stream, encoder.encode('\nendstream')])
      : encoder.encode(dict);
  };

  const catalog = reserve();
  const pageTree = reserve();
  const info = reserve();
  const fonts: Array<[Font, string]> = [['F1', 'Helvetica'], ['F2', 'Helvetica-Bold'], ['F3', 'Helvetica-Oblique']];
  const fontRefs = fonts.map(([key, base]) => {
    const id = reserve();
    put(id, `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
    return `/${key} ${id} 0 R`;
  });

  const imageRefs: string[] = [];
  for (const { name, decoded } of images) {
    const size = `/Width ${decoded.width} /Height ${decoded.height} /BitsPerComponent 8`;
    let mask = '';
    if (decoded.alpha) {
      const maskId = reserve();
      put(maskId, `<< /Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceGray${decoded.filter} >>`, decoded.alpha);
      mask = ` /SMask ${maskId} 0 R`;
    }
    const id = reserve();
    put(id, `<< /Type /XObject /Subtype /Image ${size} /ColorSpace /DeviceRGB${decoded.filter}${mask} >>`, decoded.rgb);
    imageRefs.push(`/${name} ${id} 0 R`);
  }

  const resources = `<< /Font << ${fontRefs.join(' ')} >>${imageRefs.length > 0 ? ` /XObject << ${imageRefs.join(' ')} >>` : ''} >>`;
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = reserve();
    const contentId = reserve();
    pageIds.push(pageId);
    const content = await flate(encoder.encode(page.ops.join('\n')), options);
    put(contentId, `<<${content.filter} >>`, content.bytes);
    put(pageId, `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resources} /Contents ${contentId} 0 R >>`);
  }
  put(pageTree, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  let outlines = '';
  if (bookmarks.length > 0) {
    const root = reserve();
    const ids = bookmarks.map(() => reserve());
    bookmarks.forEach((b, i) => {
      const links = `${i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : ''}${i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : ''}`;
      put(ids[i]!, `<< /Title ${infoString(b.title)} /Parent ${root} 0 R${links} /Dest [${pageIds[b.page]} 0 R /XYZ 0 ${num(b.y)} null] >>`);
    });
    put(root, `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids[ids.length - 1]} 0 R /Count ${ids.length} >>`);
    outlines = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  put(catalog, `<< /Type /Catalog /Pages ${pageTree} 0 R${outlines} /ViewerPreferences << /DisplayDocTitle true >> >>`);

  const when = validDate(doc.takenAt);
  const stamp = when ? when.toISOString().replace(/[-:T]/g, '').slice(0, 14) : null;
  put(info, `<< /Title ${infoString(doc.title)} /Author ${infoString(doc.by)} /Creator (Semaphore) /Producer (Semaphore)${stamp ? ` /CreationDate (D:${stamp}Z)` : ''} >>`);

  const chunks: Uint8Array[] = [new Uint8Array([...encoder.encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(offset);
    const chunk = joinBytes([encoder.encode(`${i + 1} 0 obj\n`), body!, encoder.encode('\nendobj\n')]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const entries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  const hash = crc32(joinBytes(chunks)).toString(16).padStart(8, '0').repeat(4);
  chunks.push(
    encoder.encode(
      `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${entries}trailer\n<< /Size ${bodies.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${hash}> <${hash}>] >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return joinBytes(chunks);
}

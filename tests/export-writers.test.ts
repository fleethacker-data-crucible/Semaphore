import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagsToCsvZip, guardFormula, toCsv } from '../src/core/export/csv.ts';
import { toDocx } from '../src/core/export/docx.ts';
import { EXPORT_SCHEMA_VERSION, toJson } from '../src/core/export/json.ts';
import type { ExportDocument, ExportFlag, ExportTable } from '../src/core/export/model.ts';
import { decodePng, textWidth, toPdf, toWinAnsiText, wrapText } from '../src/core/export/pdf.ts';
import { toPptx } from '../src/core/export/pptx.ts';
import { cleanText, xml } from '../src/core/export/shared.ts';
import { columnName, sheetName, toXlsx, uniqueSheetNames } from '../src/core/export/xlsx.ts';
import { crc32, deflateZlib, inflateZlib, joinBytes, zip } from '../src/core/export/zip.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/** Reads a ZIP from its central directory, inflating each entry with DecompressionStream. */
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50, 'central header');
    assert.equal(view.getUint16(at + 8, true) & 0x0800, 0x0800, 'UTF-8 flag');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, 'local header');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(start, start + packedSize);
    let data = packed;
    if (method === 8) {
      const stream = new Blob([packed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    assert.equal(data.length, size, `${name} size`);
    assert.equal(crc32(data), crc, `${name} CRC`);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

/** A strict little XML reader: throws on anything not well-formed. Returns the element names seen. */
function assertWellFormed(text: string, part: string): Set<string> {
  const names = new Set<string>();
  const stack: string[] = [];
  let i = 0;
  let root = false;
  if (text.startsWith('<?xml')) i = text.indexOf('?>') + 2;
  const fail = (why: string) => assert.fail(`${part}: ${why} at ${i}: ${text.slice(i, i + 60)}`);
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (stack.length === 0 && chunk.trim()) fail('text outside the root');
    checkEntities(chunk, fail);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFE\uFFFF]/.test(chunk)) fail('illegal character');
    if (lt < 0) break;
    i = lt;
    const close = text.indexOf('>', i);
    if (close < 0) fail('unclosed tag');
    const tag = text.slice(i + 1, close);
    if (tag.startsWith('/')) {
      if (stack.pop() !== tag.slice(1).trim()) fail(`mismatched </${tag.slice(1)}>`);
    } else {
      const m = /^([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)$/.exec(tag);
      if (!m) {
        fail('bad tag');
        break;
      }
      if (stack.length === 0 && root) fail('second root');
      root = true;
      names.add(m[1]!);
      checkEntities(m[2]!, fail);
      const attrs = [...m[2]!.matchAll(/([\w:.-]+)=/g)].map((a) => a[1]!);
      if (new Set(attrs).size !== attrs.length) fail('repeated attribute');
      if (m[3] !== '/') stack.push(m[1]!);
    }
    i = close + 1;
  }
  assert.equal(stack.length, 0, `${part}: unclosed ${stack.join(' ')}`);
  assert.ok(root, `${part}: no root element`);
  return names;
}

function checkEntities(text: string, fail: (why: string) => void): void {
  for (const m of text.matchAll(/&([^;\s]*;?)/g)) {
    if (!/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(m[1]!)) fail(`bad entity &${m[1]}`);
  }
}

/** Every XML part parses, every relationship points at a part, every override has a part. */
function assertPackage(parts: Map<string, Uint8Array>): void {
  const text = (name: string) => decoder.decode(parts.get(name)!);
  assert.ok(parts.has('[Content_Types].xml'));
  for (const name of parts.keys()) {
    if (/\.(xml|rels)$/.test(name)) assertWellFormed(text(name), name);
  }
  for (const m of text('[Content_Types].xml').matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(parts.has(m[1]!), `content type names missing part ${m[1]}`);
  }
  for (const name of parts.keys()) {
    if (!name.endsWith('.rels')) continue;
    const folder = name.replace(/_rels\/[^/]*$/, '');
    const ids = new Set<string>();
    for (const m of text(name).matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      assert.ok(!ids.has(m[1]!), `${name} repeats ${m[1]}`);
      ids.add(m[1]!);
      const segments: string[] = [];
      for (const s of `${folder}${m[2]}`.split('/')) {
        if (s === '..') segments.pop();
        else segments.push(s);
      }
      assert.ok(parts.has(segments.join('/')), `${name} points at missing ${segments.join('/')}`);
    }
  }
}

async function chunk(type: string, data: Uint8Array): Promise<Uint8Array> {
  const body = joinBytes([encoder.encode(type), data]);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** A real PNG whose rows use each of the five filters in turn. `pixel` gives the channel bytes. */
async function makePng(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number) => number[]): Promise<Uint8Array> {
  const rowBytes = width * channels;
  const raw = new Uint8Array(height * (rowBytes + 1));
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < width; x += 1) row.set(pixel(x, y).slice(0, channels), x * channels);
    rows.push(row);
    const filter = y % 5;
    raw[y * (rowBytes + 1)] = filter;
    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = y > 0 ? rows[y - 1]![i]! : 0;
      const corner = i >= channels && y > 0 ? rows[y - 1]![i - channels]! : 0;
      const p = left + up - corner;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter]!;
      raw[y * (rowBytes + 1) + 1 + i] = (row[i]! - predicted) & 255;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return joinBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    await chunk('IHDR', header),
    await chunk('IDAT', await deflateZlib(raw)),
    await chunk('IEND', new Uint8Array()),
  ]);
}

const gradient = (x: number, y: number) => [(x * 7) & 255, (y * 11) & 255, (x + y) & 255, x % 3 === 0 ? 128 : 255];

function baseFlag(over: Partial<ExportFlag>): ExportFlag {
  return { id: 'f', title: 'A flag', kind: 'bar', table: null, image: null, chart: null, insights: [], ...over };
}

function salesTable(rows = 3): ExportTable {
  return {
    columns: [
      { label: 'Region', numeric: false },
      { label: 'Sales', numeric: true, format: 'currency' },
      { label: 'Share', numeric: true, format: 'percent' },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      { text: `Region ${i + 1}`, value: `Region ${i + 1}` },
      { text: `$${i + 1}.2K`, value: (i + 1) * 1200.5, ...(i === 0 ? { tone: 'bad' as const } : {}) },
      { text: `${10 + i}%`, value: (10 + i) / 100 },
    ]),
  };
}

const NASTY = 'Tom & Jerry\'s "<b>sales</b>" – € 5… 売上 Продажи مبيعات 😀';

async function nastyDoc(): Promise<ExportDocument> {
  const png = await makePng(48, 30, 4, gradient);
  const image = { png, width: 48, height: 30 };
  const big = salesTable(5000);
  big.rows[7]![0] = { text: NASTY, value: NASTY };
  big.rows[8]![0] = { text: '=HYPERLINK("http://evil","x")', value: '=HYPERLINK("http://evil","x")' };
  return {
    title: `${NASTY} `.repeat(30),
    brief: `A brief with ${NASTY} and a bad \u0001 control character.\nSecond line.`,
    takenAt: 'not a date',
    by: NASTY,
    filters: [NASTY, 'Region is East'],
    accent: 'not a colour',
    flags: [
      baseFlag({ id: 'a', title: NASTY, table: big, image, insights: [NASTY, 'x'.repeat(3000)] }),
      baseFlag({ id: 'b', title: 'Sales / by [region]: * ? \\', table: salesTable(), chart: { type: 'bar', categories: ['Region 1', 'Region 2', 'Region 3'], series: [{ name: 'Sales', values: [1200.5, 2401, 3601.5], color: '#2266aa' }] } }),
      baseFlag({ id: 'c', title: 'SALES / BY [REGION]: * ? \\', chart: { type: 'pie', categories: ['A & B', '<C>'], series: [{ name: 'S"1"', values: [1, null], color: 'red' }] } }),
      baseFlag({ id: 'd', title: 'Line', table: salesTable(2), chart: { type: 'line', stacked: true, categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'A', values: [1, 2], color: '#123' }, { name: 'B', values: [3, 4, 5], color: '#abc' }] } }),
      baseFlag({ id: 'e', title: 'Area', chart: { type: 'area', categories: ['Q1'], series: [{ name: 'A', values: [1], color: '#123456' }] } }),
      baseFlag({ id: 'f', title: 'Bars', chart: { type: 'bar', horizontal: true, stacked: true, categories: ['Q1', 'Q2'], series: [{ name: 'A', values: [1, 2], color: '#123456' }, { name: 'B', values: [1, 2], color: '#654321' }] } }),
      baseFlag({ id: 'g', title: 'Picture only', image }),
      baseFlag({ id: 'h', title: 'Bad picture', image: { png: new Uint8Array([1, 2, 3]), width: 1, height: 1 } }),
      baseFlag({ id: 'i', title: 'KPIs', kind: 'kpi', headlines: Array.from({ length: 9 }, (_, i) => ({ label: `${NASTY} ${i}`, text: '$1.2M', value: i % 2 ? null : 1200000, tone: 'warn' as const, change: NASTY })) }),
      baseFlag({ id: 'j', title: 'Note', kind: 'note', text: `${NASTY}\n\n${'A long note. '.repeat(400)}` }),
      baseFlag({ id: 'k', title: 'Broke', error: `It failed: ${NASTY}` }),
      baseFlag({ id: 'l', title: '' }),
      baseFlag({ id: 'm', title: 'No rows', table: { columns: [{ label: 'A', numeric: false }], rows: [] } }),
      baseFlag({ id: 'n', title: 'Wide', table: { columns: Array.from({ length: 30 }, (_, i) => ({ label: `Column ${i}`, numeric: i > 0 })), rows: [Array.from({ length: 30 }, (_, i) => ({ text: String(i), value: i }))] } }),
    ],
  };
}

const EMPTY: ExportDocument = { title: '', brief: '', takenAt: '', by: '', filters: [], accent: '', flags: [] };

const SIMPLE: ExportDocument = {
  title: 'Weekly report',
  brief: 'How sales are going.',
  takenAt: '2026-11-07T14:05:00.000Z',
  by: 'Anthony',
  filters: ['Region is East'],
  accent: '#0B6E4F',
  flags: [
    baseFlag({ title: 'Sales (by region)', table: salesTable(), insights: ['East is ahead.'] }),
    baseFlag({ title: 'Broken flag', error: 'The source file is missing.' }),
  ],
};

interface PdfFile {
  text: string;
  bytes: Uint8Array;
  objects: Map<number, number>;
  pages: string[];
}

function pdfStringToText(body: string): string {
  return body
    .replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\([()\\])/g, '$1');
}

/** Checks the cross-reference table byte by byte, then inflates each page's content stream. */
async function readPdf(bytes: Uint8Array): Promise<PdfFile> {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.7\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)?.[1]);
  assert.equal(text.slice(start, start + 4), 'xref', 'startxref points at the table');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(start))!;
  const size = Number(head[1]);
  const objects = new Map<number, number>();
  const entries = start + head[0].length;
  assert.equal(text.slice(entries, entries + 20), '0000000000 65535 f \n');
  for (let id = 1; id < size; id += 1) {
    const row = text.slice(entries + id * 20, entries + id * 20 + 20);
    assert.match(row, /^\d{10} 00000 n \n$/);
    const offset = Number(row.slice(0, 10));
    assert.ok(text.startsWith(`${id} 0 obj\n`, offset), `object ${id} is at its xref offset`);
    objects.set(id, offset);
  }
  assert.match(text.slice(entries + size * 20), new RegExp(`^trailer\\n<< /Size ${size} `));

  const pages: string[] = [];
  for (const m of text.matchAll(/\/Type \/Page \/Parent \d+ 0 R .*?\/Contents (\d+) 0 R/g)) {
    const offset = objects.get(Number(m[1]))!;
    const dict = /<<.*?\/Length (\d+) >>\nstream\n/.exec(text.slice(offset))!;
    const from = offset + dict.index + dict[0].length;
    const length = Number(dict[1]);
    assert.equal(text.slice(from + length, from + length + 10), '\nendstream', 'stream length');
    pages.push(latin1(await inflateZlib(bytes.subarray(from, from + length))));
  }
  return { text, bytes, objects, pages };
}

function pageStrings(page: string): string[] {
  return [...page.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => pdfStringToText(m[1]!));
}

test('zip: files round trip through DecompressionStream, with UTF-8 names and a known CRC', async () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  const noise = crypto.getRandomValues(new Uint8Array(4096));
  const bytes = await zip([
    { name: 'a.txt', data: 'hello '.repeat(5000) },
    { name: 'folder/売上 é.txt', data: 'non-Latin' },
    { name: 'empty.txt', data: '' },
    { name: 'noise.bin', data: noise },
  ]);
  const files = await unzip(bytes);
  assert.equal(decoder.decode(files.get('a.txt')!), 'hello '.repeat(5000));
  assert.equal(decoder.decode(files.get('folder/売上 é.txt')!), 'non-Latin');
  assert.equal(files.get('empty.txt')!.length, 0);
  assert.deepEqual(files.get('noise.bin'), noise);
  assert.ok(bytes.length < 5000 + 4096, 'repeated text is deflated');
});

test('zip: a large entry does not stall, and unsafe or repeated names are refused', async () => {
  const big = new Uint8Array(8 * 1024 * 1024).fill(7);
  const files = await unzip(await zip([{ name: 'big.bin', data: big }]));
  assert.equal(files.get('big.bin')!.length, big.length);
  await assert.rejects(zip([{ name: 'a', data: '' }, { name: 'a', data: '' }]), /Two ZIP entries/);
  await assert.rejects(zip([{ name: '../a', data: '' }]), /safe/);
  assert.equal((await unzip(await zip([]))).size, 0);
});

test('csv: RFC 4180 quoting, CRLF, and an optional BOM', () => {
  const table: ExportTable = {
    columns: [{ label: 'Name, full', numeric: false }, { label: 'N', numeric: true }],
    rows: [
      [{ text: 'say "hi"', value: 'say "hi"' }, { text: '$1.2M', value: 1234567.5 }],
      [{ text: 'two\nlines', value: 'two\nlines' }, { text: '(blank)', value: null }],
    ],
  };
  assert.equal(toCsv(table), '"Name, full",N\r\n"say ""hi""",1234567.5\r\n"two\nlines",(blank)\r\n');
  assert.ok(toCsv(table, { bom: true }).startsWith('\uFEFF"Name'));
});

test('csv: text that starts like a formula is guarded and real numbers are not', () => {
  for (const bad of ['=1+1', '+1', '-1 thing', '@SUM(A1)', '\tx', '\rx']) assert.equal(guardFormula(bad), `'${bad}`);
  assert.equal(guardFormula('plain'), 'plain');
  const table: ExportTable = {
    columns: [{ label: '=header', numeric: false }, { label: 'Value', numeric: true }],
    rows: [
      [{ text: '=cmd|calc', value: '=cmd|calc' }, { text: '-$5', value: -5 }],
      [{ text: '-5', value: -5 }, { text: '+5%', value: 0.05 }],
      [{ text: '-abc', value: '-abc' }, { text: '-', value: '-' }],
    ],
  };
  assert.deepEqual(toCsv(table).trimEnd().split('\r\n'), ["'=header,Value", "'=cmd|calc,-5", '-5,0.05', "'-abc,'-"]);
});

test('csv zip: one file per flag with numbers, unique names, and a README with the errors', async () => {
  const files = await unzip(await flagsToCsvZip(await nastyDoc()));
  const names = [...files.keys()];
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('02-sales-by-region.csv'));
  assert.ok(names.includes('01-tom-jerry-s-b-sales-b-5-flag.csv') || names.some((n) => n.startsWith('01-')));
  const readme = decoder.decode(files.get('README.txt')!);
  assert.match(readme, /It failed:/);
  assert.match(readme, /No file for "Note"/);
  const first = decoder.decode(files.get(names.find((n) => n.startsWith('01-'))!)!, { stream: false });
  assert.equal(first.trimEnd().split('\r\n').length, 5001);
  assert.ok(first.includes(`'=HYPERLINK(""http://evil"",""x"")`) || first.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
  await flagsToCsvZip(EMPTY);
});

test('json: keeps the document, a schema version, and no image bytes', async () => {
  const doc = await nastyDoc();
  const parsed = JSON.parse(toJson(doc));
  assert.equal(parsed.schemaVersion, EXPORT_SCHEMA_VERSION);
  assert.equal(parsed.title, doc.title);
  assert.equal(parsed.flags[0].table.rows.length, 5000);
  assert.deepEqual(parsed.flags[0].image, { width: 48, height: 30 });
  assert.equal(parsed.flags[10].error, doc.flags[10]!.error);
  assert.equal(JSON.parse(toJson(EMPTY)).flags.length, 0);
});

test('sheet names follow Excel rules and stay unique when titles collide', () => {
  assert.equal(sheetName('Sales / by [region]: *?\\', 'x'), 'Sales by region');
  assert.equal(sheetName("'quoted'", 'x'), 'quoted');
  assert.equal(sheetName('   ', 'Fallback'), 'Fallback');
  assert.equal(sheetName('[]:*?/\\', 'Fallback'), 'Fallback');
  assert.equal(sheetName('History', 'Fallback'), 'Fallback');
  assert.equal(sheetName('a'.repeat(40), 'x').length, 31);
  const long = 'A very long flag title that goes past the limit';
  const names = uniqueSheetNames(['Summary', 'summary', 'SALES', 'sales', 'Sales', long, long, '', ''], ['Summary']);
  assert.deepEqual(names.slice(0, 5), ['Summary (2)', 'summary (3)', 'SALES', 'sales (2)', 'Sales (3)']);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
  for (const n of names) {
    assert.ok(n.length >= 1 && n.length <= 31, n);
    assert.doesNotMatch(n, /[[\]:*?/\\]/);
  }
  assert.equal(sheetName('😀'.repeat(20), 'x').length, 30, 'a pair is never split');
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(701), 'ZZ');
  assert.equal(columnName(702), 'AAA');
});

test('xml: escapes markup and strips what XML 1.0 forbids', () => {
  assert.equal(xml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  assert.equal(cleanText('a\u0000b\u0008c\u000bd\uFFFEe\uFFFF\ud800f\tg\nh'), 'abcdef\tg\nh');
  assert.equal(cleanText('😀 ok'), '😀 ok');
});

test('xlsx: a well-formed package with sheets, charts, a picture and typed cells', async () => {
  const parts = await unzip(await toXlsx(await nastyDoc()));
  assertPackage(parts);
  const text = (name: string) => decoder.decode(parts.get(name)!);
  const workbook = text('xl/workbook.xml');
  const sheetNames = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);
  assert.equal(sheetNames[0], 'Summary');
  assert.equal(new Set(sheetNames.map((n) => n.toLowerCase())).size, sheetNames.length);
  assert.ok(sheetNames.includes('Sales by region'));
  assert.ok(sheetNames.includes('SALES BY REGION (2)'));

  const charts = [...parts.keys()].filter((n) => n.startsWith('xl/charts/'));
  assert.equal(charts.length, 5);
  const bar = text(charts.find((n) => text(n).includes('barDir val="col"'))!);
  assert.match(bar, /<c:f>&apos;Sales by region&apos;!\$B\$2:\$B\$4<\/c:f>/, 'the chart reads the table itself');
  assert.match(bar, /srgbClr val="2266AA"/);
  const line = text(charts.find((n) => text(n).includes('c:lineChart'))!);
  assert.match(line, /<c:ptCount val="3"\/>/);
  assert.match(line, /plotVisOnly val="0"/, 'a chart that does not match the table gets its own block');
  assert.ok(charts.some((n) => text(n).includes('c:pieChart')));
  assert.ok(charts.some((n) => text(n).includes('c:areaChart')));
  assert.ok(charts.some((n) => text(n).includes('barDir val="bar"')));
  assert.equal([...parts.keys()].filter((n) => n.startsWith('xl/media/')).length, 2);

  const big = text('xl/worksheets/sheet2.xml');
  assert.match(big, /<autoFilter ref="A1:C5001"\/>/);
  assert.match(big, /state="frozen"/);
  assert.doesNotMatch(big, /<f>/, 'no formulas anywhere');
  assert.match(big, /<c r="B2" s="\d+"><v>1200\.5<\/v><\/c>/);
  const strings = text('xl/sharedStrings.xml');
  assert.ok(strings.includes('=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)'), 'formula text is a string');
  assert.equal(Number(/uniqueCount="(\d+)"/.exec(strings)![1]), (strings.match(/<si>/g) ?? []).length);

  const styles = text('xl/styles.xml');
  assert.match(styles, /formatCode="&quot;\$&quot;#,##0\.00"/);
  assert.match(styles, /formatCode="0\.0%"/);
  assert.match(styles, /rgb="FFFBDDDD"/, 'tone fill');

  const summary = text('xl/worksheets/sheet1.xml');
  assert.match(summary, /<hyperlink ref="A\d+" location="&apos;Sales by region&apos;!A1"/);
  assert.ok(strings.includes('No answer: It failed:'), 'errors are on the Summary');
  assert.ok(strings.includes('The chart picture could not be read'));
});

test('xlsx: strings Excel would decode, and text over the cell limit, stay safe', async () => {
  const table: ExportTable = {
    columns: [{ label: 'A', numeric: false }],
    rows: [[{ text: 'keep _x0041_ as it is', value: 'x' }], [{ text: 'y'.repeat(40000), value: 'y' }]],
  };
  const parts = await unzip(await toXlsx({ ...SIMPLE, flags: [baseFlag({ table })] }));
  const strings = decoder.decode(parts.get('xl/sharedStrings.xml')!);
  assert.ok(strings.includes('keep _x005F_x0041_ as it is'));
  const longest = Math.max(...[...strings.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]!.length));
  assert.ok(longest <= 32767, String(longest));
});

test('xlsx: an empty document is still a workbook', async () => {
  const parts = await unzip(await toXlsx(EMPTY));
  assertPackage(parts);
  assert.ok(decoder.decode(parts.get('xl/sharedStrings.xml')!).includes('This report has no flags.'));
});

test('docx: real heading styles, a repeating header row, alt text, and errors in the open', async () => {
  const parts = await unzip(await toDocx(await nastyDoc()));
  assertPackage(parts);
  const body = decoder.decode(parts.get('word/document.xml')!);
  assert.ok(body.includes('<w:pStyle w:val="Heading1"/>'));
  assert.ok(body.includes('<w:pStyle w:val="Heading2"/>'));
  assert.ok(body.includes('<w:tblHeader/>'));
  assert.ok(body.includes('descr="Tom &amp; Jerry&apos;s &quot;&lt;b&gt;sales&lt;/b&gt;&quot;'));
  assert.ok(body.includes('No answer: It failed:'));
  assert.ok(body.includes('and 4,500 more rows'));
  assert.ok(body.includes('売上'));
  assert.ok(body.includes('Nothing to show for this flag.'));
  assert.ok(body.includes('The chart picture could not be read'));
  assert.equal([...parts.keys()].filter((n) => n.startsWith('word/media/')).length, 2);
  assert.ok(body.includes('w:orient="landscape"'), 'a wide table turns the page');
  assert.ok(decoder.decode(parts.get('word/styles.xml')!).includes('w:styleId="Heading1"'));
  assertPackage(await unzip(await toDocx(EMPTY)));
});

test('pptx: a title slide and one slide per flag, in a valid package', async () => {
  const doc = await nastyDoc();
  const parts = await unzip(await toPptx(doc));
  assertPackage(parts);
  const slides = [...parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(slides.length, doc.flags.length + 1);
  const slide = (n: number) => decoder.decode(parts.get(`ppt/slides/slide${n}.xml`)!);
  assert.ok(slide(1).includes('type="ctrTitle"'));
  assert.ok(slide(2).includes('<p:pic>'), 'the chart picture is used');
  assert.ok(slide(15).includes('<a:tbl>'), 'a table with no picture is native');
  assert.ok(slide(15).includes('more columns'));
  assert.ok(slide(11).includes('A long note.'), 'notes get a text slide');
  assert.ok(slide(11).includes('The rest of this note'));
  assert.ok(slide(12).includes('No answer: It failed:'));
  assert.ok(decoder.decode(parts.get('ppt/presentation.xml')!).includes('cx="12192000" cy="6858000"'));
  for (const name of slides) {
    const ids = [...decoder.decode(parts.get(name)!).matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} shape ids`);
  }
  const empty = await unzip(await toPptx(EMPTY));
  assertPackage(empty);
  assert.ok(decoder.decode(empty.get('ppt/slides/slide1.xml')!).includes('This report has no flags.'));
});

test('pdf: the cross-reference table, page tree, metadata and bookmarks are right', async () => {
  const pdf = await readPdf(await toPdf(SIMPLE));
  assert.match(pdf.text, new RegExp(`/Type /Pages /Kids \\[[^\\]]*\\] /Count ${pdf.pages.length}`));
  assert.equal(pdf.pages.length, 1);
  assert.match(pdf.text, /\/Title \(Weekly report\) \/Author \(Anthony\)/);
  assert.match(pdf.text, /\/CreationDate \(D:20261107140500Z\)/);
  assert.match(pdf.text, /\/Type \/Outlines .*\/Count 2/);
  assert.ok(pdf.text.includes('/Title (Sales \\(by region\\))'));
  assert.ok(pdf.text.includes('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding'));
  assert.match(pdf.text, /\/MediaBox \[0 0 792 612\]/);
  const strings = pageStrings(pdf.pages[0]!);
  for (const expected of ['Weekly report', 'How sales are going.', 'Region is East', 'Sales (by region)', '$1.2K', '\u0095', 'East is ahead.', 'No answer: The source file is missing.', 'Page 1 of 1']) {
    assert.ok(strings.includes(expected), `${expected} in ${strings.join(' | ')}`);
  }
});

test('pdf: punctuation survives in WinAnsi and other characters are replaced sensibly', async () => {
  assert.equal(toWinAnsiText('– — “ ” ’ … €'), '– — “ ” ’ … €');
  assert.equal(toWinAnsiText('naïve café Ā ﬁ ≤ → \u2011 \u00AD'), 'naïve café A fi <= -> - ');
  let lost = 0;
  assert.equal(toWinAnsiText('売😀', () => { lost += 1; }), '??');
  assert.equal(lost, 2);
  const pdf = await readPdf(await toPdf({ ...SIMPLE, flags: [baseFlag({ title: '– — “ ” ’ … €', insights: ['売上'] })] }));
  const page = pdf.pages[0]!;
  assert.ok(page.includes('(\\226 \\227 \\223 \\224 \\222 \\205 \\200) Tj'), 'WinAnsi bytes');
  assert.ok(pageStrings(page).some((s) => s.includes('are not in this PDF')), 'says when characters were lost');
});

test('pdf: Helvetica widths drive wrapping', () => {
  assert.equal(textWidth('Hello', 'F1', 10), (722 + 556 + 222 + 222 + 556) / 100);
  assert.equal(textWidth('Hello', 'F2', 10), (722 + 556 + 278 + 278 + 611) / 100);
  assert.equal(textWidth('€—…', 'F1', 1), (556 + 1000 + 1000) / 1000);
  assert.equal(textWidth('é', 'F2', 1), 0.556);
  for (const line of wrapText('word '.repeat(100) + 'x'.repeat(500), 'F1', 10, 200)) assert.ok(textWidth(line, 'F1', 10) <= 200, line);
});

test('pdf: PNG filters are undone, alpha is split out, and RGB comes back exact', async () => {
  const pixel = gradient;
  const rgba = await decodePng(await makePng(13, 11, 4, pixel));
  const rgbBytes = await inflateZlib(rgba.rgb);
  const alpha = await inflateZlib(rgba.alpha!);
  assert.equal(rgbBytes.length, 13 * 11 * 3);
  for (let y = 0; y < 11; y += 1) {
    for (let x = 0; x < 13; x += 1) {
      const [r, g, b, a] = pixel(x, y) as [number, number, number, number];
      const i = y * 13 + x;
      assert.deepEqual([rgbBytes[i * 3], rgbBytes[i * 3 + 1], rgbBytes[i * 3 + 2], alpha[i]], [r, g, b, a]);
    }
  }
  const opaque = await decodePng(await makePng(5, 5, 4, () => [1, 2, 3, 255]));
  assert.equal(opaque.alpha, null, 'no mask when nothing is see-through');
  const rgb = await decodePng(await makePng(6, 7, 3, pixel));
  assert.equal((await inflateZlib(rgb.rgb)).length, 6 * 7 * 3);
  assert.equal(rgb.alpha, null);
  await assert.rejects(decodePng(new Uint8Array(50)), /Not a PNG/);
});

test('a chart with no picture and no table still shows its numbers', async () => {
  const doc: ExportDocument = {
    ...SIMPLE,
    flags: [baseFlag({ title: 'Chart only', chart: { type: 'bar', categories: ['Q1', 'Q2'], series: [{ name: 'Hours', values: [1200, null], color: '#123456' }] } })],
  };
  const page = pageStrings((await readPdf(await toPdf(doc))).pages[0]!);
  assert.ok(page.includes('Hours') && page.includes('1,200'), page.join(' | '));
  assert.ok(!page.includes('Nothing to show for this flag.'));
  const word = decoder.decode((await unzip(await toDocx(doc))).get('word/document.xml')!);
  assert.ok(word.includes('1,200') && !word.includes('Nothing to show'));
  const slide = decoder.decode((await unzip(await toPptx(doc))).get('ppt/slides/slide2.xml')!);
  assert.ok(slide.includes('<a:tbl>') && slide.includes('1,200'));
  const files = await unzip(await flagsToCsvZip(doc));
  const csv = decoder.decode(files.get('01-chart-only.csv')!, { stream: false });
  assert.deepEqual(csv.trimEnd().split('\r\n'), ['Category,Hours', 'Q1,1200', 'Q2,']);
});

test('pdf: long tables, wide tables and hostile text stay on the page', async () => {
  const doc = await nastyDoc();
  const pdf = await readPdf(await toPdf(doc));
  assert.match(pdf.text, new RegExp(`/Count ${pdf.pages.length} >>`));
  assert.ok(pdf.pages.length < 60, `${pdf.pages.length} pages`);
  assert.ok(pdf.text.includes('/Subtype /Image'));
  assert.ok(pdf.text.includes('/SMask'));
  const all = pdf.pages.flatMap(pageStrings).join('\n');
  assert.ok(all.includes('and 4,950 more rows'));
  assert.ok(all.includes('and 18 more columns'));
  assert.ok(all.includes('No answer: It failed:'));
  assert.ok(all.includes('The chart picture could not be read'));
  assert.ok(all.includes('Nothing to show for this flag.'));
  assert.ok(pdf.text.includes('/Title <FEFF'), 'bookmarks keep non-Latin text');

  pdf.pages.forEach((page, p) => {
    for (const m of page.matchAll(/\/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)) {
      const [font, size, x, y] = [m[1] as 'F1', Number(m[2]), Number(m[3]), Number(m[4])];
      const width = textWidth(toWinAnsiText(pdfStringToText(m[5]!).replace(/[\u0080-\u009f]/g, '?')), font, size);
      assert.ok(x >= 48 - 0.01 && x + width <= 744 + 0.5, `page ${p + 1}: text runs off at ${x}+${width}: ${m[5]}`);
      assert.ok(y >= 30 && y <= 612 - 40, `page ${p + 1}: text off the page at y=${y}`);
    }
    for (const m of page.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/g)) {
      const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
      assert.ok(x + w <= 744.5 && y >= 60, `page ${p + 1}: a filled box overruns: ${m[0]}`);
    }
  });
  const empty = await readPdf(await toPdf(EMPTY));
  assert.equal(empty.pages.length, 1);
  assert.ok(pageStrings(empty.pages[0]!).includes('This report has no flags.'));
});

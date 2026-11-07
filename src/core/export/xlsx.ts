// A real Excel workbook, written by hand: a Summary sheet, then one sheet per flag with data.
// Numbers are numbers with formats, text is always a shared string (so nothing can become a
// formula), and charts are native DrawingML charts that read the sheet's own cells.

import type { ExportCell, ExportChart, ExportColumn, ExportDocument, ExportFlag, ExportImage, ExportTable, ExportTone } from './model.ts';
import {
  accentInk,
  appProps,
  BAD_IMAGE,
  cellNumber,
  cellText,
  chartTable,
  clip,
  cleanText,
  contentTypes,
  coreProps,
  fitBox,
  hasTable,
  hexColor,
  inkOn,
  mix,
  MUTED_INK,
  NO_FLAGS,
  noAnswer,
  NOTHING_TO_SHOW,
  packageRels,
  readableImage,
  relationships,
  takenAtWords,
  TONE_FILL,
  usableChart,
  validDate,
  xml,
  XML_HEAD,
} from './shared.ts';
import { zip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** Excel's limit on one cell. Going over it makes Excel repair the file. */
const MAX_CELL_TEXT = 32767;
const EMU_PER_PIXEL = 9525;
const CHART_WIDTH_PX = 640;
const CHART_HEIGHT_PX = 360;
const MAX_ROW_HEIGHT = 409;

/** Letters for a zero-based column. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = (n - 1 - r) / 26;
  }
  return out;
}

function cutName(name: string, max: number): string {
  let out = name.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.replace(/[\s']+$/, '');
}

/** A legal sheet name: 31 characters at most, none of []:*?/\, no apostrophe at either end. */
export function sheetName(title: string, fallback: string): string {
  const name = cleanText(title)
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .trim();
  // Excel keeps "History" for itself.
  if (!name || name.toLowerCase() === 'history') return fallback;
  return cutName(name, 31);
}

/** Legal names for each title, unique the way Excel compares them (ignoring case). */
export function uniqueSheetNames(titles: string[], reserved: string[] = []): string[] {
  const used = new Set(reserved.map((r) => r.toLowerCase()));
  return titles.map((title, i) => {
    const base = sheetName(title, `Flag ${i + 1}`);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = cutName(base, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** A sheet name as it appears in a formula or link. */
function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Excel decodes _xHHHH_ in strings, so one that is really in the text has to be escaped. */
function excelText(text: string): string {
  return xml(clip(cleanText(text), MAX_CELL_TEXT).replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_'));
}

interface StyleSpec {
  font?: number;
  fill?: string;
  numFmt?: string;
  wrap?: boolean;
  align?: 'right' | 'left';
}

const FONT = { normal: 0, bold: 1, title: 2, header: 3, link: 4, section: 5, muted: 6, problem: 7 };

function makeStyles(accent: string) {
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const fillIds = new Map<string, number>();
  const numFmts = new Map<string, number>();
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const ids = new Map<string, number>();

  function fillId(hex: string | undefined): number {
    if (!hex) return 0;
    let id = fillIds.get(hex);
    if (id === undefined) {
      id = fills.length;
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillIds.set(hex, id);
    }
    return id;
  }

  function numFmtId(code: string | undefined): number {
    if (!code) return 0;
    let id = numFmts.get(code);
    if (id === undefined) {
      id = 164 + numFmts.size;
      numFmts.set(code, id);
    }
    return id;
  }

  function style(spec: StyleSpec): number {
    const key = JSON.stringify(spec);
    let id = ids.get(key);
    if (id === undefined) {
      const font = spec.font ?? FONT.normal;
      const fill = fillId(spec.fill);
      const fmt = numFmtId(spec.numFmt);
      const alignment =
        spec.wrap || spec.align
          ? `<alignment${spec.align ? ` horizontal="${spec.align}"` : ''}${spec.wrap ? ' vertical="top" wrapText="1"' : ''}/>`
          : '';
      id = xfs.length;
      xfs.push(
        `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0"` +
          `${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}` +
          (alignment ? ` applyAlignment="1">${alignment}</xf>` : '/>'),
      );
      ids.set(key, id);
    }
    return id;
  }

  function font(size: number, color: string | null, extra = ''): string {
    return `<font>${extra}<sz val="${size}"/>${color ? `<color rgb="FF${color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`;
  }

  function document(): string {
    const ink = accentInk(accent);
    const fonts = [
      font(11, null),
      font(11, null, '<b/>'),
      font(18, ink, '<b/>'),
      font(11, inkOn(accent), '<b/>'),
      font(11, '0563C1', '<u/>'),
      font(12, ink, '<b/>'),
      font(11, MUTED_INK),
      font(11, 'A61B1B', '<b/>'),
    ];
    const formats = [...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`);
    return (
      `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
      (formats.length > 0 ? `<numFmts count="${formats.length}">${formats.join('')}</numFmts>` : '') +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
      `<fills count="${fills.length}">${fills.join('')}</fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>'
    );
  }

  return { style, document };
}

function makeStrings() {
  const index = new Map<string, number>();
  let total = 0;
  return {
    add(text: string): number {
      total += 1;
      let id = index.get(text);
      if (id === undefined) {
        id = index.size;
        index.set(text, id);
      }
      return id;
    },
    document(): string {
      const items = [...index.keys()].map((t) => `<si><t xml:space="preserve">${excelText(t)}</t></si>`);
      return `${XML_HEAD}<sst xmlns="${MAIN_NS}" count="${total}" uniqueCount="${index.size}">${items.join('')}</sst>`;
    },
  };
}

type Strings = ReturnType<typeof makeStrings>;
type Styles = ReturnType<typeof makeStyles>;

/** Cells gathered by row, so a second block can sit beside a table on the same rows. */
function makeGrid(strings: Strings) {
  const rows = new Map<number, { cells: Array<[number, string]>; height?: number }>();
  let maxCol = 0;
  function row(r: number) {
    let found = rows.get(r);
    if (!found) {
      found = { cells: [] };
      rows.set(r, found);
    }
    return found;
  }
  function add(r: number, c: number, body: string) {
    row(r).cells.push([c, body]);
    maxCol = Math.max(maxCol, c);
  }
  const ref = (r: number, c: number) => `${columnName(c)}${r + 1}`;
  return {
    text(r: number, c: number, text: string, style: number) {
      add(r, c, `<c r="${ref(r, c)}" s="${style}" t="s"><v>${strings.add(text)}</v></c>`);
    },
    number(r: number, c: number, value: number, style: number) {
      add(r, c, `<c r="${ref(r, c)}" s="${style}"><v>${Object.is(value, -0) ? 0 : value}</v></c>`);
    },
    boolean(r: number, c: number, value: boolean, style: number) {
      add(r, c, `<c r="${ref(r, c)}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`);
    },
    blank(r: number, c: number, style: number) {
      add(r, c, `<c r="${ref(r, c)}" s="${style}"/>`);
    },
    height(r: number, points: number) {
      row(r).height = Math.min(MAX_ROW_HEIGHT, points);
    },
    get lastRow() {
      return rows.size > 0 ? Math.max(...rows.keys()) : 0;
    },
    get lastCol() {
      return maxCol;
    },
    xml(): string {
      const out = [...rows.keys()].sort((a, b) => a - b).map((r) => {
        const { cells, height } = rows.get(r)!;
        const body = cells.sort((a, b) => a[0] - b[0]).map((c) => c[1]).join('');
        return `<row r="${r + 1}"${height ? ` ht="${height}" customHeight="1"` : ''}>${body}</row>`;
      });
      return `<sheetData>${out.join('')}</sheetData>`;
    },
  };
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.codePointAt(0)! >= 0x2e80 ? 2 : 1;
  return width;
}

function numberFormat(column: ExportColumn, rows: ExportCell[][], index: number): string | undefined {
  if (!column.format) return undefined;
  if (column.format === 'percent') return '0.0%';
  const numbers = rows.map((r) => cellNumber(column, r[index])).filter((n): n is number => n !== null);
  const whole = numbers.every((n) => Number.isInteger(n));
  const body = whole ? '#,##0' : '#,##0.00';
  if (column.format === 'number') return body;
  const symbol = rows.map((r) => /[$€£¥]/.exec(cellText(r[index]))?.[0]).find(Boolean) ?? '$';
  return `"${symbol}"${body}`;
}

function numberWidth(value: number, code: string | undefined): number {
  if (code === '0.0%') return 8;
  const digits = String(Math.round(Math.abs(value))).length;
  if (!code) return String(value).length;
  return digits + Math.floor((digits - 1) / 3) + (code.includes('.') ? 3 : 0) + 2;
}

function columnsXml(widths: number[]): string {
  if (widths.length === 0) return '';
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(2)}" customWidth="1"/>`);
  return `<cols>${cols.join('')}</cols>`;
}

/** The table columns that hold the chart's numbers, or null if the chart needs its own block. */
function chartColumns(table: ExportTable, chart: ExportChart): { category: number; series: number[] } | null {
  if (table.rows.length !== chart.categories.length) return null;
  const category = table.columns.findIndex((_, c) => table.rows.every((r, i) => cellText(r[c]) === chart.categories[i]));
  if (category < 0) return null;
  const series: number[] = [];
  for (const s of chart.series) {
    const matches = table.columns
      .map((_, c) => c)
      .filter((c) => c !== category && table.rows.every((r, i) => cellNumber(table.columns[c], r[c]) === s.values[i]));
    const column = matches.find((c) => table.columns[c]!.label === s.name) ?? matches[0];
    if (column === undefined) return null;
    series.push(column);
  }
  return { category, series };
}

interface ChartRefs {
  category: string;
  names: string[];
  values: string[];
  /** False when the chart reads its own block, so a filter on the table must not hide its rows. */
  followFilter: boolean;
}

function fillXml(hex: string): string {
  return `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
}

function stringCache(values: string[]): string {
  const points = values.map((v, i) => `<c:pt idx="${i}"><c:v>${xml(v)}</c:v></c:pt>`);
  return `<c:strCache><c:ptCount val="${values.length}"/>${points.join('')}</c:strCache>`;
}

function numberCache(values: Array<number | null>): string {
  const points = values.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`));
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points.join('')}</c:numCache>`;
}

/** One colour per slice: lighter and darker steps of the series colour. */
function sliceColor(base: string, i: number): string {
  const steps: Array<[string, number]> = [['FFFFFF', 0], ['FFFFFF', 0.45], ['000000', 0.35], ['FFFFFF', 0.7], ['000000', 0.55], ['FFFFFF', 0.25]];
  const [target, amount] = steps[i % steps.length]!;
  return mix(base, target, amount);
}

function seriesXml(chart: ExportChart, refs: ChartRefs, i: number, fallback: string): string {
  const s = chart.series[i]!;
  const color = hexColor(s.color, fallback);
  const tx = `<c:tx><c:strRef><c:f>${xml(refs.names[i]!)}</c:f>${stringCache([s.name])}</c:strRef></c:tx>`;
  const cat = `<c:cat><c:strRef><c:f>${xml(refs.category)}</c:f>${stringCache(chart.categories)}</c:strRef></c:cat>`;
  const val = `<c:val><c:numRef><c:f>${xml(refs.values[i]!)}</c:f>${numberCache(s.values)}</c:numRef></c:val>`;
  const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}`;
  if (chart.type === 'line') {
    return `<c:ser>${head}<c:spPr><a:ln w="28575" cap="rnd">${fillXml(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${fillXml(color)}<a:ln w="9525">${fillXml(color)}</a:ln></c:spPr></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
  }
  if (chart.type === 'pie') {
    const points = chart.categories.map(
      (_, p) => `<c:dPt><c:idx val="${p}"/><c:bubble3D val="0"/><c:spPr>${fillXml(sliceColor(color, p))}<a:ln w="9525">${fillXml('FFFFFF')}</a:ln></c:spPr></c:dPt>`,
    );
    const labels =
      '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>';
    return `<c:ser>${head}${points.join('')}${labels}${cat}${val}</c:ser>`;
  }
  if (chart.type === 'bar') {
    return `<c:ser>${head}<c:spPr>${fillXml(color)}</c:spPr><c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
  }
  return `<c:ser>${head}<c:spPr>${fillXml(color)}</c:spPr>${cat}${val}</c:ser>`;
}

function chartXml(chart: ExportChart, title: string, refs: ChartRefs, accent: string): string {
  const series = chart.series.map((_, i) => seriesXml(chart, refs, i, accent)).join('');
  const horizontal = chart.type === 'bar' && !!chart.horizontal;
  const grouping = chart.stacked ? 'stacked' : 'standard';
  const axes = '<c:axId val="111111111"/><c:axId val="222222222"/>';
  let plot: string;
  if (chart.type === 'bar') {
    plot =
      `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${chart.stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${series}` +
      `<c:gapWidth val="60"/>${chart.stacked ? '<c:overlap val="100"/>' : ''}${axes}</c:barChart>`;
  } else if (chart.type === 'line') {
    plot = `<c:lineChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`;
  } else if (chart.type === 'area') {
    plot = `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}${axes}</c:areaChart>`;
  } else {
    plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  }
  const quiet = `<c:spPr><a:ln w="9525">${fillXml('BFC5CC')}</a:ln></c:spPr>`;
  const grid = `<c:majorGridlines><c:spPr><a:ln w="6350">${fillXml('E3E6EA')}</a:ln></c:spPr></c:majorGridlines>`;
  const axisXml =
    chart.type === 'pie'
      ? ''
      : `<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/>` +
        `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${quiet}<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
        `<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>${grid}` +
        `<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111111"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="${chart.type === 'area' ? 'midCat' : 'between'}"/></c:valAx>`;
  const legend = chart.type === 'pie' || chart.series.length > 1 ? `<c:legend><c:legendPos val="${chart.type === 'pie' ? 'r' : 'b'}"/><c:overlay val="0"/></c:legend>` : '';
  const heading = xml(clip(cleanText(title), 200));
  return (
    `${XML_HEAD}<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="${A_NS}" xmlns:r="${REL_NS}"><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart>` +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"/><a:t>${heading}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
    `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea>${legend}<c:plotVisOnly val="${refs.followFilter ? 1 : 0}"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr>${fillXml('FFFFFF')}<a:ln w="9525">${fillXml('D9DDE2')}</a:ln></c:spPr>` +
    '</c:chartSpace>'
  );
}

function anchor(col: number, row: number, widthPx: number, heightPx: number, body: string): string {
  return (
    `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${Math.round(widthPx * EMU_PER_PIXEL)}" cy="${Math.round(heightPx * EMU_PER_PIXEL)}"/>${body}<xdr:clientData/></xdr:oneCellAnchor>`
  );
}

function drawingXml(body: string): string {
  return `${XML_HEAD}<xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="${A_NS}" xmlns:r="${REL_NS}">${body}</xdr:wsDr>`;
}

function chartFrame(title: string): string {
  return (
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart" descr="${xml(title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic>' +
    `<a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame>`
  );
}

function pictureFrame(title: string, widthPx: number, heightPx: number): string {
  const cx = Math.round(widthPx * EMU_PER_PIXEL);
  const cy = Math.round(heightPx * EMU_PER_PIXEL);
  return (
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture" descr="${xml(title)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
  );
}

interface FlagPlan {
  flag: ExportFlag;
  table: ExportTable | null;
  chart: ExportChart | null;
  image: ExportImage | null;
  sheet: string | null;
}

function planFlags(doc: ExportDocument): FlagPlan[] {
  const plans: FlagPlan[] = doc.flags.map((flag) => {
    const chart = usableChart(flag.chart);
    const image = chart ? null : readableImage(flag.image);
    const given = hasTable(flag.table) && flag.table.rows.length > 0 ? flag.table : null;
    return { flag, chart, image, table: given ?? (chart ? chartTable(chart) : null), sheet: null };
  });
  const withSheets = plans.filter((p) => p.table || p.image);
  uniqueSheetNames(withSheets.map((p) => p.flag.title), ['Summary']).forEach((name, i) => {
    withSheets[i]!.sheet = name;
  });
  return plans;
}

function statusWords(plan: FlagPlan): string {
  const { flag, sheet, chart, image } = plan;
  const words: string[] = [];
  if (flag.error) words.push(noAnswer(flag));
  if (flag.image && !chart && !image) words.push(BAD_IMAGE);
  if (sheet) words.push(chart ? 'Chart beside the data.' : image ? 'Picture of the chart.' : 'Data only.');
  else if (flag.headlines?.length) words.push('Headlines are listed above.');
  else if (flag.text) words.push('The note is listed below.');
  else if (hasTable(flag.table)) words.push('The table has no rows.');
  else if (!flag.error) words.push(NOTHING_TO_SHOW);
  return words.join(' ');
}

function toneStyle(tone: ExportTone | undefined, align?: 'right'): StyleSpec {
  return { ...(tone ? { fill: TONE_FILL[tone] } : {}), ...(align ? { align } : {}) };
}

const SUMMARY_WIDTHS = [34, 34, 16, 16, 50];
const SUMMARY_ALL = SUMMARY_WIDTHS.reduce((a, b) => a + b, 0);
const SUMMARY_REST = SUMMARY_ALL - SUMMARY_WIDTHS[0]!;

function linesFor(text: string, width: number): number {
  return cleanText(text).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / width)), 0);
}

function summarySheet(doc: ExportDocument, plans: FlagPlan[], strings: Strings, styles: Styles, accent: string): string {
  const grid = makeGrid(strings);
  const merges: string[] = [];
  const links: string[] = [];
  const merged = (r: number, from: number) => merges.push(`${columnName(from)}${r + 1}:E${r + 1}`);
  const wrapped = styles.style({ wrap: true });
  const label = styles.style({ font: FONT.bold, wrap: true });
  const section = styles.style({ font: FONT.section });
  const header = styles.style({ font: FONT.header, fill: accent });
  let r = 0;

  grid.text(r, 0, doc.title, styles.style({ font: FONT.title, wrap: true }));
  merged(r, 0);
  grid.height(r, linesFor(doc.title, SUMMARY_ALL * 0.62) * 24 + 4);
  r += 1;
  if (doc.brief) {
    grid.text(r, 0, doc.brief, wrapped);
    merged(r, 0);
    grid.height(r, linesFor(doc.brief, SUMMARY_ALL) * 15 + 3);
    r += 1;
  }
  r += 1;
  const fact = (name: string, value: string) => {
    grid.text(r, 0, name, label);
    grid.text(r, 1, value, wrapped);
    merged(r, 1);
    grid.height(r, linesFor(value, SUMMARY_REST) * 15 + 1);
    r += 1;
  };
  fact('Taken at', takenAtWords(doc.takenAt));
  fact('By', doc.by);
  if (doc.filters.length === 0) fact('Filters', 'None');
  doc.filters.forEach((filter, i) => fact(i === 0 ? 'Filters' : '', filter));
  r += 1;

  const headRow = (labels: string[]) => {
    labels.forEach((text, c) => grid.text(r, c, text, header));
    r += 1;
  };

  const kpis = plans.flatMap((p) => (p.flag.headlines ?? []).map((h) => ({ flag: p.flag, h })));
  if (kpis.length > 0) {
    grid.text(r, 0, 'Headlines', section);
    r += 1;
    headRow(['Flag', 'Measure', 'Shown as', 'Value', 'Change']);
    for (const { flag, h } of kpis) {
      const tone = styles.style(toneStyle(h.tone));
      grid.text(r, 0, flag.title, styles.style({}));
      grid.text(r, 1, h.label, styles.style({}));
      grid.text(r, 2, h.text, styles.style(toneStyle(h.tone, 'right')));
      if (typeof h.value === 'number' && Number.isFinite(h.value)) grid.number(r, 3, h.value, tone);
      else grid.blank(r, 3, tone);
      grid.text(r, 4, h.change ?? '', styles.style({}));
      r += 1;
    }
    r += 1;
  }

  grid.text(r, 0, 'Sheets', section);
  r += 1;
  if (plans.length === 0) {
    grid.text(r, 0, NO_FLAGS, wrapped);
    merged(r, 0);
    r += 1;
  } else {
    headRow(['Sheet', 'Flag', 'Rows', 'Kind', 'What is there']);
    for (const plan of plans) {
      const { flag, sheet, table } = plan;
      if (sheet) {
        grid.text(r, 0, sheet, styles.style({ font: FONT.link, wrap: true }));
        links.push(`<hyperlink ref="A${r + 1}" location="${xml(`${quoteSheet(sheet)}!A1`)}" display="${xml(sheet)}"/>`);
      } else {
        grid.text(r, 0, 'No sheet', styles.style({ font: FONT.muted, wrap: true }));
      }
      grid.text(r, 1, flag.title, wrapped);
      if (table) grid.number(r, 2, table.rows.length, styles.style({ numFmt: '#,##0', wrap: true }));
      else grid.blank(r, 2, 0);
      grid.text(r, 3, flag.kind, wrapped);
      const status = statusWords(plan);
      grid.text(r, 4, status, flag.error ? styles.style({ font: FONT.problem, fill: TONE_FILL.bad, wrap: true }) : wrapped);
      grid.height(r, Math.max(linesFor(status, SUMMARY_WIDTHS[4]!), linesFor(flag.title, SUMMARY_WIDTHS[1]!)) * 15 + 1);
      r += 1;
    }
  }

  const longRows = (name: string, items: Array<{ title: string; text: string }>) => {
    if (items.length === 0) return;
    r += 1;
    grid.text(r, 0, name, section);
    r += 1;
    for (const item of items) {
      grid.text(r, 0, item.title, wrapped);
      grid.text(r, 1, item.text, wrapped);
      merged(r, 1);
      grid.height(r, Math.max(linesFor(item.text, SUMMARY_REST), linesFor(item.title, SUMMARY_WIDTHS[0]!)) * 15 + 1);
      r += 1;
    }
  };
  longRows('Findings', plans.flatMap((p) => p.flag.insights.map((text) => ({ title: p.flag.title, text }))));
  longRows('Notes', plans.filter((p) => p.flag.text).map((p) => ({ title: p.flag.title, text: p.flag.text! })));

  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:E${r}"/>` +
    '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
    columnsXml(SUMMARY_WIDTHS) +
    grid.xml() +
    `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` +
    (links.length > 0 ? `<hyperlinks>${links.join('')}</hyperlinks>` : '') +
    '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>'
  );
}

interface BuiltSheet {
  xml: string;
  /** Set when the sheet has a table to filter: the range, as a defined name needs it. */
  filter: string | null;
  chart: string | null;
  drawing: string | null;
}

function flagSheet(plan: FlagPlan, strings: Strings, styles: Styles, accent: string): BuiltSheet {
  const { flag, table, chart, image } = plan;
  const name = plan.sheet!;
  const grid = makeGrid(strings);
  const header = styles.style({ font: FONT.header, fill: accent });
  const widths: number[] = [];
  const widen = (c: number, w: number) => {
    widths[c] = Math.max(widths[c] ?? 0, w);
  };

  if (table) {
    table.columns.forEach((column, c) => {
      grid.text(0, c, column.label, header);
      // The filter button sits on top of the end of the header text.
      widen(c, displayWidth(column.label) + 5);
      const code = numberFormat(column, table.rows, c);
      table.rows.forEach((row, i) => {
        const cell = row[c];
        const n = cellNumber(column, cell);
        const spec = { ...(cell?.tone ? { fill: TONE_FILL[cell.tone] } : {}) };
        if (n !== null) {
          grid.number(i + 1, c, n, styles.style(code ? { ...spec, numFmt: code } : spec));
          if (i < 500) widen(c, numberWidth(n, code) + 2);
        } else if (typeof cell?.value === 'boolean') {
          grid.boolean(i + 1, c, cell.value, styles.style(spec));
        } else if (column.numeric && (!cell || cell.value === null)) {
          // An empty cell, not "(blank)", so the column still adds up and sorts.
          grid.blank(i + 1, c, styles.style(spec));
        } else {
          grid.text(i + 1, c, cellText(cell), styles.style(spec));
          if (i < 500) widen(c, displayWidth(cellText(cell)) + 2);
        }
      });
    });
  }

  const tableCols = table ? table.columns.length : 0;
  const filter = table ? `$A$1:$${columnName(tableCols - 1)}$${table.rows.length + 1}` : null;
  let chartPart: string | null = null;
  let drawing: string | null = null;

  if (chart && table) {
    const sheet = quoteSheet(name);
    const range = (c: number, count: number) => `${sheet}!$${columnName(c)}$2:$${columnName(c)}$${count + 1}`;
    const headerCell = (c: number) => `${sheet}!$${columnName(c)}$1`;
    const count = chart.categories.length;
    const found = chartColumns(table, chart);
    let refs: ChartRefs;
    let right = tableCols;
    if (found) {
      refs = { category: range(found.category, count), names: found.series.map(headerCell), values: found.series.map((c) => range(c, count)), followFilter: true };
    } else {
      // The chart's numbers do not line up with the table, so they get their own block beside it.
      const at = tableCols + 1;
      grid.text(0, at, 'Chart data', header);
      widen(at, 12);
      chart.categories.forEach((category, i) => {
        grid.text(i + 1, at, category, styles.style({}));
        if (i < 500) widen(at, displayWidth(category) + 2);
      });
      chart.series.forEach((s, k) => {
        const c = at + 1 + k;
        grid.text(0, c, s.name, header);
        widen(c, Math.max(12, displayWidth(s.name) + 2));
        s.values.forEach((v, i) => {
          if (v === null) grid.blank(i + 1, c, 0);
          else grid.number(i + 1, c, v, 0);
        });
      });
      right = at + 1 + chart.series.length;
      refs = { category: range(at, count), names: chart.series.map((_, k) => headerCell(at + 1 + k)), values: chart.series.map((_, k) => range(at + 1 + k, count)), followFilter: false };
    }
    chartPart = chartXml(chart, flag.title, refs, accent);
    drawing = drawingXml(anchor(right + 1, 1, CHART_WIDTH_PX, CHART_HEIGHT_PX, chartFrame(flag.title)));
  } else if (image) {
    const size = fitBox(image.width, image.height, CHART_WIDTH_PX, 480);
    const col = table ? tableCols + 1 : 0;
    drawing = drawingXml(anchor(col, table ? 1 : 0, size.width, size.height, pictureFrame(flag.title, size.width, size.height)));
  }

  const widthList = Array.from({ length: widths.length }, (_, c) => Math.min(60, Math.max(widths[c] ?? 9, 9)));
  const lastRow = grid.lastRow + 1;
  const view = table
    ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>'
    : '<sheetView showGridLines="0" workbookViewId="0"/>';
  const sheetXml =
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>` +
    `<dimension ref="A1:${columnName(grid.lastCol)}${lastRow}"/><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    columnsXml(widthList) +
    grid.xml() +
    (filter ? `<autoFilter ref="${filter.replace(/\$/g, '')}"/>` : '') +
    '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/>' +
    (drawing ? '<drawing r:id="rId1"/>' : '') +
    '</worksheet>';
  return { xml: sheetXml, filter, chart: chartPart, drawing };
}

export async function toXlsx(doc: ExportDocument): Promise<Uint8Array> {
  const accent = hexColor(doc.accent);
  const strings = makeStrings();
  const styles = makeStyles(accent);
  const plans = planFlags(doc);
  const sheets = plans.filter((p) => p.sheet);

  const parts: ZipEntry[] = [];
  const overrides: Array<{ part: string; type: string }> = [
    { part: '/xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
    { part: '/xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
    { part: '/xl/sharedStrings.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml' },
  ];
  const addSheet = (n: number, body: string) => {
    parts.push({ name: `xl/worksheets/sheet${n}.xml`, data: body });
    overrides.push({ part: `/xl/worksheets/sheet${n}.xml`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' });
  };

  addSheet(1, summarySheet(doc, plans, strings, styles, accent));

  const definedNames: string[] = [];
  let hasPng = false;
  sheets.forEach((plan, i) => {
    const n = i + 2;
    const built = flagSheet(plan, strings, styles, accent);
    addSheet(n, built.xml);
    if (built.filter) {
      definedNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${n - 1}" hidden="1">${xml(`${quoteSheet(plan.sheet!)}!${built.filter}`)}</definedName>`);
    }
    if (!built.drawing) return;
    parts.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: relationships([{ id: 'rId1', type: 'drawing', target: `../drawings/drawing${n}.xml` }]) });
    parts.push({ name: `xl/drawings/drawing${n}.xml`, data: built.drawing });
    overrides.push({ part: `/xl/drawings/drawing${n}.xml`, type: 'application/vnd.openxmlformats-officedocument.drawing+xml' });
    if (built.chart) {
      parts.push({ name: `xl/charts/chart${n}.xml`, data: built.chart });
      overrides.push({ part: `/xl/charts/chart${n}.xml`, type: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml' });
      parts.push({ name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: relationships([{ id: 'rId1', type: 'chart', target: `../charts/chart${n}.xml` }]) });
    } else {
      hasPng = true;
      parts.push({ name: `xl/media/image${n}.png`, data: plan.image!.png });
      parts.push({ name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: relationships([{ id: 'rId1', type: 'image', target: `../media/image${n}.png` }]) });
    }
  });

  const sheetRows = [
    '<sheet name="Summary" sheetId="1" r:id="rId1"/>',
    ...sheets.map((p, i) => `<sheet name="${xml(p.sheet!)}" sheetId="${i + 2}" r:id="rId${i + 2}"/>`),
  ];
  const workbook =
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><workbookPr/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>` +
    `<sheets>${sheetRows.join('')}</sheets>` +
    (definedNames.length > 0 ? `<definedNames>${definedNames.join('')}</definedNames>` : '') +
    '<calcPr calcId="191029"/></workbook>';
  const sheetCount = sheets.length + 1;
  const workbookRels = relationships([
    ...Array.from({ length: sheetCount }, (_, i) => ({ id: `rId${i + 1}`, type: 'worksheet', target: `worksheets/sheet${i + 1}.xml` })),
    { id: `rId${sheetCount + 1}`, type: 'styles', target: 'styles.xml' },
    { id: `rId${sheetCount + 2}`, type: 'sharedStrings', target: 'sharedStrings.xml' },
  ]);

  return zip(
    [
      { name: '[Content_Types].xml', data: contentTypes(overrides, hasPng) },
      { name: '_rels/.rels', data: packageRels('xl/workbook.xml') },
      { name: 'docProps/core.xml', data: coreProps(doc) },
      { name: 'docProps/app.xml', data: appProps() },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
      { name: 'xl/styles.xml', data: styles.document() },
      { name: 'xl/sharedStrings.xml', data: strings.document() },
      ...parts,
    ],
    { date: validDate(doc.takenAt) ?? undefined },
  );
}

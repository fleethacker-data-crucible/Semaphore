// A 16:9 PowerPoint deck, written by hand: a title slide, then one slide per flag. Each slide is
// built for a glance, so long text is cut and tables are short; the Word and PDF exports hold it all.

import type { ExportDocument, ExportFlag, ExportHeadline, ExportImage, ExportTable } from './model.ts';
import {
  accentInk,
  appProps,
  BAD_IMAGE,
  BAD_INK,
  cellText,
  clip,
  contentTypes,
  coreProps,
  filtersWords,
  fitBox,
  flagTable,
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
  takenWords,
  TONE_FILL,
  validDate,
  xml,
  XML_HEAD,
} from './shared.ts';
import { zip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const SIDE = 500000;
const BODY_WIDTH = SLIDE_WIDTH - SIDE * 2;
const BODY_TOP = 1250000;
const BODY_BOTTOM = 5700000;
const INSIGHT_TOP = 5760000;
const INSIGHT_HEIGHT = 560000;
const FOOT_TOP = 6400000;
const MAX_TITLE = 110;
const MAX_INSIGHT = 160;
const MAX_NOTE = 1100;
const MAX_CARDS = 8;
const MAX_TABLE_COLUMNS = 7;
const ROW_HEIGHT = 340000;

const GROUP_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

interface Line {
  text: string;
  size?: number;
  bold?: boolean;
  color?: string;
  align?: 'l' | 'r' | 'ctr';
}

function runProps(line: Line): string {
  const fill = line.color ? `<a:solidFill><a:srgbClr val="${line.color}"/></a:solidFill>` : '';
  return `<a:rPr lang="en-US"${line.size ? ` sz="${line.size}"` : ''}${line.bold ? ' b="1"' : ''} dirty="0">${fill}</a:rPr>`;
}

function paragraph(line: Line): string {
  const props = line.align ? `<a:pPr algn="${line.align}"/>` : '';
  const text = line.text.replace(/\s*[\r\n]+\s*/g, ' ');
  return `<a:p>${props}<a:r>${runProps(line)}<a:t>${xml(text)}</a:t></a:r></a:p>`;
}

function placeholder(id: number, name: string, type: string, text: string, index?: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${index ? ` idx="${index}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraph({ text })}</p:txBody></p:sp>`
  );
}

function box(id: number, name: string, x: number, y: number, cx: number, cy: number, lines: Line[], fill?: string, anchor: 't' | 'ctr' = 't'): string {
  const background = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${background}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${lines.map(paragraph).join('')}</p:txBody></p:sp>`
  );
}

function picture(id: number, title: string, relId: string, x: number, y: number, cx: number, cy: number): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Chart" descr="${xml(title)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function tableCellXml(line: Line, fill: string | null): string {
  const background = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
  const none = (side: string) => `<a:ln${side} w="0"><a:noFill/></a:ln${side}>`;
  const edge = `${none('L')}${none('R')}${none('T')}<a:lnB w="6350"><a:solidFill><a:srgbClr val="D9DDE2"/></a:solidFill></a:lnB>`;
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paragraph(line)}</a:txBody><a:tcPr marL="68580" marR="68580" marT="34290" marB="34290" anchor="ctr">${edge}${background}</a:tcPr></a:tc>`;
}

/**
 * Characters that fit on one line of a column at this type size. 0.6 em a letter is on the wide
 * side of Calibri, so a cell of capitals still fits and the row keeps its height.
 */
function columnCapacity(widthEmu: number, size: number): number {
  return Math.max(4, Math.floor((widthEmu - 137160) / ((size / 100) * 12700 * 0.6)));
}

function nativeTable(id: number, table: ExportTable, accent: string, y: number, room: number): { xml: string; height: number; shownRows: number; shownColumns: number } {
  const columns = table.columns.slice(0, MAX_TABLE_COLUMNS);
  const rows = table.rows.slice(0, Math.max(1, Math.floor(room / ROW_HEIGHT) - 1));
  const size = columns.length > 5 ? 1100 : 1200;
  const need = columns.map((column, c) => Math.min(30, Math.max(6, column.label.length, ...rows.map((r) => cellText(r[c]).length))));
  const sum = need.reduce((a, b) => a + b, 0);
  const widths = need.map((n) => Math.floor((n / sum) * BODY_WIDTH));
  const cell = (text: string, c: number) => clip(text.replace(/\s+/g, ' '), columnCapacity(widths[c]!, size));
  const header = columns.map((column, c) =>
    tableCellXml({ text: cell(column.label, c), size, bold: true, color: inkOn(accent), align: column.numeric ? 'r' : 'l' }, accent),
  );
  const body = rows.map((row) => {
    const cells = columns.map((column, c) => {
      const tone = row[c]?.tone;
      return tableCellXml({ text: cell(cellText(row[c]), c), size, align: column.numeric ? 'r' : 'l' }, tone ? TONE_FILL[tone] : null);
    });
    return `<a:tr h="${ROW_HEIGHT}">${cells.join('')}</a:tr>`;
  });
  const height = ROW_HEIGHT * (rows.length + 1);
  return {
    height,
    shownRows: rows.length,
    shownColumns: columns.length,
    xml:
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${SIDE}" y="${y}"/><a:ext cx="${widths.reduce((a, b) => a + b, 0)}" cy="${height}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
      `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid><a:tr h="${ROW_HEIGHT}">${header.join('')}</a:tr>${body.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  };
}

function headlineCards(items: ExportHeadline[], firstId: number, y: number, perRow: number): { xml: string; height: number; used: number } {
  const gap = 150000;
  const height = 1050000;
  const width = Math.floor((BODY_WIDTH - gap * (perRow - 1)) / perRow);
  const parts = items.map((h, i) => {
    const x = SIDE + (i % perRow) * (width + gap);
    const top = y + Math.floor(i / perRow) * (height + gap);
    const value = clip(h.text, 16);
    const lines: Line[] = [
      { text: clip(h.label, 34), size: 1200, color: MUTED_INK },
      { text: value, size: value.length > 11 ? 2000 : 2600, bold: true, color: '1A1A1A' },
      ...(h.change ? [{ text: clip(h.change, 36), size: 1100, color: MUTED_INK }] : []),
    ];
    return box(firstId + i, h.label, x, top, width, height, lines, h.tone ? TONE_FILL[h.tone] : 'F2F4F6', 'ctr');
  });
  const rows = Math.ceil(items.length / perRow);
  return { xml: parts.join(''), height: rows * height + (rows - 1) * gap, used: items.length };
}

function slideXml(shapes: string): string {
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_HEAD}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function footer(id: number, doc: ExportDocument, page: number): string {
  return (
    box(id, 'Report title', SIDE, FOOT_TOP, 8000000, 300000, [{ text: clip(doc.title, 90), size: 1000, color: MUTED_INK }]) +
    box(id + 1, 'Slide number', SLIDE_WIDTH - SIDE - 1000000, FOOT_TOP, 1000000, 300000, [{ text: String(page), size: 1000, color: MUTED_INK, align: 'r' }])
  );
}

interface SlideParts {
  xml: string;
  image: ExportImage | null;
}

function flagSlide(flag: ExportFlag, doc: ExportDocument, accent: string, page: number): SlideParts {
  const shapes: string[] = [placeholder(2, 'Title', 'title', clip(flag.title.trim() || 'Untitled flag', MAX_TITLE))];
  let nextId = 3;
  const id = () => {
    nextId += 1;
    return nextId - 1;
  };
  let y = BODY_TOP;
  let image: ExportImage | null = null;
  const notes: string[] = [];

  if (flag.error) {
    shapes.push(box(id(), 'Problem', SIDE, y, BODY_WIDTH, 620000, [{ text: clip(noAnswer(flag), 200), size: 1500, bold: true, color: BAD_INK }], TONE_FILL.bad, 'ctr'));
    y += 720000;
  }

  const readable = readableImage(flag.image);
  const data = readable ? null : flagTable(flag);
  const cards = flag.headlines ?? [];
  if (cards.length > 0) {
    // With a picture or table below, headlines keep to one row.
    const limit = readable || data || flag.text ? 4 : MAX_CARDS;
    const shown = cards.slice(0, limit);
    const built = headlineCards(shown, nextId, y, Math.min(4, shown.length));
    nextId += built.used;
    shapes.push(built.xml);
    y += built.height + 150000;
    if (cards.length > shown.length) notes.push(`and ${cards.length - shown.length} more headlines`);
  }

  if (readable) {
    const size = fitBox(readable.width, readable.height, BODY_WIDTH, BODY_BOTTOM - y);
    const cx = Math.round(size.width);
    const cy = Math.round(size.height);
    shapes.push(picture(id(), flag.title, 'rId2', Math.round((SLIDE_WIDTH - cx) / 2), y, cx, cy));
    image = readable;
    y += cy;
  } else if (data) {
    const room = BODY_BOTTOM - y;
    const built = nativeTable(id(), data, accent, y, room);
    shapes.push(built.xml);
    y += built.height;
    const rowsLeft = data.rows.length - built.shownRows;
    const columnsLeft = data.columns.length - built.shownColumns;
    if (rowsLeft > 0) notes.push(`and ${rowsLeft.toLocaleString('en-US')} more rows`);
    if (columnsLeft > 0) notes.push(`and ${columnsLeft} more columns`);
  } else if (flag.image) {
    shapes.push(box(id(), 'Problem', SIDE, y, BODY_WIDTH, 500000, [{ text: BAD_IMAGE, size: 1400, color: BAD_INK }]));
    y += 550000;
  }

  if (flag.text && y < BODY_BOTTOM - 400000) {
    const room = BODY_BOTTOM - y;
    const capacity = Math.floor((MAX_NOTE * room) / (BODY_BOTTOM - BODY_TOP));
    const cut = flag.text.length > capacity;
    const lines: Line[] = clip(flag.text, capacity).split(/\r?\n+/).filter((l) => l.trim()).map((text) => ({ text, size: 1600 }));
    if (cut) lines.push({ text: 'The rest of this note is in the Word and PDF exports.', size: 1200, color: MUTED_INK });
    shapes.push(box(id(), 'Note', SIDE, y, BODY_WIDTH, room, lines));
    y = BODY_BOTTOM;
  }

  if (y === BODY_TOP && !flag.error) {
    shapes.push(box(id(), 'Nothing to show', SIDE, y, BODY_WIDTH, 500000, [{ text: NOTHING_TO_SHOW, size: 1600, color: MUTED_INK }]));
  }

  const lines: Line[] = [];
  if (flag.insights.length > 0) lines.push({ text: clip(flag.insights[0]!, MAX_INSIGHT), size: 1400, color: '1A1A1A' });
  if (notes.length > 0) lines.push({ text: `${notes.join(', ')}. The full data is in the Excel export.`, size: 1100, color: MUTED_INK });
  if (lines.length > 0) shapes.push(box(id(), 'Finding', SIDE, INSIGHT_TOP, BODY_WIDTH, INSIGHT_HEIGHT, lines));
  shapes.push(footer(nextId, doc, page));
  return { xml: slideXml(shapes.join('')), image };
}

function titleSlide(doc: ExportDocument): string {
  const details = [`Taken at: ${takenWords(doc)}`, `By: ${doc.by}`, `Filters: ${clip(filtersWords(doc), 220)}`];
  const body = [...(doc.brief ? [clip(doc.brief, 260)] : []), ...details, ...(doc.flags.length === 0 ? [NO_FLAGS] : [])];
  return slideXml(
    placeholder(2, 'Title', 'ctrTitle', clip(doc.title.trim() || 'Report', MAX_TITLE)) +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/>${body.map((text) => paragraph({ text })).join('')}</p:txBody></p:sp>`,
  );
}

function themeXml(accent: string): string {
  const shadeOf = (n: number) => mix(accent, n % 2 === 0 ? 'FFFFFF' : '000000', 0.15 * n);
  const accents = [accent, shadeOf(1), shadeOf(2), shadeOf(3), shadeOf(4), shadeOf(5)];
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/></a:ln>`;
  return (
    `${XML_HEAD}<a:theme xmlns:a="${A_NS}" name="Semaphore"><a:themeElements><a:clrScheme name="Semaphore">` +
    '<a:dk1><a:srgbClr val="1A1A1A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="3B4650"/></a:dk2><a:lt2><a:srgbClr val="F2F4F6"/></a:lt2>' +
    accents.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join('') +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Semaphore"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="Semaphore"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
  );
}

function layoutPlaceholder(id: number, name: string, type: string, x: number, y: number, cx: number, cy: number, body: string, index?: number, style = '', size?: number): string {
  const list = size ? `<a:lstStyle><a:lvl1pPr><a:defRPr sz="${size}"/></a:lvl1pPr></a:lstStyle>` : '<a:lstStyle/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${index ? ` idx="${index}"` : ''}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr ${style}><a:normAutofit/></a:bodyPr>${list}<a:p><a:r><a:rPr lang="en-US"/><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function masterXml(ink: string): string {
  const level = (n: number, size: number) =>
    `<a:lvl${n}pPr marL="0" indent="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buNone/><a:defRPr sz="${size}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return (
    `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_HEAD}` +
    layoutPlaceholder(2, 'Title', 'title', SIDE, 330000, BODY_WIDTH, 860000, 'Title', undefined, 'anchor="ctr"') +
    layoutPlaceholder(3, 'Body', 'body', SIDE, BODY_TOP, BODY_WIDTH, BODY_BOTTOM - BODY_TOP, 'Text', 1) +
    '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:buNone/><a:defRPr sz="2800" b="1" kern="1200"><a:solidFill><a:srgbClr val="${ink}"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
    `<p:bodyStyle>${level(1, 1800)}${level(2, 1600)}</p:bodyStyle><p:otherStyle>${level(1, 1800)}</p:otherStyle></p:txStyles></p:sldMaster>`
  );
}

function titleLayoutXml(accent: string): string {
  return (
    `${XML_HEAD}<p:sldLayout ${NS} type="title" preserve="1"><p:cSld name="Title Slide"><p:spTree>${GROUP_HEAD}` +
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent bar"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="260000" cy="${SLIDE_HEIGHT}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
    layoutPlaceholder(2, 'Title', 'ctrTitle', 800000, 1200000, 10500000, 1900000, 'Title', undefined, 'anchor="b"', 4000) +
    layoutPlaceholder(3, 'Subtitle', 'subTitle', 800000, 3250000, 10500000, 2500000, 'Details', 1) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function contentLayoutXml(): string {
  return (
    `${XML_HEAD}<p:sldLayout ${NS} type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${GROUP_HEAD}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

export async function toPptx(doc: ExportDocument): Promise<Uint8Array> {
  const accent = hexColor(doc.accent);
  const ink = accentInk(accent);
  const slides: ZipEntry[] = [{ name: 'ppt/slides/slide1.xml', data: titleSlide(doc) }];
  slides.push({ name: 'ppt/slides/_rels/slide1.xml.rels', data: relationships([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }]) });
  const media: ZipEntry[] = [];

  doc.flags.forEach((flag, i) => {
    const n = i + 2;
    const built = flagSlide(flag, doc, accent, n);
    const rels = [{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout2.xml' }];
    if (built.image) {
      media.push({ name: `ppt/media/image${n}.png`, data: built.image.png });
      rels.push({ id: 'rId2', type: 'image', target: `../media/image${n}.png` });
    }
    slides.push({ name: `ppt/slides/slide${n}.xml`, data: built.xml });
    slides.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: relationships(rels) });
  });

  const count = doc.flags.length + 1;
  const numbers = Array.from({ length: count }, (_, i) => i + 1);
  const presentation =
    `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${numbers.map((n) => `<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="${SLIDE_HEIGHT}" cy="${SLIDE_WIDTH}"/></p:presentation>`;
  const overrides = [
    { part: '/ppt/presentation.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' },
    { part: '/ppt/slideMasters/slideMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml' },
    { part: '/ppt/slideLayouts/slideLayout1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' },
    { part: '/ppt/slideLayouts/slideLayout2.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' },
    { part: '/ppt/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml' },
    ...numbers.map((n) => ({ part: `/ppt/slides/slide${n}.xml`, type: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml' })),
  ];
  const layoutRels = relationships([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]);

  return zip(
    [
      { name: '[Content_Types].xml', data: contentTypes(overrides, media.length > 0) },
      { name: '_rels/.rels', data: packageRels('ppt/presentation.xml') },
      { name: 'docProps/core.xml', data: coreProps(doc) },
      { name: 'docProps/app.xml', data: appProps() },
      { name: 'ppt/presentation.xml', data: presentation },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: relationships([
          { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
          ...numbers.map((n) => ({ id: `rId${n + 1}`, type: 'slide', target: `slides/slide${n}.xml` })),
          { id: `rId${count + 2}`, type: 'theme', target: 'theme/theme1.xml' },
        ]),
      },
      { name: 'ppt/theme/theme1.xml', data: themeXml(accent) },
      { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml(ink) },
      {
        name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        data: relationships([
          { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
          { id: 'rId2', type: 'slideLayout', target: '../slideLayouts/slideLayout2.xml' },
          { id: 'rId3', type: 'theme', target: '../theme/theme1.xml' },
        ]),
      },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: titleLayoutXml(accent) },
      { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: layoutRels },
      { name: 'ppt/slideLayouts/slideLayout2.xml', data: contentLayoutXml() },
      { name: 'ppt/slideLayouts/_rels/slideLayout2.xml.rels', data: layoutRels },
      ...slides,
      ...media,
    ],
    { date: validDate(doc.takenAt) ?? undefined },
  );
}

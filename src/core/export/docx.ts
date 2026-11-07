// A Word report, written by hand: real heading styles, so the navigation pane and a table of
// contents work, real tables with a repeating header row, and pictures with alt text.

import type { ExportColumn, ExportDocument, ExportFlag, ExportHeadline, ExportTable, ExportTone } from './model.ts';
import {
  accentInk,
  appProps,
  BAD_IMAGE,
  BAD_INK,
  cellText,
  cleanText,
  clip,
  contentTypes,
  coreProps,
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
  packageRels,
  readableImage,
  relationships,
  takenAtWords,
  TONE_FILL,
  validDate,
  xml,
  XML_HEAD,
} from './shared.ts';
import { zip } from './zip.ts';
import type { ZipEntry } from './zip.ts';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 14;
/** More columns than this turns the whole report landscape. */
const PORTRAIT_COLUMNS = 7;

const PAGE_SHORT = 12240;
const PAGE_LONG = 15840;
const PAGE_MARGIN = 1080;
const TWIPS_PER_INCH = 1440;
const EMU_PER_TWIP = 635;

function run(text: string, props = ''): string {
  // A line break inside a run has to be its own element.
  const parts = cleanText(text).replace(/\t/g, ' ').split(/\r\n|\r|\n/);
  const body = parts.map((part, i) => `${i > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(part)}</w:t>`).join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`;
}

function para(text: string, style?: string, runProps = '', paraProps = ''): string {
  const pPr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${paraProps}`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(text, runProps)}</w:p>`;
}

function shade(fill: string): string {
  return `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
}

function tableCell(text: string, width: number, options: { fill?: string; right?: boolean; bold?: boolean; color?: string } = {}): string {
  const runProps = `${options.bold ? '<w:b/>' : ''}${options.color ? `<w:color w:val="${options.color}"/>` : ''}`;
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${options.fill ? shade(options.fill) : ''}</w:tcPr>` +
    para(text, 'TableText', runProps, options.right ? '<w:jc w:val="right"/>' : '') +
    '</w:tc>'
  );
}

function tableOpen(widths: number[]): string {
  const total = widths.reduce((a, b) => a + b, 0);
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="ReportTable"/><w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="0420" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
  );
}

function headerRow(labels: string[], columns: Array<ExportColumn | null>, widths: number[], accent: string): string {
  const cells = labels.map((label, c) => tableCell(label, widths[c]!, { fill: accent, bold: true, color: inkOn(accent), right: !!columns[c]?.numeric }));
  return `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${cells.join('')}</w:tr>`;
}

/** Column widths that share `total` by how much each column has to hold. */
function shareWidths(table: ExportTable, columns: ExportColumn[], total: number): number[] {
  const sample = table.rows.slice(0, 200);
  const need = columns.map((column, c) => Math.min(40, Math.max(6, column.label.length, ...sample.map((r) => cellText(r[c]).length))));
  const sum = need.reduce((a, b) => a + b, 0);
  return need.map((n) => Math.floor((n / sum) * total));
}

function dataTable(table: ExportTable, accent: string, textWidth: number): string {
  const columns = table.columns.slice(0, MAX_TABLE_COLUMNS);
  const rows = table.rows.slice(0, MAX_TABLE_ROWS);
  const widths = shareWidths(table, columns, textWidth);
  const body = rows.map((row) => {
    const cells = columns.map((column, c) => {
      const tone: ExportTone | undefined = row[c]?.tone;
      return tableCell(cellText(row[c]), widths[c]!, { right: column.numeric, ...(tone ? { fill: TONE_FILL[tone] } : {}) });
    });
    return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells.join('')}</w:tr>`;
  });
  const after: string[] = [];
  if (table.rows.length > rows.length) after.push(para(moreRows(table.rows.length - rows.length), 'Small'));
  if (table.columns.length > columns.length) after.push(para(moreColumns(table.columns.length - columns.length), 'Small'));
  if (table.rows.length === 0) after.push(para('The table has no rows.', 'Small'));
  // A paragraph after the table also keeps it apart from any table that follows.
  if (after.length === 0) after.push('<w:p/>');
  return `${tableOpen(widths)}${headerRow(columns.map((c) => c.label), columns, widths, accent)}${body.join('')}</w:tbl>${after.join('')}`;
}

function headlineTable(items: ExportHeadline[], accent: string, textWidth: number): string {
  const widths = [Math.floor(textWidth * 0.45), Math.floor(textWidth * 0.2), Math.floor(textWidth * 0.35)];
  const rows = items.map((h) => {
    const fill = h.tone ? { fill: TONE_FILL[h.tone] } : {};
    return (
      '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
      tableCell(h.label, widths[0]!) +
      tableCell(h.text, widths[1]!, { right: true, bold: true, ...fill }) +
      tableCell(h.change ?? '', widths[2]!) +
      '</w:tr>'
    );
  });
  const labels = ['Measure', 'Value', 'Change'];
  return `${tableOpen(widths)}${headerRow(labels, [null, { label: 'Value', numeric: true }, null], widths, accent)}${rows.join('')}</w:tbl><w:p/>`;
}

function pictureRun(title: string, relId: string, shapeId: number, cx: number, cy: number): string {
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${shapeId}" name="Picture ${shapeId}" descr="${xml(title)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A_NS}"><a:graphicData uri="${PIC_NS}"><pic:pic xmlns:pic="${PIC_NS}"><pic:nvPicPr><pic:cNvPr id="${shapeId}" name="Picture ${shapeId}" descr="${xml(title)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function stylesXml(ink: string): string {
  const heading = (id: string, name: string, level: number, size: number, before: number) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:color w:val="${ink}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return (
    `${XML_HEAD}<w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:color w:val="${ink}"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>` +
    heading('Heading1', 'heading 1', 0, 32, 360) +
    heading('Heading2', 'heading 2', 1, 25, 200) +
    `<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Report Details"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="20"/></w:pPr><w:rPr><w:color w:val="${MUTED_INK}"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small Note"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="60"/></w:pPr><w:rPr><w:i/><w:color w:val="${MUTED_INK}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Problem"><w:name w:val="Problem"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="${BAD_INK}"/></w:rPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="${MUTED_INK}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>` +
    '<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:tblPr><w:tblBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="D9DDE2"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E3E6EA"/></w:tblBorders></w:tblPr></w:style>' +
    '</w:styles>'
  );
}

const NUMBERING =
  `${XML_HEAD}<w:numbering xmlns:w="${W_NS}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum>` +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

const SETTINGS =
  `${XML_HEAD}<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

function footerXml(title: string): string {
  return (
    `${XML_HEAD}<w:ftr xmlns:w="${W_NS}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>` +
    `${run(clip(title, 80))}<w:r><w:t xml:space="preserve">  |  Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`
  );
}

export async function toDocx(doc: ExportDocument): Promise<Uint8Array> {
  const accent = hexColor(doc.accent);
  const ink = accentInk(accent);
  const landscape = doc.flags.some((f) => (flagTable(f)?.columns.length ?? 0) > PORTRAIT_COLUMNS);
  const pageWidth = landscape ? PAGE_LONG : PAGE_SHORT;
  const pageHeight = landscape ? PAGE_SHORT : PAGE_LONG;
  const textWidth = pageWidth - PAGE_MARGIN * 2;
  const media: ZipEntry[] = [];
  const imageRels: Array<{ id: string; type: string; target: string }> = [];

  const body: string[] = [para(doc.title.trim() || 'Report', 'Title')];
  if (doc.brief) body.push(para(doc.brief));
  body.push(para(`Taken at: ${takenAtWords(doc.takenAt)}`, 'Meta'));
  body.push(para(`By: ${doc.by}`, 'Meta'));
  body.push(para(`Filters: ${filtersWords(doc)}`, 'Meta'));
  if (doc.flags.length === 0) body.push(para(NO_FLAGS));

  const flagBody = (flag: ExportFlag): string[] => {
    const out: string[] = [para(flag.title.trim() || 'Untitled flag', 'Heading1')];
    const start = out.length;
    if (flag.error) out.push(para(noAnswer(flag), 'Problem'));
    if (flag.headlines?.length) out.push(headlineTable(flag.headlines, accent, textWidth));
    const image = readableImage(flag.image);
    if (image) {
      const n = media.length + 1;
      const id = `rIdImage${n}`;
      media.push({ name: `word/media/image${n}.png`, data: image.png });
      imageRels.push({ id, type: 'image', target: `media/image${n}.png` });
      const size = fitBox(image.width, image.height, textWidth, 4.5 * TWIPS_PER_INCH);
      out.push(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${pictureRun(flag.title, id, n, Math.round(size.width * EMU_PER_TWIP), Math.round(size.height * EMU_PER_TWIP))}</w:p>`);
    } else if (flag.image) {
      out.push(para(BAD_IMAGE, 'Problem'));
    }
    const data = flagTable(flag);
    if (data) {
      out.push(para('Data', 'Heading2'));
      out.push(dataTable(data, accent, textWidth));
    }
    if (flag.insights.length > 0) {
      out.push(para('Findings', 'Heading2'));
      for (const insight of flag.insights) out.push(para(insight, 'ListBullet'));
    }
    if (flag.text) out.push(...flag.text.split(/\r?\n\r?\n/).map((p) => para(p)));
    if (out.length === start) out.push(para(NOTHING_TO_SHOW, 'Small'));
    return out;
  };
  for (const flag of doc.flags) body.push(...flagBody(flag));

  const section =
    `<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"${landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`;
  const document =
    `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}"><w:body>${body.join('')}${section}</w:body></w:document>`;

  const overrides = [
    { part: '/word/document.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' },
    { part: '/word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
    { part: '/word/numbering.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' },
    { part: '/word/settings.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml' },
    { part: '/word/footer1.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' },
  ];
  return zip(
    [
      { name: '[Content_Types].xml', data: contentTypes(overrides, media.length > 0) },
      { name: '_rels/.rels', data: packageRels('word/document.xml') },
      { name: 'docProps/core.xml', data: coreProps(doc) },
      { name: 'docProps/app.xml', data: appProps() },
      { name: 'word/document.xml', data: document },
      {
        name: 'word/_rels/document.xml.rels',
        data: relationships([
          { id: 'rIdStyles', type: 'styles', target: 'styles.xml' },
          { id: 'rIdNumbering', type: 'numbering', target: 'numbering.xml' },
          { id: 'rIdSettings', type: 'settings', target: 'settings.xml' },
          { id: 'rIdFooter', type: 'footer', target: 'footer1.xml' },
          ...imageRels,
        ]),
      },
      { name: 'word/styles.xml', data: stylesXml(ink) },
      { name: 'word/numbering.xml', data: NUMBERING },
      { name: 'word/settings.xml', data: SETTINGS },
      { name: 'word/footer1.xml', data: footerXml(doc.title) },
      ...media,
    ],
    { date: validDate(doc.takenAt) ?? undefined },
  );
}

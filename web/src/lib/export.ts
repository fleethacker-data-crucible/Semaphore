// Turning a page into files. Everything happens in this browser: the summarised answers go into the
// file and nothing is sent anywhere. Loaded only when someone exports.
//
// Charts in a file are drawn again for paper, in light colours whatever the screen's theme, with the
// page's palette and finish, so the file matches what the analyst designed.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { type FlagStyle, FONT_STACK, type HoistDesign, paletteColors, resolveStyle } from '../../../src/core/design.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { toCsv, flagsToCsvZip } from '../../../src/core/export/csv.ts';
import { toDocx } from '../../../src/core/export/docx.ts';
import { toJson } from '../../../src/core/export/json.ts';
import { type ExportChart, type ExportDocument, type ExportFlag, type ExportHeadline, type ExportImage, type ExportTable, fileStem } from '../../../src/core/export/model.ts';
import { toPdf } from '../../../src/core/export/pdf.ts';
import { toPptx } from '../../../src/core/export/pptx.ts';
import { toXlsx } from '../../../src/core/export/xlsx.ts';
import { type Flag, toneFor } from '../../../src/core/hoist.ts';
import type { FrozenFlag } from '../../../src/core/reports.ts';
import { compressionSupported } from '../../../src/core/export/zip.ts';
import { chartToSvg, loadExtras, loadMap, paperColors } from '../components/Chart.tsx';
import { CHART_KINDS, isRichKind } from '../../../src/core/kinds.ts';
import { chartCategories, flagChartOption, formatDim, gaugeOption } from './chart-option.ts';
import type { FlagResult } from './data.ts';
import { buildPivot, pivotTable } from '../../../src/core/pivot.ts';
import { pivotFields, pivotInput, pivotView } from './pivot-view.ts';

export type FileFormat = 'pdf' | 'xlsx' | 'pptx' | 'docx' | 'csv' | 'json';

const TYPES: Record<FileFormat, { ext: string; type: string }> = {
  pdf: { ext: 'pdf', type: 'application/pdf' },
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { ext: 'pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  docx: { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  csv: { ext: 'zip', type: 'application/zip' },
  json: { ext: 'json', type: 'application/json' },
};

const IMAGE_WIDTH = 1000;

function saveBytes(name: string, bytes: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function svgToPng(svg: string, width: number, height: number, background: string): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('This browser could not draw the chart.');
    g.fillStyle = background;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
    if (!blob) throw new Error('This browser could not draw the chart.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

const hasOwnField = (result: FlagResult) => result.plan.dimensions.some((d) => result.plan.own.includes(d.key));
const isChart = (flag: Flag, result: FlagResult) => CHART_KINDS.includes(flag.kind) && (flag.binding?.metrics.length ?? 0) > 0 && hasOwnField(result);

function imageHeight(flag: Flag): number {
  return Math.max(360, Math.min(620, Math.round((IMAGE_WIDTH * flag.layout.h * 56) / (flag.layout.w * 100))));
}

/**
 * The numbers an editable chart needs, read from what the page draws. A comparison's earlier
 * window is marked `previous` (chart-option.ts draws it second, in grey), and a 100% layout keeps
 * the real numbers with `percent` set, so Excel stacks them to 100% itself.
 */
function chartNumbers(flag: Flag, result: FlagResult, option: Record<string, unknown>, colors: readonly string[], style: FlagStyle): ExportChart | null {
  const series = (option.series ?? []) as Array<Record<string, unknown>>;
  const valueOf = (d: unknown) => {
    const v = typeof d === 'object' && d !== null ? (d as { value?: unknown }).value : d;
    return typeof v === 'number' ? v : null;
  };
  // A combo is an Excel bar and line chart, each series on its own scale, as the page draws it.
  if (flag.kind === 'combo' && series.every((s) => s.type === 'bar' || s.type === 'line')) {
    return {
      type: 'combo',
      ...(series.some((s) => s.stack) ? { stacked: true } : {}),
      categories: ((option.xAxis as { data?: string[] }).data ?? []).slice(),
      series: series.map((s, i) => ({ name: String(s.name ?? ''), values: ((s.data ?? []) as unknown[]).map(valueOf), color: colors[i % colors.length]!, as: s.type as 'bar' | 'line', ...(s.yAxisIndex === 1 ? { axis: 'right' as const } : {}) })),
    };
  }
  // The other richer kinds have no editable Office chart to match, so they travel as the picture and the table.
  if (isRichKind(flag.kind)) return null;
  if (flag.kind === 'pie') {
    const data = (series[0]?.data ?? []) as Array<{ name: string; value: unknown }>;
    return { type: 'pie', categories: data.map((d) => d.name), series: [{ name: flag.title || 'Value', values: data.map(valueOf), color: colors[0]! }] };
  }
  const x = option.xAxis as { type?: string; data?: string[] } | Array<unknown>;
  const horizontal = Array.isArray(x);
  const axis = (horizontal ? option.yAxis : x) as { data?: string[] };
  const ownDims = result.plan.dimensions.filter((d) => result.plan.own.includes(d.key));
  const splitBy = ownDims[1];
  const isLine = flag.kind === 'line' || flag.kind === 'area';
  const percent = !!splitBy && !isLine && style.barLayout === 'percent';
  // Without a second field, the earlier window is the second series (chart-option.ts).
  const previousAt = !splitBy && result.previous ? 1 : -1;
  let paletteAt = 0;
  const out: ExportChart = {
    type: flag.kind as ExportChart['type'],
    ...(horizontal ? { horizontal: true } : {}),
    ...(percent ? { percent: true } : series.some((s) => s.stack) ? { stacked: true } : {}),
    categories: axis.data ?? [],
    series: series.map((s, i) => {
      const previous = i === previousAt;
      const color = previous ? colors[0]! : colors[paletteAt++ % colors.length]!;
      return { name: String(s.name ?? ''), values: ((s.data ?? []) as unknown[]).map(valueOf), color, ...(previous ? { previous: true } : {}) };
    }),
  };
  if (percent) {
    // The page's series hold shares; the file gets the numbers behind them.
    const k = flag.binding!.metrics[0]!;
    const xDim = ownDims[0]!;
    const categories = chartCategories(flag, result);
    for (const s of out.series) {
      s.values = categories.map((cat) => {
        const row = result.display.rows.find((r) => String(r.dims[xDim.key]) === String(cat) && formatDim(r.dims[splitBy.key] ?? null, splitBy.grain) === s.name);
        const v = row?.values[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      });
    }
  }
  return out;
}

function flagTable(flag: Flag, result: FlagResult, index: CatalogIndex): ExportTable | null {
  const b = flag.binding;
  if (!b) return null;
  const dims = result.plan.dimensions.filter((d) => result.plan.own.includes(d.key));
  const k0 = b.metrics[0];
  const fmt = (k: string) => index.metric(k)?.format;
  const columns: ExportTable['columns'] = [
    ...dims.map((d) => ({ label: `${index.field(d.field)?.label ?? d.field}${d.grain ? ` (${d.grain})` : ''}`, numeric: false })),
    ...b.metrics.map((k) => {
      const format = fmt(k);
      return { label: index.metric(k)?.label ?? k, numeric: true, ...(format ? { format } : {}) };
    }),
    ...(b.share && k0 ? [{ label: 'Share', numeric: true, format: 'percent' as const }] : []),
    ...(result.previous && k0 ? [{ label: 'Change', numeric: true, format: 'percent' as const }] : []),
  ];
  const rows = result.display.rows.map((r, i) => {
    const now = k0 ? r.values[k0] : undefined;
    const before = k0 ? result.previous?.[i]?.[k0] : undefined;
    const change = typeof now === 'number' && typeof before === 'number' && before !== 0 ? (now - before) / Math.abs(before) : null;
    const total = k0 ? result.display.totals[k0] : undefined;
    const part = typeof now === 'number' && typeof total === 'number' && total ? now / total : null;
    return [
      ...dims.map((d) => {
        const v = r.dims[d.key] ?? null;
        return { text: formatDim(v, d.grain), value: v };
      }),
      ...b.metrics.map((k) => {
        const v = r.values[k] ?? null;
        const tone = typeof v === 'number' ? toneFor(flag.behavior, k, v) : null;
        return { text: formatNumber(v, fmt(k)), value: v, ...(tone ? { tone } : {}) };
      }),
      ...(b.share && k0 ? [{ text: formatNumber(part, 'percent'), value: part }] : []),
      ...(result.previous && k0 ? [{ text: change === null ? '–' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`, value: change }] : []),
    ];
  });
  return { columns, rows };
}

function headlines(flag: Flag, result: FlagResult, index: CatalogIndex): ExportHeadline[] {
  const row = result.display.rows[0];
  return (flag.binding?.metrics ?? []).map((k, i) => {
    const v = row?.values[k] ?? null;
    const n = typeof v === 'number' ? v : null;
    const tone = n === null ? null : toneFor(flag.behavior, k, n);
    const before = i === 0 ? result.previous?.[0]?.[k] : undefined;
    const change = n !== null && typeof before === 'number' && before !== 0 ? (n - before) / Math.abs(before) : null;
    const format = index.metric(k)?.format;
    return {
      label: index.metric(k)?.label ?? k,
      text: formatNumber(v, format),
      value: n,
      ...(format ? { format } : {}),
      ...(tone ? { tone } : {}),
      ...(change === null ? {} : { change: `${change >= 0 ? '+' : ''}${Math.round(change * 100)}% vs ${flag.binding?.compare === 'previous-year' ? 'a year earlier' : 'previous period'}` }),
    };
  });
}

/**
 * A pivot flag as its pivoted grid: rows in the order the page shows them (a header click there
 * counts), every group open with its subtotal, the total column and the grand total row.
 */
export function pivotExport(flag: Flag, result: FlagResult, index: CatalogIndex): ExportTable {
  const input = { ...pivotInput(flag, result, index, pivotView(flag.id)), collapsed: new Set<string>(), maxRows: 100_000 };
  const f = pivotFields(result);
  const dims = new Map([...f.rows, ...(f.column ? [f.column] : [])].map((d) => [d.key, d]));
  const t = pivotTable(buildPivot(input), input, {
    dim: (key, v) => formatDim(v, dims.get(key)?.grain as Parameters<typeof formatDim>[1]),
    num: (m, v, share) => formatNumber(v, share ? 'percent' : index.metric(m)?.format),
    fieldLabel: (key) => {
      const d = dims.get(key);
      return d ? `${index.field(d.field)?.label ?? d.field}${d.grain ? ` (${d.grain})` : ''}` : key;
    },
    measureLabel: (m) => index.metric(m)?.label ?? m,
  });
  return {
    columns: t.columns.map((c) => {
      const format = c.share ? 'percent' : c.measure ? index.metric(c.measure)?.format : undefined;
      return { label: c.label, numeric: c.numeric, ...(format ? { format } : {}) };
    }),
    rows: t.rows,
  };
}

/** One flag's answer, ready for any format. */
export async function exportFlagOf(frozen: Pick<FrozenFlag, 'flag' | 'error'> & { result: unknown; insights: ReadonlyArray<{ text: string }> }, index: CatalogIndex, design: HoistDesign | undefined): Promise<ExportFlag> {
  const { flag } = frozen;
  const out: ExportFlag = { id: flag.id, title: flag.title || 'Untitled flag', kind: flag.kind, table: null, image: null, chart: null, insights: frozen.insights.map((i) => i.text) };
  if (frozen.error) out.error = frozen.error;
  if (flag.kind === 'text') {
    out.text = flag.text || flag.brief;
    return out;
  }
  const result = frozen.result as FlagResult | null;
  if (flag.kind === 'model') return exportModel(out, flag, result, index, design);
  if (!result) {
    out.error ??= 'This flag has no answer.';
    return out;
  }
  if (flag.kind === 'pivot' && result.plan.own.length && flag.binding?.metrics.length) {
    out.table = pivotExport(flag, result, index);
    return out;
  }
  if (flag.kind === 'custom') return exportCustom(out, flag, result, index);
  const style = resolveStyle(design, flag.style);
  const c = paperColors();
  const colors = paletteColors(style, 'light', c.series);
  const font = design?.font ? { fontFamily: FONT_STACK[design.font] } : {};
  const draw = async (option: Record<string, unknown>, width: number, height: number): Promise<ExportImage> => {
    const svg = await chartToSvg(option, width, height);
    return { png: await svgToPng(svg, width, height, c.panel), width: width * 2, height: height * 2, svg };
  };
  if (isChart(flag, result)) {
    if (isRichKind(flag.kind)) await loadExtras();
    if (flag.kind === 'map') await loadMap(style.map ?? 'us-states');
    const option = flagChartOption({ flag, result, index, selections: {}, style: { ...style, zoom: false }, c, colors, ...font });
    out.image = await draw(option, IMAGE_WIDTH, imageHeight(flag));
    out.chart = chartNumbers(flag, result, option, colors, style);
    out.table = flagTable(flag, result, index);
    return out;
  }
  if (flag.kind === 'table') {
    out.table = flagTable(flag, result, index);
    return out;
  }
  out.headlines = headlines(flag, result, index);
  out.table = flagTable(flag, result, index);
  const first = out.headlines[0];
  if (flag.kind === 'kpi' && style.kpiForm === 'gauge' && style.gaugeMax && first?.value !== null && first) {
    out.image = await draw(gaugeOption({ value: first.value!, max: style.gaugeMax, color: first.tone ? c[first.tone] : colors[0]!, c, text: first.text, ...font }), 500, 300);
  }
  return out;
}

export interface DocumentInput {
  title: string;
  brief: string;
  by: string;
  filters: string[];
  flags: readonly FrozenFlag[];
  index: CatalogIndex;
  design: HoistDesign | undefined;
}

export async function buildDocument(input: DocumentInput): Promise<ExportDocument> {
  const flags: ExportFlag[] = [];
  // A picker is a control for the page, not an answer.
  for (const f of input.flags) if (f.flag.kind !== 'filter') flags.push(await exportFlagOf(f, input.index, input.design));
  const now = new Date();
  // takenAt is the exact moment for machines (UTC); takenAtText is the same moment in the reader's own zone and format.
  return { title: input.title || 'Semaphore report', brief: input.brief, takenAt: now.toISOString(), takenAtText: now.toLocaleString(), by: input.by, filters: input.filters, accent: paperColors().accent, flags };
}

/**
 * A line for the person when this browser cannot compress: the files still come out, stored rather
 * than deflated, so they are larger. Null when nothing needs saying.
 */
export function compressionWarning(userAgent = navigator.userAgent): string | null {
  if (compressionSupported) return null;
  const m = /(Edg|Chrome|Firefox)\/(\d+)/.exec(userAgent);
  const browser = m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'This browser';
  return `${browser} cannot compress files, so exports are saved uncompressed and are larger than usual. Updating the browser fixes this.`;
}

/** Writes the file and starts the download. Returns the file's name. */
export async function saveDocument(format: FileFormat, doc: ExportDocument): Promise<string> {
  const { ext, type } = TYPES[format];
  const bytes = format === 'pdf' ? await toPdf(doc) : format === 'xlsx' ? await toXlsx(doc) : format === 'pptx' ? await toPptx(doc) : format === 'docx' ? await toDocx(doc) : format === 'csv' ? await flagsToCsvZip(doc) : toJson(doc);
  const name = `${fileStem(doc.title)}-${doc.takenAt.slice(0, 10)}.${ext}`;
  saveBytes(name, bytes, type);
  return name;
}

/** One flag on its own, as it stands on the page now. */
export async function saveFlag(format: 'png' | 'svg' | 'csv', flag: ExportFlag): Promise<string> {
  const stem = fileStem(flag.title, 'flag');
  if (format === 'csv') {
    if (!flag.table) throw new Error('This flag has no table of numbers to save.');
    saveBytes(`${stem}.csv`, toCsv(flag.table, { bom: true }), 'text/csv;charset=utf-8');
    return `${stem}.csv`;
  }
  if (!flag.image) throw new Error('This flag has no chart to save.');
  if (format === 'svg') saveBytes(`${stem}.svg`, flag.image.svg ?? '', 'image/svg+xml');
  else saveBytes(`${stem}.png`, flag.image.png, 'image/png');
  return `${stem}.${format}`;
}

/**
 * A custom widget travels as its table and, when its frame is drawing on the page now, as the
 * picture the frame hands back (ECharts getDataURL, or the widget's own SVG). Its code never runs here.
 */
async function exportCustom(out: ExportFlag, flag: Flag, result: FlagResult, index: CatalogIndex): Promise<ExportFlag> {
  out.table = flagTable(flag, result, index);
  const { widgetPicture } = await import('./widget-bus.ts');
  const pic = await widgetPicture(flag.id);
  if (pic) {
    try {
      out.image = await pictureImage(pic.url, Math.max(1, pic.width), Math.max(1, pic.height));
    } catch {
      /* the table alone */
    }
  }
  return out;
}

/** A data: URL from a widget frame as export PNG bytes (and the SVG, when it was one). */
async function pictureImage(url: string, width: number, height: number): Promise<ExportImage> {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (head.startsWith('data:image/svg+xml')) {
    const svg = head.endsWith(';base64') ? atob(body) : decodeURIComponent(body);
    return { png: await svgToPng(svg, width, height, paperColors().panel), width: width * 2, height: height * 2, svg };
  }
  // A PNG at twice the frame's size (the frame draws it with pixelRatio 2).
  const bin = atob(body);
  const png = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i);
  return { png, width: width * 2, height: height * 2 };
}

/**
 * A model flag: the model runs again (from the cache when the page already ran it) and travels as
 * its chart, its table, and its answer in words.
 */
async function exportModel(out: ExportFlag, flag: Flag, result: FlagResult | null, index: CatalogIndex, design: HoistDesign | undefined): Promise<ExportFlag> {
  if (!flag.model) {
    out.error ??= 'No model is chosen for this flag.';
    return out;
  }
  const [{ predict, modelData, modelContext }, { modelChartOption }, { fmt }] = await Promise.all([import('./predict.ts'), import('./model-chart.ts'), import('../../../src/core/predict/format.ts')]);
  const answer = await predict(modelData(flag, result ?? undefined, index), flag.model, modelContext(flag, new Date()));
  if (!answer.ok) {
    out.error = answer.error;
    return out;
  }
  const o = answer.output;
  const metricFormat = flag.binding?.metrics[0] ? index.metric(flag.binding.metrics[0])?.format : undefined;
  out.text = [o.headline, ...o.stats.map((s) => `${s.label}: ${typeof s.value === 'number' ? fmt(s.value, s.format ?? 'decimal', metricFormat) : (s.value ?? '–')}`), ...o.sentences, ...o.notes].join('\n');
  out.table = {
    columns: o.table.columns.map((label, j) => ({ label, numeric: o.table.rows.some((r) => typeof r[j] === 'number') })),
    rows: o.table.rows.map((r) => r.map((v) => ({ text: typeof v === 'number' ? fmt(v, 'decimal') : (v ?? '–'), value: v }))),
  };
  if (o.chart) {
    await loadExtras();
    const style = resolveStyle(design, flag.style);
    const c = paperColors();
    const option = modelChartOption({ chart: o.chart, c, colors: paletteColors(style, 'light', c.series), ...(metricFormat ? { metricFormat } : {}), ...(design?.font ? { fontFamily: FONT_STACK[design.font] } : {}) });
    const height = imageHeight(flag);
    const svg = await chartToSvg({ ...option, animation: false }, IMAGE_WIDTH, height);
    out.image = { png: await svgToPng(svg, IMAGE_WIDTH, height, c.panel), width: IMAGE_WIDTH * 2, height: height * 2, svg };
  }
  return out;
}

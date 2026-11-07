// What an export is made from. The page turns a hoist's frozen results into this plain document
// (web/src/lib/export-document.ts), and every writer in this folder reads only this: no DOM, no
// catalog, no chart library. It holds the summarised answers on the page, never source rows.

export type ExportTone = 'good' | 'warn' | 'bad';
export type ExportNumberFormat = 'number' | 'currency' | 'percent';

export interface ExportCell {
  /** As the page shows it: "$1.2M", "Jan 2026", "(blank)". */
  text: string;
  /** The value underneath, for formats that keep numbers as numbers. */
  value: string | number | boolean | null;
  /** The colour rule this value breaks, if any. */
  tone?: ExportTone;
}

export interface ExportColumn {
  label: string;
  numeric: boolean;
  format?: ExportNumberFormat;
}

export interface ExportTable {
  columns: ExportColumn[];
  rows: ExportCell[][];
}

/** A picture of the chart as the page draws it. */
export interface ExportImage {
  /** PNG bytes. */
  png: Uint8Array;
  /** Pixels, already at export resolution. */
  width: number;
  height: number;
  /** The same chart as an SVG document, for formats that can use it. */
  svg?: string;
}

/** The chart's numbers, for formats that can draw a native, editable chart. */
export interface ExportChart {
  type: 'bar' | 'line' | 'area' | 'pie';
  horizontal?: boolean;
  stacked?: boolean;
  categories: string[];
  series: Array<{ name: string; values: Array<number | null>; color: string }>;
}

export interface ExportHeadline {
  label: string;
  /** Formatted: "$1.2M". */
  text: string;
  value: number | null;
  tone?: ExportTone;
  /** "+12% vs previous period". */
  change?: string;
}

export interface ExportFlag {
  id: string;
  title: string;
  kind: string;
  /** Set for KPI flags. */
  headlines?: ExportHeadline[];
  /** Set for notes. */
  text?: string;
  table: ExportTable | null;
  image: ExportImage | null;
  chart: ExportChart | null;
  /** Findings worth a look, as sentences. */
  insights: string[];
  /** Why this flag has no answer. */
  error?: string;
}

export interface ExportDocument {
  title: string;
  brief: string;
  /** ISO time the numbers were taken. */
  takenAt: string;
  by: string;
  /** Page filters and selections in words: "Region is East". */
  filters: string[];
  /** Hex, for headings and rules in the file. */
  accent: string;
  flags: ExportFlag[];
}

/** A safe file name stem: lower case, hyphens, never empty. */
export function fileStem(title: string, fallback = 'semaphore-report'): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || fallback;
}

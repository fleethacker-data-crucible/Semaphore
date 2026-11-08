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
  /** 'combo': bars and lines together; each series says which it is and which scale it is on. */
  type: 'bar' | 'line' | 'area' | 'pie' | 'combo';
  horizontal?: boolean;
  stacked?: boolean;
  /** Stacked to 100%: the values are the real numbers, and the chart shows each as a share of its stack. */
  percent?: boolean;
  categories: string[];
  series: Array<{
    name: string;
    values: Array<number | null>;
    color: string;
    /** The earlier window of a comparison: drawn in grey, not a palette colour. */
    previous?: boolean;
    /** Combo charts: drawn as bars or a line (bars when left out). */
    as?: 'bar' | 'line';
    /** Combo charts: on the second scale, at the right. */
    axis?: 'right';
  }>;
}

export interface ExportHeadline {
  label: string;
  /** Formatted: "$1.2M". */
  text: string;
  value: number | null;
  format?: ExportNumberFormat;
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
  /** The same time in the reader's own words and zone ("07/11/2026, 14:05:00"); the writers prefer it when set. */
  takenAtText?: string;
  by: string;
  /** Page filters and selections in words: "Region is East". */
  filters: string[];
  /** Hex, for headings and rules in the file. */
  accent: string;
  flags: ExportFlag[];
}

/** Names Windows keeps for devices, which it refuses as file names whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A safe file name stem: lower case, letters and digits in any script, hyphens, never empty. */
export function fileStem(title: string, fallback = 'semaphore-report'): string {
  const stem = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!stem) return fallback;
  return RESERVED_NAMES.test(stem) ? `${stem}-file` : stem;
}

// Turning a flag's rows into what models read: a time series in date order, labelled points, or a
// table of measures per item. Shared so every model reads rows the same way and says the same thing
// when the data does not fit.

import type { Cell } from '../crossfilter.ts';
import type { TimeGrain } from '../hoist.ts';
import { type ModelData, ModelError } from './types.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function cellLabel(v: Cell, grain?: TimeGrain): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (!grain) return String(v);
  const s = String(v);
  const y = s.slice(0, 4);
  const m = Number(s.slice(5, 7));
  if (grain === 'year') return y;
  if (grain === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (grain === 'week') return `Wk of ${s.slice(5, 10)}`;
  return s.slice(0, 10);
}

export interface Series {
  /** Period starts, YYYY-MM-DD, in order. */
  dates: string[];
  /** Labels for the axis ("Mar 2026"). */
  labels: string[];
  /** Values; periods missing inside the range are null. */
  values: Array<number | null>;
  grain: TimeGrain | undefined;
  metricLabel: string;
  metricFormat?: 'number' | 'currency' | 'percent';
}

/**
 * A measure along the first field, in date order, with missing periods filled as null. Rows that
 * share a period (a second field) are added up. Throws a ModelError with fewer than `min` numbers.
 */
export function timeSeries(data: ModelData, min = 4, metricIndex = 0): Series {
  const d = data.dims[0];
  const m = data.metrics[metricIndex];
  if (!d || !m) throw new ModelError('This model needs a date field and a measure.');
  const rows = data.rows
    .map((r) => ({ at: r.dims[0] ?? null, v: r.values[metricIndex] ?? null }))
    .filter((r) => r.at !== null && r.at !== '')
    .sort((a, b) => (String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0));
  const merged: Array<{ at: string; v: number | null }> = [];
  for (const r of rows) {
    const at = d.isDate ? String(r.at).slice(0, 10) : String(r.at);
    const last = merged.at(-1);
    if (last && last.at === at) last.v = last.v === null ? r.v : r.v === null ? last.v : last.v + r.v;
    else merged.push({ at, v: r.v });
  }
  const filled = d.grain ? fillGaps(merged, d.grain) : merged;
  const count = filled.filter((r) => typeof r.v === 'number').length;
  if (count < min) throw new ModelError(`This model needs at least ${min} ${d.grain ? `${d.grain}s` : 'values'} with numbers; this flag has ${count}.`);
  return { dates: filled.map((r) => r.at), labels: filled.map((r) => cellLabel(r.at, d.grain)), values: filled.map((r) => r.v), grain: d.grain, metricLabel: m.label, ...(m.format ? { metricFormat: m.format } : {}) };
}

/** Adds the missing periods between the first and the last as null, so seasons line up. */
export function fillGaps(rows: Array<{ at: string; v: number | null }>, grain: TimeGrain): Array<{ at: string; v: number | null }> {
  if (rows.length < 2) return rows;
  const have = new Map(rows.map((r) => [r.at, r.v]));
  const out: Array<{ at: string; v: number | null }> = [];
  let at = rows[0]!.at;
  const end = rows.at(-1)!.at;
  for (let guard = 0; at <= end && guard < 100000; guard++) {
    out.push({ at, v: have.has(at) ? (have.get(at) ?? null) : null });
    at = nextPeriod(at, grain);
  }
  // Dates not on period starts would be lost: keep the rows as they were.
  const kept = out.filter((r) => r.v !== null).length;
  return kept >= rows.filter((r) => r.v !== null).length ? out : rows;
}

/** The start of the period `steps` after `at`. */
export function nextPeriod(at: string, grain: TimeGrain, steps = 1): string {
  const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return at;
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + steps);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7 * steps);
  else if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + steps);
  else if (grain === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * steps);
  else d.setUTCFullYear(d.getUTCFullYear() + steps);
  return d.toISOString().slice(0, 10);
}

/** Dates and labels for `h` periods after the series ends. */
export function futureLabels(series: Series, h: number): { dates: string[]; labels: string[] } {
  const last = series.dates.at(-1) ?? '';
  const dates: string[] = [];
  for (let i = 1; i <= h; i++) dates.push(series.grain ? nextPeriod(last, series.grain, i) : `+${i}`);
  return { dates, labels: dates.map((d) => (series.grain ? cellLabel(d, series.grain) : d)) };
}

/** The season length a grain implies: 12 months, 4 quarters, 52 weeks, 7 days; years have none. */
export function seasonFor(grain: TimeGrain | undefined): number {
  return grain === 'month' ? 12 : grain === 'quarter' ? 4 : grain === 'week' ? 52 : grain === 'day' ? 7 : 0;
}

/** Linear interpolation over gaps inside the series; the ends take the nearest value. */
export function interpolate(values: ReadonlyArray<number | null>): number[] {
  const out = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN));
  const known: number[] = [];
  out.forEach((v, i) => {
    if (!Number.isNaN(v)) known.push(i);
  });
  if (!known.length) return out.map(() => 0);
  let k = 0;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i]!)) continue;
    while (k < known.length && known[k]! < i) k++;
    const next = known[k];
    const prev = k > 0 ? known[k - 1] : undefined;
    if (prev === undefined) out[i] = out[next!]!;
    else if (next === undefined) out[i] = out[prev]!;
    else out[i] = out[prev]! + ((out[next]! - out[prev]!) * (i - prev)) / (next - prev);
  }
  return out;
}

/** One labelled item per row with its measures (drivers, clusters, inputs, survival). */
export interface Items {
  labels: string[];
  /** values[i][j]: row i, measure j. Rows with a blank measure are left out and counted. */
  values: number[][];
  dropped: number;
  metricLabels: string[];
}

export function items(data: ModelData, minRows: number, minMetrics = 1): Items {
  if (data.metrics.length < minMetrics) throw new ModelError(`This model needs at least ${minMetrics} measure${minMetrics > 1 ? 's' : ''}; this flag has ${data.metrics.length}.`);
  const labels: string[] = [];
  const values: number[][] = [];
  let dropped = 0;
  for (const r of data.rows) {
    if (r.values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      dropped++;
      continue;
    }
    labels.push(data.dims.length ? r.dims.map((c, i) => cellLabel(c, data.dims[i]?.grain)).join(' · ') : `Row ${labels.length + 1}`);
    values.push(r.values as number[]);
  }
  if (values.length < minRows) throw new ModelError(`This model needs at least ${minRows} rows with every measure filled in; this flag has ${values.length}.`);
  return { labels, values, dropped, metricLabels: data.metrics.map((m) => m.label) };
}

/** The caution for rows left out because a measure was blank. */
export function droppedNote(n: number): string[] {
  return n > 0 ? [`${n} row${n === 1 ? ' was' : 's were'} left out because a measure was blank.`] : [];
}

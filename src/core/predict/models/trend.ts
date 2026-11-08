// Trend line: a polynomial of degree 1 to 3 fitted by ordinary least squares on the period number,
// extended `horizon` periods with prediction intervals from Student's t. The period number is
// centred and scaled to [-1, 1] before the powers are taken so the cubic stays well conditioned.
//
// Also home to the small helpers the forecasting models share (chart and table layout, the period
// word, the forecast headline), so every forecast card reads the same way.

import { fmt } from '../format.ts';
import { leastSquares } from '../linalg.ts';
import { mean, tInv, tPValue } from '../stats.ts';
import { futureLabels, type Series, timeSeries } from '../data.ts';
import { type ModelChart, ModelError, type ModelOutput, type ModelRunner, type ModelSpec, numParam } from '../types.ts';

// ---- shared forecasting helpers --------------------------------------------------------------

/** The interval level setting (a string like '0.9'), as a number. */
export const levelOf = (spec: ModelSpec): number => numParam(spec, 'level', 0.9, 0.5, 0.999);

/** "month", "quarter"... or "period" when the series has no grain. */
export const periodWord = (s: Series): string => s.grain ?? 'period';

export const metricFmt = (s: Series) => (n: number | null | undefined) => fmt(n, 'metric', s.metricFormat);

export interface ForecastLayout {
  series: Series;
  /** History values as plotted (gaps may be null). */
  actual: ReadonlyArray<number | null>;
  /** In-sample fit, same length as history; null where there is none. */
  fit: ReadonlyArray<number | null>;
  forecast: ArrayLike<number>;
  lower: ArrayLike<number>;
  upper: ArrayLike<number>;
  level: number;
  fitName?: string;
}

/**
 * The forecast chart and table, by the shared convention: x is the history labels then the future
 * labels; the forecast line is null over history except the last point, which repeats the last
 * actual so the lines join; the band is null over history.
 */
export function forecastChart(p: ForecastLayout): { chart: ModelChart; table: ModelOutput['table']; future: string[] } {
  const n = p.actual.length;
  const h = p.forecast.length;
  const future = futureLabels(p.series, h).labels;
  const x = [...p.series.labels, ...future];
  const nulls = (k: number) => new Array<number | null>(k).fill(null);
  let lastActual: number | null = null;
  for (let i = n - 1; i >= 0 && lastActual === null; i--) lastActual = p.actual[i] ?? null;
  if (lastActual === null) lastActual = p.fit[n - 1] ?? null;
  const fc = Array.from(p.forecast);
  const forecastLine = [...nulls(n - 1), lastActual, ...fc];
  const lower = [...nulls(n), ...Array.from(p.lower)];
  const upper = [...nulls(n), ...Array.from(p.upper)];
  const lvl = `${Math.round(p.level * 100)}%`;
  const chart: ModelChart = {
    kind: 'series',
    x,
    series: [
      { name: p.series.metricLabel, values: [...p.actual, ...nulls(h)], role: 'actual' },
      { name: p.fitName ?? 'Fit', values: [...p.fit, ...nulls(h)], role: 'fit' },
      { name: 'Forecast', values: forecastLine, role: 'forecast' },
    ],
    band: { name: `${lvl} interval`, lower, upper },
    yFormat: 'metric',
  };
  const rows: Array<Array<string | number | null>> = [];
  for (let i = 0; i < n; i++) rows.push([p.series.labels[i]!, p.actual[i] ?? null, round6(p.fit[i] ?? null), null, null, null]);
  for (let j = 0; j < h; j++) rows.push([future[j]!, null, null, round6(fc[j]!), round6(p.lower[j]!), round6(p.upper[j]!)]);
  return { chart, table: { columns: ['Period', p.series.metricLabel, p.fitName ?? 'Fit', 'Forecast', `Lower (${lvl})`, `Upper (${lvl})`], rows }, future };
}

const round6 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(10)));

/** "Cost is forecast to reach $1.2M by Mar 2027 (90% range $1.0M to $1.4M), up 8% on the latest $1.1M." */
export function forecastHeadline(s: Series, value: number, lo: number, hi: number, level: number, when: string, last: number): string {
  const f = metricFmt(s);
  const change = last !== 0 ? (value - last) / Math.abs(last) : Number.NaN;
  const dir = !Number.isFinite(change) ? '' : Math.abs(change) < 0.005 ? `, about level with the latest ${f(last)}` : `, ${change > 0 ? 'up' : 'down'} ${fmt(Math.abs(change), 'percent')} on the latest ${f(last)}`;
  return `${s.metricLabel} is forecast to reach ${f(value)} by ${when} (${Math.round(level * 100)}% range ${f(lo)} to ${f(hi)})${dir}.`;
}

/** The last number in a history, for "up 8% on the latest". */
export function lastNumber(values: ReadonlyArray<number | null>): number {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return Number.NaN;
}

/** The note for gaps filled by linear interpolation. */
export function gapNote(values: ReadonlyArray<number | null>): string[] {
  const gaps = values.filter((v) => typeof v !== 'number' || !Number.isFinite(v)).length;
  return gaps ? [`${gaps} missing period${gaps === 1 ? ' was' : 's were'} filled in by straight-line interpolation before fitting.`] : [];
}

// ---- trend line ------------------------------------------------------------------------------

/** Ordinary least squares polynomial trend (Gauss–Markov), with t-based prediction intervals. */
export const runTrend: ModelRunner = (data, spec) => {
  const degree = Math.round(numParam(spec, 'degree', 1, 1, 3));
  const horizon = Math.round(numParam(spec, 'horizon', 6, 1, 120));
  const level = levelOf(spec);
  const s = timeSeries(data, degree + 3);
  const n = s.values.length;
  const notes: string[] = [];

  // Centre and scale the period number: x = (t − c) / r maps the history onto [-1, 1].
  const c = (n - 1) / 2;
  const r = Math.max(1, (n - 1) / 2);
  const row = (t: number) => {
    const x = (t - c) / r;
    const out = [1];
    for (let k = 1; k <= degree; k++) out.push(x ** k);
    return out;
  };
  const idx: number[] = [];
  const ys: number[] = [];
  s.values.forEach((v, t) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      idx.push(t);
      ys.push(v);
    }
  });
  const m = ys.length;
  const p = degree + 1;
  const df = m - p;
  if (df < 2) throw new ModelError(`A degree-${degree} trend needs at least ${p + 2} periods with numbers; this flag has ${m}.`);
  const missing = n - m;
  if (missing) notes.push(`${missing} period${missing === 1 ? ' has' : 's have'} no value and ${missing === 1 ? 'was' : 'were'} left out of the fit.`);

  let ls;
  try {
    ls = leastSquares(idx.map(row), ys);
  } catch {
    throw new ModelError('The trend could not be fitted: the periods with values are too few or too bunched together for this shape.');
  }
  const sigma2 = ls.rss / df;
  const sigma = Math.sqrt(Math.max(0, sigma2));
  const tq = tInv(0.5 + level / 2, df);
  const predict = (t: number) => {
    const xr = row(t);
    let yhat = 0;
    for (let j = 0; j < p; j++) yhat += xr[j]! * ls.beta[j]!;
    // Var(y_new − ŷ) = σ² (1 + x' (X'X)⁻¹ x): the prediction interval for a new period.
    let q = 0;
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) q += xr[a]! * ls.xtxInv[a]![b]! * xr[b]!;
    const half = tq * sigma * Math.sqrt(1 + Math.max(0, q));
    return { yhat, lo: yhat - half, hi: yhat + half };
  };

  const fit = s.values.map((_, t) => predict(t).yhat);
  const fc = new Float64Array(horizon);
  const lo = new Float64Array(horizon);
  const hi = new Float64Array(horizon);
  for (let j = 0; j < horizon; j++) {
    const pr = predict(n + j);
    fc[j] = pr.yhat;
    lo[j] = pr.lo;
    hi[j] = pr.hi;
  }

  // Slope per period: the derivative of the fitted curve at the last period, back on the period scale.
  const xLast = (n - 1 - c) / r;
  let slope = 0;
  for (let k = 1; k <= degree; k++) slope += (k * ls.beta[k]! * xLast ** (k - 1)) / r;
  const ybar = mean(ys);
  let tss = 0;
  for (const y of ys) tss += (y - ybar) ** 2;
  const r2 = tss > 0 ? Math.max(0, 1 - ls.rss / tss) : 1;

  const { chart, table, future } = forecastChart({ series: s, actual: s.values, fit, forecast: fc, lower: lo, upper: hi, level, fitName: 'Trend' });
  const f = metricFmt(s);
  const word = periodWord(s);
  const when = future[horizon - 1]!;
  const scale = Math.max(Math.abs(ybar), sigma, 1e-12);
  const flat = Math.abs(slope) * n < 1e-9 * scale;
  const pSlope = degree === 1 && sigma > 0 ? tPValue(ls.beta[1]! / Math.sqrt(sigma2 * ls.xtxInv[1]![1]!), df) : 0;
  const dir = flat ? 'is flat' : `is ${slope > 0 ? 'rising' : 'falling'} by about ${f(Math.abs(slope))} a ${word}`;
  const headline = `${s.metricLabel} ${dir}${degree > 1 && !flat ? ' at the latest period' : ''}; on this ${degree === 1 ? 'line' : 'curve'} it reaches ${f(fc[horizon - 1]!)} by ${when} (${Math.round(level * 100)}% range ${f(lo[horizon - 1]!)} to ${f(hi[horizon - 1]!)}).`;
  const sentences = [
    `The ${degree === 1 ? 'straight line' : degree === 2 ? 'quadratic curve' : 'cubic curve'} explains ${fmt(r2, 'percent')} of the ups and downs (R²); the rest is scatter around it.`,
    `A typical period lands within about ${f(sigma)} of the ${degree === 1 ? 'line' : 'curve'} (the residual standard deviation).`,
  ];
  if (degree === 1 && sigma > 0) sentences.push(pSlope < 0.05 ? `The slope is clear of the noise (p = ${fmt(pSlope, 'decimal')}), so the direction is unlikely to be chance.` : `The slope is not clear of the noise (p = ${fmt(pSlope, 'decimal')}): the series may not really be moving.`);
  if (degree > 1) {
    sentences.push('Curves bend sharply once they leave the data: treat the far end of the forecast with caution.');
    notes.push(`A degree-${degree} polynomial can swing far outside the history when extended; check it against a straight line.`);
  }
  if (m < 8) notes.push(`Only ${m} periods: the trend and its band are rough.`);
  notes.push('The band assumes the scatter around the trend is steady and independent from period to period.');

  return {
    model: 'trend',
    headline,
    sentences,
    stats: [
      { label: `Change per ${word}`, value: slope, format: 'metric', hint: degree === 1 ? 'The slope of the line.' : 'The slope of the curve at the latest period.' },
      { label: 'R²', value: r2, format: 'percent', hint: 'The share of the variation the trend explains.' },
      { label: `Forecast, ${when}`, value: fc[horizon - 1]!, format: 'metric', hint: `The trend value ${horizon} ${word}${horizon === 1 ? '' : 's'} ahead.` },
      { label: 'Typical scatter', value: sigma, format: 'metric', hint: 'Residual standard deviation around the trend.' },
    ],
    chart,
    table,
    notes,
  };
};

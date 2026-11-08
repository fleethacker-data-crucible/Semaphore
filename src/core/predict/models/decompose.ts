// Seasonal decomposition: the series split into trend, season and remainder.
// - Classical decomposition (FPP3 §3.4): a centred moving average for the trend, the average
//   detrended value at each position in the season, and what is left over.
// - STL (Cleveland, Cleveland, McRae and Terpenning 1990, "STL: A Seasonal-Trend Decomposition
//   Procedure Based on Loess"): an inner loop of cycle-subseries loess, a low-pass filter and a trend
//   loess, inside outer robustness iterations with bisquare weights. Window choices follow the
//   paper and R's stl() defaults (seasonal degree 0, trend and low-pass degree 1).
// Multiplicative forms divide instead of subtract (classical) or decompose the logarithms (STL), so
// trend × season × remainder gives back the observed values exactly.

import { gapNote, metricFmt } from './trend.ts';
import { interpolate, seasonFor, timeSeries } from '../data.ts';
import { fmt } from '../format.ts';
import { median, variance } from '../stats.ts';
import { ModelError, type ModelRunner, numParam, param } from '../types.ts';

/** Centred moving average of order m (a 2×m average when m is even); null where it does not reach. */
export function centredMA(y: ArrayLike<number>, m: number): Array<number | null> {
  const n = y.length;
  const out = new Array<number | null>(n).fill(null);
  const half = Math.floor(m / 2);
  for (let t = half; t < n - half; t++) {
    let s = 0;
    if (m % 2 === 1) {
      for (let j = -half; j <= half; j++) s += y[t + j]!;
      out[t] = s / m;
    } else {
      for (let j = -half + 1; j <= half - 1; j++) s += y[t + j]!;
      s += 0.5 * (y[t - half]! + y[t + half]!);
      out[t] = s / m;
    }
  }
  return out;
}

export interface Decomposition {
  trend: Array<number | null>;
  seasonal: number[];
  remainder: Array<number | null>;
}

/** Classical decomposition (additive: y = T + S + R; multiplicative: y = T · S · R). */
export function classical(y: ArrayLike<number>, m: number, mult: boolean): Decomposition {
  const n = y.length;
  const trend = centredMA(y, m);
  const sums = new Float64Array(m);
  const counts = new Float64Array(m);
  for (let t = 0; t < n; t++) {
    const tr = trend[t];
    if (tr === null || tr === undefined) continue;
    sums[t % m]! += mult ? y[t]! / tr : y[t]! - tr;
    counts[t % m]!++;
  }
  const idx = new Float64Array(m);
  for (let k = 0; k < m; k++) idx[k] = counts[k] ? sums[k]! / counts[k]! : mult ? 1 : 0;
  let avg = 0;
  for (let k = 0; k < m; k++) avg += idx[k]! / m;
  for (let k = 0; k < m; k++) idx[k] = mult ? idx[k]! / avg : idx[k]! - avg;
  const seasonal = Array.from({ length: n }, (_, t) => idx[t % m]!);
  const remainder = trend.map((tr, t) => (tr === null ? null : mult ? y[t]! / (tr * seasonal[t]!) : y[t]! - tr - seasonal[t]!));
  return { trend, seasonal, remainder };
}

// ---- STL ---------------------------------------------------------------------------------------

/**
 * Loess at `x` over values at positions 0..len−1 (Cleveland's stlest): the q nearest positions,
 * tricube distance weights times robustness weights, a local constant (degree 0) or line (degree 1).
 */
function loessAt(y: ArrayLike<number>, rw: ArrayLike<number> | null, len: number, q: number, degree: 0 | 1, x: number, fallback: number): number {
  const left = q >= len ? 0 : Math.min(len - q, Math.max(0, Math.floor(x - (q - 1) / 2)));
  const right = q >= len ? len - 1 : left + q - 1;
  let h = Math.max(x - left, right - x);
  if (q > len) h += Math.floor((q - len) / 2);
  h = Math.max(h, 1e-9);
  const h9 = 0.999 * h;
  const h1 = 0.001 * h;
  let sw = 0;
  let swx = 0;
  let swy = 0;
  const w = new Float64Array(right - left + 1);
  for (let j = left; j <= right; j++) {
    const r = Math.abs(j - x);
    let wj = 0;
    if (r <= h9) {
      wj = r <= h1 ? 1 : (1 - (r / h) ** 3) ** 3;
      if (rw) wj *= rw[j]!;
    }
    w[j - left] = wj;
    sw += wj;
    swx += wj * j;
    swy += wj * y[j]!;
  }
  if (sw <= 0) return fallback;
  const xbar = swx / sw;
  const ybar = swy / sw;
  if (degree === 0) return ybar;
  let sxx = 0;
  let sxy = 0;
  for (let j = left; j <= right; j++) {
    const wj = w[j - left]!;
    sxx += wj * (j - xbar) ** 2;
    sxy += wj * (j - xbar) * y[j]!;
  }
  // Stlest's guard: fit the slope only when the weighted spread of positions is not tiny.
  if (Math.sqrt(sxx / sw) <= 0.001 * (len - 1)) return ybar;
  return ybar + (sxy / sxx) * (x - xbar);
}

function movingAverage(x: ArrayLike<number>, k: number): Float64Array {
  const n = x.length - k + 1;
  const out = new Float64Array(Math.max(0, n));
  let s = 0;
  for (let i = 0; i < k; i++) s += x[i]!;
  for (let i = 0; i < n; i++) {
    out[i] = s / k;
    if (i + k < x.length) s += x[i + k]! - x[i]!;
  }
  return out;
}

const oddAtLeast = (v: number) => {
  const c = Math.max(3, Math.ceil(v));
  return c % 2 === 0 ? c + 1 : c;
};

export interface StlOptions {
  /** Seasonal smoothing window in cycles (odd, at least 7). */
  ns?: number;
  /** Robustness (outer) iterations; 0 for the non-robust version. */
  outer?: number;
}

/** STL (Cleveland et al. 1990). Returns y = trend + seasonal + remainder exactly. */
export function stl(y: ArrayLike<number>, m: number, opts: StlOptions = {}): { trend: Float64Array; seasonal: Float64Array; remainder: Float64Array; weights: Float64Array } {
  const n = y.length;
  const np = m;
  const ns = oddAtLeast(Math.max(7, opts.ns ?? 13));
  const nl = oddAtLeast(np);
  const nt = oddAtLeast((1.5 * np) / (1 - 1.5 / ns));
  const outer = opts.outer ?? 15;
  const inner = outer > 0 ? 1 : 2;
  const trend = new Float64Array(n);
  const seasonal = new Float64Array(n);
  const rw = new Float64Array(n).fill(1);
  const work = new Float64Array(n);
  const c = new Float64Array(n + 2 * np);
  const sub = new Float64Array(Math.ceil(n / np) + 2);
  const subW = new Float64Array(Math.ceil(n / np) + 2);
  for (let o = 0; o <= outer; o++) {
    for (let it = 0; it < inner; it++) {
      // Step 1: detrend.
      for (let t = 0; t < n; t++) work[t] = y[t]! - trend[t]!;
      // Step 2: smooth each cycle-subseries, extended one cycle either side.
      for (let k = 0; k < np; k++) {
        let len = 0;
        for (let t = k; t < n; t += np) {
          sub[len] = work[t]!;
          subW[len] = rw[t]!;
          len++;
        }
        if (len === 0) continue;
        // When every robustness weight in reach is zero (one huge outlier smeared over a short
        // subseries in the first pass), use the subseries median rather than leave the gap: the next
        // robustness pass then finds the outlier alone. (Cleveland's stless returns the raw value.)
        const fb = median(sub.subarray(0, len));
        for (let j = -1; j <= len; j++) c[k + (j + 1) * np] = loessAt(sub, subW, len, ns, 0, j, fb);
      }
      // Step 3: low-pass filter of the cycle-subseries: MA(np), MA(np), MA(3), then loess(nl).
      const lp = movingAverage(movingAverage(movingAverage(c, np), np), 3);
      // Steps 4–6: seasonal = C − L; deseasonalise; trend by loess(nt) with the robustness weights.
      for (let t = 0; t < n; t++) {
        const l = loessAt(lp, null, n, nl, 1, t, lp[t]!);
        seasonal[t] = c[t + np]! - l;
        work[t] = y[t]! - seasonal[t]!;
      }
      for (let t = 0; t < n; t++) trend[t] = loessAt(work, rw, n, nt, 1, t, work[t]!);
    }
    if (o === outer) break;
    // Robustness weights: bisquare of |R| / (6 · median |R|).
    const abs = new Float64Array(n);
    for (let t = 0; t < n; t++) abs[t] = Math.abs(y[t]! - trend[t]! - seasonal[t]!);
    const h = 6 * median(abs);
    for (let t = 0; t < n; t++) {
      const r = abs[t]!;
      rw[t] = h <= 0 ? (r <= 0 ? 1 : 0) : r <= 0.001 * h ? 1 : r <= 0.999 * h ? (1 - (r / h) ** 2) ** 2 : 0;
    }
  }
  const remainder = new Float64Array(n);
  for (let t = 0; t < n; t++) remainder[t] = y[t]! - trend[t]! - seasonal[t]!;
  return { trend, seasonal, remainder, weights: rw };
}

// ---- helpers for the card ----------------------------------------------------------------------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A plain name for a position in the season: "March", "Q2", "Tuesday", or the period itself. */
export function positionName(date: string, label: string, grain: string | undefined, m: number): string {
  if (grain === 'month' && m === 12) return MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? label;
  if (grain === 'quarter' && m === 4) return label.split(' ')[0] ?? label;
  if (grain === 'day' && m === 7) {
    const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? label : DAY_NAMES[d.getUTCDay()]!;
  }
  return `periods like ${label}`;
}

/** FPP3 §4.3 feature strength: max(0, 1 − Var(R) / Var(C + R)). */
function strength(component: ArrayLike<number | null>, remainder: ArrayLike<number | null>): number {
  const r: number[] = [];
  const cr: number[] = [];
  for (let i = 0; i < remainder.length; i++) {
    const a = component[i];
    const b = remainder[i];
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    r.push(b);
    cr.push(a + b);
  }
  const vcr = variance(cr);
  if (!(vcr > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - variance(r) / vcr));
}

/** Seasonal decomposition by STL or the classical method. */
export const runDecompose: ModelRunner = (data, spec) => {
  const method = param(spec, 'method', 'stl') === 'classical' ? 'classical' : 'stl';
  const mult = param(spec, 'form', 'additive') === 'multiplicative';
  const s = timeSeries(data, 4);
  const m = Math.round(numParam(spec, 'season', 0, 0, 366)) || seasonFor(s.grain);
  if (m < 2) throw new ModelError('No season length is known for this date grain (yearly data has none). Set the season length, or use a monthly, quarterly, weekly or daily grain.');
  const n = s.values.length;
  if (n < 2 * m) throw new ModelError(`A decomposition needs at least two full seasons (${2 * m} periods for a season of ${m}); this flag has ${n}.`);
  const notes = gapNote(s.values);
  const y = Float64Array.from(interpolate(s.values));
  if (mult && !y.every((v) => v > 0)) throw new ModelError('A multiplicative season needs every value above zero; choose the additive form instead.');
  if (n > 20000) throw new ModelError(`This flag has ${n} periods; decompose at most 20,000 (choose a coarser date grain).`);

  let trend: Array<number | null>;
  let seasonal: number[];
  let remainder: Array<number | null>;
  if (method === 'classical') {
    ({ trend, seasonal, remainder } = classical(y, m, mult));
    notes.push(`The classical trend is a centred ${m % 2 ? '' : '2×'}${m}-period moving average, so it is blank for the first and last ${Math.floor(m / 2)} periods.`);
  } else {
    const src = mult ? y.map(Math.log) : y;
    const r = stl(src, m);
    const back = (a: Float64Array) => Array.from(a, (v) => (mult ? Math.exp(v) : v));
    trend = back(r.trend);
    seasonal = back(r.seasonal);
    // Remainder by difference (or ratio) so the parts give back the observed values exactly.
    remainder = y.length ? Array.from(y, (v, t) => (mult ? v / (trend[t]! * seasonal[t]!) : v - trend[t]! - seasonal[t]!)) : [];
    const down = Array.from(r.weights).filter((w) => w < 0.1).length;
    if (down) notes.push(`${down} period${down === 1 ? ' looked' : 's looked'} unusual and counted for less in the fit (STL robustness weights); see the remainder panel.`);
  }

  // Strength on the additive scale: logs for the multiplicative form.
  const lg = (a: ArrayLike<number | null>) => Array.from(a as ArrayLike<number | null>, (v) => (v === null ? null : mult ? Math.log(v) : v));
  const fs = strength(lg(seasonal), lg(remainder));
  const ft = strength(lg(trend), lg(remainder));

  // The average seasonal effect at each position, and the highest.
  const avg = new Float64Array(m);
  const cnt = new Float64Array(m);
  for (let t = 0; t < n; t++) {
    avg[t % m]! += seasonal[t]!;
    cnt[t % m]!++;
  }
  for (let k = 0; k < m; k++) avg[k] = avg[k]! / Math.max(1, cnt[k]!);
  let hiK = 0;
  let loK = 0;
  for (let k = 1; k < m; k++) {
    if (avg[k]! > avg[hiK]!) hiK = k;
    if (avg[k]! < avg[loK]!) loK = k;
  }
  const nameOf = (k: number) => positionName(s.dates[k]!, s.labels[k]!, s.grain, m);
  const f = metricFmt(s);
  const effect = (v: number) => (mult ? `${fmt(Math.abs(v - 1), 'percent')} ${v >= 1 ? 'above' : 'below'}` : `${f(Math.abs(v))} ${v >= 0 ? 'above' : 'below'}`);
  const word = fs >= 0.6 ? 'strong' : fs >= 0.3 ? 'moderate' : 'weak';
  const headline = `The season is ${word} (seasonal strength ${fmt(fs, 'percent')}): ${nameOf(hiK)} ${nameOf(hiK).startsWith('periods like') ? 'are' : 'is'} typically the highest, about ${effect(avg[hiK]!)} the trend.`;
  const swing = avg[hiK]! - avg[loK]!;
  const sentences = [
    `Seasonal strength measures how much of the variation left after taking out the trend is the repeating ${m}-period pattern: ${fmt(fs, 'percent')}, where 0% is none and 100% is all of it.`,
    `${nameOf(loK).replace(/^periods/, 'Periods').replace(/^./, (c) => c.toUpperCase())} ${nameOf(loK).startsWith('periods like') ? 'are' : 'is'} typically the lowest, about ${effect(avg[loK]!)} the trend.`,
    `The trend strength is ${fmt(ft, 'percent')} on the same scale: ${ft >= 0.6 ? 'the series has a clear underlying direction' : 'the underlying level moves little against the noise'}.`,
    method === 'stl' ? 'STL lets the seasonal pattern change slowly over the years and keeps unusual periods from bending it.' : 'The classical method assumes the same seasonal pattern every year.',
  ];
  if (n < 3 * m) notes.push(`Only ${(n / m).toFixed(1)} seasons of history: the seasonal pattern rests on two or three values per position.`);

  const table = {
    columns: ['Period', s.metricLabel, 'Trend', 'Seasonal', 'Remainder'],
    rows: s.labels.map((lab, t) => [lab, s.values[t] ?? null, r6(trend[t] ?? null), r6(seasonal[t] ?? null), r6(remainder[t] ?? null)]),
  };
  return {
    model: 'decompose',
    headline,
    sentences,
    stats: [
      { label: 'Seasonal strength', value: fs, format: 'percent', hint: 'FPP3: 1 − Var(remainder) / Var(season + remainder).' },
      { label: 'Trend strength', value: ft, format: 'percent', hint: 'FPP3: 1 − Var(remainder) / Var(trend + remainder).' },
      { label: 'Highest', value: nameOf(hiK) },
      { label: 'Seasonal swing', value: swing, format: mult ? 'percent' : 'metric', hint: 'From the lowest to the highest position in the season.' },
      { label: 'Season length', value: m, format: 'integer' },
    ],
    chart: {
      kind: 'panels',
      x: [...s.labels],
      panels: [
        { name: 'Observed', values: Array.from(y) },
        { name: 'Trend', values: trend },
        { name: 'Seasonal', values: seasonal },
        { name: 'Remainder', values: remainder },
      ],
      yFormat: 'metric',
    },
    table,
    notes,
  };
};

const r6 = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(12)));

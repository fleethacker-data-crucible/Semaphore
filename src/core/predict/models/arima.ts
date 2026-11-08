// ARIMA(p, d, q), with optional seasonal differencing at the season length (Box and Jenkins).
// - Estimation: conditional sum of squares (Box, Jenkins and Reinsel, §7.1), minimised with
//   Nelder–Mead. The AR and MA parts are kept stationary and invertible by optimising partial
//   autocorrelations in (−1, 1) and mapping them to coefficients with the Durbin–Levinson recursion
//   (Jones 1980; Monahan 1984), so every trial model is a valid one.
// - Order of differencing: the KPSS test (Kwiatkowski, Phillips, Schmidt and Shin 1992) at the 5%
//   level, differencing again while it says the level is not stationary, up to twice (the rule
//   Hyndman and Khandakar's auto.arima uses).
// - Order search: p and q from 0 to 3, keeping the lowest AICc.
// - Forecast intervals from the psi-weights of the full model φ(B)(1 − B)^d(1 − B^m)^D.

import { forecastChart, forecastHeadline, gapNote, lastNumber, levelOf, metricFmt } from './trend.ts';
import { interpolate, seasonFor, timeSeries } from '../data.ts';
import { fmt } from '../format.ts';
import { nelderMead } from '../optimize.ts';
import { mean, zFor } from '../stats.ts';
import { ModelError, type ModelRunner, numParam, param } from '../types.ts';

/** Partial autocorrelations in (−1, 1) to the coefficients of a stationary 1 − a₁B − … − a_kB^k. */
export function pacfToCoefs(r: ArrayLike<number>): number[] {
  const k = r.length;
  let a: number[] = [];
  for (let i = 0; i < k; i++) {
    const ri = r[i]!;
    const next = new Array<number>(i + 1);
    for (let j = 0; j < i; j++) next[j] = a[j]! - ri * a[i - 1 - j]!;
    next[i] = ri;
    a = next;
  }
  return a;
}

/** The sample partial autocorrelations up to lag k (Durbin–Levinson on the sample autocorrelations). */
function samplePacf(x: ArrayLike<number>, k: number): number[] {
  const n = x.length;
  const mu = mean(x);
  const acf: number[] = [];
  let c0 = 0;
  for (let t = 0; t < n; t++) c0 += (x[t]! - mu) ** 2;
  for (let lag = 0; lag <= k; lag++) {
    let c = 0;
    for (let t = lag; t < n; t++) c += (x[t]! - mu) * (x[t - lag]! - mu);
    acf.push(c0 > 0 ? c / c0 : 0);
  }
  const out: number[] = [];
  let phi: number[] = [];
  for (let m = 1; m <= k; m++) {
    let num = acf[m]!;
    let den = 1;
    for (let j = 0; j < m - 1; j++) {
      num -= phi[j]! * acf[m - 1 - j]!;
      den -= phi[j]! * acf[j + 1]!;
    }
    const pm = den !== 0 ? num / den : 0;
    const next = phi.map((v, j) => v - pm * phi[m - 2 - j]!);
    next.push(pm);
    phi = next;
    out.push(Math.max(-0.95, Math.min(0.95, pm)));
  }
  return out;
}

/** The KPSS level-stationarity statistic with a Bartlett long-run variance, lag ⌊4(n/100)^¼⌋. */
export function kpss(x: ArrayLike<number>): number {
  const n = x.length;
  const mu = mean(x);
  const e = new Float64Array(n);
  for (let t = 0; t < n; t++) e[t] = x[t]! - mu;
  let s = 0;
  let eta = 0;
  for (let t = 0; t < n; t++) {
    s += e[t]!;
    eta += s * s;
  }
  eta /= n * n;
  const l = Math.floor(4 * (n / 100) ** 0.25);
  let s2 = 0;
  for (let t = 0; t < n; t++) s2 += e[t]! * e[t]!;
  s2 /= n;
  for (let lag = 1; lag <= l; lag++) {
    let c = 0;
    for (let t = lag; t < n; t++) c += e[t]! * e[t - lag]!;
    s2 += (2 * (1 - lag / (l + 1)) * c) / n;
  }
  return s2 > 1e-300 ? eta / s2 : 0;
}

/** The 5% critical value of the KPSS level test (Kwiatkowski et al. 1992, Table 1). */
export const KPSS_5PCT = 0.463;

function difference(x: ArrayLike<number>, lag: number): Float64Array {
  const out = new Float64Array(Math.max(0, x.length - lag));
  for (let t = lag; t < x.length; t++) out[t - lag] = x[t]! - x[t - lag]!;
  return out;
}

export interface ArimaFit {
  p: number;
  d: number;
  q: number;
  /** Seasonal differences (0 or 1) at season length m. */
  D: number;
  m: number;
  phi: number[];
  theta: number[];
  /** Mean of the differenced series (0 when not included). */
  mu: number;
  includeMean: boolean;
  sigma2: number;
  aicc: number;
  /** One-step errors on the differenced series, zero before lag p. */
  residuals: Float64Array;
  /** Observations used in the sum of squares. */
  nEff: number;
}

/** Conditional sum of squares of an ARMA(p, q) on w (minus μ). Fills `e` with the errors. */
function css(w: Float64Array, mu: number, phi: number[], theta: number[], e: Float64Array): number {
  const n = w.length;
  const p = phi.length;
  const q = theta.length;
  let sse = 0;
  e.fill(0);
  for (let t = p; t < n; t++) {
    let pred = 0;
    for (let i = 0; i < p; i++) pred += phi[i]! * (w[t - 1 - i]! - mu);
    for (let j = 0; j < q; j++) if (t - 1 - j >= p) pred += theta[j]! * e[t - 1 - j]!;
    const et = w[t]! - mu - pred;
    e[t] = et;
    sse += et * et;
  }
  return sse;
}

/**
 * Fits ARIMA(p, d, q) with D seasonal differences at lag m by CSS. A constant is included when the
 * total differencing is at most one (a mean, or a drift after one difference), as auto.arima does.
 */
export function fitArima(y: ArrayLike<number>, p: number, d: number, q: number, D = 0, m = 0): ArimaFit | null {
  let w: Float64Array = Float64Array.from(y as ArrayLike<number>);
  for (let i = 0; i < D; i++) w = difference(w, m);
  for (let i = 0; i < d; i++) w = difference(w, 1);
  const includeMean = d + D <= 1;
  const mu = includeMean ? mean(w) : 0;
  const nEff = w.length - p;
  const k = p + q + (includeMean ? 1 : 0) + 1;
  if (nEff - k - 1 <= 0 || w.length < 3) return null;
  const e = new Float64Array(w.length);
  const shrink = (z: number) => 0.995 * Math.tanh(z);
  const decode = (z: number[]) => ({
    phi: pacfToCoefs(z.slice(0, p).map(shrink)),
    // θ(B) = 1 + θ₁B + …: invertible when 1 − (−θ₁)B − … is stationary.
    theta: pacfToCoefs(z.slice(p).map(shrink)).map((v) => -v),
  });
  let sse: number;
  let phi: number[] = [];
  let theta: number[] = [];
  if (p + q === 0) sse = css(w, mu, [], [], e);
  else {
    const start = [...samplePacf(w, p).map((r) => Math.atanh(r / 0.995)), ...new Array<number>(q).fill(0)];
    const f = (z: number[]) => {
      const c = decode(z);
      return css(w, mu, c.phi, c.theta, e);
    };
    let best = nelderMead(f, start, { step: 0.4, maxIter: 250 * (p + q) });
    best = nelderMead(f, best.x, { step: 0.15, maxIter: 150 * (p + q) });
    ({ phi, theta } = decode(best.x));
    sse = css(w, mu, phi, theta, e);
  }
  if (!Number.isFinite(sse)) return null;
  const sigma2 = sse / nEff;
  // Gaussian log-likelihood at the CSS estimate: −n/2 (log 2πσ² + 1).
  const ll = (-nEff / 2) * (Math.log(2 * Math.PI * Math.max(sigma2, 1e-300)) + 1);
  const aicc = -2 * ll + 2 * k + (2 * k * (k + 1)) / (nEff - k - 1);
  return { p, d, q, D, m, phi, theta, mu, includeMean, sigma2, aicc, residuals: e, nEff };
}

/** The AR side of the full model, φ(B)(1 − B)^d(1 − B^m)^D, as y_t = c + Σ a_i y_{t−i} + …. */
function expandedAr(fit: ArimaFit): number[] {
  let poly = [1, ...fit.phi.map((v) => -v)];
  const times = (a: number[], b: number[]) => {
    const out = new Array<number>(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j]! += a[i]! * b[j]!;
    return out;
  };
  for (let i = 0; i < fit.d; i++) poly = times(poly, [1, -1]);
  for (let i = 0; i < fit.D; i++) {
    const sd = new Array<number>(fit.m + 1).fill(0);
    sd[0] = 1;
    sd[fit.m] = -1;
    poly = times(poly, sd);
  }
  return poly.slice(1).map((v) => -v);
}

/** Point forecasts, standard errors and in-sample fit from a fitted model. */
export function arimaForecast(y: ArrayLike<number>, fit: ArimaFit, horizon: number): { mean: Float64Array; se: Float64Array; fitted: Array<number | null> } {
  const n = y.length;
  const a = expandedAr(fit);
  const P = a.length;
  const offset = fit.d + fit.D * fit.m;
  const c = fit.includeMean ? fit.mu * (1 - fit.phi.reduce((s, v) => s + v, 0)) : 0;
  const E = new Float64Array(n + horizon);
  const fitted: Array<number | null> = new Array<number | null>(n).fill(null);
  for (let t = offset + fit.p; t < n; t++) {
    E[t] = fit.residuals[t - offset]!;
    fitted[t] = y[t]! - E[t]!;
  }
  const Y = new Float64Array(n + horizon);
  for (let t = 0; t < n; t++) Y[t] = y[t]!;
  const out = new Float64Array(horizon);
  for (let h = 0; h < horizon; h++) {
    const t = n + h;
    let v = c;
    for (let i = 0; i < P; i++) if (t - 1 - i >= 0) v += a[i]! * Y[t - 1 - i]!;
    for (let j = 0; j < fit.q; j++) if (t - 1 - j < n && t - 1 - j >= 0) v += fit.theta[j]! * E[t - 1 - j]!;
    Y[t] = v;
    out[h] = v;
  }
  // psi-weights: ψ₀ = 1, ψ_j = θ_j + Σ a_i ψ_{j−i}; Var(e_{T+h}) = σ² Σ_{j<h} ψ_j².
  const psi = new Float64Array(horizon);
  psi[0] = 1;
  for (let j = 1; j < horizon; j++) {
    let v = j <= fit.q ? fit.theta[j - 1]! : 0;
    for (let i = 1; i <= Math.min(j, P); i++) v += a[i - 1]! * psi[j - i]!;
    psi[j] = v;
  }
  const se = new Float64Array(horizon);
  let acc = 0;
  for (let h = 0; h < horizon; h++) {
    acc += psi[h]! ** 2;
    se[h] = Math.sqrt(fit.sigma2 * acc);
  }
  return { mean: out, se, fitted };
}

/** Picks d by repeated KPSS tests at 5% (after any seasonal difference), up to 2. */
export function chooseD(y: ArrayLike<number>, D: number, m: number): number {
  let w: Float64Array = Float64Array.from(y as ArrayLike<number>);
  for (let i = 0; i < D; i++) w = difference(w, m);
  let d = 0;
  while (d < 2 && w.length > 12 && kpss(w) > KPSS_5PCT) {
    w = difference(w, 1);
    d++;
  }
  return d;
}

const MAX_POINTS = 5000;

/** ARIMA (Box–Jenkins) by conditional sum of squares, with an AICc order search. */
export const runArima: ModelRunner = (data, spec) => {
  const horizon = Math.round(numParam(spec, 'horizon', 6, 1, 120));
  const level = levelOf(spec);
  const auto = param(spec, 'auto', true);
  const s = timeSeries(data, 4);
  const notes = gapNote(s.values);
  let y: Float64Array = Float64Array.from(interpolate(s.values));
  let series = s;
  let actual: Array<number | null> = s.values;
  if (y.length > MAX_POINTS) {
    const cut = y.length - MAX_POINTS;
    y = y.slice(cut);
    series = { ...s, dates: s.dates.slice(cut), labels: s.labels.slice(cut), values: s.values.slice(cut) };
    actual = series.values;
    notes.push(`Only the latest ${MAX_POINTS.toLocaleString('en-US')} periods were used, to keep the fit quick.`);
  }
  const n = y.length;
  const seasonalAsked = param(spec, 'seasonal', false);
  const m = Math.round(numParam(spec, 'season', 0, 0, 366)) || seasonFor(s.grain);
  let D = 0;
  if (seasonalAsked) {
    if (m < 2) notes.push('No season length is known for this date grain, so the season was not taken out. Set the season length to use it.');
    else if (n < 2 * m + 8) notes.push(`Taking out a ${m}-period season needs at least ${2 * m + 8} periods; this flag has ${n}, so it was skipped.`);
    else D = 1;
  }

  let fit: ArimaFit | null = null;
  let tried = 0;
  let dNote = '';
  if (auto) {
    const d = chooseD(y, D, m);
    dNote = d === 0 ? 'The KPSS test found the level steady, so the series was modelled as it is.' : `The KPSS test found the level wandering, so the model works on ${d === 1 ? 'period-to-period changes' : 'changes in the changes'} (d = ${d}).`;
    const need = 3 * d + D * m + 8;
    if (n < need) throw new ModelError(`ARIMA needs at least ${need} periods here; this flag has ${n}. Use a trend line or smoothing for short series.`);
    for (let p = 0; p <= 3; p++) {
      for (let q = 0; q <= 3; q++) {
        if (n < 3 * (p + q + d) + D * m) continue;
        const f = fitArima(y, p, d, q, D, m);
        if (!f || !Number.isFinite(f.aicc)) continue;
        tried++;
        if (!fit || f.aicc < fit.aicc) fit = f;
      }
    }
  } else {
    const p = Math.round(numParam(spec, 'p', 1, 0, 5));
    const d = Math.round(numParam(spec, 'd', 1, 0, 2));
    const q = Math.round(numParam(spec, 'q', 0, 0, 5));
    const need = Math.max(3 * (p + q + d), 8) + D * m;
    if (n < need) throw new ModelError(`ARIMA(${p},${d},${q}) needs at least ${need} periods; this flag has ${n}. Lower the orders or use a longer history.`);
    fit = fitArima(y, p, d, q, D, m);
    tried = 1;
  }
  if (!fit) throw new ModelError('No ARIMA model could be fitted to this series; it may be too short or constant.');

  const fc = arimaForecast(y, fit, horizon);
  const z = zFor(level);
  const lo = fc.mean.map((v, h) => v - z * fc.se[h]!);
  const hi = fc.mean.map((v, h) => v + z * fc.se[h]!);
  const { chart, table, future } = forecastChart({ series, actual, fit: fc.fitted, forecast: fc.mean, lower: lo, upper: hi, level, fitName: 'One-step fit' });
  const when = future[horizon - 1]!;
  const order = `ARIMA(${fit.p},${fit.d},${fit.q})${fit.D ? `(0,1,0)[${fit.m}]` : ''}`;
  const f = metricFmt(s);
  const sigma = Math.sqrt(fit.sigma2);
  const sentences: string[] = [];
  sentences.push(auto ? `${order} fitted best: the lowest AICc (a score that rewards a close fit and penalises extra terms) of the ${tried} orders tried.` : `Model: ${order}, as set.`);
  if (dNote) sentences.push(dNote);
  if (fit.p) sentences.push(`Autoregressive terms (${fit.phi.map((v) => fmt(v, 'decimal')).join(', ')}): how much of the last ${fit.p === 1 ? 'period’s' : `${fit.p} periods’`} departure from normal carries into the next.`);
  if (fit.q) sentences.push(`Moving-average terms (${fit.theta.map((v) => fmt(v, 'decimal')).join(', ')}): how much of the last ${fit.q === 1 ? 'surprise' : `${fit.q} surprises`} carries into the next period.`);
  sentences.push(`One period ahead, forecasts have typically been off by about ${f(sigma)}.`);
  if (fit.D) notes.push(`The ${fit.m}-period season was taken out by differencing: each period is compared with the same period one season earlier.`);
  if (n < 24) notes.push(`Only ${n} periods: ARIMA usually wants 24 or more, so treat the order and the band as rough.`);
  notes.push('Fitted by conditional least squares; the band assumes the one-step errors are normal and steady.');

  return {
    model: 'arima',
    headline: forecastHeadline(s, fc.mean[horizon - 1]!, lo[horizon - 1]!, hi[horizon - 1]!, level, when, lastNumber(actual)),
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Model', value: order, hint: 'p autoregressive terms, d differences, q moving-average terms.' },
      { label: `Forecast, ${when}`, value: fc.mean[horizon - 1]!, format: 'metric' },
      { label: 'One-step error', value: sigma, format: 'metric', hint: 'Standard deviation of the one-step errors.' },
      { label: 'AICc', value: fit.aicc, format: 'decimal', hint: 'Lower is better; compare only between models of the same differencing.' },
    ],
    chart,
    table,
    notes,
  };
};

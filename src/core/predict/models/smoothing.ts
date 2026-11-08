// Exponential smoothing: simple (level), Holt (level and trend), damped trend, and Holt–Winters with
// an additive or multiplicative season, plus a plain moving average. The forms, the parameter limits,
// the starting states and the prediction intervals follow Hyndman and Athanasopoulos, "Forecasting:
// Principles and Practice" (FPP3, chapter 8) and Hyndman, Koehler, Ord and Snyder, "Forecasting with
// Exponential Smoothing" (2008): all are ETS models with additive errors, fitted by minimising the
// one-step sum of squared errors with Nelder–Mead, and compared by AICc.

import { centredMA } from './decompose.ts';
import { forecastChart, forecastHeadline, gapNote, lastNumber, levelOf, metricFmt, periodWord } from './trend.ts';
import { interpolate, seasonFor, timeSeries } from '../data.ts';
import { fmt } from '../format.ts';
import { fromUnit, nelderMead, toUnit } from '../optimize.ts';
import { Rng } from '../rng.ts';
import { mean, quantileSorted, sd, zFor } from '../stats.ts';
import { ModelError, type ModelRunner, numParam, param } from '../types.ts';

export type EtsMethod = 'ses' | 'holt' | 'damped' | 'hw-add' | 'hw-mult';

export interface EtsShape {
  trend: boolean;
  damped: boolean;
  season: 'none' | 'add' | 'mult';
  /** Season length (ignored without a season). */
  m: number;
}

/** Smoothing constants in component form (FPP3 §8.1–8.3): β is β*, γ is bounded by 1 − α. */
export interface EtsParams {
  alpha: number;
  beta: number;
  gamma: number;
  phi: number;
  l0: number;
  b0: number;
  /** Starting seasonal states: s0[t mod m] is the season for observation t of the first cycle. */
  s0: ArrayLike<number>;
}

export interface EtsRun {
  fitted: Float64Array;
  residuals: Float64Array;
  sse: number;
  /** Final states after the last observation; s[t mod m] is the latest season for position t. */
  l: number;
  b: number;
  s: Float64Array;
  n: number;
}

export const SHAPES: Record<EtsMethod, EtsShape> = {
  ses: { trend: false, damped: false, season: 'none', m: 1 },
  holt: { trend: true, damped: false, season: 'none', m: 1 },
  damped: { trend: true, damped: true, season: 'none', m: 1 },
  'hw-add': { trend: true, damped: false, season: 'add', m: 1 },
  'hw-mult': { trend: true, damped: false, season: 'mult', m: 1 },
};

const NAMES: Record<EtsMethod | 'sma', string> = {
  ses: 'simple exponential smoothing',
  holt: "Holt's linear trend",
  damped: 'damped trend',
  'hw-add': 'Holt–Winters with an additive season',
  'hw-mult': 'Holt–Winters with a multiplicative season',
  sma: 'a moving average',
};

/**
 * Runs the smoothing recursions (component form, FPP3 Table 8.6 with additive errors) over `y`.
 * Returns an infinite SSE when a multiplicative state goes non-positive.
 */
export function etsFilter(y: ArrayLike<number>, shape: EtsShape, p: EtsParams): EtsRun {
  const n = y.length;
  const fitted = new Float64Array(n);
  const residuals = new Float64Array(n);
  const m = shape.season === 'none' ? 1 : shape.m;
  const s = new Float64Array(m);
  for (let i = 0; i < m; i++) s[i] = shape.season === 'none' ? 0 : p.s0[i]!;
  const phi = shape.trend ? (shape.damped ? p.phi : 1) : 0;
  const mult = shape.season === 'mult';
  let l = p.l0;
  let b = shape.trend ? p.b0 : 0;
  let sse = 0;
  for (let t = 0; t < n; t++) {
    const yt = y[t]!;
    const k = t % m;
    const st = shape.season === 'none' ? (mult ? 1 : 0) : s[k]!;
    const base = l + phi * b;
    const yhat = mult ? base * st : base + st;
    const e = yt - yhat;
    fitted[t] = yhat;
    residuals[t] = e;
    sse += e * e;
    const lNew = mult ? p.alpha * (yt / st) + (1 - p.alpha) * base : p.alpha * (yt - st) + (1 - p.alpha) * base;
    if (shape.trend) b = p.beta * (lNew - l) + (1 - p.beta) * phi * b;
    if (shape.season !== 'none') s[k] = mult ? p.gamma * (yt / base) + (1 - p.gamma) * st : p.gamma * (yt - base) + (1 - p.gamma) * st;
    l = lNew;
    if (mult && (!(base > 0) || !(st > 0) || !(l > 0))) return { fitted, residuals, sse: Infinity, l, b, s, n };
  }
  return { fitted, residuals, sse, l, b, s, n };
}

/** Point forecasts h = 1..H from the final states. */
export function etsForecast(run: EtsRun, shape: EtsShape, p: EtsParams, horizon: number): Float64Array {
  const out = new Float64Array(horizon);
  const m = shape.season === 'none' ? 1 : shape.m;
  const phi = shape.damped ? p.phi : 1;
  let phiH = 0;
  for (let h = 1; h <= horizon; h++) {
    phiH += shape.trend ? phi ** h : 0;
    const base = run.l + phiH * run.b;
    const st = run.s[(run.n - 1 + h) % m]!;
    out[h - 1] = shape.season === 'mult' ? base * st : shape.season === 'add' ? base + st : base;
  }
  return out;
}

/**
 * Forecast variance multipliers for the linear (additive) ETS models: Var(e_{T+h}) = σ² Σ c_j²,
 * c_0 = 1, c_j = w' F^{j−1} g (Hyndman et al. 2008, §6.1, "class 1"; the closed forms in FPP3
 * Table 8.8 are this sum). Worked by pushing one unit error through the error-correction form.
 */
export function etsVarianceFactors(shape: EtsShape, p: EtsParams, horizon: number): Float64Array {
  const out = new Float64Array(horizon);
  const m = shape.season === 'none' ? 1 : shape.m;
  const phi = shape.trend ? (shape.damped ? p.phi : 1) : 0;
  // Error-correction coefficients: l += α e, b += αβ* e, s += γ e.
  let dl = p.alpha;
  let db = shape.trend ? p.alpha * p.beta : 0;
  const ds = new Float64Array(m);
  if (shape.season !== 'none') ds[0] = p.gamma;
  let acc = 1;
  out[0] = 1;
  for (let j = 1; j < horizon; j++) {
    // Forecast j steps after the shock, seasonal slot j mod m (slot 0 took the shock).
    const c = dl + phi * db + (shape.season !== 'none' ? ds[j % m]! : 0);
    acc += c * c;
    out[j] = acc;
    dl += phi * db;
    db *= phi;
  }
  return out;
}

/** Starting states by the heuristics of Hyndman et al. (2008, §2.6.1). */
export function initialStates(y: ArrayLike<number>, shape: EtsShape): { l0: number; b0: number; s0: Float64Array } {
  const n = y.length;
  const m = shape.season === 'none' ? 1 : shape.m;
  const s0 = new Float64Array(m);
  const adj = Float64Array.from(y as ArrayLike<number>);
  if (shape.season !== 'none') {
    // A 2×m moving average over the first few full seasons; the average detrended value at each
    // position, normalised to add to 0 (additive) or average 1 (multiplicative).
    const k = Math.min(n, Math.max(2, Math.min(4, Math.floor(n / m))) * m);
    const head = Array.from({ length: k }, (_, i) => y[i]!);
    const ma = centredMA(head, m);
    const sums = new Float64Array(m);
    const counts = new Float64Array(m);
    for (let i = 0; i < k; i++) {
      const t = ma[i];
      if (t === null || t === undefined) continue;
      sums[i % m]! += shape.season === 'mult' ? head[i]! / t : head[i]! - t;
      counts[i % m]!++;
    }
    for (let i = 0; i < m; i++) s0[i] = counts[i] ? sums[i]! / counts[i]! : shape.season === 'mult' ? 1 : 0;
    const avg = mean(s0);
    for (let i = 0; i < m; i++) s0[i] = shape.season === 'mult' ? s0[i]! / avg : s0[i]! - avg;
    for (let i = 0; i < n; i++) adj[i] = shape.season === 'mult' ? y[i]! / s0[i % m]! : y[i]! - s0[i % m]!;
  }
  // Level and trend: a straight line through the first (seasonally adjusted) values; the intercept
  // is the level one period before the first observation.
  const k = Math.min(n, Math.max(shape.season === 'none' ? 10 : 2 * m, 3));
  if (!shape.trend) return { l0: shape.season === 'none' ? adj[0]! : mean(adj.subarray(0, Math.min(n, m))), b0: 0, s0 };
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  for (let i = 0; i < k; i++) {
    const t = i + 1;
    st += t;
    sy += adj[i]!;
    stt += t * t;
    sty += t * adj[i]!;
  }
  const den = k * stt - st * st;
  const b0 = den ? (k * sty - st * sy) / den : 0;
  const l0 = (sy - b0 * st) / k;
  return { l0, b0, s0 };
}

export interface EtsFit {
  method: EtsMethod;
  shape: EtsShape;
  params: EtsParams;
  run: EtsRun;
  /** Number of estimated parameters (smoothing constants and starting states). */
  k: number;
  aicc: number;
  sigma2: number;
}

/** Fits one ETS model by minimising the one-step SSE (Nelder–Mead over logistic-mapped constants). */
export function fitEts(y: ArrayLike<number>, method: EtsMethod, m: number): EtsFit | null {
  const shape: EtsShape = { ...SHAPES[method], m: SHAPES[method].season === 'none' ? 1 : m };
  const n = y.length;
  const init = initialStates(y, shape);
  const scaleL = sd(y) || Math.abs(mean(y)) || 1;
  const scaleB = scaleL / Math.max(4, shape.m);
  // z = [α, β*, γ/(1−α), φ, l0 offset, b0 offset]; only the ones the shape uses are free.
  const decode = (z: number[]): EtsParams => {
    let i = 0;
    const alpha = toUnit(z[i++]!, 1e-4, 0.9999);
    const beta = shape.trend ? toUnit(z[i++]!, 1e-4, 0.9999) : 0;
    const gamma = shape.season !== 'none' ? toUnit(z[i++]!, 1e-4, 0.9999) * (1 - alpha) : 0;
    const phi = shape.damped ? toUnit(z[i++]!, 0.8, 0.98) : 1;
    const l0 = init.l0 + z[i++]! * scaleL;
    const b0 = shape.trend ? init.b0 + z[i++]! * scaleB : 0;
    return { alpha, beta, gamma, phi, l0, b0, s0: init.s0 };
  };
  const z0 = [fromUnit(0.3, 1e-4, 0.9999)];
  if (shape.trend) z0.push(fromUnit(0.1, 1e-4, 0.9999));
  if (shape.season !== 'none') z0.push(fromUnit(0.1, 1e-4, 0.9999));
  if (shape.damped) z0.push(fromUnit(0.9, 0.8, 0.98));
  z0.push(0);
  if (shape.trend) z0.push(0);
  const sse = (z: number[]) => etsFilter(y, shape, decode(z)).sse;
  let best = nelderMead(sse, z0, { step: 0.5, maxIter: 300 * z0.length });
  // One restart from the best point (Nelder–Mead can stall on a ridge).
  best = nelderMead(sse, best.x, { step: 0.2, maxIter: 200 * z0.length });
  if (!Number.isFinite(best.fx)) return null;
  const params = decode(best.x);
  const run = etsFilter(y, shape, params);
  const k = 1 + (shape.trend ? 1 : 0) + (shape.season !== 'none' ? 1 : 0) + (shape.damped ? 1 : 0) + 1 + (shape.trend ? 1 : 0) + (shape.season !== 'none' ? shape.m - 1 : 0);
  // Gaussian log-likelihood of additive-error ETS: −n/2·(log(2π·SSE/n) + 1); AICc = AIC + 2k(k+1)/(n−k−1).
  const sseFloor = Math.max(run.sse, 1e-12 * n * (scaleL * scaleL + 1e-300));
  const aic = n * (Math.log((2 * Math.PI * sseFloor) / n) + 1) + 2 * (k + 1);
  const aicc = n - k - 2 > 0 ? aic + (2 * (k + 1) * (k + 2)) / (n - k - 2) : Infinity;
  const sigma2 = run.sse / Math.max(1, n - k);
  return { method, shape, params, run, k, aicc, sigma2 };
}

/** Exponential smoothing (Hyndman et al. ETS) and a simple moving average. */
export const runSmoothing: ModelRunner = (data, spec, ctx) => {
  const horizon = Math.round(numParam(spec, 'horizon', 6, 1, 120));
  const level = levelOf(spec);
  const s = timeSeries(data, 4);
  const notes: string[] = gapNote(s.values);
  const y = Float64Array.from(interpolate(s.values));
  const n = y.length;
  let method = param(spec, 'method', 'auto') as EtsMethod | 'sma' | 'auto';
  if (!['auto', 'sma', 'ses', 'holt', 'damped', 'hw-add', 'hw-mult'].includes(method)) method = 'auto';
  const seasonParam = Math.round(numParam(spec, 'season', 0, 0, 366));
  const m = seasonParam || seasonFor(s.grain);
  const seasonalOk = m >= 2 && n >= 2 * m;
  const positive = y.every((v) => v > 0);
  const f = metricFmt(s);
  const word = periodWord(s);
  const z = zFor(level);

  if (method === 'sma') return movingAverage();

  if ((method === 'hw-add' || method === 'hw-mult') && !seasonalOk) {
    notes.push(m < 2 ? 'No season length is known for this date grain, so Holt’s trend method was used instead of Holt–Winters. Set the season length to use one.' : `Holt–Winters needs two full seasons (${2 * m} periods); this flag has ${n}, so Holt’s trend method was used instead.`);
    method = 'holt';
  }
  if (method === 'hw-mult' && !positive) {
    notes.push('A multiplicative season needs every value above zero, so the additive season was used instead.');
    method = 'hw-add';
  }

  let fit: EtsFit | null = null;
  const tried: EtsFit[] = [];
  if (method === 'auto') {
    const cands: EtsMethod[] = ['ses', 'holt', 'damped'];
    if (seasonalOk) cands.push('hw-add');
    if (seasonalOk && positive) cands.push('hw-mult');
    for (const c of cands) {
      const r = fitEts(y, c, m);
      if (r && Number.isFinite(r.aicc)) tried.push(r);
    }
    tried.sort((a, b) => a.aicc - b.aicc);
    fit = tried[0] ?? null;
    if (!seasonalOk && m >= 2) notes.push(`Seasonal methods were not tried: they need two full seasons (${2 * m} periods) and this flag has ${n}.`);
  } else {
    fit = fitEts(y, method, m);
    if (fit && !Number.isFinite(fit.aicc)) notes.push('The series is too short to compare this method by AICc; the fit is shown anyway.');
  }
  if (!fit) throw new ModelError('The smoothing model could not be fitted to this series; try a simpler method or a longer history.');
  const sh = fit.shape;
  const p = fit.params;

  const fc = etsForecast(fit.run, sh, p, horizon);
  const lo = new Float64Array(horizon);
  const hi = new Float64Array(horizon);
  const sigma = Math.sqrt(fit.sigma2);
  if (sh.season !== 'mult') {
    const v = etsVarianceFactors(sh, p, horizon);
    for (let h = 0; h < horizon; h++) {
      const half = z * sigma * Math.sqrt(v[h]!);
      lo[h] = fc[h]! - half;
      hi[h] = fc[h]! + half;
    }
  } else {
    // Multiplicative season: no closed form here, so simulate 2,000 future paths with normal errors
    // of the fitted spread through the same recursions (FPP3 §8.7, "simulated" intervals).
    const rng = new Rng((ctx.seed ^ 0x5eed) >>> 0);
    const paths = 2000;
    const sims = Array.from({ length: horizon }, () => new Float64Array(paths));
    const mm = sh.m;
    const ss = new Float64Array(mm);
    for (let r = 0; r < paths; r++) {
      let l = fit.run.l;
      let b = fit.run.b;
      ss.set(fit.run.s);
      for (let h = 0; h < horizon; h++) {
        const k = (n + h) % mm;
        const base = l + b;
        const st = ss[k]!;
        const yv = base * st + rng.normal(0, sigma);
        sims[h]![r] = yv;
        const lNew = p.alpha * (yv / st) + (1 - p.alpha) * base;
        b = p.beta * (lNew - l) + (1 - p.beta) * b;
        ss[k] = base > 0 ? p.gamma * (yv / base) + (1 - p.gamma) * st : st;
        l = lNew;
      }
    }
    for (let h = 0; h < horizon; h++) {
      const sorted = sims[h]!.sort();
      lo[h] = quantileSorted(sorted, (1 - level) / 2);
      hi[h] = quantileSorted(sorted, (1 + level) / 2);
    }
    notes.push('The band for a multiplicative season comes from 2,000 simulated future paths, so it can shift slightly with the seed.');
  }

  const { chart, table, future } = forecastChart({ series: s, actual: s.values, fit: Array.from(fit.run.fitted), forecast: fc, lower: lo, upper: hi, level, fitName: 'One-step fit' });
  const last = lastNumber(s.values);
  const when = future[horizon - 1]!;
  const sentences: string[] = [];
  const picked = method === 'auto';
  sentences.push(picked ? `Best fit: ${NAMES[fit.method]}, which had the lowest AICc (a score that rewards a close fit and penalises extra settings) of the ${tried.length} methods tried.` : `Method: ${NAMES[fit.method]}.`);
  sentences.push(`The level adapts with weight α = ${fmt(p.alpha, 'decimal')}: ${p.alpha > 0.5 ? 'it follows recent periods closely' : p.alpha < 0.15 ? 'it averages over a long stretch of history' : 'it balances recent periods against older ones'}.`);
  if (sh.trend) sentences.push(sh.damped ? `The trend is damped (φ = ${fmt(p.phi, 'decimal')}), so the forecast flattens out instead of running on in a straight line; latest trend ${f(fit.run.b)} a ${word}.` : `The latest trend is ${f(fit.run.b)} a ${word}.`);
  if (sh.season !== 'none') {
    const sv = Array.from(fit.run.s);
    const swing = Math.max(...sv) - Math.min(...sv);
    sentences.push(sh.season === 'add' ? `The season (${sh.m} periods long) swings by about ${f(swing)} from its low to its high period.` : `The season (${sh.m} periods long) swings by about ${fmt(swing, 'percent')} of the level from its low to its high period.`);
  }
  sentences.push(`One period ahead, forecasts have typically been off by about ${f(sigma)} (the one-step error).`);
  if (n < 2 * Math.max(m, 6)) notes.push(`Only ${n} periods of history: the smoothing constants are rough.`);
  if (picked && tried.length > 1) notes.push(`AICc by method: ${tried.map((t) => `${NAMES[t.method]} ${fmt(t.aicc, 'decimal')}`).join('; ')}.`);

  return {
    model: 'smoothing',
    headline: forecastHeadline(s, fc[horizon - 1]!, lo[horizon - 1]!, hi[horizon - 1]!, level, when, last),
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Method', value: label(fit.method), hint: picked ? 'Picked by the lowest AICc.' : 'As set.' },
      { label: `Forecast, ${when}`, value: fc[horizon - 1]!, format: 'metric' },
      { label: 'One-step error', value: sigma, format: 'metric', hint: 'The typical miss one period ahead (standard deviation of the one-step errors).' },
      { label: 'Level weight α', value: p.alpha, format: 'decimal', hint: 'Near 1 follows the latest periods; near 0 averages a long history.' },
      ...(sh.season !== 'none' ? [{ label: 'Season length', value: sh.m, format: 'integer' as const }] : []),
    ],
    chart,
    table,
    notes,
  };

  function movingAverage() {
    const w = Math.round(numParam(spec, 'window', 3, 2, 60));
    if (n < w + 2) throw new ModelError(`A ${w}-period moving average needs at least ${w + 2} periods; this flag has ${n}.`);
    const fitted: Array<number | null> = new Array<number | null>(n).fill(null);
    let sumW = 0;
    for (let i = 0; i < w; i++) sumW += y[i]!;
    let sse = 0;
    let count = 0;
    for (let t = w; t < n; t++) {
      const v = sumW / w;
      fitted[t] = v;
      sse += (y[t]! - v) ** 2;
      count++;
      sumW += y[t]! - y[t - w]!;
    }
    const flat = sumW / w;
    const sig = Math.sqrt(sse / Math.max(1, count - 1));
    const fcs = new Float64Array(horizon).fill(flat);
    const los = fcs.map((v) => v - z * sig);
    const his = fcs.map((v) => v + z * sig);
    const { chart, table, future } = forecastChart({ series: s, actual: s.values, fit: fitted, forecast: fcs, lower: los, upper: his, level, fitName: `${w}-period average` });
    const when = future[horizon - 1]!;
    notes.push('A moving average assumes the level holds: the forecast is flat and its band is the past one-step error, which does not widen with the horizon.');
    return {
      model: 'smoothing' as const,
      headline: forecastHeadline(s, flat, los[horizon - 1]!, his[horizon - 1]!, level, when, lastNumber(s.values)),
      sentences: [
        `The forecast is the average of the last ${w} ${word}s, ${f(flat)}, held flat.`,
        `One period ahead, the average has typically been off by about ${f(sig)}.`,
        'It does not follow a trend or a season; use Holt or Holt–Winters for those.',
      ],
      stats: [
        { label: 'Method', value: `${w}-period moving average` },
        { label: `Forecast, ${when}`, value: flat, format: 'metric' as const },
        { label: 'One-step error', value: sig, format: 'metric' as const },
      ],
      chart,
      table,
      notes,
    };
  }
};

const label = (m: EtsMethod) => ({ ses: 'Simple', holt: 'Holt', damped: 'Damped trend', 'hw-add': 'Holt–Winters (additive)', 'hw-mult': 'Holt–Winters (multiplicative)' })[m];

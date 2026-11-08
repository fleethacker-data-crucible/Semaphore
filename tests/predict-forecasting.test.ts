// Forecasting models: trend line, exponential smoothing, ARIMA, seasonal decomposition and the LSTM.
// Checked against exact answers on noiseless data, hand-worked smoothing steps, and seeded synthetic
// series with known parameters that each model must recover within a stated tolerance.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arimaForecast, fitArima, kpss, pacfToCoefs, runArima } from '../src/core/predict/models/arima.ts';
import { centredMA, classical, runDecompose, stl } from '../src/core/predict/models/decompose.ts';
import { createLstm, lstmLossGrad, runLstm } from '../src/core/predict/models/lstm.ts';
import { etsFilter, etsForecast, etsVarianceFactors, fitEts, runSmoothing, SHAPES } from '../src/core/predict/models/smoothing.ts';
import { runTrend } from '../src/core/predict/models/trend.ts';
import { Rng } from '../src/core/predict/rng.ts';
import { type ModelData, ModelError, type ModelOutput, type ModelSpec } from '../src/core/predict/types.ts';

const ctx = { seed: 7, today: '2026-11-08' };

function monthly(values: Array<number | null>, start = 2020): ModelData {
  return {
    dims: [{ key: 'd', label: 'Month', grain: 'month', isDate: true }],
    metrics: [{ key: 'v', label: 'Cost', format: 'number' }],
    rows: values.map((v, i) => {
      const y = start + Math.floor(i / 12);
      const m = (i % 12) + 1;
      return { dims: [`${y}-${String(m).padStart(2, '0')}-01`], values: [v] };
    }),
  };
}

const spec = (type: ModelSpec['type'], params: ModelSpec['params'] = {}): ModelSpec => ({ type, params });

function forecastOf(out: ModelOutput) {
  assert.equal(out.chart?.kind, 'series');
  if (out.chart?.kind !== 'series') throw new Error('not a series');
  const fc = out.chart.series.find((s) => s.role === 'forecast')!.values;
  const band = out.chart.band!;
  return { x: out.chart.x, fc, lower: band.lower, upper: band.upper, chart: out.chart };
}

/** Checks the shared forecast-series convention and returns the future part. */
function checkConvention(out: ModelOutput, n: number, horizon: number) {
  const { x, fc, lower, upper, chart } = forecastOf(out);
  assert.equal(x.length, n + horizon);
  const actual = chart.series.find((s) => s.role === 'actual')!.values;
  assert.equal(actual.length, n + horizon);
  assert.ok(actual.slice(n).every((v) => v === null));
  for (let i = 0; i < n - 1; i++) assert.equal(fc[i], null);
  assert.equal(fc[n - 1], actual[n - 1]);
  for (let i = 0; i < n; i++) {
    assert.equal(lower[i], null);
    assert.equal(upper[i], null);
  }
  const f = fc.slice(n) as number[];
  const lo = lower.slice(n) as number[];
  const hi = upper.slice(n) as number[];
  assert.equal(f.length, horizon);
  for (let h = 0; h < horizon; h++) assert.ok(lo[h]! <= f[h]! + 1e-9 && f[h]! <= hi[h]! + 1e-9);
  assert.ok(out.stats.length >= 2 && out.stats.length <= 6);
  assert.ok(out.sentences.length <= 5);
  assert.equal(out.table.rows.length, n + horizon);
  return { f, lo, hi };
}

// ---- trend ------------------------------------------------------------------------------------

test('trend: exact line on noiseless data, with a zero-width band', () => {
  const ys = Array.from({ length: 10 }, (_, t) => 5 + 2 * t);
  const out = runTrend(monthly(ys), spec('trend', { degree: '1', horizon: 3, level: '0.9' }), ctx);
  const { f, lo, hi } = checkConvention(out, 10, 3);
  assert.deepEqual(f.map((v) => Number(v.toFixed(9))), [25, 27, 29]);
  for (let h = 0; h < 3; h++) assert.ok(Math.abs(hi[h]! - lo[h]!) < 1e-6);
  assert.ok(Math.abs((out.stats[0]!.value as number) - 2) < 1e-9);
  assert.ok(Math.abs((out.stats[1]!.value as number) - 1) < 1e-12);
  assert.match(out.headline, /rising by about 2 a month/);
  assert.match(out.headline, /29/);
});

test('trend: exact quadratic and cubic recovery', () => {
  const q = Array.from({ length: 12 }, (_, t) => 3 - t + 0.5 * t * t);
  const out = runTrend(monthly(q), spec('trend', { degree: '2', horizon: 2 }), ctx);
  const { f } = checkConvention(out, 12, 2);
  assert.ok(Math.abs(f[0]! - (3 - 12 + 72)) < 1e-6);
  assert.ok(Math.abs(f[1]! - (3 - 13 + 84.5)) < 1e-6);
  // Slope at the last period t = 11: −1 + t.
  assert.ok(Math.abs((out.stats[0]!.value as number) - 10) < 1e-6);
  const c = Array.from({ length: 15 }, (_, t) => 0.01 * t ** 3 - 0.2 * t * t + t + 4);
  const f3 = checkConvention(runTrend(monthly(c), spec('trend', { degree: '3', horizon: 1 }), ctx), 15, 1).f;
  assert.ok(Math.abs(f3[0]! - (0.01 * 3375 - 0.2 * 225 + 15 + 4)) < 1e-6);
});

test('trend: prediction interval matches the textbook formula and widens with horizon', () => {
  // y = t with alternating ±1 noise on 6 points: hand-checkable OLS.
  const ys = [1, -1, 1, -1, 1, -1].map((e, t) => t + e);
  const out = runTrend(monthly(ys), spec('trend', { degree: '1', horizon: 4, level: '0.95' }), ctx);
  const { f, lo, hi } = checkConvention(out, 6, 4);
  // Direct OLS: x̄ = 2.5, Sxx = 17.5.
  const xs = [0, 1, 2, 3, 4, 5];
  const xbar = 2.5;
  const ybar = ys.reduce((a, b) => a + b, 0) / 6;
  const sxy = xs.reduce((s, x, i) => s + (x - xbar) * (ys[i]! - ybar), 0);
  const b = sxy / 17.5;
  const a = ybar - b * xbar;
  const rss = xs.reduce((s, x, i) => s + (ys[i]! - a - b * x) ** 2, 0);
  const sig = Math.sqrt(rss / 4);
  const t975 = 2.7764451051977987; // t(0.975, 4)
  for (let h = 0; h < 4; h++) {
    const x0 = 6 + h;
    assert.ok(Math.abs(f[h]! - (a + b * x0)) < 1e-9);
    const half = t975 * sig * Math.sqrt(1 + 1 / 6 + (x0 - xbar) ** 2 / 17.5);
    assert.ok(Math.abs(hi[h]! - f[h]! - half) < 1e-6, `h=${h}`);
    if (h) assert.ok(hi[h]! - lo[h]! > hi[h - 1]! - lo[h - 1]!);
  }
});

test('trend: too few points is a ModelError', () => {
  assert.throws(() => runTrend(monthly([1, 2, 3]), spec('trend', { degree: '1' }), ctx), ModelError);
  assert.throws(() => runTrend(monthly([1, 2, 3, 4, 5]), spec('trend', { degree: '3' }), ctx), ModelError);
});

// ---- smoothing --------------------------------------------------------------------------------

test('smoothing: SES recursion by hand (α = 0.5, ℓ0 = 10)', () => {
  const r = etsFilter([10, 12, 11, 15], SHAPES.ses, { alpha: 0.5, beta: 0, gamma: 0, phi: 1, l0: 10, b0: 0, s0: [] });
  // ℓ: 10 → 10 → 11 → 11 → 13; one-step forecasts 10, 10, 11, 11.
  assert.deepEqual(Array.from(r.fitted), [10, 10, 11, 11]);
  assert.equal(r.sse, 0 + 4 + 0 + 16);
  assert.equal(r.l, 13);
  assert.deepEqual(Array.from(etsForecast(r, SHAPES.ses, { alpha: 0.5, beta: 0, gamma: 0, phi: 1, l0: 10, b0: 0, s0: [] }, 2)), [13, 13]);
  // Variance factors 1 + α²(h−1) (FPP3 Table 8.8, ANN).
  const v = etsVarianceFactors(SHAPES.ses, { alpha: 0.5, beta: 0, gamma: 0, phi: 1, l0: 0, b0: 0, s0: [] }, 4);
  assert.deepEqual(Array.from(v), [1, 1.25, 1.5, 1.75]);
});

test('smoothing: Holt and additive Holt–Winters variance factors match FPP3 Table 8.8', () => {
  const alpha = 0.4;
  const bstar = 0.25;
  const beta = alpha * bstar;
  const p = { alpha, beta: bstar, gamma: 0.2, phi: 1, l0: 0, b0: 0, s0: [0, 0, 0, 0] };
  const holt = etsVarianceFactors(SHAPES.holt, p, 6);
  for (let h = 1; h <= 6; h++) {
    const want = 1 + (h - 1) * (alpha ** 2 + alpha * beta * h + (beta ** 2 * h * (2 * h - 1)) / 6);
    assert.ok(Math.abs(holt[h - 1]! - want) < 1e-12, `holt h=${h}`);
  }
  const m = 4;
  const hw = etsVarianceFactors({ ...SHAPES['hw-add'], m }, p, 12);
  for (let h = 1; h <= 12; h++) {
    const k = Math.floor((h - 1) / m);
    const g = p.gamma;
    const want = 1 + (h - 1) * (alpha ** 2 + alpha * beta * h + (beta ** 2 * h * (2 * h - 1)) / 6) + g * k * (2 * alpha + g + beta * m * (k + 1));
    assert.ok(Math.abs(hw[h - 1]! - want) < 1e-12, `hw h=${h}`);
  }
  // Damped (FPP3 AAdN) closed form.
  const phi = 0.9;
  const dm = etsVarianceFactors(SHAPES.damped, { ...p, phi }, 5);
  for (let h = 1; h <= 5; h++) {
    const want =
      1 +
      alpha ** 2 * (h - 1) +
      ((beta * phi * h) / (1 - phi) ** 2) * (2 * alpha * (1 - phi) + beta * phi) -
      ((beta * phi * (1 - phi ** h)) / ((1 - phi) ** 2 * (1 - phi ** 2))) * (2 * alpha * (1 - phi ** 2) + beta * phi * (1 + 2 * phi - phi ** h));
    assert.ok(Math.abs(dm[h - 1]! - want) < 1e-9, `damped h=${h}: ${dm[h - 1]} vs ${want}`);
  }
});

const PATTERN = [12, 8, 3, -2, -8, -12, -10, -4, 0, 5, 9, -1];
function seasonalSeries(n: number, noise: number, seed = 3, mult = false): number[] {
  const rng = new Rng(seed);
  return Array.from({ length: n }, (_, t) => {
    const base = 200 + 0.8 * t;
    return mult ? base * (1 + PATTERN[t % 12]! / 100) + rng.normal(0, noise) : base + PATTERN[t % 12]! + rng.normal(0, noise);
  });
}

test('smoothing: Holt–Winters additive recovers the injected season and forecasts the truth', () => {
  const n = 96;
  const ys = seasonalSeries(n, 1);
  const fit = fitEts(ys, 'hw-add', 12)!;
  // The final seasonal states, in calendar position, against the (zero-sum) pattern.
  for (let k = 0; k < 12; k++) assert.ok(Math.abs(fit.run.s[k]! - PATTERN[k]!) < 2.5, `pos ${k}: ${fit.run.s[k]}`);
  const out = runSmoothing(monthly(ys), spec('smoothing', { method: 'hw-add', horizon: 12, level: '0.9' }), ctx);
  const { f, lo, hi } = checkConvention(out, n, 12);
  for (let h = 0; h < 12; h++) {
    const truth = 200 + 0.8 * (n + h) + PATTERN[(n + h) % 12]!;
    assert.ok(Math.abs(f[h]! - truth) < 4, `h=${h}: ${f[h]} vs ${truth}`);
  }
  assert.ok(hi[11]! - lo[11]! > hi[0]! - lo[0]!);
});

test('smoothing: auto picks a seasonal method on seasonal data and says so', () => {
  const ys = seasonalSeries(72, 1);
  const out = runSmoothing(monthly(ys), spec('smoothing', { method: 'auto', horizon: 6 }), ctx);
  checkConvention(out, 72, 6);
  assert.match(String(out.stats[0]!.value), /Holt–Winters/);
  assert.match(out.sentences[0]!, /lowest AICc/);
  // A straight noisy line picks a non-seasonal method.
  const rng = new Rng(9);
  const line = Array.from({ length: 40 }, (_, t) => 50 + 2 * t + rng.normal(0, 0.5));
  const o2 = runSmoothing(monthly(line), spec('smoothing', { method: 'auto', horizon: 3 }), ctx);
  assert.doesNotMatch(String(o2.stats[0]!.value), /Winters|Simple/);
});

test('smoothing: multiplicative season, simulated band, deterministic for a seed', () => {
  const ys = seasonalSeries(84, 0.5, 4, true);
  const a = runSmoothing(monthly(ys), spec('smoothing', { method: 'hw-mult', horizon: 6 }), ctx);
  const b = runSmoothing(monthly(ys), spec('smoothing', { method: 'hw-mult', horizon: 6 }), ctx);
  assert.deepEqual(a, b);
  const { f } = checkConvention(a, 84, 6);
  for (let h = 0; h < 6; h++) {
    const t = 84 + h;
    const truth = (200 + 0.8 * t) * (1 + PATTERN[t % 12]! / 100);
    assert.ok(Math.abs(f[h]! - truth) < 4, `h=${h}`);
  }
});

test('smoothing: falls back when the history is short or values are not positive; SMA; gaps', () => {
  const short = seasonalSeries(18, 1);
  const o = runSmoothing(monthly(short), spec('smoothing', { method: 'hw-add', horizon: 2 }), ctx);
  assert.equal(o.stats[0]!.value, 'Holt');
  assert.ok(o.notes.some((nn) => /two full seasons/.test(nn)));
  const neg = seasonalSeries(48, 1).map((v) => v - 260);
  const o2 = runSmoothing(monthly(neg), spec('smoothing', { method: 'hw-mult', horizon: 2 }), ctx);
  assert.equal(o2.stats[0]!.value, 'Holt–Winters (additive)');
  const sma = runSmoothing(monthly([1, 2, 3, 4, 5, 6]), spec('smoothing', { method: 'sma', window: 3, horizon: 2 }), ctx);
  const { f } = checkConvention(sma, 6, 2);
  assert.deepEqual(f, [5, 5]);
  const gappy = runSmoothing(monthly([10, 11, null, 13, 14, 15, 16, 17]), spec('smoothing', { method: 'ses', horizon: 1 }), ctx);
  assert.ok(gappy.notes.some((nn) => /interpolation/.test(nn)));
  assert.throws(() => runSmoothing(monthly([1, 2, 3]), spec('smoothing'), ctx), ModelError);
});

// ---- ARIMA ------------------------------------------------------------------------------------

test('arima: PACF reparameterisation gives the AR(2) coefficients', () => {
  // r1 = 0.5, r2 = 0.3 → φ2 = 0.3, φ1 = 0.5 − 0.3·0.5 = 0.35.
  const c = pacfToCoefs([0.5, 0.3]);
  assert.ok(Math.abs(c[0]! - 0.35) < 1e-12 && Math.abs(c[1]! - 0.3) < 1e-12);
});

function simArma(n: number, phi: number, theta: number, seed: number, mu = 0): number[] {
  const rng = new Rng(seed);
  const out: number[] = [];
  let prev = 0;
  let ePrev = 0;
  for (let t = 0; t < n + 100; t++) {
    const e = rng.normal();
    const x = phi * prev + e + theta * ePrev;
    prev = x;
    ePrev = e;
    if (t >= 100) out.push(mu + x);
  }
  return out;
}

test('arima: recovers φ = 0.6 from a simulated AR(1) and θ = 0.5 from an MA(1)', () => {
  for (const seed of [1, 2, 3]) {
    const ar = fitArima(simArma(400, 0.6, 0, seed, 10), 1, 0, 0)!;
    assert.ok(Math.abs(ar.phi[0]! - 0.6) < 0.08, `seed ${seed}: φ = ${ar.phi[0]}`);
    assert.ok(Math.abs(ar.mu - 10) < 0.5);
    assert.ok(Math.abs(Math.sqrt(ar.sigma2) - 1) < 0.1);
    const ma = fitArima(simArma(400, 0, 0.5, seed + 10), 0, 0, 1)!;
    assert.ok(Math.abs(ma.theta[0]! - 0.5) < 0.08, `seed ${seed}: θ = ${ma.theta[0]}`);
  }
});

test('arima: AR(1) forecasts decay to the mean with ψ-weight variance', () => {
  const ys = simArma(400, 0.6, 0, 5, 10);
  const fit = fitArima(ys, 1, 0, 0)!;
  const fc = arimaForecast(ys, fit, 5);
  const phi = fit.phi[0]!;
  for (let h = 1; h <= 5; h++) {
    const want = fit.mu + phi ** h * (ys.at(-1)! - fit.mu);
    assert.ok(Math.abs(fc.mean[h - 1]! - want) < 1e-9);
    let v = 0;
    for (let j = 0; j < h; j++) v += phi ** (2 * j);
    assert.ok(Math.abs(fc.se[h - 1]! - Math.sqrt(fit.sigma2 * v)) < 1e-9);
  }
});

test('arima: KPSS sees a random walk as non-stationary and AR(1) as stationary; auto picks d', () => {
  const rng = new Rng(11);
  let x = 0;
  const walk = Array.from({ length: 300 }, () => (x += rng.normal()));
  assert.ok(kpss(walk) > 0.463);
  assert.ok(kpss(simArma(300, 0.5, 0, 12)) < 0.463);
  const out = runArima(monthly(walk), spec('arima', { auto: true, horizon: 6 }), ctx);
  const { lo, hi } = checkConvention(out, 300, 6);
  assert.match(String(out.stats[0]!.value), /^ARIMA\(\d,1,\d\)$/);
  for (let h = 1; h < 6; h++) assert.ok(hi[h]! - lo[h]! > hi[h - 1]! - lo[h - 1]!);
  // A trend with d = 1 and drift continues the line.
  const line = Array.from({ length: 60 }, (_, t) => 100 + 3 * t + (t % 2 ? 0.5 : -0.5));
  const o2 = runArima(monthly(line), spec('arima', { auto: false, p: 0, d: 1, q: 0, horizon: 3 }), ctx);
  const f2 = checkConvention(o2, 60, 3).f;
  assert.ok(Math.abs(f2[2]! - (100 + 3 * 62)) < 2);
});

test('arima: seasonal differencing follows the season; short data is a ModelError; deterministic', () => {
  const ys = seasonalSeries(72, 0.5);
  const out = runArima(monthly(ys), spec('arima', { auto: true, seasonal: true, horizon: 12 }), ctx);
  const { f } = checkConvention(out, 72, 12);
  for (let h = 0; h < 12; h++) {
    const t = 72 + h;
    assert.ok(Math.abs(f[h]! - (200 + 0.8 * t + PATTERN[t % 12]!)) < 4, `h=${h}`);
  }
  assert.deepEqual(out, runArima(monthly(ys), spec('arima', { auto: true, seasonal: true, horizon: 12 }), ctx));
  assert.throws(() => runArima(monthly([1, 2, 3, 4, 5, 6]), spec('arima', { auto: false, p: 2, d: 1, q: 2 }), ctx), ModelError);
});

// ---- decomposition ----------------------------------------------------------------------------

test('decompose: centred moving average of order 2×4 by hand', () => {
  const ma = centredMA([1, 2, 3, 4, 5, 6, 7], 4);
  assert.deepEqual(ma, [null, null, 3, 4, 5, null, null]);
  assert.deepEqual(centredMA([1, 2, 3, 4, 5], 3), [null, 2, 3, 4, null]);
});

test('decompose: classical and STL recover the injected season; parts add back exactly', () => {
  const ys = seasonalSeries(96, 0.5);
  const cl = classical(ys, 12, false);
  for (let k = 0; k < 12; k++) assert.ok(Math.abs(cl.seasonal[k]! - PATTERN[k]!) < 1, `classical ${k}`);
  for (let t = 0; t < 96; t++) if (cl.trend[t] !== null) assert.ok(Math.abs(cl.trend[t]! + cl.seasonal[t]! + cl.remainder[t]! - ys[t]!) < 1e-9);
  const st = stl(ys, 12);
  for (let t = 24; t < 72; t++) assert.ok(Math.abs(st.seasonal[t]! - PATTERN[t % 12]!) < 1.5, `stl t=${t}: ${st.seasonal[t]}`);
  for (let t = 0; t < 96; t++) assert.ok(Math.abs(st.trend[t]! + st.seasonal[t]! + st.remainder[t]! - ys[t]!) < 1e-9);
  for (let t = 12; t < 84; t++) assert.ok(Math.abs(st.trend[t]! - (200 + 0.8 * t)) < 1.5, `stl trend t=${t}`);
});

test('decompose: STL is robust to an outlier', () => {
  const ys = seasonalSeries(96, 0.3);
  ys[50] = ys[50]! + 200;
  const st = stl(ys, 12);
  assert.ok(st.weights[50]! < 0.01);
  assert.ok(Math.abs(st.seasonal[50]! - PATTERN[50 % 12]!) < 2);
  assert.ok(st.remainder[50]! > 190);
});

test('decompose: the card names the strongest month, uses panels, and multiplicative multiplies back', () => {
  const ys = seasonalSeries(72, 0.3);
  const out = runDecompose(monthly(ys), spec('decompose', { method: 'stl', form: 'additive' }), ctx);
  assert.equal(out.chart?.kind, 'panels');
  if (out.chart?.kind !== 'panels') return;
  assert.deepEqual(out.chart.panels.map((p) => p.name), ['Observed', 'Trend', 'Seasonal', 'Remainder']);
  assert.match(out.headline, /strong/);
  assert.match(out.headline, /January is typically the highest/);
  assert.ok((out.stats[0]!.value as number) > 0.9);
  const mul = seasonalSeries(72, 0.2, 5, true);
  for (const method of ['stl', 'classical']) {
    const o = runDecompose(monthly(mul), spec('decompose', { method, form: 'multiplicative' }), ctx);
    if (o.chart?.kind !== 'panels') throw new Error('panels');
    const [obs, tr, se, re] = o.chart.panels.map((p) => p.values);
    for (let t = 0; t < 72; t++) if (tr![t] !== null) assert.ok(Math.abs(tr![t]! * se![t]! * re![t]! - obs![t]!) < 1e-7, `${method} t=${t}`);
    for (let k = 0; k < 12; k++) assert.ok(Math.abs(se![24 + k]! - (1 + PATTERN[k]! / 100)) < 0.02, `${method} mult k=${k}`);
  }
  assert.throws(() => runDecompose(monthly(ys.slice(0, 20)), spec('decompose'), ctx), ModelError);
  assert.throws(() => runDecompose(monthly(ys.map((v) => v - 300)), spec('decompose', { form: 'multiplicative' }), ctx), ModelError);
});

// ---- LSTM -------------------------------------------------------------------------------------

test('lstm: backpropagation through time matches finite differences', () => {
  const net = createLstm(3, new Rng(5));
  const x = [0.1, 0.7, 0.3, 0.9, 0.4];
  const grad = new Float64Array(net.w.length);
  lstmLossGrad(net, x, 5, 0.6, grad);
  const eps = 1e-6;
  const scratch = new Float64Array(net.w.length);
  for (let j = 0; j < net.w.length; j++) {
    const keep = net.w[j]!;
    net.w[j] = keep + eps;
    const up = lstmLossGrad(net, x, 5, 0.6, scratch);
    net.w[j] = keep - eps;
    const down = lstmLossGrad(net, x, 5, 0.6, scratch);
    net.w[j] = keep;
    const num = (up - down) / (2 * eps);
    assert.ok(Math.abs(num - grad[j]!) < 1e-7 * Math.max(1, Math.abs(num)), `param ${j}: ${num} vs ${grad[j]}`);
  }
});

test('lstm: learns a clean sine wave and is deterministic for a seed', () => {
  const n = 120;
  const ys = Array.from({ length: n }, (_, t) => 50 + 10 * Math.sin((2 * Math.PI * t) / 12));
  const s = spec('lstm', { window: 12, hidden: 6, epochs: 120, horizon: 12, seed: 3 });
  const t0 = Date.now();
  const a = runLstm(monthly(ys), s, ctx);
  const elapsed = Date.now() - t0;
  const { f } = checkConvention(a, n, 12);
  const heldOut = a.stats[1]!.value as number;
  assert.ok(heldOut < 1, `held-out error ${heldOut}`);
  for (let h = 0; h < 12; h++) {
    const truth = 50 + 10 * Math.sin((2 * Math.PI * (n + h)) / 12);
    assert.ok(Math.abs(f[h]! - truth) < 2.5, `h=${h}: ${f[h]} vs ${truth}`);
  }
  assert.deepEqual(runLstm(monthly(ys), s, ctx), a);
  assert.ok(elapsed < 10000);
  assert.throws(() => runLstm(monthly(ys.slice(0, 25)), s, ctx), ModelError);
});

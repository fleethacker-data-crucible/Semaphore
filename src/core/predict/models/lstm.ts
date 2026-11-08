// A small neural-network forecast: one LSTM layer (Hochreiter and Schmidhuber 1997, with the
// forget gate of Gers, Schmidhuber and Cummins 2000) and a linear output, reading the last `window`
// values (min–max scaled to 0..1) and predicting the next. Trained with Adam (Kingma and Ba 2015)
// on mini-batches by backpropagation through time, weights started by Glorot and Bengio's (2010)
// uniform rule from the seeded generator, early stopping on the last 15% of windows. The forecast
// feeds each prediction back in as the next input. Float64Array throughout; the work is capped so a
// run stays within a couple of seconds.

import { forecastChart, forecastHeadline, gapNote, lastNumber, metricFmt } from './trend.ts';
import { interpolate, timeSeries } from '../data.ts';
import { Rng } from '../rng.ts';
import { zFor } from '../stats.ts';
import { ModelError, type ModelRunner, numParam } from '../types.ts';

/** All weights in one array: Wx (4H), U (4H×H, row = gate unit), b (4H), v (H), c (1). Gates i, f, o, g. */
export interface Lstm {
  H: number;
  w: Float64Array;
}

const offsets = (H: number) => {
  const wx = 0;
  const u = wx + 4 * H;
  const b = u + 4 * H * H;
  const v = b + 4 * H;
  const c = v + H;
  return { wx, u, b, v, c, size: c + 1 };
};

/** Glorot uniform starting weights; the forget-gate bias starts at 1 (Jozefowicz et al. 2015). */
export function createLstm(H: number, rng: Rng): Lstm {
  const o = offsets(H);
  const w = new Float64Array(o.size);
  const lin = Math.sqrt(6 / (1 + 4 * H));
  const lrec = Math.sqrt(6 / (H + 4 * H));
  const lout = Math.sqrt(6 / (H + 1));
  for (let i = 0; i < 4 * H; i++) w[o.wx + i] = rng.uniform(-lin, lin);
  for (let i = 0; i < 4 * H * H; i++) w[o.u + i] = rng.uniform(-lrec, lrec);
  for (let i = 0; i < H; i++) w[o.b + H + i] = 1;
  for (let i = 0; i < H; i++) w[o.v + i] = rng.uniform(-lout, lout);
  return { H, w };
}

const sigm = (x: number) => 1 / (1 + Math.exp(-x));

/** Scratch space for one window, reused across calls. */
class Cache {
  hs: Float64Array;
  cs: Float64Array;
  gates: Float64Array;
  tc: Float64Array;
  z: Float64Array;
  dh: Float64Array;
  dc: Float64Array;
  dz: Float64Array;
  constructor(H: number, T: number) {
    this.hs = new Float64Array((T + 1) * H);
    this.cs = new Float64Array((T + 1) * H);
    this.gates = new Float64Array(T * 4 * H);
    this.tc = new Float64Array(T * H);
    this.z = new Float64Array(4 * H);
    this.dh = new Float64Array(H);
    this.dc = new Float64Array(H);
    this.dz = new Float64Array(4 * H);
  }
}

function forward(net: Lstm, x: ArrayLike<number>, start: number, T: number, k: Cache): number {
  const H = net.H;
  const w = net.w;
  const o = offsets(H);
  k.hs.fill(0, 0, H);
  k.cs.fill(0, 0, H);
  for (let t = 0; t < T; t++) {
    const xt = x[start + t]!;
    const hp = t * H;
    const z = k.z;
    for (let r = 0; r < 4 * H; r++) {
      let s = w[o.b + r]! + w[o.wx + r]! * xt;
      const ur = o.u + r * H;
      for (let j = 0; j < H; j++) s += w[ur + j]! * k.hs[hp + j]!;
      z[r] = s;
    }
    const g0 = t * 4 * H;
    for (let i = 0; i < H; i++) {
      const ig = sigm(z[i]!);
      const fg = sigm(z[H + i]!);
      const og = sigm(z[2 * H + i]!);
      const gg = Math.tanh(z[3 * H + i]!);
      k.gates[g0 + i] = ig;
      k.gates[g0 + H + i] = fg;
      k.gates[g0 + 2 * H + i] = og;
      k.gates[g0 + 3 * H + i] = gg;
      const c = fg * k.cs[hp + i]! + ig * gg;
      k.cs[hp + H + i] = c;
      const tcv = Math.tanh(c);
      k.tc[t * H + i] = tcv;
      k.hs[hp + H + i] = og * tcv;
    }
  }
  let y = w[o.c]!;
  for (let i = 0; i < H; i++) y += w[o.v + i]! * k.hs[T * H + i]!;
  return y;
}

/** Backpropagation through time for one window and squared error ½(ŷ − target)²; adds into `grad`. */
function backward(net: Lstm, x: ArrayLike<number>, start: number, T: number, k: Cache, dy: number, grad: Float64Array): void {
  const H = net.H;
  const w = net.w;
  const o = offsets(H);
  grad[o.c]! += dy;
  for (let i = 0; i < H; i++) {
    grad[o.v + i]! += dy * k.hs[T * H + i]!;
    k.dh[i] = dy * w[o.v + i]!;
    k.dc[i] = 0;
  }
  for (let t = T - 1; t >= 0; t--) {
    const g0 = t * 4 * H;
    const hp = t * H;
    for (let i = 0; i < H; i++) {
      const ig = k.gates[g0 + i]!;
      const fg = k.gates[g0 + H + i]!;
      const og = k.gates[g0 + 2 * H + i]!;
      const gg = k.gates[g0 + 3 * H + i]!;
      const tcv = k.tc[t * H + i]!;
      const dh = k.dh[i]!;
      const dc = k.dc[i]! + dh * og * (1 - tcv * tcv);
      k.dz[i] = dc * gg * ig * (1 - ig);
      k.dz[H + i] = dc * k.cs[hp + i]! * fg * (1 - fg);
      k.dz[2 * H + i] = dh * tcv * og * (1 - og);
      k.dz[3 * H + i] = dc * ig * (1 - gg * gg);
      k.dc[i] = dc * fg;
    }
    const xt = x[start + t]!;
    k.dh.fill(0);
    for (let r = 0; r < 4 * H; r++) {
      const d = k.dz[r]!;
      if (d === 0) continue;
      grad[o.b + r]! += d;
      grad[o.wx + r]! += d * xt;
      const ur = o.u + r * H;
      for (let j = 0; j < H; j++) {
        grad[ur + j]! += d * k.hs[hp + j]!;
        k.dh[j]! += d * w[ur + j]!;
      }
    }
  }
}

/** The prediction for the window x[start .. start + T). */
export function lstmPredict(net: Lstm, x: ArrayLike<number>, start: number, T: number): number {
  return forward(net, x, start, T, new Cache(net.H, T));
}

/** Loss ½(ŷ − target)² and its gradient for one window (exported for the gradient check). */
export function lstmLossGrad(net: Lstm, x: ArrayLike<number>, T: number, target: number, grad: Float64Array): number {
  const k = new Cache(net.H, T);
  const y = forward(net, x, 0, T, k);
  backward(net, x, 0, T, k, y - target, grad);
  return 0.5 * (y - target) ** 2;
}

export interface TrainResult {
  net: Lstm;
  epochsRun: number;
  bestEpoch: number;
  valRmse: number;
  trainRmse: number;
  capped: boolean;
  /** Training plus validation windows actually used (the most recent ones). */
  windowsUsed: number;
  windowsTotal: number;
  /** Passes allowed after the work cap. */
  epochsAllowed: number;
  stoppedEarly: boolean;
}

/** Trains on windows of the scaled series `x`: inputs x[i..i+T), target x[i+T]. */
export function trainLstm(x: Float64Array, T: number, H: number, epochs: number, rng: Rng, budget = 1.2e9): TrainResult {
  const windows = x.length - T;
  // Work per window-pass ≈ T·4H(H + 2) multiply-adds; backprop costs about twice the forward pass,
  // so an epoch costs about perWindow · (3·train + validation).
  const perWindow = T * 4 * H * (H + 2);
  const epochCost = (used: number) => perWindow * (3 * (used - Math.max(1, Math.round(used * 0.15))) + Math.max(1, Math.round(used * 0.15)));
  let used = windows;
  let capped = false;
  if (epochCost(used) * epochs > budget) {
    capped = true;
    epochs = Math.max(5, Math.floor(budget / epochCost(used)));
    // Still too much at five passes: train on the most recent windows only.
    while (used > 40 && epochCost(used) * epochs > budget) used = Math.max(40, Math.floor(used * 0.9));
  }
  const nVal = Math.max(1, Math.round(used * 0.15));
  const nTrain = used - nVal;
  if (nTrain < 2) throw new ModelError("Too few windows to train on.");
  const firstTrain = windows - used;
  const net = createLstm(H, rng);
  const P = net.w.length;
  const grad = new Float64Array(P);
  const m1 = new Float64Array(P);
  const m2 = new Float64Array(P);
  const best = Float64Array.from(net.w);
  const k = new Cache(H, T);
  const order = Array.from({ length: nTrain }, (_, i) => firstTrain + i);
  const lr = 0.01;
  const b1 = 0.9;
  const b2 = 0.999;
  const batch = 16;
  const patience = 20;
  let step = 0;
  let bestVal = Infinity;
  let bestEpoch = 0;
  let epochsRun = 0;
  let stoppedEarly = false;
  const valStart = windows - nVal;
  for (let ep = 0; ep < epochs; ep++) {
    rng.shuffle(order);
    for (let s0 = 0; s0 < nTrain; s0 += batch) {
      grad.fill(0);
      const end = Math.min(nTrain, s0 + batch);
      for (let b = s0; b < end; b++) {
        const i = order[b]!;
        const y = forward(net, x, i, T, k);
        backward(net, x, i, T, k, y - x[i + T]!, grad);
      }
      const bs = end - s0;
      let norm = 0;
      for (let j = 0; j < P; j++) {
        grad[j]! /= bs;
        norm += grad[j]! * grad[j]!;
      }
      // Clip the gradient norm at 5 (Pascanu et al. 2013) so a bad batch cannot blow up the weights.
      const clip = Math.sqrt(norm) > 5 ? 5 / Math.sqrt(norm) : 1;
      step++;
      const c1 = 1 - b1 ** step;
      const c2 = 1 - b2 ** step;
      for (let j = 0; j < P; j++) {
        const g = grad[j]! * clip;
        m1[j] = b1 * m1[j]! + (1 - b1) * g;
        m2[j] = b2 * m2[j]! + (1 - b2) * g * g;
        net.w[j]! -= (lr * (m1[j]! / c1)) / (Math.sqrt(m2[j]! / c2) + 1e-8);
      }
    }
    epochsRun = ep + 1;
    let v = 0;
    for (let i = valStart; i < windows; i++) v += (forward(net, x, i, T, k) - x[i + T]!) ** 2;
    v /= nVal;
    if (v < bestVal - 1e-12) {
      bestVal = v;
      bestEpoch = ep + 1;
      best.set(net.w);
    } else if (ep + 1 - bestEpoch >= patience) {
      stoppedEarly = true;
      break;
    }
  }
  net.w.set(best);
  let tr = 0;
  for (let i = firstTrain; i < firstTrain + nTrain; i++) tr += (forward(net, x, i, T, k) - x[i + T]!) ** 2;
  return { net, epochsRun, bestEpoch, valRmse: Math.sqrt(bestVal), trainRmse: Math.sqrt(tr / nTrain), capped, stoppedEarly, windowsUsed: used, windowsTotal: windows, epochsAllowed: epochs };
}

/** LSTM forecast (one layer, Adam, early stopping). */
export const runLstm: ModelRunner = (data, spec, ctx) => {
  const T = Math.round(numParam(spec, 'window', 12, 2, 60));
  const H = Math.round(numParam(spec, 'hidden', 12, 2, 48));
  const epochs = Math.round(numParam(spec, 'epochs', 150, 10, 2000));
  const horizon = Math.round(numParam(spec, 'horizon', 6, 1, 120));
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  const seed = Math.round(numParam(spec, 'seed', 1, 1, 1_000_000));
  const s = timeSeries(data, 4);
  const notes = gapNote(s.values);
  const y = Float64Array.from(interpolate(s.values));
  const n = y.length;
  if (n < T + 20) throw new ModelError(`With a look-back of ${T} periods the network needs at least ${T + 20} periods; this flag has ${n}. Shorten the look-back or use smoothing.`);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of y) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const x = y.map((v) => (v - lo) / range);
  const rng = new Rng((ctx.seed ^ seed) >>> 0);
  const tr = trainLstm(x, T, H, epochs, rng);
  const net = tr.net;

  const fitted: Array<number | null> = new Array<number | null>(n).fill(null);
  // The in-sample fit costs one forward pass per window: draw it for the latest windows only on long series.
  const fitFrom = Math.max(0, n - T - Math.floor(2e8 / (T * 4 * H * (H + 2))));
  for (let i = fitFrom; i + T < n; i++) fitted[i + T] = lo + range * lstmPredict(net, x, i, T);
  if (fitFrom > 0) notes.push(`The one-step fit is drawn for the latest ${(n - T - fitFrom).toLocaleString("en-US")} periods only, to save time.`);
  const ext = new Float64Array(n + horizon);
  ext.set(x);
  const fc = new Float64Array(horizon);
  for (let h = 0; h < horizon; h++) {
    const v = lstmPredict(net, ext, n + h - T, T);
    ext[n + h] = v;
    fc[h] = lo + range * v;
  }
  // Approximate band: the validation one-step error, widened like a random walk (σ√h).
  const sigma = tr.valRmse * range;
  const z = zFor(level);
  const low = fc.map((v, h) => v - z * sigma * Math.sqrt(h + 1));
  const high = fc.map((v, h) => v + z * sigma * Math.sqrt(h + 1));
  const { chart, table, future } = forecastChart({ series: s, actual: s.values, fit: fitted, forecast: fc, lower: low, upper: high, level, fitName: 'One-step fit' });
  const when = future[horizon - 1]!;
  const f = metricFmt(s);

  if (tr.capped) notes.push(`Training was capped at ${tr.epochsAllowed} passes${tr.windowsUsed < tr.windowsTotal ? ` over the latest ${tr.windowsUsed.toLocaleString("en-US")} of ${tr.windowsTotal.toLocaleString("en-US")} windows` : ""} to keep the run to a couple of seconds; fewer hidden units or a shorter look-back allow more.`);
  if (tr.stoppedEarly) notes.push(`Training stopped early after ${tr.epochsRun} passes: the held-out periods stopped improving at pass ${tr.bestEpoch}.`);
  notes.push('The band is approximate: it comes from the error on the held-out last 15% of periods, widened with the square root of the horizon.');
  notes.push('Neural networks need long histories; on short or noisy series, smoothing or ARIMA is usually as good and easier to explain.');
  if (n < 60) notes.push(`Only ${n} periods: the network has little to learn from.`);

  return {
    model: 'lstm',
    headline: forecastHeadline(s, fc[horizon - 1]!, low[horizon - 1]!, high[horizon - 1]!, level, when, lastNumber(s.values)),
    sentences: [
      `A small neural network (one LSTM layer of ${H} units) learned to predict each period from the ${T} before it, then forecast ${horizon} period${horizon === 1 ? '' : 's'} ahead by feeding its own predictions back in.`,
      `On the held-out last 15% of history it was typically off by about ${f(sigma)} one period ahead${tr.trainRmse > 0 ? `, against ${f(tr.trainRmse * range)} on the periods it trained on` : ''}.`,
      `It trained for ${tr.epochsRun} passes and kept the weights from pass ${tr.bestEpoch}, where the held-out error was lowest.`,
    ],
    stats: [
      { label: `Forecast, ${when}`, value: fc[horizon - 1]!, format: 'metric' },
      { label: 'Held-out error', value: sigma, format: 'metric', hint: 'Root mean squared one-step error on the last 15% of windows.' },
      { label: 'Training passes', value: tr.epochsRun, format: 'integer' },
      { label: 'Hidden units', value: H, format: 'integer' },
    ],
    chart,
    table,
    notes,
  };
};

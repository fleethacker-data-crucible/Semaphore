// Weibull reliability: time to failure, MTBF and B10 life. Each row is an item with its time to
// failure (first measure) and, optionally, whether it failed (second measure; 0 = still running, a
// right-censored time).
//
// Methods: the two-parameter Weibull fitted by maximum likelihood with right censoring, over
// (log shape, log scale) by Nelder–Mead, started from median-rank regression (Johnson's adjusted
// ranks with Bernard's approximation). Standard errors from the observed information (a numerical
// Hessian of the log-likelihood), giving intervals on shape and scale on the log scale. MTBF =
// scale·Γ(1 + 1/shape); B10 life = scale·(−ln 0.9)^(1/shape); reliability R(t) = exp(−(t/scale)^shape).

import { fmt, pct } from '../format.ts';
import { inverse } from '../linalg.ts';
import { nelderMead } from '../optimize.ts';
import { gammaFn, median, zFor } from '../stats.ts';
import { ModelError, type ModelRunner, type ModelStat, numParam } from '../types.ts';
import { kaplanMeier, lifetimes } from './survival.ts';

/** Weibull log-likelihood with right censoring, in (u = log shape, v = log scale). */
function weibullLogLik(times: ArrayLike<number>, events: ArrayLike<number>, u: number, v: number): number {
  const b = Math.exp(u);
  let ll = 0;
  for (let i = 0; i < times.length; i++) {
    const lz = Math.log(times[i]!) - v;
    const zb = Math.exp(b * lz);
    ll -= zb;
    if (events[i]) ll += u + (b - 1) * lz - v;
  }
  return ll;
}

/** Median-rank regression start: Johnson's adjusted ranks, Bernard's (i − 0.3)/(n + 0.4). */
export function medianRankStart(times: ArrayLike<number>, events: ArrayLike<number>): { shape: number; scale: number } {
  const n = times.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => times[a]! - times[b]! || events[b]! - events[a]!);
  let prev = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  idx.forEach((i, pos) => {
    if (!events[i]) return;
    const reverse = n - pos;
    const rank = prev + (n + 1 - prev) / (1 + reverse);
    prev = rank;
    const f = (rank - 0.3) / (n + 0.4);
    xs.push(Math.log(times[i]!));
    ys.push(Math.log(-Math.log(1 - f)));
  });
  const m = xs.length;
  if (m >= 2) {
    const mx = xs.reduce((a, b) => a + b, 0) / m;
    const my = ys.reduce((a, b) => a + b, 0) / m;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < m; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    const shape = sxx > 0 ? sxy / sxx : Number.NaN;
    if (shape > 0 && Number.isFinite(shape)) return { shape, scale: Math.exp(mx - my / shape) };
  }
  let tot = 0;
  for (let i = 0; i < n; i++) tot += times[i]!;
  return { shape: 1, scale: tot / Math.max(1, m) };
}

export interface WeibullFit {
  shape: number;
  scale: number;
  /** Covariance of (log shape, log scale). */
  cov: number[][] | null;
  loglik: number;
}

/** Maximum likelihood Weibull with right censoring. */
export function fitWeibull(times: ArrayLike<number>, events: ArrayLike<number>): WeibullFit {
  // Work in time units of the median, so the optimiser sees numbers near 1.
  const unit = median(times) || 1;
  const t = Float64Array.from(times as ArrayLike<number>, (x) => x / unit);
  const start = medianRankStart(t, events);
  const nll = (p: number[]) => -weibullLogLik(t, events, p[0]!, p[1]!);
  let res = nelderMead(nll, [Math.log(start.shape), Math.log(start.scale)], { step: 0.2, maxIter: 2000, tol: 1e-14 });
  res = nelderMead(nll, res.x, { step: 0.02, maxIter: 2000, tol: 1e-15 });
  const [u, v] = res.x as [number, number];
  // Observed information: the numerical Hessian of the negative log-likelihood (central differences).
  const h = 1e-4;
  const f = (a: number, b: number) => nll([a, b]);
  const f0 = f(u, v);
  const huu = (f(u + h, v) - 2 * f0 + f(u - h, v)) / (h * h);
  const hvv = (f(u, v + h) - 2 * f0 + f(u, v - h)) / (h * h);
  const huv = (f(u + h, v + h) - f(u + h, v - h) - f(u - h, v + h) + f(u - h, v - h)) / (4 * h * h);
  const cov = inverse([
    [huu, huv],
    [huv, hvv],
  ]);
  const ok = cov && cov[0]![0]! > 0 && cov[1]![1]! > 0 ? cov : null;
  return { shape: Math.exp(u), scale: Math.exp(v) * unit, cov: ok, loglik: -res.fx - countEvents(events) * Math.log(unit) };
}

function countEvents(e: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < e.length; i++) s += e[i] ? 1 : 0;
  return s;
}

export const mtbf = (shape: number, scale: number) => scale * gammaFn(1 + 1 / shape);
export const bLife = (shape: number, scale: number, q = 0.1) => scale * (-Math.log(1 - q)) ** (1 / shape);
export const reliability = (t: number, shape: number, scale: number) => Math.exp(-((t / scale) ** shape));

export const runWeibull: ModelRunner = (data, spec) => {
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  const mission = numParam(spec, 'mission', 0, 0, Number.MAX_VALUE);
  const lt = lifetimes(data, true);
  const notes = [...lt.notes];
  const n = lt.times.length;
  const failures = countEvents(lt.events);
  if (failures < 3) throw new ModelError(`Weibull needs at least 3 failures to fit; this flag has ${failures}${n ? ` among ${n} items` : ''}.`);
  const mf = data.metrics[0]?.format;
  const tl = data.metrics[0]!.label;
  const fit = fitWeibull(lt.times, lt.events);
  const { shape, scale } = fit;
  const z = zFor(level);
  const seU = fit.cov ? Math.sqrt(fit.cov[0]![0]!) : Number.NaN;
  const seV = fit.cov ? Math.sqrt(fit.cov[1]![1]!) : Number.NaN;
  const shapeLo = shape * Math.exp(-z * seU);
  const shapeHi = shape * Math.exp(z * seU);
  const scaleLo = scale * Math.exp(-z * seV);
  const scaleHi = scale * Math.exp(z * seV);
  const mt = mtbf(shape, scale);
  const b10 = bLife(shape, scale);
  const rMission = mission > 0 ? reliability(mission, shape, scale) : null;
  const lvl = `${Math.round(level * 100)}%`;
  if (!fit.cov) notes.push('The fit is too flat to give intervals on shape and scale; add more failures.');

  // Shape: below 1 early failures, about 1 random, above 1 wear-out (judged by its interval).
  const kind = Number.isFinite(shapeHi) && shapeHi < 1 ? 'early' : Number.isFinite(shapeLo) && shapeLo > 1 ? 'wear' : Number.isFinite(shapeLo) ? 'random' : shape < 0.9 ? 'early' : shape > 1.1 ? 'wear' : 'random';
  const meaning =
    kind === 'early'
      ? `The shape is ${fmt(shape, 'decimal')}, below 1: failures come early and the failure rate falls with age (infant mortality). Burn-in, better installation and quality checks help; replacing old units with new ones on a schedule would add failures, not remove them.`
      : kind === 'wear'
        ? `The shape is ${fmt(shape, 'decimal')}, above 1: the failure rate rises with age (wear-out). Replacing units before about ${fmt(b10, 'metric', mf)} (the B10 life) prevents most failures.`
        : `The shape is ${fmt(shape, 'decimal')}, close to 1: failures come at random, whatever the age. Scheduled replacement will not help; plan spares for a steady rate and look for outside causes.`;
  const headline = `The mean time between failures is ${fmt(mt, 'metric', mf)} (${tl}); 10% fail by ${fmt(b10, 'metric', mf)} (B10 life).`;
  const sentences = [meaning, `Shape ${lvl} interval ${fmt(shapeLo, 'decimal')} to ${fmt(shapeHi, 'decimal')}; scale (the time by which 63% have failed) ${fmt(scale, 'metric', mf)}, interval ${fmt(scaleLo, 'metric', mf)} to ${fmt(scaleHi, 'metric', mf)}.`];
  if (rMission !== null) sentences.push(`The chance a unit lasts the mission time of ${fmt(mission, 'metric', mf)} is ${pct(rMission)}.`);
  if (n > failures) sentences.push(`${n - failures} of ${n} units are still running; the fit counts the time they have run without failing.`);

  const stats: ModelStat[] = [
    { label: 'MTBF', value: mt, format: 'metric', hint: 'Mean time to failure: scale × Γ(1 + 1/shape).' },
    { label: 'B10 life', value: b10, format: 'metric', hint: 'The time by which 10% of units have failed.' },
    { label: 'Shape', value: shape, format: 'decimal', hint: 'Below 1 early failures, about 1 random, above 1 wear-out.' },
    { label: 'Scale', value: scale, format: 'metric', hint: 'The time by which 63% of units have failed.' },
    ...(rMission !== null ? [{ label: 'Reliability at mission', value: rMission, format: 'percent' as const, hint: `The chance of lasting ${fmt(mission, 'metric', mf)}.` }] : []),
  ];

  let tMax = 0;
  for (const t of lt.times) tMax = Math.max(tMax, t);
  tMax = Math.max(tMax, mission) * 1.1;
  const xs = Array.from({ length: 81 }, (_, i) => (tMax * i) / 80);
  const km = kaplanMeier(lt.times, lt.events, level);
  const chart = {
    kind: 'curves' as const,
    curves: [
      { name: 'Weibull reliability', x: xs, y: xs.map((t) => reliability(t, shape, scale)) },
      { name: 'Observed (Kaplan-Meier)', x: [0, ...km.map((s) => s.time)], y: [1, ...km.map((s) => s.survival)], step: true },
    ],
    xLabel: tl,
    yLabel: 'Chance still working',
    yPercent: true,
  };
  const table = {
    columns: ['Figure', 'Estimate', `Low (${lvl})`, `High (${lvl})`],
    rows: [
      ['Shape', shape, shapeLo, shapeHi],
      ['Scale', scale, scaleLo, scaleHi],
      ['MTBF', mt, null, null],
      ['B10 life', b10, null, null],
      ...(rMission !== null ? [[`Reliability at ${fmt(mission, 'metric', mf)}`, rMission, null, null]] : []),
      ['Units', n, null, null],
      ['Failures', failures, null, null],
    ] as Array<Array<string | number | null>>,
  };
  if (failures < 10) notes.push(`Only ${failures} failures: the shape is uncertain, so read the interval as well as the estimate.`);
  return { model: 'weibull', headline, sentences: sentences.slice(0, 5), stats, chart, table, notes };
};

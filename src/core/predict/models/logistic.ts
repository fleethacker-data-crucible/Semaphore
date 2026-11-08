// Logistic regression: the chance of an outcome, and how each driver moves the odds. Fitted by
// maximum likelihood with iteratively reweighted least squares (Newton–Raphson) and step halving, on
// drivers centred and scaled for stability, then mapped back to the drivers' own units.
//
// The outcome is the first measure: above the `threshold` setting counts as yes (1); with threshold 0
// the values are read as 0–1 shares and fitted as fractional binomial responses (Papke and
// Wooldridge's quasi-likelihood). Complete or quasi-complete separation (a driver that splits yes from
// no perfectly, so the coefficients run off to infinity) is detected and handled with a small ridge
// penalty (as in Firth-style bias reduction, simpler). Reported: odds ratios with Wald intervals and
// p-values, McFadden's pseudo-R², and the AUC (Mann–Whitney) for 0/1 outcomes.

import { droppedNote, items } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { inverse, solve } from '../linalg.ts';
import { mean, normalCdf, sd, zFor } from '../stats.ts';
import { type ModelChart, ModelError, type ModelRunner, type ModelStat, numParam } from '../types.ts';

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export interface LogitFit {
  /** Coefficients on the design given (intercept first). */
  beta: number[];
  /** Inverse of the (penalised) information matrix: the covariance of beta. */
  cov: number[][];
  loglik: number;
  iterations: number;
  converged: boolean;
}

/** Bernoulli/binomial log-likelihood with fractional y allowed. */
function loglik(x: number[][], y: ArrayLike<number>, beta: number[]): number {
  let ll = 0;
  for (let i = 0; i < x.length; i++) {
    let eta = 0;
    const row = x[i]!;
    for (let j = 0; j < row.length; j++) eta += row[j]! * beta[j]!;
    // log p = -log(1+e^-eta), log(1-p) = -log(1+e^eta), computed stably.
    const lp = eta >= 0 ? -Math.log1p(Math.exp(-eta)) : eta - Math.log1p(Math.exp(eta));
    const lq = eta >= 0 ? -eta - Math.log1p(Math.exp(-eta)) : -Math.log1p(Math.exp(eta));
    ll += y[i]! * lp + (1 - y[i]!) * lq;
  }
  return ll;
}

/**
 * IRLS / Newton–Raphson for logistic regression with an optional ridge penalty `lambda` on every
 * coefficient but the intercept, and step halving whenever a full step lowers the likelihood.
 */
export function fitLogit(x: number[][], y: ArrayLike<number>, lambda = 0, maxIter = 100): LogitFit {
  const n = x.length;
  const p = x[0]?.length ?? 0;
  let beta = new Array<number>(p).fill(0);
  const pen = (b: number[]) => {
    let s = 0;
    for (let j = 1; j < p; j++) s += b[j]! * b[j]!;
    return 0.5 * lambda * s;
  };
  let obj = loglik(x, y, beta) - pen(beta);
  let converged = false;
  let it = 0;
  let h: number[][] = [];
  const info = (b: number[]) => {
    const g = new Array<number>(p).fill(0);
    const hh = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < n; i++) {
      const row = x[i]!;
      let eta = 0;
      for (let j = 0; j < p; j++) eta += row[j]! * b[j]!;
      const mu = sigmoid(eta);
      const w = mu * (1 - mu);
      const r = y[i]! - mu;
      for (let j = 0; j < p; j++) {
        g[j]! += row[j]! * r;
        const wj = w * row[j]!;
        for (let k = j; k < p; k++) hh[j]![k]! += wj * row[k]!;
      }
    }
    for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) hh[j]![k] = hh[k]![j]!;
    for (let j = 1; j < p; j++) {
      g[j]! -= lambda * b[j]!;
      hh[j]![j]! += lambda;
    }
    return { g, hh };
  };
  for (; it < maxIter; it++) {
    const { g, hh } = info(beta);
    h = hh;
    const step = solve(hh, g);
    if (!step) break;
    let t = 1;
    let next = beta;
    let nextObj = obj;
    for (let half = 0; half < 30; half++) {
      next = beta.map((b, j) => b + t * step[j]!);
      nextObj = loglik(x, y, next) - pen(next);
      if (nextObj >= obj - 1e-12) break;
      t /= 2;
    }
    const change = nextObj - obj;
    beta = next;
    obj = nextObj;
    if (Math.abs(change) < 1e-10 * (Math.abs(obj) + 1e-10) && Math.max(...step.map((s) => Math.abs(s * t))) < 1e-8) {
      converged = true;
      it++;
      break;
    }
  }
  h = info(beta).hh;
  const cov = inverse(h) ?? h.map((row, i) => row.map((_, j) => (i === j ? Infinity : 0)));
  return { beta, cov, loglik: loglik(x, y, beta), iterations: it, converged };
}

/** The area under the ROC curve by the Mann–Whitney U statistic, with ties given half credit. */
export function auc(score: ArrayLike<number>, y: ArrayLike<number>): number {
  const idx = Array.from({ length: score.length }, (_, i) => i).sort((a, b) => score[a]! - score[b]!);
  const rank = new Float64Array(score.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && score[idx[j + 1]!] === score[idx[i]!]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]!] = r;
    i = j + 1;
  }
  let n1 = 0;
  let r1 = 0;
  for (let i = 0; i < score.length; i++)
    if (y[i] === 1) {
      n1++;
      r1 += rank[i]!;
    }
  const n0 = score.length - n1;
  return n1 && n0 ? (r1 - (n1 * (n1 + 1)) / 2) / (n1 * n0) : Number.NaN;
}

export const runLogistic: ModelRunner = (data, spec) => {
  const it = items(data, 3, 2);
  const threshold = numParam(spec, 'threshold', 0, -1e300, 1e300);
  const level = numParam(spec, 'level', 0.95, 0.5, 0.999);
  const outcomeName = it.metricLabels[0]!;
  const names = it.metricLabels.slice(1);
  const notes: string[] = [...droppedNote(it.dropped)];
  const raw = it.values.map((r) => r[0]!);
  let y: number[];
  let outcome: string;
  if (threshold !== 0) {
    y = raw.map((v) => (v > threshold ? 1 : 0));
    outcome = `${outcomeName} above ${fmt(threshold, 'metric', data.metrics[0]?.format)}`;
  } else {
    const bad = raw.filter((v) => v < 0 || v > 1).length;
    if (bad) throw new ModelError(`${outcomeName} has ${bad} value${bad === 1 ? '' : 's'} outside 0–1. Set "Outcome above" to a threshold to count a row as yes, or use a 0–1 share.`);
    y = raw;
    outcome = outcomeName;
  }
  const binary = y.every((v) => v === 0 || v === 1);
  if (!binary) notes.push('The outcome was read as 0–1 shares and fitted as fractional responses; the p-values treat each row as one trial, so they are rough.');
  const n = y.length;
  const k = names.length;
  const base = mean(y);
  if (base <= 0 || base >= 1) throw new ModelError(`Every row has the same outcome (${base >= 1 ? 'all yes' : 'all no'}), so there is nothing to tell apart. Check the threshold.`);
  if (n <= k + 1) throw new ModelError(`Logistic regression with ${k} driver${k === 1 ? '' : 's'} needs more than ${k + 1} rows; this flag has ${n}.`);

  // Centre and scale each driver (fitting stability), then map coefficients back.
  const cols = names.map((_, j) => it.values.map((r) => r[j + 1]!));
  const mu = cols.map((c) => mean(c));
  const sdv = cols.map((c) => sd(c));
  const flat = names.filter((_, j) => !(sdv[j]! > 0));
  if (flat.length) throw new ModelError(`${flat.join(', ')} ${flat.length === 1 ? 'is' : 'are'} the same on every row; drop ${flat.length === 1 ? 'it' : 'them'} and run again.`);
  const xs = Array.from({ length: n }, (_, i) => [1, ...cols.map((c, j) => (c[i]! - mu[j]!) / sdv[j]!)]);

  let fit = fitLogit(xs, y, 0);
  let separated = !fit.converged || fit.beta.slice(1).some((b) => !Number.isFinite(b) || Math.abs(b) > 10);
  if (!separated && binary) {
    // Quasi-complete separation: fitted chances pinned at 0 or 1 for every row.
    let pinned = 0;
    for (let i = 0; i < n; i++) {
      let eta = 0;
      for (let j = 0; j <= k; j++) eta += xs[i]![j]! * fit.beta[j]!;
      if (Math.abs(eta) > 15) pinned++;
    }
    separated = pinned === n;
  }
  if (separated) {
    fit = fitLogit(xs, y, 0.01);
    notes.push('A driver separates yes from no almost perfectly, so the plain fit had no finite answer; a small penalty was added to keep the coefficients finite. Treat the odds ratios as "very large" rather than exact.');
  }
  if (!fit.converged) notes.push('The fit did not fully settle in 100 steps; the figures are approximate.');

  // Back to original units: b_j = s_j / sd_j, b0 = s0 − Σ s_j·mean_j/sd_j. Covariance A·C·Aᵀ.
  const p = k + 1;
  const a = Array.from({ length: p }, (_, r) => new Array<number>(p).fill(0));
  a[0]![0] = 1;
  for (let j = 1; j <= k; j++) {
    a[j]![j] = 1 / sdv[j - 1]!;
    a[0]![j] = -mu[j - 1]! / sdv[j - 1]!;
  }
  const beta = a.map((row) => row.reduce((s, v, j) => s + v * fit.beta[j]!, 0));
  const cov = a.map((ri) => a.map((rj) => {
    let s = 0;
    for (let u = 0; u < p; u++) for (let v = 0; v < p; v++) s += ri[u]! * fit.cov[u]![v]! * rj[v]!;
    return s;
  }));
  const z = zFor(level);
  const coef = beta.map((b, j) => {
    const se = Math.sqrt(Math.max(0, cov[j]![j]!));
    const w = se > 0 ? b / se : 0;
    const pv = se > 0 && Number.isFinite(se) ? 2 * (1 - normalCdf(Math.abs(w))) : Number.NaN;
    return { b, se, p: pv, low: b - z * se, high: b + z * se };
  });

  const ll0 = n * (base * Math.log(base) + (1 - base) * Math.log(1 - base));
  const pseudoR2 = 1 - fit.loglik / ll0;
  const pred = xs.map((row) => sigmoid(row.reduce((s, v, j) => s + v * fit.beta[j]!, 0)));
  const area = binary ? auc(pred, y) : Number.NaN;

  // The driver that moves the odds most, ranked on a common scale (per standard deviation).
  const order = names.map((_, j) => j).sort((u, v) => Math.abs(fit.beta[v + 1]!) - Math.abs(fit.beta[u + 1]!));
  const top = order[0]!;
  const tc = coef[top + 1]!;
  const or = Math.exp(tc.b);
  const lvl = `${Math.round(level * 100)}%`;
  const headline = `Each +1 in ${names[top]} multiplies the odds of ${outcome} by ${fmt(or, 'decimal')} (${lvl} interval ${fmt(Math.exp(tc.low), 'decimal')} to ${fmt(Math.exp(tc.high), 'decimal')})${k > 1 ? ', holding the other drivers steady' : ''}.`;
  const sentences: string[] = [];
  sentences.push(`On average ${pct(base)} of rows ${threshold !== 0 ? `have ${outcome}` : `are ${outcome}`}. An odds ratio above 1 raises the chance, below 1 lowers it.`);
  if (k > 1) sentences.push(`${names[top]} moves the odds most for a typical change (one standard deviation, ${fmt(sdv[top]!)}): it multiplies them by ${fmt(Math.exp(fit.beta[top + 1]!), 'decimal')}.`);
  const weak = names.filter((_, j) => !(coef[j + 1]!.p < 0.05));
  if (weak.length && weak.length < k) sentences.push(`${weak.join(', ')} ${weak.length === 1 ? 'shows' : 'show'} no clear effect (p 0.05 or above).`);
  else if (weak.length === k) sentences.push('No driver shows a clear effect (every p-value is 0.05 or above), so the pattern could be chance.');
  if (binary) sentences.push(`The model ranks a random yes above a random no ${pct(area)} of the time (AUC; 50% is a coin toss, 100% perfect).`);
  sentences.push(`McFadden's pseudo-R² is ${fmt(pseudoR2, 'decimal')} (0.2 to 0.4 is a good fit for this kind of model).`);

  const stats: ModelStat[] = [
    { label: 'Odds ratio', value: or, format: 'decimal', hint: `Per +1 in ${names[top]}.` },
    { label: 'Base rate', value: base, format: 'percent', hint: 'The share of yes outcomes in the data.' },
    { label: 'Pseudo-R²', value: pseudoR2, format: 'decimal', hint: "McFadden's: 1 − log-likelihood of the model over that of the base rate alone." },
    ...(binary ? [{ label: 'AUC', value: area, format: 'percent' as const, hint: 'How often a random yes scores above a random no.' }] : []),
    { label: 'Rows', value: n, format: 'integer' },
  ];

  let chart: ModelChart;
  if (k === 1) {
    const c = cols[0]!;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of c) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const xv = Array.from({ length: 61 }, (_, s) => lo + ((hi - lo) * s) / 60);
    const curve = (b0: number, b1: number) => xv.map((v) => sigmoid(b0 + b1 * v));
    // A pointwise Wald band on the linear predictor.
    const band = xv.map((v) => {
      const eta = beta[0]! + beta[1]! * v;
      const se = Math.sqrt(Math.max(0, cov[0]![0]! + 2 * v * cov[0]![1]! + v * v * cov[1]![1]!));
      return [sigmoid(eta - z * se), sigmoid(eta + z * se)] as const;
    });
    chart = { kind: 'curves', curves: [{ name: `Chance of ${outcome}`, x: xv, y: curve(beta[0]!, beta[1]!), lower: band.map((b) => b[0]), upper: band.map((b) => b[1]) }], xLabel: names[0]!, yLabel: `Chance of ${outcome}`, yPercent: true };
  } else {
    chart = { kind: 'bars', labels: order.map((j) => names[j]!), values: order.map((j) => coef[j + 1]!.b), low: order.map((j) => coef[j + 1]!.low), high: order.map((j) => coef[j + 1]!.high), base: 0, xFormat: 'decimal', xLabel: 'Change in log-odds per +1 (0 = no effect)' };
  }
  const table = {
    columns: ['Driver', 'Coefficient (log-odds)', 'Std. error', 'Odds ratio', `OR low (${lvl})`, `OR high (${lvl})`, 'p-value'],
    rows: [
      ['(Intercept)', coef[0]!.b, coef[0]!.se, Math.exp(coef[0]!.b), Math.exp(coef[0]!.low), Math.exp(coef[0]!.high), coef[0]!.p] as Array<string | number | null>,
      ...names.map((nm, j) => {
        const c = coef[j + 1]!;
        return [nm, c.b, c.se, Math.exp(c.b), Math.exp(c.low), Math.exp(c.high), Number.isFinite(c.p) ? c.p : null] as Array<string | number | null>;
      }),
    ],
  };
  if (n < 10 * (k + 1) / Math.min(base, 1 - base)) notes.push(`With ${n} rows and the rarer outcome at ${pct(Math.min(base, 1 - base))}, there are fewer than 10 of the rarer outcome per driver; the estimates may be unsteady.`);
  return { model: 'logistic', headline, sentences: sentences.slice(0, 5), stats, chart, table, notes };
};

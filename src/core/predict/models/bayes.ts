// Bayesian rates with shrinkage. Each group's rate (events out of trials, or events per unit of
// exposure) is pulled toward the rate of all groups together, more so the smaller the group, so a
// 2-out-of-3 does not top a 180-out-of-300. Conjugate models: Beta-binomial for shares and
// Gamma-Poisson for rates per exposure. With prior strength 0 the prior is fitted to the groups by
// the method of moments (empirical Bayes; Efron and Morris, 1975; Casella, 1985), taking out the
// spread that sampling alone would give. Credible intervals are equal-tailed posterior quantiles.

import { cellLabel } from '../data.ts';
import { fmt, pct, article } from '../format.ts';
import { Rng } from '../rng.ts';
import { betaI, gammaP } from '../stats.ts';
import { ModelError, type ModelOutput, type ModelRunner, numParam, param } from '../types.ts';

/** The x with betaI(x, a, b) = p, by bisection. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (betaI(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The x with P(Gamma(shape, rate) ≤ x) = p, by bisection on gammaP. */
export function gammaQuantile(p: number, shape: number, rate: number): number {
  let lo = 0;
  let hi = (shape + 10 * Math.sqrt(shape) + 10) / rate;
  while (gammaP(shape, hi * rate) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (gammaP(shape, mid * rate) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-12 * hi) break;
  }
  return (lo + hi) / 2;
}

const SIMS = 20000;

export const runBayes: ModelRunner = (data, spec, ctx): ModelOutput => {
  const notes: string[] = [];
  if (data.metrics.length < 2) throw new ModelError('A Bayesian rate needs two measures: the number of events, then the number of trials (or the exposure, such as hours).');
  const poisson = param(spec, 'likelihood', 'binomial') === 'poisson';
  const strength = numParam(spec, 'prior', 0, 0, 10000);
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  const lv = fmt(level, 'percent');

  const groups: Array<{ name: string; y: number; n: number }> = [];
  let dropped = 0;
  for (const [i, r] of data.rows.entries()) {
    const y = r.values[0];
    const n = r.values[1];
    if (typeof y !== 'number' || typeof n !== 'number' || !Number.isFinite(y) || !Number.isFinite(n) || n <= 0) {
      dropped++;
      continue;
    }
    const name = data.dims.length ? r.dims.map((c, j) => cellLabel(c, data.dims[j]?.grain)).join(' · ') : `Row ${i + 1}`;
    if (y < 0) throw new ModelError(`"${name}" has ${y} events; events cannot be negative.`);
    if (!poisson && y > n) throw new ModelError(`"${name}" has ${y} events out of ${n} trials; events cannot exceed trials. If the second measure is exposure (hours, miles), choose "Rate per exposure".`);
    groups.push({ name, y, n });
  }
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out: a blank measure, or no trials or exposure.`);
  if (!groups.length) throw new ModelError('No row has both a number of events and a positive number of trials or exposure.');

  const Y = groups.reduce((a, g) => a + g.y, 0);
  const N = groups.reduce((a, g) => a + g.n, 0);
  const pooled = Y / N;
  const rates = groups.map((g) => g.y / g.n);

  // The prior: a Beta(α, β) for shares, a Gamma(α, rate β) for rates per exposure.
  let alpha: number;
  let beta: number;
  let how: string;
  if (strength > 0) {
    const m = poisson ? Math.max(pooled, 0.5 / N) : Math.min(1 - 0.5 / N, Math.max(0.5 / N, pooled));
    if (poisson) {
      alpha = strength * m;
      beta = strength;
    } else {
      alpha = strength * m;
      beta = strength * (1 - m);
    }
    how = `a prior centred on the overall rate, worth ${fmt(strength, 'decimal')} ${poisson ? 'units of exposure' : 'trials'}`;
  } else {
    // Weighted method of moments (Clayton and Kaldor, 1987; the DerSimonian–Laird form): the
    // trial-weighted spread of the group rates less what sampling alone would give,
    //   τ² = (Σ nᵢ(rᵢ − m)² − v·(k − 1)) / (Σ nᵢ − Σ nᵢ² / Σ nᵢ),  v = m(1 − m) or m.
    // Weighting by size stops a 2-of-3 group from inflating the between-group spread.
    const k = groups.length;
    const v = poisson ? pooled : pooled * (1 - pooled);
    let q = 0;
    let n2 = 0;
    for (const [i, g] of groups.entries()) {
      q += g.n * (rates[i]! - pooled) ** 2;
      n2 += g.n * g.n;
    }
    const denom = N - n2 / N;
    const tau2 = k >= 3 && denom > 0 ? (q - v * (k - 1)) / denom : 0;
    const fit = groups.length >= 3 && pooled > 0 && (poisson || pooled < 1) && tau2 > 1e-12 * Math.max(1, pooled * pooled);
    let ok = false;
    alpha = 1;
    beta = 1;
    if (fit) {
      if (poisson) {
        beta = pooled / tau2;
        alpha = pooled * beta;
        ok = alpha > 0 && beta > 0;
      } else {
        const ab = (pooled * (1 - pooled)) / tau2 - 1;
        alpha = pooled * ab;
        beta = (1 - pooled) * ab;
        ok = ab > 0;
      }
    }
    if (ok) {
      how = `a prior learnt from all ${groups.length} groups (empirical Bayes), worth about ${fmt(poisson ? beta : alpha + beta, 'decimal')} ${poisson ? 'units of exposure' : 'trials'}`;
    } else {
      // Too few groups, or they differ no more than chance: a weak prior instead.
      if (poisson) {
        alpha = 0.5;
        beta = pooled > 0 ? 0.5 / pooled : 1e-6;
      } else {
        alpha = 1;
        beta = 1;
      }
      how = poisson ? 'a weak prior worth half an event at the overall rate' : 'a flat prior (Beta(1, 1))';
      notes.push(
        groups.length < 3
          ? 'With fewer than three groups the prior cannot be learnt from the data, so a weak one was used.'
          : 'The groups differ no more than chance alone would explain, so a weak prior was used; treat differences between them as likely noise.',
      );
    }
  }

  const lo = (1 - level) / 2;
  const post = groups.map((g, i) => {
    const a = alpha + g.y;
    const b = poisson ? beta + g.n : beta + g.n - g.y;
    const meanP = poisson ? a / b : a / (a + b);
    const low = poisson ? gammaQuantile(lo, a, b) : betaQuantile(lo, a, b);
    const high = poisson ? gammaQuantile(1 - lo, a, b) : betaQuantile(1 - lo, a, b);
    return { ...g, raw: rates[i]!, a, b, mean: meanP, low, high };
  });
  post.sort((p, q) => q.mean - p.mean);
  const top = post[0]!;
  const next = post[1];

  // P(top's rate > next's) by seeded simulation from the two posteriors.
  let pBeat: number | null = null;
  if (next) {
    const rng = new Rng((ctx.seed ^ 0x6a7e5) >>> 0);
    let wins = 0;
    for (let s = 0; s < SIMS; s++) {
      const x = poisson ? rng.gamma(top.a) / top.b : rng.beta(top.a, top.b);
      const y = poisson ? rng.gamma(next.a) / next.b : rng.beta(next.a, next.b);
      if (x > y) wins++;
    }
    pBeat = wins / SIMS;
  }

  const rf = (v: number) => (poisson ? `${fmt(v, 'decimal')} per unit` : pct(v));
  const exposure = data.metrics[1]?.label ?? (poisson ? 'exposure' : 'trials');
  const headline =
    next && pBeat !== null
      ? `After allowing for group size, ${top.name} has the highest rate at ${rf(top.mean)} (${lv} credible ${rf(top.low)} to ${rf(top.high)}), with ${article(pct(pBeat))} ${pct(pBeat)} chance it is truly higher than ${next.name}.`
      : `The rate is ${rf(top.mean)}, and with ${lv} probability it lies between ${rf(top.low)} and ${rf(top.high)}.`;
  const sentences: string[] = [];
  sentences.push(`Each group's rate is pulled toward the overall ${rf(pooled)} by ${how}; small groups move most, large ones hardly at all.`);
  const rawTop = [...post].sort((p, q) => q.raw - p.raw)[0]!;
  if (next && rawTop.name !== top.name) sentences.push(`${rawTop.name} has the highest raw rate (${rf(rawTop.raw)} from ${fmt(rawTop.n, 'decimal')} ${exposure}), but on so little data it drops back once shrunk.`);
  if (pBeat !== null) sentences.push(pBeat >= 0.9 ? `${top.name} is fairly clearly ahead of ${next!.name}.` : `${top.name} and ${next!.name} could easily swap places with more data.`);
  sentences.push(`A ${lv} credible interval means there is ${article(lv)} ${lv} probability the true rate is inside it, given the data and the prior.`);
  if (poisson) notes.push(`Rates are events per one unit of ${exposure}.`);

  const shown = post.slice(0, 40);
  if (post.length > 40) notes.push(`The chart shows the 40 highest groups; the table lists all ${post.length.toLocaleString('en-US')}.`);
  const valueFormat = poisson ? 'decimal' : 'percent';
  return {
    model: 'bayes',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Highest after shrinkage', value: top.name },
      { label: 'Its rate', value: top.mean, format: valueFormat, hint: `${lv} credible: ${rf(top.low)} to ${rf(top.high)}.` },
      ...(pBeat !== null ? [{ label: `Chance it beats ${next!.name}`, value: pBeat, format: 'percent' as const, hint: 'From simulating both posteriors.' }] : []),
      { label: 'Overall rate', value: pooled, format: valueFormat, hint: 'All events over all trials or exposure.' },
      { label: 'Groups', value: groups.length, format: 'integer' },
    ],
    chart: { kind: 'bars', labels: shown.map((p) => p.name), values: shown.map((p) => p.mean), low: shown.map((p) => p.low), high: shown.map((p) => p.high), xFormat: valueFormat, xLabel: poisson ? `Events per unit of ${exposure}` : 'Rate' },
    table: {
      columns: ['Group', data.metrics[0]?.label ?? 'Events', exposure, 'Raw rate', 'Rate after shrinkage', `${lv} low`, `${lv} high`],
      rows: post.map((p) => [p.name, p.y, p.n, p.raw, p.mean, p.low, p.high]),
    },
    notes,
  };
};

// Bootstrap confidence interval (Efron, 1979): resample the rows with replacement many times,
// recompute the figure each time, and read the interval off the spread of the resampled figures.
// Two intervals: the plain percentile interval, and the bias-corrected and accelerated (BCa)
// interval of Efron (1987), with its acceleration from the jackknife (Efron and Tibshirani,
// An Introduction to the Bootstrap, ch. 14). BCa is the one quoted when it can be computed.

import { fmt } from '../format.ts';
import { Rng } from '../rng.ts';
import { histogram, mean, normalCdf, normalInv, quantileSorted, sd as sdOf } from '../stats.ts';
import { ModelError, type ModelOutput, type ModelRunner, numParam, param } from '../types.ts';

type Stat = 'mean' | 'median' | 'total' | 'sd';

const WORDS: Record<Stat, string> = { mean: 'average', median: 'median', total: 'total', sd: 'standard deviation' };

/** Values touched per run (resamples × rows; × 3 for the median's sort); resamples are cut to fit. */
const MAX_WORK = 20_000_000;

function statOf(stat: Stat, xs: Float64Array): number {
  if (stat === 'median') return quantileSorted(xs.sort(), 0.5);
  if (stat === 'total') {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[i]!;
    return s;
  }
  if (stat === 'mean') return mean(xs);
  return sdOf(xs);
}

/** Leave-one-out values of the figure (the jackknife), each in O(1) from sums or the sorted sample. */
function jackknife(stat: Stat, xs: Float64Array): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  if (stat === 'median') {
    const s = Float64Array.from(xs).sort();
    const m = n - 1;
    const h = (m - 1) / 2;
    const lo = Math.floor(h);
    const hi = Math.min(m - 1, lo + 1);
    // Element k of the sample with sorted position j removed.
    const at = (k: number, j: number) => s[k < j ? k : k + 1]!;
    const bySorted = new Float64Array(n);
    for (let j = 0; j < n; j++) bySorted[j] = at(lo, j) + (h - lo) * (at(hi, j) - at(lo, j));
    // Which sorted position each row holds; ties share a value, so any matching position will do.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
    order.forEach((row, j) => (out[row] = bySorted[j]!));
    return out;
  }
  const c = mean(xs);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - c;
    s1 += d;
    s2 += d * d;
  }
  for (let i = 0; i < n; i++) {
    const d = xs[i]! - c;
    if (stat === 'total') out[i] = c * (n - 1) + s1 - d;
    else if (stat === 'mean') out[i] = c + (s1 - d) / (n - 1);
    else {
      const a = s1 - d;
      const v = (s2 - d * d - (a * a) / (n - 1)) / (n - 2);
      out[i] = Math.sqrt(Math.max(0, v));
    }
  }
  return out;
}

export const runBootstrap: ModelRunner = (data, spec, ctx): ModelOutput => {
  const notes: string[] = [];
  const m0 = data.metrics[0];
  if (!m0) throw new ModelError('The bootstrap needs a measure to put error bars on.');
  const raw = param(spec, 'stat', 'mean');
  const stat: Stat = raw === 'median' || raw === 'total' || raw === 'sd' ? raw : 'mean';
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  let resamples = Math.round(numParam(spec, 'resamples', 5000, 200, 100000));
  const rng = new Rng((ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0);

  const vals: number[] = [];
  let dropped = 0;
  for (const r of data.rows) {
    const v = r.values[0];
    if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    else dropped++;
  }
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out because the measure was blank.`);
  const n = vals.length;
  const minN = stat === 'sd' ? 4 : 3;
  if (n < minN) throw new ModelError(`The bootstrap needs at least ${minN} rows with a number; this flag has ${n}.`);
  if (n < 15) notes.push(`Only ${n} rows: a bootstrap interval from so few tends to be too narrow, so read it as a rough guide.`);
  const xs = Float64Array.from(vals);

  const perResample = n * (stat === 'median' ? 3 : 1);
  if (resamples * perResample > MAX_WORK) {
    const cut = Math.max(200, Math.floor(MAX_WORK / perResample));
    if (cut < resamples) {
      notes.push(`Resamples were cut from ${resamples.toLocaleString('en-US')} to ${cut.toLocaleString('en-US')} to keep the run quick with ${n.toLocaleString('en-US')} rows.`);
      resamples = cut;
    }
  }

  const estimate = statOf(stat, Float64Array.from(xs));
  const boot = new Float64Array(resamples);
  const buf = new Float64Array(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) buf[i] = xs[rng.int(n)]!;
    boot[b] = statOf(stat, buf);
  }
  const sortedBoot = Float64Array.from(boot).sort();
  const alpha = (1 - level) / 2;
  const pLo = quantileSorted(sortedBoot, alpha);
  const pHi = quantileSorted(sortedBoot, 1 - alpha);
  const se = sdOf(boot);

  // BCa: bias correction z0 from the share of resamples below the estimate (ties count half), and
  // acceleration a = Σ(θ̄ − θ₍ᵢ₎)³ / (6 · (Σ(θ̄ − θ₍ᵢ₎)²)^1.5) from the jackknife.
  let below = 0;
  for (let b = 0; b < resamples; b++) below += boot[b]! < estimate ? 1 : boot[b]! === estimate ? 0.5 : 0;
  const share = below / resamples;
  let bca: [number, number] | null = null;
  if (share > 0 && share < 1) {
    const z0 = normalInv(share);
    const jack = jackknife(stat, xs);
    const jm = mean(jack);
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const d = jm - jack[i]!;
      num += d * d * d;
      den += d * d;
    }
    const a = den > 0 ? num / (6 * Math.pow(den, 1.5)) : 0;
    const adj = (z: number) => {
      const t = z0 + z;
      const q = 1 - a * t;
      return q > 0 ? normalCdf(z0 + t / q) : Number.NaN;
    };
    const a1 = adj(normalInv(alpha));
    const a2 = adj(normalInv(1 - alpha));
    if (Number.isFinite(a1) && Number.isFinite(a2) && a1 < a2) bca = [quantileSorted(sortedBoot, a1), quantileSorted(sortedBoot, a2)];
  }
  if (!bca) notes.push('The bias-corrected (BCa) interval could not be worked out for this sample, so the plain percentile interval is quoted.');
  const [lo, hi] = bca ?? [pLo, pHi];

  const mf = m0.format;
  const f = (v: number) => fmt(v, 'metric', mf);
  const word = WORDS[stat];
  const lv = fmt(level, 'percent');
  const headline = `The ${word} is ${f(estimate)}; with ${lv} confidence it lies between ${f(lo)} and ${f(hi)}.`;
  const sentences = [
    `That interval comes from recomputing the ${word} on ${resamples.toLocaleString('en-US')} random resamples of the ${n.toLocaleString('en-US')} rows, so it shows how much the figure could move with a different sample of the same kind.`,
    `The figure's standard error is about ${f(se)}${bca ? `; the plain percentile interval is ${f(pLo)} to ${f(pHi)}, and the quoted one also corrects for bias and skew (BCa)` : ''}.`,
  ];
  if (stat === 'total') sentences.push('A bootstrap total treats the rows as a sample; if they are every item there is, the total has no sampling error.');
  notes.push('Assumes the rows are independent draws: a time series with runs or a seasonal pattern gives an interval that is too narrow.');

  const markers: Array<{ label: string; value: number; tone?: 'good' | 'warn' | 'bad' }> = [
    { label: 'Estimate', value: estimate },
    { label: `${lv} low`, value: lo, tone: 'warn' },
    { label: `${lv} high`, value: hi, tone: 'warn' },
  ];
  const label = data.dims[0] ? `per ${data.dims[0].label}` : '';
  return {
    model: 'bootstrap',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: `${word[0]!.toUpperCase()}${word.slice(1)}`, value: estimate, format: 'metric', hint: `The ${word} of ${m0.label} ${label}`.trim() + '.' },
      { label: `${lv} low`, value: lo, format: 'metric', hint: bca ? 'BCa interval: corrected for bias and skew.' : 'Percentile interval.' },
      { label: `${lv} high`, value: hi, format: 'metric' },
      { label: 'Standard error', value: se, format: 'metric', hint: 'The spread of the resampled figures.' },
      { label: 'Rows', value: n, format: 'integer' },
    ],
    chart: { kind: 'histogram', bins: histogram(boot, 40), markers, xFormat: 'metric', xLabel: `Resampled ${word}` },
    table: {
      columns: ['Interval', 'Low', 'High'],
      rows: [
        ...(bca ? [[`BCa ${lv}`, bca[0], bca[1]] as Array<string | number | null>] : []),
        [`Percentile ${lv}`, pLo, pHi],
        [`Normal ${lv} (estimate ± z·SE)`, estimate - normalInv(1 - alpha) * se, estimate + normalInv(1 - alpha) * se],
      ],
    },
    notes,
  };
};

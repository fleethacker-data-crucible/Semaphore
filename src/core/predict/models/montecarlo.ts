// Monte Carlo simulation of a total (or a product) of uncertain inputs. Each input has a low, most
// likely and high value and a spread (PERT, triangular, normal, uniform, lognormal); every trial
// draws each input once and combines them. The percentiles of the trials are the P10/P50/P90 an
// analyst quotes. Which input drives the spread is read from Spearman's rank correlation between
// each input's draws and the outcome (the "contribution to variance" view of Crystal Ball and
// @RISK, squared rank correlations normalised to 100%).

import { cellLabel } from '../data.ts';
import { fmt, pct, article } from '../format.ts';
import { draw, Rng } from '../rng.ts';
import { histogram, mean, quantileSorted } from '../stats.ts';
import { type Distribution, type ModelData, ModelError, type ModelOutput, type ModelRunner, type ModelSpec, numParam, param } from '../types.ts';

const DISTRIBUTIONS: readonly Distribution[] = ['triangular', 'pert', 'normal', 'uniform', 'lognormal'];

/** An input ready to draw from. */
export interface ResolvedInput {
  name: string;
  low: number;
  likely: number;
  high: number;
  dist: Distribution;
}

/** The most rows taken as inputs; more are left out with a note. */
const MAX_INPUTS = 5000;

/**
 * The inputs of a Monte Carlo or sensitivity run: the hand-entered ones when there are any, else one
 * per row (likely = the first measure, low and high a percentage either side). Throws a ModelError
 * naming the input when low ≤ likely ≤ high does not hold.
 */
export function resolveInputs(data: ModelData, spec: ModelSpec, notes: string[]): ResolvedInput[] {
  const fallback = param(spec, 'distribution', 'pert');
  const defDist: Distribution = (DISTRIBUTIONS as readonly string[]).includes(fallback) ? (fallback as Distribution) : 'pert';
  const out: ResolvedInput[] = [];
  if (spec.inputs && spec.inputs.length) {
    for (const [i, inp] of spec.inputs.entries()) {
      const name = inp.name?.trim() || `Input ${i + 1}`;
      if (![inp.low, inp.likely, inp.high].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new ModelError(`"${name}" needs a number for its low, most likely and high values.`);
      if (!(inp.low <= inp.likely && inp.likely <= inp.high)) throw new ModelError(`"${name}" must have low ≤ most likely ≤ high; it has ${inp.low}, ${inp.likely}, ${inp.high}.`);
      const dist = inp.distribution && DISTRIBUTIONS.includes(inp.distribution) ? inp.distribution : defDist;
      out.push({ name, low: inp.low, likely: inp.likely, high: inp.high, dist });
    }
    return out;
  }
  if (!data.metrics.length) throw new ModelError('Enter some inputs (a low, most likely and high value each), or bind one field and one measure so each row becomes an input.');
  const lowPct = numParam(spec, 'lowPct', 15, 0, 100);
  const highPct = numParam(spec, 'highPct', 30, 0, 500);
  let dropped = 0;
  for (const [i, r] of data.rows.entries()) {
    const v = r.values[0];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      dropped++;
      continue;
    }
    if (out.length >= MAX_INPUTS) {
      dropped++;
      continue;
    }
    const name = data.dims.length ? r.dims.map((c, j) => cellLabel(c, data.dims[j]?.grain)).join(' · ') : `Row ${i + 1}`;
    const a = v * (1 - lowPct / 100);
    const b = v * (1 + highPct / 100);
    // For a negative value "below" and "above" swap; keep low ≤ likely ≤ high.
    out.push({ name, low: Math.min(a, b), likely: v, high: Math.max(a, b), dist: defDist });
  }
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out (a blank measure${out.length >= MAX_INPUTS ? `, or past the ${MAX_INPUTS.toLocaleString('en-US')}-input limit` : ''}).`);
  if (!out.length) throw new ModelError('None of the rows has a number to use as an input; enter inputs by hand or bind a measure.');
  notes.push(`Each row's value is the most likely case; it could fall ${lowPct}% below or rise ${highPct}% above.`);
  return out;
}

export type Combine = 'sum' | 'product';

export function combineOf(spec: ModelSpec): Combine {
  return param(spec, 'combine', 'sum') === 'product' ? 'product' : 'sum';
}

/** Ranks with ties given their average rank (for Spearman's correlation). */
export function ranks(xs: ArrayLike<number>): Float64Array {
  const n = xs.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const r = new Float64Array(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && xs[idx[j + 1]!] === xs[idx[i]!]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]!] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(x: Float64Array, y: Float64Array): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i]!;
    my += y[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Spearman's rank correlation. */
export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return pearson(ranks(x), ranks(y));
}

/** Most draws in one run (inputs × trials); trials are cut to fit. */
const MAX_DRAWS = 8_000_000;
/** Trials kept per input for the rank correlations. */
const CORR_TRIALS = 5000;
/** Inputs tracked for the rank correlations. */
const CORR_INPUTS = 200;

export const runMontecarlo: ModelRunner = (data, spec, ctx): ModelOutput => {
  const notes: string[] = [];
  const inputs = resolveInputs(data, spec, notes);
  const combine = combineOf(spec);
  const mf = data.metrics[0]?.format;
  const f = (v: number) => fmt(v, 'metric', mf);
  let trials = Math.round(numParam(spec, 'trials', 10000, 500, 200000));
  if (trials * inputs.length > MAX_DRAWS) {
    const cut = Math.max(500, Math.floor(MAX_DRAWS / inputs.length));
    notes.push(`Trials were cut from ${trials.toLocaleString('en-US')} to ${cut.toLocaleString('en-US')} to keep the run quick with ${inputs.length.toLocaleString('en-US')} inputs.`);
    trials = cut;
  }
  const target = numParam(spec, 'target', 0, -Infinity, Infinity);
  const rng = new Rng((ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0);

  // Which inputs are tracked for the contribution: all of them up to 200, else the 200 widest.
  const n = inputs.length;
  let tracked: number[] = inputs.map((_, i) => i);
  if (n > CORR_INPUTS) {
    const width = (x: ResolvedInput) => (combine === 'product' ? (x.high - x.low) / Math.max(Math.abs(x.likely), 1e-12) : x.high - x.low);
    tracked = tracked.sort((a, b) => width(inputs[b]!) - width(inputs[a]!)).slice(0, CORR_INPUTS);
    notes.push(`The contribution to the spread was measured on the ${CORR_INPUTS} widest of the ${n.toLocaleString('en-US')} inputs.`);
  }
  const slot = new Int32Array(n).fill(-1);
  tracked.forEach((i, s) => (slot[i] = s));
  const keep = Math.min(trials, CORR_TRIALS);
  const draws = tracked.map(() => new Float64Array(keep));

  const out = new Float64Array(trials);
  for (let t = 0; t < trials; t++) {
    let acc = combine === 'product' ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const x = inputs[i]!;
      const v = x.high === x.low ? x.likely : draw(rng, x.dist, x.low, x.likely, x.high);
      if (t < keep) {
        const s = slot[i]!;
        if (s >= 0) draws[s]![t] = v;
      }
      acc = combine === 'product' ? acc * v : acc + v;
    }
    out[t] = acc;
  }

  const s = Float64Array.from(out).sort();
  const q = (p: number) => quantileSorted(s, p);
  const p10 = q(0.1);
  const p50 = q(0.5);
  const p90 = q(0.9);
  const avg = mean(out);
  let under = 0;
  if (target > 0) for (let t = 0; t < trials; t++) if (out[t]! <= target) under++;
  const pUnder = under / trials;

  // Spearman's rank correlation of each tracked input with the outcome, over the kept trials.
  const outKept = out.subarray(0, keep);
  const outRanks = ranks(outKept);
  const rho = draws.map((d) => pearson(ranks(d), outRanks));
  const r2 = rho.reduce((a, r) => a + r * r, 0);
  let top = -1;
  rho.forEach((r, k) => {
    if (top < 0 || Math.abs(r) > Math.abs(rho[top]!)) top = k;
  });

  const what = combine === 'product' ? 'result' : 'total';
  const headline =
    target > 0
      ? `There is ${article(pct(pUnder))} ${pct(pUnder)} chance the ${what} comes in at or under ${f(target)}; the middle outcome is ${f(p50)}, and 8 in 10 trials land between ${f(p10)} and ${f(p90)}.`
      : `The ${what} is most likely around ${f(p50)}, with an 80% chance it lands between ${f(p10)} (P10) and ${f(p90)} (P90).`;
  const sentences: string[] = [];
  sentences.push(`That comes from ${trials.toLocaleString('en-US')} simulated trials of ${n.toLocaleString('en-US')} input${n === 1 ? '' : 's'}, ${combine === 'product' ? 'multiplied together' : 'added up'}; the average trial is ${f(avg)}.`);
  if (top >= 0 && n > 1 && r2 > 0) {
    const inp = inputs[tracked[top]!]!;
    const share = (rho[top]! * rho[top]!) / r2;
    sentences.push(`"${inp.name}" drives the spread most: it accounts for about ${pct(share)} of the variation (rank correlation ${rho[top]!.toFixed(2)} with the outcome), so narrowing its range narrows the answer most.`);
  }
  sentences.push(`P10 means 1 trial in 10 came in lower; P90 means 9 in 10 did.`);
  notes.push('The inputs are treated as independent: if some tend to rise and fall together, the real spread is wider than shown.');

  const markers: Array<{ label: string; value: number; tone?: 'good' | 'warn' | 'bad' }> = [
    { label: 'P10', value: p10 },
    { label: 'P50', value: p50 },
    { label: 'P90', value: p90 },
    { label: 'Mean', value: avg },
  ];
  if (target > 0) markers.push({ label: 'Target', value: target, tone: pUnder >= 0.5 ? 'good' : 'bad' });

  const stats: ModelOutput['stats'] = [
    { label: 'P10', value: p10, format: 'metric', hint: '1 trial in 10 came in lower than this.' },
    { label: 'P50', value: p50, format: 'metric', hint: 'The middle outcome: half the trials came in lower.' },
    { label: 'P90', value: p90, format: 'metric', hint: '9 trials in 10 came in lower than this.' },
    { label: 'Mean', value: avg, format: 'metric', hint: 'The average of all the trials.' },
  ];
  if (target > 0) stats.push({ label: `Chance ≤ ${f(target)}`, value: pUnder, format: 'percent', hint: 'The share of trials at or under the target.' });

  const rows: Array<Array<string | number | null>> = [];
  for (let p = 5; p <= 95; p += 5) rows.push([`P${p}`, q(p / 100)]);

  return {
    model: 'montecarlo',
    headline,
    sentences: sentences.slice(0, 5),
    stats,
    chart: { kind: 'histogram', bins: histogram(out, 40), markers, xFormat: 'metric', xLabel: combine === 'product' ? 'Result' : 'Total' },
    table: { columns: ['Percentile', 'Value'], rows },
    notes,
  };
};

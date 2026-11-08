// Random forest regression (Breiman 2001): many CART trees, each on a bootstrap sample of the rows and
// trying a random share of the drivers at each split. Each row is predicted only by the trees that
// did not draw it (out-of-bag), which gives an honest R² and typical miss without a holdout. Driver
// importance by permutation on the out-of-bag rows (Breiman 2001: the rise in a tree's out-of-bag
// error when one driver's values are shuffled), and by total impurity decrease (mean decrease in
// impurity), which is quicker but favours drivers with many distinct values.

import { fmt, pct } from '../format.ts';
import { Rng } from '../rng.ts';
import { droppedNote } from '../data.ts';
import { type ModelOutput, type ModelRunner, numParam } from '../types.ts';
import { drivers, fitCart, predictCart, presort, ranked, shares, treeCost } from './cart.ts';

/** About two seconds of inner-loop steps in a browser worker. */
const BUDGET = 2.5e8;

export const runForest: ModelRunner = (data, spec, ctx): ModelOutput => {
  const d = drivers(data, 10);
  const asked = Math.round(numParam(spec, 'trees', 200, 10, 2000));
  const maxDepth = Math.round(numParam(spec, 'maxDepth', 8, 1, 12));
  const minLeaf = Math.round(numParam(spec, 'minLeaf', 3, 1, 100));
  const frac = numParam(spec, 'features', 0.6, 0.1, 1);
  const rng = new Rng((ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0);
  const { y, X, n } = d;
  const p = X.length;
  const notes = droppedNote(d.dropped);

  // Bound the work: trees × rows × drivers × depth, plus the permutation passes on out-of-bag rows.
  const perTree = treeCost(n, p, maxDepth, minLeaf) + 0.37 * n * p * Math.min(maxDepth, 12);
  const trees = Math.max(10, Math.min(asked, Math.floor(BUDGET / perTree)));
  if (trees < asked) notes.push(`Grew ${trees} trees instead of ${asked} to keep the run to a couple of seconds on ${fmt(n, 'integer')} rows; out-of-bag figures steady well before that for most data.`);

  const order = presort(X);
  const oobSum = new Float64Array(n);
  const oobCnt = new Int32Array(n);
  const impurity = new Float64Array(p);
  const permRise = new Float64Array(p);
  let permTrees = 0;
  const wts = new Float64Array(n);
  const oob: number[] = [];
  const base: number[] = [];
  const perm: number[] = [];
  for (let t = 0; t < trees; t++) {
    wts.fill(0);
    for (let k = 0; k < n; k++) wts[rng.int(n)]! += 1;
    const { tree, importance } = fitCart(X, y, { maxDepth, minLeaf, featureFraction: frac, rng, weights: wts, order });
    for (let f = 0; f < p; f++) impurity[f]! += importance[f]!;
    oob.length = 0;
    base.length = 0;
    for (let i = 0; i < n; i++) if (wts[i] === 0) oob.push(i);
    if (!oob.length) continue;
    let mse = 0;
    for (const i of oob) {
      const v = predictCart(tree, X, i);
      base.push(v);
      oobSum[i]! += v;
      oobCnt[i]! += 1;
      mse += (y[i]! - v) ** 2;
    }
    mse /= oob.length;
    if (oob.length < 2) continue;
    permTrees++;
    for (let f = 0; f < p; f++) {
      perm.length = 0;
      for (const i of oob) perm.push(X[f]![i]!);
      rng.shuffle(perm);
      let msep = 0;
      for (let k = 0; k < oob.length; k++) {
        const i = oob[k]!;
        msep += (y[i]! - predictCart(tree, X, i, f, perm[k]!)) ** 2;
      }
      permRise[f]! += msep / oob.length - mse;
    }
  }
  if (permTrees) for (let f = 0; f < p; f++) permRise[f] = permRise[f]! / permTrees;

  const rows: number[] = [];
  for (let i = 0; i < n; i++) if (oobCnt[i]! > 0) rows.push(i);
  if (rows.length < n) notes.push(`${n - rows.length} row${n - rows.length === 1 ? ' was' : 's were'} drawn by every tree, so ${n - rows.length === 1 ? 'it is' : 'they are'} left out of the out-of-bag figures.`);
  let mu = 0;
  for (const i of rows) mu += y[i]!;
  mu /= Math.max(1, rows.length);
  let sse = 0;
  let sst = 0;
  for (const i of rows) {
    sse += (y[i]! - oobSum[i]! / oobCnt[i]!) ** 2;
    sst += (y[i]! - mu) ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const err = Math.sqrt(sse / Math.max(1, rows.length));

  const permShare = shares(permRise);
  const impShare = shares(impurity);
  const rank = ranked(permRise);
  const target = d.targetLabel;
  const top = rank[0]!;
  const money = (v: number) => fmt(v, 'metric', d.targetFormat);

  const headline =
    r2 > 0.05
      ? `The forest explains ${pct(r2)} of the variation in ${target} on rows it did not see; ${d.featureLabels[top]} matters most.`
      : `The forest cannot predict ${target} on rows it did not see much better than the average does (out-of-bag R² ${pct(Math.max(0, r2))}), so these drivers say little about it.`;
  const sentences: string[] = [];
  sentences.push(`Its typical miss on a row it did not see is about ${money(err)} (out-of-bag RMSE).`);
  const lead = rank.slice(0, 3).filter((f) => permShare[f]! > 0);
  if (lead.length) sentences.push(`Shuffling a driver and seeing how much worse the forest gets ranks them: ${lead.map((f) => `${d.featureLabels[f]} ${pct(permShare[f]!)}`).join(', ')}.`);
  const idle = rank.filter((f) => permShare[f]! <= 0.01);
  if (idle.length && idle.length < p) sentences.push(`${idle.map((f) => d.featureLabels[f]).join(', ')} add${idle.length === 1 ? 's' : ''} almost nothing: shuffling ${idle.length === 1 ? 'it' : 'them'} barely changes the error.`);
  const impTop = ranked(impurity)[0]!;
  if (impTop !== top) sentences.push(`Counting split improvements instead puts ${d.featureLabels[impTop]} first; that count favours drivers with many distinct values, so the shuffle ranking is the one to trust.`);
  if (n < 50) notes.push(`Only ${n} rows: the out-of-bag figures will move with the seed.`);
  if (Math.round(p * frac) < p) notes.push(`Each split tried ${Math.max(1, Math.round(p * frac))} of the ${p} drivers at random.`);

  return {
    model: 'forest',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Out-of-bag R²', value: r2, format: 'percent', hint: 'Share of the variation explained on rows each tree did not see.' },
      { label: 'Typical miss', value: err, format: 'metric', hint: 'Out-of-bag root mean squared error, in the units of the measure.' },
      { label: 'Trees', value: trees, format: 'integer' },
      { label: 'Rows', value: n, format: 'integer' },
    ],
    chart: { kind: 'bars', labels: rank.map((f) => d.featureLabels[f]!), values: rank.map((f) => permShare[f]!), xFormat: 'percent', xLabel: 'Share of importance (rise in error when shuffled)' },
    table: {
      columns: ['Driver', 'Permutation importance', 'Impurity importance', 'Rise in typical miss when shuffled'],
      rows: rank.map((f) => [d.featureLabels[f]!, permShare[f]!, impShare[f]!, Math.sqrt(Math.max(0, err * err + permRise[f]!)) - err]),
    },
    notes,
  };
};

// Gradient boosting for squared error (Friedman 2001, "Greedy function approximation"), with the
// stochastic row subsample of Friedman (2002): start from the mean, then each round fits a shallow
// CART tree to the current residuals (the negative gradient of squared error; a leaf's mean residual
// is the exact line-search step) and adds it scaled by the learning rate. A seeded 20% of the rows is
// held out to choose the number of rounds (early stopping when the held-out error has not improved
// for 25 rounds); the model is then refitted on every row with that many rounds.

import { fmt, pct } from '../format.ts';
import { Rng } from '../rng.ts';
import { droppedNote } from '../data.ts';
import { type ModelOutput, type ModelRunner, numParam } from '../types.ts';
import { fitCart, drivers, predictCart, presort, ranked, shares, treeCost } from './cart.ts';

const BUDGET = 2.5e8;
const PATIENCE = 25;

export interface BoostOptions {
  rounds: number;
  rate: number;
  maxDepth: number;
  minLeaf: number;
  subsample: number;
}

export interface BoostRun {
  /** Predictions after the last round, indexed like y. */
  pred: Float64Array;
  /** RMSE on `train` and on `test` after each round (round r at index r − 1). */
  trainErr: number[];
  testErr: number[];
  importance: Float64Array;
}

/** Boosts on the `train` rows, tracking error on `test` rows; stops early once `test` stops improving for PATIENCE rounds. */
export function boost(X: Float64Array[], y: Float64Array, train: number[], test: number[], opts: BoostOptions, rng: Rng, order: Int32Array[], early: boolean): BoostRun {
  const n = y.length;
  let f0 = 0;
  for (const i of train) f0 += y[i]!;
  f0 /= train.length;
  const pred = new Float64Array(n).fill(f0);
  const resid = new Float64Array(n);
  const importance = new Float64Array(X.length);
  const trainErr: number[] = [];
  const testErr: number[] = [];
  const pool = train.slice();
  const take = Math.max(2, Math.min(train.length, Math.round(train.length * opts.subsample)));
  let best = Infinity;
  let bestAt = 0;
  const touched = new Uint8Array(n);
  for (const i of train) touched[i] = 1;
  for (const i of test) touched[i] = 1;
  for (let r = 1; r <= opts.rounds; r++) {
    for (const i of train) resid[i] = y[i]! - pred[i]!;
    let rows = train;
    if (take < train.length) {
      // Friedman's stochastic gradient boosting: a fresh sample of rows without replacement each round.
      for (let j = 0; j < take; j++) { const s = j + rng.int(pool.length - j); const t = pool[j]!; pool[j] = pool[s]!; pool[s] = t; }
      rows = pool.slice(0, take);
    }
    const { tree, importance: imp } = fitCart(X, resid, { maxDepth: opts.maxDepth, minLeaf: opts.minLeaf, rows, order });
    for (let f = 0; f < X.length; f++) importance[f]! += imp[f]!;
    for (let i = 0; i < n; i++) if (touched[i]) pred[i]! += opts.rate * predictCart(tree, X, i);
    let a = 0;
    for (const i of train) a += (y[i]! - pred[i]!) ** 2;
    trainErr.push(Math.sqrt(a / train.length));
    if (test.length) {
      let b = 0;
      for (const i of test) b += (y[i]! - pred[i]!) ** 2;
      const e = Math.sqrt(b / test.length);
      testErr.push(e);
      if (bestAt === 0 || e < best - 1e-12 * Math.max(1, best)) { best = e; bestAt = r; }
      if (early && r - bestAt >= PATIENCE) break;
    }
  }
  return { pred, trainErr, testErr, importance };
}

export const runBoosting: ModelRunner = (data, spec, ctx): ModelOutput => {
  const d = drivers(data, 20);
  const asked = Math.round(numParam(spec, 'rounds', 200, 10, 3000));
  const rate = numParam(spec, 'rate', 0.1, 0.01, 1);
  const maxDepth = Math.round(numParam(spec, 'maxDepth', 3, 1, 12));
  const subsample = numParam(spec, 'subsample', 0.8, 0.2, 1);
  const minLeaf = Math.round(numParam(spec, 'minLeaf', 3, 1, 100));
  const seed = (ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0;
  const { y, X, n } = d;
  const p = X.length;
  const notes = droppedNote(d.dropped);

  // Bound the work: up to two passes (choose the rounds, then refit) of rounds × rows × drivers × depth.
  const perRound = treeCost(n, p, maxDepth, minLeaf) + n * maxDepth;
  const rounds = Math.max(10, Math.min(asked, Math.floor(BUDGET / (2 * perRound))));

  // A seeded 20% holdout picks the number of rounds.
  const split = new Rng(seed ^ 0x5eed).shuffle(Array.from({ length: n }, (_, i) => i));
  const nTest = Math.max(4, Math.round(n * 0.2));
  const test = split.slice(0, nTest).sort((a, b) => a - b);
  const train = split.slice(nTest).sort((a, b) => a - b);
  const order = presort(X);
  const opts = { rounds, rate, maxDepth, minLeaf, subsample };
  const first = boost(X, y, train, test, opts, new Rng(seed), order, true);
  if (rounds < asked && first.testErr.length === rounds) notes.push(`Stopped at ${rounds} rounds instead of ${asked} to keep the run to a couple of seconds on ${fmt(n, 'integer')} rows.`);
  let bestAt = 1;
  for (let r = 1; r <= first.testErr.length; r++) if (first.testErr[r - 1]! < first.testErr[bestAt - 1]!) bestAt = r;
  const heldRmse = first.testErr[bestAt - 1]!;
  let mu = 0;
  for (const i of test) mu += y[i]!;
  mu /= test.length;
  let sst = 0;
  for (const i of test) sst += (y[i]! - mu) ** 2;
  const heldR2 = sst > 0 ? 1 - (heldRmse * heldRmse * test.length) / sst : 0;
  if (bestAt === rounds) notes.push(`The held-out error was still falling at round ${rounds}; more rounds or a higher learning rate may do better.`);

  // Refit on every row with the chosen number of rounds.
  const all = Array.from({ length: n }, (_, i) => i);
  const final = boost(X, y, all, [], { ...opts, rounds: bestAt }, new Rng(seed ^ 0xf17), order, false);
  const share = shares(final.importance);
  const rank = ranked(final.importance);
  const top = rank[0]!;
  const target = d.targetLabel;
  const money = (v: number) => fmt(v, 'metric', d.targetFormat);

  const headline =
    heldR2 > 0.05
      ? `Gradient boosting explains ${pct(heldR2)} of the variation in ${target} on rows held out of the fit; ${d.featureLabels[top]} is the top driver.`
      : `Gradient boosting cannot predict ${target} on held-out rows much better than the average does (R² ${pct(Math.max(0, heldR2))}), so these drivers say little about it.`;
  const sentences: string[] = [
    `Its typical miss on a held-out row is about ${money(heldRmse)} (RMSE on ${fmt(nTest, 'integer')} rows kept aside).`,
    `The held-out error was lowest after ${bestAt} round${bestAt === 1 ? '' : 's'} of ${first.testErr.length} tried; the final model was refitted on all ${fmt(n, 'integer')} rows with that many.`,
    `${rank.slice(0, 3).filter((f) => share[f]! > 0).map((f) => `${d.featureLabels[f]} ${pct(share[f]!)}`).join(', ')} of the total improvement from all splits.`,
  ];
  const trainAtBest = first.trainErr[bestAt - 1]!;
  if (trainAtBest < 0.6 * heldRmse) sentences.push(`It fits the training rows far better (miss ${money(trainAtBest)}) than held-out ones, so expect new rows to land nearer the held-out figure.`);
  if (n < 60) notes.push(`Only ${n} rows, so the holdout is ${nTest} rows and the held-out figures will move with the seed.`);

  const tableRows: Array<Array<string | number | null>> = [];
  for (let r = 1; r <= first.testErr.length; r++) {
    if (r === 1 || r % 10 === 0 || r === bestAt || r === first.testErr.length) tableRows.push([r === bestAt ? `${r} (chosen)` : String(r), first.trainErr[r - 1]!, first.testErr[r - 1]!]);
  }

  return {
    model: 'boosting',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Held-out R²', value: heldR2, format: 'percent', hint: 'Share of the variation explained on the 20% of rows kept out of the fit.' },
      { label: 'Typical miss', value: heldRmse, format: 'metric', hint: 'Held-out root mean squared error, in the units of the measure.' },
      { label: 'Rounds used', value: bestAt, format: 'integer', hint: 'Chosen where the held-out error was lowest.' },
      { label: 'Rows', value: n, format: 'integer' },
    ],
    chart: { kind: 'bars', labels: rank.map((f) => d.featureLabels[f]!), values: rank.map((f) => share[f]!), xFormat: 'percent', xLabel: 'Share of improvement from splits' },
    table: { columns: ['Round', 'Training RMSE', 'Held-out RMSE'], rows: tableRows },
    notes,
  };
};

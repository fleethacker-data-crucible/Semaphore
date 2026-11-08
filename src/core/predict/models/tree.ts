// Decision tree: one regression tree (CART, Breiman et al. 1984) read as plain rules. Reports the fit
// on the training rows and a 5-fold cross-validated R² (seeded folds), so an analyst can see how much
// of the fit holds up on rows the tree did not see.

import { fmt, pct } from '../format.ts';
import { Rng } from '../rng.ts';
import { droppedNote } from '../data.ts';
import { type ModelOutput, type ModelRunner, numParam } from '../types.ts';
import { type Cart, drivers, fitCart, predictCart, presort, ranked, rSquared, shares } from './cart.ts';

export interface Leaf {
  node: number;
  rule: string;
  value: number;
  count: number;
}

/** Each leaf as a rule: the conditions on its path, with bounds on one feature merged ("12 < Hours ≤ 20"). */
export function treeRules(tree: Cart, labels: string[], show: (f: number, v: number) => string): Leaf[] {
  const out: Leaf[] = [];
  const walk = (node: number, lo: Map<number, number>, hi: Map<number, number>) => {
    const f = tree.feature[node]!;
    if (f < 0) {
      const feats = [...new Set([...lo.keys(), ...hi.keys()])].sort((a, b) => a - b);
      const parts = feats.map((g) => {
        const l = lo.get(g);
        const h = hi.get(g);
        const name = labels[g] ?? `Measure ${g + 2}`;
        if (l !== undefined && h !== undefined) return `${show(g, l)} < ${name} ≤ ${show(g, h)}`;
        return l !== undefined ? `${name} > ${show(g, l)}` : `${name} ≤ ${show(g, h!)}`;
      });
      out.push({ node, rule: parts.length ? parts.join(' and ') : 'All rows', value: tree.value[node]!, count: tree.count[node]! });
      return;
    }
    const t = tree.threshold[node]!;
    const hiL = new Map(hi);
    hiL.set(f, Math.min(t, hi.get(f) ?? Infinity));
    walk(node + 1, lo, hiL);
    const loR = new Map(lo);
    loR.set(f, Math.max(t, lo.get(f) ?? -Infinity));
    walk(tree.right[node]!, loR, hi);
  };
  walk(0, new Map(), new Map());
  return out;
}

export const runTree: ModelRunner = (data, spec, ctx): ModelOutput => {
  const d = drivers(data, 8);
  const maxDepth = Math.round(numParam(spec, 'maxDepth', 3, 1, 12));
  const minLeaf = Math.round(numParam(spec, 'minLeaf', 3, 1, 100));
  const { y, X, n } = d;
  const order = presort(X);
  const { tree, importance } = fitCart(X, y, { maxDepth, minLeaf, order });
  const pred = new Float64Array(n);
  for (let i = 0; i < n; i++) pred[i] = predictCart(tree, X, i);
  const r2 = rSquared(y, pred);
  const notes = droppedNote(d.dropped);
  const tf = d.targetFormat;
  const money = (v: number) => fmt(v, 'metric', tf);
  const show = (f: number, v: number) => fmt(v, d.featureFormats[f] ?? 'number');

  // 5-fold cross-validation with seeded folds: each row is predicted by a tree that never saw it.
  let cv: number | null = null;
  if (n >= 10) {
    const idx = new Rng((ctx.seed ^ 0x7a3e) >>> 0).shuffle(Array.from({ length: n }, (_, i) => i));
    const fold = new Int32Array(n);
    idx.forEach((r, k) => (fold[r] = k % 5));
    const cvPred = new Float64Array(n);
    for (let k = 0; k < 5; k++) {
      const train: number[] = [];
      for (let i = 0; i < n; i++) if (fold[i] !== k) train.push(i);
      const t = fitCart(X, y, { maxDepth, minLeaf, order, rows: train }).tree;
      for (let i = 0; i < n; i++) if (fold[i] === k) cvPred[i] = predictCart(t, X, i);
    }
    cv = rSquared(y, cvPred);
  } else notes.push('With fewer than 10 rows the tree is not cross-validated, so the fit shown is on the rows it learned from.');

  const leaves = treeRules(tree, d.featureLabels, show).sort((a, b) => b.value - a.value);
  const share = shares(importance);
  const order2 = ranked(importance);
  const target = d.targetLabel;

  let headline: string;
  const sentences: string[] = [];
  let sst = 0;
  const mu = tree.value[0]!;
  for (let i = 0; i < n; i++) sst += (y[i]! - mu) ** 2;
  if (tree.feature[0]! < 0) {
    headline = `No split of the drivers separates ${target} into clearly different groups with at least ${minLeaf} rows each, so the tree predicts the average, ${money(mu)}, for every row.`;
  } else {
    const f = tree.feature[0]!;
    const left = 1;
    const right = tree.right[0]!;
    const hiMean = tree.value[right]!;
    const loMean = tree.value[left]!;
    headline = `Rows with ${d.featureLabels[f]} above ${show(f, tree.threshold[0]!)} average ${money(hiMean)} in ${target} against ${money(loMean)} for the rest (${fmt(tree.count[right]!, 'integer')} vs ${fmt(tree.count[left]!, 'integer')} rows); that one split explains ${pct(tree.gain[0]! / sst)} of the variation.`;
    sentences.push(`The full tree has ${leaves.length} groups and explains ${pct(Math.max(0, r2))} of the variation in ${target} on the rows it learned from.`);
    if (cv !== null) {
      sentences.push(
        cv < r2 - 0.15
          ? `On rows it did not see (5-fold cross-validation) it explains only ${pct(Math.max(0, cv))}, so some of the detail is fitting noise; a shallower tree may hold up better.`
          : `On rows it did not see (5-fold cross-validation) it explains ${pct(Math.max(0, cv))}, so the rules hold up.`,
      );
    }
    const top = order2[0]!;
    sentences.push(`${d.featureLabels[top]} does the most work, with ${pct(share[top]!)} of the total improvement from all splits.`);
    const best = leaves[0]!;
    const worst = leaves.at(-1)!;
    sentences.push(`The highest group: ${best.rule} → average ${money(best.value)} (${fmt(best.count, 'integer')} rows). The lowest: ${worst.rule} → average ${money(worst.value)} (${fmt(worst.count, 'integer')} rows).`);
  }
  if (n < 30) notes.push(`Only ${n} rows: each rule rests on a handful of rows, so treat the thresholds as rough.`);

  return {
    model: 'tree',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Fit (R²)', value: r2, format: 'percent', hint: 'Share of the variation in the rows the tree learned from that it explains.' },
      { label: 'Cross-validated R²', value: cv, format: 'percent', hint: 'The same share on rows held out of each of 5 fits: the honest figure.' },
      { label: 'Groups', value: leaves.length, format: 'integer', hint: 'Leaves of the tree: each is one rule.' },
      { label: 'Rows', value: n, format: 'integer' },
    ],
    chart: { kind: 'bars', labels: order2.map((f) => d.featureLabels[f]!), values: order2.map((f) => share[f]!), xFormat: 'percent', xLabel: 'Share of improvement from splits' },
    table: {
      columns: ['Rule', `Average ${target}`, 'Rows', 'Share of rows'],
      rows: leaves.map((l) => [`${l.rule} → average ${money(l.value)} (${fmt(l.count, 'integer')} rows)`, l.value, l.count, l.count / n]),
    },
    notes,
  };
};

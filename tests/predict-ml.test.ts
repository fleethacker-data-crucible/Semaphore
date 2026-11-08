// Tree models and clustering: CART, the decision tree, random forest, gradient boosting and k-means,
// checked against hand-worked answers and seeded synthetic data with a known structure.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitCart, predictCart } from '../src/core/predict/models/cart.ts';
import { runTree } from '../src/core/predict/models/tree.ts';
import { runForest } from '../src/core/predict/models/forest.ts';
import { runBoosting } from '../src/core/predict/models/boosting.ts';
import { runKmeans } from '../src/core/predict/models/kmeans.ts';
import { Rng } from '../src/core/predict/rng.ts';
import { type ModelData, ModelError, type ModelOutput, type ModelSpec } from '../src/core/predict/types.ts';

const ctx = { seed: 7, today: '2026-11-08' };

function table(labels: string[], rows: number[][]): ModelData {
  return {
    dims: [{ key: 'item', label: 'Item', isDate: false }],
    metrics: labels.map((l, j) => ({ key: `m${j}`, label: l })),
    rows: rows.map((v, i) => ({ dims: [`R${i + 1}`], values: v })),
  };
}

/** y = sin(x1) + x2², x1, x2 on [−2, 2] and x3 pure noise. */
function nonlinear(n: number, seed: number, noise = 0.1): ModelData {
  const r = new Rng(seed);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x1 = r.uniform(-2, 2);
    const x2 = r.uniform(-2, 2);
    const x3 = r.uniform(-2, 2);
    rows.push([Math.sin(x1) + x2 * x2 + r.normal(0, noise), x1, x2, x3]);
  }
  return table(['Cost', 'Hours', 'Distance', 'Noise'], rows);
}

const statOf = (o: ModelOutput, label: string) => o.stats.find((s) => s.label === label)?.value as number;

test('CART finds the exact threshold of a step and predicts leaf means', () => {
  const x = Float64Array.from({ length: 10 }, (_, i) => i + 1);
  const y = Float64Array.from(x, (v) => (v <= 5 ? 2 : 9));
  const { tree, importance } = fitCart([x], y, { maxDepth: 3, minLeaf: 1 });
  assert.equal(tree.feature[0], 0);
  assert.equal(tree.threshold[0], 5.5);
  assert.equal(tree.nodes, 3, 'pure leaves are not split further');
  for (let i = 0; i < 10; i++) assert.equal(predictCart(tree, [x], i), y[i]);
  // SSE falls from 10 · 3.5² = 122.5 to 0.
  assert.ok(Math.abs(importance[0]! - 122.5) < 1e-9);
});

test('CART respects minLeaf and maxDepth', () => {
  const x = Float64Array.from({ length: 40 }, (_, i) => i);
  const y = Float64Array.from(x, (v) => (v === 0 ? 100 : v));
  const { tree } = fitCart([x], y, { maxDepth: 6, minLeaf: 5 });
  let maxDepth = 0;
  const walk = (node: number, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    if (tree.feature[node]! < 0) return assert.ok(tree.count[node]! >= 5, `leaf of ${tree.count[node]} rows`);
    walk(node + 1, depth + 1);
    walk(tree.right[node]!, depth + 1);
  };
  walk(0, 0);
  assert.ok(maxDepth <= 6);
  const shallow = fitCart([x], y, { maxDepth: 1, minLeaf: 1 }).tree;
  assert.equal(shallow.nodes, 3);
});

test('CART weights act as repeated rows and row subsets leave rows out', () => {
  const x = Float64Array.from([1, 2, 3, 4]);
  const y = Float64Array.from([0, 0, 10, 10]);
  const w = fitCart([x], y, { maxDepth: 0, minLeaf: 1, weights: [3, 0, 1, 0] }).tree;
  assert.equal(w.value[0], 2.5); // (0·3 + 10·1) / 4
  const s = fitCart([x], y, { maxDepth: 0, minLeaf: 1, rows: [0, 2, 3] }).tree;
  assert.ok(Math.abs(s.value[0]! - 20 / 3) < 1e-12);
});

test('decision tree: y = 3·x1 gives x1 nearly all the importance and readable rules', () => {
  const r = new Rng(3);
  const rows = Array.from({ length: 120 }, () => {
    const x1 = r.uniform(0, 10);
    return [3 * x1, x1, r.uniform(0, 10)];
  });
  const out = runTree(table(['Cost', 'Hours', 'Noise'], rows), { type: 'tree', params: { maxDepth: 4, minLeaf: 3 } }, ctx);
  assert.equal(out.chart?.kind, 'bars');
  if (out.chart?.kind !== 'bars') return;
  assert.equal(out.chart.labels[0], 'Hours');
  assert.ok(out.chart.values[0]! > 0.97, `x1 share ${out.chart.values[0]}`);
  assert.ok(statOf(out, 'Fit (R²)') > 0.97);
  assert.ok(statOf(out, 'Cross-validated R²') > 0.9);
  assert.match(out.headline, /^Rows with Hours above [\d.]+ average/);
  assert.match(String(out.table.rows[0]![0]), /Hours .* → average [\d.]+ \(\d+ rows\)/);
  const total = out.table.rows.reduce((s, row) => s + (row[2] as number), 0);
  assert.equal(total, 120);
});

test('random forest: OOB R² above 0.8 on sin(x1) + x2², noise ranked last, deterministic', () => {
  const data = nonlinear(500, 11);
  const spec: ModelSpec = { type: 'forest', params: { trees: 100, maxDepth: 8, minLeaf: 3, features: 0.67, seed: 1 } };
  const t0 = Date.now();
  const out = runForest(data, spec, ctx);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `${ms} ms`);
  const r2 = statOf(out, 'Out-of-bag R²');
  assert.ok(r2 > 0.8, `OOB R² ${r2}`);
  assert.equal(out.chart?.kind, 'bars');
  if (out.chart?.kind !== 'bars') return;
  assert.equal(out.chart.labels.at(-1), 'Noise');
  assert.equal(out.chart.labels[0], 'Distance');
  assert.match(out.headline, /explains [\d.]+% of the variation in Cost on rows it did not see; Distance matters most/);
  assert.deepEqual(runForest(data, spec, ctx), out);
  assert.notDeepEqual(runForest(data, { ...spec, params: { ...spec.params, seed: 2 } }, ctx).stats, out.stats);
});

test('random forest caps the trees on big data and says so', () => {
  const data = nonlinear(5000, 5);
  const t0 = Date.now();
  const out = runForest(data, { type: 'forest', params: { trees: 2000, maxDepth: 12, minLeaf: 1, features: 1 } }, ctx);
  const ms = Date.now() - t0;
  assert.ok(statOf(out, 'Trees') < 2000);
  assert.ok(out.notes.some((n) => /instead of 2000/.test(n)));
  assert.ok(ms < 4000, `${ms} ms`);
});

test('gradient boosting beats a single tree out of sample and refits with the chosen rounds', () => {
  const data = nonlinear(400, 21);
  const spec: ModelSpec = { type: 'boosting', params: { rounds: 300, rate: 0.1, maxDepth: 3, subsample: 0.8, seed: 1 } };
  const out = runBoosting(data, spec, ctx);
  const held = statOf(out, 'Held-out R²');
  const single = statOf(runTree(data, { type: 'tree', params: { maxDepth: 3 } }, ctx), 'Cross-validated R²');
  assert.ok(held > 0.85, `held-out R² ${held}`);
  assert.ok(held > single + 0.1, `boosting ${held} vs tree ${single}`);
  assert.equal(out.table.columns.join(), 'Round,Training RMSE,Held-out RMSE');
  assert.ok(out.table.rows.some((r) => /chosen/.test(String(r[0]))));
  if (out.chart?.kind === 'bars') assert.notEqual(out.chart.labels[0], 'Noise');
  assert.match(out.headline, /held out of the fit; (Distance|Hours) is the top driver/);
  assert.deepEqual(runBoosting(data, spec, ctx), out);
});

test('gradient boosting stops early when more rounds stop helping', () => {
  const data = nonlinear(200, 4, 0.5);
  const out = runBoosting(data, { type: 'boosting', params: { rounds: 3000, rate: 0.5, maxDepth: 3, subsample: 1 } }, ctx);
  assert.ok(statOf(out, 'Rounds used') < 200);
  const tried = Number(String(out.table.rows.at(-1)![0]).replace(/\D.*$/, ''));
  assert.ok(tried < 3000 && tried >= statOf(out, 'Rounds used') + 25 - 1);
});

/** Three well-separated Gaussian blobs, 30 items each, labelled. */
function blobs(seed: number): { data: ModelData; truth: number[] } {
  const r = new Rng(seed);
  const centres = [[0, 0, 0], [20, 5, 10], [-10, 30, -5]];
  const rows: number[][] = [];
  const truth: number[] = [];
  for (let g = 0; g < 3; g++) for (let i = 0; i < 30 + g * 5; i++) {
    rows.push(centres[g]!.map((c) => c + r.normal(0, 1)));
    truth.push(g);
  }
  return { data: table(['Cost', 'Hours', 'Miles'], rows), truth };
}

test('k-means recovers three seeded blobs exactly and auto-k picks 3', () => {
  const { data, truth } = blobs(9);
  const out = runKmeans(data, { type: 'kmeans', params: { k: 0, standardize: true, seed: 1 } }, ctx);
  assert.equal(statOf(out, 'Groups'), 3);
  assert.ok(statOf(out, 'Silhouette') > 0.8);
  const found = out.table.rows.map((r) => String(r[1]));
  // The same partition up to a relabelling: each true group maps to one found group, one to one.
  const map = new Map<number, string>();
  truth.forEach((t, i) => {
    if (!map.has(t)) map.set(t, found[i]!);
    assert.equal(found[i], map.get(t));
  });
  assert.equal(new Set(map.values()).size, 3);
  // Groups are numbered by size: the 40-item blob is group 1.
  assert.equal(map.get(2), 'Group 1');
  assert.equal(out.chart?.kind, 'scatter');
  if (out.chart?.kind === 'scatter') {
    assert.deepEqual(out.chart.groups, ['Group 1 (40)', 'Group 2 (35)', 'Group 3 (30)']);
    assert.equal(out.chart.points.length, 105);
  }
  assert.match(out.headline, /^3 groups; the largest, group 1 \(40 items\)/);
  assert.ok(out.notes.some((n) => /Cost against Hours only/.test(n)));
  assert.deepEqual(runKmeans(data, { type: 'kmeans', params: { k: 0, seed: 1 } }, ctx), out);
});

test('k-means with a fixed k and a hand-worked case', () => {
  // Two tight pairs: centres (0, 0.5) and (10, 10.5); every point is 0.5 from its centre.
  const data = table(['Cost', 'Hours'], [[0, 0], [0, 1], [10, 10], [10, 11]]);
  const out = runKmeans(data, { type: 'kmeans', params: { k: 2, standardize: false } }, ctx);
  assert.equal(statOf(out, 'Groups'), 2);
  for (const r of out.table.rows) assert.ok(Math.abs((r[2] as number) - 0.5) < 1e-12);
  assert.equal(out.table.rows[0]![1], out.table.rows[1]![1]);
  assert.notEqual(out.table.rows[0]![1], out.table.rows[2]![1]);
});

test('unusable data throws a ModelError an analyst can act on', () => {
  const few = table(['Cost', 'Hours'], [[1, 2], [3, 4], [5, 6]]);
  assert.throws(() => runTree(few, { type: 'tree' }, ctx), ModelError);
  assert.throws(() => runForest(few, { type: 'forest' }, ctx), ModelError);
  assert.throws(() => runBoosting(few, { type: 'boosting' }, ctx), ModelError);
  assert.throws(() => runKmeans(table(['Cost', 'Hours'], [[1, 2], [3, 4]]), { type: 'kmeans' }, ctx), ModelError);
  const flat = table(['Cost', 'Hours'], Array.from({ length: 30 }, (_, i) => [5, i]));
  assert.throws(() => runTree(flat, { type: 'tree' }, ctx), /same on every row/);
  const noDrivers = table(['Cost', 'Hours'], Array.from({ length: 30 }, (_, i) => [i, 1]));
  assert.throws(() => runForest(noDrivers, { type: 'forest' }, ctx), /changes from row to row/);
  assert.throws(() => runTree(table(['Cost'], Array.from({ length: 30 }, (_, i) => [i])), { type: 'tree' }, ctx), ModelError);
  const same = table(['Cost', 'Hours'], Array.from({ length: 10 }, () => [1, 1]));
  assert.throws(() => runKmeans(same, { type: 'kmeans' }, ctx), /same values/);
});

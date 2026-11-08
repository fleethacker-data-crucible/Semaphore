// A regression tree (CART: Breiman, Friedman, Olshen and Stone, 1984), shared by the decision tree,
// the random forest and gradient boosting. Each node takes the split that most reduces the weighted
// sum of squared errors; the tree stops at a depth, at a minimum leaf size, or when no split helps.
//
// Speed: every feature is sorted once (presort), and each tree keeps one sorted index list per
// feature that is stably partitioned at each split, so a node costs O(rows × features) and a whole
// tree O(rows × features × depth) with no sorting after the first. Nodes are stored in typed arrays
// in depth-first order (the left child of node i is node i + 1), so a forest of 2,000 trees stays small.

import { ModelError } from '../types.ts';
import type { ModelData } from '../types.ts';
import { items } from '../data.ts';
import type { Rng } from '../rng.ts';

export interface CartOptions {
  maxDepth: number;
  /** The least (weighted) number of rows a leaf may hold. */
  minLeaf: number;
  /** Share of features tried at each split (random forests); 1 tries them all. */
  featureFraction?: number;
  /** Needed when featureFraction < 1. */
  rng?: Rng;
  /** A weight per row of X (bootstrap counts); rows weighted 0 are left out. */
  weights?: ArrayLike<number>;
  /** Only these rows (distinct indices into X). */
  rows?: ArrayLike<number>;
  /** presort(X), shared across many trees on the same X. */
  order?: Int32Array[];
}

export interface Cart {
  /** The feature a node splits on, or −1 for a leaf. */
  feature: Int32Array;
  /** Rows with x ≤ threshold go left (to node i + 1), the rest go right. */
  threshold: Float64Array;
  right: Int32Array;
  /** The (weighted) mean of y in the node: the prediction at a leaf. */
  value: Float64Array;
  /** The (weighted) number of rows in the node. */
  count: Float64Array;
  /** The fall in the sum of squared errors the node's split gives (0 at a leaf). */
  gain: Float64Array;
  nodes: number;
}

/** Row indices sorted by each feature column. */
export function presort(X: Float64Array[]): Int32Array[] {
  return X.map((col) => {
    const idx = new Int32Array(col.length);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    return idx.sort((a, b) => col[a]! - col[b]! || a - b);
  });
}

/** Fits one regression tree. `importance[f]` is the total impurity decrease on feature f (Breiman's MDI). */
export function fitCart(X: Float64Array[], y: ArrayLike<number>, opts: CartOptions): { tree: Cart; importance: Float64Array } {
  const n = y.length;
  const p = X.length;
  const w = new Float64Array(n);
  if (opts.rows) for (let k = 0; k < opts.rows.length; k++) { const r = opts.rows[k]!; w[r] = opts.weights ? opts.weights[r]! : 1; }
  else for (let i = 0; i < n; i++) w[i] = opts.weights ? opts.weights[i]! : 1;
  let m = 0;
  for (let i = 0; i < n; i++) if (w[i]! > 0) m++;
  const order = opts.order ?? presort(X);
  const sorted = new Int32Array(p * m);
  for (let f = 0; f < p; f++) {
    const o = order[f]!;
    let k = f * m;
    for (let j = 0; j < o.length; j++) if (w[o[j]!]! > 0) sorted[k++] = o[j]!;
  }
  const goLeft = new Uint8Array(n);
  const tmp = new Int32Array(m);
  const importance = new Float64Array(p);
  const frac = opts.featureFraction ?? 1;
  const tryCount = frac >= 1 || !opts.rng ? p : Math.max(1, Math.round(p * frac));
  const feats = new Int32Array(p);
  for (let f = 0; f < p; f++) feats[f] = f;
  const minLeaf = Math.max(1e-9, opts.minLeaf);

  const feature: number[] = [];
  const threshold: number[] = [];
  const right: number[] = [];
  const value: number[] = [];
  const count: number[] = [];
  const gain: number[] = [];

  const build = (lo: number, hi: number, depth: number): number => {
    let sw = 0;
    let swy = 0;
    for (let k = lo; k < hi; k++) { const r = sorted[k]!; sw += w[r]!; swy += w[r]! * y[r]!; }
    const mu = swy / sw;
    let sse = 0;
    for (let k = lo; k < hi; k++) { const r = sorted[k]!; sse += w[r]! * (y[r]! - mu) ** 2; }
    const id = feature.length;
    feature.push(-1); threshold.push(0); right.push(-1); value.push(mu); count.push(sw); gain.push(0);
    if (depth >= opts.maxDepth || hi - lo < 2 || sw < 2 * minLeaf || sse <= 1e-12 * (Math.abs(mu) * Math.abs(mu) * sw + 1e-300)) return id;
    if (tryCount < p) {
      // A fresh random subset of features for this split (Breiman 2001, "mtry"): partial Fisher–Yates.
      for (let j = 0; j < tryCount; j++) { const s = j + opts.rng!.int(p - j); const t = feats[j]!; feats[j] = feats[s]!; feats[s] = t; }
    }
    let bestGain = 1e-10 * sse;
    let bestF = -1;
    let bestThr = 0;
    for (let j = 0; j < tryCount; j++) {
      const f = feats[j]!;
      const col = X[f]!;
      const base = f * m;
      let wl = 0;
      let wyl = 0;
      for (let k = lo; k < hi - 1; k++) {
        const r = sorted[base + k]!;
        wl += w[r]!;
        wyl += w[r]! * y[r]!;
        const x = col[r]!;
        const xn = col[sorted[base + k + 1]!]!;
        if (xn <= x) continue;
        if (wl < minLeaf) continue;
        const wr = sw - wl;
        if (wr < minLeaf) break;
        // The fall in SSE from splitting into means mL and mR: wL·wR/w · (mL − mR)², stable for large y.
        const d = wyl / wl - (swy - wyl) / wr;
        const g = ((wl * wr) / sw) * d * d;
        if (g > bestGain) { bestGain = g; bestF = f; bestThr = x + (xn - x) / 2; }
      }
    }
    if (bestF < 0) return id;
    const col = X[bestF]!;
    for (let k = lo; k < hi; k++) { const r = sorted[k]!; goLeft[r] = col[r]! <= bestThr ? 1 : 0; }
    let mid = lo;
    for (let f = 0; f < p; f++) {
      const base = f * m;
      let nl = lo;
      let nr = 0;
      for (let k = lo; k < hi; k++) { const r = sorted[base + k]!; if (goLeft[r]) sorted[base + nl++] = r; else tmp[nr++] = r; }
      for (let k = 0; k < nr; k++) sorted[base + nl + k] = tmp[k]!;
      mid = nl;
    }
    feature[id] = bestF;
    threshold[id] = bestThr;
    gain[id] = bestGain;
    importance[bestF] = importance[bestF]! + bestGain;
    build(lo, mid, depth + 1);
    right[id] = build(mid, hi, depth + 1);
    return id;
  };
  if (m === 0) throw new ModelError('There are no rows to fit a tree to.');
  build(0, m, 0);
  const tree: Cart = {
    feature: Int32Array.from(feature),
    threshold: Float64Array.from(threshold),
    right: Int32Array.from(right),
    value: Float64Array.from(value),
    count: Float64Array.from(count),
    gain: Float64Array.from(gain),
    nodes: feature.length,
  };
  return { tree, importance };
}

/** The tree's prediction for row i of X; with `sub`, feature `sub` reads `subValue` instead (permutation importance). */
export function predictCart(tree: Cart, X: Float64Array[], i: number, sub = -1, subValue = 0): number {
  let node = 0;
  for (;;) {
    const f = tree.feature[node]!;
    if (f < 0) return tree.value[node]!;
    const x = f === sub ? subValue : X[f]![i]!;
    node = x <= tree.threshold[node]! ? node + 1 : tree.right[node]!;
  }
}

// ---- Shared by tree, forest and boosting -----------------------------------------------------------

export interface Drivers {
  y: Float64Array;
  /** Feature columns. */
  X: Float64Array[];
  targetLabel: string;
  targetFormat: 'number' | 'currency' | 'percent' | undefined;
  featureLabels: string[];
  featureFormats: Array<'number' | 'currency' | 'percent' | undefined>;
  dropped: number;
  n: number;
}

/** The first measure as the target and the rest as numeric drivers, with checks an analyst can act on. */
export function drivers(data: ModelData, minRows: number): Drivers {
  if (data.metrics.length < 2) throw new ModelError('This model needs two or more measures: the first is what to predict, the rest are the drivers.');
  const it = items(data, minRows, 2);
  const n = it.values.length;
  const p = data.metrics.length - 1;
  const y = new Float64Array(n);
  const X = Array.from({ length: p }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const row = it.values[i]!;
    y[i] = row[0]!;
    for (let f = 0; f < p; f++) X[f]![i] = row[f + 1]!;
  }
  const targetLabel = data.metrics[0]!.label;
  if (y.every((v) => v === y[0])) throw new ModelError(`${targetLabel} is the same on every row, so there is nothing to predict.`);
  if (X.every((col) => col.every((v) => v === col[0]))) throw new ModelError('None of the driver measures changes from row to row, so no split can tell rows apart.');
  return {
    y,
    X,
    targetLabel,
    targetFormat: data.metrics[0]!.format,
    featureLabels: data.metrics.slice(1).map((m) => m.label),
    featureFormats: data.metrics.slice(1).map((m) => m.format),
    dropped: it.dropped,
    n,
  };
}

/** 1 − SSE/SST over `rows` (all rows when absent); pred is indexed like y. */
export function rSquared(y: ArrayLike<number>, pred: ArrayLike<number>, rows?: ArrayLike<number>): number {
  const idx = rows ?? Array.from({ length: y.length }, (_, i) => i);
  let s = 0;
  for (let k = 0; k < idx.length; k++) s += y[idx[k]!]!;
  const mu = s / idx.length;
  let sse = 0;
  let sst = 0;
  for (let k = 0; k < idx.length; k++) { const i = idx[k]!; sse += (y[i]! - pred[i]!) ** 2; sst += (y[i]! - mu) ** 2; }
  return sst > 0 ? 1 - sse / sst : 0;
}

export function rmse(y: ArrayLike<number>, pred: ArrayLike<number>, rows?: ArrayLike<number>): number {
  const idx = rows ?? Array.from({ length: y.length }, (_, i) => i);
  let sse = 0;
  for (let k = 0; k < idx.length; k++) { const i = idx[k]!; sse += (y[i]! - pred[i]!) ** 2; }
  return Math.sqrt(sse / Math.max(1, idx.length));
}

/** Importances as shares of their positive total (negative ones stay negative). */
export function shares(imp: ArrayLike<number>): number[] {
  let t = 0;
  for (let i = 0; i < imp.length; i++) t += Math.max(0, imp[i]!);
  return Array.from(imp, (v) => (t > 0 ? v / t : 0));
}

/** Feature indices from most to least important. */
export function ranked(imp: ArrayLike<number>): number[] {
  return Array.from({ length: imp.length }, (_, i) => i).sort((a, b) => imp[b]! - imp[a]! || a - b);
}

/**
 * A rough count of the inner-loop steps one tree costs, for capping the work: the per-tree filter of
 * the sorted lists plus a scan and a partition per level.
 */
export function treeCost(n: number, p: number, depth: number, minLeaf: number): number {
  const levels = Math.min(depth, Math.ceil(Math.log2(Math.max(2, n / Math.max(1, minLeaf)))) + 1);
  return n * p * (levels * 2 + 1);
}

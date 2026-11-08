// Clusters (k-means): groups of similar items. Measures can be put on one scale first (z-scores), so a
// measure in dollars does not drown one in hours. Seeding by k-means++ (Arthur and Vassilvitskii
// 2007), then Lloyd's iterations to convergence, keeping the best of several restarts by inertia (the
// total squared distance to the centres). With k = 0 the number of groups is chosen by the mean
// silhouette score (Rousseeuw 1987) over k = 2..8.

import { fmt, pct } from '../format.ts';
import { Rng } from '../rng.ts';
import { droppedNote, items } from '../data.ts';
import { type ModelOutput, type ModelRunner, ModelError, numParam, param } from '../types.ts';

const BUDGET = 2e8;
/** Silhouettes are O(n²): past this many steps they are estimated on a seeded sample of items. */
const SIL_BUDGET = 1.2e8;

export interface Clustering {
  assign: Int32Array;
  /** k × d, row-major, in the space the points were given in. */
  centres: Float64Array;
  inertia: number;
}

function dist2(P: Float64Array, i: number, C: Float64Array, c: number, d: number): number {
  let s = 0;
  for (let j = 0; j < d; j++) { const t = P[i * d + j]! - C[c * d + j]!; s += t * t; }
  return s;
}

/** One k-means run: k-means++ seeding, then Lloyd's algorithm until no item changes group. */
function once(P: Float64Array, n: number, d: number, k: number, rng: Rng, maxIter: number): Clustering {
  const C = new Float64Array(k * d);
  const D = new Float64Array(n);
  // k-means++: the first centre at random, each next one with chance proportional to squared distance.
  const first = rng.int(n);
  for (let j = 0; j < d; j++) C[j] = P[first * d + j]!;
  for (let i = 0; i < n; i++) D[i] = dist2(P, i, C, 0, d);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += D[i]!;
    let pick = n - 1;
    if (total > 0) {
      let u = rng.next() * total;
      for (let i = 0; i < n; i++) { u -= D[i]!; if (u < 0) { pick = i; break; } }
    } else pick = rng.int(n);
    for (let j = 0; j < d; j++) C[c * d + j] = P[pick * d + j]!;
    for (let i = 0; i < n; i++) D[i] = Math.min(D[i]!, dist2(P, i, C, c, d));
  }
  const assign = new Int32Array(n).fill(-1);
  const sizes = new Int32Array(k);
  let inertia = 0;
  for (let it = 0; it < maxIter; it++) {
    let changed = 0;
    inertia = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) { const v = dist2(P, i, C, c, d); if (v < bd) { bd = v; best = c; } }
      D[i] = bd;
      inertia += bd;
      if (assign[i] !== best) { assign[i] = best; changed++; }
    }
    if (!changed && it > 0) break;
    C.fill(0);
    sizes.fill(0);
    for (let i = 0; i < n; i++) { const c = assign[i]!; sizes[c]!++; for (let j = 0; j < d; j++) C[c * d + j]! += P[i * d + j]!; }
    for (let c = 0; c < k; c++) {
      if (sizes[c]) { for (let j = 0; j < d; j++) C[c * d + j]! /= sizes[c]!; continue; }
      // An empty group takes the item farthest from its centre.
      let far = 0;
      for (let i = 1; i < n; i++) if (D[i]! > D[far]!) far = i;
      for (let j = 0; j < d; j++) C[c * d + j] = P[far * d + j]!;
      D[far] = 0;
    }
  }
  return { assign, centres: C, inertia };
}

/** Best of `restarts` k-means runs by inertia. */
export function kmeans(P: Float64Array, n: number, d: number, k: number, rng: Rng, restarts = 10, maxIter = 100): Clustering {
  let best: Clustering | null = null;
  for (let r = 0; r < restarts; r++) {
    const c = once(P, n, d, k, rng, maxIter);
    if (!best || c.inertia < best.inertia - 1e-12 * Math.max(1, best.inertia)) best = c;
  }
  return best!;
}

/** Mean silhouette (Rousseeuw 1987) of the items in `sample` against all items: (b − a) / max(a, b). */
export function silhouette(P: Float64Array, n: number, d: number, assign: Int32Array, k: number, sample: ArrayLike<number>): number {
  const sums = new Float64Array(k);
  const sizes = new Int32Array(k);
  for (let i = 0; i < n; i++) sizes[assign[i]!]!++;
  let total = 0;
  for (let s = 0; s < sample.length; s++) {
    const i = sample[s]!;
    sums.fill(0);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      let t = 0;
      for (let q = 0; q < d; q++) { const v = P[i * d + q]! - P[j * d + q]!; t += v * v; }
      sums[assign[j]!]! += Math.sqrt(t);
    }
    const own = assign[i]!;
    if (sizes[own]! <= 1) continue; // a lone item scores 0
    const a = sums[own]! / (sizes[own]! - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && sizes[c]! > 0) b = Math.min(b, sums[c]! / sizes[c]!);
    if (!Number.isFinite(b)) continue;
    const m = Math.max(a, b);
    total += m > 0 ? (b - a) / m : 0;
  }
  return total / Math.max(1, sample.length);
}

function ratioWords(r: number): string {
  const near = (x: number) => Math.abs(r / x - 1) < 0.12;
  if (near(2)) return 'twice';
  if (near(3)) return 'three times';
  if (near(4)) return 'four times';
  if (near(0.5)) return 'half';
  if (near(1 / 3)) return 'a third of';
  if (near(0.25)) return 'a quarter of';
  return r > 1 ? `${fmt(r, 'decimal')} times` : `${pct(r)} of`;
}

export const runKmeans: ModelRunner = (data, spec, ctx): ModelOutput => {
  const it = items(data, 4, 2);
  const n = it.values.length;
  const d = data.metrics.length;
  const standardize = param(spec, 'standardize', true);
  const askedK = Math.round(numParam(spec, 'k', 0, 0, 12));
  const rng = new Rng((ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0);
  const notes = droppedNote(it.dropped);
  const labels = data.metrics.map((m) => m.label);

  const means = new Float64Array(d);
  const sds = new Float64Array(d);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += it.values[i]![j]!;
    means[j] = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (it.values[i]![j]! - means[j]!) ** 2;
    sds[j] = Math.sqrt(v / Math.max(1, n - 1));
  }
  const P = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
    const x = it.values[i]![j]!;
    P[i * d + j] = standardize ? (sds[j]! > 0 ? (x - means[j]!) / sds[j]! : 0) : x;
  }
  const distinct = new Set(it.values.map((r) => r.join('|'))).size;
  if (distinct < 2) throw new ModelError('Every item has the same values, so there are no groups to find.');

  const maxK = Math.min(8, n - 1, distinct);
  const ks = askedK === 0 ? Array.from({ length: Math.max(0, maxK - 1) }, (_, i) => i + 2) : [Math.min(askedK, n - 1, distinct)];
  if (askedK > 0 && ks[0]! < askedK) notes.push(`Asked for ${askedK} groups, but ${n} items with ${distinct} distinct sets of values allow at most ${ks[0]}, so ${ks[0]} were made.`);
  if (askedK === 1) notes.push('One group is everything, so at least two are made.');
  if (ks[0]! < 2) ks[0] = 2;

  // Bound the work: rows × groups × measures × iterations × restarts over every k tried.
  const sumK = ks.reduce((a, b) => a + b, 0);
  const restarts = Math.max(3, Math.min(10, Math.floor(BUDGET / (n * d * sumK * 30))));
  if (restarts < 10) notes.push(`Kept the best of ${restarts} restarts per number of groups instead of 10 to keep the run short.`);
  let sample: number[] = Array.from({ length: n }, (_, i) => i);
  const silN = Math.max(300, Math.floor(SIL_BUDGET / (n * d * ks.length)));
  if (n > silN) {
    sample = new Rng((ctx.seed ^ 0x51) >>> 0).shuffle(sample).slice(0, silN);
    notes.push(`The silhouette score was estimated on ${fmt(silN, 'integer')} items drawn at random.`);
  }

  let best: { k: number; c: Clustering; sil: number } | null = null;
  const tried: Array<{ k: number; sil: number }> = [];
  for (const k of ks) {
    const c = kmeans(P, n, d, k, rng, restarts);
    const sil = silhouette(P, n, d, c.assign, k, sample);
    tried.push({ k, sil });
    if (!best || sil > best.sil + 1e-12) best = { k, c, sil };
  }
  const { k, c, sil } = best!;

  // Number the groups from largest to smallest (ties by first item), so group 1 is the biggest.
  const sizes0 = new Array<number>(k).fill(0);
  const firstAt = new Array<number>(k).fill(n);
  for (let i = 0; i < n; i++) { const g = c.assign[i]!; sizes0[g]!++; firstAt[g] = Math.min(firstAt[g]!, i); }
  const byRank = Array.from({ length: k }, (_, g) => g).filter((g) => sizes0[g]! > 0).sort((a, b) => sizes0[b]! - sizes0[a]! || firstAt[a]! - firstAt[b]!);
  const relabel = new Int32Array(k).fill(-1);
  byRank.forEach((g, r) => (relabel[g] = r));
  const groupsN = byRank.length;
  const group = Int32Array.from(c.assign, (g) => relabel[g]!);
  const size = byRank.map((g) => sizes0[g]!);
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) dist[i] = Math.sqrt(dist2(P, i, c.centres, c.assign[i]!, d));
  // Centres in original units: the mean of each group's items.
  const centre = Array.from({ length: groupsN }, () => new Float64Array(d));
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) centre[group[i]!]![j]! += it.values[i]![j]! / size[group[i]!]!;

  const show = (j: number, v: number) => (j === 0 ? fmt(v, 'metric', data.metrics[0]?.format) : fmt(v, data.metrics[j]?.format ?? 'number'));
  // What sets the largest group apart: its centre against the mean of every other item, on the two
  // measures where the gap is widest in standard deviations.
  const others = new Float64Array(d);
  const nOthers = n - size[0]!;
  for (let i = 0; i < n; i++) if (group[i] !== 0) for (let j = 0; j < d; j++) others[j]! += it.values[i]![j]! / Math.max(1, nOthers);
  const gaps = Array.from({ length: d }, (_, j) => j)
    .map((j) => ({ j, z: sds[j]! > 0 ? Math.abs(centre[0]![j]! - others[j]!) / sds[j]! : 0 }))
    .sort((a, b) => b.z - a.z || a.j - b.j)
    .filter((g) => g.z > 0.25)
    .slice(0, 2);
  const ratioForm = gaps.map(({ j }) => centre[0]![j]! > 0 && others[j]! > 0);
  const allRatio = ratioForm.every(Boolean);
  const phrase = gaps.map(({ j }, q) => {
    const a = centre[0]![j]!;
    const b = others[j]!;
    const raw = labels[j]!;
    const name = /[A-Z]/.test(raw.slice(1)) ? raw : raw.toLowerCase();
    if (ratioForm[q]) return `${ratioWords(a / b)} the ${name}${allRatio ? '' : ' of the others'}`;
    return `${a > b ? 'higher' : 'lower'} ${name} than the others (${show(j, a)} against ${show(j, b)})`;
  });
  const headline = phrase.length
    ? `${groupsN} groups; the largest, group 1 (${size[0]} items), has ${phrase.join(' and ')}${allRatio ? ' of the others' : ''}.`
    : `${groupsN} groups; the largest, group 1, holds ${size[0]} of the ${n} items and sits close to the overall average.`;

  const sentences: string[] = [];
  const silWord = sil >= 0.7 ? 'clearly separated' : sil >= 0.5 ? 'reasonably distinct' : sil >= 0.25 ? 'only loosely separated' : 'barely separated';
  sentences.push(`The groups are ${silWord}: the silhouette score is ${fmt(sil, 'decimal')} (1 means every item sits far closer to its own group than to the next; 0 means it sits between two).`);
  for (let g = 0; g < Math.min(groupsN, 4); g++) {
    sentences.push(`Group ${g + 1} (${size[g]} item${size[g] === 1 ? '' : 's'}) centres on ${Array.from({ length: d }, (_, j) => `${labels[j]} ${show(j, centre[g]![j]!)}`).join(', ')}.`);
  }
  if (askedK === 0 && tried.length > 1) notes.push(`Tried ${tried[0]!.k} to ${tried.at(-1)!.k} groups and kept ${k}, the best silhouette score (${tried.map((t) => `${t.k}: ${fmt(t.sil, 'decimal')}`).join(', ')}).`);
  if (d > 2) notes.push(`The chart shows ${labels[0]} against ${labels[1]} only; the groups were found using all ${d} measures.`);
  notes.push(standardize ? 'Measures were put on one scale (z-scores) before grouping; distances in the table are in standard deviations.' : 'Measures were grouped in their own units, so the measure with the biggest numbers counts most; distances in the table are in those units.');

  const groupNames = size.map((s, g) => `Group ${g + 1} (${s})`);
  return {
    model: 'kmeans',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      { label: 'Groups', value: groupsN, format: 'integer' },
      { label: 'Silhouette', value: sil, format: 'decimal', hint: 'From −1 to 1: how much closer items sit to their own group than to the next. Above 0.5 is a clear grouping.' },
      { label: 'Largest group', value: size[0]!, format: 'integer' },
      { label: 'Items', value: n, format: 'integer' },
    ],
    chart: {
      kind: 'scatter',
      points: it.values.map((r, i) => ({ x: r[0]!, y: r[1]!, group: group[i]!, label: it.labels[i]! })),
      xLabel: labels[0]!,
      yLabel: labels[1]!,
      groups: groupNames,
      xFormat: 'metric',
      yFormat: data.metrics[1]?.format ?? 'number',
    },
    table: {
      columns: ['Item', 'Group', 'Distance to centre', ...labels],
      rows: it.values.map((r, i) => [it.labels[i]!, `Group ${group[i]! + 1}`, dist[i]!, ...r]),
    },
    notes,
  };
};

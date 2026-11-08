// Status transitions (Markov chain): where items go next, and how long they take to finish. Rows are
// moves: the first field is the status moved from, the second the status moved to, the measure how
// many moves. The counts give a transition matrix P (each row divided by its total).
//
// Absorbing states are statuses with no moves out other than to themselves (Closed, Cancelled). With
// absorbing states, the absorbing-chain analysis (Kemeny and Snell): the fundamental matrix
// N = (I − Q)⁻¹ over the transient states, expected steps to finish t = N·1, and absorption
// probabilities B = N·R. Without them, the stationary distribution π (πP = π, Σπ = 1): the long-run
// share of time in each status. Either way, the distribution after `steps` moves from the busiest
// status (the one with the most moves out).

import { cellLabel } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { identity, inverse, solve } from '../linalg.ts';
import { type ModelData, ModelError, type ModelRunner, type ModelStat, numParam } from '../types.ts';

const MAX_STATES = 100;

export interface Chain {
  states: string[];
  counts: number[][];
  /** Row-normalised; a status with no moves out keeps itself (probability 1). */
  p: number[][];
  absorbing: boolean[];
}

export function buildChain(data: ModelData): { chain: Chain; dropped: number } {
  if (data.dims.length < 2 || !data.metrics.length) throw new ModelError('Transitions need two fields (from status, to status) and a count of moves.');
  const index = new Map<string, number>();
  const at = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = index.size;
      index.set(s, i);
    }
    return i;
  };
  const moves: Array<[number, number, number]> = [];
  let dropped = 0;
  for (const r of data.rows) {
    const c = r.values[0];
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) {
      dropped++;
      continue;
    }
    if (c === 0) continue;
    moves.push([at(cellLabel(r.dims[0] ?? null, data.dims[0]?.grain)), at(cellLabel(r.dims[1] ?? null, data.dims[1]?.grain)), c]);
  }
  const k = index.size;
  if (k > MAX_STATES) throw new ModelError(`There are ${k} statuses; group them to ${MAX_STATES} or fewer for a transition analysis.`);
  if (k < 2) throw new ModelError('Transitions need moves between at least two statuses.');
  const counts = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const [a, b, c] of moves) counts[a]![b]! += c;
  const absorbing = counts.map((row, i) => row.every((v, j) => j === i || v === 0));
  const p = counts.map((row, i) => {
    const tot = row.reduce((s, v) => s + v, 0);
    return absorbing[i] ? row.map((_, j) => (j === i ? 1 : 0)) : row.map((v) => v / tot);
  });
  return { chain: { states: [...index.keys()], counts, p, absorbing }, dropped };
}

/** Expected steps to absorption and absorption probabilities (Kemeny–Snell fundamental matrix). */
export function absorption(chain: Chain): { transient: number[]; absorbingIdx: number[]; steps: number[]; probs: number[][] } | null {
  const transient = chain.states.map((_, i) => i).filter((i) => !chain.absorbing[i]);
  const absorbingIdx = chain.states.map((_, i) => i).filter((i) => chain.absorbing[i]);
  const t = transient.length;
  const q = transient.map((i) => transient.map((j) => chain.p[i]![j]!));
  const iq = identity(t).map((row, a) => row.map((v, b) => v - q[a]![b]!));
  const n = inverse(iq);
  if (!n) return null;
  const steps = n.map((row) => row.reduce((s, v) => s + v, 0));
  const r = transient.map((i) => absorbingIdx.map((j) => chain.p[i]![j]!));
  const probs = n.map((row) => absorbingIdx.map((_, b) => row.reduce((s, v, c) => s + v * r[c]![b]!, 0)));
  return { transient, absorbingIdx, steps, probs };
}

/** The stationary distribution: solve πP = π with Σπ = 1 (the last balance equation replaced). */
export function stationary(p: number[][]): number[] | null {
  const k = p.length;
  const a = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => p[j]![i]! - (i === j ? 1 : 0)));
  a[k - 1] = new Array<number>(k).fill(1);
  const b = new Array<number>(k).fill(0);
  b[k - 1] = 1;
  const pi = solve(a, b);
  return pi && pi.every((v) => v > -1e-9) ? pi.map((v) => Math.max(0, v)) : null;
}

export function stepAhead(p: number[][], start: number, steps: number): number[] {
  let d: number[] = p.map((_, i) => (i === start ? 1 : 0));
  for (let s = 0; s < steps; s++) d = d.map((_, j) => d.reduce((acc, v, i) => acc + v * p[i]![j]!, 0));
  return d;
}

/** "1 step", "3.4 steps". */
const stepsText = (n: number) => `${fmt(n, 'decimal')} step${fmt(n, 'decimal') === '1' ? '' : 's'}`;

export const runMarkov: ModelRunner = (data, spec) => {
  const steps = Math.round(numParam(spec, 'steps', 5, 1, 200));
  const { chain, dropped } = buildChain(data);
  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out because the count was blank or negative.`);
  const { states, counts, p, absorbing } = chain;
  const k = states.length;
  const out = counts.map((row) => row.reduce((s, v) => s + v, 0));
  const totalMoves = out.reduce((s, v) => s + v, 0);
  const between = counts.reduce((s, row, i) => s + row.reduce((a, v, j) => a + (i === j ? 0 : v), 0), 0);
  if (between === 0) throw new ModelError('Every move stays in the same status, so there are no transitions to study.');
  const selfShare = 1 - between / totalMoves;
  if (selfShare > 0) notes.push(`${pct(selfShare)} of moves stay in the same status; they count as a step that goes nowhere.`);

  const hasAbsorbing = absorbing.some(Boolean);
  // Start from the busiest status; in an absorbing chain, the busiest that is not absorbing.
  const candidates = states.map((_, i) => i).filter((i) => !hasAbsorbing || !absorbing[i]);
  const start = candidates.reduce((best, i) => (out[i]! > out[best]! ? i : best), candidates[0]!);
  const after = stepAhead(p, start, steps);
  const name = (i: number) => states[i]!;
  const sentences: string[] = [];
  const stats: ModelStat[] = [
    { label: 'Statuses', value: k, format: 'integer' },
    { label: 'Moves', value: totalMoves, format: 'integer' },
  ];
  let headline: string;
  const columns = ['Status', 'Moves out', `Share after ${steps} step${steps === 1 ? '' : 's'} from ${name(start)}`];
  let rows: Array<Array<string | number | null>>;

  if (hasAbsorbing) {
    const abs = absorption(chain);
    if (!abs) throw new ModelError('Some statuses loop among themselves and never reach a final status, so the time to finish cannot be worked out. Check for a missing closing move.');
    const ti = abs.transient.indexOf(start);
    const st = abs.steps[ti]!;
    const pr = abs.probs[ti]!;
    const order = abs.absorbingIdx.map((_, b) => b).sort((a, b) => pr[b]! - pr[a]!);
    const main = order[0]!;
    const others = order.slice(1).filter((b) => pr[b]! > 0.0005);
    if (abs.absorbingIdx.length === 1) headline = `From ${name(start)}, items take ${stepsText(st)} on average to reach ${name(abs.absorbingIdx[0]!)}.`;
    else headline = `From ${name(start)}, items take ${stepsText(st)} on average to finish; ${pct(pr[main]!)} end in ${name(abs.absorbingIdx[main]!)}${others.length ? `, ${others.map((b) => `${pct(pr[b]!)} in ${name(abs.absorbingIdx[b]!)}`).join(', ')}` : ''}.`;
    const slowest = abs.transient.map((s, a) => ({ s, t: abs.steps[a]! })).sort((a, b) => b.t - a.t)[0]!;
    if (abs.transient.length > 1 && slowest.s !== start) sentences.push(`${name(slowest.s)} is furthest from done, at ${stepsText(slowest.t)} on average.`);
    const done = abs.absorbingIdx.reduce((s, j) => s + after[j]!, 0);
    sentences.push(`After ${steps} step${steps === 1 ? '' : 's'} from ${name(start)}, ${pct(done)} of items have finished.`);
    sentences.push(`Final statuses (no moves out): ${abs.absorbingIdx.map(name).join(', ')}.`);
    stats.push({ label: `Steps to finish from ${name(start)}`, value: st, format: 'decimal', hint: 'Expected moves before reaching a final status.' });
    stats.push({ label: `End in ${name(abs.absorbingIdx[main]!)}`, value: pr[main]!, format: 'percent' });
    columns.push('Expected steps to finish', ...abs.absorbingIdx.map((j) => `Chance of ending in ${name(j)}`));
    rows = states.map((s, i) => {
      const a = abs.transient.indexOf(i);
      const bIdx = abs.absorbingIdx.indexOf(i);
      return [s, out[i]!, after[i]!, a >= 0 ? abs.steps[a]! : 0, ...abs.absorbingIdx.map((_, b) => (a >= 0 ? abs.probs[a]![b]! : b === bIdx ? 1 : 0))];
    });
  } else {
    const pi = stationary(p);
    if (!pi) throw new ModelError('The statuses split into groups that never reach each other, so there is no single long-run picture. Look at each group on its own.');
    const order = pi.map((_, i) => i).sort((a, b) => pi[b]! - pi[a]!);
    const top = order[0]!;
    headline = `In the long run, ${pct(pi[top]!)} of items sit in ${name(top)}${order.length > 1 ? `, ${order.slice(1, 3).map((i) => `${pct(pi[i]!)} in ${name(i)}`).join(', ')}` : ''}.`;
    sentences.push('No status is final (every one has moves out), so items keep cycling; the long-run shares are where they spend their time.');
    sentences.push(`After ${steps} step${steps === 1 ? '' : 's'} from ${name(start)}, the most likely status is ${name(after.indexOf(Math.max(...after)))} (${pct(Math.max(...after))}).`);
    const ret = pi[top]! > 0 ? 1 / pi[top]! : Number.NaN;
    sentences.push(`An item leaving ${name(top)} comes back after ${stepsText(ret)} on average (1 over its long-run share).`);
    stats.push({ label: `Long-run share in ${name(top)}`, value: pi[top]!, format: 'percent' });
    columns.push('Long-run share');
    rows = states.map((s, i) => [s, out[i]!, after[i]!, pi[i]!]);
  }
  const busiest = p[start]!.map((v, j) => ({ j, v })).filter((x) => x.j !== start).sort((a, b) => b.v - a.v)[0];
  if (busiest && busiest.v > 0) sentences.unshift(`From ${name(start)}, the most common next status is ${name(busiest.j)} (${pct(busiest.v)} of moves).`);
  const chart = { kind: 'matrix' as const, rows: states, cols: states, values: p, percent: true };
  if (totalMoves < 30) notes.push(`Only ${totalMoves} moves: the shares are rough.`);
  return { model: 'markov', headline, sentences: sentences.slice(0, 5), stats, chart, table: { columns, rows }, notes };
};

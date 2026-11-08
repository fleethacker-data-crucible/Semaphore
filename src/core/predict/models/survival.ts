// Survival (Kaplan-Meier): how long until something ends, counting the items still open. Each row is
// an item: its duration (first measure) and, optionally, whether it has ended (second measure: 1
// finished or failed, 0 still open, a "censored" observation). A second field splits the items into
// groups with a curve each.
//
// Methods: the Kaplan–Meier product-limit estimator; Greenwood's formula for its variance; a pointwise
// confidence band by the log(−log) transform (Kalbfleisch and Prentice), which stays inside 0..1; the
// median with its interval read from the band (Brookmeyer and Crowley); and the log-rank (Mantel–Cox)
// test for a difference between groups, a chi-square on G − 1 degrees of freedom.

import { cellLabel } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { solve } from '../linalg.ts';
import { chiSquareCdf, zFor } from '../stats.ts';
import { type ModelData, ModelError, type ModelRunner, type ModelStat, numParam } from '../types.ts';
import { fmtP } from './regression.ts';

export interface Lifetimes {
  times: number[];
  /** 1 ended (event), 0 still open (censored). */
  events: number[];
  groups: string[];
  dropped: number;
  notes: string[];
}

/** Durations, event flags and groups from a flag's rows; blanks and negative durations are left out. */
export function lifetimes(data: ModelData, positive = false): Lifetimes {
  if (!data.metrics.length) throw new ModelError('This model needs a duration measure.');
  const hasEvent = data.metrics.length > 1;
  const times: number[] = [];
  const events: number[] = [];
  const groups: string[] = [];
  let dropped = 0;
  let recoded = 0;
  for (const r of data.rows) {
    const t = r.values[0];
    const e = hasEvent ? r.values[1] : 1;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || (positive && t <= 0) || typeof e !== 'number' || !Number.isFinite(e)) {
      dropped++;
      continue;
    }
    if (e !== 0 && e !== 1) recoded++;
    times.push(t);
    events.push(e > 0 ? 1 : 0);
    groups.push(data.dims.length > 1 ? cellLabel(r.dims[1] ?? null, data.dims[1]?.grain) : 'All');
  }
  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} row${dropped === 1 ? ' was' : 's were'} left out: a blank${positive ? ', zero' : ''} or negative duration, or a blank ended flag.`);
  if (recoded) notes.push(`${recoded} ended flag${recoded === 1 ? ' was' : 's were'} not 0 or 1; values above 0 were read as ended.`);
  if (!hasEvent) notes.push('There is no ended measure, so every item was counted as ended. Add a 1/0 measure to count open items fairly.');
  return { times, events, groups, dropped, notes };
}

export interface KmStep {
  time: number;
  atRisk: number;
  events: number;
  censored: number;
  survival: number;
  /** Greenwood variance of the survival estimate. */
  variance: number;
  lower: number;
  upper: number;
}

/**
 * Kaplan–Meier at each distinct time (events or censorings), with Greenwood's variance and the
 * log(−log) band at `level`. Items censored at an event time count as at risk at that time.
 */
export function kaplanMeier(times: ArrayLike<number>, events: ArrayLike<number>, level = 0.95): KmStep[] {
  const idx = Array.from({ length: times.length }, (_, i) => i).sort((a, b) => times[a]! - times[b]!);
  const z = zFor(level);
  const out: KmStep[] = [];
  let atRisk = times.length;
  let s = 1;
  let gw = 0; // Σ d / (n (n − d))
  for (let i = 0; i < idx.length; ) {
    const t = times[idx[i]!]!;
    let d = 0;
    let c = 0;
    let j = i;
    while (j < idx.length && times[idx[j]!] === t) {
      if (events[idx[j]!]) d++;
      else c++;
      j++;
    }
    if (d > 0) {
      s *= 1 - d / atRisk;
      gw = d < atRisk ? gw + d / (atRisk * (atRisk - d)) : Infinity;
    }
    let lower: number;
    let upper: number;
    if (s <= 0) {
      lower = 0;
      upper = 0;
    } else if (s >= 1 || gw === 0) {
      lower = s;
      upper = s;
    } else {
      // log(−log S) has standard error sqrt(Σ d/(n(n−d))) / |log S|.
      const theta = (z * Math.sqrt(gw)) / Math.abs(Math.log(s));
      lower = s ** Math.exp(theta);
      upper = s ** Math.exp(-theta);
    }
    out.push({ time: t, atRisk, events: d, censored: c, survival: s, variance: Number.isFinite(gw) ? s * s * gw : 0, lower, upper });
    atRisk -= d + c;
    i = j;
  }
  return out;
}

/** The first time the curve reaches 0.5 or below; null when it never does ("not reached"). */
function crossing(steps: KmStep[], pick: (s: KmStep) => number): number | null {
  for (const s of steps) if (pick(s) <= 0.5 + 1e-12) return s.time;
  return null;
}

/** Median survival with its interval from the band (Brookmeyer–Crowley style). */
export function kmMedian(steps: KmStep[]): { median: number | null; low: number | null; high: number | null } {
  return { median: crossing(steps, (s) => s.survival), low: crossing(steps, (s) => s.lower), high: crossing(steps, (s) => s.upper) };
}

/** The log-rank (Mantel–Cox) test across groups: chi-square statistic, degrees of freedom, p. */
export function logRank(times: ArrayLike<number>, events: ArrayLike<number>, groups: ArrayLike<number>, g: number): { chi2: number; df: number; p: number; observed: number[]; expected: number[] } {
  const n = times.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => times[a]! - times[b]!);
  const risk = new Array<number>(g).fill(0);
  for (let i = 0; i < n; i++) risk[groups[i]!]!++;
  const o = new Array<number>(g).fill(0);
  const e = new Array<number>(g).fill(0);
  const v = Array.from({ length: g }, () => new Array<number>(g).fill(0));
  for (let i = 0; i < n; ) {
    const t = times[idx[i]!]!;
    const dg = new Array<number>(g).fill(0);
    const leave = new Array<number>(g).fill(0);
    let j = i;
    while (j < n && times[idx[j]!] === t) {
      const k = groups[idx[j]!]!;
      if (events[idx[j]!]) dg[k]!++;
      leave[k]!++;
      j++;
    }
    const d = dg.reduce((a, b) => a + b, 0);
    const nr = risk.reduce((a, b) => a + b, 0);
    if (d > 0 && nr > 0) {
      for (let a = 0; a < g; a++) {
        o[a]! += dg[a]!;
        e[a]! += (d * risk[a]!) / nr;
        if (nr > 1) {
          const f = (d * (nr - d)) / (nr - 1);
          for (let b = 0; b < g; b++) v[a]![b]! += f * (risk[a]! / nr) * ((a === b ? 1 : 0) - risk[b]! / nr);
        }
      }
    }
    for (let a = 0; a < g; a++) risk[a]! -= leave[a]!;
    i = j;
  }
  const df = g - 1;
  const diff = o.slice(0, df).map((x, a) => x - e[a]!);
  const vv = v.slice(0, df).map((row) => row.slice(0, df));
  const w = solve(vv, diff);
  const chi2 = w ? diff.reduce((s, x, a) => s + x * w[a]!, 0) : 0;
  return { chi2, df, p: w ? 1 - chiSquareCdf(chi2, df) : 1, observed: o, expected: e };
}

const MAX_GROUPS = 10;

export const runSurvival: ModelRunner = (data, spec) => {
  const level = numParam(spec, 'level', 0.9, 0.5, 0.999);
  const lt = lifetimes(data);
  const notes = [...lt.notes];
  const n = lt.times.length;
  if (n < 3) throw new ModelError(`Survival needs at least 3 items with a duration; this flag has ${n}.`);
  const ended = lt.events.reduce((a, b) => a + b, 0);
  if (ended === 0) throw new ModelError('No item has ended yet (every ended flag is 0), so there is no time to estimate. Check the ended measure.');
  const durLabel = data.metrics[0]!.label;

  // Groups, largest first, capped.
  const counts = new Map<string, number>();
  for (const g of lt.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  let names = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1));
  let keep = lt.times.map((_, i) => i);
  if (names.length > MAX_GROUPS) {
    const kept = new Set(names.slice(0, MAX_GROUPS));
    notes.push(`There are ${names.length} groups; the ${MAX_GROUPS} largest are shown and the rest left out.`);
    names = names.slice(0, MAX_GROUPS);
    keep = keep.filter((i) => kept.has(lt.groups[i]!));
  }
  const gi = new Map(names.map((g, i) => [g, i]));

  const all = kaplanMeier(lt.times, lt.events, level);
  const med = kmMedian(all);
  const lvl = `${Math.round(level * 100)}%`;
  const per = names.map((g) => {
    const ix = keep.filter((i) => lt.groups[i] === g);
    const steps = kaplanMeier(ix.map((i) => lt.times[i]!), ix.map((i) => lt.events[i]!), level);
    return { name: g, n: ix.length, events: ix.reduce((s, i) => s + lt.events[i]!, 0), steps, med: kmMedian(steps) };
  });
  const grouped = names.length > 1;
  const lr = grouped ? logRank(keep.map((i) => lt.times[i]!), keep.map((i) => lt.events[i]!), keep.map((i) => gi.get(lt.groups[i]!)!), names.length) : null;

  const open = n - ended;
  const medText = (m: { median: number | null }) => (m.median === null ? 'not reached' : fmt(m.median, 'decimal'));
  let headline = med.median === null ? `More than half of the items are still going: the median ${durLabel} is not reached yet (${pct(all.at(-1)!.survival)} still open at ${fmt(all.at(-1)!.time, 'decimal')}).` : `Half of the items end within ${fmt(med.median, 'decimal')} (${durLabel})${open ? `, counting the ${open} still open` : ''}.`;
  const sentences: string[] = [];
  sentences.push(`The ${lvl} interval for the median runs from ${med.low === null ? 'not reached' : fmt(med.low, 'decimal')} to ${med.high === null ? 'not reached' : fmt(med.high, 'decimal')}.`);
  if (grouped && lr) {
    const reached = per.filter((p) => p.med.median !== null).sort((a, b) => a.med.median! - b.med.median!);
    const diff = lr.p < 0.05 ? `the groups differ (log-rank p ${fmtP(lr.p)})` : `the difference between groups could be chance (log-rank p ${fmtP(lr.p)})`;
    if (reached.length >= 2) headline = headline.replace(/\.$/, `; ${reached[0]!.name} is quickest at ${fmt(reached[0]!.med.median!, 'decimal')} and ${reached.at(-1)!.name} slowest at ${fmt(reached.at(-1)!.med.median!, 'decimal')}, and ${diff}.`);
    else headline = headline.replace(/\.$/, `; ${diff}.`);
    sentences.push(`Median by group: ${per.map((p) => `${p.name} ${medText(p.med)}`).join(', ')}.`);
    const slow = per.map((p, i) => ({ name: p.name, ratio: lr.expected[i]! > 0 ? lr.observed[i]! / lr.expected[i]! : Number.NaN })).filter((x) => Number.isFinite(x.ratio)).sort((a, b) => a.ratio - b.ratio)[0];
    if (slow && lr.p < 0.05) sentences.push(`${slow.name} ends least often for its numbers (${fmt(slow.ratio, 'decimal')}× the endings expected if all groups were alike).`);
  }
  if (open) sentences.push(`${open} of ${n} items (${pct(open / n)}) are still open; Kaplan-Meier counts them for as long as they have run instead of leaving them out.`);
  const at = (q: number) => all.find((s) => s.survival <= 1 - q)?.time ?? null;
  const q75 = at(0.75);
  if (q75 !== null) sentences.push(`Three in four end within ${fmt(q75, 'decimal')}.`);

  const stats: ModelStat[] = [
    { label: 'Median', value: med.median ?? 'Not reached', ...(med.median === null ? {} : { format: 'decimal' as const }), hint: `Half of the items end within this ${durLabel}.` },
    { label: `Median ${lvl} interval`, value: `${med.low === null ? '–' : fmt(med.low, 'decimal')} to ${med.high === null ? 'not reached' : fmt(med.high, 'decimal')}` },
    { label: 'Items', value: n, format: 'integer' },
    { label: 'Still open', value: open / n, format: 'percent', hint: 'Censored: not ended by the time the data was taken.' },
    ...(lr ? [{ label: 'Log-rank p', value: lr.p, format: 'decimal' as const, hint: 'The chance of curves this different if the groups were really alike.' }] : []),
  ];

  const curveOf = (name: string, steps: KmStep[], band: boolean) => {
    const x = [0, ...steps.map((s) => s.time)];
    const y = [1, ...steps.map((s) => s.survival)];
    return band ? { name, x, y, lower: [1, ...steps.map((s) => s.lower)], upper: [1, ...steps.map((s) => s.upper)], step: true } : { name, x, y, step: true };
  };
  const chart = { kind: 'curves' as const, curves: grouped ? per.map((p) => curveOf(p.name, p.steps, per.length <= 3)) : [curveOf('Still going', all, true)], xLabel: durLabel, yLabel: 'Share still going', yPercent: true };

  const rows: Array<Array<string | number | null>> = [];
  for (const p of grouped ? per : [{ name: 'All', steps: all }]) for (const s of p.steps) rows.push([p.name, s.time, s.atRisk, s.events, s.censored, s.survival, s.lower, s.upper]);
  const table = { columns: ['Group', durLabel, 'At risk', 'Ended', 'Still open (censored)', 'Share still going', `Low (${lvl})`, `High (${lvl})`], rows };
  if (ended < 10) notes.push(`Only ${ended} item${ended === 1 ? ' has' : 's have'} ended, so the curve is rough.`);
  return { model: 'survival', headline, sentences: sentences.slice(0, 5), stats, chart, table, notes };
};

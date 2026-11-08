// Backlog forecast by Monte Carlo resampling of throughput (the "when will it be done" forecast of
// Troy Magennis and Daniel Vacanti's Actionable Agile): each trial replays past periods drawn at
// random, with replacement, until the items finished add up to the backlog. The share of trials
// done by each future period is the chance of clearing the backlog by then. A second run asks the
// other way round: how many items are finished by `horizon` periods ahead.

import { futureLabels, timeSeries } from '../data.ts';
import { fmt, pct } from '../format.ts';
import { Rng } from '../rng.ts';
import { histogram, mean, quantileSorted } from '../stats.ts';
import { ModelError, type ModelOutput, type ModelRunner, numParam } from '../types.ts';

/** Total resampled periods per run (trials × periods per trial); trials are cut to fit. */
const MAX_STEPS = 30_000_000;
/** Beyond this many periods at the recent pace the forecast is not useful. */
const MAX_PERIODS = 5000;

export const runBacklog: ModelRunner = (data, spec, ctx): ModelOutput => {
  const notes: string[] = [];
  const series = timeSeries(data, 3);
  const backlog = Math.round(numParam(spec, 'backlog', 100, 1, 10_000_000));
  const lookback = Math.round(numParam(spec, 'lookback', 26, 3, 520));
  const horizon = Math.round(numParam(spec, 'horizon', 8, 1, 260));
  let trials = Math.round(numParam(spec, 'trials', 10000, 500, 200000));
  const rng = new Rng((ctx.seed ^ Math.round(numParam(spec, 'seed', 1, 1, 1_000_000))) >>> 0);

  const all = series.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0));
  const blanks = series.values.filter((v) => v === null).length;
  if (blanks) notes.push(`${blanks} period${blanks === 1 ? '' : 's'} with nothing recorded counted as zero finished.`);
  if (series.values.some((v) => typeof v === 'number' && v < 0)) notes.push('Negative throughput was counted as zero.');
  const hist = Float64Array.from(all.slice(-lookback));
  const len = hist.length;
  if (all.length > lookback) notes.push(`Only the last ${lookback} periods were sampled, as the setting asks.`);
  if (len < 8) notes.push(`Only ${len} periods of history: the forecast assumes the future looks like these few, so treat it as rough.`);
  const pace = mean(hist);
  if (!(pace > 0)) throw new ModelError('Nothing was finished in the periods sampled, so there is no pace to forecast from; widen the look-back or check the measure counts finished items.');
  const expected = backlog / pace;
  if (expected > MAX_PERIODS) throw new ModelError(`At the recent pace of ${fmt(pace, 'decimal')} a period, ${backlog.toLocaleString('en-US')} items would take about ${Math.round(expected).toLocaleString('en-US')} periods, too far ahead to forecast; use a coarser date grain or a smaller backlog.`);
  const cap = Math.max(10 * len, Math.ceil(3 * expected) + len);
  if (trials * (expected + horizon) > MAX_STEPS) {
    const cut = Math.max(500, Math.floor(MAX_STEPS / (expected + horizon)));
    if (cut < trials) {
      notes.push(`Trials were cut from ${trials.toLocaleString('en-US')} to ${cut.toLocaleString('en-US')} to keep the run quick.`);
      trials = cut;
    }
  }

  // Periods needed per trial; unfinished trials (past the cap) are Infinity.
  const needed = new Float64Array(trials);
  let unfinished = 0;
  for (let t = 0; t < trials; t++) {
    let done = 0;
    let k = 0;
    while (done < backlog && k < cap) {
      done += hist[rng.int(len)]!;
      k++;
    }
    if (done >= backlog) needed[t] = k;
    else {
      needed[t] = Infinity;
      unfinished++;
    }
  }
  if (unfinished) notes.push(`${unfinished.toLocaleString('en-US')} of ${trials.toLocaleString('en-US')} trials had not cleared the backlog after ${cap.toLocaleString('en-US')} periods; they count as not done.`);

  // Items finished by the horizon, per trial.
  const doneBy = new Float64Array(trials);
  for (let t = 0; t < trials; t++) {
    let d = 0;
    for (let k = 0; k < horizon; k++) d += hist[rng.int(len)]!;
    doneBy[t] = d;
  }

  const sortedNeeded = Float64Array.from(needed).sort();
  /** The fewest periods by which at least share p of trials had cleared the backlog. */
  const by = (p: number) => sortedNeeded[Math.min(trials - 1, Math.max(0, Math.ceil(p * trials) - 1))]!;
  const p50 = by(0.5);
  const p85 = by(0.85);
  const p95 = by(0.95);
  const maxFinite = sortedNeeded[trials - unfinished - 1] ?? 0;
  const future = futureLabels(series, Math.max(1, Math.min(cap, Math.max(maxFinite, horizon))));
  const dateAt = (k: number) => (Number.isFinite(k) && k >= 1 ? (future.labels[k - 1] ?? `+${k}`) : 'not within the simulation');
  const unit = series.grain ?? 'period';
  const span = (k: number) => `${k.toLocaleString('en-US')} ${unit}${k === 1 ? '' : 's'}`;

  const doneSorted = Float64Array.from(doneBy).sort();
  // "At least Q items": the 15th percentile of items done is reached in 85% of trials.
  const atLeast85 = quantileSorted(doneSorted, 0.15);
  const doneMid = quantileSorted(doneSorted, 0.5);
  const horizonLabel = future.labels[horizon - 1] ?? `+${horizon}`;
  const items = backlog.toLocaleString('en-US');

  const headline = Number.isFinite(p85)
    ? `There is an 85% chance the backlog of ${items} clears by ${dateAt(p85)} (in ${span(p85)}).`
    : `Fewer than 85% of simulations clear the backlog of ${items} within ${span(cap)}; at the recent pace it needs about ${span(Math.ceil(expected))}.`;
  const sentences: string[] = [];
  if (Number.isFinite(p50)) sentences.push(`It is a coin flip to be done by ${dateAt(p50)} (${span(p50)}); for 95% confidence plan on ${Number.isFinite(p95) ? `${dateAt(p95)} (${span(p95)})` : 'longer than the simulation runs'}.`);
  sentences.push(`Over the next ${span(horizon)} (to ${horizonLabel}) at least ${fmt(Math.floor(atLeast85), 'integer')} items get done with 85% confidence, and ${fmt(Math.round(doneMid), 'integer')} is the middle guess.`);
  sentences.push(`This replays the last ${span(len)} of history at random ${trials.toLocaleString('en-US')} times; the recent pace is ${fmt(pace, 'decimal')} items a ${unit}.`);
  notes.push('Assumes the backlog stays the same size and the team keeps working the way it did in the history sampled.');

  // Histogram of periods needed: one bin per period when the range is short.
  const fin = sortedNeeded.subarray(0, trials - unfinished);
  let bins: Array<{ x0: number; x1: number; count: number }>;
  const lo = fin[0] ?? 0;
  const hi = fin[fin.length - 1] ?? 0;
  if (fin.length && hi - lo <= 60) {
    bins = [];
    let i = 0;
    for (let k = lo; k <= hi; k++) {
      let c = 0;
      while (i < fin.length && fin[i] === k) {
        c++;
        i++;
      }
      bins.push({ x0: k - 0.5, x1: k + 0.5, count: c });
    }
  } else bins = histogram(fin, 40);
  const markers = [
    { label: '50% chance', value: p50 },
    { label: '85% chance', value: p85, tone: 'good' as const },
    { label: '95% chance', value: p95 },
  ].filter((m) => Number.isFinite(m.value));

  // Table: each period with its date and the chance the backlog is clear by then.
  const rows: Array<Array<string | number | null>> = [];
  const lastRow = Number.isFinite(p95) ? p95 : maxFinite;
  let i = 0;
  for (let k = Math.max(1, lo); k <= lastRow && rows.length < 400; k++) {
    while (i < fin.length && fin[i]! <= k) i++;
    rows.push([k, dateAt(k), i / trials]);
  }
  const byStat = (label: string, k: number): ModelOutput['stats'][number] => ({
    label,
    value: Number.isFinite(k) ? dateAt(k) : '–',
    hint: Number.isFinite(k) ? `${span(k)} after the last period of history.` : 'Not reached within the simulation.',
  });

  return {
    model: 'backlog',
    headline,
    sentences: sentences.slice(0, 5),
    stats: [
      byStat('50% chance by', p50),
      byStat('85% chance by', p85),
      byStat('95% chance by', p95),
      { label: `Done by ${horizonLabel} (85%)`, value: Math.floor(atLeast85), format: 'integer', hint: `At least this many items finish in the next ${span(horizon)} in 85% of trials.` },
      { label: 'Recent pace', value: pace, format: 'decimal', hint: `Average items finished a ${unit} over the periods sampled.` },
    ],
    chart: { kind: 'histogram', bins, markers, xFormat: 'integer', xLabel: `${unit[0]!.toUpperCase()}${unit.slice(1)}s to clear` },
    table: { columns: ['Periods ahead', 'Period', 'Chance cleared by then'], rows },
    notes,
  };
};

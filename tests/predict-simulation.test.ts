// Simulation, risk and quality models: Monte Carlo, backlog, sensitivity, bootstrap, Bayesian rates,
// control charts and anomaly detection. Checked against closed-form answers (triangular and PERT
// means, Irwin–Hall percentiles, conjugate posteriors), hand-worked series and seeded synthetic
// data with known truth.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnomaly } from '../src/core/predict/models/anomaly.ts';
import { runBacklog } from '../src/core/predict/models/backlog.ts';
import { betaQuantile, gammaQuantile, runBayes } from '../src/core/predict/models/bayes.ts';
import { runBootstrap } from '../src/core/predict/models/bootstrap.ts';
import { ranks, runMontecarlo, spearman } from '../src/core/predict/models/montecarlo.ts';
import { runSensitivity } from '../src/core/predict/models/sensitivity.ts';
import { runSpc, westernElectric } from '../src/core/predict/models/spc.ts';
import { Rng } from '../src/core/predict/rng.ts';
import { betaI, gammaP, normalInv } from '../src/core/predict/stats.ts';
import { type ModelData, ModelError, type ModelInput, type ModelOutput, type ModelSpec, type ParamValue } from '../src/core/predict/types.ts';

const ctx = { seed: 7, today: '2026-11-08' };
const empty: ModelData = { dims: [], metrics: [], rows: [] };

function mc(inputs: ModelInput[], params: Record<string, ParamValue> = {}): ModelOutput {
  return runMontecarlo(empty, { type: 'montecarlo', inputs, params }, ctx);
}
const stat = (o: ModelOutput, label: string) => o.stats.find((s) => s.label === label)?.value as number;
const tableValue = (o: ModelOutput, first: string, col = 1) => o.table.rows.find((r) => r[0] === first)?.[col] as number;
const near = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);

/** One labelled field and measures per row. */
function labelled(values: Array<Array<number | null>>, metrics = ['Value'], isDate = false): ModelData {
  return {
    dims: [{ key: 'k', label: 'Item', isDate }],
    metrics: metrics.map((label, i) => ({ key: `m${i}`, label })),
    rows: values.map((v, i) => ({ dims: [`Item ${String(i + 1).padStart(3, '0')}`], values: v })),
  };
}

/** A monthly series from Jan 2025. */
function monthly(values: Array<number | null>): ModelData {
  return {
    dims: [{ key: 'd', label: 'Month', grain: 'month', isDate: true }],
    metrics: [{ key: 'n', label: 'Finished' }],
    rows: values.map((v, i) => ({ dims: [`${2025 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`], values: [v] })),
  };
}

// ---- Monte Carlo ---------------------------------------------------------------------------------

test('Monte Carlo: triangular inputs add up to Σ(a+b+c)/3 within 0.5%', () => {
  const inputs: ModelInput[] = [
    { name: 'Labour', low: 80, likely: 100, high: 150, distribution: 'triangular' },
    { name: 'Parts', low: 20, likely: 30, high: 70, distribution: 'triangular' },
    { name: 'Freight', low: 5, likely: 6, high: 12, distribution: 'triangular' },
  ];
  const o = mc(inputs, { trials: 200000 });
  const truth = inputs.reduce((a, x) => a + (x.low + x.likely + x.high) / 3, 0);
  near(stat(o, 'Mean'), truth, truth * 0.005, 'mean');
  assert.equal(o.chart?.kind, 'histogram');
  assert.ok(o.notes.some((n) => /independent/.test(n)));
  assert.equal(o.table.rows.length, 19);
  assert.deepEqual(o.table.rows.map((r) => r[0]).slice(0, 3), ['P5', 'P10', 'P15']);
  // The widest input drives the spread.
  assert.ok(o.sentences.some((s) => s.includes('"Labour" drives the spread')), o.sentences.join(' | '));
});

test('Monte Carlo: PERT mean is (a + 4m + b) / 6', () => {
  const o = mc([{ name: 'Cost', low: 10, likely: 20, high: 60 }], { trials: 200000, distribution: 'pert' });
  const truth = (10 + 4 * 20 + 60) / 6;
  near(stat(o, 'Mean'), truth, truth * 0.005, 'PERT mean');
});

test('Monte Carlo: the sum of 12 uniforms has Irwin–Hall percentiles (≈ Normal(6, 1))', () => {
  const inputs = Array.from({ length: 12 }, (_, i) => ({ name: `U${i}`, low: 0, likely: 0.5, high: 1, distribution: 'uniform' as const }));
  const o = mc(inputs, { trials: 100000 });
  near(stat(o, 'P50'), 6, 0.02, 'P50');
  // Variance 12 × 1/12 = 1, so P10/P90 ≈ 6 ∓ 1.2816 (Irwin–Hall at n = 12 is within 0.01 of normal).
  near(stat(o, 'P10'), 6 - 1.2816, 0.03, 'P10');
  near(stat(o, 'P90'), 6 + 1.2816, 0.03, 'P90');
});

test('Monte Carlo: product combine multiplies the inputs', () => {
  const fixed = mc(
    [
      { name: 'Rate', low: 3, likely: 3, high: 3 },
      { name: 'Volume', low: 4, likely: 4, high: 4 },
    ],
    { combine: 'product', trials: 500 },
  );
  assert.equal(stat(fixed, 'P50'), 12);
  const o = mc(
    [
      { name: 'Rate', low: 1, likely: 2, high: 3, distribution: 'uniform' },
      { name: 'Volume', low: 2, likely: 3, high: 4, distribution: 'uniform' },
    ],
    { combine: 'product', trials: 200000 },
  );
  near(stat(o, 'Mean'), 6, 6 * 0.005, 'E[XY] = E[X]E[Y]');
});

test('Monte Carlo: the target gives P(≤ target) and a marker', () => {
  const o = mc([{ name: 'X', low: 0, likely: 5, high: 10, distribution: 'uniform' }], { trials: 100000, target: 3 });
  near(stat(o, 'Chance ≤ 3'), 0.3, 0.01, 'P(X ≤ 3)');
  assert.match(o.headline, /30% chance/);
  assert.ok(o.chart?.kind === 'histogram' && o.chart.markers.some((m) => m.label === 'Target' && m.value === 3));
});

test('Monte Carlo: deterministic for a seed, different for another', () => {
  const inputs: ModelInput[] = [{ name: 'A', low: 1, likely: 2, high: 5 }, { name: 'B', low: 3, likely: 4, high: 9 }];
  assert.deepEqual(mc(inputs), mc(inputs));
  assert.notEqual(stat(mc(inputs, { seed: 1 }), 'P50'), stat(mc(inputs, { seed: 2 }), 'P50'));
});

test('Monte Carlo: rows become inputs with low/high a percentage either side, negatives kept in order', () => {
  const data = labelled([[100], [-50], [null]]);
  const o = runMontecarlo(data, { type: 'montecarlo', params: { lowPct: 10, highPct: 20, distribution: 'uniform', trials: 100000 } }, ctx);
  // Uniform means: (90 + 120) / 2 + (-60 + -45) / 2 = 105 − 52.5.
  near(stat(o, 'Mean'), 52.5, 0.5, 'mean');
  assert.ok(o.notes.some((n) => /1 row was left out/.test(n)));
  const s = runSensitivity(data, { type: 'sensitivity', params: { lowPct: 10, highPct: 20 } }, ctx);
  const neg = s.table.rows.find((r) => r[0] === 'Item 002')!;
  assert.deepEqual(neg.slice(1, 4), [-60, -50, -45]);
});

test('Monte Carlo: low > likely is a ModelError naming the input', () => {
  assert.throws(() => mc([{ name: 'Fuel', low: 10, likely: 5, high: 20 }]), (e: unknown) => e instanceof ModelError && /Fuel/.test(e.message));
  assert.throws(() => runMontecarlo(empty, { type: 'montecarlo' }, ctx), ModelError);
});

test('Spearman rank correlation: ties take average ranks', () => {
  assert.deepEqual(Array.from(ranks([10, 20, 20, 5])), [2, 3.5, 3.5, 1]);
  near(spearman([1, 2, 3, 4], [1, 8, 27, 64]), 1, 1e-12);
  near(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1, 1e-12);
});

// ---- Backlog -------------------------------------------------------------------------------------

test('Backlog: constant throughput of 10 clears 95 items in exactly 10 periods', () => {
  const o = runBacklog(monthly(Array(12).fill(10)), { type: 'backlog', params: { backlog: 95, trials: 1000 } }, ctx);
  // History Jan–Dec 2025, so period 10 ahead is Oct 2026.
  assert.equal(o.headline, 'There is an 85% chance the backlog of 95 clears by Oct 2026 (in 10 months).');
  assert.equal(stat(o, '50% chance by') as unknown, 'Oct 2026');
  assert.equal(stat(o, '95% chance by') as unknown, 'Oct 2026');
  assert.equal(stat(o, 'Done by Aug 2026 (85%)'), 80);
  assert.ok(o.chart?.kind === 'histogram' && o.chart.bins.length === 1 && o.chart.bins[0]!.count === 1000);
  assert.deepEqual(o.table.rows.at(-1), [10, 'Oct 2026', 1]);
});

test('Backlog: resampling a two-value history matches the exact negative-binomial answer', () => {
  // Throughput 0 or 10 with equal odds; 30 items need 3 tens. P(done by k) = P(Bin(k, ½) ≥ 3).
  // P(by 7) = 1 − (1 + 7 + 21) / 128 = 0.7734; P(by 8) = 1 − 37/256 = 0.8555, so the 85% date is 8 ahead.
  const o = runBacklog(monthly([0, 10, 0, 10, 0, 10, 0, 10]), { type: 'backlog', params: { backlog: 30, trials: 50000 } }, ctx);
  assert.match(o.headline, /in 8 months/);
  near(o.table.rows.find((r) => r[0] === 7)![2] as number, 0.7734, 0.01, 'P(by 7)');
});

test('Backlog: nothing ever finished is a ModelError', () => {
  assert.throws(() => runBacklog(monthly([0, 0, 0, 0, 0]), { type: 'backlog' }, ctx), ModelError);
});

// ---- Sensitivity ---------------------------------------------------------------------------------

test('Sensitivity: on a sum each swing is high − low, sorted biggest first', () => {
  const inputs: ModelInput[] = [
    { name: 'Small', low: 9, likely: 10, high: 12 },
    { name: 'Big', low: 50, likely: 100, high: 180 },
    { name: 'Mid', low: 20, likely: 30, high: 45 },
  ];
  const o = runSensitivity(empty, { type: 'sensitivity', inputs }, ctx);
  assert.equal(stat(o, 'Base case'), 140);
  assert.ok(o.chart?.kind === 'bars');
  assert.deepEqual(o.chart.labels, ['Big', 'Mid', 'Small']);
  assert.deepEqual(o.chart.values, [130, 25, 3]);
  assert.deepEqual(o.chart.low, [90, 130, 139]);
  assert.deepEqual(o.chart.high, [220, 155, 142]);
  assert.equal(o.chart.base, 140);
  assert.match(o.headline, /"Big" moves the total most/);
});

test('Sensitivity: product with a zero likely value', () => {
  const o = runSensitivity(
    empty,
    {
      type: 'sensitivity',
      params: { combine: 'product' },
      inputs: [
        { name: 'Rate', low: 0, likely: 0, high: 2 },
        { name: 'Volume', low: 5, likely: 10, high: 20 },
      ],
    },
    ctx,
  );
  assert.equal(stat(o, 'Base case'), 0);
  assert.ok(o.chart?.kind === 'bars');
  assert.deepEqual(o.chart.labels, ['Rate', 'Volume']);
  assert.deepEqual(o.chart.high, [20, 0]);
});

// ---- Bootstrap -----------------------------------------------------------------------------------

function normalSample(n: number, mu: number, sigma: number, seed: number): number[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, () => r.normal(mu, sigma));
}

test('Bootstrap: interval for a mean of normal data has width ≈ 2·z·sd/√n and holds the truth', () => {
  const xs = normalSample(400, 10, 2, 11);
  const o = runBootstrap(labelled(xs.map((v) => [v])), { type: 'bootstrap', params: { stat: 'mean', resamples: 5000, level: '0.9' } }, ctx);
  const s = Math.sqrt(xs.reduce((a, x) => a + (x - xs.reduce((p, q) => p + q, 0) / xs.length) ** 2, 0) / (xs.length - 1));
  const expected = (2 * normalInv(0.95) * s) / Math.sqrt(xs.length);
  for (const name of ['BCa 90%', 'Percentile 90%']) {
    const row = o.table.rows.find((r) => r[0] === name)!;
    const lo = row[1] as number;
    const hi = row[2] as number;
    near(hi - lo, expected, expected * 0.1, `${name} width`);
    assert.ok(lo < 10 && 10 < hi, `${name} holds the true mean`);
  }
  assert.match(o.headline, /^The average is .*; with 90% confidence it lies between .* and .*\.$/);
});

test('Bootstrap: BCa on skewed data shifts the interval right of the percentile one', () => {
  const r = new Rng(5);
  const xs = Array.from({ length: 60 }, () => Math.exp(r.normal(0, 1)));
  const o = runBootstrap(labelled(xs.map((v) => [v])), { type: 'bootstrap', params: { stat: 'mean' } }, ctx);
  const bca = o.table.rows.find((x) => x[0] === 'BCa 90%')!;
  const per = o.table.rows.find((x) => x[0] === 'Percentile 90%')!;
  assert.ok((bca[2] as number) > (per[2] as number), 'BCa upper end is higher for right-skewed data');
});

test('Bootstrap: median, total and sd run; deterministic; too few rows is a ModelError', () => {
  const data = labelled(normalSample(50, 5, 1, 3).map((v) => [v]));
  for (const s of ['median', 'total', 'sd']) {
    const spec: ModelSpec = { type: 'bootstrap', params: { stat: s, resamples: 1000 } };
    const o = runBootstrap(data, spec, ctx);
    assert.deepEqual(o, runBootstrap(data, spec, ctx));
    const lo = stat(o, '90% low');
    const hi = stat(o, '90% high');
    const est = o.stats[0]!.value as number;
    assert.ok(lo <= est && est <= hi, `${s}: ${lo} ≤ ${est} ≤ ${hi}`);
  }
  assert.throws(() => runBootstrap(labelled([[1], [2]]), { type: 'bootstrap' }, ctx), ModelError);
});

// ---- Bayesian rates ------------------------------------------------------------------------------

test('Bayes: Beta(1,1) prior and 3 of 10 gives the Beta(4, 8) posterior, mean 4/12', () => {
  const o = runBayes(labelled([[3, 10]], ['Defects', 'Inspected']), { type: 'bayes', params: { level: '0.9' } }, ctx);
  const row = o.table.rows[0]!;
  near(row[4] as number, 4 / 12, 1e-12, 'posterior mean');
  near(betaI(row[5] as number, 4, 8), 0.05, 1e-9, 'lower 5%');
  near(betaI(row[6] as number, 4, 8), 0.95, 1e-9, 'upper 95%');
  assert.ok(o.notes.some((n) => /fewer than three groups/.test(n)));
});

test('Bayes: a stated prior strength centres on the overall rate', () => {
  // Strength 10 with overall 3/10: Beta(3, 7) prior, posterior Beta(6, 14), mean 0.3.
  const o = runBayes(labelled([[3, 10]], ['E', 'N']), { type: 'bayes', params: { prior: 10 } }, ctx);
  near(o.table.rows[0]![4] as number, 0.3, 1e-12);
  near(betaI(o.table.rows[0]![5] as number, 6, 14), 0.05, 1e-9);
});

test('Bayes: empirical Bayes shrinks a tiny group with an extreme rate below a large one', () => {
  // True rates vary from 10% to 30%; "Tiny" has 2 of 3.
  const rows: Array<[string, number, number]> = [
    ['A', 20, 200], ['B', 40, 200], ['C', 60, 200], ['D', 30, 200], ['E', 50, 200], ['F', 25, 200], ['Big', 80, 300], ['Tiny', 2, 3],
  ];
  const data: ModelData = {
    dims: [{ key: 'g', label: 'Group', isDate: false }],
    metrics: [{ key: 'e', label: 'Events' }, { key: 'n', label: 'Trials' }],
    rows: rows.map(([g, e, n]) => ({ dims: [g], values: [e, n] })),
  };
  const o = runBayes(data, { type: 'bayes' }, ctx);
  assert.equal(o.stats[0]!.value, 'C', o.headline);
  const tiny = o.table.rows.find((r) => r[0] === 'Tiny')!;
  assert.ok((tiny[4] as number) < 0.4 && (tiny[4] as number) > 0.2, `Tiny shrunk to ${tiny[4]}`);
  assert.ok(o.sentences.some((s) => s.includes('Tiny has the highest raw rate')));
  assert.match(o.headline, /C has the highest rate/);
  assert.deepEqual(o, runBayes(data, { type: 'bayes' }, ctx));
});

test('Bayes: Poisson rates use a Gamma posterior', () => {
  // Strength 2 units of exposure at overall 12/40 = 0.3: Gamma(0.6, 2) + (4 events, 10 units) → Gamma(4.6, 12).
  const data = labelled([[4, 10], [8, 30]], ['Failures', 'Hours']);
  const o = runBayes(data, { type: 'bayes', params: { likelihood: 'poisson', prior: 2 } }, ctx);
  const row = o.table.rows.find((r) => r[0] === 'Item 001')!;
  near(row[4] as number, 4.6 / 12, 1e-12);
  near(gammaP(4.6, (row[5] as number) * 12), 0.05, 1e-9);
  near(gammaP(4.6, gammaQuantile(0.95, 4.6, 12) * 12), 0.95, 1e-9);
  near(betaI(betaQuantile(0.2, 2, 3), 2, 3), 0.2, 1e-12);
  assert.throws(() => runBayes(labelled([[5, 3]], ['E', 'N']), { type: 'bayes' }, ctx), (e: unknown) => e instanceof ModelError && /cannot exceed/.test(e.message));
});

// ---- Control charts ------------------------------------------------------------------------------

test('SPC: an injected shift is flagged after it starts and not before', () => {
  const r = new Rng(21);
  const xs = Array.from({ length: 40 }, (_, i) => 50 + r.normal(0, 1) + (i >= 30 ? 5 : 0));
  const o = runSpc(labelled(xs.map((v) => [v])), { type: 'spc', params: { baseline: 30, rules: false } }, ctx);
  assert.ok(o.chart?.kind === 'series');
  const marks = o.chart.marks ?? [];
  assert.ok(marks.length >= 5, `${marks.length} marks`);
  assert.ok(marks.every((m) => m.index >= 30 && m.tone === 'bad'));
  assert.match(o.headline, /signal a real change/);
  assert.deepEqual(o.chart.series.map((s) => s.role), ['actual', 'line', 'limit', 'limit']);
});

test('SPC: centre and sigma are the mean and average moving range / 1.128', () => {
  const xs = [10, 12, 11, 13, 12, 10, 11, 12];
  const o = runSpc(labelled(xs.map((v) => [v])), { type: 'spc' }, ctx);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const mr = [2, 1, 2, 1, 2, 1, 1].reduce((a, b) => a + b, 0) / 7;
  near(stat(o, 'Centre'), mean, 1e-12);
  near(stat(o, 'Sigma'), mr / 1.128, 1e-12);
  near(stat(o, 'Upper limit'), mean + (3 * mr) / 1.128, 1e-12);
  assert.match(o.headline, /in control/);
});

test('SPC: Western Electric rule 4 (8 in a row on one side) on a crafted series', () => {
  // 20 points alternating 1, 0 (centre 0.5, sigma 1/1.128), ending on 0; then 8 points at 0.9,
  // inside 1σ of the centre. Only the eighth completes the run.
  const xs = [...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : 0)), ...Array(8).fill(0.9)];
  const o = runSpc(labelled(xs.map((v) => [v])), { type: 'spc', params: { baseline: 20 } }, ctx);
  assert.ok(o.chart?.kind === 'series');
  assert.deepEqual(o.chart.marks, [{ index: 27, tone: 'warn', label: '8 in a row on one side' }]);
  assert.match(o.headline, /8 points in a row sat above the centre/);
  const off = runSpc(labelled(xs.map((v) => [v])), { type: 'spc', params: { baseline: 20, rules: false } }, ctx);
  assert.match(off.headline, /in control/);
});

test('Western Electric rules 1–3 on standardised values', () => {
  assert.deepEqual(westernElectric([0, 0, 3.5, 0], 3, true), [{ index: 2, rule: 1, side: 'above' }]);
  assert.deepEqual(westernElectric([0, -2.5, 0.5, -2.2], 3, true), [{ index: 3, rule: 2, side: 'below' }]);
  assert.deepEqual(westernElectric([0, 1.5, 1.2, 0.2, 1.1, 1.3], 3, true), [{ index: 5, rule: 3, side: 'above' }]);
  // Rule 2 needs both points on the same side.
  assert.deepEqual(westernElectric([2.5, -2.5, 0], 3, true), []);
});

test('SPC: EWMA and CUSUM catch a small sustained shift', () => {
  const r = new Rng(4);
  const xs = Array.from({ length: 80 }, (_, i) => 100 + r.normal(0, 2) + (i >= 40 ? 2 : 0));
  for (const chart of ['ewma', 'cusum']) {
    const o = runSpc(labelled(xs.map((v) => [v])), { type: 'spc', params: { chart, baseline: 40 } }, ctx);
    assert.ok(o.chart?.kind === 'series');
    const marks = o.chart.marks ?? [];
    assert.ok(marks.length > 0, `${chart} found the shift`);
    assert.ok(marks.every((m) => m.index >= 40), `${chart} no false alarm before the shift: ${marks.map((m) => m.index)}`);
  }
});

test('SPC: EWMA limits widen to the asymptotic Lσ√(λ/(2−λ))', () => {
  const xs = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : 0));
  const o = runSpc(labelled(xs.map((v) => [v])), { type: 'spc', params: { chart: 'ewma', lambda: 0.2 } }, ctx);
  assert.ok(o.chart?.kind === 'series');
  const upper = o.chart.series.find((s) => s.name === 'Upper limit')!.values;
  const sigma = 1 / 1.128;
  near(upper[0]! - 0.5, 3 * sigma * 0.2, 1e-12, 'first limit L·σ·λ');
  near(upper.at(-1)! - 0.5, 3 * sigma * Math.sqrt(0.2 / 1.8), 1e-6, 'asymptote');
});

test('SPC: constant values or too few points are ModelErrors', () => {
  assert.throws(() => runSpc(labelled(Array(10).fill([5])), { type: 'spc' }, ctx), ModelError);
  assert.throws(() => runSpc(labelled([[1], [2], [3]]), { type: 'spc' }, ctx), ModelError);
});

test('SPC: a date field is read in date order', () => {
  const data = monthly([5, 6, 5, 6, 5, 6, 5, 6, 20, 5]);
  data.rows.reverse();
  const o = runSpc(data, { type: 'spc', params: { baseline: 8 } }, ctx);
  assert.ok(o.chart?.kind === 'series');
  assert.equal(o.chart.x[0], 'Jan 2025');
  assert.ok((o.chart.marks ?? []).some((m) => m.index === 8 && m.tone === 'bad'));
  assert.match(o.headline, /Sep 2025/);
});

// ---- Anomaly detection ---------------------------------------------------------------------------

test('Anomaly: every method flags an injected outlier and only it', () => {
  const xs = normalSample(60, 50, 5, 9);
  xs[17] = 120;
  const data = labelled(xs.map((v) => [v]));
  for (const params of [{ method: 'mad' }, { method: 'zscore' }, { method: 'iqr', threshold: 3 }] as Array<Record<string, ParamValue>>) {
    const o = runAnomaly(data, { type: 'anomaly', params }, ctx);
    assert.equal(o.table.rows.length, 1, `${params.method}: ${o.table.rows.map((r) => r[0])}`);
    assert.equal(o.table.rows[0]![0], 'Item 018');
    assert.equal(o.table.rows[0]![3], 'High');
    assert.match(o.headline, /^1 of 60 values is unusual; the most extreme is Item 018 at 120/);
    assert.ok(o.chart?.kind === 'scatter' && o.chart.points[17]!.tone === 'bad');
  }
});

test('Anomaly: robust z is (x − median) / scaled MAD; a low value is a warn mark on a series', () => {
  const xs = [10, 11, 9, 10, 12, 10, 1, 11, 10, 9];
  const data: ModelData = { ...monthly(xs), metrics: [{ key: 'v', label: 'Value' }] };
  const o = runAnomaly(data, { type: 'anomaly' }, ctx);
  // median 10, |dev| sorted 0,0,0,0,1,1,1,1,2,9 → MAD 1 × 1.4826.
  const row = o.table.rows[0]!;
  assert.equal(row[0], 'Jul 2025');
  near(row[2] as number, -9 / 1.4826, 1e-12, 'robust z');
  assert.ok(o.chart?.kind === 'series');
  assert.deepEqual(o.chart.marks, [{ index: 6, tone: 'warn', label: 'Jul 2025' }]);
});

test('Anomaly: IQR defaults to 1.5 box widths; nothing unusual says so; constant data is a ModelError', () => {
  const o = runAnomaly(labelled([[1], [2], [3], [4], [5], [6], [7], [8], [30]]), { type: 'anomaly', params: { method: 'iqr' } }, ctx);
  // Q1 = 3, Q3 = 7, IQR 4: fences −3 and 13.
  assert.equal(stat(o, 'High fence'), 13);
  assert.equal(o.table.rows.length, 1);
  const calm = runAnomaly(labelled([[1], [2], [3], [4], [5], [6]]), { type: 'anomaly' }, ctx);
  assert.match(calm.headline, /^No values are unusual/);
  assert.throws(() => runAnomaly(labelled(Array(8).fill([3])), { type: 'anomaly', params: { method: 'zscore' } }, ctx), ModelError);
});

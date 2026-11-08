// Drivers, reliability and inventory models: regression, logistic, survival (Kaplan-Meier), Weibull,
// spare-parts demand and Markov transitions. Checked against hand-worked answers on tiny inputs,
// closed forms, and seeded synthetic data with known true parameters.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { croston, poissonQuantile, runDemand, tsb, classify, eoq } from '../src/core/predict/models/demand.ts';
import { auc, runLogistic } from '../src/core/predict/models/logistic.ts';
import { runMarkov, stationary } from '../src/core/predict/models/markov.ts';
import { runRegression } from '../src/core/predict/models/regression.ts';
import { kaplanMeier, kmMedian, logRank, runSurvival } from '../src/core/predict/models/survival.ts';
import { bLife, fitWeibull, mtbf, runWeibull } from '../src/core/predict/models/weibull.ts';
import { Rng } from '../src/core/predict/rng.ts';
import { gammaFn } from '../src/core/predict/stats.ts';
import { type ModelData, ModelError, type ModelOutput, type ModelSpec } from '../src/core/predict/types.ts';

const ctx = { seed: 7, today: '2026-11-08' };
const close = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} is not within ${tol} of ${b}`);
const stat = (o: ModelOutput, label: string) => {
  const s = o.stats.find((x) => x.label === label);
  assert.ok(s, `no stat ${label}: ${o.stats.map((x) => x.label).join(', ')}`);
  return s.value as number;
};
const row = (o: ModelOutput, first: string) => {
  const r = o.table.rows.find((x) => x[0] === first);
  assert.ok(r, `no table row ${first}`);
  return r;
};

/** Items: one label field and named measures. */
function itemData(metrics: string[], rows: number[][], dims = ['Item']): ModelData {
  return {
    dims: dims.map((d) => ({ key: d, label: d, isDate: false })),
    metrics: metrics.map((m) => ({ key: m, label: m })),
    rows: rows.map((v, i) => ({ dims: dims.map(() => `r${i}`), values: v })),
  };
}

// ---- regression -----------------------------------------------------------------------------------

test('regression recovers exact coefficients on noiseless data', () => {
  const rows: number[][] = [];
  for (let i = 0; i < 20; i++) {
    const a = i % 7;
    const b = (i * 3) % 5;
    rows.push([3 + 2 * a - 1.5 * b, a, b]);
  }
  const o = runRegression(itemData(['Cost', 'Hours', 'Parts'], rows), { type: 'regression' }, ctx);
  close(row(o, '(Intercept)')[1] as number, 3, 1e-9);
  close(row(o, 'Hours')[1] as number, 2, 1e-9);
  close(row(o, 'Parts')[1] as number, -1.5, 1e-9);
  close(stat(o, 'R²'), 1, 1e-12);
  assert.match(o.headline, /Each extra unit of (Hours|Parts)/);
  assert.equal(o.chart?.kind, 'bars');
});

test('regression matches the hand-worked simple regression (x 1..5, y 2 4 5 4 5)', () => {
  // b1 = Sxy/Sxx = 6/10 = 0.6, b0 = 4 − 0.6·3 = 2.2, RSS = 2.4, s² = 0.8,
  // se(b1) = √(0.8/10), se(b0) = √(0.8·(1/5 + 9/10)), R² = 1 − 2.4/6 = 0.6, F = 4.5 = t².
  const o = runRegression(itemData(['y', 'x'], [[2, 1], [4, 2], [5, 3], [4, 4], [5, 5]]), { type: 'regression', params: { level: '0.95' } }, ctx);
  const b = row(o, 'x');
  const a = row(o, '(Intercept)');
  close(b[1] as number, 0.6, 1e-12);
  close(a[1] as number, 2.2, 1e-12);
  close(b[2] as number, Math.sqrt(0.08), 1e-12);
  close(a[2] as number, Math.sqrt(0.88), 1e-12);
  close(stat(o, 'R²'), 0.6, 1e-12);
  close(stat(o, 'Typical error'), Math.sqrt(0.8), 1e-12);
  // t = 0.6/√0.08 = 2.1213 on 3 df: the F test p equals the slope's p, and t(0.975, 3) = 3.182446.
  close(stat(o, 'F test p'), b[5] as number, 1e-10);
  close(b[3] as number, 0.6 - 3.182446305 * Math.sqrt(0.08), 1e-6);
  assert.equal(o.chart?.kind, 'scatter');
});

test('regression fits a quadratic with one driver, and flags collinearity', () => {
  const rows = Array.from({ length: 15 }, (_, i) => [1 + 0.5 * i + 0.25 * i * i, i]);
  const o = runRegression(itemData(['y', 'x'], rows), { type: 'regression', params: { degree: 2 } }, ctx);
  close(row(o, 'x²')[1] as number, 0.25, 1e-9);
  close(row(o, 'x')[1] as number, 0.5, 1e-9);
  const rng = new Rng(3);
  const near = Array.from({ length: 40 }, () => {
    const a = rng.normal();
    const b = a + 0.05 * rng.normal();
    return [a + b + rng.normal(), a, b];
  });
  const c = runRegression(itemData(['y', 'a', 'b'], near), { type: 'regression' }, ctx);
  assert.ok(c.notes.some((n) => /VIF above 5/.test(n)));
});

test('regression refuses too few rows and dependent drivers', () => {
  assert.throws(() => runRegression(itemData(['y', 'a', 'b'], [[1, 1, 2], [2, 2, 1], [3, 3, 3]]), { type: 'regression' }, ctx), ModelError);
  const dup = Array.from({ length: 10 }, (_, i) => [i * 2 + (i % 3), i, 2 * i]);
  assert.throws(() => runRegression(itemData(['y', 'a', 'twice a'], dup), { type: 'regression' }, ctx), (e: Error) => e instanceof ModelError && /not independent/.test(e.message));
});

// ---- logistic -------------------------------------------------------------------------------------

test('logistic recovers coefficients from 2,000 seeded rows', () => {
  const rng = new Rng(11);
  const rows = Array.from({ length: 2000 }, () => {
    const a = rng.normal();
    const b = rng.normal(5, 2);
    const eta = -0.5 + 1.2 * a - 0.4 * (b - 5);
    return [rng.next() < 1 / (1 + Math.exp(-eta)) ? 1 : 0, a, b];
  });
  const o = runLogistic(itemData(['Late', 'Load', 'Age'], rows), { type: 'logistic' }, ctx);
  close(row(o, 'Load')[1] as number, 1.2, 0.15, 'Load');
  close(row(o, 'Age')[1] as number, -0.4, 0.08, 'Age');
  close(row(o, '(Intercept)')[1] as number, -0.5 + 0.4 * 5, 0.4, 'intercept');
  assert.match(o.headline, /Each \+1 in (Load|Age) multiplies the odds/);
  assert.ok(stat(o, 'AUC') > 0.7);
  assert.deepEqual(runLogistic(itemData(['Late', 'Load', 'Age'], rows), { type: 'logistic' }, ctx), o);
});

test('logistic with a threshold, separation and errors', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [i < 15 ? 10 : 90, i]);
  const o = runLogistic(itemData(['Score', 'x'], rows), { type: 'logistic', params: { threshold: 50 } }, ctx);
  assert.ok(o.notes.some((n) => /separates yes from no/.test(n)));
  assert.ok(Number.isFinite(row(o, 'x')[1] as number));
  assert.equal(o.chart?.kind, 'curves');
  assert.throws(() => runLogistic(itemData(['Score', 'x'], rows), { type: 'logistic' }, ctx), ModelError); // not 0–1
  assert.throws(() => runLogistic(itemData(['y', 'x'], rows.map((r) => [1, r[1]!])), { type: 'logistic' }, ctx), ModelError);
});

test('AUC by Mann–Whitney on a hand example', () => {
  // Positives 0.9, 0.4; negatives 0.5, 0.1: pairs won (0.9>0.5, 0.9>0.1, 0.4>0.1) = 3 of 4.
  close(auc([0.9, 0.4, 0.5, 0.1], [1, 1, 0, 0]), 0.75, 1e-12);
});

// ---- survival -------------------------------------------------------------------------------------

const KM_T = [6, 6, 6, 7, 10, 13, 16, 22, 23];
const KM_E = [1, 1, 0, 1, 0, 1, 1, 0, 1];

test('Kaplan-Meier and Greenwood on a small hand example', () => {
  const s = kaplanMeier(KM_T, KM_E, 0.95);
  const at = (t: number) => s.find((x) => x.time === t)!;
  // t=6: 9 at risk, 2 ended → 7/9. t=7: 6 at risk → ·5/6. t=13: 4 at risk → ·3/4. t=16: 3 → ·2/3. t=23: 1 → 0.
  close(at(6).survival, 7 / 9, 1e-12);
  close(at(7).survival, 35 / 54, 1e-12);
  close(at(13).survival, 105 / 216, 1e-12);
  close(at(16).survival, 70 / 216, 1e-12);
  assert.equal(at(23).survival, 0);
  assert.equal(at(7).atRisk, 6);
  // Greenwood at 7: S² · (2/(9·7) + 1/(6·5)).
  close(at(7).variance, (35 / 54) ** 2 * (2 / 63 + 1 / 30), 1e-12);
  // log(−log) band at 7.
  const theta = (1.959963985 * Math.sqrt(2 / 63 + 1 / 30)) / Math.abs(Math.log(35 / 54));
  close(at(7).lower, (35 / 54) ** Math.exp(theta), 1e-8);
  close(at(7).upper, (35 / 54) ** Math.exp(-theta), 1e-8);
  const md = kmMedian(s);
  assert.equal(md.median, 13);
  assert.ok(md.low !== null && md.low <= 13 && (md.high === null || md.high >= 13), 'median interval brackets the median');
  const o = runSurvival({ dims: [{ key: 'job', label: 'Job', isDate: false }], metrics: [{ key: 'd', label: 'Days' }, { key: 'e', label: 'Closed' }], rows: KM_T.map((t, i) => ({ dims: [`j${i}`], values: [t, KM_E[i]!] })) }, { type: 'survival' }, ctx);
  assert.equal(stat(o, 'Median'), 13);
  assert.match(o.headline, /Half of the items end within 13/);
  assert.equal(o.chart?.kind, 'curves');
});

function groupData(rng: Rng, means: number[], each: number, censorAt = Infinity): ModelData {
  const rows: ModelData['rows'] = [];
  means.forEach((m, g) => {
    for (let i = 0; i < each; i++) {
      const t = -m * Math.log(rng.open());
      rows.push({ dims: [`i${g}-${i}`, `G${g + 1}`], values: [Math.min(t, censorAt), t < censorAt ? 1 : 0] });
    }
  });
  return { dims: [{ key: 'i', label: 'Item', isDate: false }, { key: 'g', label: 'Group', isDate: false }], metrics: [{ key: 't', label: 'Days' }, { key: 'e', label: 'Ended' }], rows };
}

test('log-rank separates different groups and not alike ones', () => {
  const diff = runSurvival(groupData(new Rng(5), [10, 30], 60, 80), { type: 'survival' }, ctx);
  assert.ok(stat(diff, 'Log-rank p') < 0.01, `p ${stat(diff, 'Log-rank p')}`);
  assert.equal((diff.chart as { curves: unknown[] }).curves.length, 2);
  const same = runSurvival(groupData(new Rng(6), [20, 20], 60, 80), { type: 'survival' }, ctx);
  assert.ok(stat(same, 'Log-rank p') > 0.05, `p ${stat(same, 'Log-rank p')}`);
  // Hand check: two groups, one ending each at t=1 (A) and t=2 (B), one each at risk: O−E = 0.5, V = 0.25 → χ² = 1.
  const lr = logRank([1, 2], [1, 1], [0, 1], 2);
  close(lr.chi2, 1, 1e-12);
  assert.throws(() => runSurvival(itemData(['Days', 'Ended'], [[1, 0], [2, 0], [3, 0]]), { type: 'survival' }, ctx), ModelError);
});

// ---- Weibull --------------------------------------------------------------------------------------

function weibullSample(seed: number, n: number, shape: number, scale: number, censorMax = 0): { t: number[]; e: number[] } {
  const rng = new Rng(seed);
  const t: number[] = [];
  const e: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = scale * (-Math.log(rng.open())) ** (1 / shape);
    const c = censorMax > 0 ? rng.uniform(0, censorMax) : Infinity;
    t.push(Math.min(x, c));
    e.push(x <= c ? 1 : 0);
  }
  return { t, e };
}

test('Weibull recovers shape 2 and scale 100, with and without censoring', () => {
  const full = weibullSample(21, 2000, 2, 100);
  const f = fitWeibull(full.t, full.e);
  close(f.shape, 2, 0.1, 'shape');
  close(f.scale, 100, 5, 'scale');
  const cens = weibullSample(22, 2000, 2, 100, 200);
  assert.ok(cens.e.filter((x) => x === 0).length > 300);
  const c = fitWeibull(cens.t, cens.e);
  close(c.shape, 2, 0.1, 'censored shape');
  close(c.scale, 100, 5, 'censored scale');
  const data: ModelData = { dims: [{ key: 'u', label: 'Unit', isDate: false }], metrics: [{ key: 'h', label: 'Hours' }, { key: 'f', label: 'Failed' }], rows: cens.t.map((t, i) => ({ dims: [`u${i}`], values: [t, cens.e[i]!] })) };
  const o = runWeibull(data, { type: 'weibull', params: { mission: 50 } }, ctx);
  close(stat(o, 'MTBF'), stat(o, 'Scale') * gammaFn(1 + 1 / stat(o, 'Shape')), 1e-9);
  close(stat(o, 'Reliability at mission'), Math.exp(-((50 / stat(o, 'Scale')) ** stat(o, 'Shape'))), 1e-12);
  assert.match(o.sentences[0]!, /wear-out/);
  const lo = row(o, 'Shape')[2] as number;
  const hi = row(o, 'Shape')[3] as number;
  assert.ok(lo < c.shape && c.shape < hi && hi - lo < 0.4);
});

test('Weibull closed forms and errors', () => {
  close(mtbf(2, 100), 100 * Math.sqrt(Math.PI) / 2, 1e-9); // Γ(1.5) = √π/2
  close(mtbf(1, 50), 50, 1e-9);
  close(bLife(1, 100), -100 * Math.log(0.9), 1e-12);
  const early = weibullSample(31, 1500, 0.6, 40);
  const o = runWeibull({ dims: [{ key: 'u', label: 'Unit', isDate: false }], metrics: [{ key: 'h', label: 'Hours' }], rows: early.t.map((t, i) => ({ dims: [`u${i}`], values: [t] })) }, { type: 'weibull' }, ctx);
  assert.match(o.sentences[0]!, /infant mortality/);
  assert.throws(() => runWeibull(itemData(['Hours', 'Failed'], [[5, 1], [6, 1], [7, 0], [8, 0]]), { type: 'weibull' }, ctx), ModelError);
});

// ---- demand ---------------------------------------------------------------------------------------

function monthly(values: Array<number | null>): ModelData {
  return {
    dims: [{ key: 'm', label: 'Month', grain: 'month', isDate: true }],
    metrics: [{ key: 'q', label: 'Used' }],
    rows: values.map((v, i) => ({ dims: [`${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`], values: [v] })),
  };
}

const INTERMITTENT = [0, 0, 3, 0, 0, 0, 6, 0, 3, 0];

test('Croston, SBA and TSB by hand on a short series', () => {
  // α = 0.5. First demand 3 at period 3 → z = 3, p = 3. Demand 6 after 4 → z 4.5, p 3.5.
  // Demand 3 after 2 → z 3.75, p 2.75. Rate 3.75/2.75; SBA × 0.75.
  close(croston(INTERMITTENT, 0.5).rate, 3.75 / 2.75, 1e-12);
  close(croston(INTERMITTENT, 0.5, true).rate, 0.75 * 3.75 / 2.75, 1e-12);
  // TSB: π starts 0.3 and halves toward the 0/1 indicator each period; z 3 → 4.5 → 3.75.
  let pi = 0.3;
  for (const d of INTERMITTENT) pi += 0.5 * ((d > 0 ? 1 : 0) - pi);
  close(tsb(INTERMITTENT, 0.5).rate, pi * 3.75, 1e-12);
  close(pi, 0.31669921875, 1e-12);
  const o = runDemand(monthly(INTERMITTENT), { type: 'demand', params: { method: 'croston', alpha: 0.5 } }, ctx);
  close(stat(o, 'Rate per period'), 3.75 / 2.75, 1e-12);
  assert.equal(classify(INTERMITTENT).pattern, 'intermittent');
  assert.match(o.headline, /^Reorder at \d+ units?; keep a safety stock of .* for 95% service\.$/);
});

test('Poisson reorder point is exact, and EOQ is the closed form', () => {
  // Poisson(4): P(X ≤ 7) = 0.94887 < 0.95 ≤ P(X ≤ 8) = 0.97864.
  assert.equal(poissonQuantile(4, 0.95), 8);
  assert.equal(poissonQuantile(4, 0.94), 7);
  const series = [2, 1, 3, 2, 2, 1, 3, 2, 2, 2, 1, 3]; // mean 2
  const o = runDemand(monthly(series), { type: 'demand', params: { method: 'poisson', leadTime: 2, service: 0.95, orderCost: 50, holdingCost: 2 } }, ctx);
  assert.equal(stat(o, 'Reorder point'), 8);
  close(stat(o, 'Safety stock'), 4, 1e-12);
  close(stat(o, 'EOQ'), 10, 1e-12); // √(2·2·50/2)
  close(eoq(100, 20, 4), Math.sqrt(1000), 1e-12);
  // Forecast series convention: the forecast joins the last actual.
  const ch = o.chart as { x: string[]; series: Array<{ role: string; values: Array<number | null> }> };
  const fc = ch.series.find((s) => s.role === 'forecast')!.values;
  assert.equal(fc[11], 3);
  assert.equal(fc[12], 2);
  assert.equal(fc.length, ch.x.length);
});

test('demand auto picks a method, and refuses all-zero usage', () => {
  const lumpy = [0, 0, 12, 0, 0, 0, 1, 0, 0, 30, 0, 0, 0, 2, 0, 0];
  const o = runDemand(monthly(lumpy), { type: 'demand' }, ctx);
  assert.match(o.sentences[0]!, /SBA/);
  const smooth = [20, 22, 19, 21, 23, 20, 18, 22, 21, 20, 19, 22];
  assert.match(runDemand(monthly(smooth), { type: 'demand' }, ctx).sentences[0]!, /Croston/);
  assert.throws(() => runDemand(monthly([0, 0, 0, null, 0]), { type: 'demand' }, ctx), ModelError);
  assert.deepEqual(runDemand(monthly(lumpy), { type: 'demand' }, ctx), o);
});

// ---- Markov ---------------------------------------------------------------------------------------

function moves(list: Array<[string, string, number]>): ModelData {
  return { dims: [{ key: 'f', label: 'From', isDate: false }, { key: 't', label: 'To', isDate: false }], metrics: [{ key: 'n', label: 'Moves' }], rows: list.map(([a, b, n]) => ({ dims: [a, b], values: [n] })) };
}

test('Markov absorbing chain matches the fundamental matrix by hand', () => {
  // Q = [[0,1],[.5,0]] → N = [[2,2],[1,2]]: 4 steps from Open, 3 from Review.
  const o = runMarkov(moves([['Open', 'Review', 10], ['Review', 'Open', 5], ['Review', 'Closed', 5]]), { type: 'markov' }, ctx);
  close(row(o, 'Open')[3] as number, 4, 1e-12);
  close(row(o, 'Review')[3] as number, 3, 1e-12);
  assert.match(o.headline, /From Open, items take 4 steps on average to reach Closed/);
  // Two exits: Q = [[0,1],[.4,0]], N = [[1,1],[.4,1]]/.6; from Open 3.33 steps, 2/3 Closed, 1/3 Cancelled.
  const t = runMarkov(moves([['Open', 'Review', 10], ['Review', 'Open', 4], ['Review', 'Closed', 4], ['Review', 'Cancelled', 2]]), { type: 'markov' }, ctx);
  close(row(t, 'Open')[3] as number, 2 / 0.6, 1e-12);
  close(row(t, 'Open')[4] as number, 2 / 3, 1e-12);
  close(row(t, 'Open')[5] as number, 1 / 3, 1e-12);
  assert.match(t.headline, /66.7% end in Closed, 33.3% in Cancelled/);
  assert.equal(t.chart?.kind, 'matrix');
});

test('Markov stationary distribution of a two-state chain is (q, p)/(p + q)', () => {
  const p = 0.3;
  const q = 0.1;
  const pi = stationary([[1 - p, p], [q, 1 - q]])!;
  close(pi[0]!, q / (p + q), 1e-12);
  close(pi[1]!, p / (p + q), 1e-12);
  const o = runMarkov(moves([['Up', 'Up', 70], ['Up', 'Down', 30], ['Down', 'Up', 10], ['Down', 'Down', 90]]), { type: 'markov', params: { steps: 3 } }, ctx);
  close(row(o, 'Down')[3] as number, 0.75, 1e-12);
  assert.match(o.headline, /75% of items sit in Down/);
  assert.throws(() => runMarkov(moves([['A', 'A', 5], ['B', 'B', 3]]), { type: 'markov' }, ctx), ModelError);
});

test('every model is deterministic for the same input', () => {
  const runs: Array<[(d: ModelData, s: ModelSpec, c: typeof ctx) => ModelOutput, ModelData, ModelSpec]> = [
    [runSurvival, groupData(new Rng(9), [5, 9], 30), { type: 'survival' }],
    [runWeibull, groupData(new Rng(9), [5], 40), { type: 'weibull' }],
  ];
  for (const [fn, d, s] of runs) assert.deepEqual(fn(d, s, ctx), fn(d, s, ctx));
});

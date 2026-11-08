// Model flags end to end: saved settings are read safely, briefs ask for models, every model runs on
// the example data through the same entry point the worker uses, and every chart it returns draws.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import { applyFlagDraft } from '../src/core/intelligence/index.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { parseHoist } from '../src/core/hoist.ts';
import { defaultParams, fitModel, MODELS, modelInfo } from '../src/core/predict/models.ts';
import { runModel } from '../src/core/predict/run.ts';
import { MODEL_TYPES, parseModelSpec } from '../src/core/predict/spec.ts';
import { Rng } from '../src/core/predict/rng.ts';
import type { ModelData, ModelType } from '../src/core/predict/types.ts';
import { modelChartOption } from '../web/src/lib/model-chart.ts';

const catalog: Catalog = {
  version: 1,
  sources: [{ id: 's', label: 'S', kind: 'csv', dialect: 'ansi' }],
  fields: [
    { key: 'jobs.region', label: 'Region', source: 's', table: 'jobs', column: 'region', type: 'string', cardinality: 6 },
    { key: 'jobs.status', label: 'Status', source: 's', table: 'jobs', column: 'status', type: 'string', cardinality: 5 },
    { key: 'jobs.cost', label: 'Cost', source: 's', table: 'jobs', column: 'cost', type: 'number' },
    { key: 'jobs.opened', label: 'Opened', source: 's', table: 'jobs', column: 'opened', type: 'date' },
  ],
  metrics: [
    { key: 'labor_cost', label: 'Labor cost', agg: 'sum', field: 'jobs.cost', source: 's', format: 'currency' },
    { key: 'work_orders', label: 'Work orders', agg: 'count', source: 's' },
  ],
  hierarchies: [],
};
const index = indexCatalog(catalog);
const c = { ink: '#111111', ink2: '#333333', ink3: '#666666', line: '#dddddd', panel: '#ffffff', good: '#2e7d4f', warn: '#b7791f', bad: '#c0392b' };

test('every model type is listed once, with settings and needs', () => {
  assert.deepEqual([...MODEL_TYPES].sort(), MODELS.map((m) => m.type).sort());
  for (const m of MODELS) {
    assert.ok(m.label && m.hint && m.needs.text, m.type);
    assert.equal(new Set(m.params.map((p) => p.key)).size, m.params.length, `${m.type}: setting keys are unique`);
  }
});

test('saved model settings are read safely: unknown models and junk settings never run', () => {
  const w: string[] = [];
  assert.equal(parseModelSpec({ type: 'rm -rf' }, w, 'F'), null);
  assert.match(w[0]!, /unknown model/);
  const spec = parseModelSpec({ type: 'montecarlo', params: { trials: 5000, 'bad key': 1, __proto__x: 2, nested: { a: 1 }, distribution: 'pert' }, inputs: [{ name: 'Labour', low: 1, likely: 2, high: 4 }, { name: 'bad', low: 'x' }] }, [], 'F')!;
  assert.deepEqual(spec.params, { trials: 5000, distribution: 'pert' });
  assert.deepEqual(spec.inputs, [{ name: 'Labour', low: 1, likely: 2, high: 4 }]);
});

test('a hoist keeps a model flag, including a Monte Carlo with only typed-in inputs', () => {
  const raw = {
    version: 1,
    id: 'h',
    title: 'T',
    brief: '',
    grid: { cols: 12 },
    filters: [],
    updated: '',
    flags: [
      { id: 'mc', kind: 'model', title: 'Cost risk', brief: '', layout: { x: 0, y: 0, w: 6, h: 5 }, binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'ready', notes: [], model: { type: 'montecarlo', inputs: [{ name: 'A', low: 1, likely: 2, high: 3 }] } },
    ],
  };
  const { hoist } = parseHoist(raw, index);
  const f = hoist!.flags[0]!;
  assert.equal(f.kind, 'model');
  assert.equal(f.status, 'ready', 'inputs alone are enough');
  assert.equal(f.model?.type, 'montecarlo');
});

test('briefs ask for models, and a forecast gets a date by month', () => {
  const d = draftFlagLocally('Forecast labor cost for the next 6 months', 'bar', index);
  assert.equal(d.kind, 'model');
  assert.equal(d.model?.type, 'smoothing');
  assert.equal(d.model?.params?.horizon, 6);
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.opened', grain: 'month' }]);
  assert.equal(draftFlagLocally('Monte Carlo of labor cost by region', 'bar', index).model?.type, 'montecarlo');
  assert.equal(draftFlagLocally('Control chart of work orders by month opened', 'bar', index).model?.type, 'spc');
  assert.equal(draftFlagLocally('Labor cost by region', 'bar', index).kind, 'bar', 'an ordinary brief is not a model');
  const applied = applyFlagDraft({ id: 'f', kind: 'bar', title: '', brief: '', layout: { x: 0, y: 0, w: 6, h: 5 }, binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'empty', notes: [] }, d);
  assert.equal(applied.model?.type, 'smoothing');
});

test('fitModel says what a model needs', () => {
  assert.equal(fitModel('smoothing', { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened', grain: 'month' }], filters: [] }, index).ok, true);
  const r = fitModel('regression', { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] }, index);
  assert.equal(r.ok, false);
  assert.match(r.note!, /two or more measures/);
  assert.equal(fitModel('montecarlo', null, index, true).ok, true, 'typed-in inputs need no rows');
});

// ---- every model on realistic data -------------------------------------------------------------

const rng = new Rng(7);
const months = Array.from({ length: 48 }, (_, i) => `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`);
const monthly: ModelData = {
  dims: [{ key: 'jobs.opened@month', label: 'Opened', grain: 'month', isDate: true }],
  metrics: [{ key: 'work_orders', label: 'Work orders' }],
  rows: months.map((m, i) => ({ dims: [m], values: [Math.round(200 + 3 * i + 40 * Math.sin((2 * Math.PI * i) / 12) + rng.normal(0, 8))] })),
};
const items: ModelData = {
  dims: [{ key: 'jobs.hull', label: 'Hull', isDate: false }],
  metrics: [
    { key: 'labor_cost', label: 'Labor cost', format: 'currency' },
    { key: 'hours', label: 'Hours' },
    { key: 'parts', label: 'Parts' },
  ],
  rows: Array.from({ length: 120 }, (_, i) => {
    const hours = 10 + rng.next() * 90;
    const parts = rng.next() * 20;
    return { dims: [`H-${i}`], values: [Math.round(500 + 80 * hours + 40 * parts + rng.normal(0, 300)), Math.round(hours), Math.round(parts)] };
  }),
};
const durations: ModelData = {
  dims: [{ key: 'jobs.id', label: 'Job', isDate: false }],
  metrics: [
    { key: 'days', label: 'Days open' },
    { key: 'closed', label: 'Closed' },
  ],
  rows: Array.from({ length: 150 }, (_, i) => ({ dims: [`J-${i}`], values: [Math.max(1, Math.round(60 * Math.pow(-Math.log(1 - rng.next()), 1 / 1.6))), rng.next() < 0.85 ? 1 : 0] })),
};
const regions: ModelData = {
  dims: [{ key: 'jobs.region', label: 'Region', isDate: false }],
  metrics: [
    { key: 'labor_cost', label: 'Labor cost', format: 'currency' },
    { key: 'work_orders', label: 'Work orders' },
  ],
  rows: ['North', 'South', 'East', 'West', 'Gulf', 'Lakes'].map((r, i) => ({ dims: [r], values: [1_000_000 + i * 250_000, 40 + i * 12] })),
};
const transitions: ModelData = {
  dims: [
    { key: 'from', label: 'From', isDate: false },
    { key: 'to', label: 'To', isDate: false },
  ],
  metrics: [{ key: 'moves', label: 'Moves' }],
  rows: [
    { dims: ['Open', 'In progress'], values: [80] },
    { dims: ['Open', 'Cancelled'], values: [20] },
    { dims: ['In progress', 'Awaiting parts'], values: [30] },
    { dims: ['In progress', 'Closed'], values: [60] },
    { dims: ['Awaiting parts', 'In progress'], values: [28] },
    { dims: ['Awaiting parts', 'Cancelled'], values: [2] },
  ],
};
const rates: ModelData = { ...regions, rows: regions.rows.map((r, i) => ({ dims: r.dims, values: [3 + i * 2, 40 + i * 10] })) };
const oneMetric = (d: ModelData): ModelData => ({ ...d, metrics: d.metrics.slice(0, 1), rows: d.rows.map((r) => ({ dims: r.dims, values: r.values.slice(0, 1) })) });

const DATA: Record<ModelType, ModelData> = {
  trend: monthly,
  smoothing: monthly,
  arima: monthly,
  decompose: monthly,
  lstm: monthly,
  montecarlo: oneMetric(regions),
  backlog: monthly,
  sensitivity: oneMetric(regions),
  bootstrap: oneMetric(items),
  bayes: rates,
  spc: monthly,
  anomaly: oneMetric(items),
  regression: items,
  logistic: { ...items, metrics: [{ key: 'over', label: 'Over budget' }, ...items.metrics.slice(1)], rows: items.rows.map((r) => ({ dims: r.dims, values: [r.values[0]! > 5000 ? 1 : 0, ...r.values.slice(1)] })) },
  tree: items,
  forest: items,
  boosting: items,
  kmeans: { ...items, metrics: items.metrics.slice(1), rows: items.rows.map((r) => ({ dims: r.dims, values: r.values.slice(1) })) },
  survival: durations,
  weibull: durations,
  demand: { ...monthly, rows: monthly.rows.map((r, i) => ({ dims: r.dims, values: [i % 3 === 0 ? 0 : Math.round(rng.next() * 6)] })) },
  markov: transitions,
};

for (const type of MODEL_TYPES) {
  test(`${modelInfo(type).label} runs through the worker's entry point and its chart draws`, () => {
    const params = { ...defaultParams(type), ...(type === 'lstm' ? { epochs: 20 } : {}), ...(type === 'forest' ? { trees: 40 } : {}), ...(type === 'boosting' ? { rounds: 60 } : {}), ...(type === 'backlog' ? { backlog: 1500 } : {}) };
    const answer = runModel(DATA[type], { type, params }, { seed: 11, today: '2026-11-08' });
    assert.ok(answer.ok, answer.ok ? '' : answer.error);
    const o = answer.output;
    assert.equal(o.model, type);
    assert.ok(o.headline.length > 10, 'a headline sentence');
    assert.ok(o.stats.length >= 1 && o.stats.length <= 6, 'one to six headline numbers');
    assert.ok(Array.isArray(o.table.columns) && o.table.rows.every((r) => r.length === o.table.columns.length), 'table rows match the columns');
    assert.ok(!/NaN|undefined|Infinity/.test(o.headline + o.sentences.join(' ')), `no broken numbers in the words: ${o.headline}`);
    if (o.chart) {
      const option = modelChartOption({ chart: o.chart, c, colors: ['#2a78d6', '#eb6834', '#2e7d4f'] });
      assert.ok(Array.isArray(option.series) && (option.series as unknown[]).length > 0, 'the chart has series');
    }
    // Same seed, same answer.
    const again = runModel(DATA[type], { type, params }, { seed: 11, today: '2026-11-08' });
    assert.ok(again.ok);
    assert.equal(JSON.stringify(again.output), JSON.stringify(o));
  });
}

test('a model that cannot run says why instead of failing', () => {
  const a = runModel({ ...monthly, rows: monthly.rows.slice(0, 2) }, { type: 'arima' }, { seed: 1, today: '2026-11-08' });
  assert.equal(a.ok, false);
  assert.ok(!a.ok && a.expected, 'a ModelError is an expected answer');
});

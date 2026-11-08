// Every predictive model as the page sees it: name, group, what it answers, what fields and measures
// it needs, and its settings. Light on purpose (no model code), so the palette and the inspector can
// list models without loading them; the models run in the predict worker (web/src/predict-worker.ts).

import type { CatalogIndex } from '../catalog.ts';
import type { Binding } from '../hoist.ts';
import type { ModelType, ParamValue } from './types.ts';

export type ModelGroup = 'Forecasting' | 'Simulation and risk' | 'Quality' | 'Drivers and machine learning' | 'Reliability and inventory';

export interface ParamDef {
  key: string;
  label: string;
  kind: 'number' | 'choice' | 'boolean';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  choices?: Array<{ value: string; label: string }>;
  hint?: string;
}

export interface ModelNeeds {
  /** Fields (dimensions) the binding must have. */
  dims: [min: number, max: number];
  /** Measures the binding must have. */
  metrics: [min: number, max: number];
  /** The first field must be a date (with or without a grain). */
  date?: boolean;
  /** The model can run on hand-entered inputs instead of rows (Monte Carlo, sensitivity). */
  inputs?: boolean;
  /** Plain words, for the inspector and the note when the binding does not fit. */
  text: string;
}

export interface ModelInfo {
  type: ModelType;
  label: string;
  group: ModelGroup;
  /** The question it answers, in a few words. */
  hint: string;
  needs: ModelNeeds;
  params: ParamDef[];
  /** Runs for a while (forests, LSTM): the card says so while it works. */
  heavy?: boolean;
}

const horizon = (def = 6): ParamDef => ({ key: 'horizon', label: 'Periods ahead', kind: 'number', default: def, min: 1, max: 120, step: 1, hint: 'How far to forecast.' });
const level: ParamDef = {
  key: 'level',
  label: 'Interval',
  kind: 'choice',
  default: '0.9',
  choices: [
    { value: '0.8', label: '80%' },
    { value: '0.9', label: '90%' },
    { value: '0.95', label: '95%' },
  ],
  hint: 'How sure the shaded band is.',
};
const seed: ParamDef = { key: 'seed', label: 'Seed', kind: 'number', default: 1, min: 1, max: 1_000_000, step: 1, hint: 'The same seed gives the same random draws, so results repeat.' };
const trials: ParamDef = { key: 'trials', label: 'Trials', kind: 'number', default: 10000, min: 500, max: 200000, step: 500, hint: 'More trials, steadier percentiles, longer to run.' };
const season: ParamDef = { key: 'season', label: 'Season length', kind: 'number', default: 0, min: 0, max: 366, step: 1, hint: '0 picks it from the date grain: 12 months, 4 quarters, 52 weeks, 7 days.' };
const distribution: ParamDef = {
  key: 'distribution',
  label: 'Spread',
  kind: 'choice',
  default: 'pert',
  choices: [
    { value: 'pert', label: 'PERT (most likely weighted)' },
    { value: 'triangular', label: 'Triangular' },
    { value: 'normal', label: 'Normal (low and high are the 5th and 95th percentiles)' },
    { value: 'uniform', label: 'Uniform (any value equally likely)' },
    { value: 'lognormal', label: 'Lognormal (long tail upward)' },
  ],
};
const lowPct: ParamDef = { key: 'lowPct', label: 'Low (% below)', kind: 'number', default: 15, min: 0, max: 100, step: 1, hint: 'For inputs taken from rows: how far below each value it could fall.' };
const highPct: ParamDef = { key: 'highPct', label: 'High (% above)', kind: 'number', default: 30, min: 0, max: 500, step: 1, hint: 'For inputs taken from rows: how far above each value it could rise.' };
const combine: ParamDef = {
  key: 'combine',
  label: 'Combine inputs by',
  kind: 'choice',
  default: 'sum',
  choices: [
    { value: 'sum', label: 'Adding them (a total cost)' },
    { value: 'product', label: 'Multiplying them (rate × volume)' },
  ],
};
const depth = (def: number): ParamDef => ({ key: 'maxDepth', label: 'Tree depth', kind: 'number', default: def, min: 1, max: 12, step: 1, hint: 'Deeper trees fit more detail, and more noise.' });
const minLeaf: ParamDef = { key: 'minLeaf', label: 'Rows per leaf', kind: 'number', default: 3, min: 1, max: 100, step: 1 };

export const MODELS: readonly ModelInfo[] = [
  // ---- Forecasting -------------------------------------------------------------------------------
  {
    type: 'trend',
    label: 'Trend line',
    group: 'Forecasting',
    hint: 'Where the line is heading',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and one measure' },
    params: [{ key: 'degree', label: 'Shape', kind: 'choice', default: '1', choices: [{ value: '1', label: 'Straight line' }, { value: '2', label: 'Curve (quadratic)' }, { value: '3', label: 'S-curve (cubic)' }] }, horizon(6), level],
  },
  {
    type: 'smoothing',
    label: 'Exponential smoothing',
    group: 'Forecasting',
    hint: 'Next periods, with trend and season',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and one measure' },
    params: [
      {
        key: 'method',
        label: 'Method',
        kind: 'choice',
        default: 'auto',
        choices: [
          { value: 'auto', label: 'Best fit (picks by AIC)' },
          { value: 'sma', label: 'Moving average' },
          { value: 'ses', label: 'Simple (level only)' },
          { value: 'holt', label: 'Holt (level and trend)' },
          { value: 'damped', label: 'Damped trend' },
          { value: 'hw-add', label: 'Holt-Winters, additive season' },
          { value: 'hw-mult', label: 'Holt-Winters, multiplicative season' },
        ],
      },
      { key: 'window', label: 'Moving average window', kind: 'number', default: 3, min: 2, max: 60, step: 1 },
      season,
      horizon(6),
      level,
    ],
  },
  {
    type: 'arima',
    label: 'ARIMA',
    group: 'Forecasting',
    hint: 'Forecast from the series’ own pattern',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and one measure, ideally 24 periods or more' },
    params: [
      { key: 'auto', label: 'Choose the order for me', kind: 'boolean', default: true, hint: 'Tries small orders and keeps the one with the lowest AIC.' },
      { key: 'p', label: 'p (autoregressive)', kind: 'number', default: 1, min: 0, max: 5, step: 1 },
      { key: 'd', label: 'd (differences)', kind: 'number', default: 1, min: 0, max: 2, step: 1 },
      { key: 'q', label: 'q (moving average)', kind: 'number', default: 0, min: 0, max: 5, step: 1 },
      { key: 'seasonal', label: 'Take out the season first', kind: 'boolean', default: false, hint: 'Seasonal differencing at the season length.' },
      season,
      horizon(6),
      level,
    ],
  },
  {
    type: 'decompose',
    label: 'Seasonal decomposition',
    group: 'Forecasting',
    hint: 'Trend, season and noise apart',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and one measure covering at least two seasons' },
    params: [
      { key: 'method', label: 'Method', kind: 'choice', default: 'stl', choices: [{ value: 'stl', label: 'STL (robust, local fits)' }, { value: 'classical', label: 'Classical (moving averages)' }] },
      { key: 'form', label: 'Season form', kind: 'choice', default: 'additive', choices: [{ value: 'additive', label: 'Additive (adds a fixed amount)' }, { value: 'multiplicative', label: 'Multiplicative (scales with level)' }] },
      season,
    ],
  },
  {
    type: 'lstm',
    label: 'Neural network (LSTM)',
    group: 'Forecasting',
    hint: 'A learned forecast for long series',
    heavy: true,
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and one measure, ideally 60 periods or more' },
    params: [
      { key: 'window', label: 'Look-back periods', kind: 'number', default: 12, min: 2, max: 60, step: 1 },
      { key: 'hidden', label: 'Hidden units', kind: 'number', default: 12, min: 2, max: 48, step: 1 },
      { key: 'epochs', label: 'Training passes', kind: 'number', default: 150, min: 10, max: 2000, step: 10 },
      horizon(6),
      seed,
    ],
  },
  // ---- Simulation and risk -----------------------------------------------------------------------
  {
    type: 'montecarlo',
    label: 'Monte Carlo',
    group: 'Simulation and risk',
    hint: 'The odds of a total, with P10–P90',
    needs: { dims: [0, 1], metrics: [0, 1], inputs: true, text: 'hand-entered inputs, or one field with one measure (each row becomes an uncertain input)' },
    params: [trials, distribution, lowPct, highPct, combine, { key: 'target', label: 'Target (optional)', kind: 'number', default: 0, step: 1, hint: 'The chance of coming in at or under this is shown. 0 for none.' }, seed],
  },
  {
    type: 'backlog',
    label: 'Backlog forecast',
    group: 'Simulation and risk',
    hint: 'When the backlog clears, with odds',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and the number finished each period' },
    params: [
      { key: 'backlog', label: 'Items left', kind: 'number', default: 100, min: 1, max: 10_000_000, step: 1, hint: 'How many are still to finish.' },
      { key: 'lookback', label: 'Periods of history to sample', kind: 'number', default: 26, min: 3, max: 520, step: 1 },
      { key: 'horizon', label: 'Periods ahead (for "how many by")', kind: 'number', default: 8, min: 1, max: 260, step: 1 },
      trials,
      seed,
    ],
  },
  {
    type: 'sensitivity',
    label: 'Sensitivity (tornado)',
    group: 'Simulation and risk',
    hint: 'Which input moves the answer most',
    needs: { dims: [0, 1], metrics: [0, 1], inputs: true, text: 'hand-entered inputs, or one field with one measure' },
    params: [lowPct, highPct, combine],
  },
  {
    type: 'bootstrap',
    label: 'Bootstrap interval',
    group: 'Simulation and risk',
    hint: 'Honest error bars on a figure',
    needs: { dims: [1, 1], metrics: [1, 1], text: 'one field and one measure' },
    params: [
      { key: 'stat', label: 'Figure', kind: 'choice', default: 'mean', choices: [{ value: 'mean', label: 'Average' }, { value: 'median', label: 'Median' }, { value: 'total', label: 'Total' }, { value: 'sd', label: 'Spread (standard deviation)' }] },
      { key: 'resamples', label: 'Resamples', kind: 'number', default: 5000, min: 200, max: 100000, step: 100 },
      level,
      seed,
    ],
  },
  {
    type: 'bayes',
    label: 'Bayesian rate',
    group: 'Simulation and risk',
    hint: 'Fair rates from small samples',
    needs: { dims: [1, 1], metrics: [2, 2], text: 'one field and two measures: events, then trials (or exposure)' },
    params: [
      { key: 'likelihood', label: 'Kind of rate', kind: 'choice', default: 'binomial', choices: [{ value: 'binomial', label: 'Share of trials (events out of trials)' }, { value: 'poisson', label: 'Rate per exposure (events per hour, per ship)' }] },
      { key: 'prior', label: 'Prior strength', kind: 'number', default: 0, min: 0, max: 10000, step: 1, hint: '0 learns it from all the groups together (empirical Bayes).' },
      level,
    ],
  },
  // ---- Quality -----------------------------------------------------------------------------------
  {
    type: 'spc',
    label: 'Control chart',
    group: 'Quality',
    hint: 'Real change, or just noise?',
    needs: { dims: [1, 1], metrics: [1, 1], text: 'an ordered field (usually a date) and one measure' },
    params: [
      { key: 'chart', label: 'Chart', kind: 'choice', default: 'imr', choices: [{ value: 'imr', label: 'Individuals (Shewhart)' }, { value: 'ewma', label: 'EWMA (small drifts)' }, { value: 'cusum', label: 'CUSUM (small shifts)' }] },
      { key: 'sigma', label: 'Limits (sigma)', kind: 'number', default: 3, min: 1, max: 6, step: 0.5 },
      { key: 'lambda', label: 'EWMA weight', kind: 'number', default: 0.2, min: 0.05, max: 1, step: 0.05 },
      { key: 'k', label: 'CUSUM allowance (sigma)', kind: 'number', default: 0.5, min: 0.1, max: 3, step: 0.1 },
      { key: 'h', label: 'CUSUM limit (sigma)', kind: 'number', default: 5, min: 1, max: 10, step: 0.5 },
      { key: 'rules', label: 'Western Electric rules', kind: 'boolean', default: true, hint: 'Also flags runs and trends inside the limits.' },
      { key: 'baseline', label: 'Baseline periods', kind: 'number', default: 0, min: 0, max: 10000, step: 1, hint: 'Set the limits from the first n points only. 0 uses them all.' },
    ],
  },
  {
    type: 'anomaly',
    label: 'Anomaly detection',
    group: 'Quality',
    hint: 'Which values are unusual',
    needs: { dims: [1, 1], metrics: [1, 1], text: 'one field and one measure' },
    params: [
      { key: 'method', label: 'Method', kind: 'choice', default: 'mad', choices: [{ value: 'mad', label: 'Robust (median distance)' }, { value: 'zscore', label: 'Z-score (standard deviations)' }, { value: 'iqr', label: 'Box plot fences (IQR)' }] },
      { key: 'threshold', label: 'Threshold', kind: 'number', default: 3.5, min: 0.5, max: 10, step: 0.5, hint: 'Robust and z-score: distance in deviations. IQR: multiples of the box (1.5 is usual).' },
    ],
  },
  // ---- Drivers and machine learning --------------------------------------------------------------
  {
    type: 'regression',
    label: 'Regression (drivers)',
    group: 'Drivers and machine learning',
    hint: 'What drives a measure, and by how much',
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field and two or more measures: the first is what to explain, the rest are drivers' },
    params: [{ key: 'degree', label: 'Curve (one driver only)', kind: 'number', default: 1, min: 1, max: 3, step: 1 }, level],
  },
  {
    type: 'logistic',
    label: 'Logistic regression',
    group: 'Drivers and machine learning',
    hint: 'The chance of an outcome',
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field and two or more measures: the first is the outcome (a 0–1 share, or a value with a threshold), the rest are drivers' },
    params: [{ key: 'threshold', label: 'Outcome above', kind: 'number', default: 0, step: 1, hint: 'Counts the outcome as yes when the first measure is above this. 0 reads 0–1 shares as they are.' }, level],
  },
  {
    type: 'tree',
    label: 'Decision tree',
    group: 'Drivers and machine learning',
    hint: 'Rules that split high from low',
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field and two or more measures: the first is what to predict' },
    params: [depth(3), minLeaf],
  },
  {
    type: 'forest',
    label: 'Random forest',
    group: 'Drivers and machine learning',
    hint: 'Many trees: a steadier prediction',
    heavy: true,
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field and two or more measures: the first is what to predict' },
    params: [{ key: 'trees', label: 'Trees', kind: 'number', default: 200, min: 10, max: 2000, step: 10 }, depth(8), minLeaf, { key: 'features', label: 'Share of drivers per split', kind: 'number', default: 0.6, min: 0.1, max: 1, step: 0.05 }, seed],
  },
  {
    type: 'boosting',
    label: 'Gradient boosting',
    group: 'Drivers and machine learning',
    hint: 'Trees that correct each other',
    heavy: true,
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field and two or more measures: the first is what to predict' },
    params: [
      { key: 'rounds', label: 'Rounds', kind: 'number', default: 200, min: 10, max: 3000, step: 10 },
      { key: 'rate', label: 'Learning rate', kind: 'number', default: 0.1, min: 0.01, max: 1, step: 0.01 },
      depth(3),
      minLeaf,
      { key: 'subsample', label: 'Share of rows per round', kind: 'number', default: 0.8, min: 0.2, max: 1, step: 0.05 },
      seed,
    ],
  },
  {
    type: 'kmeans',
    label: 'Clusters (k-means)',
    group: 'Drivers and machine learning',
    hint: 'Groups of similar items',
    needs: { dims: [1, 1], metrics: [2, 12], text: 'one field (the items) and two or more measures' },
    params: [{ key: 'k', label: 'Groups', kind: 'number', default: 0, min: 0, max: 12, step: 1, hint: '0 picks the number by the silhouette score.' }, { key: 'standardize', label: 'Put measures on one scale', kind: 'boolean', default: true }, seed],
  },
  // ---- Reliability and inventory -----------------------------------------------------------------
  {
    type: 'survival',
    label: 'Survival (Kaplan-Meier)',
    group: 'Reliability and inventory',
    hint: 'How long until it ends, counting open ones',
    needs: { dims: [1, 2], metrics: [1, 2], text: 'one field (each item), its duration, and optionally a 1/0 measure for finished; a second field splits the curves' },
    params: [level],
  },
  {
    type: 'weibull',
    label: 'Weibull reliability',
    group: 'Reliability and inventory',
    hint: 'Time to failure, MTBF and B10 life',
    needs: { dims: [1, 1], metrics: [1, 2], text: 'one field (each item), its time to failure, and optionally a 1/0 measure for failed' },
    params: [{ key: 'mission', label: 'Mission time', kind: 'number', default: 0, min: 0, step: 1, hint: 'The chance of lasting this long is shown. 0 for none.' }, level],
  },
  {
    type: 'demand',
    label: 'Spare-parts demand',
    group: 'Reliability and inventory',
    hint: 'Reorder point and safety stock',
    needs: { dims: [1, 1], metrics: [1, 1], date: true, text: 'a date field and the quantity used each period' },
    params: [
      { key: 'method', label: 'Method', kind: 'choice', default: 'auto', choices: [{ value: 'auto', label: 'Pick for the pattern' }, { value: 'croston', label: 'Croston (intermittent)' }, { value: 'sba', label: 'Syntetos-Boylan (less bias)' }, { value: 'tsb', label: 'TSB (handles obsolescence)' }, { value: 'poisson', label: 'Poisson (steady small counts)' }] },
      { key: 'alpha', label: 'Smoothing', kind: 'number', default: 0.1, min: 0.01, max: 1, step: 0.01 },
      { key: 'leadTime', label: 'Lead time (periods)', kind: 'number', default: 2, min: 0, max: 104, step: 1 },
      { key: 'service', label: 'Service level', kind: 'number', default: 0.95, min: 0.5, max: 0.999, step: 0.005, hint: 'The chance of not running out during the lead time.' },
      { key: 'orderCost', label: 'Cost per order', kind: 'number', default: 0, min: 0, step: 1, hint: 'With holding cost, gives the economic order quantity. 0 for none.' },
      { key: 'holdingCost', label: 'Holding cost per unit per period', kind: 'number', default: 0, min: 0, step: 0.01 },
    ],
  },
  {
    type: 'markov',
    label: 'Status transitions (Markov)',
    group: 'Reliability and inventory',
    hint: 'Where items go next, and how long it takes',
    needs: { dims: [2, 2], metrics: [1, 1], text: 'two fields (from status, to status) and a count of moves' },
    params: [{ key: 'steps', label: 'Steps ahead', kind: 'number', default: 5, min: 1, max: 200, step: 1 }],
  },
];

export const MODEL_GROUPS: readonly ModelGroup[] = ['Forecasting', 'Simulation and risk', 'Quality', 'Drivers and machine learning', 'Reliability and inventory'];

export const modelInfo = (type: ModelType): ModelInfo => MODELS.find((m) => m.type === type) ?? MODELS[0]!;

export const isModelType = (t: unknown): t is ModelType => typeof t === 'string' && MODELS.some((m) => m.type === t);

/** Default settings of a model, for a new spec. */
export function defaultParams(type: ModelType): Record<string, ParamValue> {
  return Object.fromEntries(modelInfo(type).params.map((p) => [p.key, p.default]));
}

/**
 * Whether a binding can feed the model, and if not a sentence saying what it needs. A model that
 * takes hand-entered inputs fits whenever it has some.
 */
export function fitModel(type: ModelType, b: Binding | null, index: CatalogIndex | undefined, hasInputs = false): { ok: boolean; note?: string } {
  const info = modelInfo(type);
  const n = info.needs;
  if (n.inputs && hasInputs) return { ok: true };
  const dims = b?.dimensions.length ?? 0;
  const metrics = b?.metrics.length ?? 0;
  const dateOk = !n.date || (!!b?.dimensions[0] && (!!b.dimensions[0].grain || index?.field(b.dimensions[0].field)?.type === 'date'));
  const ok = dims >= n.dims[0] && dims <= n.dims[1] && metrics >= n.metrics[0] && metrics <= n.metrics[1] && dateOk && (dims + metrics > 0 || !!n.inputs);
  return ok ? { ok } : { ok, note: `${info.label} needs ${n.text}.` };
}

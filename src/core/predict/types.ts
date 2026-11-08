// The contract every predictive model in src/core/predict keeps. A model takes the rows a flag's
// query returned (already totalled by the database or the CSV engine), its settings, and returns a
// ModelOutput: sentences, headline numbers, one chart and a table. Plain data in and out, so a model
// runs the same in the predict worker, on the page, in a shared report and in the tests.
//
// Models are pure TypeScript with no dependencies: Semaphore runs on locked-down workstations with
// no Python, R or installs, so each model is written here and checked against hand-worked answers
// and known results (tests/predict-*.test.ts).

import type { Cell } from '../crossfilter.ts';
import type { TimeGrain } from '../hoist.ts';

/** Every model Semaphore can run. models.ts describes each one for the page. */
export type ModelType =
  // Forecasting
  | 'trend'
  | 'smoothing'
  | 'arima'
  | 'decompose'
  | 'lstm'
  // Simulation and risk
  | 'montecarlo'
  | 'backlog'
  | 'sensitivity'
  | 'bootstrap'
  | 'bayes'
  // Quality
  | 'spc'
  | 'anomaly'
  // Drivers and machine learning
  | 'regression'
  | 'logistic'
  | 'tree'
  | 'forest'
  | 'boosting'
  | 'kmeans'
  // Reliability and inventory
  | 'survival'
  | 'weibull'
  | 'demand'
  | 'markov';

export type ParamValue = number | string | boolean;

/** A hand-entered uncertain input for Monte Carlo and sensitivity: a name and its range. */
export interface ModelInput {
  name: string;
  /** The lowest, most likely and highest values. */
  low: number;
  likely: number;
  high: number;
  /** How the value spreads between low and high. Default: the model's `distribution` setting. */
  distribution?: Distribution;
}

export type Distribution = 'triangular' | 'pert' | 'normal' | 'uniform' | 'lognormal';

/** What a flag asks of its model: which one, and its settings (keys from models.ts). */
export interface ModelSpec {
  type: ModelType;
  params?: Record<string, ParamValue>;
  /** Hand-entered inputs (Monte Carlo, sensitivity). When absent, the rows are the inputs. */
  inputs?: ModelInput[];
}

/** The number format of a value, as the catalog states it, or 'metric' for the first measure's own. */
export type ValueFormat = 'number' | 'currency' | 'percent' | 'integer' | 'decimal' | 'days' | 'metric';

/** The flag's rows as a model sees them: fields and measures in binding order. */
export interface ModelData {
  dims: Array<{ key: string; label: string; grain?: TimeGrain; isDate: boolean }>;
  metrics: Array<{ key: string; label: string; format?: 'number' | 'currency' | 'percent' }>;
  /** One per result row; `dims[i]` lines up with `dims`, `values[j]` with `metrics`. */
  rows: Array<{ dims: Cell[]; values: Array<number | null> }>;
}

export interface ModelStat {
  label: string;
  value: number | string | null;
  format?: ValueFormat;
  /** One short sentence shown on hover. */
  hint?: string;
}

export type Tone = 'good' | 'warn' | 'bad';

export type ModelChart =
  /** Values along an ordered axis: actuals, the fit, a forecast with its band, limits and flagged points. */
  | {
      kind: 'series';
      x: string[];
      series: Array<{ name: string; values: Array<number | null>; role: 'actual' | 'fit' | 'forecast' | 'limit' | 'line' }>;
      band?: { name: string; lower: Array<number | null>; upper: Array<number | null> };
      marks?: Array<{ index: number; tone: Tone; label?: string }>;
      yFormat?: ValueFormat;
    }
  /** Stacked small panels on one axis (a decomposition: observed, trend, seasonal, remainder). */
  | { kind: 'panels'; x: string[]; panels: Array<{ name: string; values: Array<number | null> }>; yFormat?: ValueFormat }
  /** A distribution of simulated outcomes with marked values (P10, P50, P90, a target). */
  | { kind: 'histogram'; bins: Array<{ x0: number; x1: number; count: number }>; markers: Array<{ label: string; value: number; tone?: Tone }>; xFormat?: ValueFormat; xLabel?: string }
  /**
   * Horizontal bars: coefficients, importances, or a tornado (`low` and `high` per bar around `base`).
   * Signed bars draw negative values to the left.
   */
  | { kind: 'bars'; labels: string[]; values: number[]; low?: number[]; high?: number[]; base?: number; xFormat?: ValueFormat; xLabel?: string }
  /** Points with an optional fitted line, grouped by colour (clusters, actual against predicted). */
  | { kind: 'scatter'; points: Array<{ x: number; y: number; group?: number; label?: string; tone?: Tone }>; xLabel: string; yLabel: string; groups?: string[]; line?: Array<[number, number]>; xFormat?: ValueFormat; yFormat?: ValueFormat }
  /** Step or smooth curves over a numeric axis (survival, reliability), each with an optional band. */
  | { kind: 'curves'; curves: Array<{ name: string; x: number[]; y: number[]; lower?: number[]; upper?: number[]; step?: boolean }>; xLabel: string; yLabel: string; yPercent?: boolean }
  /** A grid of values (a transition matrix). */
  | { kind: 'matrix'; rows: string[]; cols: string[]; values: number[][]; percent?: boolean };

export interface ModelOutput {
  model: ModelType;
  /** One sentence that answers the question, with the number in it. */
  headline: string;
  /** Up to five more sentences, plain English. */
  sentences: string[];
  /** Headline numbers for the card, two to six. */
  stats: ModelStat[];
  chart: ModelChart | null;
  /** The numbers behind the chart, for the table view and exports. */
  table: { columns: string[]; rows: Array<Array<string | number | null>> };
  /** Cautions: too little data, a setting that was changed, an assumption made. */
  notes: string[];
}

/** A model that cannot run on this data throws this, with a sentence an analyst can act on. */
export class ModelError extends Error {
  override name = 'ModelError';
}

/** A model's entry point. `seed` makes every random step repeatable. */
export type ModelRunner = (data: ModelData, spec: ModelSpec, ctx: ModelContext) => ModelOutput;

export interface ModelContext {
  /** Seed for every random draw (Monte Carlo, bootstrap, forests, LSTM weights). */
  seed: number;
  /** Today, YYYY-MM-DD, for date labels on forecasts. */
  today: string;
}

/** A setting read with a fallback and, for numbers, clamped to a range. */
export function param<T extends ParamValue>(spec: ModelSpec, key: string, fallback: T): T {
  const v = spec.params?.[key];
  return (v === undefined || typeof v !== typeof fallback ? fallback : v) as T;
}

export function numParam(spec: ModelSpec, key: string, fallback: number, min: number, max: number): number {
  const v = spec.params?.[key];
  const n = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

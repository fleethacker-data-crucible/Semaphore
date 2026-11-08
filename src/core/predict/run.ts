// Runs a model by name. The predict worker (web/src/predict-worker.ts) is the usual caller; the page
// calls it directly only where workers are not available (a report opened from disk, the tests).

import { runArima } from './models/arima.ts';
import { runBacklog } from './models/backlog.ts';
import { runBayes } from './models/bayes.ts';
import { runBoosting } from './models/boosting.ts';
import { runBootstrap } from './models/bootstrap.ts';
import { runDecompose } from './models/decompose.ts';
import { runDemand } from './models/demand.ts';
import { runForest } from './models/forest.ts';
import { runKmeans } from './models/kmeans.ts';
import { runLogistic } from './models/logistic.ts';
import { runLstm } from './models/lstm.ts';
import { runMarkov } from './models/markov.ts';
import { runMontecarlo } from './models/montecarlo.ts';
import { runRegression } from './models/regression.ts';
import { runSensitivity } from './models/sensitivity.ts';
import { runSmoothing } from './models/smoothing.ts';
import { runSpc } from './models/spc.ts';
import { runSurvival } from './models/survival.ts';
import { runTree } from './models/tree.ts';
import { runTrend } from './models/trend.ts';
import { runWeibull } from './models/weibull.ts';
import { runAnomaly } from './models/anomaly.ts';
import { nextPeriod, cellLabel } from './data.ts';
import { type ModelContext, type ModelData, ModelError, type ModelOutput, type ModelRunner, type ModelSpec, type ModelType } from './types.ts';

const RUNNERS: Record<ModelType, ModelRunner> = {
  trend: runTrend,
  smoothing: runSmoothing,
  arima: runArima,
  decompose: runDecompose,
  lstm: runLstm,
  montecarlo: runMontecarlo,
  backlog: runBacklog,
  sensitivity: runSensitivity,
  bootstrap: runBootstrap,
  bayes: runBayes,
  spc: runSpc,
  anomaly: runAnomaly,
  regression: runRegression,
  logistic: runLogistic,
  tree: runTree,
  forest: runForest,
  boosting: runBoosting,
  kmeans: runKmeans,
  survival: runSurvival,
  weibull: runWeibull,
  demand: runDemand,
  markov: runMarkov,
};

export type ModelAnswer = { ok: true; output: ModelOutput; ms: number } | { ok: false; error: string; expected: boolean };

/** Runs the model and never throws: a ModelError is an expected answer ("needs 24 months"), anything else a fault. */
export function runModel(data: ModelData, spec: ModelSpec, ctx: ModelContext): ModelAnswer {
  const runner = RUNNERS[spec.type];
  if (!runner) return { ok: false, error: `There is no model called "${String(spec.type)}".`, expected: true };
  const t0 = Date.now();
  const { data: whole, note } = dropUnfinishedPeriod(data, spec.type, ctx.today);
  try {
    const output = runner(whole, spec, ctx);
    if (note) output.notes = [note, ...output.notes];
    return { ok: true, output, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error;
    return err instanceof ModelError ? { ok: false, error: err.message, expected: true } : { ok: false, error: `The model stopped: ${err.message}`, expected: false };
  }
}

/** Models that read a series in date order, where a period still under way would look like a fall. */
const TIME_MODELS: ReadonlySet<ModelType> = new Set<ModelType>(['trend', 'smoothing', 'arima', 'decompose', 'lstm', 'backlog', 'demand', 'spc']);

/**
 * Leaves out the latest period when it is still under way (today falls inside it): a month that is a
 * week old has a week of work orders, which a forecast would read as a collapse.
 */
export function dropUnfinishedPeriod(data: ModelData, type: ModelType, today: string): { data: ModelData; note?: string } {
  const d = data.dims[0];
  if (!TIME_MODELS.has(type) || !d?.grain || !d.isDate || data.dims.length > 2) return { data };
  let last = '';
  for (const r of data.rows) {
    const at = String(r.dims[0] ?? '').slice(0, 10);
    if (at > last) last = at;
  }
  if (!last || !(last <= today && today < nextPeriod(last, d.grain))) return { data };
  const rows = data.rows.filter((r) => String(r.dims[0] ?? '').slice(0, 10) !== last);
  return { data: { ...data, rows }, note: `${cellLabel(last, d.grain)} is not over yet, so it is left out: a part-${d.grain} would look like a fall.` };
}

// Reading a model flag's settings from a saved hoist. Small on purpose: hoist.ts (and so the page's
// start) carries only this; the model list (models.ts) and the models load when first used.

import type { Distribution, ModelInput, ModelSpec, ModelType, ParamValue } from './types.ts';

export const MODEL_TYPES: readonly ModelType[] = ['trend', 'smoothing', 'arima', 'decompose', 'lstm', 'montecarlo', 'backlog', 'sensitivity', 'bootstrap', 'bayes', 'spc', 'anomaly', 'regression', 'logistic', 'tree', 'forest', 'boosting', 'kmeans', 'survival', 'weibull', 'demand', 'markov'];

const DISTRIBUTIONS: readonly Distribution[] = ['triangular', 'pert', 'normal', 'uniform', 'lognormal'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A model spec from untrusted JSON, or null with a warning. Unknown settings are dropped, never run. */
export function parseModelSpec(raw: unknown, warnings: string[], where: string): ModelSpec | null {
  if (!isObject(raw)) return null;
  if (!MODEL_TYPES.includes(raw.type as ModelType)) {
    warnings.push(`${where}: unknown model "${String(raw.type)}", left out.`);
    return null;
  }
  const spec: ModelSpec = { type: raw.type as ModelType };
  if (isObject(raw.params)) {
    const params: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(raw.params).slice(0, 40)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)) continue;
      if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') params[k] = v;
      else if (typeof v === 'string') params[k] = v.slice(0, 40);
    }
    spec.params = params;
  }
  if (Array.isArray(raw.inputs)) {
    const inputs: ModelInput[] = [];
    for (const r of raw.inputs.slice(0, 200)) {
      if (!isObject(r)) continue;
      const nums = [r.low, r.likely, r.high];
      if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      const input: ModelInput = { name: String(r.name ?? '').slice(0, 80) || `Input ${inputs.length + 1}`, low: r.low as number, likely: r.likely as number, high: r.high as number };
      if (DISTRIBUTIONS.includes(r.distribution as Distribution)) input.distribution = r.distribution as Distribution;
      inputs.push(input);
    }
    if (inputs.length) spec.inputs = inputs;
  }
  return spec;
}

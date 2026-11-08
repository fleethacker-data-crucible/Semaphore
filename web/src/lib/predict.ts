// The page's side of the predict worker (web/src/predict-worker.ts): turns a flag's rows into model
// input, asks the worker, and keeps recent answers so a redraw, a theme change or an export does not
// run a model again. The worker starts the first time a model is asked for. Where workers are not
// available (a page opened from disk) the model runs here instead, loaded on demand.

import { useEffect, useState } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import type { ModelAnswer } from '../../../src/core/predict/run.ts';
import type { ModelContext, ModelData, ModelSpec } from '../../../src/core/predict/types.ts';
import type { FlagResult } from './data.ts';

/** Set by web/build.mjs to the hashed predict worker bundle. */
declare const __SEMAPHORE_PREDICT__: string;

/** The flag's rows as a model reads them: its own fields and measures in binding order. */
export function modelData(flag: Flag, result: FlagResult | undefined, index: CatalogIndex): ModelData {
  const b = flag.binding;
  if (!b || !result) return { dims: [], metrics: [], rows: [] };
  const plan = result.plan;
  const own = plan.dimensions.filter((d) => plan.own.includes(d.key));
  return {
    dims: own.map((d) => ({ key: d.key, label: index.field(d.field)?.label ?? d.field, ...(d.grain ? { grain: d.grain } : {}), isDate: !!d.grain || index.field(d.field)?.type === 'date' })),
    metrics: b.metrics.map((k) => {
      const m = index.metric(k);
      return { key: k, label: m?.label ?? k, ...(m?.format ? { format: m.format } : {}) };
    }),
    rows: result.display.rows.map((r) => ({ dims: own.map((d) => r.dims[d.key] ?? null), values: b.metrics.map((k) => r.values[k] ?? null) })),
  };
}

// ---- the worker ------------------------------------------------------------------------------

let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, (a: ModelAnswer) => void>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker !== 'undefined' && typeof location !== 'undefined' && location.protocol !== 'file:' && typeof __SEMAPHORE_PREDICT__ === 'string' ? new Worker(__SEMAPHORE_PREDICT__) : null;
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<{ id: number; answer: ModelAnswer }>) => {
      const done = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      done?.(e.data.answer);
    };
    worker.onerror = (e) => {
      for (const done of waiting.values()) done({ ok: false, error: e.message || 'The model worker stopped.', expected: false });
      waiting.clear();
      // A worker that failed is not used again; later models run on the page.
      worker = null;
    };
  }
  return worker;
}

async function ask(data: ModelData, spec: ModelSpec, ctx: ModelContext): Promise<ModelAnswer> {
  const w = startWorker();
  if (!w) {
    const { runModel } = await import('../../../src/core/predict/run.ts');
    return runModel(data, spec, ctx);
  }
  const id = nextId++;
  return new Promise<ModelAnswer>((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, data, spec, ctx });
  });
}

// ---- answers, kept ---------------------------------------------------------------------------

const CACHE_MAX = 60;
const cache = new Map<string, Promise<ModelAnswer>>();

/** A model's answer for these rows and settings, from the cache when it was asked before. */
export function predict(data: ModelData, spec: ModelSpec, ctx: ModelContext): Promise<ModelAnswer> {
  const key = JSON.stringify([data, spec, ctx]);
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes to the end.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = ask(data, spec, ctx);
  cache.set(key, p);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** Context every flag on the page shares: today, and a seed derived from the flag so results repeat. */
export function modelContext(flag: Flag, today: Date): ModelContext {
  let h = 2166136261;
  for (const ch of flag.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return { seed: h >>> 0 || 1, today: today.toISOString().slice(0, 10) };
}

export type ModelState = { state: 'idle' } | { state: 'running' } | { state: 'done'; answer: ModelAnswer };

/** The model answer for a flag, re-asked when its rows or settings change; the latest ask wins. */
export function useModel(flag: Flag, result: FlagResult | undefined, index: CatalogIndex, today: Date): ModelState {
  const [state, setState] = useState<ModelState>({ state: 'idle' });
  const spec = flag.model;
  const data = modelData(flag, result, index);
  // A model on typed-in inputs (Monte Carlo, sensitivity) runs without rows.
  const ready = !!spec && (!!result || !!spec.inputs?.length);
  const key = ready ? JSON.stringify([data, spec, flag.id, today.toISOString().slice(0, 10)]) : '';
  useEffect(() => {
    if (!ready || !spec) {
      setState({ state: 'idle' });
      return;
    }
    let live = true;
    setState({ state: 'running' });
    predict(data, spec, modelContext(flag, today)).then((answer) => live && setState({ state: 'done', answer }));
    return () => {
      live = false;
    };
    // `key` stands for data, spec and the context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

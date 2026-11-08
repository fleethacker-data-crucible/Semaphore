// The predict worker: runs predictive models (src/core/predict) off the page's thread, so a Monte
// Carlo of 200,000 trials or a forest of 2,000 trees never freezes the page. Its own bundle, loaded
// the first time a model flag is drawn (web/src/lib/predict.ts), so pages without models never pay
// for it. Plain data in and out.

import { runModel } from '../../src/core/predict/run.ts';
import type { ModelContext, ModelData, ModelSpec } from '../../src/core/predict/types.ts';

type Request = { id: number; data: ModelData; spec: ModelSpec; ctx: ModelContext };

// The page tsconfig has the DOM library, not the WebWorker one: the two members used here, typed.
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown): void };

scope.onmessage = (e: MessageEvent<Request>) => {
  const m = e.data;
  scope.postMessage({ id: m.id, answer: runModel(m.data, m.spec, m.ctx) });
};

// The page's side of the CSV worker (web/src/worker.ts). Each request gets a promise; a worker that
// cannot start (an old browser, the page opened from disk) leaves CSV files on the page's thread.

import type { Catalog, FieldType } from '../../../src/core/catalog.ts';
import type { RunResult } from '../../../src/core/engine.ts';
import type { TableProfile } from '../../../src/core/profile.ts';
import type { QueryPlan } from '../../../src/core/planner.ts';
import type { Finding, ValueCount } from '../../../src/core/quality.ts';

/** Set by web/build.mjs to the hashed worker bundle. */
declare const __SEMAPHORE_WORKER__: string;

export interface LoadedCsv {
  name: string;
  rows: number;
  columns: Array<{ name: string; type: FieldType }>;
  profile: TableProfile;
  notes: string[];
}

export class WorkerError extends Error {}

export class CsvWorker {
  private readonly worker: Worker;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(url: string) {
    this.worker = new Worker(url);
    this.worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string; name?: string }>) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data.value);
      else {
        const err = new WorkerError(e.data.error ?? 'The CSV worker failed.');
        if (e.data.name) err.name = e.data.name;
        w.reject(err);
      }
    };
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.reject(new WorkerError(e.message || 'The CSV worker stopped.'));
      this.waiting.clear();
    };
  }

  private ask<T>(msg: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  load(name: string, text: string): Promise<LoadedCsv> {
    return this.ask({ type: 'load', name, text });
  }
  drop(name: string): Promise<boolean> {
    return this.ask({ type: 'drop', name });
  }
  clear(): Promise<boolean> {
    return this.ask({ type: 'clear' });
  }
  run(plan: QueryPlan, catalog: Catalog, today: Date): Promise<RunResult> {
    return this.ask({ type: 'run', plan, catalog, today: today.toISOString() });
  }
  values(table: string, column: string): Promise<ValueCount[]> {
    return this.ask({ type: 'values', table, column });
  }
  duplicates(catalog: Catalog, source: string, table: string): Promise<Finding | null> {
    return this.ask({ type: 'duplicates', catalog, source, table });
  }
}

let shared: CsvWorker | null | undefined;

/** The page's CSV worker, or null when workers are not available here. */
export function csvWorker(): CsvWorker | null {
  if (shared !== undefined) return shared;
  try {
    shared = typeof Worker !== 'undefined' && location.protocol !== 'file:' && typeof __SEMAPHORE_WORKER__ === 'string' ? new CsvWorker(__SEMAPHORE_WORKER__) : null;
  } catch {
    shared = null;
  }
  return shared;
}

// Client for SQL scripts, saved scripts, dataset exports (server/LocalScript.ps1) and pipelines
// (server/Pipeline.ps1). Loaded only by the lazy Script mode, the Pipelines view and the local tables list.

import type { Dialect } from '../../../src/core/catalog.ts';
import type { Pipeline, PipelineRun, StepLog } from '../../../src/core/pipeline.ts';
import type { ScriptPlan } from '../../../src/core/script.ts';
import { api, ApiError, sessionToken } from './api.ts';

export interface ScriptResult {
  line: number;
  kind: 'rows' | 'changes' | 'message';
  ms: number;
  sql?: string;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  changes?: number;
  message?: string;
}

export interface ScriptRun {
  ok: boolean;
  results: ScriptResult[];
  error?: { message: string; line: number; sql: string };
  ms: number;
  tables: string[];
  dropped: string[];
  resultsDropped: number;
}

export interface SavedScript {
  version: 1;
  name: string;
  dialect: Dialect;
  text: string;
  plan?: ScriptPlan;
  /** Parameter values kept with the script (used when a pipeline runs it). */
  params?: Record<string, unknown>;
}

export interface SavedScriptItem {
  id: string;
  name: string;
  dialect: string;
  updated: string;
  runnable: boolean;
}

export const runScript = (plan: ScriptPlan, params: Record<string, unknown>, label?: string) => api<ScriptRun>('/api/local/script-run', { json: { plan, params, ...(label ? { label } : {}) } });
export const listScripts = () => api<SavedScriptItem[]>('/api/local/scripts');
export const loadScript = (id: string) => api<SavedScript>(`/api/local/scripts/${encodeURIComponent(id)}`);
export const saveScript = (id: string, doc: SavedScript) => api<{ ok: boolean; id: string }>(`/api/local/scripts/${encodeURIComponent(id)}`, { method: 'PUT', json: doc });
export const deleteScript = (id: string) => api<{ ok: boolean }>(`/api/local/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const listLocalSources = () => api<{ files: Array<{ name: string; bytes: number; modified: string }> }>('/api/local/sources');

/** A file-safe id from a script's name (the server's ConvertTo-SemScriptId). */
export function scriptId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64) || 'script';
}

// ---- exports -----------------------------------------------------------------------------------
export type ExportFormat = 'csv' | 'parquet' | 'sqlite' | 'xlsx';
export const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; ext: string }> = [
  { id: 'csv', label: 'CSV', ext: '.csv' },
  { id: 'parquet', label: 'Parquet', ext: '.parquet' },
  { id: 'sqlite', label: 'SQLite', ext: '.sqlite' },
  { id: 'xlsx', label: 'Excel (.xlsx)', ext: '.xlsx' },
];

/** Exports a whole local table: the server writes the file and streams it; the browser saves it. Returns the rows and any note. */
export async function downloadLocalTable(table: string, format: ExportFormat): Promise<{ rows: number; note: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = sessionToken();
  if (t) headers['X-Semaphore-Session'] = t;
  const r = await fetch('/api/local/export', { method: 'POST', headers, body: JSON.stringify({ table, format }), cache: 'no-store', redirect: 'error' });
  if (!r.ok) {
    let msg = `The export failed (HTTP ${r.status}).`;
    let code = `HTTP_${r.status}`;
    try {
      const j = (await r.json()) as { error?: string; code?: string };
      if (j.error) msg = j.error;
      if (j.code) code = j.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, code, msg);
  }
  const blob = await r.blob();
  const ext = EXPORT_FORMATS.find((f) => f.id === format)?.ext ?? '';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${table}${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  let note = '';
  try {
    note = decodeURIComponent(r.headers.get('X-Semaphore-Note') ?? '');
  } catch {
    note = '';
  }
  return { rows: Number(r.headers.get('X-Semaphore-Rows') ?? 0), note };
}

// ---- pipelines ---------------------------------------------------------------------------------
export interface PipelineItem {
  id: string;
  name: string;
  steps: number;
  schedule: Pipeline['schedule'] | null;
  lastRun: { run: string; state: string; started: string; finished: string; ms: number; error: string | null; trigger: string } | null;
  running: boolean;
}

export interface PipelineDetail {
  pipeline: Pipeline;
  state: { lastRun: PipelineItem['lastRun']; steps: Record<string, Pick<StepLog, 'state' | 'rows' | 'ms' | 'error'> & { at: string }>; running: boolean };
}

export const listPipelines = () => api<PipelineItem[]>('/api/pipelines');
export const loadPipeline = (id: string) => api<PipelineDetail>(`/api/pipelines/${encodeURIComponent(id)}`);
export const savePipeline = (id: string, p: Pipeline) => api<{ ok: boolean; id: string }>(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'PUT', json: p });
export const deletePipeline = (id: string) => api<{ ok: boolean }>(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const runPipeline = (id: string, opts: { from?: string; force?: boolean } = {}) => api<{ run: string; pipeline: string }>(`/api/pipelines/${encodeURIComponent(id)}/run`, { json: opts });
export const pipelineRuns = (id: string) => api<PipelineRun[]>(`/api/pipelines/${encodeURIComponent(id)}/runs`);
export const pipelineRun = (id: string, run: string) => api<PipelineRun>(`/api/pipelines/${encodeURIComponent(id)}/runs/${encodeURIComponent(run)}`);

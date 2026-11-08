// Client for Semaphore's local database (server/LocalDb.ps1): big files imported on the server and
// queried there with SQL, like any other server source (id 'local'). Uploads go as the raw file
// body (never base64, never read into this page) with XMLHttpRequest, for upload progress.

import { api, ApiError, sessionToken } from './api.ts';

export const LOCAL_SOURCE_ID = 'local';

/** What the file picker offers; the server checks the same list. */
export const LOCAL_ACCEPT = '.csv,.tsv,.txt,.tab,.xlsx,.xlsm,.sqlite,.sqlite3,.db,.parquet,.pq,.arrow,.feather,.gz';
const LOCAL_EXT = /\.(csv|tsv|txt|tab|xlsx|xlsm|sqlite|sqlite3|db|parquet|pq|arrow|feather|ipc)(\.gz)?$/i;

export function isLocalImportFile(name: string): boolean {
  return LOCAL_EXT.test(name);
}

export interface LocalTable {
  name: string;
  type: 'table' | 'view';
  rows: number | null;
  columns: Array<{ name: string; type: string }>;
  bytes: number | null;
  source: string | null;
  path: string | null;
  format: string | null;
  importedAt: string | null;
  etag: string | null;
  fileBytes: number | null;
}

export interface LocalTables {
  tables: LocalTable[];
  databaseBytes: number;
  engine: string;
  /** Parquet and Arrow files can be read (server/Columnar.cs is present). */
  columnar: boolean;
}

export interface ImportStatus {
  job: string;
  state: 'starting' | 'receiving' | 'importing' | 'done' | 'failed';
  file: string;
  phase: string;
  rows: number;
  bytes: number;
  totalBytes: number;
  table: string | null;
  tables: Array<{ name: string; rows: number; columns: number }>;
  columns: number;
  ms: number;
  error: string | null;
  warnings: string[];
}

export const listLocalTables = () => api<LocalTables>('/api/local/tables');
export const importLocalPath = (path: string, opts: { sheet?: string; table?: string; replace?: boolean } = {}) =>
  api<{ job: string; file: string; path: string }>('/api/local/import-path', { json: { path, ...opts } });
export const localSheets = (path: string) => api<{ format: string; sheets: string[] }>('/api/local/sheets', { json: { path } });
export const importStatus = (job: string) => api<ImportStatus>(`/api/local/import-status/${encodeURIComponent(job)}`);
export const cancelImport = (job: string) => api<{ ok: boolean; cancelled: boolean }>('/api/local/import-cancel', { json: { job } });
export const dropLocalTable = (name: string) => api<{ ok: boolean }>(`/api/local/tables/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const renameLocalTable = (name: string, to: string) => api<{ ok: boolean; name: string }>(`/api/local/tables/${encodeURIComponent(name)}/rename`, { json: { name: to } });

/** Sends one file as the request body; resolves with the import job once the server has all of it. */
export function uploadLocalFile(file: File, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<{ job: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/local/import');
    const t = sessionToken();
    if (t) xhr.setRequestHeader('X-Semaphore-Session', t);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      let data: { job?: string; error?: string; code?: string } = {};
      try {
        data = JSON.parse(xhr.responseText || '{}') as typeof data;
      } catch {
        /* not JSON */
      }
      if (xhr.status === 202 && typeof data.job === 'string') resolve({ job: data.job });
      else reject(new ApiError(xhr.status, data.code ?? `HTTP_${xhr.status}`, data.error ?? `The upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The upload stopped: Semaphore closed the connection. A file over the local import limit, or a full disk, does this.'));
    xhr.onabort = () => reject(new DOMException('Stopped.', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Polls an import until it is done or failed. */
export async function waitForImport(job: string, onStatus: (s: ImportStatus) => void, signal?: AbortSignal, everyMs = 500): Promise<ImportStatus> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    const s = await importStatus(job);
    onStatus(s);
    if (s.state === 'done' || s.state === 'failed') return s;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

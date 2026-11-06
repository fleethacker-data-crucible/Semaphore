// Client for the Semaphore loopback server. Every /api call carries the per-session token the
// launcher put in the URL once. With no server (the page opened from disk, or the build
// previewed elsewhere) Semaphore still works on sample data and CSV files, and saves to this
// browser only.

const TOKEN_KEY = 'semaphore.session';
const TAB_KEY = 'semaphore.tab';

export interface ServerSource {
  id: string;
  label: string;
  kind: string;
  provider: string;
  placeholders?: 'question' | 'native';
}

export interface ServerInfo {
  tool: string;
  version: string;
  pid: number;
  port: number;
  home: string;
  autoStop: boolean;
  stay: boolean;
  sources: ServerSource[];
  /** The Windows user running the server: who accepted an entry or asked a question. */
  user?: string;
  /** The named playbook reviewer (settings playbookReviewer). */
  reviewer?: string;
  /** The view this computer opens by default (settings view, or --ask). */
  view?: string;
  /** The skin settings.json fixes for this deployment, or '' to let the analyst choose. */
  skin?: string;
}

export interface StoredItem {
  id: string;
  title: string;
  updated: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let launching: Promise<void> | null = null;

/**
 * Picks up the session for this tab. A launch link carries a single-use launch code (never the
 * session token, which would end up in the browser's command line and in console transcripts);
 * the code is removed from the address bar and traded once for the token with POST /api/launch.
 * A reload or a duplicated tab reuses the token already in sessionStorage. Every api() call waits
 * for the trade to finish.
 */
export function startSession(): Promise<void> {
  if (launching) return launching;
  let code: string | null = null;
  try {
    const url = new URL(window.location.href);
    code = url.searchParams.get('launch');
    if (code) {
      url.searchParams.delete('launch');
      window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    }
  } catch {
    code = null;
  }
  launching = code ? trade(code) : Promise.resolve();
  return launching;
}

async function trade(code: string): Promise<void> {
  try {
    const response = await fetch('/api/launch', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
    if (!response.ok) return; // used or expired: a token already in sessionStorage (reload) still works
    const data = (await response.json()) as { token?: unknown };
    if (typeof data.token === 'string' && data.token) sessionStorage.setItem(TOKEN_KEY, data.token);
  } catch {
    /* no server (file://) or no storage: requests go out without a token and say so */
  }
}

function token(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The session token, for clients that build their own requests (lib/ai.ts). */
export function sessionToken(): string | null {
  return token();
}

function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 12);
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return 'tab';
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (launching) await launching;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const t = token();
  if (t) headers['X-Semaphore-Session'] = t;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const response = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, cache: 'no-store', signal: init.signal ?? null });
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const err = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(response.status, err.code ?? `HTTP_${response.status}`, err.error ?? `Request failed with HTTP ${response.status}`);
  }
  return data as T;
}

/** The server's info, or null when Semaphore is running without one. */
export async function probeServer(): Promise<ServerInfo | null> {
  if (location.protocol === 'file:') return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const info = await api<ServerInfo>('/api/info', { signal: controller.signal });
    clearTimeout(timer);
    return info && info.tool === 'semaphore' ? info : null;
  } catch {
    return null;
  }
}

/**
 * The tab owns the server (TechStack lifecycle rules): a heartbeat every 5 s, and a "leaving"
 * beacon when the page goes away. The beacon cannot set headers, so the token travels in its
 * JSON body, on that one route only.
 */
export function startHeartbeat(onLost: () => void): () => void {
  let failures = 0;
  const beat = async () => {
    try {
      await api('/api/heartbeat', { json: { tab: tabId() } });
      failures = 0;
    } catch {
      failures++;
      if (failures === 3) onLost();
    }
  };
  void beat();
  const timer = setInterval(beat, 5000);
  const leaving = () => {
    try {
      const blob = new Blob([JSON.stringify({ token: token(), tab: tabId() })], { type: 'application/json' });
      navigator.sendBeacon('/api/leaving', blob);
    } catch {
      /* the server stops on its own after the heartbeat timeout */
    }
  };
  window.addEventListener('pagehide', leaving);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pagehide', leaving);
  };
}

export const endSession = () => api<{ ok: boolean }>('/api/end', { json: {} });

export const listItems = (kind: 'hoists' | 'catalogs') => api<StoredItem[]>(`/api/${kind}`);
export const loadItem = <T,>(kind: 'hoists' | 'catalogs', id: string) => api<T>(`/api/${kind}/${encodeURIComponent(id)}`);
export const saveItem = (kind: 'hoists' | 'catalogs', id: string, value: unknown) => api<{ ok: boolean }>(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', json: value });
export const deleteItem = (kind: 'hoists' | 'catalogs', id: string) => api<{ ok: boolean }>(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface QueryResponse {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  truncated: boolean;
  ms: number;
  /** Lake sources (Athena): answered from the result cache, and when it was taken. */
  cached?: boolean;
  asOf?: string;
  /** Lake sources: bytes Athena actually read, and the cost guard's estimate before it ran. */
  scannedBytes?: number;
  estimate?: { bytes: number; usd: number; warnings: string[] };
}

export const runServerQuery = (source: string, sql: string, params: unknown[], rowCap: number, options: { approve?: boolean; signal?: AbortSignal } = {}) =>
  api<QueryResponse>('/api/query', { json: { source, sql, params, rowCap, timeoutSec: 120, ...(options.approve ? { approve: true } : {}) }, ...(options.signal ? { signal: options.signal } : {}) });

export interface ProfileTables {
  tables: Array<{ name: string; schema?: string }>;
}
export interface ProfileTable {
  table: string;
  rows: number | null;
  columns: Array<{ name: string; type: 'number' | 'string' | 'date' | 'boolean'; distinct: number | null; samples: string[] }>;
}
export const profileTables = (source: string) => api<ProfileTables>('/api/profile', { json: { source } });
export const profileTable = (source: string, table: string) => api<ProfileTable>('/api/profile', { json: { source, table } });

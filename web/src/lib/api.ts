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

export function captureSessionToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('session');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('session');
      window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function token(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
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
}

export const runServerQuery = (source: string, sql: string, params: unknown[], rowCap: number, signal?: AbortSignal) =>
  api<QueryResponse>('/api/query', { json: { source, sql, params, rowCap, timeoutSec: 60 }, ...(signal ? { signal } : {}) });

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

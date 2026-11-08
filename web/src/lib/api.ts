// Client for the Semaphore loopback server. Every /api call carries the per-session token the
// launcher put in the URL once. With no server (the page opened from disk, or the build
// previewed elsewhere) Semaphore still works on sample data and CSV files, and saves to this
// browser only.

import { readLocal, writeLocal } from './storage.ts';

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
  /** On a 409 `version`: the ETag of the copy that is in the folder now. */
  readonly etag: string | undefined;
  constructor(status: number, code: string, message: string, etag?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.etag = etag;
  }
}

// ---- Friendly errors (#89) ------------------------------------------------------------------
// One message per failure a person can meet, so no "Failed to fetch" or raw server code reaches
// the page. Server text is only ever shown as plain text.

export const FRIENDLY: Record<string, string> = {
  network: 'Semaphore isn’t answering. It may have stopped, or this computer is busy. Try again in a moment.',
  session: 'This session has ended. Start Semaphore again with Launch-Semaphore.bat; your hoist is kept in this browser.',
  'too-large': 'This is over 2 MB, the most the Semaphore folder takes for one hoist or catalog. Remove some flags or split the page into two hoists.',
  version: 'Someone else saved this since you opened it, so it was not overwritten.',
  'lake-approval': 'This lake query is large, so it waits for you to approve it before it runs.',
  'lake-daily-limit': 'This would pass your daily lake limit. Narrow the query, or wait until tomorrow.',
  'vault-locked': 'Lazarette is locked. Unlock Lazarette, then try again.',
  'vault-item': 'Lazarette could not give a secret this source needs. Check the item in Lazarette, then try again.',
  forbidden: 'Semaphore refused this request: it only answers its own page on this computer. Open Semaphore from Launch-Semaphore.bat.',
  'rate-limited': 'Too many requests at once. Wait a moment and try again.',
  'bad-response': 'Semaphore sent an answer this page could not read. Try again; if it keeps happening, restart Semaphore.',
};

/** Codes whose server message names specifics worth showing (an estimate, an item); the rest read better in our words. */
const SERVER_TEXT_WINS = new Set(['lake-approval', 'lake-daily-limit', 'vault-item']);

const NETWORK_TEXT = /failed to fetch|networkerror|load failed|network request failed|the network connection was lost/i;

/** The message to show a person for any thrown value. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 && !FRIENDLY[e.code]) return FRIENDLY['rate-limited']!;
    const friendly = FRIENDLY[e.code];
    if (friendly && !(SERVER_TEXT_WINS.has(e.code) && e.message)) return friendly;
    if (e.message && e.message !== e.code) return e.message;
    return friendly ?? `Something went wrong (HTTP ${e.status}). Try again.`;
  }
  if (e instanceof Error) {
    if (e.name === 'AbortError') return 'Stopped.';
    if (NETWORK_TEXT.test(e.message)) return FRIENDLY.network!;
    return e.message || 'Something went wrong. Try again.';
  }
  if (typeof e === 'string' && e) return NETWORK_TEXT.test(e) ? FRIENDLY.network! : e;
  return 'Something went wrong. Try again.';
}

// ---- Hooks for the session state machine (lib/session.ts, #87) --------------------------------

export interface ApiHooks {
  /** A request could not reach the server at all. */
  onNetwork?: () => void;
  /** The server answered 401: the session token is gone or wrong. */
  onSession?: () => void;
  /** Any answer from the server (even an error other than 401): it is there. */
  onSuccess?: () => void;
}

let hooks: ApiHooks = {};
export function configureApi(next: ApiHooks): void {
  hooks = next;
}

let launching: Promise<void> | null = null;
let launchedWithCode = false;

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
  launchedWithCode = !!code;
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
    if (!response.ok) return; // used or expired: a token already in sessionStorage (reload) still works;
    // without one, /api/info answers 401 and probeServer reports the session as refused.
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

export interface ApiInit {
  method?: string;
  json?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
  headers?: Record<string, string>;
  /** Do not tell the session machine about a network failure or a 401 (boot probe, heartbeat, client log). */
  quiet?: boolean;
}

async function request(path: string, init: ApiInit = {}): Promise<{ data: unknown; response: Response }> {
  if (!path.startsWith('/api/')) throw new Error('Semaphore only talks to /api/ on its own server.');
  if (launching) await launching;
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
  const t = token();
  if (t) headers['X-Semaphore-Session'] = t;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, cache: 'no-store', redirect: 'error', signal: init.signal ?? null, ...(init.keepalive ? { keepalive: true } : {}) });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e;
    if (!init.quiet) hooks.onNetwork?.();
    throw new ApiError(0, 'network', FRIENDLY.network!);
  }
  const text = await response.text().catch(() => '');
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (response.ok) throw new ApiError(response.status, 'bad-response', FRIENDLY['bad-response']!);
      data = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok) {
    const err = (data ?? {}) as { error?: unknown; code?: unknown; etag?: unknown };
    const code = typeof err.code === 'string' && err.code ? err.code : `HTTP_${response.status}`;
    const message = typeof err.error === 'string' && err.error ? err.error : `Request failed with HTTP ${response.status}`;
    if (response.status === 401 && !init.quiet) hooks.onSession?.();
    else if (!init.quiet) hooks.onSuccess?.();
    throw new ApiError(response.status, code, message, typeof err.etag === 'string' ? unquote(err.etag) : undefined);
  }
  if (!init.quiet) hooks.onSuccess?.();
  return { data, response };
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return (await request(path, init)).data as T;
}

let refused = false;

/**
 * True when a server answered but would not accept this tab: the launch link was already used
 * or has expired, and the tab holds no session from before. The page must say so rather than
 * quietly carry on without the server (no saves, no heartbeat, and the server stops).
 */
export function sessionRefused(): boolean {
  return refused;
}

/** The server's info, or null when Semaphore is running without one (or refused this tab: see sessionRefused). */
export async function probeServer(): Promise<ServerInfo | null> {
  if (location.protocol === 'file:') return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const info = await api<ServerInfo>('/api/info', { signal: controller.signal, quiet: true });
    clearTimeout(timer);
    return info && info.tool === 'semaphore' ? info : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) refused = true;
    return null;
  }
}

/**
 * What one look at the server found, for the session machine: it answered with its info, it
 * refused this tab's session (401), or nothing answered.
 */
export type Probe = { kind: 'ok'; info: ServerInfo } | { kind: 'session' } | { kind: 'network' };
export async function probe(timeoutMs = 4000): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const info = await api<ServerInfo>('/api/info', { signal: controller.signal, quiet: true });
    return info && info.tool === 'semaphore' ? { kind: 'ok', info } : { kind: 'network' };
  } catch (e) {
    return e instanceof ApiError && e.status === 401 ? { kind: 'session' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** True when this page was opened with a launch code (so a refusal means the link was used or expired). */
export function cameWithLaunchCode(): boolean {
  return launchedWithCode;
}

// ---- Presence (#80, contract 3) -------------------------------------------------------------
// The tab owns the server (TechStack lifecycle rules): a heartbeat every 5 s; one at once when the
// page is shown again (pageshow, after a back/forward-cache restore) and when the tab comes back to
// the front (visibilitychange to visible), so a throttled background tab is never late; and a
// "leaving" beacon on pagehide, after which nothing but the beacon goes out until the page is shown
// again (on close the browser fires visibilitychange after pagehide, and a beat then would cancel it).

export const HEARTBEAT_MS = 5000;
export type BeatResult = 'ok' | 'network' | 'session' | 'other';

export interface PresenceEnv {
  beat: () => Promise<BeatResult>;
  leave: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  on: (target: 'window' | 'document', type: string, fn: () => void) => void;
  off: (target: 'window' | 'document', type: string, fn: () => void) => void;
  isHidden: () => boolean;
}

async function beatOnce(): Promise<BeatResult> {
  try {
    await api('/api/heartbeat', { json: { tab: tabId() }, quiet: true });
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError) return e.status === 0 ? 'network' : e.status === 401 ? 'session' : 'other';
    return 'network';
  }
}

function leaveBeacon(): void {
  // The beacon cannot set headers, so the token travels in its JSON body, on that one route only.
  try {
    const blob = new Blob([JSON.stringify({ token: token(), tab: tabId() })], { type: 'application/json' });
    navigator.sendBeacon('/api/leaving', blob);
  } catch {
    /* the server stops on its own after the heartbeat timeout */
  }
}

function browserPresence(): PresenceEnv {
  const target = (t: 'window' | 'document') => (t === 'window' ? window : document);
  return {
    beat: beatOnce,
    leave: leaveBeacon,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    on: (t, type, fn) => target(t).addEventListener(type, fn),
    off: (t, type, fn) => target(t).removeEventListener(type, fn),
    isHidden: () => document.visibilityState === 'hidden',
  };
}

/**
 * Starts the heartbeat and returns the function that stops it for good (End session, or a session
 * that has ended). `onResult` hears how each beat went; lib/session.ts decides what that means.
 */
export function startHeartbeat(onResult: (r: BeatResult) => void, env: PresenceEnv = browserPresence(), intervalMs = HEARTBEAT_MS): () => void {
  let stopped = false;
  let leftPage = false;
  let inFlight = false;
  const send = () => {
    if (stopped || leftPage || inFlight) return;
    inFlight = true;
    env.beat().then(
      (r) => {
        inFlight = false;
        if (!stopped) onResult(r);
      },
      () => {
        inFlight = false;
        if (!stopped) onResult('network');
      },
    );
  };
  const onHide = () => {
    if (stopped) return;
    leftPage = true;
    env.leave();
  };
  const onShow = () => {
    leftPage = false;
    send();
  };
  const onVisibility = () => {
    if (!env.isHidden()) send();
  };
  send();
  const timer = env.setInterval(send, intervalMs);
  env.on('window', 'pagehide', onHide);
  env.on('window', 'pageshow', onShow);
  env.on('document', 'visibilitychange', onVisibility);
  return () => {
    if (stopped) return;
    stopped = true;
    env.clearInterval(timer);
    env.off('window', 'pagehide', onHide);
    env.off('window', 'pageshow', onShow);
    env.off('document', 'visibilitychange', onVisibility);
  };
}

// ---- Client error log (#89, contract 2) -------------------------------------------------------
// A client error leaves one line in the server's log for an admin to read. Never data values:
// quoted text and long numbers are blanked out of the message and the stack, and both are cut short.

export interface ClientError {
  level?: 'error' | 'warn';
  message: string;
  stack?: string;
  view?: string;
}

const LOG_MAX_BYTES = 4096;
const LOG_PER_MINUTE = 10;
const logTimes: number[] = [];
const logSeen = new Set<string>();

/** Blanks anything that could be a data value: quoted text, and numbers of 4 digits or more. */
export function scrubText(text: string): string {
  return text
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`/g, '"…"')
    .replace(/\b\d{4,}(\.\d+)?\b/g, '#');
}

/** The body reportClientError sends: scrubbed, and at most 4 KB as JSON. */
export function clientLogBody(e: ClientError): { level: 'error' | 'warn'; message: string; stack?: string; view?: string } {
  const body: { level: 'error' | 'warn'; message: string; stack?: string; view?: string } = { level: e.level === 'warn' ? 'warn' : 'error', message: scrubText(String(e.message || 'Unknown error')).slice(0, 500) };
  if (e.view) body.view = String(e.view).replace(/[^a-z0-9 _-]/gi, '').slice(0, 40);
  if (e.stack) {
    // Stack lines name files and functions; the page's own URL and its query string are dropped.
    let stack = scrubText(String(e.stack).replace(/https?:\/\/[^/\s)]+/g, '').replace(/\?[^\s):]*/g, ''));
    const room = LOG_MAX_BYTES - new TextEncoder().encode(JSON.stringify({ ...body, stack: '' })).length - 16;
    while (stack && new TextEncoder().encode(JSON.stringify(stack)).length > room) stack = stack.slice(0, Math.floor(stack.length * 0.8));
    if (stack) body.stack = stack;
  }
  return body;
}

/** Writes a client error to the server's log. Never throws; quiet without a session, and at most 10 a minute. */
export function reportClientError(e: ClientError, now = Date.now()): void {
  try {
    if (!token()) return;
    const body = clientLogBody(e);
    const key = `${body.message}|${(body.stack ?? '').slice(0, 200)}`;
    if (logSeen.has(key)) return;
    while (logTimes.length && now - logTimes[0]! > 60_000) logTimes.shift();
    if (logTimes.length >= LOG_PER_MINUTE) return;
    logTimes.push(now);
    logSeen.add(key);
    void api('/api/client-log', { json: body, quiet: true, keepalive: true }).catch(() => undefined);
  } catch {
    /* logging must never break the page */
  }
}

export const endSession = () => api<{ ok: boolean }>('/api/end', { json: {} });

// ---- Documents and their versions (#88, contract 1) -------------------------------------------
// GET sends the stored file's ETag; a save sends it back as If-Match, and the server answers 409
// `version` (with the folder's current ETag) instead of overwriting someone else's save.

export type DocKind = 'hoists' | 'catalogs';
const etags = new Map<string, string>();
const tagKey = (kind: DocKind, id: string) => `${kind}/${id}`;
function unquote(tag: string): string {
  return tag.replace(/^W\//, '').replace(/^"|"$/g, '');
}
export const knownEtag = (kind: DocKind, id: string): string | undefined => etags.get(tagKey(kind, id));
export function rememberEtag(kind: DocKind, id: string, tag: string | null | undefined): void {
  if (tag) etags.set(tagKey(kind, id), unquote(tag));
  else etags.delete(tagKey(kind, id));
  if (kind === 'hoists' && tag) rememberSavedEtag(id, unquote(tag));
}

// The version of the working copy's hoist that this browser last saved or loaded, kept beyond the
// page's life (lib/save-queue.ts readVersion): on the next page load the first save can tell a
// folder copy someone else saved since from the one this browser already knew.
const SAVED_ETAG_KEY = 'semaphore.savedEtag';

export function rememberSavedEtag(id: string, etag: string | null): void {
  if (etag) writeLocal(SAVED_ETAG_KEY, { id, etag });
  else if (savedEtag('hoists', id)) writeLocal(SAVED_ETAG_KEY, null);
}

/** The persisted version for this hoist, or null when this browser never saved or loaded it. */
export function savedEtag(kind: DocKind, id: string): string | null {
  if (kind !== 'hoists') return null;
  const v = readLocal<{ id?: unknown; etag?: unknown }>(SAVED_ETAG_KEY);
  return v && v.id === id && typeof v.etag === 'string' ? v.etag : null;
}

/** True for the 409 a save gets when the folder's copy changed since this page last read or wrote it. */
export function isVersionConflict(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409 && e.code === 'version';
}

export const listItems = (kind: DocKind) => api<StoredItem[]>(`/api/${kind}`);
export async function loadItem<T>(kind: DocKind, id: string): Promise<T> {
  const { data, response } = await request(`/api/${kind}/${encodeURIComponent(id)}`);
  rememberEtag(kind, id, response.headers.get('ETag'));
  return data as T;
}
/**
 * Saves with If-Match when this page knows the version it is replacing. keepalive lets a save
 * started on pagehide finish after the page is gone (bodies up to 64 KB). `overwrite` sends no
 * If-Match: the analyst chose to replace whatever is in the folder.
 */
export async function saveItem(kind: DocKind, id: string, value: unknown, opts: { keepalive?: boolean; overwrite?: boolean } = {}): Promise<{ ok: boolean; etag?: string }> {
  const tag = opts.overwrite ? undefined : knownEtag(kind, id);
  const { data } = await request(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'PUT', json: value, ...(tag ? { headers: { 'If-Match': `"${tag}"` } } : {}), ...(opts.keepalive ? { keepalive: true } : {}) });
  const result = (data ?? { ok: true }) as { ok: boolean; etag?: string };
  if (typeof result.etag === 'string') rememberEtag(kind, id, result.etag);
  return result;
}
export const deleteItem = (kind: DocKind, id: string) => api<{ ok: boolean }>(`/api/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });

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

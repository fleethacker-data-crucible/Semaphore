// The session state machine (#87), after Lazarette's lib/session.svelte.ts. One state at a time:
//
//   boot      -> no-server   nothing answered and this tab never had a session: browser-only mode
//             -> ok          the server answered /api/info
//             -> offline     nothing answered, but this tab came with a launch code or a token
//             -> link-used   401 and the tab came with a launch code: the link was used or expired
//             -> ended       401 with a token from before (a reload after the server restarted)
//   ok        -> offline     two heartbeats in a row, or any other request, could not reach the server
//             -> ended       any request answered 401
//             -> stopped     End session
//   offline   -> ok          any answer from the server (a heartbeat, Try again, the 10 s re-check)
//             -> ended       a 401
//             -> stopped     End session
//   ended, stopped, link-used are final: the heartbeat stops and nothing changes them.
//
// Plain TypeScript with its outside world passed in, so the transitions are tested in Node
// (tests/session.test.ts). hooks/useSession.ts wires it to lib/api.ts and React.

import type { BeatResult, Probe, ServerInfo } from './api.ts';

export type SessionState = 'boot' | 'no-server' | 'ok' | 'offline' | 'ended' | 'stopped' | 'link-used';

export interface SessionSnapshot {
  state: SessionState;
  /** The server's info once it answered (kept through offline, so the page keeps its sources). */
  info: ServerInfo | null;
  /** Offline right after the tab came back from a long spell in the background. */
  background: boolean;
  /** A Try again (or the automatic re-check) is waiting for an answer. */
  retrying: boolean;
  /** When the next automatic re-check runs, while offline. */
  nextCheckAt: number | null;
  /** End session is under way (saving, then stopping the server). */
  ending: boolean;
}

export interface SessionDeps {
  probe: () => Promise<Probe>;
  startHeartbeat: (onResult: (r: BeatResult) => void) => () => void;
  end: () => Promise<unknown>;
  /** The page was opened from disk (file://): there is never a server. */
  isFile: () => boolean;
  /** The page came with a launch code. */
  hadLaunchCode: () => boolean;
  /** The tab holds a session token from before. */
  hadToken: () => boolean;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

export const RECHECK_MS = 10_000;
/** Heartbeat network failures in a row before the page says Semaphore is not answering. */
export const BEAT_FAILURES = 2;
/** A tab hidden at least this long, that finds the server gone within GRACE of coming back, says so. */
export const LONG_HIDDEN_MS = 30_000;
const BACK_GRACE_MS = 15_000;

const FINAL: ReadonlySet<SessionState> = new Set(['ended', 'stopped', 'link-used']);

export interface Session {
  get(): SessionSnapshot;
  subscribe(fn: () => void): () => void;
  boot(): Promise<void>;
  /** Try again now (offline). */
  retry(): Promise<void>;
  /** End session: `flush` sends the pending save first; then the heartbeat stops; then the server is told. */
  end(flush: () => Promise<void>): Promise<void>;
  /** api() hooks. */
  networkFailed(): void;
  sessionRefused(): void;
  serverAnswered(): void;
  /** The tab went to the background (true) or came back (false). */
  visibility(hidden: boolean): void;
  /** Stops timers and the heartbeat (tests, page teardown). */
  dispose(): void;
}

export function createSession(deps: SessionDeps): Session {
  let snap: SessionSnapshot = { state: 'boot', info: null, background: false, retrying: false, nextCheckAt: null, ending: false };
  const listeners = new Set<() => void>();
  let stopBeat: (() => void) | null = null;
  let beatFailures = 0;
  let recheck: unknown = null;
  let hiddenAt: number | null = null;
  let backAt: number | null = null;
  let hiddenFor = 0;

  const set = (patch: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of listeners) fn();
  };
  const final = () => FINAL.has(snap.state);
  const clearRecheck = () => {
    if (recheck !== null) deps.clearTimer(recheck);
    recheck = null;
  };
  const stopHeartbeat = () => {
    stopBeat?.();
    stopBeat = null;
  };
  const finish = (state: 'ended' | 'stopped' | 'link-used') => {
    if (final()) return;
    stopHeartbeat();
    clearRecheck();
    set({ state, retrying: false, nextCheckAt: null, ending: false });
  };
  const scheduleRecheck = () => {
    clearRecheck();
    set({ nextCheckAt: deps.now() + RECHECK_MS });
    recheck = deps.setTimer(() => {
      recheck = null;
      void check();
    }, RECHECK_MS);
  };
  const goOk = (info: ServerInfo | null) => {
    if (final()) return;
    beatFailures = 0;
    clearRecheck();
    set({ state: 'ok', info: info ?? snap.info, background: false, retrying: false, nextCheckAt: null });
    if (!stopBeat) stopBeat = deps.startHeartbeat(onBeat);
  };
  const goOffline = () => {
    if (final() || snap.ending || snap.state === 'no-server' || snap.state === 'boot') return;
    if (snap.state !== 'offline') {
      const background = backAt !== null && hiddenFor >= LONG_HIDDEN_MS && deps.now() - backAt <= BACK_GRACE_MS;
      set({ state: 'offline', background });
    }
    if (recheck === null) scheduleRecheck();
  };
  const onBeat = (r: BeatResult) => {
    if (final()) return;
    if (r === 'session') return finish('ended');
    if (r === 'network') {
      beatFailures++;
      // One lost beat is a hiccup (a PC waking up); a beat just after coming back counts at once.
      const justBack = backAt !== null && deps.now() - backAt <= BACK_GRACE_MS && hiddenFor >= LONG_HIDDEN_MS;
      if (beatFailures >= BEAT_FAILURES || justBack || snap.state === 'offline') goOffline();
      return;
    }
    beatFailures = 0;
    if (snap.state === 'offline') goOk(null);
  };
  const check = async () => {
    if (final() || snap.state !== 'offline') return;
    set({ retrying: true });
    const p = await deps.probe();
    if (final()) return;
    if (p.kind === 'ok') return goOk(p.info);
    if (p.kind === 'session') return finish('ended');
    set({ retrying: false });
    scheduleRecheck();
  };

  return {
    get: () => snap,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async boot() {
      if (snap.state !== 'boot') return;
      if (deps.isFile()) return set({ state: 'no-server' });
      const p = await deps.probe();
      if (snap.state !== 'boot') return;
      if (p.kind === 'ok') return goOk(p.info);
      if (p.kind === 'session') return finish(deps.hadLaunchCode() && !deps.hadToken() ? 'link-used' : 'ended');
      // Nothing answered. A tab that was launched (or had a session) lost its server; any other
      // page is Semaphore without one.
      if (deps.hadLaunchCode() || deps.hadToken()) {
        set({ state: 'offline' });
        scheduleRecheck();
      } else set({ state: 'no-server' });
    },
    retry: () => check(),
    async end(flush) {
      if (snap.state !== 'ok' && snap.state !== 'offline') return;
      if (snap.ending) return;
      set({ ending: true });
      try {
        await flush();
      } catch {
        /* the save reported its own failure; ending goes on, the hoist is kept in this browser */
      }
      stopHeartbeat();
      clearRecheck();
      try {
        await deps.end();
      } catch {
        /* the server may already be gone */
      }
      finish('stopped');
    },
    networkFailed: () => goOffline(),
    sessionRefused() {
      if (snap.state === 'ok' || snap.state === 'offline') finish('ended');
    },
    serverAnswered() {
      if (snap.state === 'offline' && !snap.ending) goOk(null);
    },
    visibility(hidden) {
      const now = deps.now();
      if (hidden) {
        hiddenAt = now;
        backAt = null;
      } else if (hiddenAt !== null) {
        hiddenFor = now - hiddenAt;
        hiddenAt = null;
        backAt = now;
      }
    },
    dispose() {
      stopHeartbeat();
      clearRecheck();
      listeners.clear();
    },
  };
}

/** What each state says, for components/SessionScreen.tsx. Plain words, one next step each. */
export function sessionCopy(s: SessionSnapshot, view: 'builder' | 'ask'): { title: string; body: string } | null {
  const launcher = view === 'ask' ? 'Ask-Semaphore.bat' : 'Launch-Semaphore.bat';
  switch (s.state) {
    case 'offline':
      return s.background
        ? { title: 'Semaphore stopped while this tab was in the background', body: `Try again in case it is still starting up. If it has stopped, start it again with ${launcher}; your hoist is kept in this browser.` }
        : { title: 'Semaphore isn’t answering', body: `It may have stopped, or this computer is busy. This page checks again every 10 seconds. If it has stopped, start it again with ${launcher}; your hoist is kept in this browser.` };
    case 'ended':
      return { title: 'This session has ended', body: `Semaphore no longer knows this tab, usually because it was restarted. Close this tab and start Semaphore again with ${launcher}; your hoist is kept in this browser.` };
    case 'stopped':
      return { title: 'Semaphore has stopped', body: `The session ended and the Semaphore server stopped. Your hoist is kept in this browser and in the Semaphore folder. You can close this tab, or start again with ${launcher}.` };
    case 'link-used':
      return { title: 'This launch link has already been used', body: `Each link from ${launcher} opens one tab, within 10 minutes. Close this tab and start Semaphore again; your hoist is kept in this browser.` };
    default:
      return null;
  }
}

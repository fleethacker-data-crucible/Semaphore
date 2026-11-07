import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BeatResult, Probe, ServerInfo } from '../web/src/lib/api.ts';
import { BEAT_FAILURES, createSession, LONG_HIDDEN_MS, RECHECK_MS, sessionCopy, type SessionDeps } from '../web/src/lib/session.ts';

const INFO = { tool: 'semaphore', version: '1', pid: 1, port: 8800, home: '', autoStop: true, stay: false, sources: [] } as ServerInfo;

// A session with a fake clock, fake timers, a scripted probe and a heartbeat the test drives.
function harness(opts: { probes?: Probe[]; file?: boolean; code?: boolean; token?: boolean } = {}) {
  let now = 1000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const probes = [...(opts.probes ?? [{ kind: 'ok', info: INFO }])];
  const calls = { probe: 0, heartbeats: 0, stopped: 0, end: 0, order: [] as string[] };
  let beat: ((r: BeatResult) => void) | null = null;
  const deps: SessionDeps = {
    probe: async () => {
      calls.probe++;
      return probes.length > 1 ? probes.shift()! : probes[0]!;
    },
    startHeartbeat: (onResult) => {
      calls.heartbeats++;
      beat = onResult;
      return () => {
        calls.stopped++;
        calls.order.push('heartbeat stopped');
        beat = null;
      };
    },
    end: async () => {
      calls.end++;
      calls.order.push('end');
    },
    isFile: () => !!opts.file,
    hadLaunchCode: () => !!opts.code,
    hadToken: () => !!opts.token,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
  };
  const s = createSession(deps);
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
    await new Promise((r) => setImmediate(r));
  };
  return { s, calls, advance, beat: (r: BeatResult) => beat?.(r), probes, timers, setNow: (n: number) => (now = n), get now() { return now; } };
}

test('boot: a server that answers is ok and starts the heartbeat', async () => {
  const h = harness();
  await h.s.boot();
  assert.equal(h.s.get().state, 'ok');
  assert.equal(h.s.get().info, INFO);
  assert.equal(h.calls.heartbeats, 1);
});

test('boot: no server and no session from before is browser-only (no-server)', async () => {
  const h = harness({ probes: [{ kind: 'network' }] });
  await h.s.boot();
  assert.equal(h.s.get().state, 'no-server');
  assert.equal(h.calls.heartbeats, 0);
  const f = harness({ file: true });
  await f.s.boot();
  assert.equal(f.s.get().state, 'no-server');
  assert.equal(f.calls.probe, 0, 'a page opened from disk never asks');
});

test('boot: a launched tab that finds no server is offline, and re-checks every 10 s', async () => {
  const h = harness({ code: true, probes: [{ kind: 'network' }, { kind: 'network' }, { kind: 'ok', info: INFO }] });
  await h.s.boot();
  assert.equal(h.s.get().state, 'offline');
  await h.advance(RECHECK_MS);
  assert.equal(h.s.get().state, 'offline');
  await h.advance(RECHECK_MS);
  assert.equal(h.s.get().state, 'ok');
  assert.equal(h.calls.heartbeats, 1);
});

test('boot: a 401 is link-used with a launch code, ended with a token from before', async () => {
  const a = harness({ code: true, probes: [{ kind: 'session' }] });
  await a.s.boot();
  assert.equal(a.s.get().state, 'link-used');
  const b = harness({ token: true, probes: [{ kind: 'session' }] });
  await b.s.boot();
  assert.equal(b.s.get().state, 'ended');
  assert.equal(b.calls.heartbeats, 0);
});

test('one lost heartbeat is a hiccup; two in a row are offline; any answer recovers', async () => {
  const h = harness();
  await h.s.boot();
  h.beat('network');
  assert.equal(h.s.get().state, 'ok', 'one miss is not enough');
  h.beat('ok');
  for (let i = 0; i < BEAT_FAILURES; i++) h.beat('network');
  assert.equal(h.s.get().state, 'offline');
  assert.ok(h.s.get().nextCheckAt);
  h.beat('ok');
  assert.equal(h.s.get().state, 'ok');
  assert.equal(h.calls.heartbeats, 1, 'the same heartbeat keeps running');
});

test('any other request that cannot reach the server is offline at once; an api answer recovers', async () => {
  const h = harness();
  await h.s.boot();
  h.s.networkFailed();
  assert.equal(h.s.get().state, 'offline');
  h.s.serverAnswered();
  assert.equal(h.s.get().state, 'ok');
});

test('Try again: ok when the server answers, offline (and re-scheduled) when not', async () => {
  const h = harness({ probes: [{ kind: 'ok', info: INFO }, { kind: 'network' }, { kind: 'ok', info: INFO }] });
  await h.s.boot();
  h.s.networkFailed();
  await h.s.retry();
  assert.equal(h.s.get().state, 'offline');
  assert.equal(h.s.get().retrying, false);
  await h.s.retry();
  assert.equal(h.s.get().state, 'ok');
  assert.equal(h.timers.size, 0, 'no re-check left behind');
});

test('a 401 from any request or beat ends the session, for good', async () => {
  const h = harness();
  await h.s.boot();
  h.s.sessionRefused();
  assert.equal(h.s.get().state, 'ended');
  assert.equal(h.calls.stopped, 1, 'the heartbeat stops');
  h.s.serverAnswered();
  h.s.networkFailed();
  assert.equal(h.s.get().state, 'ended', 'final states do not change');
  const b = harness();
  await b.s.boot();
  b.beat('session');
  assert.equal(b.s.get().state, 'ended');
});

test('End session: flush first, then stop the heartbeat, then end; stopped', async () => {
  const h = harness();
  await h.s.boot();
  await h.s.end(async () => {
    h.calls.order.push('flush');
  });
  assert.deepEqual(h.calls.order, ['flush', 'heartbeat stopped', 'end']);
  assert.equal(h.s.get().state, 'stopped');
  h.s.networkFailed();
  assert.equal(h.s.get().state, 'stopped');
});

test('End session still ends when the save or the server fails', async () => {
  const h = harness();
  await h.s.boot();
  await h.s.end(async () => {
    throw new Error('save failed');
  });
  assert.equal(h.s.get().state, 'stopped');
});

test('a network failure while ending does not show offline', async () => {
  const h = harness();
  await h.s.boot();
  let release!: () => void;
  const p = h.s.end(() => new Promise<void>((r) => (release = r)));
  h.s.networkFailed();
  assert.equal(h.s.get().state, 'ok');
  release();
  await p;
  assert.equal(h.s.get().state, 'stopped');
});

test('coming back from a long spell in the background: one failed beat says the server stopped meanwhile', async () => {
  const h = harness();
  await h.s.boot();
  h.s.visibility(true);
  await h.advance(LONG_HIDDEN_MS + 60_000);
  h.s.visibility(false);
  h.beat('network');
  assert.equal(h.s.get().state, 'offline');
  assert.equal(h.s.get().background, true);
  assert.match(sessionCopy(h.s.get(), 'builder')!.title, /background/);
});

test('every state that blocks the page has a title and a next step', () => {
  const base = { info: null, background: false, retrying: false, nextCheckAt: null, ending: false };
  for (const state of ['offline', 'ended', 'stopped', 'link-used'] as const) {
    const c = sessionCopy({ ...base, state }, 'ask');
    assert.ok(c && c.title && /Ask-Semaphore\.bat/.test(c.body), state);
  }
  assert.equal(sessionCopy({ ...base, state: 'ok' }, 'builder'), null);
  assert.equal(sessionCopy({ ...base, state: 'no-server' }, 'builder'), null);
});

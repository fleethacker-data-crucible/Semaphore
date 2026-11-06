import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BeatResult, type PresenceEnv, startHeartbeat } from '../web/src/lib/api.ts';

// Contract 3: beat at once on pageshow and on visibilitychange to visible; never after pagehide.
function env() {
  const listeners = new Map<string, () => void>();
  let tick: (() => void) | null = null;
  let hidden = false;
  const log: string[] = [];
  let answer: BeatResult = 'ok';
  const e: PresenceEnv = {
    beat: async () => {
      log.push('beat');
      return answer;
    },
    leave: () => log.push('leave'),
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    on: (t, type, fn) => listeners.set(`${t}:${type}`, fn),
    off: (t, type) => listeners.delete(`${t}:${type}`),
    isHidden: () => hidden,
  };
  const fire = async (key: string) => {
    listeners.get(key)?.();
    await new Promise((r) => setImmediate(r));
  };
  return { e, log, fire, tick: async () => { tick?.(); await new Promise((r) => setImmediate(r)); }, setHidden: (h: boolean) => (hidden = h), setAnswer: (a: BeatResult) => (answer = a), listeners, get ticking() { return tick !== null; } };
}

test('beats at once, then on the interval, and reports each result', async () => {
  const x = env();
  const results: BeatResult[] = [];
  startHeartbeat((r) => results.push(r), x.e);
  await new Promise((r) => setImmediate(r));
  await x.tick();
  x.setAnswer('network');
  await x.tick();
  assert.deepEqual(results, ['ok', 'ok', 'network']);
});

test('beats at once when the tab comes back to the front, not when it goes to the back', async () => {
  const x = env();
  startHeartbeat(() => undefined, x.e);
  await new Promise((r) => setImmediate(r));
  x.log.length = 0;
  x.setHidden(true);
  await x.fire('document:visibilitychange');
  assert.deepEqual(x.log, []);
  x.setHidden(false);
  await x.fire('document:visibilitychange');
  assert.deepEqual(x.log, ['beat']);
});

test('after pagehide only the leaving signal goes out, until pageshow', async () => {
  const x = env();
  startHeartbeat(() => undefined, x.e);
  await new Promise((r) => setImmediate(r));
  x.log.length = 0;
  await x.fire('window:pagehide');
  assert.deepEqual(x.log, ['leave']);
  x.setHidden(false);
  await x.fire('document:visibilitychange');
  await x.tick();
  assert.deepEqual(x.log, ['leave'], 'no beat after pagehide: it would cancel the leaving signal');
  await x.fire('window:pageshow');
  assert.deepEqual(x.log, ['leave', 'beat'], 'a back/forward-cache restore beats at once');
});

test('stop() ends it for good', async () => {
  const x = env();
  const results: BeatResult[] = [];
  const stop = startHeartbeat((r) => results.push(r), x.e);
  stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(x.ticking, false);
  assert.equal(x.listeners.size, 0);
  assert.deepEqual(results, [], 'a beat that answers after stop is not reported');
});

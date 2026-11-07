// web/src/lib/data.ts: the result cache (expiry, LRU, failed attempts) and selectionsFor().
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFlag } from '../src/core/planner.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { computeFlag, type DataContext, lakeTtl, ResultCache, SERVER_RESULT_TTL_MS, selectionsFor } from '../web/src/lib/data.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

test('result cache: an entry is reused until its time is up, then asked again', async () => {
  let now = 0;
  let asked = 0;
  const c = new ResultCache<number>(10, () => now);
  const make = async () => ++asked;
  assert.equal(await c.remember('q', make, SERVER_RESULT_TTL_MS), 1);
  now = SERVER_RESULT_TTL_MS - 1;
  assert.equal(await c.remember('q', make, SERVER_RESULT_TTL_MS), 1);
  now = SERVER_RESULT_TTL_MS;
  assert.equal(await c.remember('q', make, SERVER_RESULT_TTL_MS), 2);
  // No ttl: kept until cleared (page results carry the data version in their key).
  assert.equal(await c.remember('page', make), 3);
  now = 1e12;
  assert.equal(await c.remember('page', make), 3);
  c.clear();
  assert.equal(await c.remember('page', make), 4);
});

test('result cache: the ttl can come from the answer', async () => {
  let now = 0;
  const c = new ResultCache<{ v: number; good: number }>(10, () => now);
  let n = 0;
  const make = async () => ({ v: ++n, good: 1000 });
  await c.remember('q', make, (r) => r.good);
  now = 999;
  assert.equal((await c.remember('q', make, (r) => r.good)).v, 1);
  now = 1001;
  assert.equal((await c.remember('q', make, (r) => r.good)).v, 2);
});

test('result cache: least recently used goes first', async () => {
  const c = new ResultCache<string>(2);
  let calls = 0;
  const make = (v: string) => async () => (calls++, v);
  await c.remember('a', make('a'));
  await c.remember('b', make('b'));
  await c.remember('a', make('a')); // a hit: a is now the most recent
  await c.remember('c', make('c')); // evicts b, not a
  assert.equal(calls, 3);
  await c.remember('a', make('a'));
  assert.equal(calls, 3, 'a was kept');
  await c.remember('b', make('b'));
  assert.equal(calls, 4, 'b was evicted');
});

test('result cache: a late failure does not drop a newer attempt under the same key', async () => {
  const c = new ResultCache<string>(10);
  let fail!: (e: Error) => void;
  const first = c.remember('q', () => new Promise<string>((_, reject) => (fail = reject)));
  c.clear(); // e.g. Refresh data while the first query is still out
  const second = c.remember('q', async () => 'fresh');
  fail(new Error('timed out'));
  await assert.rejects(first);
  assert.equal(await second, 'fresh');
  let again = 0;
  assert.equal(await c.remember('q', async () => (again++, 'new')), 'fresh');
  assert.equal(again, 0);
  // A failure on its own is dropped, so the next call asks again.
  await assert.rejects(c.remember('x', async () => Promise.reject(new Error('no'))));
  assert.equal(await c.remember('x', async () => 'ok'), 'ok');
});

test('lake answers: good until the server cache expires when it says, else 15 minutes', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(lakeTtl({ asOf: '2026-11-06T11:00:00Z' }, undefined, now), SERVER_RESULT_TTL_MS);
  assert.equal(lakeTtl({ asOf: '2026-11-06T11:00:00Z' }, 12, now), 11 * 3600_000);
  assert.equal(lakeTtl({}, 2, now), 2 * 3600_000);
  assert.equal(lakeTtl({ asOf: '2026-11-05T00:00:00Z' }, 12, now), 0);
  assert.equal(lakeTtl({ asOf: '2026-11-06T11:00:00Z' }, 0, now), SERVER_RESULT_TTL_MS);
});

test('selectionsFor: only selections that can change the flag, in a stable order', async () => {
  const index = loadIndex();
  const hoist = loadHoist();
  const today = new Date('2026-10-26T12:00:00Z');
  const ctx: DataContext = { index, local: fleetSampleRows(today), localSources: new Set(['maint', 'parts']), server: null, today, version: 1 };
  const plan = (id: string) => {
    const p = planFlag(hoist, flag(hoist, id), index);
    assert.ok(p.ok);
    return p.plan;
  };
  const selections = { 'parts.vendor': ['Acme'], 'jobs.ship_class': ['Icebreaker'], 'jobs.region': ['North'], 'jobs.empty': [] };
  // bar-region: region is its own (self-filtering) dimension, ship class a slice; the parts table is not read.
  assert.deepEqual(Object.keys(selectionsFor(plan('bar-region'), selections)), ['jobs.region', 'jobs.ship_class']);
  assert.equal(JSON.stringify(selectionsFor(plan('bar-region'), selections)), JSON.stringify(selectionsFor(plan('bar-region'), { 'jobs.region': ['North'], 'jobs.ship_class': ['Icebreaker'] })));
  // A picker keeps listing every value of its own field.
  assert.deepEqual(Object.keys(selectionsFor(plan('filter-class'), selections)), ['jobs.region']);
  // Selections sent back to the source count too.
  assert.deepEqual(Object.keys(selectionsFor(plan('kpi-hulls'), selections)), ['jobs.region', 'jobs.ship_class']);
  // Fields the flag ignores do not count.
  const line = flag(hoist, 'line-trend');
  assert.deepEqual(Object.keys(selectionsFor(plan('line-trend'), selections, line.behavior.ignore)), ['jobs.ship_class']);
  assert.deepEqual(selectionsFor(plan('bar-region'), { 'parts.vendor': ['Acme'] }), {});
  // The same numbers either way.
  for (const id of ['bar-region', 'kpi-hulls', 'filter-class', 'line-trend']) {
    const f = flag(hoist, id);
    const all = await computeFlag(hoist, f, selections, ctx);
    const some = await computeFlag(hoist, f, selectionsFor(plan(id), selections, f.behavior.ignore), ctx);
    assert.deepEqual(some.display.rows, all.display.rows, id);
  }
});

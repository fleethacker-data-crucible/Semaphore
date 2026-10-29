import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Flag } from '../src/core/hoist.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { computeFlag, type DataContext, DataError } from '../web/src/lib/data.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const today = new Date('2026-10-26T12:00:00Z');
const ctx: DataContext = { index, local: fleetSampleRows(today), localSources: new Set(['maint', 'parts']), server: null, today, version: 1 };

test('a flag runs in the page: plan, engine, cross-filter, SQL for the back of the card', async () => {
  const r = await computeFlag(hoist, flag(hoist, 'bar-region'), {}, ctx);
  assert.equal(r.origin, 'page');
  assert.equal(r.display.rows.length, 6);
  assert.match(r.sql!.sql, /^SELECT "region" AS "d0"/);
  assert.deepEqual(r.requeried, []);
});

test('a selection the cached result cannot answer is asked of the source again', async () => {
  // Hulls affected is a distinct count, so a ship-class selection cannot be re-added locally.
  const all = await computeFlag(hoist, flag(hoist, 'kpi-hulls'), {}, ctx);
  const one = await computeFlag(hoist, flag(hoist, 'kpi-hulls'), { 'jobs.ship_class': ['Icebreaker'] }, ctx);
  assert.deepEqual(one.requeried, ['jobs.ship_class']);
  assert.ok((one.display.rows[0]!.values.hulls_affected as number) < (all.display.rows[0]!.values.hulls_affected as number));
  assert.equal(one.display.rows[0]!.values.hulls_affected, 15, '180 hulls over 12 classes');
});

test('comparisons come back lined up with the current rows', async () => {
  const f: Flag = { ...flag(hoist, 'bar-region'), binding: { ...flag(hoist, 'bar-region').binding!, compare: 'previous-period' } };
  const r = await computeFlag(hoist, f, {}, ctx);
  assert.equal(r.previous?.length, r.display.rows.length);
  assert.ok(r.previous!.every((p) => typeof p?.labor_cost === 'number'));
});

test('a source with no server says how to reach it', async () => {
  const away: DataContext = { ...ctx, localSources: new Set(), version: 2 };
  await assert.rejects(computeFlag(hoist, flag(hoist, 'bar-region'), {}, away), (e: Error) => e instanceof DataError && /needs the Semaphore server/.test(e.message));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hoist } from '../src/core/hoist.ts';
import { cachedSliceKey, flagKeys, planSlice, planSliceKey, relevantSelections } from '../web/src/lib/relevance.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();

function withPartsFlag(h: Hoist): Hoist {
  const parts = { ...flag(h, 'kpi-hulls'), id: 'kpi-parts', title: 'Parts on hand', binding: { metrics: ['parts_on_hand'], dimensions: [], filters: [] } };
  return { ...h, flags: [...h.flags, parts] };
}

test('plan slice: a title, a brief or a layout change keeps the key; a page filter or a selecting flag changes it', () => {
  const key = planSliceKey(hoist);
  assert.equal(planSliceKey({ ...hoist, title: 'Another title', brief: 'typing…' }), key);
  assert.equal(planSliceKey({ ...hoist, flags: hoist.flags.map((f) => ({ ...f, title: `${f.title}!`, brief: 'x', layout: { ...f.layout, x: 0 } })) }), key);
  assert.notEqual(planSliceKey({ ...hoist, filters: [] }), key);
  assert.notEqual(planSliceKey({ ...hoist, flags: hoist.flags.map((f) => (f.id === 'bar-region' ? { ...f, behavior: { ...f.behavior, onClick: 'none' as const } } : f)) }), key);
  assert.equal(cachedSliceKey(hoist), key);
  const slice = planSlice(hoist);
  assert.equal(slice.title, '');
  assert.deepEqual(slice.flags.map((f) => f.id).sort(), ['bar-region', 'filter-class']);
});

test('relevant selections: a pick on a table the flag does not read is dropped', () => {
  const h = withPartsFlag(hoist);
  const slice = planSlice(h);
  const key = planSliceKey(h);
  const picked = { 'jobs.ship_class': ['Frigate'] };
  const parts = flagKeys(slice, key, flag(h, 'kpi-parts'), index);
  assert.deepEqual(relevantSelections(picked, parts, flag(h, 'kpi-parts').behavior), {});
  const orders = flagKeys(slice, key, flag(h, 'kpi-orders'), index);
  assert.deepEqual(relevantSelections(picked, orders, flag(h, 'kpi-orders').behavior), picked);
});

test('relevant selections: ignored fields and empty picks are dropped; output is in key order', () => {
  const trend = flag(hoist, 'line-trend'); // ignores jobs.region
  const keys = flagKeys(planSlice(hoist), planSliceKey(hoist), trend, index);
  const out = relevantSelections({ 'jobs.ship_class': ['Cutter'], 'jobs.region': ['Gulf'], 'jobs.status': [] }, keys, trend.behavior);
  assert.deepEqual(out, { 'jobs.ship_class': ['Cutter'] });
  assert.deepEqual(Object.keys(relevantSelections({ b: ['1'], a: ['2'] }, new Set(['a', 'b']), { ignore: [] })), ['a', 'b']);
  assert.deepEqual(relevantSelections({ a: ['1'] }, null, { ignore: [] }), {});
});

test('flag keys are cached per flag object and plan slice', () => {
  const slice = planSlice(hoist);
  const key = planSliceKey(hoist);
  const f = flag(hoist, 'bar-region');
  assert.equal(flagKeys(slice, key, f, index), flagKeys(slice, key, f, index));
  assert.ok(flagKeys(slice, key, f, index)!.has('jobs.region'));
  assert.equal(flagKeys(slice, key, flag(hoist, 'empty-1'), index), null);
});

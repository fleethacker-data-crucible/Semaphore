// Page snapshots on the page side (web/src/lib/page-snapshots.ts): the catalog fingerprint, what a
// restore would change, and the automatic snapshot's own 10-minute rule before it asks the server.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Catalog } from '../src/core/catalog.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { AUTO_GAP_MS, autoSnapshot, catalogVersion, compareHoists } from '../web/src/lib/page-snapshots.ts';

const catalog: Catalog = { version: 1, sources: [], fields: [], metrics: [] };
const flag = (id: string, title: string, extra: Partial<Flag> = {}): Flag => ({ id, kind: 'bar', title, brief: '', layout: { x: 0, y: 0, w: 4, h: 4 }, binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'empty', notes: [], ...extra });
const hoist = (flags: Flag[], id = 'h1'): Hoist => ({ version: 1, id, title: 'T', brief: '', grid: { cols: 12 }, filters: [], flags, updated: '' });

test('the catalog version is a short hex fingerprint that changes with the catalog', () => {
  const a = catalogVersion(catalog);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(catalogVersion({ ...catalog }), a);
  assert.notEqual(catalogVersion({ ...catalog, metrics: [{ key: 'm', label: 'M', agg: 'count', source: 's' }] }), a);
});

test('compareHoists says what a restore brings back, takes away and changes', () => {
  const now = hoist([flag('a', 'Kept'), flag('b', 'New since'), flag('c', 'Moved', { layout: { x: 4, y: 0, w: 4, h: 4 } })]);
  const then = hoist([flag('a', 'Kept', { notes: ['drafted'] }), flag('c', 'Moved'), flag('d', 'Deleted since')]);
  assert.deepEqual(compareHoists(now, then), { added: ['Deleted since'], removed: ['New since'], changed: ['Moved'] });
});

test('an automatic snapshot skips an empty page and a page snapshotted in the last 10 minutes, without asking the server', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await autoSnapshot(hoist([], 'empty'), catalog, 'Tidy up', 1_000);
    assert.equal(calls.length, 0, 'nothing to keep on an empty page');
    await autoSnapshot(hoist([flag('a', 'A')], 'busy'), catalog, 'Tidy up', 1_000);
    await autoSnapshot(hoist([flag('a', 'A')], 'busy'), catalog, 'Changing the layout', 1_000 + AUTO_GAP_MS - 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], '/api/page-snapshots/busy');
    await autoSnapshot(hoist([flag('a', 'A')], 'busy'), catalog, 'Flying a kit', 1_000 + AUTO_GAP_MS);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

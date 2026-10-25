import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, isIdentifier } from '../src/core/catalog.ts';
import { parseHoist, toneFor } from '../src/core/hoist.ts';
import { compact, findSlot, isValidLayout, place } from '../src/core/layout.ts';
import { loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

test('example catalog is clean', () => {
  assert.deepEqual(checkCatalog(loadCatalog()), []);
});

test('catalog check catches unsafe names and dangling references', () => {
  const c = loadCatalog();
  c.fields.push({ key: 'bad', label: 'Bad', source: 'maint', table: 'x"; DROP TABLE y; --', column: 'a', type: 'string' });
  c.metrics.push({ key: 'm', label: 'M', agg: 'sum', field: 'nope', source: 'maint' });
  c.metrics.push({ key: 'rows', label: 'Rows', agg: 'avg', source: 'maint', table: 't' });
  const problems = checkCatalog(c).join('\n');
  assert.match(problems, /will not quote safely/);
  assert.match(problems, /unknown field "nope"/);
  assert.match(problems, /needs a field for avg/);
});

test('identifiers: plain, spaced and schema-qualified names pass; quotes and brackets do not', () => {
  assert.ok(isIdentifier('ops.work_orders'));
  assert.ok(isIdentifier('Item Name'));
  for (const bad of ['a"b', 'a]b', 'a;b', '1abc', 'a.b.c', '', 'a--b']) assert.equal(isIdentifier(bad), false, bad);
});

test('example hoist parses with no warnings', () => {
  const h = loadHoist();
  assert.equal(h.flags.length, 7);
  assert.equal(h.flags.find((f) => f.id === 'empty-1')?.status, 'empty');
});

test('bad flags are dropped and bad references removed, with a warning for each', () => {
  const index = loadIndex();
  const { hoist, warnings } = parseHoist(
    {
      version: 1,
      id: 'h',
      flags: [
        { id: 'ok', kind: 'bar', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', binding: { metrics: ['labor_cost', 'made_up'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.region', grain: 'month' }] } },
        { id: 'ok', kind: 'bar', layout: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'weird', kind: 'hologram', layout: { x: 0, y: 0, w: 1, h: 1 } },
        { id: 'nolayout', kind: 'kpi' },
        'not a flag',
      ],
    },
    index,
  );
  assert.ok(hoist);
  assert.deepEqual(hoist.flags.map((f) => f.id), ['ok']);
  const ok = hoist.flags[0]!;
  assert.deepEqual(ok.binding?.metrics, ['labor_cost']);
  assert.deepEqual(ok.binding?.dimensions, [{ field: 'jobs.region' }]);
  assert.equal(ok.status, 'drafted', 'a ready flag that lost references needs review');
  const all = warnings.join('\n');
  for (const w of [/unknown metric "made_up"/, /grain ignored/, /duplicate id/, /unknown kind/, /invalid layout/, /not an object/]) assert.match(all, w);
});

test('non-hoists are rejected outright', () => {
  assert.equal(parseHoist(null).hoist, null);
  assert.equal(parseHoist({ version: 2 }).hoist, null);
});

test('"last" filters need a date field, a whole count and a unit', () => {
  const index = loadIndex();
  const { hoist, warnings } = parseHoist(
    {
      version: 1,
      filters: [
        { field: 'jobs.opened', op: 'last', values: [12], unit: 'month' },
        { field: 'jobs.region', op: 'last', values: [12], unit: 'month' },
        { field: 'jobs.opened', op: 'last', values: [1.5], unit: 'month' },
        { field: 'jobs.region', op: 'between', values: ['a'] },
      ],
    },
    index,
  );
  assert.equal(hoist?.filters.length, 1);
  assert.equal(warnings.length, 3);
});

test('thresholds: first match wins', () => {
  const b = { onClick: 'none' as const, ignore: [], thresholds: [
    { metric: 'm', op: 'lt' as const, value: 10, tone: 'bad' as const },
    { metric: 'm', op: 'lt' as const, value: 20, tone: 'warn' as const },
  ] };
  assert.equal(toneFor(b, 'm', 5), 'bad');
  assert.equal(toneFor(b, 'm', 15), 'warn');
  assert.equal(toneFor(b, 'm', 25), null);
});

test('layout: findSlot fills gaps left to right, top to bottom', () => {
  const items = [{ id: 'a', layout: { x: 0, y: 0, w: 6, h: 2 } }];
  assert.deepEqual(findSlot(items, 6, 2, 12), { x: 6, y: 0, w: 6, h: 2 });
  assert.deepEqual(findSlot(items, 8, 2, 12), { x: 0, y: 2, w: 8, h: 2 });
});

test('layout: dropping onto a flag pushes it down, then everything floats up', () => {
  const items = [
    { id: 'a', layout: { x: 0, y: 0, w: 6, h: 2 } },
    { id: 'b', layout: { x: 6, y: 0, w: 6, h: 2 } },
    { id: 'c', layout: { x: 0, y: 2, w: 12, h: 3 } },
  ];
  const out = place(items, 'c', { x: 0, y: 0, w: 6, h: 3 }, 12);
  assert.ok(isValidLayout(out, 12));
  const at = (id: string) => out.find((p) => p.id === id)!.layout;
  assert.deepEqual(at('c'), { x: 0, y: 0, w: 6, h: 3 });
  assert.deepEqual(at('a'), { x: 0, y: 3, w: 6, h: 2 });
  assert.deepEqual(at('b'), { x: 6, y: 0, w: 6, h: 2 });
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'c'], 'original order is kept');
});

test('layout: out-of-grid targets are clamped and the result never overlaps', () => {
  const items = [
    { id: 'a', layout: { x: 0, y: 0, w: 4, h: 2 } },
    { id: 'b', layout: { x: 4, y: 0, w: 4, h: 2 } },
    { id: 'c', layout: { x: 8, y: 0, w: 4, h: 2 } },
  ];
  for (let x = -2; x < 14; x += 3) {
    for (let w = 1; w < 16; w += 4) {
      const out = place(items, 'b', { x, y: 0, w, h: 3 }, 12);
      assert.ok(isValidLayout(out, 12), `x=${x} w=${w}`);
    }
  }
  assert.deepEqual(compact([{ id: 'z', layout: { x: 2, y: 9, w: 2, h: 2 } }])[0]!.layout, { x: 2, y: 0, w: 2, h: 2 });
});

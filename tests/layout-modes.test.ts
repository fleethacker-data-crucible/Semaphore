// Layout modes: snap keeps flags where they are put (gaps stay), free places anywhere in eighth-cell
// steps and allows overlaps, auto tidies as it always has. Hoists keep their mode when saved.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHoist } from '../src/core/hoist.ts';
import { compact, FREE_STEP, isValidLayout, place, relayout, snapAll, type Placed } from '../src/core/layout.ts';

const items = (): Placed[] => [
  { id: 'a', layout: { x: 0, y: 0, w: 4, h: 2 } },
  { id: 'b', layout: { x: 4, y: 0, w: 4, h: 2 } },
  { id: 'c', layout: { x: 0, y: 2, w: 4, h: 2 } },
];
const at = (ps: Placed[], id: string) => ps.find((p) => p.id === id)!.layout;

test('snap: a flag dropped lower stays there, leaving the gap above it', () => {
  const out = place(items(), 'b', { x: 4, y: 6, w: 4, h: 2 }, 12, 'snap');
  assert.deepEqual(at(out, 'b'), { x: 4, y: 6, w: 4, h: 2 });
  assert.deepEqual(at(out, 'a'), { x: 0, y: 0, w: 4, h: 2 });
  // Auto floats it straight back up.
  assert.equal(at(place(items(), 'b', { x: 4, y: 6, w: 4, h: 2 }, 12, 'auto'), 'b').y, 0);
});

test('snap: dropping on a flag pushes it down just far enough, and nothing floats up', () => {
  const out = place(items(), 'b', { x: 0, y: 1, w: 4, h: 2 }, 12, 'snap');
  assert.deepEqual(at(out, 'b'), { x: 0, y: 1, w: 4, h: 2 });
  assert.equal(at(out, 'a').y, 3, 'a is pushed below b');
  assert.equal(at(out, 'c').y, 5, 'c is pushed below a');
  assert.ok(isValidLayout(out, 12, 'snap'));
});

test('snap rounds to whole cells and keeps flags inside the grid', () => {
  const out = place(items(), 'a', { x: 10.4, y: 3.6, w: 4, h: 2 }, 12, 'snap');
  assert.deepEqual(at(out, 'a'), { x: 8, y: 4, w: 4, h: 2 });
});

test('free: only the moved flag changes, in eighth-cell steps, and overlaps are allowed', () => {
  const out = place(items(), 'b', { x: 1.3, y: 0.55, w: 4, h: 2 }, 12, 'free');
  assert.deepEqual(at(out, 'b'), { x: 1.25, y: 0.5, w: 4, h: 2 });
  assert.deepEqual(at(out, 'a'), items()[0]!.layout);
  assert.deepEqual(at(out, 'c'), items()[2]!.layout);
  assert.ok(isValidLayout(out, 12, 'free'));
  assert.equal(isValidLayout(out, 12, 'snap'), false);
  assert.equal(FREE_STEP, 0.125);
});

test('switching from free snaps to cells and moves overlaps down; switching to auto tidies', () => {
  const free: Placed[] = [
    { id: 'a', layout: { x: 0.25, y: 0.125, w: 4, h: 2 } },
    { id: 'b', layout: { x: 1, y: 1, w: 4, h: 2 } },
    { id: 'c', layout: { x: 6, y: 8, w: 2, h: 2 } },
  ];
  const snapped = snapAll(free, 12);
  assert.ok(isValidLayout(snapped, 12, 'snap'));
  assert.equal(at(snapped, 'b').y, 2, 'b moves below a');
  assert.equal(at(snapped, 'c').y, 8, 'c keeps its gap');
  assert.equal(at(relayout(free, 12, 'auto'), 'c').y, 0, 'auto floats c up');
  assert.deepEqual(relayout(free, 12, 'free'), free);
  assert.deepEqual(compact(snapped).map((p) => p.id), ['a', 'b', 'c']);
});

const hoistWith = (grid: Record<string, unknown>, layouts: Array<Record<string, number>>) =>
  parseHoist({ version: 1, id: 'h', title: 'T', brief: '', grid, filters: [], updated: '', flags: layouts.map((layout, i) => ({ id: `f${i}`, kind: 'text', title: '', brief: '', layout, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'ready', notes: [] })) });

test('a free hoist keeps its fractional, overlapping layout through a save and load', () => {
  const r = hoistWith({ cols: 12, mode: 'free' }, [{ x: 0.5, y: 0.25, w: 3.375, h: 2 }, { x: 1, y: 1, w: 4, h: 2 }]);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.hoist!.grid.mode, 'free');
  assert.deepEqual(r.hoist!.flags[0]!.layout, { x: 0.5, y: 0.25, w: 3.375, h: 2 });
  assert.deepEqual(r.hoist!.flags[1]!.layout, { x: 1, y: 1, w: 4, h: 2 });
  const again = parseHoist(JSON.parse(JSON.stringify(r.hoist)));
  assert.deepEqual(again.hoist!.flags.map((f) => f.layout), r.hoist!.flags.map((f) => f.layout));
});

test('a hoist with no mode is snap, and its overlaps are fixed without closing its gaps', () => {
  const r = hoistWith({ cols: 12 }, [{ x: 0, y: 0, w: 4, h: 2 }, { x: 2, y: 1, w: 4, h: 2 }, { x: 8, y: 9, w: 2, h: 2 }]);
  assert.equal(r.hoist!.grid.mode, undefined, 'snap is the default and is not written');
  assert.equal(r.hoist!.flags[1]!.layout.y, 2);
  assert.equal(r.hoist!.flags[2]!.layout.y, 9, 'the gap above the third flag stays');
  // An unknown mode is read as snap; fractions in a snap hoist are not valid and the flag is dropped with a warning.
  const bad = hoistWith({ cols: 12, mode: 'wild' }, [{ x: 0.5, y: 0, w: 4, h: 2 }]);
  assert.equal(bad.hoist!.flags.length, 0);
  assert.ok(bad.warnings.some((w) => /invalid layout/.test(w)));
});

test('an auto hoist still tidies overlaps up', () => {
  const r = hoistWith({ cols: 12, mode: 'auto' }, [{ x: 0, y: 0, w: 4, h: 2 }, { x: 8, y: 9, w: 2, h: 2 }, { x: 0, y: 1, w: 4, h: 2 }]);
  assert.equal(r.hoist!.grid.mode, 'auto');
  assert.equal(r.hoist!.flags[1]!.layout.y, 0);
});

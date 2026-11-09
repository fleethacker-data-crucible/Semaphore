import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lineage, LineageKind } from '../src/core/lineage.ts';
import { crossings, layoutLineage } from '../src/core/lineage-layout.ts';

const BOX_W = 176;
const BOX_H = 28;
const COL_W = 210;

function graph(nodes: Array<[string, LineageKind]>, edges: Array<[string, string, boolean?]>): Lineage {
  return { nodes: nodes.map(([id, kind]) => ({ id, kind, label: id })), edges: edges.map(([from, to, join]) => (join ? { from, to, join } : { from, to })) };
}

// A page like the fleet example: two tables, fields, a formula measure, and flags that split by fields
// directly (lines that skip the measure column) and a count measure on a table (skips the field column).
const fleet = graph(
  [
    ['s:db', 'source'],
    ['t:jobs', 'table'], ['t:hulls', 'table'],
    ['f:region', 'field'], ['f:cost', 'field'], ['f:class', 'field'], ['f:month', 'field'],
    ['m:labor', 'metric'], ['m:hulls', 'metric'], ['m:per', 'metric'], ['m:count', 'metric'],
    ['g:1', 'flag'], ['g:2', 'flag'], ['g:3', 'flag'], ['g:4', 'flag'],
  ],
  [
    ['s:db', 't:jobs'], ['s:db', 't:hulls'], ['t:jobs', 't:hulls', true],
    ['t:jobs', 'f:region'], ['t:jobs', 'f:cost'], ['t:hulls', 'f:class'], ['t:jobs', 'f:month'],
    ['f:cost', 'm:labor'], ['t:hulls', 'm:hulls'], ['m:labor', 'm:per'], ['m:hulls', 'm:per'], ['t:jobs', 'm:count'],
    ['m:labor', 'g:1'], ['f:region', 'g:1'], ['m:per', 'g:2'], ['f:class', 'g:2'], ['m:count', 'g:3'], ['f:month', 'g:3'], ['m:labor', 'g:4'], ['f:month', 'g:4'],
  ],
);

/** The points a path passes through (move, line and curve end points; not curve control points). */
function points(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const seg of d.match(/[MLC][^MLC]*/g)!) {
    const nums = seg.slice(1).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    out.push([nums[nums.length - 2]!, nums[nums.length - 1]!]);
  }
  return out;
}

/** Every number pair in a path, control points included (arcs are checked by their first and last). */
function allPairs(d: string): Array<[number, number]> {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

test('boxes in one column never overlap and keep their spacing', () => {
  const l = layoutLineage(fleet, { flagOrder: ['g:1', 'g:2', 'g:3', 'g:4'] });
  const byX = new Map<number, number[]>();
  for (const b of l.boxes.values()) (byX.get(b.x) ?? byX.set(b.x, []).get(b.x)!).push(b.y);
  for (const ys of byX.values()) {
    ys.sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i]! - ys[i - 1]! >= BOX_H, `boxes ${ys[i - 1]} and ${ys[i]} overlap`);
  }
  assert.ok([...l.boxes.values()].every((b) => b.y >= 30), 'nothing above the column titles');
});

test('a line that skips a column runs through a gap, never over a box', () => {
  const l = layoutLineage(fleet, { flagOrder: ['g:1', 'g:2', 'g:3', 'g:4'] });
  for (const line of l.lines.filter((x) => x.kind === 'flow')) {
    for (const [x, y] of points(line.d)) {
      for (const b of l.boxes.values()) {
        if (b.id === line.from || b.id === line.to) continue;
        const inside = x > b.x + 0.5 && x < b.x + BOX_W - 0.5 && y > b.y && y < b.y + BOX_H;
        assert.ok(!inside, `${line.from} > ${line.to} passes over ${b.id}`);
      }
      // Waypoints sit at column edges, not inside a box column.
      const xm = Math.round(x % COL_W);
      assert.ok(xm === 0 || xm === BOX_W, `waypoint at x=${x} is not on a column edge`);
    }
  }
});

test('joins and formula links are arcs to the right of their own column', () => {
  const l = layoutLineage(fleet);
  const join = l.lines.find((x) => x.kind === 'join')!;
  const formula = l.lines.filter((x) => x.kind === 'within');
  assert.equal(formula.length, 2, 'labor > per and hulls > per');
  for (const arc of [join, ...formula]) {
    const [start, , , end] = allPairs(arc.d);
    assert.equal(start![0], end![0], 'starts and ends on the same edge');
    assert.equal(Math.round(start![0] % COL_W), BOX_W, 'on the right edge of the column');
  }
});

test('several lines leaving one box fan out along its edge', () => {
  const l = layoutLineage(fleet, { flagOrder: ['g:1', 'g:2', 'g:3', 'g:4'] });
  const fromJobs = l.lines.filter((x) => x.from === 't:jobs' && x.kind === 'flow').map((x) => points(x.d)[0]![1]);
  assert.equal(new Set(fromJobs).size, fromJobs.length, 'each line leaves from its own point');
});

test('ordering keeps crossings low and flags keep the page order', () => {
  const l = layoutLineage(fleet, { flagOrder: ['g:1', 'g:2', 'g:3', 'g:4'] });
  const flags = ['g:1', 'g:2', 'g:3', 'g:4'].map((id) => l.boxes.get(id)!.y);
  assert.deepEqual([...flags].sort((a, b) => a - b), flags, 'flags top to bottom in page order');
  // Labor feeds flags 1 and 4 and flags keep the page order, so a few crossings are unavoidable here.
  assert.ok(crossings(l, fleet) <= 5, `crossings: ${crossings(l, fleet)}`);
});

test('an empty graph and a single box are laid out without errors', () => {
  assert.equal(layoutLineage({ nodes: [], edges: [] }).boxes.size, 0);
  const one = layoutLineage(graph([['g:1', 'flag']], []));
  assert.equal(one.boxes.get('g:1')!.y, 30);
});

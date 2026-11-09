// Where the lineage boxes and lines go (src/core/lineage.ts builds the graph; LineageView draws this).
// A small layered layout, the usual way for left-to-right flow charts:
//   - a line that skips a column (a field straight to a flag, a table straight to a count measure) gets a
//     waypoint in every column it passes, so it runs through the gaps between boxes, never over a box;
//   - lines within one column (joins between tables, a formula measure built on others) are arcs out to
//     the right of that column, never back through the boxes;
//   - each column is ordered to cross fewer lines (sweeps right-to-left and left-to-right by the average
//     position of neighbours), then each box is moved level with what it connects to, keeping order and
//     spacing;
//   - where several lines leave or enter one box they fan out along its edge, ordered by the other end,
//     so they do not pile up on one point.
// Pure: same input, same picture. Positions are in pixels from the top-left of the drawing.

import { LINEAGE_COLUMNS, type Lineage, type LineageKind } from './lineage.ts';

export interface LineageLayoutOptions {
  colWidth: number;
  boxWidth: number;
  boxHeight: number;
  /** Least distance between the tops of two boxes in one column. */
  rowGap: number;
  /** Least distance between a waypoint and its neighbour in a column. */
  laneGap: number;
  top: number;
  /** Flags in this order (the page's order) before any reordering. */
  flagOrder?: string[];
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
}

export interface PlacedLine {
  from: string;
  to: string;
  /** join: an arc between tables; within: an arc between two boxes of one column (a formula). */
  kind: 'flow' | 'join' | 'within';
  /** The SVG path. */
  d: string;
}

export interface LineageLayout {
  boxes: Map<string, PlacedBox>;
  lines: PlacedLine[];
  width: number;
  height: number;
}

interface Slot {
  id: string;
  /** A waypoint of a line that skips this column, rather than a box. */
  dummy: boolean;
  y: number;
}

const DEFAULTS: LineageLayoutOptions = { colWidth: 210, boxWidth: 176, boxHeight: 28, rowGap: 38, laneGap: 12, top: 30 };

export function layoutLineage(lineage: Lineage, options: Partial<LineageLayoutOptions> = {}): LineageLayout {
  const o = { ...DEFAULTS, ...options };
  const colOf = new Map<string, number>();
  for (const n of lineage.nodes) colOf.set(n.id, LINEAGE_COLUMNS.indexOf(n.kind));

  // Columns of slots: boxes, plus a waypoint per column a line passes through.
  const cols: Slot[][] = LINEAGE_COLUMNS.map(() => []);
  for (const n of lineage.nodes) cols[colOf.get(n.id)!]!.push({ id: n.id, dummy: false, y: 0 });
  // Links between adjacent columns (slot id -> slot id), and each line's chain of slots.
  const right = new Map<string, string[]>();
  const left = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (right.get(a) ?? right.set(a, []).get(a)!).push(b);
    (left.get(b) ?? left.set(b, []).get(b)!).push(a);
  };
  const chains: Array<{ from: string; to: string; ids: string[] }> = [];
  const within: Array<{ from: string; to: string; join: boolean }> = [];
  for (const e of lineage.edges) {
    const ca = colOf.get(e.from);
    const cb = colOf.get(e.to);
    if (ca === undefined || cb === undefined) continue;
    if (e.join || ca === cb) {
      within.push({ from: e.from, to: e.to, join: Boolean(e.join) });
      continue;
    }
    // Always drawn left to right.
    const [from, to, c1, c2] = ca < cb ? [e.from, e.to, ca, cb] : [e.to, e.from, cb, ca];
    const ids = [from];
    for (let c = c1 + 1; c < c2; c++) {
      const d = `~${from}>${to}@${c}`;
      cols[c]!.push({ id: d, dummy: true, y: 0 });
      ids.push(d);
    }
    ids.push(to);
    for (let i = 0; i + 1 < ids.length; i++) link(ids[i]!, ids[i + 1]!);
    chains.push({ from, to, ids });
  }

  // Order: flags in page order, then sweeps by the average index of neighbours.
  const flagCol = LINEAGE_COLUMNS.indexOf('flag' as LineageKind);
  const flagRank = new Map((o.flagOrder ?? []).map((id, i) => [id, i]));
  cols[flagCol]!.sort((a, b) => (flagRank.get(a.id) ?? 1e9) - (flagRank.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
  const index = new Map<string, number>();
  const reindex = (c: number) => cols[c]!.forEach((s, i) => index.set(s.id, i));
  cols.forEach((_, c) => reindex(c));
  const sweep = (c: number, neighbours: Map<string, string[]>) => {
    const col = cols[c]!;
    const score = new Map<string, number>();
    col.forEach((s, i) => {
      const ns = (neighbours.get(s.id) ?? []).map((n) => index.get(n)).filter((v): v is number => v !== undefined);
      score.set(s.id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i);
    });
    col.sort((a, b) => score.get(a.id)! - score.get(b.id)! || index.get(a.id)! - index.get(b.id)!);
    reindex(c);
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let c = flagCol - 1; c >= 0; c--) sweep(c, right);
    for (let c = 1; c < cols.length; c++) if (c !== flagCol || pass === 3) sweep(c, left);
  }
  // The page order of flags wins in the end; the rest settled around it.
  cols[flagCol]!.sort((a, b) => (flagRank.get(a.id) ?? index.get(a.id)! + 1e6) - (flagRank.get(b.id) ?? index.get(b.id)! + 1e6));
  reindex(flagCol);
  for (let c = flagCol - 1; c >= 0; c--) sweep(c, right);

  // Then swap neighbours wherever that removes crossings with the columns on either side (flags stay put).
  const pairCrossings = (c: number) => {
    if (c < 0 || c + 1 >= cols.length) return 0;
    const segs: Array<[number, number]> = [];
    for (const s of cols[c]!) for (const t of right.get(s.id) ?? []) if (index.has(t)) segs.push([index.get(s.id)!, index.get(t)!]);
    let n = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i]![0] - segs[j]![0]) * (segs[i]![1] - segs[j]![1]) < 0) n++;
    return n;
  };
  for (let round = 0; round < 8; round++) {
    let improved = false;
    for (let c = 0; c < cols.length; c++) {
      if (c === flagCol) continue;
      const col = cols[c]!;
      for (let i = 0; i + 1 < col.length; i++) {
        const before = pairCrossings(c - 1) + pairCrossings(c);
        [col[i], col[i + 1]] = [col[i + 1]!, col[i]!];
        reindex(c);
        if (pairCrossings(c - 1) + pairCrossings(c) < before) improved = true;
        else {
          [col[i], col[i + 1]] = [col[i + 1]!, col[i]!];
          reindex(c);
        }
      }
    }
    if (!improved) break;
  }

  // Heights: a box takes rowGap, a waypoint laneGap.
  const gap = (s: Slot) => (s.dummy ? o.laneGap : o.rowGap);
  const centre = (s: Slot) => s.y + (s.dummy ? 0 : o.boxHeight / 2);
  const stack = (col: Slot[]) => {
    let y = o.top;
    for (const s of col) {
      s.y = y;
      y += gap(s);
    }
  };
  cols.forEach(stack);
  // Move each slot level with its neighbours, then push apart to keep order and spacing.
  const slotOf = new Map<string, Slot>();
  cols.forEach((col) => col.forEach((s) => slotOf.set(s.id, s)));
  const settle = (col: Slot[], neighbours: Map<string, string[]>) => {
    for (const s of col) {
      const ns = (neighbours.get(s.id) ?? []).map((n) => slotOf.get(n)!).filter(Boolean);
      if (ns.length) s.y = ns.reduce((a, n) => a + centre(n), 0) / ns.length - (s.dummy ? 0 : o.boxHeight / 2);
    }
    // Keep order and spacing: push down, then pull the block back up so it stays centred on its wish.
    const wish = col.map((s) => s.y);
    for (let i = 1; i < col.length; i++) col[i]!.y = Math.max(col[i]!.y, col[i - 1]!.y + gap(col[i - 1]!));
    const shift = col.length ? (col.reduce((a, s, i) => a + (s.y - wish[i]!), 0) / col.length) : 0;
    for (const s of col) s.y -= shift;
    for (let i = 1; i < col.length; i++) col[i]!.y = Math.max(col[i]!.y, col[i - 1]!.y + gap(col[i - 1]!));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let c = flagCol - 1; c >= 0; c--) settle(cols[c]!, right);
    for (let c = 1; c < cols.length; c++) settle(cols[c]!, left);
  }
  // Nothing above the column titles.
  const minY = Math.min(...cols.flat().map((s) => s.y));
  const lift = o.top - (Number.isFinite(minY) ? minY : o.top);
  for (const s of cols.flat()) s.y += lift;

  const boxes = new Map<string, PlacedBox>();
  cols.forEach((col, c) => col.forEach((s) => { if (!s.dummy) boxes.set(s.id, { id: s.id, x: c * o.colWidth, y: s.y }); }));

  // Fan the ends of lines along each box's edge, ordered by where the other end is.
  const outs = new Map<string, Array<{ key: string; y: number }>>();
  const ins = new Map<string, Array<{ key: string; y: number }>>();
  for (const ch of chains) {
    const first = slotOf.get(ch.ids[1]!)!;
    const last = slotOf.get(ch.ids[ch.ids.length - 2]!)!;
    const key = `${ch.from}>${ch.to}`;
    (outs.get(ch.from) ?? outs.set(ch.from, []).get(ch.from)!).push({ key, y: centre(first) });
    (ins.get(ch.to) ?? ins.set(ch.to, []).get(ch.to)!).push({ key, y: centre(last) });
  }
  const port = (list: Array<{ key: string; y: number }> | undefined, key: string, boxY: number) => {
    if (!list || list.length < 2) return boxY + o.boxHeight / 2;
    const sorted = [...list].sort((a, b) => a.y - b.y);
    const i = sorted.findIndex((p) => p.key === key);
    const span = o.boxHeight - 10;
    return boxY + 5 + (span * i) / (sorted.length - 1);
  };

  const lines: PlacedLine[] = [];
  for (const ch of chains) {
    const key = `${ch.from}>${ch.to}`;
    const a = boxes.get(ch.from)!;
    const b = boxes.get(ch.to)!;
    const pts: Array<[number, number]> = [[a.x + o.boxWidth, port(outs.get(ch.from), key, a.y)]];
    for (let i = 1; i + 1 < ch.ids.length; i++) {
      const s = slotOf.get(ch.ids[i]!)!;
      const x = colOf.get(ch.from)! * o.colWidth + i * o.colWidth;
      // Through the column at the waypoint's height: in at the box's left edge, out at its right.
      pts.push([x, s.y], [x + o.boxWidth, s.y]);
    }
    pts.push([b.x, port(ins.get(ch.to), key, b.y)]);
    let d = `M${pts[0]![0]},${pts[0]![1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      if (y0 === y1) d += ` L${x1},${y1}`;
      else {
        const mid = (x0 + x1) / 2;
        d += ` C${mid},${y0} ${mid},${y1} ${x1},${y1}`;
      }
    }
    lines.push({ from: ch.from, to: ch.to, kind: 'flow', d });
  }
  // Arcs within a column, nested by length so they do not cross each other.
  const arcs = within
    .map((w) => ({ ...w, a: boxes.get(w.from), b: boxes.get(w.to) }))
    .filter((w) => w.a && w.b)
    .sort((p, q) => Math.abs(p.a!.y - p.b!.y) - Math.abs(q.a!.y - q.b!.y));
  const depthAt = new Map<number, number>();
  for (const w of arcs) {
    const c = w.a!.x;
    const depth = (depthAt.get(c) ?? 0) + 1;
    depthAt.set(c, depth);
    const x = c + o.boxWidth;
    const y1 = w.a!.y + o.boxHeight / 2;
    const y2 = w.b!.y + o.boxHeight / 2;
    const bulge = Math.min(o.colWidth - o.boxWidth - 4, 8 + depth * 5);
    lines.push({ from: w.from, to: w.to, kind: w.join ? 'join' : 'within', d: `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}` });
  }

  const bottom = Math.max(o.top, ...cols.flat().map((s) => s.y + (s.dummy ? 0 : o.boxHeight)));
  return { boxes, lines, width: LINEAGE_COLUMNS.length * o.colWidth, height: bottom + 12 };
}

/** How many pairs of lines cross between two adjacent columns (for tests and tuning). */
export function crossings(layout: LineageLayout, lineage: Lineage, colWidth = DEFAULTS.colWidth, boxWidth = DEFAULTS.boxWidth): number {
  // Sample each flow line where it crosses every gap between columns, then count order swaps per gap.
  const gaps = new Map<number, Array<{ y0: number; y1: number }>>();
  void lineage;
  for (const l of layout.lines) {
    if (l.kind !== 'flow') continue;
    const nums = l.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
    // Gap segments start at a right edge (x % colWidth === boxWidth) and end at the next left edge.
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i]!;
      if (Math.round(x0 % colWidth) !== boxWidth) continue;
      const end = pts.slice(i + 1).find(([x]) => Math.abs(x - (x0 + colWidth - boxWidth)) < 0.5);
      if (!end) continue;
      (gaps.get(x0) ?? gaps.set(x0, []).get(x0)!).push({ y0, y1: end[1] });
    }
  }
  let n = 0;
  for (const segs of gaps.values()) {
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]!;
      const b = segs[j]!;
      if ((a.y0 - b.y0) * (a.y1 - b.y1) < 0) n++;
    }
  }
  return n;
}

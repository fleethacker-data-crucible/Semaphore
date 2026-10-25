// The lego grid. Flags snap to whole cells, never overlap, and float up to fill gaps, so a
// layout stays tidy however the analyst drags things around.

import type { FlagKind, Layout } from './hoist.ts';

/** The footprint a new flag of each kind starts with, in grid cells (12 columns wide). */
export const DEFAULT_SIZE: Record<FlagKind, { w: number; h: number }> = {
  kpi: { w: 3, h: 2 },
  filter: { w: 3, h: 2 },
  bar: { w: 6, h: 4 },
  line: { w: 6, h: 4 },
  area: { w: 6, h: 4 },
  pie: { w: 4, h: 4 },
  table: { w: 12, h: 5 },
  text: { w: 4, h: 2 },
};

export interface Placed {
  id: string;
  layout: Layout;
}

export function overlaps(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function clampLayout(l: Layout, cols: number): Layout {
  const w = Math.max(1, Math.min(Math.round(l.w), cols));
  const h = Math.max(1, Math.min(Math.round(l.h), 24));
  const x = Math.max(0, Math.min(Math.round(l.x), cols - w));
  const y = Math.max(0, Math.round(l.y));
  return { x, y, w, h };
}

/** First free top-left position for a w×h flag, scanning row by row. */
export function findSlot(items: readonly Placed[], w: number, h: number, cols: number): Layout {
  const width = Math.min(w, cols);
  for (let y = 0; ; y++) {
    for (let x = 0; x + width <= cols; x++) {
      const candidate = { x, y, w: width, h };
      if (!items.some((p) => overlaps(p.layout, candidate))) return candidate;
    }
  }
}

/**
 * Put one flag at a new position or size. Anything it lands on is pushed down below it, then
 * every flag floats up as far as it can. The moved flag keeps the position it was given,
 * except that it floats up too, so it cannot be left hanging below empty space.
 */
export function place(items: readonly Placed[], id: string, target: Layout, cols: number): Placed[] {
  const moved = clampLayout(target, cols);
  const others = items.filter((p) => p.id !== id).map((p) => ({ id: p.id, layout: { ...p.layout } }));
  const result: Placed[] = [{ id, layout: moved }];
  // Settle the others in reading order so pushes cascade predictably.
  others.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  for (const p of others) {
    while (result.some((q) => overlaps(q.layout, p.layout))) p.layout.y += 1;
    result.push(p);
  }
  const order = new Map(items.map((p, i) => [p.id, i]));
  return compact(result, id).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Float every flag up as far as it goes without overlapping, keeping columns. */
export function compact(items: readonly Placed[], pinned?: string): Placed[] {
  const sorted = items
    .map((p) => ({ id: p.id, layout: { ...p.layout } }))
    .sort((a, b) => a.layout.y - b.layout.y || (a.id === pinned ? -1 : b.id === pinned ? 1 : a.layout.x - b.layout.x));
  const settled: Placed[] = [];
  for (const p of sorted) {
    while (p.layout.y > 0) {
      const up = { ...p.layout, y: p.layout.y - 1 };
      if (settled.some((q) => overlaps(q.layout, up))) break;
      p.layout = up;
    }
    settled.push(p);
  }
  const order = new Map(items.map((p, i) => [p.id, i]));
  return settled.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** True when no two flags overlap and all fit inside the grid. */
export function isValidLayout(items: readonly Placed[], cols: number): boolean {
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!.layout;
    if (a.x < 0 || a.y < 0 || a.w < 1 || a.h < 1 || a.x + a.w > cols) return false;
    for (let j = i + 1; j < items.length; j++) if (overlaps(a, items[j]!.layout)) return false;
  }
  return true;
}

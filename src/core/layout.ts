// The grid flags sit on, 12 columns wide, in three modes the analyst picks per hoist:
// - snap (the default): flags sit on whole cells wherever they are put. Gaps stay; a flag dropped on
//   another pushes it down just far enough, and nothing floats up.
// - free: flags go anywhere, in steps of an eighth of a cell, and may overlap; the list order of the
//   flags is the stacking order (the last is on top).
// - auto: the tidy lego grid. Flags snap to whole cells, never overlap, and float up to fill gaps.

import type { FlagKind, Layout, LayoutMode } from './hoist.ts';

/** Free mode's step: an eighth of a cell, about 9 px across on a wide screen. */
export const FREE_STEP = 1 / 8;

const toStep = (v: number) => Math.round(v / FREE_STEP) * FREE_STEP;

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
  radar: { w: 4, h: 4 },
  scatter: { w: 6, h: 4 },
  heatmap: { w: 6, h: 4 },
  calendar: { w: 12, h: 3 },
  waterfall: { w: 6, h: 4 },
  pareto: { w: 6, h: 4 },
  sankey: { w: 6, h: 5 },
  sunburst: { w: 4, h: 4 },
  stream: { w: 6, h: 4 },
  model: { w: 6, h: 5 },
  custom: { w: 6, h: 5 },
};

export interface Placed {
  id: string;
  layout: Layout;
}

export function overlaps(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Deepest row a flag may start on. Matches what parseHoist accepts. */
export const MAX_Y = 1000;

export function clampLayout(l: Layout, cols: number, mode: LayoutMode = 'snap'): Layout {
  const round = mode === 'free' ? toStep : Math.round;
  const n = (v: number, fallback: number) => (Number.isFinite(v) ? round(v) : fallback);
  const w = Math.max(1, Math.min(n(l.w, 1), cols));
  const h = Math.max(1, Math.min(n(l.h, 1), 24));
  const x = Math.max(0, Math.min(n(l.x, 0), cols - w));
  const y = Math.max(0, Math.min(n(l.y, 0), MAX_Y));
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
 * Put one flag at a new position or size, as the hoist's layout mode says:
 * - auto: anything it lands on is pushed down below it, then every flag floats up as far as it can
 *   (the moved flag too, so it cannot be left hanging below empty space).
 * - snap: the flag stays exactly where it was put; anything it lands on is pushed down just far
 *   enough, and nothing floats up, so gaps the analyst leaves stay.
 * - free: only the moved flag changes; flags may overlap.
 */
export function place(items: readonly Placed[], id: string, target: Layout, cols: number, mode: LayoutMode = 'auto'): Placed[] {
  const order = new Map(items.map((p, i) => [p.id, i]));
  const byOrder = (a: Placed, b: Placed) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  if (mode === 'free') {
    const moved = clampLayout(target, cols, 'free');
    return items.map((p) => (p.id === id ? { id, layout: moved } : { id: p.id, layout: { ...p.layout } }));
  }
  const moved = clampLayout(target, cols);
  const others = items.filter((p) => p.id !== id).map((p) => ({ id: p.id, layout: { ...p.layout } }));
  const result = pushDown([{ id, layout: moved }], others);
  return (mode === 'snap' ? result : compact(result, id)).sort(byOrder);
}

/** Adds each of `others` (in reading order) to `settled`, pushing it down past anything it overlaps. */
function pushDown(settled: Placed[], others: Placed[]): Placed[] {
  others.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  for (const p of others) {
    for (;;) {
      const blockers = settled.filter((q) => overlaps(q.layout, p.layout));
      if (blockers.length === 0) break;
      p.layout.y = Math.max(...blockers.map((q) => q.layout.y + q.layout.h));
    }
    settled.push(p);
  }
  return settled;
}

/**
 * Snaps every flag to whole cells (rounding its free position) and pushes overlapping ones down,
 * in reading order, without floating anything up: for switching a hoist from free to snap.
 */
export function snapAll(items: readonly Placed[], cols: number): Placed[] {
  const order = new Map(items.map((p, i) => [p.id, i]));
  const rounded = items.map((p) => ({ id: p.id, layout: clampLayout(p.layout, cols) }));
  return pushDown([], rounded).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The layouts for a hoist switching to `mode`: snapped to cells for snap, tidied for auto, unchanged for free. */
export function relayout(items: readonly Placed[], cols: number, mode: LayoutMode): Placed[] {
  if (mode === 'free') return items.map((p) => ({ id: p.id, layout: { ...p.layout } }));
  const snapped = snapAll(items, cols);
  return mode === 'auto' ? compact(snapped) : snapped;
}

/**
 * Float every flag up as far as it goes without overlapping, keeping columns. Flags that
 * overlap an earlier one (in reading order) are first pushed down below it, so this also
 * repairs overlapping layouts loaded from a file.
 */
export function compact(items: readonly Placed[], pinned?: string): Placed[] {
  const sorted = items
    .map((p) => ({ id: p.id, layout: { ...p.layout } }))
    .sort((a, b) => a.layout.y - b.layout.y || (a.id === pinned ? -1 : b.id === pinned ? 1 : a.layout.x - b.layout.x));
  const settled: Placed[] = [];
  for (const p of sorted) {
    for (;;) {
      const blockers = settled.filter((q) => overlaps(q.layout, p.layout));
      if (blockers.length === 0) break;
      p.layout.y = Math.max(...blockers.map((q) => q.layout.y + q.layout.h));
    }
    // Float up in one step: to the lowest bottom edge of anything above it in its columns.
    const p0 = p.layout;
    const above = settled.filter((q) => q.layout.x < p0.x + p0.w && p0.x < q.layout.x + q.layout.w && q.layout.y + q.layout.h <= p0.y);
    p.layout = { ...p0, y: above.length ? Math.max(...above.map((q) => q.layout.y + q.layout.h)) : 0 };
    settled.push(p);
  }
  const order = new Map(items.map((p, i) => [p.id, i]));
  return settled.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * True when every flag fits inside the grid, on whole cells and with no overlaps; in free mode,
 * on eighth-cell steps, and overlaps are allowed.
 */
export function isValidLayout(items: readonly Placed[], cols: number, mode: LayoutMode = 'snap'): boolean {
  const free = mode === 'free';
  const onGrid = (v: number) => (free ? Number.isFinite(v) && Math.abs(toStep(v) - v) < 1e-9 : Number.isInteger(v));
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!.layout;
    if (![a.x, a.y, a.w, a.h].every(onGrid)) return false;
    if (a.x < 0 || a.y < 0 || a.w < 1 || a.h < 1 || a.x + a.w > cols + 1e-9) return false;
    if (!free) for (let j = i + 1; j < items.length; j++) if (overlaps(a, items[j]!.layout)) return false;
  }
  return true;
}

// Where a flag's card goes in a read-only page (the shared report, frozen answers), from its grid
// layout. Positioned rather than laid out with CSS grid, so free layouts (eighth-cell steps and
// overlaps, src/core/layout.ts) draw exactly as on the canvas; whole-cell layouts look as before.

import type { CSSProperties } from 'react';
import type { Layout } from '../../../src/core/hoist.ts';

/** The board: tall enough for the lowest card. */
export function boardStyle(layouts: readonly Layout[], rowPx: number, gapPx: number): CSSProperties {
  const bottom = Math.max(1, ...layouts.map((l) => l.y + l.h));
  return { position: 'relative', height: bottom * (rowPx + gapPx) - gapPx };
}

/** A card: columns as fractions of the board's width (with the gap between them), rows in pixels. */
export function cardStyle(l: Layout, cols: number, rowPx: number, gapPx: number, z?: number): CSSProperties {
  const share = (n: number) => +(n / cols).toFixed(6);
  return {
    position: 'absolute',
    left: `calc((100% + ${gapPx}px) * ${share(l.x)})`,
    width: `calc((100% + ${gapPx}px) * ${share(l.w)} - ${gapPx}px)`,
    top: l.y * (rowPx + gapPx),
    height: l.h * (rowPx + gapPx) - gapPx,
    ...(z !== undefined ? { zIndex: z } : {}),
  };
}

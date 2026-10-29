// The hoist: a 12-column lego grid. Flags snap to whole cells, push others down when they land
// on them and float up to fill gaps (src/core/layout.ts). Drag a flag by its grip, resize it by
// its corner, drop a new one from the palette, or move the selected flag with the arrow keys.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import type { FlagKind, Hoist, Layout } from '../../../src/core/hoist.ts';
import { DEFAULT_SIZE, place } from '../../../src/core/layout.ts';
import type { DataContext } from '../lib/data.ts';
import { FlagCard } from './FlagCard.tsx';

export const ROW_PX = 56;
export const GAP_PX = 12;
export const KIND_MIME = 'application/x-semaphore-kind';

export interface CanvasProps {
  hoist: Hoist;
  ctx: DataContext;
  index: CatalogIndex;
  selections: Selections;
  selectedId: string | null;
  themeKey: string;
  onSelectFlag: (id: string | null) => void;
  onSelectValue: (key: string, value: Cell, additive: boolean) => void;
  onAccept: (id: string) => void;
  onLayout: (layouts: Array<{ id: string; layout: Layout }>, group: string) => void;
  onDropKind: (kind: FlagKind | 'auto', at: { x: number; y: number }) => void;
  empty: React.ReactNode;
}

export function Canvas({ hoist, ctx, index, selections, selectedId, themeKey, onSelectFlag, onSelectValue, onAccept, onLayout, onDropKind, empty }: CanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [dropAt, setDropAt] = useState<Layout | null>(null);
  const cols = hoist.grid.cols;

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const colW = (width - GAP_PX * (cols - 1)) / cols;
  const px = (l: Layout) => ({ left: l.x * (colW + GAP_PX), top: l.y * (ROW_PX + GAP_PX), width: l.w * colW + (l.w - 1) * GAP_PX, height: l.h * ROW_PX + (l.h - 1) * GAP_PX });
  const cellAt = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(cols - 1, Math.floor((clientX - r.left) / (colW + GAP_PX)))), y: Math.max(0, Math.floor((clientY - r.top) / (ROW_PX + GAP_PX))) };
  };

  const hoistRef = useRef(hoist);
  hoistRef.current = hoist;
  const onDragStart = useCallback(
    (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
      e.preventDefault();
      e.stopPropagation();
      const start = hoistRef.current.flags.find((f) => f.id === id)?.layout;
      if (!start) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const group = `drag-${id}-${Date.now()}`;
      let last = '';
      const move = (ev: PointerEvent) => {
        const dx = Math.round((ev.clientX - sx) / (colW + GAP_PX));
        const dy = Math.round((ev.clientY - sy) / (ROW_PX + GAP_PX));
        const target = mode === 'move' ? { ...start, x: start.x + dx, y: Math.max(0, start.y + dy) } : { ...start, w: Math.max(1, start.w + dx), h: Math.max(1, start.h + dy) };
        const key = JSON.stringify(target);
        if (key === last) return;
        last = key;
        const items = hoistRef.current.flags.map((f) => ({ id: f.id, layout: f.layout }));
        onLayout(place(items, id, target, cols), group);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [colW, cols, onLayout],
  );

  useEffect(() => {
    if (!selectedId) return;
    box.current?.querySelector(`[data-flag="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const rows = Math.max(8, ...hoist.flags.map((f) => f.layout.y + f.layout.h)) + 2;

  return (
    <div
      ref={box}
      className="relative"
      style={{ height: rows * (ROW_PX + GAP_PX) }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelectFlag(null);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(KIND_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const at = cellAt(e.clientX, e.clientY);
        setDropAt({ x: Math.min(at.x, cols - 3), y: at.y, w: 3, h: 2 });
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropAt(null);
      }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData(KIND_MIME) as FlagKind | 'auto';
        setDropAt(null);
        if (!kind) return;
        e.preventDefault();
        const at = cellAt(e.clientX, e.clientY);
        const w = kind === 'auto' ? 4 : DEFAULT_SIZE[kind].w;
        onDropKind(kind, { x: Math.min(at.x, cols - w), y: at.y });
      }}
    >
      {hoist.flags.length === 0 && !dropAt && <div className="absolute inset-0">{empty}</div>}
      {dropAt && <div className="pointer-events-none absolute rounded-xl border-2 border-dashed border-accent bg-accent-soft/40" style={px(dropAt)} />}
      {hoist.flags.map((f) => (
        <div key={f.id} data-flag={f.id} className="absolute transition-[left,top,width,height] duration-150 ease-out" style={px(f.layout)}>
          <FlagCard
            hoist={hoist}
            flag={f}
            ctx={ctx}
            index={index}
            selections={selections}
            selected={selectedId === f.id}
            themeKey={themeKey}
            onSelectFlag={onSelectFlag}
            onSelectValue={onSelectValue}
            onAccept={onAccept}
            onDragStart={onDragStart}
          />
        </div>
      ))}
    </div>
  );
}

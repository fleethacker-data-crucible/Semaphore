// Lineage on screen: sources → tables → fields → measures → flags, left to right. Click anything to
// see what feeds it and what it feeds; joins between tables are the dashed arcs.

import { useMemo, useRef, useState } from 'react';
import { Network, X } from 'lucide-react';
import type { Catalog } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { buildLineage, connected, LINEAGE_COLUMNS, type LineageKind, type LineageNode } from '../../../src/core/lineage.ts';
import { useModal } from '../lib/modal.ts';

const COL_W = 210;
const BOX_W = 176;
const ROW_H = 38;
const BOX_H = 28;
const TOP = 30;
const TITLES: Record<LineageKind, string> = { source: 'Sources', table: 'Tables', field: 'Fields', metric: 'Measures', flag: 'Flags' };

function short(s: string, n = 24): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function LineageView({ catalog, hoist, onClose }: { catalog: Catalog; hoist: Hoist; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const [all, setAll] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const lineage = useMemo(() => buildLineage(catalog, hoist, all), [catalog, hoist, all]);

  // Order each column by the average position of what it connects to on the right, so lines cross less.
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const byCol = new Map<LineageKind, LineageNode[]>(LINEAGE_COLUMNS.map((k) => [k, lineage.nodes.filter((n) => n.kind === k)]));
    const rank = new Map<string, number>();
    const flagOrder = hoist.flags.map((f) => `g:${f.id}`);
    byCol.get('flag')!.sort((a, b) => flagOrder.indexOf(a.id) - flagOrder.indexOf(b.id)).forEach((n, i) => rank.set(n.id, i));
    for (const kind of ['metric', 'field', 'table', 'source'] as LineageKind[]) {
      const col = byCol.get(kind)!;
      const score = (n: LineageNode) => {
        const right = lineage.edges.filter((e) => e.from === n.id && !e.join && rank.has(e.to)).map((e) => rank.get(e.to)!);
        return right.length ? right.reduce((a, b) => a + b, 0) / right.length : Number.MAX_SAFE_INTEGER;
      };
      col.sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label)).forEach((n, i) => rank.set(n.id, i));
    }
    LINEAGE_COLUMNS.forEach((kind, ci) => byCol.get(kind)!.forEach((n, i) => pos.set(n.id, { x: ci * COL_W, y: TOP + i * ROW_H })));
    const rows = Math.max(1, ...[...byCol.values()].map((c) => c.length));
    return { pos, height: TOP + rows * ROW_H + 10 };
  }, [lineage, hoist.flags]);

  const lit = focus ? connected(lineage, focus) : null;
  const width = LINEAGE_COLUMNS.length * COL_W;

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Lineage" className="mx-auto w-fit max-w-full rounded-xl border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Network size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Where the numbers come from</h2>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole catalog
          </label>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <p className="px-4 pt-2 text-xs text-ink-2">Click a box to see what feeds it and what it feeds. Dashed arcs are joins between tables.{focus ? ' Click it again to clear.' : ''}</p>
        <div className="overflow-x-auto p-4">
          {lineage.nodes.length === 0 ? (
            <p className="text-sm text-ink-3">No flag on this page reads data yet.</p>
          ) : (
            <svg width={width} height={layout.height} role="img" aria-label="Lineage graph" style={{ fontFamily: 'inherit' }}>
              {LINEAGE_COLUMNS.map((k, i) => (
                <text key={k} x={i * COL_W} y={14} fontSize={11} fontWeight={600} fill="var(--ink-3)">
                  {TITLES[k].toUpperCase()}
                </text>
              ))}
              {lineage.edges.map((e) => {
                const a = layout.pos.get(e.from);
                const b = layout.pos.get(e.to);
                if (!a || !b) return null;
                const on = !lit || (lit.has(e.from) && lit.has(e.to));
                if (e.join) {
                  // Same column: an arc out to the right of the table boxes.
                  const x = a.x + BOX_W;
                  const y1 = a.y + BOX_H / 2;
                  const y2 = b.y + BOX_H / 2;
                  const bulge = 18 + Math.min(20, Math.abs(y2 - y1) / 6);
                  return <path key={`${e.from}>${e.to}`} d={`M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`} fill="none" stroke="var(--accent)" strokeDasharray="4 3" strokeWidth={1.4} opacity={on ? 0.9 : 0.15} />;
                }
                const x1 = a.x + BOX_W;
                const y1 = a.y + BOX_H / 2;
                const x2 = b.x;
                const y2 = b.y + BOX_H / 2;
                const mid = (x1 + x2) / 2;
                return <path key={`${e.from}>${e.to}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke={on && lit ? 'var(--accent)' : 'var(--line)'} strokeWidth={on && lit ? 1.6 : 1.1} opacity={on ? 1 : 0.2} />;
              })}
              {lineage.nodes.map((n) => {
                const p = layout.pos.get(n.id);
                if (!p) return null;
                const on = !lit || lit.has(n.id);
                return (
                  <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={on ? 1 : 0.3} style={{ cursor: 'pointer' }} onClick={() => setFocus(focus === n.id ? null : n.id)}>
                    <title>{`${n.label}${n.detail ? ` (${n.detail})` : ''}`}</title>
                    <rect width={BOX_W} height={BOX_H} rx={6} fill="var(--panel)" stroke={focus === n.id ? 'var(--accent)' : 'var(--line)'} strokeWidth={focus === n.id ? 2 : 1} />
                    <text x={8} y={n.detail ? 12 : 18} fontSize={11} fill="var(--ink)">
                      {short(n.label)}
                    </text>
                    {n.detail && (
                      <text x={8} y={23} fontSize={9} fill="var(--ink-3)">
                        {short(n.detail, 30)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </section>
    </div>
  );
}

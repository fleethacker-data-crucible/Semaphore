// Lineage on screen: sources → tables → fields → measures → flags, left to right. Click anything to
// see what feeds it and what it feeds (hover to look, click to keep it lit); joins between tables are
// the dashed arcs and formula measures the solid ones. The layout is src/core/lineage-layout.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Network, Workflow, X } from 'lucide-react';
import type { Catalog } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { buildLineage, connected, LINEAGE_COLUMNS, type LineageKind } from '../../../src/core/lineage.ts';
import { layoutLineage } from '../../../src/core/lineage-layout.ts';
import { useModal } from '../lib/modal.ts';
import { recordSkill } from '../lib/skills.ts';
import { EmptyState } from './EmptyState.tsx';

const COL_W = 210;
const BOX_W = 176;
const ROW_H = 38;
const LANE_H = 12;
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
  const [hover, setHover] = useState<string | null>(null);
  const lineage = useMemo(() => buildLineage(catalog, hoist, all), [catalog, hoist, all]);
  useEffect(() => {
    if (lineage.nodes.length) recordSkill('lineage', { hoistId: hoist.id });
  }, [lineage.nodes.length, hoist.id]);

  const layout = useMemo(
    () => layoutLineage(lineage, { colWidth: COL_W, boxWidth: BOX_W, boxHeight: BOX_H, rowGap: ROW_H, laneGap: LANE_H, top: TOP, flagOrder: hoist.flags.map((f) => `g:${f.id}`) }),
    [lineage, hoist.flags],
  );

  const shown = focus ?? hover;
  const lit = shown ? connected(lineage, shown) : null;
  const width = layout.width;

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Lineage" className="mx-auto w-fit max-w-full rounded-xl border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Network size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Where the numbers come from</h2>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole catalog
          </label>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <p className="px-4 pt-2 text-xs text-ink-2">Point at a box to see what feeds it and what it feeds; click to keep it lit. Dashed arcs are joins between tables, solid arcs formula measures.{focus ? ' Click it again to clear.' : ''}</p>
        <div className="overflow-x-auto p-4">
          {lineage.nodes.length === 0 ? (
            <EmptyState
              compact
              icon={Workflow}
              headline="Nothing to trace yet."
              body="No flag on this page reads data yet. Wire a flag, or tick Whole catalog to see every source, table, field and measure."
              action={catalog.metrics.length ? { label: 'Show the whole catalog', onClick: () => setAll(true) } : undefined}
            />
          ) : (
            <svg width={width} height={layout.height} role="img" aria-label="Lineage graph" style={{ fontFamily: 'inherit' }}>
              {LINEAGE_COLUMNS.map((k, i) => (
                <text key={k} x={i * COL_W} y={14} fontSize={11} fontWeight={600} fill="var(--ink-3)">
                  {TITLES[k].toUpperCase()}
                </text>
              ))}
              {layout.lines.map((l) => {
                const on = !lit || (lit.has(l.from) && lit.has(l.to));
                const key = `${l.kind}:${l.from}>${l.to}`;
                if (l.kind !== 'flow') {
                  return <path key={key} d={l.d} fill="none" stroke="var(--accent)" strokeDasharray={l.kind === 'join' ? '4 3' : undefined} strokeWidth={1.4} opacity={on ? 0.85 : 0.12} />;
                }
                return <path key={key} d={l.d} fill="none" stroke={on && lit ? 'var(--accent)' : 'var(--ink-3)'} strokeWidth={on && lit ? 1.8 : 1.1} opacity={on ? (lit ? 1 : 0.45) : 0.1} strokeLinecap="round" />;
              })}
              {lineage.nodes.map((n) => {
                const p = layout.boxes.get(n.id);
                if (!p) return null;
                const on = !lit || lit.has(n.id);
                const toggle = () => setFocus(focus === n.id ? null : n.id);
                // A keyboard stop like a button: Tab reaches each box, Enter or Space lights its connections.
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x},${p.y})`}
                    opacity={on ? 1 : 0.3}
                    style={{ cursor: 'pointer' }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={focus === n.id}
                    aria-label={`${TITLES[n.kind].replace(/s$/, '')} ${n.label}${n.detail ? ` (${n.detail})` : ''}`}
                    className="outline-none focus-visible:[&>rect]:stroke-[var(--focus)] focus-visible:[&>rect]:stroke-2"
                    onClick={toggle}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onFocus={() => setHover(n.id)}
                    onBlur={() => setHover((h) => (h === n.id ? null : h))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                  >
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

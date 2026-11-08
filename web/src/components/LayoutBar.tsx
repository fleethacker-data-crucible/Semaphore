// How flags move on this hoist (src/core/layout.ts), above the canvas: Snap keeps flags on whole
// cells wherever they are put, Free puts them anywhere and lets them overlap, Auto-arrange is the
// tidy grid that floats flags up. Tidy up does Auto-arrange once. In free mode, the selected flag
// can be brought to the front or sent to the back.

import { BringToFront, Grid2x2, LayoutDashboard, Move, SendToBack, Sparkles } from 'lucide-react';
import type { LayoutMode } from '../../../src/core/hoist.ts';

const MODES: Array<{ id: LayoutMode; label: string; hint: string; Icon: typeof Grid2x2 }> = [
  { id: 'snap', label: 'Snap', hint: 'Flags sit on whole cells wherever you put them. Gaps stay; a flag you drop on another pushes it down.', Icon: Grid2x2 },
  { id: 'free', label: 'Free', hint: 'Flags go anywhere and may overlap. Hold Alt while dragging to line up with the cells.', Icon: Move },
  { id: 'auto', label: 'Auto-arrange', hint: 'Flags snap to cells and float up to fill gaps, so the page stays tidy.', Icon: LayoutDashboard },
];

export function LayoutBar({ mode, hasSelection, onMode, onTidy, onFront, onBack }: { mode: LayoutMode; hasSelection: boolean; onMode: (m: LayoutMode) => void; onTidy: () => void; onFront: () => void; onBack: () => void }) {
  const tile = (on: boolean) => `flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs ${on ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-2 hover:bg-panel-2 hover:text-ink'}`;
  const btn = 'flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-xs text-ink-2 hover:border-accent hover:text-ink';
  const current = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  return (
    <div className="mb-2 flex flex-wrap items-center justify-end gap-2" data-testid="layout-bar">
      <span className="mr-auto truncate text-[11.5px] text-ink-3" aria-live="polite">
        {current.hint}
      </span>
      {mode === 'free' && hasSelection && (
        <>
          <button type="button" onClick={onFront} className={btn} title="Bring the selected flag to the front (])">
            <BringToFront size={14} aria-hidden /> Front
          </button>
          <button type="button" onClick={onBack} className={btn} title="Send the selected flag to the back ([)">
            <SendToBack size={14} aria-hidden /> Back
          </button>
        </>
      )}
      <div role="radiogroup" aria-label="How flags move" className="flex items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={m.hint} onClick={() => onMode(m.id)} className={tile(mode === m.id)}>
            <m.Icon size={14} aria-hidden /> {m.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onTidy} className={btn} title="Arrange the flags once: on whole cells, floated up to fill the gaps">
        <Sparkles size={14} aria-hidden /> Tidy up
      </button>
    </div>
  );
}

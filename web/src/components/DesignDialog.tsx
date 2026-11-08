// The page's design: one click for a whole look, then any part of it by hand. Changes show on the
// page behind the dialog as they are made, and Ctrl+Z undoes them. Flags with their own Look keep it.

import { useRef } from 'react';
import { Paintbrush, X } from 'lucide-react';
import { type CardLook, type ChartLook, type HoistDesign, LOOKS, MAX_CORNERS, MAX_RADIUS } from '../../../src/core/design.ts';
import { useModal } from '../lib/modal.ts';
import { Choice, Group, PalettePicker, Slider, Switch } from './StyleControls.tsx';

export function DesignDialog({ design, onChange, onClose }: { design: HoistDesign | undefined; onChange: (design: HoistDesign | undefined) => void; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const d = design ?? {};
  const charts = d.charts ?? {};
  // Editing any part makes it the analyst's own look rather than the named one.
  const set = (patch: Partial<HoistDesign>) => {
    const { look: _look, ...rest } = d;
    const next: HoistDesign = { ...rest, ...patch };
    for (const k of Object.keys(next) as Array<keyof HoistDesign>) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const setCharts = (patch: Partial<ChartLook>) => {
    const next: ChartLook = { ...charts, ...patch };
    for (const k of Object.keys(next) as Array<keyof ChartLook>) if (next[k] === undefined) delete next[k];
    set({ charts: next });
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/10" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Page design" className="scroll-thin flex h-full w-[400px] max-w-full flex-col overflow-y-auto border-l border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Paintbrush size={16} aria-hidden="true" className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Page design</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <Group title="Looks">
            <div className="grid grid-cols-1 gap-1">
              {LOOKS.map((l) => {
                const on = (d.look ?? (design ? '' : 'standard')) === l.id;
                return (
                  <button key={l.id} type="button" aria-pressed={on} onClick={() => onChange(l.id === 'standard' ? undefined : { ...l.design, look: l.id })} className={`rounded-md border px-2.5 py-1.5 text-left ${on ? 'border-accent bg-accent-soft' : 'border-[var(--fl-control-border)] hover:border-accent'}`}>
                    <span className="block text-sm font-semibold">{l.label}</span>
                    <span className="block text-xs text-ink-2">{l.detail}</span>
                  </button>
                );
              })}
            </div>
          </Group>

          <Group title="Page">
            {/* 'standard' is the page as the skin draws it (designAttrs' default); choosing it clears the setting. */}
            <Choice<CardLook | 'standard'> label="Cards" value={d.card ?? 'standard'} options={[{ id: 'standard', label: 'Standard' }, { id: 'raised', label: 'Raised' }, { id: 'outline', label: 'Outlined' }, { id: 'flat', label: 'Flat' }, { id: 'glass', label: 'Glass' }]} onChange={(card) => set({ card: card === 'standard' ? undefined : card })} />
            <Slider label="Card corners" value={d.radius ?? 12} min={0} max={MAX_RADIUS} onChange={(radius) => set({ radius })} />
            <Choice label="Backdrop" value={d.backdrop ?? 'plain'} options={[{ id: 'plain', label: 'Plain' }, { id: 'tide', label: 'Tide' }, { id: 'dawn', label: 'Dawn' }, { id: 'grid', label: 'Ruled' }]} onChange={(backdrop) => set({ backdrop })} />
            <Choice label="Type" value={d.font ?? 'system'} options={[{ id: 'system', label: 'Standard' }, { id: 'serif', label: 'Serif' }, { id: 'condensed', label: 'Condensed' }, { id: 'mono', label: 'Fixed width' }]} onChange={(font) => set({ font })} />
          </Group>

          <Group title="Every chart">
            <PalettePicker look={charts} onChange={setCharts} />
            <Choice label="Fill" value={charts.fill ?? 'solid'} options={[{ id: 'solid', label: 'Solid' }, { id: 'gradient', label: 'Gradient' }]} onChange={(fill) => setCharts({ fill })} />
            <Slider label="Rounded bars" value={charts.corners ?? 0} min={0} max={MAX_CORNERS} onChange={(corners) => setCharts({ corners })} />
            <Switch label="Glow" checked={!!charts.glow} onChange={(glow) => setCharts({ glow })} />
            <Switch label="Hovering dims the rest" checked={!!charts.focus} onChange={(focus) => setCharts({ focus })} />
            <Choice label="How the page arrives" value={charts.motion ?? 'calm'} options={[{ id: 'none', label: 'None' }, { id: 'calm', label: 'Calm' }, { id: 'lively', label: 'Lively' }]} onChange={(motion) => setCharts({ motion })} />
            <p className="text-[11px] text-ink-3">Anyone whose system asks for less motion sees none, whatever is set here. Colour rules keep their colours in every look.</p>
          </Group>
        </div>
      </section>
    </div>
  );
}

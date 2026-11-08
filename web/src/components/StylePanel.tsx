// A flag's Look, in the inspector: how it is drawn, which never changes what it means. A reviewed
// flag stays reviewed. Only the settings that apply to this flag's kind are shown.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Palette as PaletteIcon, RotateCcw } from 'lucide-react';
import { type FlagStyle, type HoistDesign, MAX_CORNERS, resolveStyle } from '../../../src/core/design.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { Choice, Group, PalettePicker, Slider, Switch } from './StyleControls.tsx';

export interface StylePanelProps {
  flag: Flag;
  design: HoistDesign | undefined;
  /** The chart has a second field, so its bars can stack. */
  hasSeries: boolean;
  onStyle: (style: FlagStyle | undefined) => void;
  onUseForPage: () => void;
  onOpenDesign: () => void;
}

const MOTION = [{ id: 'none', label: 'None' }, { id: 'calm', label: 'Calm' }, { id: 'lively', label: 'Lively' }] as const;

export function StylePanel({ flag, design, hasSeries, onStyle, onUseForPage, onOpenDesign }: StylePanelProps) {
  const [open, setOpen] = useState(false);
  const own = flag.style ?? {};
  const shown = resolveStyle(design, flag.style);
  const set = (patch: Partial<FlagStyle>) => {
    const next: FlagStyle = { ...own, ...patch };
    for (const k of Object.keys(next) as Array<keyof FlagStyle>) if (next[k] === undefined) delete next[k];
    onStyle(Object.keys(next).length ? next : undefined);
  };
  const k = flag.kind;
  const bar = k === 'bar';
  const line = k === 'line' || k === 'area';
  const pie = k === 'pie';
  const chart = bar || line || pie;
  const Icon = open ? ChevronDown : ChevronRight;
  if (k === 'filter') return null;
  return (
    <section aria-label="Look">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-8 w-full items-center gap-1 text-xs font-semibold text-ink-2 hover:text-ink">
        <Icon size={14} aria-hidden="true" />
        <PaletteIcon size={13} aria-hidden="true" className="text-brass" /> Look
        {flag.style && <span className="ml-1 font-normal text-ink-3">changed</span>}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {chart && (
            <Group title="Colour and finish">
              <PalettePicker look={own} inherit onChange={set} />
              {!(k === 'line') && <Choice label="Fill" value={shown.fill ?? 'solid'} options={[{ id: 'solid', label: 'Solid' }, { id: 'gradient', label: 'Gradient' }]} onChange={(fill) => set({ fill })} />}
              <Switch label="Glow" checked={!!shown.glow} onChange={(glow) => set({ glow })} />
              {(bar || pie) && <Slider label="Rounded corners" value={shown.corners ?? 0} min={0} max={MAX_CORNERS} onChange={(corners) => set({ corners })} />}
            </Group>
          )}

          {bar && (
            <Group title="Bars">
              {hasSeries && <Choice label="Layout" value={shown.barLayout ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'stacked', label: 'Stacked' }, { id: 'grouped', label: 'Side by side' }, { id: 'percent', label: '100%' }]} onChange={(barLayout) => set({ barLayout })} />}
              <Choice label="Direction" value={shown.orientation ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'vertical', label: 'Up' }, { id: 'horizontal', label: 'Across' }]} onChange={(orientation) => set({ orientation })} />
            </Group>
          )}

          {line && (
            <Group title="Line">
              <Choice label="Shape" value={shown.curve ?? 'smooth'} options={[{ id: 'smooth', label: 'Smooth' }, { id: 'straight', label: 'Straight' }, { id: 'step', label: 'Steps' }]} onChange={(curve) => set({ curve })} />
              <Slider label="Thickness" value={shown.lineWidth ?? 2} min={1} max={6} onChange={(lineWidth) => set({ lineWidth })} />
              <Choice label="Points" value={shown.markers ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'on', label: 'Show' }, { id: 'off', label: 'Hide' }]} onChange={(markers) => set({ markers })} />
              <Switch label="Start the scale at zero" title="Off shows small changes better, and makes them look bigger than they are" checked={shown.zeroBase !== false} onChange={(on) => set({ zeroBase: on ? undefined : false })} />
            </Group>
          )}

          {pie && (
            <Group title="Shape">
              <Choice label="Draw as" value={shown.pieForm ?? 'donut'} options={[{ id: 'donut', label: 'Donut' }, { id: 'pie', label: 'Pie' }, { id: 'rose', label: 'Rose' }, { id: 'funnel', label: 'Funnel' }, { id: 'treemap', label: 'Treemap' }]} onChange={(pieForm) => set({ pieForm })} />
            </Group>
          )}

          {k === 'kpi' && (
            <Group title="Number">
              <Choice label="Draw as" value={shown.kpiForm ?? 'number'} options={[{ id: 'number', label: 'Number' }, { id: 'gauge', label: 'Gauge' }]} onChange={(kpiForm) => set({ kpiForm })} />
              {shown.kpiForm === 'gauge' ? (
                <label className="block text-[11px] font-medium text-ink-2">
                  Top of the gauge
                  <input type="number" min={0} value={own.gaugeMax ?? ''} onChange={(e) => set({ gaugeMax: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })} className="mt-1 block h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs" />
                  {!own.gaugeMax && <span className="mt-1 block font-normal text-warn">Set the top of the scale to see the gauge.</span>}
                </label>
              ) : (
                <Choice label="Size" value={shown.kpiSize ?? 'medium'} options={[{ id: 'small', label: 'S' }, { id: 'medium', label: 'M' }, { id: 'large', label: 'L' }, { id: 'huge', label: 'XL' }]} onChange={(kpiSize) => set({ kpiSize })} />
              )}
            </Group>
          )}

          {k === 'table' && (
            <Group title="Table">
              <Switch label="Stripes" checked={!!shown.striped} onChange={(striped) => set({ striped })} />
              <Switch label="Bars behind the numbers" checked={!!shown.tableBars} onChange={(tableBars) => set({ tableBars })} />
            </Group>
          )}

          {chart && (
            <Group title="Labels and guides">
              <Choice label="Values on the marks" value={shown.labels ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'on', label: 'Show' }, { id: 'off', label: 'Hide' }]} onChange={(labels) => set({ labels })} />
              <Choice label="Legend" value={shown.legend ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }, { id: 'right', label: 'Right' }, { id: 'off', label: 'Hide' }]} onChange={(legend) => set({ legend })} />
              {!pie && <Switch label="Grid lines" checked={shown.gridLines !== false} onChange={(gridLines) => set({ gridLines })} />}
              {!pie && <Switch label="Average line" checked={!!shown.average} onChange={(average) => set({ average })} />}
              {!pie && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-medium text-ink-2">
                    Target line
                    <input type="number" aria-label="Target value" value={own.target?.value ?? ''} onChange={(e) => set({ target: e.target.value === '' ? undefined : { value: Number(e.target.value), label: own.target?.label ?? '' } })} className="mt-1 block h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs" />
                  </label>
                  <label className="text-[11px] font-medium text-ink-2">
                    Its label
                    <input maxLength={40} disabled={!own.target} value={own.target?.label ?? ''} placeholder="Target" onChange={(e) => own.target && set({ target: { ...own.target, label: e.target.value } })} className="mt-1 block h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs disabled:opacity-50" />
                  </label>
                </div>
              )}
            </Group>
          )}

          {(chart || k === 'kpi') && (
            <Group title="Motion and hover">
              <Choice label="How it arrives" value={shown.motion ?? 'calm'} options={MOTION} onChange={(motion) => set({ motion })} />
              {chart && <Switch label="Hovering dims the rest" checked={!!shown.focus} onChange={(focus) => set({ focus })} />}
              {chart && !pie && <Switch label="Zoom slider" title="Drag the slider, or hold Ctrl and use the wheel" checked={!!shown.zoom} onChange={(zoom) => set({ zoom })} />}
            </Group>
          )}

          <Group title="Card">
            <Choice label="Title" value={shown.titleAlign ?? 'left'} options={[{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centred' }]} onChange={(titleAlign) => set({ titleAlign })} />
            <Switch label="Hide the title" checked={!!shown.hideTitle} onChange={(hideTitle) => set({ hideTitle })} />
            <Switch label="Coloured strip along the top" checked={!!own.accent} onChange={(on) => set({ accent: on ? '#1f6f8b' : undefined })} />
            {own.accent && <input type="color" aria-label="Strip colour" value={own.accent} onChange={(e) => set({ accent: e.target.value })} className="h-8 w-8 cursor-pointer rounded border border-[var(--fl-control-border)] bg-transparent p-0.5" />}
          </Group>

          <div className="flex flex-wrap gap-1 border-t border-line pt-2">
            {flag.style && (
              <button type="button" onClick={onUseForPage} className="min-h-8 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
                Use on every flag
              </button>
            )}
            <button type="button" onClick={onOpenDesign} className="min-h-8 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
              Page design…
            </button>
            {flag.style && (
              <button type="button" onClick={() => onStyle(undefined)} className="flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-2 hover:text-ink">
                <RotateCcw size={12} aria-hidden="true" /> Reset
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

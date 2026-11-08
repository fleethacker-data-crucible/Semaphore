// A flag's Look, in the inspector: how it is drawn, which never changes what it means. A reviewed
// flag stays reviewed. Only the settings that apply to this flag's kind are shown.

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Palette as PaletteIcon, RotateCcw } from 'lucide-react';
import { type FlagStyle, type HoistDesign, MAX_CORNERS, resolveStyle } from '../../../src/core/design.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { comboRoles, type ComboRole } from '../../../src/core/combo.ts';
import type { PivotHeat, PivotSpec } from '../../../src/core/pivot-spec.ts';
import { listRegionMaps, type RegionMapInfo } from '../lib/maps.ts';
import { Choice, Group, PalettePicker, Slider, Switch } from './StyleControls.tsx';

/** The combo settings with one measure's role changed; a role that matches the default is left out. */
export function withComboRole(style: FlagStyle['combo'], metrics: readonly string[], metric: string, patch: Partial<ComboRole>): FlagStyle['combo'] {
  const defaults = comboRoles(metrics, undefined).find((r) => r.metric === metric)!;
  const next = { ...(style?.[metric] ?? {}), ...patch };
  const out = { ...(style ?? {}) };
  const kept: Partial<ComboRole> = {};
  if (next.as && next.as !== defaults.as) kept.as = next.as;
  if (next.axis && next.axis !== defaults.axis) kept.axis = next.axis;
  if (Object.keys(kept).length) out[metric] = kept;
  else delete out[metric];
  return Object.keys(out).length ? out : undefined;
}

/** The region maps in the Semaphore folder, for a map flag's Look. */
function useRegionMaps(wanted: boolean): RegionMapInfo[] {
  const [maps, setMaps] = useState<RegionMapInfo[]>([]);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    listRegionMaps().then((m) => live && setMaps(m), () => {});
    return () => {
      live = false;
    };
  }, [wanted]);
  return maps;
}

export interface StylePanelProps {
  flag: Flag;
  design: HoistDesign | undefined;
  /** The chart has a second field, so its bars can stack. */
  hasSeries: boolean;
  onStyle: (style: FlagStyle | undefined) => void;
  onUseForPage: () => void;
  onOpenDesign: () => void;
  /** Pivot flags: heat shading lives with the pivot's settings. */
  onPivot?: (pivot: PivotSpec | undefined) => void;
  index?: CatalogIndex;
}

const HEAT = [{ id: 'off', label: 'Off' }, { id: 'row', label: 'By row' }, { id: 'column', label: 'By column' }, { id: 'table', label: 'Whole table' }] as const;

/** The pivot settings with one measure's heat shading changed ('off' removes it). */
export function withHeat(pivot: PivotSpec | undefined, measure: string, heat: PivotHeat | 'off'): PivotSpec | undefined {
  const next: Record<string, PivotHeat> = { ...(pivot?.heat ?? {}) };
  if (heat === 'off') delete next[measure];
  else next[measure] = heat;
  const { heat: _old, ...rest } = pivot ?? {};
  const out: PivotSpec = Object.keys(next).length ? { ...rest, heat: next } : rest;
  return Object.keys(out).length ? out : undefined;
}

const MOTION = [{ id: 'none', label: 'None' }, { id: 'calm', label: 'Calm' }, { id: 'lively', label: 'Lively' }] as const;

export function StylePanel({ flag, design, hasSeries, onStyle, onUseForPage, onOpenDesign, onPivot, index }: StylePanelProps) {
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
  const combo = k === 'combo';
  const map = k === 'map';
  const chart = bar || line || pie || combo;
  const metrics = flag.binding?.metrics ?? [];
  const regionMaps = useRegionMaps(open && map);
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
              {(bar || pie || combo) && <Slider label="Rounded corners" value={shown.corners ?? 0} min={0} max={MAX_CORNERS} onChange={(corners) => set({ corners })} />}
            </Group>
          )}

          {bar && (
            <Group title="Bars">
              {hasSeries && <Choice label="Layout" value={shown.barLayout ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'stacked', label: 'Stacked' }, { id: 'grouped', label: 'Side by side' }, { id: 'percent', label: '100%' }]} onChange={(barLayout) => set({ barLayout })} />}
              <Choice label="Direction" value={shown.orientation ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'vertical', label: 'Up' }, { id: 'horizontal', label: 'Across' }]} onChange={(orientation) => set({ orientation })} />
            </Group>
          )}

          {combo && (
            <Group title="Bars and line">
              {metrics.length < 2 && <p className="text-[11px] text-ink-3">Add a second measure to draw it as a line.</p>}
              {comboRoles(metrics, own.combo).map((r) => (
                <div key={r.metric} className="grid grid-cols-2 gap-2" role="group" aria-label={`How ${index?.metric(r.metric)?.label ?? r.metric} is drawn`}>
                  <Choice label={index?.metric(r.metric)?.label ?? r.metric} value={r.as} options={[{ id: 'bar', label: 'Bars' }, { id: 'line', label: 'Line' }]} onChange={(as) => set({ combo: withComboRole(own.combo, metrics, r.metric, { as }) })} />
                  <Choice label="Scale" value={r.axis} options={[{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }]} onChange={(axis) => set({ combo: withComboRole(own.combo, metrics, r.metric, { axis }) })} />
                </div>
              ))}
              {metrics.length > 1 && <Choice label="Bars" value={shown.barLayout === 'stacked' ? 'stacked' : 'grouped'} options={[{ id: 'grouped', label: 'Side by side' }, { id: 'stacked', label: 'Stacked' }]} onChange={(v) => set({ barLayout: v === 'stacked' ? 'stacked' : undefined })} />}
            </Group>
          )}

          {(line || combo) && (
            <Group title="Line">
              <Choice label="Shape" value={shown.curve ?? 'smooth'} options={[{ id: 'smooth', label: 'Smooth' }, { id: 'straight', label: 'Straight' }, { id: 'step', label: 'Steps' }]} onChange={(curve) => set({ curve })} />
              <Slider label="Thickness" value={shown.lineWidth ?? 2} min={1} max={6} onChange={(lineWidth) => set({ lineWidth })} />
              <Choice label="Points" value={shown.markers ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'on', label: 'Show' }, { id: 'off', label: 'Hide' }]} onChange={(markers) => set({ markers })} />
              {line && <Switch label="Start the scale at zero" title="Off shows small changes better, and makes them look bigger than they are" checked={shown.zeroBase !== false} onChange={(on) => set({ zeroBase: on ? undefined : false })} />}
            </Group>
          )}

          {map && (
            <Group title="Map">
              <label className="block text-[11px] font-medium text-ink-2">
                Draw on
                <select aria-label="Map" value={own.map ?? 'us-states'} onChange={(e) => set({ map: e.target.value === 'us-states' ? undefined : e.target.value })} className="mt-1 block h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs">
                  <option value="us-states">US states (built in)</option>
                  {own.map && own.map !== 'us-states' && !regionMaps.some((m) => m.id === own.map) && <option value={own.map}>{own.map}</option>}
                  {regionMaps.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.regions} regions)
                    </option>
                  ))}
                </select>
                <span className="mt-1 block font-normal text-ink-3">Add your own regions in Settings &gt; Maps.</span>
              </label>
              <PalettePicker look={own} inherit onChange={set} />
              <Choice label="Names on the map" value={shown.labels ?? 'auto'} options={[{ id: 'auto', label: 'Best fit' }, { id: 'on', label: 'Show' }, { id: 'off', label: 'Hide' }]} onChange={(labels) => set({ labels })} />
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

          {k === 'pivot' && (
            <Group title="Heat shading">
              <PalettePicker look={own} inherit onChange={set} />
              {(flag.binding?.metrics ?? []).map((m) => (
                <Choice key={m} label={index?.metric(m)?.label ?? m} value={flag.pivot?.heat?.[m] ?? 'off'} options={HEAT} onChange={(v) => onPivot?.(withHeat(flag.pivot, m, v))} />
              ))}
              {!flag.binding?.metrics.length && <p className="text-[11px] text-ink-3">Add a measure to shade its cells.</p>}
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

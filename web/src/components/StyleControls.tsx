// The small controls the flag's Look section and the page's Design dialog share.

import type { ReactNode } from 'react';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { type ChartLook, colorWarnings, MAX_COLORS, PALETTES, type PaletteId } from '../../../src/core/design.ts';
import { themeColors, themeMode } from './Chart.tsx';

export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | undefined; options: ReadonlyArray<{ id: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-[11px] font-medium text-ink-2">{label}</legend>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)} className={`min-h-8 rounded-md border px-2 text-xs ${value === o.id ? 'border-accent bg-accent-soft text-accent' : 'border-[var(--fl-control-border)] text-ink-2 hover:border-accent'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function Switch({ label, title, checked, onChange }: { label: string; title?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-8 items-center gap-2 text-xs text-ink" title={title}>
      <input type="checkbox" className="size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Slider({ label, value, min, max, unit = 'px', onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label className="block text-[11px] font-medium text-ink-2">
      <span className="flex justify-between">
        {label}
        <span className="tabular-nums text-ink-3">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1 block h-8 w-full accent-[var(--accent)]" />
    </label>
  );
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t border-line pt-2 first:border-t-0 first:pt-0">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brass">{title}</h4>
      {children}
    </div>
  );
}

function Swatches({ colors }: { colors: readonly string[] }) {
  return (
    <span aria-hidden="true" className="flex overflow-hidden rounded-sm">
      {colors.slice(0, 6).map((c) => (
        <span key={c} className="h-3 w-2.5" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Pick a palette, or build one. `inherit` adds a "use the page's" choice for a single flag. */
export function PalettePicker({ look, inherit, onChange }: { look: Pick<ChartLook, 'palette' | 'colors'>; inherit?: boolean; onChange: (patch: Pick<ChartLook, 'palette' | 'colors'>) => void }) {
  const c = themeColors();
  const mode = themeMode();
  const ids = Object.keys(PALETTES) as Array<keyof typeof PALETTES>;
  const current: PaletteId | undefined = look.palette;
  const tile = (on: boolean) => `flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-xs ${on ? 'border-accent bg-accent-soft text-accent' : 'border-[var(--fl-control-border)] text-ink-2 hover:border-accent'}`;
  const custom = look.colors?.length ? look.colors : c.series.slice(0, 4);
  const warnings = current === 'custom' ? colorWarnings(custom, c.panel.startsWith('#') ? c.panel : '') : [];
  const setCustom = (colors: string[]) => onChange({ palette: 'custom', colors });
  return (
    <fieldset className="space-y-1">
      <legend className="text-[11px] font-medium text-ink-2">Colours</legend>
      <div className="flex flex-wrap gap-1">
        {inherit && (
          <button type="button" aria-pressed={current === undefined} onClick={() => onChange({ palette: undefined, colors: undefined })} className={tile(current === undefined)}>
            Page's
          </button>
        )}
        <button type="button" aria-pressed={current === 'skin'} onClick={() => onChange({ palette: 'skin', colors: undefined })} className={tile(current === 'skin')}>
          <Swatches colors={c.series} /> Skin
        </button>
        {ids.map((id) => (
          <button key={id} type="button" aria-pressed={current === id} onClick={() => onChange({ palette: id, colors: undefined })} className={tile(current === id)}>
            <Swatches colors={PALETTES[id][mode]} /> {PALETTES[id].label}
          </button>
        ))}
        <button type="button" aria-pressed={current === 'custom'} onClick={() => setCustom(custom)} className={tile(current === 'custom')}>
          Your own
        </button>
      </div>
      {current === 'custom' && (
        <div className="space-y-1 pt-1">
          <div className="flex flex-wrap items-center gap-1">
            {custom.map((color, i) => (
              <span key={i} className="flex items-center">
                <input type="color" aria-label={`Colour ${i + 1}`} value={color} onChange={(e) => setCustom(custom.map((x, j) => (j === i ? e.target.value : x)))} className="h-8 w-8 cursor-pointer rounded border border-[var(--fl-control-border)] bg-transparent p-0.5" />
                {custom.length > 1 && (
                  <button type="button" aria-label={`Remove colour ${i + 1}`} onClick={() => setCustom(custom.filter((_, j) => j !== i))} className="flex h-8 w-5 items-center justify-center text-ink-3 hover:text-bad">
                    <X size={12} />
                  </button>
                )}
              </span>
            ))}
            {custom.length < MAX_COLORS && (
              <button type="button" aria-label="Add a colour" onClick={() => setCustom([...custom, c.series[custom.length % c.series.length]!])} className="flex h-8 w-8 items-center justify-center rounded border border-dashed border-[var(--fl-control-border)] text-ink-2 hover:border-accent">
                <Plus size={13} />
              </button>
            )}
          </div>
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-1 text-[11px] text-warn">
              <AlertTriangle size={12} aria-hidden="true" className="mt-px shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}
    </fieldset>
  );
}

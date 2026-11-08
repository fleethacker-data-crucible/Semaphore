// Settings > Appearance: the Theme, "Make it yours" and Assistant orb cards, laid out as Lazarette lays out its own
// (Lazarette ui-src/src/views/settings/SettingsView.svelte). The theme lives in this browser
// (lib/theme.ts); a theme exported here imports into Lazarette, and the other way round.

import type { ReactNode } from 'react';
import { Download, Monitor, Moon, RotateCcw, Sparkles, Sun, Upload } from 'lucide-react';
import { setReduceMotionChoice, useReduceMotionChoice } from '../lib/motion.ts';
import { setAssistantOrb, useAssistantOrb } from '../lib/assistant-bus.ts';
import { ORB_LOOKS, ORB_THEMES, type OrbLook, type OrbTalk, type OrbTheme, setOrbPrefs, useOrbPrefs } from '../lib/orb-prefs.ts';
import { theme, type ThemeSpec, useTheme } from '../lib/theme.ts';
import { contrastRatio, edited, exportTheme as themeJson, isPreset as presetAsItComes, parseTheme, PRESETS, sameTheme, surprise } from '../lib/theme-presets.ts';
import { notify } from '../lib/toasts.ts';

const btn = 'inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] hover:bg-panel-2 disabled:opacity-40 [&_svg]:size-4';
const select = 'min-h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm';

function Card({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-panel">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">{title}</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">{description}</p>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] text-ink-2">{hint}</p>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-[12px] text-ink-2">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A preset's swatch: its tint behind a bar of its accent, cut to its shape. */
function swatch(p: ThemeSpec) {
  const bg = p.tint || (p.mode === 'light' ? '#fbfaf2' : '#071a26');
  const radius = p.shape === 'pill' ? '999px' : p.shape === 'sharp' ? '2px' : '6px';
  return (
    <span aria-hidden="true" className="flex h-9 w-full overflow-hidden rounded-md border border-line" style={{ background: bg }}>
      <span className="m-auto h-4 w-10" style={{ background: p.accent || '#c9a66b', borderRadius: radius }} />
    </span>
  );
}

export function ThemeCards() {
  const spec = useTheme();
  const reduce = useReduceMotionChoice();
  const orb = useAssistantOrb();
  const orbPrefs = useOrbPrefs();
  const isPreset = presetAsItComes(spec);
  // An edited preset is named Custom, as in Lazarette.
  const set = (next: Partial<ThemeSpec>) => theme.replace(edited(spec, next));
  const pageBg = spec.mode === 'light' ? '#fbfaf2' : '#071a26';
  const accentWarning = spec.accent && contrastRatio(spec.accent, pageBg) < 3 ? 'This accent is hard to see on the page background (contrast under 3:1).' : '';

  const exportTheme = () => {
    const url = URL.createObjectURL(new Blob([themeJson(spec)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `semaphore-theme-${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'custom'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importTheme = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 64 * 1024) {
      notify('That file is too large to be a theme.', { tone: 'error' });
      return;
    }
    const imported = parseTheme(await file.text());
    if (imported) {
      theme.replace(imported);
      notify(`Theme “${imported.name}” applied.`, { tone: 'success' });
    } else notify('That is not a theme file.', { tone: 'error' });
  };
  const tile = (on: boolean) => `flex flex-col gap-2 rounded-lg border p-2 text-left text-[12px] ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2'}`;
  const modeTile = (on: boolean) => `flex min-h-9 items-center justify-center gap-2 rounded-md border p-2 text-[13px] ${on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2'}`;

  return (
    <>
      <Card title="Theme" description="Pick a preset, then make it yours. Themes live in this browser; export one to share it. A theme from Lazarette imports here too.">
        <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Theme presets">
          {PRESETS.map((p) => {
            const on = sameTheme(p, spec);
            return (
              <button key={p.name} type="button" role="radio" aria-checked={on} onClick={() => theme.replace(p)} className={tile(on)}>
                {swatch(p)}
                <span className="font-medium">{p.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => theme.replace(surprise(spec))} className={`${btn} border border-[var(--fl-control-border)]`}>
            <Sparkles aria-hidden="true" /> Surprise me
          </button>
          <button type="button" onClick={() => theme.reset()} className={btn}>
            <RotateCcw aria-hidden="true" /> Back to Fleet
          </button>
          <span className="flex-1" />
          <button type="button" onClick={exportTheme} className={btn}>
            <Download aria-hidden="true" /> Export
          </button>
          <label className={`${btn} cursor-pointer`}>
            <Upload aria-hidden="true" /> Import
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void importTheme(e.currentTarget)} />
          </label>
        </div>
      </Card>

      <Card title="Make it yours" description={isPreset ? `Editing the ${spec.name} preset.` : `Custom theme “${spec.name}”.`}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Mode">
              {([
                { v: 'dark', l: 'Dark', I: Moon },
                { v: 'light', l: 'Light', I: Sun },
                { v: 'system', l: 'System', I: Monitor },
              ] as const).map((o) => (
                <button key={o.v} type="button" role="radio" aria-checked={spec.mode === o.v} onClick={() => set({ mode: o.v })} className={modeTile(spec.mode === o.v)} data-testid={`theme-${o.v}`}>
                  <o.I size={16} aria-hidden="true" /> {o.l}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span>
                <span className="font-medium">Accent</span>
                <span className="block text-[12px] text-ink-2">Buttons, links, the active item and the first chart colour.</span>
              </span>
              <span className="flex items-center gap-2">
                <input type="color" value={spec.accent || '#c9a66b'} onChange={(e) => set({ accent: e.target.value })} aria-label="Accent colour" className="h-8 w-12 cursor-pointer rounded-md border border-[var(--fl-control-border)] bg-transparent p-0.5" />
                {spec.accent && (
                  <button type="button" aria-label="Use the skin's accent" onClick={() => set({ accent: '' })} className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2">
                    <RotateCcw size={14} />
                  </button>
                )}
              </span>
            </div>
            {accentWarning && <p className="text-[12px] text-warn">{accentWarning}</p>}
            <div className="flex items-center justify-between gap-3 text-[13px]">
              <span>
                <span className="font-medium">Tint</span>
                <span className="block text-[12px] text-ink-2">Mixed into the page, panels and cards.</span>
              </span>
              <span className="flex items-center gap-2">
                <input type="color" value={spec.tint || pageBg} onChange={(e) => set({ tint: e.target.value, tintStrength: spec.tintStrength || 30 })} aria-label="Tint colour" className="h-8 w-12 cursor-pointer rounded-md border border-[var(--fl-control-border)] bg-transparent p-0.5" />
                <input type="range" min={0} max={40} step={5} value={spec.tintStrength} onChange={(e) => set({ tintStrength: Number(e.target.value) })} aria-label="Tint strength" className="h-8 w-24 accent-[var(--accent)]" />
              </span>
            </div>
            <Toggle label="Glow" hint="A soft halo behind the brand and primary buttons." checked={spec.glow} onChange={(glow) => set({ glow })} />
          </div>
          <div className="grid content-start gap-3">
            <Field id="t-shape" label="Shape" hint="Corners on buttons, cards and dialogs.">
              <select id="t-shape" className={select} value={spec.shape} onChange={(e) => set({ shape: e.target.value as ThemeSpec['shape'] })}>
                <option value="sharp">Sharp</option>
                <option value="soft">Soft (Fleet)</option>
                <option value="round">Round</option>
                <option value="pill">Pill</option>
              </select>
            </Field>
            <Field id="t-density" label="Density" hint="How much fits on the screen.">
              <select id="t-density" className={select} value={spec.density} onChange={(e) => set({ density: e.target.value as ThemeSpec['density'] })}>
                <option value="compact">Compact</option>
                <option value="comfortable">Comfortable</option>
                <option value="spacious">Spacious</option>
              </select>
            </Field>
            <Field id="t-type" label="Type" hint="Fonts for text and headings. All ship with Windows.">
              <select id="t-type" className={select} value={spec.type} onChange={(e) => set({ type: e.target.value as ThemeSpec['type'] })}>
                <option value="inter">Segoe UI and Cambria (Fleet)</option>
                <option value="system">Windows system font</option>
                <option value="humanist">Segoe UI</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </select>
            </Field>
            <Field id="t-motion" label="Motion" hint="Transitions and animations.">
              <select id="t-motion" className={select} value={spec.motion} onChange={(e) => set({ motion: e.target.value as ThemeSpec['motion'] })}>
                <option value="full">Full</option>
                <option value="calm">Calm (shorter, no bounce)</option>
                <option value="off">Off</option>
              </select>
            </Field>
            <Field id="t-pattern" label="Background pattern">
              <select id="t-pattern" className={select} value={spec.pattern} onChange={(e) => set({ pattern: e.target.value as ThemeSpec['pattern'] })}>
                <option value="none">None</option>
                <option value="grid">Grid</option>
                <option value="dots">Dots</option>
                <option value="waves">Waves</option>
                <option value="rope">Rope</option>
                <option value="stars">Stars</option>
              </select>
            </Field>
            <Toggle label="High contrast" hint="Stronger borders, text and focus rings." checked={spec.contrast === 'high'} onChange={(on) => set({ contrast: on ? 'high' : 'normal' })} />
          </div>
        </div>
        <div className="mt-5">
          <Toggle label="Reduce motion" hint="Turns off animations even if Windows allows them. Charts, page designs and the orb then stay still." checked={reduce} onChange={setReduceMotionChoice} />
        </div>
      </Card>

      <Card title="Assistant orb" description="The orb has no menu of its own: hovering does nothing. Its look, theme and how you talk to it are chosen here, as in Lazarette.">
        <div className="grid gap-4">
          <Toggle label="Show the orb" hint="A small animated orb that shows what the assistant is doing. Drag it anywhere; click it (or press and hold, below) to open the assistant." checked={orb} onChange={setAssistantOrb} />
          {orb && (
            <div className="grid gap-3 border-l-2 border-line pl-4" data-testid="orb-settings">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <label htmlFor="s-orb-look" className="font-medium">
                  Orb look
                </label>
                <select id="s-orb-look" className={`${select} max-w-[220px]`} value={orbPrefs.look} onChange={(e) => setOrbPrefs({ look: e.target.value as OrbLook })}>
                  {ORB_LOOKS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <label htmlFor="s-orb-theme" className="font-medium">
                  Orb theme
                </label>
                <select id="s-orb-theme" className={`${select} max-w-[220px]`} value={orbPrefs.theme} onChange={(e) => setOrbPrefs({ theme: e.target.value as OrbTheme })}>
                  {ORB_THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span>
                  <label htmlFor="s-orb-talk" className="font-medium">
                    Talk to the orb
                  </label>
                  <span className="block text-[12px] text-ink-2">Click it, or press and hold it. Hovering does nothing.</span>
                </span>
                <select id="s-orb-talk" className={`${select} max-w-[220px]`} value={orbPrefs.talk} onChange={(e) => setOrbPrefs({ talk: e.target.value as OrbTalk })}>
                  <option value="click">Click</option>
                  <option value="hold">Press and hold</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

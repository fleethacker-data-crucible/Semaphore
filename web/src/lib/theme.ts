// Personal themes, the same ones Lazarette has (Lazarette ui-src/src/lib/theme.svelte.ts). A theme is
// a small spec (mode, accent, tint, shape, density, type, motion, pattern, contrast, glow) turned
// into the --fl-* custom properties the Fleet skin draws from, so every Semaphore colour follows it.
// The presets, Surprise me and import and export are in lib/theme-presets.ts, loaded with Settings.
// Everything derives from a handful of colours with color-mix(), so every preset keeps readable
// contrast in both modes. Kept in this browser; a theme exports as a small JSON file, and a file
// exported from Lazarette imports here unchanged (and back).
//
// Themes paint the Fleet skin. The Classic and Colour-blind safe skins keep their own palettes for
// colour, and take shape, density, type, motion, pattern and glow from the theme.

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ThemeShape = 'sharp' | 'soft' | 'round' | 'pill';
export type ThemeDensity = 'compact' | 'comfortable' | 'spacious';
export type ThemeType = 'inter' | 'system' | 'humanist' | 'serif' | 'mono';
export type ThemeMotion = 'full' | 'calm' | 'off';
export type ThemePattern = 'none' | 'grid' | 'dots' | 'waves' | 'rope' | 'stars';
export type ThemeContrast = 'normal' | 'high';

export interface ThemeSpec {
  v: 1;
  name: string;
  mode: ThemeMode;
  /** Hex: the one colour buttons, links and the active state use. Empty for the skin's own. */
  accent: string;
  /** Hex, mixed into backgrounds and surfaces. */
  tint: string;
  /** 0-40 (%). */
  tintStrength: number;
  shape: ThemeShape;
  density: ThemeDensity;
  type: ThemeType;
  motion: ThemeMotion;
  pattern: ThemePattern;
  contrast: ThemeContrast;
  /** A soft accent glow behind the brand and primary buttons. */
  glow: boolean;
}

export const FLEET_THEME: ThemeSpec = {
  v: 1, name: 'Fleet', mode: 'system', accent: '', tint: '', tintStrength: 0,
  shape: 'soft', density: 'comfortable', type: 'inter', motion: 'full', pattern: 'none', contrast: 'normal', glow: false,
};

const KEY = 'semaphore.theme.v1';
/** Before themes: the light or dark choice alone. Read once, as the new theme's mode. */
const FORMER_KEY = 'semaphore.theme';
const HEX = /^#[0-9a-f]{6}$/i;

export function clampSpec(raw: Partial<ThemeSpec> | null | undefined): ThemeSpec {
  const s = { ...FLEET_THEME, ...(raw && typeof raw === 'object' ? raw : {}) } as ThemeSpec;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  return {
    v: 1,
    name: typeof s.name === 'string' ? s.name.slice(0, 40) : 'Custom',
    mode: pick(s.mode, ['dark', 'light', 'system'] as const, 'system'),
    accent: typeof s.accent === 'string' && HEX.test(s.accent) ? s.accent : '',
    tint: typeof s.tint === 'string' && HEX.test(s.tint) ? s.tint : '',
    tintStrength: Math.max(0, Math.min(40, Math.round(Number(s.tintStrength) || 0))),
    shape: pick(s.shape, ['sharp', 'soft', 'round', 'pill'] as const, 'soft'),
    density: pick(s.density, ['compact', 'comfortable', 'spacious'] as const, 'comfortable'),
    type: pick(s.type, ['inter', 'system', 'humanist', 'serif', 'mono'] as const, 'inter'),
    motion: pick(s.motion, ['full', 'calm', 'off'] as const, 'full'),
    pattern: pick(s.pattern, ['none', 'grid', 'dots', 'waves', 'rope', 'stars'] as const, 'none'),
    contrast: pick(s.contrast, ['normal', 'high'] as const, 'normal'),
    glow: s.glow === true,
  };
}

/** Minimal storage and root shapes, so the engine runs in tests without a browser. */
export interface ThemeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
export interface ThemeRoot {
  style: { setProperty(n: string, v: string): void; removeProperty(n: string): void };
  dataset: Record<string, string | undefined>;
}

function browserStorage(): ThemeStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTheme(storage: ThemeStorage | null = browserStorage()): ThemeSpec {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) return clampSpec(JSON.parse(raw) as Partial<ThemeSpec>);
    const former = storage?.getItem(FORMER_KEY);
    const mode = former ? (JSON.parse(former) as unknown) : null;
    return mode === 'light' || mode === 'dark' ? { ...FLEET_THEME, mode } : { ...FLEET_THEME };
  } catch {
    return { ...FLEET_THEME };
  }
}

/** Relative luminance of a hex colour (sRGB), for choosing ink on an accent fill. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** Control, card and dialog corners for each shape (Fleet's soft is 6, 10 and 14). */
const SHAPES: Record<ThemeShape, [string, string, string]> = {
  sharp: ['3px', '4px', '6px'],
  soft: ['6px', '10px', '14px'],
  round: ['10px', '16px', '22px'],
  pill: ['999px', '20px', '28px'],
};
const DENSITY: Record<ThemeDensity, string> = { compact: '0.21rem', comfortable: '0.25rem', spacious: '0.3rem' };
/**
 * Fonts that ship with Windows, so nothing is downloaded. 'inter' is the id Lazarette uses for its
 * default pair; here it means Fleet's own (Segoe UI with Cambria headings), so a Lazarette theme file
 * still reads correctly.
 */
const TYPE: Record<Exclude<ThemeType, 'inter'>, { body: string; display: string; mono: string }> = {
  system: { body: "system-ui, 'Segoe UI', sans-serif", display: "system-ui, 'Segoe UI', sans-serif", mono: 'Consolas, monospace' },
  humanist: { body: "'Segoe UI', 'Trebuchet MS', sans-serif", display: "'Segoe UI', 'Trebuchet MS', sans-serif", mono: 'Consolas, monospace' },
  serif: { body: "Georgia, Cambria, serif", display: "Cambria, Georgia, serif", mono: 'Consolas, monospace' },
  mono: { body: "'Cascadia Mono', Consolas, monospace", display: "'Cascadia Mono', Consolas, monospace", mono: "'Cascadia Mono', Consolas, monospace" },
};

const VARS = [
  '--fl-accent', '--fl-accent-ink', '--fl-background', '--fl-sidebar', '--fl-surface', '--fl-card', '--fl-popover', '--fl-muted', '--fl-border',
  '--fl-border-strong', '--fl-control-border', '--fl-foreground', '--fl-muted-foreground', '--fl-radius-control', '--fl-radius-card',
  '--fl-radius-dialog', '--sem-radius-card', '--spacing', '--fl-font-body', '--fl-font-display', '--fl-font-mono', '--sem-font', '--sem-font-mono',
];

/** The mode the page shows: 'system' follows Windows. */
export function resolveMode(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

/**
 * Writes the spec onto <html>. The page sets data-theme from the resolved mode itself; this writes the
 * colours, corners, spacing, fonts and the attributes the stylesheet reads. Cheap enough to run live.
 */
export function applyThemeSpec(spec: ThemeSpec, dark: boolean, root: ThemeRoot = document.documentElement): void {
  const st = root.style;
  for (const v of VARS) st.removeProperty(v);

  if (spec.accent) {
    st.setProperty('--fl-accent', spec.accent);
    st.setProperty('--fl-accent-ink', luminance(spec.accent) > 0.4 ? '#0b1220' : '#ffffff');
  }
  if (spec.tint && spec.tintStrength > 0) {
    // One tint drives every surface: mixed strongest into the page, lighter into cards, so depth survives.
    const k = spec.tintStrength;
    const fg = dark ? '#f4ead6' : '#132633';
    const mix = (base: string, pct: number) => `color-mix(in oklab, ${spec.tint} ${pct}%, ${base})`;
    st.setProperty('--fl-background', mix(dark ? '#071a26' : '#fbfaf2', k));
    st.setProperty('--fl-sidebar', mix(dark ? '#0a2130' : '#f3efe2', k));
    st.setProperty('--fl-surface', mix(dark ? '#0d2636' : '#ffffff', Math.round(k * 0.8)));
    st.setProperty('--fl-card', mix(dark ? '#112d40' : '#ffffff', Math.round(k * 0.7)));
    st.setProperty('--fl-popover', mix(dark ? '#14334a' : '#ffffff', Math.round(k * 0.7)));
    st.setProperty('--fl-muted', mix(dark ? '#183a52' : '#efe9d9', Math.round(k * 0.6)));
    st.setProperty('--fl-border', `color-mix(in oklab, ${fg} ${dark ? 16 : 14}%, ${mix(dark ? '#071a26' : '#fbfaf2', k)})`);
    st.setProperty('--fl-border-strong', `color-mix(in oklab, ${fg} ${dark ? 28 : 26}%, ${mix(dark ? '#071a26' : '#fbfaf2', k)})`);
  }
  if (spec.contrast === 'high') {
    st.setProperty('--fl-foreground', dark ? '#ffffff' : '#000000');
    st.setProperty('--fl-muted-foreground', dark ? '#d9dde2' : '#2b343b');
    st.setProperty('--fl-border', dark ? '#8a97a3' : '#4b5560');
    st.setProperty('--fl-border-strong', dark ? '#c3ccd4' : '#1f272e');
    st.setProperty('--fl-control-border', dark ? '#c3ccd4' : '#1f272e');
  }
  const [control, card, dialog] = SHAPES[spec.shape];
  if (spec.shape !== 'soft') {
    st.setProperty('--fl-radius-control', control);
    st.setProperty('--fl-radius-card', card);
    st.setProperty('--fl-radius-dialog', dialog);
    st.setProperty('--sem-radius-card', card);
  }
  if (spec.density !== 'comfortable') st.setProperty('--spacing', DENSITY[spec.density]);
  if (spec.type !== 'inter') {
    const t = TYPE[spec.type];
    st.setProperty('--fl-font-body', t.body);
    st.setProperty('--fl-font-display', t.display);
    st.setProperty('--fl-font-mono', t.mono);
    st.setProperty('--sem-font', t.body);
    st.setProperty('--sem-font-mono', t.mono);
  }

  root.dataset.motion = spec.motion;
  root.dataset.pattern = spec.pattern;
  root.dataset.glow = String(spec.glow);
  root.dataset.density = spec.density;
  root.dataset.contrast = spec.contrast;
}

/** The theme as shared state: the Settings screen changes it and the page follows. */
export class ThemeStore {
  private spec: ThemeSpec;
  private readonly listeners = new Set<() => void>();

  private readonly storage: ThemeStorage | null;

  constructor(storage: ThemeStorage | null = browserStorage()) {
    this.storage = storage;
    this.spec = loadTheme(storage);
  }

  get = (): ThemeSpec => this.spec;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Changes part of the theme. Settings names an edited preset "Custom" (lib/theme-presets.ts). */
  set(next: Partial<ThemeSpec>): void {
    this.commit(clampSpec({ ...this.spec, ...next }));
  }

  /** Replaces the whole theme: a preset, a surprise or an imported file. */
  replace(spec: ThemeSpec): void {
    this.commit(clampSpec(spec));
  }

  reset(): void {
    this.replace(FLEET_THEME);
  }

  private commit(spec: ThemeSpec): void {
    this.spec = spec;
    try {
      this.storage?.setItem(KEY, JSON.stringify(spec));
    } catch {
      // Storage blocked: the theme lasts for this page only.
    }
    // Onto the page before anyone re-renders, so charts that read the colours read the new ones.
    applyToDocument(spec);
    for (const l of this.listeners) l();
  }
}

/** Mode, colours and attributes onto <html> now. Nothing happens outside a browser. */
export function applyToDocument(spec: ThemeSpec): void {
  if (typeof document === 'undefined') return;
  let systemDark = false;
  try {
    systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // No media queries: light.
  }
  const dark = resolveMode(spec.mode, systemDark) === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  applyThemeSpec(spec, dark);
}

export const theme = new ThemeStore();

export function useTheme(): ThemeSpec {
  return useSyncExternalStore(theme.subscribe, theme.get, theme.get);
}

/** Whether Windows is set to dark, kept current. */
export function useSystemDark(): boolean {
  return useSyncExternalStore(
    (l) => {
      try {
        const m = matchMedia('(prefers-color-scheme: dark)');
        m.addEventListener('change', l);
        return () => m.removeEventListener('change', l);
      } catch {
        return () => undefined;
      }
    },
    () => {
      try {
        return matchMedia('(prefers-color-scheme: dark)').matches;
      } catch {
        return false;
      }
    },
    () => false,
  );
}

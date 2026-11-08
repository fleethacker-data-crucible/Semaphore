// The parts of the theme only Settings needs (lib/theme.ts holds what the page needs at start):
// Lazarette's presets, Surprise me, contrast checks, and theme files in and out.

import { clampSpec, FLEET_THEME, luminance, type ThemePattern, type ThemeShape, type ThemeSpec } from './theme.ts';

/** Lazarette's presets, unchanged: an accent and a tint each; the base light or dark palette does the rest. */
export const PRESETS: ThemeSpec[] = [
  FLEET_THEME,
  { ...FLEET_THEME, name: 'Midnight', mode: 'dark', accent: '#7c9cff', tint: '#0b1020', tintStrength: 40, shape: 'round', glow: true },
  { ...FLEET_THEME, name: 'Harbor', mode: 'dark', accent: '#38bdf8', tint: '#062a3a', tintStrength: 30, pattern: 'waves' },
  { ...FLEET_THEME, name: 'Ember', mode: 'dark', accent: '#fb923c', tint: '#1a0b0b', tintStrength: 35, glow: true },
  { ...FLEET_THEME, name: 'Forest', mode: 'dark', accent: '#4ade80', tint: '#06160e', tintStrength: 35, pattern: 'dots' },
  { ...FLEET_THEME, name: 'Graphite', mode: 'dark', accent: '#e5e7eb', tint: '#111214', tintStrength: 40, shape: 'sharp', type: 'mono' },
  { ...FLEET_THEME, name: 'Paper', mode: 'light', accent: '#1f2937', tint: '#f8f6f0', tintStrength: 30, type: 'serif', shape: 'sharp' },
  { ...FLEET_THEME, name: 'Lagoon', mode: 'light', accent: '#0e7490', tint: '#e6f6f7', tintStrength: 30, shape: 'round' },
  { ...FLEET_THEME, name: 'Rose', mode: 'light', accent: '#be185d', tint: '#fff1f5', tintStrength: 30, shape: 'pill', pattern: 'dots' },
  { ...FLEET_THEME, name: 'Signal', mode: 'dark', accent: '#facc15', tint: '#000000', tintStrength: 40, contrast: 'high', shape: 'sharp', motion: 'calm' },
];

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function sameTheme(a: ThemeSpec, b: ThemeSpec): boolean {
  const keys: Array<keyof ThemeSpec> = ['mode', 'accent', 'tint', 'tintStrength', 'shape', 'density', 'type', 'motion', 'pattern', 'contrast', 'glow'];
  return keys.every((k) => a[k] === b[k]);
}

export function hslToHex(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * sl;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Whether the theme is one of the presets as it comes. */
export function isPreset(spec: ThemeSpec): boolean {
  return PRESETS.some((p) => sameTheme(p, spec));
}

/** The theme with a change, named "Custom" once it is no longer a preset as it comes (as in Lazarette). */
export function edited(spec: ThemeSpec, next: Partial<ThemeSpec>): ThemeSpec {
  return clampSpec({ ...spec, ...next, name: next.name ?? (isPreset(spec) ? 'Custom' : spec.name) });
}

/** A fresh combination: accent and tint on one hue family, the accent walked until it reads at 4.5:1. */
export function surprise(spec: ThemeSpec, random: () => number = Math.random): ThemeSpec {
  const hue = Math.floor(random() * 360);
  const dark = random() < 0.6;
  const tint = hslToHex((hue + (random() < 0.5 ? 0 : 180)) % 360, 40, dark ? 10 : 96);
  let light = dark ? 62 : 38;
  let accent = hslToHex(hue, 70, light);
  while (contrastRatio(accent, tint) < 4.5 && light > 20 && light < 85) {
    light += dark ? 4 : -4;
    accent = hslToHex(hue, 70, light);
  }
  const shapes: ThemeShape[] = ['soft', 'round', 'pill', 'sharp'];
  const patterns: ThemePattern[] = ['none', 'none', 'dots', 'grid', 'waves', 'stars', 'rope'];
  return clampSpec({
    ...spec,
    name: 'Surprise',
    mode: dark ? 'dark' : 'light',
    accent,
    tint,
    tintStrength: 25 + Math.floor(random() * 15),
    shape: shapes[Math.floor(random() * shapes.length)]!,
    pattern: patterns[Math.floor(random() * patterns.length)]!,
    glow: dark && random() < 0.5,
    contrast: 'normal',
  });
}

export function exportTheme(spec: ThemeSpec): string {
  return JSON.stringify(spec, null, 2);
}

/** The theme in a file, or null when the text is not one. Unknown or wrong values fall back to Fleet's. */
export function parseTheme(text: string): ThemeSpec | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return clampSpec(raw as Partial<ThemeSpec>);
  } catch {
    return null;
  }
}

export { FLEET_THEME };

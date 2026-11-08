// How the assistant orb looks and how you talk to it, as Lazarette has them (Lazarette
// ui-src/src/lib/assistant-orb.ts, PR 140): chosen in Settings > Appearance > Assistant orb, never
// from a menu on the orb. Hovering the orb does nothing. Kept in this browser.

import { useSyncExternalStore } from 'react';

/** Looks and themes the Binnacle orb draws (vendor/binnacle). */
export const ORB_LOOKS = [
  { id: 'ring', label: 'Point ring' },
  { id: 'mesh', label: 'Flow mesh' },
  { id: 'lightning', label: 'Lightning' },
  { id: 'ribbon', label: 'Ribbons' },
  { id: 'eclipse', label: 'Eclipse' },
] as const;
export const ORB_THEMES = [
  { id: 'brass', label: 'Navy brass' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'ember', label: 'Ember' },
  { id: 'glacier', label: 'Glacier' },
  { id: 'reef', label: 'Reef' },
] as const;
export type OrbLook = (typeof ORB_LOOKS)[number]['id'];
export type OrbTheme = (typeof ORB_THEMES)[number]['id'];
/** How you talk to the orb: a click, or a press held still. */
export type OrbTalk = 'click' | 'hold';

export interface OrbPrefs {
  look: OrbLook;
  theme: OrbTheme;
  talk: OrbTalk;
}

/** A press held this long without moving counts as press and hold. */
export const HOLD_MS = 300;
/** Movement beyond this many pixels makes a press a drag. */
export const DRAG_PX = 6;

/** Classifies a press so far: a drag once it moved, a hold once it was held still long enough. */
export function orbGesture(from: { x: number; y: number }, to: { x: number; y: number }, heldMs: number): 'drag' | 'hold' | 'press' {
  if (Math.hypot(to.x - from.x, to.y - from.y) > DRAG_PX) return 'drag';
  return heldMs >= HOLD_MS ? 'hold' : 'press';
}

const KEY = 'semaphore.orb';
const DEFAULTS: OrbPrefs = { look: 'ring', theme: 'brass', talk: 'click' };

/** Reads saved choices, keeping only known values. */
export function parseOrbPrefs(raw: unknown): OrbPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    look: ORB_LOOKS.some((l) => l.id === o.look) ? (o.look as OrbLook) : DEFAULTS.look,
    theme: ORB_THEMES.some((t) => t.id === o.theme) ? (o.theme as OrbTheme) : DEFAULTS.theme,
    talk: o.talk === 'hold' ? 'hold' : 'click',
  };
}

const listeners = new Set<() => void>();
let current: OrbPrefs | null = null;

function read(): OrbPrefs {
  if (current) return current;
  try {
    current = parseOrbPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export function setOrbPrefs(patch: Partial<OrbPrefs>): void {
  current = parseOrbPrefs({ ...read(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const l of listeners) l();
}

export function useOrbPrefs(): OrbPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    read,
  );
}

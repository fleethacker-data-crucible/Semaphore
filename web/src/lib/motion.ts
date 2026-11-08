// Motion rules (UNIFIED-UI 7): 200 ms or less, and none at all when the person prefers reduced motion.

import { useSyncExternalStore } from 'react';

/** Whether the person asked the system for less motion. False where it cannot be read. */
export function reducedMotion(): boolean {
  try {
    if (readChoice()) return true;
    if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off') return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The scroll behaviour to use: instant under reduced motion, smooth otherwise. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? 'auto' : 'smooth';
}

/**
 * Chart animation for a look: off under reduced motion or 'none'. 'calm' moves everything for 180 ms.
 * 'lively' lets marks arrive one after another, but no single mark moves for over 200 ms (UNIFIED-UI 7).
 */
export function chartMotion(level: 'none' | 'calm' | 'lively' = 'calm'): Record<string, unknown> {
  if (level === 'none' || reducedMotion()) return { animation: false };
  if (level === 'lively') return { animation: true, animationDuration: 200, animationEasing: 'cubicOut', animationDelay: (i: number) => Math.min(i * 40, 480), animationDurationUpdate: 180 };
  return { animation: true, animationDuration: 180, animationDurationUpdate: 180 };
}

// A person's own choice to reduce motion, kept in this browser (Settings > Appearance). It adds to
// the system setting: either one turns motion off. <html data-reduce-motion> lets the stylesheet
// follow it the way it follows prefers-reduced-motion.

const CHOICE_KEY = 'semaphore.reduceMotion';
const listeners = new Set<() => void>();

function readChoice(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CHOICE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** True when this person turned motion off in Settings. */
export function reduceMotionChoice(): boolean {
  return readChoice();
}

/** Puts the choice on the document, so CSS can read it. Safe to call before the page has a body. */
export function applyReduceMotionChoice(): void {
  if (typeof document === 'undefined') return;
  // The theme's Motion: Off (lib/theme.ts writes data-motion) counts the same as the switch.
  const off = readChoice() || document.documentElement.dataset.motion === 'off';
  if (off) document.documentElement.dataset.reduceMotion = 'true';
  else delete document.documentElement.dataset.reduceMotion;
  // The orb (vendor/binnacle) reads Lazarette's name for the same thing.
  document.documentElement.dataset.reducedMotion = String(off);
}

export function setReduceMotionChoice(on: boolean): void {
  try {
    if (on) localStorage.setItem(CHOICE_KEY, 'true');
    else localStorage.removeItem(CHOICE_KEY);
  } catch {
    // Storage may be blocked; the choice then lasts for this page only.
  }
  applyReduceMotionChoice();
  for (const l of listeners) l();
}

/** The choice as React state. */
export function useReduceMotionChoice(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readChoice,
    () => false,
  );
}

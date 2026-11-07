// Keys on a selected flag (#77) and the flip state they share with the cards.
//   Enter       open the inspector (moves focus into it)
//   A           accept a drafted flag
//   F           flip it over (what it shows, and the SQL) and back
//   D           duplicate it
// Ctrl+Enter in a flag's brief accepts it (BriefEditor). Like every single-key shortcut these never
// fire while the analyst is typing in a field.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { markStep } from './onboarding.ts';

// ---- Which flags are face down --------------------------------------------------------------
let flipped: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setFlipped(id: string, on: boolean): void {
  if (flipped.has(id) === on) return;
  const next = new Set(flipped);
  if (on) next.add(id);
  else next.delete(id);
  flipped = next;
  if (on) {
    markStep('flip');
  }
  for (const l of listeners) l();
}

export function toggleFlipped(id: string): void {
  setFlipped(id, !flipped.has(id));
}

export function useFlipped(id: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => flipped.has(id),
    () => false,
  );
}

// ---- The keys -------------------------------------------------------------------------------
export interface FlagKeyActions {
  selectedId: string | null;
  /** Status of the selected flag: A only accepts a draft. */
  selectedStatus?: string | undefined;
  onAccept: (id: string) => void;
  onDuplicate: (id: string) => void;
  /** Open the inspector; by default focus moves to its first field. */
  onOpen?: (id: string) => void;
}

/** Whether the event comes from somewhere the analyst types (the shell's typing guard). */
export function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}

/** Move focus into the open inspector: the brief, or the title for a note. */
export function focusInspector(): void {
  requestAnimationFrame(() => {
    const panel = document.getElementById('flag-inspector');
    const target = panel?.querySelector<HTMLElement>('textarea') ?? panel?.querySelector<HTMLElement>('input:not([type=checkbox])');
    target?.focus();
  });
}

/**
 * A key handler for flags, for the shell's keydown listener. Returns true when it handled the
 * key (the caller then stops). Stable across renders.
 */
export function useFlagKeys(actions: FlagKeyActions): (e: KeyboardEvent) => boolean {
  const latest = useRef(actions);
  latest.current = actions;
  return useCallback((e: KeyboardEvent) => {
    const a = latest.current;
    if (!a.selectedId || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return false;
    // A focused control inside a card (a picker chip, the flip button) keeps Enter for itself.
    const t = e.target as HTMLElement | null;
    const onControl = !!t && t.tagName === 'BUTTON';
    const id = a.selectedId;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Enter' && !onControl) {
      e.preventDefault();
      (a.onOpen ?? focusInspector)(id);
      return true;
    }
    if (key === 'a' && a.selectedStatus === 'drafted') {
      e.preventDefault();
      a.onAccept(id);
      return true;
    }
    if (key === 'f') {
      e.preventDefault();
      toggleFlipped(id);
      return true;
    }
    if (key === 'd') {
      e.preventDefault();
      a.onDuplicate(id);
      return true;
    }
    return false;
  }, []);
}

// The builder's keyboard (#77, #85): Ctrl+K palette, ? help, / quick chart, undo and redo, Escape,
// Delete, and arrows to nudge or resize the selected flag. Flag-level keys (A, F, D, Enter) come from
// hooks/useFlagKeys.ts, asked after the typing guard. Nothing fires while a dialog is open (the dialog
// owns the keyboard then), and only Ctrl+K works while typing in a field.

import { useEffect, useRef } from 'react';
import { openModalCount } from '../lib/modal.ts';

export interface ShortcutHandlers {
  enabled: boolean;
  onPalette: () => void;
  onHelp: () => void;
  onAsk: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onEscape: () => void;
  /** Delete or Backspace with a flag selected. */
  onDelete: () => void;
  /** An arrow key with a flag selected: dx, dy, and whether Shift (resize) was held. */
  onArrow: (dx: number, dy: number, resize: boolean) => void;
  hasSelection: boolean;
  /** hooks/useFlagKeys.ts: true when it handled the key. */
  flagKeys: (e: KeyboardEvent) => boolean;
}

export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function useShortcuts(h: ShortcutHandlers): void {
  // Handlers change every render; the listener is added once and reads the latest.
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = ref.current;
      if (!k.enabled || e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
        if (openModalCount() > 0) return;
        e.preventDefault();
        k.onPalette();
        return;
      }
      if (openModalCount() > 0) return;
      const typing = isTyping(e.target);
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) k.onRedo();
        else k.onUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        k.onRedo();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        k.onHelp();
      } else if (e.key === '/') {
        e.preventDefault();
        k.onAsk();
      } else if (e.key === 'Escape') {
        k.onEscape();
      } else if (k.flagKeys(e)) {
        /* a flag key */
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && k.hasSelection) {
        e.preventDefault();
        k.onDelete();
      } else if (k.hasSelection && ARROWS[e.key]) {
        e.preventDefault();
        const [dx, dy] = ARROWS[e.key]!;
        k.onArrow(dx, dy, e.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// Flag-level keys (#77): A accept, F flip, D duplicate, Enter open the inspector, on the selected
// flag. The flags agent owns this file; the page's key handler (hooks/useShortcuts.ts) calls the
// handler it returns after its own `typing` guard, before the arrow and Delete keys, and lists
// FLAG_SHORTCUTS in the Help dialog.

import type { Shortcut } from '../lib/shortcuts.ts';

export interface FlagKeyContext {
  /** The selected flag's id, or null. */
  selectedId: string | null;
}

/** Shortcuts this file handles, for the Help dialog's "With a flag selected" group. */
export const FLAG_SHORTCUTS: Shortcut[] = [];

/** Returns a handler: true when it handled the key (the page then does nothing more with it). */
export function useFlagKeys(_ctx: FlagKeyContext): (e: KeyboardEvent) => boolean {
  return () => false;
}

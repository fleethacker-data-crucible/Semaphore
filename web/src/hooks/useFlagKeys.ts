// Flag-level keys (#77): the handler lives in lib/flag-keys.ts; the page's key handler
// (hooks/useShortcuts.ts) calls it after its own typing guard, before the arrow and Delete keys.
// FLAG_SHORTCUTS lists them in the Help dialog's "With a flag selected" group.

import type { Shortcut } from '../lib/shortcuts.ts';

export { useFlagKeys } from '../lib/flag-keys.ts';

/** Shortcuts lib/flag-keys.ts handles, for the Help dialog. */
export const FLAG_SHORTCUTS: Shortcut[] = [
  { keys: ['Tab'], what: 'Move between flags, in reading order' },
  { keys: ['Enter'], what: 'Open the selected flag in the inspector' },
  { keys: ['A'], what: 'Accept the selected draft' },
  { keys: ['F'], what: 'Flip the selected flag over: its brief, why, and the SQL' },
  { keys: ['D'], what: 'Duplicate the selected flag' },
  { keys: ['Ctrl', 'Enter'], what: 'In the brief: accept the flag' },
];

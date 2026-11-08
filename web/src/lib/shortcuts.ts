// The keyboard shortcuts the page answers to, listed once: the Help dialog (components/HelpDialog.tsx)
// shows this table and the command palette shows the same keys. Flag-level keys live with the flags
// (hooks/useFlagKeys.ts FLAG_SHORTCUTS) and are listed after these.

export interface Shortcut {
  keys: string[];
  what: string;
}

export const SHORTCUTS: Array<{ group: string; items: Shortcut[] }> = [
  {
    group: 'Anywhere in the builder',
    items: [
      { keys: ['Ctrl', 'K'], what: 'Open the command palette: every action, the flags on the page, saved hoists and the catalog' },
      { keys: ['?'], what: 'Open this help' },
      { keys: ['/'], what: 'Quick chart from a question' },
      { keys: ['Ctrl', 'Z'], what: 'Undo' },
      { keys: ['Ctrl', 'Y'], what: 'Redo (also Ctrl+Shift+Z)' },
      { keys: ['Esc'], what: 'Close the top dialog, or deselect the flag' },
    ],
  },
  {
    group: 'With a flag selected',
    items: [
      { keys: ['←', '→', '↑', '↓'], what: 'Move the flag one grid step (an eighth of a cell in Free layout)' },
      { keys: ['Shift', '←', '→', '↑', '↓'], what: 'Make the flag narrower, wider, shorter or taller' },
      { keys: [']'], what: 'Free layout: bring the flag to the front' },
      { keys: ['['], what: 'Free layout: send the flag to the back' },
      { keys: ['Alt'], what: 'Free layout: hold while dragging to line the flag up with the cells' },
      { keys: ['Delete'], what: 'Delete the flag (Undo brings it back)' },
    ],
  },
  {
    group: 'In dialogs and menus',
    items: [
      { keys: ['Tab'], what: 'Next control; focus stays inside the dialog' },
      { keys: ['↑', '↓'], what: 'Move through a menu or the command palette' },
      { keys: ['Enter'], what: 'Run the highlighted command' },
    ],
  },
];

/** Shortcut keys as one string for a tooltip or the palette: ['Ctrl','K'] -> "Ctrl+K". */
export const keysText = (keys: string[]) => keys.join('+');

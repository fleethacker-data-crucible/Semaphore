// The command palette's list and its ranking (#77): every action with its shortcut, the flags on the
// page, saved hoists, catalog measures and fields, and waiting questions. Ranking is a fuzzy match
// plus local recency (the last few commands run in this browser). Plain TypeScript, tested in Node.

import { readLocal, writeLocal } from './storage.ts';

export type CommandGroup = 'Actions' | 'Flags on this page' | 'Saved hoists' | 'Catalog' | 'Questions';
export const GROUP_ORDER: CommandGroup[] = ['Actions', 'Flags on this page', 'Saved hoists', 'Catalog', 'Questions'];

export interface Command {
  /** Stable across renders: recency is kept by id. */
  id: string;
  label: string;
  group: CommandGroup;
  /** A second line: what it does, or where it comes from. */
  hint?: string;
  /** Shown as keys, e.g. "Ctrl+Z". */
  shortcut?: string;
  /** Extra words it answers to. */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/**
 * How well `query` matches `text`, or null when it does not: every query character in order.
 * Consecutive characters, a match at the start of a word, and a match at the very start score more.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 100 + (direct === 0 ? 50 : /\W/.test(t[direct - 1] ?? ' ') ? 25 : 0) - Math.min(direct, 20) - t.length / 100;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    run = at === ti ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || /\W/.test(t[at - 1]!) ? 3 : 0);
    ti = at + 1;
  }
  return score - t.length / 100;
}

export function rankCommands(commands: readonly Command[], query: string, recent: readonly string[] = [], limit = 60): Command[] {
  const q = query.trim();
  const scored: Array<{ c: Command; s: number; i: number }> = [];
  commands.forEach((c, i) => {
    if (c.disabled) return;
    const s = q ? Math.max(fuzzyScore(q, c.label) ?? -Infinity, (fuzzyScore(q, `${c.keywords ?? ''} ${c.hint ?? ''}`) ?? -Infinity) - 20) : 0;
    if (s === -Infinity) return;
    const r = recent.indexOf(c.id);
    // Recency nudges the order; it never lifts a poor match over a good one.
    const bonus = r < 0 ? 0 : q ? 8 - r : 100 - r;
    scored.push({ c, s: s + bonus, i });
  });
  if (!q) {
    // No query: recent first, then the list in its own order (actions first).
    scored.sort((a, b) => b.s - a.s || GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group) || a.i - b.i);
  } else scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.c);
}

const RECENT_KEY = 'semaphore.paletteRecent';
const RECENT_MAX = 8;

export function recentCommands(): string[] {
  const r = readLocal<unknown>(RECENT_KEY);
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
}

export function noteCommand(id: string): void {
  writeLocal(RECENT_KEY, [id, ...recentCommands().filter((x) => x !== id)].slice(0, RECENT_MAX));
}

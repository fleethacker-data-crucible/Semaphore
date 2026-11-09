// What each flag on the page shows right now, as its card last computed it (components/FlagCard.tsx).
// Kept here, by reference and in memory only, so the assistant (a lazy chunk) can summarise the page's
// own numbers when "Include this page" is on (lib/assistant-context.ts). Nothing is computed or sent
// from here; a card that goes away takes its entry with it.

import type { FlagResult } from './data.ts';

export interface FlagLive {
  /** The result the card shows (already aggregated by the page; never sent as rows). */
  result?: FlagResult;
  /** The card's error, when it could not compute. */
  error?: string;
  /** The insights the card found (src/core/insights.ts), as text. */
  insights: string[];
}

const live = new Map<string, FlagLive>();

export function noteFlagLive(id: string, entry: FlagLive): void {
  live.set(id, entry);
}

export function forgetFlagLive(id: string): void {
  live.delete(id);
}

export function flagLive(id: string): FlagLive | undefined {
  return live.get(id);
}

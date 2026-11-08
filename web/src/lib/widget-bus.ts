// What each custom widget's frame last said, by flag id: the inspector's editor shows the error
// line under the code, and an export asks a live frame for a picture of the widget.

import { useSyncExternalStore } from 'react';

export interface WidgetStatus {
  state: 'loading' | 'ready' | 'error' | 'dead';
  error?: string;
  line?: number;
}

export interface WidgetPicture {
  url: string;
  width: number;
  height: number;
}

const statuses = new Map<string, WidgetStatus>();
const listeners = new Map<string, Set<() => void>>();
const pictures = new Map<string, () => Promise<WidgetPicture | null>>();
const IDLE: WidgetStatus = { state: 'loading' };

export function reportWidget(flagId: string, status: WidgetStatus): void {
  const was = statuses.get(flagId);
  if (was && was.state === status.state && was.error === status.error && was.line === status.line) return;
  statuses.set(flagId, status);
  for (const fn of listeners.get(flagId) ?? []) fn();
}

export function widgetStatus(flagId: string): WidgetStatus {
  return statuses.get(flagId) ?? IDLE;
}

export function useWidgetStatus(flagId: string): WidgetStatus {
  return useSyncExternalStore(
    (fn) => {
      const set = listeners.get(flagId) ?? new Set();
      set.add(fn);
      listeners.set(flagId, set);
      return () => set.delete(fn);
    },
    () => widgetStatus(flagId),
  );
}

// The browser puts every sandboxed frame of one site in one process, so a widget stuck in a loop
// freezes every custom widget on the page (never the page itself). The process ends only when no
// frame is left in it, so on a stall every widget takes its frame down, and they all start again
// after a rest (measured in Edge 2026-11: a new frame made 8 s after the last one went still landed in
// the stuck process and never loaded; one made 11 s after loaded in a new process).
export const SANDBOX_REST_MS = 16000;
let restUntil = 0;
let restEpoch = 0;
const restListeners = new Set<() => void>();

// Which widget is to blame: the frame cannot say (a frame stuck in a loop sends nothing, not even a
// message posted just before the loop), so the page keeps the widgets whose render it sent and has
// had no answer for. One of them alone at a stall is the one stuck. With several, they start again
// one at a time, so the next stall has one suspect.
const rendering = new Set<string>();
let culprit: string | null = null;

/** A render was sent to this widget's frame (on), or it answered (off). */
export function setRendering(flagId: string, on: boolean): void {
  if (on) rendering.add(flagId);
  else rendering.delete(flagId);
}

/** A frame stopped answering: every widget on the page comes down, and none starts for the rest period. */
export function reportSandboxStall(now = Date.now()): void {
  culprit = rendering.size === 1 ? [...rendering][0]! : null;
  rendering.clear();
  restUntil = Math.max(restUntil, now + SANDBOX_REST_MS);
  restEpoch += 1;
  for (const fn of restListeners) fn();
}

/** The widget the last stall is pinned on, when exactly one was drawing. */
export function stallCulprit(): string | null {
  return culprit;
}

// Widgets start again one at a time after a stall: each holds the turn until its frame answers its
// first render (or gives up), at most START_TURN_MS.
const START_TURN_MS = 12000;
const waiting: Array<{ id: string; start: () => void }> = [];
let turn: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

function nextTurn(): void {
  if (turn) return;
  const next = waiting.shift();
  if (!next) return;
  turn = { id: next.id, timer: setTimeout(() => finishStart(next.id), START_TURN_MS) };
  next.start();
}

/** Asks for this widget's turn to start its frame; returns a function that withdraws the request. */
export function queueStart(flagId: string, start: () => void): () => void {
  const entry = { id: flagId, start };
  waiting.push(entry);
  nextTurn();
  return () => {
    const i = waiting.indexOf(entry);
    if (i >= 0) waiting.splice(i, 1);
  };
}

/** This widget's frame has answered (or given up, or gone): the next one may start. */
export function finishStart(flagId: string): void {
  if (!turn || turn.id !== flagId) return;
  clearTimeout(turn.timer);
  turn = null;
  nextTurn();
}

/** Milliseconds until a widget frame may start again (0 when nothing has stalled lately). */
export function sandboxRestLeft(now = Date.now()): number {
  return Math.max(0, restUntil - now);
}

/** Changes each time a frame on the page stalls. */
export function useSandboxRest(): number {
  return useSyncExternalStore(
    (fn) => {
      restListeners.add(fn);
      return () => restListeners.delete(fn);
    },
    () => restEpoch,
  );
}

/** A live frame offers a picture of itself; the returned function takes the offer back. */
export function offerPicture(flagId: string, take: () => Promise<WidgetPicture | null>): () => void {
  pictures.set(flagId, take);
  return () => {
    if (pictures.get(flagId) === take) pictures.delete(flagId);
  };
}

/** A picture of the flag's widget as it is drawn now, or null when no frame is drawing it. */
export async function widgetPicture(flagId: string): Promise<WidgetPicture | null> {
  const take = pictures.get(flagId);
  if (!take) return null;
  try {
    return await take();
  } catch {
    return null;
  }
}

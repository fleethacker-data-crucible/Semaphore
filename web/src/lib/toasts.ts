// Toasts (#69, Fleet UI 6): one store for every notification. Info and success go after 5 s; an
// error stays until the analyst dismisses it, and is shown in a role="alert" region of its own,
// so the busy line never covers it. The store is plain TypeScript (tested in Node); the React side
// is components/Toasts.tsx and useToasts below.

import { useSyncExternalStore } from 'react';

export type ToastTone = 'info' | 'success' | 'error';
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface NotifyOptions {
  tone?: ToastTone;
  action?: ToastAction;
  /** A second, quieter action, on its own line. */
  secondary?: ToastAction;
  /** Override the 5 s life of an info or success toast (0 keeps it). Errors always stay. */
  timeoutMs?: number;
}
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
  secondary?: ToastAction;
}

export const INFO_MS = 5000;
const MAX = 5;

export interface ToastStore {
  items(): readonly Toast[];
  push(text: string, opts?: NotifyOptions): number;
  dismiss(id: number): void;
  clear(): void;
  subscribe(fn: () => void): () => void;
}

export function createToastStore(timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as number) }): ToastStore {
  let list: Toast[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const pending = new Map<number, unknown>();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  const dismiss = (id: number) => {
    const t = pending.get(id);
    if (t !== undefined) timers.clear(t);
    pending.delete(id);
    const before = list.length;
    list = list.filter((x) => x.id !== id);
    if (list.length !== before) emit();
  };
  return {
    items: () => list,
    push(text, opts = {}) {
      const tone = opts.tone ?? 'info';
      // The same words again replace the old toast rather than stacking up.
      for (const old of list.filter((x) => x.text === text && x.tone === tone)) dismiss(old.id);
      const id = next++;
      const toast: Toast = { id, text, tone, ...(opts.action ? { action: opts.action } : {}), ...(opts.secondary ? { secondary: opts.secondary } : {}) };
      // Errors are never pushed out by newer info toasts; the oldest info goes first.
      let kept = [...list, toast];
      while (kept.length > MAX) {
        const drop = kept.find((x) => x.tone !== 'error' && x.id !== id) ?? kept[0]!;
        const t = pending.get(drop.id);
        if (t !== undefined) timers.clear(t);
        pending.delete(drop.id);
        kept = kept.filter((x) => x !== drop);
      }
      list = kept;
      const life = tone === 'error' ? 0 : (opts.timeoutMs ?? INFO_MS);
      if (life > 0) pending.set(id, timers.set(() => dismiss(id), life));
      emit();
      return id;
    },
    dismiss,
    clear() {
      for (const t of pending.values()) timers.clear(t);
      pending.clear();
      list = [];
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The page's one store. */
export const toasts = createToastStore();

/**
 * notify(text, opts?) (contract 6): one argument keeps working as an info toast.
 * notify('Could not save', { tone: 'error' }) stays until dismissed.
 */
export function notify(text: string, opts?: NotifyOptions): number {
  return toasts.push(text, opts);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(toasts.subscribe, toasts.items, toasts.items);
}

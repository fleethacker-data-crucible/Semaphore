// Promise-based confirmation, after Lazarette's lib/confirm.svelte.ts: `await confirm({...})`
// resolves true or false; components/ConfirmHost.tsx draws the dialog with useModal.

import { useSyncExternalStore } from 'react';

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
interface Pending extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

export function confirm(req: ConfirmRequest): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...req, resolve };
    emit();
  });
}

export function settleConfirm(ok: boolean): void {
  const c = current;
  current = null;
  emit();
  c?.resolve(ok);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const get = () => current as ConfirmRequest | null;
export function useConfirmRequest(): ConfirmRequest | null {
  return useSyncExternalStore(subscribe, get, get);
}

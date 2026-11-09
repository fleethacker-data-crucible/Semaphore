// The few bytes of the assistant the page needs at start: whether the orb is on, and a way to open the
// assistant before its code has loaded. Everything else (lib/assistant.ts, the panel, the orb) loads
// after the page has painted, so the assistant never adds to the start (web/size-budget.json).

import { useSyncExternalStore } from 'react';

const ORB_KEY = 'semaphore.assistantOrb';
const listeners = new Set<() => void>();
let wanted = false;
let pendingOpen = false;

function orbOn(): boolean {
  try {
    return localStorage.getItem(ORB_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** On by default, as in Lazarette; Settings > Appearance turns it off for this browser. */
export function setAssistantOrb(on: boolean): void {
  try {
    if (on) localStorage.removeItem(ORB_KEY);
    else localStorage.setItem(ORB_KEY, 'false');
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
  for (const l of listeners) l();
}

export function useAssistantOrb(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    orbOn,
    () => true,
  );
}

/** Whether anyone asked for the assistant yet (the header button, Ctrl+K). */
export function useAssistantWanted(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => wanted,
    () => false,
  );
}

/** Opens (or closes) the assistant. Loads it first if it has not loaded yet. */
export function toggleAssistant(): void {
  wanted = true;
  pendingOpen = true;
  for (const l of listeners) l();
  window.dispatchEvent(new CustomEvent('semaphore:assistant'));
}

/** True once when the assistant was asked for before its code loaded; the loaded assistant then opens. */
export function takePendingOpen(): boolean {
  const was = pendingOpen;
  pendingOpen = false;
  return was;
}

// "Suggest questions" in the Leadership view: open the assistant and have it suggest, loading it first if needed.
let pendingSuggest = false;
export function suggestAsksWithAssistant(): void {
  wanted = true;
  pendingSuggest = true;
  for (const l of listeners) l();
  window.dispatchEvent(new CustomEvent('semaphore:assistant-suggest'));
}
export function takePendingSuggest(): boolean {
  const was = pendingSuggest;
  pendingSuggest = false;
  return was;
}

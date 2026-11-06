// The page's busy line, with a re-entry guard (#91): run() refuses to start a second busy action
// while one is running, whatever started it (a button, Enter, a shortcut, the command palette).

import { useCallback, useRef, useState } from 'react';

export interface Busy {
  /** What the page is doing, or null. */
  busy: string | null;
  /** Runs `fn` as the one busy action; resolves undefined without running it when another is going. */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Changes the busy line while an action runs ("Profiling orders…"). */
  say: (label: string) => void;
  isBusy: () => boolean;
}

export function useBusy(): Busy {
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(label);
    try {
      return await fn();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  const say = useCallback((label: string) => {
    if (running.current) setBusy(label);
  }, []);
  const isBusy = useCallback(() => running.current, []);
  return { busy, run, say, isBusy };
}

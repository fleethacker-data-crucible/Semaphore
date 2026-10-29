// The hoist being edited, with undo and redo. Every change goes through `change`, which records
// the previous hoist unless the change is a continuation of the last one (a drag in progress,
// typing in a brief), so one undo reverses one intent, not one keystroke.

import { useCallback, useRef, useState } from 'react';
import type { Hoist } from '../../../src/core/hoist.ts';

const LIMIT = 100;

export interface HoistHistory {
  hoist: Hoist;
  change: (next: Hoist | ((h: Hoist) => Hoist), group?: string) => void;
  replace: (next: Hoist) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useHoistHistory(initial: Hoist): HoistHistory {
  const [state, setState] = useState({ hoist: initial, past: [] as Hoist[], future: [] as Hoist[] });
  const lastGroup = useRef<{ group: string; at: number } | null>(null);

  const change = useCallback((next: Hoist | ((h: Hoist) => Hoist), group?: string) => {
    setState((s) => {
      const value = typeof next === 'function' ? next(s.hoist) : next;
      if (value === s.hoist) return s;
      const stamped = { ...value, updated: new Date().toISOString() };
      const now = Date.now();
      const continuing = group && lastGroup.current?.group === group && now - lastGroup.current.at < 1500;
      lastGroup.current = group ? { group, at: now } : null;
      if (continuing) return { ...s, hoist: stamped, future: [] };
      return { hoist: stamped, past: [...s.past, s.hoist].slice(-LIMIT), future: [] };
    });
  }, []);

  const replace = useCallback((next: Hoist) => {
    lastGroup.current = null;
    setState({ hoist: next, past: [], future: [] });
  }, []);

  const undo = useCallback(() => {
    lastGroup.current = null;
    setState((s) => (s.past.length ? { hoist: s.past[s.past.length - 1]!, past: s.past.slice(0, -1), future: [s.hoist, ...s.future] } : s));
  }, []);

  const redo = useCallback(() => {
    lastGroup.current = null;
    setState((s) => (s.future.length ? { hoist: s.future[0]!, past: [...s.past, s.hoist], future: s.future.slice(1) } : s));
  }, []);

  return { hoist: state.hoist, change, replace, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

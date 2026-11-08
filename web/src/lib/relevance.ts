// What a flag card needs from the page, and no more, so a card redraws only when its own numbers
// can change (#83). Three pieces:
//   planSlice     the parts of the hoist that planning reads (its fixed filters, and the flags that
//                 make page selections), kept as the same object while those parts are unchanged:
//                 typing a title or a brief no longer gives every card a new `hoist`.
//   relevantSelections
//                 only the selections a flag's plan can apply (its own fields, the page fields it is
//                 pre-split by, and those it re-queries for). A click on a table the flag does not
//                 read leaves it alone.
//   useStableValue
//                 the same object back while its key is unchanged.
// The core work (planSliceKey, relevantSelections) is pure and tested (tests/flag-relevance.test.ts).

import { useRef } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Selections } from '../../../src/core/crossfilter.ts';
import type { Behavior, Flag, Hoist } from '../../../src/core/hoist.ts';
import { planFlag, type QueryPlan } from '../../../src/core/planner.ts';

/** The flags whose clicks or picks select values for the whole page (planner.ts selectableKeys). */
function selecting(f: Flag): boolean {
  return !!f.binding && (f.kind === 'filter' || f.behavior.onClick === 'filter-page');
}

/** A string that changes exactly when planning a flag on this hoist could change. O(flags). */
export function planSliceKey(hoist: Hoist): string {
  return JSON.stringify([hoist.id, hoist.grid.cols, hoist.filters, hoist.flags.filter(selecting).map((f) => [f.kind, f.behavior.onClick, f.binding!.dimensions])]);
}

/** The hoist as planning sees it: no title or brief, and only the flags that select for the page. */
export function planSlice(hoist: Hoist): Hoist {
  return { version: 1, id: hoist.id, title: '', brief: '', grid: hoist.grid, filters: hoist.filters, flags: hoist.flags.filter(selecting), updated: '' };
}

const sliceKeys = new WeakMap<Hoist, string>();
/** planSliceKey, worked out once per hoist object however many cards ask. */
export function cachedSliceKey(hoist: Hoist): string {
  let k = sliceKeys.get(hoist);
  if (k === undefined) {
    k = planSliceKey(hoist);
    sliceKeys.set(hoist, k);
  }
  return k;
}

/** Selection keys a plan can use: its own and pre-split fields, and those it asks the source again for. */
export function planKeys(plan: Pick<QueryPlan, 'dimensions' | 'live'>): Set<string> {
  return new Set([...plan.dimensions.map((d) => d.key), ...plan.live]);
}

/**
 * Only the non-empty selections that can change this flag's numbers or highlights. A plan that
 * cannot be made (no binding, an error) can use none. Same input, same output, in key order.
 */
export function relevantSelections(selections: Selections, keys: ReadonlySet<string> | null, behavior: Pick<Behavior, 'ignore'>): Selections {
  const out: Selections = {};
  if (!keys) return out;
  for (const k of Object.keys(selections).sort()) {
    const v = selections[k]!;
    if (!v.length || !keys.has(k) || behavior.ignore.includes(k.split('@')[0]!)) continue;
    out[k] = v;
  }
  return out;
}

const keyCache = new WeakMap<Flag, { slice: string; index: CatalogIndex; keys: Set<string> | null }>();
/** The selection keys a flag's plan can use on this hoist, cached per flag object. */
export function flagKeys(slice: Hoist, sliceKey: string, flag: Flag, index: CatalogIndex): Set<string> | null {
  const hit = keyCache.get(flag);
  if (hit && hit.slice === sliceKey && hit.index === index) return hit.keys;
  const planned = flag.binding && flag.kind !== 'text' ? planFlag(slice, flag, index) : null;
  const keys = planned?.ok ? planKeys(planned.plan) : null;
  // Measures from several tables plan once their code has loaded (planner.ts loadAcross): ask again then.
  if (planned && !planned.ok && planned.reason === 'loading') return keys;
  keyCache.set(flag, { slice: sliceKey, index, keys });
  return keys;
}

/** The same object back for as long as `key` is unchanged. */
export function useStableValue<T>(key: string, make: () => T): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, value: make() };
  return ref.current.value;
}

/**
 * Per flag, the selections it can use, each kept as the same object while its content is the
 * same: a memoised card whose selections did not change is not re-rendered.
 */
export function useRelevantSelections(flags: readonly Flag[], slice: Hoist, sliceKey: string, index: CatalogIndex, selections: Selections): (flag: Flag) => Selections {
  const memo = useRef(new Map<string, { key: string; value: Selections }>());
  const seen = new Set<string>();
  const out = new Map<string, Selections>();
  for (const f of flags) {
    seen.add(f.id);
    const value = relevantSelections(selections, flagKeys(slice, sliceKey, f, index), f.behavior);
    const key = JSON.stringify(value);
    const prev = memo.current.get(f.id);
    if (prev && prev.key === key) out.set(f.id, prev.value);
    else {
      memo.current.set(f.id, { key, value });
      out.set(f.id, value);
    }
  }
  for (const id of [...memo.current.keys()]) if (!seen.has(id)) memo.current.delete(id);
  return (flag) => out.get(flag.id) ?? EMPTY;
}

const EMPTY: Selections = {};

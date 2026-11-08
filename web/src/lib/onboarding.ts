// The first-run shakedown cruise (#67): five steps that walk a new analyst round the core loop
// (describe, draft, flip, accept, leadership can ask) on their own work, in about a minute.
//
// State lives in localStorage as `semaphore.onboarding = { steps, dismissed, startedAt }` through
// storage.ts, and in memory as well, so it works the same where storage is blocked (it simply
// starts again next time). Steps are marked from events that already happen: a flag gets its
// first binding, a flag is flipped, a flag is accepted, the leadership view opens.

import { useSyncExternalStore } from 'react';
import type { Catalog } from '../../../src/core/catalog.ts';
import { emptyBehavior, type Flag, type Hoist } from '../../../src/core/hoist.ts';
import { place } from '../../../src/core/layout.ts';
import { readLocal, writeLocal } from './storage.ts';

export const ONBOARDING_KEY = 'semaphore.onboarding';

export const SHAKEDOWN_STEPS = ['running', 'describe', 'flip', 'accept', 'ask'] as const;
export type ShakedownStep = (typeof SHAKEDOWN_STEPS)[number];

export interface OnboardingState {
  steps: Partial<Record<ShakedownStep, string>>;
  dismissed: boolean;
  /** When the shakedown was started; null until the analyst chose it. */
  startedAt: string | null;
}

function isState(raw: unknown): raw is OnboardingState {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.dismissed === 'boolean' && !!o.steps && typeof o.steps === 'object' && (o.startedAt === null || typeof o.startedAt === 'string');
}

let state: OnboardingState | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function load(): OnboardingState | null {
  if (!loaded) {
    loaded = true;
    const raw = readLocal<unknown>(ONBOARDING_KEY);
    state = isState(raw) ? raw : null;
  }
  return state;
}

function save(next: OnboardingState): void {
  state = next;
  loaded = true;
  writeLocal(ONBOARDING_KEY, next);
  for (const l of listeners) l();
}

/** A first run: nothing about the shakedown has been recorded in this browser yet. */
export function isFirstRun(): boolean {
  return load() === null;
}

/** Start the shakedown with its first step already done: Semaphore is running here. */
export function startShakedown(now: Date = new Date()): void {
  save({ steps: { running: now.toISOString() }, dismissed: false, startedAt: now.toISOString() });
}

/** "Take the shakedown again", from the ? help dialog: a fresh checklist, shown at once. */
export function restartShakedown(): void {
  startShakedown();
}

/** The analyst chose another way in on the first-run welcome: remember the first run has passed. */
export function passFirstRun(): void {
  if (load() === null) save({ steps: {}, dismissed: true, startedAt: null });
}

/** Hide the checklist for good (it comes back only from "Take the shakedown again"). */
export function hideShakedown(): void {
  const s = load();
  save({ steps: s?.steps ?? {}, dismissed: true, startedAt: s?.startedAt ?? null });
}

/** Mark a step done, if the shakedown is running. Safe to call from anywhere, any number of times. */
export function markStep(step: ShakedownStep, now: Date = new Date()): void {
  const s = load();
  if (!s || s.dismissed || !s.startedAt || s.steps[step]) return;
  save({ ...s, steps: { ...s.steps, [step]: now.toISOString() } });
}

export function doneCount(s: OnboardingState): number {
  return SHAKEDOWN_STEPS.filter((k) => s.steps[k]).length;
}

/** Whether the checklist is showing: started, not hidden. */
export function shakedownActive(s: OnboardingState | null): s is OnboardingState {
  return !!s && !s.dismissed && !!s.startedAt;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The shakedown as it stands (outside React; components use useOnboarding). */
export function onboardingState(): OnboardingState | null {
  return load();
}

export function useOnboarding(): OnboardingState | null {
  return useSyncExternalStore(subscribe, load, load);
}

/** The brief "Type it for me" types: a top-10 breakdown, in this catalog's words. */
export function shakedownBrief(catalog: Catalog): string {
  const metric = catalog.metrics.find((m) => m.agg === 'sum' && m.format === 'currency') ?? catalog.metrics.find((m) => m.agg === 'sum') ?? catalog.metrics[0];
  if (!metric) return '';
  const table = metric.field ? catalog.fields.find((f) => f.key === metric.field)?.table : metric.table;
  const fields = catalog.fields.filter((f) => f.type === 'string' && f.source === metric.source && (table === undefined || f.table === table));
  // A field with more than ten values makes "top 10" mean something; the largest such reads best.
  const field = fields.filter((f) => (f.cardinality ?? 0) > 10).sort((a, b) => (b.cardinality ?? 0) - (a.cardinality ?? 0))[0] ?? fields[0];
  if (!field) return `${metric.label} for the last 12 months`;
  return `Top 10 ${plural(field.label.toLowerCase())} by ${metric.label.toLowerCase()}`;
}

function plural(label: string): string {
  // "hull number" reads as "hulls"; otherwise a plain plural.
  const s = label.replace(/\s+(number|no|id|code|name)$/, '');
  if (/(s|x|ch|sh)$/.test(s)) return `${s}es`;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

/** The hoist with a new Smart flag holding `brief`, at the top left where it is seen first. */
export function withBriefFlag(h: Hoist, id: string, brief: string): Hoist {
  const size = { w: 6, h: 4 };
  const flag: Flag = { id, kind: 'bar', title: '', brief, layout: { x: 0, y: 0, ...size }, binding: null, behavior: emptyBehavior(), status: 'empty', notes: [] };
  const items = [...h.flags.map((f) => ({ id: f.id, layout: f.layout })), { id, layout: flag.layout }];
  // At the top left, pushing the others down: free hoists too, so the new flag is never hidden under one.
  const mode = h.grid.mode === 'free' ? 'snap' : (h.grid.mode ?? 'snap');
  const placed = new Map(place(items, id, flag.layout, h.grid.cols, mode).map((p) => [p.id, p.layout]));
  return { ...h, flags: [...h.flags, flag].map((f) => ({ ...f, layout: placed.get(f.id) ?? f.layout })) };
}

// ---- Brief hints that fade (#68) ------------------------------------------------------------
// `semaphore.grammarSeen` counts, per grammar kind, how often the analyst has used it (a hint
// clicked, or a draft whose brief used it). After HINT_FADE_AFTER uses its hint is no longer shown.
export const GRAMMAR_SEEN_KEY = 'semaphore.grammarSeen';
export const HINT_FADE_AFTER = 3;
let seen: Record<string, number> | null = null;
const seenListeners = new Set<() => void>();

function seenAll(): Record<string, number> {
  if (!seen) {
    const raw = readLocal<Record<string, number>>(GRAMMAR_SEEN_KEY);
    seen = raw && typeof raw === 'object' ? raw : {};
  }
  return seen;
}

export function noteGrammarUsed(kinds: Iterable<string>): void {
  const next = { ...seenAll() };
  let changed = false;
  for (const k of kinds) {
    if ((next[k] ?? 0) >= HINT_FADE_AFTER) continue;
    next[k] = (next[k] ?? 0) + 1;
    changed = true;
  }
  if (!changed) return;
  seen = next;
  writeLocal(GRAMMAR_SEEN_KEY, next);
  for (const l of seenListeners) l();
}

/** Grammar kinds the analyst has used often enough that their hints are no longer shown. */
export function useFadedKinds(): string[] {
  const all = useSyncExternalStore(
    (fn) => {
      seenListeners.add(fn);
      return () => seenListeners.delete(fn);
    },
    seenAll,
    seenAll,
  );
  return Object.keys(all).filter((k) => (all[k] ?? 0) >= HINT_FADE_AFTER);
}

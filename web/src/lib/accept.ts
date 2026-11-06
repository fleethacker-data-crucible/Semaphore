// Accepting a flag (#70): the product's key moment, in one place. Both ways to accept (the check
// on a drafted card and the inspector's Accept, and the A / Ctrl+Enter keys) call onAcceptFlag(id),
// which works out what the accept means BEFORE it changes anything, then:
//   - marks the flag ready, and remembers the day it was reviewed (the card's "Reviewed" chip);
//   - says so at once, with Undo: "Accepted. In the playbook. Leadership can now ask …";
//   - adds at most one bonus line, and only a computed fact: an open question it answers, the first
//     reviewed answer for a measure (coverage), or that it matches the team style card;
//   - after five accepts in ten minutes, one running summary instead of a toast each.
// No sound (workspaces are shared) and nothing random. acceptFacts is pure and tested.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag, Hoist } from '../../../src/core/hoist.ts';
import { coverage, entryId, learnFromHoist, type PlaybookEntry, type QuestionItem, resolveQuestions } from '../../../src/core/playbook.ts';
import { shapeOf, type TeamStyle } from '../../../src/core/style.ts';
import { markStep } from './onboarding.ts';
import { recordSkill, recordWatch } from './skills.ts';
import { readLocal, writeLocal } from './storage.ts';

export interface AcceptFacts {
  /** Whether accepting puts the flag in the playbook, so leadership can ask for it. */
  inPlaybook: boolean;
  /** The headline: "In the playbook. Leadership can now ask “Labor cost by region”." */
  headline: string;
  /** One honest bonus line, or null. */
  bonus: string | null;
  bonusKind: 'question' | 'coverage' | 'style' | null;
  /** The playbook entry id this accept writes, when it writes one. */
  entry: string | null;
  /** The entry as the playbook will keep it, and the open questions it answers. */
  learnt?: PlaybookEntry;
  answered?: QuestionItem[];
}

export interface AcceptInput {
  hoist: Hoist;
  index: CatalogIndex;
  user: string;
  entries: readonly PlaybookEntry[];
  questions: readonly QuestionItem[];
  style: TeamStyle | null;
}

const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Tuesday" within the last week, otherwise "3 Oct". */
export function whenAsked(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'earlier';
  const days = (now.getTime() - at.getTime()) / DAY_MS;
  if (days < 1 && at.getDate() === now.getDate()) return 'today';
  if (days < 7) return WEEKDAYS[at.getDay()]!;
  return shortDate(at);
}

/** "6 Nov". */
export function shortDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** What accepting this flag would mean, from the playbook as it is now. Pure. */
export function acceptFacts(input: AcceptInput, flagId: string, now: Date = new Date()): AcceptFacts {
  const { hoist, index, user, entries, questions, style } = input;
  const flag = hoist.flags.find((f) => f.id === flagId);
  const none: AcceptFacts = { inPlaybook: false, headline: 'Accepted.', bonus: null, bonusKind: null, entry: null };
  if (!flag) return none;
  const title = flag.title || flag.brief || 'this flag';
  const id = entryId(hoist.id, flag.id);
  const prev = entries.find((e) => e.id === id);
  if (hoist.experiment) return { ...none, headline: 'Accepted. This page is marked Try freely, so it stays out of the playbook.' };
  if (flag.learn === false) return { ...none, headline: 'Accepted. It stays out of the playbook, as you asked.' };
  if (prev?.status === 'retired') return { ...none, headline: 'Accepted. Its playbook entry is retired; restore it in the Playbook to let leadership ask for it.' };

  const accepted: Hoist = { ...hoist, flags: hoist.flags.map((f) => (f.id === flagId ? { ...f, status: 'ready' as const } : f)) };
  // Everything the playbook will hold once this page is saved: other accepted flags on the page
  // that are not saved yet count as already there, so the facts below are about this flag alone.
  const learntAll = learnFromHoist(entries, accepted, index, user, now);
  const learnt = learntAll.find((e) => e.id === id);
  if (!learnt) {
    if (prev) return { ...none, inPlaybook: true, entry: id, headline: `Accepted. Already in the playbook as “${prev.title}”.` };
    return none; // a note, a picker, or a flag with no measure: nothing for leadership to ask
  }
  const headline = prev ? `Accepted. Updated in the playbook: leadership's “${title}” now uses this version.` : `Accepted. In the playbook. Leadership can now ask “${title}”.`;
  const others = learntAll.filter((e) => e.id !== id);
  const before = [...entries.filter((e) => !others.some((o) => o.id === e.id)), ...others];
  const after = [...before.filter((e) => e.id !== id), learnt];
  const answeredAll = resolveQuestions(questions, after, now).filter((q) => q.entryId === id);
  const facts: AcceptFacts = { inPlaybook: true, headline, bonus: null, bonusKind: null, entry: id, learnt, answered: answeredAll };

  // 1. An open question from leadership that this answers, in the same words.
  const answered = answeredAll[0];
  if (answered) {
    const who = answered.askedBy && answered.askedBy !== user ? `${answered.askedBy}'s` : 'the';
    return { ...facts, bonus: `This answers ${who} question from ${whenAsked(answered.askedAt, now)}.`, bonusKind: 'question' };
  }
  // 2. The first reviewed answer for its measure.
  const metric = learnt.binding.metrics[0];
  if (metric) {
    const was = coverage(before.filter((e) => e.id !== id), index).find((c) => c.metric === metric);
    const is = coverage(after, index);
    if (was && was.entries === 0) {
      const covered = is.filter((c) => c.entries > 0).length;
      return { ...facts, bonus: `First reviewed answer for ${was.label}: coverage now ${covered} of ${is.length} measures.`, bonusKind: 'coverage' };
    }
  }
  // 3. It is built the way the team builds this kind of flag.
  if (style && flag.binding) {
    const rule = style.chart[shapeOf(flag.binding, index)];
    if (rule && !style.off.includes(rule.key) && rule.value === flag.kind) return { ...facts, bonus: 'Matches the team style card.', bonusKind: 'style' };
  }
  return facts;
}

// ---- When each flag was reviewed (for the card's chip) -------------------------------------
const REVIEWED_KEY = 'semaphore.reviewed';
const REVIEWED_MAX = 500;
let reviewed: Record<string, string> | null = null;
const reviewedListeners = new Set<() => void>();

function reviewedAll(): Record<string, string> {
  reviewed ??= readLocal<Record<string, string>>(REVIEWED_KEY) ?? {};
  return reviewed;
}

function setReviewed(key: string, iso: string | null): void {
  const next = { ...reviewedAll() };
  if (iso) next[key] = iso;
  else delete next[key];
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - REVIEWED_MAX))) delete next[k];
  reviewed = next;
  writeLocal(REVIEWED_KEY, next);
  for (const l of reviewedListeners) l();
}

/** When this flag was accepted in this browser, if known. */
export function useReviewedAt(hoistId: string, flagId: string): string | null {
  const all = useSyncExternalStore(
    (fn) => {
      reviewedListeners.add(fn);
      return () => reviewedListeners.delete(fn);
    },
    reviewedAll,
    reviewedAll,
  );
  return all[`${hoistId}/${flagId}`] ?? null;
}

// ---- Toast fatigue ---------------------------------------------------------------------------
const WINDOW_MS = 10 * 60 * 1000;
const COLLAPSE_AFTER = 5;

/** Accept times kept in this window; true when this accept should join a summary instead. */
export function collapseAccepts(times: number[], now: number): { times: number[]; collapse: boolean } {
  const kept = [...times.filter((t) => now - t < WINDOW_MS), now];
  return { times: kept, collapse: kept.length > COLLAPSE_AFTER };
}

// ---- The hook ---------------------------------------------------------------------------------
export interface NotifyOptions {
  tone?: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
}

export interface UseAcceptInput extends AcceptInput {
  updateFlag: (id: string, patch: Partial<Flag>) => void;
  notify: (text: string, opts?: NotifyOptions) => void;
  /** The playbook's save calls, for flushAccepts. */
  saveEntries?: (list: PlaybookEntry[]) => Promise<void>;
  saveQuestion?: (q: QuestionItem) => Promise<void>;
}

// The page saves accepted flags to the playbook a moment after the last change (app.tsx), so Undo
// can take an accept back before anyone sees it. Going straight to the leadership view should not
// have to wait for that: flushAccepts() saves what was just accepted at once.
const pending = new Map<string, { entry: PlaybookEntry; answered: QuestionItem[]; save: Pick<UseAcceptInput, 'saveEntries' | 'saveQuestion'> }>();

/** Save the flags accepted in the last few seconds to the playbook now (before showing the leadership view). */
export async function flushAccepts(): Promise<void> {
  const all = [...pending.values()];
  pending.clear();
  for (const p of all) {
    try {
      await p.save.saveEntries?.([p.entry]);
      for (const q of p.answered) await p.save.saveQuestion?.(q);
    } catch {
      /* the page's own save tries again from the builder, and reports a failure there */
    }
  }
}

const announced = new Set<string>();
/** Whether the accept toast already told the analyst about these entries (so a later notice need not). */
export function announcedByAccept(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => announced.has(id));
}

/**
 * The one accept handler. Stable across renders (it reads the latest page through a ref), so the
 * memoised flag cards it is passed to are not re-rendered by it.
 */
export function useAccept(input: UseAcceptInput): (id: string) => void {
  const latest = useRef(input);
  latest.current = input;
  const times = useRef<number[]>([]);
  return useCallback((id: string) => {
    const now = new Date();
    const cur = latest.current;
    const flag = cur.hoist.flags.find((f) => f.id === id);
    if (!flag || flag.status === 'ready') return;
    const before = { status: flag.status };
    const facts = acceptFacts(cur, id, now);
    cur.updateFlag(id, { status: 'ready' });
    const key = `${cur.hoist.id}/${id}`;
    const prevReviewed = reviewedAll()[key] ?? null;
    setReviewed(key, now.toISOString());
    if (facts.entry) announced.add(facts.entry);
    if (facts.learnt) {
      pending.set(id, { entry: facts.learnt, answered: facts.answered ?? [], save: { saveEntries: cur.saveEntries, saveQuestion: cur.saveQuestion } });
      window.setTimeout(() => pending.delete(id), 8000);
    }
    markStep('accept');
    recordSkill('accept', { hoistId: cur.hoist.id, flagId: id });
    recordWatch('accept');

    const undo = {
      label: 'Undo',
      run: () => {
        const c = latest.current;
        pending.delete(id);
        c.updateFlag(id, before);
        setReviewed(key, prevReviewed);
        const saved = facts.entry ? c.entries.find((e) => e.id === facts.entry && e.acceptedAt >= now.toISOString()) : undefined;
        c.notify(saved ? 'Back to a draft. Its playbook entry was already saved; retire it in the Playbook if leadership should not see it.' : 'Back to a draft.');
      },
    };
    const collapsed = collapseAccepts(times.current, now.getTime());
    times.current = collapsed.times;
    if (collapsed.collapse && facts.bonusKind !== 'question') {
      cur.notify(`Accepted. ${collapsed.times.length} flags accepted in the last few minutes${facts.inPlaybook ? '; this one is in the playbook' : ''}.`, { tone: 'success', action: undo });
      return;
    }
    cur.notify(facts.bonus ? `${facts.headline} ${facts.bonus}` : facts.headline, { tone: 'success', action: undo });
  }, []);
}

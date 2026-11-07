// Impact and the team's week: how often leadership got a reviewed answer, per ISO week; the
// "Bravo Zulu" notes leadership leaves on answers that helped; what the team added to the playbook
// this week; and each analyst's private watch log.
//
// Counts are race-free: every asker writes only their own file per week
// (team/asks-<user>-<isoWeek>, team/bz-<user>-<isoWeek>), the same one-file-per-person pattern as
// away notices, so two people asking at once never overwrite each other. A file holds counts per
// playbook entry and the week, nothing else: no question text and nothing finer than a week. Files
// older than KEEP_WEEKS are removed by their owner.
//
// Nothing here ranks people. Names appear only as authorship credit beside a person's own work.

import type { AwayNotice } from './away.ts';
import type { CatalogIndex } from './catalog.ts';
import { coverage, type PlaybookEntry, type QuestionItem } from './playbook.ts';

/** Weekly files are kept this long, then removed by the person who wrote them. */
export const KEEP_WEEKS = 26;

// ---------------------------------------------------------------------------------------------
// ISO weeks

/** The ISO week of a date (its UTC calendar day), as `2026-W45`. */
export function isoWeek(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const WEEK = /^(\d{4})-W(\d{2})$/;

/** The Monday (UTC midnight) that starts an ISO week. */
export function weekStart(week: string): Date {
  const m = WEEK.exec(week);
  if (!m) throw new Error(`Not an ISO week: ${week}`);
  const year = Number(m[1]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000);
  return new Date(monday.getTime() + (Number(m[2]) - 1) * 7 * 86_400_000);
}

/** The last `n` ISO weeks, oldest first, ending with the week of `now`. */
export function lastWeeks(now: Date, n: number): string[] {
  const start = weekStart(isoWeek(now)).getTime();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(isoWeek(new Date(start - i * 7 * 86_400_000)));
  return out;
}

function userSlug(user: string): string {
  return (user.toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'someone').slice(0, 40);
}

// ---------------------------------------------------------------------------------------------
// Ask counts: team/asks-<user>-<isoWeek>

export interface AskLog {
  version: 1;
  kind: 'asks';
  id: string;
  user: string;
  week: string;
  /** Playbook entry id -> how many reviewed answers it gave this person that week. */
  counts: Record<string, number>;
  updated: string;
}

export const askLogId = (user: string, week: string) => `asks-${userSlug(user)}-${week}`;

export function isAskLog(raw: unknown): raw is AskLog {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o.version === 1 && o.kind === 'asks' && typeof o.id === 'string' && typeof o.week === 'string' && WEEK.test(o.week) && !!o.counts && typeof o.counts === 'object' && Object.values(o.counts).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

/** This person's log for this week with one more answer from `entryId`. */
export function bumpAsk(logs: readonly AskLog[], user: string, entryId: string, now: Date = new Date()): AskLog {
  const week = isoWeek(now);
  const id = askLogId(user, week);
  const prev = logs.find((l) => l.id === id);
  const counts = { ...(prev?.counts ?? {}) };
  counts[entryId] = (counts[entryId] ?? 0) + 1;
  return { version: 1, kind: 'asks', id, user, week, counts, updated: now.toISOString() };
}

/** How many reviewed answers each entry gave, in total, and the latest week it was used. */
export function usesByEntry(logs: readonly AskLog[]): Map<string, { uses: number; lastWeek: string }> {
  const out = new Map<string, { uses: number; lastWeek: string }>();
  for (const l of logs) {
    for (const [id, n] of Object.entries(l.counts)) {
      const prev = out.get(id);
      out.set(id, { uses: (prev?.uses ?? 0) + n, lastWeek: !prev || l.week > prev.lastWeek ? l.week : prev.lastWeek });
    }
  }
  return out;
}

/**
 * Entries with `uses` and `lastUsed` read from the ask logs (lastUsed is the Monday of the latest
 * week, never finer). This is the only place those two fields are set.
 */
export function withUses(entries: readonly PlaybookEntry[], logs: readonly AskLog[]): PlaybookEntry[] {
  const by = usesByEntry(logs);
  return entries.map((e) => {
    const u = by.get(e.id);
    const { lastUsed: _l, ...rest } = e;
    return u ? { ...rest, uses: u.uses, lastUsed: weekStart(u.lastWeek).toISOString() } : { ...rest, uses: 0 };
  });
}

/** Weekly counts for one entry (or for a set of entries), oldest first, over the last `weeks`. */
export function spark(logs: readonly AskLog[], ids: ReadonlySet<string> | string, now: Date = new Date(), weeks = 8): number[] {
  const want = typeof ids === 'string' ? new Set([ids]) : ids;
  const span = lastWeeks(now, weeks);
  const out = span.map(() => 0);
  for (const l of logs) {
    const i = span.indexOf(l.week);
    if (i < 0) continue;
    for (const [id, n] of Object.entries(l.counts)) if (want.has(id)) out[i]! += n;
  }
  return out;
}

/** Ids of this person's weekly files (asks and BZ) that are older than KEEP_WEEKS. */
export function expiredIds(docs: ReadonlyArray<{ id: string; week: string; user: string }>, user: string, now: Date = new Date()): string[] {
  const oldest = lastWeeks(now, KEEP_WEEKS)[0]!;
  const mine = userSlug(user);
  return docs.filter((d) => userSlug(d.user) === mine && d.week < oldest).map((d) => d.id);
}

// ---------------------------------------------------------------------------------------------
// Bravo Zulu: team/bz-<user>-<isoWeek>, one mark per entry per person per week

export interface BzLog {
  version: 1;
  kind: 'bz';
  id: string;
  user: string;
  week: string;
  /** Entries this person said helped, this week. Each at most once. */
  entries: string[];
  updated: string;
}

export const bzId = (user: string, week: string) => `bz-${userSlug(user)}-${week}`;

export function isBzLog(raw: unknown): raw is BzLog {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o.version === 1 && o.kind === 'bz' && typeof o.id === 'string' && typeof o.week === 'string' && WEEK.test(o.week) && Array.isArray(o.entries) && o.entries.every((x) => typeof x === 'string');
}

/** This person's BZ file with `entryId` added, or null when they already said it this week. */
export function addBz(logs: readonly BzLog[], user: string, entryId: string, now: Date = new Date()): BzLog | null {
  const week = isoWeek(now);
  const id = bzId(user, week);
  const prev = logs.find((l) => l.id === id);
  if (prev?.entries.includes(entryId)) return null;
  return { version: 1, kind: 'bz', id, user, week, entries: [...(prev?.entries ?? []), entryId].slice(-500), updated: now.toISOString() };
}

export function hasBz(logs: readonly BzLog[], user: string, entryId: string, now: Date = new Date()): boolean {
  return !!logs.find((l) => l.id === bzId(user, isoWeek(now)))?.entries.includes(entryId);
}

/** How many BZ marks a set of entries got in one week. */
export function bzCount(logs: readonly BzLog[], ids: ReadonlySet<string>, week: string): number {
  return logs.filter((l) => l.week === week).reduce((n, l) => n + l.entries.filter((e) => ids.has(e)).length, 0);
}

// ---------------------------------------------------------------------------------------------
// The analyst's impact card

export interface Impact {
  thisWeek: number;
  lastWeek: number;
  top: { title: string; count: number } | null;
  bz: number;
  waiting: number;
}

/**
 * What this analyst's reviewed answers did for leadership this week. Null when there is nothing
 * positive or actionable to say: a quiet week with no questions waiting shows nothing.
 */
export function impactFor(entries: readonly PlaybookEntry[], logs: readonly AskLog[], bz: readonly BzLog[], user: string, waiting: number, now: Date = new Date()): Impact | null {
  const mine = new Set(entries.filter((e) => e.acceptedBy === user && e.status !== 'retired').map((e) => e.id));
  const [prevWeek, week] = lastWeeks(now, 2) as [string, string];
  let thisWeek = 0;
  let lastWeek = 0;
  const per = new Map<string, number>();
  for (const l of logs) {
    if (l.week !== week && l.week !== prevWeek) continue;
    for (const [id, n] of Object.entries(l.counts)) {
      if (!mine.has(id)) continue;
      if (l.week === week) {
        thisWeek += n;
        per.set(id, (per.get(id) ?? 0) + n);
      } else lastWeek += n;
    }
  }
  const best = [...per.entries()].sort((a, b) => b[1] - a[1])[0];
  const top = best ? { title: entries.find((e) => e.id === best[0])?.title ?? best[0], count: best[1] } : null;
  const marks = bzCount(bz, mine, week);
  if (thisWeek === 0 && marks === 0 && waiting === 0) return null;
  return { thisWeek, lastWeek, top, bz: marks, waiting };
}

// ---------------------------------------------------------------------------------------------
// The team's week: computed from the playbook alone, no new storage

export interface TeamWeek {
  week: string;
  /** New reviewed answers this week, oldest first, with their author as credit. */
  added: Array<{ id: string; title: string; by: string; at: string }>;
  answered: number;
  covered: number;
  total: number;
  /** Measures that gained their first reviewed answer this week. */
  gained: number;
  /** Measures with no reviewed answer yet. */
  gaps: Array<{ metric: string; label: string }>;
}

export function teamWeek(entries: readonly PlaybookEntry[], questions: readonly QuestionItem[], index: CatalogIndex, now: Date = new Date()): TeamWeek {
  const week = isoWeek(now);
  const since = weekStart(week).toISOString();
  const live = entries.filter((e) => e.status !== 'retired');
  const added = live
    .filter((e) => e.acceptedAt >= since && e.revisions === 0)
    .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))
    .map((e) => ({ id: e.id, title: e.title, by: e.acceptedBy, at: e.acceptedAt }));
  const answered = questions.filter((q) => q.status === 'answered' && q.updated >= since).length;
  const now_ = coverage(live, index);
  const before = coverage(live.filter((e) => e.acceptedAt < since), index);
  const covered = now_.filter((c) => c.entries > 0).length;
  const coveredBefore = before.filter((c) => c.entries > 0).length;
  return {
    week,
    added,
    answered,
    covered,
    total: now_.length,
    gained: Math.max(0, covered - coveredBefore),
    gaps: now_.filter((c) => c.entries === 0).map((c) => ({ metric: c.metric, label: c.label })),
  };
}

// ---------------------------------------------------------------------------------------------
// The watch log: one ISO week is one watch. Private to this browser (semaphore.watchLog).

export type WatchState = 'stood' | 'away';
export type WatchLog = Record<string, WatchState>;

/** Weeks an away notice covers (any day of the week inside from..until). */
export function awayWeeks(n: Pick<AwayNotice, 'from' | 'until'>): string[] {
  const out: string[] = [];
  const end = Date.parse(`${n.until}T00:00:00Z`);
  for (let t = Date.parse(`${n.from}T00:00:00Z`); Number.isFinite(t) && t <= end && out.length < 60; t += 86_400_000) {
    const w = isoWeek(new Date(t));
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** The log with these weeks marked away, except weeks already stood. */
export function markAway(log: WatchLog, weeks: readonly string[]): WatchLog {
  const out = { ...log };
  for (const w of weeks) if (out[w] !== 'stood') out[w] = 'away';
  return out;
}

export function markStood(log: WatchLog, now: Date = new Date()): WatchLog {
  return { ...log, [isoWeek(now)]: 'stood' };
}

/** The last `n` watches, oldest first; a week with nothing logged is quiet. The current week counts as quiet until stood. */
export function watchStrip(log: WatchLog, now: Date = new Date(), n = 12): Array<{ week: string; state: WatchState | 'quiet' }> {
  return lastWeeks(now, n).map((week) => ({ week, state: log[week] ?? 'quiet' }));
}

/** Keep only the last year of the log, so it never grows without end. */
export function trimWatchLog(log: WatchLog, now: Date = new Date()): WatchLog {
  const keep = new Set(lastWeeks(now, 53));
  return Object.fromEntries(Object.entries(log).filter(([w]) => keep.has(w)));
}

/** The Monday cue: only when there is real work waiting. About a minute and a half an item. */
export function weekCue(needsReview: number, waiting: number): string | null {
  if (needsReview + waiting === 0) return null;
  const parts: string[] = [];
  if (needsReview) parts.push(`${needsReview} answer${needsReview === 1 ? '' : 's'} need${needsReview === 1 ? 's' : ''} review`);
  if (waiting) parts.push(`${waiting} question${waiting === 1 ? ' is' : 's are'} waiting`);
  const minutes = Math.max(5, Math.round(((needsReview + waiting) * 1.5) / 5) * 5);
  return `${parts.join(' and ')}. About ${minutes} minutes.`.replace(/^./, (c) => c.toUpperCase());
}

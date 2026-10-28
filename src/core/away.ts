// Away mode: an analyst says "I'm out until Friday". While they are out, leadership's view says so,
// familiar questions keep being answered from the reviewed playbook, and anything new waits in the
// question queue. When they are back, the "while you were out" digest lists what was asked, what
// the playbook answered, what Semaphore drafted and what needs their sign-off.
//
// A notice is one small file per analyst (team/away-<user>). It holds what the analyst typed and
// the dates, nothing else; the digest is computed from the question queue and the playbook.

import type { PlaybookEntry, QuestionItem } from './playbook.ts';

export interface AwayNotice {
  version: 1;
  /** `away-<user>`, safe as a file name. */
  id: string;
  analyst: string;
  /** ISO dates (yyyy-mm-dd); the analyst is out from the start of `from` to the end of `until`. */
  from: string;
  until: string;
  /** Shown to leadership, e.g. "Back Monday; urgent questions to the watch officer." */
  note: string;
  setAt: string;
  /** Set when the analyst says they are back (or reads the digest); the notice then stops showing. */
  back?: string;
}

export function awayId(user: string): string {
  return `away-${user.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 64);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isAwayNotice(raw: unknown): raw is AwayNotice {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.id === 'string' && o.id.startsWith('away-') &&
    typeof o.analyst === 'string' &&
    typeof o.from === 'string' && DATE.test(o.from) &&
    typeof o.until === 'string' && DATE.test(o.until) &&
    typeof o.note === 'string' &&
    typeof o.setAt === 'string'
  );
}

/** A new notice; throws a readable message for bad dates. `note` is capped at 300 characters. */
export function newAwayNotice(user: string, from: string, until: string, note: string, now: Date = new Date()): AwayNotice {
  if (!DATE.test(from) || !DATE.test(until)) throw new Error('Pick both dates.');
  if (until < from) throw new Error('The return date is before the start date.');
  return { version: 1, id: awayId(user), analyst: user, from, until, note: note.trim().slice(0, 300), setAt: now.toISOString() };
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Out right now: inside the dates and not marked back. */
export function isAway(n: AwayNotice, now: Date = new Date()): boolean {
  if (n.back) return false;
  const today = day(now);
  return n.from <= today && today <= n.until;
}

/** The notice's period is over (or they came back) and the digest has something to cover. */
export function isReturned(n: AwayNotice, now: Date = new Date()): boolean {
  return !!n.back || day(now) > n.until;
}

export function markBack(n: AwayNotice, now: Date = new Date()): AwayNotice {
  return { ...n, back: now.toISOString() };
}

export interface AwayDigest {
  from: string;
  to: string;
  /** Everything leadership asked that reached the queue in the period, newest first. */
  asked: QuestionItem[];
  /** Questions Semaphore drafted an answer for: shown to leadership, not yet reviewed. */
  drafted: QuestionItem[];
  /** Questions nothing could answer, waiting for the analyst. */
  waiting: QuestionItem[];
  /** Reviewed entries leadership used in the period, most used first. */
  usedEntries: PlaybookEntry[];
  /** Entries Semaphore flagged for review in the period (catalog changes, stopped running, ...). */
  needsReview: PlaybookEntry[];
  /** True when there is anything for the analyst to do. */
  actionNeeded: boolean;
}

/**
 * The "while you were out" digest. The period runs from the start of `from` to when the analyst came
 * back (or now). Entries count as used in the period when their last use falls inside it.
 */
export function whileYouWereOut(n: AwayNotice, questions: readonly QuestionItem[], entries: readonly PlaybookEntry[], now: Date = new Date()): AwayDigest {
  const start = `${n.from}T00:00:00.000Z`;
  const end = n.back ?? now.toISOString();
  const inPeriod = (iso: string | undefined) => !!iso && iso >= start && iso <= end;
  const asked = questions.filter((q) => inPeriod(q.askedAt)).sort((a, b) => b.askedAt.localeCompare(a.askedAt));
  const drafted = asked.filter((q) => q.status === 'open' && q.shown === 'drafted');
  const waiting = asked.filter((q) => q.status === 'open' && q.shown === 'none');
  const usedEntries = entries.filter((e) => e.status !== 'retired' && inPeriod(e.lastUsed)).sort((a, b) => b.uses - a.uses);
  const needsReview = entries.filter((e) => e.status === 'needs-review' && inPeriod(e.review?.at));
  return { from: n.from, to: end.slice(0, 10), asked, drafted, waiting, usedEntries, needsReview, actionNeeded: drafted.length + waiting.length + needsReview.length > 0 };
}

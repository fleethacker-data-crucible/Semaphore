// How good the answers leadership gets are, from what is already kept: the weekly ask files
// (impact.ts: reviewed answers shown, and drafted ones under DRAFTED_ASK) and the question queue
// (playbook.ts: when each was asked and answered). Nothing new is recorded for these numbers.
//
// The share of answers that were reviewed comes from the ask files, so it is not shown when the
// "impact" switch is off for this person or the deployment (nothing is counted then). The timing
// and queue numbers come from the questions alone and name nobody.

import { type AskLog, DRAFTED_ASK, lastWeeks, weekStart } from './impact.ts';
import { type QuestionItem, withAskers } from './playbook.ts';

export interface AnswerQuality {
  weeks: number;
  /** Reviewed answers shown in the window; null when not counted (impact off). */
  reviewed: number | null;
  drafted: number | null;
  /** reviewed / (reviewed + drafted), 0..1; null when nothing was counted. */
  reviewedShare: number | null;
  /** Questions answered with a reviewed answer in the window, and how long that took. */
  answered: number;
  medianHours: number | null;
  p90Hours: number | null;
  /** The open queue now. */
  open: number;
  /** Of those, how many have a draft waiting for review. */
  draftsWaiting: number;
  oldestOpenDays: number | null;
  medianOpenDays: number | null;
}

/** The p-th percentile (0..100) by linear interpolation between closest ranks; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0]!;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo]! + (v[hi]! - v[lo]!) * (rank - lo);
}

export function answerQuality(input: { asks: readonly AskLog[]; questions: readonly QuestionItem[]; counted: boolean }, now: Date = new Date(), weeks = 8): AnswerQuality {
  const span = new Set(lastWeeks(now, weeks));
  const since = weekStart(lastWeeks(now, weeks)[0]!).toISOString();
  let reviewed = 0;
  let drafted = 0;
  if (input.counted) {
    for (const l of input.asks) {
      if (!span.has(l.week)) continue;
      for (const [id, n] of Object.entries(l.counts)) {
        if (id === DRAFTED_ASK) drafted += n;
        else reviewed += n;
      }
    }
  }
  const total = reviewed + drafted;
  const hours: number[] = [];
  for (const q of input.questions) {
    if (q.status !== 'answered') continue;
    const done = q.answeredAt ?? q.updated;
    if (!done || done < since) continue;
    const h = (Date.parse(done) - Date.parse(q.askedAt)) / 3_600_000;
    if (Number.isFinite(h) && h >= 0) hours.push(h);
  }
  const open = input.questions.filter((q) => q.status === 'open');
  const ages = open.map((q) => (now.getTime() - Date.parse(withAskers(q).askedAt)) / 86_400_000).filter((d) => Number.isFinite(d) && d >= 0);
  return {
    weeks,
    reviewed: input.counted ? reviewed : null,
    drafted: input.counted ? drafted : null,
    reviewedShare: input.counted && total > 0 ? reviewed / total : null,
    answered: hours.length,
    medianHours: percentile(hours, 50),
    p90Hours: percentile(hours, 90),
    open: open.length,
    draftsWaiting: open.filter((q) => !!q.draft && !!q.reviewRequested).length,
    oldestOpenDays: ages.length ? Math.max(...ages) : null,
    medianOpenDays: percentile(ages, 50),
  };
}

/** "3 hours", "2.5 days": a duration in hours as people say it. */
export function durationText(hours: number | null): string {
  if (hours === null) return 'none yet';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

// Drafted answers and their review. When a leader asks something no reviewed answer covers,
// Semaphore drafts one live and shows it labelled "Drafted - not yet reviewed". The leader can ask
// for it to be reviewed: the question goes to the analysts' queue with the draft attached, and an
// analyst accepts it (it becomes a reviewed playbook entry), edits it in the builder (accepting the
// edited flag answers the question as any accepted flag does), or rejects it with a reason.
//
// A draft is never a playbook entry until an analyst accepts it, so it never feeds the briefing,
// the "What changed" list or the alerts as if it were reviewed.
//
// Data access: Semaphore has no row-level security of its own. A live draft runs with the person's
// own database sign-in (kept in Lazarette), so the database's own row security decides what they
// see. A draft answered from a saved snapshot shows what the analyst's refresh read.

import type { CatalogIndex } from './catalog.ts';
import { metricTable } from './catalog.ts';
import type { Flag } from './hoist.ts';
import { DEFAULT_SIZE } from './layout.ts';
import { addAsker, type Answer, type DraftedAnswer, entryId, newQuestion, normalizeQuestion, type PlaybookEntry, type QuestionItem, type Trust } from './playbook.ts';

/** The hoist id accepted drafts are filed under in the playbook. */
export const ASK_HOIST = { id: 'leadership-questions', title: 'Leadership questions' };

export interface TrustLabel {
  label: string;
  /** True only for answers that come from an analyst's reviewed work. */
  reviewed: boolean;
  /** What a screen reader hears beside the label. */
  sr: string;
}

export const TRUST_LABELS: Record<Trust, TrustLabel> = {
  reviewed: { label: 'Reviewed', reviewed: true, sr: 'An analyst reviewed this answer.' },
  adjusted: { label: 'Worked out from a reviewed flag', reviewed: true, sr: "Worked out from an analyst's reviewed flag." },
  drafted: { label: 'Drafted — not yet reviewed', reviewed: false, sr: 'This answer was drafted by Semaphore. No analyst has reviewed it yet.' },
  none: { label: "Can't answer yet", reviewed: false, sr: 'Semaphore could not answer this yet.' },
};

/** What the drafted card says about whose data it shows. Never more than is true. */
export function dataAccessNote(from: 'snapshot' | 'live'): string {
  if (from === 'live')
    return "Run live with your own database sign-in from Lazarette. Semaphore has no row-level security of its own: the database's own row security decides which rows you can see.";
  return "Worked out from a snapshot saved by the analysts' refresh, so it shows what their sign-in could read. Semaphore has no row-level security of its own.";
}

/** "Ask for review" is offered only on a drafted answer that was shown with numbers. */
export function canAskForReview(trust: Trust, state: 'working' | 'ready' | 'unanswered' | string): boolean {
  return trust === 'drafted' && state === 'ready';
}

/** The draft to keep with the question, or null when the answer is not a drafted one with a binding. */
export function draftOf(answer: Answer, from: 'snapshot' | 'live', by = 'local rules', now: Date = new Date()): DraftedAnswer | null {
  if (answer.trust !== 'drafted' || !answer.flag.binding || answer.flag.binding.metrics.length === 0) return null;
  return { kind: answer.flag.kind, title: answer.flag.title, binding: answer.flag.binding, filters: answer.filters, thresholds: answer.flag.behavior.thresholds, by, draftedAt: now.toISOString(), from };
}

/**
 * The question to save when a leader presses "Ask for review": an open question in the same words
 * gets this asker counted and the draft attached; otherwise a new one.
 */
export function requestReview(questions: readonly QuestionItem[], answer: Answer, user: string, draft: DraftedAnswer, now: Date = new Date()): QuestionItem {
  const asked = normalizeQuestion(answer.question);
  const open = questions.find((x) => x.status === 'open' && normalizeQuestion(x.title) === asked);
  const base = open ? (open.askers?.includes(user) ? { ...open } : addAsker(open, user, now)) : newQuestion(answer.question, user, 'drafted', answer.reasons, now);
  return { ...base, shown: 'drafted', draft, reviewRequested: now.toISOString(), updated: now.toISOString() };
}

/** True when this person already asked for review of an open question in these words. */
export function reviewAsked(questions: readonly QuestionItem[], question: string, user: string): boolean {
  const asked = normalizeQuestion(question);
  return questions.some((x) => x.status === 'open' && !!x.reviewRequested && normalizeQuestion(x.title) === asked && (x.askedBy === user || (x.askers ?? []).includes(user)));
}

/** The open questions with a draft waiting for an analyst. */
export function draftsWaiting(questions: readonly QuestionItem[]): QuestionItem[] {
  return questions.filter((q) => q.status === 'open' && !!q.draft && !!q.reviewRequested);
}

/**
 * An analyst accepts a draft: it becomes a reviewed playbook entry in the asker's words, and the
 * question is answered with it. Null when the draft no longer fits the catalog.
 */
export function acceptDraft(q: QuestionItem, analyst: string, index: CatalogIndex, now: Date = new Date()): { entry: PlaybookEntry; question: QuestionItem } | null {
  const d = q.draft;
  if (!d || q.status !== 'open') return null;
  const m = d.binding.metrics[0] ? index.metric(d.binding.metrics[0]) : undefined;
  const table = m ? metricTable(index, m) : undefined;
  if (!m || !table) return null;
  const at = now.toISOString();
  const entry: PlaybookEntry = {
    version: 1,
    id: entryId(ASK_HOIST.id, q.id),
    title: d.title || q.title,
    question: q.title,
    phrasings: [],
    kind: d.kind,
    binding: d.binding,
    thresholds: d.thresholds,
    pageFilters: d.filters,
    source: m.source,
    table,
    hoist: ASK_HOIST,
    acceptedBy: analyst,
    acceptedAt: at,
    revisions: 0,
    status: 'active',
    uses: 0,
    updated: at,
  };
  return { entry, question: { ...q, status: 'answered', entryId: entry.id, answeredAt: at, reviewedBy: analyst, updated: at } };
}

/** An analyst rejects a draft: the question is closed with the reason, which the asker sees. */
export function rejectDraft(q: QuestionItem, analyst: string, reason: string, now: Date = new Date()): QuestionItem {
  const at = now.toISOString();
  return { ...q, status: 'dismissed', reviewedBy: analyst, rejected: { by: analyst, at, reason: reason.trim().slice(0, 300) || 'No reason given.' }, updated: at };
}

/** The flag "Edit in builder" drops on the page: the draft as it was shown, to check, change and accept. */
export function draftFlag(q: QuestionItem, id: string, layout: Flag['layout']): Flag {
  const d = q.draft;
  const size = d ? DEFAULT_SIZE[d.kind] : { w: 4, h: 4 };
  const note = `Asked by ${q.askedBy}; Semaphore drafted this for them (not reviewed). Check it, change it if needed, and accept it to answer them.`;
  if (!d) return { id, kind: 'bar', title: '', brief: q.title, layout, binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'empty', notes: [note] };
  return { id, kind: d.kind, title: d.title, brief: q.title, layout: { ...layout, w: Math.max(layout.w, size.w), h: Math.max(layout.h, size.h) }, binding: d.binding, behavior: { onClick: 'none', ignore: [], thresholds: d.thresholds }, status: 'drafted', notes: [note] };
}

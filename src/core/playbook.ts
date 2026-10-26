// The playbook: what analysts have reviewed, kept so leadership can ask and Semaphore can answer
// with the analysts' own work. An entry is an accepted flag: the question in the analyst's words,
// the exact binding that answers it, its colour rules and its window, and who accepted it when.
//
// It learns only from accepted work (a flag marked ready), never from drafts nobody accepted, and
// never from flags marked "do not learn". Nothing about how people work is recorded.
//
// Answering is deterministic: a question is read by local rules into a binding, and that binding's
// signature is compared with every entry's. The answer says which entry it used and why, and how
// far to trust it:
//   reviewed  the question asks exactly what an accepted flag shows (or was asked in those words)
//   adjusted  an accepted flag holds the answer once its numbers are re-added (fewer fields, a
//             value picked out of a field); the window and measures are the reviewed ones
//   drafted   local rules drafted it from the catalog; nobody has reviewed it
//   none      nothing in the catalog fits

import type { CatalogIndex } from './catalog.ts';
import { metricTable } from './catalog.ts';
import { type Binding, type Comparison, dimensionKey, type Filter, type Flag, type FlagKind, type Hoist, parseBinding, parseFilters, type Threshold } from './hoist.ts';
import { draftFlagLocally } from './intelligence/local-rules.ts';
import { DEFAULT_SIZE } from './layout.ts';
import { planFlag } from './planner.ts';

export type EntryStatus = 'active' | 'needs-review' | 'retired';

export interface PlaybookEntry {
  version: 1;
  /** `<hoist id>--<flag id>`, safe as a file name. */
  id: string;
  title: string;
  /** The flag's brief, in the analyst's words. */
  question: string;
  /** Other wordings that are known to mean this entry (questions an analyst answered with it). */
  phrasings: string[];
  kind: FlagKind;
  binding: Binding;
  thresholds: Threshold[];
  /** The hoist's fixed filters when it was accepted: its window ("last 12 months"). */
  pageFilters: Filter[];
  source: string;
  table: string;
  hoist: { id: string; title: string };
  acceptedBy: string;
  acceptedAt: string;
  /** How many times the accepted flag has changed and been accepted again. */
  revisions: number;
  status: EntryStatus;
  review?: { reason: string; at: string };
  retired?: { by: string; at: string; reason: string };
  uses: number;
  lastUsed?: string;
  updated: string;
}

/** A question from leadership that no reviewed entry answered, waiting for an analyst. */
export interface QuestionItem {
  version: 1;
  id: string;
  /** The question, also shown as the list title. */
  title: string;
  askedBy: string;
  askedAt: string;
  /** What leadership was shown. */
  shown: 'drafted' | 'none';
  notes: string[];
  status: 'open' | 'answered' | 'dismissed';
  entryId?: string;
  updated: string;
}

/** Entries not used for this long are flagged for review. */
export const STALE_DAYS = 180;

export function entryId(hoistId: string, flagId: string): string {
  return `${hoistId}--${flagId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** Lower case, single spaces, no punctuation at the ends: how two wordings are compared. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9%$' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function learnable(flag: Flag): boolean {
  return flag.status === 'ready' && flag.learn !== false && flag.kind !== 'text' && flag.kind !== 'filter' && !!flag.binding && flag.binding.metrics.length > 0;
}

function tableOf(binding: Binding, index: CatalogIndex): { source: string; table: string } | null {
  const m = binding.metrics[0] ? index.metric(binding.metrics[0]) : undefined;
  if (!m) return null;
  const table = metricTable(index, m);
  return table ? { source: m.source, table } : null;
}

/**
 * New and changed entries for the accepted flags of a hoist. Only what changed is returned, so
 * the caller saves just those. A flag accepted again after a change replaces its entry (one more
 * revision) and clears any "needs review".
 */
export function learnFromHoist(entries: readonly PlaybookEntry[], hoist: Hoist, index: CatalogIndex, by: string, now: Date = new Date()): PlaybookEntry[] {
  const out: PlaybookEntry[] = [];
  const at = now.toISOString();
  for (const flag of hoist.flags) {
    if (!learnable(flag)) continue;
    const where = tableOf(flag.binding!, index);
    if (!where) continue;
    const id = entryId(hoist.id, flag.id);
    const prev = entries.find((e) => e.id === id);
    if (prev?.status === 'retired') continue; // retired on purpose; accepting again does not bring it back silently
    const question = (flag.brief || flag.title).trim().slice(0, 1000);
    const content = { kind: flag.kind, binding: flag.binding!, thresholds: flag.behavior.thresholds, pageFilters: hoist.filters.filter((f) => !flag.behavior.ignore.includes(f.field)), question };
    if (prev && JSON.stringify({ kind: prev.kind, binding: prev.binding, thresholds: prev.thresholds, pageFilters: prev.pageFilters, question: prev.question }) === JSON.stringify(content)) {
      if (prev.title !== flag.title || prev.hoist.title !== hoist.title) out.push({ ...prev, title: flag.title || prev.title, hoist: { id: hoist.id, title: hoist.title }, updated: at });
      continue;
    }
    const entry: PlaybookEntry = {
      version: 1,
      id,
      title: flag.title || question,
      ...content,
      phrasings: prev ? prev.phrasings : [],
      source: where.source,
      table: where.table,
      hoist: { id: hoist.id, title: hoist.title },
      acceptedBy: by,
      acceptedAt: at,
      revisions: prev ? prev.revisions + 1 : 0,
      status: 'active',
      uses: prev?.uses ?? 0,
      updated: at,
    };
    if (prev?.lastUsed) entry.lastUsed = prev.lastUsed;
    out.push(entry);
  }
  return out;
}

/**
 * Entries whose status should change: anything that no longer fits the catalog, no longer plans,
 * or has not been used for STALE_DAYS is flagged "needs review" with the reason. Entries that are
 * fine again go back to active. Retired entries are left alone.
 */
export function checkHealth(entries: readonly PlaybookEntry[], index: CatalogIndex, now: Date = new Date()): PlaybookEntry[] {
  const out: PlaybookEntry[] = [];
  for (const e of entries) {
    if (e.status === 'retired') continue;
    const reason = healthProblem(e, index, now);
    if (reason && (e.status !== 'needs-review' || e.review?.reason !== reason)) out.push({ ...e, status: 'needs-review', review: { reason, at: now.toISOString() }, updated: now.toISOString() });
    else if (!reason && e.status === 'needs-review' && !e.review?.reason.startsWith('Marked by')) {
      const { review: _r, ...rest } = e;
      out.push({ ...rest, status: 'active', updated: now.toISOString() });
    }
  }
  return out;
}

function healthProblem(e: PlaybookEntry, index: CatalogIndex, now: Date): string | null {
  const warnings: string[] = [];
  const b = parseBinding(e.binding, index, warnings, 'Entry');
  parseFilters(e.pageFilters, index, warnings, 'Entry');
  if (!b || warnings.length) return `It uses something the catalog no longer has (${warnings[0] ?? 'its binding'}).`;
  const plan = planFlag(entryHoist(e), entryFlag(e), index);
  if (!plan.ok) return `It no longer runs: ${plan.error}`;
  const last = Date.parse(e.lastUsed ?? e.acceptedAt);
  if (Number.isFinite(last) && now.getTime() - last > STALE_DAYS * 86_400_000) return `Nobody has used it for ${STALE_DAYS / 30} months.`;
  return null;
}

export function retireEntry(e: PlaybookEntry, by: string, reason: string, now: Date = new Date()): PlaybookEntry {
  return { ...e, status: 'retired', retired: { by, at: now.toISOString(), reason: reason.trim().slice(0, 300) || 'No reason given.' }, updated: now.toISOString() };
}

export function restoreEntry(e: PlaybookEntry, now: Date = new Date()): PlaybookEntry {
  const { retired: _r, review: _v, ...rest } = e;
  return { ...rest, status: 'active', updated: now.toISOString() };
}

export function flagForReview(e: PlaybookEntry, by: string, note: string, now: Date = new Date()): PlaybookEntry {
  return { ...e, status: 'needs-review', review: { reason: `Marked by ${by}: ${note.trim().slice(0, 300) || 'needs a look.'}`, at: now.toISOString() }, updated: now.toISOString() };
}

export function recordUse(e: PlaybookEntry, now: Date = new Date()): PlaybookEntry {
  return { ...e, uses: e.uses + 1, lastUsed: now.toISOString(), updated: now.toISOString() };
}

/** A one-flag hoist that reproduces an entry exactly: its window and its binding. */
export function entryHoist(e: PlaybookEntry): Hoist {
  return { version: 1, id: `pb-${e.id}`.slice(0, 64), title: e.title, brief: '', grid: { cols: 12 }, filters: e.pageFilters, flags: [], updated: e.updated };
}

export function entryFlag(e: PlaybookEntry, id = 'answer'): Flag {
  const size = DEFAULT_SIZE[e.kind];
  return {
    id,
    kind: e.kind,
    title: e.title,
    brief: e.question,
    layout: { x: 0, y: 0, w: size.w, h: size.h },
    binding: e.binding,
    behavior: { onClick: 'none', ignore: [], thresholds: e.thresholds },
    status: 'ready',
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Answering a question

export type Trust = 'reviewed' | 'adjusted' | 'drafted' | 'none';

export interface Answer {
  question: string;
  trust: Trust;
  /** The entry the answer reuses, for reviewed and adjusted answers. */
  entry?: PlaybookEntry;
  /** The flag to show, and the page filters (window) it runs under. */
  flag: Flag;
  filters: Filter[];
  /** Why this trust level, in plain words. */
  reasons: string[];
}

interface Signature {
  metrics: string[];
  dims: string[];
  window: string | null;
  filters: string[];
  compare: Comparison | null;
}

function windowOf(filters: readonly Filter[]): Filter | undefined {
  return filters.find((f) => f.op === 'last');
}

function signature(binding: Binding, pageFilters: readonly Filter[]): Signature {
  const all = [...pageFilters, ...binding.filters];
  const w = [...binding.filters, ...pageFilters].find((f) => f.op === 'last');
  return {
    metrics: [...binding.metrics].sort(),
    dims: binding.dimensions.map(dimensionKey).sort(),
    window: w ? `${w.field}:${w.values[0]}:${w.unit}` : null,
    filters: all.filter((f) => f.op !== 'last').map((f) => JSON.stringify([f.field, f.op, f.values])).sort(),
    compare: binding.compare ?? null,
  };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const within = (small: readonly string[], big: readonly string[]) => small.every((x) => big.includes(x));

export function answerQuestion(question: string, entries: readonly PlaybookEntry[], index: CatalogIndex): Answer {
  const q = question.trim().slice(0, 1000);
  const live = entries.filter((e) => e.status !== 'retired');
  const asked = normalizeQuestion(q);

  // 1. Asked in words an analyst already answered.
  const worded = live.find((e) => normalizeQuestion(e.question) === asked || e.phrasings.some((p) => normalizeQuestion(p) === asked));
  if (worded) return reviewed(q, worded, ['Asked in the same words as an analyst-reviewed flag.']);

  const draft = draftFlagLocally(q, 'bar', index, { auto: true });
  if (!draft.binding || draft.binding.metrics.length === 0) {
    return { question: q, trust: 'none', flag: blankFlag(q, draft.notes), filters: [], reasons: draft.notes.length ? draft.notes : ['Nothing in the question matched the catalog.'] };
  }
  const qs = signature(draft.binding, []);

  // 2. Exactly what an accepted flag shows. A question with no window takes the entry's.
  const exact = live
    .filter((e) => {
      const es = signature(e.binding, e.pageFilters);
      return same(qs.metrics, es.metrics) && same(qs.dims, es.dims) && same(qs.filters, es.filters) && qs.compare === es.compare && (qs.window === null || qs.window === es.window);
    })
    .sort(byPreference)[0];
  if (exact) {
    const ranked = draft.binding.limit && draft.binding.limit !== exact.binding.limit;
    if (!ranked) return reviewed(q, exact, ['Asks exactly what an analyst-reviewed flag shows.']);
  }

  // 3. An accepted flag holds the answer once its numbers are re-added: the measures and fields
  //    asked for are among its own, and the window is its window. Values picked out of one of its
  //    fields ("for icebreakers") become selections. Distinct counts cannot be re-added.
  const filterFieldsOk = (e: PlaybookEntry) => draft.binding!.filters.every((f) => f.op === 'last' || ((f.op === 'in' || f.op === 'eq') && e.binding.dimensions.some((d) => !d.grain && d.field === f.field)));
  const holder = live
    .filter((e) => {
      const es = signature(e.binding, e.pageFilters);
      if (!within(qs.metrics, es.metrics) || !within(qs.dims, es.dims)) return false;
      if (qs.window !== null && qs.window !== es.window) return false;
      // The entry's own fixed filters must be part of the question too, or its numbers are narrower.
      if (!within(es.filters, qs.filters) || !filterFieldsOk(e)) return false;
      if ((qs.compare ?? null) !== null && qs.compare !== es.compare) return false;
      const distinct = qs.metrics.some((k) => index.metric(k)?.agg === 'count_distinct');
      if (distinct && (!same(qs.dims, es.dims) || draft.binding!.filters.some((f) => f.op !== 'last'))) return false;
      return true;
    })
    .sort((a, b) => a.binding.dimensions.length - b.binding.dimensions.length || byPreference(a, b))[0];
  if (holder) {
    const window = holder.pageFilters;
    const binding: Binding = { ...draft.binding, filters: draft.binding.filters.filter((f) => f.op !== 'last' && !window.some((w) => w.field === f.field)) };
    const reasons = [`Worked out from "${holder.title}", reviewed by ${holder.acceptedBy}: same measures and window, re-added to what you asked.`];
    const flag: Flag = { ...answerFlag(q, draft.kind, draft.title, binding), behavior: { onClick: 'none', ignore: [], thresholds: holder.thresholds.filter((t) => binding.metrics.includes(t.metric)) } };
    return { question: q, trust: 'adjusted', entry: holder, flag, filters: window, reasons };
  }

  // 4. Local rules, from the catalog alone. Borrow the team's usual window for that table.
  const where = tableOf(draft.binding, index);
  const usual = where ? live.filter((e) => e.table === where.table).sort(byPreference)[0] : undefined;
  const hasWindow = draft.binding.filters.some((f) => f.op === 'last');
  const filters = !hasWindow && usual ? usual.pageFilters.filter((f) => f.op === 'last') : [];
  const reasons = ['Drafted by Semaphore from the catalog. No analyst has reviewed this.'];
  if (filters.length) reasons.push(`Uses the team's usual window for this data (from "${usual!.title}").`);
  reasons.push(...draft.notes);
  return { question: q, trust: 'drafted', flag: answerFlag(q, draft.kind, draft.title, draft.binding, draft.behavior.thresholds), filters, reasons };
}

function reviewed(q: string, e: PlaybookEntry, reasons: string[]): Answer {
  return { question: q, trust: 'reviewed', entry: e, flag: entryFlag(e), filters: e.pageFilters, reasons: [...reasons, `Built by ${e.acceptedBy}, accepted ${e.acceptedAt.slice(0, 10)}.`] };
}

function byPreference(a: PlaybookEntry, b: PlaybookEntry): number {
  // Active before needs-review, then most used, then most recently accepted.
  const s = (e: PlaybookEntry) => (e.status === 'active' ? 0 : 1);
  return s(a) - s(b) || b.uses - a.uses || b.acceptedAt.localeCompare(a.acceptedAt);
}

function answerFlag(q: string, kind: FlagKind, title: string, binding: Binding, thresholds: Threshold[] = []): Flag {
  const size = DEFAULT_SIZE[kind];
  return { id: 'answer', kind, title: title || q, brief: q, layout: { x: 0, y: 0, w: size.w, h: size.h }, binding, behavior: { onClick: 'none', ignore: [], thresholds }, status: 'drafted', notes: [] };
}

function blankFlag(q: string, notes: string[]): Flag {
  return { id: 'answer', kind: 'text', title: q, brief: q, layout: { x: 0, y: 0, w: 4, h: 2 }, binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'empty', notes };
}

/** Follow-up questions worth one click: another split, a comparison, the top few, the total. */
export function followUps(answer: Answer, index: CatalogIndex): Array<{ label: string; question: string }> {
  const b = answer.flag.binding;
  if (!b || b.metrics.length === 0) return [];
  const where = tableOf(b, index);
  const base = answer.question.replace(/[?.!\s]+$/, '');
  const out: Array<{ label: string; question: string }> = [];
  const used = new Set(b.dimensions.map((d) => d.field));
  const splits = index.catalog.fields
    .filter((f) => where && f.table === where.table && f.source === where.source && f.type === 'string' && !used.has(f.key) && (f.cardinality ?? 50) <= 30)
    .sort((x, y) => (x.cardinality ?? 50) - (y.cardinality ?? 50))
    .slice(0, 2);
  for (const f of splits) out.push({ label: `by ${f.label.toLowerCase()}`, question: `${base} by ${f.label.toLowerCase()}` });
  const date = index.catalog.fields.find((f) => where && f.table === where.table && f.type === 'date');
  if (date && !b.dimensions.some((d) => d.grain)) out.push({ label: 'per month', question: `${base} per month` });
  if (!b.compare && answer.filters.concat(b.filters).some((f) => f.op === 'last')) out.push({ label: 'vs last year', question: `${base} vs last year` });
  if (b.dimensions.length > 0 && !b.limit) out.push({ label: 'top 5', question: `${base}, top 5` });
  return out.slice(0, 4);
}

/** Open questions that an entry now answers in the same words, marked answered. */
export function resolveQuestions(questions: readonly QuestionItem[], entries: readonly PlaybookEntry[], now: Date = new Date()): QuestionItem[] {
  const out: QuestionItem[] = [];
  for (const item of questions) {
    if (item.status !== 'open') continue;
    const asked = normalizeQuestion(item.title);
    const e = entries.find((x) => x.status !== 'retired' && (normalizeQuestion(x.question) === asked || x.phrasings.some((p) => normalizeQuestion(p) === asked)));
    if (e) out.push({ ...item, status: 'answered', entryId: e.id, updated: now.toISOString() });
  }
  return out;
}

export function newQuestion(question: string, askedBy: string, shown: 'drafted' | 'none', notes: string[], now: Date = new Date()): QuestionItem {
  const stamp = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return {
    version: 1,
    id: `q-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    title: question.trim().slice(0, 1000),
    askedBy,
    askedAt: now.toISOString(),
    shown,
    notes: notes.slice(0, 10),
    status: 'open',
    updated: now.toISOString(),
  };
}

/** Coverage: which measures have reviewed answers, and which would be guessed. */
export function coverage(entries: readonly PlaybookEntry[], index: CatalogIndex): Array<{ metric: string; label: string; entries: number }> {
  return index.catalog.metrics
    .map((m) => ({ metric: m.key, label: m.label, entries: entries.filter((e) => e.status !== 'retired' && e.binding.metrics.includes(m.key)).length }))
    .sort((a, b) => a.entries - b.entries || a.label.localeCompare(b.label));
}

/** Validate an entry read from the shared folder. Anything malformed is skipped by the caller. */
export function isEntry(raw: unknown): raw is PlaybookEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    e.version === 1 &&
    typeof e.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(e.id) &&
    typeof e.question === 'string' &&
    typeof e.kind === 'string' &&
    typeof e.binding === 'object' &&
    e.binding !== null &&
    Array.isArray(e.pageFilters) &&
    Array.isArray(e.thresholds) &&
    Array.isArray(e.phrasings) &&
    typeof e.acceptedBy === 'string' &&
    typeof e.acceptedAt === 'string' &&
    (e.status === 'active' || e.status === 'needs-review' || e.status === 'retired') &&
    typeof e.uses === 'number'
  );
}

export function isQuestion(raw: unknown): raw is QuestionItem {
  if (typeof raw !== 'object' || raw === null) return false;
  const q = raw as Record<string, unknown>;
  return q.version === 1 && typeof q.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(q.id) && typeof q.title === 'string' && (q.status === 'open' || q.status === 'answered' || q.status === 'dismissed');
}

/** An analyst answered a queued question with an entry: remember the wording for next time. */
export function addPhrasing(e: PlaybookEntry, question: string, now: Date = new Date()): PlaybookEntry {
  const q = question.trim().slice(0, 1000);
  if (!q || normalizeQuestion(q) === normalizeQuestion(e.question) || e.phrasings.some((p) => normalizeQuestion(p) === normalizeQuestion(q))) return e;
  return { ...e, phrasings: [...e.phrasings, q].slice(-30), updated: now.toISOString() };
}

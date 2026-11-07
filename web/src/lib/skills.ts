// The Signal Book and the watch log: private, in this browser only (semaphore.signalBook and
// semaphore.watchLog), never in the shared playbook and never shown to anyone else. Both can be
// switched off for a deployment with settings.json "signalBook": false; every call here is then a
// no-op, as it is when browser storage fails.
//
// A signal flag is earned by the FIRST real use of a capability, once, with no counts to grind.
// A watch is one ISO week; it is stood by one meaningful act that week (src/core/impact.ts).
//
// Who fires what (callers own these lines; keep this list current):
//   recordSkill('accept')        flags agent: a flag accepted (Canvas/Inspector accept path), with
//                                {hoistId, flagId}. recordFlagSkills(flag, hoistId) does accept
//                                plus compare/share/drill/click-filter/rule/ignore in one call.
//   recordSkill('draft')         flags agent: the first flag drafted from a brief.
//   recordSkill('compare'|'share'|'drill'|'click-filter'|'rule'|'ignore')
//                                flags agent via recordFlagSkills, from the accepted flag's binding
//                                and behaviour (the same things annotateBrief(flag.brief).spans
//                                marks as compare/share/click/threshold/ignore).
//   recordSkill('clean')         CleanPanel.tsx CleanTab, a cleaning step accepted.
//   recordSkill('link')          CleanPanel.tsx RelationshipsTab, a relationship added or confirmed.
//   recordSkill('drill-path')    CleanPanel.tsx DrillPaths, a drill path saved.
//   recordSkill('qlik')          QlikImport.tsx, an import that brought tables across.
//   recordSkill('kit')           KitsPanel.tsx, a kit saved.
//   recordSkill('fly')           KitsPanel.tsx, a kit flown on a page.
//   recordSkill('csv')           DataPanel.tsx, CSV or Fleet export files added.
//   recordSkill('lineage')       LineageView.tsx, the lineage view opened.
//   recordSkill('away')          TeamPanels.tsx AwayTab, an away notice set.
//   recordSkill('answer')        lib/playbook.ts saveQuestion, a leadership question marked answered.
//   recordSkill('review')        PlaybookPanel.tsx, "Still right" on an entry that needed review.
//   recordSkill('experiment')    SignalBook.tsx scan: a "Try freely" page with flags on it.
//   recordWatch('accept')        flags agent, with recordSkill('accept').
//   recordWatch('refresh')       flags agent: a flag refreshed by hand.
//   recordWatch('answer')        lib/playbook.ts saveQuestion (as above).
//   recordWatch('review')        PlaybookPanel.tsx "Still right".
// SignalBook.tsx also scans the open page, the analyst's own playbook entries and the catalog when
// the book opens, so work done before the book existed (or before a caller was wired) still counts.

import { useSyncExternalStore } from 'react';
import { type AwayNotice } from '../../../src/core/away.ts';
import type { Catalog } from '../../../src/core/catalog.ts';
import type { Flag, Hoist } from '../../../src/core/hoist.ts';
import { awayWeeks, markAway, markStood, trimWatchLog, type WatchLog } from '../../../src/core/impact.ts';
import type { PlaybookEntry } from '../../../src/core/playbook.ts';
import { readLocal, writeLocal } from './storage.ts';

export type SkillKind =
  | 'accept'
  | 'compare'
  | 'share'
  | 'drill'
  | 'rule'
  | 'click-filter'
  | 'ignore'
  | 'clean'
  | 'link'
  | 'qlik'
  | 'kit'
  | 'answer'
  | 'away'
  | 'review'
  | 'drill-path'
  | 'fly'
  | 'csv'
  | 'draft'
  | 'experiment'
  | 'lineage';

export type WatchKind = 'accept' | 'refresh' | 'answer' | 'review';

export interface SkillRef {
  hoistId?: string;
  flagId?: string;
}

export interface Earned extends SkillRef {
  at: string;
}

export interface SignalBookData {
  version: 1;
  earned: Partial<Record<SkillKind, Earned>>;
  /** Opt-in: keep a copy in the Semaphore folder (team/signalbook-<user>) so it survives a browser reset. */
  mirror?: boolean;
}

const BOOK_KEY = 'semaphore.signalBook';
const WATCH_KEY = 'semaphore.watchLog';
const WATCH_HIDDEN_KEY = 'semaphore.watchLogHidden';
const EXAMPLE_HOIST = 'fleet-maintenance';
const KINDS: readonly SkillKind[] = ['accept', 'compare', 'share', 'drill', 'rule', 'click-filter', 'ignore', 'clean', 'link', 'qlik', 'kit', 'answer', 'away', 'review', 'drill-path', 'fly', 'csv', 'draft', 'experiment', 'lineage'];

// ---------------------------------------------------------------------------------------------
// Switch, store and listeners

let enabled = true;
let version = 0;
const listeners = new Set<() => void>();
let mirrorWriter: ((book: SignalBookData) => void) | null = null;

function changed(): void {
  version++;
  for (const l of listeners) l();
}

/** settings.json "signalBook" (lib/playbook.ts passes it on). Off: every record call does nothing. */
export function configureSkills(opts: { enabled: boolean }): void {
  if (enabled === opts.enabled) return;
  enabled = opts.enabled;
  changed();
}

export function skillsEnabled(): boolean {
  return enabled;
}

/** Where the opt-in copy goes (lib/playbook.ts sets it when there is a server). */
export function setSkillMirror(write: ((book: SignalBookData) => void) | null): void {
  mirrorWriter = write;
}

function emptyBook(): SignalBookData {
  return { version: 1, earned: {} };
}

export function readSignalBook(): SignalBookData {
  const raw = readLocal<SignalBookData>(BOOK_KEY);
  if (!raw || raw.version !== 1 || typeof raw.earned !== 'object' || raw.earned === null) return emptyBook();
  const earned: SignalBookData['earned'] = {};
  for (const k of KINDS) {
    const e = (raw.earned as Record<string, unknown>)[k] as Earned | undefined;
    if (e && typeof e.at === 'string') earned[k] = { at: e.at, ...(typeof e.hoistId === 'string' ? { hoistId: e.hoistId } : {}), ...(typeof e.flagId === 'string' ? { flagId: e.flagId } : {}) };
  }
  return { version: 1, earned, ...(raw.mirror ? { mirror: true } : {}) };
}

function writeBook(book: SignalBookData): boolean {
  const ok = writeLocal(BOOK_KEY, book);
  if (ok && book.mirror && mirrorWriter) {
    try {
      mirrorWriter(book);
    } catch {
      /* the copy is a convenience; the book itself is saved */
    }
  }
  changed();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Recording

/** The first use of a capability earns its flag. Returns true only when it was newly earned. */
export function recordSkill(kind: SkillKind, ref?: SkillRef): boolean {
  if (!enabled || !KINDS.includes(kind)) return false;
  try {
    const book = readSignalBook();
    if (book.earned[kind]) return false;
    book.earned[kind] = { at: new Date().toISOString(), ...(ref?.hoistId ? { hoistId: ref.hoistId.slice(0, 64) } : {}), ...(ref?.flagId ? { flagId: ref.flagId.slice(0, 64) } : {}) };
    return writeBook(book);
  } catch {
    return false;
  }
}

/** What an accepted flag shows that is worth a flag of its own. */
export function skillsInFlag(flag: Flag): SkillKind[] {
  const out: SkillKind[] = [];
  if (flag.status !== 'ready') return out;
  out.push('accept');
  if (flag.binding?.compare) out.push('compare');
  if (flag.binding?.share) out.push('share');
  if (flag.behavior.onClick === 'drill') out.push('drill');
  if (flag.behavior.onClick === 'filter-page') out.push('click-filter');
  if (flag.behavior.thresholds.some((t) => t.tone === 'bad' || t.tone === 'warn')) out.push('rule');
  if (flag.behavior.ignore.length) out.push('ignore');
  return out;
}

/** For the accept path: the accept flag plus whatever the accepted flag uses. */
export function recordFlagSkills(flag: Flag, hoistId: string): SkillKind[] {
  return skillsInFlag(flag).filter((k) => recordSkill(k, { hoistId, flagId: flag.id }));
}

/** A meaningful act this week: the week's watch is stood. */
export function recordWatch(kind: WatchKind): void {
  void kind; // every kind stands the watch; the kind is for callers' readability
  if (!enabled) return;
  try {
    if (writeLocal(WATCH_KEY, trimWatchLog(markStood(readWatchLog())))) changed();
  } catch {
    /* storage unavailable: nothing to do */
  }
}

/** An away notice excuses its weeks (never overwriting a week already stood). */
export function noteAway(n: Pick<AwayNotice, 'from' | 'until'>): void {
  if (!enabled) return;
  try {
    const log = readWatchLog();
    const next = markAway(log, awayWeeks(n));
    if (JSON.stringify(next) !== JSON.stringify(log) && writeLocal(WATCH_KEY, next)) changed();
  } catch {
    /* storage unavailable */
  }
}

export function readWatchLog(): WatchLog {
  const raw = readLocal<WatchLog>(WATCH_KEY);
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).filter(([w, v]) => /^\d{4}-W\d{2}$/.test(w) && (v === 'stood' || v === 'away')));
}

export function watchLogHidden(): boolean {
  return readLocal<boolean>(WATCH_HIDDEN_KEY) === true;
}

export function setWatchLogHidden(hidden: boolean): void {
  writeLocal(WATCH_HIDDEN_KEY, hidden);
  changed();
}

export function setMirror(on: boolean): void {
  const book = readSignalBook();
  if (on) book.mirror = true;
  else delete book.mirror;
  writeBook(book);
}

/** Merge a copy read back from the Semaphore folder: the earliest date wins for each flag. */
export function mergeMirror(earned: unknown): void {
  if (!earned || typeof earned !== 'object') return;
  const book = readSignalBook();
  let any = false;
  for (const k of KINDS) {
    const e = (earned as Record<string, Earned | undefined>)[k];
    if (!e || typeof e.at !== 'string') continue;
    const mine = book.earned[k];
    if (!mine || e.at < mine.at) {
      book.earned[k] = { at: e.at, ...(typeof e.hoistId === 'string' ? { hoistId: e.hoistId } : {}), ...(typeof e.flagId === 'string' ? { flagId: e.flagId } : {}) };
      any = true;
    }
  }
  if (any) writeLocal(BOOK_KEY, book) && changed();
}

/**
 * Work already done counts: accepted flags on the open page (an experiment page too), the
 * analyst's own playbook entries, and the catalog's accepted fixes, links and drill paths.
 */
export function scanForSkills(hoist: Hoist, entries: readonly PlaybookEntry[], catalog: Catalog, user: string): void {
  if (!enabled) return;
  // The example page arrives with accepted flags nobody here built: it is not scanned.
  if (hoist.id !== EXAMPLE_HOIST) for (const f of hoist.flags) for (const k of skillsInFlag(f)) recordSkill(k, { hoistId: hoist.id, flagId: f.id });
  if (hoist.experiment && hoist.id !== EXAMPLE_HOIST && hoist.flags.length) recordSkill('experiment', { hoistId: hoist.id });
  for (const e of entries) {
    if (e.acceptedBy !== user || e.hoist.id === EXAMPLE_HOIST) continue;
    recordSkill('accept', { hoistId: e.hoist.id });
    if (e.binding.compare) recordSkill('compare', { hoistId: e.hoist.id });
    if (e.binding.share) recordSkill('share', { hoistId: e.hoist.id });
    if (e.thresholds.some((t) => t.tone !== 'good')) recordSkill('rule', { hoistId: e.hoist.id });
  }
  const steps = catalog.cleaning ?? [];
  if (steps.some((s) => s.origin !== 'qlik')) recordSkill('clean');
  if (steps.some((s) => s.origin === 'qlik')) recordSkill('qlik');
  if ((catalog.relationships ?? []).some((r) => r.origin === 'analyst')) recordSkill('link');
  if ((catalog.hierarchies ?? []).length) recordSkill('drill-path');
  if (catalog.sources.some((s) => s.kind === 'csv')) recordSkill('csv');
}

// ---------------------------------------------------------------------------------------------
// Hand-offs between panels: the Signal Book's "Try it" can open the Data panel on a given tab.

export type DataTab = 'sources' | 'measures' | 'fields' | 'clean' | 'relationships';
let pendingDataTab: DataTab | null = null;

export function requestDataTab(tab: DataTab): void {
  pendingDataTab = tab;
}

/** The tab the Data panel should open on, once. */
export function takeDataTab(): DataTab | null {
  const t = pendingDataTab;
  pendingDataTab = null;
  return t;
}

// ---------------------------------------------------------------------------------------------
// The Signal Book's flags (components/SignalBook.tsx draws them)

export type How = { kind: 'panel'; panel: 'data' | 'qlik' | 'kits' | 'lineage' | 'playbook' | 'away'; tab?: DataTab; where: string } | { kind: 'brief'; brief: string } | { kind: 'tip'; text: string };

export interface Signal {
  letter: string;
  name: string;
  kind: SkillKind;
  title: string;
  how: string;
  try: (h: Hints) => How;
}

export interface Hints {
  m: string;
  f: string;
}

// The international code of signals' phonetic alphabet, A to T; each flag stands for one capability.
export const SIGNALS: readonly Signal[] = [
  { letter: 'A', name: 'Alfa', kind: 'accept', title: 'First accepted flag', how: 'Draft a flag from a brief, check what it shows, then press Accept.', try: (h) => ({ kind: 'brief', brief: `${h.m} by ${h.f}` }) },
  { letter: 'B', name: 'Bravo', kind: 'compare', title: 'A comparison', how: 'Ask for "vs last year" or "compared with the previous month" in a brief, and accept the flag.', try: (h) => ({ kind: 'brief', brief: `${h.m} by ${h.f}, last 12 months vs last year` }) },
  { letter: 'C', name: 'Charlie', kind: 'share', title: 'A share of the total', how: 'Ask for "% of total" in a brief, and accept the flag.', try: (h) => ({ kind: 'brief', brief: `${h.m} by ${h.f} as % of total` }) },
  { letter: 'D', name: 'Delta', kind: 'drill', title: 'A drill flag', how: 'Say "clicking a bar drills down" in a brief, and accept the flag.', try: (h) => ({ kind: 'brief', brief: `${h.m} by ${h.f}. Clicking a bar drills down` }) },
  { letter: 'E', name: 'Echo', kind: 'rule', title: 'A red or amber rule', how: 'Add a colour rule such as "turn red over 5,000", and accept the flag.', try: (h) => ({ kind: 'brief', brief: `Total ${h.m.toLowerCase()}. Turn red over 5,000` }) },
  { letter: 'F', name: 'Foxtrot', kind: 'click-filter', title: 'A click-to-filter flag', how: 'Say "clicking a bar filters the page", and accept the flag.', try: (h) => ({ kind: 'brief', brief: `${h.m} by ${h.f}. Clicking a bar filters the page` }) },
  { letter: 'G', name: 'Golf', kind: 'ignore', title: 'An ignore rule', how: 'Tell a flag to "ignore the … filter" so it keeps the whole picture, and accept it.', try: (h) => ({ kind: 'brief', brief: `${h.m} per month. Ignore the ${h.f.toLowerCase()} filter` }) },
  { letter: 'H', name: 'Hotel', kind: 'clean', title: 'A cleaning fix', how: 'Check a table for messy values and accept one of the fixes Semaphore proposes.', try: () => ({ kind: 'panel', panel: 'data', tab: 'clean', where: 'Data, Clean' }) },
  { letter: 'I', name: 'India', kind: 'link', title: 'A link between tables', how: 'Find and confirm how two tables join, in Data, Links.', try: () => ({ kind: 'panel', panel: 'data', tab: 'relationships', where: 'Data, Links' }) },
  { letter: 'J', name: 'Juliett', kind: 'qlik', title: 'A Qlik import', how: 'Paste a Qlik load script and bring its tables and measures across.', try: () => ({ kind: 'panel', panel: 'qlik', where: 'Import from Qlik' }) },
  { letter: 'K', name: 'Kilo', kind: 'kit', title: 'A kit saved', how: 'Save flags you reuse as a kit, so you can fly them on any page.', try: () => ({ kind: 'panel', panel: 'kits', where: 'Flag kits' }) },
  { letter: 'L', name: 'Lima', kind: 'answer', title: 'A leadership question answered', how: 'Build the answer to a waiting question and accept it. The asker is told.', try: () => ({ kind: 'panel', panel: 'playbook', where: 'Playbook, Questions' }) },
  { letter: 'M', name: 'Mike', kind: 'away', title: 'An away notice', how: 'Before leave, mark yourself away so leadership knows and new questions wait for you.', try: () => ({ kind: 'panel', panel: 'away', where: 'Playbook, Away' }) },
  { letter: 'N', name: 'November', kind: 'review', title: 'An answer kept current', how: 'When an answer needs review, check it and press "Still right".', try: () => ({ kind: 'panel', panel: 'playbook', where: 'Playbook, Answers' }) },
  { letter: 'O', name: 'Oscar', kind: 'drill-path', title: 'A drill path', how: 'Set the levels a drill walks through, such as region, then ship, in Data, Links.', try: () => ({ kind: 'panel', panel: 'data', tab: 'relationships', where: 'Data, Links' }) },
  { letter: 'P', name: 'Papa', kind: 'fly', title: 'A kit flown', how: 'Fly a saved kit on a page: Semaphore wires each flag to the closest match.', try: () => ({ kind: 'panel', panel: 'kits', where: 'Flag kits' }) },
  { letter: 'Q', name: 'Quebec', kind: 'csv', title: 'Your own data', how: 'Add a CSV file or a Fleet export. It is read in this page and never uploaded.', try: () => ({ kind: 'panel', panel: 'data', tab: 'sources', where: 'Data, Sources' }) },
  { letter: 'R', name: 'Romeo', kind: 'draft', title: 'A flag drafted from a brief', how: 'Describe a flag in plain English and let Semaphore draft it.', try: (h) => ({ kind: 'brief', brief: `${h.m} per month, last 12 months` }) },
  { letter: 'S', name: 'Sierra', kind: 'experiment', title: 'A practice page', how: 'Press "Try freely" beside the page title and build anything. Nothing there goes into the playbook.', try: () => ({ kind: 'tip', text: 'Press "Try freely" beside the page title, then add a flag or two. Practice counts here too.' }) },
  { letter: 'T', name: 'Tango', kind: 'lineage', title: 'Lineage traced', how: 'Open Lineage from the Data panel to see where every number comes from.', try: () => ({ kind: 'panel', panel: 'lineage', where: 'Lineage' }) },
];

// ---------------------------------------------------------------------------------------------
// Reading, for the panels

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Re-renders when the book or the watch log changes; returns a counter to key memos on. */
export function useSkillsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

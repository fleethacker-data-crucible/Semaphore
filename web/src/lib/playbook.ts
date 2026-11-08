// The playbook, snapshots and question queue as the page sees them. With a server they live in
// the shared Semaphore folder (one file each, so two people saving different entries never
// overwrite each other); without one, in this browser's localStorage.
//
// Also the team notes that make the loop visible (src/core/impact.ts): each person's weekly ask
// counts and "Bravo Zulu" marks, one file per person per week, and the deployment's switches for
// those features (settings.json, passed on by the server as /api/info "social").

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AwayNotice, isAwayNotice } from '../../../src/core/away.ts';
import { type Edition, isEdition, isReportSchedule, isUsageLog, type ReportSchedule, type UsageLog } from '../../../src/core/reports.ts';
import { type AskLog, addBz, type BzLog, bumpAsk, expiredIds, isAskLog, isBzLog, withUses } from '../../../src/core/impact.ts';
import { isEntry, isQuestion, type PlaybookEntry, type QuestionItem, withAskers } from '../../../src/core/playbook.ts';
import { emptyOverrides, isStyleOverrides, type StyleOverrides } from '../../../src/core/style.ts';
import { isSnapshot, type Snapshot } from '../../../src/core/snapshot.ts';
import { api, type ServerInfo } from './api.ts';
import { readLocal, writeLocal } from './storage.ts';
import { usePersonalFeatures, withPersonal } from './features.ts';
import { configureSkills, mergeMirror, noteAway, recordSkill, recordWatch, setSkillMirror } from './skills.ts';

/**
 * The deployment's switches for the social and motivational features (settings.json). Each is on
 * unless the deployment turns it off; in browser-only mode there are no settings, so all are on.
 */
export interface SocialSettings {
  /** The private Signal Book and watch log. */
  signalBook: boolean;
  /** "Your flags answered N questions this week" and the answer sparklines. */
  impact: boolean;
  /** The playbook's "This week" tab. */
  teamLog: boolean;
  /** Askers' names beside leadership questions; off shows only how many asked. */
  showAskers: boolean;
  /** "BZ: this helped" on reviewed answers. */
  bz: boolean;
}

export const SOCIAL_DEFAULTS: SocialSettings = { signalBook: true, impact: true, teamLog: true, showAskers: true, bz: true };

export function socialSettings(raw: unknown): SocialSettings {
  const out = { ...SOCIAL_DEFAULTS };
  if (raw && typeof raw === 'object') for (const k of Object.keys(out) as Array<keyof SocialSettings>) if ((raw as Record<string, unknown>)[k] === false) out[k] = false;
  return out;
}

const mirrorId = (user: string) => `signalbook-${user.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 64);

type Kind = 'playbook' | 'snapshots' | 'questions' | 'team';
type Doc = { id: string };

const localKey = (kind: Kind) => `semaphore.${kind}`;

function localAll<T>(kind: Kind): T[] {
  return Object.values(readLocal<Record<string, T>>(localKey(kind)) ?? {});
}

function localRemove(kind: Kind, id: string): void {
  const all = readLocal<Record<string, Doc>>(localKey(kind)) ?? {};
  delete all[id];
  writeLocal(localKey(kind), all);
}

function localPut(kind: Kind, doc: Doc): void {
  const all = readLocal<Record<string, Doc>>(localKey(kind)) ?? {};
  all[doc.id] = doc;
  writeLocal(localKey(kind), all);
}

/**
 * The documents that pass their guard. A file someone edited by hand or that was cut short is
 * dropped with a console warning naming it, so one bad file never takes the page down.
 */
export function keepValid<T>(docs: readonly unknown[], what: string, ok: (raw: unknown) => raw is T): T[] {
  const out: T[] = [];
  for (const d of docs) {
    if (ok(d)) out.push(d);
    else {
      const id = d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string' ? ` "${(d as { id: string }).id.slice(0, 64)}"` : '';
      console.warn(`Semaphore: skipped a ${what}${id} in the shared folder that is not in the expected shape.`);
    }
  }
  return out;
}

async function serverAll(kind: Kind): Promise<unknown[]> {
  if (kind !== 'snapshots') return api<unknown[]>(`/api/${kind}?full=1`);
  const list = await api<Array<{ id: string }>>('/api/snapshots');
  const out: unknown[] = [];
  for (const item of list) {
    try {
      out.push(await api<unknown>(`/api/snapshots/${encodeURIComponent(item.id)}`));
    } catch {
      /* an unreadable snapshot is skipped; it is taken again on the next refresh */
    }
  }
  return out;
}

export interface PlaybookState {
  entries: PlaybookEntry[];
  questions: QuestionItem[];
  snapshots: Snapshot[];
  loaded: boolean;
  /** Where it is kept, for the UI to say. */
  where: 'shared folder' | 'this browser';
  saveEntries: (list: PlaybookEntry[]) => Promise<void>;
  saveQuestion: (q: QuestionItem) => Promise<void>;
  saveSnapshot: (s: Snapshot) => Promise<void>;
  /** The team style card's overrides (team/style): what analysts switched off or pinned. */
  styleOverrides: StyleOverrides;
  saveStyleOverrides: (o: StyleOverrides) => Promise<void>;
  /** Away notices, one per analyst (team/away-<user>). */
  away: AwayNotice[];
  saveAway: (n: AwayNotice) => Promise<void>;
  removeAway: (id: string) => Promise<void>;
  /** Recurring reports (src/core/reports.ts): usage logs, accepted schedules and editions. */
  usage: UsageLog[];
  schedules: ReportSchedule[];
  editions: Edition[];
  saveReportDoc: (doc: UsageLog | ReportSchedule | Edition) => Promise<void>;
  removeReportDoc: (id: string) => Promise<void>;
  /** What is on for this person: the deployment's switches, less their own (lib/features.ts). */
  social: SocialSettings;
  /** The deployment's switches alone (settings.json via /api/info "social"). */
  deployment: SocialSettings;
  /** Weekly ask counts and BZ marks, everyone's (src/core/impact.ts). */
  asks: AskLog[];
  bz: BzLog[];
  /** A reviewed answer was shown to this person: one more in their own file for this week. */
  recordAsk: (entryId: string) => void;
  /** "BZ: this helped". False when they already said it this week, or BZ is off. */
  giveBz: (entryId: string) => Promise<boolean>;
  reload: () => void;
}

export function usePlaybook(server: ServerInfo | null, serverChecked: boolean): PlaybookState {
  const user = server?.user || 'analyst';
  const socialRaw = (server as (ServerInfo & { social?: unknown }) | null)?.social;
  const deployment = useMemo(() => socialSettings(socialRaw), [JSON.stringify(socialRaw ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
  const personal = usePersonalFeatures();
  const social = useMemo(() => withPersonal(deployment, personal), [deployment, personal]);
  const [stored, setEntries] = useState<PlaybookEntry[]>([]);
  const [asks, setAsks] = useState<AskLog[]>([]);
  const [bz, setBz] = useState<BzLog[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [styleOverrides, setStyleOverrides] = useState<StyleOverrides>(emptyOverrides);
  const [away, setAway] = useState<AwayNotice[]>([]);
  const [usage, setUsage] = useState<UsageLog[]>([]);
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Read synchronously by the save paths, so two quick saves never work from a stale list.
  const questionsRef = useRef<QuestionItem[]>([]);
  const asksRef = useRef<AskLog[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!serverChecked) return;
    let live = true;
    const load = async (kind: Kind): Promise<unknown[]> => (server ? serverAll(kind).catch((): unknown[] => []) : localAll<unknown>(kind));
    Promise.all([load('playbook'), load('questions'), load('snapshots'), load('team')]).then(([e, q, s, t]) => {
      if (!live) return;
      setStyleOverrides(t.find((x): x is StyleOverrides => isStyleOverrides(x)) ?? emptyOverrides());
      const notices = t.filter((x): x is AwayNotice => isAwayNotice(x));
      setAway(notices);
      const askLogs = t.filter((x): x is AskLog => isAskLog(x));
      const bzLogs = t.filter((x): x is BzLog => isBzLog(x));
      setAsks(askLogs);
      asksRef.current = askLogs;
      setBz(bzLogs);
      const mine = notices.find((n) => n.analyst === user);
      if (mine) noteAway(mine);
      const copy = t.find((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === mirrorId(user)) as { earned?: unknown } | undefined;
      if (copy) mergeMirror(copy.earned);
      // This person's weekly files older than KEEP_WEEKS go (moved to .trash with a server).
      for (const id of expiredIds([...askLogs, ...bzLogs], user)) {
        if (server) void api(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
        else localRemove('team', id);
      }
      setUsage(t.filter((x): x is UsageLog => isUsageLog(x)));
      setSchedules(t.filter((x): x is ReportSchedule => isReportSchedule(x)));
      setEditions(t.filter((x): x is Edition => isEdition(x)));
      setEntries(keepValid(e, 'playbook entry', isEntry));
      questionsRef.current = keepValid(q, 'question', isQuestion).map(withAskers);
      setQuestions(questionsRef.current);
      setSnapshots(keepValid(s, 'snapshot', isSnapshot));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [server, serverChecked, tick]);

  useEffect(() => configureSkills({ enabled: social.signalBook }), [social.signalBook]);

  const put = useCallback(
    async (kind: Kind, doc: Doc) => {
      if (server) await api(`/api/${kind}/${encodeURIComponent(doc.id)}`, { method: 'PUT', json: doc });
      else localPut(kind, doc);
    },
    [server],
  );

  const saveEntries = useCallback(
    async (list: PlaybookEntry[]) => {
      if (!list.length) return;
      for (const e of list) await put('playbook', e);
      setEntries((all) => {
        const map = new Map(all.map((e) => [e.id, e]));
        for (const e of list) map.set(e.id, e);
        return [...map.values()];
      });
    },
    [put],
  );

  const saveQuestion = useCallback(
    async (q: QuestionItem) => {
      await put('questions', q);
      const answered = q.status === 'answered' && questionsRef.current.some((x) => x.id === q.id && x.status === 'open');
      questionsRef.current = [...questionsRef.current.filter((x) => x.id !== q.id), q];
      setQuestions(questionsRef.current);
      // An analyst's accepted flag answered a leadership question (app.tsx resolveQuestions).
      if (answered) {
        recordSkill('answer');
        recordWatch('answer');
      }
    },
    [put],
  );

  const saveSnapshot = useCallback(
    async (s: Snapshot) => {
      try {
        await put('snapshots', s);
      } catch {
        /* too large for the folder or this browser: it is still used in this session */
      }
      setSnapshots((all) => [...all.filter((x) => x.id !== s.id), s]);
    },
    [put],
  );

  const saveStyleOverrides = useCallback(
    async (o: StyleOverrides) => {
      await put('team', o);
      setStyleOverrides(o);
    },
    [put],
  );

  const saveAway = useCallback(
    async (n: AwayNotice) => {
      await put('team', n);
      if (n.analyst === user && !n.back) {
        recordSkill('away');
        noteAway(n);
      }
      setAway((all) => [...all.filter((x) => x.id !== n.id), n]);
    },
    [put, user],
  );

  const removeAway = useCallback(
    async (id: string) => {
      if (server) await api(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
      else localRemove('team', id);
      setAway((all) => all.filter((x) => x.id !== id));
    },
    [server],
  );

  const saveReportDoc = useCallback(
    async (doc: UsageLog | ReportSchedule | Edition) => {
      await put('team', doc);
      const swap = <T extends { id: string }>(all: T[], d: T) => [...all.filter((x) => x.id !== d.id), d];
      if (doc.kind === 'usage') setUsage((all) => swap(all, doc));
      else if (doc.kind === 'report') setSchedules((all) => swap(all, doc));
      else setEditions((all) => swap(all, doc));
    },
    [put],
  );

  const removeReportDoc = useCallback(
    async (id: string) => {
      if (server) await api(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
      else localRemove('team', id);
      setSchedules((all) => all.filter((x) => x.id !== id));
      setEditions((all) => all.filter((x) => x.id !== id));
      setUsage((all) => all.filter((x) => x.id !== id));
    },
    [server],
  );

  // The opt-in Signal Book copy goes to the Semaphore folder; without a server there is nowhere to put it.
  useEffect(() => {
    if (!server) return;
    setSkillMirror((book) => {
      const copy: Doc & Record<string, unknown> = { version: 1, kind: 'signalbook', id: mirrorId(user), user, earned: book.earned, updated: new Date().toISOString() };
      void put('team', copy).catch(() => undefined);
    });
    return () => setSkillMirror(null);
  }, [server, put, user]);

  const recordAsk = useCallback(
    (entryId: string) => {
      if (!social.impact) return; // Off means off: no named record of which answers this person viewed.
      const log = bumpAsk(asksRef.current, user, entryId);
      asksRef.current = [...asksRef.current.filter((l) => l.id !== log.id), log];
      setAsks(asksRef.current);
      void put('team', log).catch(() => undefined);
    },
    [put, user, social.impact],
  );

  const giveBz = useCallback(
    async (entryId: string) => {
      if (!social.bz) return false;
      const log = addBz(bz, user, entryId);
      if (!log) return false;
      await put('team', log);
      setBz((all) => [...all.filter((l) => l.id !== log.id), log]);
      return true;
    },
    [put, user, bz, social.bz],
  );

  const entries = useMemo(() => withUses(stored, asks), [stored, asks]);

  return {
    social, deployment, asks, bz, recordAsk, giveBz,
    entries, questions, snapshots, loaded, where: server ? 'shared folder' : 'this browser',
    saveEntries, saveQuestion, saveSnapshot, styleOverrides, saveStyleOverrides, away, saveAway, removeAway,
    usage, schedules, editions, saveReportDoc, removeReportDoc,
    reload: () => setTick((t) => t + 1),
  };
}

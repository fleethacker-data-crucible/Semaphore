// The playbook, snapshots and question queue as the page sees them. With a server they live in
// the shared Semaphore folder (one file each, so two people saving different entries never
// overwrite each other); without one, in this browser's localStorage.

import { useCallback, useEffect, useState } from 'react';
import { type AwayNotice, isAwayNotice } from '../../../src/core/away.ts';
import { type Edition, isEdition, isReportSchedule, isUsageLog, type ReportSchedule, type UsageLog } from '../../../src/core/reports.ts';
import { isEntry, isQuestion, type PlaybookEntry, type QuestionItem } from '../../../src/core/playbook.ts';
import { emptyOverrides, isStyleOverrides, type StyleOverrides } from '../../../src/core/style.ts';
import { isSnapshot, type Snapshot } from '../../../src/core/snapshot.ts';
import { api, type ServerInfo } from './api.ts';
import { readLocal, writeLocal } from './storage.ts';

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
  reload: () => void;
}

export function usePlaybook(server: ServerInfo | null, serverChecked: boolean): PlaybookState {
  const [entries, setEntries] = useState<PlaybookEntry[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [styleOverrides, setStyleOverrides] = useState<StyleOverrides>(emptyOverrides);
  const [away, setAway] = useState<AwayNotice[]>([]);
  const [usage, setUsage] = useState<UsageLog[]>([]);
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!serverChecked) return;
    let live = true;
    const load = async (kind: Kind): Promise<unknown[]> => (server ? serverAll(kind).catch((): unknown[] => []) : localAll<unknown>(kind));
    Promise.all([load('playbook'), load('questions'), load('snapshots'), load('team')]).then(([e, q, s, t]) => {
      if (!live) return;
      setStyleOverrides(t.find((x): x is StyleOverrides => isStyleOverrides(x)) ?? emptyOverrides());
      setAway(t.filter((x): x is AwayNotice => isAwayNotice(x)));
      setUsage(t.filter((x): x is UsageLog => isUsageLog(x)));
      setSchedules(t.filter((x): x is ReportSchedule => isReportSchedule(x)));
      setEditions(t.filter((x): x is Edition => isEdition(x)));
      setEntries(e.filter((x): x is PlaybookEntry => isEntry(x)));
      setQuestions(q.filter((x): x is QuestionItem => isQuestion(x)));
      setSnapshots(s.filter((x): x is Snapshot => isSnapshot(x)));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [server, serverChecked, tick]);

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
      setQuestions((all) => [...all.filter((x) => x.id !== q.id), q]);
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
      setAway((all) => [...all.filter((x) => x.id !== n.id), n]);
    },
    [put],
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

  return {
    entries, questions, snapshots, loaded, where: server ? 'shared folder' : 'this browser',
    saveEntries, saveQuestion, saveSnapshot, styleOverrides, saveStyleOverrides, away, saveAway, removeAway,
    usage, schedules, editions, saveReportDoc, removeReportDoc,
    reload: () => setTick((t) => t + 1),
  };
}

// The playbook, snapshots and question queue as the page sees them. With a server they live in
// the shared Semaphore folder (one file each, so two people saving different entries never
// overwrite each other); without one, in this browser's localStorage.

import { useCallback, useEffect, useState } from 'react';
import { isEntry, isQuestion, type PlaybookEntry, type QuestionItem } from '../../../src/core/playbook.ts';
import { isSnapshot, type Snapshot } from '../../../src/core/snapshot.ts';
import { api, type ServerInfo } from './api.ts';
import { readLocal, writeLocal } from './storage.ts';

type Kind = 'playbook' | 'snapshots' | 'questions';
type Doc = { id: string };

const localKey = (kind: Kind) => `semaphore.${kind}`;

function localAll<T>(kind: Kind): T[] {
  return Object.values(readLocal<Record<string, T>>(localKey(kind)) ?? {});
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
  reload: () => void;
}

export function usePlaybook(server: ServerInfo | null, serverChecked: boolean): PlaybookState {
  const [entries, setEntries] = useState<PlaybookEntry[]>([]);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!serverChecked) return;
    let live = true;
    const load = async (kind: Kind): Promise<unknown[]> => (server ? serverAll(kind).catch((): unknown[] => []) : localAll<unknown>(kind));
    Promise.all([load('playbook'), load('questions'), load('snapshots')]).then(([e, q, s]) => {
      if (!live) return;
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

  return { entries, questions, snapshots, loaded, where: server ? 'shared folder' : 'this browser', saveEntries, saveQuestion, saveSnapshot, reload: () => setTick((t) => t + 1) };
}

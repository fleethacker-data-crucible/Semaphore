// Flag kits as the page keeps them (src/core/kits.ts). A kit is one small JSON document with
// "version": 1, so it rides the server's existing "team" folder (one file each, atomic writes,
// deletes move to .trash) and needs no new route. Without a server it lives in this browser's
// localStorage, in the same place the playbook keeps team notes. Either way an unreadable or
// invalid kit is skipped, never trusted.

import { useCallback, useEffect, useState } from 'react';
import { isKitDocument, type Kit, KIT_LIMITS, parseKit } from '../../../src/core/kits.ts';
import { api, type ServerInfo } from './api.ts';
import { readLocal, writeLocal } from './storage.ts';

const LOCAL_KEY = 'semaphore.team';

export interface KitStore {
  kits: Kit[];
  loaded: boolean;
  /** Where they are kept, for the UI to say. */
  where: 'shared folder' | 'this browser';
  save: (kit: Kit) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

function localDocs(): Record<string, unknown> {
  return readLocal<Record<string, unknown>>(LOCAL_KEY) ?? {};
}

function toKits(docs: unknown[]): Kit[] {
  return docs
    .filter(isKitDocument)
    .map((d) => parseKit(d).kit)
    .filter((k): k is Kit => k !== null)
    .sort((a, b) => b.created.localeCompare(a.created));
}

export function useKits(server: ServerInfo | null, serverChecked: boolean): KitStore {
  const [kits, setKits] = useState<Kit[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!serverChecked) return;
    let live = true;
    const read = server ? api<unknown[]>('/api/team?full=1').catch((): unknown[] => []) : Promise.resolve(Object.values(localDocs()));
    read.then((docs) => {
      if (!live) return;
      setKits(toKits(docs));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [server, serverChecked]);

  const save = useCallback(
    async (kit: Kit) => {
      if (!kits.some((k) => k.id === kit.id) && kits.length >= KIT_LIMITS.stored) throw new Error(`Semaphore keeps at most ${KIT_LIMITS.stored} kits. Delete one first.`);
      if (server) await api(`/api/team/${encodeURIComponent(kit.id)}`, { method: 'PUT', json: kit });
      else if (!writeLocal(LOCAL_KEY, { ...localDocs(), [kit.id]: kit })) throw new Error('This browser would not store the kit (storage is blocked or full). Export it to a file instead.');
      setKits((all) => [kit, ...all.filter((k) => k.id !== kit.id)].sort((a, b) => b.created.localeCompare(a.created)));
    },
    [server, kits],
  );

  const remove = useCallback(
    async (id: string) => {
      if (server) await api(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else {
        const all = localDocs();
        delete all[id];
        writeLocal(LOCAL_KEY, all);
      }
      setKits((all) => all.filter((k) => k.id !== id));
    },
    [server],
  );

  return { kits, loaded, where: server ? 'shared folder' : 'this browser', save, remove };
}

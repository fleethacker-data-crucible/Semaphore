// Saving (#85, #88, #91). The hoist is always kept in this browser; with a server it is also saved
// to the Semaphore folder 1.2 s after the last change. A pending save is sent at once, never
// dropped, when another hoist replaces this one, before End session, and when the page goes away.
// Every save checks the size first (the folder takes 2 MB a document) and sends the version it
// replaces (If-Match); a 409 `version` becomes a persistent choice (components/ConflictBar.tsx)
// instead of a silent overwrite. Another tab writing the working copy is noticed through the
// `storage` event and offered as a reload.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, CatalogIndex } from '../../../src/core/catalog.ts';
import { type Hoist, LIMITS, oversize, parseHoist } from '../../../src/core/hoist.ts';
import { api, type DocKind, describeError, isVersionConflict, loadItem, rememberEtag, saveItem, type ServerInfo } from '../lib/api.ts';
import { notify } from '../lib/toasts.ts';
import { writeLocal } from '../lib/storage.ts';
import type { SaveConflict, TabChange } from '../components/ConflictBar.tsx';

const SAVE_DELAY_MS = 1200;
/** Browsers refuse keepalive bodies over 64 KB; a bigger save on pagehide goes as a normal request. */
const KEEPALIVE_MAX = 60_000;

interface Conflict extends SaveConflict {
  id: string;
  /** The folder's version now, from the 409. */
  etag?: string;
  /** What this page tried to save. */
  mine: Hoist | Catalog;
}

export interface PersistenceOptions {
  hoist: Hoist;
  /** The server's info while it answers; null in browser-only mode. */
  server: ServerInfo | null;
  /** The session is up (not offline): a save that failed for the network is sent again then. */
  online: boolean;
  index: CatalogIndex;
  hoistKey: string;
  newId: (prefix: string) => string;
  /** Replace the page's hoist (Load theirs, Save mine as a copy, Reload from another tab). */
  onLoadHoist: (h: Hoist) => void;
  onLoadCatalog: (c: Catalog) => void;
}

export interface Persistence {
  flushSave: (keepalive?: boolean) => Promise<void>;
  saveCatalog: (c: Catalog) => void;
  conflict: SaveConflict | null;
  resolveConflict: (choice: 'theirs' | 'copy' | 'overwrite') => void;
  tabChange: TabChange | null;
  resolveTabChange: (choice: 'reload' | 'keep') => void;
}

export function usePersistence(o: PersistenceOptions): Persistence {
  const { hoist, server, online, hoistKey } = o;
  const latest = useRef(o);
  latest.current = o;
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<Hoist | null>(null);
  // What the folder holds for each id as far as this page knows, so an unchanged hoist is not sent again.
  const lastSaved = useRef(new Map<string, string>());
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const conflictRef = useRef<Conflict | null>(null);
  conflictRef.current = conflict;
  const [tabChange, setTabChange] = useState<(TabChange & { raw: unknown }) | null>(null);

  const onConflict = useCallback((kind: DocKind, id: string, mine: Hoist | Catalog, etag: string | undefined) => {
    const title = kind === 'hoists' ? (mine as Hoist).title : 'the catalog';
    const c: Conflict = { kind, id, title, mine, ...(etag ? { etag } : {}) };
    setConflict(c);
    // When theirs was saved, if the folder's copy says (read without taking its version).
    api<{ updated?: unknown }>(`/api/${kind}/${encodeURIComponent(id)}`, { quiet: true }).then(
      (d) => typeof d?.updated === 'string' && setConflict((x) => (x && x.id === id && x.kind === kind ? { ...x, theirsAt: d.updated as string } : x)),
      () => undefined,
    );
  }, []);

  const send = useCallback(
    async (kind: DocKind, id: string, value: Hoist | Catalog, keepalive: boolean) => {
      const noun = kind === 'hoists' ? 'hoist' : 'catalog';
      const tooBig = oversize(value, noun);
      if (tooBig) {
        notify(tooBig, { tone: 'error' });
        return;
      }
      const json = JSON.stringify(value);
      const key = `${kind}/${id}`;
      if (lastSaved.current.get(key) === json) return;
      try {
        await saveItem(kind, id, value, { keepalive: keepalive && json.length < KEEPALIVE_MAX });
        lastSaved.current.set(key, json);
      } catch (e) {
        if (isVersionConflict(e)) {
          onConflict(kind, id, value, e.etag);
          return;
        }
        const name = kind === 'hoists' ? `“${(value as Hoist).title || 'this hoist'}”` : 'the catalog';
        if (kind === 'hoists' && pendingSave.current === null) pendingSave.current = value as Hoist;
        notify(`Could not save ${name} to the Semaphore folder. ${describeError(e)} It is kept in this browser${kind === 'hoists' ? ' and saved again when Semaphore answers' : ''}.`, {
          tone: 'error',
          action: { label: 'Try again', run: () => void send(kind, id, value, false) },
        });
      }
    },
    [onConflict],
  );

  const flushSave = useCallback(
    (keepalive = false): Promise<void> => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const h = pendingSave.current;
      if (!h || !latest.current.server) return Promise.resolve();
      // While the analyst decides about a conflict on this hoist, nothing is sent for it.
      const c = conflictRef.current;
      if (c && c.kind === 'hoists' && c.id === h.id) return Promise.resolve();
      pendingSave.current = null;
      return send('hoists', h.id, h, keepalive);
    },
    [send],
  );

  // A browser that cannot keep the page (storage full or blocked) says so once, until it can again.
  const localSaveFailed = useRef(false);
  useEffect(() => {
    const kept = writeLocal(hoistKey, hoist);
    if (!kept && !localSaveFailed.current) notify(server ? 'This browser could not keep the page (storage is full or blocked). It is still saved to the Semaphore folder.' : 'This browser could not save the page (storage is full or blocked). Download this hoist to keep it.', { tone: 'error' });
    localSaveFailed.current = !kept;
    if (!server) return;
    if (pendingSave.current && pendingSave.current.id !== hoist.id) void flushSave();
    pendingSave.current = hoist;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS);
  }, [hoist, server, flushSave, hoistKey]);

  // Back online: send what could not be sent.
  useEffect(() => {
    if (online && server && pendingSave.current) void flushSave();
  }, [online, server, flushSave]);

  useEffect(() => {
    const leaving = () => void flushSave(true);
    window.addEventListener('pagehide', leaving);
    return () => window.removeEventListener('pagehide', leaving);
  }, [flushSave]);

  const saveCatalog = useCallback(
    (c: Catalog) => {
      if (!latest.current.server) return;
      const cc = conflictRef.current;
      if (cc && cc.kind === 'catalogs') {
        setConflict({ ...cc, mine: c });
        return;
      }
      void send('catalogs', 'default', c, false);
    },
    [send],
  );

  const resolveConflict = useCallback(
    (choice: 'theirs' | 'copy' | 'overwrite') => {
      const c = conflictRef.current;
      if (!c) return;
      setConflict(null);
      conflictRef.current = null;
      const { onLoadHoist, onLoadCatalog, index: idx, newId } = latest.current;
      if (choice === 'overwrite') {
        rememberEtag(c.kind, c.id, c.etag);
        if (c.kind === 'hoists') pendingSave.current = null;
        void send(c.kind, c.id, c.kind === 'hoists' ? (latest.current.hoist.id === c.id ? latest.current.hoist : (c.mine as Hoist)) : c.mine, false);
        return;
      }
      if (choice === 'copy' && c.kind === 'hoists') {
        const mine = latest.current.hoist.id === c.id ? latest.current.hoist : (c.mine as Hoist);
        pendingSave.current = null;
        onLoadHoist({ ...mine, id: newId('h'), title: `${mine.title || 'Untitled hoist'} (copy)`.slice(0, LIMITS.titleChars), updated: new Date().toISOString() });
        notify('Saved yours as a copy; the folder keeps theirs under the old name.', { tone: 'success' });
        return;
      }
      loadItem<unknown>(c.kind, c.id).then(
        (raw) => {
          if (c.kind === 'hoists') {
            const { hoist: h, warnings } = parseHoist(raw, idx);
            if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
            pendingSave.current = null;
            lastSaved.current.set(`hoists/${h.id}`, JSON.stringify(h));
            onLoadHoist(h);
          } else {
            onLoadCatalog(raw as Catalog);
          }
          notify(c.kind === 'hoists' ? 'Loaded their version.' : 'Loaded their catalog.', { tone: 'success' });
        },
        (e: unknown) => notify(`Could not load their version. ${describeError(e)}`, { tone: 'error' }),
      );
    },
    [send],
  );

  // Another tab of this browser wrote the working copy.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== hoistKey || !e.newValue) return;
      let raw: unknown;
      try {
        raw = JSON.parse(e.newValue);
      } catch {
        return;
      }
      const theirs = raw as Partial<Hoist>;
      const mine = latest.current.hoist;
      if (JSON.stringify(mine) === e.newValue) return setTabChange(null);
      setTabChange({ title: typeof theirs.title === 'string' ? theirs.title : '', sameHoist: theirs.id === mine.id, raw });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [hoistKey]);

  const resolveTabChange = useCallback(
    (choice: 'reload' | 'keep') => {
      const t = tabChange;
      setTabChange(null);
      if (!t) return;
      if (choice === 'keep') {
        writeLocal(hoistKey, latest.current.hoist);
        return;
      }
      const { hoist: h, warnings } = parseHoist(t.raw, latest.current.index);
      if (h) latest.current.onLoadHoist(h);
      else notify(`Could not read the other tab’s hoist: ${warnings[0] ?? 'not a hoist.'}`, { tone: 'error' });
    },
    [tabChange, hoistKey],
  );

  return {
    flushSave,
    saveCatalog,
    conflict: conflict ? { kind: conflict.kind, title: conflict.title, ...(conflict.theirsAt ? { theirsAt: conflict.theirsAt } : {}) } : null,
    resolveConflict,
    tabChange: tabChange ? { title: tabChange.title, sameHoist: tabChange.sameHoist } : null,
    resolveTabChange,
  };
}

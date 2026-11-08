// Saving (#85, #88, #91). The hoist is always kept in this browser; with a server it is also saved
// to the Semaphore folder 1.2 s after the last change, and so is the catalog. A pending save is sent
// at once, never dropped, when another hoist replaces this one, before End session, and when the
// page goes away. Every save checks the size first (the folder takes 2 MB a document) and sends the
// version it replaces (If-Match); a 409 `version` becomes a persistent choice
// (components/ConflictBar.tsx) instead of a silent overwrite. Before the first save of a hoist in
// this page the folder's version is read (lib/save-queue.ts readVersion), so a copy a colleague saved
// since is never replaced blind. Saves for one document go out one at a time, newest wins
// (SaveQueue). Another tab writing the working copy is noticed through the `storage` event and
// offered as a reload.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, CatalogIndex } from '../../../src/core/catalog.ts';
import { type Hoist, LIMITS, oversize, parseHoist } from '../../../src/core/hoist.ts';
import { api, type DocKind, describeError, isVersionConflict, knownEtag, loadItem, rememberEtag, saveItem, type ServerInfo } from '../lib/api.ts';
import { notify } from '../lib/toasts.ts';
import { writeLocal } from '../lib/storage.ts';
import { readVersion, SaveQueue } from '../lib/save-queue.ts';
import type { SaveConflict, TabChange } from '../components/ConflictBar.tsx';

export const SAVE_DELAY_MS = 1200;
/** Browsers refuse keepalive bodies over 64 KB; a bigger save on pagehide goes as a normal request. */
const KEEPALIVE_MAX = 60_000;
const CATALOG_ID = 'default';

interface Conflict extends SaveConflict {
  id: string;
  /** The folder's version now, from the 409. */
  etag?: string;
  /** What this page would save now: kept current while the analyst decides. */
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
  /** The catalog reached the folder (so the page may take the folder's copy again). */
  onCatalogSaved?: () => void;
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
  const queue = useRef(new SaveQueue());
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<Hoist | null>(null);
  const catalogTimer = useRef<number | null>(null);
  const pendingCatalog = useRef<Catalog | null>(null);
  // What the folder holds for each id as far as this page knows, so an unchanged document is not sent again.
  const lastSaved = useRef(new Map<string, string>());
  // Hoists whose folder version this page has read (or found absent) since it loaded.
  const versionRead = useRef(new Set<string>());
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

  /** Sends one document, after everything queued before it for the same kind/id; skipped if a newer value was queued since. */
  const send = useCallback(
    (kind: DocKind, id: string, value: Hoist | Catalog, keepalive: boolean): Promise<void> => {
      const noun = kind === 'hoists' ? 'hoist' : 'catalog';
      const tooBig = oversize(value, noun);
      if (tooBig) {
        notify(tooBig, { tone: 'error' });
        return Promise.resolve();
      }
      const key = `${kind}/${id}`;
      return queue.current.run(key, value, async (v) => {
        const json = JSON.stringify(v);
        if (lastSaved.current.get(key) === json) return;
        try {
          await saveItem(kind, id, v, { keepalive: keepalive && json.length < KEEPALIVE_MAX });
          lastSaved.current.set(key, json);
          if (kind === 'catalogs') latest.current.onCatalogSaved?.();
        } catch (e) {
          if (isVersionConflict(e)) {
            onConflict(kind, id, v, e.etag);
            return;
          }
          const name = kind === 'hoists' ? `“${(v as Hoist).title || 'this hoist'}”` : 'the catalog';
          if (kind === 'hoists' && pendingSave.current === null) pendingSave.current = v as Hoist;
          if (kind === 'catalogs' && pendingCatalog.current === null) pendingCatalog.current = v as Catalog;
          notify(`Could not save ${name} to the Semaphore folder. ${describeError(e)} It is kept in this browser and saved again when Semaphore answers.`, {
            tone: 'error',
            action: { label: 'Try again', run: () => void send(kind, id, v, false) },
          });
        }
      });
    },
    [onConflict],
  );

  /**
   * The folder's version of a hoist is read once per page load before its first save, in the same
   * line as the saves, so that first save sends If-Match. A read the server could not answer leaves
   * the save pending; it is tried again when the session is back.
   */
  const versionKnown = useCallback((h: Hoist): Promise<'ok' | 'wait' | 'conflict'> => {
    if (versionRead.current.has(h.id)) return Promise.resolve('ok');
    let result: 'ok' | 'conflict' = 'ok';
    return queue.current
      .before(`hoists/${h.id}`, async () => {
        const r = await readVersion('hoists', h.id, h);
        if (r === 'failed') throw new Error('version read failed');
        versionRead.current.add(h.id);
        if (r === 'changed') result = 'conflict';
      })
      .then(
        () => result,
        () => 'wait' as const,
      );
  }, []);

  const flushSave = useCallback(
    async (keepalive = false): Promise<void> => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const h = pendingSave.current;
      if (!h || !latest.current.server) return;
      // While the analyst decides about a conflict on this hoist, nothing is sent for it.
      const c = conflictRef.current;
      if (c && c.kind === 'hoists' && c.id === h.id) return;
      pendingSave.current = null;
      const known = await versionKnown(h);
      if (known === 'wait') {
        // Nothing newer took its place: it stays pending for the next flush (back online).
        pendingSave.current ??= h;
        return;
      }
      if (known === 'conflict') {
        // Someone saved this hoist since this browser last had it: the same bar as a 409, before anything is sent.
        onConflict('hoists', h.id, h, knownEtag('hoists', h.id));
        return;
      }
      await send('hoists', h.id, h, keepalive);
    },
    [send, versionKnown, onConflict],
  );

  const flushCatalog = useCallback(
    (keepalive = false): Promise<void> => {
      if (catalogTimer.current) clearTimeout(catalogTimer.current);
      catalogTimer.current = null;
      const c = pendingCatalog.current;
      if (!c || !latest.current.server) return Promise.resolve();
      const cc = conflictRef.current;
      if (cc && cc.kind === 'catalogs') return Promise.resolve();
      pendingCatalog.current = null;
      return send('catalogs', CATALOG_ID, c, keepalive);
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
    // A conflict on this hoist keeps the newest version, so Overwrite and Save as a copy send what is on the page now.
    const c = conflictRef.current;
    if (c && c.kind === 'hoists' && c.id === hoist.id && c.mine !== hoist) setConflict({ ...c, mine: hoist });
    if (pendingSave.current && pendingSave.current.id !== hoist.id) void flushSave();
    pendingSave.current = hoist;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS);
  }, [hoist, server, flushSave, hoistKey]);

  // Back online: send what could not be sent.
  useEffect(() => {
    if (!online || !server) return;
    if (pendingSave.current) void flushSave();
    if (pendingCatalog.current) void flushCatalog();
  }, [online, server, flushSave, flushCatalog]);

  useEffect(() => {
    const leaving = () => {
      void flushSave(true);
      void flushCatalog(true);
    };
    window.addEventListener('pagehide', leaving);
    return () => window.removeEventListener('pagehide', leaving);
  }, [flushSave, flushCatalog]);

  const saveCatalog = useCallback(
    (c: Catalog) => {
      if (!latest.current.server) return;
      const cc = conflictRef.current;
      if (cc && cc.kind === 'catalogs') {
        setConflict({ ...cc, mine: c });
        return;
      }
      pendingCatalog.current = c;
      if (catalogTimer.current) clearTimeout(catalogTimer.current);
      catalogTimer.current = window.setTimeout(() => void flushCatalog(), SAVE_DELAY_MS);
    },
    [flushCatalog],
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
        else pendingCatalog.current = null;
        void send(c.kind, c.id, c.kind === 'hoists' ? (latest.current.hoist.id === c.id ? latest.current.hoist : (c.mine as Hoist)) : c.mine, false);
        return;
      }
      if (choice === 'copy' && c.kind === 'hoists') {
        const mine = latest.current.hoist.id === c.id ? latest.current.hoist : (c.mine as Hoist);
        pendingSave.current = null;
        const id = newId('h');
        versionRead.current.add(id); // a fresh id: nothing in the folder to read
        onLoadHoist({ ...mine, id, title: `${mine.title || 'Untitled hoist'} (copy)`.slice(0, LIMITS.titleChars), updated: new Date().toISOString() });
        notify('Saved yours as a copy; the folder keeps theirs under the old name.', { tone: 'success' });
        return;
      }
      loadItem<unknown>(c.kind, c.id).then(
        (raw) => {
          if (c.kind === 'hoists') {
            const { hoist: h, warnings } = parseHoist(raw, idx);
            if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
            pendingSave.current = null;
            versionRead.current.add(h.id);
            lastSaved.current.set(`hoists/${h.id}`, JSON.stringify(h));
            onLoadHoist(h);
          } else {
            pendingCatalog.current = null;
            lastSaved.current.set(`catalogs/${CATALOG_ID}`, JSON.stringify(raw));
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
      if (!h) {
        notify(`Could not read the other tab’s hoist: ${warnings[0] ?? 'not a hoist.'}`, { tone: 'error' });
        return;
      }
      // The other tab saved this very version: it is not sent again, and the folder's ETag is read
      // afresh (in the save line, so the next edit's save waits for it) rather than kept from before.
      pendingSave.current = null;
      lastSaved.current.set(`hoists/${h.id}`, JSON.stringify(h));
      if (latest.current.server) {
        versionRead.current.add(h.id);
        void queue.current.before(`hoists/${h.id}`, () => loadItem(`hoists`, h.id).then(() => undefined, () => undefined));
      }
      latest.current.onLoadHoist(h);
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

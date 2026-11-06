// Browser storage, per TechStack: settings and the working copy in localStorage, data files in
// IndexedDB. Both can be missing (private windows, blocked site data), so every call is guarded
// and the app works without them. Every write says whether it worked, so the page can tell the
// analyst when something was not kept.

export function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const DB = 'semaphore';
const STORE = 'files';
/** 1: files stored as text. 2: files stored as Blobs (text records are moved over once). */
const VERSION = 2;

export type StoreResult = { ok: true } | { ok: false; reason: 'quota' | 'blocked' | 'other' };

function failure(e: unknown): StoreResult {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return { ok: false, reason: 'quota' };
  if (name === 'SecurityError' || name === 'InvalidStateError') return { ok: false, reason: 'blocked' };
  return { ok: false, reason: 'other' };
}

type Opened = { db: IDBDatabase } | { db: null; why: StoreResult };

// One connection per page load. Another tab upgrading the database asks it to close
// (versionchange); it is closed at once and opened again on the next call.
let connection: Promise<Opened> | null = null;

function open(): Promise<Opened> {
  if (connection) return connection;
  const p = new Promise<Opened>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve({ db: null, why: { ok: false, reason: 'blocked' } });
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = (e) => upgrade(req, e.oldVersion);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          if (connection === p) connection = null;
        };
        db.onclose = () => {
          if (connection === p) connection = null;
        };
        resolve({ db });
      };
      req.onerror = () => resolve({ db: null, why: failure(req.error) });
      req.onblocked = () => resolve({ db: null, why: { ok: false, reason: 'blocked' } });
    } catch (e) {
      resolve({ db: null, why: failure(e) });
    }
  });
  connection = p;
  // A failed open is tried again next time (the analyst may free space or close another tab).
  void p.then((o) => {
    if (!o.db && connection === p) connection = null;
  });
  return p;
}

function upgrade(req: IDBOpenDBRequest, from: number): void {
  const db = req.result;
  if (from < 1) {
    db.createObjectStore(STORE);
    return;
  }
  if (from < 2) {
    // Version 1 kept { name, text, added }; keep the file, as a Blob.
    const store = req.transaction!.objectStore(STORE);
    const all = store.getAll();
    all.onsuccess = () => {
      for (const rec of all.result as Array<{ name: string; text?: unknown; blob?: Blob; added: string }>) {
        if (typeof rec.text === 'string') store.put({ name: rec.name, blob: new Blob([rec.text], { type: 'text/csv' }), added: rec.added } satisfies StoredFile, rec.name);
      }
    };
  }
}

async function read<T>(fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const o = await open();
  if (!o.db) return null;
  const db = o.db;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, 'readonly').objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Resolves when the transaction is committed: quota errors only show up when it aborts. */
async function write(fn: (s: IDBObjectStore) => void): Promise<StoreResult> {
  const o = await open();
  if (!o.db) return o.why;
  const db = o.db;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, 'readwrite');
      t.oncomplete = () => resolve({ ok: true });
      t.onabort = () => resolve(failure(t.error));
      fn(t.objectStore(STORE));
    } catch (e) {
      resolve(failure(e));
    }
  });
}

let persistAsked = false;

/** Ask once that stored files are not evicted under storage pressure. Never fails. */
export function requestPersistence(): void {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const storage = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator?.storage;
    void storage?.persist?.().catch(() => false);
  } catch {
    /* not offered here */
  }
}

export interface StoredFile {
  name: string;
  /** The file as read from disk (or the CSV made from a Fleet export). Never read by the page. */
  blob: Blob;
  added: string;
}

export async function putFile(f: StoredFile): Promise<StoreResult> {
  const r = await write((s) => s.put(f, f.name));
  if (r.ok) requestPersistence();
  return r;
}

export const deleteFile = (name: string): Promise<StoreResult> => write((s) => s.delete(name));

export const clearFiles = (): Promise<StoreResult> => write((s) => s.clear());

export async function allFiles(): Promise<StoredFile[]> {
  return ((await read((s) => s.getAll())) as StoredFile[] | null)?.filter((f) => f && f.blob instanceof Blob) ?? [];
}

/** What to tell the analyst when `what` (e.g. "parts.csv") was not stored. */
export function notKeptMessage(what: string, r: StoreResult): string | null {
  if (r.ok) return null;
  const why = r.reason === 'quota' ? ' because its storage is full' : r.reason === 'blocked' ? ' because site storage is blocked' : '';
  return `This browser could not keep ${what}${why}. It works until you reload; add it again after that.`;
}

/** Closes the connection; the next call opens a new one. For tests and page teardown. */
export async function closeStorage(): Promise<void> {
  const c = connection;
  connection = null;
  const o = await c;
  o?.db?.close();
}

// Browser storage, per TechStack: settings and the working copy in localStorage, data files in
// IndexedDB. Both can be missing (private windows, blocked site data), so every call is guarded
// and the app works without them.

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

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export interface StoredFile {
  name: string;
  text: string;
  added: string;
}

export const putFile = (f: StoredFile) => tx('readwrite', (s) => s.put(f, f.name));
export const deleteFile = (name: string) => tx('readwrite', (s) => s.delete(name));
export async function allFiles(): Promise<StoredFile[]> {
  return ((await tx('readonly', (s) => s.getAll())) as StoredFile[] | null) ?? [];
}

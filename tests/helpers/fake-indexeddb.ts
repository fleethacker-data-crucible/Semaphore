// A small in-memory IndexedDB for tests: one database name, out-of-line keys, the calls
// web/src/lib/storage.ts makes (open with upgrade, get/put/delete/clear/getAll, transactions that
// commit or abort, versionchange). Events fire on timers, like the real thing.

type Handler = ((e: any) => void) | null;

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: { name: string } | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onblocked: Handler = null;
  onupgradeneeded: Handler = null;
  transaction: FakeTransaction | null = null;
}

class FakeStore {
  readonly t: FakeTransaction;
  constructor(t: FakeTransaction) {
    this.t = t;
  }
  private req<T>(fn: () => T): FakeRequest<T> {
    const r = new FakeRequest<T>();
    this.t.pending++;
    setTimeout(() => {
      this.t.pending--;
      if (this.t.done) return;
      r.result = fn();
      r.onsuccess?.({ target: r });
    }, 0);
    return r;
  }
  put(value: unknown, key: string) {
    return this.req(() => (this.t.data.set(key, value), key));
  }
  delete(key: string) {
    return this.req(() => (this.t.data.delete(key), undefined));
  }
  clear() {
    return this.req(() => (this.t.data.clear(), undefined));
  }
  get(key: string) {
    return this.req(() => this.t.data.get(key));
  }
  getAll() {
    return this.req(() => [...this.t.data.values()]);
  }
}

class FakeTransaction {
  pending = 0;
  done = false;
  error: { name: string } | null = null;
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  data: Map<string, unknown>;
  readonly db: FakeDatabase;
  readonly mode: string;
  constructor(db: FakeDatabase, mode: string) {
    this.db = db;
    this.mode = mode;
    this.data = new Map(db.factory.stores.get(db.factory.storeName) ?? []);
    this.settle();
  }
  objectStore(_name: string) {
    if (!this.db.factory.stores.has(this.db.factory.storeName)) throw Object.assign(new Error('no store'), { name: 'NotFoundError' });
    return new FakeStore(this);
  }
  private settle() {
    setTimeout(() => {
      if (this.pending > 0) return this.settle();
      this.done = true;
      const fail = this.mode !== 'readonly' ? this.db.factory.failCommits.shift() : undefined;
      if (fail) {
        this.error = { name: fail };
        this.onabort?.({ target: this });
        return;
      }
      if (this.mode !== 'readonly') this.db.factory.stores.set(this.db.factory.storeName, this.data);
      this.oncomplete?.({ target: this });
    }, 0);
  }
}

class FakeDatabase {
  closed = false;
  onversionchange: Handler = null;
  onclose: Handler = null;
  readonly factory: FakeIndexedDB;
  constructor(factory: FakeIndexedDB) {
    this.factory = factory;
  }
  createObjectStore(name: string) {
    this.factory.storeName = name;
    this.factory.stores.set(name, new Map());
  }
  transaction(_store: string, mode: string) {
    if (this.closed) throw Object.assign(new Error('closed'), { name: 'InvalidStateError' });
    return new FakeTransaction(this, mode);
  }
  close() {
    this.closed = true;
  }
}

export class FakeIndexedDB {
  version = 0;
  storeName = 'files';
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly opened: FakeDatabase[] = [];
  /** Error names for the next write transactions to abort with, in order. */
  failCommits: string[] = [];
  /** When set, open() fails with this error name. */
  openError: string | null = null;

  /** A database as an older page version left it. */
  seed(version: number, records: Record<string, unknown>) {
    this.version = version;
    this.stores.set(this.storeName, new Map(Object.entries(records)));
  }

  /** Another tab opens a newer version: open connections are asked to close. */
  versionChange() {
    for (const db of this.opened) if (!db.closed) db.onversionchange?.({ target: db });
  }

  open(_name: string, version: number) {
    const req = new FakeRequest<FakeDatabase>();
    setTimeout(() => {
      if (this.openError) {
        req.error = { name: this.openError };
        req.onerror?.({ target: req });
        return;
      }
      const db = new FakeDatabase(this);
      req.result = db;
      const finish = () => {
        this.opened.push(db);
        req.onsuccess?.({ target: req });
      };
      if (version > this.version) {
        const old = this.version;
        this.version = version;
        // The upgrade transaction sees the store the callback creates or finds.
        const t = Object.create(FakeTransaction.prototype) as FakeTransaction;
        Object.assign(t, { pending: 0, done: false, error: null, db, mode: 'versionchange', data: new Map() });
        req.transaction = t;
        req.onupgradeneeded?.({ target: req, oldVersion: old });
        t.data = this.stores.get(this.storeName) ?? new Map();
        const wait = () => (t.pending > 0 ? setTimeout(wait, 0) : finish());
        setTimeout(wait, 0);
      } else finish();
    }, 0);
    return req;
  }
}

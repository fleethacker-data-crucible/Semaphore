// One writer per document (#88 follow-up). Saves for the same kind/id run one after another, so two
// in-flight PUTs never carry the same If-Match; a value that was replaced before its turn is not sent
// at all (the newer one is). A version read (GET for the ETag) can be put in the same line, so the
// first save of a page load waits for it. Plain TypeScript, tested in tests/save-queue.test.ts.

import { ApiError, loadItem, type DocKind, knownEtag, rememberSavedEtag, savedEtag } from './api.ts';

export class SaveQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, unknown>();

  /**
   * Runs `fn(value)` once everything queued before it for `key` has finished. If a newer value was
   * queued for the key in the meantime, this one is skipped (resolves without running). A rejection
   * reaches the caller; the line carries on.
   */
  run<T>(key: string, value: T, fn: (value: T) => Promise<void>): Promise<void> {
    this.latest.set(key, value);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const p = prev.then(() => (this.latest.get(key) === value ? fn(value) : undefined));
    this.chains.set(key, p.catch(() => undefined));
    return p;
  }

  /** Something every later save for `key` must wait for (an ETag read). Its failure is the caller's. */
  before(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const p = prev.then(fn);
    this.chains.set(key, p.catch(() => undefined));
    return p;
  }

  /** Whether `value` is still the newest queued for `key`. */
  isLatest(key: string, value: unknown): boolean {
    return this.latest.get(key) === value;
  }
}

export type VersionRead = 'known' | 'new' | 'changed' | 'failed';

/**
 * Before the page's first save of a document, learns where the folder's copy stands against the
 * working copy. 'known': the folder holds the version this browser last saved or loaded, so the save
 * may go. 'changed': someone saved since (the caller raises the conflict bar). 'new': the folder has
 * no such document (404). 'failed': the server could not be asked, so the save waits.
 *
 * A page that never recorded a version (an older build, an imported copy) has only the stamps to
 * go by: the folder's copy is newer than the working copy's last edit, or it is not.
 */
export async function readVersion(kind: DocKind, id: string, local?: { updated?: string }, load: typeof loadItem = loadItem): Promise<VersionRead> {
  if (knownEtag(kind, id)) return 'known';
  const mine = savedEtag(kind, id);
  try {
    const doc = await load<{ updated?: unknown }>(kind, id);
    const theirs = knownEtag(kind, id);
    if (!theirs) return 'new';
    let result: VersionRead;
    if (mine) result = mine === theirs ? 'known' : 'changed';
    else {
      const stamp = typeof doc?.updated === 'string' ? doc.updated : '';
      result = local?.updated && stamp > local.updated ? 'changed' : 'known';
    }
    // The read must not pass for a save: until the analyst decides, the browser's version stays what it was.
    if (result === 'changed' && kind === 'hoists') rememberSavedEtag(id, mine);
    return result;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return 'new';
    return 'failed';
  }
}

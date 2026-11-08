import assert from 'node:assert/strict';
import { test } from 'node:test';

// One writer per document (web/src/lib/save-queue.ts): saves for one kind/id go out one at a time
// with the newest value, and the first save of a page load waits for the folder's version.
const store = new Map<string, string>([['semaphore.session', 'TOKEN']]);
const g = globalThis as Record<string, unknown>;
g.localStorage = { getItem: (k: string) => store.get('L:' + k) ?? null, setItem: (k: string, v: string) => void store.set('L:' + k, v), removeItem: (k: string) => void store.delete('L:' + k) };
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const sent: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
let next: (url: string, init: RequestInit) => Response = () => new Response('{}');
g.fetch = async (url: string, init: RequestInit) => {
  sent.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? init.body : undefined });
  return next(url, init);
};

const { knownEtag, rememberEtag, rememberSavedEtag, saveItem, savedEtag } = await import('../web/src/lib/api.ts');
const { readVersion, SaveQueue } = await import('../web/src/lib/save-queue.ts');

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test('saves for one key run one after another, each with the ETag the one before it brought back', async () => {
  const q = new SaveQueue();
  rememberEtag('catalogs', 'q1', 'e0');
  let n = 0;
  next = () => new Response(JSON.stringify({ ok: true, etag: `e${++n}` }));
  const before = sent.length;
  // Two keystrokes' saves queued at once: without the queue both would carry If-Match "e0".
  const a = q.run('catalogs/q1', { v: 1 }, (v) => saveItem('catalogs', 'q1', v).then(() => undefined));
  const b = q.run('catalogs/q1', { v: 2 }, (v) => saveItem('catalogs', 'q1', v).then(() => undefined));
  await Promise.all([a, b]);
  const puts = sent.slice(before);
  assert.equal(puts.length, 1, 'the first value was replaced before its turn, so only the newest was sent');
  assert.equal(puts[0]!.body, '{"v":2}');
  assert.equal(puts[0]!.headers['If-Match'], '"e0"');
  assert.equal(knownEtag('catalogs', 'q1'), 'e1');
});

test('a value that is still the newest when its turn comes is sent; the next one waits for its ETag', async () => {
  const q = new SaveQueue();
  rememberEtag('hoists', 'q2', 'h0');
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  next = () => new Response(JSON.stringify({ ok: true, etag: `h${++n}` }));
  const before = sent.length;
  const first = q.run('hoists/q2', { v: 1 }, async (v) => {
    await gate; // a slow folder: the save is still in flight when the next one is queued
    await saveItem('hoists', 'q2', v);
  });
  await tick();
  const second = q.run('hoists/q2', { v: 2 }, (v) => saveItem('hoists', 'q2', v).then(() => undefined));
  release();
  await Promise.all([first, second]);
  const puts = sent.slice(before);
  assert.deepEqual(puts.map((p) => p.body), ['{"v":1}', '{"v":2}'], 'in order, nothing dropped');
  assert.deepEqual(puts.map((p) => p.headers['If-Match']), ['"h0"', '"h1"'], 'the second waited for the first and sent the ETag it brought back');
});

test('a failed save does not stop the line, and its rejection reaches its caller', async () => {
  const q = new SaveQueue();
  const seen: string[] = [];
  const failed = q.run('k', 'a', async () => {
    throw new Error('no');
  });
  await tick(); // 'a' has started (and failed) before 'b' is queued
  const ok = q.run('k', 'b', async (v) => {
    seen.push(v);
  });
  await assert.rejects(failed, /no/);
  await ok;
  assert.deepEqual(seen, ['b']);
});

test('before(): a version read ahead of the first save; readVersion tells known, new and failed apart', async () => {
  const q = new SaveQueue();
  const order: string[] = [];
  // Nothing known yet and nothing remembered: the folder's copy is read first, so the save carries its ETag.
  next = (url) => (url.endsWith('/r1') && !sent.at(-1)!.method.startsWith('PUT') ? new Response('{"version":1}', { headers: { ETag: '"theirs"' } }) : new Response('{"ok":true,"etag":"mine"}'));
  const read = q.before('hoists/r1', async () => {
    order.push(`read:${await readVersion('hoists', 'r1')}`);
  });
  const save = q.run('hoists/r1', { v: 1 }, async (v) => {
    order.push('save');
    await saveItem('hoists', 'r1', v);
  });
  await Promise.all([read, save]);
  assert.deepEqual(order, ['read:known', 'save']);
  assert.equal(sent.at(-1)!.headers['If-Match'], '"theirs"', 'the first save of the page is no longer blind');

  // A document the folder has not got is a first save, sent without If-Match.
  next = () => new Response('{"error":"none","code":"not-found"}', { status: 404 });
  assert.equal(await readVersion('hoists', 'r2'), 'new');
  // The server not answering is neither: the save must wait.
  next = () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await readVersion('hoists', 'r3'), 'failed');
  // Already known: no request at all.
  rememberEtag('hoists', 'r4', 'x');
  const n = sent.length;
  assert.equal(await readVersion('hoists', 'r4'), 'known');
  assert.equal(sent.length, n);
});

test('a folder copy someone else saved since is a conflict, not a save', async () => {
  // The working copy was last saved as "mine"; the folder now holds "theirs".
  rememberSavedEtag('c1', 'mine');
  next = () => new Response('{"version":1,"updated":"2026-11-07T10:00:00.000Z"}', { headers: { ETag: '"theirs"' } });
  assert.equal(await readVersion('hoists', 'c1', { updated: '2026-11-07T09:00:00.000Z' }), 'changed');
  assert.equal(knownEtag('hoists', 'c1'), 'theirs', 'the folder version is known for the bar and for Overwrite');
  assert.equal(savedEtag('hoists', 'c1'), 'mine', 'but the browser still remembers the version it last had');

  // The folder holds the version this browser saved: the save may go.
  rememberSavedEtag('c2', 'same');
  next = () => new Response('{"version":1}', { headers: { ETag: '"same"' } });
  assert.equal(await readVersion('hoists', 'c2', { updated: '2026-11-07T09:00:00.000Z' }), 'known');

  // Nothing remembered (an older build, an imported copy): the stamps decide.
  rememberSavedEtag('c3', null);
  next = () => new Response('{"version":1,"updated":"2026-11-07T10:00:00.000Z"}', { headers: { ETag: '"x"' } });
  assert.equal(await readVersion('hoists', 'c3', { updated: '2026-11-07T09:00:00.000Z' }), 'changed');
  next = () => new Response('{"version":1,"updated":"2026-11-07T08:00:00.000Z"}', { headers: { ETag: '"y"' } });
  assert.equal(await readVersion('hoists', 'c4', { updated: '2026-11-07T09:00:00.000Z' }), 'known');
});

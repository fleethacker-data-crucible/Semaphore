import assert from 'node:assert/strict';
import { test } from 'node:test';

// Contract 1: the client keeps the ETag per kind/id, sends it as If-Match, and surfaces a 409 version.
const store = new Map<string, string>([['semaphore.session', 'TOKEN']]);
const g = globalThis as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let next: () => Response = () => new Response('{}');
g.fetch = async (url: string, init: RequestInit) => {
  sent.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string> });
  return next();
};

const { configureApi, isVersionConflict, knownEtag, loadItem, rememberEtag, saveItem, describeError } = await import('../web/src/lib/api.ts');

test('a read keeps the ETag, a save sends it as If-Match and keeps the new one', async () => {
  next = () => new Response('{"version":1,"id":"h1"}', { headers: { ETag: '"aaa111"' } });
  await loadItem('hoists', 'h1');
  assert.equal(knownEtag('hoists', 'h1'), 'aaa111');
  next = () => new Response('{"ok":true,"etag":"bbb222"}');
  await saveItem('hoists', 'h1', { version: 1 });
  assert.equal(sent.at(-1)!.headers['If-Match'], '"aaa111"');
  assert.equal(knownEtag('hoists', 'h1'), 'bbb222');
  await saveItem('hoists', 'h1', { version: 1 });
  assert.equal(sent.at(-1)!.headers['If-Match'], '"bbb222"');
});

test('a first save sends no If-Match; ETags are per kind and id', async () => {
  next = () => new Response('{"ok":true,"etag":"ccc"}');
  await saveItem('hoists', 'h2', { version: 1 });
  assert.equal(sent.at(-1)!.headers['If-Match'], undefined);
  assert.equal(knownEtag('catalogs', 'h2'), undefined);
});

test('a 409 version is surfaced with the folder’s current ETag, in plain words', async () => {
  rememberEtag('catalogs', 'default', 'old');
  next = () => new Response('{"error":"changed","code":"version","etag":"theirs"}', { status: 409 });
  let caught: unknown;
  try {
    await saveItem('catalogs', 'default', { version: 1 });
  } catch (e) {
    caught = e;
  }
  assert.ok(isVersionConflict(caught));
  assert.equal((caught as { etag?: string }).etag, 'theirs');
  assert.match(describeError(caught), /Someone else saved/);
  assert.equal(knownEtag('catalogs', 'default'), 'old', 'the page keeps its own version until the analyst chooses');
  next = () => new Response('{"ok":true,"etag":"mine"}');
  await saveItem('catalogs', 'default', { version: 1 }, { overwrite: true });
  assert.equal(sent.at(-1)!.headers['If-Match'], undefined);
});

test('api hooks: a network failure, a 401 and an answer each reach the session machine', async () => {
  const heard: string[] = [];
  configureApi({ onNetwork: () => heard.push('network'), onSession: () => heard.push('session'), onSuccess: () => heard.push('ok') });
  next = () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(loadItem('hoists', 'x'), (e: unknown) => describeError(e).startsWith('Semaphore isn’t answering'));
  next = () => new Response('{"error":"no","code":"session"}', { status: 401 });
  await assert.rejects(loadItem('hoists', 'x'));
  next = () => new Response('{"error":"nope","code":"not-found"}', { status: 404 });
  await assert.rejects(loadItem('hoists', 'x'));
  assert.deepEqual(heard, ['network', 'session', 'ok']);
  configureApi({});
});

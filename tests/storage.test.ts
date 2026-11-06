// web/src/lib/storage.ts against an in-memory IndexedDB (tests/helpers/fake-indexeddb.ts).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { allFiles, closeStorage, deleteFile, notKeptMessage, putFile, requestPersistence } from '../web/src/lib/storage.ts';
import { FakeIndexedDB } from './helpers/fake-indexeddb.ts';

let fake: FakeIndexedDB;
const g = globalThis as { indexedDB?: unknown; navigator?: unknown };
let persistCalls = 0;

beforeEach(() => {
  fake = new FakeIndexedDB();
  g.indexedDB = fake;
});
afterEach(async () => {
  await closeStorage();
  delete g.indexedDB;
});

const file = (name: string, text: string) => ({ name, blob: new Blob([text], { type: 'text/csv' }), added: '2026-11-06T00:00:00.000Z' });

// First: the request is made once per page load (module state), so it must run before other writes.
test('storage: persistence is asked for once, and a missing API is fine', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { persist: async () => (persistCalls++, true) } } });
  try {
    await putFile(file('a.csv', 'a\n1'));
    await putFile(file('b.csv', 'a\n1'));
    requestPersistence();
    assert.equal(persistCalls, 1);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete g.navigator;
  }
});

test('storage: files are kept as Blobs and come back; one connection serves every call', async () => {
  assert.deepEqual(await putFile(file('a.csv', 'x,y\n1,2')), { ok: true });
  assert.deepEqual(await putFile(file('b.csv', 'z\n3')), { ok: true });
  const all = await allFiles();
  assert.deepEqual(all.map((f) => f.name).sort(), ['a.csv', 'b.csv']);
  assert.equal(await all.find((f) => f.name === 'a.csv')!.blob.text(), 'x,y\n1,2');
  assert.deepEqual(await deleteFile('a.csv'), { ok: true });
  assert.deepEqual((await allFiles()).map((f) => f.name), ['b.csv']);
  assert.equal(fake.opened.length, 1);
});

test('storage: a full disk is reported as quota, and the file is not half-stored', async () => {
  fake.failCommits.push('QuotaExceededError');
  const r = await putFile(file('big.csv', 'a\n1'));
  assert.deepEqual(r, { ok: false, reason: 'quota' });
  assert.deepEqual(await allFiles(), []);
  const message = notKeptMessage('big.csv', r);
  assert.match(message!, /could not keep big\.csv because its storage is full/);
  assert.equal(notKeptMessage('x', { ok: true }), null);
  fake.failCommits.push('UnknownError');
  assert.deepEqual(await deleteFile('big.csv'), { ok: false, reason: 'other' });
});

test('storage: blocked or missing IndexedDB is a result, not a throw', async () => {
  fake.openError = 'SecurityError';
  assert.deepEqual(await putFile(file('a.csv', 'a\n1')), { ok: false, reason: 'blocked' });
  assert.deepEqual(await allFiles(), []);
  // A failed open is tried again on the next call.
  fake.openError = null;
  assert.deepEqual(await putFile(file('a.csv', 'a\n1')), { ok: true });
  await closeStorage();
  delete g.indexedDB;
  assert.deepEqual(await putFile(file('a.csv', 'a\n1')), { ok: false, reason: 'blocked' });
});

test('storage: another tab upgrading closes this connection, and the next call reopens', async () => {
  await putFile(file('a.csv', 'a\n1'));
  assert.equal(fake.opened.length, 1);
  fake.versionChange();
  assert.equal(fake.opened[0]!.closed, true);
  assert.deepEqual(await putFile(file('b.csv', 'b\n2')), { ok: true });
  assert.equal(fake.opened.length, 2);
  assert.equal((await allFiles()).length, 2);
});

test('storage: text files from version 1 are moved to Blobs once', async () => {
  fake.seed(1, { 'old.csv': { name: 'old.csv', text: 'a,b\n1,2', added: '2026-01-01' } });
  const all = await allFiles();
  assert.equal(all.length, 1);
  assert.ok(all[0]!.blob instanceof Blob);
  assert.equal(await all[0]!.blob.text(), 'a,b\n1,2');
  assert.equal('text' in all[0]!, false);
  assert.equal(fake.version, 2);
});

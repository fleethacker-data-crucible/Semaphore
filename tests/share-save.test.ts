import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { presentSave, runSave } from '../web/src/lib/save-status.ts';

const named = (name: string) => `${name}, locked.`;

test('a rejected save is a failure, never a success', async () => {
  const status = await runSave(() => Promise.reject(new Error('disk full')), named);
  assert.equal(status.kind, 'failed');
  const p = presentSave(status)!;
  assert.equal(p.tone, 'text-bad');
  assert.notEqual(p.tone, 'text-good');
  assert.equal(p.role, 'alert');
  assert.equal(p.label, 'Could not save');
  assert.equal(p.message, 'disk full');
  assert.equal(p.mark, 'error');
  assert.equal(p.retry, true);
});

test('a failure is told in words and a mark as well as colour', () => {
  const p = presentSave({ kind: 'failed', message: 'x' })!;
  assert.ok(p.label.length > 0 && p.mark === 'error');
});

test('a successful save is announced politely, in success styling, with no retry', async () => {
  const p = presentSave(await runSave(() => Promise.resolve('page.html'), named))!;
  assert.deepEqual([p.role, p.tone, p.label, p.mark, p.retry], ['status', 'text-good', 'Saved', 'ok', false]);
  assert.equal(p.message, 'page.html, locked.');
});

test('retry after a failure succeeds with the same inputs, and the failure is gone', async () => {
  let calls = 0;
  const save = () => (++calls === 1 ? Promise.reject(new Error('network share offline')) : Promise.resolve('page.html'));
  const first = await runSave(save, named);
  const second = await runSave(save, named);
  assert.equal(first.kind, 'failed');
  assert.equal(second.kind, 'saved');
  assert.equal(presentSave(second)!.tone, 'text-good');
  assert.equal(calls, 2);
});

test('odd rejections still give a readable failure', async () => {
  for (const why of ['text reason', undefined, null, 42, new Error('')]) {
    const status = await runSave(() => Promise.reject(why), named);
    assert.equal(status.kind, 'failed');
    assert.ok(presentSave(status)!.message.length > 0);
  }
  assert.equal(presentSave({ kind: 'idle' }), null);
  assert.equal(presentSave({ kind: 'saving' }), null);
});

test('the dialog keeps success and failure apart and announces failures (source check)', () => {
  const src = readFileSync(new URL('../web/src/components/ShareDialog.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /setDone|useState<string \| null>/, 'one string state for both outcomes is back');
  assert.match(src, /role=\{result\.role\}/);
  assert.match(src, /result\.tone/);
  assert.doesNotMatch(src, /Could not save: \$\{/, 'the failure text is built into a success element again');
  assert.match(src, /runSave\(/);
  assert.match(src, /disabled=\{busy \|\|/);
});

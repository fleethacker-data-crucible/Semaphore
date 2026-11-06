import assert from 'node:assert/strict';
import { test } from 'node:test';
import { docBytes, LIMITS, oversize, parseHoist } from '../src/core/hoist.ts';
import { createToastStore } from '../web/src/lib/toasts.ts';
import { type Command, fuzzyScore, rankCommands } from '../web/src/lib/commands.ts';

test('LIMITS: the inputs and the server agree', () => {
  assert.equal(LIMITS.titleChars, 120);
  assert.equal(LIMITS.briefChars, 2000);
  assert.equal(LIMITS.labelChars, 80);
  assert.equal(LIMITS.synonymChars, 40);
  assert.equal(LIMITS.docBytes, 2097152, 'server/Routes.ps1 SemDocMaxBytes');
  const { hoist } = parseHoist({ version: 1, id: 'h', title: 't'.repeat(500), brief: 'b'.repeat(3000), flags: [], grid: { cols: 12 } });
  assert.equal(hoist!.title.length, LIMITS.titleChars);
  assert.equal(hoist!.brief.length, LIMITS.briefChars);
});

test('size check: a document over 2 MB is caught before it is sent, with the next step', () => {
  assert.equal(oversize({ version: 1, brief: 'small' }, 'hoist'), null);
  const big = { version: 1, flags: [{ notes: ['é'.repeat(1_100_000)] }] };
  assert.ok(docBytes(big) > LIMITS.docBytes, 'counted in UTF-8 bytes');
  const msg = oversize(big, 'hoist')!;
  assert.match(msg, /This hoist is 2\.1 MB, over the 2 MB limit/);
  assert.match(msg, /Remove some flags or split the page/);
  assert.match(oversize(big, 'catalog')!, /catalog/);
});

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return { set: (fn: () => void) => (pending.set(++id, fn), id), clear: (x: unknown) => void pending.delete(x as number), fireAll: () => [...pending.values()].forEach((f) => f()), pending };
}

test('toasts: info goes after its time, errors stay until dismissed, repeats replace', () => {
  const t = fakeTimers();
  const s = createToastStore(t);
  s.push('Saved.');
  const err = s.push('Could not save', { tone: 'error', action: { label: 'Try again', run: () => undefined } });
  s.push('Saved.');
  assert.equal(s.items().length, 2, 'the same words again replace the old toast');
  t.fireAll();
  assert.deepEqual(s.items().map((x) => x.tone), ['error'], 'no error text disappears on a timer');
  s.dismiss(err);
  assert.equal(s.items().length, 0);
});

test('toasts: a flood of info never pushes an error out', () => {
  const s = createToastStore(fakeTimers());
  s.push('Broken', { tone: 'error' });
  for (let i = 0; i < 10; i++) s.push(`info ${i}`);
  assert.equal(s.items().length, 5);
  assert.ok(s.items().some((x) => x.text === 'Broken'));
});

test('command palette: fuzzy match, recency, disabled commands hidden', () => {
  const c = (id: string, label: string, extra: Partial<Command> = {}): Command => ({ id, label, group: 'Actions', run: () => undefined, ...extra });
  const list = [c('a', 'New hoist'), c('b', 'Download this hoist (JSON)'), c('c', 'Share as a report…'), c('d', 'SQL desk…', { disabled: true }), c('e', 'Labor cost', { group: 'Catalog', keywords: 'wages' })];
  assert.equal(fuzzyScore('xyz', 'New hoist'), null);
  assert.ok(fuzzyScore('nh', 'New hoist')! > 0);
  assert.equal(rankCommands(list, 'share')[0]!.id, 'c');
  assert.equal(rankCommands(list, 'dwnld')[0]!.id, 'b');
  assert.equal(rankCommands(list, 'wages')[0]!.id, 'e', 'keywords count');
  assert.ok(!rankCommands(list, 'sql').some((x) => x.id === 'd'));
  assert.deepEqual(rankCommands(list, '', ['c']).map((x) => x.id).slice(0, 2), ['c', 'a'], 'recent first with no query');
});

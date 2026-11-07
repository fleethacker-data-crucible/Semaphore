import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingLabel } from '../src/core/csv.ts';
import { impactLine } from '../src/core/impact.ts';
import { createToastStore } from '../web/src/lib/toasts.ts';

test('the reading line names the file, and adds place and size only when they say something', () => {
  assert.equal(readingLabel('a.csv', 1, 1, 100), 'Reading a.csv…');
  assert.equal(readingLabel('a.csv', 2, 3, 100), 'Reading a.csv (2 of 3)…');
  assert.equal(readingLabel('a.csv', 1, 1, 5 * 1024 * 1024), 'Reading a.csv (5 MB)…');
  assert.equal(readingLabel('a.csv', 2, 3, 5 * 1024 * 1024), 'Reading a.csv (2 of 3, 5 MB)…');
});

test('the welcome line says what the number is, and nothing for zero', () => {
  assert.equal(impactLine(0), null);
  assert.equal(impactLine(1), 'Your reviewed answers were shown 1 time this week.');
  assert.equal(impactLine(4), 'Your reviewed answers were shown 4 times this week.');
});

test('a toast keeps both of its actions', () => {
  const store = createToastStore({ set: () => 0, clear: () => undefined });
  const run = () => undefined;
  store.push('Accepted.', { action: { label: 'Undo', run }, secondary: { label: 'See it', run } });
  const t = store.items()[0]!;
  assert.equal(t.action?.label, 'Undo');
  assert.equal(t.secondary?.label, 'See it');
});

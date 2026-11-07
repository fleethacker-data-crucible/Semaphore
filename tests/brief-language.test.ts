import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateBrief, appendHint, GRAMMAR_KINDS, phrasebook, suggestNext, usedKinds } from '../src/core/intelligence/annotate.ts';
import { loadIndex } from './fixtures.ts';

const index = loadIndex();

test('suggestNext: hints are built from catalog names and offer at most three', () => {
  const hints = suggestNext(annotateBrief('', index), index);
  assert.equal(hints.length, 3);
  assert.deepEqual(hints.map((h) => h.kind), ['metric', 'field', 'range']);
  assert.equal(hints[0]!.label, '+ Labor cost');
  assert.match(hints[1]!.label, /^\+ by (Region|Status|Ship class)$/);
  assert.equal(suggestNext(annotateBrief('', index), index, { max: 1 }).length, 1);
});

test('suggestNext: never offers a kind the brief already uses, and is pure', () => {
  const a = annotateBrief('Labor cost by region for the last 12 months vs last year', index);
  const hints = suggestNext(a, index);
  for (const h of hints) assert.ok(!usedKinds(a).has(h.kind), h.kind);
  assert.deepEqual(suggestNext(a, index), hints);
});

test('every grammar kind is reachable from a hint, and each hint is read back as its kind', () => {
  let brief = '';
  const seen = new Set<string>();
  for (let round = 0; round < 8; round++) {
    const hints = suggestNext(annotateBrief(brief, index), index);
    if (!hints.length) break;
    for (const h of hints) {
      const spans = annotateBrief(appendHint(brief, h), index).spans;
      assert.ok(spans.some((s) => s.kind === h.kind), `"${appendHint(brief, h)}" should contain a ${h.kind} span`);
      seen.add(h.kind);
    }
    for (const h of hints) brief = appendHint(brief, h);
  }
  assert.deepEqual([...seen].sort(), [...GRAMMAR_KINDS].sort());
  assert.equal(annotateBrief(brief, index).unknown.length, 0);
});

test('suggestNext: faded kinds are skipped; an unknown word is taught before another field is offered', () => {
  const skip = suggestNext(annotateBrief('', index), index, { skip: ['metric', 'field'] });
  assert.ok(!skip.some((h) => h.kind === 'metric' || h.kind === 'field'));
  const withUnknown = suggestNext(annotateBrief('labor cost by readiness', index), index);
  assert.ok(!withUnknown.some((h) => h.kind === 'field'));
});

test('appendHint: joining phrases go into the first sentence, clauses after it', () => {
  assert.equal(appendHint('Labor cost.', { phrase: 'by region', clause: false }), 'Labor cost by region.');
  assert.equal(appendHint('Labor cost. Turn red over $1M.', { phrase: 'vs last year', clause: false }), 'Labor cost vs last year. Turn red over $1M.');
  assert.equal(appendHint('Labor cost by region', { phrase: 'Turn red over $1M', clause: true }), 'Labor cost by region. Turn red over $1M.');
  assert.equal(appendHint('  ', { phrase: 'labor cost', clause: false }), 'Labor cost');
});

test('phrasebook: one live example per construction, each understood as that construction', () => {
  const book = phrasebook(index);
  assert.deepEqual(book.map((p) => p.kind).sort(), [...GRAMMAR_KINDS].sort());
  for (const p of book) {
    const a = annotateBrief(p.example, index);
    assert.ok(a.spans.some((s) => s.kind === p.kind), `${p.kind}: ${p.example}`);
    assert.equal(a.unknown.length, 0, p.example);
  }
});

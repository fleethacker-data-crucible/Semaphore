import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateBrief } from '../src/core/intelligence/annotate.ts';
import { doneCount, hideShakedown, isFirstRun, markStep, onboardingState, passFirstRun, restartShakedown, shakedownActive, shakedownBrief, startShakedown, withBriefFlag } from '../web/src/lib/onboarding.ts';
import { loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

// No localStorage here: the shakedown must work from memory alone.
test('shakedown: first run, start with one step done, steps once each, hide for good, restart', () => {
  assert.equal(isFirstRun(), true);
  markStep('flip'); // nothing is running yet: ignored
  assert.equal(onboardingState(), null);
  passFirstRun();
  assert.equal(isFirstRun(), false);
  assert.equal(shakedownActive(onboardingState()), false);

  startShakedown(new Date('2026-11-06T10:00:00Z'));
  assert.deepEqual(onboardingState()!.steps, { running: '2026-11-06T10:00:00.000Z' });
  markStep('flip', new Date('2026-11-06T10:00:20Z'));
  markStep('flip', new Date('2026-11-06T10:00:40Z')); // once only
  assert.equal(onboardingState()!.steps.flip, '2026-11-06T10:00:20.000Z');
  assert.equal(doneCount(onboardingState()!), 2);

  hideShakedown();
  markStep('accept'); // ignored once hidden
  assert.equal(onboardingState()!.steps.accept, undefined);
  assert.equal(shakedownActive(onboardingState()), false);

  restartShakedown();
  assert.equal(shakedownActive(onboardingState()), true);
  assert.equal(doneCount(onboardingState()!), 1);
});

test('shakedown state helpers', () => {
  const s = { steps: { running: 'x', flip: 'y' }, dismissed: false, startedAt: 'x' };
  assert.equal(doneCount(s), 2);
  assert.equal(shakedownActive(s), true);
  assert.equal(shakedownActive({ ...s, dismissed: true }), false);
  assert.equal(shakedownActive(null), false);
});

test('"Type it for me" writes a top-10 brief in the catalog\'s own words, and Semaphore understands all of it', () => {
  const brief = shakedownBrief(loadCatalog());
  assert.equal(brief, 'Top 10 hulls by labor cost');
  const a = annotateBrief(brief, loadIndex());
  assert.equal(a.unknown.length, 0);
  assert.deepEqual(a.spans.map((s) => s.kind).sort(), ['field', 'metric', 'rank']);
});

test('the typed flag goes in at the top left and pushes the page down', () => {
  const h = loadHoist();
  const out = withBriefFlag(h, 'new-1', 'Top 10 hulls by labor cost');
  const f = out.flags.find((x) => x.id === 'new-1')!;
  assert.deepEqual(f.layout, { x: 0, y: 0, w: 6, h: 4 });
  assert.equal(f.status, 'empty');
  assert.equal(f.brief, 'Top 10 hulls by labor cost');
  assert.equal(out.flags.length, h.flags.length + 1);
  // Nothing overlaps.
  for (const a of out.flags) for (const b of out.flags) {
    if (a === b) continue;
    const overlap = a.layout.x < b.layout.x + b.layout.w && b.layout.x < a.layout.x + a.layout.w && a.layout.y < b.layout.y + b.layout.h && b.layout.y < a.layout.y + a.layout.h;
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
});

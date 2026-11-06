import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Flag } from '../src/core/hoist.ts';
import { configureSkills, readSignalBook, readWatchLog, recordSkill, recordWatch, skillsInFlag } from '../web/src/lib/skills.ts';
import { socialSettings } from '../web/src/lib/playbook.ts';
import { SIGNALS } from '../web/src/lib/skills.ts';

// A tiny localStorage for Node, so the record paths can be exercised.
function withStorage(fn: () => void) {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    fn();
  } finally {
    delete g.localStorage;
  }
}

const flag = (patch: Partial<Flag>): Flag => ({ id: 'f', kind: 'bar', title: '', brief: '', layout: { x: 0, y: 0, w: 4, h: 4 }, binding: { metrics: ['m'], dimensions: [], filters: [] }, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'ready', notes: [], ...patch });

test('skills: first use only, no counts', () => {
  withStorage(() => {
    configureSkills({ enabled: true });
    assert.equal(recordSkill('clean'), true);
    assert.equal(recordSkill('clean'), false, 'nothing to grind');
    const book = readSignalBook();
    assert.deepEqual(Object.keys(book.earned), ['clean']);
    assert.ok(!('count' in book.earned.clean!));
  });
});

test('skills: switched off, or with no storage, every call is a safe no-op', () => {
  withStorage(() => {
    configureSkills({ enabled: false });
    assert.equal(recordSkill('kit'), false);
    recordWatch('accept');
    assert.deepEqual(readSignalBook().earned, {});
    assert.deepEqual(readWatchLog(), {});
    configureSkills({ enabled: true });
  });
  assert.equal(recordSkill('kit'), false); // no localStorage at all in Node
  assert.doesNotThrow(() => recordWatch('review'));
});

test('skills: an accepted flag names the capabilities it uses', () => {
  assert.deepEqual(skillsInFlag(flag({ status: 'drafted' })), []);
  assert.deepEqual(
    skillsInFlag(flag({ binding: { metrics: ['m'], dimensions: [], filters: [], compare: 'previous-year', share: true }, behavior: { onClick: 'filter-page', ignore: ['region'], thresholds: [{ metric: 'm', op: 'gt', value: 1, tone: 'bad' }] } })),
    ['accept', 'compare', 'share', 'click-filter', 'rule', 'ignore'],
  );
});

test('watch: a meaningful act stands this week', () => {
  withStorage(() => {
    configureSkills({ enabled: true });
    recordWatch('answer');
    assert.deepEqual(Object.values(readWatchLog()), ['stood']);
  });
});

test('signal book: 20 flags A to T, each with how-to text and a Try it', () => {
  assert.equal(SIGNALS.length, 20);
  assert.deepEqual(SIGNALS.map((s) => s.letter).join(''), 'ABCDEFGHIJKLMNOPQRST');
  assert.equal(new Set(SIGNALS.map((s) => s.kind)).size, 20);
  for (const s of SIGNALS) {
    assert.ok(s.how.length > 10, s.letter);
    assert.ok(s.try({ m: 'Labor cost', f: 'Region' }), s.letter);
    assert.doesNotMatch(`${s.title} ${s.how}`, /qualif|PQS/i);
  }
});

test('social settings: on unless the deployment says false', () => {
  assert.deepEqual(socialSettings(undefined), { signalBook: true, impact: true, teamLog: true, showAskers: true, bz: true });
  assert.deepEqual(socialSettings({ bz: false, impact: 'no' }), { signalBook: true, impact: true, teamLog: true, showAskers: true, bz: false });
});

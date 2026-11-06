import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hoist } from '../src/core/hoist.ts';
import { entryId, learnFromHoist, newQuestion, type PlaybookEntry } from '../src/core/playbook.ts';
import type { TeamStyle } from '../src/core/style.ts';
import { acceptFacts, type AcceptInput, collapseAccepts, whenAsked } from '../web/src/lib/accept.ts';
import { loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const now = new Date('2026-11-06T12:00:00Z');

/** The example page with one flag still a draft, and an empty playbook. */
function page(draftId = 'bar-region'): Hoist {
  const h = loadHoist();
  return { ...h, flags: h.flags.map((f) => (f.id === draftId ? { ...f, status: 'drafted' as const } : f)) };
}
function input(h: Hoist, over: Partial<AcceptInput> = {}): AcceptInput {
  return { hoist: h, index, user: 'ana', entries: [], questions: [], style: null, ...over };
}
/** Everything else on the page already in the playbook. */
function othersSaved(h: Hoist): PlaybookEntry[] {
  return learnFromHoist([], h, index, 'ana', now);
}

test('accept: the headline says what happens, in the flag\'s own words', () => {
  const h = page();
  const f = acceptFacts(input(h, { entries: othersSaved(h) }), 'bar-region', now);
  assert.equal(f.inPlaybook, true);
  assert.equal(f.headline, 'Accepted. In the playbook. Leadership can now ask “Labor cost by region”.');
  assert.equal(f.entry, entryId(h.id, 'bar-region'));
  assert.equal(f.learnt?.status, 'active');
});

test('accept: a leadership question in the same words is the bonus line, before anything else', () => {
  const h = page();
  const brief = h.flags.find((x) => x.id === 'bar-region')!.brief;
  const q = { ...newQuestion(brief, 'Cdr Hale', 'drafted', [], new Date('2026-11-03T09:00:00Z')) };
  const f = acceptFacts(input(h, { entries: othersSaved(h), questions: [q] }), 'bar-region', now);
  assert.equal(f.bonusKind, 'question');
  assert.equal(f.bonus, "This answers Cdr Hale's question from Tuesday.");
  assert.equal(f.answered?.[0]?.status, 'answered');
});

test('accept: the first reviewed answer for a measure reports coverage, counting the rest of the page as saved', () => {
  const h = page('kpi-hulls');
  const f = acceptFacts(input(h), 'kpi-hulls', now);
  assert.equal(f.bonusKind, 'coverage');
  // Work orders, labor cost and average days open come from the other accepted flags on the page.
  assert.equal(f.bonus, 'First reviewed answer for Hulls affected: coverage now 4 of 5 measures.');
  // A measure that already has reviewed answers gets no coverage line.
  const again = acceptFacts(input(page('bar-region'), { entries: othersSaved(page('bar-region')) }), 'bar-region', now);
  assert.notEqual(again.bonusKind, 'coverage');
});

test('accept: the team style line only when the card has a rule this flag follows', () => {
  const h = page();
  const style = { chart: { category: { key: 'chart.category', value: 'bar', evidence: 3, of: 3 } }, grain: null, topN: null, window: null, redRules: {}, off: [], learnedFrom: 3 } as TeamStyle;
  const f = acceptFacts(input(h, { entries: othersSaved(h), style }), 'bar-region', now);
  assert.equal(f.bonus, 'Matches the team style card.');
  assert.equal(acceptFacts(input(h, { entries: othersSaved(h), style: { ...style, off: ['chart.category'] } }), 'bar-region', now).bonus, null);
  assert.equal(acceptFacts(input(h, { entries: othersSaved(h), style: { ...style, chart: { category: { ...style.chart.category!, value: 'pie' } } } }), 'bar-region', now).bonus, null);
});

test('accept: honest about pages and flags that stay out of the playbook', () => {
  const h = page();
  assert.match(acceptFacts(input({ ...h, experiment: true }), 'bar-region', now).headline, /Try freely/);
  const noLearn = { ...h, flags: h.flags.map((f) => (f.id === 'bar-region' ? { ...f, learn: false } : f)) };
  assert.equal(acceptFacts(input(noLearn), 'bar-region', now).inPlaybook, false);
  const filter = { ...h, flags: h.flags.map((f) => (f.id === 'filter-class' ? { ...f, status: 'drafted' as const } : f)) };
  assert.deepEqual(acceptFacts(input(filter), 'filter-class', now), { inPlaybook: false, headline: 'Accepted.', bonus: null, bonusKind: null, entry: null });
});

test('toast fatigue: after five accepts in ten minutes they collapse into one summary', () => {
  let times: number[] = [];
  const t0 = now.getTime();
  const out: boolean[] = [];
  for (let i = 0; i < 7; i++) {
    const r = collapseAccepts(times, t0 + i * 60000);
    times = r.times;
    out.push(r.collapse);
  }
  assert.deepEqual(out, [false, false, false, false, false, true, true]);
  assert.equal(collapseAccepts(times, t0 + 30 * 60000).collapse, false);
});

test('whenAsked: a weekday within the week, a date before that', () => {
  assert.equal(whenAsked('2026-11-03T09:00:00Z', now), 'Tuesday');
  assert.equal(whenAsked('2026-10-03T09:00:00Z', now), '3 Oct');
  assert.equal(whenAsked('nonsense', now), 'earlier');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addBz,
  type AskLog,
  awayWeeks,
  bumpAsk,
  bzCount,
  expiredIds,
  hasBz,
  impactFor,
  isAskLog,
  isBzLog,
  isoWeek,
  lastWeeks,
  markAway,
  markStood,
  spark,
  teamWeek,
  watchStrip,
  weekCue,
  weekStart,
  withUses,
} from '../src/core/impact.ts';
import { addAsker, byDemand, learnFromHoist, newQuestion, type PlaybookEntry, withAskers } from '../src/core/playbook.ts';
import { loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const now = new Date('2026-11-06T12:00:00Z'); // a Friday, ISO week 2026-W45

test('ISO weeks: year boundaries, Mondays and runs of weeks', () => {
  assert.equal(isoWeek(now), '2026-W45');
  assert.equal(isoWeek(new Date('2021-01-03T10:00:00Z')), '2020-W53');
  assert.equal(isoWeek(new Date('2024-12-30T10:00:00Z')), '2025-W01');
  assert.equal(weekStart('2026-W45').toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(isoWeek(weekStart('2020-W53')), '2020-W53');
  assert.deepEqual(lastWeeks(now, 3), ['2026-W43', '2026-W44', '2026-W45']);
  assert.deepEqual(lastWeeks(new Date('2026-01-02T00:00:00Z'), 2), ['2025-W52', '2026-W01']);
});

test('ask logs: one file per person per week, counts only, uses read from them', () => {
  let logs: AskLog[] = [];
  const add = (user: string, id: string, at: Date) => {
    const l = bumpAsk(logs, user, id, at);
    logs = [...logs.filter((x) => x.id !== l.id), l];
    return l;
  };
  const a = add('cdr.hale', 'e1', now);
  add('cdr.hale', 'e1', now);
  add('lt.ng', 'e1', now);
  add('cdr.hale', 'e2', new Date('2026-10-28T09:00:00Z'));
  assert.equal(a.id, 'asks-cdr_hale-2026-W45');
  assert.equal(logs.length, 3, 'two people this week, one file each; one older week');
  assert.deepEqual(logs.find((l) => l.id === 'asks-cdr_hale-2026-W45')!.counts, { e1: 2 });
  assert.ok(logs.every(isAskLog));
  assert.deepEqual(Object.keys(a).sort(), ['counts', 'id', 'kind', 'updated', 'user', 'version', 'week'], 'nothing but counts and the week');
  assert.equal(isAskLog({ ...a, counts: { e1: 'x' } }), false);

  const entries = learnFromHoist([], loadHoist(), index, 'dana', now);
  const e = { ...entries[0]!, id: 'e1' } as PlaybookEntry;
  const [used] = withUses([e, { ...entries[1]!, id: 'e9', lastUsed: '2026-01-01T00:00:00Z' } as PlaybookEntry], logs);
  assert.equal(used!.uses, 3);
  assert.equal(used!.lastUsed, '2026-11-02T00:00:00.000Z', 'nothing finer than a week');
  const unused = withUses([{ ...entries[1]!, id: 'e9', uses: 7, lastUsed: '2026-01-01T00:00:00Z' } as PlaybookEntry], logs)[0]!;
  assert.equal(unused.uses, 0);
  assert.equal(unused.lastUsed, undefined);

  assert.deepEqual(spark(logs, 'e1', now, 3), [0, 0, 3]);
  assert.deepEqual(spark(logs, new Set(['e1', 'e2']), now, 3), [0, 1, 3]);
});

test('old weekly files are removed by their owner only, after 26 weeks', () => {
  const docs = [
    { id: 'asks-dana-2026-W01', week: '2026-W01', user: 'dana' },
    { id: 'asks-dana-2026-W40', week: '2026-W40', user: 'dana' },
    { id: 'asks-lee-2026-W01', week: '2026-W01', user: 'lee' },
  ];
  assert.deepEqual(expiredIds(docs, 'dana', now), ['asks-dana-2026-W01']);
});

test('Bravo Zulu: once per entry per person per week', () => {
  const first = addBz([], 'cdr', 'e1', now)!;
  assert.ok(isBzLog(first));
  assert.equal(addBz([first], 'cdr', 'e1', now), null, 'idempotent');
  const second = addBz([first], 'cdr', 'e2', now)!;
  assert.deepEqual(second.entries, ['e1', 'e2']);
  assert.ok(hasBz([second], 'cdr', 'e1', now));
  assert.equal(hasBz([second], 'lee', 'e1', now), false);
  const next = addBz([second], 'cdr', 'e1', new Date('2026-11-10T09:00:00Z'));
  assert.ok(next && next.id !== second.id, 'a new week is a new file');
  assert.equal(bzCount([second, addBz([], 'lee', 'e1', now)!], new Set(['e1']), '2026-W45'), 2);
});

test('impact: only when positive or actionable, and only for the analyst\'s own entries', () => {
  const entries = learnFromHoist([], loadHoist(), index, 'dana', now);
  const mine = entries[0]!;
  const logs: AskLog[] = [
    { version: 1, kind: 'asks', id: 'a1', user: 'cdr', week: '2026-W45', counts: { [mine.id]: 5, other: 9 }, updated: '' },
    { version: 1, kind: 'asks', id: 'a2', user: 'cdr', week: '2026-W44', counts: { [mine.id]: 2 }, updated: '' },
  ];
  const i = impactFor(entries, logs, [], 'dana', 2, now)!;
  assert.equal(i.thisWeek, 5);
  assert.equal(i.lastWeek, 2);
  assert.deepEqual(i.top, { title: mine.title, count: 5 });
  assert.equal(i.waiting, 2);
  assert.equal(impactFor(entries, [], [], 'dana', 0, now), null, 'a quiet week with nothing waiting shows nothing');
  assert.equal(impactFor(entries, logs, [], 'lee', 0, now), null, 'never someone else\'s numbers');
});

test('the team week: new answers with credit, coverage gained, gaps; no per-person counts', () => {
  const before = learnFromHoist([], loadHoist(), index, 'dana', new Date('2026-10-01T00:00:00Z'));
  const fresh = before.slice(0, 1).map((e) => ({ ...e, id: 'new-one', acceptedBy: 'lee', acceptedAt: '2026-11-04T10:00:00Z' }));
  const old = before.slice(1);
  const q = { ...newQuestion('backlog?', 'cdr', 'none', [], new Date('2026-10-20T00:00:00Z')), status: 'answered' as const, updated: '2026-11-03T00:00:00Z' };
  const w = teamWeek([...old, ...fresh], [q], index, now);
  assert.equal(w.week, '2026-W45');
  assert.deepEqual(w.added.map((a) => [a.title, a.by]), [[fresh[0]!.title, 'lee']]);
  assert.equal(w.answered, 1);
  assert.equal(w.total, index.catalog.metrics.length);
  assert.ok(w.covered <= w.total && w.gained >= 0);
  assert.equal(w.gaps.length, w.total - w.covered);
  assert.ok(!('byPerson' in w));
  const quiet = teamWeek(old, [], index, now);
  assert.equal(quiet.added.length, 0);
  assert.ok(quiet.gaps.length > 0, 'an empty week shows gaps, not zeros');
});

test('the watch log: stood weeks, away weeks excused, never overwriting a stood week', () => {
  const weeks = awayWeeks({ from: '2026-10-22', until: '2026-11-03' });
  assert.deepEqual(weeks, ['2026-W43', '2026-W44', '2026-W45']);
  let log = markStood({}, now);
  log = markAway(log, weeks);
  assert.deepEqual(log, { '2026-W45': 'stood', '2026-W43': 'away', '2026-W44': 'away' });
  const strip = watchStrip(log, now, 4);
  assert.deepEqual(strip.map((s) => s.state), ['quiet', 'away', 'away', 'stood']);
});

test('the Monday cue appears only with real work', () => {
  assert.equal(weekCue(0, 0), null);
  assert.equal(weekCue(2, 1), '2 answers need review and 1 question is waiting. About 5 minutes.');
  assert.equal(weekCue(1, 0), '1 answer needs review. About 5 minutes.');
});

test('questions: every asker counted, queue sorted by demand then age', () => {
  const q1 = newQuestion('Labor cost by ship class vs last year', 'cdr.hale', 'none', [], new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual(q1.askers, ['cdr.hale']);
  assert.equal(q1.askCount, 1);
  let q = addAsker(q1, 'lt.ng', now);
  q = addAsker(q, 'cdr.hale', now);
  assert.deepEqual(q.askers, ['lt.ng', 'cdr.hale'], 'the most recent asker last');
  assert.equal(q.askCount, 3);
  const legacy = withAskers({ ...q1, askers: undefined, askCount: undefined } as never);
  assert.deepEqual([legacy.askers, legacy.askCount], [['cdr.hale'], 1]);
  const older = newQuestion('Backlog by region', 'x', 'none', [], new Date('2026-10-01T00:00:00Z'));
  const newer = newQuestion('Parts cost', 'y', 'none', [], new Date('2026-11-05T00:00:00Z'));
  assert.deepEqual([newer, older, q].sort(byDemand).map((x) => x.title), [q.title, older.title, newer.title]);
});

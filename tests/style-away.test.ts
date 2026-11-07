// The team style card (src/core/style.ts) and away mode (src/core/away.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAway, isAwayNotice, isReturned, markBack, newAwayNotice, whileYouWereOut } from '../src/core/away.ts';
import type { Binding, FlagKind, Hoist } from '../src/core/hoist.ts';
import { draftFlag, LocalRulesProvider } from '../src/core/intelligence/index.ts';
import type { FlagDraft } from '../src/core/intelligence/contract.ts';
import { learnFromHoist, type PlaybookEntry, type QuestionItem } from '../src/core/playbook.ts';
import { applyTeamStyle, describeStyle, emptyOverrides, isStyleOverrides, learnStyle, shapeOf } from '../src/core/style.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();

let n = 0;
function entry(kind: FlagKind, binding: Partial<Binding>, extra: Partial<PlaybookEntry> = {}): PlaybookEntry {
  n++;
  return {
    version: 1,
    id: `h--f${n}`,
    title: `Entry ${n}`,
    question: `question ${n}`,
    phrasings: [],
    kind,
    binding: { metrics: ['labor_cost'], dimensions: [], filters: [], ...binding },
    thresholds: [],
    pageFilters: [],
    source: 'maint',
    table: 'jobs',
    hoist: { id: 'h', title: 'H' },
    acceptedBy: 'analyst',
    acceptedAt: `2026-10-0${(n % 9) + 1}T10:00:00.000Z`,
    revisions: 0,
    status: 'active',
    uses: 0,
    updated: '2026-10-01T10:00:00.000Z',
    ...extra,
  };
}

const region = [{ field: 'jobs.region' }];
const month = [{ field: 'jobs.opened', grain: 'month' as const }];
const last12 = [{ field: 'jobs.opened', op: 'last' as const, values: [12], unit: 'month' as const }];
const red = [{ metric: 'labor_cost', op: 'gt' as const, value: 3_000_000, tone: 'bad' as const }];

function teamEntries(): PlaybookEntry[] {
  return [
    entry('line', { dimensions: month }, { pageFilters: last12 }),
    entry('line', { dimensions: month }, { pageFilters: last12 }),
    entry('area', { dimensions: month }, { pageFilters: last12 }),
    entry('bar', { dimensions: region, limit: 10 }, { thresholds: red }),
    entry('bar', { dimensions: region, limit: 10 }),
    entry('pie', { dimensions: region }),
    entry('kpi', {}),
  ];
}

test('shape of a binding: number, trend, one or two breakdowns', () => {
  assert.equal(shapeOf({ metrics: ['labor_cost'], dimensions: [], filters: [] }, index), 'number');
  assert.equal(shapeOf({ metrics: ['labor_cost'], dimensions: month, filters: [] }, index), 'trend');
  assert.equal(shapeOf({ metrics: ['labor_cost'], dimensions: region, filters: [] }, index), 'category');
  assert.equal(shapeOf({ metrics: ['labor_cost'], dimensions: [...region, { field: 'jobs.ship_class' }], filters: [] }, index), 'two-categories');
});

test('the card learns chart habits, grain, top N, window and colour rules, with their evidence', () => {
  const s = learnStyle(teamEntries(), index);
  assert.equal(s.chart.trend?.value, 'line');
  assert.deepEqual([s.chart.trend?.evidence, s.chart.trend?.of], [2, 3]);
  assert.equal(s.chart.category?.value, 'bar');
  assert.equal(s.chart.number, undefined, 'one KPI is not a habit');
  assert.equal(s.grain?.value, 'month');
  assert.equal(s.topN?.value, 10);
  assert.deepEqual(s.window?.value, { count: 12, unit: 'month' });
  assert.deepEqual(s.redRules.labor_cost?.value, red);
  assert.equal(s.learnedFrom, 7);
  const lines = describeStyle(s, index);
  assert.ok(lines.some((l) => /trends over time as a line \(2 of 3 accepted flags\)/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /top 10/.test(l)));
});

test('needs-review and retired entries do not count', () => {
  const list = teamEntries().map((e) => (e.kind === 'line' ? { ...e, status: 'retired' as const } : e));
  assert.equal(learnStyle(list, index).chart.trend, undefined);
});

test('analysts can switch a rule off or pin a value; bad pins are ignored', () => {
  const s = learnStyle(teamEntries(), index, { ...emptyOverrides(), off: ['topN'], pinned: { 'chart.number': 'kpi', grain: 'quarter', 'chart.trend': 'pie', topN: 1000 } });
  assert.equal(s.chart.number?.value, 'kpi');
  assert.equal(s.chart.number?.pinned, true);
  assert.equal(s.grain?.value, 'quarter');
  assert.equal(s.chart.trend?.value, 'line', 'a pie cannot draw a trend, so that pin is ignored');
  assert.equal(s.topN?.value, 10, 'an out-of-range pin is ignored');
  assert.ok(!describeStyle(s, index).some((l) => /top 10/.test(l)), 'an "off" rule is not described');
  assert.ok(isStyleOverrides(emptyOverrides()));
  assert.ok(!isStyleOverrides({ version: 1, id: 'other' }));
});

const draft = (kind: FlagKind, binding: Binding): FlagDraft => ({ kind, title: 't', binding, behavior: { onClick: 'none', ignore: [], thresholds: [] }, confidence: 0.8, notes: [] });

test('applying the style fills only what the brief left open, and says so', () => {
  const s = learnStyle(teamEntries(), index);
  const out = applyTeamStyle(draft('table', { metrics: ['labor_cost'], dimensions: region, filters: [] }), s, index, { auto: true, brief: 'labor cost by region' });
  assert.equal(out.draft.kind, 'bar');
  assert.equal(out.draft.binding?.limit, 10);
  assert.deepEqual(out.draft.binding?.sort, { by: 'labor_cost', dir: 'desc' });
  assert.deepEqual(out.draft.behavior.thresholds, red);
  assert.equal(out.applied.length, 3);
  assert.ok(out.draft.notes.every((x) => x.startsWith('Team style: ')));

  const said = applyTeamStyle(draft('pie', { metrics: ['labor_cost'], dimensions: region, filters: [] }), s, index, { auto: true, brief: 'labor cost by region as a pie, top 3' });
  assert.equal(said.draft.kind, 'pie', 'a chart word in the brief wins');
  assert.equal(said.draft.binding?.limit, undefined, 'a top N in the brief wins');

  const notAuto = applyTeamStyle(draft('table', { metrics: ['labor_cost'], dimensions: region, filters: [] }), s, index, { auto: false, brief: 'labor cost by region' });
  assert.equal(notAuto.draft.kind, 'table', 'the analyst chose the kind');

  const trend = applyTeamStyle(draft('line', { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened' }], filters: [] }), s, index, { auto: true, brief: 'labor cost over time' });
  assert.equal(trend.draft.binding?.dimensions[0]?.grain, 'month');
});

test('draftFlag sends the style to the provider and applies it to a local fallback', async () => {
  const s = learnStyle(teamEntries(), index);
  let seen: unknown = null;
  const failing = { id: 'remote', label: 'Remote', local: false, ping: async () => '', draftFlag: async (r: unknown) => { seen = r; throw new Error('down'); }, draftHoist: async () => { throw new Error('down'); } };
  const target = { ...flag(hoist, 'empty-1'), brief: 'labor cost by region' };
  const out = await draftFlag(failing, hoist, target, index, { auto: true, style: s });
  assert.ok(Array.isArray((seen as { teamStyle?: string[] }).teamStyle));
  assert.equal(out.providerId, 'local-rules');
  assert.equal(out.draft.binding?.limit, 10, 'the team style finished the fallback draft');
  const plain = await draftFlag(new LocalRulesProvider(index), hoist, target, index, { auto: true });
  assert.equal(plain.draft.binding?.limit, undefined, 'no style, no change');
});

test('experiment pages are never learnt from', () => {
  const accepted: Hoist = { ...hoist, flags: hoist.flags.map((f) => ({ ...f, status: f.binding ? ('ready' as const) : f.status })) };
  assert.ok(learnFromHoist([], accepted, index, 'analyst').length > 0);
  assert.equal(learnFromHoist([], { ...accepted, experiment: true }, index, 'analyst').length, 0);
});

const q = (id: string, askedAt: string, shown: 'drafted' | 'none', status: QuestionItem['status'] = 'open'): QuestionItem => ({ version: 1, id, title: id, askedBy: 'cdr', askedAt, askers: ['cdr'], askCount: 1, shown, notes: [], status, updated: askedAt });

test('away notices: validation, dates and being back', () => {
  const nt = newAwayNotice('J.Smith', '2026-11-02', '2026-11-06', ' Back Monday ', new Date('2026-10-30T09:00:00Z'));
  assert.equal(nt.id, 'away-j_smith');
  assert.equal(nt.note, 'Back Monday');
  assert.ok(isAwayNotice(nt));
  assert.ok(!isAwayNotice({ ...nt, from: 'Monday' }));
  assert.throws(() => newAwayNotice('a', '2026-11-06', '2026-11-02', ''), /before the start/);
  assert.equal(isAway(nt, new Date('2026-11-01T12:00:00Z')), false);
  assert.equal(isAway(nt, new Date('2026-11-04T12:00:00Z')), true);
  assert.equal(isAway(nt, new Date('2026-11-06T23:00:00Z')), true, 'out to the end of the last day');
  assert.equal(isReturned(nt, new Date('2026-11-07T08:00:00Z')), true);
  const back = markBack(nt, new Date('2026-11-05T08:00:00Z'));
  assert.equal(isAway(back, new Date('2026-11-05T12:00:00Z')), false);
});

test('the while-you-were-out digest covers the period and what needs the analyst', () => {
  const nt = markBack(newAwayNotice('a', '2026-11-02', '2026-11-06', ''), new Date('2026-11-07T08:00:00Z'));
  const questions = [
    q('before', '2026-11-01T10:00:00Z', 'drafted'),
    q('drafted', '2026-11-03T10:00:00Z', 'drafted'),
    q('nothing', '2026-11-04T10:00:00Z', 'none'),
    q('handled', '2026-11-05T10:00:00Z', 'drafted', 'answered'),
  ];
  const used = entry('bar', { dimensions: region }, { uses: 4, lastUsed: '2026-11-04T09:00:00Z' });
  const old = entry('bar', { dimensions: region }, { uses: 9, lastUsed: '2026-10-20T09:00:00Z' });
  const review = entry('line', { dimensions: month }, { status: 'needs-review', review: { reason: 'catalog changed', at: '2026-11-03T00:00:00Z' } });
  const d = whileYouWereOut(nt, questions, [used, old, review]);
  assert.deepEqual(d.asked.map((x) => x.id), ['handled', 'nothing', 'drafted']);
  assert.deepEqual(d.drafted.map((x) => x.id), ['drafted']);
  assert.deepEqual(d.waiting.map((x) => x.id), ['nothing']);
  assert.deepEqual(d.usedEntries.map((e) => e.id), [used.id]);
  assert.deepEqual(d.needsReview.map((e) => e.id), [review.id]);
  assert.equal(d.actionNeeded, true);
  assert.equal(d.to, '2026-11-07');
});

test('recurring reports: a rhythm is noticed, editions fall due once per date, never before the schedule', async () => {
  const r = await import('../src/core/reports.ts');
  const mondays = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const wed = new Date('2026-10-28T09:00:00Z');
  assert.deepEqual(r.detectCadence(mondays, wed), { every: 'week', weekday: 1 });
  assert.equal(r.describeCadence({ every: 'week', weekday: 1 }), 'every Monday');
  assert.equal(r.detectCadence(['2026-10-05', '2026-10-19'], wed), null, 'twice is not a rhythm');
  const daily: string[] = [];
  for (let i = 1; i <= 20; i++) daily.push(new Date(wed.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  assert.equal(r.detectCadence(daily, wed), null, 'a page opened most days is not a report');
  assert.deepEqual(r.detectCadence(['2026-07-01', '2026-08-03', '2026-09-02', '2026-10-01'], wed), { every: 'month', day: 1 });
  assert.equal(r.describeCadence({ every: 'month', day: 2 }), 'on the 2nd of each month');

  const s = r.newSchedule('h1', 'Monday brief', 'jdoe', { every: 'week', weekday: 1 }, new Date('2026-10-20T10:00:00Z'));
  assert.equal(r.editionDue(s, wed), '2026-10-26');
  assert.equal(r.editionDue({ ...s, lastEdition: '2026-10-26' }, wed), null);
  assert.equal(r.editionDue(s, new Date('2026-10-19T10:00:00Z')), null, 'not before the schedule began');
  assert.equal(r.lastScheduled({ every: 'month', day: 15 }, new Date('2026-10-10T00:00:00Z')), '2026-09-15');

  const log = r.noteOpened(undefined, 'h1', 'Monday brief', 'jdoe', wed)!;
  assert.deepEqual(log.opened, ['2026-10-28']);
  assert.equal(r.noteOpened(log, 'h1', 'Monday brief', 'jdoe', wed), null, 'once a day');
  assert.ok(r.isReportSchedule(s) && r.isUsageLog(log));
  assert.equal(r.isReportSchedule({ ...s, cadence: { every: 'week', weekday: 9 } }), false);
});

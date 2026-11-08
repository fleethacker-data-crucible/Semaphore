import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexCatalog } from '../src/core/catalog.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { runPlan } from '../src/core/engine.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { planFlag } from '../src/core/planner.ts';
import {
  addPhrasing,
  answerQuestion,
  checkHealth,
  coverage,
  entryId,
  flagForReview,
  followUps,
  isEntry,
  learnFromHoist,
  newQuestion,
  normalizeQuestion,
  type PlaybookEntry,
  resolveQuestions,
  retireEntry,
} from '../src/core/playbook.ts';
import { answerFromSnapshots, isStale, type Snapshot, snapshotPlan, takeSnapshot } from '../src/core/snapshot.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { flag, loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const today = new Date('2026-10-26T12:00:00Z');
const tables = fleetSampleRows(today);

function learnt(h: Hoist = hoist, entries: PlaybookEntry[] = []): PlaybookEntry[] {
  return learnFromHoist(entries, h, index, 'dana', today);
}

const run = async (plan: Parameters<typeof runPlan>[0]) => runPlan(plan, index, tables, today);

test('learning: accepted flags become entries; drafts, pickers, notes and "do not learn" do not', () => {
  const draft: Flag = { ...flag(hoist, 'bar-region'), id: 'd1', status: 'drafted' };
  const secret: Flag = { ...flag(hoist, 'kpi-cost'), id: 's1', learn: false };
  const h = { ...hoist, flags: [...hoist.flags, draft, secret] };
  const entries = learnt(h);
  assert.deepEqual(entries.map((e) => e.id).sort(), ['fleet-maintenance--bar-region', 'fleet-maintenance--kpi-cost', 'fleet-maintenance--kpi-hulls', 'fleet-maintenance--kpi-orders', 'fleet-maintenance--line-trend']);
  const bar = entries.find((e) => e.id === 'fleet-maintenance--bar-region')!;
  assert.equal(bar.question, 'Labor cost by region. Clicking a bar filters the page.');
  assert.equal(bar.acceptedBy, 'dana');
  assert.equal(bar.table, 'ops.work_orders');
  assert.deepEqual(bar.pageFilters, hoist.filters);
  assert.equal(bar.status, 'active');
  assert.ok(entries.every(isEntry));
  // The line ignores the region filter, but the window is still its window.
  assert.equal(entries.find((e) => e.id.endsWith('line-trend'))!.pageFilters.length, 1);
});

test('learning: nothing changes when nothing changed; a changed flag is a new revision', () => {
  const first = learnt();
  assert.deepEqual(learnt(hoist, first), []);
  const changed = { ...hoist, flags: hoist.flags.map((f) => (f.id === 'bar-region' ? { ...f, binding: { ...f.binding!, limit: 3 } } : f)) };
  const again = learnFromHoist(first, changed, index, 'sam', today);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.revisions, 1);
  assert.equal(again[0]!.acceptedBy, 'sam');
  // A retired entry is not brought back by accepting the flag again.
  const retired = first.map((e) => (e.id === again[0]!.id ? retireEntry(e, 'sam', 'wrong measure', today) : e));
  assert.deepEqual(learnFromHoist(retired, changed, index, 'sam', today), []);
  assert.equal(entryId('h x', 'f/1'), 'h_x--f_1');
});

test('health: catalog changes and long disuse are flagged, with reasons; fixes clear them', () => {
  const entries = learnt();
  const without = { ...loadCatalog(), metrics: loadCatalog().metrics.filter((m) => m.key !== 'labor_cost') };
  const flagged = checkHealth(entries, indexCatalog(without), today);
  assert.deepEqual(flagged.map((e) => e.id).sort(), ['fleet-maintenance--bar-region', 'fleet-maintenance--kpi-cost']);
  assert.ok(flagged.every((e) => e.status === 'needs-review' && /no longer has/.test(e.review!.reason)));
  const later = new Date('2027-06-01T00:00:00Z');
  assert.ok(checkHealth(entries, index, later).every((e) => /months/.test(e.review!.reason)));
  // Back in the catalog, the flag clears; a person's own "needs review" stays until they clear it.
  const back = checkHealth(flagged, index, today);
  assert.ok(back.every((e) => e.status === 'active' && !e.review));
  const marked = flagForReview(entries[0]!, 'lee', 'check the definition', today);
  assert.deepEqual(checkHealth([marked], index, today), []);
});

test('answers: same words, exact binding, re-addable, drafted, none', () => {
  const entries = learnt();
  const words = answerQuestion('labor cost by region. clicking a bar filters the page', entries, index);
  assert.equal(words.trust, 'reviewed');
  assert.match(words.reasons.join(' '), /same words/);

  const exact = answerQuestion('Total labor cost', entries, index);
  assert.equal(exact.trust, 'reviewed');
  assert.equal(exact.entry?.id, 'fleet-maintenance--kpi-cost');
  assert.deepEqual(exact.filters, hoist.filters, 'the reviewed window comes with it');
  assert.equal(exact.flag.behavior.thresholds.length, 1, 'and its colour rule');

  // Labor cost by ship class: no flag shows it, and no entry holds ship class yet.
  const drafted = answerQuestion('Labor cost by ship class', entries, index);
  assert.equal(drafted.trust, 'drafted');
  assert.deepEqual(drafted.filters, hoist.filters, "borrows the team's usual window");
  assert.match(drafted.reasons[0]!, /No analyst has reviewed/);

  const none = answerQuestion('How many bananas?', entries, index);
  assert.equal(none.trust, 'none');

  // A reviewed flag by region and ship class answers "by region" by re-adding it.
  const both: Flag = { ...flag(hoist, 'bar-region'), id: 'both', brief: 'Labor cost by region and ship class', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.ship_class' }], filters: [] } };
  const more = learnt({ ...hoist, flags: [both] });
  const adjusted = answerQuestion('Labor cost by ship class', more, index);
  assert.equal(adjusted.trust, 'adjusted');
  assert.equal(adjusted.entry?.id, 'fleet-maintenance--both');
  assert.match(adjusted.reasons[0]!, /re-added/);

  // A different window is not the reviewed answer.
  assert.equal(answerQuestion('Labor cost in the last 3 months', entries, index).trust, 'drafted');
});

test('follow-ups, phrasings and the question queue', () => {
  const entries = learnt();
  const a = answerQuestion('Total labor cost', entries, index);
  const labels = followUps(a, index).map((f) => f.label);
  assert.ok(labels.includes('by status') && labels.includes('per month') && labels.includes('vs last year'), labels.join(', '));
  const q = newQuestion('What did we spend in each region?', 'chief', 'drafted', [], today);
  assert.match(q.id, /^q-\d{14}-[a-z0-9]+$/);
  assert.deepEqual(resolveQuestions([q], entries, today), []);
  const taught = addPhrasing(entries.find((e) => e.id.endsWith('bar-region'))!, q.title, today);
  const resolved = resolveQuestions([q], [taught], today);
  assert.equal(resolved[0]!.status, 'answered');
  assert.equal(answerQuestion('what did we spend in each region', [taught], index).trust, 'reviewed');
  assert.equal(normalizeQuestion('  What, did WE spend?? '), 'what did we spend');
  const cov = coverage(entries, index);
  assert.equal(cov[0]!.entries, 0, 'the least covered measures come first');
});

test('snapshots: pre-split by the short lists, and they answer more than their own question', async () => {
  const entries = learnt();
  const bar = entries.find((e) => e.id.endsWith('bar-region'))!;
  const plan = snapshotPlan(bar, index)!;
  assert.deepEqual(plan.dimensions.map((d) => d.key), ['jobs.region', 'jobs.status', 'jobs.ship_class']);
  const snap = (await takeSnapshot(bar, index, run, today))!;
  assert.equal(snap.truncated, false);
  assert.ok(!isStale(snap, bar, today));
  assert.ok(isStale(snap, bar, new Date('2026-10-27T00:00:00Z')));
  // A pipeline's Publish step marks it (server/Pipeline.ps1): stale at once; a newer snapshot is fresh again.
  assert.ok(isStale({ ...snap, invalidatedAt: new Date(Date.parse(snap.asOf) + 1000).toISOString() }, bar, today));
  assert.ok(!isStale({ ...snap, invalidatedAt: new Date(Date.parse(snap.asOf) - 1000).toISOString() }, bar, today));

  // The snapshot's own question, its total, and a picked value all match a direct query.
  const direct = async (f: Flag) => {
    const p = planFlag({ ...hoist, flags: [] }, f, index);
    assert.ok(p.ok);
    return applySelections(p.plan, (await run(p.plan)).rows, {}, f.behavior).rows;
  };
  const own = answerFromSnapshots(answerQuestion(bar.question, entries, index).flag, hoist.filters, [snap])!;
  assert.deepEqual(own.display.rows, await direct(flag(hoist, 'bar-region')));
  const total: Flag = { ...flag(hoist, 'kpi-cost'), binding: { metrics: ['labor_cost'], dimensions: [], filters: [] } };
  assert.deepEqual(answerFromSnapshots(total, hoist.filters, [snap])!.display.rows, await direct(total));
  const ice: Flag = { ...total, binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.ship_class', op: 'in', values: ['Icebreaker'] }] } };
  assert.deepEqual(answerFromSnapshots(ice, hoist.filters, [snap])!.display.rows.map((r) => r.values.labor_cost).sort(), (await direct(ice)).map((r) => r.values.labor_cost).sort());

  // Not answerable: another window, a field it does not hold, a distinct count it was not built for.
  assert.equal(answerFromSnapshots(total, [], [snap]), null);
  assert.equal(answerFromSnapshots({ ...total, binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.hull' }], filters: [] } }, hoist.filters, [snap]), null);
  assert.equal(answerFromSnapshots({ ...total, binding: { metrics: ['hulls_affected'], dimensions: [], filters: [] } }, hoist.filters, [snap]), null);
});

test('snapshots: distinct counts only exactly, comparisons carried along', async () => {
  const hulls: Flag = { ...flag(hoist, 'kpi-hulls'), brief: 'Hulls affected vs last year', binding: { metrics: ['hulls_affected'], dimensions: [], filters: [], compare: 'previous-year' } };
  const [e] = learnt({ ...hoist, flags: [hulls] });
  const snap = (await takeSnapshot(e!, index, run, today)) as Snapshot;
  assert.ok(snap.previous);
  const a = answerFromSnapshots(answerQuestion('Hulls affected vs last year', [e!], index).flag, hoist.filters, [snap])!;
  assert.equal(typeof a.display.rows[0]!.values.hulls_affected, 'number');
  assert.equal(typeof a.previous?.[0]?.hulls_affected, 'number');
  const ice = { ...hulls, binding: { ...hulls.binding!, filters: [{ field: 'jobs.ship_class', op: 'in' as const, values: ['Icebreaker'] }] } };
  assert.equal(answerFromSnapshots(ice, hoist.filters, [snap]), null);
});

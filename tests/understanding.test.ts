import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexCatalog } from '../src/core/catalog.ts';
import { describeFlag, formatNumber } from '../src/core/describe.ts';
import { parseHoist } from '../src/core/hoist.ts';
import { annotateBrief, distance, learnSynonym, suggest } from '../src/core/intelligence/annotate.ts';
import { draftHoist, LocalRulesProvider } from '../src/core/intelligence/index.ts';
import { draftFlagLocally, starterHoistLocally } from '../src/core/intelligence/local-rules.ts';
import { isValidLayout } from '../src/core/layout.ts';
import { planFlag } from '../src/core/planner.ts';
import { suggestKind } from '../src/core/shape.ts';
import { flag, loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const auto = (brief: string) => draftFlagLocally(brief, 'bar', index, { auto: true });

test('annotation: offsets point into the text as typed, and every kind is found', () => {
  const brief = 'Monthly  Labor cost by Region, last 12 months, vs last year. Top 5. Clicking a bar filters the page. Turn red over $5M';
  const a = annotateBrief(brief, index);
  const at = (kind: string) => a.spans.filter((s) => s.kind === kind).map((s) => brief.slice(s.start, s.end));
  assert.deepEqual(at('metric'), ['Labor cost']);
  assert.deepEqual(at('field'), ['Region']);
  assert.deepEqual(at('time'), ['Monthly']);
  assert.deepEqual(at('range'), ['last 12 months']);
  assert.deepEqual(at('compare'), ['vs last year']);
  assert.deepEqual(at('rank'), ['Top 5']);
  assert.deepEqual(at('click'), ['Clicking a bar filters the page']);
  assert.deepEqual(at('threshold'), ['red over $5M']);
  assert.equal(a.unknown.length, 0);
  // Spans never overlap and are in reading order.
  for (let i = 1; i < a.spans.length; i++) assert.ok(a.spans[i]!.start >= a.spans[i - 1]!.end);
});

test('annotation: typos get "did you mean", unknown grouping words are reported', () => {
  const a = annotateBrief('labor cost by regoin and by vendor', index);
  assert.deepEqual(
    a.unknown.map((u) => [u.word, u.suggestions[0]?.key]),
    [
      ['regoin', 'jobs.region'],
      ['vendor', undefined],
    ],
  );
  assert.match(a.reasons.join(' '), /did you mean Region/);
  // Ordinary words are not reported.
  assert.equal(annotateBrief('Leadership wants labor cost at a glance', index).unknown.length, 0);
});

test('suggestions: edit distance, prefixes, and nothing for unrelated words', () => {
  assert.equal(distance('regoin', 'region'), 1);
  assert.equal(distance('clsas', 'class'), 1);
  assert.equal(suggest('statsu', index)[0]?.key, 'jobs.status');
  assert.equal(suggest('maint', index).length, 0);
  assert.deepEqual(suggest('banana', index), []);
});

test('learning a synonym makes the next brief resolve; clashes are refused', () => {
  const catalog = loadCatalog();
  const learnt = learnSynonym(catalog, 'Vendor', { kind: 'field', key: 'jobs.ship_class' });
  assert.ok(learnt);
  const d = draftFlagLocally('Labor cost by vendor', 'bar', indexCatalog(learnt));
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.ship_class' }]);
  assert.equal(learnSynonym(catalog, 'area', { kind: 'field', key: 'jobs.status' }), null, 'already means Region');
  assert.equal(learnSynonym(catalog, 'the', { kind: 'field', key: 'jobs.status' }), null, 'a stop word');
  assert.equal(learnSynonym(catalog, 'x;drop', { kind: 'field', key: 'jobs.status' }), null);
  assert.equal(learnSynonym(catalog, 'area', { kind: 'field', key: 'jobs.region' }), catalog, 'already known: unchanged');
});

test('questions become a ranked chart', () => {
  const d = auto('Which ship class had the most work orders?');
  assert.equal(d.kind, 'bar');
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.ship_class' }]);
  assert.deepEqual(d.binding?.sort, { by: 'work_orders', dir: 'desc' });
  assert.equal(d.binding?.limit, 5);
  assert.equal(auto('What region has the lowest labor cost?').binding?.sort?.dir, 'asc');
  assert.equal(auto('How many work orders?').kind, 'kpi');
});

test('comparisons and shares are understood, and "vs last year" is not a date filter', () => {
  const yoy = auto('Labor cost vs last year');
  assert.equal(yoy.binding?.compare, 'previous-year');
  assert.deepEqual(yoy.binding?.filters, []);
  const pop = auto('Work orders in the last 3 months compared with the previous period');
  assert.equal(pop.binding?.compare, 'previous-period');
  assert.deepEqual(pop.binding?.filters, [{ field: 'jobs.opened', op: 'last', values: [3], unit: 'month' }]);
  const share = auto('Labor cost by region as a % of total');
  assert.equal(share.binding?.share, true);
  assert.equal(share.kind, 'pie');
});

test('kind follows the shape of the data when the brief does not name one', () => {
  const f = { filters: [] };
  assert.equal(suggestKind({ metrics: ['labor_cost'], dimensions: [], ...f }, index).kind, 'kpi');
  assert.equal(suggestKind({ metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened', grain: 'month' }], ...f }, index).kind, 'line');
  assert.equal(suggestKind({ metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened', grain: 'month' }, { field: 'jobs.region' }], ...f }, index).kind, 'line');
  assert.equal(suggestKind({ metrics: ['labor_cost'], dimensions: [{ field: 'jobs.opened', grain: 'month' }, { field: 'jobs.hull' }], ...f }, index).kind, 'table');
  const long = suggestKind({ metrics: ['labor_cost'], dimensions: [{ field: 'jobs.hull' }], ...f }, index);
  assert.deepEqual([long.kind, long.limit], ['bar', 15]);
  assert.equal(suggestKind({ metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], share: true, ...f }, index).kind, 'pie');
  // An average is not a part of a whole.
  assert.equal(suggestKind({ metrics: ['avg_days_open'], dimensions: [{ field: 'jobs.region' }], share: true, ...f }, index).kind, 'bar');
  // A long list is cut to the top 15 and says so.
  const hulls = auto('Labor cost by hull');
  assert.equal(hulls.binding?.limit, 15);
  assert.match(hulls.notes.join(' '), /top 15/);
  // A kind the analyst chose is kept unless auto is on.
  assert.equal(draftFlagLocally('Labor cost per month', 'bar', index).kind, 'bar');
});

test('starter page: a sensible first hoist from the catalog alone', async () => {
  const d = starterHoistLocally(index);
  const kinds = d.flags.map((f) => f.kind);
  assert.deepEqual(kinds.filter((k) => k === 'kpi').length, 4);
  assert.ok(kinds.includes('filter') && kinds.includes('line') && kinds.includes('bar') && kinds.includes('table'));
  assert.deepEqual(d.filters, [{ field: 'jobs.opened', op: 'last', values: [12], unit: 'month' }]);
  // An empty brief gets the starter page through the normal entry point.
  const { draft } = await draftHoist(new LocalRulesProvider(index), '', index);
  assert.equal(draft.flags.length, d.flags.length);
  const nothing = await draftHoist(new LocalRulesProvider(index), 'bananas and pears', index);
  assert.ok(nothing.draft.flags.length > 0);
  assert.match(nothing.draft.notes[0]!, /starter page/);
  // Every starter flag plans.
  const h = parseHoist({ ...hoist, flags: [] }, index).hoist!;
  for (const f of d.flags) {
    const fl = { id: 'x', kind: f.kind, title: f.title, brief: f.brief, layout: { x: 0, y: 0, w: 3, h: 2 }, binding: f.binding, behavior: f.behavior, status: 'drafted' as const, notes: [] };
    const p = planFlag({ ...h, filters: d.filters }, fl, index);
    assert.ok(p.ok, `${f.title}: ${p.ok ? '' : p.error}`);
  }
  assert.ok(isValidLayout([], 12));
});

test('readback: plain English for the example flags', () => {
  const text = (id: string) => describeFlag(flag(hoist, id), hoist, index).join(' ');
  assert.equal(text('kpi-cost'), 'A KPI showing Labor cost (total). Last 12 months of Opened date (page). Turns red when Labor cost is over $5M.');
  assert.match(text('bar-region'), /^Bars of Labor cost \(total\) by Region\. Sorted by Labor cost, highest first\..*Clicking a value filters the whole page\.$/);
  assert.match(text('filter-class'), /^A picker listing every Ship class\..*Choosing values filters the whole page\.$/);
  const line = flag(hoist, 'line-trend');
  assert.match(describeFlag(line, hoist, index).join(' '), /Ignores page selections on Region/);
});

test('number formatting for labels', () => {
  assert.equal(formatNumber(5_000_000, 'currency'), '$5M');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber(12_345), '12.3K');
  assert.equal(formatNumber(0.256, 'percent'), '25.6%');
  assert.equal(formatNumber(2.5), '2.5');
  assert.equal(formatNumber(null), '–');
});

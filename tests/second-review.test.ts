// Regression tests for the issues found in the second code review (bound parameters in cleaned
// columns, Spark row limits, the local calendar day, selections the source cannot be asked for).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { planFlag } from '../src/core/planner.ts';
import { calendarToday, renderSql } from '../src/core/sql.ts';
import { fleetSampleRows } from '../src/sample/fleet.ts';
import { computeFlag, type DataContext } from '../web/src/lib/data.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

function cleanedCatalog(dialect: string, kind: string): Catalog {
  return {
    version: 1,
    sources: [{ id: 'y', label: 'Y', kind, dialect }],
    fields: [
      { key: 'jobs.region', label: 'Region', source: 'y', table: 'jobs', column: 'region', type: 'string' },
      { key: 'jobs.parts', label: 'Parts', source: 'y', table: 'jobs', column: 'parts_cost', type: 'string' },
    ],
    metrics: [{ key: 'parts', label: 'Parts', agg: 'sum', field: 'jobs.parts', source: 'y' }],
    cleaning: [
      { id: 'm', field: 'jobs.parts', kind: 'map', map: { 'n/a': '0', none: '0' }, sentence: 'x' },
      { id: 'b', field: 'jobs.parts', kind: 'blank-as', value: '0', sentence: 'x' },
      { id: 'n', field: 'jobs.parts', kind: 'number', sentence: 'x' },
    ],
  } as unknown as Catalog;
}

function partsByRegion(c: Catalog) {
  const index = indexCatalog(c);
  const f = {
    id: 'f', kind: 'bar', title: '', brief: '', layout: { x: 0, y: 0, w: 4, h: 4 },
    binding: { metrics: ['parts'], dimensions: [{ field: 'jobs.region' }], filters: [] },
    behavior: { ignore: [], onClick: 'filter', thresholds: [] }, status: 'ready', notes: [],
  } as unknown as Flag;
  const h = { version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [f], updated: '' } as unknown as Hoist;
  const p = planFlag(h, f, index);
  if (!p.ok) throw new Error(p.error);
  return { plan: p.plan, index };
}

for (const [dialect, kind] of [['access', 'access'], ['postgres', 'postgres'], ['ansi', 'aws-athena'], ['tsql', 'azure-sql'], ['spark', 'foundry']] as const) {
  test(`cleaned columns bind one parameter per "?" in ${dialect}`, () => {
    const { plan, index } = partsByRegion(cleanedCatalog(dialect, kind));
    const r = renderSql(plan, index, new Date(Date.UTC(2026, 9, 25)), { placeholders: 'question' });
    // "?" inside a quoted literal (the Postgres number pattern) is text, not a marker.
    const marks = (r.sql.replace(/'(?:[^']|'')*'/g, "''").match(/\?/g) ?? []).length;
    assert.equal(marks, r.params.length, r.sql);
    // The markers carry the step values in text order: the map's pairs come before the blank value.
    assert.deepEqual(r.params.slice(0, 4).map((p) => p.value), ['n/a', '0', 'none', '0']);
  });
}

test('Spark SQL is cut to the row limit at the source', () => {
  const c = cleanedCatalog('spark', 'foundry');
  c.cleaning = [];
  const { plan, index } = partsByRegion(c);
  const r = renderSql(plan, index, new Date(Date.UTC(2026, 9, 25)));
  assert.match(r.sql, / LIMIT \d+$/);
});

test('today is the local calendar day, not the UTC one', () => {
  // 9 pm on 31 October in Norfolk is already 1 November in UTC.
  const evening = new Date(2026, 9, 31, 21, 0, 0);
  const t = calendarToday(evening);
  assert.equal(t.toISOString(), '2026-10-31T00:00:00.000Z');
});

test('a blank selection the source cannot be asked for is not claimed as applied', async () => {
  const index = loadIndex();
  const hoist = loadHoist();
  const today = new Date(Date.UTC(2026, 9, 26));
  const ctx: DataContext = { index, local: fleetSampleRows(today), localSources: new Set(['maint', 'parts']), server: null, today, version: 1 };
  const picked = await computeFlag(hoist, flag(hoist, 'kpi-hulls'), { 'jobs.ship_class': ['Icebreaker'] }, ctx);
  assert.deepEqual(picked.requeried, ['jobs.ship_class'], 'a text value is still asked of the source');
  const blank = await computeFlag(hoist, flag(hoist, 'kpi-hulls'), { 'jobs.ship_class': [null] }, ctx);
  assert.deepEqual(blank.requeried, []);
  assert.ok(blank.display.live.includes('jobs.ship_class'), 'reported as not applied');
});

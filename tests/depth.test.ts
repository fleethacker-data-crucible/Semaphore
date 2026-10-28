import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, checkCatalog, indexCatalog } from '../src/core/catalog.ts';
import { toIsoDate, toNumber } from '../src/core/cleaning.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import { proposeCatalog } from '../src/core/profile.ts';
import { renderSql } from '../src/core/sql.ts';

const TODAY = new Date('2026-10-28T12:00:00Z');

/** Jobs point at ships, ships at classes: two many-to-one steps. */
function yard(dialect: 'postgres' | 'access' | 'oracle' = 'postgres'): Catalog {
  return {
    version: 1,
    sources: [{ id: 'y', label: 'Yard', kind: dialect === 'access' ? 'access' : dialect, dialect }],
    fields: [
      { key: 'jobs.region', label: 'Region', source: 'y', table: 'jobs', column: 'region', type: 'string' },
      { key: 'jobs.ship', label: 'Ship id', source: 'y', table: 'jobs', column: 'ship_id', type: 'string' },
      { key: 'jobs.hours', label: 'Labor hours', source: 'y', table: 'jobs', column: 'labor_hours', type: 'number' },
      { key: 'jobs.parts', label: 'Parts cost', source: 'y', table: 'jobs', column: 'parts_cost', type: 'string' },
      { key: 'ships.name', label: 'Ship', source: 'y', table: 'ships', column: 'name', type: 'string' },
      { key: 'ships.class', label: 'Class code', source: 'y', table: 'ships', column: 'class_code', type: 'string' },
      { key: 'classes.label', label: 'Ship class', source: 'y', table: 'classes', column: 'label', type: 'string' },
      { key: 'crews.name', label: 'Crew', source: 'y', table: 'crews', column: 'name', type: 'string' },
    ],
    metrics: [
      { key: 'hours', label: 'Total labor hours', agg: 'sum', field: 'jobs.hours', source: 'y' },
      { key: 'jobs_count', label: 'Jobs', agg: 'count', table: 'jobs', source: 'y' },
      { key: 'parts', label: 'Parts cost', agg: 'sum', field: 'jobs.parts', source: 'y' },
    ],
    relationships: [
      { id: 'r1', source: 'y', from: { table: 'jobs', column: 'ship_id' }, to: { table: 'ships', column: 'id' } },
      { id: 'r2', source: 'y', from: { table: 'ships', column: 'class_code' }, to: { table: 'classes', column: 'code' } },
    ],
  };
}

const ROWS: TableRows = {
  jobs: [
    { region: 'Northeast', ship_id: 'S1', labor_hours: 10, parts_cost: '1,200' },
    { region: ' N.E. ', ship_id: 'S1', labor_hours: 5, parts_cost: '$300' },
    { region: 'south', ship_id: 'S2', labor_hours: 7, parts_cost: '' },
    { region: 'South', ship_id: 'S3', labor_hours: 2, parts_cost: 'n/a' },
    { region: 'South', ship_id: 'S9', labor_hours: 4, parts_cost: '50' },
    { region: 'South', ship_id: 'S9', labor_hours: 4, parts_cost: '50' },
  ],
  ships: [
    { id: 'S1', name: 'Arleigh', class_code: 'DDG' },
    { id: 'S2', name: 'Bunker', class_code: 'CG' },
    { id: 'S3', name: 'Carney', class_code: 'DDG' },
  ],
  classes: [
    { code: 'DDG', label: 'Destroyer' },
    { code: 'CG', label: 'Cruiser' },
  ],
};

function page(binding: Partial<Binding>, filters: Hoist['filters'] = []): { hoist: Hoist; flag: Flag } {
  const flag: Flag = {
    id: 'f',
    kind: 'bar',
    title: 't',
    brief: '',
    layout: { x: 0, y: 0, w: 6, h: 4 },
    binding: { metrics: [], dimensions: [], filters: [], ...binding },
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    status: 'drafted',
    notes: [],
  };
  return { hoist: { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters, flags: [flag], updated: '' }, flag };
}

function plan(catalog: Catalog, binding: Partial<Binding>, filters: Hoist['filters'] = []): QueryPlan {
  const { hoist, flag } = page(binding, filters);
  const p = planFlag(hoist, flag, indexCatalog(catalog));
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

function totals(catalog: Catalog, p: QueryPlan): Record<string, number | null> {
  const index = indexCatalog(catalog);
  const r = applySelections(p, runPlan(p, index, ROWS, TODAY).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  return Object.fromEntries(r.rows.map((x) => [String(Object.values(x.dims)[0]), x.values[p.metrics[0]!.key] as number | null]));
}

test('joins: a measure on jobs grouped by a field two relationships away', () => {
  const c = yard();
  // Parts cost is text until a cleaning step reads it as a number (below); nothing else is wrong.
  assert.deepEqual(checkCatalog(c), ['Metric "parts" uses sum on a field that is not a number.']);
  const p = plan(c, { metrics: ['hours'], dimensions: [{ field: 'classes.label' }] });
  assert.deepEqual(p.joins?.map((j) => [j.table, j.alias, j.left.alias]), [['ships', 't1', 't0'], ['classes', 't2', 't1']]);
  const q = renderSql(p, indexCatalog(c), TODAY);
  assert.equal(
    q.sql,
    'SELECT "t2"."label" AS "d0", SUM("t0"."labor_hours") AS "a0" FROM "jobs" AS "t0" LEFT JOIN "ships" AS "t1" ON "t0"."ship_id" = "t1"."id" LEFT JOIN "classes" AS "t2" ON "t1"."class_code" = "t2"."code" GROUP BY "t2"."label" LIMIT 50000',
  );
  // In the page: a job whose ship is unknown lands in the blank group, as with LEFT JOIN.
  assert.deepEqual(totals(c, p), { Destroyer: 17, Cruiser: 7, null: 8 });
});

test('joins: Access nests each join, Oracle drops AS, and filters reach joined tables', () => {
  const access = renderSql(plan(yard('access'), { metrics: ['jobs_count'], dimensions: [{ field: 'classes.label' }] }), indexCatalog(yard('access')), TODAY);
  assert.match(access.sql, /FROM \(\[jobs\] AS \[t0\] LEFT JOIN \[ships\] AS \[t1\] ON \[t0\]\.\[ship_id\] = \[t1\]\.\[id\]\) LEFT JOIN \[classes\] AS \[t2\]/);
  const p = plan(yard('oracle'), { metrics: ['hours'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'ships.name', op: 'eq', values: ['Arleigh'] }] });
  const oracle = renderSql(p, indexCatalog(yard('oracle')), TODAY);
  assert.match(oracle.sql, /FROM "jobs" "t0" LEFT JOIN "ships" "t1" ON/);
  assert.match(oracle.sql, /WHERE "t1"\."name" = :p1/);
  assert.deepEqual(totals(yard(), plan(yard(), { metrics: ['hours'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'ships.name', op: 'eq', values: ['Arleigh'] }] })), { Northeast: 10, ' N.E. ': 5 });
});

test('joins: an unrelated table is refused, and a page filter on it is reported', () => {
  const { hoist, flag } = page({ metrics: ['hours'], dimensions: [{ field: 'crews.name' }] });
  const r = planFlag(hoist, flag, indexCatalog(yard()));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /not related to jobs.*Relationships/);
  const p = plan(yard(), { metrics: ['hours'] }, [{ field: 'crews.name', op: 'eq', values: ['A'] }]);
  assert.match(p.notes.join(' '), /Crew.*not related/);
  // A one-side measure cannot reach the many side: ships do not lead back to jobs.
  const back = page({ metrics: [], dimensions: [{ field: 'ships.name' }, { field: 'jobs.region' }] });
  assert.equal(planFlag(back.hoist, back.flag, indexCatalog(yard())).ok, false);
});

test('local rules draft across a relationship', () => {
  const d = draftFlagLocally('Total labor hours by ship class', 'bar', indexCatalog(yard()));
  assert.deepEqual(d.binding?.dimensions, [{ field: 'classes.label' }]);
});

test('cleaning: trim and map merge label variants, in SQL (bound once) and in the page', () => {
  const c = yard();
  c.cleaning = [
    { id: 'c1', field: 'jobs.region', kind: 'map', map: { 'N.E.': 'Northeast', south: 'South' }, sentence: 'Read “N.E.” as “Northeast” and “south” as “South”' },
    { id: 'c2', field: 'jobs.region', kind: 'trim', sentence: 'Remove stray spaces' },
  ];
  const p = plan(c, { metrics: ['hours'], dimensions: [{ field: 'jobs.region' }] }, [{ field: 'jobs.region', op: 'in', values: ['Northeast', 'South'] }]);
  const q = renderSql(p, indexCatalog(c), TODAY);
  assert.equal(
    q.sql,
    'SELECT "q"."c0" AS "d0", SUM("q"."c1") AS "a0" FROM (SELECT CASE TRIM("region") WHEN $1 THEN $2 WHEN $3 THEN $4 ELSE TRIM("region") END AS "c0", "labor_hours" AS "c1" FROM "jobs") AS "q" WHERE "q"."c0" IN ($5, $6) GROUP BY "q"."c0" LIMIT 50000',
  );
  assert.deepEqual(q.params.map((x) => x.value), ['N.E.', 'Northeast', 'south', 'South', 'Northeast', 'South']);
  assert.deepEqual(totals(c, p), { Northeast: 15, South: 17 });
  // Access has no CASE: Switch() instead, with positional binds in text order.
  const a = yard('access');
  a.cleaning = c.cleaning;
  assert.match(renderSql(plan(a, { metrics: ['hours'], dimensions: [{ field: 'jobs.region' }] }), indexCatalog(a), TODAY).sql, /Switch\(TRIM\(\[region\]\) = \?, \?, TRIM\(\[region\]\) = \?, \?, True, TRIM\(\[region\]\)\)/);
  // Profiling reads values as stored.
  const raw = { ...p, raw: true };
  assert.equal(renderSql(raw, indexCatalog(c), TODAY).sql.includes('CASE'), false);
  assert.deepEqual(Object.keys(totals(c, { ...raw, filters: [] })).sort(), [' N.E. ', 'Northeast', 'South', 'south']);
});

test('cleaning: numbers stored as text, blanks that mean zero, duplicate rows', () => {
  const c = yard();
  c.cleaning = [
    { id: 'n', field: 'jobs.parts', kind: 'number', sentence: 'Read parts cost as a number' },
    { id: 'b', field: 'jobs.parts', kind: 'blank-as', value: '0', sentence: 'A blank parts cost means 0' },
    { id: 'd', field: 'jobs.region', kind: 'dedupe', sentence: 'Count repeated job rows once' },
  ];
  assert.deepEqual(checkCatalog(c), [], 'a sum over text is fine once it is read as a number');
  const p = plan(c, { metrics: ['parts'] });
  const index = indexCatalog(c);
  const rows = runPlan(p, index, ROWS, TODAY).rows;
  assert.equal(rows[0]![p.aggregates[0]!.alias], 1200 + 300 + 0 + 50);
  assert.equal(runPlan(plan(c, { metrics: ['jobs_count'] }), index, ROWS, TODAY).rows[0]!.a0, 5);
  const q = renderSql(p, index, TODAY);
  assert.match(q.sql, /FROM \(SELECT CASE WHEN .* AS DOUBLE PRECISION\) END AS "c0" FROM \(SELECT DISTINCT \* FROM "jobs"\) AS "t0"\) AS "q"/);
  assert.equal(toNumber('(1,250.50)'), -1250.5);
  assert.equal(toNumber('12 ft'), null);
});

test('cleaning: mixed date formats read into one, in the page only', () => {
  assert.equal(toIsoDate('03/04/2026', 'mdy'), '2026-03-04');
  assert.equal(toIsoDate('03/04/2026', 'dmy'), '2026-04-03');
  assert.equal(toIsoDate('2026-03-04T10:00:00Z', 'dmy'), '2026-03-04');
  assert.equal(toIsoDate('4-Mar-26', 'mdy'), '2026-03-04');
  assert.equal(toIsoDate('March 4, 2026', 'dmy'), '2026-03-04');
  assert.equal(toIsoDate('02/30/2026', 'mdy'), null);
  const c = yard();
  c.cleaning = [{ id: 'dt', field: 'jobs.region', kind: 'date', order: 'mdy', sentence: 'x' }];
  assert.throws(() => renderSql(plan(c, { metrics: ['hours'], dimensions: [{ field: 'jobs.region' }] }), indexCatalog(c), TODAY), /in the page only/);
});

test('profile: hours of work add up, so the bare name is the total and "average" the mean', () => {
  const { catalog } = proposeCatalog({
    source: { id: 'wh', label: 'Warehouse', kind: 'postgres', dialect: 'postgres' },
    tables: [{ name: 'jobs', rows: 900, columns: [{ name: 'ship_class', type: 'string', distinct: 6 }, { name: 'labor_hours', type: 'number' }, { name: 'days_open', type: 'number' }] }],
  });
  const total = catalog.metrics.find((m) => m.label === 'Total labor hours');
  const mean = catalog.metrics.find((m) => m.label === 'Average labor hours');
  assert.equal(total?.agg, 'sum');
  assert.equal(mean?.agg, 'avg');
  // Ages are not added up: days open stays an average only.
  assert.deepEqual(catalog.metrics.filter((m) => m.field === 'jobs.days_open').map((m) => m.agg), ['avg']);
  const index = indexCatalog(catalog);
  assert.deepEqual(draftFlagLocally('Which ship class had the most labor hours', 'bar', index).binding?.metrics, [total!.key]);
  assert.deepEqual(draftFlagLocally('Average labor hours by ship class', 'bar', index).binding?.metrics, [mean!.key]);
});

test('quality: findings read as sentences, and each fix does what it says', async () => {
  const { findIssues, findDuplicates, countValues, labelKey, valuesPlan, toValueCounts } = await import('../src/core/quality.ts');
  const c = yard();
  const index = indexCatalog(c);
  assert.equal(labelKey('N.E.'), labelKey('north east'));
  assert.equal(labelKey('Northeast'), labelKey(' NORTH-EAST '));
  assert.notEqual(labelKey('North'), labelKey('Northeast'));
  const region = findIssues(index, 'jobs.region', countValues(ROWS.jobs!, 'region'));
  assert.deepEqual(region.map((x) => x.kind).sort(), ['spaces', 'variants']);
  const variants = region.find((x) => x.kind === 'variants')!;
  assert.deepEqual(variants.step.map, { 'N.E.': 'Northeast', ' N.E. ': 'Northeast', south: 'South' });
  assert.match(variants.step.sentence, /“N\.E\.” as “Northeast”/);
  const parts = findIssues(index, 'jobs.parts', countValues(ROWS.jobs!, 'parts_cost'));
  assert.equal(parts.find((x) => x.kind === 'number-text')?.step.kind, 'number');
  assert.match(parts.find((x) => x.kind === 'number-text')!.problem, /“n\/a”/);
  // Accepting the variants fix leaves nothing more to merge.
  const fixed = indexCatalog({ ...c, cleaning: [variants.step] });
  assert.equal(findIssues(fixed, 'jobs.region', countValues(ROWS.jobs!, 'region')).some((x) => x.kind === 'variants'), false);
  assert.match(findDuplicates(index, 'y', 'jobs', ROWS.jobs!)!.problem, /1 row in jobs is an exact copy/);
  // Mixed dates are offered for page data only.
  const dates = [{ value: '03/04/2026', count: 3 }, { value: '2026-03-05', count: 2 }, { value: '17/03/2026', count: 1 }];
  assert.equal(findIssues(index, 'jobs.region', dates).some((x) => x.kind === 'mixed-dates'), false);
  assert.equal(findIssues(index, 'jobs.region', dates, { pageData: true }).find((x) => x.kind === 'mixed-dates')?.step.order, 'dmy');
  // Values come from one small query, as stored, most common first.
  const q = renderSql(valuesPlan(index, 'jobs.region'), index, TODAY);
  assert.equal(q.sql, 'SELECT "region" AS "d0", COUNT(*) AS "a0" FROM "jobs" GROUP BY "region" ORDER BY COUNT(*) DESC LIMIT 1000');
  assert.deepEqual(toValueCounts([{ d0: 'a', a0: 1 }, { d0: 'b', a0: 4 }]).map((v) => v.value), ['b', 'a']);
});

test('relationships: proposed from names, kept only when the data backs them', async () => {
  const { relationshipCandidates, checkRelationship, proposeRelationship, countValues } = await import('../src/core/quality.ts');
  const c = yard();
  c.relationships = [];
  c.fields.push({ key: 'ships.id', label: 'Ship id', source: 'y', table: 'ships', column: 'id', type: 'string' });
  const cands = relationshipCandidates(indexCatalog(c));
  const pair = cands.find((x) => x.from.key === 'jobs.ship' && x.to.key === 'ships.id');
  assert.ok(pair, 'ship_id → ships.id');
  const check = checkRelationship(countValues(ROWS.jobs!, 'ship_id'), countValues(ROWS.ships!, 'id'));
  assert.equal(check.matched, 3);
  assert.equal(check.distinct, 4);
  assert.equal(check.toUnique, true);
  assert.deepEqual(proposeRelationship(pair!, check)?.to, { table: 'ships', column: 'id' });
  // Joining onto a column that repeats would count rows twice: not proposed.
  assert.equal(proposeRelationship(pair!, { ...check, toUnique: false }), null);
  assert.equal(proposeRelationship(pair!, { ...check, match: 0.2 }), null);
});

test('AI cleaning answers are checked: only real values, each in one group', async () => {
  const { validateCleaning } = await import('../src/core/intelligence/tasks.ts');
  const list = [{ value: 'Northeast', count: 9 }, { value: 'N.E.', count: 2 }, { value: 'Mgmt', count: 1 }, { value: 'Management', count: 5 }];
  const r = validateCleaning(
    { groups: [{ keep: 'Northeast', merge: ['N.E.', 'NE region'] }, { keep: 'Made up', merge: ['Mgmt'] }, { keep: 'Management', merge: ['Mgmt', 'N.E.'] }] },
    { key: 'jobs.region', label: 'Region' },
    list,
  );
  assert.deepEqual(r.step?.map, { 'N.E.': 'Northeast', Mgmt: 'Management' });
  assert.equal(r.step?.origin, 'ai');
  assert.equal(r.rejected.length, 3);
  assert.throws(() => validateCleaning('nonsense', { key: 'k', label: 'K' }, list), /groups/);
});

test('drill: dates go year → quarter → month → day → rows; categories follow a drill path', async () => {
  const { drillView, drillLabel, nextLevel } = await import('../src/core/drill.ts');
  const c = yard();
  c.fields.push({ key: 'jobs.opened', label: 'Opened', source: 'y', table: 'jobs', column: 'opened_on', type: 'date' });
  c.hierarchies = [{ id: 'p', label: 'Class → ship', levels: ['classes.label', 'ships.name'] }];
  const index = indexCatalog(c);
  const { flag } = page({ metrics: ['hours'], dimensions: [{ field: 'jobs.opened', grain: 'year' }], limit: 5, sort: { by: 'hours', dir: 'desc' } });
  flag.behavior.onClick = 'drill';
  const q3 = drillView(flag, [{ field: 'jobs.opened', grain: 'year', value: '2026-01-01' }, { field: 'jobs.opened', grain: 'quarter', value: '2026-07-01' }], index);
  assert.deepEqual(q3.flag.binding?.dimensions, [{ field: 'jobs.opened', grain: 'month' }]);
  assert.deepEqual(q3.flag.binding?.filters.map((f) => f.values), [['2026-01-01', '2026-12-31'], ['2026-07-01', '2026-09-30']]);
  assert.equal(q3.flag.binding?.limit, undefined, 'the top 5 does not carry down');
  assert.equal(drillLabel([{ field: 'x', grain: 'year', value: '2026-01-01' }, { field: 'x', grain: 'quarter', value: '2026-07-01' }]), '2026 › 2026 Q3');
  assert.equal(nextLevel(index, { field: 'jobs.opened', grain: 'day' }), 'detail');
  assert.equal(nextLevel(index, { field: 'jobs.region' }), null, 'no path: no drill');
  // Categories: class → ship → the rows behind one ship, as a capped table; planned through the joins.
  const cls = page({ metrics: ['hours'], dimensions: [{ field: 'classes.label' }] }).flag;
  const ship = drillView(cls, [{ field: 'classes.label', value: 'Destroyer' }], index);
  assert.deepEqual(ship.flag.binding?.dimensions, [{ field: 'ships.name' }]);
  const rows = drillView(cls, [{ field: 'classes.label', value: 'Destroyer' }, { field: 'ships.name', value: 'Arleigh' }], index);
  assert.equal(rows.detail, true);
  assert.equal(rows.flag.kind, 'table');
  assert.equal(rows.flag.binding?.limit, 500);
  const p = plan(c, rows.flag.binding!);
  assert.deepEqual(totals(c, p), { Arleigh: 10 + 5 });
});

// Cleaning steps that make fields or a table (src/core/reshape.ts, reshape-words.ts): split, merge,
// unpivot and bucket. Each is proposed from a sentence, read in the in-page engine, run as SQLite SQL
// in Node's own SQLite against the engine's answer, and rendered for the other dialects. Undo takes
// out the step and everything built on it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { type Catalog, checkCatalog, type Dialect, indexCatalog, SQL_DIALECTS } from '../src/core/catalog.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import * as impl from '../src/core/reshape-impl.ts';
import { bucketOf, mergeValues, splitPart, tileBounds, tileRanker } from '../src/core/reshape-impl.ts';
import { registerReshaping } from '../src/core/reshape.ts';
import { acceptReshape, parseBuckets, previewPlan, proposeReshape, type ReshapeProposal, undoStep, withBounds } from '../src/core/reshape-words.ts';
import { renderSql } from '../src/core/sql.ts';

const base = (dialect: Dialect = 'sqlite'): Catalog => ({
  version: 1,
  sources: [{ id: 's', label: 'S', kind: dialect === 'sqlite' ? 'csv' : 'other', dialect }],
  fields: [
    { key: 'crew.name', label: 'Full name', source: 's', table: 'crew', column: 'name', type: 'string' },
    { key: 'crew.city', label: 'City', source: 's', table: 'crew', column: 'city', type: 'string' },
    { key: 'crew.state', label: 'State', source: 's', table: 'crew', column: 'state', type: 'string' },
    { key: 'crew.code', label: 'Code', source: 's', table: 'crew', column: 'code', type: 'string' },
    { key: 'crew.days', label: 'Days open', source: 's', table: 'crew', column: 'days', type: 'number' },
    { key: 'crew.jan', label: 'Jan', source: 's', table: 'crew', column: 'jan', type: 'number' },
    { key: 'crew.feb', label: 'Feb', source: 's', table: 'crew', column: 'feb', type: 'number' },
    { key: 'crew.mar', label: 'Mar', source: 's', table: 'crew', column: 'mar', type: 'number' },
  ],
  metrics: [{ key: 'people', label: 'People', agg: 'count', table: 'crew', source: 's' }],
});

const ROWS = [
  { name: 'Smith, Jane', city: 'Norfolk', state: 'VA', code: 'ABC-001', days: 0, jan: 1, feb: 2, mar: 3 },
  { name: 'Ng,Li', city: ' San Diego ', state: 'CA', code: 'XY-12', days: 7, jan: 4, feb: null, mar: 6 },
  { name: 'Okafor', city: 'Mayport', state: null, code: 'Q', days: 7.5, jan: 7, feb: 8, mar: 9 },
  { name: null, city: null, state: 'WA', code: null, days: 30, jan: null, feb: 1, mar: 1 },
  { name: 'Diaz, Ana, Jr', city: '', state: '', code: 'LONGCODE-99', days: 31, jan: 10, feb: 20, mar: 30 },
  { name: ' , Solo', city: 'Bangor', state: 'WA', code: 'AA-1', days: 90, jan: 2, feb: 2, mar: 2 },
  { name: 'Lee, Kim', city: 'Everett', state: 'WA', code: 'BB-2', days: 91, jan: 5, feb: 5, mar: 5 },
  { name: 'Park, Joon', city: 'Pearl', state: 'HI', code: 'CC-3', days: 400, jan: 0, feb: 0, mar: 0 },
  { name: 'Ito, Yu', city: 'Bremerton', state: 'WA', code: 'DD-4', days: null, jan: 3, feb: 3, mar: 3 },
];
registerReshaping(impl);

const tables: TableRows = { crew: ROWS as unknown as TableRows[string] };
const today = new Date('2025-06-15T00:00:00Z');

const db = new sqlite.DatabaseSync(':memory:');
db.exec('CREATE TABLE crew (name TEXT, city TEXT, state TEXT, code TEXT, days REAL, jan INTEGER, feb INTEGER, mar INTEGER)');
const insert = db.prepare('INSERT INTO crew VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
for (const r of ROWS) insert.run(r.name, r.city, r.state, r.code, r.days, r.jan, r.feb, r.mar);

function accept(sentence: string, catalog: Catalog = base()): { catalog: Catalog; proposal: ReshapeProposal } {
  const r = proposeReshape(sentence, indexCatalog(catalog), { source: 's', table: 'crew' });
  assert.ok(r.ok, r.ok ? '' : r.error);
  const next = acceptReshape(catalog, r);
  assert.deepEqual(checkCatalog(next), [], sentence);
  assert.deepEqual(impl.checkReshape(next), [], sentence);
  return { catalog: next, proposal: r };
}

function plan(catalog: Catalog, binding: Partial<Binding>): QueryPlan {
  const flag: Flag = { id: 'f', kind: 'table', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: [], dimensions: [], filters: [], ...binding } };
  const hoist: Hoist = { version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' };
  const p = planFlag(hoist, flag, indexCatalog(catalog));
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v])))).sort();

/** Runs the plan in the in-page engine and as SQLite SQL, checks they agree, and returns the engine's rows. */
function both(catalog: Catalog, binding: Partial<Binding>): { rows: Array<Record<string, unknown>>; sql: string } {
  const p = plan(catalog, binding);
  const index = indexCatalog(catalog);
  const q = renderSql(p, index, today);
  const fromSql = db.prepare(q.sql).all(...(q.params.map((x) => x.value) as Array<string | number>)) as Array<Record<string, unknown>>;
  const fromEngine = runPlan(p, index, tables, today).rows as Array<Record<string, unknown>>;
  assert.deepEqual(norm(fromSql), norm(fromEngine), q.sql);
  return { rows: fromEngine, sql: q.sql };
}

function display(catalog: Catalog, binding: Partial<Binding>) {
  const p = plan(catalog, binding);
  return applySelections(p, runPlan(p, indexCatalog(catalog), tables, today).rows, {}, { onClick: 'none', ignore: [], thresholds: [] }).rows;
}

test('split on a delimiter: parts trimmed, blank parts and missing parts are null', () => {
  const { catalog, proposal } = accept('split full name on the comma into last and first');
  assert.equal(proposal.step.kind, 'split');
  assert.equal(proposal.step.delimiter, ',');
  assert.equal(proposal.step.sentence, 'Split Full name on the comma into Last and First');
  assert.deepEqual(proposal.fields.map((f) => [f.label, f.type, f.table, f.derived]), [
    ['Last', 'string', 'crew', proposal.step.id],
    ['First', 'string', 'crew', proposal.step.id],
  ]);
  const [last, first] = proposal.step.into!;
  const rows = display(catalog, { metrics: ['people'], dimensions: [{ field: last! }, { field: first! }] });
  const pairs = rows.map((r) => [r.dims[last!], r.dims[first!]]);
  for (const want of [['Smith', 'Jane'], ['Ng', 'Li'], ['Okafor', null], [null, null], ['Diaz', 'Ana'], [null, 'Solo']]) assert.ok(pairs.some((p) => JSON.stringify(p) === JSON.stringify(want)), JSON.stringify(want));
  const sql = both(catalog, { metrics: ['people'], dimensions: [{ field: last! }, { field: first! }] }).sql;
  assert.match(sql, /instr\(/);
  // Filtering and grouping on a made field.
  both(catalog, { metrics: ['people'], dimensions: [{ field: first! }], filters: [{ field: last!, op: 'in', values: ['Smith', 'Lee'] }] });
  assert.equal(splitPart('a--b', { id: 'x', field: 'f', kind: 'split', delimiter: '--', sentence: '' }, 1), 'b');
});

test('split by position: the first characters, then the rest', () => {
  const { catalog, proposal } = accept('split code at 3 into prefix and number');
  assert.deepEqual(proposal.step.widths, [3]);
  const [prefix, rest] = proposal.step.into!;
  const rows = display(catalog, { metrics: ['people'], dimensions: [{ field: prefix! }, { field: rest! }] });
  assert.ok(rows.some((r) => r.dims[prefix!] === 'ABC' && r.dims[rest!] === '-001'));
  assert.ok(rows.some((r) => r.dims[prefix!] === 'Q' && r.dims[rest!] === null));
  both(catalog, { metrics: ['people'], dimensions: [{ field: prefix! }, { field: rest! }] });
  const three = accept('split code at 2 and 4 into a, b and c').proposal;
  assert.deepEqual(three.step.widths, [2, 2]);
  assert.ok(!proposeReshape('split code at 3 into prefix', indexCatalog(base())).ok);
});

test('merge: values joined with the separator, blanks skipped, all blank is null', () => {
  const { catalog, proposal } = accept("join city and state with ', ' as location");
  assert.equal(proposal.step.separator, ', ');
  assert.equal(proposal.fields[0]!.label, 'Location');
  const loc = proposal.step.into![0]!;
  const values = display(catalog, { metrics: ['people'], dimensions: [{ field: loc }] }).map((r) => r.dims[loc]);
  for (const v of ['Norfolk, VA', 'San Diego, CA', 'Mayport', 'WA', null]) assert.ok(values.includes(v), String(v));
  assert.equal(values.filter((v) => v === null).length, 1);
  both(catalog, { metrics: ['people'], dimensions: [{ field: loc }] });
  // A number joins as text.
  const n = accept('combine code and days with a dash as tag').catalog;
  both(n, { metrics: ['people'], dimensions: [{ field: 'crew.tag' }], filters: [{ field: 'crew.days', op: 'in', values: [0, 7, 30] }] });
  assert.equal(mergeValues([' a ', null, '', 'b'], '/'), 'a/b');
});

test('unpivot: month columns become rows of month and value, as a table of their own', () => {
  const { catalog, proposal } = accept('turn the month columns Jan..Mar into rows of month and value');
  const s = proposal.step;
  assert.equal(s.kind, 'unpivot');
  assert.equal(s.table, 'crew_by_month');
  assert.deepEqual(s.names, ['Jan', 'Feb', 'Mar']);
  const [month, value] = s.into!;
  const total = catalog.metrics.find((m) => m.field === value)!;
  assert.equal(total.agg, 'sum');
  const rows = display(catalog, { metrics: [total.key], dimensions: [{ field: month! }] });
  const by = Object.fromEntries(rows.map((r) => [r.dims[month!], r.values[total.key]]));
  assert.deepEqual(by, { Jan: 32, Feb: 41, Mar: 59 });
  both(catalog, { metrics: [total.key], dimensions: [{ field: month! }] });
  // The other columns come along: value by state and month, and a filter on a kept column.
  const state = catalog.fields.find((f) => f.table === 'crew_by_month' && f.column === 'state')!.key;
  both(catalog, { metrics: [total.key], dimensions: [{ field: state }, { field: month! }], filters: [{ field: state, op: 'eq', values: ['WA'] }] });
  // A list of columns works too, and the kept fields do not include the turned ones.
  const list = accept('unpivot jan, feb and mar into month and amount').proposal;
  assert.ok(!list.fields.some((f) => ['jan', 'feb', 'mar'].includes(f.column)));
  assert.ok(!proposeReshape('turn Mar..Jan into rows of month and value', indexCatalog(base())).ok);
});

test('bucket by ranges: whole-number ranges close at the next whole number; outside every range is null', () => {
  assert.deepEqual(parseBuckets('0-7, 8-30, 31-90, 90+'), [
    { label: '0-7', from: 0, to: 8 },
    { label: '8-30', from: 8, to: 31 },
    { label: '31-90', from: 31, to: 91 },
    { label: '90+', from: 91 },
  ]);
  assert.deepEqual(parseBuckets('under 10, 10-50 and over 50'), [{ label: 'under 10', to: 10 }, { label: '10-50', from: 10, to: 51 }, { label: 'over 50', from: 51 }]);
  assert.equal(typeof parseBuckets('soon, later'), 'string');
  const { catalog, proposal } = accept('group days open into 0-7, 8-30, 31-90, 90+');
  const g = proposal.step.into![0]!;
  const rows = display(catalog, { metrics: ['people'], dimensions: [{ field: g }] });
  const by = Object.fromEntries(rows.map((r) => [String(r.dims[g]), r.values.people]));
  assert.deepEqual(by, { '0-7': 3, '8-30': 1, '31-90': 2, '90+': 2, null: 1 });
  both(catalog, { metrics: ['people'], dimensions: [{ field: g }] });
  assert.equal(bucketOf(-1, proposal.step.buckets!), null);
  const words = proposeReshape('group full name into 0-7', indexCatalog(base()));
  assert.ok(!words.ok && /not a number/.test(words.error));
});

/** The equal-count rule in SQL: RANK() and COUNT() over the table, compared as whole numbers. */
const TILE_SQL = /\(RANK\(\) OVER \(PARTITION BY CASE WHEN .+? IS NULL THEN 1 ELSE 0 END ORDER BY .+?\) - 1\) \* 4 < COUNT\(.+?\) OVER \(\) \* 1 THEN/;

test('bucket into quartiles: RANK and COUNT where the dialect has them, the same groups in the page, bounds for Access', () => {
  const r = proposeReshape('bucket days open into quartiles', indexCatalog(base()), { source: 's', table: 'crew' });
  assert.ok(r.ok);
  assert.equal(r.needsValues, 'crew.days');
  const values = ROWS.map((x) => ({ value: x.days, count: 1 }));
  const p = withBounds(r, values);
  // 8 values: 0, 7, 7.5, 30 | 31, 90, 91, 400 → two per quartile.
  assert.deepEqual(p.step.bounds, [7, 30, 90]);
  const catalog = acceptReshape(base(), p);
  const q = p.step.into![0]!;
  const rows = display(catalog, { metrics: ['people'], dimensions: [{ field: q }] });
  assert.deepEqual(Object.fromEntries(rows.map((x) => [String(x.dims[q]), x.values.people])), { Q1: 2, Q2: 2, Q3: 2, Q4: 2, null: 1 });
  const sql = both(catalog, { metrics: ['people'], dimensions: [{ field: q }] }).sql;
  assert.match(sql, TILE_SQL);
  assert.doesNotMatch(sql, /NTILE/);
  // The rule: group = floor((rank - 1) * k / n) + 1. With 10 distinct values in 4 groups: 3, 2, 3, 2.
  const rank = tileRanker([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(rank), [1, 1, 1, 2, 2, 3, 3, 3, 4, 4]);
  assert.deepEqual(tileBounds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => ({ value, count: 1 })), 4), [3, 5, 8]);
  assert.match(p.step.sentence, /equal values always share a group, so groups can differ in size/);
  const access = renderSql(plan({ ...catalog, sources: [{ id: 's', label: 'S', kind: 'access', dialect: 'access' }] }, { metrics: ['people'], dimensions: [{ field: q }] }), indexCatalog({ ...catalog, sources: [{ id: 's', label: 'S', kind: 'access', dialect: 'access' }] }), today);
  assert.match(access.sql, /Switch\(\[days\] <= \?, \?/);
  assert.deepEqual(access.params.slice(0, 2).map((x) => x.value), [7, 'Q1']);
});

test('every dialect renders each step, with values bound and placeholders in the order they appear', () => {
  let catalog = base();
  for (const s of ['split full name on the comma into last and first', 'split code at 3 into prefix and number', "join city and state with ', ' as location", 'group days open into 0-7, 8-30, 31-90, 90+', 'turn the month columns Jan..Mar into rows of month and value']) catalog = accept(s, catalog).catalog;
  const tiles = withBounds(proposeReshape('bucket days open into quartiles', indexCatalog(catalog), { source: 's', table: 'crew' }) as ReshapeProposal, ROWS.map((x) => ({ value: x.days, count: 1 })));
  catalog = acceptReshape(catalog, tiles);
  const made = catalog.fields.filter((f) => f.derived && f.table === 'crew').map((f) => f.key);
  const month = catalog.fields.find((f) => f.table === 'crew_by_month' && f.column === 'month')!.key;
  const total = catalog.metrics.find((m) => m.table === undefined && m.field?.startsWith('crew_by_month'))!.key;
  const want: Record<Dialect, RegExp[]> = {
    postgres: [/SPLIT_PART\(/, /SUBSTR\("code", 1, 3\)/, /COALESCE\(\$\d+ \|\| NULLIF\(TRIM\("city"\), ''\), ''\)/, TILE_SQL, /UNION ALL/, /CAST\(\$\d+ AS VARCHAR\(200\)\)/],
    oracle: [/INSTR\("name", :p\d+, 1, 1\)/, /NVL2\(/, TILE_SQL, /UNION ALL/],
    access: [/InStr\(\[name\] & \?, \?\)/, /Mid\(\[code\], 1, 3\)/, /IIf\(Trim\(\[city\]\) = '', Null/, /Switch\(/, /UNION ALL/],
    tsql: [/CHARINDEX\(@p\d+, \[name\] \+ @p\d+\)/, /SUBSTRING\(\[code\], 1, 3\)/, /COALESCE\(@p\d+ \+ NULLIF/, TILE_SQL, /NVARCHAR\(200\)/],
    synapse: [/CHARINDEX\(/, TILE_SQL],
    spark: [/SPLIT_PART\(`name`/, /CONCAT\(/, TILE_SQL, /CAST\(\? AS STRING\)/],
    mysql: [/SUBSTRING_INDEX\(SUBSTRING_INDEX\(`name`/, /CONCAT\(/, TILE_SQL],
    sqlite: [/instr\(/, TILE_SQL],
    ansi: [/SPLIT_PART\(/, TILE_SQL, /CAST\(\? AS VARCHAR\(200\)\)/],
  };
  for (const dialect of SQL_DIALECTS) {
    const c: Catalog = { ...catalog, sources: [{ id: 's', label: 'S', kind: dialect === 'access' ? 'access' : dialect === 'oracle' ? 'oracle' : dialect === 'postgres' ? 'postgres' : 'other', dialect }] };
    const index = indexCatalog(c);
    const wide = renderSql(plan(c, { metrics: ['people'], dimensions: made.map((field) => ({ field })) }), index, today);
    const long = renderSql(plan(c, { metrics: [total], dimensions: [{ field: month }] }), index, today);
    const text = `${wide.sql}\n${long.sql}`;
    for (const re of want[dialect]) assert.match(text, re, `${dialect}: ${re}`);
    // One parameter per placeholder, in order.
    for (const q of [wide, long]) {
      const markers = q.sql.match(dialect === 'postgres' ? /\$\d+/g : dialect === 'oracle' ? /:p\d+/g : dialect === 'tsql' || dialect === 'synapse' ? /@p\d+/g : /\?/g) ?? [];
      assert.equal(markers.length, q.params.length, `${dialect}: ${markers.length} markers, ${q.params.length} params`);
      // Numbered markers come in order, so the "?" form (ODBC, OLE DB) binds each value where it is written.
      const prefix = ({ postgres: '$', oracle: ':p', tsql: '@p', synapse: '@p' } as Record<string, string>)[dialect];
      if (prefix) assert.deepEqual(markers, q.params.map((_, i) => `${prefix}${i + 1}`), `${dialect}: ${q.sql}`);
    }
  }
});

test('preview, undo, and a catalog check that refuses broken steps', () => {
  const first = accept('split full name on the comma into last and first');
  const p = previewPlan(base(), first.proposal);
  const rows = runPlan(p.plan, p.index, tables, today).rows;
  assert.ok(rows.length > 0 && rows.length <= 8);
  assert.deepEqual(p.columns.map((c) => c.label), ['Full name', 'Last', 'First', 'Rows']);
  // A step built on a made field, a measure on it and a formula on that measure all go with an undo.
  const last = first.proposal.step.into![0]!;
  const withMore: Catalog = {
    ...first.catalog,
    metrics: [...first.catalog.metrics, { key: 'lasts', label: 'Surnames', agg: 'count_distinct', field: last, source: 's' }, { key: 'per', label: 'Per surname', agg: 'formula', formula: 'people / lasts', source: 's' }],
  };
  const merged = accept('join last and city with a space as tag', withMore).catalog;
  const undone = undoStep(merged, first.proposal.step.id);
  assert.deepEqual(undone.fields.map((f) => f.key), base().fields.map((f) => f.key));
  assert.deepEqual(undone.metrics.map((m) => m.key), ['people']);
  assert.deepEqual(undone.cleaning, []);
  assert.deepEqual(checkCatalog(undone), []);
  // Broken steps are refused with a reason.
  const broken: Catalog = { ...first.catalog, cleaning: first.catalog.cleaning!.map((s) => ({ ...s, delimiter: '' })) };
  assert.ok(impl.checkReshape(broken).some((x) => /delimiter/.test(x)));
  // A catalog that does not hold together is refused when it is read, with the reason.
  const name = first.proposal.step.into![0]!;
  assert.throws(() => renderSql(plan(broken, { metrics: ['people'], dimensions: [{ field: name }] }), indexCatalog(broken), today), /delimiter/);
  assert.throws(() => runPlan(plan(broken, { metrics: ['people'], dimensions: [{ field: name }] }), indexCatalog(broken), tables, today), /delimiter/);
  const orphan: Catalog = { ...first.catalog, cleaning: [] };
  assert.ok(checkCatalog(orphan).some((x) => /not in the catalog/.test(x)));
});

test('equal-count groups with heavy ties: equal values share a group, and the page, SQLite SQL and Access bounds agree', () => {
  // Many repeats, blanks, one value that holds most rows, and a value that is everything.
  const sets: Array<Array<number | null>> = [
    [1, 1, 1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 3, 5, 5, 8, 8, 8, 8, 8, 8, 8, 8, 8, null, null, null, 13],
    [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 1],
    [7, 7, 7, 7, 7, null],
    [0.5, -2, -2, 10, 10, 10, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 99],
  ];
  for (const days of sets) {
    const rows = days.map((d) => ({ name: null, city: null, state: null, code: null, days: d, jan: null, feb: null, mar: null }));
    const local = new sqlite.DatabaseSync(':memory:');
    local.exec('CREATE TABLE crew (name TEXT, city TEXT, state TEXT, code TEXT, days REAL, jan INTEGER, feb INTEGER, mar INTEGER)');
    const ins = local.prepare('INSERT INTO crew VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.name, r.city, r.state, r.code, r.days, r.jan, r.feb, r.mar);
    const counts = new Map<number, number>();
    for (const d of days) if (d !== null) counts.set(d, (counts.get(d) ?? 0) + 1);
    const n = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const [k, words] of [[2, 'halves'], [3, 'tertiles'], [4, 'quartiles'], [5, '5 equal groups'], [10, 'deciles']] as const) {
      const r = proposeReshape(`bucket days open into ${words}`, indexCatalog(base()), { source: 's', table: 'crew' });
      assert.ok(r.ok, r.ok ? '' : r.error);
      const p = withBounds(r, [...counts].map(([value, count]) => ({ value, count })));
      const catalog = acceptReshape(base(), p);
      const index = indexCatalog(catalog);
      const q = p.step.into![0]!;
      const fp = plan(catalog, { metrics: ['people'], dimensions: [{ field: 'crew.days' }, { field: q }] });
      const sql = renderSql(fp, index, today);
      const fromSql = local.prepare(sql.sql).all(...(sql.params.map((x) => x.value) as Array<string | number>)) as Array<Record<string, unknown>>;
      const fromPage = runPlan(fp, index, { crew: rows as unknown as TableRows[string] }, today).rows as Array<Record<string, unknown>>;
      assert.deepEqual(norm(fromSql), norm(fromPage), `${k} groups of ${JSON.stringify(days)}`);
      // Grouped by value and group: each value appears once, so equal values never split.
      const groupOf = new Map<number, string>();
      for (const row of fromPage) {
        const v = row.d0 as number | null;
        if (v === null) {
          assert.equal(row.d1, null, 'a blank stays blank');
          continue;
        }
        assert.ok(!groupOf.has(v), `value ${v} in two groups`);
        groupOf.set(v, row.d1 as string);
      }
      // The rule by hand: floor(values below * k / n) + 1, and Access's bounds give the same label.
      const bounds = p.step.bounds!;
      assert.equal(bounds.length, k - 1);
      for (const [v] of counts) {
        const below = days.filter((d) => d !== null && d < v).length;
        const want = impl.tileLabel(Math.floor((below * k) / n) + 1, k);
        assert.equal(groupOf.get(v), want, `${v} of ${JSON.stringify(days)} in ${k}`);
        const at = bounds.findIndex((b) => v <= b);
        assert.equal(impl.tileLabel(at < 0 ? k : at + 1, k), want, `Access bounds ${JSON.stringify(bounds)} for ${v}`);
      }
    }
    local.close();
  }
});

test('equal-count SQL for every dialect: RANK and COUNT window functions, Access a Switch over bounds', () => {
  const r = proposeReshape('bucket days open into quartiles', indexCatalog(base()), { source: 's', table: 'crew' });
  assert.ok(r.ok);
  const p = withBounds(r, [1, 1, 1, 1, 2, 3, 3, 9].map((value) => ({ value, count: 1 })));
  // Below 1: 0 → Q1; below 2: 4 → Q3; below 3: 5 → Q3; below 9: 7 → Q4. Q2 is empty and takes Q1's bound.
  assert.deepEqual(p.step.bounds, [1, 1, 3]);
  const want: Record<Dialect, RegExp> = {
    postgres: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN "days" IS NULL THEN 1 ELSE 0 END ORDER BY "days"\) - 1\) \* 4 < COUNT\("days"\) OVER \(\) \* 3 THEN \$3 ELSE \$4 END/,
    oracle: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN "days" IS NULL THEN 1 ELSE 0 END ORDER BY "days"\) - 1\) \* 4 < COUNT\("days"\) OVER \(\) \* 1 THEN :p1/,
    tsql: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN \[days\] IS NULL THEN 1 ELSE 0 END ORDER BY \[days\]\) - 1\) \* 4 < COUNT\(\[days\]\) OVER \(\) \* 1 THEN @p1/,
    synapse: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN \[days\] IS NULL THEN 1 ELSE 0 END ORDER BY \[days\]\) - 1\) \* 4 < COUNT\(\[days\]\) OVER \(\) \* 2 THEN @p2/,
    spark: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN `days` IS NULL THEN 1 ELSE 0 END ORDER BY `days`\) - 1\) \* 4 < COUNT\(`days`\) OVER \(\) \* 1 THEN \?/,
    mysql: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN `days` IS NULL THEN 1 ELSE 0 END ORDER BY `days`\) - 1\) \* 4 < COUNT\(`days`\) OVER \(\) \* 1 THEN \?/,
    sqlite: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN "days" IS NULL THEN 1 ELSE 0 END ORDER BY "days"\) - 1\) \* 4 < COUNT\("days"\) OVER \(\) \* 1 THEN \?/,
    ansi: /\(RANK\(\) OVER \(PARTITION BY CASE WHEN "days" IS NULL THEN 1 ELSE 0 END ORDER BY "days"\) - 1\) \* 4 < COUNT\("days"\) OVER \(\) \* 1 THEN \?/,
    access: /IIf\(\[days\] Is Null, Null, Switch\(\[days\] <= \?, \?, \[days\] <= \?, \?, \[days\] <= \?, \?, True, \?\)\)/,
  };
  for (const dialect of SQL_DIALECTS) {
    const c: Catalog = acceptReshape({ ...base(), sources: [{ id: 's', label: 'S', kind: dialect === 'access' ? 'access' : dialect === 'oracle' ? 'oracle' : dialect === 'postgres' ? 'postgres' : 'other', dialect }] }, p);
    const q = renderSql(plan(c, { metrics: ['people'], dimensions: [{ field: p.step.into![0]! }] }), indexCatalog(c), today);
    assert.match(q.sql, want[dialect], `${dialect}: ${q.sql}`);
    assert.doesNotMatch(q.sql, /NTILE|FLOOR/i, dialect);
    if (dialect === 'access') assert.deepEqual(q.params.slice(0, 7).map((x) => x.value), [1, 'Q1', 1, 'Q2', 3, 'Q3', 'Q4']);
    else assert.deepEqual(q.params.filter((x) => typeof x.value === 'string' && /^Q\d$/.test(x.value)).map((x) => x.value), ['Q1', 'Q2', 'Q3', 'Q4']);
  }
});

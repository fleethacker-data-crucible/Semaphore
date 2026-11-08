// The SQLite dialect (Semaphore's local database) and the MySQL / MariaDB dialect (RDS, Aurora).
// SQLite is proven by running the rendered SQL in Node's own SQLite and comparing with the in-page
// engine; MySQL, which has no server here, by the text it renders and translates to.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { type Catalog, type Dialect, indexCatalog } from '../src/core/catalog.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Flag, Hoist, TimeGrain } from '../src/core/hoist.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import { renderSql, truncate } from '../src/core/sql.ts';
import { translateSql } from '../src/core/sql-translate.ts';

const catalogFor = (dialect: Dialect): Catalog => ({
  version: 1,
  sources: [{ id: 's', label: 'S', kind: dialect === 'sqlite' ? 'csv' : 'other', dialect }],
  fields: [
    { key: 'jobs.region', label: 'Region', source: 's', table: 'jobs', column: 'region', type: 'string' },
    { key: 'jobs.hull', label: 'Hull', source: 's', table: 'jobs', column: 'hull', type: 'string' },
    { key: 'jobs.opened', label: 'Opened', source: 's', table: 'jobs', column: 'opened', type: 'date' },
    { key: 'jobs.cost', label: 'Cost', source: 's', table: 'jobs', column: 'cost', type: 'number' },
  ],
  metrics: [
    { key: 'cost', label: 'Cost', agg: 'sum', field: 'jobs.cost', source: 's' },
    { key: 'hulls', label: 'Hulls', agg: 'count_distinct', field: 'jobs.hull', source: 's' },
    { key: 'jobs', label: 'Jobs', agg: 'count', source: 's', table: 'jobs' },
  ],
});

// Two years of jobs, including Sundays, month and quarter edges, and a leap day.
const ROWS = (() => {
  const out: Array<{ region: string; hull: string; opened: string; cost: number }> = [];
  const start = Date.UTC(2023, 10, 27);
  for (let i = 0; i < 420; i++) {
    const d = new Date(start + i * 86400000 * 1.7);
    out.push({ region: ['North', 'South', 'East'][i % 3]!, hull: `H${i % 17}`, opened: d.toISOString().slice(0, 10), cost: (i * 37) % 500 });
  }
  out.push({ region: 'North', hull: 'H1', opened: '2024-02-29', cost: 99 });
  return out;
})();

const today = new Date('2025-06-15T00:00:00Z');

function page(binding: Partial<Binding>, dialect: Dialect): { plan: QueryPlan; catalog: Catalog } {
  const catalog = catalogFor(dialect);
  const flag: Flag = { id: 'f', kind: 'table', title: 'T', brief: '', layout: { x: 0, y: 0, w: 4, h: 3 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: [], dimensions: [], filters: [], ...binding } };
  const hoist: Hoist = { version: 1, id: 'h', title: '', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' };
  const p = planFlag(hoist, flag, indexCatalog(catalog));
  if (!p.ok) throw new Error(p.error);
  return { plan: p.plan, catalog };
}

const db = new sqlite.DatabaseSync(':memory:');
db.exec('CREATE TABLE jobs (region TEXT, hull TEXT, opened DATE, cost REAL)');
const insert = db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)');
for (const r of ROWS) insert.run(r.region, r.hull, r.opened, r.cost);
const tables: TableRows = { jobs: ROWS as unknown as TableRows[string] };

const normal = (rows: Array<Record<string, unknown>>) =>
  rows
    .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : v]))))
    .sort();

function sameAsEngine(binding: Partial<Binding>) {
  const { plan, catalog } = page(binding, 'sqlite');
  const index = indexCatalog(catalog);
  const q = renderSql(plan, index, today);
  assert.equal(q.dialect, 'sqlite');
  const params = q.params.map((p) => (typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value)) as Array<string | number>;
  const fromSql = db.prepare(q.sql).all(...params) as Array<Record<string, unknown>>;
  const fromEngine = runPlan(plan, index, tables, today).rows as Array<Record<string, unknown>>;
  assert.deepEqual(normal(fromSql), normal(fromEngine), `${q.sql}`);
  return q.sql;
}

test('SQLite: every date grain groups exactly as the in-page engine does (Monday weeks, quarters, leap day)', () => {
  for (const grain of ['day', 'week', 'month', 'quarter', 'year'] as TimeGrain[]) {
    const sql = sameAsEngine({ metrics: ['cost', 'jobs'], dimensions: [{ field: 'jobs.opened', grain }] });
    assert.match(sql, /date\("/);
  }
});

test('SQLite: "last N" and between filters, distinct counts, and a field split', () => {
  sameAsEngine({ metrics: ['cost'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'last', values: [6], unit: 'month' }] });
  sameAsEngine({ metrics: ['hulls', 'jobs'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.opened', op: 'between', values: ['2024-01-01', '2024-03-31'] }] });
  sameAsEngine({ metrics: ['cost'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.opened', grain: 'quarter' }] });
});

test('SQLite renders double-quoted names, ? markers and LIMIT', () => {
  const { plan, catalog } = page({ metrics: ['cost'], dimensions: [{ field: 'jobs.region' }], filters: [{ field: 'jobs.region', op: 'eq', values: ['North'] }] }, 'sqlite');
  const q = renderSql(plan, indexCatalog(catalog), today);
  assert.match(q.sql, /"region"/);
  assert.match(q.sql, /= \?/);
  assert.match(q.sql, /LIMIT \d+$/);
});

test('MySQL renders backticks, ? markers, LIMIT and its own date grouping', () => {
  const { plan, catalog } = page({ metrics: ['cost'], dimensions: [{ field: 'jobs.opened', grain: 'week' }], filters: [{ field: 'jobs.region', op: 'eq', values: ['North'] }] }, 'mysql');
  const q = renderSql(plan, indexCatalog(catalog), today);
  assert.equal(q.dialect, 'mysql');
  assert.match(q.sql, /`opened`/);
  assert.match(q.sql, /WEEKDAY\(/);
  assert.match(q.sql, /= \?/);
  assert.match(q.sql, /LIMIT \d+$/);
  assert.equal(truncate('d', 'month', 'mysql'), "DATE(DATE_FORMAT(d, '%Y-%m-01'))");
  assert.equal(truncate('d', 'quarter', 'mysql'), 'DATE(MAKEDATE(YEAR(d), 1) + INTERVAL (QUARTER(d) - 1) QUARTER)');
  assert.equal(truncate('d', 'year', 'mysql'), 'MAKEDATE(YEAR(d), 1)');
});

test('translation to and from MySQL and SQLite', () => {
  const t = translateSql('SELECT TOP 5 [Region], LEN([Name]), ISNULL([Cost], 0) FROM [jobs]', 'tsql', 'mysql');
  assert.equal(t.sql, 'SELECT `Region`, CHAR_LENGTH(`Name`), COALESCE(`Cost`, 0) FROM `jobs`\nLIMIT 5');
  const back = translateSql('SELECT `Region`, IFNULL(`Cost`, 0) FROM `jobs` LIMIT 10', 'mysql', 'postgres');
  assert.equal(back.sql, 'SELECT "Region", COALESCE("Cost", 0) FROM "jobs"\nLIMIT 10');
  const pipes = translateSql("SELECT a || b FROM t", 'postgres', 'mysql');
  assert.ok(pipes.notes.some((n) => /PIPES_AS_CONCAT/.test(n)));
  const lite = translateSql("SELECT date_trunc('month', \"opened\") FROM \"jobs\" FETCH FIRST 3 ROWS ONLY", 'oracle', 'sqlite');
  assert.equal(lite.sql, `SELECT date("opened", 'start of month') FROM "jobs"\nLIMIT 3`);
  assert.ok(translateSql("SELECT DATE_FORMAT(d, '%Y') FROM t", 'mysql', 'sqlite').notes.some((n) => /DATE_FORMAT/.test(n)));
});

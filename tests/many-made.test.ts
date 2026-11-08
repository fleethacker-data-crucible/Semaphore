// Fields made by cleaning steps (split, merge, bucket, quartiles) and reshaped tables on the many
// side of a one-to-many split (manyjoin.ts): computed inside the many-side block, over the many-side
// table's own rows, so a customer is still counted once per group and the groups still overlap.
// The in-page engine and the SQLite SQL (run in Node's own SQLite) give the same rows; the other
// dialects are checked by their text.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { type Catalog, checkCatalog, type Dialect, indexCatalog, SQL_DIALECTS } from '../src/core/catalog.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { describeFlag } from '../src/core/describe.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import * as impl from '../src/core/reshape-impl.ts';
import { registerReshaping } from '../src/core/reshape.ts';
import { acceptReshape, proposeReshape, withBounds, type ReshapeProposal } from '../src/core/reshape-words.ts';
import { renderSql } from '../src/core/sql.ts';

registerReshaping(impl);
const today = new Date('2026-10-28T00:00:00Z');

function shop(dialect: Dialect = 'sqlite'): Catalog {
  const f = (table: string, column: string, label: string, type: 'string' | 'number' = 'string') => ({ key: `${table}.${column}`, label, source: 's', table, column, type });
  return {
    version: 1,
    sources: [{ id: 's', label: 'Shop', kind: dialect === 'sqlite' ? 'csv' : 'other', dialect }],
    fields: [
      f('customers', 'credit_limit', 'Credit limit', 'number'),
      f('customers', 'segment', 'Segment'),
      f('orders', 'customer_id', 'Customer id'),
      f('orders', 'status', 'Order status'),
      f('orders', 'channel', 'Channel'),
      f('orders', 'code', 'Order code'),
      f('orders', 'total', 'Order total', 'number'),
      f('orders', 'm1', 'M1', 'number'),
      f('orders', 'm2', 'M2', 'number'),
    ],
    metrics: [
      { key: 'credit', label: 'Credit limit', agg: 'sum', field: 'customers.credit_limit', source: 's' },
      { key: 'customers', label: 'Customers', agg: 'count', table: 'customers', source: 's' },
    ],
    relationships: [{ id: 'r1', source: 's', from: { table: 'orders', column: 'customer_id' }, to: { table: 'customers', column: 'id' } }],
  };
}

const ROWS: TableRows = {
  customers: [
    { id: 'C1', credit_limit: 100, segment: 'gold' },
    { id: 'C2', credit_limit: 200, segment: 'gold' },
    { id: 'C3', credit_limit: 300, segment: 'silver' },
    { id: 'C4', credit_limit: 400, segment: 'silver' },
  ],
  orders: [
    // Alice (C1) has an order entered twice, two AA orders and a BB one.
    { id: 'o1', customer_id: 'C1', status: 'open', channel: 'web', code: 'AA-1', total: 10, m1: 1, m2: 2 },
    { id: 'o1', customer_id: 'C1', status: 'open', channel: 'web', code: 'AA-1', total: 10, m1: 1, m2: 2 },
    { id: 'o2', customer_id: 'C1', status: 'open', channel: 'shop', code: 'AA-2', total: 20, m1: 3, m2: 0 },
    { id: 'o3', customer_id: 'C1', status: 'shipped', channel: 'web', code: 'BB-1', total: 30, m1: 0, m2: 5 },
    { id: 'o4', customer_id: 'C2', status: 'open', channel: 'web', code: 'BB-2', total: 40, m1: 2, m2: 2 },
    { id: 'o5', customer_id: 'C4', status: 'shipped', channel: 'shop', code: 'CC-1', total: 50, m1: 4, m2: null },
    { id: 'o6', customer_id: 'C4', status: 'shipped', channel: 'shop', code: 'CC-2', total: 60, m1: 1, m2: 1 },
    { id: 'o9', customer_id: null, status: 'open', channel: 'web', code: 'DD-1', total: 99, m1: 9, m2: 9 },
  ],
};

/** The shop with every making step accepted, as an analyst would from a sentence. */
function made(dialect: Dialect = 'sqlite') {
  let catalog = shop(dialect);
  const keys: Record<string, string> = {};
  const take = (name: string, sentence: string, values?: boolean) => {
    const r = proposeReshape(sentence, indexCatalog(catalog), { source: 's', table: 'orders' });
    assert.ok(r.ok, r.ok ? '' : r.error);
    const p: ReshapeProposal = values ? withBounds(r, ROWS.orders!.map((x) => ({ value: x.total ?? null, count: 1 }))) : r;
    catalog = acceptReshape(catalog, p);
    keys[name] = p.step.into![0]!;
    if (name === 'unpivot') {
      keys.value = p.step.into![1]!;
      keys.table = p.step.table!;
    }
  };
  take('prefix', 'split order code on the dash into prefix and number');
  take('mix', "join order status and channel with ' / ' as mix");
  take('size', 'group order total into 0-25, 26+');
  take('quartile', 'bucket order total into quartiles', true);
  take('unpivot', 'turn the month columns M1..M2 into rows of month and amount');
  // The reshaped table points at customers, as orders do.
  catalog = { ...catalog, relationships: [...catalog.relationships!, { id: 'r2', source: 's', from: { table: keys.table!, column: 'customer_id' }, to: { table: 'customers', column: 'id' } }] };
  assert.deepEqual(checkCatalog(catalog), []);
  assert.deepEqual(impl.checkReshape(catalog), []);
  return { catalog, keys };
}

function plan(catalog: Catalog, binding: Partial<Binding>): QueryPlan {
  const flag: Flag = { id: 'f', kind: 'bar', title: 't', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: [], dimensions: [], filters: [], ...binding } };
  const hoist: Hoist = { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' };
  const p = planFlag(hoist, flag, indexCatalog(catalog));
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

const db = new sqlite.DatabaseSync(':memory:');
db.exec('CREATE TABLE customers (id TEXT, credit_limit REAL, segment TEXT)');
db.exec('CREATE TABLE orders (id TEXT, customer_id TEXT, status TEXT, channel TEXT, code TEXT, total REAL, m1 REAL, m2 REAL)');
for (const r of ROWS.customers!) db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(r.id as string, r.credit_limit as number, r.segment as string);
for (const r of ROWS.orders!) db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...(['id', 'customer_id', 'status', 'channel', 'code', 'total', 'm1', 'm2'].map((c) => r[c] ?? null) as Array<string | number | null>));
const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, typeof r[k] === 'number' ? Math.round((r[k] as number) * 1000) / 1000 : (r[k] ?? null)]))).sort();

/** Runs in the engine and as SQLite SQL, checks they agree, and gives the display values by group. */
function both(catalog: Catalog, binding: Partial<Binding>, metric = 'credit') {
  const p = plan(catalog, binding);
  const index = indexCatalog(catalog);
  const q = renderSql(p, index, today);
  const fromSql = db.prepare(q.sql).all(...(q.params.map((x) => x.value) as Array<string | number>)) as Array<Record<string, unknown>>;
  const engine = runPlan(p, index, ROWS, today).rows;
  assert.deepEqual(norm(fromSql), norm(engine), q.sql);
  const shown = applySelections(p, engine, {}, { onClick: 'none', ignore: [], thresholds: [] });
  return { plan: p, sql: q.sql, by: Object.fromEntries(shown.rows.map((r) => [Object.values(r.dims).map(String).join('/'), r.values[metric] ?? null])), totals: shown.totals };
}

test('split and merge on the many side: each customer once per group, never once per order', () => {
  const { catalog, keys } = made();
  const prefix = both(catalog, { metrics: ['credit'], dimensions: [{ field: keys.prefix! }] });
  // Alice has two AA orders (one entered twice) and a BB one: 100 in AA, 100 in BB, never 300.
  assert.deepEqual(prefix.by, { AA: 100, BB: 300, CC: 400, null: 300 });
  assert.ok(prefix.plan.many?.overlap);
  assert.equal(prefix.totals.credit, null); // groups overlap: no total built by adding them up
  assert.match(prefix.sql, /\(SELECT "s"\.\*, .+ AS "sem_made0" FROM "orders" AS "s"\) AS "m0"/);
  const mix = both(catalog, { metrics: ['credit', 'customers'], dimensions: [{ field: keys.mix! }] });
  assert.deepEqual(mix.by, { 'open / web': 300, 'open / shop': 100, 'shipped / web': 100, 'shipped / shop': 400, null: 300 });
  // A filter on a made field is a semi-join: customers with a matching order, once each.
  const bb = both(catalog, { metrics: ['credit'], dimensions: [{ field: 'customers.segment' }], filters: [{ field: keys.prefix!, op: 'eq', values: ['BB'] }] });
  assert.deepEqual(bb.by, { gold: 300 });
  assert.equal(bb.plan.many?.overlap, false);
  // Made and cleaned fields together, the cleaned one in the block's inner query.
  const cleaned: Catalog = { ...catalog, cleaning: [...catalog.cleaning!, { id: 'up', field: 'orders.channel', kind: 'map', map: { web: 'online' }, sentence: 'Read web as online' }] };
  const both2 = both(cleaned, { metrics: ['credit'], dimensions: [{ field: keys.prefix! }, { field: 'orders.channel' }] });
  assert.deepEqual(both2.by, { 'AA/online': 100, 'AA/shop': 100, 'BB/online': 300, 'CC/shop': 400, 'null/null': 300 });
});

test('buckets and quartiles on the many side: quartiles rank the orders’ own rows', () => {
  const { catalog, keys } = made();
  const size = both(catalog, { metrics: ['credit'], dimensions: [{ field: keys.size! }] });
  assert.deepEqual(size.by, { '0-25': 100, '26+': 700, null: 300 });
  const small = both(catalog, { metrics: ['credit', 'customers'], filters: [{ field: keys.size!, op: 'eq', values: ['0-25'] }] }, 'customers');
  assert.deepEqual(small.by, { '': 1 });
  // Order totals 10, 10, 20, 30, 40, 50, 60, 99: two orders per quartile, whoever placed them.
  const q = both(catalog, { metrics: ['credit'], dimensions: [{ field: keys.quartile! }] });
  assert.deepEqual(q.by, { Q1: 100, Q2: 100, Q3: 600, Q4: 400, null: 300 });
  assert.match(q.sql, /NTILE\(4\) OVER .+ FROM "orders" AS "s"\) AS "m0"/);
});

test('a reshaped table on the many side: its rows built from the stored table, then split by', () => {
  const { catalog, keys } = made();
  const month = both(catalog, { metrics: ['credit'], dimensions: [{ field: keys.unpivot! }] });
  assert.deepEqual(month.by, { M1: 700, M2: 700, null: 300 });
  const big = both(catalog, { metrics: ['credit'], dimensions: [{ field: keys.unpivot! }], filters: [{ field: keys.value!, op: 'gte', values: [3] }] });
  assert.deepEqual(big.by, { M1: 500, M2: 100 });
  assert.match(big.sql, /UNION ALL/);
  // The readback still explains the counting.
  const flag: Flag = { id: 'f', kind: 'bar', title: 't', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, status: 'ready', notes: [], behavior: { onClick: 'none', ignore: [], thresholds: [] }, binding: { metrics: ['credit'], dimensions: [{ field: keys.unpivot! }], filters: [] } };
  assert.match(describeFlag(flag, null, indexCatalog(catalog)).join(' '), /counted once in every group/);
});

test('every dialect: made fields inside the many-side block, values bound in the order they appear', () => {
  for (const dialect of SQL_DIALECTS) {
    const { catalog, keys } = made(dialect);
    const index = indexCatalog(catalog);
    for (const field of [keys.prefix!, keys.mix!, keys.size!, keys.quartile!, keys.unpivot!]) {
      const q = renderSql(plan(catalog, { metrics: ['credit'], dimensions: [{ field }], filters: [{ field: 'customers.segment', op: 'eq', values: ['gold'] }] }), index, today);
      const markers = q.sql.match(/\$\d+|:p\d+|@p\d+|\?/g) ?? [];
      assert.equal(markers.length, q.params.length, `${dialect} ${field}: ${q.sql}`);
      if (dialect === 'postgres') assert.deepEqual(markers, q.params.map((_, i) => `$${i + 1}`));
      // The page filter on the one side is bound last, after the block's values.
      assert.equal(q.params.at(-1)!.value, 'gold', `${dialect} ${field}`);
      if (field !== keys.unpivot) assert.match(q.sql, /sem_made0/, `${dialect} ${field}`);
    }
  }
});

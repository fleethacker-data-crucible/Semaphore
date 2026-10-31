import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, type Dialect, indexCatalog } from '../src/core/catalog.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { describeFlag } from '../src/core/describe.ts';
import { runPlan, type TableRows } from '../src/core/engine.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { planFlag, type QueryPlan } from '../src/core/planner.ts';
import { renderSql } from '../src/core/sql.ts';

const TODAY = new Date('2026-10-28T12:00:00Z');

/** Customers are the one side; orders and shipments are many sides; order lines are many below orders. */
function shop(dialect: Dialect = 'postgres'): Catalog {
  const f = (table: string, column: string, label: string, type: 'string' | 'number' | 'date' = 'string') => ({
    key: `${table}.${column}`,
    label,
    source: 's',
    table,
    column,
    type,
  });
  return {
    version: 1,
    sources: [{ id: 's', label: 'Shop', kind: dialect === 'tsql' ? 'azure-sql' : dialect === 'ansi' ? 'aws-athena' : dialect, dialect }],
    fields: [
      f('customers', 'credit_limit', 'Credit limit', 'number'),
      f('customers', 'segment', 'Segment'),
      f('customers', 'name', 'Customer'),
      f('regions', 'name', 'Region'),
      f('orders', 'status', 'Order status'),
      f('orders', 'placed_on', 'Placed', 'date'),
      f('orders', 'total', 'Order total', 'number'),
      f('order_lines', 'product_id', 'Line product'),
      f('products', 'category', 'Product category'),
      f('shipments', 'carrier', 'Carrier'),
      f('warehouses', 'name', 'Warehouse'),
    ],
    metrics: [
      { key: 'credit', label: 'Credit limit', agg: 'sum', field: 'customers.credit_limit', source: 's' },
      { key: 'avg_credit', label: 'Average credit limit', agg: 'avg', field: 'customers.credit_limit', source: 's' },
      { key: 'top_credit', label: 'Highest credit limit', agg: 'max', field: 'customers.credit_limit', source: 's' },
      { key: 'customers', label: 'Customers', agg: 'count', table: 'customers', source: 's' },
      { key: 'segments', label: 'Number of distinct segments', agg: 'count_distinct', field: 'customers.segment', source: 's' },
      { key: 'order_total', label: 'Order total', agg: 'sum', field: 'orders.total', source: 's' },
    ],
    relationships: [
      { id: 'r1', source: 's', from: { table: 'orders', column: 'customer_id' }, to: { table: 'customers', column: 'id' } },
      { id: 'r2', source: 's', from: { table: 'customers', column: 'region_id' }, to: { table: 'regions', column: 'id' } },
      { id: 'r3', source: 's', from: { table: 'order_lines', column: 'order_id' }, to: { table: 'orders', column: 'id' } },
      { id: 'r4', source: 's', from: { table: 'order_lines', column: 'product_id' }, to: { table: 'products', column: 'id' } },
    ],
  };
}

const ROWS: TableRows = {
  customers: [
    { id: 'C1', name: 'Alice', region_id: 'R1', credit_limit: 100, segment: 'gold' },
    { id: 'C2', name: 'Bob', region_id: 'R1', credit_limit: 200, segment: 'gold' },
    { id: 'C3', name: 'Cara', region_id: 'R2', credit_limit: 300, segment: 'silver' },
    { id: 'C4', name: 'Dan', region_id: 'R2', credit_limit: 400, segment: 'silver' },
  ],
  regions: [
    { id: 'R1', name: 'North' },
    { id: 'R2', name: 'South' },
  ],
  orders: [
    // Alice has two open orders, one of them entered twice, and a shipped one.
    { id: 'o1', customer_id: 'C1', status: 'open', total: 10, placed_on: '2026-08-02' },
    { id: 'o1', customer_id: 'C1', status: 'open', total: 10, placed_on: '2026-08-02' },
    { id: 'o2', customer_id: 'C1', status: 'open', total: 20, placed_on: '2026-08-20' },
    { id: 'o3', customer_id: 'C1', status: 'shipped', total: 30, placed_on: '2026-09-05' },
    { id: 'o4', customer_id: 'C2', status: 'open', total: 40, placed_on: '2026-10-01' },
    { id: 'o5', customer_id: 'C4', status: 'shipped', total: 50, placed_on: '2026-09-10' },
    { id: 'o6', customer_id: 'C4', status: 'shipped', total: 60, placed_on: '2026-09-11' },
    { id: 'o9', customer_id: null, status: 'open', total: 99, placed_on: '2026-10-02' },
  ],
  order_lines: [
    { id: 'l1', order_id: 'o1', product_id: 'P1' },
    { id: 'l2', order_id: 'o1', product_id: 'P2' },
    { id: 'l3', order_id: 'o2', product_id: 'P1' },
    { id: 'l4', order_id: 'o5', product_id: 'P2' },
    { id: 'l5', order_id: 'o6', product_id: 'P2' },
  ],
  products: [
    { id: 'P1', category: 'tools' },
    { id: 'P2', category: 'parts' },
  ],
  shipments: [{ id: 'h1', customer_id: 'C4', carrier: 'UPS', warehouse_id: 'W1' }],
  warehouses: [{ id: 'W1', name: 'Main' }],
};

function page(binding: Partial<Binding>, filters: Hoist['filters'] = [], extra: Flag[] = []): { hoist: Hoist; flag: Flag } {
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
  return { hoist: { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters, flags: [flag, ...extra], updated: '' }, flag };
}

function plan(catalog: Catalog, binding: Partial<Binding>, filters: Hoist['filters'] = []): QueryPlan {
  const { hoist, flag } = page(binding, filters);
  const p = planFlag(hoist, flag, indexCatalog(catalog));
  if (!p.ok) throw new Error(p.error);
  return p.plan;
}

/** Display values by own-dimension value for the first metric, as the page would show them. */
function shown(catalog: Catalog, p: QueryPlan, rows: TableRows = ROWS): Record<string, number | null> {
  const r = applySelections(p, runPlan(p, indexCatalog(catalog), rows, TODAY).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  return Object.fromEntries(r.rows.map((x) => [Object.values(x.dims).map(String).join('/'), x.values[p.metrics[0]!.key] as number | null]));
}

test('a one-side sum split by the many side counts each customer once per group, not once per order', () => {
  const c = shop();
  // Naive join: open would be 100 × 3 order rows (o1 twice, o2) + 200 = 500. Distinct handling: 300.
  const p = plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }] });
  assert.ok(p.many?.overlap);
  assert.deepEqual(shown(c, p), { open: 300, shipped: 500, null: 300 });
  // The same customers counted once each overall.
  assert.deepEqual(shown(c, plan(c, { metrics: ['credit'] })), { '': 1000 });
});

test('count, average, extremes and distinct counts are all taken over the de-duplicated one-side rows', () => {
  const c = shop();
  const by = (metric: string) => shown(c, plan(c, { metrics: [metric], dimensions: [{ field: 'orders.status' }] }));
  assert.deepEqual(by('customers'), { open: 2, shipped: 2, null: 1 });
  assert.deepEqual(by('avg_credit'), { open: 150, shipped: 250, null: 300 });
  assert.deepEqual(by('top_credit'), { open: 200, shipped: 400, null: 300 });
  assert.deepEqual(by('segments'), { open: 1, shipped: 2, null: 1 });
});

test('a filter on the many side keeps customers with a matching order, once each, and no blank group', () => {
  const c = shop();
  const open = { field: 'orders.status', op: 'eq' as const, values: ['open'] };
  assert.deepEqual(shown(c, plan(c, { metrics: ['credit'], filters: [open] })), { '': 300 });
  assert.deepEqual(shown(c, plan(c, { metrics: ['customers'], filters: [open] })), { '': 2 });
  // Split by a field of the customer itself: no overlap, so no warning and no lost total.
  const byRegion = plan(c, { metrics: ['credit'], dimensions: [{ field: 'regions.name' }], filters: [open] });
  assert.equal(byRegion.many?.overlap, false);
  assert.equal(byRegion.notes.length, 0);
  assert.deepEqual(shown(c, byRegion), { North: 300 });
  // A page filter works the same way, and several filters must hold on the same order.
  assert.deepEqual(shown(c, plan(c, { metrics: ['credit'] }, [open])), { '': 300 });
  const sameOrder = plan(c, {
    metrics: ['customers'],
    filters: [open, { field: 'orders.placed_on', op: 'between', values: ['2026-09-01', '2026-10-31'] }],
  });
  // Alice's open orders are in August, Bob's is in October: only Bob has an open order in that window.
  assert.deepEqual(shown(c, sameOrder), { '': 1 });
});

test('splitting by two fields counts a customer once per combination; a deeper many side and its lookups work', () => {
  const c = shop();
  const both = plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }, { field: 'regions.name' }] });
  assert.deepEqual(shown(c, both), { 'open/North': 300, 'shipped/North': 100, 'shipped/South': 400, 'null/South': 300 });
  // customers <- orders <- order_lines -> products: two steps down, one lookup across.
  const cat = plan(c, { metrics: ['credit'], dimensions: [{ field: 'products.category' }] });
  assert.deepEqual(cat.many?.tables, ['orders', 'order_lines', 'products']);
  // Alice (100) is in tools and parts, Dan (400) in parts. Alice's shipped order and Bob's order have
  // no lines and Cara has no orders, so they fall in the blank group: 100 + 200 + 300.
  assert.deepEqual(shown(c, cat), { tools: 100, parts: 500, null: 600 });
  assert.deepEqual(shown(c, plan(c, { metrics: ['customers'], dimensions: [{ field: 'products.category' }] })), { tools: 1, parts: 2, null: 3 });
});

test('the grand total never doubles: no total is built from overlapping groups', () => {
  const c = shop();
  const p = plan(c, { metrics: ['credit', 'customers'], dimensions: [{ field: 'orders.status' }] });
  const groups = applySelections(p, runPlan(p, indexCatalog(c), ROWS, TODAY).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  const added = groups.rows.reduce((n, r) => n + (r.values.credit ?? 0), 0);
  assert.equal(added, 1100, 'the groups overlap, so they add up to more than the real 1000');
  assert.deepEqual(groups.totals, { credit: null, customers: null }, 'so no total is offered');
  // Without a split the total is the real one.
  const k = plan(c, { metrics: ['credit'] });
  const kpi = applySelections(k, runPlan(k, indexCatalog(c), ROWS, TODAY).rows, {}, { onClick: 'none', ignore: [], thresholds: [] });
  assert.equal(kpi.totals.credit, 1000);
  // A share of the total over overlapping groups is refused rather than shown wrong.
  const { hoist, flag } = page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }], share: true });
  const r = planFlag(hoist, flag, indexCatalog(c));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /share of the total cannot be shown.*Order status.*several groups/);
});

test('the flag readback explains the counting in plain English and warns that groups overlap', () => {
  const c = shop();
  const { hoist, flag } = page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }] });
  const text = describeFlag(flag, hoist, indexCatalog(c)).join(' ');
  assert.match(text, /Customers is the one side of orders: a customer can have several orders/);
  assert.match(text, /counted once in every group it has at least one order in/);
  assert.match(text, /A customer with no orders falls in the blank group/);
  assert.match(text, /groups can add up to more than the real total of customers/);
  const p = plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }] });
  assert.match(p.notes.join(' '), /Order status splits customers.*counted in each.*more than the real total/);
  // A filter explains itself differently, and a plain flag says nothing extra.
  const f = page({ metrics: ['credit'], filters: [{ field: 'orders.status', op: 'eq', values: ['open'] }] });
  const filtered = describeFlag(f.flag, f.hoist, indexCatalog(c)).join(' ');
  assert.match(filtered, /Only customers with at least one order matching Order status are included, each once however many orders match/);
  assert.doesNotMatch(filtered, /add up to more/);
  const plain = page({ metrics: ['credit'], dimensions: [{ field: 'regions.name' }] });
  assert.doesNotMatch(describeFlag(plain.flag, plain.hoist, indexCatalog(c)).join(' '), /one side of/);
  assert.doesNotMatch(describeFlag(plain.flag, null, indexCatalog(c)).join(' '), /one side of/);
});

test('ambiguous many-side paths are refused with a readable message, never guessed', () => {
  // Two relationships from orders to customers (billing and shipping).
  const two = shop();
  two.relationships!.push({ id: 'r5', source: 's', from: { table: 'orders', column: 'ship_customer_id' }, to: { table: 'customers', column: 'id' } });
  const a = page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }] });
  const ra = planFlag(a.hoist, a.flag, indexCatalog(two));
  assert.equal(ra.ok, false);
  assert.match(!ra.ok ? ra.error : '', /"Order status" is in orders, which relates to customers in 2 ways \(orders\.customer_id → customers\.id; or orders\.ship_customer_id → customers\.id\)\. Semaphore will not guess/);
  assert.equal(!ra.ok && ra.reason, 'many-side');
  assert.match(describeFlag(a.flag, a.hoist, indexCatalog(two)).join(' '), /will not guess/, 'the readback shows the refusal');
  // A filter or a page filter on it is refused too, not silently ignored.
  const f = page({ metrics: ['credit'], filters: [{ field: 'orders.status', op: 'eq', values: ['open'] }] });
  assert.equal(planFlag(f.hoist, f.flag, indexCatalog(two)).ok, false);
  const pf = page({ metrics: ['credit'] }, [{ field: 'orders.status', op: 'eq', values: ['open'] }]);
  assert.equal(planFlag(pf.hoist, pf.flag, indexCatalog(two)).ok, false);

  // A diamond: warehouses reached through orders and through shipments.
  const diamond = shop();
  diamond.relationships!.push(
    { id: 'r6', source: 's', from: { table: 'shipments', column: 'customer_id' }, to: { table: 'customers', column: 'id' } },
    { id: 'r7', source: 's', from: { table: 'shipments', column: 'warehouse_id' }, to: { table: 'warehouses', column: 'id' } },
    { id: 'r8', source: 's', from: { table: 'orders', column: 'warehouse_id' }, to: { table: 'warehouses', column: 'id' } },
  );
  const d = page({ metrics: ['credit'], dimensions: [{ field: 'warehouses.name' }] });
  const rd = planFlag(d.hoist, d.flag, indexCatalog(diamond));
  assert.equal(rd.ok, false);
  assert.match(!rd.ok ? rd.error : '', /"Warehouse".*2 ways.*orders\.customer_id → customers\.id, then orders\.warehouse_id → warehouses\.id; or shipments\.customer_id → customers\.id, then shipments\.warehouse_id → warehouses\.id/);

  // Two different many-side tables in one flag: refused, not cross-multiplied.
  const both = page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }, { field: 'shipments.carrier' }] });
  const rb = planFlag(both.hoist, both.flag, indexCatalog(diamond));
  assert.equal(rb.ok, false);
  assert.match(!rb.ok ? rb.error : '', /different many-side tables of customers \(orders and shipments\)/);

  // A many-to-one path still wins when it exists, and unrelated tables are still refused.
  const un = page({ metrics: ['credit'], dimensions: [{ field: 'regions.name' }] });
  assert.equal(planFlag(un.hoist, un.flag, indexCatalog(diamond)).ok, true);
  const none = shop();
  none.relationships = none.relationships!.filter((r) => r.id !== 'r1');
  const nr = page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }] });
  assert.match((planFlag(nr.hoist, nr.flag, indexCatalog(none)) as { error: string }).error, /not related to customers/);
});

test('page selections on a many-side field re-query the source; selections on the customer still apply locally', () => {
  const c = shop();
  const index = indexCatalog(c);
  const byStatus: Flag = { ...page({ metrics: ['credit'], dimensions: [{ field: 'orders.status' }] }).flag, id: 'a' };
  byStatus.behavior.onClick = 'filter-page';
  const bySegment: Flag = { ...page({ metrics: ['credit'], dimensions: [{ field: 'customers.segment' }] }).flag, id: 'b' };
  bySegment.behavior.onClick = 'filter-page';
  const hoist: Hoist = { ...page({}).hoist, flags: [byStatus, bySegment] };

  // Credit by segment, with "orders.status" selectable elsewhere: it must not be pre-split, or
  // adding the status groups back up would count a customer twice.
  const seg = planFlag(hoist, bySegment, index);
  assert.ok(seg.ok);
  assert.deepEqual(seg.plan.slices, []);
  assert.deepEqual(seg.plan.live, ['orders.status']);
  assert.match(seg.plan.notes.join(' '), /Selections on Order status re-query the source/);
  assert.deepEqual(shown(c, seg.plan), { gold: 300, silver: 700 });
  // The status flag may pre-split by the customer's own segment: each customer is in one segment.
  const st = planFlag(hoist, byStatus, index);
  assert.ok(st.ok);
  assert.deepEqual(st.plan.slices, ['customers.segment']);
  assert.deepEqual(shown(c, st.plan), { open: 300, shipped: 500, null: 300 });
  const picked = applySelections(st.plan, runPlan(st.plan, index, ROWS, TODAY).rows, { 'customers.segment': ['silver'] }, byStatus.behavior);
  assert.deepEqual(Object.fromEntries(picked.rows.map((r) => [String(Object.values(r.dims)[0]), r.values.credit])), { shipped: 400, null: 300 });
  // The re-query: selecting "open" adds a filter, and customers with an open order are counted once.
  const narrowed: Flag = { ...bySegment, binding: { ...bySegment.binding!, filters: [{ field: 'orders.status', op: 'in', values: ['open'] }] } };
  const again = planFlag(hoist, narrowed, index);
  assert.ok(again.ok);
  assert.deepEqual(shown(c, again.plan), { gold: 300 });
});

// ---- SQL ------------------------------------------------------------------------------------

const BINDING: Partial<Binding> = {
  metrics: ['credit'],
  dimensions: [{ field: 'orders.status' }],
  filters: [
    { field: 'orders.status', op: 'in', values: ['open', 'shipped'] },
    { field: 'customers.segment', op: 'eq', values: ['gold'] },
  ],
};

test('SQL, PostgreSQL: a derived table of distinct pairs, every value a bound parameter', () => {
  const c = shop('postgres');
  const q = renderSql(plan(c, BINDING), indexCatalog(c), TODAY);
  assert.equal(
    q.sql,
    'SELECT "mx"."g0" AS "d0", SUM("t0"."credit_limit") AS "a0" FROM "customers" AS "t0" INNER JOIN (SELECT DISTINCT "m0"."customer_id" AS "k", "m0"."status" AS "g0" FROM "orders" AS "m0" WHERE "m0"."status" IN ($1, $2)) AS "mx" ON "t0"."id" = "mx"."k" WHERE "t0"."segment" = $3 GROUP BY "mx"."g0" LIMIT 50000',
  );
  assert.deepEqual(q.params.map((p) => p.value), ['open', 'shipped', 'gold']);
  // With no many-side filter the join is a LEFT JOIN, so customers without orders keep a blank group.
  const left = renderSql(plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }] }), indexCatalog(c), TODAY);
  assert.match(left.sql, /FROM "customers" AS "t0" LEFT JOIN \(SELECT DISTINCT "m0"."customer_id" AS "k", "m0"."status" AS "g0" FROM "orders" AS "m0"\) AS "mx" ON "t0"."id" = "mx"."k" GROUP BY/);
  assert.equal(left.params.length, 0);
});

test('SQL, all five dialects: same shape, own quoting and markers, nothing spliced in', () => {
  const sqlFor = (d: Dialect) => renderSql(plan(shop(d), BINDING), indexCatalog(shop(d)), TODAY);
  const want = ['open', 'shipped', 'gold'];
  for (const d of ['postgres', 'oracle', 'access', 'tsql', 'ansi'] as const) {
    const q = sqlFor(d);
    assert.deepEqual(q.params.map((p) => p.value), want, d);
    for (const v of want) assert.equal(q.sql.includes(`'${v}'`) || q.sql.includes(`"${v}"`), false, `${d}: ${v} is a parameter`);
    assert.match(q.sql, /SELECT DISTINCT/, d);
  }
  const oracle = sqlFor('oracle').sql;
  assert.match(oracle, /FROM "customers" "t0" INNER JOIN \(SELECT DISTINCT "m0"."customer_id" AS "k", "m0"."status" AS "g0" FROM "orders" "m0" WHERE "m0"."status" IN \(:p1, :p2\)\) "mx" ON "t0"."id" = "mx"."k" WHERE "t0"."segment" = :p3 GROUP BY "mx"."g0" FETCH FIRST 50000 ROWS ONLY$/);
  const tsql = sqlFor('tsql').sql;
  assert.match(tsql, /^SELECT TOP 50000 \[mx\]\.\[g0\] AS \[d0\], SUM\(\[t0\]\.\[credit_limit\]\) AS \[a0\] FROM \[customers\] AS \[t0\] INNER JOIN \(SELECT DISTINCT \[m0\]\.\[customer_id\] AS \[k\], \[m0\]\.\[status\] AS \[g0\] FROM \[orders\] AS \[m0\] WHERE \[m0\]\.\[status\] IN \(@p1, @p2\)\) AS \[mx\] ON \[t0\]\.\[id\] = \[mx\]\.\[k\] WHERE \[t0\]\.\[segment\] = @p3 GROUP BY \[mx\]\.\[g0\]$/);
  const ansi = sqlFor('ansi').sql;
  assert.match(ansi, /WHERE "m0"."status" IN \(\?, \?\)\) AS "mx" ON "t0"."id" = "mx"."k" WHERE "t0"."segment" = \? GROUP BY "mx"."g0" LIMIT 50000$/);
  const access = sqlFor('access').sql;
  assert.match(access, /^SELECT TOP 50000 \[mx\]\.\[g0\] AS \[d0\], SUM\(\[t0\]\.\[credit_limit\]\) AS \[a0\] FROM \[customers\] AS \[t0\] INNER JOIN \(SELECT DISTINCT \[m0\]\.\[customer_id\] AS \[k\], \[m0\]\.\[status\] AS \[g0\] FROM \[orders\] AS \[m0\] WHERE \[m0\]\.\[status\] IN \(\?, \?\)\) AS \[mx\] ON/);
});

test('SQL, Access nests every join, the many-side ones too; Oracle keeps the plain alias form', () => {
  const split = { metrics: ['credit'], dimensions: [{ field: 'regions.name' }, { field: 'products.category' }] };
  const access = renderSql(plan(shop('access'), split), indexCatalog(shop('access')), TODAY).sql;
  // One-side lookups first: (customers LEFT JOIN regions) LEFT JOIN (derived table).
  assert.match(access, /FROM \(\[customers\] AS \[t0\] LEFT JOIN \[regions\] AS \[t1\] ON \[t0\]\.\[region_id\] = \[t1\]\.\[id\]\) LEFT JOIN \(SELECT DISTINCT/);
  // Inside the derived table: ((orders LEFT JOIN order_lines) LEFT JOIN products).
  assert.match(access, /FROM \(\[orders\] AS \[m0\] LEFT JOIN \[order_lines\] AS \[m1\] ON \[m0\]\.\[id\] = \[m1\]\.\[order_id\]\) LEFT JOIN \[products\] AS \[m2\] ON \[m1\]\.\[product_id\] = \[m2\]\.\[id\]\) AS \[mx\]/);
  const oracle = renderSql(plan(shop('oracle'), split), indexCatalog(shop('oracle')), TODAY).sql;
  assert.match(oracle, /FROM "orders" "m0" LEFT JOIN "order_lines" "m1" ON "m0"."id" = "m1"."order_id" LEFT JOIN "products" "m2" ON "m1"."product_id" = "m2"."id"\) "mx"/);
  assert.match(oracle, /"t0"."id" = "mx"."k"/);
});

test('SQL: dates on the many side are cut to their grain inside the derived table; page dates are bound', () => {
  for (const d of ['postgres', 'oracle', 'access', 'tsql', 'ansi'] as const) {
    const c = shop(d);
    const q = renderSql(
      plan(c, { metrics: ['customers'], dimensions: [{ field: 'orders.placed_on', grain: 'month' }], filters: [{ field: 'orders.placed_on', op: 'last', values: [3], unit: 'month' }] }),
      indexCatalog(c),
      TODAY,
    );
    assert.deepEqual(q.params.map((p) => [p.value, p.type]), [['2026-08-01', 'date']], d);
    // The month is cut inside the DISTINCT, so a customer with two orders in a month counts once.
    const inside = q.sql.match(/\(SELECT DISTINCT .*\) (?:AS )?[["]?\[?mx/)?.[0] ?? '';
    assert.match(inside, /DISTINCT/, d);
    assert.match(inside, /(date_trunc\('month'|TRUNC\(|DATETRUNC\(month|DateSerial\()/, d);
    assert.doesNotMatch(q.sql.slice(q.sql.indexOf('GROUP BY')), /date_trunc|TRUNC|DATETRUNC|DateSerial/, d);
  }
});

test('SQL: cleaning on a many-side field runs once in an inner query, with values bound in text order', () => {
  const c = shop('ansi');
  c.cleaning = [
    { id: 't', field: 'orders.status', kind: 'trim', sentence: 'Remove stray spaces' },
    { id: 'm', field: 'orders.status', kind: 'map', map: { OPEN: 'open' }, sentence: 'Read OPEN as open' },
    { id: 'c', field: 'customers.segment', kind: 'map', map: { GOLD: 'gold' }, sentence: 'Read GOLD as gold' },
  ];
  const p = plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }], filters: [{ field: 'orders.status', op: 'eq', values: ['open'] }, { field: 'customers.segment', op: 'eq', values: ['gold'] }] });
  const q = renderSql(p, indexCatalog(c), TODAY);
  // Parameters follow the text: the customer's cleaning (outer inner-query), then the derived table's, then the filters.
  const count = (q.sql.match(/\?/g) ?? []).length;
  assert.equal(count, q.params.length);
  assert.deepEqual(q.params.map((x) => x.value), ['GOLD', 'gold', 'OPEN', 'open', 'open', 'gold']);
  assert.match(q.sql, /FROM \(SELECT "t0"."credit_limit" AS "c0", CASE "t0"."segment" WHEN \? THEN \? ELSE "t0"."segment" END AS "c1", "mx"."g0" AS "g0" FROM "customers" AS "t0" INNER JOIN \(SELECT DISTINCT "mi"."k" AS "k", "mi"."c0" AS "g0" FROM \(SELECT "m0"."customer_id" AS "k", CASE TRIM\("m0"."status"\) WHEN \? THEN \? ELSE TRIM\("m0"."status"\) END AS "c0" FROM "orders" AS "m0"\) AS "mi" WHERE "mi"."c0" = \?\) AS "mx" ON "t0"."id" = "mx"."k"\) AS "q" WHERE "q"."c1" = \? GROUP BY "q"."g0"/);
});

// ---- Equivalence: the page engine gives what the SQL gives ---------------------------------------

interface Db {
  prepare(sql: string): { all(...params: Array<string | number | null>): Array<Record<string, unknown>> };
  exec(sql: string): void;
}

async function openDb(rows: TableRows): Promise<Db | null> {
  let DatabaseSync: (new (path: string) => Db) | undefined;
  try {
    ({ DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => Db });
  } catch {
    return null;
  }
  const db = new DatabaseSync(':memory:');
  for (const [table, list] of Object.entries(rows)) {
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
    db.exec(`CREATE TABLE "${table}" (${cols.map((x) => `"${x}"`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (${cols.map(() => '?').join(', ')})`) as unknown as { run(...p: unknown[]): void };
    for (const r of list) ins.run(...cols.map((x) => (r[x] ?? null) as never));
  }
  return db;
}

const norm = (rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k] ?? null]))).sort();

test('the page engine and the generated SQL return the same rows (run for real on SQLite)', async (t) => {
  const withCleaning = (c: Catalog): Catalog => ({
    ...c,
    cleaning: [
      { id: 't', field: 'orders.status', kind: 'trim', sentence: 'Remove stray spaces' },
      { id: 'm', field: 'orders.status', kind: 'map', map: { OPEN: 'open' }, sentence: 'Read OPEN as open' },
    ],
  });
  const messy: TableRows = { ...ROWS, orders: [...ROWS.orders!, { id: 'o7', customer_id: 'C3', status: ' OPEN ', total: 5, placed_on: '2026-10-03' }] };
  const open = { field: 'orders.status', op: 'eq' as const, values: ['open'] };
  const cases: Array<{ name: string; catalog: Catalog; rows: TableRows; binding: Partial<Binding> }> = [
    { name: 'sum by status', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit'], dimensions: [{ field: 'orders.status' }] } },
    { name: 'count, avg, max by status', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['customers', 'avg_credit', 'top_credit'], dimensions: [{ field: 'orders.status' }] } },
    { name: 'distinct count by status', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['segments'], dimensions: [{ field: 'orders.status' }] } },
    { name: 'kpi, filtered by status', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit', 'customers'], filters: [open] } },
    { name: 'status and region', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit'], dimensions: [{ field: 'orders.status' }, { field: 'regions.name' }] } },
    { name: 'region, filtered by status', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit'], dimensions: [{ field: 'regions.name' }], filters: [open] } },
    { name: 'two filters on one order', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['customers'], dimensions: [{ field: 'customers.segment' }], filters: [open, { field: 'orders.placed_on', op: 'between', values: ['2026-09-01', '2026-10-31'] }] } },
    { name: 'two steps down, one lookup across', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit', 'customers'], dimensions: [{ field: 'products.category' }] } },
    { name: 'no total from nothing', catalog: shop('ansi'), rows: ROWS, binding: { metrics: ['credit'], dimensions: [{ field: 'orders.status' }], filters: [{ field: 'orders.status', op: 'eq', values: ['nothing'] }] } },
    { name: 'cleaned status', catalog: withCleaning(shop('ansi')), rows: messy, binding: { metrics: ['credit', 'customers'], dimensions: [{ field: 'orders.status' }], filters: [{ field: 'customers.segment', op: 'in', values: ['gold', 'silver'] }] } },
  ];
  if (!(await openDb({}))) {
    t.skip('node:sqlite is not available in this Node');
    return;
  }
  for (const k of cases) {
    const index = indexCatalog(k.catalog);
    const p = plan(k.catalog, k.binding);
    const q = renderSql(p, index, TODAY);
    const db = (await openDb(k.rows))!;
    const sqlRows = db.prepare(q.sql).all(...q.params.map((x) => x.value as string | number));
    const engineRows = runPlan(p, index, k.rows, TODAY).rows;
    assert.deepEqual(norm(engineRows), norm(sqlRows), k.name);
  }
});

test('the engine answers a filter that matches nothing like SQL does: no groups, and a KPI row of nothing', () => {
  const c = shop();
  const none = { field: 'orders.status', op: 'eq' as const, values: ['nothing'] };
  assert.deepEqual(runPlan(plan(c, { metrics: ['credit'], dimensions: [{ field: 'orders.status' }], filters: [none] }), indexCatalog(c), ROWS, TODAY).rows, []);
  assert.deepEqual(runPlan(plan(c, { metrics: ['credit', 'customers'], filters: [none] }), indexCatalog(c), ROWS, TODAY).rows, [{ a0: null, a1: 0 }]);
});

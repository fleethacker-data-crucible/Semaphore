import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Catalog } from '../src/core/catalog.ts';
import type { Binding, Flag, Hoist } from '../src/core/hoist.ts';
import { buildLineage, connected } from '../src/core/lineage.ts';

function shop(extra: Catalog['relationships'] = []): Catalog {
  const f = (table: string, column: string, label: string, type: 'string' | 'number' = 'string') => ({ key: `${table}.${column}`, label, source: 's', table, column, type });
  return {
    version: 1,
    sources: [{ id: 's', label: 'Shop', kind: 'postgres', dialect: 'postgres' }],
    fields: [f('customers', 'credit_limit', 'Credit limit', 'number'), f('customers', 'segment', 'Segment'), f('orders', 'status', 'Order status'), f('products', 'category', 'Product category'), f('order_lines', 'sku', 'SKU')],
    metrics: [{ key: 'credit', label: 'Credit limit', agg: 'sum', field: 'customers.credit_limit', source: 's' }],
    relationships: [
      { id: 'r1', source: 's', from: { table: 'orders', column: 'customer_id' }, to: { table: 'customers', column: 'id' } },
      { id: 'r3', source: 's', from: { table: 'order_lines', column: 'order_id' }, to: { table: 'orders', column: 'id' } },
      { id: 'r4', source: 's', from: { table: 'order_lines', column: 'product_id' }, to: { table: 'products', column: 'id' } },
      ...(extra ?? []),
    ],
  };
}

function page(binding: Partial<Binding>): Hoist {
  const flag: Flag = {
    id: 'f',
    kind: 'bar',
    title: 'Credit by order status',
    brief: '',
    layout: { x: 0, y: 0, w: 6, h: 4 },
    binding: { metrics: ['credit'], dimensions: [], filters: [], ...binding },
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    status: 'drafted',
    notes: [],
  };
  return { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' };
}

const tableId = (t: string) => `t:s|${t}`;
const joins = (l: ReturnType<typeof buildLineage>) => l.edges.filter((e) => e.join).map((e) => `${e.from.slice(4)}>${e.to.slice(4)}`).sort();

test('a one-side measure split by a many-side field shows the join back to the many side', () => {
  const l = buildLineage(shop(), page({ dimensions: [{ field: 'orders.status' }] }));
  assert.ok(l.nodes.some((n) => n.id === tableId('orders')), 'the orders table is in the picture');
  assert.deepEqual(joins(l), ['orders>customers']);
  // and the field still traces to the flag
  assert.ok(connected(l, 'f:orders.status').has('g:f'));
});

test('a deeper many-side field draws every hop: customers, orders, order lines, products', () => {
  const l = buildLineage(shop(), page({ dimensions: [{ field: 'products.category' }] }));
  assert.deepEqual(joins(l), ['order_lines>orders', 'order_lines>products', 'orders>customers']);
  for (const t of ['customers', 'orders', 'order_lines', 'products']) assert.ok(l.nodes.some((n) => n.id === tableId(t)), t);
});

test('a field on the same side as the measure draws no extra join', () => {
  const l = buildLineage(shop(), page({ dimensions: [{ field: 'customers.segment' }] }));
  assert.deepEqual(joins(l), []);
});

test('a field reachable in more than one way is not guessed: the flag says so and no extra tables are pulled in', () => {
  const twice = shop([{ id: 'r9', source: 's', from: { table: 'orders', column: 'billing_customer_id' }, to: { table: 'customers', column: 'id' } }]);
  const l = buildLineage(twice, page({ dimensions: [{ field: 'orders.status' }] }));
  assert.match(l.nodes.find((n) => n.id === 'g:f')!.detail!, /more than one way/);
  assert.ok(!l.nodes.some((n) => n.id === tableId('order_lines')));
});

test('a filter on a many-side field draws its join too', () => {
  const l = buildLineage(shop(), page({ filters: [{ field: 'orders.status', op: 'in', values: ['open'] }] }));
  assert.deepEqual(joins(l), ['orders>customers']);
});

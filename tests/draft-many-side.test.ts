import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { planFlag } from '../src/core/planner.ts';

function shop(extraRelationships: Catalog['relationships'] = [], withWarehouses = false): Catalog {
  const f = (table: string, column: string, label: string, type: 'string' | 'number' = 'string', synonyms?: string[]) => ({ key: `${table}.${column}`, label, source: 's', table, column, type, ...(synonyms ? { synonyms } : {}) });
  return {
    version: 1,
    sources: [{ id: 's', label: 'Shop', kind: 'postgres', dialect: 'postgres' }],
    fields: [
      f('customers', 'credit_limit', 'Credit limit', 'number'),
      f('customers', 'segment', 'Segment'),
      f('orders', 'status', 'Order status', 'string', ['status']),
      f('orders', 'total', 'Order total', 'number'),
      f('products', 'category', 'Product category'),
      f('order_lines', 'sku', 'SKU'),
      ...(withWarehouses ? [f('warehouses', 'name', 'Warehouse')] : []),
    ],
    metrics: [
      { key: 'credit', label: 'Credit limit', agg: 'sum', field: 'customers.credit_limit', source: 's' },
      { key: 'order_total', label: 'Order total', agg: 'sum', field: 'orders.total', source: 's' },
    ],
    relationships: [
      { id: 'r1', source: 's', from: { table: 'orders', column: 'customer_id' }, to: { table: 'customers', column: 'id' } },
      { id: 'r3', source: 's', from: { table: 'order_lines', column: 'order_id' }, to: { table: 'orders', column: 'id' } },
      { id: 'r4', source: 's', from: { table: 'order_lines', column: 'product_id' }, to: { table: 'products', column: 'id' } },
      ...(extraRelationships ?? []),
    ],
  };
}

const draft = (brief: string, c: Catalog = shop()) => draftFlagLocally(brief, 'bar', indexCatalog(c));

function plans(c: Catalog, d: ReturnType<typeof draft>): boolean {
  const flag: Flag = { id: 'f', kind: 'bar', title: 't', brief: '', layout: { x: 0, y: 0, w: 6, h: 4 }, binding: d.binding!, behavior: { onClick: 'none', ignore: [], thresholds: [] }, status: 'drafted', notes: [] };
  const hoist: Hoist = { version: 1, id: 'h', title: 't', brief: '', grid: { cols: 12 }, filters: [], flags: [flag], updated: '' };
  return planFlag(hoist, flag, indexCatalog(c)).ok;
}

test('"credit limit by order status" splits a one-side measure by a many-side field, with a plain warning', () => {
  const d = draft('Credit limit by order status');
  assert.deepEqual(d.binding?.metrics, ['credit']);
  assert.deepEqual(d.binding?.dimensions, [{ field: 'orders.status' }]);
  assert.match(d.notes.join(' '), /once in every group it appears in/);
  assert.ok(plans(shop(), d), 'the draft plans');
});

test('a field of the measure\'s own table and a many-side field can be split by together', () => {
  const d = draft('Credit limit by segment and order status');
  assert.deepEqual(d.binding?.dimensions.map((x) => x.field), ['customers.segment', 'orders.status']);
  assert.ok(plans(shop(), d));
});

test('a deeper many-side field (through order lines) is reached too', () => {
  const d = draft('Credit limit by product category');
  assert.deepEqual(d.binding?.dimensions, [{ field: 'products.category' }]);
  assert.ok(plans(shop(), d));
});

test('only one many-side table per flag: the second is left out and says why', () => {
  const d = draft('Credit limit by order status and product category');
  assert.deepEqual(d.binding?.dimensions.map((x) => x.field), ['orders.status']);
  assert.match(d.notes.join(' '), /different many-side table/);
  assert.ok(plans(shop(), d));
});

test('a field reachable in more than one way is not guessed', () => {
  const c = shop([{ id: 'r9', source: 's', from: { table: 'orders', column: 'billing_customer_id' }, to: { table: 'customers', column: 'id' } }]);
  const d = draft('Credit limit by order status', c);
  assert.deepEqual(d.binding?.dimensions, []);
  assert.match(d.notes.join(' '), /more than one way/);
});

test('a table with no relationship at all is still refused as before', () => {
  const d = draft('Credit limit by warehouse', shop([], true));
  assert.deepEqual(d.binding?.dimensions, []);
  assert.match(d.notes.join(' '), /not related to this one/);
});

test('splitting by a field on the one side (many-to-one) is unchanged and gets no many-side warning', () => {
  const d = draft('Order total by segment');
  assert.deepEqual(d.binding?.metrics, ['order_total']);
  assert.deepEqual(d.binding?.dimensions, [{ field: 'customers.segment' }]);
  assert.doesNotMatch(d.notes.join(' '), /once in every group/);
  assert.ok(plans(shop(), d));
});

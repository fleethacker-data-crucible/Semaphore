import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexCatalog } from '../src/core/catalog.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import { proposeCatalog } from '../src/core/profile.ts';

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

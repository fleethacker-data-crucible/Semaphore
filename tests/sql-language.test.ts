import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, indexCatalog, type Dialect } from '../src/core/catalog.ts';
import { planFlag } from '../src/core/planner.ts';
import { renderSql } from '../src/core/sql.ts';
import { sqlLanguage } from '../web/src/lib/sql-language.ts';
import { flag, loadCatalog, loadHoist } from './fixtures.ts';

test('SQL explanations follow the actual driver markers, even for a PostgreSQL source', () => {
  const index = indexCatalog(loadCatalog());
  const hoist = loadHoist();
  const planned = planFlag(hoist, flag(hoist, 'kpi-cost'), index);
  assert.ok(planned.ok);
  const native = renderSql(planned.plan, index, new Date('2026-10-29'));
  const positional = renderSql(planned.plan, index, new Date('2026-10-29'), { placeholders: 'question' });
  assert.ok(native.params.length > 0);
  assert.match(sqlLanguage(native).parameters, /\$1/);
  assert.match(sqlLanguage(positional).parameters, /^\? marks/);
  assert.equal(sqlLanguage(positional).name, 'PostgreSQL');
});

test('an unknown imported SQL dialect is rejected instead of falling through to a generic renderer', () => {
  const catalog = loadCatalog();
  const index = indexCatalog(catalog);
  const hoist = loadHoist();
  const planned = planFlag(hoist, flag(hoist, 'kpi-cost'), index);
  assert.ok(planned.ok);
  const source = index.source(planned.plan.source)!;
  source.kind = 'other';
  source.dialect = 'not-a-supported-database' as Dialect;
  assert.ok(checkCatalog(catalog).some(message => message.includes('unsupported SQL dialect')));
  assert.throws(() => renderSql(planned.plan, index), /unsupported SQL dialect/);
});

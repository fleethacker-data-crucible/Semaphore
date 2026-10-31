import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, type Dialect, dialectForKind, indexCatalog, type SourceKind } from '../src/core/catalog.ts';
import { planFlag } from '../src/core/planner.ts';
import { renderSql } from '../src/core/sql.ts';
import { sqlLanguage } from '../web/src/lib/sql-language.ts';
import { loadCatalog, loadHoist } from './fixtures.ts';

const TODAY = new Date('2026-10-29');

/** Every flag of the example hoist rendered for one dialect (the catalog's first source is switched). */
function renderAll(dialect: Dialect) {
  const catalog = loadCatalog();
  catalog.sources.forEach((s) => (s.dialect = dialect));
  const index = indexCatalog(catalog);
  const hoist = loadHoist();
  const out: string[] = [];
  for (const f of hoist.flags) {
    const planned = planFlag(hoist, f, index);
    if (!planned.ok) continue;
    try { out.push(renderSql(planned.plan, index, TODAY).sql); } catch { /* flags the dialect refuses */ }
  }
  return out;
}

test('source kinds map to their SQL profile and a catalog is checked against it', () => {
  const want: Record<string, Dialect> = { postgres: 'postgres', oracle: 'oracle', access: 'access', 'azure-sql': 'tsql', 'azure-synapse': 'synapse', foundry: 'spark', 'aws-redshift': 'ansi', 'aws-athena': 'ansi', csv: 'ansi' };
  for (const [kind, d] of Object.entries(want)) assert.equal(dialectForKind(kind as SourceKind), d, kind);
  const catalog = loadCatalog();
  catalog.sources[0]!.kind = 'azure-synapse';
  catalog.sources[0]!.dialect = 'tsql';
  assert.ok(checkCatalog(catalog).some((m) => /azure-synapse but uses the tsql dialect; use synapse/.test(m)));
  catalog.sources[0]!.dialect = 'synapse';
  assert.deepEqual(checkCatalog(catalog).filter((m) => /dialect/.test(m)), []);
  catalog.sources[0]!.kind = 'foundry';
  assert.ok(checkCatalog(catalog).some((m) => /use spark/.test(m)));
  catalog.sources[0]!.kind = 'aws-redshift';
  catalog.sources[0]!.dialect = 'postgres';
  assert.ok(checkCatalog(catalog).some((m) => /use ansi/.test(m)));
});

test('synapse renders T-SQL without DATETRUNC and with TOP, brackets and native markers', () => {
  const sqls = renderAll('synapse');
  assert.ok(sqls.length > 0);
  const all = sqls.join('\n');
  assert.doesNotMatch(all, /DATETRUNC/i);
  assert.match(all, /SELECT TOP \d+ /);
  assert.match(all, /\[[A-Za-z_ ]+\]/);
  assert.doesNotMatch(all, /LIMIT \d+/);
  assert.match(all, /DATEADD\((month|year|quarter|week|day), /);
  assert.match(all, /@p1/);
});

test('synapse date grouping truncates by whole periods, Monday weeks included', () => {
  const catalog = loadCatalog();
  catalog.sources.forEach((s) => (s.dialect = 'synapse'));
  const index = indexCatalog(catalog);
  const hoist = loadHoist();
  const grains = new Set<string>();
  for (const f of hoist.flags) {
    const p = planFlag(hoist, f, index);
    if (!p.ok) continue;
    for (const d of p.plan.dimensions) if (d.grain) grains.add(d.grain);
  }
  assert.ok(grains.size > 0);
  // the week form: whole weeks from 1900-01-01, a Monday
  const week = renderAll('synapse').join('\n');
  if (grains.has('week')) assert.match(week, /DATEDIFF\(day, '19000101'/);
});

test('spark renders backtick names, date_trunc and positional markers', () => {
  const all = renderAll('spark').join('\n');
  assert.match(all, /`[A-Za-z_ ]+`/);
  assert.doesNotMatch(all, /"[A-Za-z_ ]+"/);
  assert.doesNotMatch(all, /@p\d|\$\d/);
  assert.match(all, /\?/);
});

test('spark never lets a name break out of its backticks', () => {
  const catalog = loadCatalog();
  catalog.sources.forEach((s) => (s.dialect = 'spark'));
  catalog.fields[0]!.column = 'bad`name';
  assert.ok(checkCatalog(catalog).some((m) => /will not quote safely/.test(m)));
});

test('the card names the new SQL languages', () => {
  const catalog = loadCatalog();
  catalog.sources.forEach((s) => (s.dialect = 'spark'));
  const index = indexCatalog(catalog);
  const hoist = loadHoist();
  const f = hoist.flags.find((x) => planFlag(hoist, x, index).ok)!;
  const p = planFlag(hoist, f, index);
  assert.ok(p.ok);
  const sql = renderSql(p.plan, index, TODAY, { placeholders: 'question' });
  assert.equal(sqlLanguage(sql).name, 'Spark SQL (Foundry, Databricks)');
  catalog.sources.forEach((s) => (s.dialect = 'synapse'));
  assert.equal(sqlLanguage(renderSql(p.plan, indexCatalog(catalog), TODAY)).name, 'T-SQL (Azure Synapse)');
});

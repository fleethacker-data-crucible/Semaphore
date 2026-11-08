import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateSql } from '../src/core/sql-translate.ts';

const t = (sql: string, from: Parameters<typeof translateSql>[1], to: Parameters<typeof translateSql>[2]) => translateSql(sql, from, to);

test('the same dialect comes back unchanged', () => {
  const r = t('SELECT TOP 5 [a] FROM [t]', 'tsql', 'tsql');
  assert.equal(r.sql, 'SELECT TOP 5 [a] FROM [t]');
  assert.equal(r.changed, false);
});

test('T-SQL written for a PostgreSQL source', () => {
  const r = t("SELECT TOP 10 [Region], ISNULL([Cost], 0) AS cost, LEN([Name]) FROM [dbo].[jobs] WHERE [Opened] >= GETDATE() AND [Name] = 'O''Neil'", 'tsql', 'postgres');
  assert.equal(r.sql, `SELECT "Region", COALESCE("Cost", 0) AS cost, LENGTH("Name") FROM "dbo"."jobs" WHERE "Opened" >= CURRENT_TIMESTAMP AND "Name" = 'O''Neil'\nLIMIT 10`);
});

test('PostgreSQL written for SQL Server, and back again', () => {
  const pg = `SELECT "region", date_trunc('month', "opened") AS m, "a" || "b", amount::numeric FROM "jobs" WHERE active = TRUE LIMIT 25`;
  const ts = t(pg, 'postgres', 'tsql');
  assert.equal(ts.sql, 'SELECT TOP 25 [region], DATETRUNC(month, [opened]) AS m, [a] + [b], CAST(amount AS numeric) FROM [jobs] WHERE active = 1');
  assert.ok(ts.notes.some((n) => /CAST/.test(n)));
  const back = t(ts.sql, 'tsql', 'postgres');
  assert.equal(back.sql, `SELECT "region", date_trunc('month', "opened") AS m, "a" + "b", CAST(amount AS numeric) FROM "jobs" WHERE active = 1\nLIMIT 25`);
  assert.ok(back.notes.some((n) => /\+ between text/.test(n)), 'a T-SQL + is flagged, not guessed at');
});

test('row limits move to each dialect\'s own form', () => {
  assert.equal(t('SELECT a FROM t LIMIT 5', 'postgres', 'oracle').sql, 'SELECT a FROM t\nFETCH FIRST 5 ROWS ONLY');
  assert.equal(t('SELECT a FROM t FETCH FIRST 5 ROWS ONLY', 'oracle', 'access').sql, 'SELECT TOP 5 a FROM t');
  assert.equal(t('SELECT DISTINCT TOP 3 a FROM t;', 'tsql', 'spark').sql, 'SELECT DISTINCT a FROM t\nLIMIT 3');
  assert.equal(t('SELECT a FROM t LIMIT 5', 'ansi', 'synapse').sql, 'SELECT TOP 5 a FROM t');
});

test('Oracle and Access functions translate, quoted names follow the target', () => {
  assert.equal(t("SELECT NVL(x, 'none'), SUBSTR(name, 1, 3), TRUNC(d, 'MM') FROM t", 'oracle', 'postgres').sql, "SELECT COALESCE(x, 'none'), SUBSTRING(name, 1, 3), date_trunc('month', d) FROM t");
  assert.equal(t('SELECT Nz([x], 0), Mid([n], 2), UCase([n]) & [m], Now() FROM [t]', 'access', 'spark').sql, 'SELECT COALESCE(`x`, 0), SUBSTRING(`n`, 2), UPPER(`n`) || `m`, CURRENT_TIMESTAMP FROM `t`');
  assert.equal(t('SELECT COALESCE("x", 0), LENGTH("n") FROM "t"', 'postgres', 'access').sql, 'SELECT Nz([x], 0), Len([n]) FROM [t]');
});

test('Access\'s one-argument ISNULL is a test, not a fallback, and is left alone', () => {
  assert.equal(t('SELECT ISNULL([x]) FROM [t]', 'access', 'postgres').sql, 'SELECT ISNULL("x") FROM "t"');
});

test('text inside strings is never changed', () => {
  assert.equal(t("SELECT 'TOP 5 [a] || GETDATE()' FROM t", 'tsql', 'postgres').sql, "SELECT 'TOP 5 [a] || GETDATE()' FROM t");
});

test('what cannot be translated is passed through with a note', () => {
  const r = t('SELECT DATEADD(day, 1, d), ROWNUM FROM t WHERE n ILIKE \'a%\'', 'tsql', 'oracle');
  assert.match(r.sql, /DATEADD\(day, 1, d\)/);
  assert.equal(r.notes.length, 3);
});

test('generated SQL is shown in the person\'s language while what runs stays the source\'s', async () => {
  const { indexCatalog } = await import('../src/core/catalog.ts');
  const { planFlag } = await import('../src/core/planner.ts');
  const { renderSql } = await import('../src/core/sql.ts');
  const { shownSql } = await import('../web/src/lib/sql-language.ts');
  const { loadCatalog, loadHoist } = await import('./fixtures.ts');
  const catalog = loadCatalog();
  catalog.sources.forEach((s) => (s.dialect = 'postgres'));
  const index = indexCatalog(catalog);
  const hoist = loadHoist();
  const today = new Date('2026-10-29');
  const planned = hoist.flags.map((f) => planFlag(hoist, f, index)).find((p) => p.ok && p.plan.dimensions.length > 0);
  assert.ok(planned && planned.ok);
  const runs = renderSql(planned.plan, index, today);
  assert.equal(runs.dialect, 'postgres');
  const asTsql = shownSql(runs, planned.plan, index, today, 'tsql');
  assert.equal(asTsql.translated, true);
  assert.equal(asTsql.shown.dialect, 'tsql');
  assert.match(asTsql.shown.sql, /\[/);
  assert.doesNotMatch(runs.sql, /\[/, 'what runs is untouched');
  assert.equal(shownSql(runs, planned.plan, index, today, 'source').translated, false);
  assert.equal(shownSql(runs, planned.plan, index, today, 'postgres').translated, false);
});

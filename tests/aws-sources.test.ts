// Amazon RDS / Aurora sources pick their SQL dialect from the engine (dialectForSource), and the S3 browser's
// small helpers (web/src/lib/aws.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, type Dialect, dialectForKind, dialectForSource, isSqlDialect, RDS_ENGINES, SQL_DIALECTS } from '../src/core/catalog.ts';
import { crumbs, formatBytes } from '../web/src/lib/aws.ts';
import { loadCatalog } from './fixtures.ts';

test('dialectForSource maps each RDS engine to postgres, mysql, tsql or oracle', () => {
  const want: Record<string, Dialect> = {
    postgres: 'postgres',
    'aurora-postgresql': 'postgres',
    mysql: 'mysql',
    mariadb: 'mysql',
    'aurora-mysql': 'mysql',
    sqlserver: 'tsql',
    oracle: 'oracle',
  };
  assert.deepEqual([...RDS_ENGINES].sort(), Object.keys(want).sort(), 'every engine the server accepts has a dialect');
  for (const [engine, d] of Object.entries(want)) assert.equal(dialectForSource({ kind: 'aws-rds', engine, provider: 'odbc' }), d, engine);
  assert.equal(dialectForSource({ kind: 'aws-rds', engine: 'Aurora-PostgreSQL' }), 'postgres', 'engine names are matched without case');
});

test('dialectForSource falls back safely and agrees with dialectForKind for every other kind', () => {
  assert.equal(dialectForSource({ kind: 'aws-rds' }), 'ansi', 'no engine');
  assert.equal(dialectForSource({ kind: 'aws-rds', engine: 'db2-se' }), 'ansi', 'an engine Semaphore does not read');
  assert.equal(dialectForSource({ kind: 'aws-athena', provider: 'athena' }), 'ansi');
  assert.equal(dialectForSource({ kind: 'postgres', provider: 'athena' }), 'ansi', 'an Athena source is always the ansi profile');
  for (const kind of ['postgres', 'oracle', 'access', 'azure-sql', 'azure-synapse', 'foundry', 'aws-redshift', 'csv', 'other'] as const) {
    assert.equal(dialectForSource({ kind, provider: 'odbc' }), dialectForKind(kind), kind);
  }
  // The engine only matters for aws-rds.
  assert.equal(dialectForSource({ kind: 'oracle', engine: 'mysql', provider: 'odbc' }), 'oracle');
});

test('mysql is a known dialect, and a catalog checks an RDS source against its engine', () => {
  assert.ok(isSqlDialect('mysql'));
  assert.ok(SQL_DIALECTS.includes('mysql'));
  const catalog = loadCatalog();
  catalog.sources[0]!.kind = 'aws-rds';
  catalog.sources[0]!.engine = 'aurora-mysql';
  catalog.sources[0]!.dialect = 'postgres';
  assert.ok(checkCatalog(catalog).some((m) => /aws-rds but uses the postgres dialect; use mysql/.test(m)));
  catalog.sources[0]!.dialect = 'mysql';
  assert.deepEqual(checkCatalog(catalog).filter((m) => /dialect/.test(m)), []);
  catalog.sources[0]!.engine = 'sqlserver';
  assert.ok(checkCatalog(catalog).some((m) => /use tsql/.test(m)));
  delete catalog.sources[0]!.engine;
  assert.deepEqual(checkCatalog(catalog).filter((m) => /aws-rds but/.test(m)), [], 'without an engine nothing is expected');
});

test('S3 browser helpers: sizes and the breadcrumb under the allowlisted prefix', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20480 * 1024 * 1024), '20 GB');
  assert.equal(formatBytes(-1), '');
  assert.deepEqual(crumbs('semaphore/', 'semaphore/parts/year=2025/'), [
    { name: 'semaphore', prefix: 'semaphore/' },
    { name: 'parts', prefix: 'semaphore/parts/' },
    { name: 'year=2025', prefix: 'semaphore/parts/year=2025/' },
  ]);
  assert.deepEqual(crumbs('', 'a/'), [
    { name: '(bucket)', prefix: '' },
    { name: 'a', prefix: 'a/' },
  ]);
  assert.deepEqual(crumbs('semaphore/', 'other/'), [{ name: 'semaphore', prefix: 'semaphore/' }], 'never above the allowlisted root');
});

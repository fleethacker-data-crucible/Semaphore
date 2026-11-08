import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dialectForKind } from '../src/core/catalog.ts';
import { formatBytes, isLocalImportFile } from '../web/src/lib/localdb.ts';

test('the local database is a source kind with a SQL dialect', () => {
  assert.equal(dialectForKind('local'), 'sqlite');
});

test('the page offers the file types the server imports, gzipped too', () => {
  for (const n of ['a.csv', 'b.TSV', 'c.txt', 'd.xlsx', 'e.sqlite', 'f.db', 'g.parquet', 'h.pq', 'i.arrow', 'j.feather', 'k.csv.gz']) assert.ok(isLocalImportFile(n), n);
  for (const n of ['a.xls', 'b.docx', 'c.exe', 'csv', 'd.gz']) assert.ok(!isLocalImportFile(n), n);
});

test('sizes read in binary units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(21474836480), '20.0 GB');
  assert.equal(formatBytes(null), '');
});

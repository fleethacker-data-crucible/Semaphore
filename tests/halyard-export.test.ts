import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, indexCatalog } from '../src/core/catalog.ts';
import { readCsv } from '../src/core/csv.ts';
import { fleetExportToCsv, HALYARD_TABLES, halyardTableOf, undefuseCells } from '../src/core/fleet-exports.ts';
import { proposeCatalog } from '../src/core/profile.ts';

// Synthetic files written the way Halyard documents its export: UTF-8, CRLF, RFC 4180 quoting, UTC ISO dates,
// true/false, ';' inside list cells, and a leading apostrophe on a text cell that starts with = + - @ or a tab.
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const files: Record<string, string> = {
  'health.csv': crlf([
    HALYARD_TABLES.health.join(','),
    '2026-10-30T09:15:00Z,example/backlog,5,2,1,4,3,2,1,1,1,13.5,2,8,0',
  ]),
  'items.csv': crlf([
    HALYARD_TABLES.items.join(','),
    'S-1,1,STORY,101,"Add login, with MFA",open,201,F-1,Access,Auth,5,,Sprint 12,"auth;mfa",false,,,2026-10-29T08:00:00Z,https://example.test/1',
    "S-2,2,STORY,102,'=Looks like a formula,open,201,F-1,Access,Auth,3,,Sprint 12,,true,story_missing_acceptance_criteria,,2026-10-28T08:00:00Z,https://example.test/2",
    "S-3,3,STORY,103,\"'-dash first\",done,202,F-2,Reports,Export,8,,Sprint 11,,false,,,2026-10-20T08:00:00Z,https://example.test/3",
    'S-4,4,STORY,104,"Line one\nline two",open,202,F-2,Reports,Export,2,,Sprint 12,,true,story_missing_points;story_missing_theme,,2026-10-27T08:00:00Z,https://example.test/4',
  ]),
  'features.csv': crlf([
    HALYARD_TABLES.features.join(','),
    "201,Sign-in,E-1,Access,pat,2026-12-01T00:00:00Z,2,1,8,5,62.5,false,ontrack,'+points on pace",
    '202,Exports,E-1,Reports,sam,2026-11-15T00:00:00Z,2,1,10,8,80,true,atrisk,blocked by S-4',
  ]),
  'velocity.csv': crlf([
    HALYARD_TABLES.velocity.join(','),
    'Sprint 11,11,20,18,6,false',
    'Sprint 12,12,22,9,3,true',
  ]),
};

test('each of the four tables is recognised by its pinned header, extra columns on the right allowed', () => {
  for (const [name, text] of Object.entries(files)) {
    const fx = fleetExportToCsv(name, text);
    assert.ok(fx, name);
    assert.equal(fx.origin, 'Halyard');
    assert.equal(fx.fileName, `halyard_${name}`);
  }
  assert.equal(halyardTableOf(HALYARD_TABLES.velocity.join(',') + ',a_newer_column'), 'velocity');
  assert.equal(halyardTableOf('sprint,number,points_planned'), null);
  assert.equal(halyardTableOf('a,b,c'), null);
  assert.equal(fleetExportToCsv('other.csv', 'a,b\r\n1,2\r\n'), null);
});

test('the protective apostrophe comes off text cells and nothing else changes', () => {
  const items = readCsv('x.csv', fleetExportToCsv('items.csv', files['items.csv']!)!.csv);
  assert.equal(items.rows[1]!['title'], '=Looks like a formula');
  assert.equal(items.rows[2]!['title'], '-dash first');
  assert.equal(items.rows[0]!['title'], 'Add login, with MFA');
  assert.equal(items.rows[3]!['title'], 'Line one\nline two');
  const features = readCsv('x.csv', fleetExportToCsv('features.csv', files['features.csv']!)!.csv);
  assert.equal(features.rows[0]!['reason'], '+points on pace');
});

test('undefuseCells leaves an ordinary leading apostrophe, quotes and empty cells alone', () => {
  assert.equal(undefuseCells("a,'hello,'=x,\"'@y\",,'\r\n"), "a,'hello,=x,\"@y\",,'\r\n");
  assert.equal(undefuseCells("'+1\n'a"), "+1\n'a");
  assert.equal(undefuseCells('"a ""quoted"" cell",\'-b'), '"a ""quoted"" cell",-b');
});

test('the tables read with the right types: numbers, dates, booleans, text', () => {
  const t = (name: string) => readCsv('x.csv', fleetExportToCsv(name, files[name]!)!.csv);
  const types = (name: string) => Object.fromEntries(t(name).columns.map((c) => [c.name, c.type]));
  assert.equal(types('items.csv')['points'], 'number');
  assert.equal(types('items.csv')['updated_at'], 'date');
  assert.equal(types('items.csv')['needs_review'], 'boolean');
  assert.equal(types('items.csv')['title'], 'string');
  assert.equal(types('velocity.csv')['points_done'], 'number');
  assert.equal(types('velocity.csv')['is_current'], 'boolean');
  assert.equal(types('features.csv')['percent'], 'number');
  assert.equal(types('health.csv')['generated_at'], 'date');
  assert.equal(t('items.csv').rows.length, 4);
  assert.equal(t('velocity.csv').rows[1]!['points_done'], 9);
});

test('the four tables give a clean proposed catalog with measures and fields to build on', () => {
  const profiles = Object.keys(files).map((n) => { const fx = fleetExportToCsv(n, files[n]!)!; return readCsv(fx.fileName, fx.csv).profile; });
  const proposal = proposeCatalog({ source: { id: 'files', label: 'Files in this browser', kind: 'csv', dialect: 'ansi' }, tables: profiles });
  assert.deepEqual(checkCatalog(proposal.catalog), []);
  const index = indexCatalog(proposal.catalog);
  const labels = new Set(proposal.catalog.metrics.map((m) => m.label.toLowerCase()));
  assert.ok(labels.size > 6, 'measures were proposed');
  assert.ok([...labels].some((l) => l.includes('points')), 'a points measure');
  assert.ok(proposal.catalog.fields.some((f) => f.table === 'halyard_items' && f.column === 'deficiencies'));
  assert.ok(proposal.catalog.fields.some((f) => f.table === 'halyard_velocity' && f.column === 'points_done'));
  assert.ok(index.field(proposal.catalog.fields[0]!.key));
});

test('a table that is not Halyard keeps loading as plain CSV', () => {
  assert.equal(fleetExportToCsv('velocity-copy.csv', 'sprint,points_done\r\nS1,3\r\n'), null);
});

test('a BOM is ignored', () => {
  assert.ok(fleetExportToCsv('v.csv', '﻿' + files['velocity.csv']!));
});

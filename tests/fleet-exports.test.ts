import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CsvError, readCsv } from '../src/core/csv.ts';
import { fleetExportToCsv } from '../src/core/fleet-exports.ts';

const eightBells = JSON.stringify({
  synthetic: true,
  system: 'Fictional Training eLog',
  watch: 'Engineering',
  start: '2026-10-20T08:00:00',
  entries: [
    { timestamp: '2026-10-20T08:00:00', equipment: 'Pump B', category: 'observation', text: 'Intermittent vibration, "loud"', status: 'open' },
    { timestamp: '2026-10-20T08:15:00', equipment: 'Pump B', category: 'notification', text: 'Supervisor notified', status: 'open' },
    { timestamp: '2026-10-20T10:00:00', equipment: 'Pump C', category: 'followup', text: 'Maintenance assessment requested', status: 'pending' },
  ],
});

test('an Eight Bells eLog export becomes a typed table through the normal CSV reader', () => {
  const fx = fleetExportToCsv('elog_export.json', eightBells)!;
  assert.equal(fx.origin, 'Eight Bells');
  const t = readCsv(fx.fileName, fx.csv);
  assert.equal(t.name, 'eight_bells_entries');
  assert.equal(t.rows.length, 3);
  assert.deepEqual(
    t.columns.map((c) => [c.name, c.type]),
    [['timestamp', 'date'], ['equipment', 'string'], ['category', 'string'], ['text', 'string'], ['status', 'string']],
  );
  assert.equal(t.rows[0]!['text'], 'Intermittent vibration, "loud"');
});

test('a PacketRat usage-counts export becomes one row per action, counts as numbers', () => {
  const body = { schema: 'packetrat.usage-counts/1', estimate: true, since: '2026-10-01T00:00:00', exportedAt: '2026-10-30T12:00:00', counts: { triaged: 120, drafts: 14, reports: 3 } };
  const fx = fleetExportToCsv('counts.json', JSON.stringify(body))!;
  assert.equal(fx.origin, 'PacketRat');
  const t = readCsv(fx.fileName, fx.csv);
  assert.equal(t.name, 'packetrat_usage_counts');
  assert.equal(t.rows.length, 3);
  assert.equal(t.columns.find((c) => c.name === 'count')!.type, 'number');
  assert.equal(t.rows.find((r) => r['action'] === 'drafts')!['count'], 14);
  assert.match(fx.note, /estimate/);
});

test('any list of flat records works, nested objects flatten one level and arrays join', () => {
  const body = { records: [{ id: 1, who: { team: 'A', deep: { x: 1 } }, tags: ['a', 'b'] }, { id: 2, who: { team: 'B' }, tags: [] }] };
  const fx = fleetExportToCsv('bundle.json', JSON.stringify(body))!;
  const t = readCsv(fx.fileName, fx.csv);
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'who_team', 'tags']);
  assert.equal(t.rows[0]!['tags'], 'a; b');
  assert.equal(t.rows[1]!['who_team'], 'B');
});

test('hostile or awkward column names are made safe and unique', () => {
  const fx = fleetExportToCsv('x.json', '[{"__proto__":"p","a.b":1,"a b":2,"a-b":3,"1st":4,"":5}]')!;
  const header = fx.csv.split('\n')[0]!.split(',');
  assert.equal(new Set(header.map((h) => h.toLowerCase())).size, header.length);
  for (const h of header) assert.match(h, /^[A-Za-z_][A-Za-z0-9_ ]*$/);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('CSV special characters in cells survive a round trip', () => {
  const fx = fleetExportToCsv('x.json', JSON.stringify([{ note: 'a,b\n"c"', n: 1 }]))!;
  assert.equal(readCsv(fx.fileName, fx.csv).rows[0]!['note'], 'a,b\n"c"');
});

test('anything that is not a .json file is left to the CSV reader', () => {
  assert.equal(fleetExportToCsv('data.csv', 'a,b\n1,2'), null);
  assert.equal(fleetExportToCsv('data.txt', '{"a":1}'), null);
});

test('malformed or unreadable JSON is refused with a readable message', () => {
  const cases: Array<[string, RegExp]> = [
    ['{not json', /not valid JSON/],
    ['{"a":1}', /list of records/],
    ['[]', /list of records/],
    ['[1,2,3]', /list of records/],
    ['{"entries":[{"a":1}],"rows":[{"b":2}]}', /list of records/],
    ['{"schema":"packetrat.usage-counts/1"}', /no counts/],
    ['{"schema":"packetrat.usage-counts/1","counts":{}}', /no counts yet/],
    ['[{}]', /no columns/],
  ];
  for (const [text, why] of cases) {
    assert.throws(() => fleetExportToCsv('x.json', text), (e: unknown) => e instanceof CsvError && why.test(e.message), text);
  }
});

test('a BOM at the start of the file is ignored', () => {
  assert.equal(fleetExportToCsv('x.json', '﻿[{"a":1}]')!.csv, 'a\n1\n');
});

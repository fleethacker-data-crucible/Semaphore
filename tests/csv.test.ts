import assert from 'node:assert/strict';
import test from 'node:test';
import { CSV_LIMITS, checkCsvSize, CsvError, parseCsvRecords, readCsv } from '../src/core/csv.ts';

test('CSV: delimiters inside quotes do not count when sniffing', () => {
  assert.deepEqual(parseCsvRecords('"Cost, USD";Region\n5;East\n'), [['Cost, USD', 'Region'], ['5', 'East']]);
  const t = readCsv('x.csv', '"Cost, USD";Region\n5;East\n7;West');
  assert.deepEqual(t.columns.map((c) => c.name), ['Cost USD', 'Region']);
  assert.equal(t.rows[1]!['Cost USD'], 7);
});

test('CSV: the delimiter with the same count on every line wins', () => {
  // Two commas on the header only (in a title), one semicolon on every line.
  const text = 'name, title, note;value\na;1\nb;2\nc;3\n';
  assert.deepEqual(parseCsvRecords(text)[1], ['a', '1']);
  assert.deepEqual(parseCsvRecords('a\tb\n1\t2\n')[1], ['1', '2']);
  assert.deepEqual(parseCsvRecords('a|b|c\n1|2|3\n')[1], ['1', '2', '3']);
  // A quoted line break does not end a sniffed line.
  assert.deepEqual(parseCsvRecords('a;"b\nc,d,e"\n1;2\n'), [['a', 'b\nc,d,e'], ['1', '2']]);
});

test('CSV: spaces before an opening quote still quote the field', () => {
  assert.deepEqual(parseCsvRecords('a, "x,y", b\n1, "2,3" ,4'), [['a', 'x,y', ' b'], ['1', '2,3 ', '4']]);
  const t = readCsv('x.csv', 'Name, Cost\n"Alpha", "$1,200"\nBeta, 5');
  assert.equal(t.rows[0]!.Cost, 1200);
  assert.equal(t.rows[0]!.Name, 'Alpha');
});

test('CSV: trailing delimiters, blank lines and CRLF', () => {
  assert.deepEqual(parseCsvRecords('a,b,\r\n\r\n1,2,\r\n'), [['a', 'b', ''], ['1', '2', '']]);
  assert.deepEqual(parseCsvRecords('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsvRecords('﻿a,b\n"x ""q"" y",2'), [['a', 'b'], ['x "q" y', '2']]);
});

function column(header: string, values: string[]): string {
  return [header, ...values].join('\n');
}

test('CSV: late text in a number column is counted, shown blank and noted', () => {
  const values = Array.from({ length: 6000 }, (_, i) => String(i));
  values[5999] = 'N/A';
  values[5500] = 'tbd';
  const t = readCsv('parts.csv', column('Parts cost', values));
  assert.equal(t.columns[0]!.type, 'number');
  assert.equal(t.rows[5999]!['Parts cost'], null);
  assert.equal(t.rows[5998]!['Parts cost'], 5998);
  assert.ok(t.notes.includes('Parts cost: 2 values were not numbers and are shown blank. See Data > Clean.'), t.notes.join(' | '));
  const one = readCsv('parts.csv', column('Parts cost', [...values.slice(0, 5500), 'N/A']));
  assert.ok(one.notes.includes('Parts cost: 1 value was not a number and is shown blank. See Data > Clean.'), one.notes.join(' | '));
  const clean = readCsv('parts.csv', column('Parts cost', values.slice(0, 100)));
  assert.deepEqual(clean.notes, []);
});

test('CSV: late bad dates and booleans are counted too', () => {
  const dates = Array.from({ length: 5001 }, () => '2026-01-15');
  dates.push('soon');
  const d = readCsv('x.csv', column('Opened', dates));
  assert.equal(d.columns[0]!.type, 'date');
  assert.equal(d.rows[5001]!.Opened, null);
  assert.ok(d.notes.some((n) => n.startsWith('Opened: 1 value was not a date')));
  const flags: string[] = Array.from({ length: 5001 }, (_, i) => (i % 2 ? 'yes' : 'no'));
  flags.push('maybe');
  const b = readCsv('x.csv', column('Active', flags));
  assert.equal(b.rows[5001]!.Active, null);
  assert.equal(b.rows[1]!.Active, true);
  assert.ok(b.notes.some((n) => n.startsWith('Active: 1 value was not yes or no')));
});

test('CSV: leading zeros are checked over the same rows as the number test', () => {
  const values = Array.from({ length: 6000 }, (_, i) => String(1000 + i));
  values[4500] = '00042';
  const t = readCsv('x.csv', column('Code', values));
  assert.equal(t.columns[0]!.type, 'string');
  assert.equal(t.rows[4500]!.Code, '00042');
  // Outside the sample window a leading-zero value in a number column is still a number.
  const late = Array.from({ length: 6000 }, (_, i) => String(1000 + i));
  late[5999] = '00042';
  assert.equal(readCsv('x.csv', column('Code', late)).columns[0]!.type, 'number');
});

test('CSV: whole numbers of 16 or more digits stay text', () => {
  const t = readCsv('x.csv', column('Id', ['12345678901234567890', '12345678901234567891', '1']));
  assert.equal(t.columns[0]!.type, 'string');
  assert.deepEqual(t.rows.map((r) => r.Id), ['12345678901234567890', '12345678901234567891', '1']);
  assert.equal(t.profile.columns[0]!.distinct, 3);
  assert.equal(readCsv('x.csv', column('Id', ['123456789012345', '2'])).columns[0]!.type, 'number', '15 digits is still a number');
  assert.equal(readCsv('x.csv', column('Amount', ['1234567890123456.5', '2'])).columns[0]!.type, 'number', 'decimals are numbers');
  // A late long id in a number column is not rounded into another value.
  const late = Array.from({ length: 5001 }, (_, i) => String(i));
  late.push('12345678901234567890');
  const l = readCsv('x.csv', column('Id', late));
  assert.equal(l.rows[5001]!.Id, null);
  assert.ok(l.notes.some((n) => n.startsWith('Id: 1 value was not a number')));
});

test('CSV: impossible US and ISO dates are not dates', () => {
  const bad = readCsv('x.csv', column('When', ['13/45/2020', '1/2/2020']));
  assert.equal(bad.columns[0]!.type, 'string');
  assert.equal(bad.rows[0]!.When, '13/45/2020');
  assert.equal(readCsv('x.csv', column('When', ['2/30/2020', '1/2/2020'])).columns[0]!.type, 'string');
  assert.equal(readCsv('x.csv', column('When', ['2020-02-30', '2020-01-02'])).columns[0]!.type, 'string');
  const ok = readCsv('x.csv', column('When', ['2/29/2020', '12/31/2020']));
  assert.equal(ok.columns[0]!.type, 'date');
  assert.deepEqual(ok.rows.map((r) => r.When), ['2020-02-29', '2020-12-31']);
});

test('CSV: the size cap is checked from the byte count, before reading', () => {
  assert.doesNotThrow(() => checkCsvSize(CSV_LIMITS.bytes));
  assert.throws(() => checkCsvSize(CSV_LIMITS.bytes + 1), CsvError);
  assert.throws(() => readCsv('x.csv', 'a\n'), CsvError);
});

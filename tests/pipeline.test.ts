// Data-prep pipelines (src/core/pipeline.ts): the validation rules the page shares with server/Pipeline.ps1,
// the next scheduled run, and the tables a pipeline builds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSchedule, nextRun, type Pipeline, pipelineId, pipelineOutputs, validatePipeline } from '../src/core/pipeline.ts';

const ok: Pipeline = {
  version: 1,
  name: 'Nightly',
  steps: [
    { id: 'load', kind: 'import', path: 'C:\\data\\orders.csv', table: 'orders' },
    { id: 'pull', kind: 'pull', source: 'erp', sql: 'SELECT id, qty FROM stock', table: 'erp_stock' },
    { id: 'tidy', kind: 'script', script: 'tidy-orders' },
    { id: 'pub', kind: 'publish' },
  ],
  schedule: { every: 'weekly', time: '06:30', days: ['mon', 'thu'], catchUp: true },
};

test('a well-formed pipeline is valid', () => {
  assert.equal(validatePipeline(ok), null);
  assert.equal(validatePipeline({ ...ok, schedule: { every: 'hourly', minute: 15 } }), null);
  assert.equal(validatePipeline({ ...ok, schedule: undefined }), null);
});

test('validation names the first problem the way the server does', () => {
  const step = (s: object) => ({ ...ok, steps: [s] });
  const cases: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [{ ...ok, version: 2 }, /version/],
    [{ ...ok, name: '' }, /name of 1 to 100/],
    [{ ...ok, steps: [] }, /at least one step/],
    [{ ...ok, steps: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, kind: 'publish' })) }, /at most 50/],
    [step({ id: 'Bad Id', kind: 'publish' }), /an id has/],
    [{ ...ok, steps: [{ id: 'a', kind: 'publish' }, { id: 'a', kind: 'publish' }] }, /used twice/],
    [step({ id: 'a', kind: 'shell' }), /kind is/],
    [step({ id: 'a', kind: 'import', path: 'x', upload: 'y', table: 't' }), /one of path, upload or s3/],
    [step({ id: 'a', kind: 'import', table: 't' }), /one of path, upload or s3/],
    [step({ id: 'a', kind: 'import', upload: '..\\evil.csv', table: 't' }), /local sources folder/],
    [step({ id: 'a', kind: 'import', s3: { bucket: 'b', key: 'k', prefix: 'p' }, table: 't' }), /key or a prefix/],
    [step({ id: 'a', kind: 'import', path: 'x', table: '_semaphore_tables' }), /table has/],
    [step({ id: 'a', kind: 'pull', source: 'erp', sql: 'DELETE FROM t', table: 't' }), /single SELECT/],
    [step({ id: 'a', kind: 'pull', source: 'erp', sql: 'SELECT 1; DROP TABLE t', table: 't' }), /single SELECT/],
    [step({ id: 'a', kind: 'pull', source: 'local', sql: 'SELECT 1', table: 't' }), /live source/],
    [step({ id: 'a', kind: 'script', script: '../x' }), /saved script/],
    [step({ id: 'a', kind: 'publish', tables: ['ok', 'not ok'] }), /table names/],
    [{ ...ok, schedule: { every: 'monthly' } }, /every is/],
    [{ ...ok, schedule: { every: 'daily', time: '6:30' } }, /HH:mm/],
    [{ ...ok, schedule: { every: 'hourly', minute: 60 } }, /0 to 59/],
    [{ ...ok, schedule: { every: 'weekly', time: '06:00', days: [] } }, /names its days/],
    [{ ...ok, schedule: { every: 'weekly', time: '06:00', days: ['funday'] } }, /days are/],
  ];
  for (const [doc, rx] of cases) assert.match(validatePipeline(doc) ?? 'valid', rx, JSON.stringify(doc).slice(0, 80));
});

test('the next run of hourly, daily and weekly schedules', () => {
  const now = new Date(2026, 10, 4, 10, 20); // Wednesday 4 Nov 2026, 10:20 local
  assert.deepEqual(nextRun({ every: 'hourly', minute: 30 }, now), new Date(2026, 10, 4, 10, 30));
  assert.deepEqual(nextRun({ every: 'hourly', minute: 10 }, now), new Date(2026, 10, 4, 11, 10));
  assert.deepEqual(nextRun({ every: 'daily', time: '06:00' }, now), new Date(2026, 10, 5, 6, 0));
  assert.deepEqual(nextRun({ every: 'daily', time: '11:00' }, now), new Date(2026, 10, 4, 11, 0));
  assert.deepEqual(nextRun({ every: 'weekly', time: '06:00', days: ['mon', 'fri'] }, now), new Date(2026, 10, 6, 6, 0));
  assert.deepEqual(nextRun({ every: 'weekly', time: '12:00', days: ['wed'] }, now), new Date(2026, 10, 4, 12, 0));
  assert.deepEqual(nextRun({ every: 'weekly', time: '09:00', days: ['wed'] }, now), new Date(2026, 10, 11, 9, 0));
  assert.equal(nextRun({ every: 'off' }, now), null);
  assert.equal(nextRun(undefined, now), null);
});

test('schedules read as sentences; outputs and ids come from the steps and the name', () => {
  assert.equal(describeSchedule(ok.schedule), 'Mon, Thu at 06:30');
  assert.equal(describeSchedule({ every: 'hourly' }), 'Every hour at :00');
  assert.equal(describeSchedule({ every: 'daily', time: '07:15' }), 'Every day at 07:15');
  assert.equal(describeSchedule(undefined), 'Not scheduled');
  assert.deepEqual(pipelineOutputs(ok), ['orders', 'erp_stock']);
  assert.equal(pipelineId('Nightly ERP rebuild!'), 'nightly-erp-rebuild');
  assert.equal(pipelineId('***'), 'pipeline');
});

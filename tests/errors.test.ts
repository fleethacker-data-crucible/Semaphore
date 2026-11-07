import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, clientLogBody, describeError, FRIENDLY, scrubText } from '../web/src/lib/api.ts';
import { explainError } from '../web/src/lib/explain.ts';

test('describeError: every code in the map has plain words, and no raw fetch error gets through', () => {
  assert.equal(describeError(new TypeError('Failed to fetch')), FRIENDLY.network);
  assert.equal(describeError(new ApiError(0, 'network', 'x')), FRIENDLY.network);
  assert.equal(describeError(new ApiError(401, 'session', 'Missing or wrong session token. Relaunch Semaphore.')), FRIENDLY.session);
  assert.equal(describeError(new ApiError(413, 'too-large', 'A hoist may be at most 2 MB.')), FRIENDLY['too-large']);
  assert.equal(describeError(new ApiError(409, 'version', 'changed')), FRIENDLY.version);
  assert.equal(describeError(new ApiError(423, 'vault-locked', 'Start with --console')), FRIENDLY['vault-locked']);
  assert.equal(describeError(new ApiError(403, 'forbidden', 'Request refused: not a local same-origin request.')), FRIENDLY.forbidden);
  assert.equal(describeError(new ApiError(429, 'HTTP_429', '')), FRIENDLY['rate-limited']);
  // Where the server's words carry the specifics, they are kept.
  assert.match(describeError(new ApiError(409, 'lake-approval', 'This query could scan up to 12.0 GB (about $0.06). Run it?')), /12\.0 GB/);
  assert.match(describeError(new ApiError(424, 'vault-item', "Lazarette could not give 'db-pw'")), /db-pw/);
  assert.equal(describeError(new ApiError(424, 'vault-item', '')), FRIENDLY['vault-item']);
  // The default: the server's message, or a plain fallback.
  assert.equal(describeError(new ApiError(500, 'HTTP_500', 'Disk full')), 'Disk full');
  assert.match(describeError(new ApiError(500, 'HTTP_500', '')), /HTTP 500/);
  assert.equal(describeError(new Error('Plain')), 'Plain');
  assert.match(describeError(undefined), /Something went wrong/);
  for (const [code, text] of Object.entries(FRIENDLY)) assert.ok(text.length > 20 && !/undefined|\{|\}/.test(text), code);
});

test('explainError: one next step for each kind of flag failure', () => {
  const kinds = (e: unknown) => explainError(e).action.kind;
  assert.equal(kinds(new ApiError(0, 'network', '')), 'retry');
  assert.equal(kinds(new Error('"Maint DB" is not set up on this computer (sources.json).')), 'open-data');
  assert.equal(kinds(new Error('Unknown field "orders.region".')), 'redraft');
  assert.equal(kinds(new Error('Field "x" is not in orders or a table joined to it.')), 'redraft');
  assert.equal(kinds(new Error('The result passed the row cap of 5,000 rows.')), 'table');
  assert.equal(kinds(new Error('"abc" is not a number.')), 'clean');
  assert.equal(kinds(new Error("Invalid column name 'Regoin'.")), 'redraft');
  assert.equal(kinds(new ApiError(409, 'lake-approval', 'Run it?')), 'approve');
  const held = new Error('held');
  held.name = 'ApprovalNeeded';
  assert.equal(kinds(held), 'approve');
  assert.equal(kinds(new ApiError(423, 'vault-locked', '')), 'retry');
  assert.equal(kinds(new ApiError(424, 'vault-item', 'no item')), 'open-data');
  assert.equal(kinds(new Error('Something odd')), 'retry');
  const e = explainError(new Error('Unknown field "orders.region".'));
  assert.match(e.text, /catalog no longer has/);
  assert.equal(e.action.label, 'Redraft');
});

test('client log: no data values, at most 4 KB', () => {
  assert.equal(scrubText('Cannot read "Gulf region" at row 12345'), 'Cannot read "…" at row #');
  assert.equal(scrubText("value 'secret' and “curly”"), 'value "…" and "…"');
  const body = clientLogBody({ message: 'TypeError: bad "Acme Corp"', stack: 'at f (http://127.0.0.1:8800/assets/app.js?x=1:1:2)\n'.repeat(400), view: 'builder<script>' });
  assert.equal(body.message, 'TypeError: bad "…"');
  assert.equal(body.view, 'builderscript');
  assert.ok(!body.stack!.includes('127.0.0.1'));
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).length <= 4096);
  assert.equal(clientLogBody({ level: 'warn', message: '' }).level, 'warn');
});

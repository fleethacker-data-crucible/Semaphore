// The Databricks serving-endpoint provider (src/core/intelligence/remote.ts), against a fake fetch.
// There is no real workspace here: these tests pin Semaphore's side of the documented chat route
// (request path, headers, body, answer parsing, error and timeout mapping, URL rules, fallback).
// Validating against a real Databricks workspace is still to do (docs/DATABRICKS.md).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabricksProvider, draftFlag, draftHoist } from '../src/core/intelligence/index.ts';
import type { DraftFlagRequest } from '../src/core/intelligence/contract.ts';
import type { FetchLike } from '../src/core/intelligence/remote.ts';
import { learnFromHoist } from '../src/core/playbook.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const WORKSPACE = 'https://adb-1234567890123456.7.azuredatabricks.net';
const TOKEN = 'dapi0123456789abcdef0123456789abcdef';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, any> | null;
  credentials: string;
  referrerPolicy: string;
}

const goodDraft = {
  kind: 'bar',
  title: 'Labor cost by region',
  binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] },
  behavior: { onClick: 'filter-page', ignore: [], thresholds: [] },
  confidence: 0.95,
  notes: [],
};
const chat = (content: unknown) => ({ choices: [{ index: 0, message: { role: 'assistant', content } }], usage: { total_tokens: 12 } });

/** A fetch that answers from a queue (or a function) and records each call. */
function fakeFetch(...replies: Array<{ status?: number; body?: unknown; text?: string } | ((c: Call) => Promise<never> | { status?: number; body?: unknown; text?: string })>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials, referrerPolicy: init.referrerPolicy };
    calls.push(call);
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    const r = typeof next === 'function' ? await next(call) : next;
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.body ?? {});
    return { ok: status >= 200 && status < 300, status, text: async () => text, headers: { get: () => null } };
  };
  return { fetch, calls };
}

const make = (fetch: FetchLike, over: Partial<ConstructorParameters<typeof DatabricksProvider>[0]> = {}) =>
  new DatabricksProvider({ id: 'databricks', label: 'Databricks', url: WORKSPACE, endpoint: 'semaphore-drafter', token: TOKEN, fetch, ...over });

test('invocations route: path, headers and body', async () => {
  const { fetch, calls } = fakeFetch({ body: chat(JSON.stringify(goodDraft)) });
  const out = await draftFlag(make(fetch), hoist, flag(hoist, 'bar-region'), index);
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, `${WORKSPACE}/serving-endpoints/semaphore-drafter/invocations`);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.equal(c.headers.Accept, 'application/json');
  assert.equal(c.credentials, 'omit');
  assert.equal(c.referrerPolicy, 'no-referrer');
  // The endpoint is in the path, not the body; no response_format unless asked for.
  assert.equal(Object.hasOwn(c.body!, 'model'), false);
  assert.equal(Object.hasOwn(c.body!, 'response_format'), false);
  assert.equal(c.body!.temperature, 0);
  assert.equal(c.body!.messages.length, 2);
  assert.equal(c.body!.messages[0].role, 'system');
  assert.match(c.body!.messages[0].content, /Never invent keys/);
  const request = JSON.parse(c.body!.messages[1].content) as DraftFlagRequest;
  assert.equal(request.task, 'draft-flag');
  assert.ok(request.catalog.metrics.some((m) => m.key === 'labor_cost'));
  // The answer is a draft, validated like every other and capped as a model's.
  assert.equal(out.providerId, 'databricks');
  assert.equal(out.fallbackReason, undefined);
  assert.deepEqual(out.draft.binding?.metrics, ['labor_cost']);
  assert.equal(out.draft.confidence, 0.8);
});

test('chat-completions route names the endpoint as the model; options reach the body', async () => {
  const { fetch, calls } = fakeFetch({ body: chat(JSON.stringify(goodDraft)) });
  await draftFlag(make(fetch, { route: 'chat-completions', maxTokens: 2048, jsonMode: true }), hoist, flag(hoist, 'bar-region'), index);
  const c = calls[0]!;
  assert.equal(c.url, `${WORKSPACE}/serving-endpoints/chat/completions`);
  assert.equal(c.body!.model, 'semaphore-drafter');
  assert.equal(c.body!.max_tokens, 2048);
  assert.deepEqual(c.body!.response_format, { type: 'json_object' });
});

test('the workspace URL is normalised: a pasted route, query or trailing slash is dropped', async () => {
  for (const pasted of [`${WORKSPACE}/`, `${WORKSPACE}/serving-endpoints/other/invocations?x=1`, `${WORKSPACE}/serving-endpoints`, `${WORKSPACE}/api/2.0/serving-endpoints#top`]) {
    const { fetch, calls } = fakeFetch({ body: chat(JSON.stringify(goodDraft)) });
    await make(fetch, { url: pasted }).draftFlag({ task: 'draft-flag', brief: { hoist: '', flag: 'x', pageFilters: [], kind: 'bar' }, catalog: { metrics: [], fields: [] } });
    assert.equal(calls[0]!.url, `${WORKSPACE}/serving-endpoints/semaphore-drafter/invocations`, pasted);
  }
  // A workspace behind a path prefix keeps the prefix.
  const { fetch, calls } = fakeFetch({ body: chat('{}') });
  await make(fetch, { url: 'https://proxy.example.com/databricks/' }).draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } });
  assert.equal(calls[0]!.url, 'https://proxy.example.com/databricks/serving-endpoints/semaphore-drafter/invocations');
});

test('no token, no Authorization header', async () => {
  const { fetch, calls } = fakeFetch({ body: chat('{}') });
  await make(fetch, { token: undefined }).draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } });
  assert.equal(calls[0]!.headers.Authorization, undefined);
});

test('answers: plain text, a code fence, and content parts that start with reasoning', async () => {
  const request = { task: 'draft-hoist' as const, brief: 'x', catalog: { metrics: [], fields: [] } };
  const answer = async (content: unknown) => make(fakeFetch({ body: chat(content) }).fetch).draftHoist(request);
  assert.deepEqual(await answer('{"title":"A"}'), { title: 'A' });
  assert.deepEqual(await answer('```json\n{"title":"B"}\n```'), { title: 'B' });
  const parts = [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking {"title":"no"}' }] }, { type: 'text', text: '{"title":' }, { type: 'text', text: '"C"}' }];
  assert.deepEqual(await answer(parts), { title: 'C' });
});

test('answers that are not usable are errors: no message, empty parts, not JSON, not an object', async () => {
  const request = { task: 'draft-hoist' as const, brief: 'x', catalog: { metrics: [], fields: [] } };
  const fail = (reply: { status?: number; body?: unknown; text?: string }) => make(fakeFetch(reply).fetch).draftHoist(request);
  await assert.rejects(fail({ body: { choices: [] } }), /returned no message/);
  await assert.rejects(fail({ body: chat([{ type: 'reasoning', summary: [] }]) }), /returned no message/);
  await assert.rejects(fail({ body: chat(null) }), /returned no message/);
  await assert.rejects(fail({ body: chat('I am sorry, I cannot do that.') }), /did not answer in JSON/);
  await assert.rejects(fail({ text: '<html>login</html>' }), /did not return JSON/);
});

test('HTTP errors carry Databricks\' message and a hint, and never the token', async () => {
  const request = { task: 'draft-hoist' as const, brief: 'x', catalog: { metrics: [], fields: [] } };
  const cases: Array<[number, RegExp]> = [
    [401, /HTTP 401: Invalid access token.*refused the token/s],
    [403, /HTTP 403.*refused the token/s],
    [404, /HTTP 404.*workspace URL and the endpoint name/s],
    [429, /HTTP 429.*rate limited/s],
    [503, /HTTP 503.*starting up/s],
    [500, /HTTP 500: Invalid access token/],
  ];
  for (const [status, pattern] of cases) {
    // Databricks errors are { error_code, message }; this one even echoes the token back.
    const provider = make(fakeFetch({ status, body: { error_code: 'X', message: `Invalid access token ${TOKEN}.` } }).fetch);
    await assert.rejects(provider.draftHoist(request), (e: Error) => pattern.test(e.message) && !e.message.includes(TOKEN) && e.message.includes('[token]'), String(status));
  }
  // OpenAI-style { error: { message } } bodies and bodies that are not JSON are handled too.
  await assert.rejects(make(fakeFetch({ status: 400, body: { error: { message: 'bad request' } } }).fetch).draftHoist(request), /HTTP 400: bad request/);
  await assert.rejects(make(fakeFetch({ status: 502, text: '<html>bad gateway</html>' }).fetch).draftHoist(request), /HTTP 502\./);
});

test('a model that refuses temperature 0 is asked again with its default, once', async () => {
  const { fetch, calls } = fakeFetch({ status: 400, body: { error_code: 'BAD_REQUEST', message: 'temperature is not supported for this model' } }, { body: chat('{"title":"ok"}') });
  const provider = make(fetch);
  const request = { task: 'draft-hoist' as const, brief: 'x', catalog: { metrics: [], fields: [] } };
  assert.deepEqual(await provider.draftHoist(request), { title: 'ok' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body!.temperature, 0);
  assert.equal(Object.hasOwn(calls[1]!.body!, 'temperature'), false);
  await provider.draftHoist(request);
  assert.equal(Object.hasOwn(calls[2]!.body!, 'temperature'), false, 'remembered');
});

test('timeout: a slow endpoint is cut off and reported', async () => {
  const slow = (c: Call) => new Promise<never>(() => undefined).then(() => c as never);
  let aborted = false;
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('This operation was aborted'));
      });
      void slow;
    });
  const provider = make(fetch, { timeoutMs: 30 });
  await assert.rejects(provider.draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } }), /Databricks did not answer within/);
  assert.ok(aborted);
});

test('network failure is reported without the token', async () => {
  const fetch: FetchLike = async () => {
    throw new Error(`connect ECONNREFUSED while sending ${TOKEN}`);
  };
  await assert.rejects(make(fetch).draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } }), (e: Error) => /could not be reached/.test(e.message) && !e.message.includes(TOKEN));
});

test('an answer larger than Semaphore accepts is refused', async () => {
  const big = 'x'.repeat(2_000_001);
  await assert.rejects(make(fakeFetch({ text: big }).fetch).draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } }), /larger than Semaphore accepts/);
});

test('URL rules: HTTPS only (plain HTTP only on this computer), no embedded credentials, a usable endpoint name', () => {
  const { fetch } = fakeFetch({});
  assert.throws(() => make(fetch, { url: 'http://adb-1.azuredatabricks.net' }), /HTTPS/);
  assert.throws(() => make(fetch, { url: 'ftp://adb-1.azuredatabricks.net' }), /HTTPS/);
  assert.throws(() => make(fetch, { url: 'https://me:dapi123@adb-1.azuredatabricks.net' }), /vault, not in the URL/);
  assert.throws(() => make(fetch, { url: 'https://:dapi123@adb-1.azuredatabricks.net' }), /vault, not in the URL/);
  assert.throws(() => make(fetch, { url: 'not a url' }), /not a valid URL/);
  assert.throws(() => make(fetch, { url: '' }), /not a valid URL/);
  for (const endpoint of ['', ' ', 'a/b', '../etc', 'a b', 'name?x=1', '-lead', 'x'.repeat(200)]) {
    assert.throws(() => make(fetch, { endpoint }), /endpoint name/, JSON.stringify(endpoint));
  }
  assert.equal(make(fetch, { endpoint: 'databricks-meta-llama-3-3-70b-instruct' }).endpoint, 'databricks-meta-llama-3-3-70b-instruct');
  // A simulated endpoint on this computer is fine.
  assert.doesNotThrow(() => make(fetch, { url: 'http://127.0.0.1:9999' }));
  assert.doesNotThrow(() => make(fetch, { url: 'http://localhost:9999' }));
});

test('the endpoint name is encoded into the path, so it cannot change the route', async () => {
  const { fetch, calls } = fakeFetch({ body: chat('{}') });
  await make(fetch, { endpoint: 'a.b_c-1' }).draftHoist({ task: 'draft-hoist', brief: 'x', catalog: { metrics: [], fields: [] } });
  assert.equal(calls[0]!.url, `${WORKSPACE}/serving-endpoints/a.b_c-1/invocations`);
});

test('a failing endpoint falls back to local rules, and says why', async () => {
  for (const status of [401, 503, 404]) {
    const { fetch } = fakeFetch({ status, body: { error_code: 'X', message: 'nope' } });
    const out = await draftFlag(make(fetch), hoist, flag(hoist, 'bar-region'), index);
    assert.equal(out.providerId, 'local-rules');
    assert.match(out.fallbackReason ?? '', new RegExp(`HTTP ${status}: nope`));
    assert.ok(out.draft.binding, 'local rules still drafted');
  }
  // So does an answer that is not a draft, for a whole page.
  const out = await draftHoist(make(fakeFetch({ body: chat('["not","a","hoist"]') }).fetch), 'Labor cost by region', index);
  assert.equal(out.providerId, 'local-rules');
  assert.match(out.fallbackReason ?? '', /not a hoist draft/);
  // And a timeout.
  const hang: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = await draftFlag(make(hang, { timeoutMs: 20 }), hoist, flag(hoist, 'bar-region'), index);
  assert.equal(slow.providerId, 'local-rules');
  assert.match(slow.fallbackReason ?? '', /did not answer/);
});

test('a bad draft from the endpoint is still checked against the catalog', async () => {
  const bad = { ...goodDraft, binding: { metrics: ['labor_cost', 'made_up'], dimensions: [{ field: 'jobs.made_up' }], filters: [] }, confidence: 1 };
  const out = await draftFlag(make(fakeFetch({ body: chat(JSON.stringify(bad)) }).fetch), hoist, flag(hoist, 'bar-region'), index);
  assert.equal(out.providerId, 'databricks');
  assert.deepEqual(out.draft.binding?.metrics, ['labor_cost']);
  assert.ok(out.draft.confidence <= 0.4);
});

test('reviewed examples ride in the user message when asked for, and are absent otherwise', async () => {
  const entries = learnFromHoist([], hoist, index, 'dana', new Date('2026-10-26T12:00:00Z'));
  const { fetch, calls } = fakeFetch({ body: chat(JSON.stringify(goodDraft)) });
  await draftFlag(make(fetch), hoist, flag(hoist, 'bar-region'), index, { examples: { entries } });
  await draftFlag(make(fetch), hoist, flag(hoist, 'bar-region'), index);
  const withEx = JSON.parse(calls[0]!.body!.messages[1].content);
  const without = JSON.parse(calls[1]!.body!.messages[1].content);
  assert.ok(withEx.examples.length >= 1);
  assert.equal(Object.hasOwn(without, 'examples'), false);
  assert.match(calls[0]!.body!.messages[0].content, /"examples"/);
  assert.doesNotMatch(calls[1]!.body!.messages[0].content, /"examples"/);
});

test('ping reads the endpoint\'s state; listModels lists the workspace\'s endpoints', async () => {
  const { fetch, calls } = fakeFetch(
    { body: { name: 'semaphore-drafter', state: { ready: 'READY', config_update: 'NOT_UPDATING' } } },
    { body: { name: 'semaphore-drafter', state: { ready: 'NOT_READY' } } },
    { body: {} },
    { body: { endpoints: [{ name: 'semaphore-drafter', task: 'llm/v1/chat' }, { name: 'other' }, { nope: 1 }] } },
    { body: {} },
  );
  const p = make(fetch);
  assert.match(await p.ping(), /endpoint "semaphore-drafter" is ready/);
  assert.match(await p.ping(), /not ready yet \(NOT_READY\)/);
  assert.match(await p.ping(), /answered/);
  assert.deepEqual(await p.listModels(), ['semaphore-drafter', 'other']);
  assert.deepEqual(await p.listModels(), []);
  assert.equal(calls[0]!.url, `${WORKSPACE}/api/2.0/serving-endpoints/semaphore-drafter`);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.body, null);
  assert.equal(calls[3]!.url, `${WORKSPACE}/api/2.0/serving-endpoints`);
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${TOKEN}`);
});

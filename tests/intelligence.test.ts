import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import {
  applyFlagDraft,
  applyHoistDraft,
  ContractProvider,
  draftFlag,
  draftHoist,
  LocalRulesProvider,
  OpenAICompatibleProvider,
  summarizeCatalog,
} from '../src/core/intelligence/index.ts';
import { draftFlagLocally } from '../src/core/intelligence/local-rules.ts';
import type { FetchLike } from '../src/core/intelligence/remote.ts';
import { isValidLayout } from '../src/core/layout.ts';
import { planFlag } from '../src/core/planner.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const local = (brief: string, kind: Flag['kind'] = 'bar') => draftFlagLocally(brief, kind, index);

test('local rules: metric by field, sorted for a bar', () => {
  const d = local('Labor cost by region');
  assert.equal(d.kind, 'bar');
  assert.deepEqual(d.binding?.metrics, ['labor_cost']);
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.region' }]);
  assert.deepEqual(d.binding?.sort, { by: 'labor_cost', dir: 'desc' });
  assert.equal(d.title, 'Labor cost by region');
  assert.ok(d.confidence >= 0.7);
});

test('local rules: synonyms, plurals and chained fields', () => {
  const d = local('Show spend across regions and ship classes');
  assert.deepEqual(d.binding?.metrics, ['labor_cost']);
  assert.deepEqual(d.binding?.dimensions.map((x) => x.field), ['jobs.region', 'jobs.ship_class']);
});

test('local rules: time grain, relative filter, and a line', () => {
  const d = local('Monthly work orders for the last 6 months', 'kpi');
  assert.equal(d.kind, 'line', 'a KPI that is split over time becomes a chart, with a note');
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.opened', grain: 'month' }]);
  assert.deepEqual(d.binding?.filters, [{ field: 'jobs.opened', op: 'last', values: [6], unit: 'month' }]);
  assert.deepEqual(d.binding?.sort, { by: 'jobs.opened@month', dir: 'asc' });
  assert.match(d.notes.join(' '), /KPI shows one number/);
});

test('local rules: behaviour phrases', () => {
  const d = local('Labor cost by region. Clicking a bar filters the page. Turn red over $1.5M, amber over 900k. Ignore the ship class filter.');
  assert.equal(d.behavior.onClick, 'filter-page');
  assert.deepEqual(d.behavior.ignore, ['jobs.ship_class']);
  assert.deepEqual(d.behavior.thresholds, [
    { metric: 'labor_cost', op: 'gt', value: 1_500_000, tone: 'bad' },
    { metric: 'labor_cost', op: 'gt', value: 900_000, tone: 'warn' },
  ]);
  assert.deepEqual(d.binding?.dimensions.map((x) => x.field), ['jobs.region'], 'ship class is not grouped just because it was named');
});

test('local rules: top N, explicit kind words', () => {
  const d = local('Top 5 hulls by work orders as a table');
  assert.equal(d.kind, 'table');
  assert.equal(d.binding?.limit, 5);
  assert.deepEqual(d.binding?.sort, { by: 'work_orders', dir: 'desc' });
  assert.deepEqual(d.binding?.dimensions, [{ field: 'jobs.hull' }]);
});

test('local rules: honest about what it could not match', () => {
  const d = local('Labor cost by squadron');
  assert.match(d.notes.join(' '), /No field matches "squadron"/);
  assert.ok(d.confidence < 0.6);
  const none = local('Morale trends');
  assert.equal(none.binding, null);
  assert.match(none.notes.join(' '), /No metric in the catalog matches/);
});

test('local rules: metrics in another table are left out, not mixed in', () => {
  const d = local('Labor cost and parts on hand by region');
  assert.deepEqual(d.binding?.metrics, ['labor_cost']);
  assert.match(d.notes.join(' '), /another table/);
});

test('local rules: a filter flag', () => {
  const d = local('Ship class', 'filter');
  assert.equal(d.kind, 'filter');
  assert.deepEqual(d.binding, { metrics: [], dimensions: [{ field: 'jobs.ship_class' }], filters: [] });
  assert.equal(d.behavior.onClick, 'filter-page');
});

test('every locally drafted flag plans cleanly', () => {
  for (const brief of ['Labor cost by region', 'Monthly work orders', 'Average days open by ship class, last 2 quarters', 'Top 10 hulls by labor cost']) {
    const d = local(brief);
    const f: Flag = applyFlagDraft({ ...flag(hoist, 'empty-1'), brief }, d);
    const r = planFlag(hoist, f, index);
    assert.ok(r.ok, `${brief}: ${!r.ok ? r.error : ''}`);
  }
});

test('the example hoist brief drafts a sensible dashboard', async () => {
  const { draft, providerId } = await draftHoist(new LocalRulesProvider(index), hoist.brief, index);
  assert.equal(providerId, 'local-rules');
  const kinds = draft.flags.map((f) => f.kind);
  assert.ok(kinds.includes('kpi'));
  assert.ok(kinds.filter((k) => k === 'filter').length === 2, `region and ship class pickers: ${kinds}`);
  assert.ok(kinds.includes('line'));
  assert.deepEqual(draft.filters, [{ field: 'jobs.opened', op: 'last', values: [12], unit: 'month' }]);
  let n = 0;
  const empty: Hoist = { ...hoist, flags: [], filters: [] };
  const built = applyHoistDraft(empty, draft, () => `f${n++}`);
  assert.ok(isValidLayout(built.flags, 12));
  assert.ok(built.flags.every((f) => f.status === 'drafted'));
});

test('providers receive keys, labels and types only: no tables, columns, sources or rows', () => {
  const s = JSON.stringify(summarizeCatalog(index.catalog));
  for (const leak of ['ops.work_orders', 'opened_on', 'QtyOnHand', 'vault', 'postgres', 'Maintenance warehouse']) {
    assert.ok(!s.includes(leak), leak);
  }
});

// ---- remote providers -----------------------------------------------------------------------

type Call = { url: string; init: Parameters<FetchLike>[1] };
function fakeFetch(handler: (url: string, body: any) => { status?: number; body: unknown } | 'hang'): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const out = handler(url, init.body ? JSON.parse(init.body) : undefined);
    if (out === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve({ ok: (out.status ?? 200) < 400, status: out.status ?? 200, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)) });
  };
  return { fetch, calls };
}

test('contract provider: request shape, bearer token, no credentials or referrer', async () => {
  const { fetch, calls } = fakeFetch(() => ({ body: { ok: true, result: { kind: 'kpi', title: 'Orders', binding: { metrics: ['work_orders'], dimensions: [], filters: [] }, confidence: 0.9 } } }));
  const p = new ContractProvider({ id: 'gw', label: 'Gateway', url: 'https://ai.example.mil/semaphore', model: 'm1', token: 's3cret', fetch });
  const { draft, providerId, fallbackReason } = await draftFlag(p, hoist, flag(hoist, 'kpi-orders'), index);
  assert.equal(providerId, 'gw');
  assert.equal(fallbackReason, undefined);
  assert.deepEqual(draft.binding?.metrics, ['work_orders']);
  const c = calls[0]!;
  assert.equal(c.init.headers.Authorization, 'Bearer s3cret');
  assert.equal(c.init.credentials, 'omit');
  assert.equal(c.init.referrerPolicy, 'no-referrer');
  const body = JSON.parse(c.init.body!);
  assert.equal(body.contract, 1);
  assert.equal(body.model, 'm1');
  assert.equal(body.payload.task, 'draft-flag');
  assert.equal(body.payload.brief.flag, 'Total work orders.');
});

test('invented keys from a provider are removed and lower the confidence', async () => {
  const { fetch } = fakeFetch(() => ({ body: { ok: true, result: { kind: 'bar', binding: { metrics: ['labor_cost', 'morale'], dimensions: [{ field: 'jobs.squadron' }, { field: 'jobs.region' }] }, confidence: 0.95 } } }));
  const p = new ContractProvider({ id: 'gw', label: 'Gateway', url: 'https://ai.example.mil/x', fetch });
  const { draft } = await draftFlag(p, hoist, flag(hoist, 'bar-region'), index);
  assert.deepEqual(draft.binding?.metrics, ['labor_cost']);
  assert.deepEqual(draft.binding?.dimensions, [{ field: 'jobs.region' }]);
  assert.ok(draft.confidence <= 0.4);
  assert.match(draft.notes.join(' '), /morale/);
});

test('a failing provider falls back to local rules and says why', async () => {
  for (const [name, handler] of [
    ['http error', () => ({ status: 502, body: { error: { message: 'upstream down' } } })],
    ['not json', () => ({ body: '<html>' })],
    ['contract error', () => ({ body: { ok: false, error: 'model unavailable' } })],
    ['wrong shape', () => ({ body: { ok: true, result: 'nope' } })],
  ] as const) {
    const { fetch } = fakeFetch(handler as any);
    const p = new ContractProvider({ id: 'gw', label: 'Gateway', url: 'https://ai.example.mil/x', fetch });
    const out = await draftFlag(p, hoist, flag(hoist, 'bar-region'), index);
    assert.equal(out.providerId, 'local-rules', name);
    assert.ok(out.fallbackReason, name);
    assert.deepEqual(out.draft.binding?.dimensions, [{ field: 'jobs.region' }], name);
  }
});

test('timeouts abort the request and fall back', async () => {
  const { fetch } = fakeFetch(() => 'hang');
  const p = new ContractProvider({ id: 'gw', label: 'Gateway', url: 'https://ai.example.mil/x', fetch, timeoutMs: 30 });
  const out = await draftFlag(p, hoist, flag(hoist, 'bar-region'), index);
  assert.match(out.fallbackReason ?? '', /did not answer within/);
});

test('errors never echo the token', async () => {
  const fetch: FetchLike = () => Promise.reject(new Error('connect failed for Bearer tok-123'));
  const p = new ContractProvider({ id: 'gw', label: 'Gateway', url: 'https://ai.example.mil/x', fetch, token: 'tok-123' });
  await assert.rejects(p.ping(), (e: Error) => !e.message.includes('tok-123') && e.message.includes('[token]'));
});

test('OpenAI-compatible provider: chat completions, JSON mode, fenced answers, model list', async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.endsWith('/models')
      ? { body: { data: [{ id: 'gpt-x' }, { id: 'llama' }] } }
      : { body: { choices: [{ message: { content: '```json\n{"kind":"kpi","binding":{"metrics":["work_orders"]},"confidence":0.8}\n```' } }] } },
  );
  const p = new OpenAICompatibleProvider({ id: 'oai', label: 'Gateway', url: 'https://gw.example.mil/v1/', model: 'gpt-x', fetch });
  assert.deepEqual(await p.listModels(), ['gpt-x', 'llama']);
  const { draft } = await draftFlag(p, hoist, flag(hoist, 'kpi-orders'), index);
  assert.deepEqual(draft.binding?.metrics, ['work_orders']);
  const chat = calls.find((c) => c.url.endsWith('/chat/completions'))!;
  assert.equal(chat.url, 'https://gw.example.mil/v1/chat/completions');
  const body = JSON.parse(chat.init.body!);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.temperature, 0);
  assert.match(body.messages[0].content, /Never invent keys/);
});

test('provider URLs: HTTPS, or HTTP on loopback only; no credentials in the URL', () => {
  const mk = (url: string) => new ContractProvider({ id: 'x', label: 'X', url, fetch: (() => {}) as any });
  assert.doesNotThrow(() => mk('https://ai.example.mil/x'));
  assert.doesNotThrow(() => mk('http://127.0.0.1:8790'));
  assert.doesNotThrow(() => mk('http://localhost:11434/v1'));
  assert.throws(() => mk('http://ai.example.mil/x'), /HTTPS/);
  assert.throws(() => mk('https://user:pw@ai.example.mil/x'), /vault/);
  assert.throws(() => mk('not a url'), /valid URL/);
});

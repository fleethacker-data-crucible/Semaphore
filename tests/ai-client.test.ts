// The browser's AI client (web/src/lib/ai.ts): which provider drafts, and what goes on the wire.
// The page talks to its own server with the session token; the Fairlead key never appears here.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { draftFlag } from '../src/core/intelligence/index.ts';
import { type AiStatus, draftingProvider } from '../web/src/lib/ai.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();

const status = (over: Partial<AiStatus> = {}): AiStatus => ({
  configured: true,
  provider: 'fairlead',
  url: 'http://127.0.0.1:8776/v1',
  model: 'local',
  privacyLocal: true,
  keySource: 'file',
  problem: null,
  setup: '',
  ...over,
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];
let reply: () => Response;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  sent = [];
  for (const k of ['location', 'sessionStorage', 'fetch']) saved[k] = (globalThis as Record<string, unknown>)[k];
  const store = new Map([['semaphore.session', 'session-token-123']]);
  Object.assign(globalThis, {
    location: { origin: 'http://127.0.0.1:8800' },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    fetch: async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body ?? '{}') });
      return reply();
    },
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

const chat = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('local rules draft when AI is not configured, switched off, or there is no server', () => {
  assert.equal(draftingProvider(index, null, true).id, 'local-rules');
  assert.equal(draftingProvider(index, status({ configured: false }), true).id, 'local-rules');
  assert.equal(draftingProvider(index, status(), false).id, 'local-rules');
});

test('Fairlead drafts through this server, with the session token and the configured route', async () => {
  reply = () =>
    chat({
      kind: 'bar',
      title: 'Labor cost by region',
      binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] },
      behavior: { onClick: 'filter-page', ignore: [], thresholds: [] },
      confidence: 0.9,
      notes: [],
    });
  const provider = draftingProvider(index, status(), true);
  assert.equal(provider.id, 'fairlead');
  assert.match(provider.label, /on this computer/);
  const out = await draftFlag(provider, hoist, flag(hoist, 'bar-region'), index);
  assert.equal(out.providerId, 'fairlead');
  assert.equal(out.fallbackReason, undefined);
  assert.deepEqual(out.draft.binding?.metrics, ['labor_cost']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'http://127.0.0.1:8800/api/ai/v1/chat/completions');
  assert.equal(sent[0]!.headers['X-Semaphore-Session'], 'session-token-123');
  assert.equal(sent[0]!.headers.Authorization, undefined, 'the page never sends a provider key');
  assert.equal(sent[0]!.body.model, 'local');
});

test('a failing Fairlead falls back to local rules and says why', async () => {
  reply = () => new Response(JSON.stringify({ error: 'Fairlead is not running at http://127.0.0.1:8776/v1.', code: 'ai-down' }), { status: 503 });
  const out = await draftFlag(draftingProvider(index, status(), true), hoist, flag(hoist, 'bar-region'), index);
  assert.equal(out.providerId, 'local-rules');
  assert.match(out.fallbackReason ?? '', /503/);
  assert.match(out.fallbackReason ?? '', /not running/);
  assert.ok(out.draft.binding, 'local rules still produced a draft');
});

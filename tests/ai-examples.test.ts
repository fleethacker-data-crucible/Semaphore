// Reviewed examples sent to a model with a draft request (src/core/intelligence/examples.ts):
// which playbook entries are chosen, what is cut away, the caps, the request a provider sees, that
// the draft is still validated against the catalog, and that nothing is built when the switch is off.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { draftFlag, draftHoist, EXAMPLE_LIMITS, type IntelligenceProvider, OpenAICompatibleProvider, selectExamples } from '../src/core/intelligence/index.ts';
import type { DraftFlagRequest, DraftHoistRequest, WorkedExample } from '../src/core/intelligence/contract.ts';
import { learnFromHoist, type PlaybookEntry, retireEntry } from '../src/core/playbook.ts';
import { type AiStatus, draftingProvider, examplesFor } from '../web/src/lib/ai.ts';
import { flag, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const now = new Date('2026-10-26T12:00:00Z');
const entries: PlaybookEntry[] = learnFromHoist([], hoist, index, 'dana', now);
const byId = (id: string) => entries.find((e) => e.id.endsWith(id))!;

const ALLOWED_KEYS = new Set(['brief', 'kind', 'metrics', 'dimensions', 'filters', 'window', 'sort', 'limit', 'compare', 'share', 'thresholds']);

/** A provider that is not local rules and records what it was sent. */
function fake(answer: unknown = { kind: 'bar', title: 'x', binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, confidence: 0.9, notes: [] }) {
  const seen: Array<DraftFlagRequest | DraftHoistRequest> = [];
  const provider: IntelligenceProvider = {
    id: 'fake',
    label: 'Fake gateway',
    local: false,
    ping: async () => 'ok',
    draftFlag: async (r) => (seen.push(r), answer),
    draftHoist: async (r) => (seen.push(r), { title: 'T', filters: [], flags: [], notes: [] }),
  };
  return { provider, seen };
}

test('selection: the entries most like the brief come first, the same way every time', () => {
  const picked = selectExamples('Labor cost by region', entries, index);
  assert.ok(picked.length >= 1 && picked.length <= EXAMPLE_LIMITS.count);
  assert.equal(picked[0]!.brief, 'Labor cost by region. Clicking a bar filters the page.');
  assert.deepEqual(picked[0]!.metrics, [{ key: 'labor_cost', label: 'Labor cost' }]);
  assert.deepEqual(picked[0]!.dimensions, [{ key: 'jobs.region', label: 'Region' }]);
  assert.deepEqual(picked[0]!.sort, { by: 'labor_cost', dir: 'desc' });
  assert.equal(picked[0]!.kind, 'bar');
  assert.deepEqual(picked[0]!.window, { field: 'jobs.opened', label: picked[0]!.window!.label, count: 12, unit: 'month' });
  // Same inputs, same answer; order of the playbook does not matter.
  assert.deepEqual(selectExamples('Labor cost by region', [...entries].reverse(), index), picked);
  // A trend question finds the trend.
  assert.match(selectExamples('monthly work orders', entries, index)[0]!.brief, /Monthly work orders/);
  // Nothing alike, nothing sent.
  assert.deepEqual(selectExamples('zebra giraffe', entries, index), []);
  assert.deepEqual(selectExamples('', entries, index), []);
});

test('only active, reviewed entries: retired, needs-review, unreviewed and "do not learn" are never used', () => {
  const bar = byId('bar-region');
  const retired = retireEntry(bar, 'sam', 'wrong measure', now);
  assert.deepEqual(selectExamples('Labor cost by region', [retired], index), []);
  const review = { ...bar, status: 'needs-review' as const, review: { reason: 'Marked by sam: stale', at: now.toISOString() } };
  assert.deepEqual(selectExamples('Labor cost by region', [review], index), []);
  // Not a playbook entry at all (a draft someone dropped into the folder).
  const draft = { ...bar, version: 2, status: 'drafted' } as unknown as PlaybookEntry;
  assert.deepEqual(selectExamples('Labor cost by region', [draft], index), []);
  const noLearn = { ...bar, learn: false } as unknown as PlaybookEntry;
  assert.deepEqual(selectExamples('Labor cost by region', [noLearn], index), []);
  // An entry the catalog no longer understands is left out rather than taught.
  const stale = { ...bar, binding: { ...bar.binding, metrics: ['not_in_catalog'] } };
  assert.deepEqual(selectExamples('Labor cost by region', [stale], index), []);
  // The live entry is still found among the dead ones.
  assert.equal(selectExamples('Labor cost by region', [retired, review, draft, noLearn, stale, bar], index).length, 1);
});

test('redaction: no row, result, snapshot, reviewer, table or filter value can leak', () => {
  const bar = byId('bar-region');
  const rowful = {
    ...bar,
    question: 'Labor cost by region, and ask Dana or SAM about the Gulf figure.',
    acceptedBy: 'Dana',
    retired: undefined,
    binding: { ...bar.binding, filters: [{ field: 'jobs.region', op: 'in' as const, values: ['Gulf Coast', 'Atlantic'] }, { field: 'jobs.opened', op: 'last' as const, values: [6], unit: 'month' as const }] },
    hoist: { id: 'danas-private-board', title: "Dana's private board" },
    // Things an entry file might carry that must never be forwarded.
    rows: [{ region: 'Gulf Coast', labor_cost: 123456 }],
    snapshot: { rows: [[1, 2, 3]], asOf: 'yesterday' },
    result: { total: 987654321 },
    reviewer: 'Quinn',
    reviewerNotes: 'Quinn signed off on 12 Oct',
    secret: 'sk-live-0000',
  } as unknown as PlaybookEntry;
  const out = selectExamples('Labor cost by region', [rowful], index, { names: ['Sam'] });
  assert.equal(out.length, 1);
  const ex = out[0]!;
  for (const k of Object.keys(ex)) assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${k}`);
  const json = JSON.stringify(out);
  for (const leak of ['dana', 'sam', 'quinn', 'Gulf Coast', 'Atlantic', '123456', '987654321', 'snapshot', 'rows', 'reviewer', 'sk-live', 'private board', 'danas-', rowful.table, 'asOf']) {
    assert.ok(!json.toLowerCase().includes(leak.toLowerCase()), `leaked: ${leak}`);
  }
  assert.match(ex.brief, /\[name\] or \[name\]/);
  // Filters keep the field and the operator, not the picked values; a "last N" window keeps its length.
  assert.deepEqual(ex.filters[0], { field: 'jobs.region', label: ex.filters[0]!.label, op: 'in' });
  assert.deepEqual(ex.filters[1]!.last, { count: 6, unit: 'month' });
  // Every key and label in an example is the catalog's.
  const keys = [...ex.metrics.map((m) => m.key), ...ex.dimensions.map((d) => d.key), ...ex.filters.map((f) => f.field)];
  assert.ok(keys.every((k) => index.metric(k) || index.field(k)));
});

test('caps: count, characters per brief, and characters in all', () => {
  const clones = (n: number, question: (i: number) => string): PlaybookEntry[] =>
    Array.from({ length: n }, (_, i) => ({ ...byId('bar-region'), id: `copy-${i}`, question: question(i), uses: i }));
  const many = clones(20, (i) => `Labor cost by region number ${i}`);
  assert.equal(selectExamples('Labor cost by region', many, index).length, EXAMPLE_LIMITS.count);
  assert.equal(selectExamples('Labor cost by region', many, index, { max: 50 }).length, EXAMPLE_LIMITS.maxCount, 'a caller cannot ask for more than the hard cap');
  assert.equal(selectExamples('Labor cost by region', many, index, { max: 0 }).length, 0);
  // A long brief is cut.
  const long = clones(1, () => `Labor cost by region ${'and more words '.repeat(80)}`);
  const cut = selectExamples('Labor cost by region', long, index);
  assert.equal(cut[0]!.brief.length, EXAMPLE_LIMITS.briefChars);
  // The total is capped: a budget for one example fits one.
  const one = JSON.stringify(selectExamples('Labor cost by region', many, index, { max: 1 })[0]).length;
  assert.equal(selectExamples('Labor cost by region', many, index, { maxChars: one + 10 }).length, 1);
  assert.equal(selectExamples('Labor cost by region', many, index, { maxChars: 10 }).length, 0);
  assert.ok(JSON.stringify(selectExamples('Labor cost by region', many, index, { max: 5 })).length <= EXAMPLE_LIMITS.totalChars + 10);
  // The same wording twice is one example.
  const twins = clones(3, () => 'Labor cost by region');
  assert.equal(selectExamples('Labor cost by region', twins, index).length, 1);
});

test('a fake provider gets the examples in a draft-flag and a draft-hoist request, and old fields are unchanged', async () => {
  const f = flag(hoist, 'bar-region');
  const { provider, seen } = fake();
  await draftFlag(provider, hoist, f, index, { examples: { entries, names: ['dana'] } });
  const req = seen[0] as DraftFlagRequest;
  assert.equal(req.task, 'draft-flag');
  assert.ok(req.examples && req.examples.length >= 1 && req.examples.length <= EXAMPLE_LIMITS.count);
  assert.equal(req.brief.flag, f.brief);
  assert.ok(req.catalog.metrics.length > 0);
  for (const ex of req.examples!) assert.deepEqual(Object.keys(ex).filter((k) => !ALLOWED_KEYS.has(k)), []);
  assert.ok(!JSON.stringify(req).toLowerCase().includes('dana'));

  await draftHoist(provider, 'Labor cost by region and monthly work orders', index, { examples: { entries } });
  const hreq = seen[1] as DraftHoistRequest;
  assert.equal(hreq.task, 'draft-hoist');
  assert.ok((hreq.examples ?? []).length >= 1);
});

test('the draft is still validated against the catalog: a bad answer that copies an example is rejected', async () => {
  const f = flag(hoist, 'bar-region');
  const bad = {
    kind: 'bar',
    title: 'Copied',
    binding: { metrics: ['labor_cost', 'invented_metric'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.invented' }], filters: [{ field: 'secret.field', op: 'in', values: ['x'] }] },
    behavior: { onClick: 'none', ignore: ['nope'], thresholds: [] },
    confidence: 1,
    notes: [],
  };
  const { provider } = fake(bad);
  const out = await draftFlag(provider, hoist, f, index, { examples: { entries } });
  assert.deepEqual(out.draft.binding?.metrics, ['labor_cost']);
  assert.ok(out.draft.binding?.dimensions.every((d) => d.field !== 'jobs.invented'));
  assert.ok(out.draft.confidence <= 0.4, 'unknown keys cap the confidence');
  assert.ok(out.draft.notes.some((n) => /invented/.test(n)));
  // And a draft that is not an object at all falls back to local rules with the reason.
  const { provider: nonsense } = fake('not json');
  const fell = await draftFlag(nonsense, hoist, f, index, { examples: { entries } });
  assert.equal(fell.providerId, 'local-rules');
  assert.match(fell.fallbackReason ?? '', /not a flag draft/);
});

test('switch off: no examples are built or sent; local rules never get them either', async () => {
  const f = flag(hoist, 'bar-region');
  const { provider, seen } = fake();
  await draftFlag(provider, hoist, f, index);
  await draftHoist(provider, 'Labor cost by region', index);
  assert.equal(Object.hasOwn(seen[0]!, 'examples'), false);
  assert.equal(Object.hasOwn(seen[1]!, 'examples'), false);
  // Nothing similar enough: the key is left out, not sent empty.
  await draftFlag(provider, hoist, { ...f, brief: 'zebra giraffe' }, index, { examples: { entries } });
  assert.equal(Object.hasOwn(seen[2]!, 'examples'), false);
  // Local rules are given nothing even with the switch on.
  const local = { ...fake().provider, local: true, id: 'local-rules' };
  const seenLocal: unknown[] = [];
  local.draftFlag = async (r) => (seenLocal.push(r), { kind: 'bar', title: '', binding: null, behavior: { onClick: 'none', ignore: [], thresholds: [] }, confidence: 0.5, notes: [] });
  await draftFlag(local, hoist, f, index, { examples: { entries } });
  assert.equal(Object.hasOwn(seenLocal[0] as object, 'examples'), false);
});

const status = (over: Partial<AiStatus> = {}): AiStatus => ({ configured: true, provider: 'fairlead', url: 'http://127.0.0.1:8776/v1', model: 'local', privacyLocal: true, keySource: 'file', problem: null, setup: '', ...over });

test('the UI helper: examples are off unless wanted, and only with AI on and a key stored', () => {
  assert.equal(examplesFor(false, status(), true, entries, 'dana'), undefined);
  assert.equal(examplesFor(true, status(), false, entries, 'dana'), undefined, 'AI switched off');
  assert.equal(examplesFor(true, status({ configured: false }), true, entries, 'dana'), undefined, 'no Fairlead key');
  assert.equal(examplesFor(true, null, true, entries, 'dana'), undefined, 'no server');
  const on = examplesFor(true, status(), true, entries, 'dana');
  assert.equal(on?.entries.length, entries.length);
  assert.deepEqual(on?.names, ['dana']);
});

// ---- On the wire: the browser's provider is the server-side relay --------------------------------

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { model?: string; messages: Array<{ role: string; content: string }> };
}
let sent: Sent[] = [];
const saved: Record<string, unknown> = {};

beforeEach(() => {
  sent = [];
  for (const k of ['location', 'sessionStorage', 'fetch']) saved[k] = (globalThis as Record<string, unknown>)[k];
  const store = new Map([['semaphore.session', 'session-token-123']]);
  Object.assign(globalThis, {
    location: { origin: 'http://127.0.0.1:8774' },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    fetch: async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body ?? '{}') });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'bar', title: 'Labor cost by region', binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] }, behavior: { onClick: 'none', ignore: [], thresholds: [] }, confidence: 0.9, notes: [] }) } }] }), { status: 200 });
    },
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

test('examples travel only through the relay, with its session token and no provider key', async () => {
  const provider = draftingProvider(index, status(), true);
  await draftFlag(provider, hoist, flag(hoist, 'bar-region'), index, { examples: examplesFor(true, status(), true, entries, 'dana') });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'http://127.0.0.1:8774/api/ai/v1/chat/completions');
  assert.equal(sent[0]!.headers['X-Semaphore-Session'], 'session-token-123');
  assert.equal(sent[0]!.headers.Authorization, undefined);
  assert.equal(sent[0]!.body.model, 'local');
  const [system, user] = sent[0]!.body.messages;
  assert.match(system!.content, /"examples"/, 'the model is told what examples are');
  const request = JSON.parse(user!.content) as DraftFlagRequest;
  assert.ok((request.examples ?? []).length >= 1);

  // Switch off: the request is what it always was, and the prompt does not mention examples.
  sent = [];
  await draftFlag(provider, hoist, flag(hoist, 'bar-region'), index, { examples: examplesFor(false, status(), true, entries, 'dana') });
  const plain = sent[0]!.body.messages;
  assert.equal(Object.hasOwn(JSON.parse(plain[1]!.content), 'examples'), false);
  assert.doesNotMatch(plain[0]!.content, /"examples"/);
});

test('a direct OpenAI-compatible gateway gets the same examples in its user message', async () => {
  const calls: Array<{ url: string; body: { messages: Array<{ content: string }> } }> = [];
  const gateway = new OpenAICompatibleProvider({
    id: 'gw',
    label: 'Gateway',
    url: 'https://gateway.example.com/v1',
    token: 'tok',
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body ?? '{}') });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"kind":"bar","binding":null}' } }] }) };
    },
  });
  await draftFlag(gateway, hoist, flag(hoist, 'bar-region'), index, { examples: { entries } });
  const examples = (JSON.parse(calls[0]!.body.messages[1]!.content) as DraftFlagRequest).examples as WorkedExample[];
  assert.ok(examples.length >= 1);
  assert.equal(calls[0]!.url, 'https://gateway.example.com/v1/chat/completions');
});

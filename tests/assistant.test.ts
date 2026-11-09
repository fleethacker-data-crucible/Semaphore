import assert from 'node:assert/strict';
import { test } from 'node:test';

// The assistant (web/src/lib/assistant.ts): guide answers without Fairlead, and what is sent with it.
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.localStorage = g.sessionStorage;

const { Assistant, assistantOrbState, GUIDE, guideAnswer, localSuggestions, replyText, systemPrompt } = await import('../web/src/lib/assistant.ts');
const { builderOutline, leadershipOutline, summarizeFlag, MAX_VALUES } = await import('../web/src/lib/assistant-context.ts');
const { applyProposal, checkProposal, readProposals, describeProposal } = await import('../web/src/lib/assistant-actions.ts');
const { noteFlagLive, forgetFlagLive } = await import('../web/src/lib/flag-live.ts');
const { loadHoist, loadIndex } = await import('./fixtures.ts');
const { ApiError } = await import('../web/src/lib/api.ts');

const configured = { configured: true, model: 'semaphore-draft', label: 'Fairlead' } as never;
const index = loadIndex();
const hoist = loadHoist();
const page = { outline: builderOutline(hoist, index), context: { mode: 'builder' as const, flags: hoist.flags, index } };

test('without Fairlead the assistant answers from the guide, on this computer', async () => {
  let sent = 0;
  const a = new Assistant(async () => {
    sent++;
    return {};
  });
  await a.send('How do I export to Excel?', { status: null, on: true }, page);
  assert.equal(sent, 0, 'nothing leaves the page');
  const reply = a.messages.at(-1)!;
  assert.equal(reply.local, true);
  assert.match(reply.content, /^Export and share:/);
  assert.match(reply.content, /Fairlead is not set up/);
  await a.send('zzz qqq', { status: configured, on: false }, page);
  assert.match(a.messages.at(-1)!.content, /do not have an answer/);
  assert.match(a.messages.at(-1)!.content, /AI drafting is off/);
});

test('with Fairlead the question goes to the relay with the configured model, and the page only when allowed', async () => {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const a = new Assistant(async (body) => {
    bodies.push(body as never);
    return { choices: [{ message: { content: ' Drag a kind onto the page. ' } }] };
  });
  a.setIncludePage(false);
  await a.send('How do I add a flag?', { status: configured, on: true }, page);
  assert.equal(bodies[0]!.model, 'semaphore-draft');
  assert.equal(bodies[0]!.messages[0]!.role, 'system');
  assert.doesNotMatch(bodies[0]!.messages[0]!.content, /PAGE OUTLINE/, 'the page stays here unless it is ticked');
  assert.equal(a.messages.at(-1)!.content, 'Drag a kind onto the page.');
  a.setIncludePage(true);
  await a.send('What is on this page?', { status: configured, on: true }, page);
  const sys = bodies[1]!.messages[0]!.content;
  assert.match(sys, /PAGE OUTLINE/);
  assert.match(sys, /Labor cost/);
  assert.deepEqual(bodies[1]!.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user'], 'the conversation so far goes with it');
});

test('a failed or empty reply is shown as an error, and the assistant is ready again', async () => {
  const a = new Assistant(async () => ({ choices: [] }));
  await a.send('hello', { status: configured, on: true }, null);
  assert.equal(a.busy, false);
  assert.match(a.messages.at(-1)!.error!, /no text/);
  assert.equal(replyText({ choices: [{ message: { content: 42 } }] }), null);
});

test('a question that is empty or too long is refused before anything is sent', async () => {
  const a = new Assistant(async () => ({}));
  await a.send('   ', { status: configured, on: true }, null);
  await a.send('x'.repeat(2001), { status: configured, on: true }, null);
  assert.equal(a.messages.length, 0);
  assert.match(a.status, /1–2,000 characters/);
});

test('the guide finds the right topic and the system prompt marks untrusted parts', () => {
  assert.equal(guideAnswer('how do I pair with lazarette')[0]!.topic, 'Lazarette pairing');
  assert.equal(guideAnswer('compare with last year')[0]!.topic, 'Compare periods');
  assert.deepEqual(guideAnswer('?!'), []);
  assert.deepEqual(guideAnswer('how do I do this'), [], 'filler words alone pick nothing');
});

test('the guide answers what Semaphore does, forgives typos and word endings, and covers the newer features', () => {
  for (const q of ['what does semaphor do?', 'What is Semaphore', 'what can you do', 'give me an overview']) assert.equal(guideAnswer(q)[0]!.topic, 'What Semaphore does', q);
  const cases: Array<[string, string]> = [
    ['how do I set up a pipline', 'Pipelines'],
    ['exporting to powerpoint', 'Export and share'],
    ['can I load a parquet file with 20 million rows', 'Local database and big files'],
    ['connect to an s3 bucket', 'Amazon RDS and S3'],
    ['import my power bi model', 'Import a model'],
    ['make a calculated measure for cost per hull', 'Calculated measures'],
    ['split a column into two', 'Cleaning data'],
    ['tell me when labor cost goes red', 'Alerts'],
    ['email the briefing through outlook', 'Briefing email'],
    ['how do I move flags around freely', 'Layout'],
    ['restore an older version of the page', 'Page snapshots'],
    ['show cost on a map by state', 'More charts and maps'],
    ['run a sql script', 'SQL desk and scripts'],
    ['forecast next quarter', 'Predictions'],
    ['talk to it with my microphone', 'Voice'],
    ['is there a command line', 'Command line'],
  ];
  for (const [q, topic] of cases) assert.equal(guideAnswer(q)[0]?.topic, topic, q);
});

test('when nothing fits, the reply lists what the guide covers', async () => {
  const a = new Assistant(async () => ({}));
  await a.send('zzz qqq', { status: null, on: true }, null);
  assert.match(a.messages.at(-1)!.content, /I can tell you about: what semaphore does, draft a flag/);
});

test('the system prompt carries every guide topic', () => {
  const sys = systemPrompt(page.outline);
  assert.match(sys, /untrusted/);
  for (const g2 of GUIDE) assert.ok(sys.includes(g2.topic));
});

test('the orb shows thinking while waiting and listening while open', () => {
  assert.equal(assistantOrbState(true, true), 'thinking');
  assert.equal(assistantOrbState(false, true), 'listening');
  assert.equal(assistantOrbState(false, false), 'idle');
});

test('when Fairlead is set up but does not answer, the guide answers and says why', async () => {
  const a = new Assistant(async () => {
    throw new ApiError(503, 'ai-down', 'Fairlead is not running on 127.0.0.1:8776.');
  });
  await a.send('How do I add a flag?', { status: configured, on: true }, null);
  const reply = a.messages.at(-1)!;
  assert.equal(reply.local, true);
  assert.equal(reply.error, undefined);
  assert.match(reply.content, /^Draft a flag:/);
  assert.match(reply.content, /Fairlead did not answer/);
  const refused = new Assistant(async () => {
    throw new ApiError(400, 'bad-request', 'The request must use the configured model.');
  });
  await refused.send('hello', { status: configured, on: true }, null);
  assert.match(refused.messages.at(-1)!.error!, /configured model/, 'a refusal is shown, not hidden behind the guide');
});

test('orb choices read from storage keep only known values, and a moved press is a drag', async () => {
  const { orbGesture, parseOrbPrefs, HOLD_MS } = await import('../web/src/lib/orb-prefs.ts');
  assert.deepEqual(parseOrbPrefs({ look: 'eclipse', theme: 'reef', talk: 'hold' }), { look: 'eclipse', theme: 'reef', talk: 'hold' });
  assert.deepEqual(parseOrbPrefs({ look: 'disco', theme: 1, talk: 'shout' }), { look: 'ring', theme: 'brass', talk: 'click' });
  assert.deepEqual(parseOrbPrefs(null), { look: 'ring', theme: 'brass', talk: 'click' });
  assert.equal(orbGesture({ x: 0, y: 0 }, { x: 3, y: 3 }, HOLD_MS), 'hold');
  assert.equal(orbGesture({ x: 0, y: 0 }, { x: 3, y: 3 }, 100), 'press');
  assert.equal(orbGesture({ x: 0, y: 0 }, { x: 10, y: 0 }, HOLD_MS), 'drag');
});

test('voice choices keep only known values, and a failed piece shows the server sentence and stops', async () => {
  const { parseVoicePrefs, Voice } = await import('../web/src/lib/voice.ts');
  assert.deepEqual(parseVoicePrefs({ speak: true, voice: 'en_US-libritts-high', speed: 1.234 }), { speak: true, voice: 'en_US-libritts-high', speed: 1.23, input: true, autoSend: true });
  assert.deepEqual(parseVoicePrefs({ speak: 'yes', voice: '../x', speed: 9, input: false, autoSend: false }), { speak: false, voice: '', speed: 2, input: false, autoSend: false });
  const unavailable = { status: async () => ({ state: 'offline' as const, message: 'TalkForge is not running.' }), start: async () => ({ state: 'unavailable' as const, message: 'TalkForge was not found next to the Semaphore folder.' }), wait: async () => {} };
  const v = new Voice(async () => {
    throw new ApiError(503, 'voice-offline', 'TalkForge is not running at http://127.0.0.1:25009.');
  }, unavailable);
  v.say('First sentence. Second sentence.');
  assert.equal(v.speaking, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(v.speaking, false);
  assert.match(v.error, /TalkForge was not found/, 'why it could not be started, not just that it is not running');
  const refused = new Voice(async () => {
    throw new ApiError(502, 'voice-token', 'TalkForge refused the token.');
  }, unavailable);
  refused.say('Hello.');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(refused.error, /refused the token/, 'only voice-offline starts TalkForge');
});

test('getting the voice ready: TalkForge is started, the page waits while it starts, and the piece is tried again', async () => {
  const { Voice } = await import('../web/src/lib/voice.ts');
  const calls: string[] = [];
  let state: 'offline' | 'starting' | 'ready' = 'offline';
  let polls = 0;
  const lifecycle = {
    status: async () => {
      calls.push('status');
      if (state === 'starting' && ++polls >= 2) state = 'ready';
      return { state, message: '' };
    },
    start: async () => {
      calls.push('start');
      state = 'starting';
      return { state, message: 'Getting the voice ready...' };
    },
    wait: async () => {},
  };
  let fetched = 0;
  const seen: boolean[] = [];
  const v = new Voice(async () => {
    fetched++;
    if (state !== 'ready') throw new ApiError(503, 'voice-offline', 'TalkForge is not running.');
    return new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' });
  }, lifecycle);
  v.subscribe(() => seen.push(v.preparing));
  assert.equal(await v.ensureReady(), true);
  assert.deepEqual(calls, ['status', 'start', 'status', 'status']);
  assert.ok(seen.includes(true), '"Getting the voice ready" was shown while it started');
  assert.equal(v.preparing, false);
  // Already ready: one status check, no start.
  calls.length = 0;
  assert.equal(await v.ensureReady(), true);
  assert.deepEqual(calls, ['status']);
  // Many callers at once share one check.
  calls.length = 0;
  await Promise.all([v.ensureReady(), v.ensureReady(), v.ensureReady()]);
  assert.deepEqual(calls, ['status']);
  assert.equal(fetched, 0);
});

// ---- Turnkey assistant: page context on by default, flag summaries, proposals with Accept ----

test('"Include this page" is on by default and the choice is remembered per browser', () => {
  store.delete('semaphore.assistant.includePage');
  assert.equal(new Assistant(async () => ({})).includePage, true);
  const a = new Assistant(async () => ({}));
  a.setIncludePage(false);
  assert.equal(new Assistant(async () => ({})).includePage, false, 'a new assistant reads the choice back');
  a.setIncludePage(true);
  assert.equal(new Assistant(async () => ({})).includePage, true);
});

test('the page outline names each flag with its readback, measures and a summary of what it shows, never raw rows', () => {
  const bar = hoist.flags.find((f) => f.id === 'bar-region')!;
  const rows = Array.from({ length: 14 }, (_, i) => ({ dims: { 'jobs.region': `Region ${i}` }, values: { [bar.binding!.metrics[0]!]: 1000 * (14 - i) } }));
  noteFlagLive('bar-region', { result: { plan: {} as never, sql: null, display: { rows, applied: [], live: [], truncated: false, totals: { [bar.binding!.metrics[0]!]: 105000 } }, origin: 'page', ms: 1, requeried: [], raw: [{ secret_column: 'RAW-ROW-VALUE' }] }, insights: ['Region 0 stands out.'] });
  noteFlagLive('kpi-orders', { error: 'The source did not answer.', insights: [] });
  try {
    const o = builderOutline(hoist, index);
    const f = o.flags.find((x) => x.id === 'bar-region')!;
    assert.equal(f.kind, 'bar');
    assert.ok(f.readback.length > 0);
    assert.ok(f.measures.length > 0);
    assert.match(f.shows, /14 rows/);
    assert.match(f.shows, /Region 0/);
    assert.doesNotMatch(f.shows, /Region 10/, `at most ${MAX_VALUES} values`);
    assert.match(f.shows, /total/);
    assert.match(f.shows, /stands out/);
    assert.match(o.flags.find((x) => x.id === 'kpi-orders')!.shows, /could not compute/);
    assert.match(o.flags.find((x) => x.id === 'empty-1')!.shows, /shows nothing/);
    const sys = systemPrompt(o);
    assert.match(sys, /untrusted/);
    assert.match(sys, /Flag bar-region/);
    assert.match(sys, /semaphore-action/);
    assert.match(sys, /CATALOG: tables/);
    assert.doesNotMatch(sys, /RAW-ROW-VALUE/, 'the raw rows never go');
  } finally {
    forgetFlagLive('bar-region');
    forgetFlagLive('kpi-orders');
  }
  noteFlagLive('bar-region', { result: { plan: {} as never, sql: null, display: { rows: [], applied: [], live: [], truncated: false, totals: {} }, origin: 'page', ms: 1, requeried: [] }, insights: [] });
  assert.match(summarizeFlag(hoist.flags.find((x) => x.id === 'bar-region')!, { result: undefined, insights: [] }, index), /not computed/);
  forgetFlagLive('bar-region');
});

test('proposals are read from semaphore-action blocks and checked strictly', () => {
  const ctx = { mode: 'builder' as const, flags: hoist.flags, index };
  const text = [
    'The region chart is fine, but the empty table shows nothing.',
    '```semaphore-action',
    '{"action":"set-title","flag":"bar-region","title":"Labor cost by region, this year","reason":"clearer"}',
    '```',
    '```semaphore-action',
    '[{"action":"delete","flag":"empty-1"},{"action":"delete","flag":"bar-region"},{"action":"set-kind","flag":"bar-region","kind":"custom"},{"action":"set-title","flag":"nope","title":"x"},{"action":"set-filter","flag":"bar-region","filter":{"field":"jobs.no_such","op":"in","values":["a"]}},{"action":"rm -rf"}]',
    '```',
    '```semaphore-action',
    'not json',
    '```',
  ].join('\n');
  const r = readProposals(text, ctx);
  assert.equal(r.text, 'The region chart is fine, but the empty table shows nothing.');
  assert.deepEqual(r.proposals.map((p) => p.action), ['set-title', 'delete']);
  assert.equal(r.refusals.length, 6);
  assert.match(r.refusals.join(' '), /only deletes flags that show nothing/);
  assert.match(r.refusals.join(' '), /not on this page/);
  assert.match(r.refusals.join(' '), /no field "jobs.no_such"/);
  assert.match(r.refusals.join(' '), /not valid JSON/);
  // Filters: known fields, known operators, the right number of values; "last" needs a date field and a unit.
  assert.equal(checkProposal({ action: 'set-filter', flag: 'bar-region', filter: { field: 'jobs.opened', op: 'last', values: [6], unit: 'month' } }, ctx).ok, true);
  assert.equal(checkProposal({ action: 'set-filter', flag: 'bar-region', filter: { field: 'jobs.region', op: 'last', values: [6], unit: 'month' } }, ctx).ok, false);
  assert.equal(checkProposal({ action: 'set-filter', flag: 'bar-region', filter: { field: 'parts.item', op: 'in', values: ['x'] } }, ctx).ok, false, 'another source');
  assert.equal(checkProposal({ action: 'add', kind: 'model', title: 'x', brief: 'y' }, ctx).ok, false);
  assert.equal(checkProposal({ action: 'ask', question: 'Which region costs most?' }, { mode: 'leadership', flags: [], index }).ok, true);
  assert.equal(checkProposal({ action: 'set-title', flag: 'bar-region', title: 'x' }, { mode: 'leadership', flags: hoist.flags, index }).ok, false, 'the Leadership view only suggests questions');
  const d = describeProposal(r.proposals[0]!, hoist.flags, index);
  assert.equal(d.before, 'Labor cost by region');
  assert.equal(d.after, 'Labor cost by region, this year');
});

test('a proposal is applied only on Accept, through the editing paths, and checked again then', async () => {
  let flags = hoist.flags.map((f) => ({ ...f }));
  const calls: string[] = [];
  const editor = {
    flags: () => flags,
    index: () => index,
    update: (id: string, patch: Record<string, unknown>) => {
      calls.push(`update ${id} ${Object.keys(patch).join(',')}`);
      flags = flags.map((f) => (f.id === id ? { ...f, ...patch } : f));
    },
    remove: (id: string) => {
      calls.push(`remove ${id}`);
      flags = flags.filter((f) => f.id !== id);
    },
    add: (kind: string, title: string) => void calls.push(`add ${kind} ${title}`),
    redraft: (id: string) => void calls.push(`redraft ${id}`),
    ask: (q: string) => void calls.push(`ask ${q}`),
  };
  const a = new Assistant(async () => ({ choices: [{ message: { content: 'Rename it.\n```semaphore-action\n{"action":"set-title","flag":"bar-region","title":"Cost by region"}\n```\n```semaphore-action\n{"action":"set-filter","flag":"bar-region","filter":{"field":"jobs.status","op":"in","values":["Open"]}}\n```' } }] }));
  a.setIncludePage(true);
  await a.send('Review my flags', { status: configured, on: true }, { outline: builderOutline(hoist, index), context: { mode: 'builder', flags, index } });
  const m = a.messages.at(-1)!;
  assert.equal(m.content, 'Rename it.');
  assert.equal(m.proposals!.length, 2);
  assert.equal(calls.length, 0, 'nothing is applied before Accept');
  a.accept(m.id, m.proposals![0]!.id, 'builder', editor as never);
  assert.equal(flags.find((f) => f.id === 'bar-region')!.title, 'Cost by region');
  a.accept(m.id, m.proposals![1]!.id, 'builder', editor as never);
  assert.deepEqual(flags.find((f) => f.id === 'bar-region')!.binding!.filters.map((f) => f.field), [...hoist.flags.find((f) => f.id === 'bar-region')!.binding!.filters.map((f) => f.field).filter((x) => x !== 'jobs.status'), 'jobs.status']);
  const after = a.messages.at(-1)!;
  assert.deepEqual(after.proposals!.map((c) => c.state), ['accepted', 'accepted']);
  // A flag deleted in the meantime: Accept refuses in words and changes nothing.
  assert.equal(applyProposal({ action: 'set-title', flag: 'gone', title: 'x' }, 'builder', editor as never)?.includes('not on this page'), true);
  // Dismiss leaves the page alone.
  const b = new Assistant(async () => ({ choices: [{ message: { content: '```semaphore-action\n{"action":"delete","flag":"empty-1"}\n```' } }] }));
  b.setIncludePage(true);
  await b.send('Tidy up', { status: configured, on: true }, { outline: builderOutline(hoist, index), context: { mode: 'builder', flags, index } });
  const bm = b.messages.at(-1)!;
  b.dismiss(bm.id, bm.proposals![0]!.id);
  assert.equal(b.messages.at(-1)!.proposals![0]!.state, 'dismissed');
  assert.ok(!calls.some((c) => c.startsWith('remove')));
});

test('proposals are ignored when the page did not go with the question', async () => {
  const a = new Assistant(async () => ({ choices: [{ message: { content: 'Sure.\n```semaphore-action\n{"action":"delete","flag":"empty-1"}\n```' } }] }));
  a.setIncludePage(false);
  await a.send('Tidy up', { status: configured, on: true }, page);
  assert.equal(a.messages.at(-1)!.proposals, undefined);
  a.setIncludePage(true);
});

test('Suggest questions works without Fairlead, from the reviewed answers and the catalog', async () => {
  const o = leadershipOutline([], [], [], 0, index);
  const list = localSuggestions(o);
  assert.ok(list.length > 0);
  assert.ok(list.every((q) => q.endsWith('?')));
  let sent = 0;
  const a = new Assistant(async () => {
    sent++;
    return {};
  });
  await a.suggestAsks({ status: null, on: false }, { outline: o, context: { mode: 'leadership', flags: [], index } });
  assert.equal(sent, 0);
  const m = a.messages.at(-1)!;
  assert.ok(m.proposals!.length > 0);
  assert.ok(m.proposals!.every((c) => c.proposal.action === 'ask'));
  const asked: string[] = [];
  a.accept(m.id, m.proposals![0]!.id, 'leadership', { flags: () => [], index: () => index, update: () => undefined, remove: () => undefined, add: () => undefined, redraft: () => undefined, ask: (q: string) => void asked.push(q) });
  assert.equal(asked.length, 1);
  assert.match(systemPrompt(o), /Leadership view/);
});
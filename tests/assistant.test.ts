import assert from 'node:assert/strict';
import { test } from 'node:test';

// The assistant (web/src/lib/assistant.ts): guide answers without Fairlead, and what is sent with it.
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.localStorage = g.sessionStorage;

const { Assistant, assistantOrbState, GUIDE, guideAnswer, replyText, systemPrompt } = await import('../web/src/lib/assistant.ts');
const { ApiError } = await import('../web/src/lib/api.ts');

const configured = { configured: true, model: 'semaphore-draft', label: 'Fairlead' } as never;
const page = { title: 'Fleet maintenance', brief: 'Cost and backlog', flags: [{ title: 'Labor cost', kind: 'kpi', brief: 'total labor cost, red over $5M' }] };

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
  const sys = systemPrompt(page);
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

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

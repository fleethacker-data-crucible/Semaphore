import assert from 'node:assert/strict';
import { test } from 'node:test';

// web/src/lib/api.ts reads window, sessionStorage and fetch; give it small stand-ins.
const store = new Map<string, string>();
const calls: { url: string; init: RequestInit }[] = [];
let href = 'http://127.0.0.1:8800/?launch=CODE123&view=ask';
const g = globalThis as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.window = { get location() { return { href }; }, history: { replaceState: (_s: unknown, _t: string, u: string) => { href = 'http://127.0.0.1:8800' + u; } } };
g.fetch = async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  if (url === '/api/launch') return new Response(JSON.stringify({ token: 'TOKEN-XYZ' }), { status: 200 });
  return new Response('{"ok":true}', { status: 200 });
};

const { api, sessionToken, startSession } = await import('../web/src/lib/api.ts');

test('a launch link is traded once for the token, and the code leaves the address bar', async () => {
  const first = startSession();
  assert.equal(startSession(), first, 'one trade per page');
  assert.equal(href, 'http://127.0.0.1:8800/?view=ask');
  await api('/api/info');
  assert.equal(calls[0]!.url, '/api/launch');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { code: 'CODE123' });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-Semaphore-Session'], undefined);
  assert.equal(sessionToken(), 'TOKEN-XYZ');
  assert.equal((calls[1]!.init.headers as Record<string, string>)['X-Semaphore-Session'], 'TOKEN-XYZ');
  assert.equal(calls.filter((c) => c.url === '/api/launch').length, 1);
});

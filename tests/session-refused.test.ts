import assert from 'node:assert/strict';
import { test } from 'node:test';

// A launch link opened a second time: the server refuses the code and, with no token from before,
// /api/info answers 401. The page must learn that the session was refused, not carry on quietly.
const store = new Map<string, string>();
let href = 'http://127.0.0.1:8800/?launch=USED';
const g = globalThis as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
g.window = { get location() { return { href }; }, history: { replaceState: (_s: unknown, _t: string, u: string) => { href = 'http://127.0.0.1:8800' + u; } } };
g.location = { protocol: 'http:' };
g.fetch = async (url: string) => {
  if (url === '/api/launch') return new Response('{"error":"used","code":"launch"}', { status: 401 });
  if (url === '/api/info') return new Response('{"error":"session","code":"session"}', { status: 401 });
  return new Response('{}', { status: 200 });
};

const { probeServer, sessionRefused, startSession } = await import('../web/src/lib/api.ts');

test('a used launch link is reported as a refused session', async () => {
  assert.equal(sessionRefused(), false);
  await startSession();
  assert.equal(await probeServer(), null);
  assert.equal(sessionRefused(), true);
});

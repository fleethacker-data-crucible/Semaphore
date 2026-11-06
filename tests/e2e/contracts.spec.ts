// The server contracts the UI relies on, checked through the mock from a launched page (so the mock
// keeps following server/Http.ps1 and server/Routes.ps1): the gate, save conflicts (ETag/If-Match),
// the client error log and the cache headers of hashed assets.
import http from 'node:http';
import { expect, test } from './fixtures';

async function pageApi(page: import('@playwright/test').Page, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(
    async ([p, m, b, h]) => {
      const t = sessionStorage.getItem('semaphore.session') ?? '';
      const r = await fetch(p as string, { method: m as string, headers: { 'X-Semaphore-Session': t, 'Content-Type': 'application/json', ...(h as Record<string, string>) }, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b), cache: 'no-store' });
      const text = await r.text();
      return { status: r.status, etag: r.headers.get('ETag'), data: text ? JSON.parse(text) : null };
    },
    [path, method, body, headers] as const,
  );
}

test('a save with a stale If-Match is refused with 409 and the current ETag', async ({ semaphore, page }) => {
  await semaphore.open();
  await expect(page.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
  const doc = { version: 1, id: 'e2e-etag', title: 'First' };
  const first = await pageApi(page, '/api/hoists/e2e-etag', 'PUT', doc);
  expect(first.status).toBe(200);
  expect(first.data.etag).toMatch(/^[0-9a-f]{64}$/);
  const read = await pageApi(page, '/api/hoists/e2e-etag');
  expect(read.etag).toBe(`"${first.data.etag}"`);
  const second = await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { ...doc, title: 'Second' }, { 'If-Match': read.etag! });
  expect(second.status).toBe(200);
  const stale = await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { ...doc, title: 'Third' }, { 'If-Match': read.etag! });
  expect(stale.status).toBe(409);
  expect(stale.data).toMatchObject({ code: 'version', etag: second.data.etag });
  expect((await semaphore.stored<{ title: string }>('hoists', 'e2e-etag'))?.title).toBe('Second');
  expect((await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { title: 'no version' })).status).toBe(400);
  expect((await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { version: 1, pad: 'x'.repeat(2_100_000) })).status).toBe(413);
});

test('the client error log takes small entries, refuses big ones and limits the rate', async ({ semaphore, page }) => {
  await semaphore.open();
  await expect(page.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
  const before = (await semaphore.state()).clientLog.length;
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'error', message: 'e2e: something broke', view: 'builder' })).status).toBe(204);
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'info', message: 'x' })).status).toBe(400);
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'warn', message: 'x'.repeat(5000) })).status).toBe(413);
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) statuses.push((await pageApi(page, '/api/client-log', 'POST', { level: 'warn', message: `e2e ${i}` })).status);
  expect(statuses).toContain(429);
  expect((await semaphore.state()).clientLog.length - before).toBe(statuses.filter((s) => s === 204).length + 1);
  // Without the session token the route is closed.
  const anon = await page.evaluate(async () => (await fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"level":"error","message":"x"}' })).status);
  expect(anon).toBe(401);
});

test('the gate refuses a foreign Host or Origin; hashed assets are immutable, the page is not cached', async ({ request, baseURL }) => {
  const url = new URL(baseURL!);
  const raw = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: Number(url.port), path: '/', headers }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }).on('error', reject);
    });
  expect(await raw({ Host: `127.0.0.1:${url.port}` })).toBe(200);
  expect(await raw({ Host: `evil.example:${url.port}` })).toBe(403);
  expect(await raw({ Host: `127.0.0.1:${url.port}`, Origin: 'http://evil.example' })).toBe(403);

  const page = await request.get('/');
  expect(page.headers()['cache-control']).toBe('no-store');
  expect(page.headers()['content-security-policy']).toContain("script-src 'self'");
  const html = await page.text();
  const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  expect(entry, 'index.html loads the app as a module').toMatch(/^assets\/app-[A-Za-z0-9]{8,}\.js$/);
  const js = await request.get('/' + entry);
  expect(js.headers()['content-type']).toMatch(/^text\/javascript/);
  expect(js.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get('/api/info')).status()).toBe(401);
});

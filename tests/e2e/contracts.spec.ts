// The server contracts the UI relies on, checked through the mock from a launched page (so the mock
// keeps following server/Http.ps1 and server/Routes.ps1): the gate, the exact security header set,
// save conflicts (ETag/If-Match), the client error log and the cache headers of hashed assets.
// These tests run against their own mock (--stay, like the shared one): the rate-limit test spends
// the client-log budget and the gate test sends raw requests, neither of which may touch another test.
import http from 'node:http';
import { expect, startOwnMock, test, type OwnMock } from './fixtures';

// Security.Tests.ps1 asserts the same list against the real server; a change must land in both.
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=()',
};

let mock: OwnMock;
test.beforeEach(async () => {
  mock = await startOwnMock({}, ['--stay']);
});
test.afterEach(() => mock.stop());

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

function storedTitle(id: string): string | undefined {
  try {
    return (JSON.parse(require('node:fs').readFileSync(`${mock.home}/hoists/${id}.json`, 'utf8')) as { title: string }).title;
  } catch {
    return undefined;
  }
}

test('a save with a stale If-Match is refused with 409 and the current ETag', async ({ page }) => {
  await page.goto(mock.link);
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
  expect(storedTitle('e2e-etag')).toBe('Second');
  expect((await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { title: 'no version' })).status).toBe(400);
  expect((await pageApi(page, '/api/hoists/e2e-etag', 'PUT', { version: 1, pad: 'x'.repeat(2_100_000) })).status).toBe(413);
});

test('the client error log takes small entries, refuses big ones and limits the rate', async ({ page }) => {
  await page.goto(mock.link);
  await expect(page.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
  const before = (await mock.state()).clientLog.length;
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'error', message: 'e2e: something broke', view: 'builder' })).status).toBe(204);
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'info', message: 'x' })).status).toBe(400);
  expect((await pageApi(page, '/api/client-log', 'POST', { level: 'warn', message: 'x'.repeat(5000) })).status).toBe(413);
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) statuses.push((await pageApi(page, '/api/client-log', 'POST', { level: 'warn', message: `e2e ${i}` })).status);
  expect(statuses).toContain(429);
  expect((await mock.state()).clientLog.length - before).toBe(statuses.filter((s) => s === 204).length + 1);
  // Without the session token the route is closed.
  const anon = await page.evaluate(async () => (await fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"level":"error","message":"x"}' })).status);
  expect(anon).toBe(401);
});

test('the gate refuses a foreign Host or Origin; every response carries exactly the security header set; hashed assets are immutable, the page is not cached', async ({ request }) => {
  const url = new URL(mock.base);
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

  const page = await request.get(`${mock.base}/`);
  expect(page.headers()['cache-control']).toBe('no-store');
  const html = await page.text();
  const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  expect(entry, 'index.html loads the app as a module').toMatch(/^assets\/app-[A-Za-z0-9]{8,}\.js$/);
  const js = await request.get(`${mock.base}/${entry}`);
  expect(js.headers()['content-type']).toMatch(/^text\/javascript/);
  expect(js.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  const info = await request.get(`${mock.base}/api/info`);
  expect(info.status()).toBe(401);

  // The same header set on the page, a hashed asset, a refused API call and a 404 (Security.Tests.ps1).
  const missing = await request.get(`${mock.base}/api/no-such-route`);
  for (const r of [page, js, info, missing]) {
    const got = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => k in SECURITY_HEADERS));
    expect(got, `security headers on ${r.url()}`).toEqual(SECURITY_HEADERS);
  }
});

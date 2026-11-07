// Lifecycle (TechStack "Lifecycle rules"): the tab owns the server. The shared mock runs with --stay;
// these tests start their own mock with auto-stop on and short timings (8 s heartbeat timeout,
// 1.5 s leaving grace).
import { expect, startOwnMock, test } from './fixtures';

const CONNECTION_GONE = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_FAILED/;

test('a server that dies shows the "isn’t answering" screen with Try again', async ({ browser, problems }) => {
  problems.allow(CONNECTION_GONE);
  const mock = await startOwnMock();
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(mock.link);
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByRole('textbox', { name: 'Hoist title' })).toBeVisible();
    mock.proc.kill('SIGKILL');
    // Two missed heartbeats (5 s apart) in a row mean the server is not answering.
    const screen = page.getByRole('alertdialog');
    await expect(screen).toContainText('Semaphore isn’t answering', { timeout: 25_000 });
    await expect(screen.getByRole('button', { name: /Try again/ })).toBeVisible();
  } finally {
    await ctx.close();
    mock.stop();
  }
});

test('End session stops the server and says so', async ({ browser, problems }) => {
  problems.allow(CONNECTION_GONE);
  const mock = await startOwnMock();
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(mock.link);
    await page.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: /End session/ }).click();
    // End session asks first.
    await page.getByRole('alertdialog', { name: 'End this session?' }).getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Semaphore has stopped' })).toBeVisible();
    await expect.poll(mock.exited, { timeout: 5_000 }).toBe(true);
    expect(mock.output()).toMatch(/Stopped \(end\)/);
  } finally {
    await ctx.close();
    mock.stop();
  }
});

test('a reload keeps the server; closing the last of two tabs stops it', async ({ browser, problems }) => {
  problems.allow(CONNECTION_GONE);
  const mock = await startOwnMock();
  const ctx = await browser.newContext({ baseURL: mock.base });
  try {
    const a = await ctx.newPage();
    await a.goto(mock.link);
    await expect(a.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();

    // A reload sends the leaving beacon, then a fresh heartbeat well inside the 1.5 s grace.
    await a.reload();
    await expect(a.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
    await a.waitForTimeout(2500);
    expect(mock.exited(), 'a reload must not stop the server').toBe(false);

    // A second tab, opened from its own launch link as the launcher hands out one per tab.
    const code = (await (await ctx.request.post('/__mock/launch')).json()) as { link: string };
    const b = await ctx.newPage();
    await b.goto(code.link);
    await expect(b.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
    await expect.poll(async () => ((await (await ctx.request.get('/__mock/state')).json()) as { liveTabs: number }).liveTabs).toBe(2);

    await a.close({ runBeforeUnload: true });
    await b.waitForTimeout(3000);
    expect(mock.exited(), 'one tab is still open').toBe(false);

    // Last tab gone: the leaving beacon and the 1.5 s grace stop it well before the 8 s timeout.
    const t0 = Date.now();
    await b.close({ runBeforeUnload: true });
    await expect.poll(mock.exited, { timeout: 7_000 }).toBe(true);
    expect(Date.now() - t0).toBeLessThan(7_000);
    expect(mock.output()).toMatch(/Stopped \(browser-gone\)/);
  } finally {
    await ctx.close();
    mock.stop();
  }
});

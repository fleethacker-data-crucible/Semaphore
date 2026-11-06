// Launch: the link's single-use code is traded for the session, the welcome page shows, and the
// example hoist draws its flags. A link used twice gets the "already been used" screen.
import { EXAMPLE_TITLE, expect, test } from './fixtures';

test('launch, welcome, open the example: its flags render', async ({ semaphore, page }) => {
  await semaphore.open();
  // The launch code leaves the address bar as soon as the page has it.
  await expect.poll(() => new URL(page.url()).searchParams.has('launch')).toBe(false);
  await expect(page.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a saved hoist' })).toBeVisible(); // only with a server
  await semaphore.continueToBuilder();
  const bar = page.getByRole('article', { name: 'Labor cost by region' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('img').locator('svg').first()).toBeVisible();
  await expect(page.getByRole('article', { name: 'Work orders per month' }).getByRole('img').locator('svg').first()).toBeVisible();
  await expect(page.getByRole('article', { name: 'Work orders', exact: true })).toContainText(/\d/);
  // The tab registered with the server's presence list.
  await expect.poll(async () => (await semaphore.state()).liveTabs).toBeGreaterThan(0);
});

test('a launch link used a second time shows the "already been used" screen', async ({ semaphore, page, browser }) => {
  const link = await semaphore.open();
  await expect(page.getByRole('heading', { name: 'Run up the signal.' })).toBeVisible();

  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(link);
    const used = second.getByRole('alertdialog').filter({ hasText: 'This launch link has already been used' });
    const welcome = second.getByRole('button', { name: `Continue “${EXAMPLE_TITLE}”` });
    // The notice may sit behind the welcome page; continuing must reveal it.
    await expect(used.or(welcome).first()).toBeVisible();
    if (!(await used.isVisible())) await welcome.click();
    await expect(used).toBeVisible();
    await expect(second.getByRole('button', { name: 'End session' })).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the Ask view loads and answers a question', async ({ semaphore, page }) => {
  await semaphore.open();
  await page.getByRole('button', { name: 'Leadership view' }).click();
  const box = page.getByRole('textbox', { name: 'Ask a question' });
  await expect(box).toBeVisible();
  await box.fill('which region cost the most this year?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByRole('article', { name: /^Answer: / }).first()).toBeVisible();
});

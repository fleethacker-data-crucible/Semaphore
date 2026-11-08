// Saves: every edit reaches the server's folder (1.2 s after the last change), and a pending save is
// sent at once, never dropped, when another hoist replaces the open one. Nothing here sleeps or times
// itself: every wait is a poll on the mock's state or on the stored file.
import { EXAMPLE_ID, expect, test } from './fixtures';

test('a hoist title edit survives a reload and is saved in the home folder', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const title = page.getByRole('textbox', { name: 'Hoist title' });
  const name = `Readiness review ${Date.now()}`;
  await title.fill(name);
  await expect.poll(async () => (await semaphore.stored<{ title: string }>('hoists', EXAMPLE_ID))?.title, { timeout: 10_000 }).toBe(name);

  await page.reload();
  // The reload keeps the session (sessionStorage) and the hoist.
  await page.getByRole('button', { name: `Continue “${name}”` }).click();
  await expect(title).toHaveValue(name);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await semaphore.stored<{ title: string }>('hoists', EXAMPLE_ID))?.title).toBe(name);
});

test('an edit followed at once by Open another hoist is saved, not dropped', async ({ semaphore, page }, testInfo) => {
  await semaphore.writeStored('hoists', 'e2e-other', { version: 1, id: 'e2e-other', title: 'Spare parts watch', brief: '', grid: { cols: 12 }, filters: [], flags: [], updated: new Date().toISOString() });
  await semaphore.open();
  await semaphore.continueToBuilder();
  // Let the opening save land, so the file's next change can only come from the edit below.
  await expect.poll(async () => (await semaphore.stored('hoists', EXAMPLE_ID)) !== null, { timeout: 10_000 }).toBe(true);
  const savesBefore = (await semaphore.state()).saves;
  const title = page.getByRole('textbox', { name: 'Hoist title' });

  const name = `Edited before switching ${Date.now()}`;
  const t0 = Date.now();
  await title.fill(name);
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /Open a saved hoist/ }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /Spare parts watch/ }).click();
  await expect(title).toHaveValue('Spare parts watch');
  // The point of the test is a switch inside the 1.2 s save delay. On a slow machine the delay may
  // have fired on its own; the save must still land either way, so that is noted, not failed.
  if (Date.now() - t0 >= 1200) testInfo.annotations.push({ type: 'note', description: `the switch took ${Date.now() - t0} ms, longer than the 1.2 s save delay; the flush path was not exercised` });

  await expect.poll(async () => (await semaphore.stored<{ title: string }>('hoists', EXAMPLE_ID))?.title, { timeout: 5_000 }).toBe(name);
  await expect.poll(async () => (await semaphore.state()).saves).toBeGreaterThan(savesBefore);
  expect((await semaphore.stored<{ title: string }>('hoists', 'e2e-other'))?.title).toBe('Spare parts watch');
});

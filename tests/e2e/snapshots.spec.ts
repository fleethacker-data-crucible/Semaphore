// Page snapshots in the browser: save one with a name, change the page, restore it, and the page as it
// was is kept first; Undo takes the restore back; a delete goes to .trash; Tidy up takes an automatic one.
import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_ID, EXAMPLE_TITLE, expect, test } from './fixtures';

/** The page snapshots the mock holds for one hoist, newest first. */
function snapshotsOn(home: string, hoistId: string): Array<{ id: string; kind: string; name: string; reason: string }> {
  const dir = path.join(home, 'snapshots', hoistId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^\d{17}-[0-9a-f]{6}\.json$/.test(n))
    .sort()
    .reverse()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

test('save a snapshot, change the page, restore it: the page as it was is kept first, and Undo goes back', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const title = page.getByRole('textbox', { name: 'Hoist title' });

  // Save one from the Hoist menu.
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Snapshots/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Snapshots' });
  await expect(dialog.getByText('No snapshots of this page yet.')).toBeVisible();
  await dialog.getByLabel('Name').fill('Baseline');
  await dialog.getByLabel(/^Note/).fill('Before the review');
  await dialog.getByRole('button', { name: 'Save snapshot' }).click();
  const item = dialog.getByTestId('snapshot-item').filter({ hasText: 'Baseline' });
  await expect(item).toContainText('Before the review');
  await dialog.getByRole('button', { name: 'Close' }).click();
  const home = (await semaphore.state()).home;
  expect(snapshotsOn(home, EXAMPLE_ID).map((s) => s.kind)).toEqual(['named']);

  // Change the page and let it save.
  await title.fill('Changed for the snapshot test');
  await expect.poll(async () => (await semaphore.stored<{ title?: string }>('hoists', EXAMPLE_ID))?.title, { timeout: 10_000 }).toBe('Changed for the snapshot test');

  // Open it again from the command palette, preview, then restore.
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: /command palette/i }).getByRole('combobox').fill('Snapshots');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview Baseline' }).click();
  const preview = dialog.getByTestId('snapshot-preview');
  await expect(preview).toContainText(EXAMPLE_TITLE);
  await expect(preview.getByRole('img', { name: /Layout of the snapshot/ })).toBeVisible();
  await preview.getByRole('button', { name: 'Restore this snapshot' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(title).toHaveValue(EXAMPLE_TITLE);

  // The page as it was before the restore is a snapshot of its own, with the changed title.
  const after = snapshotsOn(home, EXAMPLE_ID);
  expect(after.map((s) => s.kind)).toEqual(['restore', 'named']);
  expect(after[0]!.reason).toContain('Baseline');
  const kept = JSON.parse(fs.readFileSync(path.join(home, 'snapshots', EXAMPLE_ID, `${after[0]!.id}.hoist.json`), 'utf8'));
  expect(kept.title).toBe('Changed for the snapshot test');
  await expect.poll(async () => (await semaphore.stored<{ title?: string }>('hoists', EXAMPLE_ID))?.title, { timeout: 10_000 }).toBe(EXAMPLE_TITLE);

  // Undo takes the restore back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(title).toHaveValue('Changed for the snapshot test');

  // The list shows both, the automatic one marked as such; a delete goes to .trash.
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Snapshots/ }).click();
  await expect(dialog.getByTestId('snapshot-item')).toHaveCount(2);
  await expect(dialog.locator('[data-testid="snapshot-item"][data-kind="restore"]')).toContainText('automatic');
  await dialog.getByRole('button', { name: 'Delete Baseline' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByTestId('snapshot-item')).toHaveCount(1);
  expect(fs.readdirSync(path.join(home, 'snapshots', EXAMPLE_ID, '.trash')).length).toBe(2);
});

test('Tidy up takes an automatic snapshot first, at most one every 10 minutes', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const home = (await semaphore.state()).home;
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await expect.poll(() => snapshotsOn(home, EXAMPLE_ID).map((s) => s.reason)).toEqual(['Tidy up']);
  await page.getByRole('button', { name: 'Tidy up' }).click();
  await page.waitForTimeout(500);
  expect(snapshotsOn(home, EXAMPLE_ID).length).toBe(1);
});

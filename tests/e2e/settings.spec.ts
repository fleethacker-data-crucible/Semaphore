// The Settings screen: reachable before the builder, pairing with Lazarette, and each person's switches.
import { expect, test } from './fixtures';

const GOOD = `lztl1.${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.${'a'.repeat(43)}`;

test('Settings opens from the welcome page, pairs with Lazarette and unpairs', async ({ semaphore, page }) => {
  await semaphore.open();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Lazarette' }).click();
  await expect(dialog.getByTestId('vault-line')).toContainText('not paired');

  const box = dialog.getByLabel('Pairing code from Lazarette');
  await expect(box).toHaveAttribute('type', 'password');
  await box.fill('not-a-code');
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(dialog.getByTestId('vault-line')).toContainText('not a Lazarette pairing code');
  await expect(box).toHaveValue('');
  await expect(dialog).not.toContainText('not-a-code');

  await box.fill(GOOD);
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(dialog.getByTestId('vault-line')).toContainText('Paired. Lazarette is running and unlocked.');
  await expect(box).toHaveValue('');

  await dialog.getByRole('button', { name: 'Unpair' }).click();
  await page.getByRole('alertdialog', { name: 'Unpair from Lazarette?' }).getByRole('button', { name: 'Unpair' }).click();
  await expect(dialog.getByTestId('vault-line')).toContainText('not paired');
});

test('a person can turn a feature off and back on, with nothing lost', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Playbook' }).click();
  await expect(page.getByRole('tab', { name: 'This week' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Features' }).click();
  await dialog.getByRole('checkbox', { name: /^This week/ }).uncheck();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Playbook' }).click();
  await expect(page.getByRole('tab', { name: 'This week' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.reload();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('tab', { name: 'Features' }).click();
  await expect(dialog.getByRole('checkbox', { name: /^This week/ })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: /^This week/ }).check();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Playbook' }).click();
  await expect(page.getByRole('tab', { name: 'This week' })).toBeVisible();
});

test('Settings opens from the Leadership view too', async ({ semaphore, page }) => {
  await semaphore.open();
  await page.getByRole('button', { name: 'Leadership view' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Session' }).click();
  await expect(dialog.getByRole('button', { name: /End session/ })).toBeVisible();
});

test('the Settings tabs move with the arrow keys and remember nothing between opens', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('tab', { name: 'Appearance' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Lazarette' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tabpanel')).toContainText('Pairing');
  await dialog.getByRole('tab', { name: 'Appearance' }).click();
  await dialog.getByRole('checkbox', { name: /^Reduce motion/ }).check();
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'true');
  await dialog.getByRole('checkbox', { name: /^Reduce motion/ }).uncheck();
  await expect(page.locator('html')).not.toHaveAttribute('data-reduce-motion', 'true');
});

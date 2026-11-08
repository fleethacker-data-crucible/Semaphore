// The Semaphore assistant and its orb, as in Lazarette. The mock server has no Fairlead, so answers
// come from the guide on this computer.
import { expect, test } from './fixtures';

test('the orb floats over the page and opens the assistant, which answers from the guide', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const orb = page.getByRole('button', { name: /^Semaphore assistant orb/ });
  await expect(orb).toBeVisible();
  await orb.click();
  const dock = page.getByRole('complementary', { name: 'Semaphore assistant' });
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId('assistant-status')).toContainText('Guide mode');
  await dock.getByRole('button', { name: 'How do I export to Excel?' }).click();
  await expect(dock.getByTestId('assistant-answer').last()).toContainText('Export and share');
  await dock.getByTestId('assistant-input').fill('how do I pair with lazarette');
  await page.keyboard.press('Enter');
  await expect(dock.getByTestId('assistant-answer').last()).toContainText('Lazarette pairing');
  await dock.getByRole('button', { name: 'Close assistant' }).click();
  await expect(dock).toHaveCount(0);
});

test('the header button opens the assistant, and Settings turns the orb off and on', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Semaphore assistant' })).toBeVisible();
  await page.getByRole('button', { name: 'Close assistant' }).click();

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('checkbox', { name: /^Assistant orb/ }).uncheck();
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('checkbox', { name: /^Assistant orb/ }).check();
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toBeVisible();
});

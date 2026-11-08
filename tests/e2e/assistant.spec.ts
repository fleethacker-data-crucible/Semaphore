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
  await dialog.getByRole('checkbox', { name: /^Show the orb/ }).uncheck();
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('checkbox', { name: /^Show the orb/ }).check();
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
  await expect(page.getByRole('button', { name: /^Semaphore assistant orb/ })).toBeVisible();
});

test('hovering the orb shows no menu; its look and how you talk to it are set in Settings', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const orb = page.getByRole('button', { name: /^Semaphore assistant orb/ });
  await expect(orb).toBeVisible();
  await orb.hover();
  await page.waitForTimeout(400);
  await expect(page.getByRole('group', { name: 'Orb look' })).toHaveCount(0);
  await expect(orb).toHaveAttribute('aria-label', /Point ring, Navy brass/);

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const card = dialog.getByRole('region', { name: 'Assistant orb' });
  await card.getByLabel('Orb look').selectOption('eclipse');
  await card.getByLabel('Orb theme').selectOption('glacier');
  await card.getByLabel('Talk to the orb').selectOption('hold');
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
  await expect(orb).toHaveAttribute('aria-label', /Eclipse, Glacier/);

  // With press and hold, a quick click does not open the assistant; holding does.
  await orb.click();
  await expect(page.getByRole('complementary', { name: 'Semaphore assistant' })).toHaveCount(0);
  const box = (await orb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('complementary', { name: 'Semaphore assistant' })).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('assistant-input')).toBeFocused();
});

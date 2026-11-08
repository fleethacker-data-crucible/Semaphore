// Calculated measures and the cleaning steps that make fields, in the browser, on the example data:
// a brief that defines "cost per hull" offers the measure, and once accepted the flag shows it; on the
// Clean tab a sentence splits the hull number and another groups days open, each previewed first,
// and a flag reads the new group.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Flag inspector' });

async function addTable(page: Page, brief: string, title: string) {
  await page.getByRole('navigation', { name: 'Flag palette' }).getByRole('button', { name: /^Table/ }).click();
  const panel = inspector(page);
  await panel.getByRole('textbox', { name: 'Flag brief' }).fill(brief);
  await panel.getByRole('button', { name: /^Draft$/ }).click();
  await expect(panel.getByRole('button', { name: /^Redraft$/ })).toBeVisible();
  await panel.getByRole('textbox', { name: 'Flag title' }).fill(title);
  return page.locator('[data-flag-card]', { hasText: title }).first();
}

test('a brief that defines "cost per hull = labor cost / hulls" offers the measure, and the flag shows it once accepted', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = await addTable(page, 'cost per hull = labor cost / hulls by region', 'Cost per hull by region');
  const offer = page.getByRole('region', { name: 'Calculated measure' });
  await expect(offer.getByTestId('measure-offer')).toHaveText('Cost per hull = Labor cost ÷ Hulls affected');
  await offer.getByRole('button', { name: 'Add Cost per hull' }).click();
  await expect(offer).toHaveCount(0);
  // The flag is drafted again over the new measure: one column of it, by region, in dollars.
  await expect(card.locator('th', { hasText: 'Cost per hull' })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('th', { hasText: /^Labor cost$/ })).toHaveCount(0);
  await expect(card.locator('td', { hasText: /^\$/ }).first()).toBeVisible();
  // The readback says it in words.
  await expect(inspector(page)).toContainText('Cost per hull is Labor cost ÷ Hulls affected');
  // And the catalog keeps it as a calculated measure.
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const data = page.getByRole('dialog', { name: 'Data and catalog' });
  await data.getByRole('tab', { name: /measures/ }).click();
  await expect(data).toContainText('Cost per hull is Labor cost ÷ Hulls affected');
});

test('on the Clean tab a sentence splits the hull number and another groups days open, each previewed first', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const data = page.getByRole('dialog', { name: 'Data and catalog' });
  await data.getByRole('tab', { name: 'clean' }).click();
  const fix = data.getByRole('textbox', { name: 'Describe a fix' });

  await fix.fill('split hull number on the dash into prefix and number');
  await data.getByRole('button', { name: 'Preview' }).click();
  const proposal = data.getByTestId('fix-proposal');
  await expect(proposal).toContainText('Split Hull number on the dash into Prefix and Number');
  await expect(proposal.locator('tbody tr').first()).toContainText(/H-\d+\s*H\s*\d+/);
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await expect(data).toContainText('Split Hull number on the dash into Prefix and Number');

  await fix.fill('group days open into 0-7, 8-30, 31-90, 90+');
  await data.getByRole('button', { name: 'Preview' }).click();
  await expect(proposal).toContainText('Group Days open into 0-7, 8-30, 31-90 and 90+ as Days open group');
  await expect(proposal.locator('tbody')).toContainText('8-30');
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await expect(data.getByRole('button', { name: /^Undo: Group Days open/ })).toBeVisible();
  await data.getByRole('button', { name: 'Close' }).click();

  // A flag groups by the new field.
  const card = await addTable(page, 'work orders by days open group', 'Jobs by age');
  await expect(card.locator('td', { hasText: /^31-90$/ })).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('td', { hasText: /^0-7$/ })).toBeVisible();
});

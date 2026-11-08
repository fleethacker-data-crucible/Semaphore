// A flag kit that carries a calculated measure, in the browser: a flag on "cost per hull" is saved as
// a kit, the catalog is changed under it (its inputs renamed, the measure gone), and flying the kit
// makes the measure again over the renamed inputs and wires the flag to it.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Flag inspector' });

interface StoredMetric {
  key: string;
  label: string;
  agg: string;
  formula?: string;
  synonyms?: string[];
}

async function openKits(page: Page) {
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Flag kits/ }).click();
  return page.getByRole('dialog', { name: 'Flag kits' });
}

test('a kit with a calculated measure flies onto a catalog whose inputs were renamed, and makes the measure there', async ({ semaphore, page }) => {
  test.setTimeout(60_000);
  await semaphore.open();
  await semaphore.continueToBuilder();

  // A flag on a calculated measure, offered from its brief and accepted.
  await page.getByRole('navigation', { name: 'Flag palette' }).getByRole('button', { name: /^Table/ }).click();
  const panel = inspector(page);
  await panel.getByRole('textbox', { name: 'Flag brief' }).fill('cost per hull = labor cost / hulls by region');
  await panel.getByRole('button', { name: /^Draft$/ }).click();
  await expect(panel.getByRole('button', { name: /^Redraft$/ })).toBeVisible();
  await panel.getByRole('textbox', { name: 'Flag title' }).fill('Cost per hull by region');
  const offer = page.getByRole('region', { name: 'Calculated measure' });
  await offer.getByRole('button', { name: 'Add Cost per hull' }).click();
  const card = page.locator('[data-flag-card]', { hasText: 'Cost per hull by region' }).first();
  await expect(card.locator('th', { hasText: 'Cost per hull' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => ((await semaphore.stored<{ metrics: StoredMetric[] }>('catalogs', 'default'))?.metrics ?? []).some((m) => m.agg === 'formula'), { timeout: 10_000 }).toBe(true);

  // Save it, alone, as a kit.
  let kits = await openKits(page);
  await kits.getByRole('tab', { name: 'Save a kit' }).click();
  await kits.getByRole('textbox', { name: 'Kit name' }).fill('Hull costs');
  const rows = kits.locator('fieldset li');
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const box = row.getByRole('checkbox');
    if ((await row.innerText()).includes('Cost per hull by region')) await box.check();
    else await box.uncheck();
  }
  await kits.getByRole('button', { name: 'Save the kit' }).click();
  await expect(kits.getByRole('status').first()).toContainText('Saved the kit "Hull costs" with 1 flag');
  const kit = await semaphore.stored<{ formulas?: Array<{ key: string; formula: string; inputs: Array<{ key: string; agg: string; field?: { key: string } }> }> }>('team', 'kit-hull-costs');
  expect(kit?.formulas?.length).toBe(1);
  const def = kit!.formulas![0]!;
  expect(def.formula).toBe('labor_cost / hulls_affected');
  expect(def.inputs.map((i) => [i.key, i.agg, i.field?.key])).toEqual([
    ['labor_cost', 'sum', 'jobs.cost'],
    ['hulls_affected', 'count_distinct', 'jobs.hull'],
  ]);
  await kits.getByRole('button', { name: 'Close' }).click();

  // Another catalog: the inputs under other keys (one under another name too), and no such measure.
  const catalog = (await semaphore.stored<{ metrics: StoredMetric[] }>('catalogs', 'default'))!;
  const rename: Record<string, string> = { labor_cost: 'spend_total', hulls_affected: 'ships' };
  catalog.metrics = catalog.metrics
    .filter((m) => m.key !== def.key)
    .map((m) => {
      const out = { ...m, key: rename[m.key] ?? m.key };
      if (m.key === 'hulls_affected') Object.assign(out, { label: 'Ships', synonyms: ['hulls affected'] });
      if (m.formula) out.formula = m.formula.replace(/[A-Za-z_][A-Za-z0-9_.]*/g, (w) => rename[w] ?? w);
      return out;
    });
  await semaphore.writeStored('catalogs', 'default', catalog);
  await semaphore.writeStored('hoists', 'yard', { version: 1, id: 'yard', title: 'Yard page', brief: '', grid: { cols: 12 }, filters: [], updated: new Date().toISOString(), flags: [] });

  await semaphore.open();
  await page.getByRole('button', { name: 'Open a saved hoist' }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /^Yard page/ }).click();
  await expect(page.getByRole('textbox', { name: 'Hoist title' })).toHaveValue('Yard page');

  // Fly it: the preview says what it will make and how each input matched, before anything changes.
  kits = await openKits(page);
  await expect(kits.getByRole('button', { name: /^Hull costs/ })).toBeVisible();
  await expect(kits).toContainText('Calculated measures added to this catalog');
  await expect(kits).toContainText('Cost per hull = Labor cost ÷ Ships');
  await expect(kits).toContainText('Remapped: check it');
  await expect(kits).toContainText(/Hulls affected\s*Ships\s*\(synonym, hulls_affected → ships\)/);
  await expect(kits).toContainText(/Labor cost\s*Labor cost\s*\(same label, labor_cost → spend_total\)/);
  await kits.getByRole('button', { name: 'Add 1 flag to this page' }).click();
  await expect(kits).toHaveCount(0);

  // The flag shows the measure made here, in dollars.
  const flown = page.locator('[data-flag-card]', { hasText: 'Cost per hull by region' }).first();
  await expect(flown.locator('th', { hasText: 'Cost per hull' })).toBeVisible({ timeout: 15_000 });
  await expect(flown.locator('td', { hasText: /^\$/ }).first()).toBeVisible();
  // The catalog keeps the measure, over the new keys.
  await expect
    .poll(async () => ((await semaphore.stored<{ metrics: StoredMetric[] }>('catalogs', 'default'))?.metrics ?? []).find((m) => m.agg === 'formula')?.formula, { timeout: 10_000 })
    .toBe('spend_total / ships');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const data = page.getByRole('dialog', { name: 'Data and catalog' });
  await data.getByRole('tab', { name: /measures/ }).click();
  await expect(data).toContainText('Cost per hull is Labor cost ÷ Ships');
});

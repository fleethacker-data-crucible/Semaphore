// Import a model: a dbt project and a Power BI model.bim are read in the page, reviewed, mapped to
// the local database (where their tables were loaded from CSV), profiled and added to the catalog;
// a .pbix is refused with what to do instead.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'models');
const WORK_ORDERS = 'wo_id,hull_no,region,opened_on,labor_cost,parts_cost,status\n1,DDG-51,Gulf,2025-01-03,1200,300,open\n2,DDG-52,Northeast,2025-01-09,800,150,closed\n3,DDG-51,Gulf,2025-02-14,450,90,closed\n';
const HULLS = 'hull_no,ship_class,home_yard\nDDG-51,Arleigh Burke,Norfolk\nDDG-52,Arleigh Burke,San Diego\n';

/** Loads the two fixture tables into the local database and opens Import a model from the Data panel. */
async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Data and catalog' });
  const local = panel.getByTestId('local-db');
  for (const [name, text, table] of [['work_orders.csv', WORK_ORDERS, 'work_orders'], ['hulls.csv', HULLS, 'hulls']] as const) {
    await local.getByLabel('Files for the local database').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
    await expect(local.getByRole('list', { name: 'Local tables' })).toContainText(table);
  }
  await panel.getByRole('button', { name: /Import a model/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a model' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The measure names on the Data panel's Measures tab. */
async function measureNames(page: Page): Promise<string[]> {
  const panel = page.getByRole('dialog', { name: 'Data and catalog' });
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Data', exact: true }).click();
  await panel.getByRole('tab', { name: 'measures' }).click();
  return panel.getByLabel('Measure name').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}

test('a dbt project comes across: tables, measures, calculated measures and a link', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: /dbt project/ }).click();
  const dbt = path.join(FIXTURES, 'dbt-fleet');
  await dialog.getByLabel('dbt project files').setInputFiles([path.join(dbt, 'dbt_project.yml'), path.join(dbt, 'models', 'marts', '_marts.yml'), path.join(dbt, 'models', 'legacy', 'legacy_metrics.yml')]);
  const review = dialog.getByTestId('model-review');
  await expect(review).toContainText('fleet_maintenance');
  await expect(dialog.getByRole('list', { name: 'Measures to add' })).toContainText('calculated: labor / work_orders');
  await expect(dialog.getByRole('list', { name: 'Warnings' })).toContainText('Median labor: Semaphore has no median measure yet');
  // One server source (the local database): every table is mapped to it already.
  await expect(dialog.getByLabel('Semaphore source for work_orders')).toHaveValue('local');
  await expect(dialog.getByLabel('Database table for hulls')).toHaveValue('hulls');
  await dialog.getByRole('button', { name: 'Import 2 tables into the catalog' }).click();
  const result = dialog.getByRole('list', { name: 'Import result' });
  await expect(result).toContainText('4 calculated measures added from the dbt project');
  await expect(result).toContainText('Linked work_orders to hulls on Hull');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await expect.poll(() => measureNames(page)).toEqual(expect.arrayContaining(['Cost per work order', 'Hulls in service', 'Parts share']));
});

test('a Power BI model.bim comes across with its measures, link and drill path; a .pbix is refused', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const dialog = await openImport(page);
  await dialog.getByRole('button', { name: /Power BI model/ }).click();

  await dialog.getByLabel('Power BI model files').setInputFiles({ name: 'Fleet.pbix', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\u0003\u0004 not a real model') });
  await expect(dialog.getByRole('alert')).toContainText('Save as > Power BI Project (.pbip)');
  await expect(dialog.getByTestId('model-review')).toHaveCount(0);

  await dialog.getByLabel('Power BI model files').setInputFiles(path.join(FIXTURES, 'model.bim'));
  const review = dialog.getByTestId('model-review');
  await expect(review).toContainText('Fleet Maintenance');
  await expect(dialog.getByRole('list', { name: 'Measures to add' })).toContainText('calculated: (Labor Cost - Parts Cost) / Labor Cost');
  await expect(dialog.getByRole('list', { name: 'Warnings' })).toContainText('Labor Last Year: time intelligence');
  await expect(review).toContainText('Drill path Yard drill');
  // Power BI read the tables from the ops schema; here they are in the local database without one.
  await expect(dialog.getByLabel('Database table for Work Orders')).toHaveValue('ops.work_orders');
  await dialog.getByLabel('Database table for Work Orders').fill('work_orders');
  await dialog.getByLabel('Database table for Hulls').fill('hulls');
  await dialog.getByRole('button', { name: 'Import 2 tables into the catalog' }).click();
  const result = dialog.getByRole('list', { name: 'Import result' });
  await expect(result).toContainText('calculated measures added from the Power BI model');
  await expect(result).toContainText('Linked work_orders to hulls on Hull');
  await expect(result).toContainText('1 drill path added.');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await expect.poll(() => measureNames(page)).toEqual(expect.arrayContaining(['Labor Margin', 'Cost per Order', 'Largest Job']));
});

test('Import a model offers Qlik too, from the command palette', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: /Import a model/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Import a model' });
  await dialog.getByRole('button', { name: /Qlik app/ }).click();
  await expect(page.getByRole('dialog', { name: 'Import from Qlik' })).toBeVisible();
});

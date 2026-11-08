// The Data panel's "Add to local database": a picked file goes to the server as it is, its table is
// listed, profiled into the catalog like a server source, renamed and dropped; a network path the
// administrator did not allow is refused with the reason.
import { expect, test } from './fixtures';

test('a file goes into the local database, into the catalog, and out again', async ({ semaphore, page, problems }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Data and catalog' });
  const local = panel.getByTestId('local-db');
  await expect(local).toContainText('Add to local database');
  await expect(local).toContainText('No tables yet.');

  await local.getByLabel('Files for the local database').setInputFiles({ name: 'Work Orders.csv', mimeType: 'text/csv', buffer: Buffer.from('id,region,cost\n1,North,10\n2,South,20\n3,North,5\n') });
  await expect(local.getByRole('list', { name: 'Imports' })).toContainText('3 rows in work_orders');
  const tables = local.getByRole('list', { name: 'Local tables' });
  await expect(tables).toContainText('work_orders');
  await expect(tables).toContainText('Work Orders.csv (uploaded)');

  await tables.getByRole('button', { name: 'Profile and add' }).click();
  await expect(panel.getByText('via the server')).toBeVisible();
  await expect(panel).toContainText('Local database');

  await local.getByRole('button', { name: 'Rename work_orders' }).click();
  await local.getByLabel('New name for work_orders').fill('orders');
  await local.getByRole('button', { name: 'Save' }).click();
  await expect(tables).toContainText('orders');
  await expect(tables).not.toContainText('work_orders');

  problems.allowNetwork(403, /^\/api\/local\/import-path$/);
  await local.getByLabel('Path of a file to import').fill('\\\\fileserver01\\share\\big.csv');
  await local.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(local.getByRole('list', { name: 'Imports' })).toContainText('localShares');

  await local.getByRole('button', { name: 'Drop orders' }).click();
  await page.getByRole('alertdialog', { name: 'Drop orders?' }).getByRole('button', { name: 'Drop table' }).click();
  await expect(local).toContainText('No tables yet.');
});

test('a file type the local database does not read is turned away in the page', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const local = page.getByRole('dialog', { name: 'Data and catalog' }).getByTestId('local-db');
  await local.getByLabel('Files for the local database').setInputFiles({ name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  await expect(local.getByRole('alert')).toContainText('notes.docx');
});

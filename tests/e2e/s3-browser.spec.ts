// The Data panel's Amazon S3 browser and RDS help card against the mock's fake bucket (tests/e2e/mock-server.mjs):
// pick the allowlisted bucket, open a folder, import picked objects and a whole partitioned folder with progress,
// see a failed import's sentence, and list RDS databases with an entry to copy.
import { expect, test } from './fixtures';

async function openData(semaphore: import('./fixtures').SemaphoreApp) {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await semaphore.page.getByRole('button', { name: 'Data', exact: true }).click();
  const panel = semaphore.page.getByRole('dialog', { name: 'Data and catalog' });
  await expect(panel.getByTestId('s3-browser')).toBeVisible();
  return panel;
}

test('browses the allowlisted bucket and imports picked objects into one table', async ({ semaphore }) => {
  const panel = await openData(semaphore);
  const s3 = panel.getByTestId('s3-browser');
  await s3.getByLabel('S3 bucket').selectOption({ label: 'Maintenance exports (s3://maint-exports/semaphore/) · us-gov-west-1' });
  const objects = s3.getByRole('list', { name: 'Objects' });
  await expect(objects.getByRole('checkbox', { name: /work_orders\.csv/ })).toBeVisible();
  await expect(objects.getByRole('button', { name: 'parts/' })).toBeVisible();

  await objects.getByRole('checkbox', { name: /work_orders\.csv/ }).click();
  await objects.getByRole('checkbox', { name: /hulls\.csv\.gz/ }).click();
  await expect(objects.getByRole('checkbox', { name: /work_orders\.csv/ })).toHaveAttribute('aria-checked', 'true');
  await s3.getByLabel('Table name').fill('maint_files');
  await s3.getByRole('button', { name: /Import 2 objects as one table/ }).click();
  await expect(s3.getByTestId('s3-job')).toContainText('Imported into table maint_files: 2,500 rows, 6 columns');
});

test('opens a partitioned folder and imports the whole prefix, then goes back up', async ({ semaphore }) => {
  const panel = await openData(semaphore);
  const s3 = panel.getByTestId('s3-browser');
  await s3.getByLabel('S3 bucket').selectOption({ index: 1 });
  await s3.getByRole('list', { name: 'Objects' }).getByRole('button', { name: 'parts/' }).click();
  await expect(s3.getByRole('navigation', { name: 'S3 folder' })).toContainText('parts');
  await expect(s3.getByRole('list', { name: 'Objects' }).getByRole('button', { name: 'year=2025/' })).toBeVisible();
  await s3.getByRole('button', { name: 'Import this whole folder' }).click();
  await expect(s3.getByTestId('s3-job')).toContainText('Imported into table parts: 2,500 rows');

  await s3.getByRole('navigation', { name: 'S3 folder' }).getByRole('button', { name: 'semaphore' }).click();
  await expect(s3.getByRole('list', { name: 'Objects' }).getByRole('checkbox', { name: /work_orders\.csv/ })).toBeVisible();
});

test('a failed import says why, in a sentence', async ({ semaphore }) => {
  const panel = await openData(semaphore);
  const s3 = panel.getByTestId('s3-browser');
  await s3.getByLabel('S3 bucket').selectOption({ index: 1 });
  await s3.getByRole('list', { name: 'Objects' }).getByRole('checkbox', { name: /broken\.csv/ }).click();
  await s3.getByRole('button', { name: /Import into the local database/ }).click();
  await expect(s3.getByTestId('s3-job')).toContainText('Import failed: S3 answered 403');
  await expect(s3.getByTestId('s3-job')).toContainText('s3:GetObject');
});

test('the RDS card lists databases with a sources.json entry to copy', async ({ semaphore }) => {
  const panel = await openData(semaphore);
  const card = panel.getByTestId('rds-help');
  await expect(card).toContainText('"kind": "aws-rds"');
  await card.getByLabel('AWS region').fill('us-gov-east-1');
  await card.getByRole('button', { name: 'Find RDS databases' }).click();
  const list = card.getByRole('list', { name: 'RDS databases' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const entry = list.getByLabel('sources.json entry for maint-aurora');
  await expect(entry).toHaveValue(/"engine": "aurora-postgresql"/);
  await expect(entry).toHaveValue(/"auth": "iam"/);
  await expect(entry).toHaveValue(/cluster-ro-abc123\.us-gov-east-1\.rds\.amazonaws\.com/);
  await expect(list.getByLabel('sources.json entry for supply-sql')).toHaveValue(/"auth": "password"/);
  await expect(card).toContainText('Semaphore does not write the file');
});

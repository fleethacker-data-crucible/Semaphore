// The SQL desk's Script mode, pipelines and dataset exports: a T-SQL script with a MERGE is shown in
// SQLite before it runs, runs, and shows a result per statement; saved, it becomes a pipeline's Script
// step, and Update now colours the step boxes; a local table downloads as a CSV file.
import { expect, test } from './fixtures';

const SCRIPT = `DROP TABLE IF EXISTS stock
CREATE TABLE stock (id INT PRIMARY KEY, name NVARCHAR(50), qty INT)
INSERT INTO stock VALUES (1, N'bolt', 5), (2, N'nut', 7)
MERGE INTO stock AS t
USING (SELECT 2 AS id, 'nut' AS name, 70 AS qty UNION ALL SELECT 3, 'washer', 30) AS s
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET t.qty = s.qty
WHEN NOT MATCHED THEN INSERT (id, name, qty) VALUES (s.id, s.name, s.qty);
SELECT id, name, qty FROM stock ORDER BY id`;

test('a T-SQL script with MERGE is translated, run, saved, run by a pipeline, and its table exported', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();

  // Script mode in the SQL desk.
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /^SQL desk/ }).click();
  const desk = page.getByRole('dialog', { name: 'SQL desk' });
  await desk.getByRole('tab', { name: 'Script' }).click();
  const mode = desk.getByTestId('script-mode');
  await mode.getByLabel('Script SQL language').selectOption('tsql');
  await mode.getByLabel('Script', { exact: true }).fill(SCRIPT);
  const translation = mode.getByTestId('script-translation');
  await expect(translation).toContainText('translated from T-SQL');
  await expect(translation).toContainText('UPDATE stock AS t SET qty = s.qty FROM');
  await expect(translation).toContainText('INSERT INTO stock (id, name, qty) SELECT s.id, s.name, s.qty FROM sem_merge_4 AS s');
  await expect(translation).toContainText('MERGE became');

  await mode.getByLabel('Script', { exact: true }).press('Control+Enter');
  await expect(mode.getByTestId('script-summary')).toContainText('Ran in');
  const tabs = mode.getByRole('tablist', { name: 'Statement results' }).getByRole('tab');
  await expect(tabs).toHaveCount(9);
  await expect(mode.getByRole('tabpanel')).toContainText('row');
  await tabs.last().click();
  const table = mode.getByRole('tabpanel');
  await expect(table).toContainText('washer');
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row').nth(2)).toContainText('70');

  // Saved scripts library.
  await mode.getByLabel('Script name').fill('Merge stock');
  await mode.getByRole('button', { name: 'Save' }).click();
  await expect(mode).toContainText('Saved as merge-stock');
  await expect(mode.getByLabel('Saved scripts')).toContainText('Merge stock (merge-stock)');
  await desk.getByRole('button', { name: 'Close' }).click();

  // A pipeline that runs it and publishes.
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Data and catalog' });
  await expect(panel.getByRole('list', { name: 'Local tables' })).toContainText('stock');
  await panel.getByRole('button', { name: /^Pipelines/ }).click();
  const view = page.getByRole('dialog', { name: 'Pipelines' });
  await view.getByRole('button', { name: 'New pipeline' }).click();
  const editor = view.getByTestId('pipeline-editor');
  await editor.getByLabel('Pipeline name').fill('Stock rebuild');
  await editor.getByRole('button', { name: 'Script', exact: true }).click();
  await expect(editor.getByLabel('Script of step 1')).toHaveValue('merge-stock');
  await editor.getByRole('button', { name: 'Publish', exact: true }).click();
  const nodes = editor.getByTestId('pipeline-nodes');
  await expect(nodes.locator('[data-step="script-1"]')).toHaveAttribute('data-state', 'pending');
  await editor.getByRole('button', { name: 'Update now' }).click();
  await expect(editor.getByTestId('pipeline-message')).toContainText('Updated in');
  await expect(nodes.locator('[data-step="script-1"]')).toHaveAttribute('data-state', 'done');
  await expect(nodes.locator('[data-step="publish-1"]')).toHaveAttribute('data-state', 'done');
  await expect(nodes).toContainText('done');
  await expect(view.getByRole('navigation', { name: 'Pipeline list' })).toContainText('Stock rebuild');
  await expect(editor).toContainText('Run history (1)');
  await view.getByRole('button', { name: 'Close' }).click();

  // Export the table as CSV.
  const local = panel.getByTestId('local-db');
  const download = page.waitForEvent('download');
  await local.getByLabel('Export stock').selectOption('csv');
  const file = await download;
  expect(file.suggestedFilename()).toBe('stock.csv');
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toContain('id,name,qty');
  expect(text).toContain('3,washer,30');
  await expect(local.getByRole('alert')).toContainText('Exported 3 rows of stock');
});

test('a script with a refused statement shows the problem and its line, and does not run', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Hoist', exact: true }).click();
  await page.getByRole('menuitem', { name: /^SQL desk/ }).click();
  const desk = page.getByRole('dialog', { name: 'SQL desk' });
  await desk.getByRole('tab', { name: 'Script' }).click();
  const mode = desk.getByTestId('script-mode');
  await mode.getByLabel('Script', { exact: true }).fill("SELECT 1;\nATTACH DATABASE 'other.db' AS o;");
  await expect(mode.getByRole('list', { name: 'Script problems' })).toContainText('Line 2: ATTACH is refused');
  await expect(mode.getByRole('button', { name: 'Run script' })).toBeDisabled();
});

// A calculated measure whose inputs are in two tables, in the browser: labor cost on jobs and hulls on
// a hulls table, both linked to regions. Three CSV files are read in the page; the flag works the
// measure out from each table on its own, lines the rows up by region, shows nothing for a region one
// table lacks, and says so in its readback and notes.
import { expect, test } from './fixtures';

const FILES = [
  { name: 'regions.csv', text: 'id,region\nR1,East\nR2,West\nR3,North\n' },
  { name: 'jobs.csv', text: 'job_id,region_id,labor\n1,R1,10\n2,R1,20\n3,R2,40\n' },
  { name: 'hulls.csv', text: 'hull_id,region_id,hull\n1,R1,h1\n2,R1,h2\n3,R1,h1\n4,R2,h3\n5,R3,h9\n' },
];

type Stored = { fields: Array<{ key: string; source: string; table: string; column: string }>; metrics: unknown[]; relationships?: unknown[] };

test('a measure over two tables: each read on its own, lined up by region, nothing shown where one is missing', async ({ semaphore, page }) => {
  test.setTimeout(90_000);
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const data = page.getByRole('dialog', { name: 'Data and catalog' });
  await data.locator('label', { hasText: 'CSV files and Fleet exports' }).locator('input[type="file"]').setInputFiles(FILES.map((f) => ({ name: f.name, mimeType: 'text/csv', buffer: Buffer.from(f.text) })));
  const tables = async () => [...new Set(((await semaphore.stored<Stored>('catalogs', 'default'))?.fields ?? []).map((f) => f.table))];
  await expect.poll(tables, { timeout: 15_000 }).toEqual(expect.arrayContaining(['regions', 'jobs', 'hulls']));

  // Link both tables to regions and add the measure, as Data > Links and Data > Measures would.
  await page.goto('about:blank');
  const catalog = (await semaphore.stored<Stored>('catalogs', 'default'))!;
  const field = (table: string, column: string) => catalog.fields.find((f) => f.table === table && f.column === column)!;
  const source = field('jobs', 'labor').source;
  const link = (from: string) => ({ id: `e2e-${from}`, source, from: { table: from, column: 'region_id' }, to: { table: 'regions', column: 'id' }, origin: 'analyst' });
  await semaphore.writeStored('catalogs', 'default', {
    ...catalog,
    relationships: [...(catalog.relationships ?? []), link('jobs'), link('hulls')],
    metrics: [
      ...catalog.metrics,
      { key: 'e2e_labor', label: 'Labor', agg: 'sum', field: field('jobs', 'labor').key, source },
      { key: 'e2e_hulls', label: 'Hull count', agg: 'count_distinct', field: field('hulls', 'hull').key, source },
      { key: 'e2e_per_hull', label: 'Labor per hull', agg: 'formula', formula: 'e2e_labor / e2e_hulls', source },
    ],
  });
  const flag = {
    id: 'per-hull',
    kind: 'table',
    title: 'Labor per hull by region',
    brief: 'labor per hull by region',
    layout: { x: 0, y: 0, w: 6, h: 5 },
    binding: { metrics: ['e2e_per_hull'], dimensions: [{ field: field('regions', 'region').key }], filters: [], sort: { by: 'e2e_per_hull', dir: 'desc' } },
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    status: 'ready',
    notes: [],
  };
  await semaphore.writeStored('hoists', 'across', { version: 1, id: 'across', title: 'Across tables', brief: '', grid: { cols: 12 }, filters: [], updated: new Date().toISOString(), flags: [flag] });

  await semaphore.open();
  await page.getByRole('button', { name: 'Open a saved hoist' }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /^Across tables/ }).click();
  const card = page.locator('[data-flag-card]', { hasText: 'Labor per hull by region' }).first();
  // West 40 / 1 hull, East 30 / 2 hulls (h1 counted once); North has hulls but no jobs.
  const rows = card.locator('tbody tr');
  await expect(rows.first()).toContainText('West', { timeout: 20_000 });
  await expect(rows.first()).toContainText('40');
  await expect(rows.nth(1)).toContainText('East');
  await expect(rows.nth(1)).toContainText('15');
  await expect(card.locator('tbody')).toContainText('North');
  await expect(card).not.toContainText('Labor per hull combines');

  await card.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await expect(inspector).toContainText('Worked out from jobs and hulls, lined up by Region');
  await expect(inspector).toContainText('1 of these groups is found in only some of jobs, hulls');
});

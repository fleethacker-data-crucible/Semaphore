// Pivot flags in the browser. A pivot of the example data: rows by region and ship class, columns by
// status, a sum and a distinct count side by side; groups fold, a header orders the rows, heat shading
// comes from the Look panel, and the flag saves as its pivoted grid. Added from the palette, next to Table.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const pivot = {
  id: 'pv',
  kind: 'pivot',
  title: 'Cost by region and class',
  brief: 'Pivot of labor cost and hulls affected by region and ship class across status',
  layout: { x: 0, y: 0, w: 12, h: 8 },
  binding: { metrics: ['labor_cost', 'hulls_affected'], dimensions: [{ field: 'jobs.region' }, { field: 'jobs.ship_class' }, { field: 'jobs.status' }], filters: [] },
  behavior: { onClick: 'filter-page', ignore: [], thresholds: [] },
  status: 'ready',
  notes: [],
};

async function openPivot(semaphore: { writeStored: (k: string, id: string, d: unknown) => Promise<void>; open: () => Promise<string> }, page: Page) {
  await semaphore.writeStored('hoists', 'pivots', { version: 1, id: 'pivots', title: 'Pivots', brief: '', grid: { cols: 12 }, filters: [], updated: new Date().toISOString(), flags: [pivot] });
  await semaphore.open();
  await page.getByRole('button', { name: 'Open a saved hoist' }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /^Pivots/ }).click();
  await expect(page.getByRole('textbox', { name: 'Hoist title' })).toHaveValue('Pivots');
  const card = page.locator('[data-flag-card]', { hasText: 'Cost by region and class' }).first();
  await expect(card.getByTestId('pivot')).toBeVisible({ timeout: 20_000 });
  return card;
}

const num = async (cells: ReturnType<Page['locator']>) => (await cells.evaluateAll((els) => els.map((e) => e.getAttribute('data-value')))).map((v) => (v === null || v === '' ? null : Number(v)));

test('a pivot flag nests its rows, folds a group, orders by a column total, shades its cells and saves its grid', async ({ semaphore, page }) => {
  test.setTimeout(90_000);
  const card = await openPivot(semaphore, page);
  const table = card.getByTestId('pivot').locator('table');
  await expect(table.locator('tfoot')).toContainText('Grand total');
  const groups = table.locator('tbody tr[data-pivot-line="group"]');
  const leaves = table.locator('tbody tr[data-pivot-line="leaf"]');
  const groupCount = await groups.count();
  expect(groupCount).toBeGreaterThan(2);
  const leafCount = await leaves.count();

  // A distinct count's grand total comes from the data: the same hull is in several regions, so the
  // grand total is less than the regions' subtotals added up (it is never summed from the cells).
  const hullsTotal = table.locator('tfoot td').last();
  const grand = (await num(hullsTotal))[0]!;
  const subtotals = (await num(groups.locator('td:last-child'))).filter((v): v is number => v !== null);
  expect(subtotals.length).toBe(groupCount);
  expect(grand).toBeGreaterThan(0);
  expect(grand).toBeLessThan(subtotals.reduce((a, b) => a + b, 0));

  // Fold the first region: its classes go, its subtotal stays, and the button says so.
  const fold = groups.first().getByRole('button', { name: /^Fold / });
  await fold.click();
  await expect(groups.first().getByRole('button', { name: /^Unfold / })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => leaves.count()).toBeLessThan(leafCount);
  await groups.first().getByRole('button', { name: /^Unfold / }).press('Enter');
  await expect.poll(() => leaves.count()).toBe(leafCount);

  // Order the rows by the labor cost total, highest first: the regions' subtotals then fall.
  const header = table.locator('thead tr').last().locator('th');
  const totalCost = header.nth((await header.count()) - 2);
  await totalCost.getByRole('button').click();
  await expect(totalCost).toHaveAttribute('aria-sort', 'descending');
  const costs = (await num(groups.locator('td:nth-last-child(2)'))).map((v) => v ?? -Infinity);
  expect(costs).toEqual([...costs].sort((a, b) => b - a));

  // Heat shading by the whole table, from the Look panel, in the look's palette.
  await card.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await expect(inspector.getByTestId('pivot-panel')).toBeVisible();
  await inspector.getByRole('button', { name: 'Look' }).click();
  const heat = inspector.getByRole('group', { name: 'Labor cost' });
  await heat.getByRole('button', { name: 'Whole table' }).click();
  await expect(heat.getByRole('button', { name: 'Whole table' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => table.locator('td[data-heat]').count()).toBeGreaterThan(5);
  expect(await table.locator('td[data-heat]').first().getAttribute('style')).toContain('color-mix');

  // The flag saves as its pivoted grid: subtotal and grand total rows, a total column per measure.
  const saved = inspector.getByRole('region', { name: 'Save this flag' });
  const [csv] = await Promise.all([page.waitForEvent('download'), saved.getByRole('button', { name: 'csv' }).click()]);
  const text = (await readFile(await csv.path())).toString('utf8');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  expect(lines[0]).toContain('Region');
  expect(lines[0]).toContain('Total · Labor cost');
  expect(lines[0]).toContain('Total · Hulls affected');
  expect(text).toContain('Subtotal');
  expect(lines[lines.length - 1]).toMatch(/^"?Grand total/);
  // Rows in the order the page shows them: the first region is the one with the highest cost.
  const firstGroup = (await groups.first().locator('th').innerText()).replace(/\(\d+\)$/, '').trim();
  expect(lines[1]).toContain(firstGroup);
});

test('a pivot is added from the palette, next to Table, and its inspector says what it needs', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const palette = page.getByRole('navigation', { name: 'Flag palette' });
  const names = await palette.locator('button .font-medium').allInnerTexts();
  expect(names.indexOf('Pivot')).toBe(names.indexOf('Table') + 1);
  const before = await page.locator('[data-flag-card]').count();
  await palette.getByRole('button', { name: /^Pivot/ }).click();
  await expect(page.locator('[data-flag-card]')).toHaveCount(before + 1);
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await expect(inspector.getByTestId('pivot-panel')).toContainText('every field but the last makes the rows');
});

test('page exports (JSON here, the same table Excel and CSV write) carry the pivoted grid with its totals', async ({ semaphore, page }) => {
  await openPivot(semaphore, page);
  await page.getByRole('button', { name: 'Export or share' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export or share' });
  await dialog.getByRole('radio', { name: /^JSON/ }).check();
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save the file' }).click()]);
  const doc = JSON.parse((await readFile(await file.path())).toString('utf8'));
  const flag = doc.flags.find((f: { kind: string }) => f.kind === 'pivot');
  const columns = flag.table.columns.map((c: { label: string }) => c.label);
  expect(columns.slice(0, 2)).toEqual(['Region', 'Ship class']);
  expect(columns).toContain('Total · Hulls affected');
  const rows = flag.table.rows as Array<Array<{ text: string }>>;
  expect(rows.some((r) => r[1]!.text === 'Subtotal')).toBe(true);
  expect(rows[rows.length - 1]![0]!.text).toBe('Grand total');
});

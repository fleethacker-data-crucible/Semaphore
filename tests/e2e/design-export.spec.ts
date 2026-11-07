// Page design, a flag's Look, and exports: each file downloads and starts as its format says it should.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { EXAMPLE_ID, expect, test } from './fixtures';

async function exportAs(page: Page, label: RegExp): Promise<{ name: string; bytes: Buffer }> {
  await page.getByRole('button', { name: 'Export or share' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export or share' });
  await dialog.getByRole('radio', { name: label }).check();
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save the file' }).click()]);
  const bytes = await readFile(await file.path());
  await dialog.getByRole('button', { name: 'Close' }).click();
  return { name: file.suggestedFilename(), bytes };
}

test('a look changes the page, is saved with it, and Ctrl+Z takes it back', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Page design' }).click();
  const dialog = page.getByRole('dialog', { name: 'Page design' });
  await dialog.getByRole('button', { name: /^Bridge/ }).click();
  await expect(page.locator('[data-design-card="glass"]')).toHaveCount(1);
  await expect(page.locator('[data-design-motion="lively"]')).toHaveCount(1);
  await expect.poll(async () => (await semaphore.stored<{ design?: { look?: string } }>('hoists', EXAMPLE_ID))?.design?.look, { timeout: 10_000 }).toBe('bridge');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-design-card="glass"]')).toHaveCount(0);
});

test('a flag can have its own Look, and a reviewed flag stays reviewed', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = page.locator('[data-flag-card]:has([role="img"])').first();
  await card.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await inspector.getByRole('button', { name: 'Look' }).click();
  await inspector.getByRole('button', { name: /Ember/ }).click();
  await inspector.getByRole('checkbox', { name: 'Hide the title' }).check();
  await expect(card.locator('h3')).toHaveClass(/sr-only/);
  await expect.poll(async () => {
    const hoist = await semaphore.stored<{ flags: Array<{ status: string; style?: { palette?: string } }> }>('hoists', EXAMPLE_ID);
    return hoist?.flags.find((f) => f.style?.palette === 'ember')?.status;
  }, { timeout: 10_000 }).toBe('ready');
});

test('forms that load on demand draw, on a chart that was already on the page', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = page.locator('[data-flag-card]:has([role="img"])').first();
  await card.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await inspector.getByRole('button', { name: 'Look' }).click();
  const drawn = async () => {
    await expect(card.locator('[role="img"] svg').first()).toBeVisible();
    await page.waitForTimeout(500);
    await expect(card.getByText('could not be drawn')).toHaveCount(0);
  };
  await inspector.getByRole('radio', { name: 'Pie' }).click();
  await inspector.getByRole('button', { name: 'Funnel' }).click();
  await drawn();
  await inspector.getByRole('button', { name: 'Treemap' }).click();
  await drawn();
  await inspector.getByRole('radio', { name: 'Line' }).click();
  await inspector.getByRole('checkbox', { name: 'Zoom slider' }).check();
  await inspector.getByRole('checkbox', { name: 'Average line' }).check();
  await inspector.getByLabel('Target value').fill('50');
  await drawn();
  // A chart elsewhere on the page was made before the forms loaded, too.
  await inspector.getByRole('button', { name: 'Use on every flag' }).click();
  await page.waitForTimeout(500);
  await expect(page.getByText('could not be drawn')).toHaveCount(0);
});

test('the page exports to every format', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const pdf = await exportAs(page, /^PDF report/);
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  for (const [label, ext] of [[/^Excel workbook/, 'xlsx'], [/^PowerPoint/, 'pptx'], [/^Word report/, 'docx'], [/^CSV/, 'zip']] as const) {
    const file = await exportAs(page, label);
    expect(file.name.endsWith(`.${ext}`)).toBe(true);
    expect(file.bytes.subarray(0, 2).toString()).toBe('PK');
  }
  const json = await exportAs(page, /^JSON/);
  expect(JSON.parse(json.bytes.toString()).flags.length).toBeGreaterThan(0);
  const html = await exportAs(page, /^Interactive HTML/);
  expect(html.bytes.toString()).toContain('__SEMAPHORE_DATA__');
});

test('a chart saves on its own as a picture', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.locator('[data-flag-card]:has([role="img"])').first().locator('h3').click();
  const saved = page.getByRole('region', { name: 'Save this flag' });
  const [png] = await Promise.all([page.waitForEvent('download'), saved.getByRole('button', { name: 'png' }).click()]);
  expect((await readFile(await png.path())).subarray(1, 4).toString()).toBe('PNG');
  const [svg] = await Promise.all([page.waitForEvent('download'), saved.getByRole('button', { name: 'svg' }).click()]);
  expect((await readFile(await svg.path())).toString()).toContain('<svg');
});

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

/** The text of a chart's SVG labels, for reading its axes back without a hook into the chart library. */
async function svgTexts(card: ReturnType<Page['locator']>): Promise<string[]> {
  return card.locator('[role="img"] svg text').allTextContents();
}

test('a layout or scale change takes the axis with it, both ways', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  // Give the bar flag a second field, so its bars can stack and share. The change goes into this
  // page's own working copy: written to the folder behind the page's back, it would rightly raise the
  // conflict bar (someone else saved since).
  await expect.poll(async () => (await semaphore.stored('hoists', EXAMPLE_ID)) !== null, { timeout: 10_000 }).toBe(true);
  await page.evaluate(() => {
    const raw = localStorage.getItem('semaphore.hoist');
    if (!raw) throw new Error('no working copy');
    const h = JSON.parse(raw) as { flags: Array<{ id: string; binding: { dimensions: Array<{ field: string }> } | null }> };
    h.flags.find((f) => f.id === 'bar-region')!.binding!.dimensions.push({ field: 'jobs.status' });
    localStorage.setItem('semaphore.hoist', JSON.stringify(h));
  });
  await page.reload();
  await semaphore.continueToBuilder();

  const bars = page.locator('[data-flag-card]', { hasText: 'Labor cost by region' }).first();
  await bars.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  await inspector.getByRole('button', { name: 'Look' }).click();
  const layout = inspector.getByRole('group', { name: 'Layout' });
  await expect(layout.getByRole('button', { name: 'Best fit' })).toHaveAttribute('aria-pressed', 'true');
  await layout.getByRole('button', { name: '100%' }).click();
  // A share of the whole: the axis is in percent and never passes 100% (tick steps vary with the card's size).
  const percents = async () => (await svgTexts(bars)).filter((x) => /^\d+(\.\d+)?%$/.test(x)).map((x) => parseFloat(x));
  await expect.poll(async () => (await percents()).length).toBeGreaterThan(1);
  expect(Math.max(...(await percents()))).toBeLessThanOrEqual(100);
  await layout.getByRole('button', { name: 'Stacked' }).click();
  // The 100% cap went with the layout: the axis is back in dollars and reaches past 100.
  await expect.poll(async () => (await svgTexts(bars)).filter((t) => /%$/.test(t))).toEqual([]);
  await expect.poll(async () => (await svgTexts(bars)).some((t) => /^\$?\d/.test(t) && !/%$/.test(t))).toBe(true);

  const line = page.locator('[data-flag-card]', { hasText: 'Work orders per month' }).first();
  await line.locator('h3').click();
  await inspector.getByRole('button', { name: 'Look' }).click();
  const zero = inspector.getByRole('checkbox', { name: 'Start the scale at zero' });
  await expect(zero).toBeChecked();
  const atZero = await svgTexts(line);
  expect(atZero).toContain('0');
  await zero.uncheck();
  await expect.poll(() => svgTexts(line)).not.toEqual(atZero);
  await zero.check();
  // Switching the floating scale off again really puts zero back.
  await expect.poll(() => svgTexts(line)).toEqual(atZero);
});

test('Page design shows the skin\'s own cards as Standard until another style is chosen', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Page design' }).click();
  const dialog = page.getByRole('dialog', { name: 'Page design' });
  const cards = dialog.getByRole('group', { name: 'Cards' });
  await expect(cards.getByRole('button', { name: 'Standard' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-design-card="standard"]')).toHaveCount(1);
  await cards.getByRole('button', { name: 'Raised' }).click();
  await expect(page.locator('[data-design-card="raised"]')).toHaveCount(1);
  await cards.getByRole('button', { name: 'Standard' }).click();
  await expect(page.locator('[data-design-card="standard"]')).toHaveCount(1);
});

// Moving flags: Snap keeps a flag where it is dropped (gaps stay), Free moves it anywhere and lets it
// overlap, Tidy up floats everything back up. The mode is saved with the hoist.
import type { Locator, Page } from '@playwright/test';
import { EXAMPLE_ID, expect, test } from './fixtures';

type Stored = { grid: { cols: number; mode?: string }; flags: Array<{ id: string; title: string; layout: { x: number; y: number; w: number; h: number } }> };

async function drag(page: Page, card: Locator, dx: number, dy: number, alt = false) {
  const grip = card.getByRole('button', { name: 'Move flag' });
  const box = (await grip.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

const layoutOf = async (semaphore: { stored: <T>(k: string, id: string) => Promise<T | null> }, title: string) =>
  ((await semaphore.stored<Stored>('hoists', EXAMPLE_ID))?.flags.find((f) => f.title === title))?.layout;

test('Snap: a flag dragged down stays where it is dropped, and Tidy up floats it back', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const bar = page.getByTestId('layout-bar');
  await expect(bar.getByRole('radio', { name: /Snap/ })).toHaveAttribute('aria-checked', 'true');
  const card = page.locator('[data-flag-card]', { hasText: 'Labor cost by region' }).first();
  const before = (await card.boundingBox())!;
  // Three rows down (a row is 56 px plus a 12 px gap).
  await drag(page, card, 0, 3 * 68);
  await expect.poll(async () => (await card.boundingBox())!.y - before.y, { timeout: 5000 }).toBeGreaterThan(3 * 68 - 10);
  await page.waitForTimeout(400);
  expect((await card.boundingBox())!.y - before.y).toBeGreaterThan(3 * 68 - 10);
  await expect.poll(async () => Number.isInteger((await layoutOf(semaphore, 'Labor cost by region'))?.y), { timeout: 10_000 }).toBe(true);

  await bar.getByRole('button', { name: 'Tidy up' }).click();
  await expect.poll(async () => Math.abs((await card.boundingBox())!.y - before.y), { timeout: 5000 }).toBeLessThan(4);
});

test('Free: a flag moves in small steps, may overlap another, and the mode is saved', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const bar = page.getByTestId('layout-bar');
  await bar.getByRole('radio', { name: /Free/ }).click();
  await expect.poll(async () => (await semaphore.stored<Stored>('hoists', EXAMPLE_ID))?.grid.mode, { timeout: 10_000 }).toBe('free');

  const card = page.locator('[data-flag-card]', { hasText: 'Labor cost by region' }).first();
  const start = (await layoutOf(semaphore, 'Labor cost by region'))!;
  // About a third of a column across and a quarter of a row down: a position snap could not hold.
  const colPx = (await page.locator('[data-layout-mode]').boundingBox())!.width / 12;
  await drag(page, card, colPx * 0.375, 68 * 0.25);
  await expect.poll(async () => {
    const l = await layoutOf(semaphore, 'Labor cost by region');
    return l ? !Number.isInteger(l.x) || !Number.isInteger(l.y) : false;
  }, { timeout: 10_000 }).toBe(true);
  const moved = (await layoutOf(semaphore, 'Labor cost by region'))!;
  expect(moved.x * 8).toBe(Math.round(moved.x * 8));
  expect(moved.y * 8).toBe(Math.round(moved.y * 8));
  expect(moved.x).toBeGreaterThan(start.x);

  // Holding Alt lines the flag up with whole cells.
  await drag(page, card, colPx * 1.2, 0, true);
  await expect.poll(async () => Number.isInteger((await layoutOf(semaphore, 'Labor cost by region'))!.x), { timeout: 10_000 }).toBe(true);

  // Selected, it can be sent to the back and brought to the front (list order is stacking order).
  await card.locator('h3').click();
  await bar.getByRole('button', { name: /Back/ }).click();
  await expect.poll(async () => (await semaphore.stored<Stored>('hoists', EXAMPLE_ID))?.flags[0]?.title, { timeout: 10_000 }).toBe('Labor cost by region');
  await bar.getByRole('button', { name: /Front/ }).click();
  await expect.poll(async () => (await semaphore.stored<Stored>('hoists', EXAMPLE_ID))?.flags.at(-1)?.title, { timeout: 10_000 }).toBe('Labor cost by region');

  // Back to Snap: every flag sits on whole cells again, with no overlaps.
  await bar.getByRole('radio', { name: /Snap/ }).click();
  await expect.poll(async () => {
    const h = await semaphore.stored<Stored>('hoists', EXAMPLE_ID);
    return h && !h.grid.mode && h.flags.every((f) => Object.values(f.layout).every(Number.isInteger));
  }, { timeout: 10_000 }).toBe(true);
});

test('the cells show while a flag is being dragged', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = page.locator('[data-flag-card]').first();
  const grip = card.getByRole('button', { name: 'Move flag' });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 30, { steps: 3 });
  await expect(page.locator('.canvas-cells')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.canvas-cells')).toHaveCount(0);
});

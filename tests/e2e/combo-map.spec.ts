// The combo (bars and a line) and map kinds, drawn from the inspector: a combo with its line on a
// second scale and the measures' roles in the Look, the built-in US state tile map, and a region map
// the analyst adds in Settings > Maps from a small GeoJSON file.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { EXAMPLE_ID, expect, test } from './fixtures';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Flag inspector' });

/** The card of the example flag with this title, by its id (a draft may change the title). */
async function cardOf(page: Page, title: string): Promise<Locator> {
  const card = page.locator('[data-flag-card]', { hasText: title }).first();
  const id = await card.getAttribute('data-flag-card');
  return page.locator(`[data-flag-card="${id}"]`);
}

async function draft(page: Page, card: Locator, brief: string) {
  await card.locator('h3').click();
  const panel = inspector(page);
  await panel.getByRole('textbox', { name: 'Flag brief' }).fill(brief);
  await panel.getByRole('button', { name: /^(Draft|Redraft)$/ }).click();
}

async function drawn(page: Page, card: Locator) {
  await expect(card.locator('[role="img"] svg').first()).toBeVisible();
  await expect.poll(() => card.locator('[role="img"] svg path').count(), { timeout: 10_000 }).toBeGreaterThan(4);
  await page.waitForTimeout(400);
  await expect(card.getByText('could not be drawn')).toHaveCount(0);
}

const texts = (card: Locator) => card.locator('[role="img"] svg text').allTextContents();

test('a combo and a US state map draw from the inspector, and the combo\'s measures take their roles from the Look', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await expect(page.getByRole('navigation', { name: 'Flag palette' }).getByRole('button', { name: /^Combo/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Flag palette' }).getByRole('button', { name: /^Map/ })).toBeVisible();

  // Bars and a line: the brief says so, and the last measure is the line on its own scale.
  const combo = await cardOf(page, 'Labor cost by region');
  await draft(page, combo, 'Labor cost as bars and average days open as a line by region');
  const panel = inspector(page);
  await expect(panel.getByRole('radio', { name: 'Combo', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByTestId('kind-note')).toHaveCount(0);
  await drawn(page, combo);
  await expect.poll(async () => (await texts(combo)).filter((t) => t === 'Labor cost' || t === 'Average days open').length).toBeGreaterThanOrEqual(2);
  // Two scales: the left in dollars, the right in days.
  await expect.poll(async () => (await texts(combo)).some((t) => /^\$/.test(t))).toBe(true);

  // The Look: draw the line as bars as well, then back; the choice is saved with the flag.
  await panel.getByRole('button', { name: 'Look' }).click();
  const role = panel.getByRole('group', { name: 'How Average days open is drawn' });
  await role.getByRole('button', { name: 'Bars', exact: true }).click();
  await expect(role.getByRole('button', { name: 'Bars', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await drawn(page, combo);
  await expect.poll(async () => {
    const hoist = await semaphore.stored<{ flags: Array<{ id: string; kind: string; style?: { combo?: Record<string, { as?: string }> } }> }>('hoists', EXAMPLE_ID);
    return hoist?.flags.find((f) => f.kind === 'combo')?.style?.combo?.avg_days_open?.as;
  }, { timeout: 10_000 }).toBe('bar');
  await role.getByRole('button', { name: 'Line', exact: true }).click();
  await drawn(page, combo);

  // A state map: one square per state, named by its code, coloured by the measure.
  const map = await cardOf(page, 'Work orders per month');
  await draft(page, map, 'Labor cost by home state on a map');
  await expect(panel.getByRole('radio', { name: 'Map', exact: true })).toHaveAttribute('aria-checked', 'true');
  await drawn(page, map);
  await expect.poll(async () => {
    const t = await texts(map);
    return ['VA', 'TX', 'WA', 'ME'].every((code) => t.includes(code));
  }, { timeout: 10_000 }).toBe(true);
  // Every home state in the sample is a state, so nothing is listed as off the map.
  await expect(map.getByTestId('chart-note')).toHaveCount(0);
  // Hovering a state names it in full, with its value.
  const va = map.locator('[role="img"] svg text', { hasText: /^VA$/ }).first();
  await va.hover();
  await expect(map.getByText(/Virginia/)).toBeVisible();

  await panel.getByRole('button', { name: 'Close inspector' }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  const shot = process.env.SEMAPHORE_E2E_SHOT || path.join(__dirname, '.output', 'combo-map.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  const top = await combo.boundingBox();
  const right = await map.boundingBox();
  await page.screenshot({ path: shot, clip: { x: Math.max(0, top!.x - 8), y: Math.max(0, top!.y - 8), width: right!.x + right!.width - top!.x + 16, height: Math.max(top!.height, right!.height) + 16 } });
});

test('a region map added in Settings > Maps draws the page\'s regions, with values off the map listed', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  // Six fleet regions as boxes in longitude and latitude, and one name the data writes another way.
  const box = (x: number, y: number) => [[[x, y], [x + 8, y], [x + 8, y + 6], [x, y + 6], [x, y]]];
  const regions = [['Northeast', -78, 39], ['Southeast', -86, 28], ['Gulf', -98, 25], ['Pacific NW', -126, 42], ['Southwest', -122, 31], ['Great Lakes', -92, 41]] as const;
  const geojson = { type: 'FeatureCollection', features: regions.map(([name, x, y]) => ({ type: 'Feature', properties: { NAME: name, area: 1 }, geometry: { type: 'Polygon', coordinates: box(x, y) } })) };

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Maps' }).click();
  await expect(dialog.getByText('No region maps yet.')).toBeVisible();
  await dialog.getByLabel('Region map file').setInputFiles({ name: 'fleet_regions.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(geojson)) });
  await expect(dialog.getByTestId('map-preview')).toContainText('6 regions (Northeast, Southeast, Gulf, Pacific NW');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('fleet regions');
  await dialog.getByRole('textbox', { name: /Other names for regions/ }).fill('Pacific Northwest = Pacific NW');
  await dialog.getByRole('button', { name: 'Add the map' }).click();
  await expect(dialog.getByRole('status')).toContainText('Added fleet regions: 6 regions');
  await expect(dialog.getByRole('list', { name: 'Saved region maps' })).toContainText('6 regions, 1 other names');
  const home = (await semaphore.state()).home;
  expect(fs.existsSync(path.join(home, 'maps', 'fleet-regions.json'))).toBe(true);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'maps', 'shapes', 'fleet-regions.json'), 'utf8'));
  expect(saved.features[0].properties).toEqual({ name: 'Northeast' });
  // A file that is not a map says why, and nothing is added.
  await dialog.getByLabel('Region map file').setInputFiles({ name: 'points.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Port' }, geometry: { type: 'Point', coordinates: [1, 2] } }] })) });
  await expect(dialog.getByRole('alert')).toContainText('no named regions');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The bar flag as a map on the fleet regions.
  const card = await cardOf(page, 'Labor cost by region');
  await card.locator('h3').click();
  const panel = inspector(page);
  await panel.getByRole('radio', { name: 'Map', exact: true }).click();
  await expect(panel.getByTestId('kind-note')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Look' }).click();
  await expect(panel.getByRole('combobox', { name: 'Map' }).locator('option', { hasText: 'fleet regions (6 regions)' })).toHaveCount(1);
  await panel.getByRole('combobox', { name: 'Map' }).selectOption('fleet-regions');
  await drawn(page, card);
  await expect.poll(async () => {
    const t = await texts(card);
    return ['Northeast', 'Gulf', 'Pacific NW'].every((n) => t.includes(n));
  }, { timeout: 10_000 }).toBe(true);
  // "Pacific Northwest" in the data is "Pacific NW" on the map; every sample region is on it.
  await expect(card.getByTestId('chart-note')).toHaveCount(0);
  await expect.poll(async () => {
    const hoist = await semaphore.stored<{ flags: Array<{ kind: string; style?: { map?: string } }> }>('hoists', EXAMPLE_ID);
    return hoist?.flags.find((f) => f.kind === 'map')?.style?.map;
  }, { timeout: 10_000 }).toBe('fleet-regions');

  // Back on the state map, regions are not states: the note lists them.
  await panel.getByRole('combobox', { name: 'Map' }).selectOption('us-states');
  await expect(card.getByTestId('chart-note')).toContainText('Not on the map: ');
});

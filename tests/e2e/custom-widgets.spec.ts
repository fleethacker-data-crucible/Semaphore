// Custom chart widgets: an analyst's own code drawing in a sandboxed frame. A custom flag from the
// palette draws a starter template, cross-filters the page through api.select(), cannot reach the
// page's storage, session or DOM, is replaced when it stops answering, and goes to and from the team
// library.
import { readFile } from 'node:fs/promises';
import type { FrameLocator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Flag inspector' });

/** Adds a custom flag from the palette and drafts it from a brief; returns its card and frame. */
async function addCustomFlag(page: Page, brief: string, title: string) {
  await page.getByRole('navigation', { name: 'Flag palette' }).getByRole('button', { name: /^Custom/ }).click();
  const panel = inspector(page);
  await panel.getByRole('textbox', { name: 'Flag brief' }).fill(brief);
  await panel.getByRole('button', { name: /^Draft$/ }).click();
  await expect(panel.getByRole('button', { name: /^Redraft$/ })).toBeVisible();
  await panel.getByRole('textbox', { name: 'Flag title' }).fill(title);
  const card = page.locator('[data-flag-card]', { hasText: title }).first();
  await expect(card.getByTestId('widget-frame')).toBeVisible({ timeout: 15_000 });
  return { card, frame: card.frameLocator('[data-testid="widget-frame"]') };
}

/** Types code into the widget editor (replacing what is there); the card draws it after a pause. */
async function writeCode(page: Page, code: string) {
  const editor = inspector(page).getByRole('textbox', { name: 'Widget code' });
  await editor.fill(code);
}

async function barOf(frame: FrameLocator, label: string) {
  // The bullet's category labels are SVG text; the bar for one starts just right of its label.
  const text = frame.locator('svg text', { hasText: label }).first();
  await expect(text).toBeVisible();
  return (await text.boundingBox())!;
}

test('a custom flag from the palette draws the Bullet template in its sandboxed frame, and a click on a bar filters the page', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const { frame } = await addCustomFlag(page, 'Labor cost by region', 'Cost against target');
  const panel = inspector(page);
  await expect(panel.getByTestId('widget-panel')).toBeVisible();

  await panel.getByLabel('Widget template').selectOption('bullet');
  await expect(panel.getByRole('textbox', { name: 'Widget code' })).toHaveValue(/Bullet chart/);
  // Drawn inside the frame by the frame's own ECharts: bars, target marks and region labels.
  await expect(frame.locator('svg').first()).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('widget-ok')).toBeVisible();
  const label = (await frame.locator('svg text').allTextContents()).find((t) => /^(Northeast|Southeast|Gulf|Pacific|Atlantic|Great Lakes|[A-Z][a-z]+)/.test(t) && !/^\$|^\d/.test(t));
  expect(label, 'a region label in the bullet chart').toBeTruthy();

  // A click on a bar runs the widget's api.select(), which filters the whole page.
  // (Boxes of elements inside a frame are in the page's coordinates already. The bars grow in with the
  // chart's animation, so the click is tried again until one lands on a bar.)
  const chips = page.getByLabel('Page selections');
  await expect(async () => {
    if (!(await chips.count())) {
      const box = await barOf(frame, label!);
      await page.mouse.click(box.x + box.width + 18, box.y + box.height / 2);
    }
    await expect(chips).toContainText(label!, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // Saved on its own: the picture the frame hands back (its chart's PNG), and its table as CSV.
  const saved = panel.getByRole('region', { name: 'Save this flag' });
  const [png] = await Promise.all([page.waitForEvent('download'), saved.getByRole('button', { name: 'png' }).click()]);
  expect((await readFile(await png.path())).subarray(1, 4).toString()).toBe('PNG');
  const [csv] = await Promise.all([page.waitForEvent('download'), saved.getByRole('button', { name: 'csv' }).click()]);
  expect((await readFile(await csv.path())).toString()).toContain('Labor cost');
});

test('the frame cannot read the page: its storage, its session token and its DOM are out of reach', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  // The page does hold a session token, in its own sessionStorage.
  expect(await page.evaluate(() => sessionStorage.getItem('semaphore.session'))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.evaluate(() => localStorage.setItem('e2e-secret', 'not for widgets'));
  const { frame } = await addCustomFlag(page, 'Labor cost by region', 'Nosy widget');
  await writeCode(
    page,
    [
      'function render(api) {',
      '  const out = [];',
      '  const probe = (name, fn) => { try { const v = fn(); out.push(name + ": READ " + String(v).slice(0, 20)); } catch (e) { out.push(name + ": blocked (" + e.name + ")"); } };',
      '  probe("parent document", () => window.parent.document.title);',
      '  probe("top document", () => window.top.document.cookie);',
      '  probe("page localStorage", () => localStorage.getItem("e2e-secret"));',
      '  probe("page sessionStorage", () => sessionStorage.getItem("semaphore.session"));',
      '  probe("cookie", () => document.cookie);',
      '  const p = document.createElement("pre");',
      '  p.id = "probe";',
      '  p.textContent = out.join("\\n");',
      '  api.el.appendChild(p);',
      '  return window.parent.document.body.innerHTML;',
      '}',
    ].join('\n'),
  );
  const probe = frame.locator('#probe');
  await expect(probe).toContainText('parent document: blocked', { timeout: 15_000 });
  await expect(probe).toContainText('top document: blocked');
  await expect(probe).toContainText('page localStorage: blocked');
  await expect(probe).toContainText('page sessionStorage: blocked');
  await expect(probe).toContainText('cookie: blocked');
  await expect(probe).not.toContainText('READ');
  // The last line reaches for the page's DOM: the editor shows the browser's refusal. (A cross-origin
  // refusal carries no stack, so no line; an ordinary error does, below.)
  const error = inspector(page).getByTestId('widget-error');
  await expect(error).toContainText(/SecurityError.*cross-origin/);
  await writeCode(page, 'function render(api) {\n  const rows = api.data.rows;\n  return rows.missing.length;\n}\n');
  await expect(error).toContainText('Line 3');
  await expect(error).toContainText('TypeError');
});

const storedCustom = (id: string, title: string, x: number, code: string) => ({
  id,
  kind: 'custom',
  title,
  brief: title,
  layout: { x, y: 0, w: 6, h: 5 },
  binding: { metrics: ['labor_cost'], dimensions: [{ field: 'jobs.region' }], filters: [] },
  behavior: { onClick: 'filter-page', ignore: [], thresholds: [] },
  status: 'ready',
  notes: [],
  widget: { code },
});
const SAYS = (id: string, text: string) => `function render(api) {\n  api.el.innerHTML = "<p id=\\"${id}\\">${text}</p>";\n}\n`;

test('a widget stuck in a loop freezes only the widget frames, never the page; the others come back and so does it, fixed', async ({ semaphore, page }) => {
  test.setTimeout(180_000);
  await semaphore.writeStored('hoists', 'loops', {
    version: 1, id: 'loops', title: 'Loops', brief: '', grid: { cols: 12 }, filters: [], updated: new Date().toISOString(),
    flags: [storedCustom('fine', 'Fine widget', 0, SAYS('fine', 'still here')), storedCustom('loop', 'Runaway', 6, 'function render(api) {\n  while (true) {}\n}\n')],
  });
  await semaphore.open();
  await page.getByRole('button', { name: 'Open a saved hoist' }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /^Loops/ }).click();
  const runaway = page.locator('[data-flag-card="loop"]');
  const fine = page.locator('[data-flag-card="fine"]');
  // Both frames freeze (they share the browser's sandbox process) and come down. They start again one at a time, so the
  // runaway is caught drawing alone and is the one that stays down.
  await expect(runaway.getByTestId('widget-dead')).toContainText('This widget stopped responding', { timeout: 60_000 });
  // The page itself still answers: the inspector opens and its title field takes typing.
  await runaway.locator('h3').click();
  await inspector(page).getByRole('textbox', { name: 'Flag title' }).fill('Runaway, caught');
  await expect(runaway.locator('h3')).toHaveText('Runaway, caught');
  await expect(inspector(page).getByTestId('widget-error')).toContainText('stopped responding');
  // Every widget frame shares the browser's sandbox process, so the fine one rests too, then starts again by itself.
  await expect(fine.frameLocator('[data-testid="widget-frame"]').locator('#fine')).toHaveText('still here', { timeout: 70_000 });
  // Fixed code gets a new frame (after the rest) and draws.
  await writeCode(page, SAYS('fixed', 'fine again'));
  await expect(runaway.frameLocator('[data-testid="widget-frame"]').locator('#fixed')).toHaveText('fine again', { timeout: 50_000 });
});
test('a widget saved to the team library can be inserted into another flag', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await addCustomFlag(page, 'Labor cost by region', 'Library source');
  const panel = inspector(page);
  await panel.getByLabel('Widget template').selectOption('bullet');
  await expect(panel.getByTestId('widget-ok')).toBeVisible({ timeout: 15_000 });
  const library = panel.getByTestId('widget-library');
  await library.getByRole('button', { name: 'Save to team library' }).click();
  await library.getByLabel('Library widget name').fill('Fleet bullet');
  await library.getByLabel('Library widget description').fill('Cost against the fleet average');
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByTestId('widget-library-note')).toContainText('Saved to the team library as “Fleet bullet”');
  const stored = await semaphore.stored<{ name: string; code: string; by: string }>('widgets', 'fleet-bullet');
  expect(stored?.name).toBe('Fleet bullet');
  expect(stored?.code).toContain('Bullet chart');

  const { frame } = await addCustomFlag(page, 'Labor cost by region', 'Library copy');
  const copy = inspector(page).getByTestId('widget-library');
  await copy.getByRole('button', { name: 'Insert from library' }).click();
  await copy.getByRole('button', { name: 'Insert Fleet bullet' }).click();
  await expect(inspector(page).getByTestId('widget-library-note')).toContainText('Inserted “Fleet bullet”');
  await expect(inspector(page).getByRole('textbox', { name: 'Widget code' })).toHaveValue(/Bullet chart/);
  await expect(copy).toContainText('From the library: Fleet bullet');
  await expect(frame.locator('svg').first()).toBeVisible({ timeout: 15_000 });
  // The hoist keeps the code and where it came from.
  await expect
    .poll(async () => {
      const h = await semaphore.stored<{ flags: Array<{ title: string; widget?: { libraryId?: string; code: string } }> }>('hoists', 'fleet-maintenance');
      return h?.flags.find((f) => f.title === 'Library copy')?.widget?.libraryId;
    }, { timeout: 10_000 })
    .toBe('fleet-bullet');
});

test('the sandbox page is served with its own locked-down policy', async ({ request }) => {
  const r = await request.get('/sandbox/widget.html');
  expect(r.status()).toBe(200);
  const csp = r.headers()['content-security-policy']!;
  expect(csp).toContain('sandbox allow-scripts');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self' 'unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toContain('connect-src');
  expect(r.headers()['x-frame-options']).toBe('SAMEORIGIN');
  // The app routes do not fall back to the page under /sandbox/.
  expect((await request.get('/sandbox/anything')).status()).toBe(404);
  // The page itself may frame only its own origin.
  expect((await request.get('/')).headers()['content-security-policy']).toContain("frame-src 'self'");
});

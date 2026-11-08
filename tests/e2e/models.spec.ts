// Model flags in the browser: models run in the predict worker on the example data and show their
// answer; the inspector's Model panel switches models; a Monte Carlo runs on typed-in inputs alone.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

type Dim = { field: string; grain?: string };
const flag = (id: string, title: string, x: number, y: number, model: Record<string, unknown>, metrics: string[], dimensions: Dim[]) => ({
  id,
  kind: 'model',
  title,
  brief: title,
  layout: { x, y, w: 6, h: 5 },
  binding: metrics.length ? { metrics, dimensions, filters: [] } : null,
  behavior: { onClick: 'none', ignore: [], thresholds: [] },
  status: 'ready',
  notes: [],
  model,
});

async function openModels(semaphore: { writeStored: (k: string, id: string, d: unknown) => Promise<void>; open: () => Promise<string> }, page: Page, flags: unknown[]) {
  await semaphore.writeStored('hoists', 'models', { version: 1, id: 'models', title: 'Models', brief: '', grid: { cols: 12 }, filters: [], updated: new Date().toISOString(), flags });
  await semaphore.open();
  await page.getByRole('button', { name: 'Open a saved hoist' }).click();
  await page.getByRole('dialog', { name: 'Open a hoist' }).getByRole('button', { name: /^Models/ }).click();
  await expect(page.getByRole('textbox', { name: 'Hoist title' })).toHaveValue('Models');
}

test('model flags run in the worker on the example data and answer in words, numbers and a chart', async ({ semaphore, page }) => {
  test.setTimeout(60_000);
  await openModels(semaphore, page, [
    flag('fc', 'Forecast', 0, 0, { type: 'smoothing', params: { horizon: 6 } }, ['work_orders'], [{ field: 'jobs.opened', grain: 'month' }]),
    flag('mc', 'Cost risk', 6, 0, { type: 'montecarlo', params: { trials: 5000 } }, ['labor_cost'], [{ field: 'jobs.region' }]),
    flag('spc', 'Control', 0, 5, { type: 'spc' }, ['labor_cost'], [{ field: 'jobs.opened', grain: 'month' }]),
    flag('km', 'Groups', 6, 5, { type: 'kmeans' }, ['labor_cost', 'avg_days_open'], [{ field: 'jobs.hull' }]),
    flag('reg', 'Drivers', 0, 10, { type: 'regression' }, ['labor_cost', 'avg_days_open', 'work_orders'], [{ field: 'jobs.ship_class' }]),
    flag('wb', 'Reliability', 6, 10, { type: 'weibull' }, ['avg_days_open'], [{ field: 'jobs.hull' }]),
  ]);
  const answers = page.getByTestId('model-answer');
  await expect(answers).toHaveCount(6, { timeout: 30_000 });
  await expect(page.getByTestId('model-error')).toHaveCount(0);
  for (const model of ['smoothing', 'montecarlo', 'spc', 'kmeans', 'regression', 'weibull']) {
    const a = page.locator(`[data-model="${model}"]`);
    await expect(a.getByTestId('model-headline')).not.toBeEmpty();
    await expect(a.locator('[role="img"] svg').first()).toBeVisible();
  }
  // The table and the model's own words are a click away.
  const mc = page.locator('[data-model="montecarlo"]');
  await mc.getByRole('button', { name: 'Table' }).click();
  await expect(mc.getByTestId('model-table')).toContainText('P50');
  await mc.getByRole('button', { name: 'What the model says' }).click();
  await expect(mc.getByTestId('model-about')).not.toBeEmpty();
});

test('the inspector switches a flag to another model, and a Monte Carlo runs on typed-in inputs alone', async ({ semaphore, page }) => {
  test.setTimeout(60_000);
  await openModels(semaphore, page, [
    flag('fc', 'Forecast', 0, 0, { type: 'smoothing' }, ['work_orders'], [{ field: 'jobs.opened', grain: 'month' }]),
    flag('mc', 'Typed in', 6, 0, { type: 'montecarlo', params: { trials: 2000, target: 400 }, inputs: [{ name: 'Labour', low: 100, likely: 150, high: 260 }, { name: 'Parts', low: 80, likely: 120, high: 200 }] }, [], []),
  ]);
  await expect(page.locator('[data-model="montecarlo"]').getByTestId('model-headline')).toContainText('400', { timeout: 30_000 });
  const card = page.locator('[data-flag-card]', { hasText: 'Forecast' }).first();
  await card.locator('h3').click();
  const inspector = page.getByRole('complementary', { name: 'Flag inspector' });
  const panel = inspector.getByTestId('model-panel');
  await expect(panel).toBeVisible();
  await panel.getByLabel('Predictive model').selectOption('arima');
  await expect(card.locator('[data-model="arima"]')).toBeVisible({ timeout: 30_000 });
  await panel.getByLabel('Predictive model').selectOption('regression');
  await expect(panel.getByTestId('model-fit-note')).toContainText('two or more measures');
});

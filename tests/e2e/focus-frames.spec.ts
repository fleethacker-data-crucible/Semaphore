// A borderless field inside a rounded frame shows focus on the frame, never as a square ring inside
// it, in every theme preset; under high contrast the frame gets a 3px ring.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const PRESETS = ['Fleet', 'Midnight', 'Harbor', 'Ember', 'Forest', 'Graphite', 'Paper', 'Lagoon', 'Rose', 'Signal'];

async function usePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('radiogroup', { name: 'Theme presets' }).getByRole('radio', { name: new RegExp(`^${name}`) }).click();
  await dialog.getByRole('button', { name: 'Back to the page' }).click();
}

const look = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((field) => {
    const frame = field.closest('.focus-frame') as HTMLElement;
    const f = getComputedStyle(field);
    const s = getComputedStyle(frame);
    return { fieldOutline: f.outlineStyle, radius: Number.parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow, frameOutline: s.outlineStyle, frameOutlineWidth: s.outlineWidth };
  });

test('the assistant message box shows focus on its rounded frame in every theme', async ({ semaphore, page }) => {
  test.setTimeout(90_000);
  await semaphore.open();
  await semaphore.continueToBuilder();
  for (const name of PRESETS) {
    await usePreset(page, name);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const input = page.getByTestId('assistant-input');
    await input.click();
    await expect(input).toBeFocused();
    const l = await look(page, 'assistant-input');
    expect(l.fieldOutline, `${name}: no square ring on the field`).toBe('none');
    expect(l.radius, `${name}: the frame is rounded`).toBeGreaterThan(0);
    expect(l.shadow, `${name}: the frame shows focus`).not.toBe('none');
    if (name === 'Signal') {
      expect(l.frameOutline, 'high contrast: a ring on the frame').toBe('solid');
      expect(l.frameOutlineWidth).toBe('3px');
    } else expect(l.frameOutline, `${name}: no ring on the frame`).toBe('none');
    await page.keyboard.press('Escape');
  }
});

test('a plain control still gets the focus ring once the stylesheets are layered', async ({ semaphore, page }) => {
  await semaphore.open();
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(outline).toBe('solid');
});

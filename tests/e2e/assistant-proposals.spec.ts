// The turnkey assistant: with Fairlead (the mock's stand-in) it sees the page's flags and what they show,
// proposes changes as cards, and nothing changes until Accept; Accept goes through undo. In the
// Leadership view, asks can be deleted, and Settings > Connections fixes Fairlead with one button.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

const REPLY = [
  'The region chart reads well; its title could say it is labor cost. The empty table shows nothing.',
  '```semaphore-action',
  '{"action":"set-title","flag":"bar-region","title":"Labor cost by region (all ships)","reason":"Say what it measures."}',
  '```',
  '```semaphore-action',
  '{"action":"set-title","flag":"no-such-flag","title":"x"}',
  '```',
].join('\n');

test('the assistant sees the flags, proposes a change as a card, and applies it only on Accept, with undo', async ({ semaphore, page }) => {
  await semaphore.ai({ configured: true, running: true, reply: REPLY });
  await semaphore.open();
  await semaphore.continueToBuilder();
  const flag = page.locator('[data-flag="bar-region"]');
  await expect(flag).toContainText('Labor cost by region');

  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Semaphore assistant' });
  // "Include this page" is on by default now.
  await expect(dock.getByTestId('assistant-page')).toBeChecked();
  await dock.getByRole('button', { name: 'Review the flags on this page' }).click();

  const card = dock.getByTestId('assistant-proposal');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Rename "Labor cost by region"');
  await expect(card).toContainText('Labor cost by region (all ships)');
  await expect(dock.getByTestId('assistant-refusal')).toContainText('not on this page');
  await expect(dock.getByTestId('assistant-answer').last()).not.toContainText('semaphore-action');
  // What went to Fairlead: the flags and what they show, marked untrusted; never before Accept a change.
  const sent = (await semaphore.state()).aiLast!;
  expect(sent.model).toBe('local');
  expect(sent.messages[0]!.content).toContain('Flag bar-region');
  expect(sent.messages[0]!.content).toContain('shows now:');
  expect(sent.messages[0]!.content).toContain('untrusted');
  await expect(flag).not.toContainText('(all ships)');

  await card.getByTestId('assistant-accept').click();
  await expect(flag).toContainText('Labor cost by region (all ships)');
  await expect(card).toHaveAttribute('data-state', 'accepted');
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await page.keyboard.press('Control+z');
  await expect(flag).not.toContainText('(all ships)');
});

test('turning "Include this page" off is remembered, and then no outline goes', async ({ semaphore, page }) => {
  await semaphore.ai({ configured: true, running: true, reply: 'Sure.' });
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Semaphore assistant' });
  await dock.getByTestId('assistant-page').uncheck();
  await dock.getByTestId('assistant-input').fill('What is on this page?');
  await page.keyboard.press('Enter');
  await expect(dock.getByTestId('assistant-answer').last()).toContainText('Sure.');
  expect((await semaphore.state()).aiLast!.messages[0]!.content).not.toContain('PAGE OUTLINE');
  await page.reload();
  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await expect(page.getByTestId('assistant-page')).not.toBeChecked();
});

test('Leadership view: an ask that shows nothing is deleted at once, from the answer and from Your asks', async ({ semaphore, page }) => {
  await semaphore.open();
  const box = page.getByRole('textbox', { name: 'Ask a question' });
  const button = page.getByRole('button', { name: 'Leadership view' }).first();
  await expect(box.or(button).first()).toBeVisible();
  if (!(await box.isVisible())) await button.click();
  const home = (await semaphore.state()).home;
  const queued = () => (fs.existsSync(path.join(home, 'questions')) ? fs.readdirSync(path.join(home, 'questions')).filter((n) => n.endsWith('.json')) : []);

  for (const q of ['zzz qqq nothing here', 'qqq zzz none either']) {
    await box.fill(q);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('article', { name: `Answer: ${q}` })).toContainText('Sent to the analysts');
  }
  await expect.poll(() => queued().length).toBe(2);
  const mine = page.getByRole('region', { name: 'Your asks' });
  await expect(mine.getByTestId('my-ask')).toHaveCount(2);

  // From the answer card: nothing shown, so no confirmation; the queued question goes to .trash too.
  const first = page.getByRole('article', { name: 'Answer: zzz qqq nothing here' });
  await first.getByTestId('delete-answer').click();
  await expect(first).toHaveCount(0);
  await expect.poll(() => queued().length).toBe(1);
  // From Your asks.
  await mine.getByRole('button', { name: 'Delete ask: qqq zzz none either' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => queued().length).toBe(0);
  await expect(page.getByRole('region', { name: 'Your asks' })).toHaveCount(0);
  expect(fs.readdirSync(path.join(home, 'questions', '.trash')).length).toBe(2);
});

test('Suggest questions in the Leadership view opens the assistant with questions to click', async ({ semaphore, page }) => {
  await semaphore.open();
  const button = page.getByRole('button', { name: 'Leadership view' }).first();
  const box = page.getByRole('textbox', { name: 'Ask a question' });
  await expect(box.or(button).first()).toBeVisible();
  if (!(await box.isVisible())) await button.click();
  await page.getByTestId('suggest-questions').click();
  const dock = page.getByRole('complementary', { name: 'Semaphore assistant' });
  const cards = dock.getByTestId('assistant-proposal');
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().getByTestId('assistant-accept')).toHaveText(/Ask/);
  await cards.first().getByTestId('assistant-accept').click();
  await expect(page.getByRole('article', { name: /^Answer: / }).first()).toBeVisible();
  await expect(cards.first()).toHaveAttribute('data-state', 'accepted');
});

test('Settings > Connections shows each service with one line, and Fix starts Fairlead', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Connections' }).click();
  const card = dialog.getByRole('region', { name: 'Connections' });
  await expect(card.getByTestId('conn-fairlead')).toHaveAttribute('data-ok', 'false');
  await expect(card.getByTestId('conn-lazarette')).toHaveAttribute('data-ok', 'false');
  await expect(card.getByTestId('conn-voice')).toContainText(/not running|not found/);
  await card.getByTestId('fix-fairlead').click();
  await expect(card.getByTestId('conn-fairlead')).toHaveAttribute('data-ok', 'true');
  await expect(card.getByTestId('conn-fairlead')).toContainText('local key');
  await card.getByTestId('fix-lazarette').click();
  await expect(card).toContainText('Pair tool');
});

// Spoken answers and voice input through TalkForge, as in Lazarette (PRs 141, 142, 144). The mock acts
// TalkForge out (POST /__mock/voice); the fake microphone (playwright.config.ts) plays a short
// voice-like sound, then quiet, and the mock's stand-in Whisper "hears" a fixed sentence.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';

const dockOf = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Semaphore assistant' });
const orbOf = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^Semaphore assistant orb/ });

async function openSettingsAi(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'AI drafting' }).click();
  return dialog;
}

test.describe('spoken answers: getting the voice ready', () => {
  test('TalkForge not running yet is started when the speaker is turned on, and the panel says so', async ({ semaphore, page }) => {
    await semaphore.voice({ talkforge: 'offline' });
    await semaphore.open();
    await semaphore.continueToBuilder();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dock = dockOf(page);
    await dock.getByRole('button', { name: 'Read answers aloud' }).click();
    await expect(dock.getByTestId('assistant-speak-preparing')).toContainText('Getting the voice ready');
    await expect(dock.getByTestId('assistant-speak-preparing')).toHaveCount(0, { timeout: 15_000 });
    expect((await semaphore.state()).voice.talkforge).toBe('ready');
    await dock.getByTestId('assistant-input').fill('How do I export to Excel?');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await semaphore.state()).spoken.join(' '), { timeout: 15_000 }).toContain('Export');
    await expect(dock.getByTestId('assistant-speak-error')).toHaveCount(0);
  });

  test('an answer that finds TalkForge stopped starts it and is still spoken', async ({ semaphore, page, problems }) => {
    problems.allowNetwork(503, /\/api\/voice\/speak$/);
    await page.addInitScript(() => localStorage.setItem('semaphore.voice', JSON.stringify({ speak: true })));
    await semaphore.voice({ talkforge: 'offline' }); // as if TalkForge stopped by itself after its idle time
    await semaphore.open();
    await semaphore.continueToBuilder();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dock = dockOf(page);
    await dock.getByTestId('assistant-input').fill('How do I pair with Lazarette?');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await semaphore.state()).spoken.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(dock.getByTestId('assistant-speak-error')).toHaveCount(0);
  });

  test('Test voice gets TalkForge ready first', async ({ semaphore, page }) => {
    await semaphore.voice({ talkforge: 'offline' });
    await semaphore.open();
    await semaphore.continueToBuilder();
    const card = (await openSettingsAi(page)).getByRole('region', { name: 'Spoken answers' });
    await expect(card.getByTestId('voice-folder')).toHaveText(/TalkForge$/);
    await card.getByTestId('voice-test').click();
    await expect(card.getByTestId('voice-test')).toContainText('Getting ready');
    await expect(card.getByTestId('voice-test-result')).toContainText('Played', { timeout: 20_000 });
    expect((await semaphore.state()).spoken).toContain('Semaphore can read the assistant’s answers aloud.');
  });
});

test('Voice lists the voices installed in TalkForge, the default first and the fast ones marked', async ({ semaphore, page }) => {
  await semaphore.voice({ talkforge: 'ready' });
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = (await openSettingsAi(page)).getByRole('region', { name: 'Spoken answers' });
  const pick = card.getByLabel('Voice', { exact: true });
  await expect(pick.locator('option')).toHaveText([
    'TalkForge default (en_US-libritts-high)',
    'en_US-libritts-high (high quality, slower to start, 904 speakers)',
    'en_US-libritts_r-medium (medium quality, starts quickly, 904 speakers)',
  ]);
  await pick.selectOption('en_US-libritts_r-medium');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('semaphore.voice') ?? '{}').voice)).toBe('en_US-libritts_r-medium');
  await page.reload();
  await page.getByRole('button', { name: /^Continue/ }).click();
  const again = (await openSettingsAi(page)).getByRole('region', { name: 'Spoken answers' });
  await expect(again.getByLabel('Voice', { exact: true })).toHaveValue('en_US-libritts_r-medium');
});

test('with TalkForge not found, Voice says so and offers only the default', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const card = (await openSettingsAi(page)).getByRole('region', { name: 'Spoken answers' });
  await expect(card.getByLabel('Voice', { exact: true }).locator('option')).toHaveText(['TalkForge default']);
  await expect(card).toContainText('voices cannot be listed');
});

test.describe('voice input', () => {
  test('click the orb, talk, pause: the words go in the box and are sent without the keyboard', async ({ semaphore, page }) => {
    await semaphore.voice({ sttText: 'How do I export to Excel?' });
    await semaphore.open();
    await semaphore.continueToBuilder();
    await orbOf(page).click();
    const dock = dockOf(page);
    await expect(dock.getByTestId('assistant-listening')).toBeVisible();
    await expect(dock.getByTestId('assistant-mic')).toHaveAttribute('aria-pressed', 'true');
    await expect(dock.getByTestId('assistant-question').last()).toHaveText('How do I export to Excel?', { timeout: 15_000 });
    await expect(dock.getByTestId('assistant-answer').last()).toContainText('Export and share');
    await expect(dock.getByTestId('assistant-listening')).toHaveCount(0);
    await expect(dock.getByTestId('assistant-mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(dock.getByTestId('assistant-input')).toHaveValue('');
  });

  test('the microphone next to Send, with Send when I stop talking off: the words wait for Send', async ({ semaphore, page }) => {
    await semaphore.voice({ sttText: 'How do I pair with Lazarette?' });
    await semaphore.open();
    await semaphore.continueToBuilder();
    const dialog = await openSettingsAi(page);
    await dialog.getByRole('region', { name: 'Voice input' }).getByTestId('s-voice-autosend').uncheck();
    await dialog.getByRole('button', { name: 'Back to the page' }).click();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dock = dockOf(page);
    await dock.getByTestId('assistant-mic').click();
    await expect(dock.getByTestId('assistant-input')).toHaveValue('How do I pair with Lazarette?', { timeout: 15_000 });
    await expect(dock.getByTestId('assistant-listening')).toHaveCount(0, { timeout: 15_000 });
    await expect(dock.getByTestId('assistant-question')).toHaveCount(0);
    await dock.getByTestId('assistant-send').click();
    await expect(dock.getByTestId('assistant-question').last()).toHaveText('How do I pair with Lazarette?');
  });

  test('clicking the orb again while it listens stops without sending', async ({ semaphore, page }) => {
    await semaphore.open();
    await semaphore.continueToBuilder();
    await orbOf(page).click();
    const dock = dockOf(page);
    await expect(dock.getByTestId('assistant-listening')).toBeVisible();
    await orbOf(page).click();
    await expect(dock.getByTestId('assistant-listening')).toHaveCount(0);
    await page.waitForTimeout(3500);
    await expect(dock.getByTestId('assistant-question')).toHaveCount(0);
    await expect(dock.getByTestId('assistant-input')).toHaveValue('');
  });

  test('press and hold: listening while held, sent on release', async ({ semaphore, page }) => {
    await page.addInitScript(() => localStorage.setItem('semaphore.orb', JSON.stringify({ talk: 'hold' })));
    await semaphore.voice({ sttText: 'How do I add a flag?' });
    await semaphore.open();
    await semaphore.continueToBuilder();
    const box = (await orbOf(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const dock = dockOf(page);
    await expect(dock.getByTestId('assistant-listening')).toBeVisible();
    await page.waitForTimeout(1500); // talking while holding
    await page.mouse.up();
    await expect(dock.getByTestId('assistant-question').last()).toHaveText('How do I add a flag?', { timeout: 15_000 });
  });

  test('missing Whisper files: one clear message with the command to install them', async ({ semaphore, page }) => {
    await semaphore.voice({ sttMissing: true });
    await semaphore.open();
    await semaphore.continueToBuilder();
    await orbOf(page).click();
    const dock = dockOf(page);
    await expect(dock.getByTestId('assistant-listening-error')).toContainText("populate-assets.ps1 -Only 'stt/*'");
    await expect(dock.getByTestId('assistant-input')).toBeFocused();
  });

  test('Talk with the microphone off: no microphone button, and the orb only opens the panel', async ({ semaphore, page }) => {
    await semaphore.open();
    await semaphore.continueToBuilder();
    const dialog = await openSettingsAi(page);
    await dialog.getByRole('region', { name: 'Voice input' }).getByTestId('s-voice-input').uncheck();
    await dialog.getByRole('button', { name: 'Back to the page' }).click();
    await orbOf(page).click();
    const dock = dockOf(page);
    await expect(dock).toBeVisible();
    await expect(dock.getByTestId('assistant-mic')).toHaveCount(0);
    await expect(dock.getByTestId('assistant-listening')).toHaveCount(0);
  });

  test('voice input switched off for this Semaphore: the microphone is blocked by header and nothing listens', async ({ semaphore, page, request }) => {
    await semaphore.voice({ input: false });
    expect((await request.get('/')).headers()['permissions-policy']).toContain('microphone=()');
    await semaphore.open();
    await semaphore.continueToBuilder();
    await orbOf(page).click();
    const dock = dockOf(page);
    await expect(dock).toBeVisible();
    await expect(dock.getByTestId('assistant-mic')).toHaveCount(0);
    await expect(dock.getByTestId('assistant-listening')).toHaveCount(0);
    await dock.getByRole('button', { name: 'Close assistant' }).click();
    const card = (await openSettingsAi(page)).getByRole('region', { name: 'Voice input' });
    await expect(card.getByTestId('voice-input-off')).toContainText('voice.input');
    await expect(card.getByTestId('s-voice-input')).toBeDisabled();
  });

  test('headers: the page may use the microphone, and only the Whisper worker may compile WebAssembly', async ({ request }) => {
    const pageHeaders = (await request.get('/')).headers();
    expect(pageHeaders['permissions-policy']).toContain('microphone=(self)');
    expect(pageHeaders['content-security-policy']).not.toContain('wasm-unsafe-eval');
    const built = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'web', 'dist', 'build.json'), 'utf8')) as { stt: string };
    const worker = (await request.get('/' + built.stt)).headers();
    expect(worker['content-security-policy']).toBe(pageHeaders['content-security-policy']!.replace("script-src 'self';", "script-src 'self' 'wasm-unsafe-eval';"));
    expect((await request.get('/stt/secret.txt')).status()).toBe(404); // only fixed names (traversal is covered in tests/server/Voice.Tests.ps1)
  });
});

// Leadership Q&A: a drafted answer is labelled apart and goes to review only when asked; an analyst
// accepts it and it becomes a reviewed answer; the answer-quality numbers follow; an alert on a red rule
// is set from a tile and fires when the flag's snapshot refreshes; the briefing saves as an .eml draft.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const QUESTION = 'work orders by ship class';

async function toLeadership(page: Page) {
  const box = page.getByRole('textbox', { name: 'Ask a question' });
  const button = page.getByRole('button', { name: 'Leadership view' }).first();
  await expect(box.or(button).first()).toBeVisible();
  if (!(await box.isVisible())) await button.click();
  await expect(box).toBeVisible();
}

async function toBuilder(page: Page) {
  await page.getByRole('button', { name: 'Builder' }).click();
  const title = page.getByRole('textbox', { name: 'Hoist title' });
  const welcome = page.getByRole('button', { name: /^Continue / }).first();
  await expect(title.or(welcome).first()).toBeVisible();
  if (!(await title.isVisible())) await welcome.click();
  await expect(title).toBeVisible();
}

async function ask(page: Page, q: string) {
  await page.getByRole('textbox', { name: 'Ask a question' }).fill(q);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  return page.getByRole('article', { name: `Answer: ${q}` }).first();
}

function questionsIn(home: string): Array<Record<string, unknown>> {
  const dir = path.join(home, 'questions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

test('a drafted answer is labelled as not reviewed; Ask for review queues it, an analyst accepts it, and it is reviewed from then on', async ({ semaphore, page }) => {
  await semaphore.open();
  await toLeadership(page);
  const home = (await semaphore.state()).home;

  const card = await ask(page, QUESTION);
  await expect(card).toHaveAttribute('data-trust', 'drafted');
  const badge = card.getByTestId('trust-badge');
  await expect(badge).toContainText('Drafted — not yet reviewed');
  await expect(badge.locator('.sr-only')).toHaveText(/No analyst has reviewed it yet/);
  await expect(card.getByText(/no row-level security of its own/)).toBeVisible();
  await expect(card.getByRole('img').first()).toBeVisible();
  // Nothing goes to the analysts until the asker says so.
  await page.waitForTimeout(500);
  expect(questionsIn(home)).toEqual([]);

  await card.getByRole('button', { name: 'Ask for review' }).click();
  await expect(card.getByText(/Sent for review/)).toBeVisible();
  await expect.poll(() => questionsIn(home).length).toBe(1);
  const queued = questionsIn(home)[0]!;
  expect(queued.status).toBe('open');
  expect(queued.reviewRequested).toBeTruthy();
  expect((queued.draft as { binding: { metrics: string[] } }).binding.metrics).toContain('work_orders');
  // It is not in the playbook: only an analyst's accept puts it there.
  expect(fs.readdirSync(path.join(home, 'playbook')).filter((n) => n.includes('leadership-questions'))).toEqual([]);

  // The analyst: the draft is in the queue, labelled, and accepted as it is.
  await toBuilder(page);
  await page.getByRole('button', { name: /^Playbook/ }).click();
  const panel = page.getByRole('dialog', { name: 'Playbook' });
  await panel.getByRole('tab', { name: /^Questions/ }).click();
  const row = panel.getByTestId('question-row').filter({ hasText: QUESTION });
  await expect(row.getByText('Drafted — not yet reviewed')).toBeVisible();
  await expect(panel.getByLabel('Answer quality')).toContainText('1 draft to review');
  await row.getByRole('button', { name: 'Accept draft' }).click();
  await expect(panel.getByText('All caught up.')).toBeVisible();
  await expect.poll(() => questionsIn(home)[0]?.status).toBe('answered');
  const entryFile = fs.readdirSync(path.join(home, 'playbook')).find((n) => n.startsWith('leadership-questions--'));
  expect(entryFile).toBeTruthy();
  await panel.getByRole('button', { name: 'Close' }).click();

  // Back as the leader: told it was answered, and the same question is now reviewed.
  await page.getByRole('button', { name: 'Leadership view' }).click();
  await expect(page.getByText(/Answered:/)).toBeVisible();
  const again = await ask(page, QUESTION);
  await expect(again).toHaveAttribute('data-trust', 'reviewed');
  await expect(again.getByTestId('trust-badge')).toContainText('Reviewed');
  await expect(again.getByRole('button', { name: 'Ask for review' })).toHaveCount(0);

  // Answer quality: one drafted and one reviewed answer shown, one question answered within minutes, nothing waiting.
  await semaphore.open();
  await toLeadership(page);
  const quality = page.getByRole('region', { name: 'Answer quality' });
  await expect(quality.getByTestId('quality-share')).toHaveText('50%');
  await expect(quality).toContainText('1 reviewed, 1 drafted');
  await expect(quality.getByTestId('quality-time')).toContainText(/median \d+ min/);
  await expect(quality).toContainText('1 answered');
  await expect(quality.getByTestId('quality-queue')).toHaveText('0');
});

test('an alert set on a red rule fires once when the flag refreshes into red, with a badge, a toast and the Alerts panel', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const home = (await semaphore.state()).home;
  const snapFile = path.join(home, 'snapshots', 'fleet-maintenance--kpi-cost.json');
  // The builder learns the accepted flags and takes their snapshots from the sample data.
  await expect.poll(() => fs.existsSync(snapFile), { timeout: 20_000 }).toBe(true);

  // Make the saved labor cost a tenth of the real one (under its $5M red rule), fresh, as if read just now.
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const low = { ...snap, rows: snap.rows.map((r: Record<string, unknown>) => ({ ...r, a0: typeof r.a0 === 'number' ? Math.round(r.a0 / 10) : r.a0 })), asOf: new Date().toISOString() };
  fs.writeFileSync(snapFile, JSON.stringify(low));

  await semaphore.open();
  await toLeadership(page);
  const tile = page.getByTestId('glance-tile').filter({ hasText: 'Labor cost' });
  await expect(tile).toContainText(/\$\d/);
  await expect(tile).not.toContainText('Breaks its red rule');
  await tile.getByRole('button', { name: 'Alert me when Labor cost goes red' }).click();
  await expect(page.getByText(/Alert set: you will be told when Labor cost goes red \(over \$5/)).toBeVisible();
  await expect(tile.getByRole('button', { name: /Alert set on Labor cost/ })).toBeVisible();
  const alertDir = path.join(home, 'alerts');
  await expect.poll(() => (fs.existsSync(alertDir) ? fs.readdirSync(alertDir).filter((n) => n.endsWith('.json')).length : 0)).toBe(1);
  const alertFile = path.join(alertDir, fs.readdirSync(alertDir).find((n) => n.endsWith('.json'))!);
  expect(JSON.parse(fs.readFileSync(alertFile, 'utf8')).state).toBe('normal');
  await expect(page.getByTestId('alert-badge')).toHaveCount(0);

  // The snapshot goes out of date; the next page open refreshes it from the data (the real, red number) and the alert fires.
  fs.writeFileSync(snapFile, JSON.stringify({ ...low, asOf: new Date(Date.now() - 2 * 86_400_000).toISOString() }));
  await semaphore.open();
  await toLeadership(page);
  await expect(page.getByText(/Labor cost went red: \$/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('alert-badge')).toHaveText('1');
  const stored = JSON.parse(fs.readFileSync(alertFile, 'utf8'));
  expect(stored.state).toBe('red');
  expect(stored.events).toHaveLength(1);
  expect(stored.events[0].kind).toBe('red');
  expect(stored.events[0].value).toBeGreaterThan(5_000_000);

  await page.getByRole('button', { name: /^Alerts, 1 new/ }).click();
  const panel = page.getByRole('dialog', { name: 'Alerts' });
  const item = panel.getByTestId('alert-item');
  await expect(item).toContainText('Labor cost');
  await expect(item).toContainText(/went red: \$/);
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('alert-badge')).toHaveCount(0);

  // Opening the page again does not fire it a second time while it stays red.
  await semaphore.open();
  await toLeadership(page);
  await page.waitForTimeout(2000);
  expect(JSON.parse(fs.readFileSync(alertFile, 'utf8')).events).toHaveLength(1);
});

test('"Tell me when labor cost goes red" sets the alert; the briefing saves as an unsent .eml with the report, and Outlook missing is said plainly', async ({ semaphore, page }) => {
  await semaphore.open();
  await semaphore.continueToBuilder();
  const home = (await semaphore.state()).home;
  await expect.poll(() => fs.existsSync(path.join(home, 'snapshots', 'fleet-maintenance--kpi-cost.json')), { timeout: 20_000 }).toBe(true);
  await page.getByRole('button', { name: 'Leadership view' }).click();

  await page.getByRole('textbox', { name: 'Ask a question' }).fill('Tell me when labor cost goes red');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText(/Alert set: you will be told when Labor cost goes red/)).toBeVisible();
  await expect(page.getByText(/It is red now/)).toBeVisible();

  await page.getByRole('button', { name: 'Email this briefing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Email this briefing' });
  await expect(dialog.getByText(/Outlook is not installed on this computer/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Draft in Outlook' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Recipients' }).fill('cdr@example.org, not-an-address');
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Save as email (.eml)' }).click()]);
  expect(file.suggestedFilename()).toMatch(/^leadership-briefing-\d{4}-\d{2}-\d{2}\.eml$/);
  const eml = fs.readFileSync(await file.path(), 'utf8');
  expect(eml).toMatch(/^To: cdr@example\.org\r\n/);
  expect(eml).toContain('X-Unsent: 1');
  expect(eml).toMatch(/Content-Disposition: attachment; filename="leadership-briefing-\d{4}-\d{2}-\d{2}\.html"/);
  expect(eml).not.toMatch(/^From:/m);
  const html = Buffer.from(eml.split('Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]!.split('--')[0]!.replace(/\s+/g, ''), 'base64').toString('utf8');
  expect(html).toContain('Leadership briefing');
  expect(html).toContain('Only answers an analyst has reviewed are included');
  expect(html).toMatch(/Labor cost/);
  await expect(dialog.getByText(/Saved as an email file/)).toBeVisible();
  // Kept for the weekly draft, and the recipients saved.
  expect(fs.existsSync(path.join(home, 'mail', 'latest-briefing.json'))).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'mail', 'user-mock.json'), 'utf8')).recipients).toEqual(['cdr@example.org']);
});

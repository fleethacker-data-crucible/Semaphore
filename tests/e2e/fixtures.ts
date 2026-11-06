// Shared helpers: open the UI the way the launcher does (a fresh single-use launch link), read the
// mock's state and home folder, start a private mock for the tests that stop a server, and fail any
// test that produced a CSP violation, an uncaught page error or an unexpected console error.
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MOCK = path.join(__dirname, 'mock-server.mjs');
export const EXAMPLE_TITLE = 'Fleet maintenance overview';
export const EXAMPLE_ID = 'fleet-maintenance';

// Browsers log non-2xx fetches as console errors; the app provokes these on purpose (a catalog not
// saved yet, no refresh report, a used launch link).
const EXPECTED_NETWORK = /Failed to load resource: the server responded with a status of (400|401|404|409|413|429)/;

export interface Problems {
  console: string[];
  csp: string[];
  pageErrors: string[];
  /** Console errors matching this are expected in the current test (e.g. a server that was stopped). */
  allow: (re: RegExp) => void;
}

export interface MockState {
  home: string;
  port: number;
  autoStop: boolean;
  liveTabs: number;
  tabs: { tab: string; seenAgoMs: number; leaving: boolean }[];
  clientLog: { level: string; message: string }[];
  saves: number;
}

export const test = base.extend<{ problems: Problems; semaphore: SemaphoreApp }>({
  problems: [
    async ({ context }, use) => {
      const allowed: RegExp[] = [EXPECTED_NETWORK];
      const p: Problems = { console: [], csp: [], pageErrors: [], allow: (re) => void allowed.push(re) };
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
        });
      });
      const watch = (page: Page) => {
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
          if (t.startsWith('CSP-VIOLATION')) p.csp.push(t);
          else if (!allowed.some((re) => re.test(t))) p.console.push(t);
        });
        page.on('pageerror', (e) => p.pageErrors.push(e.message));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      await use(p);
      expect(p.csp, 'CSP violations').toEqual([]);
      expect(p.pageErrors, 'uncaught page errors').toEqual([]);
      expect(p.console, 'console errors').toEqual([]);
    },
    { auto: true },
  ],
  semaphore: async ({ page, request }, use) => {
    await use(new SemaphoreApp(page, request));
  },
});

export class SemaphoreApp {
  constructor(
    readonly page: Page,
    readonly request: APIRequestContext,
  ) {}

  /** A fresh launch link from the mock, as another run of Launch-Semaphore.bat would print. */
  async launchLink(): Promise<string> {
    const r = await this.request.post('/__mock/launch');
    expect(r.ok()).toBeTruthy();
    return ((await r.json()) as { link: string }).link;
  }

  async state(): Promise<MockState> {
    return (await (await this.request.get('/__mock/state')).json()) as MockState;
  }

  /** Opens the UI with a new launch link and waits for the welcome page. */
  async open(query = '') {
    const link = await this.launchLink();
    await this.page.goto(link + query);
    await expect(this.page.locator('#root')).not.toBeEmpty();
    return link;
  }

  /** From the welcome page into the builder on the example hoist. */
  async continueToBuilder(title = EXAMPLE_TITLE) {
    await this.page.getByRole('button', { name: `Continue “${title}”` }).click();
    await expect(this.page.getByRole('textbox', { name: 'Hoist title' })).toHaveValue(title);
  }

  /** The stored document in the mock's home folder, or null. */
  async stored<T = Record<string, unknown>>(kind: string, id: string): Promise<T | null> {
    const file = path.join((await this.state()).home, kind, `${id}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async writeStored(kind: string, id: string, doc: unknown) {
    const dir = path.join((await this.state()).home, kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc, null, 2));
  }
}

export interface OwnMock {
  proc: ChildProcess;
  base: string;
  link: string;
  home: string;
  exited: () => boolean;
  output: () => string;
  stop: () => void;
}

/**
 * A private mock with auto-stop on (as a plain double-click starts Semaphore) and short presence
 * timings, for the tests that end, kill or outlive the server.
 */
export function startOwnMock(env: Record<string, string> = {}, args: string[] = []): Promise<OwnMock> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semaphore-e2e-'));
  const proc = spawn(process.execPath, [MOCK, '--port', '0', '--home', home, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SEMAPHORE_AUTO_STOP: '', SEMAPHORE_MOCK_HEARTBEAT_TIMEOUT_MS: '8000', SEMAPHORE_MOCK_LEAVING_GRACE_MS: '1500', SEMAPHORE_MOCK_CHECK_MS: '250', ...env },
  });
  let log = '';
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the mock did not start: ' + log)), 10_000);
    const onData = (c: Buffer) => {
      log += c.toString();
      const m = /Session link \(works once, for 10 minutes\): (http:\/\/127\.0\.0\.1:\d+)(\/\?launch=[A-Za-z0-9_-]+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve({
          proc,
          base: m[1]!,
          link: m[1]! + m[2]!,
          home,
          exited,
          output: () => log,
          stop: () => {
            if (!exited()) proc.kill();
            fs.rmSync(home, { recursive: true, force: true });
          },
        });
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', (c: Buffer) => (log += c.toString()));
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (!/Session link/.test(log)) reject(new Error(`the mock exited early (${code}): ${log}`));
    });
  });
}

export { expect };

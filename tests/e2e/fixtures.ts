// Shared helpers: open the UI the way the launcher does (a fresh single-use launch link), read the
// mock's state and home folder, reset the shared mock before every test, start a private mock for the
// tests that stop a server, and fail any test that produced a CSP violation, an uncaught page error
// or a console error that was not expected.
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MOCK = path.join(__dirname, 'mock-server.mjs');
export const EXAMPLE_TITLE = 'Fleet maintenance overview';
export const EXAMPLE_ID = 'fleet-maintenance';

/**
 * Browsers log every non-2xx fetch as a console error. The app provokes some on purpose, always on
 * an API path: a catalog not saved yet (404), no refresh report yet (404), a used launch link (401),
 * a save conflict (409), the client-log limits (413, 429) and a refused body (400). Each allowance is
 * a (status, path) pair; anything else, and in particular a 404 under /assets/, fails the test.
 */
export type Allowance = { status: number; path: RegExp };
export const EXPECTED_NETWORK: Allowance[] = [
  { status: 400, path: /^\/api\// },
  { status: 401, path: /^\/api\// },
  { status: 404, path: /^\/api\// },
  { status: 409, path: /^\/api\// },
  { status: 413, path: /^\/api\// },
  { status: 429, path: /^\/api\// },
];
const NETWORK_ERROR = /Failed to load resource: the server responded with a status of (\d{3})/;

export interface Problems {
  console: string[];
  csp: string[];
  pageErrors: string[];
  /** Console errors matching this are expected in the current test (e.g. a server that was stopped). */
  allow: (re: RegExp) => void;
  /** One more (status, path) pair this test expects from the network. */
  allowNetwork: (status: number, path: RegExp) => void;
}

export interface MockState {
  home: string;
  port: number;
  autoStop: boolean;
  everSeen: boolean;
  liveTabs: number;
  tabs: { tab: string; seenAgoMs: number; leaving: boolean; leavingAgoMs: number | null }[];
  graceMs: number;
  timeoutMs: number;
  clientLog: { level: string; message: string }[];
  saves: number;
  vault: { paired: boolean; state: 'unlocked' | 'locked' | 'down' };
  voice: { talkforge: string; input: boolean };
  /** Texts sent to /api/voice/speak that the stand-in TalkForge spoke. */
  spoken: string[];
}

/** POST /__mock/voice: TalkForge as the next answers see it (mock-server.mjs). */
export interface VoiceMock {
  talkforge?: 'missing' | 'offline' | 'ready';
  input?: boolean;
  sttMissing?: boolean;
  sttText?: string;
}

export const test = base.extend<{ problems: Problems; semaphore: SemaphoreApp; freshMock: void }>({
  // Every test starts from an empty home folder, unpaired, with the rate limiter and counters cleared.
  freshMock: [
    async ({ request }, use) => {
      const r = await request.post('/__mock/reset');
      expect(r.ok(), 'the shared mock reset').toBeTruthy();
      await use();
    },
    { auto: true },
  ],
  problems: [
    async ({ context }, use) => {
      const allowed: RegExp[] = [];
      const network: Allowance[] = [...EXPECTED_NETWORK];
      const p: Problems = { console: [], csp: [], pageErrors: [], allow: (re) => void allowed.push(re), allowNetwork: (status, path) => void network.push({ status, path }) };
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
        });
      });
      const watch = (page: Page) => {
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
          if (t.startsWith('CSP-VIOLATION')) {
            p.csp.push(t);
            return;
          }
          if (allowed.some((re) => re.test(t))) return;
          const net = NETWORK_ERROR.exec(t);
          if (net) {
            const status = Number(net[1]);
            let pathname = m.location().url;
            try {
              pathname = new URL(pathname).pathname;
            } catch {
              /* keep the raw text */
            }
            if (network.some((a) => a.status === status && a.path.test(pathname))) return;
            p.console.push(`${status} on ${pathname}${pathname.startsWith('/assets/') ? ' (a built asset the page names is missing)' : ''}`);
            return;
          }
          p.console.push(t);
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

  async voice(v: VoiceMock): Promise<void> {
    const r = await this.request.post('/__mock/voice', { data: v });
    expect(r.ok(), 'the mock took the voice state').toBeTruthy();
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
  state: () => Promise<MockState>;
  stop: () => void;
}

/**
 * A private mock with auto-stop on (as a plain double-click starts Semaphore) and short presence
 * timings, for the tests that end, kill or outlive the server, or that must not share state.
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
        const basePath = m[1]!;
        resolve({
          proc,
          base: basePath,
          link: basePath + m[2]!,
          home,
          exited,
          output: () => log,
          state: async () => (await (await fetch(`${basePath}/__mock/state`)).json()) as MockState,
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

// End-to-end tests for the Semaphore browser UI against tests/e2e/mock-server.mjs, a Node stand-in
// for the PowerShell server (same gate, launch codes, presence and document store).
//   npm run build && npm run e2e
// Locally the suite uses Playwright's Chromium; CI on the Windows runner sets
// SEMAPHORE_E2E_BROWSER_CHANNEL=msedge to use the installed Edge (nothing is downloaded).
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const port = Number(process.env.SEMAPHORE_E2E_PORT || 47681);

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(__dirname, '.output', 'results'),
  fullyParallel: false,
  workers: 1, // one shared mock; the tests that stop a server start their own
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
  projects: [{ name: 'browser', use: { browserName: 'chromium', ...(process.env.SEMAPHORE_E2E_BROWSER_CHANNEL ? { channel: process.env.SEMAPHORE_E2E_BROWSER_CHANNEL } : {}) } }],
  webServer: {
    command: `node "${path.join(__dirname, 'mock-server.mjs')}" --port ${port} --stay`,
    url: `http://127.0.0.1:${port}/__fleethacker/id`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: 'ignore',
  },
});

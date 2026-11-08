// End-to-end tests for the Semaphore browser UI against tests/e2e/mock-server.mjs, a Node stand-in
// for the PowerShell server (same gate, launch codes, presence, headers and document store).
//   npm run build && npm run e2e
// Locally the suite uses Playwright's Chromium; CI sets SEMAPHORE_E2E_BROWSER_CHANNEL=msedge to use
// the installed Edge (nothing is downloaded). SEMAPHORE_E2E_TRACE=retain-on-failure keeps a trace
// and screenshot for each failed test under tests/e2e/.output (CI uploads that folder).
import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Fake microphone for the voice input tests (as Lazarette's tests/ui/playwright.config.ts): about 1.5 s
// of a voice-like sound (a 120-220 Hz buzz with harmonics, pulsing four times a second like
// syllables), then 3.5 s of quiet. Chromium loops it. The mock's stand-in Whisper "hears" a fixed text.
const fakeMic = path.join(__dirname, '.output', 'fake-mic.wav');
function writeFakeMic(): void {
  const rate = 16000;
  const n = rate * 5;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (t < 1.5) {
      const f0 = 120 + 100 * Math.sin(2 * Math.PI * 0.7 * t);
      const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      v *= 0.25 * syllable;
    }
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(fakeMic), { recursive: true });
  fs.writeFileSync(fakeMic, Buffer.concat([h, data]));
}
writeFakeMic();
const micArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic}`];

const port = Number(process.env.SEMAPHORE_E2E_PORT || 47681);
const trace = (process.env.SEMAPHORE_E2E_TRACE as 'off' | 'retain-on-failure' | 'on' | undefined) || 'off';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(__dirname, '.output', 'results'),
  fullyParallel: false,
  workers: 1, // one shared mock, reset before every test; the tests that stop a server start their own
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    trace,
    screenshot: trace === 'off' ? 'off' : 'only-on-failure',
  },
  projects: [{ name: 'browser', use: { browserName: 'chromium', launchOptions: { args: micArgs }, permissions: ['microphone'], ...(process.env.SEMAPHORE_E2E_BROWSER_CHANNEL ? { channel: process.env.SEMAPHORE_E2E_BROWSER_CHANNEL } : {}) } }],
  webServer: {
    command: `node "${path.join(__dirname, 'mock-server.mjs')}" --port ${port} --stay`,
    url: `http://127.0.0.1:${port}/__fleethacker/id`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: 'ignore',
  },
});

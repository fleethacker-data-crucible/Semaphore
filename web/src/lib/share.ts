// A page shared as one HTML file: every flag's answer as it stood, with working filters (clicking a
// bar or a picker filters the other flags from the pre-split results), readable anywhere with no
// server and no database. With a passphrase, the data is encrypted (AES-GCM, key from PBKDF2) and
// the file asks for it before showing anything. The reader is web/src/report.tsx.

import type { Catalog } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import type { FrozenFlag } from '../../../src/core/reports.ts';

/** Set by web/build.mjs to the hashed reader bundle. */
declare const __SEMAPHORE_REPORT__: string;

export interface ReportPayload {
  version: 1;
  title: string;
  brief: string;
  takenAt: string;
  by: string;
  cols: number;
  theme: 'light' | 'dark';
  skin: string;
  /** Labels and formats only: sources lose their vault item names. */
  catalog: Catalog;
  flags: FrozenFlag[];
}

export interface Sealed {
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

export const PBKDF2_ITERATIONS = 310_000;

function b64(bytes: Uint8Array): string {
  // In slices: spreading megabytes into one call would overflow the stack.
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(json: string, passphrase: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export function reportPayload(hoist: Hoist, flags: FrozenFlag[], catalog: Catalog, by: string, theme: 'light' | 'dark', skin: string): ReportPayload {
  return {
    version: 1,
    title: hoist.title || 'Semaphore report',
    brief: hoist.brief,
    takenAt: new Date().toISOString(),
    by,
    cols: hoist.grid.cols,
    theme,
    skin,
    catalog: { ...catalog, sources: catalog.sources.map(({ vaultItem: _v, ...s }) => s) },
    flags,
  };
}

/** JSON safe inside a <script> element: no "</script", no "<!--". */
function scriptJson(value: unknown): string {
  // Every '<' becomes its JSON escape (a backslash, then u003c), so the data cannot close the script.
  // Raw U+2028 and U+2029 are valid inside script strings since ES2019.
  return JSON.stringify(value).replace(/</g, String.fromCharCode(92) + 'u003c');
}

/** The whole file: styles, data (or the sealed data) and the reader, inline. */
export async function buildReportHtml(payload: ReportPayload, passphrase?: string): Promise<string> {
  const css = await (await fetch(document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!.href)).text();
  const reader = await (await fetch(__SEMAPHORE_REPORT__)).text();
  const json = JSON.stringify(payload);
  const data = passphrase ? { sealed: await seal(json, passphrase) } : { report: payload };
  const title = payload.title.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
  return `<!doctype html>
<html lang="en" data-theme="${payload.theme}" data-skin="${payload.skin.replace(/[^a-z0-9-]/gi, '')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">
<title>${title}</title>
<style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body class="bg-bg text-ink">
<div id="root"></div>
<script>window.__SEMAPHORE_DATA__ = ${scriptJson(data)};</script>
<script>${reader.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}

export function download(name: string, text: string, type = 'text/html'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Size report and budget for the built UI (#78). Run after the build: npm run size.
//
// "Initial" is what the browser must fetch and parse before the welcome page paints: the module
// entry index.html names plus every chunk it imports statically (import ... from), followed
// recursively. Chunks reached only through import() load later and count as "lazy". The worker
// and the shared-report reader never load at start.
//
// The budget lives in web/size-budget.json. It started at the initial JS size of the first ESM
// build plus 5 %; lower it when lazy loading takes code out of the start, never raise it quietly.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { stripHtmlComments } from './build-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, 'dist'));
const budget = JSON.parse(readFileSync(path.join(here, 'size-budget.json'), 'utf8'));

if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('size: web/dist/index.html is missing; run npm run build first.');
  process.exit(1);
}

const html = stripHtmlComments(readFileSync(path.join(dist, 'index.html'), 'utf8'));
const entry = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1] ?? /<script\b[^>]*src="([^"]+)"[^>]*type="module"/.exec(html)?.[1];
if (!entry) {
  console.error('size: index.html has no <script type="module" src>.');
  process.exit(1);
}
const css = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith('assets/'));

/** Static imports of one built module: import{..}from"./x.js", import"./x.js", export{..}from"./x.js". */
function staticImports(file) {
  const js = readFileSync(path.join(dist, file), 'utf8');
  const out = new Set();
  for (const m of js.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    // import("./x.js") is dynamic: skip it (the regex above needs import directly before the quote).
    out.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return [...out];
}

const initial = new Set();
const queue = [entry];
while (queue.length) {
  const f = queue.shift();
  if (initial.has(f)) continue;
  initial.add(f);
  queue.push(...staticImports(f));
}

const sizeOf = (f) => {
  const bytes = readFileSync(path.join(dist, f));
  return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
};
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const rows = [];
for (const name of readdirSync(path.join(dist, 'assets')).sort()) {
  const f = `assets/${name}`;
  if (!statSync(path.join(dist, f)).isFile()) continue;
  const kind = initial.has(f) ? 'initial' : css.includes(f) ? 'initial css' : /^report\./.test(name) ? 'report reader' : /^worker\./.test(name) ? 'worker' : name.endsWith('.js') ? 'lazy' : 'other';
  rows.push({ f, kind, ...sizeOf(f) });
}
const sum = (k, key) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r[key], 0);
const initialJs = sum('initial', 'raw');

console.log('Semaphore UI size (web/dist)');
for (const r of rows) console.log(`  ${r.kind.padEnd(13)} ${kb(r.raw).padStart(10)} ${kb(r.gzip).padStart(10)} gz  ${r.f}`);
console.log(`  initial JS ${kb(initialJs)} (${kb(sum('initial', 'gzip'))} gz) in ${initial.size} file(s); initial CSS ${kb(sum('initial css', 'raw'))}; lazy JS ${kb(sum('lazy', 'raw'))}`);
console.log(`  budget: initial JS at most ${kb(budget.initialJsBytes)}`);
if (initialJs > budget.initialJsBytes) {
  console.error(`size: the initial JS is ${kb(initialJs)}, over the ${kb(budget.initialJsBytes)} budget in web/size-budget.json. Load the new code with import() or make it smaller.`);
  process.exit(1);
}

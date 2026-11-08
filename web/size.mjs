// Size report and budget for the built UI (#78). Run after the build: npm run size.
//
//   node web/size.mjs [<dist>] [<budget.json>]
//
// "Initial" is what the browser must fetch and parse before the welcome page paints: the module
// entry index.html names plus every chunk it imports statically (import ... from), followed
// recursively. Chunks reached only through import() load later and count as "lazy". The worker
// and the shared-report reader never load at start.
//
// The budget lives in web/size-budget.json. It started at the initial JS size of the first ESM
// build plus 5 %; lower it when lazy loading takes code out of the start, never raise it quietly.
// The classification is exported so tests/size.test.ts can prove it on a small built fixture.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { stripHtmlComments } from './build-contract.mjs';

/** The module entry index.html loads, relative to dist, or null. */
export function moduleEntry(html) {
  const text = stripHtmlComments(html);
  for (const m of text.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    if (!/\stype\s*=\s*["']module["']/i.test(' ' + attrs)) continue;
    const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(' ' + attrs)?.[1];
    if (src) return src.replace(/^\.?\//, '');
  }
  return null;
}

/** The stylesheets index.html loads from assets/, relative to dist. */
export function styleSheets(html) {
  const text = stripHtmlComments(html);
  const out = [];
  for (const m of text.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = ' ' + (m[1] ?? '');
    if (!/\srel\s*=\s*["']stylesheet["']/i.test(attrs)) continue;
    const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href && href.replace(/^\.?\//, '').startsWith('assets/')) out.push(href.replace(/^\.?\//, ''));
  }
  return out;
}

/**
 * Static imports of one built module, relative to dist: import{..}from"./x.js", import"./x.js",
 * export{..}from"./x.js", export*from"./x.js". import("./x.js") is dynamic and skipped (the regex
 * needs `from` or `import` directly before the quote, and import( has a parenthesis there).
 */
export function staticImports(dist, file) {
  const js = readFileSync(path.join(dist, file), 'utf8');
  const out = new Set();
  for (const m of js.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    out.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return [...out];
}

/** Every file under dist/assets with its kind and sizes; `initial` is the set of files the start needs. */
export function classify(dist) {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const entry = moduleEntry(html);
  if (!entry) throw new Error('index.html has no <script type="module" src>.');
  const css = styleSheets(html);
  const initial = new Set();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (initial.has(f)) continue;
    initial.add(f);
    queue.push(...staticImports(dist, f));
  }
  const sizeOf = (f) => {
    const bytes = readFileSync(path.join(dist, f));
    return { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  };
  const rows = [];
  for (const name of readdirSync(path.join(dist, 'assets')).sort()) {
    const f = `assets/${name}`;
    if (!statSync(path.join(dist, f)).isFile()) continue;
    const kind = initial.has(f) ? 'initial' : css.includes(f) ? 'initial css' : /^report\./.test(name) ? 'report reader' : /^worker\./.test(name) ? 'worker' : name.endsWith('.js') ? 'lazy' : 'other';
    rows.push({ f, kind, ...sizeOf(f) });
  }
  return { entry, initial, rows };
}

/** The report lines and whether the initial JS is over the budget. */
export function report(dist, budget) {
  const { initial, rows } = classify(dist);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const sum = (k, key) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r[key], 0);
  const initialJs = sum('initial', 'raw');
  const lines = ['Semaphore UI size (web/dist)'];
  for (const r of rows) lines.push(`  ${r.kind.padEnd(13)} ${kb(r.raw).padStart(10)} ${kb(r.gzip).padStart(10)} gz  ${r.f}`);
  lines.push(`  initial JS ${kb(initialJs)} (${kb(sum('initial', 'gzip'))} gz) in ${initial.size} file(s); initial CSS ${kb(sum('initial css', 'raw'))}; lazy JS ${kb(sum('lazy', 'raw'))}`);
  lines.push(`  budget: initial JS at most ${kb(budget.initialJsBytes)}`);
  const over = initialJs > budget.initialJsBytes;
  const problem = over ? `size: the initial JS is ${kb(initialJs)}, over the ${kb(budget.initialJsBytes)} budget in web/size-budget.json. Load the new code with import() or make it smaller.` : null;
  return { lines, initialJs, over, problem };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const dist = path.resolve(process.argv[2] ?? path.join(here, 'dist'));
  const budgetFile = path.resolve(process.argv[3] ?? path.join(here, 'size-budget.json'));
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.error('size: web/dist/index.html is missing; run npm run build first.');
    process.exit(1);
  }
  const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
  if (!Number.isFinite(budget.initialJsBytes) || budget.initialJsBytes <= 0) {
    console.error(`size: ${budgetFile} has no positive initialJsBytes.`);
    process.exit(1);
  }
  let result;
  try {
    result = report(dist, budget);
  } catch (e) {
    console.error(`size: ${e.message}`);
    process.exit(1);
  }
  for (const line of result.lines) console.log(line);
  if (result.over) {
    console.error(result.problem);
    process.exit(1);
  }
}

// The built page's contract with the server's Content-Security-Policy (#90): web/dist/index.html
// carries no inline code at all, so script-src 'self' never needs 'unsafe-inline' or a nonce.
//
//   node web/build-contract.mjs            check web/dist (npm run build runs it after the build)
//   node web/build-contract.mjs <dist>     check another dist folder
//
// It fails on an inline <script> (one without src, or with a body), a <style> element, any on*=
// event-handler attribute, a javascript: URL, and an asset the page names that is not in dist.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The page without HTML comments, ended the way a browser ends them, repeated until none are left. */
export function stripHtmlComments(html) {
  let text = html;
  let before;
  do {
    before = text;
    text = text.replace(/<!--[\s\S]*?--!?>/g, '');
  } while (text !== before);
  return text;
}

/** Problems with one index.html, as plain sentences; [] when it keeps the contract. */
export function checkIndexHtml(html) {
  const problems = [];
  const text = stripHtmlComments(html);
  // Scripts are walked in order, each from its own open tag to its own end tag, the way a browser
  // reads them: a script that never ends is reported on its own, and does not borrow a later end tag.
  const openRe = /<script\b([^>]*)>/gi;
  let open;
  while ((open = openRe.exec(text)) !== null) {
    const attrs = open[1] ?? '';
    const bodyStart = open.index + open[0].length;
    const closeRe = /<\/script\b[^>]*>/gi;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(text);
    if (!close) {
      problems.push('an unclosed <script> tag');
      break;
    }
    const body = text.slice(bodyStart, close.index);
    if (!/\ssrc\s*=/i.test(' ' + attrs)) problems.push('an inline <script> without src');
    else if (body.trim() !== '') problems.push('a <script src> with inline code in its body');
    openRe.lastIndex = close.index + close[0].length;
  }
  if (/<style\b/i.test(text)) problems.push('an inline <style> element');
  for (const m of text.matchAll(/<[a-z][^>]*>/gi)) {
    const tag = m[0];
    const handler = /\s(on[a-z]+)\s*=/i.exec(tag);
    if (handler) problems.push(`an event-handler attribute ${handler[1]}= in ${tag.slice(0, 60)}`);
    if (/=\s*["']?\s*javascript:/i.test(tag)) problems.push(`a javascript: URL in ${tag.slice(0, 60)}`);
  }
  return problems;
}

/** Local files the page loads (script src, link href), relative to dist. */
export function referencedFiles(html) {
  const out = [];
  const text = stripHtmlComments(html);
  for (const m of text.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*"([^"]+)"/gi)) {
    const ref = m[1];
    if (/^[a-z]+:|^\/\//i.test(ref)) continue;
    out.push(ref.replace(/^\.?\//, ''));
  }
  return out;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'));
  const file = path.join(dist, 'index.html');
  if (!existsSync(file)) {
    console.error(`build contract: ${file} is missing; run the build first.`);
    process.exit(1);
  }
  const html = readFileSync(file, 'utf8');
  const problems = checkIndexHtml(html);
  for (const ref of referencedFiles(html)) if (!existsSync(path.join(dist, ref))) problems.push(`the page names ${ref}, which is not in dist`);
  if (problems.length) {
    console.error(`build contract: web/dist/index.html breaks the CSP contract (#90):\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('build contract: index.html has no inline script, style or event handlers');
}

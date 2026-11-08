import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// web/build-contract.mjs keeps web/dist/index.html free of inline code (#90), so the server's CSP
// never needs 'unsafe-inline' for scripts.
const here = path.dirname(fileURLToPath(import.meta.url));
const { checkIndexHtml, referencedFiles } = (await import(pathToFileURL(path.join(here, '..', 'web', 'build-contract.mjs')).href)) as {
  checkIndexHtml: (html: string) => string[];
  referencedFiles: (html: string) => string[];
};

const good = `<!doctype html><html><head><link rel="stylesheet" href="assets/app-abcdef1234.css" />
<link rel="modulepreload" href="assets/chunk-ABCDEFGH.js" /><!-- <script>not code</script> --></head>
<body><div id="root"></div><script type="module" src="assets/app-ABCDEFGH.js"></script></body></html>`;

test('the built page shape passes', () => {
  assert.deepEqual(checkIndexHtml(good), []);
  assert.deepEqual(referencedFiles(good), ['assets/app-abcdef1234.css', 'assets/chunk-ABCDEFGH.js', 'assets/app-ABCDEFGH.js']);
});

test('inline script, style, event handlers and javascript: URLs fail', () => {
  assert.equal(checkIndexHtml(good.replace('<div id="root">', '<script>alert(1)</script><div id="root">')).length, 1);
  assert.equal(checkIndexHtml(good.replace('></script>', '>alert(1)</script>')).length, 1);
  assert.equal(checkIndexHtml(good.replace('</head>', '<style>body{color:red}</style></head>')).length, 1);
  assert.equal(checkIndexHtml(good.replace('<div id="root">', '<div id="root" onclick="go()">')).length, 1);
  assert.equal(checkIndexHtml(good.replace('<body>', '<body onLoad = "go()">')).length, 1);
  assert.equal(checkIndexHtml(good.replace('<div id="root">', '<a href="javascript:go()">x</a><div id="root">')).length, 1);
});

test('scripts are walked in order: an unclosed first script is reported even when a later one is closed', () => {
  const add = (html: string) => good.replace('<div id="root">', `${html}<div id="root">`);
  // A browser runs an unclosed first script up to the NEXT </script>, swallowing the module tag in
  // between: that is reported as a body on a <script src>, and the swallowed tag is not judged twice.
  const unclosedFirst = checkIndexHtml(add('<script src="assets/a-ABCDEFGH.js">'));
  assert.deepEqual(unclosedFirst, ['a <script src> with inline code in its body']);
  // A script with no end tag after it is reported as unclosed, once.
  assert.deepEqual(checkIndexHtml(good.replace('</body>', '<script src="assets/b-ABCDEFGH.js"></body>')), ['an unclosed <script> tag']);
  // Two well-formed external scripts pass; each is judged on its own body.
  assert.deepEqual(checkIndexHtml(add('<script src="assets/a-ABCDEFGH.js"></script><script src="assets/b-ABCDEFGH.js"></script>')), []);
  assert.deepEqual(checkIndexHtml(add('<script src="assets/a-ABCDEFGH.js"></script><script src="assets/b-ABCDEFGH.js">x()</script>')), ['a <script src> with inline code in its body']);
});

test('a script the browser runs is not hidden by an odd end tag or a comment trick', () => {
  const add = (html: string) => good.replace('<div id="root">', `${html}<div id="root">`);
  assert.equal(checkIndexHtml(add('<script>alert(1)</script foo>')).length, 1);
  assert.equal(checkIndexHtml(add('<script>alert(1)</script\t\n bar>')).length, 1);
  assert.equal(checkIndexHtml(add('<!-- --!><script>alert(1)</script><!-- -->')).length, 1);
  assert.equal(checkIndexHtml(add('<!-<!-- x -->- --!><script>alert(1)</script>')).length, 1);
});

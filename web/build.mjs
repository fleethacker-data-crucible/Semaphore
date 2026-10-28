// Builds the Semaphore UI to static files with esbuild and Tailwind's compiler API, the same way
// Halyard does. The workstation only ever serves pre-built files from the local server, so the
// build is the whole story: two tools, no plugins, no dev server to secure.
//
//   node web/build.mjs            production build to web/dist/
//   node web/build.mjs --watch    rebuild on change

import { build } from 'esbuild';
import { compile } from 'tailwindcss';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const outDir = path.join(here, 'dist');
const publicDir = path.join(here, 'public');
const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

// Tailwind normally scans with a native module; here we extract class candidates ourselves.
// Any token that is not a utility is ignored by the compiler, so being generous is harmless.
async function extractCandidates(files) {
  const candidates = new Set();
  const tokenRe = /[^\s"'`<>{}=;]+/g;
  for (const file of files) {
    if (!/\.(tsx?|html|css)$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const match of text.match(tokenRe) ?? []) {
      if (match.length < 2 || match.length > 80) continue;
      candidates.add(match);
      // Tokens glued to JS punctuation (e.g. cn('a', or ('a') need trimming to become class names.
      const trimmed = match.replace(/^[(,]+|[),]+$/g, '');
      if (trimmed && trimmed !== match) candidates.add(trimmed);
    }
  }
  return [...candidates];
}

async function buildCss(files) {
  const entry = await readFile(path.join(srcDir, 'styles.css'), 'utf8');
  const twRoot = path.dirname(require.resolve('tailwindcss/package.json'));
  const compiled = await compile(entry, {
    base: srcDir,
    async loadStylesheet(id, base) {
      if (id === 'tailwindcss') return { base: twRoot, content: await readFile(path.join(twRoot, 'index.css'), 'utf8') };
      if (id.startsWith('tailwindcss/')) {
        const file = path.join(twRoot, id.slice('tailwindcss/'.length));
        return { base: twRoot, content: await readFile(file, 'utf8') };
      }
      const file = path.resolve(base, id);
      return { base: path.dirname(file), content: await readFile(file, 'utf8') };
    },
    async loadModule() {
      throw new Error('JavaScript plugins are not used in this build.');
    },
  });
  return compiled.build(await extractCandidates(files));
}

async function run() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  const files = await listFiles(srcDir);

  // The CSV worker is its own bundle (same-origin, so the page's CSP allows it); the app learns its
  // hashed name through a define.
  const workerOut = await build({
    entryPoints: [path.join(srcDir, 'worker.ts')],
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: ['es2020', 'edge120', 'chrome120'],
    write: false,
    outfile: 'worker.js',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const workerJs = workerOut.outputFiles[0].text;
  const workerName = `worker.${createHash('sha256').update(workerJs).digest('hex').slice(0, 10)}.js`;
  await writeFile(path.join(outDir, 'assets', workerName), workerJs);

  // The reader inside a shared HTML report (web/src/lib/share.ts inlines it into the file).
  const readerOut = await build({
    entryPoints: [path.join(srcDir, 'report.tsx')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020', 'edge120', 'chrome120'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    write: false,
    outfile: 'report.js',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const readerJs = readerOut.outputFiles[0].text;
  const readerName = `report.${createHash('sha256').update(readerJs).digest('hex').slice(0, 10)}.js`;
  await writeFile(path.join(outDir, 'assets', readerName), readerJs);

  const result = await build({
    entryPoints: [path.join(srcDir, 'main.tsx')],
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: ['es2020', 'edge120', 'chrome120'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'), __SEMAPHORE_WORKER__: JSON.stringify(`assets/${workerName}`), __SEMAPHORE_REPORT__: JSON.stringify(`assets/${readerName}`) },
    write: false,
    outfile: 'app.js',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const js = result.outputFiles[0].text;
  const css = await buildCss(files);
  const hash = createHash('sha256').update(js).update(css).digest('hex').slice(0, 10);
  await writeFile(path.join(outDir, 'assets', `app.${hash}.js`), js);
  await writeFile(path.join(outDir, 'assets', `app.${hash}.css`), css);
  const html = (await readFile(path.join(here, 'index.html'), 'utf8'))
    .replace('%APP_JS%', `assets/app.${hash}.js`)
    .replace('%APP_CSS%', `assets/app.${hash}.css`);
  await writeFile(path.join(outDir, 'index.html'), html);
  // Static files (favicon, emblem art) are copied as they are, at the same relative paths.
  await cp(publicDir, outDir, { recursive: true });
  await writeFile(path.join(outDir, 'build.json'), JSON.stringify({ hash, builtAt: new Date().toISOString(), watch }, null, 2));
  const size = (await stat(path.join(outDir, 'assets', `app.${hash}.js`))).size;
  console.log(`built dist/ (app.${hash}.js ${(size / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
}

await run();

if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((e) => console.error(e.message)), 150);
  };
  fsWatch(srcDir, { recursive: true }, schedule);
  fsWatch(path.join(here, '..', 'src'), { recursive: true }, schedule);
  fsWatch(path.join(here, 'index.html'), schedule);
  console.log('watching web/src and src for changes…');
}

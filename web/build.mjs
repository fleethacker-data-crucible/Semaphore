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

  // The predict worker (predictive models) is its own bundle too, started the first time a model
  // flag is drawn (web/src/lib/predict.ts), so a page without models never loads it.
  const predictOut = await build({
    entryPoints: [path.join(srcDir, 'predict-worker.ts')],
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: ['es2020', 'edge120', 'chrome120'],
    write: false,
    outfile: 'predict.js',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const predictJs = predictOut.outputFiles[0].text;
  const predictName = `predict.${createHash('sha256').update(predictJs).digest('hex').slice(0, 10)}.js`;
  await writeFile(path.join(outDir, 'assets', predictName), predictJs);

  // A custom widget's frame: dist/sandbox/widget.html and its own bundle (the bridge and the full
  // ECharts build). The server sends /sandbox/ with the sandbox CSP (server/Http.ps1), and the page
  // only ever loads it inside <iframe sandbox="allow-scripts">, so it never joins the page's start.
  const widgetOut = await build({
    entryPoints: [path.join(srcDir, 'widget-host.ts')],
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    format: 'iife',
    target: ['es2020', 'edge120', 'chrome120'],
    write: false,
    outfile: 'widget-host.js',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const widgetJs = widgetOut.outputFiles[0].text;
  const widgetName = `widget-host.${createHash('sha256').update(widgetJs).digest('hex').slice(0, 10)}.js`;
  await mkdir(path.join(outDir, 'sandbox'), { recursive: true });
  await writeFile(path.join(outDir, 'sandbox', widgetName), widgetJs);
  const sandboxHtml = (await readFile(path.join(here, 'sandbox', 'widget.html'), 'utf8')).replace('%WIDGET_JS%', widgetName);
  await writeFile(path.join(outDir, 'sandbox', 'widget.html'), sandboxHtml);

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

  // The app is an ES module entry with code splitting: a dynamic import() becomes its own chunk,
  // loaded on first use. Every output is named assets/<name>-<HASH>.js (contract: the server caches
  // hashed assets as immutable). Same origin, so script-src 'self' covers the chunks.
  const result = await build(appBuildOptions({ outdir: path.join(outDir, 'assets'), dev: watch, define: { __SEMAPHORE_WORKER__: JSON.stringify(`assets/${workerName}`), __SEMAPHORE_PREDICT__: JSON.stringify(`assets/${predictName}`), __SEMAPHORE_REPORT__: JSON.stringify(`assets/${readerName}`) } }));
  const css = await buildCss(files);
  const cssHash = createHash('sha256').update(css).digest('hex').slice(0, 10);
  const cssName = `app-${cssHash}.css`;
  await writeFile(path.join(outDir, 'assets', cssName), css);

  const outputs = result.metafile.outputs;
  const rel = (abs) => path.relative(outDir, abs).split(path.sep).join('/');
  // Dynamic import() targets are entry points too in the metafile: pick the output built from main.tsx.
  const entryKey = Object.keys(outputs).find((k) => k.endsWith('.js') && /(^|[\\/])main\.tsx$/.test(outputs[k].entryPoint ?? ''));
  if (!entryKey) throw new Error('esbuild produced no app entry.');
  const entry = rel(path.resolve(entryKey));
  // Chunks the entry imports statically load before it runs anyway: preload them in parallel.
  const preload = [];
  const seen = new Set();
  const walk = (key) => {
    for (const imp of outputs[key].imports) {
      if (imp.kind !== 'import-statement' || seen.has(imp.path)) continue;
      seen.add(imp.path);
      preload.push(rel(path.resolve(imp.path)));
      walk(imp.path);
    }
  };
  walk(entryKey);
  const chunks = Object.keys(outputs).filter((k) => k.endsWith('.js') && k !== entryKey).map((k) => rel(path.resolve(k)));

  const html = (await readFile(path.join(here, 'index.html'), 'utf8'))
    .replace('%APP_JS%', entry)
    .replace('%APP_CSS%', `assets/${cssName}`)
    .replace(/^[ \t]*%PRELOAD%\r?\n/m, preload.map((p) => `    <link rel="modulepreload" href="${p}" />\n`).join(''));
  await writeFile(path.join(outDir, 'index.html'), html);
  // Static files (favicon, emblem art) are copied as they are, at the same relative paths.
  await cp(publicDir, outDir, { recursive: true });
  const hash = createHash('sha256').update(entry).update(cssName).update(chunks.join(',')).update(workerName).update(predictName).update(readerName).update(widgetName).digest('hex').slice(0, 10);
  const manifest = { hash, builtAt: new Date().toISOString(), watch, entry, css: `assets/${cssName}`, preload, chunks, worker: `assets/${workerName}`, predict: `assets/${predictName}`, report: `assets/${readerName}`, widget: `sandbox/${widgetName}` };
  await writeFile(path.join(outDir, 'build.json'), JSON.stringify(manifest, null, 2));
  const size = (await stat(path.join(outDir, entry))).size;
  console.log(`built dist/ (${entry} ${(size / 1024).toFixed(0)} KB, ${chunks.length} chunk(s), css ${(css.length / 1024).toFixed(0)} KB)`);
}

/** esbuild options for the app entry; exported so tests can prove a dynamic import() splits. */
export function appBuildOptions({ outdir, dev = false, define = {}, entryPoints = { app: path.join(srcDir, 'main.tsx') } }) {
  return {
    entryPoints,
    bundle: true,
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    format: 'esm',
    splitting: true,
    target: ['es2020', 'edge120', 'chrome120'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), ...define },
    outdir,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    metafile: true,
    write: true,
    legalComments: 'none',
    logLevel: 'warning',
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await run();

if (invoked && watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => run().catch((e) => console.error(e.message)), 150);
  };
  fsWatch(srcDir, { recursive: true }, schedule);
  fsWatch(path.join(here, '..', 'src'), { recursive: true }, schedule);
  fsWatch(path.join(here, 'index.html'), schedule);
  fsWatch(path.join(here, 'sandbox'), schedule);
  console.log('watching web/src and src for changes…');
}

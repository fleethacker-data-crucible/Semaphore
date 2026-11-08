import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// web/size.mjs decides what counts as "initial" JS (the module entry and its static imports) and
// fails the build when that is over web/size-budget.json. Both are proved here on a small app built
// with the real app options (#78), so a change in esbuild's output shape cannot silently turn every
// chunk into "lazy" and switch the budget off.
const here = path.dirname(fileURLToPath(import.meta.url));
const sizeModule = path.join(here, '..', 'web', 'size.mjs');
const { classify, report, moduleEntry, styleSheets } = (await import(pathToFileURL(sizeModule).href)) as {
  classify: (dist: string) => { entry: string; initial: Set<string>; rows: Array<{ f: string; kind: string; raw: number; gzip: number }> };
  report: (dist: string, budget: { initialJsBytes: number }) => { lines: string[]; initialJs: number; over: boolean; problem: string | null };
  moduleEntry: (html: string) => string | null;
  styleSheets: (html: string) => string[];
};
const { appBuildOptions } = (await import(pathToFileURL(path.join(here, '..', 'web', 'build.mjs')).href)) as { appBuildOptions: (o: { outdir: string; entryPoints?: Record<string, string> }) => Record<string, unknown> };

/** A dist with an entry that imports `shared` statically and `lazy` through import(), a worker and a report reader. */
async function buildFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sem-size-'));
  const src = path.join(dir, 'src');
  await mkdir(src);
  await writeFile(path.join(src, 'shared.ts'), 'export const shared = (n: number) => n * 2;\n');
  await writeFile(path.join(src, 'lazy.ts'), "import { shared } from './shared.ts';\nexport const panel = () => 'lazy panel ' + shared(21);\n");
  await writeFile(path.join(src, 'eager.ts'), "export const eager = 'eager text that is in the initial set';\n");
  await writeFile(path.join(src, 'main.ts'), "import { shared } from './shared.ts';\nimport { eager } from './eager.ts';\nexport async function open() { const m = await import('./lazy.ts'); return m.panel() + shared(1) + eager; }\n(globalThis as any).open = open;\n");
  const dist = path.join(dir, 'dist');
  const assets = path.join(dist, 'assets');
  const { build } = await import('esbuild');
  // Two entries: a second static entry makes esbuild put the shared code in its own chunk.
  const result = await build(appBuildOptions({ outdir: assets, entryPoints: { app: path.join(src, 'main.ts'), other: path.join(src, 'eager.ts') } }) as Parameters<typeof build>[0]);
  assert.equal(result.errors.length, 0);
  const files = (await readdir(assets)).filter((f) => f.endsWith('.js'));
  const entry = files.find((f) => f.startsWith('app-'))!;
  await writeFile(path.join(assets, 'app-deadbeef00.css'), 'body{margin:0}\n');
  await writeFile(path.join(assets, 'worker.0123456789.js'), 'self.onmessage = () => {};\n');
  await writeFile(path.join(assets, 'report.0123456789.js'), 'console.log("reader");\n');
  await writeFile(
    path.join(dist, 'index.html'),
    `<!doctype html><html><head><link rel="stylesheet" href="assets/app-deadbeef00.css" /><!-- <script type="module" src="assets/not-this.js"></script> --></head><body><div id="root"></div><script type="module" src="assets/${entry}"></script></body></html>`,
  );
  return { dir, dist, entry, files };
}

test('index.html readers: the module entry (not one in a comment) and the asset stylesheets', () => {
  const html = `<link rel="stylesheet" href="assets/app-1.css"><link href="skin.css" rel="stylesheet"><!-- <script type="module" src="assets/x.js"></script> --><script src="assets/plain.js"></script><script src="./assets/app-2.js" type="module"></script>`;
  assert.equal(moduleEntry(html), 'assets/app-2.js');
  assert.deepEqual(styleSheets(html), ['assets/app-1.css']);
  assert.equal(moduleEntry('<script src="assets/plain.js"></script>'), null);
});

test('the entry and its static imports are initial; an import() chunk is lazy; worker, reader and css are their own kinds', async () => {
  const { dir, dist, entry } = await buildFixture();
  try {
    const { initial, rows } = classify(dist);
    const kind = (re: RegExp) => rows.find((r) => re.test(r.f))?.kind;
    assert.ok(initial.has(`assets/${entry}`), 'the entry is initial');
    assert.equal(kind(new RegExp(entry.replace('.', '\\.'))), 'initial');
    assert.equal(kind(/^assets\/lazy-/), 'lazy', `rows: ${rows.map((r) => `${r.f}=${r.kind}`).join(', ')}`);
    assert.equal(kind(/^assets\/other-/), 'lazy', 'another entry the page does not name is not initial');
    assert.equal(kind(/^assets\/app-deadbeef00\.css$/), 'initial css');
    assert.equal(kind(/^assets\/worker\./), 'worker');
    assert.equal(kind(/^assets\/report\./), 'report reader');
    // The shared code sits in a chunk the entry imports statically: it must be counted as initial.
    const initialChunks = rows.filter((r) => r.kind === 'initial');
    assert.ok(initialChunks.length >= 2, `the entry plus at least one static chunk are initial, got ${initialChunks.map((r) => r.f).join(', ')}`);
    for (const r of rows) assert.ok(r.raw > 0 && r.gzip > 0, `${r.f} has sizes`);

    const fit = report(dist, { initialJsBytes: 10_000_000 });
    assert.equal(fit.over, false);
    assert.equal(fit.problem, null);
    assert.ok(fit.lines.some((l) => /initial JS .* in \d+ file\(s\)/.test(l)));
    const tight = report(dist, { initialJsBytes: 1 });
    assert.equal(tight.over, true);
    assert.match(tight.problem ?? '', /over the 0\.0 KB budget/);
    assert.equal(tight.initialJs, fit.initialJs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command exits 1 over budget (and 0 under it) so npm run size can gate the build', async () => {
  const { dir, dist } = await buildFixture();
  try {
    const tight = path.join(dir, 'tight.json');
    const roomy = path.join(dir, 'roomy.json');
    await writeFile(tight, JSON.stringify({ initialJsBytes: 1 }));
    await writeFile(roomy, JSON.stringify({ initialJsBytes: 10_000_000 }));
    const over = spawnSync(process.execPath, [sizeModule, dist, tight], { encoding: 'utf8' });
    assert.equal(over.status, 1, over.stdout + over.stderr);
    assert.match(over.stderr, /over the .* budget/);
    const under = spawnSync(process.execPath, [sizeModule, dist, roomy], { encoding: 'utf8' });
    assert.equal(under.status, 0, under.stdout + under.stderr);
    assert.match(under.stdout, /budget: initial JS at most/);
    const missing = spawnSync(process.execPath, [sizeModule, path.join(dir, 'nowhere'), roomy], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

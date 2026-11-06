import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// web/build.mjs builds the app as an ES module with splitting on (#78): a dynamic import() must
// come out as its own hashed chunk that the entry loads on demand, and nothing else may change.
const here = path.dirname(fileURLToPath(import.meta.url));
const buildModule = pathToFileURL(path.join(here, '..', 'web', 'build.mjs')).href;

test('a dynamic import() in the app becomes its own hashed chunk', async () => {
  const { appBuildOptions } = (await import(buildModule)) as { appBuildOptions: (o: { outdir: string; entryPoints?: Record<string, string> }) => Record<string, unknown> };
  const { build } = await import('esbuild');
  const dir = await mkdtemp(path.join(tmpdir(), 'sem-split-'));
  try {
    await writeFile(path.join(dir, 'shared.ts'), 'export const shared = (n: number) => n * 2;\n');
    await writeFile(path.join(dir, 'lazy.ts'), "import { shared } from './shared.ts';\nexport const panel = () => 'lazy panel ' + shared(21);\n");
    await writeFile(path.join(dir, 'main.ts'), "import { shared } from './shared.ts';\nexport async function open() { const m = await import('./lazy.ts'); return m.panel() + shared(1); }\n(globalThis as any).open = open;\n");
    const out = path.join(dir, 'out');
    const result = await build(appBuildOptions({ outdir: out, entryPoints: { app: path.join(dir, 'main.ts') } }) as Parameters<typeof build>[0]);
    assert.equal(result.errors.length, 0);
    const files = (await readdir(out)).filter((f) => f.endsWith('.js')).sort();
    // Contract 4: every output is <name>-<HASH>.js with a hash segment of 8+ letters or digits.
    for (const f of files) assert.match(f, /^[a-z]+-[A-Za-z0-9]{8,}\.js$/, f);
    const entry = files.find((f) => f.startsWith('app-'));
    assert.ok(entry, 'an app-<hash>.js entry');
    const lazy = files.find((f) => f.startsWith('lazy-'));
    assert.ok(lazy, `a lazy-<hash>.js chunk in ${files.join(', ')}`);
    const entryJs = await readFile(path.join(out, entry), 'utf8');
    assert.ok(entryJs.includes(`import("./${lazy}")`), 'the entry loads the chunk with import()');
    assert.ok(!entryJs.includes('lazy panel'), 'the lazy code is not in the entry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

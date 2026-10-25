import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Catalog, indexCatalog } from '../src/core/catalog.ts';
import { type Hoist, parseHoist } from '../src/core/hoist.ts';

const root = fileURLToPath(new URL('../examples/fleet-maintenance/', import.meta.url));

export function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(root + 'catalog.json', 'utf8')) as Catalog;
}

export function loadIndex() {
  return indexCatalog(loadCatalog());
}

export function loadHoist(): Hoist {
  const raw = JSON.parse(readFileSync(root + 'hoist.json', 'utf8'));
  const { hoist, warnings } = parseHoist(raw, loadIndex());
  if (!hoist || warnings.length) throw new Error(`Example hoist is invalid: ${warnings.join(' ')}`);
  return hoist;
}

export function flag(hoist: Hoist, id: string) {
  const f = hoist.flags.find((x) => x.id === id);
  if (!f) throw new Error(`No flag ${id}`);
  return f;
}

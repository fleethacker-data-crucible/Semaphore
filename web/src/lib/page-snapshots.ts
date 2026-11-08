// Page snapshots: a saved copy of the open hoist (its JSON as it stands, and the catalog version it
// was built on) in the Semaphore folder, to look at again or restore. The server keeps them under
// snapshots\<hoist id> (server/Routes.ps1, /api/page-snapshots): every named one, and the last 30
// automatic ones, taken before a risky change at most once every 10 minutes per page and always
// before a restore, so a restore can itself be undone. Loaded with the Snapshots dialog or the first
// risky change.

import type { Catalog } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { api } from './api.ts';

export type SnapshotKind = 'named' | 'auto' | 'restore';

export interface SnapshotMeta {
  version: 1;
  id: string;
  hoistId: string;
  kind: SnapshotKind;
  name: string;
  note: string;
  /** For automatic ones: what was about to happen ("Tidy up"). */
  reason: string;
  author: string;
  created: string;
  catalogVersion: string;
  title: string;
  flags: number;
  bytes: number;
}

/** Minutes between automatic snapshots of one page (the server holds the same rule). */
export const AUTO_GAP_MS = 10 * 60 * 1000;
export const NAME_CHARS = 80;
export const NOTE_CHARS = 500;

const base = (hoistId: string) => `/api/page-snapshots/${encodeURIComponent(hoistId)}`;

/**
 * A short fingerprint of the catalog (FNV-1a over its JSON, 8 hex digits): enough to tell that the
 * catalog changed since a snapshot was taken, never a way back to its contents.
 */
export function catalogVersion(catalog: Catalog): string {
  const text = JSON.stringify(catalog);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function listSnapshots(hoistId: string): Promise<SnapshotMeta[]> {
  const list = await api<SnapshotMeta[]>(base(hoistId));
  return Array.isArray(list) ? list : [];
}

export async function readSnapshot(hoistId: string, id: string): Promise<{ snapshot: SnapshotMeta; hoist: unknown }> {
  return api<{ snapshot: SnapshotMeta; hoist: unknown }>(`/api/page-snapshots/${encodeURIComponent(hoistId)}/${encodeURIComponent(id)}`);
}

export const deleteSnapshot = (hoistId: string, id: string) => api<{ ok: boolean }>(`/api/page-snapshots/${encodeURIComponent(hoistId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });

export async function saveSnapshot(hoist: Hoist, catalog: Catalog, what: { kind: SnapshotKind; name?: string; note?: string; reason?: string }): Promise<{ ok: boolean; skipped?: string; snapshot?: SnapshotMeta }> {
  return api(base(hoist.id), {
    json: {
      kind: what.kind,
      ...(what.name ? { name: what.name.slice(0, NAME_CHARS) } : {}),
      ...(what.note ? { note: what.note.slice(0, NOTE_CHARS) } : {}),
      ...(what.reason ? { reason: what.reason } : {}),
      catalogVersion: catalogVersion(catalog),
      hoist: JSON.stringify(hoist),
    },
  });
}

// When this tab last took an automatic snapshot of each page, so a run of risky changes does not
// ask the server every time (the server decides in the end).
const lastAuto = new Map<string, number>();

/**
 * An automatic snapshot before a risky change ("Tidy up", "Redraft whole page", a layout mode, a
 * kit). Quiet: a page with no flags, a recent one, or a server that cannot be reached is no reason
 * to stop the change.
 */
export async function autoSnapshot(hoist: Hoist, catalog: Catalog, reason: string, now = Date.now()): Promise<void> {
  if (!hoist.flags.length) return;
  const last = lastAuto.get(hoist.id);
  if (last !== undefined && now - last < AUTO_GAP_MS) return;
  lastAuto.set(hoist.id, now);
  try {
    await saveSnapshot(hoist, catalog, { kind: 'auto', reason });
  } catch {
    lastAuto.delete(hoist.id);
  }
}

/** What restoring a snapshot would change on the page, in a few words each. */
export function compareHoists(now: Hoist, then: Hoist): { added: string[]; removed: string[]; changed: string[] } {
  const name = (f: Hoist['flags'][number]) => f.title || f.brief || `Untitled ${f.kind}`;
  const nowById = new Map(now.flags.map((f) => [f.id, f]));
  const thenById = new Map(then.flags.map((f) => [f.id, f]));
  const strip = (f: Hoist['flags'][number]) => JSON.stringify({ ...f, notes: undefined, confidence: undefined });
  return {
    // Restoring brings back what the snapshot has and the page lacks, and takes away what it adds.
    added: then.flags.filter((f) => !nowById.has(f.id)).map(name),
    removed: now.flags.filter((f) => !thenById.has(f.id)).map(name),
    changed: then.flags.filter((f) => nowById.has(f.id) && strip(nowById.get(f.id)!) !== strip(f)).map(name),
  };
}

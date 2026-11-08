// Hoist > Snapshots…: save a named copy of this page with a note, see the saved ones (named and
// automatic) with when and by whom, look at one without changing anything, restore it, or delete it.
// Restoring first saves the page as it is now, so a restore can be undone like any other step.
// A modal (useModal); loaded when first opened (LazyPanels.tsx).

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Eye, History, RotateCcw, Save, Trash2, X } from 'lucide-react';
import type { Catalog, CatalogIndex } from '../../../src/core/catalog.ts';
import { type Hoist, parseHoist } from '../../../src/core/hoist.ts';
import { describeError } from '../lib/api.ts';
import { confirm } from '../lib/confirm.ts';
import { useModal } from '../lib/modal.ts';
import { catalogVersion, compareHoists, deleteSnapshot, listSnapshots, NAME_CHARS, NOTE_CHARS, readSnapshot, saveSnapshot, type SnapshotMeta } from '../lib/page-snapshots.ts';
import { notify } from '../lib/toasts.ts';
import { KIND_META } from './Palette.tsx';

export interface SnapshotsDialogProps {
  hoist: Hoist;
  catalog: Catalog;
  index: CatalogIndex;
  /** Put a snapshot's page in place of this one (one undo step). */
  onRestore: (hoist: Hoist) => void;
  onClose: () => void;
}

const field = 'w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm focus:border-accent focus:outline-none';
const small = 'inline-flex min-h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent disabled:opacity-40';

function label(s: SnapshotMeta): string {
  if (s.kind === 'named') return s.name;
  if (s.kind === 'restore') return s.reason || 'Before a restore';
  return s.reason ? `Before ${s.reason.charAt(0).toLowerCase()}${s.reason.slice(1)}` : 'Automatic';
}

export function SnapshotsDialog({ hoist, catalog, index, onRestore, onClose }: SnapshotsDialogProps) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const [list, setList] = useState<SnapshotMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ meta: SnapshotMeta; hoist: Hoist; warnings: string[] } | null>(null);
  const version = useMemo(() => catalogVersion(catalog), [catalog]);

  const refresh = () =>
    listSnapshots(hoist.id).then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e: unknown) => setError(describeError(e)),
    );
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoist.id]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const r = await saveSnapshot(hoist, catalog, { kind: 'named', name: name.trim(), note: note.trim() });
      setName('');
      setNote('');
      notify(`Saved the snapshot “${r.snapshot?.name ?? name.trim()}”.`, { tone: 'success' });
      await refresh();
    });

  const load = async (meta: SnapshotMeta) => {
    const got = await readSnapshot(hoist.id, meta.id);
    const parsed = parseHoist(got.hoist, index);
    if (!parsed.hoist) throw new Error(`This snapshot could not be read: ${parsed.warnings[0] ?? 'it is not a hoist.'}`);
    return { meta, hoist: { ...parsed.hoist, id: hoist.id }, warnings: parsed.warnings };
  };

  const restore = (meta: SnapshotMeta) =>
    run(async () => {
      const then = preview?.meta.id === meta.id ? preview : await load(meta);
      // The page as it is now goes first, always (not held back by the 10-minute rule).
      await saveSnapshot(hoist, catalog, { kind: 'restore', reason: `Before restoring “${label(meta)}”` });
      onRestore({ ...then.hoist, updated: new Date().toISOString() });
      notify(`Restored “${label(meta)}”. The page as it was is kept as a snapshot, and Undo brings it back too.`, { tone: 'success' });
      onClose();
    });

  const remove = (meta: SnapshotMeta) =>
    run(async () => {
      const ok = await confirm({ title: `Delete the snapshot “${label(meta)}”?`, body: 'It is moved to the .trash folder in the Semaphore folder, not erased.', confirmLabel: 'Delete', destructive: true });
      if (!ok) return;
      await deleteSnapshot(hoist.id, meta.id);
      if (preview?.meta.id === meta.id) setPreview(null);
      await refresh();
    });

  const diff = preview ? compareHoists(hoist, preview.hoist) : null;
  const cols = preview?.hoist.grid.cols ?? 12;
  const rows = preview ? Math.max(1, ...preview.hoist.flags.map((f) => f.layout.y + f.layout.h)) : 1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-16" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="snapshots-title" tabIndex={-1} className="fl-dialog flex max-h-[calc(100vh-6rem)] w-[620px] max-w-[calc(100%-2rem)] flex-col rounded-[14px] border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <History size={16} aria-hidden="true" className="text-brass" />
          <h2 id="snapshots-title" className="flex-1 text-base font-semibold">
            Snapshots
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>

        {error && (
          <p role="alert" className="mx-4 mt-3 rounded-md bg-bad-soft px-3 py-2 text-xs text-bad">
            {error}
          </p>
        )}

        {preview ? (
          <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="snapshot-preview">
            <button type="button" onClick={() => setPreview(null)} className={small}>
              <ArrowLeft size={13} aria-hidden="true" /> All snapshots
            </button>
            <div>
              <h3 className="text-sm font-semibold">{label(preview.meta)}</h3>
              <p className="text-[11px] text-ink-3">
                {new Date(preview.meta.created).toLocaleString()} · {preview.meta.author || 'someone'} · “{preview.hoist.title || 'Untitled hoist'}”, {preview.hoist.flags.length} flag{preview.hoist.flags.length === 1 ? '' : 's'}
              </p>
              {preview.meta.note && <p className="mt-1 text-xs text-ink-2">{preview.meta.note}</p>}
            </div>
            {preview.meta.catalogVersion && preview.meta.catalogVersion !== version && (
              <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-ink" data-testid="snapshot-catalog-note">
                The catalog has changed since this snapshot was taken, so some of its flags may need their measures or fields again.
              </p>
            )}
            {preview.warnings.length > 0 && <p className="text-xs text-warn">{preview.warnings.slice(0, 3).join(' ')}</p>}
            {/* The layout, drawn small: read only. */}
            <div role="img" aria-label={`Layout of the snapshot: ${preview.hoist.flags.map((f) => `${KIND_META[f.kind].label} ${f.title || ''}`.trim()).join(', ') || 'no flags'}`} className="relative w-full rounded-md border border-line bg-panel-2" style={{ aspectRatio: `${cols} / ${Math.min(rows, 40) * 0.6}` }}>
              {preview.hoist.flags.map((f) => (
                <div
                  key={f.id}
                  className="absolute overflow-hidden rounded border border-line bg-panel px-1 py-0.5 text-[10px] leading-tight text-ink-2"
                  style={{ left: `${(f.layout.x / cols) * 100}%`, top: `${(f.layout.y / Math.min(rows, 40)) * 100}%`, width: `calc(${(f.layout.w / cols) * 100}% - 2px)`, height: `calc(${(f.layout.h / Math.min(rows, 40)) * 100}% - 2px)` }}
                >
                  <span className="font-medium text-ink">{KIND_META[f.kind].label}</span> {f.title}
                </div>
              ))}
            </div>
            {diff && (
              <ul className="space-y-0.5 text-xs text-ink-2" data-testid="snapshot-diff">
                {diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && <li>Its flags are the same as the page now (the title, brief, filters or look may differ).</li>}
                {diff.added.length > 0 && <li>Restoring brings back: {diff.added.join(', ')}</li>}
                {diff.removed.length > 0 && <li>Restoring takes away: {diff.removed.join(', ')}</li>}
                {diff.changed.length > 0 && <li>Restoring changes: {diff.changed.join(', ')}</li>}
              </ul>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void restore(preview.meta)} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-semibold text-panel hover:opacity-90 disabled:opacity-40">
                <RotateCcw size={13} aria-hidden="true" /> Restore this snapshot
              </button>
            </div>
          </div>
        ) : (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <form
              className="space-y-2 border-b border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void save();
              }}
            >
              <label className="block text-xs font-medium text-ink-2">
                Name
                <input value={name} maxLength={NAME_CHARS} onChange={(e) => setName(e.target.value)} placeholder="Before the quarterly review" className={`${field} mt-1 min-h-8`} />
              </label>
              <label className="block text-xs font-medium text-ink-2">
                Note <span className="font-normal text-ink-3">(optional)</span>
                <textarea value={note} maxLength={NOTE_CHARS} rows={2} onChange={(e) => setNote(e.target.value)} className={`${field} mt-1 py-1`} />
              </label>
              <button type="submit" disabled={busy || !name.trim()} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-semibold text-panel hover:opacity-90 disabled:opacity-40">
                <Save size={13} aria-hidden="true" /> Save snapshot
              </button>
              <p className="text-[11px] text-ink-3">Semaphore also saves one before Redraft whole page, Tidy up, a layout change and a kit, at most every 10 minutes, and keeps the last 30 of those.</p>
            </form>
            <ul className="space-y-1 p-2" aria-label="Saved snapshots">
              {list === null && !error && <li className="px-3 py-4 text-center text-xs text-ink-3">Reading the snapshots…</li>}
              {list?.length === 0 && <li className="fl-empty px-3 py-6 text-center text-sm text-ink-3">No snapshots of this page yet.</li>}
              {list?.map((s) => (
                <li key={s.id} className="flex items-start gap-2 rounded-md px-2.5 py-1.5 hover:bg-panel-2" data-testid="snapshot-item" data-kind={s.kind}>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {label(s)}
                      {s.kind !== 'named' && <span className="ml-1.5 rounded bg-panel-2 px-1 text-[10px] font-normal text-ink-3">automatic</span>}
                    </span>
                    <span className="block text-[11px] text-ink-3">
                      {new Date(s.created).toLocaleString()} · {s.author || 'someone'} · {s.flags} flag{s.flags === 1 ? '' : 's'}
                    </span>
                    {s.note && <span className="block text-xs text-ink-2">{s.note}</span>}
                  </div>
                  <button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await load(s)))} className={small} aria-label={`Preview ${label(s)}`}>
                    <Eye size={13} aria-hidden="true" /> Preview
                  </button>
                  <button type="button" disabled={busy} onClick={() => void restore(s)} className={small} aria-label={`Restore ${label(s)}`}>
                    <RotateCcw size={13} aria-hidden="true" /> Restore
                  </button>
                  <button type="button" disabled={busy} onClick={() => void remove(s)} className={`${small} text-bad`} aria-label={`Delete ${label(s)}`}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

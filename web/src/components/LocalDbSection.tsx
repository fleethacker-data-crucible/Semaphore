// "Add to local database": big files (CSV, TSV, Excel, SQLite, Parquet, Arrow; also gzipped) go to
// Semaphore's local database on this computer and are queried there with SQL, so 10 million rows
// never pass through the page. Files are picked or dropped (uploaded as they are), or read in place
// from a path or a network share the administrator allowed. Loaded tables are profiled into the
// catalog like any server source (id 'local'). Part of the Data panel's chunk, loaded on demand.

import { useCallback, useEffect, useRef, useState } from 'react';
import { HardDrive, Pencil, Square, Trash2, Upload } from 'lucide-react';
import { describeError } from '../lib/api.ts';
import { confirm } from '../lib/confirm.ts';
import {
  cancelImport,
  dropLocalTable,
  formatBytes,
  type ImportStatus,
  importLocalPath,
  isLocalImportFile,
  listLocalTables,
  LOCAL_ACCEPT,
  LOCAL_SOURCE_ID,
  type LocalTables,
  renameLocalTable,
  uploadLocalFile,
  waitForImport,
} from '../lib/localdb.ts';

interface Job {
  key: string;
  file: string;
  /** 'uploading' while the browser sends the file; then the server's states. */
  state: 'uploading' | ImportStatus['state'];
  sent: number;
  total: number;
  rows: number;
  table: string | null;
  error: string | null;
  warnings: string[];
  serverJob: string | null;
  abort: AbortController;
}

export interface LocalDbSectionProps {
  busy: string | null;
  onProfile: (source: string, table: string) => void;
  /** The tables changed (an import finished, a table was renamed or dropped). */
  onChanged?: () => void;
}

const NAME_RX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function LocalDbSection(p: LocalDbSectionProps) {
  const [info, setInfo] = useState<LocalTables | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [path, setPath] = useState('');
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<{ name: string; to: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await listLocalTables();
      if (!alive.current) return;
      setInfo(r);
      setListError(null);
    } catch (e) {
      if (alive.current) setListError(describeError(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = (key: string, change: Partial<Job>) => {
    if (alive.current) setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...change } : j)));
  };

  const follow = async (key: string, serverJob: string, abort: AbortController) => {
    patch(key, { serverJob, state: 'importing' });
    try {
      const s = await waitForImport(serverJob, (st) => patch(key, { state: st.state, rows: st.rows, table: st.table, sent: st.bytes, total: st.totalBytes || 0 }), abort.signal);
      patch(key, { state: s.state, rows: s.rows, table: s.table, error: s.error, warnings: s.warnings ?? [] });
    } catch (e) {
      patch(key, { state: 'failed', error: describeError(e) });
    }
    await refresh();
    p.onChanged?.();
  };

  const startJob = (file: string, total: number): Job => {
    const job: Job = { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, state: 'uploading', sent: 0, total, rows: 0, table: null, error: null, warnings: [], serverJob: null, abort: new AbortController() };
    setJobs((js) => [job, ...js].slice(0, 12));
    return job;
  };

  const addFiles = async (files: File[]) => {
    setMessage(null);
    const skipped = files.filter((f) => !isLocalImportFile(f.name));
    if (skipped.length) setMessage(`Not a file the local database reads: ${skipped.map((f) => f.name).join(', ')}. It takes CSV, TSV, TXT, XLSX, SQLite, Parquet and Arrow files (also .gz).`);
    for (const f of files.filter((x) => isLocalImportFile(x.name))) {
      const job = startJob(f.name, f.size);
      try {
        const { job: serverJob } = await uploadLocalFile(f, (sent, total) => patch(job.key, { sent, total }), job.abort.signal);
        void follow(job.key, serverJob, job.abort);
      } catch (e) {
        patch(job.key, { state: 'failed', error: describeError(e) });
      }
    }
  };

  const addPath = async () => {
    const value = path.trim();
    if (!value) return;
    setMessage(null);
    const job = startJob(value.split(/[\\/]/).pop() || value, 0);
    patch(job.key, { state: 'starting' });
    try {
      const r = await importLocalPath(value);
      setPath('');
      void follow(job.key, r.job, job.abort);
    } catch (e) {
      patch(job.key, { state: 'failed', error: describeError(e) });
    }
  };

  const stop = async (j: Job) => {
    j.abort.abort();
    if (j.serverJob) {
      try {
        await cancelImport(j.serverJob);
      } catch {
        /* the job may have finished */
      }
    }
  };

  const drop = async (name: string) => {
    const ok = await confirm({ title: `Drop ${name}?`, body: 'The table leaves the local database. Flags that read it stop working until you import the file again.', confirmLabel: 'Drop table', destructive: true });
    if (!ok) return;
    try {
      await dropLocalTable(name);
      await refresh();
      p.onChanged?.();
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const rename = async () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!NAME_RX.test(to)) {
      setMessage('A table name has letters, digits and _ only, starts with a letter or _, and has at most 64 characters.');
      return;
    }
    try {
      await renameLocalTable(renaming.name, to);
      setRenaming(null);
      await refresh();
      p.onChanged?.();
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const tables = info?.tables ?? [];
  return (
    <div className="space-y-2 rounded-lg border border-line px-3 py-2" data-testid="local-db">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <HardDrive size={14} className="text-accent" /> Add to local database
        {info && <span className="ml-auto text-[11px] font-normal text-ink-3">{tables.length} table{tables.length === 1 ? '' : 's'} · {formatBytes(info.databaseBytes)}</span>}
      </p>
      <p className="text-[11px] text-ink-3">
        For big files: they are loaded into a database on this computer and queried there, so millions of rows never come into the page.{info && !info.columnar ? ' Parquet and Arrow need the columnar reader, which this copy does not have.' : ''}
      </p>
      <label
        className={`flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm ${dragging ? 'border-accent bg-panel-2' : 'border-line hover:border-accent'}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={15} className="text-accent" />
        <span>
          <span className="font-medium">Pick or drop files</span>
          <span className="block text-[11px] text-ink-3">CSV, TSV, TXT, Excel (.xlsx), SQLite (.sqlite, .db), Parquet, Arrow; also .gz.</span>
        </span>
        <input
          type="file"
          accept={LOCAL_ACCEPT}
          multiple
          className="sr-only"
          aria-label="Files for the local database"
          onChange={(e) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (list.length) void addFiles(list);
          }}
        />
      </label>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void addPath();
        }}
      >
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Or a path: C:\data\orders.csv or \\server\share\orders.csv"
          aria-label="Path of a file to import"
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs"
        />
        <button type="submit" disabled={!path.trim()} className="rounded-md border border-line px-2 py-1 text-xs font-semibold hover:border-accent disabled:opacity-40">
          Import
        </button>
      </form>
      <p className="text-[11px] text-ink-3">A path is read where it is, without copying. Network shares work only when the administrator listed the server in localShares.</p>
      {message && (
        <p role="alert" className="text-xs text-bad">
          {message}
        </p>
      )}

      {jobs.length > 0 && (
        <ul className="space-y-1.5" aria-label="Imports">
          {jobs.map((j) => {
            const running = j.state !== 'done' && j.state !== 'failed';
            const pct = j.total > 0 ? Math.min(100, Math.round((j.sent / j.total) * 100)) : undefined;
            const what =
              j.state === 'uploading' ? `Sending${pct !== undefined ? ` ${pct}%` : ''}`
              : j.state === 'done' ? `${j.rows.toLocaleString()} rows in ${j.table ?? 'a table'}`
              : j.state === 'failed' ? 'Not imported'
              : j.state === 'importing' ? `Importing: ${j.rows.toLocaleString()} rows${pct !== undefined && j.total ? ` (${pct}% of the file)` : ''}`
              : 'Starting…';
            return (
              <li key={j.key} className="rounded-md border border-line px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{j.file}</span>
                  <span className={j.state === 'failed' ? 'text-bad' : j.state === 'done' ? 'text-good' : 'text-ink-3'}>{what}</span>
                  {running && (
                    <button type="button" onClick={() => void stop(j)} aria-label={`Stop importing ${j.file}`} title="Stop this import" className="grid size-6 place-items-center rounded text-ink-3 hover:text-bad">
                      <Square size={11} />
                    </button>
                  )}
                </div>
                {running && <progress className="mt-1 h-1.5 w-full" max={100} value={pct ?? undefined} aria-label={`Progress of ${j.file}`} />}
                {j.error && <p className="mt-0.5 text-bad">{j.error}</p>}
                {j.warnings.map((w, i) => (
                  <p key={i} className="mt-0.5 text-warn">
                    {w}
                  </p>
                ))}
                {j.state === 'done' && j.table && (
                  <button type="button" disabled={p.busy !== null} onClick={() => p.onProfile(LOCAL_SOURCE_ID, j.table!)} className="mt-1 rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-panel disabled:opacity-40">
                    Profile and add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {listError ? (
        <p className="text-xs text-bad">{listError}</p>
      ) : !info ? (
        <p className="text-xs text-ink-3">Reading the local database…</p>
      ) : tables.length === 0 ? (
        <p className="text-xs text-ink-3">No tables yet.</p>
      ) : (
        <ul className="space-y-1" aria-label="Local tables">
          {tables.map((t) => (
            <li key={t.name} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-panel-2">
              {renaming?.name === t.name ? (
                <form
                  className="flex min-w-0 flex-1 gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename();
                  }}
                >
                  <input autoFocus value={renaming.to} onChange={(e) => setRenaming({ name: t.name, to: e.target.value })} aria-label={`New name for ${t.name}`} className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5" />
                  <button type="submit" className="rounded border border-line px-1.5">
                    Save
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} className="rounded px-1.5 text-ink-3">
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="truncate text-[11px] text-ink-3" title={t.path ?? undefined}>
                    {t.rows !== null ? `${t.rows.toLocaleString()} rows · ` : ''}
                    {t.columns.length} columns{t.bytes ? ` · ${formatBytes(t.bytes)}` : ''}
                    {t.source ? ` · ${t.source}` : ''}
                  </p>
                </div>
              )}
              {renaming?.name !== t.name && (
                <>
                  <button type="button" disabled={p.busy !== null} onClick={() => p.onProfile(LOCAL_SOURCE_ID, t.name)} className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-panel disabled:opacity-40">
                    Profile and add
                  </button>
                  <button type="button" onClick={() => setRenaming({ name: t.name, to: t.name })} aria-label={`Rename ${t.name}`} title="Rename" className="grid size-6 place-items-center rounded text-ink-3 hover:text-ink">
                    <Pencil size={12} />
                  </button>
                  <button type="button" onClick={() => void drop(t.name)} aria-label={`Drop ${t.name}`} title="Drop this table" className="grid size-6 place-items-center rounded text-ink-3 hover:text-bad">
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

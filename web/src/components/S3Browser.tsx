// The Data panel's Amazon S3 section: pick an allowlisted bucket, browse its folders, pick objects (or a whole
// folder of a partitioned dataset) and import them into the local database, following the import's progress.
// The server streams the objects to disk and runs the import (server/S3.ps1); this page never sees an AWS key.

import { useEffect, useRef, useState } from 'react';
import { CheckSquare, ChevronRight, Cloud, FileText, Folder, Loader2, Square } from 'lucide-react';
import { describeError } from '../lib/api.ts';
import { crumbs, formatBytes, type S3Bucket, type S3Buckets, type S3Job, type S3Listing, s3Buckets, s3Import, s3ImportStatus, s3List } from '../lib/aws.ts';

const POLL_MS = 1000;

export function S3Browser() {
  const [config, setConfig] = useState<S3Buckets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bucket, setBucket] = useState<S3Bucket | null>(null);
  const [listing, setListing] = useState<S3Listing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [table, setTable] = useState('');
  const [replace, setReplace] = useState(true);
  const [job, setJob] = useState<S3Job | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    s3Buckets().then(setConfig, (e) => setLoadError(describeError(e)));
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const open = async (b: S3Bucket, prefix: string, token = '') => {
    setLoading(true);
    setListError(null);
    try {
      const page = await s3List(b.bucket, prefix, token);
      setListing((was) => (token && was ? { ...page, folders: [...was.folders, ...page.folders], objects: [...was.objects, ...page.objects] } : page));
      if (!token) setPicked(new Set());
    } catch (e) {
      setListError(describeError(e));
    } finally {
      setLoading(false);
    }
  };

  const follow = (id: string) => {
    timer.current = window.setTimeout(async () => {
      try {
        const s = await s3ImportStatus(id);
        setJob(s);
        if (s.state === 'queued' || s.state === 'running') follow(id);
      } catch (e) {
        setStartError(describeError(e));
      }
    }, POLL_MS);
  };

  const start = async (what: { key?: string; keys?: string[]; prefix?: string }) => {
    if (!bucket) return;
    setStartError(null);
    try {
      const s = await s3Import({ bucket: bucket.bucket, ...what, ...(table.trim() ? { table: table.trim() } : {}), replace });
      setJob(s);
      follow(s.job);
    } catch (e) {
      setStartError(describeError(e));
    }
  };

  if (loadError) return <p className="text-xs text-bad">{loadError}</p>;
  if (!config) return <p className="text-xs text-ink-3">Reading the S3 settings…</p>;
  if (config.buckets.length === 0)
    return (
      <div className="space-y-1 text-xs text-ink-3" data-testid="s3-none">
        <p>No S3 buckets are set up. An administrator lists the buckets Semaphore may read in config\settings.json under "s3": {'{'} "buckets": [{'{'} "bucket", "region", "prefix" {'}'}] {'}'}; only those can be browsed or imported.</p>
        {config.problems.map((p) => (
          <p key={p} className="text-warn">
            {p}
          </p>
        ))}
      </div>
    );

  const busy = job !== null && (job.state === 'queued' || job.state === 'running');
  const keys = [...picked];
  const pickedBytes = listing ? listing.objects.filter((o) => picked.has(o.key)).reduce((n, o) => n + o.size, 0) : 0;
  const toggle = (key: string) =>
    setPicked((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-2" data-testid="s3-browser">
      <div className="flex gap-2">
        <select
          aria-label="S3 bucket"
          value={bucket ? `${bucket.bucket}|${bucket.prefix}` : ''}
          onChange={(e) => {
            const b = config.buckets.find((x) => `${x.bucket}|${x.prefix}` === e.target.value) ?? null;
            setBucket(b);
            setListing(null);
            setJob(null);
            if (b) void open(b, b.prefix);
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs"
        >
          <option value="">Choose a bucket…</option>
          {config.buckets.map((b) => (
            <option key={`${b.bucket}|${b.prefix}`} value={`${b.bucket}|${b.prefix}`}>
              {b.label !== b.bucket ? `${b.label} (` : ''}s3://{b.bucket}/{b.prefix}
              {b.label !== b.bucket ? ')' : ''} · {b.region}
            </option>
          ))}
        </select>
      </div>
      {listError && <p className="text-xs text-bad">{listError}</p>}
      {bucket && listing && (
        <>
          <nav aria-label="S3 folder" className="flex flex-wrap items-center gap-0.5 text-[11px] text-ink-3">
            {crumbs(listing.root, listing.prefix).map((c, i, all) => (
              <span key={c.prefix} className="flex items-center gap-0.5">
                {i > 0 && <ChevronRight size={11} />}
                {i === all.length - 1 ? (
                  <span className="font-medium text-ink">{c.name}</span>
                ) : (
                  <button type="button" onClick={() => void open(bucket, c.prefix)} className="underline-offset-2 hover:underline">
                    {c.name}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-line p-1" aria-label="Objects">
            {listing.folders.map((f) => (
              <li key={f.prefix}>
                <button type="button" onClick={() => void open(bucket, f.prefix)} className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-panel-2">
                  <Folder size={14} className="text-brass" /> <span className="truncate">{f.name}/</span>
                </button>
              </li>
            ))}
            {listing.objects.map((o) => (
              <li key={o.key}>
                <button type="button" role="checkbox" aria-checked={picked.has(o.key)} onClick={() => toggle(o.key)} className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-panel-2">
                  {picked.has(o.key) ? <CheckSquare size={14} className="text-accent" /> : <Square size={14} className="text-ink-3" />}
                  <FileText size={13} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-3">{formatBytes(o.size)}</span>
                  <span className="shrink-0 text-[10px] text-ink-3">{o.lastModified.slice(0, 10)}</span>
                </button>
              </li>
            ))}
            {listing.folders.length === 0 && listing.objects.length === 0 && <li className="px-2 py-1 text-xs text-ink-3">This folder is empty.</li>}
          </ul>
          {listing.nextToken && (
            <button type="button" disabled={loading} onClick={() => void open(bucket, listing.prefix, listing.nextToken!)} className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40">
              Show more
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              Table
              <input value={table} onChange={(e) => setTable(e.target.value.slice(0, 63))} placeholder="named from the file" aria-label="Table name" className="w-36 rounded border border-line bg-panel px-1.5 py-0.5" />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace a table of that name
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || keys.length === 0}
              onClick={() => void start(keys.length === 1 ? { key: keys[0]! } : { keys })}
              className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-panel disabled:opacity-40"
            >
              {keys.length > 1 ? `Import ${keys.length} objects as one table` : 'Import into the local database'}
              {keys.length > 0 ? ` (${formatBytes(pickedBytes)})` : ''}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start({ prefix: listing.prefix })}
              title={`Every CSV, JSON lines or Parquet part in this folder and below (up to ${config.maxPrefixObjects}), with the same columns, into one table`}
              className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40"
            >
              Import this whole folder
            </button>
          </div>
        </>
      )}
      {loading && !listing && <p className="text-xs text-ink-3">Listing…</p>}
      {startError && <p className="text-xs text-bad">{startError}</p>}
      {job && <JobLine job={job} />}
      <p className="text-[11px] text-ink-3">
        Objects are streamed to this computer and loaded into the local database; up to {formatBytes(config.maxObjectMb * 1024 * 1024)} each. Only the buckets and prefixes your administrator allows are shown.
      </p>
    </div>
  );
}

function JobLine({ job }: { job: S3Job }) {
  if (job.state === 'failed')
    return (
      <p role="alert" className="text-xs text-bad" data-testid="s3-job">
        Import failed: {job.error}
      </p>
    );
  if (job.state === 'done')
    return (
      <p role="status" className="text-xs text-good" data-testid="s3-job">
        Imported into table <span className="font-mono">{job.table}</span>: {(job.rows ?? 0).toLocaleString('en-US')} rows
        {typeof job.columns === 'number' ? `, ${job.columns} columns` : Array.isArray(job.columns) ? `, ${job.columns.length} columns` : ''}
        {job.ms !== null ? ` in ${(job.ms / 1000).toFixed(1)} s` : ''}.
      </p>
    );
  const pct = job.totalBytes > 0 ? Math.min(100, Math.round((job.bytes / job.totalBytes) * 100)) : 0;
  return (
    <div role="status" className="space-y-1 text-xs text-ink-2" data-testid="s3-job">
      <p className="flex items-center gap-1">
        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> {job.what}: {job.phase}
        {job.objectCount > 1 ? ` (${job.objects} of ${job.objectCount})` : ''}
        {job.totalBytes > 0 ? ` · ${formatBytes(job.bytes)} of ${formatBytes(job.totalBytes)}` : ''}
      </p>
      <div className="h-1.5 w-full rounded bg-panel-2" aria-hidden="true">
        <div className="h-1.5 rounded bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The Amazon S3 heading and browser, as one block of the Data panel. */
export function S3Section() {
  return (
    <section className="space-y-2" aria-label="Amazon S3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
        <Cloud size={13} /> Amazon S3
      </h3>
      <S3Browser />
    </section>
  );
}

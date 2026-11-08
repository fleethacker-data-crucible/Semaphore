// The SQL desk: for analysts who want to write their own query against a source on this computer's
// server, the lake included. It runs through the same /api/query as flags, so the same guard (one
// SELECT, nothing that writes), row cap and, for the lake, the same cost guard and cache apply.
// Analysts write in their own SQL language (Settings > SQL, or the picker here): what they write is
// translated into the source's dialect before it runs, and the translated text is shown first.

import { useMemo, useRef, useState } from 'react';
import { Download, History, Play, TerminalSquare, X } from 'lucide-react';
import { ApiError, type QueryResponse, runServerQuery, type ServerSource } from '../lib/api.ts';
import { useModal } from '../lib/modal.ts';
import { dialectForKind, SQL_DIALECTS, type SourceKind } from '../../../src/core/catalog.ts';
import { DIALECT_NAMES, translateSql } from '../../../src/core/sql-translate.ts';
import { setSqlPref, type SqlPref, useSqlPref } from '../lib/sql-pref.ts';

const HISTORY_KEY = 'semaphore.sqldesk';
const ROW_CAP = 5000;
const SHOWN = 200;

function readHistory(): Array<{ source: string; sql: string }> {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 15) : [];
  } catch {
    return [];
  }
}

function remember(source: string, sql: string): void {
  try {
    const next = [{ source, sql }, ...readHistory().filter((h) => h.sql !== sql)].slice(0, 15);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* history is a convenience */
  }
}

function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function toCsv(r: QueryResponse): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Leading = + - @ would be read as a formula by a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [r.columns.map(cell).join(','), ...r.rows.map((row) => r.columns.map((c) => cell(row[c])).join(','))].join('\r\n');
}

export function SqlDesk({ sources, onClose }: { sources: ServerSource[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const [source, setSource] = useState(sources[0]?.id ?? '');
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [error, setError] = useState<{ text: string; approve?: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState(readHistory);
  const pref = useSqlPref();
  const target = (() => {
    const s = sources.find((x) => x.id === source);
    return s ? (s.provider === 'athena' ? 'ansi' : dialectForKind(s.kind as SourceKind)) : 'ansi';
  })();
  // What actually runs: the SQL as written, translated into the source's dialect when the person writes in another.
  const translation = useMemo(() => (pref === 'source' || !sql.trim() ? null : translateSql(sql.trim(), pref, target)), [pref, sql, target]);
  const toRun = translation ? translation.sql : sql.trim();

  const run = async (approve = false) => {
    if (!sql.trim() || !source) return;
    setRunning(true);
    setError(null);
    try {
      const r = await runServerQuery(source, toRun, [], ROW_CAP, { approve });
      setResult(r);
      remember(source, sql.trim());
      setHistory(readHistory());
    } catch (e) {
      const approval = e instanceof ApiError && e.code === 'lake-approval';
      setError({ text: (e as Error).message, ...(approval ? { approve: true } : {}) });
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `semaphore-query-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const src = sources.find((s) => s.id === source);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="SQL desk" className="w-[900px] max-w-full rounded-lg border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <TerminalSquare size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">SQL desk</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 p-4">
          <p className="text-xs text-ink-2">
            Write one SELECT against a source on this computer. Semaphore only reads: statements that change data are refused. {src?.provider === 'athena' ? 'This is the lake: the query is sized before it runs, big scans ask first, and repeats come from the cache for free.' : ''}
          </p>
          <div className="flex items-center gap-2">
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source" className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {history.length > 0 && (
              <select value="" onChange={(e) => { const h = history[Number(e.target.value)]; if (h) { setSql(h.sql); if (sources.some((s) => s.id === h.source)) setSource(h.source); } }} aria-label="Earlier queries" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs">
                <option value="">Earlier queries…</option>
                {history.map((h, i) => (
                  <option key={i} value={i}>
                    {h.sql.replace(/\s+/g, ' ').slice(0, 110)}
                  </option>
                ))}
              </select>
            )}
            <History size={14} className="text-ink-3" aria-hidden />
            <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-2">
              I write in
              <select value={pref} onChange={(e) => setSqlPref(e.target.value as SqlPref)} aria-label="SQL language you write in" className="min-h-8 rounded-md border border-line bg-panel px-2 py-1 text-xs">
                <option value="source">{DIALECT_NAMES[target]} (this source's)</option>
                {SQL_DIALECTS.filter((d) => d !== target).map((d) => (
                  <option key={d} value={d}>
                    {DIALECT_NAMES[d]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            data-autofocus
            value={sql}
            onChange={(e) => setSql(e.target.value.slice(0, 100_000))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void run();
              }
            }}
            rows={8}
            spellCheck={false}
            aria-label="SQL"
            placeholder={'SELECT region, SUM(labor_cost) AS cost\nFROM work_orders\nWHERE opened_on >= DATE \'2026-01-01\'\nGROUP BY region'}
            className="block w-full rounded-md border border-line bg-panel-2 p-2 font-mono text-xs"
          />
          {translation && (
            <details open={translation.changed} className="rounded-md border border-line p-2 text-xs" data-testid="sql-translation">
              <summary className="cursor-pointer font-semibold">
                {translation.changed ? `Runs as ${DIALECT_NAMES[target]}: translated from ${DIALECT_NAMES[pref as keyof typeof DIALECT_NAMES]}` : `Nothing to translate for ${DIALECT_NAMES[target]}`}
              </summary>
              {translation.changed && <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-panel-2 p-2 font-mono text-[11px]">{translation.sql}</pre>}
              {translation.notes.map((n) => (
                <p key={n} className="mt-1 text-warn">
                  {n}
                </p>
              ))}
            </details>
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => run()} disabled={running || !sql.trim() || !source} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
              <Play size={14} /> {running ? 'Running…' : 'Run'}
            </button>
            <span className="text-[11px] text-ink-3">Ctrl+Enter runs it. Up to {ROW_CAP.toLocaleString('en-US')} rows come back.</span>
            {result && (
              <button type="button" onClick={download} className="ml-auto flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:border-accent">
                <Download size={13} /> CSV
              </button>
            )}
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-line p-2 text-xs">
              <span className={`flex-1 ${error.approve ? 'text-warn' : 'text-bad'}`}>{error.text}</span>
              {error.approve && (
                <button type="button" onClick={() => run(true)} className="rounded-md bg-accent px-2 py-0.5 font-semibold text-panel">
                  Run it
                </button>
              )}
            </div>
          )}
          {result && (
            <div className="space-y-1">
              <p className="text-[11px] text-ink-3">
                {result.rows.length.toLocaleString('en-US')} row{result.rows.length === 1 ? '' : 's'}
                {result.truncated ? ` (stopped at ${ROW_CAP.toLocaleString('en-US')})` : ''} · {result.ms} ms
                {result.cached ? ` · from the lake cache, taken ${result.asOf ?? ''}` : result.scannedBytes !== undefined ? ` · Athena read ${formatBytes(result.scannedBytes)}` : ''}
                {result.rows.length > SHOWN ? ` · showing the first ${SHOWN}; the CSV has them all` : ''}
              </p>
              {result.estimate?.warnings.map((w) => (
                <p key={w} className="text-[11px] text-warn">
                  {w}
                </p>
              ))}
              <div className="scroll-thin max-h-[420px] overflow-auto rounded-md border border-line">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-panel-2">
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c} className="border-b border-line px-2 py-1 text-left font-semibold">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, SHOWN).map((r, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => (
                          <td key={c} className={`border-b border-line/60 px-2 py-0.5 ${typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}`}>
                            {r[c] === null ? <span className="text-ink-3">null</span> : String(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

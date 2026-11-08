// The SQL desk's Script mode: several statements in the analyst's own SQL language, run against the
// local database in one transaction (server/LocalScript.ps1), or, against a live source, as read-only
// SELECTs one after another. The translated SQLite script and the notes show before anything runs;
// parameters are asked for first; each statement's result has its own tab. Saved scripts live on the
// server (SEMAPHORE_HOME\scripts) so pipelines can run them. Loaded with the SQL desk's Script tab only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Play, Save, Trash2 } from 'lucide-react';
import { describeError, runServerQuery, type ServerSource } from '../lib/api.ts';
import { dialectForSource, type Dialect, SQL_DIALECTS } from '../../../src/core/catalog.ts';
import { compileReadOnly, compileScript, DIALECT_NAMES } from '../../../src/core/script.ts';
import { setSqlPref, type SqlPref, useSqlPref } from '../lib/sql-pref.ts';
import { listLocalTables, LOCAL_SOURCE_ID } from '../lib/localdb.ts';
import { deleteScript, listScripts, loadScript, runScript, type SavedScriptItem, saveScript, scriptId, type ScriptResult } from '../lib/scripts.ts';
import { confirm } from '../lib/confirm.ts';

const HISTORY_KEY = 'semaphore.scriptdesk';
const SHOWN = 200;

interface Tab {
  title: string;
  result: ScriptResult;
}

function readHistory(): Array<{ dialect: string; text: string }> {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(v) ? v.slice(0, 15) : [];
  } catch {
    return [];
  }
}
function remember(dialect: string, text: string): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ dialect, text }, ...readHistory().filter((h) => h.text !== text)].slice(0, 15)));
  } catch {
    /* history is a convenience */
  }
}

/** The word being typed just before the caret, for name suggestions. */
function wordBefore(text: string, caret: number): { start: number; word: string } {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]!)) i--;
  return { start: i, word: text.slice(i, caret) };
}

export function ScriptMode({ sources }: { sources: ServerSource[] }) {
  const [target, setTarget] = useState(LOCAL_SOURCE_ID);
  const [text, setText] = useState('');
  const [params, setParams] = useState<Record<string, string>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<{ message: string; line: number } | null>(null);
  const [summary, setSummary] = useState('');
  const [running, setRunning] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [suggest, setSuggest] = useState<{ start: number; items: string[] } | null>(null);
  const [library, setLibrary] = useState<SavedScriptItem[]>([]);
  const [saveName, setSaveName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState(readHistory);
  const editor = useRef<HTMLTextAreaElement>(null);
  const pref = useSqlPref();
  const src = sources.find((s) => s.id === target);
  const targetDialect: Dialect = target === LOCAL_SOURCE_ID ? 'sqlite' : src ? dialectForSource(src) : 'ansi';
  const from: Dialect = pref === 'source' ? targetDialect : pref;
  const live = useMemo(() => sources.filter((s) => s.id !== LOCAL_SOURCE_ID), [sources]);
  const sourceDialects = useMemo(() => Object.fromEntries(live.map((s) => [s.id, dialectForSource(s)])) as Record<string, Dialect>, [live]);

  const compiled = useMemo(() => (target === LOCAL_SOURCE_ID && text.trim() ? compileScript(text, from, { sources: sourceDialects }) : null), [target, text, from, sourceDialects]);
  const readOnly = useMemo(() => (target !== LOCAL_SOURCE_ID && text.trim() ? compileReadOnly(text, from, targetDialect, src?.label ?? target) : null), [target, text, from, targetDialect, src]);
  const errors = compiled?.errors ?? readOnly?.errors ?? [];
  const notes = compiled?.notes ?? readOnly?.notes ?? [];
  const wanted = compiled?.plan.params ?? [];

  useEffect(() => {
    // Names to suggest: the local tables and their columns.
    listLocalTables().then(
      (r) => setNames([...new Set(r.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]))].sort()),
      () => setNames([]),
    );
    refreshLibrary();
  }, []);
  const refreshLibrary = () => {
    listScripts().then(setLibrary, () => setLibrary([]));
  };

  const onType = (value: string, caret: number) => {
    setText(value.slice(0, 200_000));
    const w = wordBefore(value, caret);
    if (w.word.length < 2) return setSuggest(null);
    const low = w.word.toLowerCase();
    const items = names.filter((n) => n.toLowerCase().startsWith(low) && n.toLowerCase() !== low).slice(0, 8);
    setSuggest(items.length ? { start: w.start, items } : null);
  };
  const accept = (name: string) => {
    const el = editor.current;
    if (!el || !suggest) return;
    const caret = el.selectionStart;
    const next = text.slice(0, suggest.start) + name + text.slice(caret);
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = suggest.start + name.length;
    });
  };

  const run = async () => {
    if (!text.trim() || running || errors.length) return;
    setRunning(true);
    setError(null);
    setTabs([]);
    setSummary('');
    try {
      if (compiled) {
        const values: Record<string, unknown> = {};
        for (const p of wanted) {
          const raw = params[p.name] ?? '';
          values[p.name] = raw === '' ? null : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
        }
        const r = await runScript(compiled.plan, values, 'SQL desk');
        setTabs(r.results.map((x, i) => ({ title: `${i + 1} · line ${x.line}`, result: x })));
        if (!r.ok && r.error) setError({ message: r.error.message, line: r.error.line });
        setSummary(`${r.ok ? 'Ran' : 'Stopped and rolled back'} in ${r.ms} ms${r.tables.length ? ` · wrote ${r.tables.join(', ')}` : ''}${r.resultsDropped ? ` · ${r.resultsDropped} more results not kept` : ''}`);
      } else if (readOnly) {
        const out: Tab[] = [];
        for (const s of readOnly.statements) {
          const q = await runServerQuery(target, s.sql, [], 5000);
          out.push({ title: `${out.length + 1} · line ${s.line}`, result: { line: s.line, kind: 'rows', ms: q.ms, sql: s.sql, columns: q.columns, rows: q.rows.map((row) => q.columns.map((c) => row[c])), truncated: q.truncated } });
          setTabs([...out]);
        }
        setSummary(`Ran ${out.length} SELECT${out.length === 1 ? '' : 's'} on ${src?.label ?? target} (read-only)`);
      }
      setActive(0);
      remember(from, text);
      setHistory(readHistory());
    } catch (e) {
      setError({ message: describeError(e), line: 0 });
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    const name = saveName.trim();
    if (!name) return setMessage('Give the script a name first.');
    if (!compiled || errors.length) return setMessage('Only a script for the local database without errors can be saved.');
    try {
      const id = scriptId(name);
      await saveScript(id, { version: 1, name, dialect: from, text, plan: compiled.plan });
      setMessage(`Saved as ${id}. Pipelines can run it.`);
      refreshLibrary();
    } catch (e) {
      setMessage(describeError(e));
    }
  };
  const open = async (id: string) => {
    try {
      const s = await loadScript(id);
      setText(s.text);
      setSaveName(s.name);
      setTarget(LOCAL_SOURCE_ID);
      if (s.dialect !== from) setSqlPref(s.dialect === 'sqlite' ? 'source' : s.dialect);
      setMessage(null);
    } catch (e) {
      setMessage(describeError(e));
    }
  };
  const remove = async (id: string) => {
    if (!(await confirm({ title: `Delete the script ${id}?`, body: 'It is moved to the scripts .trash folder. Pipelines that run it will fail until it is saved again.', confirmLabel: 'Delete script', destructive: true }))) return;
    try {
      await deleteScript(id);
      refreshLibrary();
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const tab = tabs[active];
  return (
    <div className="space-y-3" data-testid="script-mode">
      <p className="text-xs text-ink-2">
        Several statements, one after another. In the local database they run in one transaction (CREATE, INSERT, UPDATE, DELETE, MERGE, upserts, CTEs, window functions, IF, WHILE, TRY...CATCH); an error rolls it all back. Live databases stay read-only: only SELECTs run there, and IMPORT INTO local_table FROM SOURCE id AS (SELECT ...) copies rows into the local database.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          Run against
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Script target" className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
            <option value={LOCAL_SOURCE_ID}>Local database (read and write)</option>
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} (SELECT only)
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          I write in
          <select value={pref} onChange={(e) => setSqlPref(e.target.value as SqlPref)} aria-label="Script SQL language" className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
            <option value="source">{DIALECT_NAMES[targetDialect]}</option>
            {SQL_DIALECTS.filter((d) => d !== targetDialect).map((d) => (
              <option key={d} value={d}>
                {DIALECT_NAMES[d]}
              </option>
            ))}
          </select>
        </label>
        {history.length > 0 && (
          <select value="" onChange={(e) => { const h = history[Number(e.target.value)]; if (h) setText(h.text); }} aria-label="Earlier scripts" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs">
            <option value="">Earlier scripts…</option>
            {history.map((h, i) => (
              <option key={i} value={i}>
                {h.text.replace(/\s+/g, ' ').slice(0, 100)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5 text-xs">
        <BookOpen size={13} className="text-ink-3" aria-hidden />
        <select value="" onChange={(e) => e.target.value && void open(e.target.value)} aria-label="Saved scripts" className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
          <option value="">{library.length ? 'Open a saved script…' : 'No saved scripts yet'}</option>
          {library.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.id})
            </option>
          ))}
        </select>
        <input value={saveName} onChange={(e) => setSaveName(e.target.value.slice(0, 100))} placeholder="Script name" aria-label="Script name" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1" />
        <button type="button" onClick={() => void save()} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:border-accent">
          <Save size={12} /> Save
        </button>
        {library.some((s) => s.id === scriptId(saveName)) && saveName.trim() && (
          <button type="button" onClick={() => void remove(scriptId(saveName))} aria-label={`Delete the saved script ${scriptId(saveName)}`} className="grid size-6 place-items-center rounded text-ink-3 hover:text-bad">
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {message && <p className="text-xs text-ink-2">{message}</p>}

      <div className="relative">
        <textarea
          ref={editor}
          data-autofocus
          value={text}
          onChange={(e) => onType(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void run();
            } else if (e.key === 'Tab' && suggest?.items[0]) {
              e.preventDefault();
              accept(suggest.items[0]);
            } else if (e.key === 'Escape' && suggest) {
              e.stopPropagation();
              setSuggest(null);
            }
          }}
          rows={12}
          spellCheck={false}
          aria-label="Script"
          placeholder={'DECLARE @cutoff DATE = \'2026-01-01\'\nMERGE INTO stock AS t\nUSING incoming AS s ON t.id = s.id\nWHEN MATCHED THEN UPDATE SET t.qty = s.qty\nWHEN NOT MATCHED THEN INSERT (id, qty) VALUES (s.id, s.qty);\nSELECT * FROM stock WHERE updated >= @cutoff'}
          className="block w-full rounded-md border border-line bg-panel-2 p-2 font-mono text-xs"
        />
        {suggest && (
          <div className="mt-1 flex flex-wrap gap-1" role="listbox" aria-label="Name suggestions">
            {suggest.items.map((n, i) => (
              <button key={n} type="button" role="option" aria-selected={i === 0} onMouseDown={(e) => { e.preventDefault(); accept(n); }} className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${i === 0 ? 'border-accent' : 'border-line'}`}>
                {n}
              </button>
            ))}
            <span className="text-[11px] text-ink-3">Tab takes the first</span>
          </div>
        )}
      </div>

      {(compiled || readOnly) && (
        <details open={(compiled?.statements ?? 0) > 0 && from !== 'sqlite'} className="rounded-md border border-line p-2 text-xs" data-testid="script-translation">
          <summary className="cursor-pointer font-semibold">
            {compiled ? `Runs as SQLite in the local database: ${compiled.statements} statement${compiled.statements === 1 ? '' : 's'}${from !== 'sqlite' ? `, translated from ${DIALECT_NAMES[from]}` : ''}` : `Runs on ${src?.label ?? target} as ${DIALECT_NAMES[targetDialect]}: ${readOnly!.statements.length} SELECT${readOnly!.statements.length === 1 ? '' : 's'}`}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 font-mono text-[11px]">{compiled ? compiled.sqlite : readOnly!.statements.map((s) => `${s.sql};`).join('\n')}</pre>
          {notes.map((n, i) => (
            <p key={i} className="mt-1 text-warn">
              Line {n.line}: {n.message}
            </p>
          ))}
        </details>
      )}
      {errors.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-bad/50 p-2 text-xs text-bad" aria-label="Script problems">
          {errors.map((e, i) => (
            <li key={i}>
              Line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      )}
      {wanted.length > 0 && (
        <fieldset className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-xs">
          <legend className="px-1 font-semibold">Parameters</legend>
          {wanted.map((p) => (
            <label key={p.name} className="flex items-center gap-1">
              <span className="font-mono">{p.label}</span>
              <input value={params[p.name] ?? ''} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} aria-label={`Value for ${p.label}`} className="w-32 rounded border border-line bg-panel px-1.5 py-0.5" />
            </label>
          ))}
          <span className="text-[11px] text-ink-3">Empty means NULL; numbers are sent as numbers.</span>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void run()} disabled={running || !text.trim() || errors.length > 0} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
          <Play size={14} /> {running ? 'Running…' : 'Run script'}
        </button>
        <span className="text-[11px] text-ink-3">Ctrl+Enter runs it. Up to 500 rows per statement come back.</span>
        {summary && <span className="ml-auto text-[11px] text-ink-2" data-testid="script-summary">{summary}</span>}
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-line p-2 text-xs text-bad">
          {error.message}
        </p>
      )}
      {tabs.length > 0 && (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Statement results">
            {tabs.map((t, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)} className={`rounded-md border px-2 py-0.5 text-[11px] ${i === active ? 'border-accent font-semibold' : 'border-line text-ink-3'}`}>
                {t.title}
              </button>
            ))}
          </div>
          {tab && <ResultView r={tab.result} />}
        </div>
      )}
    </div>
  );
}

function ResultView({ r }: { r: ScriptResult }) {
  if (r.kind === 'message') return <p className="rounded-md border border-line p-2 font-mono text-xs" role="tabpanel">{r.message}</p>;
  if (r.kind === 'changes')
    return (
      <p className="rounded-md border border-line p-2 text-xs" role="tabpanel">
        {(r.changes ?? 0).toLocaleString('en-US')} row{r.changes === 1 ? '' : 's'} changed · {r.ms} ms
        {r.sql && <span className="mt-1 block truncate font-mono text-[11px] text-ink-3">{r.sql}</span>}
      </p>
    );
  const rows = r.rows ?? [];
  const cols = r.columns ?? [];
  return (
    <div role="tabpanel" className="space-y-1">
      <p className="text-[11px] text-ink-3">
        {rows.length.toLocaleString('en-US')} row{rows.length === 1 ? '' : 's'}
        {r.truncated ? ' (more were left out)' : ''} · {r.ms} ms{rows.length > SHOWN ? ` · showing the first ${SHOWN}` : ''}
      </p>
      <div className="scroll-thin max-h-[360px] overflow-auto rounded-md border border-line">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panel-2">
            <tr>
              {cols.map((c, i) => (
                <th key={i} className="border-b border-line px-2 py-1 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((row, i) => (
              <tr key={i}>
                {cols.map((_, j) => (
                  <td key={j} className={`border-b border-line/60 px-2 py-0.5 ${typeof row[j] === 'number' ? 'text-right tabular-nums' : ''}`}>
                    {row[j] === null || row[j] === undefined ? <span className="text-ink-3">null</span> : String(row[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

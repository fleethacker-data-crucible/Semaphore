// Inspector > Widget, for a custom flag: the code and CSS editor, starter templates, the frame's
// last error under the code, and the team library (save this widget, insert one). Loaded only when
// a custom flag is selected. The flag's own card is the live preview: edits reach it after a pause.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Check, Library, Save, Trash2 } from 'lucide-react';
import type { Flag } from '../../../src/core/hoist.ts';
import { type FlagWidget, sanitizeWidgetName, utf8Bytes, WIDGET_LIMITS } from '../../../src/core/widget.ts';
import { confirm } from '../lib/confirm.ts';
import { describeError, sessionToken } from '../lib/api.ts';
import { useWidgetStatus } from '../lib/widget-bus.ts';
import { STARTER_CODE, STARTER_CSS, WIDGET_API_HELP, WIDGET_TEMPLATES } from '../lib/widget-templates.ts';
import { deleteLibraryWidget, type LibraryEntry, listLibrary, loadLibraryWidget, saveLibraryWidget } from '../lib/widgets.ts';

/** How long the editor waits after the last key before the card draws the new code. */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface CustomPanelProps {
  flag: Flag;
  onChange: (patch: Partial<Flag>, group?: string) => void;
}

export default function CustomPanel({ flag, onChange }: CustomPanelProps) {
  // Browser-only mode has no server, so no team library.
  const library = sessionToken() !== null;
  const widget: FlagWidget = flag.widget ?? { code: STARTER_CODE, css: STARTER_CSS };
  const [tab, setTab] = useState<'code' | 'css'>('code');
  const [draft, setDraft] = useState({ code: widget.code, css: widget.css ?? '' });
  const status = useWidgetStatus(flag.id);
  const editor = useRef<HTMLTextAreaElement>(null);

  // A change from elsewhere (a template, the library, undo) replaces the draft.
  const shown = useRef({ code: widget.code, css: widget.css ?? '' });
  useEffect(() => {
    if (widget.code !== shown.current.code || (widget.css ?? '') !== shown.current.css) {
      shown.current = { code: widget.code, css: widget.css ?? '' };
      setDraft({ code: widget.code, css: widget.css ?? '' });
    }
  }, [widget.code, widget.css]);

  const codeBytes = utf8Bytes(draft.code);
  const cssBytes = utf8Bytes(draft.css);
  const tooBig = codeBytes > WIDGET_LIMITS.codeBytes ? `The code is ${(codeBytes / 1024).toFixed(1)} KB, over the ${WIDGET_LIMITS.codeBytes / 1024} KB limit, so the card still shows the last code that fit.` : cssBytes > WIDGET_LIMITS.cssBytes ? `The CSS is over the ${WIDGET_LIMITS.cssBytes / 1024} KB limit.` : null;

  // The card is the preview: it gets the code after a short pause, not on every key.
  useEffect(() => {
    if (draft.code === shown.current.code && draft.css === shown.current.css) return;
    if (tooBig) return;
    const t = window.setTimeout(() => {
      shown.current = { ...draft };
      onChange({ widget: { ...widget, code: draft.code, css: draft.css } }, `widget-${flag.id}`);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tooBig]);

  const useCode = (next: FlagWidget) => {
    shown.current = { code: next.code, css: next.css ?? '' };
    setDraft({ code: next.code, css: next.css ?? '' });
    onChange({ widget: next }, `widget-${flag.id}`);
  };

  const pickTemplate = async (id: string) => {
    const t = WIDGET_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    const changed = flag.widget && flag.widget.code.trim() !== '' && !WIDGET_TEMPLATES.some((x) => x.code === flag.widget!.code) && flag.widget.code !== STARTER_CODE;
    if (changed && !(await confirm({ title: `Replace this widget's code with the ${t.name} template?`, body: 'Your code is replaced. Undo (Ctrl+Z) brings it back.', confirmLabel: 'Replace' }))) return;
    useCode({ code: t.code, css: t.css });
  };

  const value = tab === 'code' ? draft.code : draft.css;
  const setValue = (v: string) => setDraft((d) => (tab === 'code' ? { ...d, code: v } : { ...d, css: v }));
  const lines = useMemo(() => Math.max(1, value.split('\n').length), [value]);
  const gutter = useRef<HTMLPreElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    // Tab indents (two spaces), Shift+Tab takes two back; Escape leaves the editor.
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = ta;
    const start = value.lastIndexOf('\n', a - 1) + 1;
    if (e.shiftKey) {
      const block = value.slice(start, b);
      const out = block.replace(/^ {1,2}/gm, '');
      const removedFirst = block.length && /^ {1,2}/.exec(block)?.[0].length;
      setValue(value.slice(0, start) + out + value.slice(b));
      requestAnimationFrame(() => ta.setSelectionRange(Math.max(start, a - (removedFirst || 0)), b - (block.length - out.length)));
    } else if (a !== b && value.slice(a, b).includes('\n')) {
      const block = value.slice(start, b);
      const out = block.replace(/^/gm, '  ');
      setValue(value.slice(0, start) + out + value.slice(b));
      requestAnimationFrame(() => ta.setSelectionRange(a + 2, b + (out.length - block.length)));
    } else {
      setValue(value.slice(0, a) + '  ' + value.slice(b));
      requestAnimationFrame(() => ta.setSelectionRange(a + 2, a + 2));
    }
  };

  const goToLine = (line: number) => {
    setTab('code');
    requestAnimationFrame(() => {
      const ta = editor.current;
      if (!ta) return;
      const parts = draft.code.split('\n');
      const from = parts.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(from, from + (parts[line - 1]?.length ?? 0));
    });
  };

  return (
    <section className="space-y-2" aria-label="Widget" data-testid="widget-panel">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold text-ink-2">Widget</h3>
        <span className="text-[11px] text-ink-3">Runs sandboxed: no network, no page data but its own</span>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <span className="shrink-0 text-ink-2">Start from</span>
        <select
          aria-label="Widget template"
          value=""
          onChange={(e) => void pickTemplate(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs"
        >
          <option value="">a template…</option>
          {WIDGET_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}: {t.description}
            </option>
          ))}
        </select>
      </label>
      <div role="tablist" aria-label="Widget source" className="flex gap-1 text-xs">
        {(['code', 'css'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-8 rounded-md px-2 ${tab === t ? 'bg-accent-soft font-semibold text-accent' : 'text-ink-2 hover:bg-panel-2'}`}>
            {t === 'code' ? 'Code' : 'CSS'}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-ink-3">
          {tab === 'code' ? `${(codeBytes / 1024).toFixed(1)} of ${WIDGET_LIMITS.codeBytes / 1024} KB` : `${(cssBytes / 1024).toFixed(1)} of ${WIDGET_LIMITS.cssBytes / 1024} KB`}
        </span>
      </div>
      <div className="focus-frame flex max-h-[420px] min-h-[220px] overflow-hidden rounded-lg border border-line bg-panel-2 font-mono text-[11.5px] leading-[18px]">
        <pre ref={gutter} aria-hidden="true" className="m-0 shrink-0 select-none overflow-hidden border-r border-line px-1.5 py-2 text-right text-ink-3">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} className={`block ${status.line === i + 1 && tab === 'code' ? 'font-semibold text-bad' : ''}`}>
              {i + 1}
            </span>
          ))}
        </pre>
        <textarea
          ref={editor}
          aria-label={tab === 'code' ? 'Widget code' : 'Widget CSS'}
          aria-describedby={`widget-help-${flag.id}`}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          className="scroll-thin min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-ink outline-none"
          rows={18}
        />
      </div>
      <p id={`widget-help-${flag.id}`} className="text-[11px] text-ink-3">
        Tab indents, Shift+Tab outdents, Esc leaves the editor. The card draws your code {PREVIEW_DEBOUNCE_MS} ms after you stop typing.
      </p>
      {tooBig ? (
        <p className="flex items-start gap-1.5 text-xs text-bad" role="alert">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {tooBig}
        </p>
      ) : status.state === 'error' || status.state === 'dead' ? (
        <p className="flex items-start gap-1.5 text-xs text-bad" role="alert" data-testid="widget-error">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {status.line ? (
              <button type="button" onClick={() => goToLine(status.line!)} className="font-semibold underline">
                Line {status.line}
              </button>
            ) : null}
            {status.line ? ': ' : ''}
            {status.state === 'dead' ? 'This widget stopped responding. Its code may be stuck in a loop.' : status.error}
          </span>
        </p>
      ) : status.state === 'ready' ? (
        <p className="flex items-center gap-1.5 text-xs text-good" data-testid="widget-ok">
          <Check size={13} aria-hidden="true" /> Drawn without errors
        </p>
      ) : null}
      <details className="text-[11px] text-ink-2">
        <summary className="cursor-pointer font-semibold text-accent">The widget API</summary>
        <pre className="scroll-thin mt-1 overflow-x-auto whitespace-pre rounded-md bg-panel-2 p-2 font-mono text-[10.5px] leading-4">{WIDGET_API_HELP}</pre>
      </details>
      {library ? <LibraryBox flag={flag} widget={{ ...widget, code: draft.code, css: draft.css }} onUse={useCode} /> : <p className="text-[11px] text-ink-3">The team library needs the Semaphore server; this page is running on its own.</p>}
    </section>
  );
}

function LibraryBox({ flag, widget, onUse }: { flag: Flag; widget: FlagWidget; onUse: (w: FlagWidget) => void }) {
  const [mode, setMode] = useState<'idle' | 'save' | 'insert'>('idle');
  const [name, setName] = useState(widget.name ?? flag.title ?? '');
  const [description, setDescription] = useState('');
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  const open = async (next: 'save' | 'insert') => {
    setNote(null);
    setMode(next);
    if (next === 'insert') {
      setEntries(null);
      try {
        setEntries(await listLibrary());
      } catch (e) {
        setNote({ tone: 'bad', text: describeError(e) });
        setEntries([]);
      }
    }
  };

  const save = async (asNew: boolean) => {
    const clean = sanitizeWidgetName(name);
    if (!clean) return setNote({ tone: 'bad', text: 'Give the widget a name first.' });
    setBusy(true);
    try {
      const saved = await saveLibraryWidget({ ...(!asNew && widget.libraryId ? { id: widget.libraryId } : {}), name: clean, description, code: widget.code, css: widget.css ?? '' });
      onUse({ ...widget, libraryId: saved.id, name: saved.name });
      setNote({ tone: 'good', text: `Saved to the team library as “${saved.name}”.` });
      setMode('idle');
    } catch (e) {
      setNote({ tone: 'bad', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const insert = async (id: string) => {
    setBusy(true);
    try {
      const w = await loadLibraryWidget(id);
      onUse({ code: w.code, ...(w.css ? { css: w.css } : {}), libraryId: w.id, name: w.name });
      setNote({ tone: 'good', text: `Inserted “${w.name}” from the team library.` });
      setMode('idle');
    } catch (e) {
      setNote({ tone: 'bad', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: LibraryEntry) => {
    if (!(await confirm({ title: `Remove “${e.name}” from the team library?`, body: 'It moves to the library’s .trash folder on the server. Pages that inserted it keep their copy.', confirmLabel: 'Remove', destructive: true }))) return;
    try {
      await deleteLibraryWidget(e.id);
      setEntries((list) => (list ?? []).filter((x) => x.id !== e.id));
    } catch (err) {
      setNote({ tone: 'bad', text: describeError(err) });
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-line p-2" data-testid="widget-library">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-auto flex items-center gap-1 text-xs font-semibold text-ink-2">
          <Library size={13} aria-hidden="true" /> Team library
        </span>
        <button type="button" onClick={() => void open('save')} className="flex min-h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
          <Save size={13} aria-hidden="true" /> Save to team library
        </button>
        <button type="button" onClick={() => void open('insert')} className="flex min-h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
          <BookOpen size={13} aria-hidden="true" /> Insert from library
        </button>
      </div>
      {widget.name && <p className="text-[11px] text-ink-3">From the library: {widget.name}</p>}
      {mode === 'save' && (
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <label className="block text-xs">
            <span className="text-ink-2">Name</span>
            <input value={name} maxLength={WIDGET_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} aria-label="Library widget name" className="mt-0.5 w-full rounded-md border border-line bg-panel px-2 py-1 text-xs" />
          </label>
          <label className="block text-xs">
            <span className="text-ink-2">What it shows (optional)</span>
            <input value={description} maxLength={WIDGET_LIMITS.descriptionChars} onChange={(e) => setDescription(e.target.value)} aria-label="Library widget description" className="mt-0.5 w-full rounded-md border border-line bg-panel px-2 py-1 text-xs" />
          </label>
          <div className="flex gap-1.5">
            <button type="submit" disabled={busy} className="min-h-8 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel disabled:opacity-40">
              {widget.libraryId ? 'Update in library' : 'Save'}
            </button>
            {widget.libraryId && (
              <button type="button" disabled={busy} onClick={() => void save(true)} className="min-h-8 rounded-md border border-[var(--fl-control-border)] px-2 text-xs">
                Save as new
              </button>
            )}
            <button type="button" onClick={() => setMode('idle')} className="min-h-8 rounded-md px-2 text-xs text-ink-2 hover:bg-panel-2">
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === 'insert' && (
        <div className="space-y-1">
          {entries === null ? (
            <p className="text-xs text-ink-3">Loading the library…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-ink-3">The team library is empty. Save a widget to start it.</p>
          ) : (
            <ul className="scroll-thin max-h-56 space-y-1 overflow-y-auto" aria-label="Library widgets">
              {entries.map((e) => (
                <li key={e.id} className="flex items-center gap-1.5 rounded-md bg-panel-2 px-2 py-1">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{e.name}</span>
                    <span className="block truncate text-[11px] text-ink-3">{[e.description, e.by && `by ${e.by}`].filter(Boolean).join(' · ')}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => void insert(e.id)} aria-label={`Insert ${e.name}`} className="min-h-8 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
                    Insert
                  </button>
                  <button type="button" onClick={() => void remove(e)} aria-label={`Remove ${e.name} from the library`} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:text-bad">
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setMode('idle')} className="min-h-8 rounded-md px-2 text-xs text-ink-2 hover:bg-panel-2">
            Close
          </button>
        </div>
      )}
      {note && (
        <p className={`text-xs ${note.tone === 'good' ? 'text-good' : 'text-bad'}`} role={note.tone === 'bad' ? 'alert' : 'status'} data-testid="widget-library-note">
          {note.text}
        </p>
      )}
    </div>
  );
}

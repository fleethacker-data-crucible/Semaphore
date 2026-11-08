// Data and catalog: what Semaphore can read and what it calls things. Add CSV files (read in
// this page, never uploaded), profile a server source into a proposed catalog, and rename
// measures and fields or teach them more words. Every change is checked before it is used.

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Database, FileSpreadsheet, Network, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { Catalog, Field, Metric } from '../../../src/core/catalog.ts';
import type { IntelligenceProvider } from '../../../src/core/intelligence/contract.ts';
import { profileTables, type ServerInfo } from '../lib/api.ts';
import type { DataContext } from '../lib/data.ts';
import { CleanTab, RelationshipsTab } from './CleanPanel.tsx';
import { useModal } from '../lib/modal.ts';
import { recordSkill, takeDataTab } from '../lib/skills.ts';
import { EmptyState, emptyActionClass } from './EmptyState.tsx';

// Amazon S3 browser and RDS help (AwsData.tsx), loaded when the Sources tab first shows with a server.
const AwsData = lazy(() => import('./AwsData.tsx').then((m) => ({ default: m.AwsData })));

export interface DataPanelProps {
  catalog: Catalog;
  server: ServerInfo | null;
  localSources: ReadonlySet<string>;
  notes: string[];
  busy: string | null;
  onClose: () => void;
  onCatalog: (c: Catalog) => void;
  onAddCsv: (files: FileList) => void;
  onRemoveSource: (id: string) => void;
  onProfile: (source: string, table: string) => void;
  onLoadExample: () => void;
  /** Opens the Import from Qlik screen. */
  onImportQlik: () => void;
  /** For checking data quality and relationships against the data. */
  ctx: DataContext;
  /** The AI, when it is on, for cleaning suggestions. */
  provider: IntelligenceProvider;
  /** Opens the lineage view for this page. */
  onLineage: () => void;
}

export function DataPanel(p: DataPanelProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, p.onClose);
  // The Signal Book's "Try it" can ask for a tab (lib/skills.ts).
  const [tab, setTab] = useState<'sources' | 'measures' | 'fields' | 'clean' | 'relationships'>(() => takeDataTab() ?? 'sources');
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <aside ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Data and catalog" className="flex h-full w-[520px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Database size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Data and catalog</h2>
          <button type="button" onClick={p.onLineage} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:border-accent" title="Which flags read which measures and fields, back to the tables">
            <Network size={13} /> Lineage
          </button>
          <button type="button" onClick={p.onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="flex gap-1 border-b border-line px-3" role="tablist">
          {(['sources', 'measures', 'fields', 'clean', 'relationships'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-2.5 py-2 text-sm capitalize ${tab === t ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
            >
              {t === 'relationships' ? 'links' : t} {t === 'measures' ? `(${p.catalog.metrics.length})` : t === 'fields' ? `(${p.catalog.fields.length})` : ''}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {tab === 'sources' && <Sources {...p} />}
          {tab === 'measures' && <Measures catalog={p.catalog} onCatalog={p.onCatalog} />}
          {tab === 'fields' && <Fields catalog={p.catalog} onCatalog={p.onCatalog} />}
          {tab === 'clean' && <CleanTab catalog={p.catalog} ctx={p.ctx} provider={p.provider} onCatalog={p.onCatalog} />}
          {tab === 'relationships' && <RelationshipsTab catalog={p.catalog} ctx={p.ctx} onCatalog={p.onCatalog} />}
        </div>
      </aside>
    </div>
  );
}

function Sources(p: DataPanelProps) {
  const [tables, setTables] = useState<Record<string, string[] | string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const inCatalog = new Set(p.catalog.sources.map((s) => s.id));
  const addFiles = (files: FileList) => {
    p.onAddCsv(files);
    recordSkill('csv');
  };
  useEffect(() => {
    for (const s of p.server?.sources ?? []) {
      if (tables[s.id]) continue;
      profileTables(s.id).then(
        (r) => setTables((t) => ({ ...t, [s.id]: r.tables.map((x) => x.name) })),
        (e: Error) => setTables((t) => ({ ...t, [s.id]: e.message })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.server]);

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">In this hoist's catalog</h3>
        <ul className="space-y-1.5">
          {p.catalog.sources.map((s) => {
            const tableCount = new Set(p.catalog.fields.filter((f) => f.source === s.id).map((f) => f.table)).size;
            const where = p.localSources.has(s.id) ? (s.kind === 'csv' ? 'in this page' : 'sample data in this page') : p.server?.sources.some((x) => x.id === s.id) ? 'via the server' : 'not connected';
            return (
              <li key={s.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                {s.kind === 'csv' ? <FileSpreadsheet size={15} className="text-good" /> : <Database size={15} className="text-accent" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.label}</p>
                  <p className="text-[11px] text-ink-3">
                    {s.kind} · {s.dialect} · {tableCount} table{tableCount === 1 ? '' : 's'} · <span className={where === 'not connected' ? 'text-warn' : ''}>{where}</span>
                  </p>
                </div>
                <button type="button" onClick={() => p.onRemoveSource(s.id)} aria-label={`Remove ${s.label}`} title="Remove this source and its measures and fields" className="grid size-8 place-items-center rounded-md text-ink-3 hover:text-bad">
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
        {p.catalog.sources.length === 0 && (
          <div className="rounded-[10px] border border-dashed border-line">
            <EmptyState
              compact
              icon={Database}
              headline="No data yet."
              body="Add a CSV and Semaphore proposes measures and fields for you to check."
              action={
                <label className={emptyActionClass}>
                  <Upload size={15} /> Add CSV
                  <input type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" multiple className="sr-only" onChange={(e) => e.target.files?.length && addFiles(e.target.files)} />
                </label>
              }
              secondary={{ label: 'Load the example', icon: Sparkles, onClick: p.onLoadExample }}
            />
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Add data</h3>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-3 text-sm hover:border-accent">
          <Plus size={15} className="text-accent" />
          <span>
            <span className="font-medium">CSV files and Fleet exports</span>
            <span className="block text-[11px] text-ink-3">CSV, Halyard's backlog-health files, or the JSON exports of PacketRat and Eight Bells (or any list of records). Read in this page and kept in this browser. Semaphore proposes measures and fields for you to check.</span>
          </span>
          <input type="file" accept=".csv,.tsv,.txt,.json,text/csv,application/json" multiple className="sr-only" onChange={(e) => e.target.files?.length && addFiles(e.target.files)} />
        </label>
        <button type="button" onClick={p.onImportQlik} className="w-full rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent">
          <span className="font-medium">Import from Qlik</span>
          <span className="block text-[11px] text-ink-3">Paste a load script and chart expressions: tables, field names and measures come across for you to check.</span>
        </button>
        {!inCatalog.has('maint') && p.catalog.sources.length > 0 && (
          <button type="button" onClick={p.onLoadExample} className="w-full rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent">
            <span className="font-medium">Fleet maintenance example</span>
            <span className="block text-[11px] text-ink-3">Generated sample data, to try Semaphore out.</span>
          </button>
        )}
        {p.server ? (
          (p.server.sources.length ? p.server.sources : []).map((s) => {
            const t = tables[s.id];
            return (
              <div key={s.id} className="space-y-1.5 rounded-lg border border-line px-3 py-2">
                <p className="text-sm font-medium">
                  {s.label} <span className="text-[11px] font-normal text-ink-3">({s.kind}, {s.provider})</span>
                </p>
                {typeof t === 'string' ? (
                  <p className="text-xs text-bad">{t}</p>
                ) : !t ? (
                  <p className="text-xs text-ink-3">Reading tables…</p>
                ) : (
                  <div className="flex gap-2">
                    <select value={pick[s.id] ?? ''} onChange={(e) => setPick({ ...pick, [s.id]: e.target.value })} aria-label="Table" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs">
                      <option value="">Choose a table…</option>
                      {t.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!pick[s.id] || p.busy !== null}
                      onClick={() => p.onProfile(s.id, pick[s.id]!)}
                      className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-panel disabled:opacity-40"
                    >
                      Profile and add
                    </button>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <p className="text-xs text-ink-3">Databases (ODBC and OLE DB) are reached through the Semaphore server. Start Semaphore with Launch-Semaphore.bat and list them in sources.json.</p>
        )}
        {p.server && p.server.sources.length === 0 && <p className="text-xs text-ink-3">No databases are set up yet. Add them to sources.json in {p.server.home}.</p>}
        {p.busy && <p className="text-xs text-accent">{p.busy}</p>}
      </section>

      {p.server && (
        <Suspense fallback={<p className="text-xs text-ink-3">Loading Amazon S3 and RDS…</p>}>
          <AwsData home={p.server.home} />
        </Suspense>
      )}

      {p.notes.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">From the last profile</h3>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
            {p.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function words(s: string): string[] {
  return s
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z][a-z0-9 '-]{1,39}$/.test(w));
}

function Measures({ catalog, onCatalog }: { catalog: Catalog; onCatalog: (c: Catalog) => void }) {
  const set = (key: string, patch: Partial<Metric>) => onCatalog({ ...catalog, metrics: catalog.metrics.map((m) => (m.key === key ? { ...m, ...patch } : m)) });
  return (
    <ul className="space-y-2">
      {catalog.metrics.map((m) => (
        <li key={m.key} className="space-y-1 rounded-lg border border-line p-2">
          <div className="flex items-center gap-2">
            <LabelInput value={m.label} label="Measure name" onCommit={(label) => set(m.key, { label })} />
            <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">{m.agg}</span>
            <select value={m.format ?? 'number'} onChange={(e) => set(m.key, { format: e.target.value as Metric['format'] })} aria-label="Format" className="rounded border border-line bg-panel px-1 text-[11px]">
              <option value="number">number</option>
              <option value="currency">currency</option>
              <option value="percent">percent</option>
            </select>
          </div>
          <SynonymInput value={m.synonyms ?? []} onChange={(s) => set(m.key, { synonyms: s })} />
        </li>
      ))}
    </ul>
  );
}

function Fields({ catalog, onCatalog }: { catalog: Catalog; onCatalog: (c: Catalog) => void }) {
  const set = (key: string, patch: Partial<Field>) => onCatalog({ ...catalog, fields: catalog.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  return (
    <ul className="space-y-2">
      {catalog.fields.map((f) => (
        <li key={f.key} className="space-y-1 rounded-lg border border-line p-2">
          <div className="flex items-center gap-2">
            <LabelInput value={f.label} label="Field name" onCommit={(label) => set(f.key, { label })} />
            <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">{f.type}</span>
            {f.cardinality !== undefined && <span className="text-[10px] text-ink-3">{f.cardinality.toLocaleString('en-US')} values</span>}
          </div>
          <p className="truncate px-1 font-mono text-[10px] text-ink-3">
            {f.table}.{f.column}
          </p>
          <SynonymInput value={f.synonyms ?? []} onChange={(s) => set(f.key, { synonyms: s })} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A measure's or field's name: edited freely (it may be emptied while retyping) and kept in the
 * catalog on every keystroke that leaves a name; on blur an empty box goes back to the last name.
 */
function LabelInput({ value, label, onCommit }: { value: string; label: string; onCommit: (label: string) => void }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  // The catalog changed under the box (another panel, the folder's copy): show the new name unless typing here.
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <input
      value={text}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const next = e.target.value.slice(0, 80);
        setText(next);
        if (next.trim()) onCommit(next);
      }}
      onBlur={() => {
        focused.current = false;
        if (!text.trim()) setText(value);
      }}
      aria-label={label}
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-sm font-medium hover:border-line focus:border-accent focus:outline-none"
    />
  );
}

function SynonymInput({ value, onChange }: { value: string[]; onChange: (s: string[]) => void }) {
  const joined = value.join(', ');
  const [text, setText] = useState(joined);
  const focused = useRef(false);
  // Only a real change to the words resets the box, and never while the analyst is typing in it:
  // `value` is a fresh array on every render of the parent.
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);
  return (
    <label className="flex items-center gap-2 px-1 text-[11px] text-ink-3">
      Also called
      <input
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          onChange(words(text));
        }}
        placeholder="other words for it, comma separated"
        className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-ink focus:border-accent focus:outline-none"
      />
    </label>
  );
}

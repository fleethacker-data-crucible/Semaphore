// Import a model: one place to bring across what analysts already built in another tool. Qlik opens
// its own screen (QlikImport.tsx: a pasted load script); a dbt project or a Power BI model is picked
// as a folder or files, read in this page (src/core/dbt.ts, powerbi.ts, no model and nothing sent),
// and reviewed here: the tables and the Semaphore source each one is in, the measures that will be
// added, the links and drill paths, and every warning with the original expression. Accepting it
// profiles each picked table for its real columns and types, then adds the rest (app.tsx).

import { useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, FileCode2, FolderOpen, Layers, Link2, X } from 'lucide-react';
import { describeMeasure, MODEL_LIMITS, type ModelFile, type ModelRead, type ModelTool } from '../../../src/core/model-import.ts';
import { binaryPowerBi, readModelFiles, wantedModelFile } from '../../../src/core/model-read.ts';
import type { ServerSource } from '../lib/api.ts';
import { useModal } from '../lib/modal.ts';

export interface ModelImportPlan {
  read: ModelRead;
  /** Each picked model table, the Semaphore source it is in and the database table to profile. */
  tables: Array<{ model: string; source: string; table: string }>;
}

export interface ModelImportProps {
  sources: ServerSource[];
  busy: string | null;
  onImport: (plan: ModelImportPlan) => Promise<string[]>;
  /** Opens the Qlik import (a load script is pasted, not picked). */
  onQlik: () => void;
  onClose: () => void;
}

const TOOLS: Record<ModelTool, { title: string; hint: string; accept: string }> = {
  dbt: { title: 'dbt project', hint: 'Pick the project folder (or its YAML files): dbt_project.yml, models/**/*.yml with semantic_models and metrics. profiles.yml is never read.', accept: '.yml,.yaml' },
  powerbi: { title: 'Power BI model', hint: "Pick a Power BI Project's .SemanticModel folder (its .tmdl files) or a model.bim saved by Tabular Editor. A .pbix cannot be read: save it as a Power BI Project first.", accept: '.tmdl,.bim,.json,.pbix,.pbit' },
};

type Row = { pick: boolean; source: string; table: string };

/** The picked files as text: only model files, within the limits. */
async function readPicked(list: FileList): Promise<{ files: ModelFile[]; names: string[]; skipped: string[] }> {
  const files: ModelFile[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const f of [...list].slice(0, MODEL_LIMITS.files)) {
    const path = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    names.push(path);
    if (!wantedModelFile(path)) continue;
    if (f.size > MODEL_LIMITS.fileBytes || bytes + f.size > MODEL_LIMITS.bytes) {
      skipped.push(path);
      continue;
    }
    bytes += f.size;
    files.push({ path, text: await f.text() });
  }
  if (list.length > MODEL_LIMITS.files) skipped.push(`${list.length - MODEL_LIMITS.files} more files`);
  return { files, names, skipped };
}

export function ModelImport({ sources, busy, onImport, onQlik, onClose }: ModelImportProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const [tool, setTool] = useState<ModelTool | null>(null);
  const [read, setRead] = useState<(ModelRead & { refused?: string; switched?: boolean }) | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const [result, setResult] = useState<string[] | null>(null);
  const [reading, setReading] = useState(false);

  const pick = async (list: FileList | null) => {
    if (!list?.length || !tool) return;
    setReading(true);
    setResult(null);
    try {
      const got = await readPicked(list);
      const r = binaryPowerBi(got.names) && !got.files.length ? readModelFiles('powerbi', [], got.names) : readModelFiles(tool, got.files, got.names);
      setRead(r);
      setSkipped(got.skipped);
      const next: Record<string, Row> = {};
      for (const t of r.tables) {
        const hint = (t.connection ?? '').toLowerCase();
        const hit = hint ? sources.find((s) => hint.includes(s.label.toLowerCase()) || s.label.toLowerCase().includes(hint) || hint.includes(s.id.toLowerCase())) : undefined;
        const source = hit?.id ?? (sources.length === 1 ? sources[0]!.id : '');
        next[t.name] = { pick: true, source, table: t.relation };
      }
      setRows(next);
    } finally {
      setReading(false);
    }
  };

  const set = (name: string, patch: Partial<Row>) => setRows((r) => ({ ...r, [name]: { ...r[name]!, ...patch } }));
  const chosen = useMemo(() => (read?.tables ?? []).filter((t) => rows[t.name]?.pick && rows[t.name]?.source && rows[t.name]?.table.trim()), [read, rows]);
  const placed = new Set(chosen.map((t) => t.name));

  const run = async () => {
    if (!read) return;
    const tables = chosen.map((t) => ({ model: t.name, source: rows[t.name]!.source, table: rows[t.name]!.table.trim() }));
    setResult(await onImport({ read, tables }));
  };

  const what = tool ? TOOLS[tool] : null;
  const measureReady = (m: ModelRead['measures'][number]): boolean => (m.kind === 'agg' ? placed.has(m.table) : true);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Import a model" className="w-[820px] max-w-full rounded-lg border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Layers size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Import a model{what ? `: ${what.title}` : ''}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <p className="text-xs text-ink-2">Bring across the tables, field names, measures, links and drill paths someone already defined. Semaphore reads the files in this page without a model, shows what it will create and what it cannot, and adds nothing until you accept.</p>
          <div role="group" aria-label="Where the model comes from" className="grid gap-2 sm:grid-cols-3">
            <button type="button" onClick={onQlik} className="rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent">
              <span className="flex items-center gap-1.5 font-medium"><FileCode2 size={14} /> Qlik app</span>
              <span className="block text-[11px] text-ink-3">Paste a load script and chart expressions.</span>
            </button>
            {(['dbt', 'powerbi'] as const).map((t) => (
              <button key={t} type="button" aria-pressed={tool === t} onClick={() => (setTool(t), setRead(null), setResult(null))} className={`rounded-lg border px-3 py-2 text-left text-sm hover:border-accent ${tool === t ? 'border-accent bg-panel-2' : 'border-line'}`}>
                <span className="flex items-center gap-1.5 font-medium"><FolderOpen size={14} /> {TOOLS[t].title}</span>
                <span className="block text-[11px] text-ink-3">{t === 'dbt' ? 'Semantic models, metrics (and pre-1.6 metrics).' : 'TMDL folder (.pbip) or model.bim.'}</span>
              </button>
            ))}
          </div>

          {tool && what && (
            <div className="space-y-2 rounded-md border border-dashed border-line p-3">
              <p className="text-[11px] text-ink-3">{what.hint}</p>
              <div className="flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel">
                  Pick a folder
                  <input type="file" className="sr-only" aria-label={`${what.title} folder`} multiple {...{ webkitdirectory: '' }} onChange={(e) => void pick(e.target.files)} />
                </label>
                <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">
                  Pick files
                  <input type="file" className="sr-only" aria-label={`${what.title} files`} multiple accept={what.accept} onChange={(e) => void pick(e.target.files)} />
                </label>
                {reading && <span className="self-center text-xs text-ink-3">Reading…</span>}
              </div>
            </div>
          )}

          {read?.refused && (
            <p role="alert" className="flex gap-1.5 rounded-md border border-warn p-3 text-sm text-warn">
              <CircleAlert size={16} className="mt-0.5 shrink-0" /> {read.refused}
            </p>
          )}

          {read && !read.refused && (
            <div className="space-y-4" data-testid="model-review">
              <p className="text-xs text-ink-2">
                <b>{read.name}</b>: {read.files.length} file{read.files.length === 1 ? '' : 's'} read
                {read.switched ? `, read as ${TOOLS[read.tool].title} files (that is what they are)` : ''}
                {skipped.length ? `; left out as too large: ${skipped.slice(0, 3).join(', ')}` : ''}.
              </p>

              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold">Tables</h3>
                {read.tables.length === 0 && <p className="text-xs text-ink-3">No tables in these files.</p>}
                {read.tables.length > 1 && sources.length > 1 && (
                  <label className="flex items-center gap-2 text-xs text-ink-2">
                    Put every table in
                    <select aria-label="Semaphore source for every table" value="" onChange={(e) => e.target.value && setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, source: e.target.value }])))} className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
                      <option value="">Choose a source…</option>
                      {sources.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {read.tables.map((t) => {
                  const row = rows[t.name] ?? { pick: false, source: '', table: t.relation };
                  return (
                    <div key={t.name} className={`flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2 text-sm ${row.source ? '' : 'opacity-80'}`}>
                      <input type="checkbox" aria-label={`Import ${t.name}`} checked={row.pick && !!row.source} disabled={!row.source} onChange={(e) => set(t.name, { pick: e.target.checked })} />
                      <span className="min-w-0 flex-1">
                        <b>{t.name}</b>
                        <span className="block text-[11px] text-ink-3">
                          {t.columns.length} column{t.columns.length === 1 ? '' : 's'}
                          {t.columns.some((c) => c.grain) ? `, dates by ${t.columns.filter((c) => c.grain).map((c) => `${c.name} (${c.grain})`).join(', ')}` : ''}
                          {t.connection ? ` · ${t.connection}` : ''}
                          {t.description ? ` · ${t.description.split('\n')[0]!.slice(0, 90)}` : ''}
                        </span>
                      </span>
                      <ArrowRight size={14} className="text-ink-3" />
                      <select aria-label={`Semaphore source for ${t.name}`} value={row.source} onChange={(e) => set(t.name, { source: e.target.value, pick: true })} className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
                        <option value="">Choose a source…</option>
                        {sources.map((s) => (
                          <option key={s.id} value={s.id}>{s.label}</option>
                        ))}
                      </select>
                      <input aria-label={`Database table for ${t.name}`} value={row.table} onChange={(e) => set(t.name, { table: e.target.value.slice(0, 200) })} className="w-40 rounded-md border border-line bg-panel-2 px-2 py-1 font-mono text-xs" />
                    </div>
                  );
                })}
                {sources.length === 0 && <p className="text-xs text-warn">No database sources: start Semaphore with its server and list your databases in sources.json, or add files to the local database under Data.</p>}
              </div>

              {read.measures.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Measures</h3>
                  <ul aria-label="Measures to add" className="space-y-0.5 text-xs">
                    {read.measures.map((m) => (
                      <li key={m.name} className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate" title={m.expression}>
                          <b>{m.label}</b> <span className="font-mono text-ink-3">{describeMeasure(m)}</span>
                        </span>
                        <span className={measureReady(m) ? 'text-good' : 'text-ink-3'}>{m.kind === 'formula' ? 'calculated' : measureReady(m) ? 'will be added' : 'needs its table'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(read.relationships.length > 0 || read.hierarchies.length > 0) && (
                <div className="space-y-1">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Link2 size={14} /> Links and drill paths</h3>
                  <ul className="space-y-0.5 text-xs text-ink-2">
                    {read.relationships.map((r) => (
                      <li key={`${r.from.table}.${r.from.column}`}>
                        {r.from.table}.{r.from.column} → {r.to.table}.{r.to.column}
                        {r.note ? <span className="block text-[11px] text-ink-3">{r.note}</span> : null}
                      </li>
                    ))}
                    {read.hierarchies.map((h) => (
                      <li key={`${h.table}.${h.label}`}>
                        Drill path <b>{h.label}</b>: {h.levels.join(' → ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {read.warnings.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Not imported, and why</h3>
                  <ul aria-label="Warnings" className="max-h-56 space-y-0.5 overflow-y-auto text-[11px] text-ink-2">
                    {read.warnings.map((w) => (
                      <li key={w} className="flex gap-1">
                        <CircleAlert size={12} className="mt-0.5 shrink-0 text-warn" /> {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-line pt-3">
                <button type="button" onClick={run} disabled={!!busy || !chosen.length} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
                  {busy ?? `Import ${chosen.length} table${chosen.length === 1 ? '' : 's'} into the catalog`}
                </button>
                <span className="text-xs text-ink-3">Each table is profiled for its real columns and types first.</span>
              </div>
            </div>
          )}

          {result && (
            <ul aria-label="Import result" className="space-y-1 rounded-md bg-panel-2 p-3 text-xs">
              {result.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

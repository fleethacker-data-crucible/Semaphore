// Pipelines (Data panel > Pipelines): ordered steps that rebuild tidy tables in the local database
// (server/Pipeline.ps1). List, create and edit steps, see them as boxes left to right with the last
// run's status, rows and time on each, Update now (all, or from a step; Force reimports unchanged
// sources), the schedule, the run history, and each output table one click from the catalog.
// Loaded on demand from the Data panel.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GitBranch, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { describeError, type ServerSource } from '../lib/api.ts';
import { useModal } from '../lib/modal.ts';
import { confirm } from '../lib/confirm.ts';
import { LOCAL_SOURCE_ID } from '../lib/localdb.ts';
import { describeSchedule, newStepId, nextRun, type Pipeline, pipelineId, pipelineOutputs, type PipelineRun, type PipelineStep, type Schedule, type StepKind, type StepLog, validatePipeline, WEEKDAYS, type Weekday } from '../../../src/core/pipeline.ts';
import { deletePipeline, listLocalSources, listPipelines, listScripts, loadPipeline, type PipelineDetail, type PipelineItem, pipelineRun, pipelineRuns, runPipeline, type SavedScriptItem, savePipeline } from '../lib/scripts.ts';

export interface PipelinesViewProps {
  sources: ServerSource[];
  onClose: () => void;
  onProfile: (source: string, table: string) => void;
}

const BLANK: Pipeline = { version: 1, name: 'New pipeline', steps: [], schedule: { every: 'off' } };
const KIND_LABEL: Record<StepKind, string> = { import: 'Import', script: 'Script', pull: 'Pull', publish: 'Publish' };

type Status = Pick<StepLog, 'state' | 'rows' | 'ms' | 'error'>;

export function PipelinesView(p: PipelinesViewProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, p.onClose);
  const [items, setItems] = useState<PipelineItem[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pipeline | null>(null);
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [live, setLive] = useState<PipelineRun | null>(null);
  const [scripts, setScripts] = useState<SavedScriptItem[]>([]);
  const [uploads, setUploads] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [force, setForce] = useState(false);
  const [dirty, setDirty] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      setItems(await listPipelines());
    } catch (e) {
      setMessage(describeError(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    listScripts().then(setScripts, () => setScripts([]));
    listLocalSources().then((r) => setUploads(r.files.map((f) => f.name)), () => setUploads([]));
  }, [refresh]);

  const open = async (pid: string) => {
    setMessage(null);
    setLive(null);
    try {
      const d = await loadPipeline(pid);
      setId(pid);
      setDetail(d);
      setDraft(d.pipeline);
      setDirty(false);
      setRuns(await pipelineRuns(pid));
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const change = (next: Pipeline) => {
    setDraft(next);
    setDirty(true);
  };
  const setStep = (i: number, s: PipelineStep) => draft && change({ ...draft, steps: draft.steps.map((x, k) => (k === i ? s : x)) });
  const addStep = (kind: StepKind) => {
    if (!draft) return;
    const sid = newStepId(draft, kind);
    const step: PipelineStep =
      kind === 'import' ? { id: sid, kind, table: 'table_name', path: '' }
      : kind === 'script' ? { id: sid, kind, script: scripts[0]?.id ?? '' }
      : kind === 'pull' ? { id: sid, kind, source: p.sources.find((s) => s.id !== LOCAL_SOURCE_ID)?.id ?? '', sql: 'SELECT * FROM table_name', table: 'table_name' }
      : { id: sid, kind };
    change({ ...draft, steps: [...draft.steps, step] });
  };
  const move = (i: number, by: number) => {
    if (!draft) return;
    const steps = [...draft.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(Math.max(0, Math.min(steps.length, i + by)), 0, s!);
    change({ ...draft, steps });
  };

  const problem = draft ? validatePipeline(draft) : null;

  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    if (problem) {
      setMessage(problem);
      return null;
    }
    const pid = id ?? pipelineId(draft.name);
    try {
      await savePipeline(pid, draft);
      setId(pid);
      setDirty(false);
      setMessage('Saved.');
      await refresh();
      return pid;
    } catch (e) {
      setMessage(describeError(e));
      return null;
    }
  };

  const updateNow = async () => {
    const pid = dirty || !id ? await save() : id;
    if (!pid) return;
    setMessage(null);
    try {
      const { run } = await runPipeline(pid, { ...(from ? { from } : {}), ...(force ? { force: true } : {}) });
      for (;;) {
        await new Promise((r) => setTimeout(r, 600));
        if (!alive.current) return;
        let r: PipelineRun | null = null;
        try {
          r = await pipelineRun(pid, run);
        } catch {
          r = null; // the run file appears a moment after the run starts
        }
        if (r) setLive(r);
        if (r && r.state !== 'running') {
          setMessage(r.state === 'done' ? `Updated in ${(r.ms / 1000).toFixed(1)} s.` : r.error);
          break;
        }
      }
      setRuns(await pipelineRuns(pid));
      setDetail(await loadPipeline(pid));
      await refresh();
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const remove = async () => {
    if (!id) return;
    if (!(await confirm({ title: `Delete the pipeline ${draft?.name ?? id}?`, body: 'The pipeline is moved to the pipelines .trash folder. The tables it built stay in the local database.', confirmLabel: 'Delete pipeline', destructive: true }))) return;
    try {
      await deletePipeline(id);
      setId(null);
      setDraft(null);
      setDetail(null);
      setRuns([]);
      await refresh();
    } catch (e) {
      setMessage(describeError(e));
    }
  };

  const status = (sid: string): Status | undefined => {
    const fromLive = live?.steps.find((s) => s.id === sid);
    if (fromLive) return fromLive;
    const st = detail?.state.steps[sid];
    return st ? { state: st.state, rows: st.rows, ms: st.ms, error: st.error } : undefined;
  };
  const outputs = draft ? [...new Set([...pipelineOutputs(draft), ...(live?.outputs ?? runs[0]?.outputs ?? [])])] : [];
  const next = draft ? nextRun(draft.schedule) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Pipelines" className="w-[1080px] max-w-full rounded-lg border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <GitBranch size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Pipelines</h2>
          <button type="button" onClick={p.onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="flex gap-4 p-4">
          <nav className="w-52 shrink-0 space-y-1" aria-label="Pipeline list">
            {items.map((it) => (
              <button key={it.id} type="button" onClick={() => void open(it.id)} className={`block w-full rounded-md border px-2 py-1.5 text-left text-xs ${it.id === id ? 'border-accent' : 'border-line hover:border-accent'}`}>
                <span className="block truncate font-medium">{it.name}</span>
                <span className={`block text-[11px] ${it.lastRun?.state === 'failed' ? 'text-bad' : 'text-ink-3'}`}>
                  {it.running ? 'Running…' : it.lastRun ? `${it.lastRun.state} · ${new Date(it.lastRun.started).toLocaleString()}` : 'Never run'}
                </span>
              </button>
            ))}
            <button type="button" onClick={() => { setId(null); setDetail(null); setRuns([]); setLive(null); setDraft({ ...BLANK, steps: [] }); setDirty(true); }} className="flex w-full items-center gap-1 rounded-md border border-dashed border-line px-2 py-1.5 text-xs hover:border-accent">
              <Plus size={12} /> New pipeline
            </button>
            <p className="pt-2 text-[11px] text-ink-3">Steps rebuild tables in the local database, in order. A failed step stops the run; the tables of a failed step stay as they were.</p>
          </nav>

          {!draft ? (
            <p className="text-sm text-ink-3">Pick a pipeline, or make a new one.</p>
          ) : (
            <div className="min-w-0 flex-1 space-y-3" data-testid="pipeline-editor">
              <div className="flex items-center gap-2">
                <input value={draft.name} onChange={(e) => change({ ...draft, name: e.target.value.slice(0, 100) })} aria-label="Pipeline name" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-sm font-semibold" />
                <button type="button" onClick={() => void save()} disabled={!dirty} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40">
                  <Save size={12} /> Save
                </button>
                {id && (
                  <button type="button" onClick={() => void remove()} aria-label="Delete this pipeline" className="grid size-7 place-items-center rounded text-ink-3 hover:text-bad">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              <NodeView steps={draft.steps} status={status} />

              <ol className="space-y-2" aria-label="Steps">
                {draft.steps.map((s, i) => (
                  <li key={s.id} className="rounded-md border border-line p-2 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold">
                        {i + 1}. {KIND_LABEL[s.kind]}
                      </span>
                      <input value={s.name ?? ''} onChange={(e) => setStep(i, { ...s, name: e.target.value.slice(0, 100) || undefined } as PipelineStep)} placeholder={s.id} aria-label={`Name of step ${i + 1}`} className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5" />
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`} className="grid size-6 place-items-center rounded text-ink-3 disabled:opacity-30"><ArrowUp size={12} /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === draft.steps.length - 1} aria-label={`Move step ${i + 1} down`} className="grid size-6 place-items-center rounded text-ink-3 disabled:opacity-30"><ArrowDown size={12} /></button>
                      <button type="button" onClick={() => change({ ...draft, steps: draft.steps.filter((_, k) => k !== i) })} aria-label={`Remove step ${i + 1}`} className="grid size-6 place-items-center rounded text-ink-3 hover:text-bad"><Trash2 size={12} /></button>
                    </div>
                    <StepEditor step={s} index={i} sources={p.sources} scripts={scripts} uploads={uploads} onChange={(x) => setStep(i, x)} />
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(KIND_LABEL) as StepKind[]).map((k) => (
                  <button key={k} type="button" onClick={() => addStep(k)} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:border-accent">
                    <Plus size={12} /> {KIND_LABEL[k]}
                  </button>
                ))}
              </div>

              <ScheduleEditor schedule={draft.schedule ?? { every: 'off' }} onChange={(schedule) => change({ ...draft, schedule })} />
              <p className="text-[11px] text-ink-3">
                {describeSchedule(draft.schedule)}
                {next ? ` · next run ${next.toLocaleString()} while Semaphore is running` : ''}. Without Semaphore running, Windows Task Scheduler can run <code>Semaphore-CLI.bat pipeline run {id ?? pipelineId(draft.name)}</code> (docs/PIPELINES.md).
              </p>

              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <button type="button" onClick={() => void updateNow()} disabled={!!problem || draft.steps.length === 0 || live?.state === 'running'} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
                  <Play size={14} /> {live?.state === 'running' ? 'Updating…' : 'Update now'}
                </button>
                <label className="flex items-center gap-1 text-xs">
                  from
                  <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start at step" className="rounded border border-line bg-panel px-1.5 py-0.5">
                    <option value="">the first step</option>
                    {draft.steps.map((s, i) => (
                      <option key={s.id} value={s.id}>
                        step {i + 1} ({s.name ?? s.id})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force (import unchanged sources too)
                </label>
                {problem && <span className="text-xs text-warn">{problem}</span>}
              </div>
              {message && (
                <p role="status" className="text-xs text-ink-2" data-testid="pipeline-message">
                  {message}
                </p>
              )}

              {outputs.length > 0 && (
                <div className="text-xs">
                  <span className="font-semibold">Output tables: </span>
                  {outputs.map((t) => (
                    <button key={t} type="button" onClick={() => p.onProfile(LOCAL_SOURCE_ID, t)} title="Profile it into this page's catalog" className="mr-1 rounded border border-line px-1.5 py-0.5 font-mono hover:border-accent">
                      {t}
                    </button>
                  ))}
                </div>
              )}

              {runs.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-semibold">Run history ({runs.length})</summary>
                  <ul className="mt-1 space-y-1" aria-label="Run history">
                    {runs.map((r) => (
                      <li key={r.run} className="rounded border border-line px-2 py-1">
                        <span className={r.state === 'failed' ? 'text-bad' : r.state === 'done' ? 'text-good' : ''}>{r.state}</span> · {new Date(r.started).toLocaleString()} · {(r.ms / 1000).toFixed(1)} s · {r.trigger}
                        {r.error && <span className="block text-bad">{r.error}</span>}
                        <span className="block text-ink-3">{r.steps.map((s) => `${s.name || s.id}: ${s.state}${s.rows !== null ? ` (${s.rows})` : ''}`).join(' → ')}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const STATE_CLASS: Record<string, string> = { done: 'stroke-good', skipped: 'stroke-ink-3', failed: 'stroke-bad', running: 'stroke-accent', pending: 'stroke-line', 'not run': 'stroke-line', kept: 'stroke-line' };

/** The steps as boxes left to right with arrows; each shows the last run's state, rows and time. */
function NodeView({ steps, status }: { steps: PipelineStep[]; status: (id: string) => Status | undefined }) {
  if (steps.length === 0) return <p className="rounded-md border border-dashed border-line p-3 text-xs text-ink-3">No steps yet: add an Import, a Script, a Pull or a Publish below.</p>;
  const W = 150;
  const H = 66;
  const GAP = 36;
  const width = steps.length * W + (steps.length - 1) * GAP + 8;
  return (
    <div className="scroll-thin overflow-x-auto rounded-md border border-line bg-panel-2 p-2">
      <svg width={width} height={H + 8} viewBox={`0 0 ${width} ${H + 8}`} role="img" aria-label="Pipeline steps" data-testid="pipeline-nodes">
        <defs>
          <marker id="pipe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="fill-ink-3" />
          </marker>
        </defs>
        {steps.map((s, i) => {
          const x = 4 + i * (W + GAP);
          const st = status(s.id);
          const state = st?.state ?? 'pending';
          const detail = st?.state === 'failed' ? 'failed' : st && st.rows !== null && st.rows !== undefined ? `${st.rows.toLocaleString('en-US')} rows · ${st.ms ?? 0} ms` : st?.state === 'skipped' ? `unchanged · ${st.ms ?? 0} ms` : '';
          return (
            <g key={s.id} data-step={s.id} data-state={state}>
              <title>{`${s.name ?? s.id}: ${state}${st?.error ? ` - ${st.error}` : ''}`}</title>
              <rect x={x} y={4} width={W} height={H} rx={8} className={`fill-panel ${STATE_CLASS[state] ?? 'stroke-line'}`} strokeWidth={state === 'pending' || state === 'not run' || state === 'kept' ? 1 : 2.5} />
              <text x={x + 10} y={22} className="fill-ink-3 text-[10px]">
                {i + 1}. {KIND_LABEL[s.kind]}
              </text>
              <text x={x + 10} y={40} className="fill-ink text-[12px] font-semibold">
                {(s.name ?? ('table' in s ? s.table : s.kind === 'script' ? s.script : s.id)).slice(0, 18)}
              </text>
              <text x={x + 10} y={58} className={`text-[10px] ${state === 'failed' ? 'fill-bad' : state === 'done' ? 'fill-good' : 'fill-ink-3'}`}>
                {state}{detail && state !== 'failed' ? ` · ${detail}` : ''}
              </text>
              {i < steps.length - 1 && <line x1={x + W + 2} y1={4 + H / 2} x2={x + W + GAP - 4} y2={4 + H / 2} className="stroke-ink-3" strokeWidth={1.5} markerEnd="url(#pipe-arrow)" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StepEditor({ step: s, index, sources, scripts, uploads, onChange }: { step: PipelineStep; index: number; sources: ServerSource[]; scripts: SavedScriptItem[]; uploads: string[]; onChange: (s: PipelineStep) => void }) {
  const field = 'rounded border border-line bg-panel px-1.5 py-0.5';
  const n = index + 1;
  if (s.kind === 'import') {
    const where = s.s3 ? 's3' : s.upload !== undefined ? 'upload' : 'path';
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select value={where} onChange={(e) => { const v = e.target.value; const base = { id: s.id, kind: 'import' as const, table: s.table, ...(s.name ? { name: s.name } : {}) }; onChange(v === 's3' ? { ...base, s3: { bucket: '', key: '' } } : v === 'upload' ? { ...base, upload: uploads[0] ?? '' } : { ...base, path: '' }); }} aria-label={`Source of step ${n}`} className={field}>
          <option value="path">A file path or share</option>
          <option value="upload">An uploaded file</option>
          <option value="s3">Amazon S3</option>
        </select>
        {where === 'path' && <input value={s.path ?? ''} onChange={(e) => onChange({ ...s, path: e.target.value })} placeholder="C:\data\orders.csv or \\server\share\orders.csv" aria-label={`Path of step ${n}`} className={`min-w-0 flex-1 ${field}`} />}
        {where === 'upload' && (
          <select value={s.upload ?? ''} onChange={(e) => onChange({ ...s, upload: e.target.value })} aria-label={`Uploaded file of step ${n}`} className={field}>
            {uploads.length === 0 && <option value="">No kept uploads: tick "Keep for pipelines" when adding a file</option>}
            {uploads.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        )}
        {where === 's3' && (
          <>
            <input value={s.s3?.bucket ?? ''} onChange={(e) => onChange({ ...s, s3: { ...s.s3!, bucket: e.target.value } })} placeholder="bucket" aria-label={`S3 bucket of step ${n}`} className={`w-32 ${field}`} />
            <input value={s.s3?.key ?? s.s3?.prefix ?? ''} onChange={(e) => onChange({ ...s, s3: e.target.value.endsWith('/') ? { bucket: s.s3?.bucket ?? '', prefix: e.target.value } : { bucket: s.s3?.bucket ?? '', key: e.target.value } })} placeholder="key, or a prefix ending in /" aria-label={`S3 key of step ${n}`} className={`min-w-0 flex-1 ${field}`} />
          </>
        )}
        <label className="flex items-center gap-1">
          into
          <input value={s.table} onChange={(e) => onChange({ ...s, table: e.target.value })} aria-label={`Table of step ${n}`} className={`w-36 font-mono ${field}`} />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!s.force} onChange={(e) => onChange({ ...s, force: e.target.checked || undefined })} /> always import
        </label>
      </div>
    );
  }
  if (s.kind === 'script')
    return (
      <select value={s.script} onChange={(e) => onChange({ ...s, script: e.target.value })} aria-label={`Script of step ${n}`} className={field}>
        {scripts.length === 0 && <option value="">No saved scripts: save one in the SQL desk's Script mode</option>}
        {scripts.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name} ({x.id})
          </option>
        ))}
      </select>
    );
  if (s.kind === 'pull')
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <select value={s.source} onChange={(e) => onChange({ ...s, source: e.target.value })} aria-label={`Source of step ${n}`} className={field}>
            {sources.filter((x) => x.id !== LOCAL_SOURCE_ID).map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            into
            <input value={s.table} onChange={(e) => onChange({ ...s, table: e.target.value })} aria-label={`Table of step ${n}`} className={`w-36 font-mono ${field}`} />
          </label>
          <select value={s.mode ?? 'replace'} onChange={(e) => onChange({ ...s, mode: e.target.value as 'replace' | 'append' })} aria-label={`Mode of step ${n}`} className={field}>
            <option value="replace">replace the table</option>
            <option value="append">add the rows</option>
          </select>
        </div>
        <textarea value={s.sql} onChange={(e) => onChange({ ...s, sql: e.target.value })} rows={2} spellCheck={false} aria-label={`SELECT of step ${n}`} className={`block w-full font-mono ${field}`} />
        <p className="text-[11px] text-ink-3">One SELECT in the source's own SQL, run read-only through the normal query path.</p>
      </div>
    );
  return (
    <p className="text-[11px] text-ink-3">
      Marks the saved snapshots that read this pipeline's tables as out of date, so they are refreshed next (by an open page or "refresh run"). Regular report editions read the new tables when they are produced.
    </p>
  );
}

function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  const field = 'rounded border border-line bg-panel px-1.5 py-0.5';
  return (
    <fieldset className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-xs">
      <legend className="px-1 font-semibold">Schedule</legend>
      <select value={schedule.every} onChange={(e) => { const every = e.target.value as Schedule['every']; onChange(every === 'hourly' ? { every, minute: 0, ...(schedule.catchUp ? { catchUp: true } : {}) } : every === 'daily' ? { every, time: schedule.time ?? '06:00', ...(schedule.catchUp ? { catchUp: true } : {}) } : every === 'weekly' ? { every, time: schedule.time ?? '06:00', days: schedule.days?.length ? schedule.days : ['mon'], ...(schedule.catchUp ? { catchUp: true } : {}) } : { every }); }} aria-label="Runs" className={field}>
        <option value="off">Only when I click Update now</option>
        <option value="hourly">Every hour</option>
        <option value="daily">Every day</option>
        <option value="weekly">On some days of the week</option>
      </select>
      {schedule.every === 'hourly' && (
        <label className="flex items-center gap-1">
          at minute
          <input type="number" min={0} max={59} value={schedule.minute ?? 0} onChange={(e) => onChange({ ...schedule, minute: Math.max(0, Math.min(59, Math.round(Number(e.target.value) || 0))) })} aria-label="Minute past the hour" className={`w-16 ${field}`} />
        </label>
      )}
      {(schedule.every === 'daily' || schedule.every === 'weekly') && (
        <label className="flex items-center gap-1">
          at
          <input type="time" value={schedule.time ?? '06:00'} onChange={(e) => onChange({ ...schedule, time: e.target.value })} aria-label="Time of day" className={field} />
        </label>
      )}
      {schedule.every === 'weekly' &&
        WEEKDAYS.map((d) => (
          <label key={d} className="flex items-center gap-0.5 capitalize">
            <input type="checkbox" checked={schedule.days?.includes(d) ?? false} onChange={(e) => onChange({ ...schedule, days: e.target.checked ? [...(schedule.days ?? []), d] : (schedule.days ?? []).filter((x: Weekday) => x !== d) })} /> {d}
          </label>
        ))}
      {schedule.every !== 'off' && (
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!schedule.catchUp} onChange={(e) => onChange({ ...schedule, catchUp: e.target.checked || undefined })} /> Catch up: run once at start-up when a time was missed
        </label>
      )}
    </fieldset>
  );
}

// Messy data, cleaned with the analyst instead of by them: Semaphore checks a table, says what is
// wrong in plain words and proposes each fix as a sentence to accept or leave. Accepted steps live
// in the catalog and apply wherever the field is read; the data itself is never changed. The AI
// can look for abbreviations and misspellings, one field at a time, when the analyst asks.
// Relationships between tables are found the same way: proposed from names, checked on the data.

import { useState } from 'react';
import { Link2, ShieldCheck, Sparkles, Table2, Trash2, Undo2, Wand2, X } from 'lucide-react';
import type { Catalog, Field } from '../../../src/core/catalog.ts';
import type { CleaningStep } from '../../../src/core/cleaning.ts';
import type { IntelligenceProvider } from '../../../src/core/intelligence/contract.ts';
import { proposeCleaningWithAi } from '../../../src/core/intelligence/tasks.ts';
import { describeRelationship, type Relationship } from '../../../src/core/joins.ts';
import {
  checkRelationship,
  countValues,
  type Finding,
  findDuplicates,
  findIssues,
  proposeRelationship,
  relationshipCandidates,
  toValueCounts,
  type ValueCount,
  VALUES_CAP,
  valuesPlan,
  withoutMapEntry,
} from '../../../src/core/quality.ts';
import { type DataContext, runAnywhere } from '../lib/data.ts';
import { recordSkill } from '../lib/skills.ts';
import { EmptyState } from './EmptyState.tsx';

interface Props {
  catalog: Catalog;
  ctx: DataContext;
  provider: IntelligenceProvider;
  onCatalog: (c: Catalog) => void;
}

const tableId = (f: Field) => `${f.source}|${f.table}`;

async function valuesOf(ctx: DataContext, field: Field): Promise<{ values: ValueCount[]; partial: boolean }> {
  if (ctx.localSources.has(field.source)) {
    if (ctx.worker && ctx.workerTables?.has(field.table)) return { values: await ctx.worker.values(field.table, field.column), partial: false };
    const rows = ctx.local[field.table] ?? [];
    return { values: countValues(rows, field.column), partial: false };
  }
  const r = await runAnywhere(valuesPlan(ctx.index, field.key), ctx);
  return { values: toValueCounts(r.rows), partial: r.truncated || r.rows.length >= VALUES_CAP };
}

export function CleanTab({ catalog, ctx, provider, onCatalog }: Props) {
  const tables = [...new Map(catalog.fields.map((f) => [tableId(f), f])).values()];
  const [table, setTable] = useState(tables[0] ? tableId(tables[0]) : '');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, ValueCount[]>>({});
  const [aiNote, setAiNote] = useState<Record<string, string>>({});
  const steps = catalog.cleaning ?? [];
  const fieldsIn = catalog.fields.filter((f) => tableId(f) === table && (f.type === 'string' || f.type === 'number')).slice(0, 40);

  const accept = (step: CleaningStep, findingId?: string) => {
    onCatalog({ ...catalog, cleaning: [...steps, step] });
    recordSkill('clean');
    if (findingId) setFindings((all) => all?.filter((x) => x.id !== findingId) ?? null);
  };
  const undo = (id: string) => onCatalog({ ...catalog, cleaning: steps.filter((s) => s.id !== id) });

  const check = async () => {
    setFindings(null);
    const out: Finding[] = [];
    const seen: Record<string, ValueCount[]> = {};
    try {
      for (const [i, f] of fieldsIn.entries()) {
        setProgress(`Checking ${f.label} (${i + 1} of ${fieldsIn.length})…`);
        const { values: v, partial } = await valuesOf(ctx, f);
        seen[f.key] = v;
        out.push(...findIssues(ctx.index, f.key, v, { pageData: ctx.localSources.has(f.source), partial }));
      }
      const first = fieldsIn[0];
      if (first && ctx.localSources.has(first.source)) {
        const d = ctx.worker && ctx.workerTables?.has(first.table) ? await ctx.worker.duplicates(ctx.index.catalog, first.source, first.table) : findDuplicates(ctx.index, first.source, first.table, ctx.local[first.table] ?? []);
        if (d) out.push(d);
      }
      setValues(seen);
      setFindings(out);
      setProgress(null);
    } catch (e) {
      setProgress(`Could not check this table: ${(e as Error).message}`);
    }
  };

  const askAi = async (f: Field) => {
    setAiNote((n) => ({ ...n, [f.key]: `Asking ${provider.label}…` }));
    try {
      const r = await proposeCleaningWithAi(provider, f, values[f.key] ?? []);
      if (r.step) {
        const step = r.step;
        setFindings((all) => [
          ...(all ?? []),
          {
            id: step.id,
            field: f.key,
            kind: 'variants',
            problem: `${r.answeredBy ? `${r.answeredBy} (Fairlead's local fallback; the model asked for did not answer)` : provider.label} suggests these mean the same thing.`,
            examples: [],
            rows: 0,
            step,
          },
        ]);
      }
      setAiNote((n) => ({ ...n, [f.key]: r.step ? `Suggestion added below.${r.rejected.length ? ` ${r.rejected.length} part${r.rejected.length === 1 ? ' was' : 's were'} left out: ${r.rejected[0]}` : ''}` : 'Nothing found to merge.' }));
    } catch (e) {
      setAiNote((n) => ({ ...n, [f.key]: (e as Error).message }));
    }
  };

  const labelOf = (key: string) => catalog.fields.find((f) => f.key === key)?.label ?? key;
  const aiReady = provider.id !== 'local' && !!provider.runTask;

  if (tables.length === 0) return <EmptyState compact icon={Table2} headline="No tables to check yet." body="Add a CSV or profile a database table on the Sources tab, then check it here for messy values." />;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Check a table</h3>
        <p className="text-xs text-ink-2">Semaphore looks at each field's values for stray spaces, the same label spelt different ways, numbers kept as text, mixed date formats, blanks and repeated rows. Nothing changes until you accept a fix, and the data itself is never changed.</p>
        <div className="flex gap-2">
          <select value={table} onChange={(e) => (setTable(e.target.value), setFindings(null))} aria-label="Table" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs">
            {tables.map((f) => (
              <option key={tableId(f)} value={tableId(f)}>
                {f.table} ({catalog.sources.find((s) => s.id === f.source)?.label ?? f.source})
              </option>
            ))}
          </select>
          <button type="button" disabled={!table || progress?.startsWith('Checking') === true} onClick={check} className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-panel disabled:opacity-40">
            <Wand2 size={13} /> Check
          </button>
        </div>
        {progress && <p className="text-xs text-accent">{progress}</p>}
      </section>

      {findings && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">What Semaphore found</h3>
          {findings.length === 0 && <EmptyState compact tone="success" icon={ShieldCheck} headline="Clean bill of health." body="No stray spaces, duplicate labels or mixed dates in this table." />}
          {findings.map((x) => (
            <FindingCard key={x.id} finding={x} onAccept={(s) => accept(s, x.id)} onSkip={() => setFindings((all) => all?.filter((y) => y.id !== x.id) ?? null)} />
          ))}
          {aiReady && (
            <div className="space-y-1.5 rounded-lg border border-dashed border-line p-2">
              <p className="flex items-center gap-1 text-xs font-medium">
                <Sparkles size={13} className="text-accent" /> Ask the AI about abbreviations and misspellings
              </p>
              <p className="text-[11px] text-ink-3">Sends one field's distinct values and their counts (not rows, not other fields) to {provider.label}.</p>
              <div className="flex flex-wrap gap-1.5">
                {fieldsIn
                  .filter((f) => f.type === 'string' && (values[f.key]?.length ?? 0) > 1)
                  .map((f) => (
                    <button key={f.key} type="button" onClick={() => askAi(f)} className="rounded border border-line px-2 py-0.5 text-[11px] hover:border-accent">
                      {f.label}
                    </button>
                  ))}
              </div>
              {Object.entries(aiNote).map(([k, n]) => (
                <p key={k} className="text-[11px] text-ink-2">
                  {labelOf(k)}: {n}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Accepted fixes ({steps.length})</h3>
        {steps.length === 0 && <p className="text-xs text-ink-3">None yet.</p>}
        <ul className="space-y-1.5">
          {steps.map((s) => (
            <li key={s.id} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{s.sentence}</p>
                <p className="text-[11px] text-ink-3">
                  {labelOf(s.field)} · {s.origin === 'ai' ? 'suggested by AI' : s.origin === 'qlik' ? 'from the Qlik load script' : s.origin === 'analyst' ? 'by hand' : 'found by Semaphore'}
                </p>
              </div>
              <button type="button" onClick={() => undo(s.id)} title="Undo this fix" aria-label={`Undo: ${s.sentence}`} className="rounded p-1 text-ink-3 hover:text-bad">
                <Undo2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function FindingCard({ finding, onAccept, onSkip }: { finding: Finding; onAccept: (s: CleaningStep) => void; onSkip: () => void }) {
  const [step, setStep] = useState(finding.step);
  const entries = step.kind === 'map' ? Object.entries(step.map ?? {}).filter(([k]) => k === k.trim()) : [];
  return (
    <div className="space-y-1.5 rounded-lg border border-line p-2">
      <p className="text-sm">{finding.problem}</p>
      {finding.examples.length > 0 && step.kind !== 'map' && <p className="text-[11px] text-ink-3">For example: {finding.examples.join(', ')}</p>}
      {entries.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {entries.map(([from, to]) => (
            <li key={from} className="flex items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-[11px]">
              “{from}” → “{to}”
              <button type="button" aria-label={`Keep “${from}” as it is`} title="Leave this one as it is" onClick={() => setStep(withoutMapEntry(step, from))} className="text-ink-3 hover:text-bad">
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium text-ink-2">Fix: {step.sentence}</span>
        <button type="button" disabled={step.kind === 'map' && entries.length === 0} onClick={() => onAccept(step)} className="min-h-8 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel disabled:opacity-40">
          Accept
        </button>
        <button type="button" onClick={onSkip} className="min-h-8 rounded-md border border-line px-2.5 text-xs">
          Not now
        </button>
      </div>
    </div>
  );
}

export function RelationshipsTab({ catalog, ctx, onCatalog }: Omit<Props, 'provider'>) {
  const [found, setFound] = useState<Array<{ rel: Relationship; check: string }> | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rels = catalog.relationships ?? [];
  const keyFields = catalog.fields.filter((f) => f.type === 'string' || f.type === 'number');

  const test = async (a: Field, b: Field) => {
    const [x, y] = [await valuesOf(ctx, a), await valuesOf(ctx, b)];
    const check = checkRelationship(x.values, y.values);
    return { check, rel: proposeRelationship({ from: a, to: b }, check) };
  };

  const discover = async () => {
    setFound(null);
    const out: Array<{ rel: Relationship; check: string }> = [];
    try {
      const candidates = relationshipCandidates(ctx.index).slice(0, 30);
      for (const [i, c] of candidates.entries()) {
        setProgress(`Checking ${c.from.table}.${c.from.column} against ${c.to.table} (${i + 1} of ${candidates.length})…`);
        const { check, rel } = await test(c.from, c.to);
        if (rel) out.push({ rel, check: `${check.matched.toLocaleString('en-US')} of ${check.distinct.toLocaleString('en-US')} values match (${Math.round(check.match * 100)}%).` });
      }
      setFound(out);
      setProgress(out.length ? null : candidates.length ? 'No relationship held up against the data.' : 'No columns look like keys between tables.');
    } catch (e) {
      setProgress(`Could not check: ${(e as Error).message}`);
    }
  };

  const addManual = async () => {
    const a = catalog.fields.find((f) => f.key === from);
    const b = catalog.fields.find((f) => f.key === to);
    if (!a || !b) return;
    if (a.source !== b.source || a.table === b.table) {
      setProgress('A relationship joins two different tables of one source.');
      return;
    }
    setProgress('Checking against the data…');
    try {
      const { check, rel } = await test(a, b);
      if (!check.toUnique) setProgress(`${b.table}.${b.column} repeats values, so joining on it would count rows twice. Pick a column that identifies one row.`);
      else {
        const r: Relationship = rel ?? { id: `rel-${a.table}-${a.column}-${b.table}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), source: a.source, from: { table: a.table, column: a.column }, to: { table: b.table, column: b.column }, match: check.match };
        onCatalog({ ...catalog, relationships: [...rels.filter((x) => x.id !== r.id), { ...r, origin: 'analyst' }] });
        recordSkill('link');
        setProgress(`Added. ${Math.round(check.match * 100)}% of values match.`);
      }
    } catch (e) {
      setProgress(`Could not check: ${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">How tables connect ({rels.length})</h3>
        <p className="text-xs text-ink-2">A relationship lets a chart about one table (jobs) group or filter by another (the ship's class). Each row of the first belongs to one row of the second, so totals stay right.</p>
        {rels.length === 0 && <p className="text-xs text-ink-3">None yet.</p>}
        <ul className="space-y-1.5">
          {rels.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
              <Link2 size={14} className="text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{describeRelationship(r)}</p>
                <p className="text-[11px] text-ink-3">
                  {r.from.table} → {r.to.table}
                  {r.match !== undefined ? ` · ${Math.round(r.match * 100)}% of values match` : ''}
                  {r.origin === 'qlik' ? ' · from a Qlik association' : r.origin === 'dbt' ? ' · from the dbt project' : r.origin === 'powerbi' ? ' · from the Power BI model' : r.origin === 'discovered' ? ' · found by Semaphore' : ''}
                </p>
              </div>
              <button type="button" onClick={() => onCatalog({ ...catalog, relationships: rels.filter((x) => x.id !== r.id) })} aria-label={`Remove ${describeRelationship(r)}`} className="rounded p-1 text-ink-3 hover:text-bad">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <DrillPaths catalog={catalog} onCatalog={onCatalog} />

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Find relationships</h3>
        <button type="button" onClick={discover} className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-panel">
          <Wand2 size={13} /> Look for keys between tables
        </button>
        {progress && <p className="text-xs text-accent">{progress}</p>}
        {found?.map(({ rel, check }) => (
          <div key={rel.id} className="flex items-center gap-2 rounded-lg border border-line p-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{describeRelationship(rel)}</p>
              <p className="text-[11px] text-ink-3">{check}</p>
            </div>
            <button type="button" onClick={() => (onCatalog({ ...catalog, relationships: [...rels, rel] }), recordSkill('link'), setFound((f) => f?.filter((x) => x.rel.id !== rel.id) ?? null))} className="rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-panel">
              Add
            </button>
          </div>
        ))}
        <div className="space-y-1.5 rounded-lg border border-line p-2">
          <p className="text-xs font-medium">Or add one yourself</p>
          <div className="flex items-center gap-1.5 text-xs">
            <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Key column" className="min-w-0 flex-1 rounded border border-line bg-panel px-1 py-0.5">
              <option value="">Each row's key…</option>
              {keyFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.table}.{f.column}
                </option>
              ))}
            </select>
            <span className="text-ink-3">points at</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Identifying column" className="min-w-0 flex-1 rounded border border-line bg-panel px-1 py-0.5">
              <option value="">…one row of</option>
              {keyFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.table}.{f.column}
                </option>
              ))}
            </select>
            <button type="button" disabled={!from || !to} onClick={addManual} className="rounded-md border border-line px-2 py-0.5 disabled:opacity-40">
              Check and add
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Drill paths for categories: a click on a ship class shows its hulls, then the rows behind one. */
function DrillPaths({ catalog, onCatalog }: { catalog: Catalog; onCatalog: (c: Catalog) => void }) {
  const [levels, setLevels] = useState<string[]>(['', '']);
  const paths = catalog.hierarchies ?? [];
  const label = (k: string) => catalog.fields.find((f) => f.key === k)?.label ?? k;
  const choices = catalog.fields.filter((f) => f.type === 'string');
  const picked = levels.filter(Boolean);
  const add = () => {
    const id = `path-${picked.join('-')}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    onCatalog({ ...catalog, hierarchies: [...paths.filter((h) => h.id !== id), { id, label: picked.map(label).join(' → '), levels: picked }] });
    recordSkill('drill-path');
    setLevels(['', '']);
  };
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3">Drill paths ({paths.length})</h3>
      <p className="text-xs text-ink-2">For flags set to drill: clicking a value shows the next level down, and the last level shows the rows. Dates drill year → quarter → month → day on their own.</p>
      <ul className="space-y-1.5">
        {paths.map((h) => (
          <li key={h.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1">{h.levels.map(label).join(' → ')}</span>
            <button type="button" onClick={() => onCatalog({ ...catalog, hierarchies: paths.filter((x) => x.id !== h.id) })} aria-label={`Remove drill path ${h.label}`} className="rounded p-1 text-ink-3 hover:text-bad">
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {levels.map((v, i) => (
          <select key={i} value={v} onChange={(e) => setLevels((l) => l.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Level ${i + 1}`} className="min-w-0 flex-1 rounded border border-line bg-panel px-1 py-0.5">
            <option value="">{i === 0 ? 'Broadest…' : 'then…'}</option>
            {choices.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label} ({f.table})
              </option>
            ))}
          </select>
        ))}
        {levels.length < 5 && (
          <button type="button" onClick={() => setLevels((l) => [...l, ''])} className="rounded border border-line px-1.5 py-0.5">
            + level
          </button>
        )}
        <button type="button" disabled={picked.length < 2 || new Set(picked).size !== picked.length} onClick={add} className="rounded-md bg-accent px-2 py-0.5 font-semibold text-panel disabled:opacity-40">
          Add path
        </button>
      </div>
    </section>
  );
}

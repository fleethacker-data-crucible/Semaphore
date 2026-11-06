// The selected flag, side panel: its brief (highlighted as it is understood), the draft it
// produced in plain English, why Semaphore is or is not sure, what is worth a look, and the
// controls an analyst reaches for most. The binding and SQL are a click away, never in the way.

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Flag as FlagIcon, MessagesSquare, Sparkles, Trash2, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Selections } from '../../../src/core/crossfilter.ts';
import { describeFlag } from '../../../src/core/describe.ts';
import type { Behavior, Flag, FlagKind, Hoist } from '../../../src/core/hoist.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { annotateBrief, type Suggestion, usedKinds } from '../../../src/core/intelligence/annotate.ts';
import { flushAccepts, shortDate, useReviewedAt } from '../lib/accept.ts';
import type { DataContext } from '../lib/data.ts';
import { noteGrammarUsed } from '../lib/onboarding.ts';
import { BriefEditor, BriefHints, BriefLegend, Understood } from './BriefEditor.tsx';
import { useFlagResult } from './FlagCard.tsx';
import { KIND_META } from './Palette.tsx';

export interface InspectorProps {
  hoist: Hoist;
  flag: Flag;
  ctx: DataContext;
  index: CatalogIndex;
  selections: Selections;
  busy: boolean;
  autoKind: boolean;
  onAutoKind: (on: boolean) => void;
  onChange: (patch: Partial<Flag>, group?: string) => void;
  onDraft: () => void;
  onAccept: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
  onLearn: (word: string, s: Suggestion) => void;
  /** Open the leadership view (shown with an accepted flag: "See it as leadership will"). */
  onSeeAsLeadership?: () => void;
}

const KINDS: FlagKind[] = ['kpi', 'bar', 'line', 'area', 'pie', 'table', 'filter', 'text'];

export function Inspector(p: InspectorProps) {
  const { flag, hoist, index } = p;
  const [details, setDetails] = useState(false);
  const load = useFlagResult(hoist, flag, p.selections, p.ctx);
  const result = load.state === 'ready' ? load.result : undefined;
  const insights = useMemo(
    () => (result ? findInsights({ flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals, today: p.ctx.today }, index) : []),
    [result, flag, index, p.ctx.today],
  );
  const reasons = useMemo(() => annotateBrief(flag.brief, index).reasons, [flag.brief, index]);
  // Only fields in the table this flag reads can affect it.
  const firstMetric = flag.binding?.metrics[0] ? index.metric(flag.binding.metrics[0]) : undefined;
  const table = firstMetric ? (firstMetric.field ? index.field(firstMetric.field)?.table : firstMetric.table) : flag.binding?.dimensions[0] ? index.field(flag.binding.dimensions[0].field)?.table : undefined;
  const fields = index.catalog.fields.filter((f) => table === undefined || f.table === table);
  const setBehavior = (b: Partial<Behavior>) => p.onChange({ behavior: { ...flag.behavior, ...b } });
  const reviewedAt = useReviewedAt(hoist.id, flag.id);
  const briefId = `brief-${flag.id}`;
  // Drafting counts as using each construction in the brief: hints for them fade after a few uses.
  const draft = () => {
    noteGrammarUsed(usedKinds(annotateBrief(flag.brief, index)));
    p.onDraft();
  };
  // An empty flag opens with its brief ready to type in, unless the analyst is moving through the
  // cards with the keyboard (focus stays on the card; Enter comes here).
  useEffect(() => {
    if (flag.status !== 'empty' || flag.kind === 'text') return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest('[data-flag-card]') && active.matches(':focus-visible')) return;
    (document.getElementById(briefId) as HTMLTextAreaElement | null)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <aside
      id="flag-inspector"
      aria-label="Flag inspector"
      onKeyDown={(e) => {
        // Escape from a field goes back to the flag's card, so the keyboard picks up where it was.
        if (e.key === 'Escape' && e.target !== e.currentTarget && (e.target as HTMLElement).matches('input, textarea, select')) {
          e.preventDefault();
          document.querySelector<HTMLElement>(`[data-flag-card="${CSS.escape(flag.id)}"]`)?.focus();
        }
      }}
      className="scroll-thin flex h-full w-[360px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <input
          value={flag.title}
          onChange={(e) => p.onChange({ title: e.target.value.slice(0, 200) }, `title-${flag.id}`)}
          placeholder="Title"
          aria-label="Flag title"
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-base font-semibold hover:border-line focus:border-accent focus:outline-none"
        />
        <button type="button" onClick={p.onClose} aria-label="Close inspector" className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 hover:bg-panel-2">
          <X size={16} />
        </button>
      </div>

      <div className="space-y-4 px-4 py-3">
        {flag.kind === 'text' ? (
          <section className="space-y-1.5">
            <label htmlFor="note" className="text-xs font-semibold text-ink-2">
              Note
            </label>
            <textarea
              id="note"
              value={flag.text ?? ''}
              rows={6}
              onChange={(e) => p.onChange({ text: e.target.value.slice(0, 20000) }, `text-${flag.id}`)}
              className="w-full rounded-lg border border-line bg-panel p-2 text-sm focus:border-accent focus:outline-none"
            />
          </section>
        ) : (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs font-semibold text-ink-2">What should this flag show?</h3>
              <span className="text-[11px] text-ink-2">Enter to draft{flag.status === 'drafted' ? ' · Ctrl+Enter to accept' : ' · Shift+Enter for a new line'}</span>
            </div>
            <BriefEditor
              value={flag.brief}
              onChange={(v) => p.onChange({ brief: v }, `brief-${flag.id}`)}
              index={index}
              label="Flag brief"
              placeholder="e.g. Monthly labor cost vs last year. Turn red over $500K."
              onSubmit={draft}
              {...(flag.status === 'drafted' ? { onCtrlEnter: p.onAccept } : {})}
              onLearn={p.onLearn}
              id={briefId}
            />
            <Understood value={flag.brief} index={index} />
            <BriefHints value={flag.brief} index={index} onChange={(v) => p.onChange({ brief: v }, `brief-${flag.id}`)} briefId={briefId} />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={draft}
                disabled={p.busy || !flag.brief.trim()}
                className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-panel hover:opacity-90 disabled:opacity-40"
              >
                <Sparkles size={14} /> {flag.binding ? 'Redraft' : 'Draft'}
              </button>
              {flag.status === 'drafted' && (
                <button type="button" onClick={p.onAccept} title="Accept this draft (A, or Ctrl+Enter in the brief)" className="flex h-8 items-center gap-1 rounded-lg border border-[var(--fl-control-border)] px-3 text-sm hover:border-good hover:text-good">
                  <Check size={14} /> Accept
                </button>
              )}
              <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-2" title="Let Semaphore pick the chart from the shape of the data">
                <input type="checkbox" checked={p.autoKind} onChange={(e) => p.onAutoKind(e.target.checked)} />
                Pick chart for me
              </label>
            </div>
            {flag.status === 'ready' && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-brass-soft px-2.5 py-1.5 text-xs text-ink">
                <FlagIcon size={13} className="text-brass" aria-hidden="true" />
                <span className="font-medium">{reviewedAt ? `Reviewed · ${shortDate(new Date(reviewedAt))}` : 'Reviewed'}</span>
                {flag.learn !== false && !hoist.experiment && <span className="text-ink-2">Leadership can ask for it.</span>}
                {p.onSeeAsLeadership && flag.learn !== false && !hoist.experiment && (
                  <button type="button" onClick={() => void flushAccepts().then(p.onSeeAsLeadership)} className="ml-auto flex h-8 items-center gap-1 rounded-md px-1.5 font-medium text-accent hover:bg-panel">
                    <MessagesSquare size={13} aria-hidden="true" /> See it as leadership will
                  </button>
                )}
              </div>
            )}
            <BriefLegend />
            <label className="flex items-center gap-1.5 text-xs text-ink-2" title="Accepted flags go into the playbook, so leadership can ask for them in the Ask view">
              <input type="checkbox" checked={flag.learn !== false} onChange={(e) => p.onChange({ learn: e.target.checked ? undefined : false })} />
              Leadership can ask for this once accepted
            </label>
          </section>
        )}

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-ink-2">Show as</h3>
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Flag kind">
            {KINDS.map((k) => {
              const Icon = KIND_META[k].icon;
              const on = flag.kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    p.onAutoKind(false);
                    p.onChange({ kind: k });
                  }}
                  className={`flex flex-col items-center gap-0.5 rounded-md border px-1 py-1.5 text-[11px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:border-accent'}`}
                >
                  <Icon size={15} />
                  {KIND_META[k].label}
                </button>
              );
            })}
          </div>
        </section>

        {flag.kind !== 'text' && (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-ink-2">In plain English</h3>
            <p className="text-sm leading-relaxed text-ink">{describeFlag(flag, hoist, index).join(' ')}</p>
          </section>
        )}

        {flag.status === 'drafted' && flag.confidence !== undefined && (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-ink-2">
              How sure: <span className={flag.confidence < 0.6 ? 'text-warn' : 'text-good'}>{Math.round(flag.confidence * 100)}%</span>
            </h3>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </section>
        )}

        {insights.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-ink-2">Worth a look</h3>
            <ul className="space-y-1 text-xs">
              {insights.map((i) => (
                <li key={i.text} className={`rounded-md px-2 py-1 ${i.tone === 'bad' ? 'bg-bad-soft text-bad' : i.tone === 'warn' ? 'bg-warn-soft text-ink' : 'bg-panel-2 text-ink'}`}>
                  {i.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(flag.notes.length > 0 || (result?.plan.notes.length ?? 0) > 0) && (
          <section className="space-y-1">
            <h3 className="text-xs font-semibold text-ink-2">Notes</h3>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
              {[...flag.notes, ...(result?.plan.notes ?? [])].map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
        )}

        {flag.kind !== 'text' && flag.kind !== 'filter' && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-ink-2">Behaviour</h3>
            <label className="flex items-center justify-between gap-2 text-xs">
              <span>Clicking a value</span>
              <select
                value={flag.behavior.onClick}
                onChange={(e) => setBehavior({ onClick: e.target.value as Behavior['onClick'] })}
                className="rounded-md border border-line bg-panel px-2 py-1 text-xs"
              >
                <option value="none">does nothing</option>
                <option value="filter-page">filters the page</option>
                <option value="drill">drills down (dates, or a drill path under Data &gt; Links)</option>
              </select>
            </label>
            <div className="text-xs">
              <p className="mb-1">Ignore page selections on</p>
              <div className="flex flex-wrap gap-1">
                {fields
                  .filter((f) => f.type !== 'number')
                  .slice(0, 30)
                  .map((f) => {
                    const on = flag.behavior.ignore.includes(f.key);
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setBehavior({ ignore: on ? flag.behavior.ignore.filter((k) => k !== f.key) : [...flag.behavior.ignore, f.key] })}
                        className={`rounded-full border px-2 py-0.5 ${on ? 'border-brass bg-brass-soft text-ink' : 'border-line text-ink-3 hover:border-brass'}`}
                      >
                        {f.label}
                      </button>
                    );
                  })}
              </div>
            </div>
          </section>
        )}

        <section>
          <button type="button" onClick={() => setDetails((d) => !d)} className="text-xs font-semibold text-accent" aria-expanded={details}>
            {details ? 'Hide' : 'Show'} binding and SQL
          </button>
          {details && (
            <div className="mt-2 space-y-2">
              <pre className="scroll-thin max-h-56 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[11px]">{JSON.stringify({ binding: flag.binding, behavior: flag.behavior }, null, 2)}</pre>
              {result?.sql && <pre className="whitespace-pre-wrap break-words rounded-md bg-panel-2 p-2 font-mono text-[11px]">{result.sql.sql}</pre>}
              {result && (
                <p className="text-[11px] text-ink-3">
                  {result.display.rows.length} rows shown · {result.origin === 'page' ? 'answered in this page' : 'from the server'} in {result.ms} ms
                  {result.plan.slices.length ? ` · pre-split by ${result.plan.slices.length} page field${result.plan.slices.length > 1 ? 's' : ''}` : ''}
                </p>
              )}
            </div>
          )}
        </section>

        <div className="flex gap-2 border-t border-line pt-3">
          <button type="button" onClick={p.onDuplicate} title="Duplicate (D)" className="flex h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
            <Copy size={13} /> Duplicate
          </button>
          <button type="button" onClick={p.onDelete} title="Delete (Delete key)" className="flex h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-bad hover:text-bad">
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    </aside>
  );
}

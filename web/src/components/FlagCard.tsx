// One flag on the hoist: a header with its title and state, its face (the data), and its back
// (what it shows in plain English, why Semaphore drafted it that way, and the SQL it runs).

import { memo, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, FlipHorizontal2, GripHorizontal, Lightbulb, Loader2, RefreshCcw, Sparkles } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import { describeFlag } from '../../../src/core/describe.ts';
import type { Flag, Hoist } from '../../../src/core/hoist.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { ApprovalNeeded, approveQuery, computeFlag, type DataContext, type FlagResult } from '../lib/data.ts';
import { FlagView } from './FlagView.tsx';

export interface FlagCardProps {
  hoist: Hoist;
  flag: Flag;
  ctx: DataContext;
  index: CatalogIndex;
  selections: Selections;
  selected: boolean;
  themeKey: string;
  onSelectFlag: (id: string) => void;
  onSelectValue: (key: string, value: Cell, additive: boolean) => void;
  onAccept: (id: string) => void;
  onDragStart: (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => void;
}

type Load = { state: 'idle' } | { state: 'loading'; last?: FlagResult } | { state: 'ready'; result: FlagResult } | { state: 'error'; error: string; approve?: () => void };

function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Only the selections that can change this flag's numbers, so unrelated clicks do not reload it. */
function relevant(selections: Selections, flag: Flag): string {
  const out: Selections = {};
  for (const [k, v] of Object.entries(selections)) if (v.length && !flag.behavior.ignore.includes(k.split('@')[0]!)) out[k] = v;
  return JSON.stringify(out);
}

export function useFlagResult(hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext): Load {
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const selKey = relevant(selections, flag);
  const planKey = JSON.stringify([flag.kind, flag.binding, flag.behavior.ignore, hoist.filters, hoist.flags.map((f) => [f.id, f.kind, f.behavior.onClick, f.binding?.dimensions])]);
  useEffect(() => {
    if (!flag.binding || flag.kind === 'text') {
      setLoad({ state: 'idle' });
      return;
    }
    let live = true;
    setLoad((l) => ({ state: 'loading', ...(l.state === 'ready' ? { last: l.result } : l.state === 'loading' && l.last ? { last: l.last } : {}) }));
    computeFlag(hoist, flag, selections, ctx).then(
      (result) => live && setLoad({ state: 'ready', result }),
      (e: Error) => {
        if (!live) return;
        // A lake query the cost guard is holding: the card asks, and Run approves and retries it.
        if (e instanceof ApprovalNeeded) {
          setLoad({ state: 'error', error: e.message, approve: () => { approveQuery(e.key); setAttempt((a) => a + 1); } });
        } else setLoad({ state: 'error', error: e.message });
      },
    );
    return () => {
      live = false;
    };
    // Recompute on what changes the numbers, not on every new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, selKey, ctx, attempt]);
  return load;
}

function FlagCardInner({ hoist, flag, ctx, index, selections, selected, themeKey, onSelectFlag, onSelectValue, onAccept, onDragStart }: FlagCardProps) {
  const [flipped, setFlipped] = useState(false);
  const load = useFlagResult(hoist, flag, selections, ctx);
  const result = load.state === 'ready' ? load.result : load.state === 'loading' ? load.last : undefined;
  const insights = useMemo(
    () => (result && flag.kind !== 'filter' ? findInsights({ flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals, today: ctx.today }, index) : []),
    [result, flag, index, ctx.today],
  );
  const lowConfidence = flag.status === 'drafted' && (flag.confidence ?? 1) < 0.6;

  return (
    <article
      aria-label={flag.title || 'Untitled flag'}
      onDoubleClick={() => onSelectFlag(flag.id)}
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl border bg-panel shadow-sm transition-shadow ${selected ? 'border-accent shadow-md ring-2 ring-accent/25' : 'border-line hover:shadow-md'} ${flag.status === 'drafted' ? 'border-dashed' : ''}`}
    >
      <header className="flex cursor-pointer items-center gap-1.5 px-3 pt-2" onClick={(e) => e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'H3' ? onSelectFlag(flag.id) : undefined}>
        <button
          type="button"
          aria-label="Move flag"
          title="Drag to move"
          onPointerDown={(e) => onDragStart(e, flag.id, 'move')}
          className="-ml-1 cursor-grab touch-none rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing"
        >
          <GripHorizontal size={14} />
        </button>
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink" title={`${flag.title} (click to edit)`}>
          {flag.title || <span className="font-normal text-ink-3">Untitled flag</span>}
        </h3>
        {load.state === 'loading' && <Loader2 size={13} className="animate-spin text-ink-3" aria-label="Loading" />}
        {result?.lake && (
          <span
            title={[result.lake.cached ? `From the lake cache, taken ${result.lake.asOf ?? ''}: no scan, no cost.` : `Athena read ${formatBytes(result.lake.scannedBytes ?? 0)} for this flag.`, ...result.lake.warnings].join(' ')}
            className={`text-[10px] ${result.lake.warnings.length ? 'text-warn' : 'text-ink-3'}`}
          >
            {result.lake.cached ? 'cached' : formatBytes(result.lake.scannedBytes ?? 0)}
          </span>
        )}
        {result?.requeried.length ? (
          <span title="This flag asked its source again for the current selection" className="text-ink-3">
            <RefreshCcw size={12} />
          </span>
        ) : null}
        {result?.display.truncated && (
          <span title="The result hit the row cap, so totals may be incomplete" className="text-warn">
            <AlertTriangle size={13} />
          </span>
        )}
        {flag.status === 'drafted' && (
          <span className="flex items-center gap-1">
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${lowConfidence ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent'}`}
              title={`Drafted by Semaphore${flag.confidence !== undefined ? `, ${Math.round(flag.confidence * 100)}% sure` : ''}. Flip it over to check, then accept.`}
            >
              {lowConfidence ? 'Verify' : 'Draft'}
              {flag.confidence !== undefined ? ` ${Math.round(flag.confidence * 100)}%` : ''}
            </span>
            <button type="button" onClick={() => onAccept(flag.id)} className="rounded p-0.5 text-ink-3 hover:bg-good-soft hover:text-good" aria-label="Accept draft" title="Accept this draft">
              <Check size={14} />
            </button>
          </span>
        )}
        {insights.length > 0 && !flipped && (
          <span className="text-brass" title={insights.map((i) => i.text).join('\n')}>
            <Lightbulb size={13} />
          </span>
        )}
        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          className={`rounded p-0.5 hover:bg-panel-2 ${flipped ? 'text-accent' : 'text-ink-3'}`}
          aria-pressed={flipped}
          aria-label={flipped ? 'Show the data' : 'Flip over: what this shows and the SQL'}
          title={flipped ? 'Show the data' : 'Flip over: what this shows and the SQL'}
        >
          <FlipHorizontal2 size={14} />
        </button>
      </header>
      <div key={flipped ? 'back' : 'front'} className={`relative min-h-0 flex-1 px-3 pb-2 pt-1 ${flipped ? 'flip-enter' : ''}`}>
        {flipped ? (
          <Back flag={flag} hoist={hoist} index={index} result={result} insights={insights.map((i) => i.text)} />
        ) : flag.kind === 'text' ? (
          <p className="scroll-thin h-full overflow-auto whitespace-pre-wrap text-sm text-ink-2">{flag.text || flag.brief || 'Write a note in the inspector.'}</p>
        ) : !flag.binding ? (
          <div className="h-full" onClick={() => onSelectFlag(flag.id)}>
            <Empty flag={flag} />
          </div>
        ) : load.state === 'error' ? (
          load.approve ? (
            <div className="flex flex-col items-start gap-2 text-xs">
              <p className="flex items-start gap-2 text-warn">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                {load.error}
              </p>
              <button type="button" onClick={load.approve} className="rounded-md bg-accent px-2.5 py-1 font-semibold text-panel">
                Run it
              </button>
            </div>
          ) : (
            <p className="flex items-start gap-2 text-xs text-bad">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {load.error}
            </p>
          )
        ) : result ? (
          <div className="flex h-full flex-col gap-1">
            <div className="min-h-0 flex-1">
              <FlagView flag={flag} result={result} index={index} selections={selections} onSelect={onSelectValue} themeKey={themeKey} />
            </div>
            {insights[0] && flag.layout.h >= 4 && <p className="truncate text-[11px] text-ink-2" title={insights.map((i) => i.text).join('\n')}>{insights[0].text}</p>}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Resize flag"
        title="Drag to resize"
        onPointerDown={(e) => onDragStart(e, flag.id, 'resize')}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize touch-none opacity-0 group-hover:opacity-100"
        style={{ background: 'linear-gradient(135deg, transparent 50%, var(--line) 50%)', borderBottomRightRadius: 12 }}
      />
    </article>
  );
}

export const FlagCard = memo(FlagCardInner);

function Empty({ flag }: { flag: Flag }) {
  return (
    <div className="flex h-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line text-center text-xs text-ink-3 hover:border-accent hover:text-accent">
      <Sparkles size={18} />
      <p className="text-sm font-medium">{flag.brief ? 'Not drafted yet' : 'Say what this flag should show'}</p>
      <p className="max-w-sm text-[11px]">{flag.notes[flag.notes.length - 1] ?? 'Click here, then describe it in plain English: "top 10 hulls by labor cost", "which region has the most open work?"'}</p>
    </div>
  );
}

function Back({ flag, hoist, index, result, insights }: { flag: Flag; hoist: Hoist; index: CatalogIndex; result: FlagResult | undefined; insights: string[] }) {
  return (
    <div className="scroll-thin h-full space-y-2 overflow-auto text-xs">
      <section>
        <h4 className="mb-0.5 font-semibold text-ink-2">What it shows</h4>
        <p className="text-ink">{describeFlag(flag, hoist, index).join(' ')}</p>
      </section>
      {insights.length > 0 && (
        <section>
          <h4 className="mb-0.5 font-semibold text-ink-2">Worth a look</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-ink">
            {insights.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      )}
      {(flag.notes.length > 0 || (result?.plan.notes.length ?? 0) > 0) && (
        <section>
          <h4 className="mb-0.5 font-semibold text-ink-2">Notes</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-ink-2">
            {[...flag.notes, ...(result?.plan.notes ?? [])].map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      )}
      {result?.sql && (
        <section>
          <h4 className="mb-0.5 font-semibold text-ink-2">
            SQL <span className="font-normal text-ink-3">({result.sql.dialect}{result.origin === 'page' ? ', answered in this page' : ''})</span>
          </h4>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-panel-2 p-2 font-mono text-[11px] text-ink">{prettySql(result.sql.sql)}</pre>
          {result.sql.params.length > 0 && (
            <p className="mt-1 font-mono text-[11px] text-ink-3">
              Parameters: {result.sql.params.map((p, i) => `${i + 1}=${JSON.stringify(p.value)} (${p.type})`).join(', ')}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function prettySql(sql: string): string {
  return sql.replace(/ (FROM|WHERE|GROUP BY|ORDER BY|LIMIT|FETCH FIRST) /g, '\n$1 ');
}

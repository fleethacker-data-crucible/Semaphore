// One flag on the hoist: a header with its title and state, its face (the data), and its back
// (what it shows in plain English, why Semaphore drafted it that way, and the SQL it runs).
//
// A card is a keyboard stop in reading order: focusing it selects it, and its handles show while
// it holds focus. It redraws only when its own numbers can change (lib/relevance.ts): `hoist` is
// the planning slice of the page, and `selections` only those this flag can use.

import { Component, type ReactNode, memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CHART_KINDS } from '../../../src/core/kinds.ts';
import { AlertTriangle, ArrowUpLeft, Check, FlipHorizontal2, Flag as FlagIcon, GripHorizontal, Lightbulb, Loader2, RefreshCcw, Sparkles, Table2 } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import { describeFlag } from '../../../src/core/describe.ts';
import { dimensionKey, type Flag, type Hoist } from '../../../src/core/hoist.ts';
import { type DrillStep, drillLabel, drillView, nextLevel } from '../../../src/core/drill.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { shortDate, useReviewedAt } from '../lib/accept.ts';
import { ApprovalNeeded, approveQuery, computeFlag, type DataContext, type FlagResult } from '../lib/data.ts';
import { toggleFlipped, useFlipped } from '../lib/flag-keys.ts';
import { forgetFlagLive, noteFlagLive } from '../lib/flag-live.ts';
import { markStep } from '../lib/onboarding.ts';
import { cachedSliceKey, flagKeys, relevantSelections } from '../lib/relevance.ts';
import { recordSkill } from '../lib/skills.ts';
import { type HoistDesign, resolveStyle } from '../../../src/core/design.ts';
import { FlagView, ModelView } from './FlagView.tsx';
import { dialectName, shownSql, sqlLanguage } from '../lib/sql-language.ts';
import { useSqlPref } from '../lib/sql-pref.ts';

export interface FlagCardProps {
  /** The page as planning sees it (lib/relevance.ts planSlice): the same object while that is unchanged. */
  hoist: Hoist;
  flag: Flag;
  ctx: DataContext;
  index: CatalogIndex;
  /** Only the selections this flag can use (lib/relevance.ts). */
  selections: Selections;
  selected: boolean;
  themeKey: string;
  /** The page's design; kept apart from `hoist`, which only changes when planning does. */
  design?: HoistDesign;
  onSelectFlag: (id: string) => void;
  onSelectValue: (key: string, value: Cell, additive: boolean) => void;
  onAccept: (id: string) => void;
  onDragStart: (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => void;
}

type Load = { state: 'idle' } | { state: 'loading'; last?: FlagResult } | { state: 'ready'; result: FlagResult } | { state: 'error'; error: string; approve?: () => void };

const CHART_KIND_SET = new Set<string>(CHART_KINDS);

function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * A flag's numbers for the current page. Recomputes only when the plan or a selection this flag can
 * use changes; a result already in the cache arrives without a loading flash.
 */
export function useFlagResult(hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext): Load {
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  // The page part of the key is worked out once per hoist object, however many cards ask (#83).
  const sliceKey = cachedSliceKey(hoist);
  const planKey = useMemo(() => JSON.stringify([flag.id, flag.kind, flag.binding, flag.behavior.ignore, sliceKey]), [flag.id, flag.kind, flag.binding, flag.behavior.ignore, sliceKey]);
  // Asked again once a result is in: a flag over several tables plans only after that code has loaded (planner.ts loadAcross).
  const ready = load.state === 'ready';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const relevant = useMemo(() => relevantSelections(selections, flagKeys(hoist, sliceKey, flag, ctx.index), flag.behavior), [selections, hoist, sliceKey, flag, ctx.index, ready]);
  const selKey = JSON.stringify(relevant);
  useEffect(() => {
    if (!flag.binding || flag.kind === 'text') {
      setLoad({ state: 'idle' });
      return;
    }
    let live = true;
    let settled = false;
    // Show "loading" only when the answer does not come straight from the cache.
    const slow = window.setTimeout(() => {
      if (live && !settled) setLoad((l) => ({ state: 'loading', ...(l.state === 'ready' ? { last: l.result } : l.state === 'loading' && l.last ? { last: l.last } : {}) }));
    }, 0);
    computeFlag(hoist, flag, relevant, ctx).then(
      (result) => {
        settled = true;
        if (live) setLoad({ state: 'ready', result });
      },
      (e: Error) => {
        settled = true;
        if (!live) return;
        // A lake query the cost guard is holding: the card asks, and Run approves and retries it.
        if (e instanceof ApprovalNeeded) {
          setLoad({ state: 'error', error: e.message, approve: () => { approveQuery(e.key); setAttempt((a) => a + 1); } });
        } else setLoad({ state: 'error', error: e.message });
      },
    );
    return () => {
      live = false;
      window.clearTimeout(slow);
    };
    // Recompute on what changes the numbers, not on every new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, selKey, ctx, attempt]);
  return load;
}

function FlagCardInner({ hoist, flag: own, ctx, index, selections, selected, themeKey, design, onSelectFlag, onSelectValue, onAccept, onDragStart }: FlagCardProps) {
  const flipped = useFlipped(own.id);
  const [asTable, setAsTable] = useState(false);
  // Drilling narrows this flag only, for as long as the page is open; the flag itself is unchanged.
  const [drill, setDrill] = useState<DrillStep[]>([]);
  const bindingKey = JSON.stringify(own.binding);
  useEffect(() => setDrill([]), [bindingKey]);
  const view = useMemo(() => drillView(own, drill, index), [own, drill, index]);
  const flag = view.flag;
  const drills = own.behavior.onClick === 'drill' && !view.detail && !!flag.binding?.dimensions[0] && nextLevel(index, flag.binding.dimensions[0]) !== null;
  const onPick = (key: string, value: Cell, additive: boolean) => {
    const d = flag.binding?.dimensions.find((x) => dimensionKey(x) === key);
    if (drills && d && d === flag.binding?.dimensions[0]) setDrill((s) => [...s, { field: d.field, ...(d.grain ? { grain: d.grain } : {}), value }]);
    else if (own.behavior.onClick !== 'drill') onSelectValue(key, value, additive);
  };
  const load = useFlagResult(hoist, flag, selections, ctx);
  const result = load.state === 'ready' ? load.result : load.state === 'loading' ? load.last : undefined;
  const insights = useMemo(
    () => (result && flag.kind !== 'filter' ? findInsights({ flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals, today: ctx.today }, index) : []),
    [result, flag, index, ctx.today],
  );
  // What this card shows, for the assistant's page outline (lib/flag-live.ts).
  const loadError = load.state === 'error' ? load.error : undefined;
  useEffect(() => {
    noteFlagLive(own.id, { ...(result ? { result } : {}), ...(loadError ? { error: loadError } : {}), insights: insights.map((i) => i.text) });
  }, [own.id, result, loadError, insights]);
  useEffect(() => () => forgetFlagLive(own.id), [own.id]);
  const sqlPref = useSqlPref();
  const hasResult = result !== undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const described = useMemo(() => (flag.kind === 'text' ? '' : describeFlag(flag, hoist, index).join(' ')), [flag, hoist, index, hasResult]);
  const descId = useId();
  const lowConfidence = flag.status === 'drafted' && (flag.confidence ?? 1) < 0.6;
  const reviewedAt = useReviewedAt(hoist.id, own.id);

  // The moments this card sees happen: a first draft (shakedown step 2) and an accept (the brass
  // flag runs up, once, in 180 ms or less; not at all under reduced motion).
  const prev = useRef({ bound: !!own.binding, status: own.status });
  const [justAccepted, setJustAccepted] = useState(false);
  useEffect(() => {
    const was = prev.current;
    if (!was.bound && own.binding && own.status === 'drafted') {
      markStep('describe');
      recordSkill('draft', { hoistId: hoist.id, flagId: own.id });
    }
    if (was.status !== 'ready' && own.status === 'ready' && own.kind !== 'text') {
      setJustAccepted(true);
      const t = window.setTimeout(() => setJustAccepted(false), 400);
      prev.current = { bound: !!own.binding, status: own.status };
      return () => window.clearTimeout(t);
    }
    prev.current = { bound: !!own.binding, status: own.status };
    return undefined;
  }, [own.binding, own.status, own.kind, own.id, hoist.id]);

  const chartLike = (CHART_KIND_SET.has(flag.kind) || flag.kind === 'custom') && !!flag.binding && (flag.binding.metrics.length ?? 0) > 0;
  const shownFlag = asTable && chartLike ? { ...flag, kind: 'table' as const } : flag;
  const reviewedLabel = reviewedAt ? `Reviewed · ${shortDate(new Date(reviewedAt))}` : 'Reviewed';

  const look = resolveStyle(design, flag.style);

  return (
    <article
      data-flag-card={own.id}
      style={{ '--flag-i': Math.min(12, flag.layout.y + Math.floor(flag.layout.x / 3)), ...(look.accent ? { borderTopColor: look.accent, borderTopWidth: 3 } : {}) } as CSSProperties}
      aria-label={flag.title || 'Untitled flag'}
      aria-current={selected ? 'true' : undefined}
      aria-describedby={described ? descId : undefined}
      tabIndex={0}
      onFocus={(e) => {
        // Keyboard focus selects the flag; a mouse click inside it does not (that stays a click on the data).
        if (e.target === e.currentTarget && !selected && e.currentTarget.matches(':focus-visible')) onSelectFlag(own.id);
      }}
      onDoubleClick={() => onSelectFlag(flag.id)}
      className={`flag-card group relative flex h-full flex-col overflow-hidden rounded-xl border bg-panel shadow-sm transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 ${selected ? 'border-accent shadow-md ring-2 ring-accent/25' : 'border-line hover:shadow-md'} ${flag.status === 'drafted' ? 'border-dashed' : ''}`}
    >
      {described && (
        <p id={descId} className="sr-only">
          {described}
        </p>
      )}
      <header
        className="flag-titlebar flex cursor-grab touch-none items-center gap-1 px-2 pt-2 active:cursor-grabbing"
        title="Drag to move this flag; click the title to edit it"
        // The whole title bar moves the flag, not only the grip; its buttons and links keep their own clicks.
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return;
          onDragStart(e, flag.id, 'move');
        }}
        onClick={(e) => (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'H3' ? onSelectFlag(flag.id) : undefined)}
      >
        <button
          type="button"
          aria-label="Move flag"
          title="Drag to move (or select the flag and use the arrow keys)"
          tabIndex={-1}
          onPointerDown={(e) => onDragStart(e, flag.id, 'move')}
          className="flag-handle -my-1.5 flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-ink-3 active:cursor-grabbing"
        >
          <GripHorizontal size={14} />
        </button>
        <h3 className={look.hideTitle ? 'sr-only' : `min-w-0 flex-1 truncate text-[13px] font-semibold text-ink ${look.titleAlign === 'center' ? 'text-center' : ''}`} title={`${flag.title} (click to edit)`}>
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
            <RefreshCcw size={12} aria-hidden="true" />
            <span className="sr-only">Re-queried for the selection</span>
          </span>
        ) : null}
        {result && result.display.live.some((k) => !k.includes('@')) ? (
          <span title="A blank or true/false selection on another flag could not be applied to this one; it shows its numbers without that selection" className="text-warn">
            <AlertTriangle size={13} aria-hidden="true" />
            <span className="sr-only">A selection could not be applied</span>
          </span>
        ) : null}
        {result?.display.truncated && (
          <span title="The result hit the row cap, so totals may be incomplete" className="text-warn">
            <AlertTriangle size={13} aria-hidden="true" />
            <span className="sr-only">Row cap reached</span>
          </span>
        )}
        {flag.status === 'drafted' && (
          <span className="flex items-center gap-0.5">
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${lowConfidence ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent'}`}
              title={`Drafted by Semaphore${flag.confidence !== undefined ? `, ${Math.round(flag.confidence * 100)}% sure` : ''}. Flip it over to check, then accept.`}
            >
              {lowConfidence ? 'Verify' : 'Draft'}
              {flag.confidence !== undefined ? ` ${Math.round(flag.confidence * 100)}%` : ''}
            </span>
            <button type="button" onClick={() => onAccept(own.id)} className="-my-1.5 flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-good-soft hover:text-good" aria-label="Accept draft" title="Accept this draft (A)">
              <Check size={16} />
            </button>
          </span>
        )}
        {flag.status === 'ready' && flag.kind !== 'text' && (
          <span className="reviewed-chip" title={reviewedAt ? `${reviewedLabel}: accepted in this browser` : 'Reviewed: accepted by an analyst'}>
            <FlagIcon size={12} aria-hidden="true" className={`shrink-0 ${justAccepted ? 'flag-run' : ''}`} />
            <span className={reviewedAt ? 'reviewed-text' : 'sr-only'}>{reviewedLabel}</span>
          </span>
        )}
        {insights.length > 0 && !flipped && (
          <span className="text-brass" title={insights.map((i) => i.text).join('\n')}>
            <Lightbulb size={13} aria-hidden="true" />
            <span className="sr-only">Worth a look: {insights[0]!.text}</span>
          </span>
        )}
        {chartLike && !flipped && (
          <button
            type="button"
            onClick={() => setAsTable((t) => !t)}
            aria-pressed={asTable}
            aria-label="Show as table"
            title={asTable ? 'Show the chart' : 'Show as table'}
            className={`-my-1.5 flex h-8 w-8 items-center justify-center rounded-md hover:bg-panel-2 ${asTable ? 'text-accent' : 'text-ink-3'}`}
          >
            <Table2 size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={() => toggleFlipped(own.id)}
          className={`-my-1.5 flex h-8 w-8 items-center justify-center rounded-md hover:bg-panel-2 ${flipped ? 'text-accent' : 'text-ink-3'}`}
          aria-pressed={flipped}
          aria-label={flipped ? 'Show the data' : 'Flip over: what this shows and the SQL'}
          title={flipped ? 'Show the data (F)' : 'Flip over: what this shows and the SQL (F)'}
        >
          <FlipHorizontal2 size={14} />
        </button>
      </header>
      <div key={flipped ? 'back' : 'front'} className={`relative min-h-0 flex-1 px-3 pb-2 pt-1 ${flipped ? 'flip-enter' : ''}`}>
        {flipped ? (
          <Back flag={flag} described={described} result={result} insights={insights.map((i) => i.text)} index={index} today={ctx.today} />
        ) : flag.kind === 'text' ? (
          <p className="scroll-thin h-full overflow-auto whitespace-pre-wrap text-sm text-ink-2">{flag.text || flag.brief || 'Write a note in the inspector.'}</p>
        ) : flag.kind === 'model' && !flag.binding && flag.model?.inputs?.length ? (
          // A model on hand-entered inputs (Monte Carlo, sensitivity) needs no rows.
          <ModelView flag={flag} result={undefined} index={index} themeKey={themeKey} today={ctx.today} {...(design ? { design } : {})} />
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
            {drill.length > 0 && (
              <nav aria-label="Drill path" className="flex items-center gap-1 text-[11px] text-ink-3">
                <button type="button" onClick={() => setDrill((s) => s.slice(0, -1))} className="flex items-center gap-0.5 rounded px-1 hover:bg-panel-2 hover:text-ink" title="Back up one level">
                  <ArrowUpLeft size={12} /> Up
                </button>
                <button type="button" onClick={() => setDrill([])} className="rounded px-1 hover:bg-panel-2 hover:text-ink">
                  All
                </button>
                <span className="truncate">› {drillLabel(drill)}{view.detail ? ' · rows' : ''}{result.previous && flag.binding?.compare ? ` · vs ${flag.binding.compare === 'previous-year' ? 'a year earlier' : 'the previous period'}, same selection` : ''}</span>
              </nav>
            )}
            <div className="min-h-0 flex-1">
              <FlagBoundary resetKey={`${shownFlag.kind}:${JSON.stringify(flag.binding)}`}>
                <FlagView flag={shownFlag} result={result} index={index} selections={selections} onSelect={onPick} themeKey={themeKey} today={ctx.today} {...(design ? { design } : {})} {...(described ? { describedBy: descId } : {})} />
              </FlagBoundary>
            </div>
            {insights[0] && flag.layout.h >= 4 && <p className="truncate text-[11px] text-ink-2" title={insights.map((i) => i.text).join('\n')}>{insights[0].text}</p>}
          </div>
        ) : null}
      </div>
      {flipped && result?.sql && (
        <footer aria-label="SQL language" className="shrink-0 border-t border-line bg-panel-2 px-3 py-1.5 text-[11px] text-ink">
          <span className="font-semibold">SQL language: </span>{sqlLanguage(result.sql).name}
          {sqlPref !== 'source' && sqlPref !== result.sql.dialect && <span className="block text-ink-2">Shown below in {dialectName(sqlPref)}, your SQL language; it runs as {sqlLanguage(result.sql).name}.</span>}
          {result.origin === 'page' && <span className="block text-ink-2">Reference SQL; results calculated in this browser.</span>}
        </footer>
      )}
      <button
        type="button"
        aria-label="Resize flag"
        title="Drag to resize (or select the flag and use Shift and the arrow keys)"
        tabIndex={-1}
        onPointerDown={(e) => onDragStart(e, flag.id, 'resize')}
        className="flag-handle flag-resize absolute bottom-0 right-0 h-6 w-6 cursor-se-resize touch-none"
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

function Back({ flag, described, result, insights, index, today }: { flag: Flag; described: string; result: FlagResult | undefined; insights: string[]; index: CatalogIndex; today: Date }) {
  const pref = useSqlPref();
  const view = result?.sql ? shownSql(result.sql, result.plan, index, today, pref) : null;
  return (
    <div className="scroll-thin h-full space-y-2 overflow-auto text-xs">
      <section>
        <h4 className="mb-0.5 font-semibold text-ink-2">What it shows</h4>
        <p className="text-ink">{described}</p>
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
            SQL
          </h4>
          {view?.translated && <p className="mb-1 text-ink-2">In {dialectName(view.shown.dialect)}, your SQL language (Settings &gt; SQL). It runs as {sqlLanguage(result.sql).name}.</p>}
          <pre className="whitespace-pre-wrap break-words rounded-md bg-panel-2 p-2 font-mono text-[11px] text-ink">{prettySql((view?.shown ?? result.sql).sql)}</pre>
          <p className="mt-1 text-ink-2">{sqlLanguage(view?.shown ?? result.sql).syntax}</p>
          <p className="mt-1 text-ink-2">{sqlLanguage(view?.shown ?? result.sql).parameters}</p>
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

/** One flag that fails to draw says so in its own card; the rest of the page carries on. */
class FlagBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: string | null; key: string }> {
  override state = { error: null as string | null, key: this.props.resetKey };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message || 'unknown error' };
  }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { error: string | null; key: string }) {
    // A changed flag (new kind or binding) gets another try.
    return p.resetKey === s.key ? null : { error: null, key: p.resetKey };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <p role="alert" className="flex h-full items-center justify-center gap-1.5 px-2 text-center text-xs text-ink-2">
        <AlertTriangle size={14} className="shrink-0 text-warn" /> This flag could not be drawn ({this.state.error}). Change its kind or redraft it.
      </p>
    );
  }
}

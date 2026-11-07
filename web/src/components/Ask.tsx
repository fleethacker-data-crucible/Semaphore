// Ask a question of the data in plain English and get the answer as a flag: "Which ship class
// had the most work orders?" Pin it to keep it on the page.

import { useState } from 'react';
import { MessageSquareText, Pin, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import { describeFlag } from '../../../src/core/describe.ts';
import { emptyBehavior, type Flag, type Hoist } from '../../../src/core/hoist.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { draftFlagLocally } from '../../../src/core/intelligence/local-rules.ts';
import { DEFAULT_SIZE } from '../../../src/core/layout.ts';
import type { DataContext } from '../lib/data.ts';
import { useFlagResult } from './FlagCard.tsx';
import { FlagView } from './FlagView.tsx';

export function AskBox({ index, onAsk, inputRef }: { index: CatalogIndex; onAsk: (flag: Flag) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState('');
  const submit = () => {
    const text = q.trim();
    if (!text) return;
    const d = draftFlagLocally(text, 'bar', index, { auto: true });
    const size = DEFAULT_SIZE[d.kind];
    onAsk({
      id: `ask-${Date.now().toString(36)}`,
      kind: d.kind,
      title: d.title || text,
      brief: text,
      layout: { x: 0, y: 0, w: size.w, h: size.h },
      binding: d.binding,
      behavior: d.binding ? d.behavior : emptyBehavior(),
      status: d.binding ? 'drafted' : 'empty',
      confidence: d.confidence,
      notes: d.notes,
    });
  };
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 focus-within:border-accent"
    >
      <MessageSquareText size={15} className="shrink-0 text-ink-3" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value.slice(0, 400))}
        placeholder="Quick chart from a question… (press / )"
        aria-label="Quick chart from a question"
        className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-3"
      />
    </form>
  );
}

export function AskAnswer(props: { flag: Flag; hoist: Hoist; ctx: DataContext; index: CatalogIndex; selections: Selections; themeKey: string; onPin: () => void; onClose: () => void; onSelectValue: (k: string, v: Cell, a: boolean) => void }) {
  const { flag, hoist, ctx, index } = props;
  const load = useFlagResult(hoist, flag, props.selections, ctx);
  const result = load.state === 'ready' ? load.result : undefined;
  const insights = result ? findInsights({ flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals, today: ctx.today }, index) : [];
  return (
    <div role="dialog" aria-label="Answer" className="absolute right-4 top-2 z-30 flex w-[440px] max-w-[calc(100%-2rem)] flex-col gap-2 rounded-xl border border-line bg-panel p-3 shadow-xl">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-ink-3">You asked</p>
          <p className="text-sm font-medium">{flag.brief}</p>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close answer" className="rounded p-1 text-ink-3 hover:bg-panel-2">
          <X size={15} />
        </button>
      </div>
      {!flag.binding ? (
        <p className="text-sm text-ink-2">{flag.notes.join(' ') || 'Semaphore could not match that to the catalog.'}</p>
      ) : (
        <>
          <p className="text-xs text-ink-2">{describeFlag(flag, hoist, index).join(' ')}</p>
          {result && result.display.applied.length + result.requeried.length > 0 && (
            <p className="rounded-md bg-accent-soft px-2 py-1 text-[11px] text-ink">
              Answered for the current page selections ({[...result.display.applied, ...result.requeried].map((k) => index.field(k.split('@')[0]!)?.label ?? k).join(', ')}). Clear them for the whole picture.
            </p>
          )}
          <div className="h-56 rounded-lg border border-line p-2">
            {load.state === 'error' ? <p className="text-xs text-bad">{load.error}</p> : result ? <FlagView flag={flag} result={result} index={index} selections={props.selections} onSelect={props.onSelectValue} themeKey={props.themeKey} /> : <p className="text-xs text-ink-3">Working it out…</p>}
          </div>
          {insights.length > 0 && (
            <ul className="space-y-0.5 text-xs text-ink">
              {insights.map((i) => (
                <li key={i.text}>• {i.text}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <button type="button" onClick={props.onPin} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-panel hover:opacity-90">
              <Pin size={14} /> Pin to page
            </button>
          </div>
        </>
      )}
    </div>
  );
}

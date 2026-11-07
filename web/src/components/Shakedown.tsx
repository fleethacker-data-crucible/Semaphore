// The shakedown cruise (#67): a docked, non-modal checklist at the top of the canvas that walks a
// new analyst round the core loop on a flag of their own, in about a minute. The first step is
// already ticked (Semaphore is running here), the next one can be typed for them, and the analyst
// still presses Enter themselves. It never traps focus or covers the canvas; Hide puts it away for
// good, and it hides itself three seconds after the last step. "Take the shakedown again" in the
// ? help dialog calls restartShakedown() (lib/onboarding.ts).

import { useEffect, useRef } from 'react';
import { Check, Circle, Flag, Keyboard, MessagesSquare } from 'lucide-react';
import type { Catalog } from '../../../src/core/catalog.ts';
import { flushAccepts } from '../lib/accept.ts';
import { doneCount, hideShakedown, markStep, SHAKEDOWN_STEPS, type ShakedownStep, shakedownActive, shakedownBrief, useOnboarding } from '../lib/onboarding.ts';

export interface ShakedownProps {
  catalog: Catalog;
  /** Add a Smart flag holding this brief and select it, so the analyst only presses Enter. */
  onTypeForMe: (brief: string) => void;
  /** Open the leadership view. */
  onAsk: () => void;
}

export function Shakedown({ catalog, onTypeForMe, onAsk }: ShakedownProps) {
  const state = useOnboarding();
  const active = shakedownActive(state);
  const done = active ? doneCount(state) : 0;
  const all = done === SHAKEDOWN_STEPS.length;
  const live = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!active || !all) return;
    const t = window.setTimeout(hideShakedown, 3000);
    return () => window.clearTimeout(t);
  }, [active, all]);

  if (!active) return null;
  const brief = shakedownBrief(catalog);
  const is = (k: ShakedownStep) => !!state.steps[k];
  const steps: Array<{ key: ShakedownStep; text: React.ReactNode; action?: React.ReactNode }> = [
    { key: 'running', text: 'Semaphore is running on this computer' },
    {
      key: 'describe',
      text: brief ? (
        <>
          Describe a flag: <em className="text-ink-2">try “{brief.charAt(0).toLowerCase() + brief.slice(1)}”</em>, then press Enter
        </>
      ) : (
        'Describe a flag in plain English, then press Enter'
      ),
      action: brief && !is('describe') ? (
        <button type="button" onClick={() => onTypeForMe(brief)} className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-[var(--fl-control-border)] bg-panel px-2.5 text-xs font-medium hover:border-accent hover:text-accent">
          <Keyboard size={13} aria-hidden="true" /> Type it for me
        </button>
      ) : undefined,
    },
    { key: 'flip', text: 'Flip it over to see the SQL behind it (the ⇄ button, or F)' },
    { key: 'accept', text: 'Accept it (the ✓ button, or A)' },
    {
      key: 'ask',
      text: 'See it answered in the leadership view',
      action: is('accept') && !is('ask') ? (
        <button
          type="button"
          onClick={() => {
            markStep('ask');
            void flushAccepts().then(onAsk);
          }}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel hover:opacity-90"
        >
          <MessagesSquare size={13} aria-hidden="true" /> Open leadership view
        </button>
      ) : undefined,
    },
  ];
  const next = steps.find((s) => !is(s.key))?.key;

  return (
    <section aria-labelledby="shakedown-title" className="mb-3 rounded-xl border border-brass/50 bg-panel px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <Flag size={16} className="text-brass" aria-hidden="true" />
        <h2 id="shakedown-title" className="text-sm font-semibold text-ink">
          Shakedown cruise <span className="font-normal text-ink-2">· {all ? 'all done. Welcome aboard.' : `${done} of ${SHAKEDOWN_STEPS.length} done`}</span>
        </h2>
        <div className="ml-2 hidden h-1.5 w-28 overflow-hidden rounded-full bg-panel-2 sm:block" aria-hidden="true">
          <div className="h-full rounded-full bg-brass" style={{ width: `${(done / SHAKEDOWN_STEPS.length) * 100}%` }} />
        </div>
        <button type="button" onClick={hideShakedown} className="ml-auto flex h-8 items-center rounded-md px-2 text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline">
          Hide
        </button>
      </div>
      <ol className="mt-2 grid gap-1 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
        {steps.map((s) => {
          const ok = is(s.key);
          return (
            <li key={s.key} className={`flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-xs ${s.key === next ? 'bg-brass-soft text-ink' : ok ? 'text-ink-2' : 'text-ink'}`} aria-current={s.key === next ? 'step' : undefined}>
              {ok ? <Check size={15} className="shrink-0 text-good" aria-hidden="true" /> : <Circle size={15} className="shrink-0 text-ink-3" aria-hidden="true" />}
              <span className="sr-only">{ok ? 'Done: ' : 'To do: '}</span>
              <span className={`min-w-0 flex-1 ${ok ? 'line-through decoration-ink-3/60' : ''}`}>{s.text}</span>
              {s.action}
            </li>
          );
        })}
      </ol>
      <p ref={live} className="sr-only" aria-live="polite">
        {done > 1 ? `Shakedown: ${done} of ${SHAKEDOWN_STEPS.length} done.` : ''}
      </p>
    </section>
  );
}

/** Mounted in the leadership view: reaching it is the shakedown's last step. */
export function ShakedownAskMark() {
  useEffect(() => markStep('ask'), []);
  return null;
}

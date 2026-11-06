// One screen per session state (#87), after Lazarette's views/SessionEnded.svelte: offline (Try
// again, and a re-check every 10 s), ended, stopped and link used. A modal over the page (useModal):
// the page behind stays visible but inert, so the analyst can see their work is still there.

import { useEffect, useRef, useState } from 'react';
import { HardDrive, Link2Off, LoaderCircle, PlugZap, Power, RotateCcw, WifiOff, X } from 'lucide-react';
import { useModal } from '../lib/modal.ts';
import { sessionCopy, type SessionSnapshot } from '../lib/session.ts';

const ICONS = { offline: WifiOff, ended: PlugZap, stopped: Power, 'link-used': Link2Off } as const;

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return <>{s > 0 ? `Checking again in ${s} s.` : 'Checking…'}</>;
}

function Screen({ s, view, onRetry }: { s: SessionSnapshot; view: 'builder' | 'ask'; onRetry: () => void }) {
  const ref = useRef<HTMLElement>(null);
  // Escape cannot close a session state: there is nothing behind it to go back to.
  useModal(ref, () => undefined);
  const copy = sessionCopy(s, view)!;
  const Icon = ICONS[s.state as keyof typeof ICONS] ?? PlugZap;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-bg/80 px-4 backdrop-blur-sm" data-testid="session-screen" data-state={s.state}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="session-title" aria-describedby="session-body" tabIndex={-1} className="fl-dialog outline-none w-full max-w-[440px] rounded-[14px] border border-line bg-panel p-8 text-center shadow-xl">
        <img src="brand/mark.svg" alt="" className="mx-auto mb-5 h-10 w-10" />
        <div className={`mx-auto mb-4 grid size-12 place-items-center rounded-full ${s.state === 'offline' ? 'bg-warn-soft text-warn' : 'bg-panel-2 text-ink-2'}`}>
          <Icon size={20} aria-hidden="true" />
        </div>
        <h1 id="session-title" className="text-lg font-semibold">
          {copy.title}
        </h1>
        <p id="session-body" className="mt-2 text-sm leading-6 text-ink-2">
          {copy.body}
        </p>
        {s.state === 'offline' && (
          <>
            <button type="button" data-autofocus onClick={onRetry} disabled={s.retrying} className="mt-6 inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-semibold text-panel hover:opacity-90 disabled:opacity-60">
              {s.retrying ? <LoaderCircle size={15} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <RotateCcw size={15} aria-hidden="true" />}
              {s.retrying ? 'Checking…' : 'Try again'}
            </button>
            <p className="mt-2 text-xs text-ink-3" aria-live="polite">
              {s.nextCheckAt && !s.retrying ? <Countdown at={s.nextCheckAt} /> : ' '}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

export function SessionScreen({ session, view, onRetry }: { session: SessionSnapshot; view: 'builder' | 'ask'; onRetry: () => void }) {
  if (!sessionCopy(session, view)) return null;
  return <Screen s={session} view={view} onRetry={onRetry} />;
}

/** Browser-only mode, said plainly (#87): no server, so nothing reaches the Semaphore folder. */
export function BrowserOnlyNote({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="note" className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-1.5 text-xs text-ink">
      <HardDrive size={14} aria-hidden="true" className="shrink-0 text-warn" />
      <span className="flex-1">
        <span className="font-semibold">Working in this browser only;</span> nothing is saved to the Semaphore folder. Start Semaphore with Launch-Semaphore.bat to save to the folder and use your sources.
      </span>
      <button type="button" onClick={onDismiss} aria-label="Hide this note" title="Hide this note" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}

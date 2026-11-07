// The landing page (UNIFIED-UI 6, .fl-empty): the full emblem, one headline and the ways in. It shows
// when Semaphore opens and gives way to the builder as soon as the analyst picks something.
// On a first run (no `semaphore.onboarding` yet) the primary way in is the shakedown cruise: hoist
// a first flag of one's own in about a minute (components/Shakedown.tsx); continuing is secondary.

import { Database, FilePlus2, Flag, FolderOpen, MessagesSquare, PenLine, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { isFirstRun, passFirstRun, startShakedown } from '../lib/onboarding.ts';

/** The full Semaphore emblem with its wordmark, one per theme (web/public/brand, from assets/brand). */
export function Emblem({ className, alt = 'Semaphore' }: { className?: string; alt?: string }) {
  return (
    <>
      <img src="brand/emblem-light.png" alt={alt} width={768} height={768} className={`only-light ${className ?? ''}`} />
      <img src="brand/emblem-dark.png" alt={alt} width={768} height={768} className={`only-dark ${className ?? ''}`} />
    </>
  );
}

export interface WelcomeProps {
  /** Title of the page the analyst was last on; continuing opens it. */
  lastTitle: string;
  canOpenSaved: boolean;
  onContinue: () => void;
  onNew: () => void;
  onOpenSaved: () => void;
  onData: () => void;
  onAsk: () => void;
  onSettings: () => void;
  /** The analyst's choice to open straight on the builder next time. */
  skipNextTime: boolean;
  onSkipNextTime: (skip: boolean) => void;
}

export function Welcome(p: WelcomeProps) {
  const [skip, setSkip] = useState(p.skipNextTime);
  const [first] = useState(isFirstRun);
  // Any other way in on a first run means the analyst chose not to take the shakedown now.
  const pass = (go: () => void) => () => {
    passFirstRun();
    go();
  };
  const secondary = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 py-2 text-sm font-medium text-ink hover:border-accent';
  return (
    // Centred with auto margins, not justify-center: on a short window the top stays reachable by scrolling.
    <main aria-labelledby="welcome-title" className="relative flex h-full flex-col overflow-auto bg-bg px-4 py-8 text-center">
      <button type="button" onClick={p.onSettings} className="absolute right-4 top-4 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-sm text-ink-2 hover:border-accent">
        <Settings2 size={15} aria-hidden="true" /> Settings
      </button>
      <div className="my-auto flex flex-col items-center gap-4">
      <Emblem className="welcome-emblem" />
      <h1 id="welcome-title" className="font-display text-[28px] font-semibold leading-tight text-ink">
        Run up the signal.
      </h1>
      <p className="max-w-[56ch] text-sm text-ink-2">
        Describe a dashboard in plain English and Semaphore drafts it from your data, on this computer. Leadership asks the questions; your reviewed work answers them.
      </p>
      {first ? (
        <button
          type="button"
          autoFocus
          onClick={() => {
            startShakedown();
            p.onContinue();
          }}
          className="inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[15px] font-semibold text-panel hover:opacity-90"
        >
          <Flag size={17} className="shrink-0" />
          <span className="truncate">Hoist your first flag (about a minute)</span>
        </button>
      ) : (
        <button type="button" autoFocus onClick={p.onContinue} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[15px] font-semibold text-panel hover:opacity-90">
          <PenLine size={17} className="shrink-0" />
          <span className="truncate">Continue “{p.lastTitle || 'Untitled hoist'}”</span>
        </button>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {first && (
          <button type="button" onClick={pass(p.onContinue)} className={`${secondary} max-w-full`}>
            <PenLine size={16} className="shrink-0" /> <span className="truncate">Continue “{p.lastTitle || 'Untitled hoist'}”</span>
          </button>
        )}
        <button type="button" onClick={pass(p.onNew)} className={secondary}>
          <FilePlus2 size={16} /> New hoist
        </button>
        {p.canOpenSaved && (
          <button type="button" onClick={pass(p.onOpenSaved)} className={secondary}>
            <FolderOpen size={16} /> Open a saved hoist
          </button>
        )}
        <button type="button" onClick={pass(p.onData)} className={secondary}>
          <Database size={16} /> Add data
        </button>
        <button type="button" onClick={pass(p.onAsk)} className={secondary}>
          <MessagesSquare size={16} /> Leadership view
        </button>
      </div>
      <label className="mt-1 flex items-center gap-2 text-xs text-ink-3">
        <input
          type="checkbox"
          checked={skip}
          onChange={(e) => {
            setSkip(e.target.checked);
            p.onSkipNextTime(e.target.checked);
          }}
        />
        Open straight to the builder next time
      </label>
      </div>
    </main>
  );
}

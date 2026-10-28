// The landing page (UNIFIED-UI 6, .fl-empty): the full emblem, one headline and the ways in. It shows
// when Semaphore opens and gives way to the builder as soon as the analyst picks something.

import { Database, FilePlus2, FolderOpen, MessagesSquare, PenLine } from 'lucide-react';
import { useState } from 'react';

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
  /** The analyst's choice to open straight on the builder next time. */
  skipNextTime: boolean;
  onSkipNextTime: (skip: boolean) => void;
}

export function Welcome(p: WelcomeProps) {
  const [skip, setSkip] = useState(p.skipNextTime);
  const secondary = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3.5 py-2 text-sm font-medium text-ink hover:border-accent';
  return (
    // Centred with auto margins, not justify-center: on a short window the top stays reachable by scrolling.
    <main aria-labelledby="welcome-title" className="flex h-full flex-col overflow-auto bg-bg px-4 py-8 text-center">
      <div className="my-auto flex flex-col items-center gap-4">
      <Emblem className="welcome-emblem" />
      <h1 id="welcome-title" className="font-display text-[28px] font-semibold leading-tight text-ink">
        Run up the signal.
      </h1>
      <p className="max-w-[56ch] text-sm text-ink-2">
        Describe a dashboard in plain English and Semaphore drafts it from your data, on this computer. Leadership asks the questions; your reviewed work answers them.
      </p>
      <button type="button" autoFocus onClick={p.onContinue} className="inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[15px] font-semibold text-panel hover:opacity-90">
        <PenLine size={17} className="shrink-0" />
        <span className="truncate">Continue “{p.lastTitle || 'Untitled hoist'}”</span>
      </button>
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={p.onNew} className={secondary}>
          <FilePlus2 size={16} /> New hoist
        </button>
        {p.canOpenSaved && (
          <button type="button" onClick={p.onOpenSaved} className={secondary}>
            <FolderOpen size={16} /> Open a saved hoist
          </button>
        )}
        <button type="button" onClick={p.onData} className={secondary}>
          <Database size={16} /> Add data
        </button>
        <button type="button" onClick={p.onAsk} className={secondary}>
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

// Error boundaries (#89). React unmounts the whole tree when a render throws and nothing catches
// it, so the page has two layers: AppBoundary around everything (Reload, or download the hoist the
// page was working on), and PanelBoundary around each panel and the inspector, so one broken panel
// shows its own card and the rest of the page keeps working. Each catch is written to the server's
// log by main.tsx (createRoot onCaughtError), without data values.

import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { AlertTriangle, Download, RotateCcw, X } from 'lucide-react';

const HOIST_KEY = 'semaphore.hoist';

/** Downloads the working copy this browser keeps, straight from storage (the app state may be gone). */
export function downloadSavedHoist(): boolean {
  try {
    const raw = localStorage.getItem(HOIST_KEY);
    if (!raw) return false;
    let name = 'hoist';
    try {
      const id = (JSON.parse(raw) as { id?: unknown }).id;
      if (typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) name = id;
    } catch {
      /* not JSON: download it as it is */
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    a.download = `${name}.hoist.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  } catch {
    return false;
  }
}

export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean; noCopy: boolean }> {
  override state = { failed: false, noCopy: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="grid h-full place-items-center bg-bg px-4">
        <div className="w-full max-w-[440px] rounded-[14px] border border-line bg-panel p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-bad-soft text-bad">
            <AlertTriangle size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
          <p className="mt-2 text-sm text-ink-2">Your hoist is kept in this browser. Reload to carry on where you were, or download a copy of it first.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" autoFocus onClick={() => location.reload()} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-semibold text-panel hover:opacity-90">
              <RotateCcw size={15} aria-hidden="true" /> Reload
            </button>
            <button type="button" onClick={() => this.setState({ noCopy: !downloadSavedHoist() })} className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-ink-3 px-4 text-sm hover:bg-panel-2">
              <Download size={15} aria-hidden="true" /> Download this hoist (JSON)
            </button>
          </div>
          {this.state.noCopy && <p className="mt-3 text-xs text-ink-3">There is no copy in this browser to download.</p>}
        </div>
      </main>
    );
  }
}

export interface PanelBoundaryProps {
  /** What the panel is called in the card: "Data panel", "inspector". */
  name: string;
  /** 'overlay' for dialogs and drawers (the card is a small dialog), 'inline' for the inspector. */
  variant?: 'overlay' | 'inline';
  onClose?: () => void;
  children: ReactNode;
}

export class PanelBoundary extends Component<PanelBoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(_e: Error, _info: ErrorInfo) {
    /* reported by createRoot's onCaughtError (main.tsx) */
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const { name, onClose, variant = 'overlay' } = this.props;
    const card = (
      <div role="alert" className="w-[380px] max-w-[calc(100%-2rem)] rounded-[10px] border border-line bg-panel p-4 text-sm shadow-lg">
        <p className="flex items-start gap-2">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-bad" />
          <span>
            <span className="font-semibold">The {name} ran into a problem.</span> The rest of the page still works, and nothing you made is lost.
          </span>
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => this.setState({ failed: false })} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-panel hover:opacity-90">
            <RotateCcw size={14} aria-hidden="true" /> Try again
          </button>
          {onClose && (
            <button type="button" onClick={onClose} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-ink-3 px-3 text-sm hover:bg-panel-2">
              <X size={14} aria-hidden="true" /> Close
            </button>
          )}
        </div>
      </div>
    );
    if (variant === 'inline') return <aside className="w-[340px] shrink-0 border-l border-line bg-panel p-3">{card}</aside>;
    return <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-24">{card}</div>;
  }
}

/** What a lazily loaded panel shows while its code arrives: the panel's frame with grey lines. */
export function PanelSkeleton({ variant = 'overlay', label }: { variant?: 'overlay' | 'inline'; label: string }) {
  const lines = (
    <div className="space-y-3" aria-hidden="true">
      <div className="h-5 w-1/3 animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
      <div className="h-24 w-full animate-pulse rounded bg-panel-2 motion-reduce:animate-none" />
    </div>
  );
  if (variant === 'inline')
    return (
      <aside role="status" aria-label={`Opening the ${label}`} className="w-[340px] shrink-0 border-l border-line bg-panel p-4">
        {lines}
      </aside>
    );
  return (
    <div role="status" aria-label={`Opening the ${label}`} className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-24">
      <div className="w-[560px] max-w-[calc(100%-2rem)] rounded-[14px] border border-line bg-panel p-5 shadow-xl">{lines}</div>
    </div>
  );
}

/** A panel with both: its own error card, and a skeleton while a lazy panel loads. */
export function Panel({ name, variant = 'overlay', onClose, children }: PanelBoundaryProps) {
  return (
    <PanelBoundary name={name} variant={variant} {...(onClose ? { onClose } : {})}>
      <Suspense fallback={<PanelSkeleton variant={variant} label={name} />}>{children}</Suspense>
    </PanelBoundary>
  );
}

// A save that would have overwritten someone else's (#88): a persistent choice under the header,
// never a silent discard. Also: another tab of this browser changed the working copy.

import { Copy, Download, RefreshCw, Upload, Users, X } from 'lucide-react';

export interface SaveConflict {
  kind: 'hoists' | 'catalogs';
  /** The title of what was being saved. */
  title: string;
  /** When the folder's copy was saved, if it says. */
  theirsAt?: string;
}

export interface TabChange {
  /** The other tab's hoist title. */
  title: string;
  /** The other tab changed this same hoist (otherwise it opened a different one). */
  sameHoist: boolean;
}

const btn = 'inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-sm';

function at(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return ` at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${today ? '' : ` on ${d.toLocaleDateString()}`}`;
}

export function ConflictBar({ conflict, onTheirs, onCopy, onOverwrite }: { conflict: SaveConflict; onTheirs: () => void; onCopy?: () => void; onOverwrite: () => void }) {
  const noun = conflict.kind === 'hoists' ? 'hoist' : 'catalog';
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warn bg-warn-soft px-4 py-2 text-sm">
      <Users size={16} aria-hidden="true" className="shrink-0 text-warn" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Someone else saved {conflict.kind === 'hoists' ? `“${conflict.title || 'this hoist'}”` : 'the catalog'}{at(conflict.theirsAt)}.</span> Your changes are kept here and were not saved over theirs. Choose which to keep.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={onTheirs} className={`${btn} border border-ink-3 bg-panel hover:bg-panel-2`}>
          <Download size={14} aria-hidden="true" /> Load theirs
        </button>
        {onCopy && (
          <button type="button" onClick={onCopy} className={`${btn} bg-accent font-semibold text-panel hover:opacity-90`}>
            <Copy size={14} aria-hidden="true" /> Save mine as a copy
          </button>
        )}
        <button type="button" onClick={onOverwrite} className={`${btn} border border-bad text-bad hover:bg-bad-soft`} title={`Replace the ${noun} in the Semaphore folder with yours`}>
          <Upload size={14} aria-hidden="true" /> Overwrite
        </button>
      </div>
    </div>
  );
}

export function TabChangeBar({ change, onReload, onKeep }: { change: TabChange; onReload: () => void; onKeep: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-accent-soft px-4 py-2 text-sm">
      <RefreshCw size={16} aria-hidden="true" className="shrink-0 text-accent" />
      <p className="min-w-0 flex-1">
        {change.sameHoist ? (
          <>
            <span className="font-semibold">This hoist was changed in another tab.</span> Reload to see those changes, or keep working on this tab’s version.
          </>
        ) : (
          <>
            <span className="font-semibold">Another tab is working on “{change.title || 'Untitled hoist'}”.</span> This tab’s hoist is still yours; keep it as the one this browser opens next time, or switch to the other one.
          </>
        )}
      </p>
      <div className="flex gap-1.5">
        <button type="button" onClick={onReload} className={`${btn} bg-accent font-semibold text-panel hover:opacity-90`}>
          <RefreshCw size={14} aria-hidden="true" /> {change.sameHoist ? 'Reload' : 'Switch to it'}
        </button>
        <button type="button" onClick={onKeep} className={`${btn} border border-ink-3 bg-panel hover:bg-panel-2`}>
          <X size={14} aria-hidden="true" /> Keep this tab’s
        </button>
      </div>
    </div>
  );
}

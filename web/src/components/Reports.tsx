// Recurring reports on screen: leadership's shelf of editions and the edition itself (frozen
// answers, read like the page), and the analyst's offer to keep a page coming while away.

import { useState } from 'react';
import { CalendarClock, Newspaper, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { type Cadence, describeCadence, type Edition, type FrozenFlag, latestEditions, type ReportSchedule } from '../../../src/core/reports.ts';
import type { FlagResult } from '../lib/data.ts';
import { FlagView } from './FlagView.tsx';

const noop = () => undefined;

/** Frozen flags laid out on the page's own grid, read-only. Used by editions and shared reports. */
export function FrozenGrid({ flags, cols, index, themeKey }: { flags: FrozenFlag[]; cols: number; index: CatalogIndex; themeKey: string }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '64px' }}>
      {flags.map(({ flag, result, error, insights }) => (
        <article key={flag.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel p-2 shadow-sm" style={{ gridColumn: `${flag.layout.x + 1} / span ${flag.layout.w}`, gridRow: `${flag.layout.y + 1} / span ${flag.layout.h}` }}>
          <h3 className="truncate px-1 text-[13px] font-semibold">{flag.title}</h3>
          <div className="min-h-0 flex-1">
            {flag.kind === 'text' ? (
              <p className="whitespace-pre-wrap p-1 text-sm text-ink-2">{flag.text || flag.brief}</p>
            ) : result ? (
              <FlagView flag={flag} result={result as FlagResult} index={index} selections={{}} onSelect={noop} themeKey={themeKey} />
            ) : (
              <p className="p-1 text-xs text-warn">{error ?? 'No data.'}</p>
            )}
          </div>
          {insights[0] && flag.layout.h >= 4 && <p className="truncate px-1 text-[11px] text-ink-2">{insights[0]}</p>}
        </article>
      ))}
    </div>
  );
}

export function EditionView({ edition, index, themeKey, onClose }: { edition: Edition; index: CatalogIndex; themeKey: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-label={edition.title} className="mx-auto max-w-6xl rounded-xl border border-line bg-bg shadow-xl">
        <header className="flex items-start gap-2 border-b border-line px-5 py-3">
          <Newspaper size={18} className="mt-0.5 text-brass" />
          <div className="flex-1">
            <h2 className="text-base font-semibold">{edition.title}</h2>
            <p className="text-xs text-ink-2">
              Edition for {edition.date}, produced {new Date(edition.takenAt).toLocaleString()} while {edition.owner} is away. The same page, new data; nothing in it was changed by hand.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="p-5">
          <FrozenGrid flags={edition.flags} cols={edition.cols} index={index} themeKey={themeKey} />
        </div>
      </section>
    </div>
  );
}

/** Leadership's shelf: the latest edition of each recurring report. */
export function ReportsShelf({ editions, index, themeKey }: { editions: Edition[]; index: CatalogIndex; themeKey: string }) {
  const [open, setOpen] = useState<Edition | null>(null);
  const latest = latestEditions(editions);
  if (!latest.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
        <Newspaper size={13} /> Regular reports
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {latest.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => setOpen(e)} className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-left hover:border-accent">
              <span className="block text-sm font-medium">{e.title}</span>
              <span className="block text-[11px] text-ink-3">
                {e.date} · kept coming while {e.owner} is away · {e.flags.length} flag{e.flags.length === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && <EditionView edition={open} index={index} themeKey={themeKey} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** In the builder: the offer when a rhythm is noticed, or the schedule once accepted. */
export function ReportChip({ title, cadence, schedule, onAccept, onDismiss, onStop }: { title: string; cadence: Cadence | null; schedule: ReportSchedule | undefined; onAccept: (c: Cadence) => void; onDismiss: () => void; onStop: () => void }) {
  if (schedule) {
    return (
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-2" title={`Kept coming ${describeCadence(schedule.cadence)} while you are marked away: Semaphore produces this page on schedule for leadership.`}>
        <CalendarClock size={12} className="text-brass" /> {schedule.cadence.every === 'week' ? 'Weekly' : 'Monthly'}
        <button type="button" onClick={onStop} aria-label="Stop the regular report" title="Stop producing this page while you are away" className="rounded px-0.5 text-ink-3 hover:text-bad">
          <X size={11} />
        </button>
      </span>
    );
  }
  if (!cadence) return null;
  return (
    <span role="status" className="flex items-center gap-1.5 border-b border-accent/30 bg-accent-soft px-4 py-1 text-[12px]">
      <CalendarClock size={13} className="text-accent" /> You open “{title || 'this page'}” {describeCadence(cadence)}. Keep it coming while you are away?
      <button type="button" onClick={() => onAccept(cadence)} className="rounded bg-accent px-1.5 font-semibold text-panel">
        Yes
      </button>
      <button type="button" onClick={onDismiss} className="rounded px-1 text-ink-3 hover:text-ink">
        No thanks
      </button>
    </span>
  );
}

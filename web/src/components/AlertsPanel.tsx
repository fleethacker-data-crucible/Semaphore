// The Alerts panel: this person's alerts on reviewed flags, what each watches, its state now, and each
// time it fired (when, the value, the data's as-of time). Opening it marks the firings seen. Loaded on demand.

import { useEffect, useRef } from 'react';
import { BellRing, CircleCheck, Clock, Trash2, TriangleAlert, X } from 'lucide-react';
import { type Alert, alertText, markSeen, ruleText } from '../../../src/core/alerts.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { removeAlert, saveAlert } from '../lib/alerts.ts';
import { useModal } from '../lib/modal.ts';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AlertsPanel({ alerts, user, server, onClose }: { alerts: readonly Alert[]; user: string; server: boolean; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const mine = alerts.filter((a) => a.who === user).sort((a, b) => a.title.localeCompare(b.title));
  useEffect(() => {
    for (const a of mine) if (a.events.some((e) => !e.seen)) void saveAlert(server, markSeen(a)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = (a: Alert, key: 'notifyClear' | 'speak' | 'brief') => void saveAlert(server, { ...a, [key]: !a[key], updated: new Date().toISOString() }).catch(() => undefined);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-label="Alerts" tabIndex={-1} className="flex h-full w-[480px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <BellRing size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Alerts</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs text-ink-2">
            Checked each time a flag's data refreshes: when a snapshot is refreshed on an open page, on a refresh run, and when this page opens. Each alert tells you once when it goes red{server ? '' : ' (kept in this browser only)'}.
          </p>
          {mine.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-ink-2">No alerts yet. Press "Alert me" on a reviewed number with a red rule, or ask "Tell me when labor cost goes red".</p>
          ) : (
            <ul className="space-y-3">
              {mine.map((a) => (
                <li key={a.id} data-testid="alert-item" className="rounded-lg border border-line p-3">
                  <div className="flex items-start gap-2">
                    {a.state === 'red' ? <TriangleAlert size={15} className="mt-0.5 text-bad" aria-hidden="true" /> : <CircleCheck size={15} className="mt-0.5 text-good" aria-hidden="true" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{a.title}</p>
                      <p className="text-xs text-ink-2">
                        {a.metricLabel}: red {ruleText(a.rule, a.format)} · now <b className={a.state === 'red' ? 'text-bad' : 'text-ink'}>{a.state === 'red' ? 'red' : a.state === 'normal' ? 'within its rule' : 'not checked yet'}</b>
                        {typeof a.lastValue === 'number' ? ` (${formatNumber(a.lastValue, a.format)})` : ''}
                      </p>
                      {a.lastAsOf && (
                        <p className="flex items-center gap-1 text-[11px] text-ink-3">
                          <Clock size={11} /> Data as of {when(a.lastAsOf)}
                        </p>
                      )}
                    </div>
                    <button type="button" onClick={() => void removeAlert(server, a.id)} aria-label={`Remove the alert on ${a.title}`} className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-bad">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {a.pending && <p className="mt-2 rounded bg-warn-soft px-2 py-1 text-xs text-ink">{a.pending.note}</p>}
                  {a.events.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
                      {[...a.events].reverse().slice(0, 10).map((e) => (
                        <li key={e.id} className={e.kind === 'red' ? 'text-bad' : 'text-good'}>
                          {alertText(a, e)} <span className="text-ink-3">({e.source === 'refresh' ? 'refresh run' : 'on a page'})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-2">
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={a.notifyClear} onChange={() => toggle(a, 'notifyClear')} /> Also when back to normal
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={a.speak} onChange={() => toggle(a, 'speak')} /> Read aloud
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={a.brief} onChange={() => toggle(a, 'brief')} /> Add to the next briefing
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

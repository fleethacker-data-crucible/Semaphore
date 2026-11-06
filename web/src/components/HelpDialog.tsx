// The "?" help dialog (Fleet UI 7, #77): every keyboard shortcut, the Phrasebook (the words a brief
// understands, filled in by components/Phrasebook.tsx), and a way to restart the shakedown tour.

import { useRef, useState } from 'react';
import { Keyboard, LifeBuoy, X } from 'lucide-react';
import { useModal } from '../lib/modal.ts';
import { SHORTCUTS, type Shortcut } from '../lib/shortcuts.ts';
import { restartShakedown } from '../lib/onboarding.ts';
import { FLAG_SHORTCUTS } from '../hooks/useFlagKeys.ts';
import { Phrasebook } from './Phrasebook.tsx';

type Tab = 'shortcuts' | 'phrasebook';

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {keys.map((k, i) => (
        <kbd key={i} className="min-w-6 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-center font-mono text-[11px] text-ink">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function HelpDialog({ onClose, onPalette }: { onClose: () => void; onPalette: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const [tab, setTab] = useState<Tab>('shortcuts');
  const groups = SHORTCUTS.map((g) => (g.group === 'With a flag selected' ? { ...g, items: [...g.items, ...FLAG_SHORTCUTS] as Shortcut[] } : g));
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'phrasebook', label: 'Phrasebook' },
  ];
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-ink/30 pt-16" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="help-title" tabIndex={-1} className="fl-dialog flex max-h-[calc(100vh-6rem)] w-[620px] max-w-[calc(100%-2rem)] flex-col rounded-[14px] border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <LifeBuoy size={16} aria-hidden="true" className="text-brass" />
          <h2 id="help-title" className="flex-1 text-base font-semibold">
            Help
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div role="tablist" aria-label="Help" className="flex gap-1 border-b border-line px-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`help-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`help-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              data-autofocus={tab === t.id ? '' : undefined}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = tabs[(tabs.findIndex((x) => x.id === tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
                  setTab(next.id);
                  document.getElementById(`help-tab-${next.id}`)?.focus();
                }
              }}
              className={`-mb-px min-h-9 border-b-2 px-3 text-sm ${tab === t.id ? 'border-accent font-semibold text-accent' : 'border-transparent text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`help-panel-${tab}`} role="tabpanel" aria-labelledby={`help-tab-${tab}`} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'shortcuts' ? (
            <div className="space-y-5">
              {groups.map((g) => (
                <section key={g.group}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">{g.group}</h3>
                  <dl className="divide-y divide-line rounded-[10px] border border-line">
                    {g.items.map((s) => (
                      <div key={s.what} className="flex items-center gap-3 px-3 py-2">
                        <dt className="min-w-0 flex-1 text-sm">{s.what}</dt>
                        <dd>
                          <Keys keys={s.keys} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ) : (
            <Phrasebook />
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              window.setTimeout(onPalette, 0);
            }}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-ink-3 px-3 text-sm hover:bg-panel-2"
          >
            <Keyboard size={14} aria-hidden="true" /> Open the command palette
          </button>
          <button
              type="button"
              onClick={() => {
                onClose();
                window.setTimeout(restartShakedown, 0);
              }}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-ink-3 px-3 text-sm hover:bg-panel-2"
            >
              Restart the shakedown
            </button>
        </footer>
      </section>
    </div>
  );
}

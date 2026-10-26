// The analysts' side of the playbook: what leadership can ask for (every accepted flag), what
// needs review and why, the questions leadership asked that are waiting for an answer, and which
// measures have no reviewed answer yet.

import { useState } from 'react';
import { BadgeCheck, BookOpen, CircleAlert, Inbox, RotateCcw, Sparkles, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { coverage, flagForReview, type PlaybookEntry, type QuestionItem, restoreEntry, retireEntry } from '../../../src/core/playbook.ts';
import type { PlaybookState } from '../lib/playbook.ts';

export interface PlaybookPanelProps {
  playbook: PlaybookState;
  index: CatalogIndex;
  user: string;
  reviewer: string;
  onClose: () => void;
  onAnswer: (q: QuestionItem) => void;
}

export function PlaybookPanel({ playbook, index, user, reviewer, onClose, onAnswer }: PlaybookPanelProps) {
  const open = playbook.questions.filter((q) => q.status === 'open').sort((a, b) => b.askedAt.localeCompare(a.askedAt));
  const review = playbook.entries.filter((e) => e.status === 'needs-review');
  const [tab, setTab] = useState<'questions' | 'entries' | 'coverage'>(open.length ? 'questions' : review.length ? 'entries' : 'entries');
  const [filter, setFilter] = useState<'all' | 'needs-review' | 'retired'>(review.length ? 'needs-review' : 'all');
  const entries = playbook.entries
    .filter((e) => (filter === 'all' ? e.status !== 'retired' : e.status === filter))
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-label="Playbook" className="flex h-full w-[560px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
        <header className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-brass" />
            <h2 className="flex-1 text-base font-semibold">Playbook</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-2">
            Every flag you accept becomes an answer leadership can ask for in the Ask view. Untick "Leadership can ask for this" on a flag to keep it out. Kept in {playbook.where === 'shared folder' ? 'the shared Semaphore folder' : 'this browser only (start Semaphore with its server to share it)'}
            {reviewer ? `; ${reviewer} reviews flagged entries` : ''}.
          </p>
        </header>
        <div className="flex gap-1 border-b border-line px-3" role="tablist">
          {(
            [
              ['questions', `Questions (${open.length})`],
              ['entries', `Answers (${playbook.entries.filter((e) => e.status !== 'retired').length})`],
              ['coverage', 'Coverage'],
            ] as const
          ).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-semibold' : 'border-transparent text-ink-3 hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {tab === 'questions' && (
            <ul className="space-y-2">
              {open.map((q) => (
                <li key={q.id} className="rounded-lg border border-line p-3">
                  <p className="text-sm font-medium">{q.title}</p>
                  <p className="mt-0.5 text-[11px] text-ink-3">
                    Asked by {q.askedBy} {q.askedAt.slice(0, 10)} · {q.shown === 'drafted' ? 'they saw a draft, not reviewed' : 'they got no answer'}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => onAnswer(q)} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-panel">
                      <Sparkles size={12} /> Build the answer
                    </button>
                    <button type="button" onClick={() => playbook.saveQuestion({ ...q, status: 'dismissed', updated: new Date().toISOString() })} className="rounded-md border border-line px-2.5 py-1 text-xs hover:border-bad hover:text-bad">
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
              {open.length === 0 && (
                <li className="flex flex-col items-center gap-1 py-8 text-center text-sm text-ink-3">
                  <Inbox size={20} /> No open questions from leadership.
                </li>
              )}
              <li className="pt-2 text-[11px] text-ink-3">
                "Build the answer" adds a flag with the question as its brief. Accept it and the question is answered: the next time anyone asks it, they get your reviewed answer.
              </li>
            </ul>
          )}

          {tab === 'entries' && (
            <>
              <div className="mb-3 flex gap-1 text-xs">
                {(['all', 'needs-review', 'retired'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`rounded-full border px-2.5 py-0.5 ${filter === f ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2'}`}>
                    {f === 'all' ? 'In use' : f === 'needs-review' ? `Needs review (${review.length})` : 'Retired'}
                  </button>
                ))}
              </div>
              <ul className="space-y-2">
                {entries.map((e) => (
                  <EntryRow key={e.id} entry={e} user={user} onSave={(x) => playbook.saveEntries([x])} />
                ))}
                {entries.length === 0 && <li className="py-6 text-center text-sm text-ink-3">Nothing here.</li>}
              </ul>
            </>
          )}

          {tab === 'coverage' && (
            <div className="space-y-2">
              <p className="text-xs text-ink-2">Measures with no reviewed answer are where Semaphore would be drafting for leadership. Worth covering before someone goes on leave.</p>
              <ul className="space-y-1">
                {coverage(playbook.entries, index).map((c) => (
                  <li key={c.metric} className="flex items-center gap-2 text-sm">
                    {c.entries === 0 ? <CircleAlert size={14} className="text-warn" /> : <BadgeCheck size={14} className="text-good" />}
                    <span className="flex-1">{c.label}</span>
                    <span className="text-xs text-ink-3">
                      {c.entries} reviewed answer{c.entries === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function EntryRow({ entry, user, onSave }: { entry: PlaybookEntry; user: string; onSave: (e: PlaybookEntry) => void }) {
  const [mode, setMode] = useState<'idle' | 'retire' | 'review'>('idle');
  const [reason, setReason] = useState('');
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{entry.title}</p>
          <p className="truncate text-xs text-ink-2" title={entry.question}>
            "{entry.question}"
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {entry.acceptedBy}, {entry.acceptedAt.slice(0, 10)} · {entry.hoist.title} · asked {entry.uses} time{entry.uses === 1 ? '' : 's'}
            {entry.phrasings.length ? ` · ${entry.phrasings.length} other wording${entry.phrasings.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        {entry.status === 'needs-review' && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">Needs review</span>}
        {entry.status === 'retired' && <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">Retired</span>}
      </div>
      {entry.review && entry.status === 'needs-review' && <p className="mt-1.5 rounded bg-warn-soft px-2 py-1 text-xs text-ink">{entry.review.reason}</p>}
      {entry.retired && <p className="mt-1.5 text-xs text-ink-3">Retired by {entry.retired.by}: {entry.retired.reason}</p>}
      {mode === 'idle' ? (
        <div className="mt-2 flex gap-2 text-xs">
          {entry.status === 'retired' ? (
            <button type="button" onClick={() => onSave(restoreEntry(entry))} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 hover:border-accent">
              <RotateCcw size={12} /> Restore
            </button>
          ) : (
            <>
              {entry.status === 'needs-review' ? (
                <button type="button" onClick={() => onSave(restoreEntry(entry))} className="rounded-md border border-line px-2 py-0.5 hover:border-good hover:text-good">
                  Still right
                </button>
              ) : (
                <button type="button" onClick={() => setMode('review')} className="rounded-md border border-line px-2 py-0.5 hover:border-warn">
                  Flag for review
                </button>
              )}
              <button type="button" onClick={() => setMode('retire')} className="rounded-md border border-line px-2 py-0.5 hover:border-bad hover:text-bad">
                Retire
              </button>
            </>
          )}
        </div>
      ) : (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            onSave(mode === 'retire' ? retireEntry(entry, user, reason) : flagForReview(entry, user, reason));
            setMode('idle');
            setReason('');
          }}
        >
          <input autoFocus value={reason} onChange={(ev) => setReason(ev.target.value.slice(0, 300))} placeholder={mode === 'retire' ? 'Why retire it? e.g. backlog now excludes cancelled orders' : 'What needs checking?'} aria-label="Reason" className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-xs focus:border-accent focus:outline-none" />
          <button type="submit" className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-panel">
            {mode === 'retire' ? 'Retire' : 'Flag'}
          </button>
          <button type="button" onClick={() => setMode('idle')} className="rounded-md px-2 py-1 text-xs text-ink-3">
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

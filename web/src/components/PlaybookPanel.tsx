// The analysts' side of the playbook: the team's week (what the playbook gained, credited to who
// built it, never ranked), what leadership can ask for, what needs review and why, the questions
// leadership asked that are waiting for an answer (most asked first), and which measures have no
// reviewed answer yet.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, BadgeCheck, BookOpen, CircleAlert, Hammer, Inbox, LayoutDashboard, PartyPopper, RotateCcw, Sparkles, ThumbsUp, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { impactFor, isoWeek, spark, teamWeek, weekCue } from '../../../src/core/impact.ts';
import { byDemand, coverage, flagForReview, type PlaybookEntry, type QuestionItem, restoreEntry, retireEntry, withAskers } from '../../../src/core/playbook.ts';
import type { TeamStyle } from '../../../src/core/style.ts';
import type { PlaybookState } from '../lib/playbook.ts';
import { recordSkill, recordWatch } from '../lib/skills.ts';
import { readLocal, writeLocal } from '../lib/storage.ts';
import { EmptyState } from './EmptyState.tsx';
import { AwayTab, StyleTab } from './TeamPanels.tsx';
import { useModal } from '../lib/modal.ts';

type Tab = 'week' | 'questions' | 'entries' | 'coverage' | 'style' | 'away';

export interface PlaybookPanelProps {
  playbook: PlaybookState;
  index: CatalogIndex;
  user: string;
  reviewer: string;
  onClose: () => void;
  onAnswer: (q: QuestionItem) => void;
  /** The team style card, learnt from the accepted entries plus the analysts' overrides. */
  style: TeamStyle;
  /** Open on this tab (the header's 'while you were out' chip opens 'away'). */
  initialTab?: Tab;
}

const CUE_KEY = 'semaphore.weekCue';
const FULL_KEY = 'semaphore.fullHoistSeen';

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A gap or a coverage row turned into a brief, so "Build" drops a flag ready to draft. */
function gapQuestion(label: string, user: string): QuestionItem {
  const now = new Date().toISOString();
  return { version: 1, id: 'gap', title: `${label} by month`, askedBy: 'the coverage list', askedAt: now, askers: [user], askCount: 1, shown: 'none', notes: [], status: 'open', updated: now };
}

export function PlaybookPanel({ playbook, index, user, reviewer, onClose, onAnswer, style, initialTab }: PlaybookPanelProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const { social } = playbook;
  const open = playbook.questions.filter((q) => q.status === 'open').sort(byDemand);
  const review = playbook.entries.filter((e) => e.status === 'needs-review');
  const live = playbook.entries.filter((e) => e.status !== 'retired');
  const [tab, setTab] = useState<Tab>(initialTab ?? (social.teamLog ? 'week' : open.length ? 'questions' : 'entries'));
  const [filter, setFilter] = useState<'all' | 'needs-review' | 'retired'>(review.length ? 'needs-review' : 'all');
  const entries = playbook.entries
    .filter((e) => (filter === 'all' ? e.status !== 'retired' : e.status === filter))
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));

  // The Monday cue: on the first open of the week, and only when there is real work.
  const week = isoWeek(new Date());
  const [cue] = useState(() => (readLocal<string>(CUE_KEY) === week ? null : weekCue(review.length, open.length)));
  useEffect(() => {
    if (cue) writeLocal(CUE_KEY, week);
  }, [cue, week]);

  const impact = useMemo(() => (social.impact ? impactFor(playbook.entries, playbook.asks, playbook.bz, user, open.length) : null), [social.impact, playbook.entries, playbook.asks, playbook.bz, user, open.length]);

  const tabs: Array<[Tab, string]> = [
    ...(social.teamLog ? ([['week', 'This week']] as Array<[Tab, string]>) : []),
    ['questions', `Questions (${open.length})`],
    ['entries', `Answers (${live.length})`],
    ['coverage', 'Coverage'],
    ['style', 'Team style'],
    ['away', 'Away'],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Playbook" className="flex h-full w-[580px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
        <header className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-brass" />
            <h2 className="flex-1 text-base font-semibold">Playbook</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-2">
            Every flag you accept becomes an answer leadership can ask for in the Ask view. Untick "Leadership can ask for this" on a flag to keep it out. Kept in {playbook.where === 'shared folder' ? 'the shared Semaphore folder' : 'this browser only (start Semaphore with its server to share it)'}
            {reviewer ? `; ${reviewer} reviews flagged entries` : ''}.
          </p>
          {cue && (
            <p role="status" className="mt-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-ink">
              <Anchor size={15} className="shrink-0 text-accent" />
              <span className="flex-1">
                <span className="font-semibold">This week's watch.</span> {cue}
              </span>
            </p>
          )}
        </header>
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3" role="tablist">
          {tabs.map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px min-h-8 shrink-0 border-b-2 px-2.5 py-2 text-sm ${tab === t ? 'border-accent font-semibold' : 'border-transparent text-ink-3 hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-4">
          {tab === 'week' && <WeekTab playbook={playbook} index={index} impact={impact} waiting={open.length} onQuestions={() => setTab('questions')} onBuild={(label) => onAnswer(gapQuestion(label, user))} onClose={onClose} />}

          {tab === 'questions' && (
            <>
              {open.length === 0 ? (
                <EmptyState compact tone="success" icon={Inbox} headline="All caught up." body="No leadership questions are waiting." />
              ) : (
                <ul className="space-y-2">
                  {open.map((q) => (
                    <QuestionRow key={q.id} q={q} showAskers={social.showAskers} onAnswer={() => onAnswer(q)} onDismiss={() => void playbook.saveQuestion({ ...q, status: 'dismissed', updated: new Date().toISOString() })} />
                  ))}
                </ul>
              )}
              <p className="pt-3 text-[11px] text-ink-3">
                "Build the answer" adds a flag with the question as its brief. Accept it and the question is answered: the next time anyone asks it, they get your reviewed answer, and the people who asked are told.
              </p>
            </>
          )}

          {tab === 'entries' && (
            <>
              {impact && !social.teamLog && <ImpactCard impact={impact} onQuestions={() => setTab('questions')} />}
              <div className="mb-3 flex gap-1 text-xs">
                {(['all', 'needs-review', 'retired'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className={`min-h-8 rounded-full border px-3 ${filter === f ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:border-accent'}`}>
                    {f === 'all' ? 'In use' : f === 'needs-review' ? `Needs review (${review.length})` : 'Retired'}
                  </button>
                ))}
              </div>
              {entries.length === 0 ? (
                filter === 'all' ? (
                  <EmptyState compact icon={BookOpen} headline="No reviewed answers yet." body="Accept a flag and leadership can ask for it here." action={{ label: 'Go to the builder', icon: LayoutDashboard, onClick: onClose }} />
                ) : filter === 'needs-review' ? (
                  <EmptyState compact tone="success" icon={BadgeCheck} headline="Nothing needs review." body="Every answer in use still fits the catalog and still runs." />
                ) : (
                  <EmptyState compact icon={RotateCcw} headline="Nothing retired." body="Retired answers wait here, with the reason, in case you want one back." />
                )
              ) : (
                <ul className="space-y-2">
                  {entries.map((e) => (
                    <EntryRow key={e.id} entry={e} user={user} weeks={social.impact ? spark(playbook.asks, e.id) : null} bz={social.bz ? playbook.bz.filter((b) => b.week === week && b.entries.includes(e.id)).length : 0} onSave={(x) => void playbook.saveEntries([x])} />
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === 'coverage' && (
            <div className="space-y-2">
              <p className="text-xs text-ink-2">Measures with no reviewed answer are where Semaphore would be drafting for leadership. Worth covering before someone goes on leave.</p>
              {index.catalog.metrics.length === 0 ? (
                <EmptyState compact icon={CircleAlert} headline="No measures yet." body="Add data and check its measures; coverage shows which ones have a reviewed answer." />
              ) : (
                <ul className="space-y-1">
                  {coverage(playbook.entries, index).map((c) => (
                    <li key={c.metric} className="flex min-h-8 items-center gap-2 text-sm">
                      {c.entries === 0 ? <CircleAlert size={14} className="text-warn" /> : <BadgeCheck size={14} className="text-good" />}
                      <span className="flex-1">{c.label}</span>
                      {c.entries === 0 ? (
                        <button type="button" onClick={() => onAnswer(gapQuestion(c.label, user))} className="flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-xs hover:border-accent">
                          <Hammer size={12} /> Build
                        </button>
                      ) : (
                        <span className="text-xs text-ink-3">
                          {c.entries} reviewed answer{c.entries === 1 ? '' : 's'}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {tab === 'style' && <StyleTab style={style} overrides={playbook.styleOverrides} index={index} user={user} onSave={(o) => void playbook.saveStyleOverrides(o)} />}

          {tab === 'away' && <AwayTab playbook={playbook} user={user} onAnswer={onAnswer} />}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function QuestionRow({ q, showAskers, onAnswer, onDismiss }: { q: QuestionItem; showAskers: boolean; onAnswer: () => void; onDismiss: () => void }) {
  const { askers } = withAskers(q);
  const last = askers[askers.length - 1] ?? q.askedBy;
  const who = askers.length > 1 ? `Asked by ${askers.length} people${showAskers ? ` · most recently ${last}` : ''}` : showAskers ? `Asked by ${q.askedBy}` : 'Asked by one person';
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm font-medium">{q.title}</p>
        {askers.length > 1 && <span className="shrink-0 rounded-full bg-brass-soft px-2 py-0.5 text-[11px] font-semibold text-brass">{askers.length} asking</span>}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-3">
        {who} · first asked {shortDate(q.askedAt)} · {q.shown === 'drafted' ? 'they saw a draft, not reviewed' : 'they got no answer yet'}
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onAnswer} className="flex min-h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs font-semibold text-panel hover:opacity-90">
          <Sparkles size={12} /> Build the answer
        </button>
        <button type="button" onClick={onDismiss} className="min-h-8 rounded-md border border-line px-3 text-xs hover:border-bad hover:text-bad">
          Dismiss
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// This week: the team's shared story. Credit beside each person's own work, never a tally.

function WeekTab({ playbook, index, impact, waiting, onQuestions, onBuild, onClose }: { playbook: PlaybookState; index: CatalogIndex; impact: ReturnType<typeof impactFor>; waiting: number; onQuestions: () => void; onBuild: (label: string) => void; onClose: () => void }) {
  const w = useMemo(() => teamWeek(playbook.entries, playbook.questions, index), [playbook.entries, playbook.questions, index]);
  const full = w.total > 0 && w.covered === w.total;
  // "Full hoist" shows once, the first time every measure has a reviewed answer.
  const [fullNote] = useState(() => full && readLocal<boolean>(FULL_KEY) !== true);
  useEffect(() => {
    if (fullNote) writeLocal(FULL_KEY, true);
  }, [fullNote]);
  const pct = w.total ? Math.round((w.covered / w.total) * 100) : 0;
  const quiet = w.added.length === 0 && w.answered === 0;

  return (
    <div className="space-y-4">
      {impact && <ImpactCard impact={impact} onQuestions={onQuestions} />}

      <section className="rounded-[10px] border border-line p-4" aria-labelledby="week-title">
        <h3 id="week-title" className="font-display text-lg font-semibold leading-tight">
          The playbook this week
        </h3>
        {quiet ? (
          <p className="mt-1 text-sm text-ink-2">A quiet week so far. The gaps below are good places to start.</p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            {w.added.length > 0 && (
              <>
                <b className="text-ink">{w.added.length}</b> new reviewed answer{w.added.length === 1 ? '' : 's'}
              </>
            )}
            {w.added.length > 0 && w.answered > 0 && ' · '}
            {w.answered > 0 && (
              <>
                <b className="text-ink">{w.answered}</b> leadership question{w.answered === 1 ? '' : 's'} answered
              </>
            )}
          </p>
        )}

        {w.total > 0 && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-ink">
                Coverage: {w.covered} of {w.total} measures
                {w.gained > 0 && <span className="ml-1 font-semibold text-good">(+{w.gained} this week)</span>}
              </span>
              <span className="text-ink-3">Goal: every measure has a reviewed answer</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={w.total} aria-valuenow={w.covered} aria-label="Measures with a reviewed answer">
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {fullNote && (
          <p role="status" className="mt-3 flex items-center gap-2 rounded-lg bg-good-soft px-3 py-2 text-sm text-good">
            <PartyPopper size={15} /> <span><b>Full hoist.</b> Every measure has a reviewed answer. Well done, all of you.</span>
          </p>
        )}

        {w.added.length > 0 && (
          <div className="mt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">New this week</p>
            <ul className="mt-1 space-y-1">
              {w.added.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2 text-sm">
                  <BadgeCheck size={13} className="shrink-0 translate-y-0.5 text-good" />
                  <span className="min-w-0 flex-1 truncate italic" title={a.title}>
                    {a.title}
                  </span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {a.by}, {shortDate(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {w.gaps.length > 0 ? (
        <section className="rounded-[10px] border border-line p-4">
          <h3 className="text-sm font-semibold">Gaps worth covering before leave</h3>
          <p className="text-xs text-ink-2">Leadership gets a draft, not a reviewed answer, for these.</p>
          <ul className="mt-2 space-y-1">
            {w.gaps.slice(0, 5).map((g) => (
              <li key={g.metric} className="flex min-h-8 items-center gap-2 text-sm">
                <CircleAlert size={14} className="text-warn" />
                <span className="flex-1">{g.label}</span>
                <button type="button" onClick={() => onBuild(g.label)} className="flex min-h-8 items-center gap-1 rounded-md border border-line px-2.5 text-xs hover:border-accent">
                  <Hammer size={12} /> Build
                </button>
              </li>
            ))}
          </ul>
          {w.gaps.length > 5 && <p className="mt-1 text-[11px] text-ink-3">And {w.gaps.length - 5} more on the Coverage tab.</p>}
        </section>
      ) : w.total === 0 ? (
        <EmptyState compact icon={LayoutDashboard} headline="Nothing to cover yet." body="Add data and accept a few flags: the team's week fills in from the playbook." action={{ label: 'Go to the builder', onClick: onClose }} />
      ) : null}
      {waiting > 0 && !impact && (
        <button type="button" onClick={onQuestions} className="text-xs text-accent underline-offset-2 hover:underline">
          {waiting} leadership question{waiting === 1 ? ' is' : 's are'} waiting
        </button>
      )}
      <p className="text-[11px] text-ink-3">Names appear beside their own work as credit. Nobody is counted or ranked.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Impact: what this analyst's reviewed answers did for leadership. Shown only when positive or actionable.

function ImpactCard({ impact, onQuestions }: { impact: NonNullable<ReturnType<typeof impactFor>>; onQuestions: () => void }) {
  return (
    <section className="rounded-[10px] border border-accent/40 bg-accent-soft p-4" aria-label="Your impact this week">
      {impact.thisWeek > 0 ? (
        <p className="text-sm text-ink">
          <b>
            Your flags answered {impact.thisWeek} leadership question{impact.thisWeek === 1 ? '' : 's'} this week
          </b>
          {impact.lastWeek > 0 && impact.thisWeek > impact.lastWeek ? ` (up from ${impact.lastWeek})` : ''}.
          {impact.top && (
            <span className="text-ink-2">
              {' '}
              Most asked: <i>{impact.top.title}</i> ({impact.top.count}).
            </span>
          )}
        </p>
      ) : (
        <p className="text-sm text-ink">
          <b>Quiet week</b> <span className="text-ink-2">for your answers so far.</span>
        </p>
      )}
      {impact.bz > 0 && (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-2">
          <ThumbsUp size={13} className="text-accent" /> Leadership said <b className="text-ink">Bravo Zulu</b> {impact.bz} time{impact.bz === 1 ? '' : 's'}: your answers helped.
        </p>
      )}
      {impact.waiting > 0 && (
        <p className="mt-2 flex items-center gap-2 text-sm text-ink-2">
          {impact.waiting} question{impact.waiting === 1 ? ' is' : 's are'} waiting.
          <button type="button" onClick={onQuestions} className="min-h-8 rounded-md bg-accent px-3 text-xs font-semibold text-panel hover:opacity-90">
            Build one
          </button>
        </p>
      )}
    </section>
  );
}

/** Weekly counts as small bars, oldest first; a hover on each bar says the week's count. */
export function Sparkline({ weeks, label }: { weeks: number[]; label: string }) {
  const max = Math.max(1, ...weeks);
  const total = weeks.reduce((a, b) => a + b, 0);
  const W = 6;
  const GAP = 2;
  const H = 18;
  return (
    <svg width={weeks.length * (W + GAP) - GAP} height={H} viewBox={`0 0 ${weeks.length * (W + GAP) - GAP} ${H}`} role="img" aria-label={`${label}: ${total} in the last ${weeks.length} weeks`} className="shrink-0 overflow-visible">
      {weeks.map((n, i) => {
        const h = n === 0 ? 2 : Math.max(3, Math.round((n / max) * H));
        const ago = weeks.length - 1 - i;
        return (
          <rect key={i} x={i * (W + GAP)} y={H - h} width={W} height={h} rx={1.5} className={n === 0 ? 'fill-line' : i === weeks.length - 1 ? 'fill-accent' : 'fill-brass'}>
            <title>{`${ago === 0 ? 'This week' : ago === 1 ? 'Last week' : `${ago} weeks ago`}: ${n}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function EntryRow({ entry, user, weeks, bz, onSave }: { entry: PlaybookEntry; user: string; weeks: number[] | null; bz: number; onSave: (e: PlaybookEntry) => void }) {
  const [mode, setMode] = useState<'idle' | 'retire' | 'review'>('idle');
  const [reason, setReason] = useState('');
  const asked = weeks ? weeks.reduce((a, b) => a + b, 0) : 0;
  const btn = 'min-h-8 rounded-md border border-line px-2.5';
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{entry.title}</p>
          <p className="truncate text-xs text-ink-2" title={entry.question}>
            "{entry.question}"
          </p>
          <p className="mt-0.5 text-[11px] text-ink-3">
            {entry.acceptedBy}, {shortDate(entry.acceptedAt)} · {entry.hoist.title}
            {entry.phrasings.length ? ` · ${entry.phrasings.length} other wording${entry.phrasings.length === 1 ? '' : 's'}` : ''}
            {bz > 0 ? ` · BZ ×${bz} this week` : ''}
          </p>
        </div>
        {weeks && asked > 0 && (
          <div className="flex flex-col items-end gap-0.5" title="Reviewed answers given to leadership, per week, last 8 weeks">
            <Sparkline weeks={weeks} label={`Asked for ${entry.title}`} />
            <span className="text-[10px] text-ink-3">{asked} in 8 weeks</span>
          </div>
        )}
        {entry.status === 'needs-review' && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">Needs review</span>}
        {entry.status === 'retired' && <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">Retired</span>}
      </div>
      {entry.review && entry.status === 'needs-review' && <p className="mt-1.5 rounded bg-warn-soft px-2 py-1 text-xs text-ink">{entry.review.reason}</p>}
      {entry.retired && <p className="mt-1.5 text-xs text-ink-3">Retired by {entry.retired.by}: {entry.retired.reason}</p>}
      {mode === 'idle' ? (
        <div className="mt-2 flex gap-2 text-xs">
          {entry.status === 'retired' ? (
            <button type="button" onClick={() => onSave(restoreEntry(entry))} className={`flex items-center gap-1 ${btn} hover:border-accent`}>
              <RotateCcw size={12} /> Restore
            </button>
          ) : (
            <>
              {entry.status === 'needs-review' ? (
                <button
                  type="button"
                  onClick={() => {
                    onSave(restoreEntry(entry));
                    recordSkill('review', { hoistId: entry.hoist.id });
                    recordWatch('review');
                  }}
                  className={`${btn} hover:border-good hover:text-good`}
                >
                  Still right
                </button>
              ) : (
                <button type="button" onClick={() => setMode('review')} className={`${btn} hover:border-warn`}>
                  Flag for review
                </button>
              )}
              <button type="button" onClick={() => setMode('retire')} className={`${btn} hover:border-bad hover:text-bad`}>
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
          <input autoFocus value={reason} onChange={(ev) => setReason(ev.target.value.slice(0, 300))} placeholder={mode === 'retire' ? 'Why retire it? e.g. backlog now excludes cancelled orders' : 'What needs checking?'} aria-label="Reason" className="min-h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-xs focus:border-accent focus:outline-none" />
          <button type="submit" className="min-h-8 rounded-md bg-accent px-3 text-xs font-semibold text-panel">
            {mode === 'retire' ? 'Retire' : 'Flag'}
          </button>
          <button type="button" onClick={() => setMode('idle')} className="min-h-8 rounded-md px-2 text-xs text-ink-3 hover:bg-panel-2">
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

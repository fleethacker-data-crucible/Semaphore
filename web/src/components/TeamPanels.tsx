// The team side of the playbook panel: the team style card (how this team builds, learnt from
// accepted flags, owned by the analysts) and away mode with its "while you were out" digest.

import { useState } from 'react';
import { CalendarOff, CircleAlert, MessageSquareText, Pin, PinOff, Sparkles, ToggleLeft, ToggleRight } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { type AwayNotice, awayId, isAway, isReturned, markBack, newAwayNotice, whileYouWereOut } from '../../../src/core/away.ts';
import type { FlagKind } from '../../../src/core/hoist.ts';
import type { QuestionItem } from '../../../src/core/playbook.ts';
import { MIN_EVIDENCE, SHAPE_LABEL, type Shape, type StyleOverrides, type StyleRule, type TeamStyle } from '../../../src/core/style.ts';
import type { PlaybookState } from '../lib/playbook.ts';
import { EmptyState } from './EmptyState.tsx';

const KIND_LABEL: Record<FlagKind, string> = { kpi: 'KPI', bar: 'bar', line: 'line', area: 'area', pie: 'pie', table: 'table', filter: 'picker', text: 'note', radar: 'spider', scatter: 'scatter', heatmap: 'heatmap', calendar: 'calendar', waterfall: 'waterfall', pareto: 'Pareto', sankey: 'Sankey', sunburst: 'sunburst', stream: 'stream', model: 'model', pivot: 'pivot' };

export function StyleTab({ style, overrides, index, user, onSave }: { style: TeamStyle; overrides: StyleOverrides; index: CatalogIndex; user: string; onSave: (o: StyleOverrides) => void }) {
  const save = (next: Partial<StyleOverrides>) => onSave({ ...overrides, ...next, updatedBy: user, updated: new Date().toISOString() });
  const toggle = (key: string) => save({ off: overrides.off.includes(key) ? overrides.off.filter((k) => k !== key) : [...overrides.off, key] });
  const unpin = (key: string) => {
    const pinned = { ...overrides.pinned };
    delete pinned[key];
    save({ pinned });
  };
  const rows: Array<{ rule: StyleRule<unknown>; text: string }> = [];
  for (const shape of Object.keys(SHAPE_LABEL) as Shape[]) {
    const r = style.chart[shape];
    if (r) rows.push({ rule: r, text: `${SHAPE_LABEL[shape][0]!.toUpperCase()}${SHAPE_LABEL[shape].slice(1)} as a ${KIND_LABEL[r.value]}` });
  }
  if (style.grain) rows.push({ rule: style.grain, text: `Time shown by ${style.grain.value}` });
  if (style.topN) rows.push({ rule: style.topN, text: `Breakdowns cut to the top ${style.topN.value}` });
  if (style.window) rows.push({ rule: style.window, text: `Pages cover the last ${style.window.value.count} ${style.window.value.unit}s` });
  for (const [metric, r] of Object.entries(style.redRules)) {
    const rules = r.value.map((t) => `${t.tone === 'bad' ? 'red' : t.tone === 'warn' ? 'amber' : 'green'} ${t.op.startsWith('g') ? 'over' : 'under'} ${t.value.toLocaleString()}`).join(', ');
    rows.push({ rule: r, text: `${index.metric(metric)?.label ?? metric}: ${rules}` });
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-2">
        How this team builds, learnt from {style.learnedFrom} accepted flag{style.learnedFrom === 1 ? '' : 's'}. When Semaphore drafts (for you, or for leadership while you are out), it fills in what a brief leaves open the way the team would, and says so in the flag's notes. Switch off anything that is a coincidence rather than a habit.
      </p>
      {rows.length === 0 ? (
        <EmptyState compact icon={Sparkles} headline="No habits yet." body={`A habit needs at least ${MIN_EVIDENCE} accepted flags that agree. Accept a few flags and the card fills in.`} />
      ) : (
        <ul className="space-y-1.5">
          {rows.map(({ rule, text }) => {
            const off = style.off.includes(rule.key);
            return (
              <li key={rule.key} className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 ${off ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${off ? 'line-through' : ''}`}>{text}</p>
                  <p className="text-[11px] text-ink-3">{rule.pinned ? `Set by the team${overrides.updatedBy ? ` (${overrides.updatedBy})` : ''}` : `${rule.evidence} of ${rule.of} accepted flags`}</p>
                </div>
                {rule.pinned ? (
                  <button type="button" onClick={() => unpin(rule.key)} title="Stop pinning; go back to what the team's flags show" aria-label={`Unpin: ${text}`} className="rounded p-1 text-brass hover:bg-panel-2">
                    <PinOff size={14} />
                  </button>
                ) : (
                  rule.key.startsWith('chart.') || rule.key === 'grain' || rule.key === 'topN' ? (
                    <button type="button" onClick={() => save({ pinned: { ...overrides.pinned, [rule.key]: rule.value } })} title="Pin it, so it stays even if the team's flags change" aria-label={`Pin: ${text}`} className="rounded p-1 text-ink-3 hover:bg-panel-2">
                      <Pin size={14} />
                    </button>
                  ) : null
                )}
                <button type="button" onClick={() => toggle(rule.key)} aria-pressed={!off} aria-label={`${off ? 'Use' : 'Do not use'}: ${text}`} className={`rounded p-1 hover:bg-panel-2 ${off ? 'text-ink-3' : 'text-accent'}`}>
                  {off ? <ToggleLeft size={18} /> : <ToggleRight size={18} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-ink-3">Learnt only from accepted flags, never from drafts, flags marked "do not learn" or experiment pages. Nothing about how anyone works is recorded.</p>
    </div>
  );
}

export function AwayTab({ playbook, user, onAnswer }: { playbook: PlaybookState; user: string; onAnswer: (q: QuestionItem) => void }) {
  const mine = playbook.away.find((n) => n.id === awayId(user));
  const others = playbook.away.filter((n) => n.id !== awayId(user) && isAway(n));
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {others.length > 0 && (
        <ul className="space-y-1 text-xs text-ink-2">
          {others.map((n) => (
            <li key={n.id} className="flex items-center gap-2">
              <CalendarOff size={12} /> {n.analyst} is out until {n.until}
              {n.note ? `: ${n.note}` : ''}
            </li>
          ))}
        </ul>
      )}

      {mine && isReturned(mine) ? (
        <Digest notice={mine} playbook={playbook} onAnswer={onAnswer} onDone={() => playbook.removeAway(mine.id)} />
      ) : mine ? (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-sm font-medium">
            {isAway(mine) ? 'You are marked out' : 'You are marked out from'} {mine.from} to {mine.until}
          </p>
          <p className="text-xs text-ink-2">Leadership sees this in the Ask view. Familiar questions are answered from the playbook; new ones wait here for you.{mine.note ? ` Your note: "${mine.note}"` : ''}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => playbook.saveAway(markBack(mine))} className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-panel">
              I'm back
            </button>
            <button type="button" onClick={() => playbook.removeAway(mine.id)} className="rounded-md border border-line px-2.5 py-1 text-xs hover:border-bad hover:text-bad">
              Cancel it
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2 rounded-lg border border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              void playbook.saveAway(newAwayNotice(user, from, until, note));
              setError(null);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <p className="text-sm font-medium">Going on leave?</p>
          <p className="text-xs text-ink-2">Semaphore tells leadership you are out, keeps answering the questions you have already reviewed, and holds anything new. When you are back, you get a digest of what happened.</p>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-0.5">
              From
              <input id="away-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-line bg-panel px-2 py-1" />
            </label>
            <label className="flex flex-col gap-0.5">
              Until
              <input id="away-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="rounded-md border border-line bg-panel px-2 py-1" />
            </label>
          </div>
          <input id="away-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="Note for leadership (optional), e.g. urgent requests to the watch officer" aria-label="Note for leadership" className="w-full rounded-md border border-line bg-panel px-2 py-1 text-xs" />
          {error && <p className="text-xs text-bad">{error}</p>}
          <button type="submit" className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-panel">
            Mark me out
          </button>
        </form>
      )}
    </div>
  );
}

function Digest({ notice, playbook, onAnswer, onDone }: { notice: AwayNotice; playbook: PlaybookState; onAnswer: (q: QuestionItem) => void; onDone: () => void }) {
  const d = whileYouWereOut(notice, playbook.questions, playbook.entries);
  return (
    <div className="space-y-3 rounded-lg border border-accent p-3">
      <p className="text-sm font-semibold">While you were out ({d.from} to {d.to})</p>
      <ul className="space-y-1 text-xs text-ink-2">
        <li>{d.asked.length} question{d.asked.length === 1 ? '' : 's'} from leadership</li>
        <li>{d.usedEntries.length} of your reviewed answers used{d.usedEntries.length ? `: ${d.usedEntries.slice(0, 3).map((e) => e.title).join(', ')}${d.usedEntries.length > 3 ? '…' : ''}` : ''}</li>
        <li>{d.drafted.length} answered with a draft that needs your review</li>
        <li>{d.waiting.length} with no answer yet</li>
        {d.needsReview.length > 0 && <li>{d.needsReview.length} reviewed answer{d.needsReview.length === 1 ? '' : 's'} flagged for review</li>}
      </ul>
      {[...d.drafted, ...d.waiting].length > 0 && (
        <ul className="space-y-1.5">
          {[...d.drafted, ...d.waiting].map((q) => (
            <li key={q.id} className="flex items-center gap-2 text-sm">
              {q.shown === 'drafted' ? <MessageSquareText size={14} className="text-warn" /> : <CircleAlert size={14} className="text-bad" />}
              <span className="min-w-0 flex-1 truncate" title={q.title}>
                {q.title}
              </span>
              <button type="button" onClick={() => onAnswer(q)} className="rounded-md border border-line px-2 py-0.5 text-xs hover:border-accent">
                Build the answer
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={onDone} className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-panel">
        {d.actionNeeded ? 'Got it (questions stay in the queue)' : 'Got it'}
      </button>
    </div>
  );
}

// The leadership view: ask in plain English, get an answer and how far to trust it. Answers come
// from the analysts' reviewed work (the playbook), read from snapshots so nobody needs database
// access; anything Semaphore had to draft is labelled, and anything it cannot answer goes to the
// analysts' queue. Above the answers, a briefing of what changed across the reviewed flags.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BadgeCheck, CalendarOff, CircleHelp, Clock, Inbox, LayoutDashboard, Lightbulb, Moon, Send, Sparkles, Sun, Wand2 } from 'lucide-react';
import { isAway } from '../../../src/core/away.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { describeFlag, formatNumber } from '../../../src/core/describe.ts';
import { type Hoist, toneFor } from '../../../src/core/hoist.ts';
import { findInsights, type Insight } from '../../../src/core/insights.ts';
import { type Answer, answerQuestion, entryFlag, followUps, newQuestion, normalizeQuestion, recordUse } from '../../../src/core/playbook.ts';
import { answerFromSnapshots } from '../../../src/core/snapshot.ts';
import { canReach, computeFlag, type DataContext, type FlagResult } from '../lib/data.ts';
import type { PlaybookState } from '../lib/playbook.ts';
import { FlagView } from './FlagView.tsx';

export interface AskViewProps {
  index: CatalogIndex;
  ctx: DataContext;
  playbook: PlaybookState;
  user: string;
  theme: 'light' | 'dark';
  /** Changes with the theme and the skin, so charts re-read their colours. */
  themeKey: string;
  onTheme: () => void;
  onBuilder: () => void;
  /** The last full refresh (Launch-Semaphore.bat --refresh), when there has been one. */
  lastRefresh?: { at: string; computer: string; refreshed: number; failed: unknown[] } | null;
}

interface Shown {
  key: number;
  answer: Answer;
  state: 'working' | 'ready' | 'unanswered';
  result?: FlagResult;
  /** Where the numbers came from. */
  from?: { kind: 'snapshot'; asOf: string } | { kind: 'live' };
  queued?: boolean;
  problem?: string;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

function asOfText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function AskView({ index, ctx, playbook, user, theme, themeKey, onTheme, onBuilder, lastRefresh }: AskViewProps) {
  const [q, setQ] = useState('');
  const [answers, setAnswers] = useState<Shown[]>([]);
  const counter = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const live = playbook.entries.filter((e) => e.status !== 'retired');

  const popular = useMemo(
    () =>
      [...live]
        .sort((a, b) => b.uses - a.uses || b.acceptedAt.localeCompare(a.acceptedAt))
        .slice(0, 6)
        .map((e) => e.question.split(/(?<=[.?!])\s/)[0]!.replace(/\.$/, '')),
    [live],
  );

  // What changed: insights across every reviewed flag that has a snapshot, worst first.
  const briefing = useMemo(() => {
    const out: Array<{ insight: Insight; question: string; title: string }> = [];
    for (const e of live) {
      const snap = playbook.snapshots.find((s) => s.entryId === e.id);
      if (!snap) continue;
      const flag = entryFlag(e);
      const a = answerFromSnapshots(flag, e.pageFilters, [snap]);
      if (!a) continue;
      for (const insight of findInsights({ flag, rows: a.display.rows, ...(a.previous ? { previous: a.previous } : {}), totals: a.display.totals, today: ctx.today }, index)) {
        if (/still running/.test(insight.text)) continue;
        out.push({ insight, question: e.question, title: e.title });
      }
    }
    const rank = { bad: 0, warn: 1, good: 2, info: 3 } as const;
    return out.sort((a, b) => rank[a.insight.tone] - rank[b.insight.tone]).slice(0, 6);
  }, [live, playbook.snapshots, index, ctx.today]);

  // At a glance: the reviewed headline numbers, from their snapshots.
  const glance = useMemo(() => {
    const out: Array<{ title: string; question: string; value: number | null; before: number | null; format?: 'number' | 'currency' | 'percent'; tone: string }> = [];
    for (const e of live) {
      if (e.kind !== 'kpi') continue;
      const snap = playbook.snapshots.find((s) => s.entryId === e.id);
      const key = e.binding.metrics[0];
      if (!snap || !key) continue;
      const a = answerFromSnapshots(entryFlag(e), e.pageFilters, [snap]);
      const v = a?.display.rows[0]?.values[key] ?? null;
      const before = a?.previous?.[0]?.[key] ?? null;
      const tone = typeof v === 'number' ? (toneFor({ onClick: 'none', ignore: [], thresholds: e.thresholds }, key, v) ?? '') : '';
      out.push({ title: e.title, question: e.question, value: v, before, format: index.metric(key)?.format, tone });
    }
    return out.slice(0, 8);
  }, [live, playbook.snapshots, index]);

  const oldest = playbook.snapshots.length ? playbook.snapshots.reduce((a, s) => (s.asOf < a ? s.asOf : a), playbook.snapshots[0]!.asOf) : null;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setQ('');
    const key = ++counter.current;
    const answer = answerQuestion(text, playbook.entries, index);
    const shown: Shown = { key, answer, state: 'working' };
    setAnswers((list) => [shown, ...list].slice(0, 20));
    const update = (patch: Partial<Shown>) => setAnswers((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));

    if (answer.trust === 'none' || !answer.flag.binding) {
      update({ state: 'unanswered', queued: await queue(text, 'none', answer.reasons) });
      return;
    }
    const hoist: Hoist = { version: 1, id: 'ask', title: 'Ask', brief: '', grid: { cols: 12 }, filters: answer.filters, flags: [answer.flag], updated: '' };
    // 1. Snapshots: no database needed.
    const snap = answerFromSnapshots(answer.flag, answer.filters, playbook.snapshots);
    let patch: Partial<Shown> | null = null;
    if (snap && answer.trust === 'drafted') {
      // The numbers are a reviewed flag's own, re-added: same measures, same window. Only the split is new.
      const source = playbook.entries.find((e) => e.id === snap.snapshot.entryId && e.status !== 'retired');
      if (source) {
        const upgraded: Answer = { ...answer, trust: 'adjusted', entry: source, reasons: [`Worked out from the saved numbers of "${source.title}", reviewed by ${source.acceptedBy}: same measures and window, re-added to what you asked.`] };
        update({ answer: upgraded });
        Object.assign(answer, upgraded);
      }
    }
    if (snap) {
      patch = { state: 'ready', result: { plan: snap.plan, sql: null, display: snap.display, ...(snap.previous ? { previous: snap.previous } : {}), origin: 'page', ms: 0, requeried: [] }, from: { kind: 'snapshot', asOf: snap.snapshot.asOf } };
    } else {
      // 2. Live, when this computer can reach the source (an analyst's machine, or sample data).
      const source = answer.flag.binding.metrics[0] ? index.metric(answer.flag.binding.metrics[0])?.source : undefined;
      if (source && canReach(source, ctx)) {
        try {
          const result = await computeFlag(hoist, answer.flag, {}, ctx);
          patch = { state: 'ready', result, from: { kind: 'live' } };
        } catch (e) {
          patch = { state: 'unanswered', problem: (e as Error).message };
        }
      } else {
        patch = { state: 'unanswered', problem: 'None of the saved snapshots covers this yet, and this computer does not read the database itself.' };
      }
    }
    if (answer.trust === 'drafted' || patch.state === 'unanswered') patch.queued = await queue(text, patch.state === 'unanswered' ? 'none' : 'drafted', answer.reasons);
    update(patch);
    if (answer.entry && patch.state === 'ready') playbook.saveEntries([recordUse(answer.entry)]).catch(() => undefined);
  };

  const queue = async (text: string, shown: 'drafted' | 'none', notes: string[]): Promise<boolean> => {
    const asked = normalizeQuestion(text);
    if (playbook.questions.some((x) => x.status === 'open' && normalizeQuestion(x.title) === asked)) return true;
    try {
      await playbook.saveQuestion(newQuestion(text, user, shown, notes));
      return true;
    } catch {
      return false;
    }
  };

  useEffect(() => input.current?.focus(), []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-5 py-2.5">
        <img src="brand/mark.svg" alt="" className="h-7 w-7" />
        <div className="flex flex-col">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">Semaphore</span>
          <span className="text-[15px] font-semibold leading-tight">Ask</span>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-ink-3">
          {oldest && (
            <span
              className="flex items-center gap-1"
              title={`When the oldest saved answer was read from its source.${lastRefresh ? ` Last full refresh ${asOfText(lastRefresh.at)} on ${lastRefresh.computer || 'the refresher'}: ${lastRefresh.refreshed} refreshed${lastRefresh.failed.length ? `, ${lastRefresh.failed.length} failed` : ''}.` : ' No scheduled refresh has run; answers refresh when an analyst opens Semaphore.'}`}
            >
              <Clock size={13} /> Data as of {asOfText(oldest)} ({ago(oldest)})
            </span>
          )}
          <span className="flex items-center gap-1" title="Reviewed answers in the playbook">
            <BadgeCheck size={13} /> {live.length} reviewed answer{live.length === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={onTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="rounded-md p-1.5 text-ink-2 hover:bg-panel-2">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button type="button" onClick={onBuilder} className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-ink-2 hover:border-accent" title="Open the analysts' builder">
            <LayoutDashboard size={13} /> Builder
          </button>
        </div>
      </header>

      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-5 py-8">
          {playbook.away.filter((n) => isAway(n)).map((n) => (
            <p key={n.id} role="status" className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              <CalendarOff size={16} className="mt-0.5 shrink-0 text-brass" />
              <span>
                <b>{n.analyst}</b> is out until {n.until}. Questions they have already reviewed are answered as usual; new ones wait for their return.
                {n.note ? <span className="text-ink-2"> {n.note}</span> : null}
              </span>
            </p>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(q);
            }}
            className="flex items-center gap-2 rounded-2xl border border-line bg-panel px-4 py-2 shadow-sm focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15"
          >
            <Sparkles size={18} className="shrink-0 text-brass" />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value.slice(0, 400))}
              placeholder="Ask anything about the numbers, e.g. which region cost the most this year?"
              aria-label="Ask a question"
              className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none placeholder:text-ink-3"
            />
            <button type="submit" disabled={!q.trim()} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-panel disabled:opacity-40" aria-label="Ask">
              <Send size={15} /> Ask
            </button>
          </form>

          {popular.length > 0 && answers.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {popular.map((p) => (
                <button key={p} type="button" onClick={() => void ask(p)} className="rounded-full border border-line bg-panel px-3 py-1 text-sm text-ink-2 hover:border-accent hover:text-ink">
                  {p}
                </button>
              ))}
            </div>
          )}

          {glance.length > 0 && answers.length === 0 && (
            <section aria-label="At a glance" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {glance.map((g) => (
                <button key={g.title} type="button" onClick={() => void ask(g.question)} className="rounded-2xl border border-line bg-panel p-4 text-left shadow-sm hover:border-accent">
                  <span className="block text-xs text-ink-3">{g.title}</span>
                  <span className={`mt-1 block text-2xl font-semibold tabular-nums ${g.tone === 'bad' ? 'text-bad' : g.tone === 'warn' ? 'text-warn' : g.tone === 'good' ? 'text-good' : 'text-ink'}`}>{formatNumber(g.value, g.format)}</span>
                  {typeof g.value === 'number' && typeof g.before === 'number' && g.before !== 0 && (
                    <span className="text-xs text-ink-2">
                      {g.value >= g.before ? '▲' : '▼'} {Math.abs(Math.round(((g.value - g.before) / Math.abs(g.before)) * 100))}% on before
                    </span>
                  )}
                </button>
              ))}
            </section>
          )}

          {answers.map((a) => (
            <AnswerCard key={a.key} shown={a} index={index} onAsk={(x) => void ask(x)} themeKey={themeKey} />
          ))}

          {briefing.length > 0 && (
            <section aria-label="What changed" className="rounded-2xl border border-line bg-panel p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Lightbulb size={15} className="text-brass" /> What changed
                <span className="font-normal text-ink-3">across the analysts' reviewed flags</span>
              </h2>
              <ul className="divide-y divide-line">
                {briefing.map((b, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => void ask(b.question)} className="group flex w-full items-start gap-3 py-2.5 text-left">
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${b.insight.tone === 'bad' ? 'bg-bad' : b.insight.tone === 'warn' ? 'bg-warn' : 'bg-accent'}`} />
                      <span className="flex-1">
                        <span className="block text-sm text-ink">{b.insight.text}</span>
                        <span className="text-xs text-ink-3">{b.title}</span>
                      </span>
                      <ArrowRight size={15} className="mt-1 text-ink-3 opacity-0 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {playbook.loaded && live.length === 0 && (
            <section className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-ink-2">
              <Wand2 size={20} className="mx-auto mb-2 text-brass" />
              <p className="font-medium text-ink">No reviewed answers yet.</p>
              <p className="mt-1">
                When analysts accept flags in the builder, those answers appear here. You can still ask: Semaphore drafts from the catalog, labels it as not reviewed, and sends the question to the analysts.
              </p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

const TRUST: Record<Answer['trust'], { label: string; tone: string; icon: typeof BadgeCheck }> = {
  reviewed: { label: 'Reviewed', tone: 'bg-good-soft text-good', icon: BadgeCheck },
  adjusted: { label: 'Worked out from a reviewed flag', tone: 'bg-good-soft text-good', icon: BadgeCheck },
  drafted: { label: 'Drafted by Semaphore, not reviewed', tone: 'bg-warn-soft text-warn', icon: CircleHelp },
  none: { label: "Can't answer yet", tone: 'bg-panel-2 text-ink-2', icon: Inbox },
};

function AnswerCard({ shown, index, onAsk, themeKey }: { shown: Shown; index: CatalogIndex; onAsk: (q: string) => void; themeKey: string }) {
  const [why, setWhy] = useState(false);
  const { answer, result } = shown;
  const t = TRUST[shown.state === 'unanswered' && answer.trust !== 'none' ? 'none' : answer.trust];
  const Icon = t.icon;
  const hoist: Hoist = { version: 1, id: 'ask', title: '', brief: '', grid: { cols: 12 }, filters: answer.filters, flags: [], updated: '' };
  const insights = result && answer.flag.binding ? findInsights({ flag: answer.flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals }, index) : [];
  const chips = shown.state === 'ready' ? followUps(answer, index) : [];
  const tall = answer.flag.kind !== 'kpi';
  return (
    <article className="rounded-2xl border border-line bg-panel p-5 shadow-sm" aria-label={`Answer: ${answer.question}`}>
      <p className="text-xs text-ink-3">You asked</p>
      <h2 className="text-lg font-semibold">{answer.question}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${t.tone}`}>
          <Icon size={13} /> {t.label}
          {answer.entry && shown.state === 'ready' ? ` · ${answer.entry.acceptedBy}, ${answer.entry.acceptedAt.slice(0, 10)}` : ''}
        </span>
        {shown.from?.kind === 'snapshot' && (
          <span className="flex items-center gap-1 text-ink-3">
            <Clock size={12} /> Data as of {asOfText(shown.from.asOf)}
          </span>
        )}
        {shown.from?.kind === 'live' && <span className="text-ink-3">Live data</span>}
        {shown.queued && <span className="text-ink-3">· Sent to the analysts {answer.trust === 'drafted' && shown.state === 'ready' ? 'to review' : 'to answer'}</span>}
        <button type="button" onClick={() => setWhy((w) => !w)} className="text-accent underline-offset-2 hover:underline" aria-expanded={why}>
          Why this answer?
        </button>
      </div>
      {why && (
        <ul className="mt-2 list-disc space-y-0.5 rounded-lg bg-panel-2 py-2 pl-7 pr-3 text-xs text-ink-2">
          {answer.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {shown.state === 'working' && <p className="mt-4 text-sm text-ink-3">Working it out…</p>}
      {shown.state === 'unanswered' && (
        <p className="mt-4 text-sm text-ink-2">{shown.problem ?? answer.reasons[answer.reasons.length - 1] ?? 'Semaphore could not match that to the data it knows.'} {shown.queued ? 'The analysts have it in their queue.' : ''}</p>
      )}
      {shown.state === 'ready' && result && answer.flag.binding && (
        <>
          <p className="mt-3 text-sm text-ink-2">{describeFlag(answer.flag, hoist, index).join(' ')}</p>
          <div className={`mt-3 rounded-xl border border-line p-3 ${tall ? 'h-72' : 'h-28'}`}>
            <FlagView flag={answer.flag} result={result} index={index} selections={{}} onSelect={() => undefined} themeKey={themeKey} />
          </div>
          {insights.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {insights.map((i) => (
                <li key={i.text} className="flex gap-2">
                  <Lightbulb size={14} className="mt-0.5 shrink-0 text-brass" /> {i.text}
                </li>
              ))}
            </ul>
          )}
          {chips.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-ink-3">Then ask:</span>
              {chips.map((c) => (
                <button key={c.label} type="button" onClick={() => onAsk(c.question)} className="rounded-full border border-line px-3 py-0.5 text-ink-2 hover:border-accent hover:text-ink">
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

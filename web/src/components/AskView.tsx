// The leadership view: ask in plain English, get an answer and how far to trust it. Answers come
// from the analysts' reviewed work (the playbook), read from snapshots so nobody needs database
// access; anything Semaphore had to draft is labelled, and anything it cannot answer goes to the
// analysts' queue. Above the answers, a briefing of what changed across the reviewed flags.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ArrowRight, BadgeCheck, Bell, BellRing, CheckCircle2, Info, CalendarOff, Check, CircleCheck, CircleHelp, Clock, Gauge, Inbox, LayoutDashboard, Lightbulb, Mail, Settings2, Moon, Send, Sparkles, Sun, ThumbsUp, Wand2, X } from 'lucide-react';
import { type Alert, alertableMetrics, alertId, alertReading, alertTarget, newAlert, parseAlertRequest, primeAlert, redRule, ruleText, unseen } from '../../../src/core/alerts.ts';
import { answerQuality, durationText } from '../../../src/core/answer-quality.ts';
import { canAskForReview, dataAccessNote, draftOf, requestReview, reviewAsked, TRUST_LABELS } from '../../../src/core/review.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { loadAlerts, saveAlert, subscribeAlerts } from '../lib/alerts.ts';
import { glance as glanceTiles, whatChanged } from '../lib/briefing-package.ts';
import { ReportsShelf } from './Reports.tsx';
import { isAway } from '../../../src/core/away.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { describeFlag, formatNumber } from '../../../src/core/describe.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { hasBz } from '../../../src/core/impact.ts';
import { addAsker, type Answer, answerQuestion, followUps, newQuestion, normalizeQuestion, type PlaybookEntry, type QuestionItem, withAskers } from '../../../src/core/playbook.ts';
import { answerFromSnapshots } from '../../../src/core/snapshot.ts';
import { canReach, computeFlag, type DataContext, type FlagResult } from '../lib/data.ts';
import type { PlaybookState } from '../lib/playbook.ts';
import { readLocal, writeLocal } from '../lib/storage.ts';
import { EmptyState } from './EmptyState.tsx';
import { FlagView } from './FlagView.tsx';

const AlertsPanel = lazy(() => import('./AlertsPanel.tsx').then((m) => ({ default: m.AlertsPanel })));
const BriefingMail = lazy(() => import('./BriefingMail.tsx').then((m) => ({ default: m.BriefingMail })));

export interface AskViewProps {
  index: CatalogIndex;
  ctx: DataContext;
  playbook: PlaybookState;
  user: string;
  theme: 'light' | 'dark';
  /** Changes with the theme and the skin, so charts re-read their colours. */
  themeKey: string;
  onTheme: () => void;
  onSettings: () => void;
  onBuilder: () => void;
  /** The last full refresh (Launch-Semaphore.bat --refresh), when there has been one. */
  lastRefresh?: { at: string; computer: string; refreshed: number; failed: unknown[] } | null;
  /** True with Semaphore's server: alerts and mail drafts go through it. */
  server?: boolean;
  /**
   * Drafts a question no reviewed answer and no local rule could, with the drafting provider set up
   * here (Fairlead when it is on). Null when nothing fits. The result is always shown as drafted.
   */
  drafter?: (question: string) => Promise<{ flag: Flag; by: string } | null>;
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
  /** Who drafted it, for a drafted answer. */
  draftBy?: string;
  /** "Ask for review" was pressed (or this person already asked). */
  reviewAsked?: boolean;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

const SEEN_KEY = 'semaphore.askSeen';

function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function asOfText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function AskView({ index, ctx, playbook, user, theme, themeKey, onTheme, onSettings, onBuilder, lastRefresh, server = false, drafter }: AskViewProps) {
  const [q, setQ] = useState('');
  const [answers, setAnswers] = useState<Shown[]>([]);
  const counter = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const live = playbook.entries.filter((e) => e.status !== 'retired');

  // Your questions: answered since you asked, and not yet seen here (semaphore.askSeen).
  const [seen, setSeen] = useState<string[]>(() => readLocal<string[]>(SEEN_KEY) ?? []);
  const markSeen = (id: string) => {
    const next = [...seen.filter((x) => x !== id), id].slice(-200);
    setSeen(next);
    writeLocal(SEEN_KEY, next);
  };
  const answeredForMe = playbook.questions
    .filter((x) => x.status === 'answered' && !seen.includes(x.id) && (x.askedBy === user || withAskers(x).askers.includes(user)))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 3);

  const popular = useMemo(
    () =>
      [...live]
        .sort((a, b) => b.uses - a.uses || b.acceptedAt.localeCompare(a.acceptedAt))
        .slice(0, 6)
        .map((e) => e.question.split(/(?<=[.?!])\s/)[0]!.replace(/\.$/, '')),
    [live],
  );

  // What changed and the headline numbers: reviewed flags only, from their snapshots (lib/briefing-package.ts).
  const briefing = useMemo(() => whatChanged(live, playbook.snapshots, index, ctx.today), [live, playbook.snapshots, index, ctx.today]);
  const glance = useMemo(() => glanceTiles(live, playbook.snapshots, index), [live, playbook.snapshots, index]);

  // Alerts (lib/alerts.ts): this person's, kept fresh by every check on the page.
  const [alerts, setAlerts] = useState<Alert[]>([]);
  useEffect(() => subscribeAlerts(setAlerts), []);
  useEffect(() => {
    void loadAlerts(server).catch(() => undefined);
  }, [server]);
  const [panel, setPanel] = useState<'alerts' | 'mail' | null>(null);
  const [alertNote, setAlertNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fresh = unseen(alerts, user).length;
  const hasAlert = (entryId: string, metric: string) => alerts.some((a) => a.id === alertId(user, entryId, metric));
  const createAlert = async (entry: PlaybookEntry, metric: string, notifyClear = false) => {
    const id = alertId(user, entry.id, metric);
    if (alerts.some((a) => a.id === id)) {
      setAlertNote({ ok: true, text: `You already have an alert on ${index.metric(metric)?.label ?? metric}. See Alerts.` });
      return;
    }
    const made = newAlert(entry, metric, user, index, { notifyClear });
    if (!made) return;
    const a = primeAlert(made, alertReading(made, playbook.entries, playbook.snapshots));
    try {
      await saveAlert(server, a);
      setAlertNote({
        ok: true,
        text: `Alert set: you will be told when ${a.metricLabel} goes red (${ruleText(a.rule, a.format)}). It is checked whenever its data refreshes.${a.state === 'red' ? ' It is red now, so you are told the next time it goes red after coming back within its rule.' : ''}`,
      });
    } catch {
      setAlertNote({ ok: false, text: 'Could not save the alert. Try again.' });
    }
  };

  // Answer quality: from the ask files and the question queue (src/core/answer-quality.ts).
  const quality = useMemo(() => answerQuality({ asks: playbook.asks, questions: playbook.questions, counted: playbook.social.impact }), [playbook.asks, playbook.questions, playbook.social.impact]);

  // Drafts an analyst looked at and did not accept, for the person who asked.
  const rejectedForMe = playbook.questions.filter((x) => x.status === 'dismissed' && x.rejected && !seen.includes(x.id) && (x.askedBy === user || withAskers(x).askers.includes(user))).slice(0, 3);

  const oldest = playbook.snapshots.length ? playbook.snapshots.reduce((a, s) => (s.asOf < a ? s.asOf : a), playbook.snapshots[0]!.asOf) : null;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setQ('');
    // "Tell me when labor cost goes red": an alert, not a question.
    const wants = parseAlertRequest(text);
    if (wants) {
      const target = alertTarget(wants.subject, playbook.entries, index);
      if (target) await createAlert(target.entry, target.metric, wants.notifyClear);
      else setAlertNote({ ok: false, text: `No reviewed flag about "${wants.subject}" has a red rule yet, so there is nothing to watch. Ask an analyst to add one.` });
      return;
    }
    const key = ++counter.current;
    let answer = answerQuestion(text, playbook.entries, index);
    let draftBy = 'local rules';
    // Nothing reviewed and nothing local rules can read: the drafting provider set up here may still draft it, live.
    if (answer.trust === 'none' && drafter) {
      const d = await drafter(text).catch(() => null);
      if (d?.flag.binding) {
        draftBy = d.by;
        answer = { question: answer.question, trust: 'drafted', flag: d.flag, filters: [], reasons: [`Drafted by ${d.by} from the catalog. No analyst has reviewed this.`, ...d.flag.notes] };
      }
    }
    const shown: Shown = { key, answer, state: 'working', draftBy, reviewAsked: reviewAsked(playbook.questions, text, user) };
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
    // A drafted answer goes to the analysts only when the asker presses "Ask for review"; one with no answer goes now.
    if (patch.state === 'unanswered') patch.queued = await queue(text, 'none', answer.reasons);
    update(patch);
    if (answer.entry && patch.state === 'ready') playbook.recordAsk(answer.entry.id);
    else if (answer.trust === 'drafted' && patch.state === 'ready') playbook.recordDrafted();
  };

  const askForReview = async (a: Shown): Promise<boolean> => {
    const draft = draftOf(a.answer, a.from?.kind === 'live' ? 'live' : 'snapshot', a.draftBy);
    if (!draft) return false;
    try {
      await playbook.saveQuestion(requestReview(playbook.questions, a.answer, user, draft));
      setAnswers((list) => list.map((x) => (x.key === a.key ? { ...x, reviewAsked: true, queued: true } : x)));
      return true;
    } catch {
      return false;
    }
  };

  const queue = async (text: string, shown: 'drafted' | 'none', notes: string[]): Promise<boolean> => {
    const asked = normalizeQuestion(text);
    const already = playbook.questions.find((x) => x.status === 'open' && normalizeQuestion(x.title) === asked);
    try {
      // Asked again: count this asker too, so the analysts see how many people want it.
      if (already) {
        await playbook.saveQuestion(addAsker(already, user));
        return true;
      }
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
          <button
            type="button"
            onClick={() => setPanel('alerts')}
            aria-label={`Alerts${fresh ? `, ${fresh} new` : ''}`}
            title="Alerts on reviewed numbers"
            className="relative grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2"
          >
            {fresh ? <BellRing size={16} className="text-bad" /> : <Bell size={16} />}
            {fresh > 0 && (
              <span data-testid="alert-badge" className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold leading-4 text-panel">
                {fresh}
              </span>
            )}
          </button>
          <span className="flex items-center gap-1" title="Reviewed answers in the playbook">
            <BadgeCheck size={13} /> {live.length} reviewed answer{live.length === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={onTheme} aria-label={theme === 'dark' ? 'Light theme' : 'Dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'} className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button type="button" onClick={onSettings} aria-label="Settings" title="Settings" className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2">
            <Settings2 size={16} />
          </button>
          <button type="button" onClick={onBuilder} className="flex min-h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-ink-2 hover:border-accent" title="Open the analysts' builder">
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
          {answeredForMe.length > 0 && (
            <section aria-label="Your questions" className="space-y-1.5">
              {answeredForMe.map((x) => (
                <AnsweredNotice
                  key={x.id}
                  q={x}
                  by={playbook.entries.find((e) => e.id === x.entryId)?.acceptedBy}
                  onShow={() => {
                    markSeen(x.id);
                    void ask(x.title);
                  }}
                  onDismiss={() => markSeen(x.id)}
                />
              ))}
            </section>
          )}
          {rejectedForMe.map((x) => (
            <p key={x.id} role="status" className="flex items-start gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm">
              <Inbox size={16} className="mt-0.5 shrink-0 text-ink-3" />
              <span className="flex-1">
                <b>Not accepted:</b> "{x.title}". {x.rejected!.by} looked at the draft: {x.rejected!.reason}
              </span>
              <button type="button" onClick={() => markSeen(x.id)} aria-label={`Dismiss: ${x.title}`} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel">
                <X size={14} />
              </button>
            </p>
          ))}
          {alertNote && (
            <p role="status" className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${alertNote.ok ? 'border-accent/40 bg-accent-soft' : 'border-line bg-panel-2'}`}>
              <Bell size={16} className="mt-0.5 shrink-0 text-accent" />
              <span className="flex-1">{alertNote.text}</span>
              <button type="button" onClick={() => setAlertNote(null)} aria-label="Dismiss" className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel">
                <X size={14} />
              </button>
            </p>
          )}
          <ReportsShelf editions={playbook.editions} index={index} themeKey={themeKey} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(q);
            }}
            className="focus-frame flex items-center gap-2 rounded-2xl border border-line bg-panel px-4 py-2 shadow-sm"
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
              {glance.map((g) => {
                const metric = g.entry.binding.metrics[0]!;
                const can = !!redRule(g.entry.thresholds, metric);
                return (
                  <div key={g.title} data-testid="glance-tile" className="flex flex-col rounded-2xl border border-line bg-panel shadow-sm hover:border-accent">
                    <button type="button" onClick={() => void ask(g.question)} className="flex-1 p-4 pb-2 text-left">
                      <span className="block text-xs text-ink-3">{g.title}</span>
                      <span className={`mt-1 block text-2xl font-semibold tabular-nums ${g.tone === 'bad' ? 'text-bad' : g.tone === 'warn' ? 'text-warn' : g.tone === 'good' ? 'text-good' : 'text-ink'}`}>{formatNumber(g.value, g.format)}</span>
                      {g.tone && <ToneWord tone={g.tone} />}
                      {typeof g.value === 'number' && typeof g.before === 'number' && g.before !== 0 && (
                        <span className="text-xs text-ink-2">
                          {g.value >= g.before ? '▲' : '▼'} {Math.abs(Math.round(((g.value - g.before) / Math.abs(g.before)) * 100))}% on before
                        </span>
                      )}
                    </button>
                    {can && <AlertMe on={hasAlert(g.entry.id, metric)} label={g.title} onSet={() => void createAlert(g.entry, metric)} onOpen={() => setPanel('alerts')} />}
                  </div>
                );
              })}
            </section>
          )}

          {answers.length === 0 && playbook.loaded && (live.length > 0 || playbook.questions.length > 0) && <QualityCard q={quality} counted={playbook.social.impact} />}

          {answers.map((a) => (
            <AnswerCard
              key={a.key}
              shown={a}
              index={index}
              onAsk={(x) => void ask(x)}
              onFlag={() =>
                void queue(a.answer.question, 'drafted', ['Flagged for review from the Leadership view: a reviewed answer someone wants looked at again.']).then((queued) => setAnswers((list) => list.map((x) => (x.key === a.key ? { ...x, queued } : x))))
              }
              themeKey={themeKey}
              onReview={() => askForReview(a)}
              alert={(() => {
                const e = a.answer.entry;
                if (!e || a.state !== 'ready' || (a.answer.trust !== 'reviewed' && a.answer.trust !== 'adjusted')) return null;
                const metric = (a.answer.flag.binding?.metrics ?? []).find((k) => !!redRule(e.thresholds, k)) ?? alertableMetrics(e)[0];
                return metric ? { on: hasAlert(e.id, metric), set: () => void createAlert(e, metric), open: () => setPanel('alerts') } : null;
              })()}
              bz={playbook.social.bz && a.answer.entry ? { given: hasBz(playbook.bz, user, a.answer.entry.id), give: () => playbook.giveBz(a.answer.entry!.id) } : null}
            />
          ))}

          {live.length > 0 && playbook.snapshots.length > 0 && (
            <div className="flex justify-end">
              <button type="button" onClick={() => setPanel('mail')} className="flex min-h-8 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 hover:border-accent hover:text-ink">
                <Mail size={14} /> Email this briefing
              </button>
            </div>
          )}
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
                      {b.insight.tone === 'bad' ? (
                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-bad" aria-label="Needs attention" />
                      ) : b.insight.tone === 'warn' ? (
                        <AlertCircle size={15} className="mt-0.5 shrink-0 text-warn" aria-label="Worth a look" />
                      ) : (
                        <Info size={15} className="mt-0.5 shrink-0 text-accent" aria-label="For information" />
                      )}
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

          {playbook.loaded && live.length === 0 && answers.length === 0 && (
            <section className="rounded-2xl border border-dashed border-line">
              <EmptyState
                icon={Wand2}
                headline="No reviewed answers yet."
                body="When analysts accept flags in the builder, their answers appear here. You can still ask: Semaphore drafts an answer, labels it as not reviewed, and you can ask the analysts to review it."
              />
            </section>
          )}
        </div>
      </main>
      {panel && (
        <Suspense fallback={null}>
          {panel === 'alerts' ? (
            <AlertsPanel alerts={alerts} user={user} server={server} onClose={() => setPanel(null)} />
          ) : (
            <BriefingMail entries={playbook.entries} snapshots={playbook.snapshots} index={index} user={user} alerts={alerts} theme={theme} server={server} onClose={() => setPanel(null)} />
          )}
        </Suspense>
      )}
    </div>
  );
}

// Labels and screen-reader text come from src/core/review.ts, so drafted and reviewed never read alike.
const TRUST: Record<Answer['trust'], { label: string; sr: string; tone: string; icon: typeof BadgeCheck }> = {
  reviewed: { ...TRUST_LABELS.reviewed, tone: 'bg-good-soft text-good', icon: BadgeCheck },
  adjusted: { ...TRUST_LABELS.adjusted, tone: 'bg-good-soft text-good', icon: BadgeCheck },
  drafted: { ...TRUST_LABELS.drafted, tone: 'border border-dashed border-warn bg-warn-soft text-warn', icon: CircleHelp },
  none: { ...TRUST_LABELS.none, tone: 'bg-panel-2 text-ink-2', icon: Inbox },
};

/** "Alert me" on a reviewed number with a red rule; once set, opens the Alerts panel. */
function AlertMe({ on, label, onSet, onOpen }: { on: boolean; label: string; onSet: () => void; onOpen: () => void }) {
  return on ? (
    <button type="button" onClick={onOpen} aria-label={`Alert set on ${label}: open Alerts`} className="flex min-h-8 items-center gap-1 self-start px-4 pb-3 text-xs text-accent hover:underline">
      <BellRing size={12} /> Alert set
    </button>
  ) : (
    <button type="button" onClick={onSet} aria-label={`Alert me when ${label} goes red`} className="flex min-h-8 items-center gap-1 self-start px-4 pb-3 text-xs text-ink-2 hover:text-ink hover:underline">
      <Bell size={12} /> Alert me
    </button>
  );
}

/** Answer quality: reviewed share, time to a reviewed answer, and the queue. */
function QualityCard({ q, counted }: { q: ReturnType<typeof answerQuality>; counted: boolean }) {
  const pct = q.reviewedShare === null ? null : Math.round(q.reviewedShare * 100);
  return (
    <section aria-label="Answer quality" className="rounded-2xl border border-line bg-panel p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Gauge size={15} className="text-brass" /> Answer quality
        <span className="font-normal text-ink-3">last {q.weeks} weeks</span>
      </h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-3">Answers that were reviewed</dt>
          <dd data-testid="quality-share" className="text-lg font-semibold tabular-nums">
            {!counted ? <span className="text-sm font-normal text-ink-2">Not counted (impact is off)</span> : pct === null ? <span className="text-sm font-normal text-ink-2">None shown yet</span> : `${pct}%`}
          </dd>
          {counted && q.reviewed !== null && q.drafted !== null && q.reviewed + q.drafted > 0 && (
            <dd className="text-xs text-ink-2">
              {q.reviewed} reviewed, {q.drafted} drafted
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-ink-3">Question to reviewed answer</dt>
          <dd data-testid="quality-time" className="text-lg font-semibold tabular-nums">
            {q.answered ? `median ${durationText(q.medianHours)}` : <span className="text-sm font-normal text-ink-2">None answered yet</span>}
          </dd>
          {q.answered > 0 && (
            <dd className="text-xs text-ink-2">
              90th percentile {durationText(q.p90Hours)} · {q.answered} answered
            </dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-ink-3">Waiting for an analyst</dt>
          <dd data-testid="quality-queue" className="text-lg font-semibold tabular-nums">
            {q.open}
          </dd>
          {q.open > 0 && (
            <dd className="text-xs text-ink-2">
              {q.draftsWaiting ? `${q.draftsWaiting} with a draft to review · ` : ''}oldest {durationText((q.oldestOpenDays ?? 0) * 24)}
            </dd>
          )}
        </div>
      </dl>
    </section>
  );
}

/** "Answered: <question>, reviewed by A. Reyes, 4 Nov [Show]": the loop closed for the asker. */
function AnsweredNotice({ q, by, onShow, onDismiss }: { q: QuestionItem; by?: string | undefined; onShow: () => void; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-good/40 bg-good-soft px-3 py-2 text-sm">
      <CircleCheck size={16} className="shrink-0 text-good" />
      <p className="min-w-0 flex-1">
        <b className="text-good">Answered:</b> <span className="text-ink">"{q.title}"</span>
        <span className="text-ink-2">
          {by ? `, reviewed by ${by}` : ''}, {dayMonth(q.updated)}
        </span>
      </p>
      <button type="button" onClick={onShow} className="min-h-8 shrink-0 rounded-md bg-accent px-3 text-xs font-semibold text-panel hover:opacity-90">
        Show
      </button>
      <button type="button" onClick={onDismiss} aria-label={`Dismiss: ${q.title}`} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel">
        <X size={14} />
      </button>
    </div>
  );
}

/** "BZ: this helped": rates the answer's usefulness, not the person. Once per answer per week. */
function BzButton({ given, give }: { given: boolean; give: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'sent' | 'failed'>(given ? 'sent' : 'idle');
  if (state === 'sent')
    return (
      <span className="flex items-center gap-1 text-xs text-good" role="status">
        <Check size={13} /> Bravo Zulu sent. The analyst who built it will see it.
      </span>
    );
  return (
    <button
      type="button"
      onClick={() => give().then(() => setState('sent'), () => setState('failed'))}
      title="Tell the analysts this answer helped. It rates the answer, not a person."
      className="flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-ink-2 hover:border-accent hover:text-ink"
    >
      <ThumbsUp size={13} /> BZ: this helped{state === 'failed' ? ' (could not save, try again)' : ''}
    </button>
  );
}

function AnswerCard({ shown, index, onAsk, onFlag, onReview, alert, themeKey, bz }: { shown: Shown; index: CatalogIndex; onAsk: (q: string) => void; onFlag: () => void; onReview: () => Promise<boolean>; alert: { on: boolean; set: () => void; open: () => void } | null; themeKey: string; bz: { given: boolean; give: () => Promise<boolean> } | null }) {
  const [why, setWhy] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const { answer, result } = shown;
  const t = TRUST[shown.state === 'unanswered' && answer.trust !== 'none' ? 'none' : answer.trust];
  const Icon = t.icon;
  const hoist: Hoist = { version: 1, id: 'ask', title: '', brief: '', grid: { cols: 12 }, filters: answer.filters, flags: [], updated: '' };
  const insights = result && answer.flag.binding ? findInsights({ flag: answer.flag, rows: result.display.rows, ...(result.previous ? { previous: result.previous } : {}), totals: result.display.totals }, index) : [];
  const chips = shown.state === 'ready' ? followUps(answer, index) : [];
  const tall = answer.flag.kind !== 'kpi';
  const drafted = answer.trust === 'drafted' && shown.state !== 'unanswered';
  return (
    <article
      data-trust={drafted ? 'drafted' : shown.state === 'unanswered' ? 'none' : answer.trust}
      className={`rounded-2xl p-5 shadow-sm ${drafted ? 'border-2 border-dashed border-warn bg-panel' : 'border border-line bg-panel'}`}
      aria-label={`Answer: ${answer.question}`}
      aria-describedby={`trust-${shown.key}`}
    >
      <p className="text-xs text-ink-3">You asked</p>
      <h2 className="text-lg font-semibold">{answer.question}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span id={`trust-${shown.key}`} data-testid="trust-badge" className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${t.tone}`}>
          <Icon size={13} aria-hidden="true" /> {t.label}
          <span className="sr-only"> {t.sr}</span>
          {answer.entry && shown.state === 'ready' ? ` · ${answer.entry.acceptedBy}, ${answer.entry.acceptedAt.slice(0, 10)}` : ''}
        </span>
        {shown.from?.kind === 'snapshot' && (
          <span className="flex items-center gap-1 text-ink-3">
            <Clock size={12} /> Data as of {asOfText(shown.from.asOf)}
          </span>
        )}
        {shown.from?.kind === 'live' && <span className="text-ink-3">Live data</span>}
        {shown.queued && shown.state === 'unanswered' && <span className="text-ink-3">· Sent to the analysts to answer</span>}
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
          {drafted && (
            <div className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-ink">
              <p>
                <b>Not yet reviewed.</b> Semaphore drafted this{shown.draftBy && shown.draftBy !== 'local rules' ? ` with ${shown.draftBy}` : ''} from the catalog; no analyst has checked it, so treat the numbers with care.
              </p>
              <p className="mt-1 text-ink-2">{dataAccessNote(shown.from?.kind === 'live' ? 'live' : 'snapshot')}</p>
            </div>
          )}
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
          {canAskForReview(answer.trust, shown.state) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {shown.reviewAsked ? (
                <span role="status" className="flex items-center gap-1 text-sm text-ink-2">
                  <Check size={14} className="text-good" /> Sent for review. An analyst will accept, edit or reject it, and you will see the answer here.
                </span>
              ) : (
                <button type="button" onClick={() => void onReview().then((ok) => setReviewFailed(!ok))} className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-panel hover:opacity-90">
                  <Send size={14} /> Ask for review
                </button>
              )}
              {reviewFailed && <span className="text-xs text-bad">Could not send it. Try again.</span>}
            </div>
          )}
          {alert && (
            <div className="mt-2">
              <AlertMe on={alert.on} label={answer.question} onSet={alert.set} onOpen={alert.open} />
            </div>
          )}
          {(answer.trust === 'reviewed' || answer.trust === 'adjusted') && !shown.queued && (
            <button type="button" onClick={onFlag} className="mt-3 text-sm text-ink-2 underline-offset-2 hover:text-ink hover:underline">
              Flag for review
            </button>
          )}
          {bz && (answer.trust === 'reviewed' || answer.trust === 'adjusted') && (
            <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
              <BzButton given={bz.given} give={bz.give} />
            </div>
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

/** A tile's status in an icon and a word, never colour alone (WCAG 1.4.1). */
function ToneWord({ tone }: { tone: string }) {
  if (tone === 'bad') return <span className="flex items-center gap-1 text-xs font-semibold text-bad"><AlertTriangle size={12} aria-hidden="true" /> Breaks its red rule</span>;
  if (tone === 'warn') return <span className="flex items-center gap-1 text-xs font-semibold text-warn"><AlertCircle size={12} aria-hidden="true" /> In its amber band</span>;
  if (tone === 'good') return <span className="flex items-center gap-1 text-xs font-semibold text-good"><CheckCircle2 size={12} aria-hidden="true" /> Within its rule</span>;
  return null;
}

// Alerts: "Tell me when labor cost goes red". An alert is a reviewed flag (a playbook entry), the
// red colour rule on one of its measures, and who asked. It is checked whenever the flag's data
// refreshes (a snapshot refresh on any page, the headless refresh run, opening the page) and fires
// once per change into red, and optionally once when it goes back to normal. Each firing is kept
// with its time, value and the data's as-of time.
//
// The rules here are mirrored by server/Alerts.ps1 (Update-SemAlertState), which applies them when
// a Semaphore server is running so two pages checking at once never fire twice. Without a server
// the page applies them itself and keeps the alerts in this browser.
//
// A pipeline's Publish step cannot work out the new value on the server (snapshots hold partial
// sums the page's planner re-adds), so it marks the alert pending with a note; the check happens at
// the next snapshot refresh or page open.

import type { CatalogIndex } from './catalog.ts';
import { formatNumber } from './describe.ts';
import type { Threshold } from './hoist.ts';
import { answerQuestion, entryFlag, normalizeQuestion, type PlaybookEntry } from './playbook.ts';
import { answerFromSnapshots, type Snapshot } from './snapshot.ts';

export type AlertSource = 'page' | 'refresh' | 'pipeline';
export type AlertState = 'unknown' | 'normal' | 'red';

export interface AlertEvent {
  id: string;
  kind: 'red' | 'clear';
  at: string;
  value: number | null;
  /** When the data it was read from was taken. */
  asOf: string;
  source: AlertSource;
  /** The person saw it in the Alerts panel. */
  seen?: boolean;
  /** It went into a briefing. */
  briefed?: boolean;
}

export interface Alert {
  version: 1;
  kind: 'alert';
  id: string;
  entryId: string;
  title: string;
  metric: string;
  metricLabel: string;
  format?: 'number' | 'currency' | 'percent';
  /** The red rule as the flag has it. */
  rule: Threshold;
  /** Who asked to be told. */
  who: string;
  /** Also tell them when it goes back to normal. */
  notifyClear: boolean;
  /** Read it aloud when it fires on an open page. */
  speak: boolean;
  /** Add it to the next briefing. */
  brief: boolean;
  state: AlertState;
  lastValue?: number | null;
  lastAsOf?: string;
  lastChecked?: string;
  /** Data changed where the value cannot be worked out (a pipeline's Publish): checked on the next refresh or page open. */
  pending?: { note: string; at: string };
  /** Newest last, at most ALERT_EVENTS_KEPT. */
  events: AlertEvent[];
  created: string;
  updated: string;
}

export const ALERT_EVENTS_KEPT = 50;

export interface AlertReading {
  value: number | null;
  asOf: string;
  /** The row the value is from, for a chart ("Northeast"). */
  label?: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_');

export function alertId(who: string, entryId: string, metric: string): string {
  return `alert-${slug(who).slice(0, 16)}-${slug(entryId).slice(0, 30)}-${slug(metric).slice(0, 10)}`.slice(0, 64);
}

/** The flag's red rule for a measure, or null when it has none. */
export function redRule(thresholds: readonly Threshold[], metric: string): Threshold | null {
  return thresholds.find((t) => t.metric === metric && t.tone === 'bad') ?? null;
}

/** The measures of an entry that have a red rule: what "Alert me" can watch. */
export function alertableMetrics(entry: PlaybookEntry): string[] {
  return entry.binding.metrics.filter((m) => !!redRule(entry.thresholds, m));
}

export function isRed(rule: Threshold, value: number): boolean {
  return rule.op === 'lt' ? value < rule.value : rule.op === 'lte' ? value <= rule.value : rule.op === 'gt' ? value > rule.value : value >= rule.value;
}

export function ruleText(rule: Threshold, format?: 'number' | 'currency' | 'percent'): string {
  const words = { gt: 'over', gte: 'at or over', lt: 'under', lte: 'at or under' }[rule.op];
  return `${words} ${formatNumber(rule.value, format)}`;
}

export function newAlert(entry: PlaybookEntry, metric: string, who: string, index: CatalogIndex, opts: { notifyClear?: boolean; speak?: boolean; brief?: boolean } = {}, now: Date = new Date()): Alert | null {
  const rule = redRule(entry.thresholds, metric);
  if (!rule) return null;
  const m = index.metric(metric);
  const at = now.toISOString();
  return {
    version: 1,
    kind: 'alert',
    id: alertId(who, entry.id, metric),
    entryId: entry.id,
    title: entry.title,
    metric,
    metricLabel: m?.label ?? metric,
    ...(m?.format ? { format: m.format } : {}),
    rule,
    who,
    notifyClear: opts.notifyClear ?? false,
    speak: opts.speak ?? false,
    brief: opts.brief ?? true,
    state: 'unknown',
    events: [],
    created: at,
    updated: at,
  };
}

/** Sets the state from the reading at the time the alert is made, without firing: it fires on the next change. */
export function primeAlert(alert: Alert, reading: AlertReading | null, now: Date = new Date()): Alert {
  if (!reading || reading.value === null) return alert;
  return { ...alert, state: isRed(alert.rule, reading.value) ? 'red' : 'normal', lastValue: reading.value, lastAsOf: reading.asOf, lastChecked: now.toISOString() };
}

/**
 * One check. Fires 'red' on a change into red (from normal, or from unknown: the first reading
 * after the alert was made without one), and 'clear' on a change from red back to normal when the
 * alert asks for it. A reading older than the last one is ignored, so a page holding an old
 * snapshot never undoes a newer check. No value: only the check time is noted.
 */
export function stepAlert(alert: Alert, reading: AlertReading, source: AlertSource, now: Date = new Date()): { alert: Alert; fired: AlertEvent | null } {
  if (alert.lastAsOf && reading.asOf < alert.lastAsOf) return { alert, fired: null };
  const at = now.toISOString();
  const { pending: _p, ...base } = alert;
  if (reading.value === null || !Number.isFinite(reading.value)) return { alert: { ...base, lastChecked: at }, fired: null };
  const next: AlertState = isRed(alert.rule, reading.value) ? 'red' : 'normal';
  let fired: AlertEvent | null = null;
  if (next === 'red' && alert.state !== 'red') fired = { id: `${at.replace(/[^0-9]/g, '').slice(0, 17)}-r`, kind: 'red', at, value: reading.value, asOf: reading.asOf, source };
  else if (next === 'normal' && alert.state === 'red' && alert.notifyClear) fired = { id: `${at.replace(/[^0-9]/g, '').slice(0, 17)}-c`, kind: 'clear', at, value: reading.value, asOf: reading.asOf, source };
  const events = fired ? [...alert.events, fired].slice(-ALERT_EVENTS_KEPT) : alert.events;
  return { alert: { ...base, state: next, lastValue: reading.value, lastAsOf: reading.asOf, lastChecked: at, events, updated: fired ? at : alert.updated }, fired };
}

/**
 * The value an alert watches, from the entry's saved snapshot: a KPI's total; for a chart the row
 * that comes closest to breaking the rule (the highest for an "over" rule, the lowest for an "under").
 */
export function alertReading(alert: Pick<Alert, 'entryId' | 'metric' | 'rule'>, entries: readonly PlaybookEntry[], snapshots: readonly Snapshot[]): AlertReading | null {
  const e = entries.find((x) => x.id === alert.entryId && x.status !== 'retired');
  if (!e) return null;
  const own = snapshots.filter((s) => s.entryId === e.id);
  if (!own.length) return null;
  const a = answerFromSnapshots(entryFlag(e), e.pageFilters, own);
  if (!a) return null;
  const asOf = a.snapshot.asOf;
  if (e.kind === 'kpi' || e.binding.dimensions.length === 0) {
    const v = a.display.totals[alert.metric] ?? a.display.rows[0]?.values[alert.metric] ?? null;
    return { value: typeof v === 'number' ? v : null, asOf };
  }
  const high = alert.rule.op === 'gt' || alert.rule.op === 'gte';
  let best: { value: number; label: string } | null = null;
  for (const r of a.display.rows) {
    const v = r.values[alert.metric];
    if (typeof v !== 'number') continue;
    if (!best || (high ? v > best.value : v < best.value)) best = { value: v, label: Object.values(r.dims).map(String).join(' / ') };
  }
  return best ? { value: best.value, asOf, label: best.label } : { value: null, asOf };
}

/** "Labor cost went red: $12.3M (red over $5M), 8 Nov 14:05." */
export function alertText(alert: Alert, event: AlertEvent): string {
  const v = formatNumber(event.value, alert.format);
  const when = new Date(event.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return event.kind === 'red' ? `${alert.metricLabel} went red: ${v} (red ${ruleText(alert.rule, alert.format)}), ${when}.` : `${alert.metricLabel} is back to normal: ${v}, ${when}.`;
}

/** Firings this person has not seen yet, newest first. */
export function unseen(alerts: readonly Alert[], who: string): Array<{ alert: Alert; event: AlertEvent }> {
  return alerts
    .filter((a) => a.who === who)
    .flatMap((alert) => alert.events.filter((e) => !e.seen).map((event) => ({ alert, event })))
    .sort((x, y) => y.event.at.localeCompare(x.event.at));
}

/** The alert with every firing marked seen. */
export function markSeen(alert: Alert, now: Date = new Date()): Alert {
  if (alert.events.every((e) => e.seen)) return alert;
  return { ...alert, events: alert.events.map((e) => ({ ...e, seen: true })), updated: now.toISOString() };
}

/** Firings this person asked to have in the next briefing that have not been in one yet, oldest first. */
export function forBriefing(alerts: readonly Alert[], who: string): Array<{ alert: Alert; event: AlertEvent }> {
  return alerts
    .filter((a) => a.who === who && a.brief)
    .flatMap((alert) => alert.events.filter((e) => !e.briefed).map((event) => ({ alert, event })))
    .sort((x, y) => x.event.at.localeCompare(y.event.at));
}

export function markBriefed(alert: Alert, now: Date = new Date()): Alert {
  if (alert.events.every((e) => e.briefed)) return alert;
  return { ...alert, events: alert.events.map((e) => ({ ...e, briefed: true })), updated: now.toISOString() };
}

/** "Tell me when labor cost goes red" (and "...or back to normal"): what to watch, or null when it is not an alert request. */
export function parseAlertRequest(text: string): { subject: string; notifyClear: boolean } | null {
  const t = text.trim().replace(/[?.!]+$/, '');
  const m = /^(?:please\s+)?(?:tell|alert|notify|warn|let)\s+(?:me\s+)?(?:know\s+)?(?:when|if|whenever)\s+(?:the\s+)?(.+?)\s+(?:goes|turns|gets|is|becomes)\s+red\b(.*)$/i.exec(t);
  if (!m || !m[1]) return null;
  return { subject: m[1].trim(), notifyClear: /\b(back|normal|green|clears?)\b/i.test(m[2] ?? '') };
}

/** The reviewed entry and measure an alert request is about: the entry the subject would be answered with, when it has a red rule; else any entry whose measure's name the subject says. */
export function alertTarget(subject: string, entries: readonly PlaybookEntry[], index: CatalogIndex): { entry: PlaybookEntry; metric: string } | null {
  const live = entries.filter((e) => e.status !== 'retired');
  const a = answerQuestion(subject, live, index);
  if (a.entry && (a.trust === 'reviewed' || a.trust === 'adjusted')) {
    const metric = (a.flag.binding?.metrics ?? []).find((k) => !!redRule(a.entry!.thresholds, k)) ?? alertableMetrics(a.entry)[0];
    if (metric) return { entry: a.entry, metric };
  }
  const words = normalizeQuestion(subject);
  const named = live
    .flatMap((e) => alertableMetrics(e).map((metric) => ({ entry: e, metric, label: normalizeQuestion(index.metric(metric)?.label ?? metric) })))
    .filter((x) => x.label && words.includes(x.label))
    .sort((x, y) => (x.entry.kind === 'kpi' ? 0 : 1) - (y.entry.kind === 'kpi' ? 0 : 1));
  return named[0] ? { entry: named[0].entry, metric: named[0].metric } : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isAlert(raw: unknown): raw is Alert {
  if (!isObj(raw)) return false;
  const r = raw.rule;
  return (
    raw.version === 1 &&
    raw.kind === 'alert' &&
    typeof raw.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) &&
    typeof raw.entryId === 'string' &&
    typeof raw.metric === 'string' &&
    typeof raw.who === 'string' &&
    isObj(r) &&
    typeof r.value === 'number' &&
    (r.op === 'lt' || r.op === 'lte' || r.op === 'gt' || r.op === 'gte') &&
    (raw.state === 'unknown' || raw.state === 'normal' || raw.state === 'red') &&
    Array.isArray(raw.events)
  );
}

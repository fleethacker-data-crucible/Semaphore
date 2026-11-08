// Alerts as the page sees them (src/core/alerts.ts). With a server they are files in the home folder
// (server/Alerts.ps1) and the server applies each check, so two pages never fire the same change twice;
// without one they live in this browser and the page applies the same rules. Loaded on first use, so the
// start bundle does not carry it (web/size-budget.json).

import { type Alert, type AlertEvent, alertReading, type AlertSource, alertText, isAlert, stepAlert } from '../../../src/core/alerts.ts';
import type { PlaybookEntry } from '../../../src/core/playbook.ts';
import type { Snapshot } from '../../../src/core/snapshot.ts';
import { api } from './api.ts';
import { readLocal, writeLocal } from './storage.ts';

const LOCAL = 'semaphore.alerts';

export type Fired = { alert: Alert; event: AlertEvent };

let cache: Alert[] = [];
const listeners = new Set<(a: Alert[]) => void>();
function publish(list: Alert[]): void {
  cache = list;
  for (const l of listeners) l(list);
}

/** Called with the alert list whenever it changes on this page. */
export function subscribeAlerts(l: (a: Alert[]) => void): () => void {
  listeners.add(l);
  l(cache);
  return () => listeners.delete(l);
}

const localAll = (): Alert[] => Object.values(readLocal<Record<string, unknown>>(LOCAL) ?? {}).filter(isAlert);
const localPut = (list: Alert[]) => writeLocal(LOCAL, Object.fromEntries(list.map((a) => [a.id, a])));

export async function loadAlerts(server: boolean): Promise<Alert[]> {
  const list = server ? ((await api<unknown[]>('/api/alerts').catch(() => [])) as unknown[]).filter(isAlert) : localAll();
  publish(list);
  return list;
}

export async function saveAlert(server: boolean, a: Alert): Promise<void> {
  if (server) await api(`/api/alerts/${encodeURIComponent(a.id)}`, { method: 'PUT', json: a });
  else localPut([...localAll().filter((x) => x.id !== a.id), a]);
  publish([...cache.filter((x) => x.id !== a.id), a]);
}

export async function removeAlert(server: boolean, id: string): Promise<void> {
  if (server) await api(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  else localPut(localAll().filter((x) => x.id !== id));
  publish(cache.filter((x) => x.id !== id));
}

/**
 * Checks every alert against the snapshots: values are worked out here (the snapshots' partial sums
 * are re-added by the planner's code), the rules are applied by the server when there is one.
 * Returns the firings for this person.
 */
export async function checkAlerts(input: { server: boolean; user: string; entries: readonly PlaybookEntry[]; snapshots: readonly Snapshot[]; source: AlertSource }): Promise<Fired[]> {
  const alerts = await loadAlerts(input.server);
  if (!alerts.length) return [];
  const readings: Array<{ entryId: string; metric: string; value: number | null; asOf: string }> = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    const key = `${a.entryId}|${a.metric}`;
    if (seen.has(key)) continue;
    const r = alertReading(a, input.entries, input.snapshots);
    if (!r) continue;
    seen.add(key);
    readings.push({ entryId: a.entryId, metric: a.metric, value: r.value, asOf: r.asOf });
  }
  if (!readings.length) return [];
  let next: Alert[];
  const fired: Fired[] = [];
  if (input.server) {
    const res = await api<{ fired: Array<{ alertId: string; event: AlertEvent }>; alerts: unknown[] }>('/api/alerts/check', { json: { source: input.source, readings } });
    next = res.alerts.filter(isAlert);
    for (const f of res.fired) {
      const alert = next.find((a) => a.id === f.alertId);
      if (alert) fired.push({ alert, event: f.event });
    }
  } else {
    next = alerts.map((a) => {
      const r = readings.find((x) => x.entryId === a.entryId && x.metric === a.metric);
      if (!r) return a;
      const s = stepAlert(a, r, input.source);
      if (s.fired) fired.push({ alert: s.alert, event: s.fired });
      return s.alert;
    });
    localPut(next);
  }
  publish(next);
  return fired.filter((f) => f.alert.who === input.user);
}

/**
 * Reads a firing aloud for an alert that asks for it: with TalkForge on this computer when it is set up
 * (lib/voice.ts), else with a voice installed on this PC. Never a cloud voice (src/core/voice.ts).
 */
export async function speakAlert(text: string, server: boolean): Promise<void> {
  if (server) {
    const { voice } = await import('./voice.ts');
    if (await voice.ensureReady()) {
      voice.say(text);
      return;
    }
  }
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  if (!synth) return;
  const { pickLocalVoice } = await import('../../../src/core/voice.ts');
  const v = pickLocalVoice(synth.getVoices(), document.documentElement.lang || navigator.language || 'en-US');
  if (!v) return;
  const u = new SpeechSynthesisUtterance(text);
  u.voice = synth.getVoices().find((x) => x.name === v.name && x.lang === v.lang) ?? null;
  synth.speak(u);
}

/** Checks the alerts and tells this person about each firing: a toast, and read aloud when the alert asks for it. */
export async function checkAndTell(input: Parameters<typeof checkAlerts>[0], tell: (text: string) => void): Promise<number> {
  const fired = await checkAlerts(input);
  for (const f of fired) {
    const text = alertText(f.alert, f.event);
    tell(text);
    if (f.alert.speak && input.source !== 'refresh') void speakAlert(text, input.server).catch(() => undefined);
  }
  return fired.length;
}

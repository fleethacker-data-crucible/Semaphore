// The leadership briefing: what changed across the analysts' reviewed flags, the headline numbers,
// and the alerts this person asked to have in it, all read from saved snapshots (no database).
// Only playbook entries are read, so a drafted answer never appears in it as if it were reviewed.
// For email it becomes a plain HTML body (src/core/briefing-mail.ts) with the shared report attached
// (lib/share.ts), built from the same snapshots.

import { type Alert, alertText, forBriefing } from '../../../src/core/alerts.ts';
import { type BriefingMail, briefingMailHtml, briefingMailText } from '../../../src/core/briefing-mail.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { type Flag, type Hoist, toneFor } from '../../../src/core/hoist.ts';
import { findInsights, type Insight } from '../../../src/core/insights.ts';
import { entryFlag, type PlaybookEntry } from '../../../src/core/playbook.ts';
import type { FrozenFlag } from '../../../src/core/reports.ts';
import { answerFromSnapshots, type Snapshot } from '../../../src/core/snapshot.ts';
import type { FlagResult } from './data.ts';

export interface ChangeLine {
  insight: Insight;
  question: string;
  title: string;
}

export interface GlanceTile {
  entry: PlaybookEntry;
  title: string;
  question: string;
  value: number | null;
  before: number | null;
  format?: 'number' | 'currency' | 'percent';
  tone: string;
}

const live = (entries: readonly PlaybookEntry[]) => entries.filter((e) => e.status !== 'retired');

/** What changed: insights across every reviewed flag that has a snapshot, worst first. */
export function whatChanged(entries: readonly PlaybookEntry[], snapshots: readonly Snapshot[], index: CatalogIndex, today?: Date, max = 6): ChangeLine[] {
  const out: ChangeLine[] = [];
  for (const e of live(entries)) {
    const snap = snapshots.find((s) => s.entryId === e.id);
    if (!snap) continue;
    const flag = entryFlag(e);
    const a = answerFromSnapshots(flag, e.pageFilters, [snap]);
    if (!a) continue;
    for (const insight of findInsights({ flag, rows: a.display.rows, ...(a.previous ? { previous: a.previous } : {}), totals: a.display.totals, ...(today ? { today } : {}) }, index)) {
      if (/still running/.test(insight.text)) continue;
      out.push({ insight, question: e.question, title: e.title });
    }
  }
  const rank = { bad: 0, warn: 1, good: 2, info: 3 } as const;
  return out.sort((a, b) => rank[a.insight.tone] - rank[b.insight.tone]).slice(0, max);
}

/** At a glance: the reviewed headline numbers, from their snapshots. */
export function glance(entries: readonly PlaybookEntry[], snapshots: readonly Snapshot[], index: CatalogIndex, max = 8): GlanceTile[] {
  const out: GlanceTile[] = [];
  for (const e of live(entries)) {
    if (e.kind !== 'kpi') continue;
    const snap = snapshots.find((s) => s.entryId === e.id);
    const key = e.binding.metrics[0];
    if (!snap || !key) continue;
    const a = answerFromSnapshots(entryFlag(e), e.pageFilters, [snap]);
    const v = a?.display.rows[0]?.values[key] ?? null;
    const before = a?.previous?.[0]?.[key] ?? null;
    const tone = typeof v === 'number' ? (toneFor({ onClick: 'none', ignore: [], thresholds: e.thresholds }, key, v) ?? '') : '';
    const format = index.metric(key)?.format;
    out.push({ entry: e, title: e.title, question: e.question, value: v, before, ...(format ? { format } : {}), tone });
  }
  return out.slice(0, max);
}

/** The reviewed flags as frozen answers for the attached report: headline numbers first, then charts. */
export function briefingFlags(entries: readonly PlaybookEntry[], snapshots: readonly Snapshot[], index: CatalogIndex, today?: Date): FrozenFlag[] {
  const out: FrozenFlag[] = [];
  const kpis = live(entries).filter((e) => e.kind === 'kpi');
  const charts = live(entries).filter((e) => e.kind !== 'kpi' && e.kind !== 'text' && e.kind !== 'filter');
  let x = 0;
  let y = 0;
  const place = (w: number, h: number) => {
    if (x + w > 12) {
      x = 0;
      y += h;
    }
    const l = { x, y, w, h };
    x += w;
    return l;
  };
  for (const [i, e] of [...kpis, ...charts].entries()) {
    const snap = snapshots.find((s) => s.entryId === e.id);
    if (!snap) continue;
    const kpi = e.kind === 'kpi';
    if (!kpi && i === kpis.length && x !== 0) {
      x = 0;
      y += 2;
    }
    const base = entryFlag(e, `pb-${out.length}`);
    const flag: Flag = { ...base, layout: kpi ? place(3, 2) : place(6, 5) };
    const a = answerFromSnapshots(base, e.pageFilters, [snap]);
    if (!a) continue;
    const result: FlagResult = { plan: a.plan, sql: null, display: a.display, ...(a.previous ? { previous: a.previous } : {}), origin: 'page', ms: 0, requeried: [] } as FlagResult;
    out.push({ flag, result, insights: findInsights({ flag, rows: a.display.rows, ...(a.previous ? { previous: a.previous } : {}), totals: a.display.totals, ...(today ? { today } : {}) }, index).map((i) => ({ tone: i.tone, text: i.text })) });
  }
  return out;
}

export interface BriefingPackage {
  subject: string;
  mail: BriefingMail;
  html: string;
  text: string;
  /** The shared report, as one HTML file. */
  report: { name: string; html: string } | null;
  /** The alert firings that went into it, to mark briefed once it is drafted or saved. */
  alerts: Alert[];
}

const day = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export async function buildBriefingPackage(input: { entries: readonly PlaybookEntry[]; snapshots: readonly Snapshot[]; index: CatalogIndex; user: string; alerts: readonly Alert[]; theme: 'light' | 'dark'; withReport?: boolean; now?: Date }): Promise<BriefingPackage> {
  const now = input.now ?? new Date();
  const changes = whatChanged(input.entries, input.snapshots, input.index, now, 5);
  const tiles = glance(input.entries, input.snapshots, input.index);
  const fired = forBriefing(input.alerts, input.user);
  const ymd = now.toISOString().slice(0, 10);
  const name = `leadership-briefing-${ymd}.html`;
  const mail: BriefingMail = {
    subject: `Leadership briefing, ${now.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
    title: 'Leadership briefing',
    dateText: day(now),
    sentences: changes.map((c) => `${c.insight.text} (${c.title})`),
    numbers: tiles.map((t) => ({ label: t.title, value: formatNumber(t.value, t.format), ...(t.tone === 'bad' ? { note: 'Breaks its red rule' } : t.tone === 'warn' ? { note: 'In its amber band' } : {}) })),
    alerts: fired.map((f) => alertText(f.alert, f.event)),
    by: input.user,
    ...(input.withReport !== false ? { attachment: name } : {}),
  };
  let report: BriefingPackage['report'] = null;
  if (input.withReport !== false) {
    const flags = briefingFlags(input.entries, input.snapshots, input.index, now);
    const hoist: Hoist = { version: 1, id: 'leadership-briefing', title: 'Leadership briefing', brief: `Reviewed answers as of ${day(now)}. Only answers an analyst has reviewed are included.`, grid: { cols: 12 }, filters: [], flags: flags.map((f) => f.flag), updated: now.toISOString() };
    const { reportPayload, buildReportHtml } = await import('./share.ts');
    const payload = reportPayload(hoist, flags, input.index.catalog, input.user, input.theme, document.documentElement.dataset.skin || 'fleet');
    report = { name, html: await buildReportHtml(payload) };
  }
  const alerts = [...new Map(fired.map((f) => [f.alert.id, f.alert])).values()];
  return { subject: mail.subject, mail, html: briefingMailHtml(mail), text: briefingMailText(mail), report, alerts };
}

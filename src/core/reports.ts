// Recurring reports: the Monday brief keeps arriving while its analyst is away. Semaphore notices
// that an analyst opens a page on a rhythm (every Monday, the first of the month), offers to keep
// it coming, and while the analyst is marked away produces a dated edition on schedule: the same
// page, new data, frozen so leadership can read it without a database. Nothing is scheduled
// without the analyst saying yes, and an edition says who it stands in for.
//
// Three small team documents: usage-<hoist> (days the page was opened), report-<hoist> (the
// schedule the analyst accepted) and edition-<hoist>-<date> (one edition).

import type { Briefing } from './briefing.ts';
import type { DrillStep } from './drill.ts';
import type { Flag } from './hoist.ts';

export type Cadence = { every: 'week'; weekday: number } | { every: 'month'; day: number };

export interface UsageLog {
  version: 1;
  id: string;
  kind: 'usage';
  hoistId: string;
  title: string;
  owner: string;
  /** Days the owner opened the page (yyyy-mm-dd), oldest first, the last 120 at most. */
  opened: string[];
}

export interface ReportSchedule {
  version: 1;
  id: string;
  kind: 'report';
  hoistId: string;
  title: string;
  owner: string;
  cadence: Cadence;
  createdAt: string;
  /** Date of the last edition produced (yyyy-mm-dd). */
  lastEdition?: string;
}

/** A flag's answer frozen for an edition or a shared report: what FlagView needs and no more. */
/** One level a reader can open in a shared report: the flag after these drill steps, as computed when the report was saved. */
export interface FrozenDrillNode {
  steps: DrillStep[];
  /** The computed result (lib/data FlagResult without its SQL and raw rows). */
  result: unknown;
}

/** Stable text for a list of drill steps, so a click can find its level. */
export function drillKey(steps: readonly DrillStep[]): string {
  return JSON.stringify(steps.map((s) => [s.field, s.grain ?? '', s.value === null ? null : String(s.value)]));
}

/** The saved level for these steps, or null when it is not in the file (past the budget, or the detail rows). */
export function findDrillNode(f: Pick<FrozenFlag, 'drill'>, steps: readonly DrillStep[]): FrozenDrillNode | null {
  const want = drillKey(steps);
  return f.drill?.find((n) => drillKey(n.steps) === want) ?? null;
}

export interface FrozenFlag {
  flag: Flag;
  /** The computed result (lib/data FlagResult without its SQL), or null when it could not run. */
  result: unknown;
  error?: string;
  insights: Array<{ tone: string; text: string }>;
  /** Levels a reader can drill into in a shared report (web/src/lib/report-drill.ts). Absent in editions. */
  drill?: FrozenDrillNode[];
}

export interface Edition {
  version: 1;
  id: string;
  kind: 'edition';
  hoistId: string;
  title: string;
  owner: string;
  /** The scheduled date this edition is for. */
  date: string;
  takenAt: string;
  /** Who produced it (the computer's user), shown so leadership knows it is a stand-in. */
  by: string;
  cols: number;
  flags: FrozenFlag[];
  /** What changed, in a few sentences linked to flags (briefing.ts). */
  briefing?: Briefing;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
export const usageId = (hoistId: string) => `usage-${safe(hoistId)}`.slice(0, 64);
export const reportId = (hoistId: string) => `report-${safe(hoistId)}`.slice(0, 64);
export const editionId = (hoistId: string, date: string) => `edition-${safe(hoistId).slice(0, 40)}-${date}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isUsageLog(v: unknown): v is UsageLog {
  return isObj(v) && v.version === 1 && v.kind === 'usage' && typeof v.hoistId === 'string' && Array.isArray(v.opened);
}

export function isReportSchedule(v: unknown): v is ReportSchedule {
  if (!isObj(v) || v.version !== 1 || v.kind !== 'report' || typeof v.hoistId !== 'string' || typeof v.owner !== 'string' || !isObj(v.cadence)) return false;
  const c = v.cadence;
  return (c.every === 'week' && typeof c.weekday === 'number' && c.weekday >= 0 && c.weekday <= 6) || (c.every === 'month' && typeof c.day === 'number' && c.day >= 1 && c.day <= 28);
}

export function isEdition(v: unknown): v is Edition {
  return isObj(v) && v.version === 1 && v.kind === 'edition' && typeof v.hoistId === 'string' && typeof v.date === 'string' && DATE.test(v.date) && Array.isArray(v.flags);
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);

/** The log with today added, or null when today is already in it. */
export function noteOpened(log: UsageLog | undefined, hoistId: string, title: string, owner: string, today: Date): UsageLog | null {
  const day = ymd(today);
  if (log?.opened.includes(day)) return null;
  const opened = [...(log?.opened ?? []), day].sort().slice(-120);
  return { version: 1, id: usageId(hoistId), kind: 'usage', hoistId, title, owner, opened };
}

/**
 * A rhythm in the days a page was opened: the same weekday in at least 3 of the last 4 weeks,
 * or about the same day of the month (within two days) in at least 3 of the last 4 months.
 */
export function detectCadence(opened: readonly string[], today: Date): Cadence | null {
  const days = opened.filter((d) => DATE.test(d) && d <= ymd(today)).map(utc);
  const t = utc(ymd(today)).getTime();
  // A page opened most days is a working page, not a periodic report.
  if (days.filter((d) => d.getTime() > t - 28 * 86_400_000).length > 10) return null;
  for (let weekday = 0; weekday < 7; weekday++) {
    let weeks = 0;
    for (let w = 0; w < 4; w++) {
      const lo = t - (w + 1) * 7 * 86_400_000;
      const hi = t - w * 7 * 86_400_000;
      if (days.some((d) => d.getTime() > lo && d.getTime() <= hi && d.getUTCDay() === weekday)) weeks++;
    }
    if (weeks >= 3) return { every: 'week', weekday };
  }
  const now = utc(ymd(today));
  const byMonth: number[][] = [];
  for (let m = 0; m < 4; m++) {
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth() - m;
    byMonth.push(days.filter((d) => d.getUTCFullYear() === new Date(Date.UTC(y, mo, 1)).getUTCFullYear() && d.getUTCMonth() === new Date(Date.UTC(y, mo, 1)).getUTCMonth()).map((d) => d.getUTCDate()));
  }
  for (let day = 1; day <= 28; day++) {
    const months = byMonth.filter((ds) => ds.some((d) => Math.abs(d - day) <= 2)).length;
    if (months >= 3) {
      // The earliest day that fits every month it appears in, so the edition is never late.
      const firsts = byMonth.map((ds) => ds.filter((d) => Math.abs(d - day) <= 2).sort((a, b) => a - b)[0]).filter((d): d is number => d !== undefined);
      return { every: 'month', day: Math.min(...firsts, 28) };
    }
  }
  return null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeCadence(c: Cadence): string {
  if (c.every === 'week') return `every ${WEEKDAYS[c.weekday]}`;
  const n = c.day;
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `on the ${n}${suffix} of each month`;
}

/** The most recent scheduled date on or before today. */
export function lastScheduled(c: Cadence, today: Date): string {
  const d = utc(ymd(today));
  if (c.every === 'week') return ymd(new Date(d.getTime() - ((d.getUTCDay() - c.weekday + 7) % 7) * 86_400_000));
  const thisMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), c.day));
  return ymd(thisMonth <= d ? thisMonth : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, c.day)));
}

/** The date an edition is due for, or null: one per scheduled date, none before the schedule began. */
export function editionDue(s: ReportSchedule, today: Date): string | null {
  const due = lastScheduled(s.cadence, today);
  if (due < s.createdAt.slice(0, 10)) return null;
  if (s.lastEdition && s.lastEdition >= due) return null;
  return due;
}

export function newSchedule(hoistId: string, title: string, owner: string, cadence: Cadence, now: Date): ReportSchedule {
  return { version: 1, id: reportId(hoistId), kind: 'report', hoistId, title: title.slice(0, 120), owner, cadence, createdAt: now.toISOString() };
}

/** Editions newest first, the latest per page first of all, for leadership's shelf. */
export function latestEditions(all: readonly Edition[], max = 6): Edition[] {
  const sorted = [...all].sort((a, b) => b.date.localeCompare(a.date) || b.takenAt.localeCompare(a.takenAt));
  const seen = new Set<string>();
  const out: Edition[] = [];
  for (const e of sorted) {
    if (seen.has(e.hoistId)) continue;
    seen.add(e.hoistId);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

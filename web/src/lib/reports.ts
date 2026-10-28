// Producing editions of recurring reports, and freezing a page's answers for an edition or a shared
// report. Whoever can reach the data does it: an analyst's Semaphore, leadership's Ask view, or
// the headless refresher, the same way snapshots are kept fresh.

import { isAway } from '../../../src/core/away.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { findInsights } from '../../../src/core/insights.ts';
import { type Edition, editionDue, editionId, type FrozenFlag, type ReportSchedule } from '../../../src/core/reports.ts';
import { loadItem } from './api.ts';
import { canReach, computeFlag, type DataContext, type FlagResult } from './data.ts';
import type { PlaybookState } from './playbook.ts';

/** Editions kept per page; older ones are removed when a new one is saved. */
export const EDITIONS_KEPT = 12;

/** Every flag's answer as it stands, with no selections. Flags that fail keep their error. */
export async function freezeHoist(hoist: Hoist, ctx: DataContext, index: CatalogIndex): Promise<FrozenFlag[]> {
  const out: FrozenFlag[] = [];
  for (const flag of hoist.flags) {
    // A flag not set up yet has nothing to say to a reader.
    if (!flag.binding && flag.kind !== 'text') continue;
    if (!flag.binding || flag.kind === 'text') {
      out.push({ flag, result: null, insights: [] });
      continue;
    }
    try {
      const r: FlagResult = await computeFlag(hoist, flag, {}, ctx);
      const insights = flag.kind === 'filter' ? [] : findInsights({ flag, rows: r.display.rows, ...(r.previous ? { previous: r.previous } : {}), totals: r.display.totals, today: ctx.today }, index).map((i) => i.text);
      const { sql: _sql, ...kept } = r;
      out.push({ flag, result: kept, insights });
    } catch (e) {
      out.push({ flag, result: null, error: (e as Error).message.slice(0, 300), insights: [] });
    }
  }
  return out;
}

/** The schedules whose owner is away and whose edition is due today (or was missed). */
export function dueSchedules(playbook: PlaybookState, now: Date): Array<{ schedule: ReportSchedule; date: string }> {
  const out: Array<{ schedule: ReportSchedule; date: string }> = [];
  for (const s of playbook.schedules) {
    const notice = playbook.away.find((n) => n.analyst.toLowerCase() === s.owner.toLowerCase());
    if (!notice || !isAway(notice, now)) continue;
    const date = editionDue(s, now);
    if (date) out.push({ schedule: s, date });
  }
  return out;
}

/**
 * Produce every due edition this computer can: the page is loaded from the shared folder (or is the
 * page open here), every flag must reach its data, and the edition is saved before the schedule
 * moves on. Returns one line per schedule for the refresher's log.
 */
export async function produceDueEditions(playbook: PlaybookState, ctx: DataContext, index: CatalogIndex, by: string, current: Hoist | null, now = new Date()): Promise<string[]> {
  const log: string[] = [];
  for (const { schedule, date } of dueSchedules(playbook, now)) {
    let hoist: Hoist | null = current && current.id === schedule.hoistId ? current : null;
    if (!hoist && ctx.server) hoist = await loadItem<Hoist>('hoists', schedule.hoistId).catch(() => null);
    if (!hoist) {
      log.push(`${schedule.title}: the page is not in the shared folder, so no edition.`);
      continue;
    }
    const sources = new Set(hoist.flags.flatMap((f) => (f.binding?.metrics ?? []).map((m) => index.metric(m)?.source ?? '')).filter(Boolean));
    const unreachable = [...sources].filter((s) => !canReach(s, ctx));
    if (unreachable.length) {
      log.push(`${schedule.title}: ${unreachable.join(', ')} is not set up on this computer; another computer can produce it.`);
      continue;
    }
    const flags = await freezeHoist(hoist, ctx, index);
    const edition: Edition = { version: 1, id: editionId(schedule.hoistId, date), kind: 'edition', hoistId: schedule.hoistId, title: hoist.title || schedule.title, owner: schedule.owner, date, takenAt: now.toISOString(), by, cols: hoist.grid.cols, flags };
    try {
      await playbook.saveReportDoc(edition);
      await playbook.saveReportDoc({ ...schedule, lastEdition: date });
      const older = playbook.editions.filter((e) => e.hoistId === schedule.hoistId && e.id !== edition.id).sort((a, b) => b.date.localeCompare(a.date)).slice(EDITIONS_KEPT - 1);
      for (const e of older) await playbook.removeReportDoc(e.id);
      const failed = flags.filter((f) => f.error).length;
      log.push(`${edition.title}: edition for ${date} produced${failed ? `, ${failed} flag${failed === 1 ? '' : 's'} could not be answered` : ''}.`);
    } catch (e) {
      log.push(`${schedule.title}: the edition could not be saved (${(e as Error).message}).`);
    }
  }
  return log;
}

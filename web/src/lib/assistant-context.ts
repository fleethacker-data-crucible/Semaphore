// What the assistant may see of the page when "Include this page" is on (lib/assistant.ts), built in the
// assistant's own lazy chunk. Builder: the page title and brief, and for each flag its id, title, kind,
// brief, the plain-English readback (src/core/describe.ts), its measures, fields and filters, its notes
// and warnings, and a compact summary of what it shows now: at most 10 values from the numbers the page
// already computed (lib/flag-live.ts), with totals and the card's own insights. Leadership: the reviewed
// answers (title, question, kind, measures) with their saved headline numbers and what changed. Both
// carry the catalog's dataset (table) names, measures and fields, so a proposal can name real keys.
// Never a raw row, a source, a connection string or a secret. Everything here is marked untrusted in
// the prompt.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell } from '../../../src/core/crossfilter.ts';
import { describeFlag, filterText, formatNumber } from '../../../src/core/describe.ts';
import { dimensionKey, type Flag, type Hoist } from '../../../src/core/hoist.ts';
import type { PlaybookEntry } from '../../../src/core/playbook.ts';
import type { Snapshot } from '../../../src/core/snapshot.ts';
import { flagLive, type FlagLive } from './flag-live.ts';

/** At most this many values per flag summary. */
export const MAX_VALUES = 10;
const MAX_FLAGS = 40;
const MAX_ENTRIES = 30;

export interface FlagOutline {
  id: string;
  title: string;
  kind: string;
  brief: string;
  status: string;
  readback: string;
  measures: string[];
  fields: string[];
  filters: string[];
  notes: string[];
  /** What the flag shows now, from the page's own computed numbers. */
  shows: string;
}

export interface CatalogOutline {
  datasets: string[];
  measures: Array<{ key: string; label: string }>;
  fields: Array<{ key: string; label: string; type: string }>;
}

export interface BuilderOutline {
  mode: 'builder';
  title: string;
  brief: string;
  filters: string[];
  flags: FlagOutline[];
  catalog: CatalogOutline;
}

export interface LeadershipOutline {
  mode: 'leadership';
  reviewed: Array<{ title: string; question: string; kind: string; measures: string[]; shows: string }>;
  changed: string[];
  waiting: number;
  catalog: CatalogOutline;
}

export type AssistantOutline = BuilderOutline | LeadershipOutline;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function cellText(v: Cell, grain?: string): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  if (!grain) return clip(s, 40);
  if (grain === 'year') return s.slice(0, 4);
  if (grain === 'month') return s.slice(0, 7);
  if (grain === 'quarter') return `Q${Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1} ${s.slice(0, 4)}`;
  return s.slice(0, 10);
}

export function catalogOutline(index: CatalogIndex): CatalogOutline {
  const c = index.catalog;
  const tables = [...new Set(c.fields.map((f) => f.table))].slice(0, 30);
  return {
    datasets: tables,
    measures: c.metrics.slice(0, 60).map((m) => ({ key: m.key, label: m.label })),
    fields: c.fields.slice(0, 80).map((f) => ({ key: f.key, label: f.label, type: f.type })),
  };
}

/** One flag's "what it shows": at most MAX_VALUES values, plus totals and insights. Never rows as they came. */
export function summarizeFlag(flag: Flag, live: FlagLive | undefined, index: CatalogIndex): string {
  if (flag.kind === 'text') return 'a text note (no data)';
  const b = flag.binding;
  if (!b) return 'not drafted yet: it shows nothing';
  if (live?.error) return `could not compute: ${clip(live.error, 160)}`;
  const r = live?.result;
  if (!r) return 'not computed yet';
  const rows = r.display.rows;
  if (!rows.length) return 'shows nothing: the query returned 0 rows';
  const fmt = (k: string, n: number | null | undefined) => formatNumber(n ?? null, index.metric(k)?.format);
  const label = (k: string) => index.metric(k)?.label ?? k;
  const parts: string[] = [];
  let budget = MAX_VALUES;
  if (!b.dimensions.length) {
    const before = r.previous?.[0] ?? null;
    for (const k of b.metrics) {
      if (budget <= 0) break;
      const now = rows[0]!.values[k];
      const was = before?.[k];
      parts.push(`${label(k)} ${fmt(k, now)}${typeof was === 'number' ? ` (before: ${fmt(k, was)})` : ''}`);
      budget--;
    }
  } else {
    const shown = b.metrics.slice(0, 3);
    const perRow = Math.max(1, shown.length);
    const take = Math.max(1, Math.floor(budget / perRow));
    parts.push(`${rows.length} row${rows.length === 1 ? '' : 's'}${r.display.truncated ? ' (hit the row cap, so totals may be incomplete)' : ''}`);
    const vals: string[] = [];
    for (const row of rows.slice(0, take)) {
      const name = b.dimensions.map((d) => cellText(row.dims[dimensionKey(d)] ?? null, d.grain)).join(' / ');
      vals.push(`${name}: ${shown.map((k) => (shown.length > 1 ? `${label(k)} ${fmt(k, row.values[k])}` : fmt(k, row.values[k]))).join(', ')}`);
    }
    parts.push(`${rows.length > take ? `first ${take}` : 'values'}: ${vals.join('; ')}`);
    const totals = b.metrics.filter((k) => typeof r.display.totals[k] === 'number').slice(0, 2);
    if (totals.length) parts.push(`total ${totals.map((k) => `${label(k)} ${fmt(k, r.display.totals[k])}`).join(', ')}`);
  }
  if (live.insights.length) parts.push(`noticed: ${live.insights.slice(0, 3).join(' ')}`);
  return clip(parts.join('. '), 900);
}

export function flagOutline(flag: Flag, hoist: Hoist, index: CatalogIndex): FlagOutline {
  const b = flag.binding;
  const notes = [...flag.notes];
  if (flag.status === 'drafted' && (flag.confidence ?? 1) < 0.6) notes.unshift(`low confidence draft (${Math.round((flag.confidence ?? 0) * 100)}%)`);
  if (flag.status === 'drafted') notes.unshift('drafted, not yet accepted');
  return {
    id: flag.id,
    title: clip(flag.title, 120),
    kind: flag.kind,
    brief: clip(flag.brief, 400),
    status: flag.status,
    readback: flag.kind === 'text' ? '' : clip(describeFlag(flag, hoist, index).join(' '), 500),
    measures: (b?.metrics ?? []).map((k) => `${index.metric(k)?.label ?? k} (${k})`),
    fields: (b?.dimensions ?? []).map((d) => `${index.field(d.field)?.label ?? d.field} (${d.field}${d.grain ? `, by ${d.grain}` : ''})`),
    filters: (b?.filters ?? []).map((f) => clip(filterText(f, index), 160)),
    notes: notes.slice(0, 5).map((n) => clip(n, 200)),
    shows: summarizeFlag(flag, flagLive(flag.id), index),
  };
}

export function builderOutline(hoist: Hoist, index: CatalogIndex): BuilderOutline {
  return {
    mode: 'builder',
    title: clip(hoist.title, 120),
    brief: clip(hoist.brief, 600),
    filters: hoist.filters.map((f) => clip(filterText(f, index), 160)),
    flags: hoist.flags.slice(0, MAX_FLAGS).map((f) => flagOutline(f, hoist, index)),
    catalog: catalogOutline(index),
  };
}

/** A reviewed entry's saved numbers, from its latest snapshot: at most MAX_VALUES, already aggregated. */
function snapshotShows(entry: PlaybookEntry, snaps: readonly Snapshot[], index: CatalogIndex): string {
  const s = snaps.filter((x) => x.entryId === entry.id).sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  if (!s) return 'no saved numbers yet';
  const k = entry.binding.metrics[0];
  if (!k) return 'no measure';
  const m = index.metric(k);
  const dims = entry.binding.dimensions;
  const vals = s.rows.slice(0, dims.length ? MAX_VALUES : 1).map((row) => {
    const v = row[k];
    const n = typeof v === 'number' ? v : null;
    const name = dims.map((d) => cellText((row[dimensionKey(d)] ?? row[d.field] ?? null) as Cell, d.grain)).join(' / ');
    return `${name ? `${name}: ` : ''}${formatNumber(n, m?.format)}`;
  });
  return clip(`as of ${s.asOf.slice(0, 10)}: ${vals.join('; ')}${s.rows.length > vals.length ? ` (of ${s.rows.length})` : ''}`, 700);
}

export function leadershipOutline(entries: readonly PlaybookEntry[], snapshots: readonly Snapshot[], changed: readonly string[], waiting: number, index: CatalogIndex): LeadershipOutline {
  const live = entries.filter((e) => e.status === 'active').slice(0, MAX_ENTRIES);
  return {
    mode: 'leadership',
    reviewed: live.map((e) => ({
      title: clip(e.title, 120),
      question: clip(e.question, 240),
      kind: e.kind,
      measures: e.binding.metrics.map((k) => index.metric(k)?.label ?? k),
      shows: snapshotShows(e, snapshots, index),
    })),
    changed: changed.slice(0, 10).map((c) => clip(c, 200)),
    waiting,
    catalog: catalogOutline(index),
  };
}

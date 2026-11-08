// The team style card: how this team builds flags, learned from the playbook's accepted entries,
// so a draft (by AI or by local rules) can be finished the way the team would finish it while an
// analyst is out. It is a property of the accepted work, not of any person: it is computed from
// entries (finished, accepted flags; never drafts, "do not learn" flags or experiment pages) and
// records nothing about how anyone works.
//
// Each rule says what it is based on ("line for trends: 12 of 14 accepted trend flags"). Analysts
// own the card: they can switch a rule off or pin a value, and those overrides are the only thing
// stored (team/style). A rule needs at least MIN_EVIDENCE accepted flags and a majority among them.
//
// Applying the style only fills what the brief left open: an explicit chart word, a top N or a
// grain in the brief always wins. Every change is written into the draft's notes.

import type { CatalogIndex } from './catalog.ts';
import type { Binding, FlagKind, Threshold, TimeGrain } from './hoist.ts';
import type { FlagDraft } from './intelligence/contract.ts';
import type { PlaybookEntry } from './playbook.ts';

export type Shape = 'number' | 'trend' | 'category' | 'two-categories';

export const SHAPE_LABEL: Record<Shape, string> = {
  number: 'single numbers',
  trend: 'trends over time',
  category: 'one breakdown',
  'two-categories': 'two breakdowns',
};

/** Kinds a shape can be drawn as; a learnt kind outside this list is never applied. */
const KINDS_FOR: Record<Shape, FlagKind[]> = {
  number: ['kpi', 'table'],
  trend: ['line', 'area', 'bar', 'calendar', 'table'],
  category: ['bar', 'pie', 'radar', 'waterfall', 'pareto', 'table'],
  'two-categories': ['bar', 'heatmap', 'sankey', 'sunburst', 'radar', 'stream', 'pivot', 'table'],
};

export const MIN_EVIDENCE = 2;

export interface StyleRule<T> {
  key: string;
  value: T;
  /** Accepted flags that follow the rule, out of those it applies to. */
  evidence: number;
  of: number;
  /** Set by an analyst on the card rather than learnt. */
  pinned?: boolean;
}

export interface TeamStyle {
  chart: Partial<Record<Shape, StyleRule<FlagKind>>>;
  grain: StyleRule<TimeGrain> | null;
  topN: StyleRule<number> | null;
  window: StyleRule<{ count: number; unit: TimeGrain }> | null;
  /** Metric key: the team's colour rules for it. */
  redRules: Record<string, StyleRule<Threshold[]>>;
  /** Rules an analyst switched off (shown greyed on the card, never applied). */
  off: string[];
  learnedFrom: number;
}

/** What analysts changed on the card. Stored as team/style. */
export interface StyleOverrides {
  version: 1;
  id: 'style';
  off: string[];
  pinned: Record<string, unknown>;
  updatedBy: string;
  updated: string;
}

export function emptyOverrides(): StyleOverrides {
  return { version: 1, id: 'style', off: [], pinned: {}, updatedBy: '', updated: new Date(0).toISOString() };
}

export function isStyleOverrides(raw: unknown): raw is StyleOverrides {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o.version === 1 && o.id === 'style' && Array.isArray(o.off) && !!o.pinned && typeof o.pinned === 'object';
}

export function shapeOf(binding: Binding, index: CatalogIndex): Shape {
  const dims = binding.dimensions;
  if (dims.length === 0) return 'number';
  if (dims.some((d) => index.field(d.field)?.type === 'date')) return 'trend';
  return dims.length === 1 ? 'category' : 'two-categories';
}

/** The most common value and how often it occurs, when it has the evidence and a majority. */
function winner<T>(values: T[], key = (v: T) => JSON.stringify(v)): { value: T; count: number } | null {
  if (values.length < MIN_EVIDENCE) return null;
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const k = key(v);
    const c = counts.get(k);
    if (c) c.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  let best: { value: T; count: number } | null = null;
  for (const c of counts.values()) if (!best || c.count > best.count) best = c;
  return best && best.count >= MIN_EVIDENCE && best.count * 2 > values.length ? best : null;
}

const GRAINS: TimeGrain[] = ['day', 'week', 'month', 'quarter', 'year'];

function pinnedValue(key: string, raw: unknown): unknown {
  // Pinned values come from a shared file: accept only the shapes each rule uses.
  if (key.startsWith('chart.')) return typeof raw === 'string' && (KINDS_FOR[key.slice(6) as Shape] ?? []).includes(raw as FlagKind) ? raw : undefined;
  if (key === 'grain') return typeof raw === 'string' && GRAINS.includes(raw as TimeGrain) ? raw : undefined;
  if (key === 'topN') return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 100 ? raw : undefined;
  return undefined;
}

/** The card: learnt from active entries, then the analysts' overrides. */
export function learnStyle(entries: readonly PlaybookEntry[], index: CatalogIndex, overrides: StyleOverrides = emptyOverrides()): TeamStyle {
  const active = entries.filter((e) => e.status === 'active');
  const style: TeamStyle = { chart: {}, grain: null, topN: null, window: null, redRules: {}, off: [...overrides.off], learnedFrom: active.length };

  const byShape = new Map<Shape, FlagKind[]>();
  const grains: TimeGrain[] = [];
  const limits: number[] = [];
  let breakdowns = 0;
  const windows: Array<{ count: number; unit: TimeGrain }> = [];
  for (const e of active) {
    const shape = shapeOf(e.binding, index);
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape)!.push(e.kind);
    for (const d of e.binding.dimensions) if (d.grain && index.field(d.field)?.type === 'date') grains.push(d.grain);
    if (shape === 'category' || shape === 'two-categories') {
      breakdowns++;
      if (e.binding.limit) limits.push(e.binding.limit);
    }
    const last = e.pageFilters.find((f) => f.op === 'last' && f.unit && typeof f.values[0] === 'number');
    if (last) windows.push({ count: last.values[0] as number, unit: last.unit! });
  }
  for (const [shape, kinds] of byShape) {
    const w = winner(kinds.filter((k) => KINDS_FOR[shape].includes(k)));
    if (w) style.chart[shape] = { key: `chart.${shape}`, value: w.value, evidence: w.count, of: kinds.length };
  }
  const g = winner(grains);
  if (g) style.grain = { key: 'grain', value: g.value, evidence: g.count, of: grains.length };
  // Top N is a habit only when most breakdowns are cut, and most cuts are the same size.
  const t = winner(limits);
  if (t && limits.length * 2 > breakdowns) style.topN = { key: 'topN', value: t.value, evidence: t.count, of: breakdowns };
  const win = winner(windows);
  if (win) style.window = { key: 'window', value: win.value, evidence: win.count, of: active.length };

  // Colour rules: the most recently accepted rules for each metric that has them.
  const byMetric = new Map<string, PlaybookEntry[]>();
  for (const e of active) {
    for (const th of e.thresholds) {
      if (!byMetric.has(th.metric)) byMetric.set(th.metric, []);
      if (!byMetric.get(th.metric)!.includes(e)) byMetric.get(th.metric)!.push(e);
    }
  }
  for (const [metric, list] of byMetric) {
    if (!index.metric(metric)) continue;
    const latest = [...list].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))[0]!;
    style.redRules[metric] = { key: `red.${metric}`, value: latest.thresholds.filter((th) => th.metric === metric), evidence: list.length, of: list.length };
  }

  // Pins replace (or add) a rule's value; "off" rules stay on the card but are never applied.
  for (const [key, raw] of Object.entries(overrides.pinned)) {
    const value = pinnedValue(key, raw);
    if (value === undefined) continue;
    if (key.startsWith('chart.')) {
      const shape = key.slice(6) as Shape;
      style.chart[shape] = { key, value: value as FlagKind, evidence: style.chart[shape]?.evidence ?? 0, of: style.chart[shape]?.of ?? 0, pinned: true };
    } else if (key === 'grain') style.grain = { key, value: value as TimeGrain, evidence: style.grain?.evidence ?? 0, of: style.grain?.of ?? 0, pinned: true };
    else if (key === 'topN') style.topN = { key, value: value as number, evidence: style.topN?.evidence ?? 0, of: style.topN?.of ?? 0, pinned: true };
  }
  return style;
}

function on<T>(style: TeamStyle, rule: StyleRule<T> | null | undefined): rule is StyleRule<T> {
  return !!rule && !style.off.includes(rule.key);
}

const KIND_WORD = /\b(kpi|bar|bars|line|lines|area|pie|table|chart|graph|number|headline)\b/i;
// "top 5", "bottom 3", "first 10"; "last 10" too, unless it is a window ("last 12 months").
const LIMIT_WORD = /\b(?:top|bottom|first)\s+\d+\b|\blast\s+\d+\b(?!\s*(?:day|week|month|quarter|year)s?\b)/i;

/** Plain-language rules the card shows, and the AI receives as context. */
export function describeStyle(style: TeamStyle, index: CatalogIndex): string[] {
  const out: string[] = [];
  const why = (r: StyleRule<unknown>) => (r.pinned ? 'set by the team' : `${r.evidence} of ${r.of} accepted flags`);
  for (const shape of Object.keys(SHAPE_LABEL) as Shape[]) {
    const r = style.chart[shape];
    if (on(style, r)) out.push(`Draw ${SHAPE_LABEL[shape]} as ${r.value === 'kpi' ? 'a KPI' : `a ${r.value}`} (${why(r)}).`);
  }
  if (on(style, style.grain)) out.push(`Show time by ${style.grain.value} (${why(style.grain)}).`);
  if (on(style, style.topN)) out.push(`Cut breakdowns to the top ${style.topN.value} (${why(style.topN)}).`);
  if (on(style, style.window)) out.push(`Pages usually cover the last ${style.window.value.count} ${style.window.value.unit}s (${why(style.window)}).`);
  for (const [metric, r] of Object.entries(style.redRules)) {
    if (!on(style, r)) continue;
    const label = index.metric(metric)?.label ?? metric;
    const rules = r.value.map((th) => `${th.tone === 'bad' ? 'red' : th.tone === 'warn' ? 'amber' : 'green'} ${th.op.startsWith('g') ? 'over' : 'under'} ${th.value}`).join(', ');
    out.push(`${label}: ${rules} (${why(r)}).`);
  }
  return out;
}

/**
 * Finish a draft the way the team would, filling only what the brief left open. Returns the new
 * draft and what changed. `auto` is true when the analyst left the chart kind to Semaphore.
 */
export function applyTeamStyle(draft: FlagDraft, style: TeamStyle, index: CatalogIndex, options: { auto: boolean; brief: string }): { draft: FlagDraft; applied: string[] } {
  if (!draft.binding) return { draft, applied: [] };
  const applied: string[] = [];
  let kind = draft.kind;
  let binding: Binding = { ...draft.binding, dimensions: draft.binding.dimensions.map((d) => ({ ...d })) };
  const behavior = { ...draft.behavior, thresholds: [...draft.behavior.thresholds] };
  const shape = shapeOf(binding, index);

  const chart = style.chart[shape];
  if (options.auto && !KIND_WORD.test(options.brief) && on(style, chart) && chart.value !== kind && KINDS_FOR[shape].includes(chart.value)) {
    kind = chart.value;
    applied.push(`${SHAPE_LABEL[shape][0]!.toUpperCase()}${SHAPE_LABEL[shape].slice(1)} are drawn as ${kind === 'kpi' ? 'KPIs' : `${kind}s`}.`);
  }
  if (on(style, style.grain)) {
    let changed = false;
    binding.dimensions = binding.dimensions.map((d) => {
      if (index.field(d.field)?.type !== 'date' || d.grain) return d;
      changed = true;
      return { ...d, grain: style.grain!.value };
    });
    if (changed) applied.push(`Time is shown by ${style.grain.value}.`);
  }
  if ((shape === 'category' || shape === 'two-categories') && on(style, style.topN) && !binding.limit && !LIMIT_WORD.test(options.brief) && binding.metrics[0]) {
    binding = { ...binding, limit: style.topN.value, sort: binding.sort ?? { by: binding.metrics[0], dir: 'desc' } };
    applied.push(`Breakdowns are cut to the top ${style.topN.value}.`);
  }
  if (behavior.thresholds.length === 0) {
    for (const m of binding.metrics) {
      const r = style.redRules[m];
      if (on(style, r)) {
        behavior.thresholds.push(...r.value);
        applied.push(`${index.metric(m)?.label ?? m} uses the team's colour rules.`);
      }
    }
  }
  if (!applied.length) return { draft, applied };
  return { draft: { ...draft, kind, binding, behavior, notes: [...draft.notes, ...applied.map((a) => `Team style: ${a}`)] }, applied };
}

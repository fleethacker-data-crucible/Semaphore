// Call-outs worth a glance, found in a flag's own result after page selections are applied: the
// latest move in a trend, the category that dominates, an outlier, a comparison that changed
// sharply, and how many values break a colour rule. Everything is computed from the rows the
// flag already holds, so nothing goes back to the source.

import type { CatalogIndex } from './catalog.ts';
import type { DisplayRow } from './crossfilter.ts';
import { formatNumber } from './describe.ts';
import { type Flag, type Tone, toneFor } from './hoist.ts';

export interface Insight {
  tone: Tone | 'info';
  text: string;
}

export interface InsightInput {
  flag: Flag;
  rows: readonly DisplayRow[];
  /** Earlier values per row, from lineUp(), when the flag compares. */
  previous?: ReadonlyArray<Record<string, number | null> | null>;
  totals?: Record<string, number | null>;
  /** Today, to tell a period that is still running from a complete one. */
  today?: Date;
}

export const MAX_INSIGHTS = 3;

export function findInsights(input: InsightInput, index: CatalogIndex): Insight[] {
  const { flag, rows } = input;
  const b = flag.binding;
  if (!b || b.metrics.length === 0 || rows.length === 0) return [];
  const key = b.metrics[0]!;
  const m = index.metric(key);
  const label = m?.label ?? key;
  const fmt = (n: number) => formatNumber(n, m?.format);
  const out: Insight[] = [];

  // Comparison with the earlier window.
  if (input.previous && b.dimensions.length === 0) {
    const now = rows[0]!.values[key];
    const before = input.previous[0]?.[key];
    if (typeof now === 'number' && typeof before === 'number' && before !== 0) {
      const pct = (now - before) / Math.abs(before);
      if (Math.abs(pct) >= 0.02) out.push({ tone: 'info', text: `${label} is ${pct > 0 ? 'up' : 'down'} ${pctText(pct)} on ${b.compare === 'previous-year' ? 'a year earlier' : 'the previous period'} (${fmt(before)}).` });
    }
  }

  const time = b.dimensions.find((d) => d.grain);
  const timeKey = time ? `${time.field}@${time.grain}` : null;
  const values = rows.map((r) => r.values[key]).filter((v): v is number => typeof v === 'number');

  if (time && timeKey && b.dimensions.length === 1 && values.length >= 3) {
    // Series in time order. A period still running is partial; compare the last complete ones.
    const series = rows
      .map((r) => ({ at: String(r.dims[timeKey] ?? ''), v: r.values[key] }))
      .filter((p): p is { at: string; v: number } => typeof p.v === 'number' && p.at !== '')
      .sort((a, b2) => a.at.localeCompare(b2.at));
    const today = (input.today ?? new Date()).toISOString().slice(0, 10);
    let end = series.length - 1;
    const partial = series[end] && isCurrentPeriod(series[end]!.at, time.grain!, today);
    if (partial) end--;
    if (end >= 1) {
      const last = series[end]!;
      const prev = series[end - 1]!;
      if (prev.v !== 0) {
        const pct = (last.v - prev.v) / Math.abs(prev.v);
        if (Math.abs(pct) >= 0.1) out.push({ tone: 'info', text: `${label} ${pct > 0 ? 'rose' : 'fell'} ${pctText(pct)} in ${periodName(last.at, time.grain!)} on the ${time.grain} before.` });
      }
      const peak = series.slice(0, end + 1).reduce((a, x) => (x.v > a.v ? x : a));
      if (peak === last && end >= 3) out.push({ tone: 'info', text: `${periodName(last.at, time.grain!)} is the highest ${time.grain} shown.` });
    }
    if (partial) out.push({ tone: 'info', text: `${periodName(series[series.length - 1]!.at, time.grain!)} is still running, so it is not compared.` });
  } else if (!time && b.dimensions.length === 1 && values.length >= 2) {
    const dimKey = b.dimensions[0]!.field;
    const name = (r: DisplayRow) => String(r.dims[dimKey] ?? '(blank)');
    const total = input.totals?.[key] ?? (m?.agg === 'sum' || m?.agg === 'count' ? values.reduce((s, v) => s + v, 0) : null);
    const ranked = rows.filter((r) => typeof r.values[key] === 'number').sort((a, c) => (c.values[key] as number) - (a.values[key] as number));
    const top = ranked[0]!;
    const topV = top.values[key] as number;
    if (total && total > 0 && ranked.length >= 3) {
      const share = topV / total;
      if (share >= 0.3) out.push({ tone: 'info', text: `${name(top)} is ${pctText(share, false)} of all ${label.toLowerCase()}.` });
    }
    // Outlier: well above the rest, measured against the median absolute deviation so one
    // big value cannot hide itself by inflating the spread.
    if (values.length >= 5) {
      const med = median(values);
      const mad = median(values.map((v) => Math.abs(v - med))) || 1e-9;
      const score = (topV - med) / (1.4826 * mad);
      if (score >= 3.5 && topV > med * 1.5) out.push({ tone: 'warn', text: `${name(top)} stands out: ${fmt(topV)} against a typical ${fmt(med)}.` });
    }
    if (input.previous) {
      let biggest: { name: string; pct: number } | null = null;
      rows.forEach((r, i) => {
        const now = r.values[key];
        const before = input.previous![i]?.[key];
        if (typeof now !== 'number' || typeof before !== 'number' || before === 0) return;
        const pct = (now - before) / Math.abs(before);
        if (!biggest || Math.abs(pct) > Math.abs(biggest.pct)) biggest = { name: name(r), pct };
      });
      const big = biggest as { name: string; pct: number } | null;
      if (big && Math.abs(big.pct) >= 0.1) out.push({ tone: 'info', text: `Biggest move: ${big.name}, ${big.pct > 0 ? 'up' : 'down'} ${pctText(big.pct)} on ${b.compare === 'previous-year' ? 'a year earlier' : 'the previous period'}.` });
    }
  }

  // Colour rules.
  if (flag.behavior.thresholds.length && b.dimensions.length > 0) {
    let bad = 0;
    for (const r of rows) {
      const v = r.values[key];
      if (typeof v === 'number' && toneFor(flag.behavior, key, v) === 'bad') bad++;
    }
    if (bad) out.unshift({ tone: 'bad', text: `${bad} of ${rows.length} ${bad === 1 ? 'value breaks' : 'values break'} the red rule.` });
  }
  return out.slice(0, MAX_INSIGHTS);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pctText(p: number, abs = true): string {
  const v = Math.round((abs ? Math.abs(p) : p) * 100);
  return `${v}%`;
}

function isCurrentPeriod(at: string, grain: string, today: string): boolean {
  const start = at.slice(0, 10);
  const t = new Date(`${today}T00:00:00Z`);
  const s = new Date(`${start}T00:00:00Z`);
  const next = new Date(s);
  if (grain === 'day') next.setUTCDate(s.getUTCDate() + 1);
  else if (grain === 'week') next.setUTCDate(s.getUTCDate() + 7);
  else if (grain === 'month') next.setUTCMonth(s.getUTCMonth() + 1);
  else if (grain === 'quarter') next.setUTCMonth(s.getUTCMonth() + 3);
  else next.setUTCFullYear(s.getUTCFullYear() + 1);
  return t >= s && t < next;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "March 2026", "Q2 2026", "2026", "week of 2026-03-02". */
export function periodName(at: string, grain: string): string {
  const y = at.slice(0, 4);
  const mo = Number(at.slice(5, 7));
  if (grain === 'month') return `${MONTHS[mo - 1]} ${y}`;
  if (grain === 'quarter') return `Q${Math.floor((mo - 1) / 3) + 1} ${y}`;
  if (grain === 'year') return y;
  if (grain === 'week') return `the week of ${at.slice(0, 10)}`;
  return at.slice(0, 10);
}

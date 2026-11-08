// The face of a flag: a KPI, a chart, a table, a picker or a note, drawn from its result.
// Clicking a mark on a flag that filters the page selects that value for every other flag.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EChartsCoreOption } from 'echarts/core';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, DisplayRow, Selections } from '../../../src/core/crossfilter.ts';
import { FONT_STACK, type FlagStyle, type HoistDesign, type KpiSize, paletteColors, resolveStyle } from '../../../src/core/design.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { type Behavior, type Threshold, type Tone, type Flag, toneFor } from '../../../src/core/hoist.ts';
import { chartCategories, flagChartOption, formatDim, gaugeOption, isSelected } from '../lib/chart-option.ts';
import type { FlagResult } from '../lib/data.ts';
import { reducedMotion } from '../lib/motion.ts';
import { EChart, themeColors, themeMode, useExtras } from './Chart.tsx';
import { isRichKind } from '../../../src/core/kinds.ts';

export interface FlagViewProps {
  flag: Flag;
  result: FlagResult;
  index: CatalogIndex;
  selections: Selections;
  onSelect: (key: string, value: Cell, additive: boolean) => void;
  themeKey: string;
  /** Id of an element describing the flag in words, for the chart's aria-describedby. */
  describedBy?: string;
  /** The page's design; the flag's own style goes over it. */
  design?: HoistDesign;
  /** Today, for model forecasts' dates. */
  today?: Date;
}

// Model flags load their view, the model list and the chart builder on first use (lib/predict.ts).
const ModelFlag = lazy(() => import('./ModelFlag.tsx'));

export function ModelView(props: { flag: Flag; result: FlagResult | undefined; index: CatalogIndex; themeKey: string; today: Date; design?: HoistDesign }) {
  return (
    <Suspense fallback={<p className="p-2 text-xs text-ink-3">Loading the model…</p>}>
      <ModelFlag {...props} />
    </Suspense>
  );
}

// Custom flags load the frame host on first use; the frame loads its own bundle (web/src/widget-host.ts).
const CustomWidget = lazy(() => import('./CustomWidget.tsx'));

function CustomView(props: FlagViewProps) {
  return (
    <Suspense fallback={<p className="p-2 text-xs text-ink-3">Loading the widget…</p>}>
      <CustomWidget flag={props.flag} result={props.result} index={props.index} selections={props.selections} onSelect={props.onSelect} themeKey={props.themeKey} {...(props.design ? { design: props.design } : {})} />
    </Suspense>
  );
}

export function FlagView(props: FlagViewProps) {
  const { flag } = props;
  if (flag.kind === 'custom') return <CustomView {...props} />;
  if (flag.kind === 'model') return <ModelView flag={flag} result={props.result} index={props.index} themeKey={props.themeKey} today={props.today ?? new Date()} {...(props.design ? { design: props.design } : {})} />;
  if (flag.kind === 'kpi') return <Kpi {...props} />;
  if (flag.kind === 'filter') return <Picker {...props} />;
  if (flag.kind === 'table' || (flag.binding?.metrics.length ?? 0) === 0) return <Table {...props} />;
  // A chart needs a field of its own to draw along. When the plan has none (the only field was
  // dropped, say, as unrelated to the metric's table) show the number rather than fail the page.
  const { plan } = props.result;
  if (!plan.dimensions.some((d) => plan.own.includes(d.key))) return <Kpi {...props} />;
  return <ChartFlag {...props} />;
}

function metricFormat(index: CatalogIndex, key: string) {
  return index.metric(key)?.format;
}

/** The colour rule a value breaks (the first that matches, as toneFor decides). */
export function ruleFor(behavior: Behavior, metric: string, value: number): Threshold | null {
  for (const t of behavior.thresholds) {
    if (t.metric !== metric) continue;
    const hit = t.op === 'lt' ? value < t.value : t.op === 'lte' ? value <= t.value : t.op === 'gt' ? value > t.value : value >= t.value;
    if (hit) return t;
  }
  return null;
}

const TONE_ICON: Record<Tone, LucideIcon> = { bad: AlertTriangle, warn: AlertCircle, good: CheckCircle2 };
const TONE_WORD: Record<Tone, string> = { bad: 'red', warn: 'amber', good: 'green' };

/** A colour rule in words: "Over $5M rule". */
export function ruleText(t: Threshold, format: 'number' | 'currency' | 'percent' | undefined): string {
  return `${t.op === 'gt' || t.op === 'gte' ? 'Over' : 'Under'} ${formatNumber(t.value, format)} rule`;
}

/**
 * A status never shown by colour alone (WCAG 1.4.1): an icon and a word, with the colour named
 * for screen readers. Reads the same in greyscale.
 */
export function RuleBadge({ rule, format, compact }: { rule: Threshold; format: 'number' | 'currency' | 'percent' | undefined; compact?: boolean }) {
  const Icon = TONE_ICON[rule.tone];
  const text = ruleText(rule, format);
  return (
    <span className={`inline-flex items-center gap-1 font-medium text-${rule.tone}`} title={`${text}: shown ${TONE_WORD[rule.tone]}`}>
      <Icon size={compact ? 12 : 14} aria-hidden="true" className="shrink-0" />
      {compact ? <span className="sr-only">{text}</span> : text}
    </span>
  );
}

const KPI_SIZE: Record<KpiSize, string> = { small: 'text-xl', medium: 'text-3xl', large: 'text-5xl', huge: 'text-7xl' };

/** The number rising to its value in one short step on a lively page. The real value is always the last frame. */
function useCountUp(value: number | null, on: boolean): number | null {
  const [shown, setShown] = useState<number | null>(on && value !== null ? 0 : value);
  const raf = useRef(0);
  useEffect(() => {
    if (!on || value === null || reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 200);
      setShown(p >= 1 ? value : value * p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, on]);
  return shown;
}

function Kpi({ flag, result, index, design, themeKey }: FlagViewProps) {
  const style = resolveStyle(design, flag.style);
  const key = flag.binding!.metrics[0]!;
  const v = result.display.rows[0]?.values[key] ?? null;
  const before = result.previous?.[0]?.[key];
  const tone = typeof v === 'number' ? toneFor(flag.behavior, key, v) : null;
  const rule = typeof v === 'number' ? ruleFor(flag.behavior, key, v) : null;
  const toneClass = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-ink';
  const change = typeof v === 'number' && typeof before === 'number' && before !== 0 ? (v - before) / Math.abs(before) : null;
  const others = flag.binding!.metrics.slice(1);
  const counted = useCountUp(typeof v === 'number' ? v : null, style.motion === 'lively');
  const gauge = useMemo(() => {
    if (style.kpiForm !== 'gauge' || !style.gaugeMax || typeof v !== 'number') return null;
    const c = themeColors();
    const colors = paletteColors(style, themeMode(), c.series);
    return gaugeOption({ value: v, max: style.gaugeMax, color: tone ? c[tone] : colors[0]!, c, text: formatNumber(v, metricFormat(index, key)), fontFamily: design?.font ? FONT_STACK[design.font] : undefined });
    // themeKey is a dependency so a theme switch re-reads the colour tokens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style.kpiForm, style.gaugeMax, style.palette, style.colors, v, tone, index, key, themeKey, design?.font]);
  const aligned = style.titleAlign === 'center' ? 'items-center text-center' : '';
  return (
    <div className={`flex h-full flex-col justify-center gap-1 px-1 ${aligned}`}>
      {gauge ? (
        <div className="min-h-0 w-full flex-1">
          <EChart option={gauge} label={`${flag.title || 'Gauge'}: ${formatNumber(v, metricFormat(index, key))} of ${formatNumber(style.gaugeMax!, metricFormat(index, key))}`} motion={style.motion ?? 'calm'} />
        </div>
      ) : (
        <div className={`${KPI_SIZE[style.kpiSize ?? 'medium']} font-semibold tabular-nums tracking-tight ${toneClass}`} title={typeof v === 'number' ? v.toLocaleString('en-US') : ''} aria-label={formatNumber(v, metricFormat(index, key))}>
          {formatNumber(typeof v === 'number' ? counted : v, metricFormat(index, key))}
        </div>
      )}
      {rule && (
        <div className="text-xs">
          <RuleBadge rule={rule} format={metricFormat(index, key)} />
        </div>
      )}
      {change !== null && (
        <div className="flex items-center gap-1 text-xs text-ink-2">
          {change >= 0 ? <ArrowUpRight size={14} className="text-accent" /> : <ArrowDownRight size={14} className="text-brass" />}
          <span className="font-medium tabular-nums">{`${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`}</span>
          <span className="text-ink-3">vs {flag.binding!.compare === 'previous-year' ? 'a year earlier' : 'previous period'} ({formatNumber(before as number, metricFormat(index, key))})</span>
        </div>
      )}
      {others.map((k) => (
        <div key={k} className="text-xs text-ink-2">
          {index.metric(k)?.label}: <span className="font-medium tabular-nums">{formatNumber(result.display.rows[0]?.values[k] ?? null, metricFormat(index, k))}</span>
        </div>
      ))}
    </div>
  );
}

function ChartFlag({ flag, result, index, selections, onSelect, themeKey, describedBy, design }: FlagViewProps) {
  const b = flag.binding!;
  const plan = result.plan;
  const ownDims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const x = ownDims[0]!;
  const series = ownDims[1];
  const rows = result.display.rows;
  const clickable = flag.behavior.onClick !== 'none';

  // Distinct categories along the chart, in order: the keyboard's filter buttons list these too.
  const categories = useMemo(() => chartCategories(flag, result), [flag, result]);
  // The colour rules some mark breaks, for the legend under the chart (pattern + words).
  const broken = useMemo(() => {
    const out: Threshold[] = [];
    if (series) return out;
    for (const k of b.metrics) {
      for (const r of rows) {
        const v = r.values[k];
        const t = typeof v === 'number' ? ruleFor(flag.behavior, k, v) : null;
        if (t && !out.includes(t)) out.push(t);
      }
    }
    return out;
  }, [rows, b.metrics, flag.behavior, series]);

  const style = useMemo(() => resolveStyle(design, flag.style), [design, flag.style]);
  const rich = isRichKind(flag.kind);
  const extras = useExtras(rich);
  const option = useMemo<EChartsCoreOption>(() => {
    const c = themeColors();
    return flagChartOption({ flag, result, index, selections, style, c, colors: paletteColors(style, themeMode(), c.series), ...(design?.font ? { fontFamily: FONT_STACK[design.font] } : {}) });
    // themeKey is a dependency so a theme switch re-reads the colour tokens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flag, result, index, selections, themeKey, style, design?.font, extras]);

  const fieldLabel = index.field(x.field)?.label ?? x.field;
  const drills = flag.behavior.onClick === 'drill';
  // One tab stop for the whole list (the first selected value, else the first); arrows move along it.
  const stop = Math.max(0, categories.findIndex((v) => isSelected(selections, x.key, v) === true));
  const rove = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null || at < 0) return;
    // The page's own arrow keys move the selected flag; here they move along the list instead.
    e.preventDefault();
    e.stopPropagation();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, to))]!;
    for (const btn of buttons) btn.tabIndex = btn === next ? 0 : -1;
    next.focus();
  };
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <EChart
          option={option}
          label={flag.title || 'Chart'}
          motion={style.motion ?? 'calm'}
          {...(describedBy ? { describedBy } : {})}
          onClick={
            clickable
              ? (e) => {
                  // A treemap numbers its marks from its root, so a mark's own value comes first.
                  // The richer kinds carry the value on each mark that stands for one; the rest are not clickable.
                  if (rich && e.raw === undefined) return;
                  const v = e.raw !== undefined ? (e.raw as Cell) : flag.kind === 'pie' ? (rows[e.dataIndex]?.dims[x.key] ?? null) : (categories[e.dataIndex] ?? null);
                  onSelect(x.key, v, false);
                }
              : undefined
          }
        />
        {clickable && categories.length > 0 && (
          // The chart's clicks, for the keyboard: hidden until focus reaches them, then shown over the chart.
          <div role="group" aria-label={`${drills ? 'Drill into' : 'Filter the page by'} ${fieldLabel}`} className="kbd-filter" onKeyDown={rove}>
            {categories.slice(0, 200).map((v, i) => {
              const sel = isSelected(selections, x.key, v);
              return (
                <button key={String(v)} type="button" tabIndex={i === stop ? 0 : -1} aria-pressed={drills ? undefined : sel === true} onClick={() => onSelect(x.key, v, false)} className="kbd-filter-chip">
                  {formatDim(v, x.grain)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {broken.length > 0 && (
        <ul aria-label="Colour rules" className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-[11px] text-ink-2">
          {broken.map((t) => (
            <li key={`${t.metric}-${t.op}-${t.value}`} className="flex items-center gap-1">
              <span aria-hidden="true" className={`rule-swatch rule-swatch-${t.tone}`} />
              {b.metrics.length > 1 ? `${index.metric(t.metric)?.label ?? t.metric}: ` : ''}
              {ruleText(t, metricFormat(index, t.metric))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const drillsTable = (flag: Flag) => flag.behavior.onClick === 'drill';

function Table({ flag, result, index, selections, onSelect, design }: FlagViewProps) {
  const style: FlagStyle = resolveStyle(design, flag.style);
  const plan = result.plan;
  const b = flag.binding!;
  const dims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const rows = result.display.rows;
  const clickable = flag.behavior.onClick !== 'none' && dims.length > 0;
  // The widest value in each measure's column, for the bars behind the numbers.
  const widest = (k: string) => Math.max(0, ...rows.map((r) => Math.abs(typeof r.values[k] === 'number' ? (r.values[k] as number) : 0)));
  const tops = style.tableBars ? Object.fromEntries(b.metrics.map((k) => [k, widest(k)])) : null;
  return (
    <div className="scroll-thin h-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-panel">
          <tr className="text-left text-ink-3">
            {dims.map((d) => (
              <th key={d.key} className="border-b border-line px-2 py-1.5 font-medium">
                {index.field(d.field)?.label ?? d.field}
                {d.grain ? ` (${d.grain})` : ''}
              </th>
            ))}
            {b.metrics.map((k) => (
              <th key={k} className="border-b border-line px-2 py-1.5 text-right font-medium">
                {index.metric(k)?.label ?? k}
              </th>
            ))}
            {b.share && b.metrics[0] && <th className="border-b border-line px-2 py-1.5 text-right font-medium">Share</th>}
            {result.previous && b.metrics[0] && <th className="border-b border-line px-2 py-1.5 text-right font-medium">Change</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const first = dims[0];
            const sel = first ? isSelected(selections, first.key, r.dims[first.key] ?? null) : null;
            const k0 = b.metrics[0];
            const before = k0 ? result.previous?.[i]?.[k0] : undefined;
            const now = k0 ? r.values[k0] : undefined;
            const change = typeof now === 'number' && typeof before === 'number' && before !== 0 ? (now - before) / Math.abs(before) : null;
            const pick = clickable && first ? (additive: boolean) => onSelect(first.key, r.dims[first.key] ?? null, additive) : null;
            return (
              <tr
                key={i}
                onClick={pick ? (e) => pick(e.ctrlKey || e.metaKey) : undefined}
                className={`${clickable ? 'cursor-pointer hover:bg-accent-soft' : ''} ${sel === false ? 'opacity-45' : ''} ${sel ? 'bg-accent-soft' : style.striped && i % 2 ? 'bg-panel-2' : ''}`}
              >
                {dims.map((d, di) => (
                  <td key={d.key} className="border-b border-line/60 px-2 py-1">
                    {pick && di === 0 ? (
                      // The keyboard's way to what a click on the row does: a button in the first cell
                      // (Enter or Space; Ctrl adds to the selection), stopped so the row does not act twice.
                      <button
                        type="button"
                        aria-pressed={sel === true}
                        title={drillsTable(flag) ? 'Drill into this value' : 'Filter the page by this value'}
                        onClick={(e) => {
                          e.stopPropagation();
                          pick(e.ctrlKey || e.metaKey);
                        }}
                        className="-my-1 min-h-8 rounded px-1 text-left hover:underline"
                      >
                        {formatDim(r.dims[d.key] ?? null, d.grain)}
                      </button>
                    ) : (
                      formatDim(r.dims[d.key] ?? null, d.grain)
                    )}
                  </td>
                ))}
                {b.metrics.map((k) => {
                  const v = r.values[k] ?? null;
                  const rule = typeof v === 'number' ? ruleFor(flag.behavior, k, v) : null;
                  const bar = tops?.[k] && typeof v === 'number' ? Math.round((Math.abs(v) / tops[k]!) * 100) : null;
                  return (
                    <td key={k} className={`border-b border-line/60 px-2 py-1 text-right tabular-nums ${rule ? `text-${rule.tone} font-medium` : ''}`} style={bar === null ? undefined : { background: `linear-gradient(to left, var(--accent-soft) ${bar}%, transparent ${bar}%)` }}>
                      <span className="inline-flex items-center justify-end gap-1">
                        {rule && <RuleBadge rule={rule} format={metricFormat(index, k)} compact />}
                        {formatNumber(v, metricFormat(index, k))}
                      </span>
                    </td>
                  );
                })}
                {b.share && k0 && (
                  <td className="border-b border-line/60 px-2 py-1 text-right tabular-nums text-ink-2">
                    {formatNumber(typeof now === 'number' && result.display.totals[k0] ? now / (result.display.totals[k0] as number) : null, 'percent')}
                  </td>
                )}
                {result.previous && k0 && (
                  <td className="border-b border-line/60 px-2 py-1 text-right tabular-nums text-ink-2">{change === null ? '–' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`}</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-3 text-xs text-ink-3">Nothing matches the current selections.</p>}
    </div>
  );
}

function Picker({ flag, result, selections, onSelect }: FlagViewProps) {
  const [q, setQ] = useState('');
  const d = result.plan.dimensions.find((x) => result.plan.own.includes(x.key));
  if (!d) return null;
  const values = result.display.rows.map((r: DisplayRow) => r.dims[d.key] ?? null).sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));
  const shown = q ? values.filter((v) => formatDim(v, d.grain).toLowerCase().includes(q.toLowerCase())) : values;
  const sel = selections[d.key] ?? [];
  return (
    <div className="flex h-full flex-col gap-1.5">
      {values.length > 10 && (
        <label className="focus-frame flex items-center gap-1 rounded-md border border-line px-2">
          <Search size={12} className="text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${flag.title.toLowerCase()}`} aria-label="Find a value" className="w-full bg-transparent py-1 text-xs outline-none" />
        </label>
      )}
      <div className="scroll-thin flex flex-1 flex-wrap content-start gap-1 overflow-auto" role="listbox" aria-multiselectable="true" aria-label={flag.title}>
        {shown.map((v) => {
          const on = sel.some((s) => String(s) === String(v));
          return (
            <button
              key={String(v)}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onSelect(d.key, v, true)}
              className={`min-h-8 rounded-full border px-2 text-xs transition-colors ${on ? 'border-accent bg-accent text-panel' : 'border-line bg-panel-2 text-ink hover:border-accent'}`}
            >
              {formatDim(v, d.grain)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

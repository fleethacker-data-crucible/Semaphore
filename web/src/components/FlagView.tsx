// The face of a flag: a KPI, a chart, a table, a picker or a note, drawn from its result.
// Clicking a mark on a flag that filters the page selects that value for every other flag.

import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Search } from 'lucide-react';
import type { EChartsCoreOption } from 'echarts/core';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, DisplayRow, Selections } from '../../../src/core/crossfilter.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { type Flag, type TimeGrain, toneFor } from '../../../src/core/hoist.ts';
import type { FlagResult } from '../lib/data.ts';
import { EChart, themeColors } from './Chart.tsx';

export interface FlagViewProps {
  flag: Flag;
  result: FlagResult;
  index: CatalogIndex;
  selections: Selections;
  onSelect: (key: string, value: Cell, additive: boolean) => void;
  themeKey: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDim(v: Cell, grain?: TimeGrain): string {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (!grain) return String(v);
  const s = String(v);
  const y = s.slice(0, 4);
  const m = Number(s.slice(5, 7));
  if (grain === 'year') return y;
  if (grain === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (grain === 'week') return `Wk of ${s.slice(5, 10)}`;
  return s.slice(0, 10);
}

export function FlagView(props: FlagViewProps) {
  const { flag } = props;
  if (flag.kind === 'kpi') return <Kpi {...props} />;
  if (flag.kind === 'filter') return <Picker {...props} />;
  if (flag.kind === 'table' || (flag.binding?.metrics.length ?? 0) === 0) return <Table {...props} />;
  return <ChartFlag {...props} />;
}

function metricFormat(index: CatalogIndex, key: string) {
  return index.metric(key)?.format;
}

function Kpi({ flag, result, index }: FlagViewProps) {
  const key = flag.binding!.metrics[0]!;
  const v = result.display.rows[0]?.values[key] ?? null;
  const before = result.previous?.[0]?.[key];
  const tone = typeof v === 'number' ? toneFor(flag.behavior, key, v) : null;
  const toneClass = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-ink';
  const change = typeof v === 'number' && typeof before === 'number' && before !== 0 ? (v - before) / Math.abs(before) : null;
  const others = flag.binding!.metrics.slice(1);
  return (
    <div className="flex h-full flex-col justify-center gap-1 px-1">
      <div className={`text-3xl font-semibold tabular-nums tracking-tight ${toneClass}`} title={typeof v === 'number' ? v.toLocaleString('en-US') : ''}>
        {formatNumber(v, metricFormat(index, key))}
      </div>
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

function isSelected(selections: Selections, key: string, v: Cell): boolean | null {
  const sel = selections[key];
  if (!sel || sel.length === 0) return null;
  return sel.some((x) => String(x) === String(v));
}

function ChartFlag({ flag, result, index, selections, onSelect, themeKey }: FlagViewProps) {
  const b = flag.binding!;
  const plan = result.plan;
  const ownDims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const x = ownDims[0]!;
  const series = ownDims[1];
  const rows = result.display.rows;
  const clickable = flag.behavior.onClick !== 'none';

  const option = useMemo<EChartsCoreOption>(() => {
    const c = themeColors();
    const fmt = (k: string) => (n: number) => formatNumber(n, b.share ? 'percent' : metricFormat(index, k));
    const share = (k: string, v: number | null) => (b.share && typeof v === 'number' && result.display.totals[k] ? v / (result.display.totals[k] as number) : v);
    const base = {
      animationDuration: 250,
      textStyle: { color: c.ink2, fontFamily: 'Segoe UI, system-ui, sans-serif' },
      tooltip: { trigger: flag.kind === 'pie' ? 'item' : 'axis', backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink } },
      color: c.series,
    };
    if (flag.kind === 'pie') {
      const k = b.metrics[0]!;
      return {
        ...base,
        tooltip: { ...base.tooltip, valueFormatter: (n: number) => formatNumber(n, metricFormat(index, k)) },
        series: [
          {
            type: 'pie',
            radius: ['42%', '72%'],
            itemStyle: { borderColor: c.panel, borderWidth: 2 },
            label: { color: c.ink2, formatter: '{b}\n{d}%' },
            data: rows.map((r) => {
              const v = r.dims[x.key] ?? null;
              const sel = isSelected(selections, x.key, v);
              return { name: formatDim(v, x.grain), value: r.values[k], raw: v, itemStyle: sel === false ? { opacity: 0.35 } : {} };
            }),
          },
        ],
      };
    }
    const categories: Cell[] = [];
    for (const r of rows) {
      const v = r.dims[x.key] ?? null;
      if (!categories.some((c2) => String(c2) === String(v))) categories.push(v);
    }
    const isLine = flag.kind === 'line' || flag.kind === 'area';
    const seriesList: Array<Record<string, unknown>> = [];
    if (series) {
      const names: Cell[] = [];
      for (const r of rows) {
        const v = r.dims[series.key] ?? null;
        if (!names.some((n) => String(n) === String(v))) names.push(v);
      }
      const k = b.metrics[0]!;
      for (const n of names) {
        seriesList.push({
          name: formatDim(n, series.grain),
          type: isLine ? 'line' : 'bar',
          stack: !isLine ? 'all' : undefined,
          areaStyle: flag.kind === 'area' ? { opacity: 0.25 } : undefined,
          smooth: isLine ? 0.2 : undefined,
          showSymbol: false,
          data: categories.map((cat) => {
            const r = rows.find((row) => String(row.dims[x.key]) === String(cat) && String(row.dims[series.key]) === String(n));
            return r ? share(k, r.values[k] ?? null) : null;
          }),
        });
      }
    } else {
      b.metrics.forEach((k, mi) => {
        const label = index.metric(k)?.label ?? k;
        seriesList.push({
          name: label,
          type: isLine ? 'line' : 'bar',
          yAxisIndex: mi > 0 && b.metrics.length === 2 ? 1 : 0,
          areaStyle: flag.kind === 'area' ? { opacity: 0.25 } : undefined,
          smooth: isLine ? 0.2 : undefined,
          showSymbol: isLine && categories.length <= 24,
          barMaxWidth: 42,
          data: categories.map((cat, i) => {
            const r = rows.find((row) => String(row.dims[x.key]) === String(cat));
            const v = r ? (r.values[k] ?? null) : null;
            const tone = typeof v === 'number' ? toneFor(flag.behavior, k, v) : null;
            const sel = isSelected(selections, x.key, cat);
            const color = tone ? c[tone] : undefined;
            return { value: share(k, v), itemStyle: { ...(color ? { color } : {}), ...(sel === false ? { opacity: 0.35 } : {}) }, raw: cat, i };
          }),
        });
        if (result.previous && mi === 0) {
          seriesList.push({
            name: `${label}, ${b.compare === 'previous-year' ? 'a year earlier' : 'previous period'}`,
            type: isLine ? 'line' : 'bar',
            lineStyle: { type: 'dashed' },
            itemStyle: { color: c.ink3, opacity: isLine ? 1 : 0.45 },
            showSymbol: false,
            barMaxWidth: 42,
            data: categories.map((cat) => {
              const ri = rows.findIndex((row) => String(row.dims[x.key]) === String(cat));
              return ri >= 0 ? share(k, result.previous![ri]?.[k] ?? null) : null;
            }),
          });
        }
      });
    }
    // Long or many category names read better down the side than squeezed along the bottom.
    const longest = Math.max(0, ...categories.map((v) => formatDim(v, x.grain).length));
    const horizontal = !isLine && !x.grain && (categories.length > 6 || (categories.length > 3 && longest > 9));
    const catAxis = {
      type: 'category',
      data: categories.map((v) => formatDim(v, x.grain)),
      axisLine: { lineStyle: { color: c.line } },
      axisTick: { show: false },
      axisLabel: { color: c.ink2, hideOverlap: !horizontal, ...(horizontal ? { width: 120, overflow: 'truncate', interval: 0 } : {}) },
      inverse: horizontal,
    };
    const valueAxes = (b.metrics.length === 2 && !series ? b.metrics : [b.metrics[0]!]).map((k) => ({
      type: 'value',
      splitLine: { lineStyle: { color: c.line } },
      axisLabel: { color: c.ink3, formatter: fmt(k) },
    }));
    return {
      ...base,
      tooltip: { ...base.tooltip, valueFormatter: (n: number | null) => (n === null || n === undefined ? '–' : fmt(b.metrics[0]!)(n)) },
      legend: seriesList.length > 1 ? { top: 0, type: 'scroll', textStyle: { color: c.ink2 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10 } : undefined,
      grid: { left: 8, right: 12, top: seriesList.length > 1 ? 28 : 10, bottom: 4, containLabel: true },
      xAxis: horizontal ? valueAxes : catAxis,
      yAxis: horizontal ? catAxis : valueAxes,
      series: seriesList,
    };
    // themeKey is a dependency so a theme switch re-reads the colour tokens.
  }, [flag, result, index, selections, themeKey, x, series, rows, b]);

  return (
    <EChart
      option={option}
      label={flag.title}
      onClick={
        clickable
          ? (e) => {
              const cats: Cell[] = [];
              for (const r of rows) {
                const v = r.dims[x.key] ?? null;
                if (!cats.some((c2) => String(c2) === String(v))) cats.push(v);
              }
              const v = flag.kind === 'pie' ? (rows[e.dataIndex]?.dims[x.key] ?? null) : (cats[e.dataIndex] ?? null);
              onSelect(x.key, v, false);
            }
          : undefined
      }
    />
  );
}

function Table({ flag, result, index, selections, onSelect }: FlagViewProps) {
  const plan = result.plan;
  const b = flag.binding!;
  const dims = plan.dimensions.filter((d) => plan.own.includes(d.key));
  const rows = result.display.rows;
  const clickable = flag.behavior.onClick !== 'none' && dims.length > 0;
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
            return (
              <tr
                key={i}
                onClick={clickable && first ? (e) => onSelect(first.key, r.dims[first.key] ?? null, e.ctrlKey || e.metaKey) : undefined}
                className={`${clickable ? 'cursor-pointer hover:bg-accent-soft' : ''} ${sel === false ? 'opacity-45' : ''} ${sel ? 'bg-accent-soft' : ''}`}
              >
                {dims.map((d) => (
                  <td key={d.key} className="border-b border-line/60 px-2 py-1">
                    {formatDim(r.dims[d.key] ?? null, d.grain)}
                  </td>
                ))}
                {b.metrics.map((k) => {
                  const v = r.values[k] ?? null;
                  const tone = typeof v === 'number' ? toneFor(flag.behavior, k, v) : null;
                  return (
                    <td key={k} className={`border-b border-line/60 px-2 py-1 text-right tabular-nums ${tone ? `text-${tone} font-medium` : ''}`}>
                      {formatNumber(v, metricFormat(index, k))}
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
        <label className="flex items-center gap-1 rounded-md border border-line px-2">
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
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${on ? 'border-accent bg-accent text-panel' : 'border-line bg-panel-2 text-ink hover:border-accent'}`}
            >
              {formatDim(v, d.grain)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The face of a model flag: the answer in a sentence, its headline numbers, the chart, and the table
// and the model's own words a click away. The model runs in the predict worker (lib/predict.ts); this
// file loads only when a page has a model flag, with the model list and the chart builder.

import { useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Info, Loader2, Table2 } from 'lucide-react';
import type { EChartsCoreOption } from 'echarts/core';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { FONT_STACK, type HoistDesign, paletteColors, resolveStyle } from '../../../src/core/design.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { fmt } from '../../../src/core/predict/format.ts';
import { modelInfo } from '../../../src/core/predict/models.ts';
import type { ModelOutput } from '../../../src/core/predict/types.ts';
import type { FlagResult } from '../lib/data.ts';
import { modelChartOption } from '../lib/model-chart.ts';
import { useModel } from '../lib/predict.ts';
import { EChart, themeColors, themeMode } from './Chart.tsx';

export interface ModelFlagProps {
  flag: Flag;
  result: FlagResult | undefined;
  index: CatalogIndex;
  themeKey: string;
  today: Date;
  design?: HoistDesign;
}

export default function ModelFlag({ flag, result, index, themeKey, today, design }: ModelFlagProps) {
  const state = useModel(flag, result, index, today);
  const spec = flag.model;
  if (!spec) {
    return (
      <p className="flex h-full items-center justify-center p-3 text-center text-xs text-ink-2" data-testid="model-empty">
        Pick a model in the inspector: a forecast, a Monte Carlo simulation, a control chart, drivers, clusters, reliability and more.
      </p>
    );
  }
  const info = modelInfo(spec.type);
  if (state.state !== 'done') {
    return (
      <p className="flex h-full items-center justify-center gap-2 text-xs text-ink-2" role="status" data-testid="model-running">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
        Running {info.label.toLowerCase()}…{info.heavy ? ' This one can take a few seconds.' : ''}
      </p>
    );
  }
  const a = state.answer;
  if (!a.ok) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-1 p-2 text-xs" data-testid="model-error">
        <p className={`flex items-start gap-2 ${a.expected ? 'text-warn' : 'text-bad'}`}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          {a.error}
        </p>
        <p className="text-ink-2">{info.label} needs {info.needs.text}. Change the fields or the model in the inspector.</p>
      </div>
    );
  }
  return <ModelAnswerView output={a.output} flag={flag} index={index} themeKey={themeKey} {...(design ? { design } : {})} />;
}

function ModelAnswerView({ output, flag, index, themeKey, design }: { output: ModelOutput; flag: Flag; index: CatalogIndex; themeKey: string; design?: HoistDesign }) {
  const [view, setView] = useState<'chart' | 'table' | 'about'>('chart');
  const metricFormat = flag.binding?.metrics[0] ? index.metric(flag.binding.metrics[0])?.format : undefined;
  const style = useMemo(() => resolveStyle(design, flag.style), [design, flag.style]);
  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!output.chart) return null;
    const c = themeColors();
    return modelChartOption({ chart: output.chart, c, colors: paletteColors(style, themeMode(), c.series), ...(metricFormat ? { metricFormat } : {}), ...(design?.font ? { fontFamily: FONT_STACK[design.font] } : {}) }) as EChartsCoreOption;
    // themeKey re-reads the colour tokens after a theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, style, themeKey, metricFormat, design?.font]);
  const tab = (id: typeof view, label: string, Icon: typeof Table2) => (
    <button type="button" aria-pressed={view === id} onClick={() => setView(id)} title={label} aria-label={label} className={`flex h-7 w-7 items-center justify-center rounded-md ${view === id ? 'bg-accent-soft text-accent' : 'text-ink-3 hover:bg-panel-2'}`}>
      <Icon size={13} aria-hidden />
    </button>
  );
  return (
    <div className="flex h-full flex-col gap-1.5" data-testid="model-answer" data-model={output.model}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-ink" data-testid="model-headline">
          {output.headline}
        </p>
        <div className="flex shrink-0 gap-0.5" role="group" aria-label="Show">
          {output.chart && tab('chart', 'Chart', BarChart3)}
          {tab('table', 'Table', Table2)}
          {tab('about', 'What the model says', Info)}
        </div>
      </div>
      {output.stats.length > 0 && (
        <dl className={`grid shrink-0 gap-1.5 ${['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-5', 'grid-cols-6'][Math.min(output.stats.length, flag.layout.w >= 6 ? 6 : 3) - 1]}`}>
          {output.stats.slice(0, flag.layout.w >= 6 ? 6 : 3).map((s) => (
            <div key={s.label} className="min-w-0 rounded-md border border-line bg-panel-2 px-2 py-1" title={s.hint}>
              <dt className="truncate text-[10.5px] uppercase tracking-wide text-ink-3">{s.label}</dt>
              <dd className="truncate text-sm font-semibold tabular-nums text-ink">{typeof s.value === 'number' ? fmt(s.value, s.format ?? 'decimal', metricFormat) : (s.value ?? '–')}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="relative min-h-0 flex-1">
        {view === 'chart' && option ? (
          <EChart option={option} label={`${flag.title || 'Model'}: ${output.headline}`} motion={style.motion ?? 'calm'} />
        ) : view === 'about' || (view === 'chart' && !option) ? (
          <div className="scroll-thin h-full space-y-1.5 overflow-auto text-xs leading-5 text-ink-2" data-testid="model-about">
            {output.sentences.map((s) => (
              <p key={s}>{s}</p>
            ))}
            {output.notes.map((n) => (
              <p key={n} className="text-warn">
                {n}
              </p>
            ))}
          </div>
        ) : (
          <div className="scroll-thin h-full overflow-auto">
            <table className="w-full text-xs tabular-nums" data-testid="model-table">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  {output.table.columns.map((c) => (
                    <th key={c} scope="col" className="border-b border-line px-1.5 py-1 text-left font-semibold text-ink-2">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {output.table.rows.slice(0, 1000).map((r, i) => (
                  <tr key={i} className="odd:bg-panel-2/60">
                    {r.map((v, j) => (
                      <td key={j} className={`border-b border-line/60 px-1.5 py-0.5 ${typeof v === 'number' ? 'text-right' : ''}`}>
                        {typeof v === 'number' ? fmt(v, 'decimal') : (v ?? '–')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {output.notes.length > 0 && view === 'chart' && (
        <p className="shrink-0 truncate text-[11px] text-warn" title={output.notes.join('\n')}>
          {output.notes[0]}
        </p>
      )}
    </div>
  );
}

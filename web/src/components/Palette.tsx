// The flag palette: drag a flag onto the hoist, or click to drop it in the first free slot.
// "Smart flag" leaves the chart to Semaphore: say what you want and it picks the shape.

import { AreaChart, BarChart3, BrainCircuit, CalendarDays, ChartBarDecreasing, ChartColumnStacked, ChartScatter, Filter, Gauge, Grid3x3, LineChart, PieChart, Radar, Sparkles, SunMedium, Table2, Type, Waves, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FlagKind } from '../../../src/core/hoist.ts';
import { KIND_MIME } from './Canvas.tsx';
import { Emblem } from './Welcome.tsx';

export const KIND_META: Record<FlagKind, { label: string; icon: LucideIcon; hint: string }> = {
  kpi: { label: 'KPI', icon: Gauge, hint: 'One headline number' },
  bar: { label: 'Bar', icon: BarChart3, hint: 'Compare categories' },
  line: { label: 'Line', icon: LineChart, hint: 'A trend over time' },
  area: { label: 'Area', icon: AreaChart, hint: 'Volume over time' },
  pie: { label: 'Pie', icon: PieChart, hint: 'Parts of a whole' },
  table: { label: 'Table', icon: Table2, hint: 'Rows and columns' },
  filter: { label: 'Picker', icon: Filter, hint: 'Filter the page' },
  text: { label: 'Note', icon: Type, hint: 'Words, no data' },
  radar: { label: 'Spider', icon: Radar, hint: 'Profiles across measures' },
  scatter: { label: 'Scatter', icon: ChartScatter, hint: 'Two measures against each other' },
  heatmap: { label: 'Heatmap', icon: Grid3x3, hint: 'A grid of two fields' },
  calendar: { label: 'Calendar', icon: CalendarDays, hint: 'Day by day across the year' },
  waterfall: { label: 'Waterfall', icon: ChartColumnStacked, hint: 'Steps up and down to a total' },
  pareto: { label: 'Pareto', icon: ChartBarDecreasing, hint: 'The few that make most of it' },
  sankey: { label: 'Sankey', icon: Workflow, hint: 'Flows from one field to another' },
  sunburst: { label: 'Sunburst', icon: SunMedium, hint: 'Rings of a breakdown' },
  stream: { label: 'Stream', icon: Waves, hint: 'Shares over time' },
  model: { label: 'Predict', icon: BrainCircuit, hint: 'Forecasts, simulations, models' },
};

const ORDER: FlagKind[] = ['kpi', 'bar', 'line', 'area', 'pie', 'table', 'filter', 'text'];
const MORE: FlagKind[] = ['radar', 'scatter', 'heatmap', 'calendar', 'waterfall', 'pareto', 'sankey', 'sunburst', 'stream'];

export function Palette({ onAdd, onHome }: { onAdd: (kind: FlagKind | 'auto') => void; onHome: () => void }) {
  const item = (kind: FlagKind | 'auto', label: string, hint: string, Icon: LucideIcon, accent = false) => (
    <li key={kind}>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(KIND_MIME, kind);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => onAdd(kind)}
        title={`${hint}. Drag onto the page, or click to add.`}
        className={`flex w-full cursor-grab items-center gap-2 rounded-lg border px-2 py-1.5 text-left active:cursor-grabbing ${accent ? 'border-accent/40 bg-accent-soft text-accent hover:border-accent' : 'border-line bg-panel hover:border-accent'}`}
      >
        <Icon size={16} className="shrink-0" />
        <span className="min-w-0">
          <span className="block text-[13px] font-medium leading-tight">{label}</span>
          <span className={`block truncate text-[11px] leading-tight ${accent ? 'text-accent/80' : 'text-ink-3'}`}>{hint}</span>
        </span>
      </button>
    </li>
  );
  return (
    <nav aria-label="Flag palette" className="flex w-[168px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line bg-panel-2 p-3">
      {/* Shown only on a window with room for it (styles.css); otherwise the header's mark is the brand. */}
      <button type="button" onClick={onHome} title="Home: the welcome page" className="rounded-lg">
        <Emblem className="palette-emblem" alt="Semaphore home" />
      </button>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Flags</h2>
      <ul className="flex flex-col gap-1.5">
        {item('auto', 'Smart flag', 'Describe it; Semaphore picks the chart', Sparkles, true)}
        {ORDER.map((k) => item(k, KIND_META[k].label, KIND_META[k].hint, KIND_META[k].icon))}
      </ul>
      <h2 className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">More charts</h2>
      <ul className="flex flex-col gap-1.5" aria-label="More charts">
        {MORE.map((k) => item(k, KIND_META[k].label, KIND_META[k].hint, KIND_META[k].icon))}
      </ul>
      <h2 className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3">Predict</h2>
      <ul className="flex flex-col gap-1.5" aria-label="Predict">
        {item('model', KIND_META.model.label, 'Forecast, Monte Carlo, drivers and more', KIND_META.model.icon)}
      </ul>
    </nav>
  );
}

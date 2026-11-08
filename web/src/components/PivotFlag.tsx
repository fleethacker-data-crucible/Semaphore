// The face of a pivot flag: rows nested by every field but the last, the last field across, the
// measures side by side under each column, with subtotals, a grand total row and a total column.
// Groups fold and unfold (a button with aria-expanded), a measure header orders the rows by that
// column, the corner orders them by label, and a click on a row or column header filters the page
// or drills, as a click on a table row does. The maths is src/core/pivot.ts; this file loads with
// the first pivot flag (web/size-budget.json).

import { useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell } from '../../../src/core/crossfilter.ts';
import { type HoistDesign, paletteColors, resolveStyle } from '../../../src/core/design.ts';
import { formatNumber } from '../../../src/core/describe.ts';
import { buildPivot, canShare, heatLevels, type PivotLine, type PivotValue } from '../../../src/core/pivot.ts';
import type { PivotSort } from '../../../src/core/pivot-spec.ts';
import type { Flag, TimeGrain } from '../../../src/core/hoist.ts';
import { formatDim, isSelected } from '../lib/chart-option.ts';
import type { FlagResult } from '../lib/data.ts';
import { pivotFields, pivotInput, pivotView } from '../lib/pivot-view.ts';
import { themeColors, themeMode } from './Chart.tsx';

export interface PivotFlagProps {
  flag: Flag;
  result: FlagResult;
  index: CatalogIndex;
  selections: Record<string, ReadonlyArray<string | number | boolean | null>>;
  onSelect: (key: string, value: Cell, additive: boolean) => void;
  themeKey: string;
  design?: HoistDesign;
}

const SHOW_WORD = { row: '% of row', column: '% of column', total: '% of total' } as const;

export default function PivotFlag({ flag, result, index, selections, onSelect, themeKey, design }: PivotFlagProps) {
  const view = pivotView(flag.id);
  // The view object is this session's; a counter redraws after changing it.
  const [, redraw] = useState(0);
  const touch = () => redraw((n) => n + 1);
  // A new starting order set in the inspector wins over a header click made before it.
  const specOrder = JSON.stringify([flag.pivot?.sort, flag.pivot?.colSort]);
  const seenOrder = useRef(specOrder);
  if (seenOrder.current !== specOrder) {
    seenOrder.current = specOrder;
    delete view.sort;
    delete view.colSort;
  }
  const fields = useMemo(() => pivotFields(result), [result]);
  const input = pivotInput(flag, result, index, view);
  const grid = useMemo(() => buildPivot(input), [JSON.stringify([input.sort, input.colSort, [...view.collapsed], flag.pivot]), result, flag.binding, index]); // eslint-disable-line react-hooks/exhaustive-deps
  const measures = input.measures;
  const style = resolveStyle(design, flag.style);
  // Heat shading uses the look's palette: one colour per measure, as the charts do.
  const colors = useMemo(() => paletteColors(style, themeMode(), themeColors().series), [style.palette, style.colors, themeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const heat = useMemo(() => Object.fromEntries(measures.flatMap((m) => (flag.pivot?.heat?.[m.key] ? [[m.key, heatLevels(grid, m.key, flag.pivot.heat[m.key]!)]] : []))), [grid, measures, flag.pivot]);
  const clickable = flag.behavior.onClick !== 'none';
  const oneWay = fields.column === null;
  const shareOf = (m: string) => {
    const mode = flag.pivot?.show?.[m] ?? 'value';
    const agg = measures.find((x) => x.key === m)?.agg ?? 'sum';
    return mode !== 'value' && canShare(agg) ? mode : null;
  };
  const label = (m: string) => index.metric(m)?.label ?? m;
  const fieldLabel = (f: { field: string; grain?: string }) => `${index.field(f.field)?.label ?? f.field}${f.grain ? ` (${f.grain})` : ''}`;
  const dim = (f: { grain?: string } | null | undefined, v: Cell) => formatDim(v, f?.grain as TimeGrain | undefined);

  const sortBy = (next: PivotSort | undefined) => {
    view.sort = next;
    touch();
  };
  // Click a measure header: high to low, then low to high, then back to labels.
  const cycle = (by: string, col?: string) => {
    const s = view.sort ?? flag.pivot?.sort;
    const same = s && s.by === by && s.col === col;
    sortBy(!same ? { by, dir: 'desc', ...(col !== undefined ? { col } : {}) } : s.dir === 'desc' ? { by, dir: 'asc', ...(col !== undefined ? { col } : {}) } : { by: '', dir: 'asc' });
  };
  const current = view.sort ?? flag.pivot?.sort;
  const ariaSort = (by: string, col?: string): 'ascending' | 'descending' | 'none' => (current && current.by === by && current.col === col ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  const SortIcon = ({ by, col }: { by: string; col?: string }) => {
    const s = ariaSort(by, col);
    const I = s === 'ascending' ? ArrowUp : s === 'descending' ? ArrowDown : ArrowUpDown;
    return <I size={11} aria-hidden="true" className={s === 'none' ? 'opacity-40' : ''} />;
  };
  const colOrder = view.colSort ?? flag.pivot?.colSort;
  const first = measures[0]?.key;

  const text = (m: string, v: PivotValue | undefined) => {
    if (!v) return '';
    if (v.shown === null) return v.why ? '—' : '';
    return shareOf(m) ? formatNumber(v.shown, 'percent') : formatNumber(v.shown, index.metric(m)?.format);
  };
  const td = (line: PivotLine, colKey: string | null, m: string, i: number) => {
    const v = colKey === null ? line.total[m] : line.cells[colKey]?.[m];
    const t = line.kind === 'leaf' ? heat[m]?.get(`${line.id}\u0000${oneWay ? '' : colKey}`) : undefined;
    const color = colors[i % colors.length] ?? 'var(--accent)';
    return (
      <td
        key={`${colKey ?? 'total'}-${m}`}
        title={v?.why}
        data-heat={t === undefined ? undefined : t.toFixed(2)}
        data-value={v?.shown ?? undefined}
        className={`border-b border-line/60 px-2 py-1 text-right tabular-nums ${colKey === null && !oneWay ? 'bg-panel-2/60 font-medium' : ''} ${v?.why ? 'cursor-help text-ink-3' : ''}`}
        style={t === undefined ? undefined : { background: `color-mix(in srgb, ${color} ${Math.round(8 + t * 52)}%, transparent)` }}
      >
        {text(m, v)}
      </td>
    );
  };

  const rowHeader = (line: PivotLine) => {
    const f = fields.rows[line.depth]!;
    const sel = isSelected(selections, f.key, line.label);
    const pick = (e: React.MouseEvent) => onSelect(f.key, line.label, e.ctrlKey || e.metaKey);
    const name = dim(f, line.label);
    return (
      <th scope="row" className={`sticky left-0 z-[1] whitespace-nowrap border-b border-line/60 bg-panel px-2 py-1 text-left font-normal ${line.kind === 'group' ? 'font-semibold' : ''} ${sel === false ? 'opacity-45' : ''}`} style={{ paddingLeft: 8 + line.depth * 14 }}>
        <span className="inline-flex items-center gap-1">
          {line.kind === 'group' && (
            <button
              type="button"
              aria-expanded={line.open}
              aria-label={`${line.open ? 'Fold' : 'Unfold'} ${name}`}
              onClick={() => {
                if (view.collapsed.has(line.id)) view.collapsed.delete(line.id);
                else view.collapsed.add(line.id);
                touch();
              }}
              className="grid size-6 place-items-center rounded text-ink-3 hover:bg-panel-2"
            >
              {line.open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            </button>
          )}
          {clickable ? (
            <button type="button" aria-pressed={sel === true} title={flag.behavior.onClick === 'drill' ? 'Drill into this value' : 'Filter the page by this value'} onClick={pick} className={`min-h-6 rounded px-1 text-left hover:underline ${sel ? 'bg-accent-soft' : ''}`}>
              {name}
            </button>
          ) : (
            <span className="px-1">{name}</span>
          )}
          {line.kind === 'group' && <span className="text-[10px] font-normal text-ink-3">({line.size})</span>}
        </span>
      </th>
    );
  };

  const values = (line: PivotLine) => (
    <>
      {!oneWay && grid.columns.map((c) => measures.map((m, i) => td(line, c.key, m.key, i)))}
      {measures.map((m, i) => td(line, null, m.key, i))}
    </>
  );
  const many = measures.length > 1;
  const corner = fields.rows.map(fieldLabel).join(' › ');

  return (
    <div className="flex h-full flex-col gap-1" data-testid="pivot">
      <div className="scroll-thin min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label={`${flag.title || 'Pivot'}: scroll for more rows and columns`} role="region">
        <table className="border-collapse text-xs" aria-describedby={grid.notes.length ? `pivot-notes-${flag.id}` : undefined}>
          <thead className="sticky top-0 z-[2] bg-panel">
            {!oneWay && (
              <tr className="text-ink-3">
                <th scope="col" rowSpan={2} aria-sort={ariaSort('')} className="sticky left-0 z-[3] border-b border-line bg-panel px-2 py-1.5 text-left align-bottom font-medium">
                  <button type="button" onClick={() => sortBy(current?.by === '' && current.dir === 'asc' ? { by: '', dir: 'desc' } : { by: '', dir: 'asc' })} className="inline-flex items-center gap-1 hover:text-ink" title="Order the rows by name">
                    {corner} <SortIcon by="" />
                  </button>
                  <span className="block text-[10px] font-normal">
                    <button
                      type="button"
                      onClick={() => {
                        view.colSort = colOrder?.by ? { by: '', dir: 'asc' } : first ? { by: first, dir: 'desc' } : undefined;
                        touch();
                      }}
                      className="underline-offset-2 hover:text-ink hover:underline"
                      title={colOrder?.by ? 'Order the columns by name' : 'Order the columns by their total, highest first'}
                    >
                      {fieldLabel(fields.column!)}: {colOrder?.by ? 'by total' : 'A–Z'}
                    </button>
                  </span>
                </th>
                {grid.columns.map((c) => {
                  const sel = isSelected(selections, fields.column!.key, c.value);
                  return (
                    <th key={c.key} scope="colgroup" colSpan={measures.length} className={`whitespace-nowrap border-b border-line px-2 py-1 text-center font-medium ${sel === false ? 'opacity-45' : ''}`}>
                      {clickable ? (
                        <button type="button" aria-pressed={sel === true} title={flag.behavior.onClick === 'drill' ? 'Drill into this value' : 'Filter the page by this value'} onClick={(e) => onSelect(fields.column!.key, c.value, e.ctrlKey || e.metaKey)} className={`rounded px-1 hover:underline ${sel ? 'bg-accent-soft' : ''}`}>
                          {dim(fields.column, c.value)}
                        </button>
                      ) : (
                        dim(fields.column, c.value)
                      )}
                    </th>
                  );
                })}
                <th scope="colgroup" colSpan={measures.length} className="border-b border-line bg-panel-2/60 px-2 py-1 text-center font-semibold">
                  Total
                </th>
              </tr>
            )}
            <tr className="text-ink-3">
              {oneWay && (
                <th scope="col" aria-sort={ariaSort('')} className="sticky left-0 z-[3] border-b border-line bg-panel px-2 py-1.5 text-left font-medium">
                  <button type="button" onClick={() => sortBy(current?.by === '' && current.dir === 'asc' ? { by: '', dir: 'desc' } : { by: '', dir: 'asc' })} className="inline-flex items-center gap-1 hover:text-ink" title="Order the rows by name">
                    {corner} <SortIcon by="" />
                  </button>
                </th>
              )}
              {[...(oneWay ? [] : grid.columns.map((c) => c.key)), null].flatMap((col) =>
                measures.map((m) => (
                  <th key={`${col ?? 'total'}-${m.key}`} scope="col" aria-sort={ariaSort(m.key, col ?? undefined)} className={`whitespace-nowrap border-b border-line px-2 py-1 text-right font-medium ${col === null && !oneWay ? 'bg-panel-2/60' : ''}`}>
                    <button
                      type="button"
                      onClick={() => cycle(m.key, col ?? undefined)}
                      className="inline-flex items-center gap-1 hover:text-ink"
                      title={`Order the rows by ${label(m.key).toLowerCase()}${col === null ? (oneWay ? '' : ' in the total') : ''}`}
                    >
                      {many || oneWay ? label(m.key) : col === null ? 'Total' : label(m.key)}
                      {shareOf(m.key) ? <span className="font-normal">({SHOW_WORD[shareOf(m.key)!]})</span> : null}
                      <SortIcon by={m.key} {...(col !== null ? { col } : {})} />
                    </button>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {grid.lines.map((line) => (
              <tr key={line.id} data-pivot-line={line.kind} className={line.kind === 'group' ? 'bg-panel-2/40 font-medium' : ''}>
                {rowHeader(line)}
                {values(line)}
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 z-[2] bg-panel">
            <tr data-pivot-line="total" className="font-semibold shadow-[0_-1px_0_var(--line)] [&>td]:border-b-0">
              <th scope="row" className="sticky left-0 z-[3] border-t border-line bg-panel px-2 py-1 text-left">
                Grand total
              </th>
              {values(grid.total)}
            </tr>
          </tfoot>
        </table>
        {grid.lines.length === 0 && <p className="p-3 text-xs text-ink-3">Nothing matches the current selections.</p>}
      </div>
      {(grid.notes.length > 0 || result.display.truncated) && (
        <p id={`pivot-notes-${flag.id}`} className="truncate text-[11px] text-ink-3" title={[...grid.notes, ...(result.display.truncated ? ['The source returned as many rows as it may, so some cells and totals can be missing.'] : [])].join('\n')} data-testid="pivot-note">
          {[...grid.notes, ...(result.display.truncated ? ['The source returned as many rows as it may, so some cells and totals can be missing.'] : [])].join(' ')}
        </p>
      )}
    </div>
  );
}

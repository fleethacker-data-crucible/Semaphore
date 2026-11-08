// Inspector > Pivot: which fields make the rows and the columns, how each measure is shown (its
// values, or a share of its row, column or the whole table), and the order the rows and columns
// start in. Heat shading is in the Look panel. Loaded only when a pivot flag is selected.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { fitPivot } from '../../../src/core/kinds.ts';
import { canShare } from '../../../src/core/pivot.ts';
import type { PivotShow, PivotSort, PivotSpec } from '../../../src/core/pivot-spec.ts';

const SHOW: Array<{ id: PivotShow; label: string }> = [
  { id: 'value', label: 'Values' },
  { id: 'row', label: '% of row' },
  { id: 'column', label: '% of column' },
  { id: 'total', label: '% of total' },
];

function tidy(spec: PivotSpec): PivotSpec | undefined {
  const out: PivotSpec = { ...spec };
  if (out.show && !Object.keys(out.show).length) delete out.show;
  if (!out.sort) delete out.sort;
  if (!out.colSort) delete out.colSort;
  return Object.keys(out).length ? out : undefined;
}

export default function PivotPanel({ flag, index, onChange }: { flag: Flag; index: CatalogIndex; onChange: (patch: Partial<Flag>, group?: string) => void }) {
  const b = flag.binding;
  const spec = flag.pivot ?? {};
  const set = (next: PivotSpec) => onChange({ pivot: tidy(next) }, `pivot-${flag.id}`);
  const label = (f: { field: string; grain?: string }) => `${index.field(f.field)?.label ?? f.field}${f.grain ? ` (${f.grain})` : ''}`;
  const dims = b?.dimensions ?? [];
  const rows = dims.length > 1 ? dims.slice(0, -1) : dims;
  const column = dims.length > 1 ? dims[dims.length - 1] : undefined;
  const note = b ? fitPivot({ ...b, dimensions: [...b.dimensions] }).note : undefined;
  const metrics = b?.metrics ?? [];
  const field = 'min-h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs focus:border-accent focus:outline-none';
  const sortValue = (s: PivotSort | undefined) => (s?.by ? `${s.by}|${s.dir}` : s?.dir === 'desc' ? '|desc' : '');
  const toSort = (v: string): PivotSort | undefined => {
    if (!v) return undefined;
    const [by, dir] = v.split('|') as [string, 'asc' | 'desc'];
    return { by, dir };
  };
  return (
    <section aria-label="Pivot" className="space-y-2" data-testid="pivot-panel">
      <h3 className="text-xs font-semibold text-ink-2">Pivot</h3>
      {!b || !dims.length ? (
        <p className="text-[11.5px] leading-5 text-ink-2">Describe the pivot in the brief, for example “labor cost by region and ship class across status”: every field but the last makes the rows, the last makes the columns.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
          <dt className="text-ink-3">Rows</dt>
          <dd>{rows.map(label).join(' › ')}</dd>
          <dt className="text-ink-3">Columns</dt>
          <dd>{column ? label(column) : 'none: a one-way table with a total'}</dd>
        </dl>
      )}
      {note && (
        <p className="text-[11.5px] leading-5 text-warn" data-testid="pivot-fit-note">
          {note}
        </p>
      )}
      {metrics.map((m) => {
        const agg = index.metric(m)?.agg ?? 'sum';
        const ok = canShare(agg);
        return (
          <label key={m} className="block text-[11px] font-medium text-ink-2">
            {index.metric(m)?.label ?? m}: show as
            <select aria-label={`Show ${index.metric(m)?.label ?? m} as`} disabled={!ok} value={ok ? (spec.show?.[m] ?? 'value') : 'value'} onChange={(e) => {
              const show = { ...(spec.show ?? {}) };
              if (e.target.value === 'value') delete show[m];
              else show[m] = e.target.value as PivotShow;
              set({ ...spec, show });
            }} className={`${field} mt-1 disabled:opacity-50`}>
              {SHOW.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {!ok && <span className="mt-0.5 block font-normal text-ink-3">An {agg === 'avg' ? 'average' : agg === 'min' ? 'minimum' : 'maximum'} is not a share of anything, so it shows its values.</span>}
          </label>
        );
      })}
      {metrics.length > 0 && (
        <>
          <label className="block text-[11px] font-medium text-ink-2">
            Rows start in order
            <select aria-label="Row order" value={sortValue(spec.sort)} onChange={(e) => set({ ...spec, ...(toSort(e.target.value) ? { sort: toSort(e.target.value)! } : { sort: undefined }) })} className={`${field} mt-1`}>
              <option value="">By name, A to Z</option>
              <option value="|desc">By name, Z to A</option>
              {metrics.map((m) => (
                <option key={m} value={`${m}|desc`}>
                  By total {(index.metric(m)?.label ?? m).toLowerCase()}, highest first
                </option>
              ))}
              {metrics.map((m) => (
                <option key={`${m}-a`} value={`${m}|asc`}>
                  By total {(index.metric(m)?.label ?? m).toLowerCase()}, lowest first
                </option>
              ))}
            </select>
          </label>
          {column && (
            <label className="block text-[11px] font-medium text-ink-2">
              Columns start in order
              <select aria-label="Column order" value={sortValue(spec.colSort)} onChange={(e) => set({ ...spec, ...(toSort(e.target.value) ? { colSort: toSort(e.target.value)! } : { colSort: undefined }) })} className={`${field} mt-1`}>
                <option value="">By name, A to Z</option>
                <option value="|desc">By name, Z to A</option>
                {metrics.map((m) => (
                  <option key={m} value={`${m}|desc`}>
                    By total {(index.metric(m)?.label ?? m).toLowerCase()}, highest first
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-[11px] leading-4 text-ink-3">Click a measure under a column on the flag to order the rows by it; heat shading is under Look.</p>
        </>
      )}
    </section>
  );
}

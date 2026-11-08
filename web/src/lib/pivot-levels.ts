// A pivot's totals for measures that cannot be added up from its cells (averages, distinct counts,
// and anything split by a many-side field): the same flag asked again, grouped by fewer fields, one
// query per grouping (src/core/pivot.ts neededLevels). They go through the same planning, cache and
// cross-filtering as the flag itself, with the same selections, so every total matches its cells.
// Loaded with the first pivot flag.

import type { DisplayRow, Selections } from '../../../src/core/crossfilter.ts';
import type { Flag, Hoist } from '../../../src/core/hoist.ts';
import { levelKey, neededLevels, needsLevels } from '../../../src/core/pivot.ts';
import type { DataContext, FlagResult } from './data.ts';

type Compute = (hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext) => Promise<FlagResult>;

export async function pivotLevels(hoist: Hoist, flag: Flag, selections: Selections, ctx: DataContext, main: FlagResult, compute: Compute): Promise<Record<string, DisplayRow[]> | undefined> {
  const b = flag.binding;
  if (!b || !b.dimensions.length) return undefined;
  if (!needsLevels(main.plan.metrics, !!main.plan.many?.overlap)) return undefined;
  const dims = b.dimensions;
  const hasColumn = dims.length > 1;
  const rowFields = hasColumn ? dims.length - 1 : dims.length;
  const out: Record<string, DisplayRow[]> = {};
  await Promise.all(
    neededLevels(rowFields, hasColumn).map(async ([depth, withColumn]) => {
      const dimensions = [...dims.slice(0, depth), ...(withColumn ? [dims[dims.length - 1]!] : [])];
      // A plain grouping: no top-N, share or comparison, which only change how the flag's own rows read.
      const sub: Flag = { ...flag, kind: dimensions.length ? 'table' : 'kpi', binding: { metrics: b.metrics, dimensions, filters: b.filters } };
      try {
        out[levelKey(depth, withColumn)] = (await compute(hoist, sub, selections, ctx)).display.rows;
      } catch {
        // Left out: those totals show a dash with the reason (pivot.ts), never a guess.
      }
    }),
  );
  return out;
}

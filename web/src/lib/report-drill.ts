// Drill levels inside a shared report. A report has no database, so the levels a reader can open are
// worked out when the report is saved: breadth first, each level of a drillable flag for each value
// above it, using the same drill rule the page uses (src/core/drill.ts). A reader's click then looks the
// level up. Levels past the budget are not in the file and the reader says so. Page filters do not
// apply below the top level in a file (the same as on the page, where a drill narrows one flag only).

import { canDrill, type DrillStep, drillView, nextLevel } from '../../../src/core/drill.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag, Hoist } from '../../../src/core/hoist.ts';
import { dimensionKey } from '../../../src/core/hoist.ts';
import type { FrozenDrillNode } from '../../../src/core/reports.ts';
import { computeFlag, type DataContext, type FlagResult } from './data.ts';

/** Levels kept for one flag, and for the whole report. Breadth first, so the upper levels always make it in. */
export const DRILL_NODES_PER_FLAG = 150;
export const DRILL_NODES_PER_REPORT = 600;

function lite(r: FlagResult): unknown {
  const { sql: _sql, raw: _raw, previousRaw: _previousRaw, ...kept } = r;
  return kept;
}

/**
 * Every level below the flag's top level that fits the budget: one node per clicked value. The detail
 * table (the rows behind the last level) is never saved: it can be hundreds of rows per value.
 */
export async function freezeDrill(hoist: Hoist, flag: Flag, top: FlagResult, ctx: DataContext, index: CatalogIndex, budget: { left: number }, perFlag = DRILL_NODES_PER_FLAG): Promise<FrozenDrillNode[]> {
  if (!flag.binding || !canDrill(index, flag)) return [];
  const nodes: FrozenDrillNode[] = [];
  const queue: Array<{ steps: DrillStep[]; result: FlagResult }> = [{ steps: [], result: top }];
  while (queue.length && nodes.length < perFlag && budget.left > 0) {
    const at = queue.shift()!;
    const here = drillView(flag, at.steps, index);
    const first = here.flag.binding?.dimensions[0];
    if (!first || here.detail || nextLevel(index, first) === null) continue;
    const key = dimensionKey(first);
    for (const row of at.result.display.rows) {
      if (nodes.length >= perFlag || budget.left <= 0) break;
      const value = row.dims[key];
      if (value === undefined) continue;
      const steps: DrillStep[] = [...at.steps, { field: first.field, ...(first.grain ? { grain: first.grain } : {}), value }];
      const view = drillView(flag, steps, index);
      if (view.detail) continue; // the rows behind a value are not kept
      let result: FlagResult;
      try {
        result = await computeFlag(hoist, view.flag, {}, ctx);
      } catch {
        continue; // a level that cannot be worked out is simply not in the file
      }
      nodes.push({ steps, result: lite(result) });
      budget.left--;
      queue.push({ steps, result });
    }
  }
  return nodes;
}

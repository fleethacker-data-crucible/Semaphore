// The chart forms only some looks use. Loaded the first time a chart needs one, so a page that draws
// plain bars, lines and pies never pays for them (web/size-budget.json). These are direct paths, not
// the echarts/charts index: the page imports that index, which would pull all of this into its start.

import 'echarts/lib/chart/funnel';
import 'echarts/lib/chart/gauge';
import 'echarts/lib/chart/treemap';
import 'echarts/lib/component/dataZoom';
import 'echarts/lib/chart/radar';
import 'echarts/lib/chart/scatter';
import 'echarts/lib/chart/heatmap';
import 'echarts/lib/chart/sankey';
import 'echarts/lib/chart/sunburst';
import 'echarts/lib/chart/themeRiver';
import 'echarts/lib/chart/map';
import 'echarts/lib/component/geo';
import 'echarts/lib/component/radar';
import 'echarts/lib/component/visualMap';
import 'echarts/lib/component/calendar';
import 'echarts/lib/component/singleAxis';
import { registerMap } from 'echarts/lib/core/echarts.js';
import { use } from 'echarts/lib/extension.js';
import { LabelLayout } from 'echarts/features';
import { STATES, tileGeoJSON, US_STATES } from '../../../src/core/geo.ts';
import { setRichBuilder } from '../lib/chart-option.ts';
import { richChartNote, richChartOption } from '../lib/chart-kinds.ts';
import { chartMapName, mapEntry, setMapEntry } from '../lib/map-registry.ts';
import { listRegionMaps, regionMapShapes } from '../lib/maps.ts';

// The richer kinds (src/core/kinds.ts) are drawn by chart-kinds.ts, which comes with these forms.
setRichBuilder(richChartOption, richChartNote);
// Lets labels that would sit on top of each other (a scatter's names) hide instead.
use([LabelLayout]);

// The built-in US state tile map: drawn from positions in geo.ts, no map data.
registerMap(chartMapName(US_STATES), tileGeoJSON() as never);
setMapEntry(US_STATES, { state: 'ready', regions: STATES.map((s) => s[0]), aliases: {}, lonLat: false, name: 'US states' });

const loading = new Map<string, Promise<void>>();

/** Registers a region map from the Semaphore folder with the chart library, once; a failure is kept as 'missing'. */
export function ensureMap(id: string): Promise<void> {
  if (id === US_STATES || mapEntry(id)?.state === 'ready') return Promise.resolve();
  const running = loading.get(id);
  if (running) return running;
  setMapEntry(id, { state: 'loading', regions: [], aliases: {}, lonLat: false, name: id });
  const p = (async () => {
    try {
      const [list, shapes] = await Promise.all([listRegionMaps(), regionMapShapes(id)]);
      const meta = list.find((m) => m.id === id);
      const features = (shapes as { features?: Array<{ properties?: { name?: unknown } }> } | null)?.features;
      if (!Array.isArray(features)) throw new Error('its file is not a region map');
      registerMap(chartMapName(id), shapes as never);
      setMapEntry(id, { state: 'ready', regions: [...new Set(features.map((f) => String(f.properties?.name ?? '')).filter(Boolean))], aliases: meta?.aliases ?? {}, lonLat: meta?.lonLat ?? true, name: meta?.name ?? id });
    } catch (e) {
      setMapEntry(id, { state: 'missing', regions: [], aliases: {}, lonLat: false, name: id, error: e instanceof Error ? e.message : String(e) });
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, p);
  return p;
}

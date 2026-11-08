// Which maps the chart library knows about, for the option builder (chart-kinds.ts) to read. The
// maps themselves are registered by chart-extras.ts: the built-in tile map when it loads, a region
// map from the Semaphore folder the first time a flag asks for it (Chart.tsx useMap). Plain data,
// so the page's start carries only this and the tests can fill it by hand.

export interface MapEntry {
  state: 'loading' | 'ready' | 'missing';
  /** Region names as the map draws them (for the tile map, state codes). */
  regions: string[];
  /** Other names for a region, from the region map's settings. */
  aliases: Record<string, string>;
  /** Positions are longitude and latitude, so points can go on it. */
  lonLat: boolean;
  name: string;
  error?: string;
}

const maps = new Map<string, MapEntry>();

export const mapEntry = (id: string): MapEntry | undefined => maps.get(id);
export function setMapEntry(id: string, entry: MapEntry | null): void {
  if (entry) maps.set(id, entry);
  else maps.delete(id);
}
/** The name the chart library knows a map by. */
export const chartMapName = (id: string): string => `semaphore-map-${id}`;

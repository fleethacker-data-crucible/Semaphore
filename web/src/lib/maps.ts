// Region maps: the analyst's own GeoJSON regions (fleet regions, ports, bases), kept in
// SEMAPHORE_HOME\maps on the server (server/Routes.ps1), so every page on the team can draw them.
// The file is read and cut down in the page first (src/core/geo.ts parseRegionFile).

import { api } from './api.ts';

export interface RegionMapInfo {
  id: string;
  name: string;
  /** How many regions it has. */
  regions: number;
  aliases: Record<string, string>;
  lonLat: boolean;
  bytes: number;
  by: string;
  updated: string;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function info(e: Record<string, unknown>): RegionMapInfo {
  const aliases: Record<string, string> = {};
  if (typeof e.aliases === 'object' && e.aliases !== null && !Array.isArray(e.aliases)) {
    for (const [k, v] of Object.entries(e.aliases as Record<string, unknown>)) if (typeof v === 'string' && k !== '__proto__') aliases[k] = v;
  }
  return { id: String(e.id), name: text(e.name, 80) || String(e.id), regions: typeof e.regions === 'number' ? e.regions : 0, aliases, lonLat: e.lonLat !== false, bytes: typeof e.bytes === 'number' ? e.bytes : 0, by: text(e.by, 64), updated: text(e.updated, 40) };
}

export async function listRegionMaps(): Promise<RegionMapInfo[]> {
  const raw = await api<unknown>('/api/maps');
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string').map(info);
}

/** The region map's GeoJSON, as saved. */
export const regionMapShapes = (id: string) => api<unknown>(`/api/maps/${encodeURIComponent(id)}`);

/**
 * Saves a new region map (the server picks the id from the name) or, with `id`, changes one: its name
 * and other names, and its shapes when `geojson` is given.
 */
export async function saveRegionMap(m: { id?: string; name: string; geojson?: string; aliases: Record<string, string>; lonLat?: boolean }): Promise<RegionMapInfo> {
  const raw = await api<{ ok: boolean; map: unknown }>('/api/maps', { json: m });
  if (typeof raw?.map !== 'object' || raw.map === null) throw new Error('The server did not return the saved map.');
  return info(raw.map as Record<string, unknown>);
}

export const deleteRegionMap = (id: string) => api<{ ok: boolean }>(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Maps without the internet: the built-in US state tile map, the analyst's own region files
// (GeoJSON or TopoJSON, kept in the Semaphore folder) and points from latitude and longitude.
//
// The tile map is a grid cartogram: every state (and DC) is the same square at a fixed place, so a
// small state reads as well as a large one and no map data is needed. The positions are our own.
// A region file is checked and cut down to what a map needs (each region's outline and name)
// before it is saved; the server checks it again (server/Routes.ps1 Test-SemMapBody).
//
// Loaded with the chart extras and the Settings > Maps card, never with the page's start.

/** Limits on a region file. The server keeps the same ones (server/Routes.ps1). */
export const MAP_LIMITS = {
  /** The cut-down GeoJSON as saved. */
  bytes: 2 * 1024 * 1024,
  /** The file as picked, before it is cut down. */
  fileBytes: 20 * 1024 * 1024,
  regions: 2000,
  points: 250_000,
  nameChars: 80,
  aliases: 500,
  maps: 50,
} as const;

/** The built-in map's id in a flag's style (FlagStyle.map). */
export const US_STATES = 'us-states';

/** USPS code, name, column, row, then other ways the state is written. */
type StateRow = readonly [string, string, number, number, ...string[]];
export const STATES: readonly StateRow[] = [
  ['AK', 'Alaska', 0, 0, 'alas'],
  ['ME', 'Maine', 11, 0, 'me'],
  ['WI', 'Wisconsin', 6, 1, 'wis', 'wisc'],
  ['VT', 'Vermont', 10, 1, 'vt'],
  ['NH', 'New Hampshire', 11, 1, 'n h'],
  ['WA', 'Washington', 1, 2, 'wash', 'washington state'],
  ['ID', 'Idaho', 2, 2, 'ida'],
  ['MT', 'Montana', 3, 2, 'mont'],
  ['ND', 'North Dakota', 4, 2, 'n dak', 'n d', 'no dak'],
  ['MN', 'Minnesota', 5, 2, 'minn'],
  ['IL', 'Illinois', 6, 2, 'ill'],
  ['MI', 'Michigan', 7, 2, 'mich'],
  ['NY', 'New York', 9, 2, 'n y', 'new york state'],
  ['MA', 'Massachusetts', 10, 2, 'mass'],
  ['OR', 'Oregon', 1, 3, 'ore', 'oreg'],
  ['NV', 'Nevada', 2, 3, 'nev'],
  ['WY', 'Wyoming', 3, 3, 'wyo'],
  ['SD', 'South Dakota', 4, 3, 's dak', 's d', 'so dak'],
  ['IA', 'Iowa', 5, 3, 'ia'],
  ['IN', 'Indiana', 6, 3, 'ind'],
  ['OH', 'Ohio', 7, 3, 'oh'],
  ['PA', 'Pennsylvania', 8, 3, 'penn', 'penna'],
  ['NJ', 'New Jersey', 9, 3, 'n j'],
  ['CT', 'Connecticut', 10, 3, 'conn'],
  ['RI', 'Rhode Island', 11, 3, 'r i'],
  ['CA', 'California', 1, 4, 'calif', 'cal'],
  ['UT', 'Utah', 2, 4, 'ut'],
  ['CO', 'Colorado', 3, 4, 'colo'],
  ['NE', 'Nebraska', 4, 4, 'neb', 'nebr'],
  ['MO', 'Missouri', 5, 4, 'mo'],
  ['KY', 'Kentucky', 6, 4, 'ky'],
  ['WV', 'West Virginia', 7, 4, 'w va', 'w virginia'],
  ['VA', 'Virginia', 8, 4, 'va'],
  ['MD', 'Maryland', 9, 4, 'md'],
  ['DE', 'Delaware', 10, 4, 'del'],
  ['AZ', 'Arizona', 2, 5, 'ariz'],
  ['NM', 'New Mexico', 3, 5, 'n m', 'n mex'],
  ['KS', 'Kansas', 4, 5, 'kan', 'kans'],
  ['AR', 'Arkansas', 5, 5, 'ark'],
  ['TN', 'Tennessee', 6, 5, 'tenn'],
  ['NC', 'North Carolina', 7, 5, 'n c', 'n carolina'],
  ['SC', 'South Carolina', 8, 5, 's c', 's carolina'],
  ['DC', 'District of Columbia', 9, 5, 'd c', 'washington dc', 'washington d c', 'washington, dc', 'washington, d c'],
  ['OK', 'Oklahoma', 4, 6, 'okla'],
  ['LA', 'Louisiana', 5, 6, 'la'],
  ['MS', 'Mississippi', 6, 6, 'miss'],
  ['AL', 'Alabama', 7, 6, 'ala'],
  ['GA', 'Georgia', 8, 6, 'ga'],
  ['HI', 'Hawaii', 0, 7, "hawai'i", 'hawai i'],
  ['TX', 'Texas', 4, 7, 'tex'],
  ['FL', 'Florida', 9, 7, 'fla'],
];

/** Lower case, no dots, single spaces: how names are compared. */
export function normalName(v: unknown): string {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

let stateIndex: Map<string, string> | null = null;
/** The state's USPS code for a value written as a code, a name or a common abbreviation; else null. */
export function matchState(v: unknown): string | null {
  if (!stateIndex) {
    stateIndex = new Map();
    for (const [code, name, , , ...more] of STATES) {
      for (const w of [code, name, ...more]) {
        stateIndex.set(normalName(w), code);
        // "NewYork", "N.H." written "NH": the same words run together.
        if (!stateIndex.has(normalName(w).replace(/[ ,']/g, ''))) stateIndex.set(normalName(w).replace(/[ ,']/g, ''), code);
      }
      stateIndex.set(`us ${code.toLowerCase()}`, code);
      stateIndex.set(`us-${code.toLowerCase()}`, code);
      stateIndex.set(`state of ${normalName(name)}`, code);
    }
  }
  const s = normalName(v);
  return stateIndex.get(s) ?? stateIndex.get(s.replace(/,/g, '').replace(/\s+/g, ' ')) ?? stateIndex.get(s.replace(/\s+/g, '')) ?? null;
}

export const stateName = (code: string): string => STATES.find((s) => s[0] === code)?.[1] ?? code;

export interface Feature {
  type: 'Feature';
  properties: { name: string };
  geometry: { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };
}
export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

/** The tile map as GeoJSON for echarts.registerMap: one square per state, named by its code, row 0 at the top. */
export function tileGeoJSON(): FeatureCollection {
  const size = 0.9;
  return {
    type: 'FeatureCollection',
    features: STATES.map(([code, , col, row]) => {
      const x = col;
      const y = -row;
      return { type: 'Feature', properties: { name: code }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y - size], [x, y - size], [x, y]]] } };
    }),
  };
}

/** Field values to the map's regions: by name, then by the alias list. Unmatched values are listed. */
export function matchRegions(values: readonly unknown[], regions: readonly string[], aliases: Record<string, string> = {}): { matched: Map<string, string>; unmatched: string[] } {
  const byName = new Map(regions.map((r) => [normalName(r), r]));
  for (const [alias, region] of Object.entries(aliases)) {
    const r = byName.get(normalName(region));
    if (r && !byName.has(normalName(alias))) byName.set(normalName(alias), r);
  }
  const matched = new Map<string, string>();
  const unmatched: string[] = [];
  for (const v of values) {
    const key = String(v ?? '');
    if (matched.has(key) || unmatched.includes(key)) continue;
    const r = byName.get(normalName(v));
    if (r) matched.set(key, r);
    else unmatched.push(key);
  }
  return { matched, unmatched };
}

/** Field values to state codes. */
export function matchStates(values: readonly unknown[]): { matched: Map<string, string>; unmatched: string[] } {
  const matched = new Map<string, string>();
  const unmatched: string[] = [];
  for (const v of values) {
    const key = String(v ?? '');
    if (matched.has(key) || unmatched.includes(key)) continue;
    const code = matchState(v);
    if (code) matched.set(key, code);
    else unmatched.push(key);
  }
  return { matched, unmatched };
}

/** "Not on the map: Guam, Puerto Rico and 3 more." for values that matched no region; null when all did. */
export function unmatchedNote(unmatched: readonly string[]): string | null {
  if (!unmatched.length) return null;
  const shown = unmatched.slice(0, 6).map((v) => (v === '' || v === 'null' ? '(blank)' : v));
  const more = unmatched.length - shown.length;
  return `Not on the map: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

/** One number for a region several values fell in: the total, or for an average, lowest or highest, the same of them. */
export function combine(agg: string | undefined, values: readonly number[]): number {
  if (agg === 'avg') return values.reduce((s, v) => s + v, 0) / values.length;
  if (agg === 'min') return Math.min(...values);
  if (agg === 'max') return Math.max(...values);
  return values.reduce((s, v) => s + v, 0);
}

// ---- points --------------------------------------------------------------------------------

const NUM = '[-+]?\\d{1,3}(?:\\.\\d+)?';
const PAIR = new RegExp(`^\\(?\\s*(${NUM})\\s*[,; ]\\s*(${NUM})\\s*\\)?$`);
const WKT = new RegExp(`^point\\s*\\(\\s*(${NUM})\\s+(${NUM})\\s*\\)$`, 'i');

/** "36.85, -76.29" (latitude first) or "POINT(-76.29 36.85)" (WKT, longitude first) as a position. */
export function parseLatLon(v: unknown): { lat: number; lon: number } | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const w = WKT.exec(s);
  const p = w ? { lat: Number(w[2]), lon: Number(w[1]) } : (() => {
    const m = PAIR.exec(s);
    return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
  })();
  if (!p || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return null;
  return p;
}

/** True when most values (four in five, blanks aside) are latitude, longitude pairs. */
export function looksLikeLatLon(values: readonly unknown[]): boolean {
  const filled = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (!filled.length) return false;
  return filled.filter((v) => parseLatLon(v)).length >= 0.8 * filled.length;
}

/** A latitude or longitude written as a number or numeric text; null otherwise. */
export function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

// ---- region files ----------------------------------------------------------------------------

export interface RegionFile {
  geojson: FeatureCollection;
  regions: string[];
  /** True when every coordinate is a longitude and latitude, so points can be placed on the map. */
  lonLat: boolean;
  /** Things worth telling the analyst: regions without a name, shapes left out. */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NAME_KEYS = ['name', 'NAME', 'Name', 'region', 'REGION', 'Region', 'label', 'LABEL', 'Label', 'title', 'id', 'ID', 'code', 'CODE'];

/** TopoJSON to GeoJSON features (arcs stitched, quantized positions decoded). */
function topoFeatures(topo: Record<string, unknown>): unknown[] {
  const arcsRaw = Array.isArray(topo.arcs) ? (topo.arcs as unknown[]) : [];
  const t = isObj(topo.transform) ? topo.transform : null;
  const scale = t && Array.isArray(t.scale) ? (t.scale as number[]) : null;
  const translate = t && Array.isArray(t.translate) ? (t.translate as number[]) : [0, 0];
  const decode = (p: unknown): number[] => {
    if (!Array.isArray(p)) throw new Error('A position in the TopoJSON file is not a pair of numbers.');
    return scale ? [(p[0] as number) * scale[0]! + translate[0]!, (p[1] as number) * scale[1]! + translate[1]!] : [p[0] as number, p[1] as number];
  };
  const arcs = arcsRaw.map((arc) => {
    if (!Array.isArray(arc)) throw new Error('An arc in the TopoJSON file is not a list of positions.');
    if (!scale) return arc.map((p) => decode(p));
    let x = 0;
    let y = 0;
    return arc.map((p) => {
      if (!Array.isArray(p)) throw new Error('A position in the TopoJSON file is not a pair of numbers.');
      x += p[0] as number;
      y += p[1] as number;
      return decode([x, y]);
    });
  });
  const ring = (ids: unknown): number[][] => {
    if (!Array.isArray(ids)) throw new Error('A ring in the TopoJSON file is not a list of arcs.');
    const out: number[][] = [];
    for (const i of ids) {
      if (typeof i !== 'number' || !Number.isInteger(i)) throw new Error('A ring in the TopoJSON file names an arc that is not a number.');
      const arc = arcs[i < 0 ? ~i : i];
      if (!arc) throw new Error('A ring in the TopoJSON file names an arc it does not have.');
      const pts = i < 0 ? [...arc].reverse() : arc;
      out.push(...(out.length ? pts.slice(1) : pts));
    }
    return out;
  };
  const geometry = (g: Record<string, unknown>): unknown => {
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: (g.arcs as unknown[]).map(ring) };
    if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: (g.arcs as unknown[]).map((poly) => (poly as unknown[]).map(ring)) };
    return { type: g.type };
  };
  const out: unknown[] = [];
  const objects = isObj(topo.objects) ? Object.values(topo.objects) : [];
  const add = (g: unknown) => {
    if (!isObj(g)) return;
    if (g.type === 'GeometryCollection') {
      for (const one of Array.isArray(g.geometries) ? g.geometries : []) add(one);
      return;
    }
    out.push({ type: 'Feature', id: g.id, properties: isObj(g.properties) ? g.properties : {}, geometry: Array.isArray(g.arcs) ? geometry(g) : { type: g.type } });
  };
  for (const o of objects) add(o);
  return out;
}

/**
 * Reads a GeoJSON or TopoJSON file the analyst picked: keeps each polygon region's outline (to five
 * decimals) and name, and nothing else. Throws an Error that says what is wrong.
 */
export function parseRegionFile(text: string): RegionFile {
  if (new TextEncoder().encode(text).length > MAP_LIMITS.fileBytes) throw new Error(`The file is over ${MAP_LIMITS.fileBytes / 1048576} MB. Simplify the shapes or split the file.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error('The file is not JSON. Pick a GeoJSON (.geojson, .json) or TopoJSON file.');
  }
  if (!isObj(raw)) throw new Error('The file is not a GeoJSON or TopoJSON object.');
  const list: unknown[] = raw.type === 'Topology' ? topoFeatures(raw) : raw.type === 'FeatureCollection' && Array.isArray(raw.features) ? raw.features : raw.type === 'Feature' ? [raw] : [];
  if (raw.type !== 'Topology' && raw.type !== 'FeatureCollection' && raw.type !== 'Feature') throw new Error('The file is not a GeoJSON FeatureCollection or a TopoJSON topology.');
  const notes: string[] = [];
  let points = 0;
  let lonLat = true;
  let skipped = 0;
  let unnamed = 0;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const position = (p: unknown): number[] => {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error('A shape in the file has a position that is not a pair of numbers.');
    if (++points > MAP_LIMITS.points) throw new Error(`The shapes have more than ${MAP_LIMITS.points.toLocaleString('en-US')} points. Simplify them first.`);
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) lonLat = false;
    return [round(p[0]), round(p[1])];
  };
  const ringOf = (r: unknown): number[][] => {
    if (!Array.isArray(r) || r.length < 4) throw new Error('A shape in the file has a ring with fewer than four positions.');
    return r.map(position);
  };
  const polygon = (rings: unknown): number[][][] => {
    if (!Array.isArray(rings) || !rings.length) throw new Error('A polygon in the file has no rings.');
    return rings.map(ringOf);
  };
  const features: Feature[] = [];
  const keyFor = (props: Record<string, unknown>) => NAME_KEYS.find((k) => (typeof props[k] === 'string' && (props[k] as string).trim() !== '') || typeof props[k] === 'number');
  for (const f of list) {
    if (!isObj(f) || !isObj(f.geometry)) {
      skipped++;
      continue;
    }
    const g = f.geometry;
    if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
      skipped++;
      continue;
    }
    const props = isObj(f.properties) ? f.properties : {};
    const key = keyFor(props);
    const rawName = key ? props[key] : typeof f.id === 'string' || typeof f.id === 'number' ? f.id : null;
    const name = rawName === null || rawName === undefined ? '' : String(rawName).replace(/[\x00-\x1f\x7f-\x9f]|\p{Zl}|\p{Zp}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAP_LIMITS.nameChars);
    if (!name) {
      unnamed++;
      continue;
    }
    if (features.length >= MAP_LIMITS.regions) throw new Error(`The file has more than ${MAP_LIMITS.regions} regions.`);
    const geometry: Feature['geometry'] = g.type === 'Polygon' ? { type: 'Polygon', coordinates: polygon(g.coordinates) } : { type: 'MultiPolygon', coordinates: (Array.isArray(g.coordinates) ? g.coordinates : []).map(polygon) };
    if (geometry.type === 'MultiPolygon' && !geometry.coordinates.length) throw new Error(`The region "${name}" has no shapes.`);
    features.push({ type: 'Feature', properties: { name }, geometry });
  }
  if (!features.length) throw new Error('The file has no named regions: each region needs a polygon and a name (a "name" property, for example).');
  if (skipped) notes.push(`${skipped} shape${skipped === 1 ? ' was' : 's were'} not a region (points or lines) and ${skipped === 1 ? 'was' : 'were'} left out.`);
  if (unnamed) notes.push(`${unnamed} region${unnamed === 1 ? ' has' : 's have'} no name and ${unnamed === 1 ? 'was' : 'were'} left out.`);
  if (!lonLat) notes.push('The positions are not longitude and latitude, so points cannot be placed on this map.');
  const geojson: FeatureCollection = { type: 'FeatureCollection', features };
  if (new TextEncoder().encode(JSON.stringify(geojson)).length > MAP_LIMITS.bytes) throw new Error(`The regions come to more than ${MAP_LIMITS.bytes / 1048576} MB even cut down. Simplify the shapes or split the file.`);
  return { geojson, regions: [...new Set(features.map((x) => x.properties.name))], lonLat, notes };
}

/** "Fleet 1 = Northeast" lines as an alias list (alias to region). Blank lines and lines without "=" are skipped. */
export function parseAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const alias = line.slice(0, at).trim().slice(0, MAP_LIMITS.nameChars);
    const region = line.slice(at + 1).trim().slice(0, MAP_LIMITS.nameChars);
    if (!alias || !region || alias === '__proto__' || Object.keys(out).length >= MAP_LIMITS.aliases) continue;
    out[alias] = region;
  }
  return out;
}

/** The alias list as the lines the analyst typed. */
export const aliasLines = (aliases: Record<string, string> | undefined): string =>
  Object.entries(aliases ?? {})
    .map(([a, r]) => `${a} = ${r}`)
    .join('\n');

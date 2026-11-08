// Settings > Maps: the team's own region maps (fleet regions, ports, bases) from a GeoJSON or
// TopoJSON file. The file is read and cut down here (src/core/geo.ts), then kept in the Semaphore
// folder (server/Routes.ps1, SEMAPHORE_HOME\maps), so a map flag on any page can draw it.

import { useCallback, useEffect, useState } from 'react';
import { Map as MapIcon, Trash2, Upload } from 'lucide-react';
import { aliasLines, MAP_LIMITS, parseAliases, parseRegionFile, type RegionFile } from '../../../src/core/geo.ts';
import { describeError } from '../lib/api.ts';
import { confirm } from '../lib/confirm.ts';
import { setMapEntry } from '../lib/map-registry.ts';
import { deleteRegionMap, listRegionMaps, type RegionMapInfo, saveRegionMap } from '../lib/maps.ts';

const btn = 'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-sm hover:border-accent disabled:opacity-40';
const input = 'min-h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm focus:border-accent focus:outline-none';

function AliasEditor({ map, onSaved }: { map: RegionMapInfo; onSaved: (m: RegionMapInfo) => void }) {
  const [text, setText] = useState(aliasLines(map.aliases));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-2 space-y-1">
      <textarea aria-label={`Other names for the regions of ${map.name}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Fleet 1 = Northeast" className={`${input} font-mono text-[12px]`} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={btn}
          onClick={() =>
            saveRegionMap({ id: map.id, name: map.name, aliases: parseAliases(text) }).then(
              (m) => {
                setMapEntry(m.id, null);
                setError(null);
                onSaved(m);
              },
              (e) => setError(describeError(e)),
            )
          }
        >
          Save other names
        </button>
        {error && <span className="text-[12px] text-bad">{error}</span>}
      </div>
    </div>
  );
}

export function MapsCard() {
  const [maps, setMaps] = useState<RegionMapInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ file: string; parsed: RegionFile } | null>(null);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const reload = useCallback(() => listRegionMaps().then(setMaps, (e) => setError(describeError(e))), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const pick = async (file: File | undefined) => {
    setError(null);
    setSaved(null);
    setPicked(null);
    if (!file) return;
    if (file.size > MAP_LIMITS.fileBytes) {
      setError(`${file.name} is over ${MAP_LIMITS.fileBytes / 1048576} MB. Simplify the shapes or split the file.`);
      return;
    }
    try {
      const parsed = parseRegionFile(await file.text());
      setPicked({ file: file.name, parsed });
      setName((n) => n || file.name.replace(/\.(geo|topo)?json$/i, '').replace(/[_-]+/g, ' ').slice(0, MAP_LIMITS.nameChars));
    } catch (e) {
      setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const add = async () => {
    if (!picked || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const m = await saveRegionMap({ name: name.trim(), geojson: JSON.stringify(picked.parsed.geojson), aliases: parseAliases(aliases), lonLat: picked.parsed.lonLat });
      setMapEntry(m.id, null);
      setSaved(`Added ${m.name}: ${m.regions} regions. Pick it in a map flag's Look.`);
      setPicked(null);
      setName('');
      setAliases('');
      await reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: RegionMapInfo) => {
    if (!(await confirm({ title: `Remove the ${m.name} map?`, body: 'It moves to the maps .trash folder in the Semaphore folder. Map flags that use it are drawn as bars until you add it again.', confirmLabel: 'Remove', destructive: true }))) return;
    try {
      await deleteRegionMap(m.id);
      setMapEntry(m.id, null);
      await reload();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const regions = picked?.parsed.regions ?? [];
  return (
    <section aria-label="Region maps" className="rounded-lg border border-line bg-panel">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Region maps</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">
          Your own regions for map flags: fleet regions, ports, bases. Add a GeoJSON or TopoJSON file; each region needs a name, which is matched to the values of the flag's field. US states are built in. Everything stays in the Semaphore folder on this computer.
        </p>
      </header>
      <div className="space-y-4 p-5">
        {maps === null ? (
          <p className="text-sm text-ink-3">Reading the maps…</p>
        ) : maps.length === 0 ? (
          <p className="text-sm text-ink-3">No region maps yet.</p>
        ) : (
          <ul aria-label="Saved region maps" className="divide-y divide-line">
            {maps.map((m) => (
              <li key={m.id} className="py-2">
                <div className="flex items-center gap-2">
                  <MapIcon size={15} aria-hidden="true" className="text-brass" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{m.name}</span>
                    <span className="block text-[12px] text-ink-2">
                      {m.regions} regions{Object.keys(m.aliases).length ? `, ${Object.keys(m.aliases).length} other names` : ''}
                      {m.by ? ` · ${m.by}` : ''}
                      {m.lonLat ? '' : ' · not longitude and latitude, so no points'}
                    </span>
                  </span>
                  <button type="button" className={btn} aria-expanded={editing === m.id} onClick={() => setEditing((e) => (e === m.id ? null : m.id))}>
                    Other names
                  </button>
                  <button type="button" className={`${btn} hover:border-bad hover:text-bad`} aria-label={`Remove ${m.name}`} onClick={() => void remove(m)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {editing === m.id && <AliasEditor map={m} onSaved={() => void reload()} />}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 rounded-md border border-dashed border-line p-3">
          <label className={`${btn} cursor-pointer`}>
            <Upload size={14} aria-hidden="true" /> Choose a GeoJSON or TopoJSON file…
            <input type="file" accept=".geojson,.json,.topojson,application/geo+json,application/json" aria-label="Region map file" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
          {picked && (
            <div className="space-y-2" data-testid="map-preview">
              <p className="text-[12.5px] text-ink-2">
                {picked.file}: {regions.length} regions ({regions.slice(0, 8).join(', ')}
                {regions.length > 8 ? `, and ${regions.length - 8} more` : ''}).
              </p>
              {picked.parsed.notes.map((n) => (
                <p key={n} className="text-[12px] text-warn">
                  {n}
                </p>
              ))}
              <label className="block text-[12px] font-medium text-ink-2">
                Name
                <input value={name} maxLength={MAP_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} className={`${input} mt-1`} />
              </label>
              <label className="block text-[12px] font-medium text-ink-2">
                Other names for regions, one per line (optional)
                <textarea rows={3} value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="NE = Northeast" className={`${input} mt-1 font-mono text-[12px]`} />
              </label>
              <button type="button" className={btn} disabled={busy || !name.trim()} onClick={() => void add()}>
                Add the map
              </button>
            </div>
          )}
          {saved && (
            <p role="status" className="text-[12.5px] text-good">
              {saved}
            </p>
          )}
          {error && (
            <p role="alert" className="text-[12.5px] text-bad">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

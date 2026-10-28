// Semaphore's page: the hoist brief on top, the flag palette on the left, the hoist in the
// middle, the selected flag's inspector on the right. State lives here; the core does the
// thinking (src/core) and lib/data.ts fetches the numbers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Bot, Database, Download, FilePlus2, FolderOpen, MessagesSquare, Moon, Paintbrush, Power, Redo2, Sparkles, Sun, Undo2, Upload, Wand2, X } from 'lucide-react';
import exampleCatalog from '../../examples/fleet-maintenance/catalog.json';
import exampleHoist from '../../examples/fleet-maintenance/hoist.json';
import { type Catalog, checkCatalog, indexCatalog } from '../../src/core/catalog.ts';
import type { Cell, Selections } from '../../src/core/crossfilter.ts';
import { CsvError, readCsv } from '../../src/core/csv.ts';
import type { TableRows } from '../../src/core/engine.ts';
import { filterText } from '../../src/core/describe.ts';
import { emptyBehavior, type Flag, type FlagKind, GRID_COLS, type Hoist, type Layout, parseHoist } from '../../src/core/hoist.ts';
import { learnSynonym, type Suggestion } from '../../src/core/intelligence/annotate.ts';
import { applyFlagDraft, applyHoistDraft, draftFlag, draftHoist } from '../../src/core/intelligence/index.ts';
import { starterHoistLocally } from '../../src/core/intelligence/local-rules.ts';
import { DEFAULT_SIZE, findSlot, place } from '../../src/core/layout.ts';
import { proposeCatalog } from '../../src/core/profile.ts';
import { checkHealth, learnFromHoist, type QuestionItem, resolveQuestions } from '../../src/core/playbook.ts';
import { isStale, takeSnapshot } from '../../src/core/snapshot.ts';
import { fleetSampleRows } from '../../src/sample/fleet.ts';
import { api, captureSessionToken, endSession, listItems, loadItem, probeServer, profileTable, saveItem, type ServerInfo, startHeartbeat, type StoredItem } from './lib/api.ts';
import { type AiStatus, aiWanted, checkAi, draftingProvider, loadAiStatus, setAiWanted } from './lib/ai.ts';
import { canReach, clearResultCache, type DataContext, runAnywhere } from './lib/data.ts';
import { usePlaybook } from './lib/playbook.ts';
import { useHoistHistory } from './lib/history.ts';
import { allFiles, deleteFile, putFile, readLocal, writeLocal } from './lib/storage.ts';
import { AskAnswer, AskBox } from './components/Ask.tsx';
import { AskView } from './components/AskView.tsx';
import { PlaybookPanel } from './components/PlaybookPanel.tsx';
import { BriefEditor, BriefLegend } from './components/BriefEditor.tsx';
import { Canvas } from './components/Canvas.tsx';
import { DataPanel } from './components/DataPanel.tsx';
import { formatDim } from './components/FlagView.tsx';
import { Inspector } from './components/Inspector.tsx';
import { Palette } from './components/Palette.tsx';

const FILES_SOURCE = 'files';
const EXAMPLE_SOURCES = new Set(['maint', 'parts']);
const K = { hoist: 'semaphore.hoist', catalog: 'semaphore.catalog', theme: 'semaphore.theme', skin: 'semaphore.skin', auto: 'semaphore.autoKind', view: 'semaphore.view' };
/** Built-in skins (web/src/styles.css). A deployment may name another one defined in config\skin.css. */
const SKINS = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'classic', label: 'Classic' },
];

type View = 'builder' | 'ask' | 'refresh';

function initialView(): View | null {
  try {
    const v = new URL(window.location.href).searchParams.get('view');
    if (v === 'ask' || v === 'builder' || v === 'refresh') return v;
  } catch {
    /* no URL to read */
  }
  return readLocal<'builder' | 'ask'>(K.view);
}

captureSessionToken();

function newId(prefix = 'f'): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function blankHoist(): Hoist {
  return { version: 1, id: newId('h'), title: 'Untitled hoist', brief: '', grid: { cols: GRID_COLS }, filters: [], flags: [], updated: new Date().toISOString() };
}

function initialCatalog(): Catalog {
  const saved = readLocal<Catalog>(K.catalog);
  return saved && saved.version === 1 && checkCatalog(saved).length === 0 ? saved : (exampleCatalog as Catalog);
}

function initialHoist(catalog: Catalog): Hoist {
  const index = indexCatalog(catalog);
  const saved = readLocal<unknown>(K.hoist);
  const parsed = saved ? parseHoist(saved, index).hoist : null;
  if (parsed) return parsed;
  return parseHoist(exampleHoist, index).hoist ?? blankHoist();
}

export function App() {
  const [catalog, setCatalogState] = useState<Catalog>(initialCatalog);
  const index = useMemo(() => indexCatalog(catalog), [catalog]);
  const history = useHoistHistory(useMemo(() => initialHoist(catalog), []));
  const { hoist, change } = history;
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [serverChecked, setServerChecked] = useState(false);
  const [view, setViewState] = useState<View | null>(initialView);
  const [refreshLog, setRefreshLog] = useState<string[]>([]);
  const [lastRefresh, setLastRefresh] = useState<{ at: string; computer: string; refreshed: number; failed: unknown[] } | null>(null);
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const [serverLost, setServerLost] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [useAi, setUseAi] = useState(aiWanted);
  const [files, setFiles] = useState<TableRows>({});
  const [dataVersion, setDataVersion] = useState(1);
  const [selections, setSelections] = useState<Selections>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [openList, setOpenList] = useState<StoredItem[] | null>(null);
  const [profileNotes, setProfileNotes] = useState<string[]>([]);
  const [asked, setAsked] = useState<Flag | null>(null);
  const [autoKinds, setAutoKinds] = useState<Record<string, boolean>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readLocal<'light' | 'dark'>(K.theme) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const askRef = useRef<HTMLInputElement>(null);
  const today = useMemo(() => new Date(), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeLocal(K.theme, theme);
  }, [theme]);

  // Skin (docs/SKINS.md): settings.json "skin" is the deployment's choice and wins; otherwise the
  // analyst's choice in this browser; otherwise Fleet UI.
  const [skin, setSkin] = useState<string>(() => readLocal<string>(K.skin) ?? 'fleet');
  const skinFixed = !!server?.skin;
  useEffect(() => {
    document.documentElement.dataset.skin = server?.skin || skin;
    if (!server?.skin) writeLocal(K.skin, skin);
  }, [skin, server]);

  const notify = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 6000);
  }, []);

  // The server, when there is one: its sources, and the heartbeat that keeps it alive while
  // this tab is open.
  useEffect(() => {
    let stop: (() => void) | null = null;
    probeServer().then((info) => {
      setServer(info);
      setServerChecked(true);
      if (info?.view === 'ask' || info?.view === 'builder') setViewState((v) => v ?? (info.view as 'ask' | 'builder'));
      if (info) {
        stop = startHeartbeat(() => setServerLost(true));
        loadAiStatus().then(setAi);
      }
    });
    return () => stop?.();
  }, []);

  // CSV files kept in this browser come back on reload.
  useEffect(() => {
    allFiles().then((stored) => {
      const tables: TableRows = {};
      for (const f of stored) {
        try {
          const t = readCsv(f.name, f.text);
          tables[t.name] = t.rows;
        } catch {
          /* a file that no longer parses is skipped; it can be removed from the data panel */
        }
      }
      if (Object.keys(tables).length) {
        setFiles(tables);
        setDataVersion((v) => v + 1);
      }
    });
  }, []);

  const sample = useMemo(() => fleetSampleRows(today), [today]);
  const ctx: DataContext = useMemo(() => {
    const local: TableRows = {};
    const localSources = new Set<string>();
    if (catalog.sources.some((s) => EXAMPLE_SOURCES.has(s.id))) {
      Object.assign(local, sample);
      for (const id of EXAMPLE_SOURCES) localSources.add(id);
    }
    Object.assign(local, files);
    localSources.add(FILES_SOURCE);
    return { index, local, localSources, server, today, version: dataVersion };
  }, [index, sample, files, server, today, dataVersion, catalog.sources]);

  // Save: always to this browser; to the server's folder too when there is one.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    writeLocal(K.hoist, hoist);
    if (!server) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveItem('hoists', hoist.id, hoist).catch((e: Error) => notify(`Could not save to the server: ${e.message}`));
    }, 1200);
  }, [hoist, server, notify]);

  const setCatalog = useCallback(
    (c: Catalog) => {
      const problems = checkCatalog(c);
      if (problems.length) {
        notify(problems[0]!);
        return;
      }
      setCatalogState(c);
      writeLocal(K.catalog, c);
      if (server) saveItem('catalogs', 'default', c).catch(() => undefined);
    },
    [server, notify],
  );

  // A server keeps the catalog for every browser on this computer; prefer its copy.
  useEffect(() => {
    if (!server) return;
    loadItem<Catalog>('catalogs', 'default').then(
      (c) => {
        if (c && c.version === 1 && checkCatalog(c).length === 0) {
          setCatalogState(c);
          writeLocal(K.catalog, c);
        }
      },
      () => saveItem('catalogs', 'default', catalog).catch(() => undefined),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const selected = hoist.flags.find((f) => f.id === selectedId) ?? null;
  const updateFlag = useCallback((id: string, patch: Partial<Flag>, group?: string) => change((h) => ({ ...h, flags: h.flags.map((f) => (f.id === id ? { ...f, ...patch } : f)) }), group), [change]);

  const addFlag = useCallback(
    (kind: FlagKind | 'auto', at?: { x: number; y: number }) => {
      const real: FlagKind = kind === 'auto' ? 'bar' : kind;
      const size = kind === 'auto' ? { w: 4, h: 4 } : DEFAULT_SIZE[real];
      const id = newId();
      change((h) => {
        const items = h.flags.map((f) => ({ id: f.id, layout: f.layout }));
        const flag: Flag = { id, kind: real, title: '', brief: '', layout: { x: 0, y: 0, ...size }, binding: null, behavior: emptyBehavior(), status: kind === 'text' ? 'ready' : 'empty', notes: [] };
        if (at) {
          const placed = place([...items, { id, layout: { ...at, ...size } }], id, { ...at, ...size }, h.grid.cols);
          const map = new Map(placed.map((p) => [p.id, p.layout]));
          return { ...h, flags: [...h.flags, flag].map((f) => ({ ...f, layout: map.get(f.id) ?? f.layout })) };
        }
        return { ...h, flags: [...h.flags, { ...flag, layout: findSlot(items, size.w, size.h, h.grid.cols) }] };
      });
      setAutoKinds((a) => ({ ...a, [id]: kind === 'auto' }));
      setSelectedId(id);
    },
    [change],
  );

  const removeFlag = useCallback(
    (id: string) => {
      change((h) => ({ ...h, flags: h.flags.filter((f) => f.id !== id) }));
      setSelectedId(null);
    },
    [change],
  );

  const duplicateFlag = useCallback(
    (id: string) => {
      const id2 = newId();
      change((h) => {
        const f = h.flags.find((x) => x.id === id);
        if (!f) return h;
        const layout = findSlot(h.flags, f.layout.w, f.layout.h, h.grid.cols);
        return { ...h, flags: [...h.flags, { ...structuredClone(f), id: id2, layout }] };
      });
      setSelectedId(id2);
    },
    [change],
  );

  const draftSelected = useCallback(async () => {
    if (!selected) return;
    const provider = draftingProvider(index, ai, useAi);
    setBusy(provider.local ? 'Drafting…' : `Drafting with ${provider.label}…`);
    try {
      const outcome = await draftFlag(provider, hoist, selected, index, { auto: autoKinds[selected.id] ?? selected.status === 'empty' });
      const draft = provider.local || outcome.fallbackReason ? outcome.draft : { ...outcome.draft, notes: [`Drafted by ${provider.label}.`, ...outcome.draft.notes] };
      if (outcome.fallbackReason) notify(`${provider.label} could not draft this flag: ${outcome.fallbackReason} Local rules drafted it instead.`);
      const next = applyFlagDraft(selected, draft);
      // A fresh draft takes the drafted title; one the analyst typed is kept.
      if (!selected.binding || selected.title === '' || selected.title === titleOf(selected)) next.title = draft.title || selected.title;
      if (next.kind !== selected.kind && next.layout.w < DEFAULT_SIZE[next.kind].w) {
        next.layout = { ...next.layout, w: DEFAULT_SIZE[next.kind].w, h: Math.max(next.layout.h, DEFAULT_SIZE[next.kind].h) };
      }
      change((h) => {
        const flags = h.flags.map((f) => (f.id === selected.id ? next : f));
        const placed = new Map(place(flags, selected.id, next.layout, h.grid.cols).map((p) => [p.id, p.layout]));
        return { ...h, flags: flags.map((f) => ({ ...f, layout: placed.get(f.id) ?? f.layout })) };
      });
      if (!draft.binding && !outcome.fallbackReason) notify(draft.notes[draft.notes.length - 1] ?? 'Nothing in the brief matched the catalog.');
    } finally {
      setBusy(null);
    }
  }, [selected, index, hoist, autoKinds, change, notify, ai, useAi]);

  const draftPage = useCallback(
    async (mode: 'add' | 'replace' | 'starter') => {
      const provider = draftingProvider(index, ai, useAi);
      setBusy(mode === 'starter' || provider.local ? 'Drafting the page…' : `Drafting the page with ${provider.label}…`);
      try {
        const base = mode === 'add' ? hoist : { ...hoist, flags: [], filters: [] };
        const outcome = mode === 'starter' ? null : await draftHoist(provider, hoist.brief, index);
        const draft = outcome ? outcome.draft : starterHoistLocally(index);
        const next = applyHoistDraft({ ...base, title: base.title }, draft, () => newId());
        change(next);
        setSelections({});
        setSelectedId(null);
        if (outcome?.fallbackReason) notify(`${provider.label} could not draft the page: ${outcome.fallbackReason} Local rules drafted it instead.`);
        else if (draft.notes.length) notify(draft.notes[0]!);
      } finally {
        setBusy(null);
      }
    },
    [hoist, index, change, notify, ai, useAi],
  );

  // The header's AI switch. Turning Fairlead on checks it, so a missing Fairlead or a refused key
  // shows up now rather than on the next draft.
  const toggleAi = useCallback(() => {
    if (!ai?.configured) {
      loadAiStatus().then((s) => {
        if (s) setAi(s);
        notify((s ?? ai)?.configured ? 'Fairlead key found: AI drafting is on.' : ((s ?? ai)?.problem ?? (s ?? ai)?.setup ?? 'AI drafting needs the Semaphore server.'));
      });
      return;
    }
    const on = !useAi;
    setUseAi(on);
    setAiWanted(on);
    if (!on) {
      notify('AI is off: local rules draft every flag.');
      return;
    }
    checkAi().then(
      (r) => notify(r.ok ? r.detail : `${r.detail} Drafts fall back to local rules until this is fixed.`),
      (e: Error) => notify(`Could not check Fairlead: ${e.message}`),
    );
  }, [ai, useAi, notify]);

  const onLearn = useCallback(
    (word: string, s: Suggestion) => {
      const next = learnSynonym(catalog, word, s);
      if (next && next !== catalog) {
        setCatalog(next);
        notify(`Learnt: "${word}" means ${s.label}.`);
      }
    },
    [catalog, setCatalog, notify],
  );

  const onSelectValue = useCallback((key: string, value: Cell, additive: boolean) => {
    setSelections((s) => {
      const current = s[key] ?? [];
      const has = current.some((v) => String(v) === String(value));
      const nextValues = has ? current.filter((v) => String(v) !== String(value)) : additive ? [...current, value] : [value];
      const next = { ...s, [key]: nextValues };
      if (nextValues.length === 0) delete next[key];
      return next;
    });
  }, []);

  const onLayout = useCallback(
    (layouts: Array<{ id: string; layout: Layout }>, group: string) => {
      const map = new Map(layouts.map((l) => [l.id, l.layout]));
      change((h) => ({ ...h, flags: h.flags.map((f) => ({ ...f, layout: map.get(f.id) ?? f.layout })) }), group);
    },
    [change],
  );

  const addCsv = useCallback(
    async (list: FileList) => {
      setBusy('Reading files…');
      let cat = catalog;
      const notes: string[] = [];
      const tables: TableRows = { ...files };
      for (const file of Array.from(list)) {
        try {
          const text = await file.text();
          const t = readCsv(file.name, text);
          tables[t.name] = t.rows;
          await putFile({ name: file.name, text, added: new Date().toISOString() });
          // Replace the measures and fields of a file loaded before under the same name.
          const without: Catalog = {
            ...cat,
            fields: cat.fields.filter((f) => !(f.source === FILES_SOURCE && f.table === t.name)),
            metrics: cat.metrics.filter((m) => !(m.source === FILES_SOURCE && (m.table === t.name || cat.fields.find((f) => f.key === m.field)?.table === t.name))),
          };
          const proposal = proposeCatalog({ source: { id: FILES_SOURCE, label: 'Files in this browser', kind: 'csv', dialect: 'ansi' }, tables: [t.profile] }, without);
          cat = proposal.catalog;
          notes.push(`${file.name}: ${t.rows.length.toLocaleString('en-US')} rows, ${t.columns.length} columns.`, ...t.notes, ...proposal.notes);
        } catch (e) {
          notes.push(`${file.name}: ${e instanceof CsvError ? e.message : 'could not be read.'}`);
        }
      }
      setFiles(tables);
      setDataVersion((v) => v + 1);
      clearResultCache();
      setCatalog(cat);
      setProfileNotes(notes);
      setBusy(null);
      notify('Files added. Check the proposed measures and fields, then describe a flag or draft a starter page.');
    },
    [catalog, files, setCatalog, notify],
  );

  const profile = useCallback(
    async (source: string, table: string) => {
      setBusy(`Profiling ${table}…`);
      try {
        const p = await profileTable(source, table);
        const s = server?.sources.find((x) => x.id === source);
        const kind = (s?.kind ?? 'other') as Catalog['sources'][number]['kind'];
        const dialect = kind === 'postgres' ? 'postgres' : kind === 'oracle' ? 'oracle' : kind === 'access' ? 'access' : kind === 'azure-sql' ? 'tsql' : 'ansi';
        const proposal = proposeCatalog({ source: { id: source, label: s?.label ?? source, kind, dialect }, tables: [{ name: p.table, rows: p.rows, columns: p.columns }] }, catalog);
        setCatalog(proposal.catalog);
        setProfileNotes(proposal.notes);
        notify(`${table} added to the catalog.`);
      } catch (e) {
        notify(`Profiling failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [server, catalog, setCatalog, notify],
  );

  const removeSource = useCallback(
    (id: string) => {
      if (id === FILES_SOURCE) {
        for (const name of Object.keys(files)) void deleteFile(name);
        allFiles().then((all) => all.forEach((f) => deleteFile(f.name)));
        setFiles({});
        setDataVersion((v) => v + 1);
      }
      const fieldKeys = new Set(catalog.fields.filter((f) => f.source === id).map((f) => f.key));
      setCatalog({ ...catalog, sources: catalog.sources.filter((s) => s.id !== id), fields: catalog.fields.filter((f) => f.source !== id), metrics: catalog.metrics.filter((m) => m.source !== id && !(m.field && fieldKeys.has(m.field))) });
    },
    [catalog, files, setCatalog],
  );

  const loadExample = useCallback(() => {
    const ex = exampleCatalog as Catalog;
    setCatalog({ version: 1, sources: [...catalog.sources.filter((s) => !EXAMPLE_SOURCES.has(s.id)), ...ex.sources], fields: [...catalog.fields.filter((f) => !EXAMPLE_SOURCES.has(f.source)), ...ex.fields], metrics: [...catalog.metrics.filter((m) => !EXAMPLE_SOURCES.has(m.source)), ...ex.metrics] });
    const h = parseHoist(exampleHoist, indexCatalog(ex)).hoist;
    if (h) history.replace(h);
    setSelections({});
  }, [catalog, setCatalog, history]);

  const exportHoist = () => {
    const blob = new Blob([JSON.stringify(hoist, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${hoist.id}.hoist.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importHoist = async (file: File) => {
    try {
      const { hoist: h, warnings } = parseHoist(JSON.parse(await file.text()), index);
      if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
      history.replace(h);
      setSelections({});
      if (warnings.length) notify(warnings.slice(0, 2).join(' '));
    } catch (e) {
      notify(`Could not open ${file.name}: ${(e as Error).message}`);
    }
  };

  const openFromServer = async (id: string) => {
    try {
      const raw = await loadItem<unknown>('hoists', id);
      const { hoist: h, warnings } = parseHoist(raw, index);
      if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
      history.replace(h);
      setSelections({});
      setOpenList(null);
      if (warnings.length) notify(warnings.slice(0, 2).join(' '));
    } catch (e) {
      notify(`Could not open it: ${(e as Error).message}`);
    }
  };

  // ---- The playbook: learn from accepted flags, keep it healthy, keep snapshots fresh --------
  const playbook = usePlaybook(server, serverChecked);
  const user = server?.user || 'analyst';
  const currentView: View = view ?? 'builder';
  const setView = useCallback((v: 'builder' | 'ask') => {
    setViewState(v);
    writeLocal(K.view, v);
  }, []);

  useEffect(() => {
    if (!playbook.loaded || currentView !== 'builder') return;
    const timer = window.setTimeout(() => {
      const learnt = learnFromHoist(playbook.entries, hoist, index, user);
      if (!learnt.length) return;
      playbook.saveEntries(learnt).then(
        () => {
          const fresh = learnt.filter((e) => e.revisions === 0 && !playbook.entries.some((x) => x.id === e.id));
          if (fresh.length) notify(`Leadership can now ask for "${fresh[0]!.title}"${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}.`);
          const all = [...playbook.entries.filter((e) => !learnt.some((l) => l.id === e.id)), ...learnt];
          for (const q of resolveQuestions(playbook.questions, all)) void playbook.saveQuestion(q);
        },
        (e: Error) => notify(`Could not save to the playbook: ${e.message}`),
      );
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoist, playbook.loaded, currentView]);

  const checkedHealth = useRef(false);
  useEffect(() => {
    if (!playbook.loaded || checkedHealth.current || currentView !== 'builder') return;
    checkedHealth.current = true;
    const changed = checkHealth(playbook.entries, index);
    if (changed.length) void playbook.saveEntries(changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbook.loaded, currentView]);

  // Whoever can reach a source refreshes its stale snapshots, one at a time, in the background.
  const refreshing = useRef(false);
  useEffect(() => {
    if (!playbook.loaded || refreshing.current || currentView === 'refresh') return;
    const due = playbook.entries.filter((e) => e.status !== 'retired' && canReach(e.source, ctx) && isStale(playbook.snapshots.find((s) => s.entryId === e.id), e));
    if (!due.length) return;
    refreshing.current = true;
    (async () => {
      for (const e of due) {
        try {
          const snap = await takeSnapshot(e, index, (plan) => runAnywhere(plan, ctx));
          if (snap) await playbook.saveSnapshot(snap);
        } catch {
          /* the source could not be read now; the old snapshot stays, with its date */
        }
      }
    })().finally(() => {
      refreshing.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbook.loaded, playbook.entries, ctx]);

  // The refresher (Launch-Semaphore.bat --refresh, in a headless browser): refresh every snapshot
  // this computer can reach, report to the server, and end the session.
  const refreshRun = useRef(false);
  useEffect(() => {
    if (currentView !== 'refresh' || !playbook.loaded || refreshRun.current) return;
    refreshRun.current = true;
    const say = (line: string) => setRefreshLog((l) => [...l, line]);
    (async () => {
      let refreshed = 0;
      let skipped = 0;
      const failed: Array<{ id: string; title: string; error: string }> = [];
      for (const e of playbook.entries.filter((x) => x.status !== 'retired')) {
        if (!canReach(e.source, ctx)) {
          skipped++;
          say(`Skipped ${e.title}: its source is not set up on this computer.`);
          continue;
        }
        try {
          const snap = await takeSnapshot(e, index, (plan) => runAnywhere(plan, ctx));
          if (!snap) throw new Error('It no longer plans against the catalog.');
          await playbook.saveSnapshot(snap);
          refreshed++;
          say(`Refreshed ${e.title}.`);
        } catch (err) {
          failed.push({ id: e.id, title: e.title, error: (err as Error).message.slice(0, 300) });
          say(`Failed ${e.title}: ${(err as Error).message}`);
        }
      }
      say(`Done: ${refreshed} refreshed, ${skipped} skipped, ${failed.length} failed.`);
      if (server) {
        await api('/api/refresh-report', { json: { refreshed, skipped, failed } }).catch(() => undefined);
        await endSession().catch(() => undefined);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, playbook.loaded]);

  useEffect(() => {
    if (!server || currentView !== 'ask') return;
    api<{ at: string; computer: string; refreshed: number; failed: unknown[] }>('/api/refresh-report').then(setLastRefresh, () => setLastRefresh(null));
  }, [server, currentView]);

  const answerQuestionItem = useCallback(
    (q: QuestionItem) => {
      setPlaybookOpen(false);
      const id = newId();
      change((h) => {
        const layout = findSlot(h.flags, 4, 4, h.grid.cols);
        return { ...h, flags: [...h.flags, { id, kind: 'bar', title: '', brief: q.title, layout, binding: null, behavior: emptyBehavior(), status: 'empty', notes: [`Asked by ${q.askedBy}. Draft it, check it, and accept it to answer them.`] }] };
      });
      setAutoKinds((a) => ({ ...a, [id]: true }));
      setSelectedId(id);
    },
    [change],
  );

  // Keyboard: undo/redo, delete, arrows to nudge, Escape to deselect, / to ask.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (currentView !== 'builder') return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        history.redo();
        return;
      }
      if (typing) return;
      if (e.key === '/') {
        e.preventDefault();
        askRef.current?.focus();
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setAsked(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        removeFlag(selectedId);
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const l = selected.layout;
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
        const target = e.shiftKey ? { ...l, w: Math.max(1, l.w + d[0]!), h: Math.max(1, l.h + d[1]!) } : { ...l, x: l.x + d[0]!, y: Math.max(0, l.y + d[1]!) };
        onLayout(place(hoist.flags, selected.id, target, hoist.grid.cols), `keys-${selected.id}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, selectedId, selected, removeFlag, onLayout, hoist, currentView]);

  const selectionChips = Object.entries(selections).flatMap(([key, values]) => {
    const [field, grain] = key.split('@');
    const label = index.field(field!)?.label ?? field;
    return values.map((v) => ({ key, value: v, text: `${label}: ${formatDim(v, grain as never)}` }));
  });
  const examples = useMemo(() => exampleBriefs(catalog), [catalog]);
  const themeKey = `${theme}:${server?.skin || skin}`;
  const waiting = playbook.questions.filter((q) => q.status === 'open').length + playbook.entries.filter((e) => e.status === 'needs-review').length;

  if (currentView === 'refresh') {
    return (
      <main className="mx-auto max-w-2xl p-8 font-mono text-xs">
        <h1 className="mb-3 font-sans text-base font-semibold">Semaphore: refreshing snapshots</h1>
        <ul>{refreshLog.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </main>
    );
  }

  if (currentView === 'ask') {
    return (
      <>
        <AskView index={index} ctx={ctx} playbook={playbook} user={user} theme={theme} themeKey={themeKey} lastRefresh={lastRefresh} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onBuilder={() => setView('builder')} />
        {serverLost && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
            <div role="alertdialog" className="max-w-sm rounded-xl border border-line bg-panel p-5 text-center shadow-xl">
              <h2 className="mb-1 text-base font-semibold">The session has ended</h2>
              <p className="text-sm text-ink-2">Semaphore has stopped. Start it again with Ask-Semaphore.bat.</p>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <img src="brand/mark.svg" alt="" className="h-7 w-7" />
        <div className="flex min-w-0 flex-col">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">Semaphore</span>
          <input
            value={hoist.title}
            onChange={(e) => change((h) => ({ ...h, title: e.target.value.slice(0, 200) }), 'title')}
            aria-label="Hoist title"
            className="-ml-1 min-w-0 rounded border border-transparent bg-transparent px-1 text-[15px] font-semibold leading-tight hover:border-line focus:border-accent focus:outline-none"
          />
        </div>
        <div className="ml-4 flex items-center gap-0.5">
          <IconButton label="Undo (Ctrl+Z)" onClick={history.undo} disabled={!history.canUndo}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton label="Redo (Ctrl+Y)" onClick={history.redo} disabled={!history.canRedo}>
            <Redo2 size={16} />
          </IconButton>
        </div>
        <div className="flex flex-1 justify-center">
          <AskBox index={index} onAsk={setAsked} inputRef={askRef} />
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="New hoist" onClick={() => { history.replace(blankHoist()); setSelections({}); setSelectedId(null); }}>
            <FilePlus2 size={16} />
          </IconButton>
          {server && (
            <IconButton label="Open a saved hoist" onClick={() => listItems('hoists').then(setOpenList, (e: Error) => notify(e.message))}>
              <FolderOpen size={16} />
            </IconButton>
          )}
          <label className="cursor-pointer rounded-md p-1.5 text-ink-2 hover:bg-panel-2" title="Import a hoist file">
            <Upload size={16} />
            <span className="sr-only">Import a hoist file</span>
            <input type="file" accept=".json,application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importHoist(e.target.files[0])} />
          </label>
          <IconButton label="Download this hoist" onClick={exportHoist}>
            <Download size={16} />
          </IconButton>
          <button type="button" onClick={() => setPlaybookOpen(true)} className="relative ml-1 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent" title="What leadership can ask for, their questions, and what needs review">
            <BookOpen size={14} className="text-brass" /> Playbook
            {waiting > 0 && <span className="absolute -right-1.5 -top-1.5 rounded-full bg-bad px-1.5 text-[10px] font-bold text-panel">{waiting}</span>}
          </button>
          <button type="button" onClick={() => setView('ask')} className="ml-1 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent" title="The leadership view: ask a question, get an answer">
            <MessagesSquare size={14} className="text-brass" /> Ask view
          </button>
          <button type="button" onClick={() => setDataOpen(true)} className="ml-1 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-sm hover:border-accent">
            <Database size={14} className="text-brass" /> Data
          </button>
          {server && ai && (
            <button
              type="button"
              onClick={toggleAi}
              aria-pressed={ai.configured && useAi}
              className={`ml-1 flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:border-accent ${ai.configured && useAi ? 'border-accent text-accent' : 'border-line text-ink-2'}`}
              title={ai.configured ? (useAi ? 'Drafts go through Fairlead. Click to draft with local rules only.' : 'Drafting with local rules only. Click to use Fairlead.') : (ai.problem ?? ai.setup)}
            >
              <Bot size={14} /> {ai.configured ? (useAi ? 'AI: Fairlead' : 'AI: off') : 'AI: local rules'}
            </button>
          )}
          {!skinFixed && (
            <IconButton
              label={`Skin: ${SKINS.find((s) => s.id === skin)?.label ?? skin}. Switch skin`}
              onClick={() => {
                const i = SKINS.findIndex((s) => s.id === skin);
                const next = SKINS[(i + 1) % SKINS.length]!;
                setSkin(next.id);
                notify(`Skin: ${next.label}.`);
              }}
            >
              <Paintbrush size={16} />
            </IconButton>
          )}
          <IconButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          {server && (
            <button
              type="button"
              onClick={() => endSession().then(() => setServerLost(true), () => setServerLost(true))}
              className="ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-ink-2 hover:bg-bad-soft hover:text-bad"
              title="Stop the Semaphore server and end this session"
            >
              <Power size={14} /> End session
            </button>
          )}
        </div>
      </header>

      <section aria-label="Page brief" className="border-b border-line bg-panel-2 px-4 py-3">
        <div className="mx-auto flex max-w-[1400px] items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <BriefEditor
              value={hoist.brief}
              onChange={(v) => change((h) => ({ ...h, brief: v }), 'hoist-brief')}
              index={index}
              rows={1}
              label="What is this page for?"
              placeholder="What is this page for? e.g. Maintenance picture for the last 12 months: cost and backlog at a glance; clicking a region filters the page."
              onSubmit={() => draftPage(hoist.flags.length ? 'add' : 'replace')}
              onLearn={onLearn}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <BriefLegend />
              {hoist.filters.length > 0 && (
                <span className="text-[11px] text-ink-2">
                  Page: {hoist.filters.map((f) => filterText(f, index)).join('; ')}
                  <button type="button" onClick={() => change((h) => ({ ...h, filters: [] }))} className="ml-1 text-ink-3 hover:text-bad" aria-label="Remove page filters" title="Remove page filters">
                    <X size={11} className="inline" />
                  </button>
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <button
              type="button"
              disabled={busy !== null || !hoist.brief.trim()}
              onClick={() => draftPage(hoist.flags.length ? 'add' : 'replace')}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-panel hover:opacity-90 disabled:opacity-40"
              title={hoist.flags.length ? 'Draft flags for this brief and add them below' : 'Draft a page from this brief'}
            >
              <Sparkles size={14} /> {hoist.flags.length ? 'Add drafted flags' : 'Draft page'}
            </button>
            {hoist.flags.length > 0 && hoist.brief.trim() && (
              <button type="button" disabled={busy !== null} onClick={() => draftPage('replace')} className="rounded-lg border border-line px-3 py-1 text-xs hover:border-accent">
                Redraft whole page
              </button>
            )}
          </div>
        </div>
      </section>

      {selectionChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-panel px-4 py-1.5 text-xs" aria-label="Page selections">
          <span className="text-ink-3">Selected:</span>
          {selectionChips.map((c) => (
            <button key={`${c.key}-${String(c.value)}`} type="button" onClick={() => onSelectValue(c.key, c.value, true)} className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 font-medium text-panel" title="Remove this selection">
              {c.text} <X size={11} />
            </button>
          ))}
          <button type="button" onClick={() => setSelections({})} className="ml-1 text-ink-3 underline hover:text-ink">
            Clear all
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Palette onAdd={(k) => addFlag(k)} />
        <main className="relative min-w-0 flex-1 overflow-auto">
          {asked && (
            <AskAnswer
              flag={asked}
              hoist={hoist}
              ctx={ctx}
              index={index}
              selections={selections}
              themeKey={themeKey}
              onSelectValue={onSelectValue}
              onClose={() => setAsked(null)}
              onPin={() => {
                change((h) => ({ ...h, flags: [...h.flags, { ...asked, layout: findSlot(h.flags, asked.layout.w, asked.layout.h, h.grid.cols) }] }));
                setSelectedId(asked.id);
                setAsked(null);
              }}
            />
          )}
          <div className="mx-auto max-w-[1400px] p-4">
            <Canvas
              hoist={hoist}
              ctx={ctx}
              index={index}
              selections={selections}
              selectedId={selectedId}
              themeKey={themeKey}
              onSelectFlag={setSelectedId}
              onSelectValue={onSelectValue}
              onAccept={(id) => updateFlag(id, { status: 'ready' })}
              onLayout={onLayout}
              onDropKind={addFlag}
              empty={<EmptyHoist examples={examples} onExample={(b) => change((h) => ({ ...h, brief: b }))} onStarter={() => draftPage('starter')} hasCatalog={catalog.metrics.length > 0} onData={() => setDataOpen(true)} />}
            />
          </div>
        </main>
        {selected && (
          <Inspector
            key={selected.id}
            hoist={hoist}
            flag={selected}
            ctx={ctx}
            index={index}
            selections={selections}
            busy={busy !== null}
            autoKind={autoKinds[selected.id] ?? selected.status === 'empty'}
            onAutoKind={(on) => setAutoKinds((a) => ({ ...a, [selected.id]: on }))}
            onChange={(patch, group) => updateFlag(selected.id, patch, group)}
            onDraft={draftSelected}
            onAccept={() => updateFlag(selected.id, { status: 'ready' })}
            onDuplicate={() => duplicateFlag(selected.id)}
            onDelete={() => removeFlag(selected.id)}
            onClose={() => setSelectedId(null)}
            onLearn={onLearn}
          />
        )}
      </div>

      {playbookOpen && <PlaybookPanel playbook={playbook} index={index} user={user} reviewer={server?.reviewer ?? ''} onClose={() => setPlaybookOpen(false)} onAnswer={answerQuestionItem} />}

      {dataOpen && (
        <DataPanel
          catalog={catalog}
          server={server}
          localSources={ctx.localSources}
          notes={profileNotes}
          busy={busy}
          onClose={() => setDataOpen(false)}
          onCatalog={setCatalog}
          onAddCsv={addCsv}
          onRemoveSource={removeSource}
          onProfile={profile}
          onLoadExample={loadExample}
        />
      )}

      {openList && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-ink/20 pt-24" onPointerDown={(e) => e.target === e.currentTarget && setOpenList(null)}>
          <div role="dialog" aria-label="Open a hoist" className="w-[440px] rounded-xl border border-line bg-panel p-4 shadow-xl">
            <h2 className="mb-2 text-base font-semibold">Open a hoist</h2>
            <ul className="scroll-thin max-h-80 space-y-1 overflow-y-auto">
              {openList.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => openFromServer(item.id)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-panel-2">
                    <span className="block text-sm font-medium">{item.title || item.id}</span>
                    <span className="text-[11px] text-ink-3">{item.updated ? new Date(item.updated).toLocaleString() : ''}</span>
                  </button>
                </li>
              ))}
              {openList.length === 0 && <li className="text-sm text-ink-3">Nothing saved yet.</li>}
            </ul>
          </div>
        </div>
      )}

      {serverLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm">
          <div role="alertdialog" className="max-w-sm rounded-xl border border-line bg-panel p-5 text-center shadow-xl">
            <h2 className="mb-1 text-base font-semibold">The session has ended</h2>
            <p className="text-sm text-ink-2">The Semaphore server has stopped. Your hoist is saved. Start Semaphore again with Launch-Semaphore.bat.</p>
          </div>
        </div>
      )}

      <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
        {(toast || busy) && <div className="rounded-lg bg-ink px-4 py-2 text-sm text-panel shadow-lg">{busy ?? toast}</div>}
      </div>
    </div>
  );
}

function titleOf(f: Flag): string {
  return f.title;
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="rounded-md p-1.5 text-ink-2 hover:bg-panel-2 disabled:opacity-30">
      {children}
    </button>
  );
}

/** Example briefs written from the catalog, so the first thing to try uses real names. */
function exampleBriefs(catalog: Catalog): string[] {
  const sum = catalog.metrics.find((m) => m.agg === 'sum') ?? catalog.metrics[0];
  const count = catalog.metrics.find((m) => m.agg === 'count');
  const short = catalog.fields.filter((f) => f.type === 'string' && (f.cardinality ?? 50) <= 30);
  const date = catalog.fields.find((f) => f.type === 'date');
  if (!sum) return [];
  const out: string[] = [];
  const a = short[0];
  const b = short[1];
  if (a) out.push(`${sum.label} and ${(count ?? sum).label.toLowerCase()} for the last 12 months. Clicking a ${a.label.toLowerCase()}${b ? ` or ${b.label.toLowerCase()}` : ''} filters the page.`);
  if (date) out.push(`Monthly ${sum.label.toLowerCase()} vs last year${a ? `, by ${a.label.toLowerCase()}` : ''}.`);
  if (a) out.push(`Which ${a.label.toLowerCase()} has the highest ${sum.label.toLowerCase()}? Turn red over the typical level.`);
  return out;
}

function EmptyHoist({ examples, onExample, onStarter, hasCatalog, onData }: { examples: string[]; onExample: (b: string) => void; onStarter: () => void; hasCatalog: boolean; onData: () => void }) {
  return (
    <div className="mx-auto mt-10 max-w-xl rounded-2xl border border-dashed border-line bg-panel/60 p-6 text-center">
      <img src="brand/mark.svg" alt="" className="mx-auto mb-2 h-12 w-12" />
      <h2 className="text-lg font-semibold">An empty hoist</h2>
      {hasCatalog ? (
        <>
          <p className="mt-1 text-sm text-ink-2">Say what the page is for in the brief above, drag flags in from the left, or let Semaphore start you off.</p>
          <button type="button" onClick={onStarter} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-panel hover:opacity-90">
            <Wand2 size={15} /> Draft a starter page from the catalog
          </button>
          {examples.length > 0 && (
            <div className="mt-5 text-left">
              <p className="mb-1.5 text-xs font-semibold text-ink-3">Or try a brief:</p>
              <ul className="space-y-1.5">
                {examples.map((e) => (
                  <li key={e}>
                    <button type="button" onClick={() => onExample(e)} className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent">
                      {e}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-2">There is no data yet. Add CSV files or a database, and Semaphore will propose a catalog.</p>
          <button type="button" onClick={onData} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-panel">
            <Database size={15} /> Add data
          </button>
        </>
      )}
    </div>
  );
}

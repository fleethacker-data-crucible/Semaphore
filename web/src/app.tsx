// Semaphore's page: the hoist brief on top, the flag palette on the left, the hoist in the
// middle, the selected flag's inspector on the right. State lives here; the core does the
// thinking (src/core) and lib/data.ts fetches the numbers.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Sparkles, Wand2, X } from 'lucide-react';
import exampleCatalog from '../../examples/fleet-maintenance/catalog.json';
import exampleHoist from '../../examples/fleet-maintenance/hoist.json';
import { type Catalog, checkCatalog, dialectForSource, indexCatalog, type Metric, pruneCatalog, type RdsEngine } from '../../src/core/catalog.ts';
import type { Cell, Selections } from '../../src/core/crossfilter.ts';
import { impactFor, impactLine } from '../../src/core/impact.ts';
import { checkCsvSize, CsvError, readCsv, readingLabel } from '../../src/core/csv.ts';
import type { TableRows } from '../../src/core/engine.ts';
import { filterText } from '../../src/core/describe.ts';
import { fileStem } from '../../src/core/export/model.ts';
import { emptyBehavior, type Flag, type FlagKind, formatMb, GRID_COLS, type Hoist, type Layout, type LayoutMode, LIMITS, oversize, parseHoist, type TimeGrain } from '../../src/core/hoist.ts';
import { learnSynonym, type Suggestion } from '../../src/core/intelligence/annotate.ts';
import { applyFlagDraft, applyHoistDraft, draftFlag, draftHoist } from '../../src/core/intelligence/index.ts';
import { starterHoistLocally } from '../../src/core/intelligence/local-rules.ts';
import { awayId, isReturned } from '../../src/core/away.ts';
import { learnStyle } from '../../src/core/style.ts';
import type { QlikImported } from '../../src/core/qlik.ts';
import { compact, DEFAULT_SIZE, findSlot, FREE_STEP, place, relayout, snapAll } from '../../src/core/layout.ts';
import { proposeCatalog, type TableProfile } from '../../src/core/profile.ts';
import { checkHealth, learnFromHoist, type QuestionItem, resolveQuestions } from '../../src/core/playbook.ts';
import { isStale, takeSnapshot } from '../../src/core/snapshot.ts';
import { calendarToday } from '../../src/core/sql.ts';
import { fleetSampleRows } from '../../src/sample/fleet.ts';
import { api, describeError, listItems, loadItem, profileTable, type StoredItem } from './lib/api.ts';
import { notify } from './lib/toasts.ts';
import { confirm } from './lib/confirm.ts';
import { aiExamplesWanted, aiLabel, type AiStatus, aiWanted, checkAi, draftingProvider, examplesFor, loadAiStatus, setAiExamplesWanted, setAiWanted } from './lib/ai.ts';
import { canReach, clearResultCache, type DataContext, runAnywhere } from './lib/data.ts';
import { usePlaybook } from './lib/playbook.ts';
import { useKits } from './lib/kits.ts';
import { useHoistHistory } from './lib/history.ts';
import { allFiles, deleteFile, notKeptMessage, putFile, readLocal, writeLocal } from './lib/storage.ts';
import { csvWorker, WorkerError } from './lib/worker.ts';
import { briefFrozen, dueSchedules, freezeHoist, produceDueEditions } from './lib/reports.ts';
import type { Briefing } from '../../src/core/briefing.ts';
import { BriefingPanel, ReportChip } from './components/Reports.tsx';
import { AskView, AssistantRoot, CommandPalette, DataPanel, DesignDialog, HelpDialog, KitsPanel, LineageView, OpenHoistDialog, PlaybookPanel, QlikImport, ShareDialog, SignalBook, SnapshotsDialog, SqlDesk, SettingsDialog } from './components/LazyPanels.tsx';
import { Panel, PanelBoundary, PanelSkeleton } from './components/ErrorBoundary.tsx';
import { Toasts } from './components/Toasts.tsx';
import { ConfirmHost } from './components/ConfirmHost.tsx';
import { BrowserOnlyNote, SessionScreen } from './components/SessionScreen.tsx';
import { Header } from './components/Header.tsx';
import { ConflictBar, TabChangeBar } from './components/ConflictBar.tsx';
import { DraftMiss, type DraftMissInfo } from './components/DraftMiss.tsx';
import { useSession } from './hooks/useSession.ts';
import { usePersistence } from './hooks/usePersistence.ts';
import { useBusy } from './hooks/useBusy.ts';
import { useShortcuts } from './hooks/useShortcuts.ts';
import { useFlagKeys } from './hooks/useFlagKeys.ts';
import { buildActions, useCommands } from './hooks/useCommands.ts';
import { describeCadence, detectCadence, newSchedule, noteOpened } from '../../src/core/reports.ts';
import { AskAnswer, AskBox } from './components/Ask.tsx';
import { BriefEditor, BriefLegend } from './components/BriefEditor.tsx';
import { Canvas } from './components/Canvas.tsx';
import { LayoutBar } from './components/LayoutBar.tsx';
import type { QlikImportPlan } from './components/QlikImport.tsx';
import { formatDim } from './lib/chart-option.ts';
import { applyThemeSpec, resolveMode, theme as themeStore, useSystemDark, useTheme } from './lib/theme.ts';
import { applyReduceMotionChoice } from './lib/motion.ts';
import { toggleAssistant, useAssistantOrb, useAssistantWanted } from './lib/assistant-bus.ts';
import { chartLookOf, designAttrs, designVars, withoutChartLook } from '../../src/core/design.ts';
import { cachedSliceKey, flagKeys as pageKeysFor, planSlice, relevantSelections } from './lib/relevance.ts';
import { Inspector } from './components/Inspector.tsx';
import { Palette } from './components/Palette.tsx';
import { Welcome } from './components/Welcome.tsx';
import { Shakedown, ShakedownAskMark } from './components/Shakedown.tsx';
import { announcedByAccept, useAccept } from './lib/accept.ts';
import { scrollBehavior } from './lib/motion.ts';
import { withBriefFlag } from './lib/onboarding.ts';

const FILES_SOURCE = 'files';
const EXAMPLE_SOURCES = new Set(['maint', 'parts']);
const K = { hoist: 'semaphore.hoist', catalog: 'semaphore.catalog', theme: 'semaphore.theme', skin: 'semaphore.skin', auto: 'semaphore.autoKind', view: 'semaphore.view', skipWelcome: 'semaphore.skipWelcome' };
/** Built-in skins (web/src/styles.css). A deployment may name another one defined in config\skin.css. */
const SKINS = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'classic', label: 'Classic' },
  { id: 'safe', label: 'Colour-blind safe' },
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
  // The session (lib/session.ts): the server's info while it answers, and one screen per state.
  const session = useSession();
  const server = session.info;
  const serverChecked = session.state !== 'boot';
  const [view, setViewState] = useState<View | null>(initialView);
  // The builder opens on the welcome page (components/Welcome.tsx) unless the analyst turned it off.
  const [welcome, setWelcome] = useState(() => (initialView() ?? 'builder') === 'builder' && !readLocal<boolean>(K.skipWelcome));
  const [refreshLog, setRefreshLog] = useState<string[]>([]);
  const [lastRefresh, setLastRefresh] = useState<{ at: string; computer: string; refreshed: number; failed: unknown[] } | null>(null);
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const [kitsOpen, setKitsOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [signalOpen, setSignalOpen] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [useAi, setUseAi] = useState(aiWanted);
  const [useExamples, setUseExamples] = useState(aiExamplesWanted);
  const [files, setFiles] = useState<TableRows>({});
  // CSV files are kept in the CSV worker when there is one (lib/worker.ts); `files` is the fallback.
  const worker = useMemo(() => csvWorker(), []);
  const [workerTables, setWorkerTables] = useState<string[]>([]);
  const [dataVersion, setDataVersion] = useState(1);
  const [selections, setSelections] = useState<Selections>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The busy line, and the guard that keeps a second draft or import from starting during one (#91).
  const { busy, run: runBusy, say: sayBusy } = useBusy();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [browserNoteHidden, setBrowserNoteHidden] = useState(false);
  // "Why it didn't draft" (#69): kept until the flag's brief changes.
  const [draftMiss, setDraftMiss] = useState<DraftMissInfo | null>(null);
  // A brief that defines a measure ("cost per hull = labor cost / hulls") offers it, to accept or leave.
  const [measureOffer, setMeasureOffer] = useState<{ flagId: string; brief: string; metric: Metric; sentence: string } | null>(null);
  const [dataOpen, setDataOpen] = useState(false);
  const [qlikOpen, setQlikOpen] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const assistantOrb = useAssistantOrb();
  const assistantWanted = useAssistantWanted();
  const [openList, setOpenList] = useState<StoredItem[] | null>(null);
  const [profileNotes, setProfileNotes] = useState<string[]>([]);
  const [asked, setAsked] = useState<Flag | null>(null);
  const [autoKinds, setAutoKinds] = useState<Record<string, boolean>>({});
  // The theme (lib/theme.ts, as in Lazarette): its mode decides light or dark, 'system' following Windows.
  const themeSpec = useTheme();
  const systemDark = useSystemDark();
  const theme = resolveMode(themeSpec.mode, systemDark);
  const setTheme = useCallback((mode: 'light' | 'dark') => themeStore.set({ mode }), []);
  const askRef = useRef<HTMLInputElement>(null);
  // The local calendar day (the core reads dates in UTC), moved on at local midnight so a tab left
  // open overnight does not keep yesterday's windows.
  const [today, setToday] = useState(() => calendarToday());
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const timer = setTimeout(() => setToday(calendarToday()), midnight - now.getTime() + 1000);
    return () => clearTimeout(timer);
  }, [today]);

  // The playbook, and the team style card learnt from it: drafts are finished the way the team builds.
  const playbook = usePlaybook(server, serverChecked);
  const kitStore = useKits(server, serverChecked);
  const user = server?.user || 'analyst';
  const teamStyle = useMemo(() => learnStyle(playbook.entries, index, playbook.styleOverrides), [playbook.entries, index, playbook.styleOverrides]);
  const [playbookTab, setPlaybookTab] = useState<'away' | undefined>(undefined);
  const myAway = playbook.away.find((n) => n.id === awayId(user));
  const digestWaiting = !!myAway && isReturned(myAway);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyThemeSpec(themeSpec, theme === 'dark');
    applyReduceMotionChoice();
  }, [theme, themeSpec]);

  // Skin (docs/SKINS.md): settings.json "skin" is the deployment's choice and wins; otherwise the
  // analyst's choice in this browser; otherwise Fleet UI.
  const [skin, setSkin] = useState<string>(() => readLocal<string>(K.skin) ?? 'fleet');
  const skinFixed = !!server?.skin;
  useEffect(() => {
    document.documentElement.dataset.skin = server?.skin || skin;
    if (!server?.skin) writeLocal(K.skin, skin);
  }, [skin, server]);

  // notify(text, { tone, action }) (lib/toasts.ts): info goes after 5 s, an error stays until dismissed.

  // The server, once it answers: the view this computer opens by default, and the AI status. The
  // heartbeat that keeps it alive while this tab is open runs in lib/session.ts.
  useEffect(() => {
    if (!server) return;
    if (server.view === 'ask' || server.view === 'builder') setViewState((v) => v ?? (server.view as 'ask' | 'builder'));
    loadAiStatus().then(setAi);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.pid]);

  // CSV files kept in this browser come back on reload.
  useEffect(() => {
    allFiles().then(async (stored) => {
      const tables: TableRows = {};
      const held: string[] = [];
      for (const f of stored) {
        try {
          if (worker) held.push((await worker.load(f.name, f.blob)).name);
          else {
            const t = readCsv(f.name, await f.blob.text());
            tables[t.name] = t.rows;
          }
        } catch {
          /* a file that no longer parses is skipped; it can be removed from the data panel */
        }
      }
      if (Object.keys(tables).length || held.length) {
        setFiles(tables);
        setWorkerTables(held);
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
    return { index, local, localSources, server, today, version: dataVersion, worker, workerTables: new Set(workerTables) };
  }, [index, sample, files, server, today, dataVersion, catalog.sources, worker, workerTables]);

  // "Brief me" and the quick-chart answer belong to the page they were made on (declared here so a
  // hoist switch can clear them).
  const [briefing, setBriefing] = useState<Briefing | 'loading' | null>(null);
  // What goes when another hoist takes this one's place: selections, the selected flag, an open
  // answer and briefing.
  const leavePage = useCallback(() => {
    setSelections({});
    setSelectedId(null);
    setAsked(null);
    setBriefing(null);
  }, []);

  // The catalog has edits the folder has not got yet: the folder's copy must not replace them.
  const catalogDirty = useRef(false);

  // Save (hooks/usePersistence.ts): always to this browser; to the Semaphore folder 1.2 s after the
  // last change, with the version check, the size check, and another tab's changes noticed.
  const persistence = usePersistence({
    hoist,
    server,
    online: session.state === 'ok',
    index,
    hoistKey: K.hoist,
    newId,
    onLoadHoist: (h) => {
      history.replace(h);
      leavePage();
    },
    onLoadCatalog: (c) => {
      if (c && c.version === 1 && checkCatalog(c).length === 0) {
        catalogDirty.current = false;
        setCatalogState(c);
        writeLocal(K.catalog, c);
      }
    },
    onCatalogSaved: () => {
      catalogDirty.current = false;
    },
  });
  const { flushSave } = persistence;

  const setCatalog = useCallback(
    (c: Catalog) => {
      const problems = checkCatalog(c);
      if (problems.length) {
        notify(problems[0]!, { tone: 'error' });
        return;
      }
      catalogDirty.current = true;
      setCatalogState(c);
      if (!writeLocal(K.catalog, c)) notify(server ? 'This browser could not save the catalog (storage is full or blocked). The server keeps a copy.' : 'This browser could not save the catalog (storage is full or blocked). Download the hoist to keep your work.', { tone: 'error' });
      persistence.saveCatalog(c);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persistence.saveCatalog],
  );

  // A server keeps the catalog for every browser on this computer; prefer its copy, once per server
  // (not again after an offline spell), and never over edits made here that it has not got yet.
  useEffect(() => {
    if (!server) return;
    loadItem<Catalog>('catalogs', 'default').then(
      (c) => {
        if (catalogDirty.current) return;
        if (c && c.version === 1 && checkCatalog(c).length === 0) {
          setCatalogState(c);
          writeLocal(K.catalog, c);
        }
      },
      // Nothing in the folder yet (or it could not be read): this browser's catalog becomes the folder's.
      () => {
        if (!oversize(catalog, 'catalog')) persistence.saveCatalog(catalog);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.pid]);

  // While a save conflict waits for a choice, the hoist stays: a switch would lose the edits it holds.
  const conflictBlocks = useCallback((): boolean => {
    if (!persistence.conflict) return false;
    notify(persistence.conflict.kind === 'hoists' ? 'Choose what to keep in the save conflict bar first: Load theirs, Save mine as a copy, or Overwrite. Then open another hoist.' : 'Choose what to keep for the catalog in the save conflict bar first. Then open another hoist.', { tone: 'error' });
    return true;
  }, [persistence.conflict]);

  const selected = hoist.flags.find((f) => f.id === selectedId) ?? null;
  const updateFlag = useCallback((id: string, patch: Partial<Flag>, group?: string) => change((h) => ({ ...h, flags: h.flags.map((f) => (f.id === id ? { ...f, ...patch } : f)) }), group), [change]);

  const addFlag = useCallback(
    (kind: FlagKind | 'auto', at?: { x: number; y: number }) => {
      const real: FlagKind = kind === 'auto' ? 'bar' : kind;
      const size = kind === 'auto' ? { w: 4, h: 4 } : DEFAULT_SIZE[real];
      const id = newId();
      change((h) => {
        const items = h.flags.map((f) => ({ id: f.id, layout: f.layout }));
        const flag: Flag = { id, kind: real, title: '', brief: '', layout: { x: 0, y: 0, ...size }, binding: null, behavior: real === 'custom' ? { ...emptyBehavior(), onClick: 'filter-page' } : emptyBehavior(), status: kind === 'text' ? 'ready' : 'empty', notes: [] };
        if (at) {
          const placed = place([...items, { id, layout: { ...at, ...size } }], id, { ...at, ...size }, h.grid.cols, h.grid.mode ?? 'snap');
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

  // A copy of the page before a risky change, at most every 10 minutes (lib/page-snapshots.ts).
  const autoSnap = (reason: string) => void (server && import('./lib/page-snapshots.ts').then((m) => m.autoSnapshot(hoist, catalog, reason)));

  // How flags move on this hoist: switching snaps free positions to cells (or tidies, for auto).
  const setLayoutMode = useCallback(
    (mode: LayoutMode) =>
      change((h) => {
        if ((h.grid.mode ?? 'snap') === mode) return h;
        const fixed = new Map(relayout(h.flags, h.grid.cols, mode).map((p) => [p.id, p.layout]));
        return { ...h, grid: mode === 'snap' ? { cols: h.grid.cols } : { cols: h.grid.cols, mode }, flags: h.flags.map((f) => ({ ...f, layout: fixed.get(f.id) ?? f.layout })) };
      }),
    [change],
  );
  const tidyUp = useCallback(
    () =>
      change((h) => {
        const fixed = new Map(compact(snapAll(h.flags, h.grid.cols)).map((p) => [p.id, p.layout]));
        return { ...h, flags: h.flags.map((f) => ({ ...f, layout: fixed.get(f.id) ?? f.layout })) };
      }),
    [change],
  );
  // Free mode stacks flags in list order, the last on top.
  const restack = useCallback(
    (id: string, to: 'front' | 'back') =>
      change((h) => {
        const f = h.flags.find((x) => x.id === id);
        if (!f) return h;
        const rest = h.flags.filter((x) => x.id !== id);
        return { ...h, flags: to === 'front' ? [...rest, f] : [f, ...rest] };
      }),
    [change],
  );

  const removeFlag = useCallback(
    (id: string) => {
      const gone = hoist.flags.find((f) => f.id === id);
      change((h) => ({ ...h, flags: h.flags.filter((f) => f.id !== id) }));
      setSelectedId(null);
      // Fail-safe delete (#69): one step back brings it back, offered right where the analyst looks.
      notify(`Flag deleted${gone?.title ? `: “${gone.title}”` : ''}.`, { action: { label: 'Undo', run: () => { history.undo(); setSelectedId(id); } } });
    },
    [change, hoist.flags, history],
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

  // The title each flag's last draft gave it, so a redraft can tell a drafted title from a typed one.
  const draftedTitles = useRef(new Map<string, string>());

  // Reviewed examples ride along with a draft only when the analyst switched them on (lib/ai.ts).
  const aiExamples = useMemo(() => examplesFor(useExamples, ai, useAi, playbook.entries, user), [useExamples, ai, useAi, playbook.entries, user]);

  const draftSelected = useCallback(async () => {
    if (!selected) return;
    if (/=|\bdivided by\b|\bdifference between\b|\bas an? (?:percent|share)/i.test(selected.brief)) {
      const p = (await import('../../src/core/formula-words.ts')).proposeMeasure(selected.brief, index);
      const known = p.ok && index.catalog.metrics.some((m) => m.label.toLowerCase() === p.metric.label.toLowerCase());
      setMeasureOffer(p.ok && !known ? { flagId: selected.id, brief: selected.brief, metric: p.metric, sentence: p.sentence } : null);
    }
    const provider = draftingProvider(index, ai, useAi);
    await runBusy(provider.local ? 'Drafting…' : `Drafting with ${provider.label}…`, async () => {
      const outcome = await draftFlag(provider, hoist, selected, index, { auto: autoKinds[selected.id] ?? selected.status === 'empty', style: teamStyle, ...(aiExamples ? { examples: aiExamples } : {}) });
      // When Fairlead fell back to a local model, the draft names the model that really answered.
      const by = outcome.draft.answeredBy;
      const credit = by ? `Drafted by ${by}, Fairlead's local fallback: ${ai?.model ?? 'the model asked for'} did not answer.` : `Drafted by ${provider.label}.`;
      const draft = provider.local || outcome.fallbackReason ? outcome.draft : { ...outcome.draft, notes: [credit, ...outcome.draft.notes] };
      if (outcome.fallbackReason) notify(`${provider.label} could not draft this flag: ${outcome.fallbackReason} Local rules drafted it instead.`, { tone: 'error' });
      else if (by) notify(`${ai?.model ?? 'The model asked for'} did not answer, so Fairlead's local fallback (${by}) drafted this flag.`);
      const next = applyFlagDraft(selected, draft);
      // A fresh draft takes the drafted title, and so does a redraft whose title is still the one the
      // last draft gave it; a title the analyst typed is kept.
      if (!selected.binding || selected.title === '' || selected.title === draftedTitles.current.get(selected.id)) {
        next.title = draft.title || selected.title;
        draftedTitles.current.set(selected.id, next.title);
      }
      if (next.kind !== selected.kind && next.layout.w < DEFAULT_SIZE[next.kind].w) {
        next.layout = { ...next.layout, w: DEFAULT_SIZE[next.kind].w, h: Math.max(next.layout.h, DEFAULT_SIZE[next.kind].h) };
      }
      change((h) => {
        const flags = h.flags.map((f) => (f.id === selected.id ? next : f));
        const placed = new Map(place(flags, selected.id, next.layout, h.grid.cols, h.grid.mode ?? 'snap').map((p) => [p.id, p.layout]));
        return { ...h, flags: flags.map((f) => ({ ...f, layout: placed.get(f.id) ?? f.layout })) };
      });
      // No measure found: the "Why it didn't draft" card says what was understood and what to do next.
      if (!draft.binding) setDraftMiss({ flagId: selected.id, brief: next.brief, note: draft.notes[draft.notes.length - 1] ?? 'Nothing in the brief matched the catalog.' });
      else setDraftMiss((m) => (m?.flagId === selected.id ? null : m));
    }).catch((e: unknown) => notify(`Could not draft this flag. ${describeError(e)}`, { tone: 'error' }));
  }, [selected, index, hoist, autoKinds, change, ai, useAi, teamStyle, aiExamples, runBusy]);

  // "Use <measure>" on the draft-miss card: draft again once the new brief is in the hoist.
  const [redraftFor, setRedraftFor] = useState<string | null>(null);
  useEffect(() => {
    if (!redraftFor || selected?.id !== redraftFor) return;
    setRedraftFor(null);
    void draftSelected();
  }, [redraftFor, selected, draftSelected]);

  const draftPage = useCallback(
    async (mode: 'add' | 'replace' | 'starter') => {
      const provider = draftingProvider(index, ai, useAi);
      if (mode !== 'add') autoSnap('Redrafting the whole page');
      await runBusy(mode === 'starter' || provider.local ? 'Drafting the page…' : `Drafting the page with ${provider.label}…`, async () => {
        const base = mode === 'add' ? hoist : { ...hoist, flags: [], filters: [] };
        const outcome = mode === 'starter' ? null : await draftHoist(provider, hoist.brief, index, { style: teamStyle, ...(aiExamples ? { examples: aiExamples } : {}) });
        const draft = outcome ? outcome.draft : starterHoistLocally(index);
        const next = applyHoistDraft({ ...base, title: base.title }, draft, () => newId());
        change(next);
        setSelections({});
        setSelectedId(null);
        if (outcome?.fallbackReason) notify(`${provider.label} could not draft the page: ${outcome.fallbackReason} Local rules drafted it instead.`, { tone: 'error' });
        else if (draft.notes.length) notify(draft.notes[0]!);
      }).catch((e: unknown) => notify(`Could not draft the page. ${describeError(e)}`, { tone: 'error' }));
    },
    [hoist, index, change, ai, useAi, teamStyle, aiExamples, runBusy],
  );

  const toggleExamples = useCallback(() => {
    const on = !useExamples;
    setUseExamples(on);
    setAiExamplesWanted(on);
    notify(on ? 'Reviewed examples are on: drafts also send a few similar reviewed briefs with catalog keys and labels. Never rows, results or names.' : 'Reviewed examples are off: drafts send only the brief and the catalog.');
  }, [useExamples]);

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
      (e: unknown) => notify(`Could not check Fairlead. ${describeError(e)}`, { tone: 'error' }),
    );
  }, [ai, useAi]);

  const onLearn = useCallback(
    (word: string, s: Suggestion) => {
      const next = learnSynonym(catalog, word, s);
      if (next && next !== catalog) {
        setCatalog(next);
        notify(`Learnt: "${word}" means ${s.label}.`);
      }
    },
    [catalog, setCatalog],
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
    (list: FileList) =>
      runBusy('Reading files…', async () => {
      let cat = catalog;
      const notes: string[] = [];
      const tables: TableRows = { ...files };
      const held = new Set(workerTables);
      let notKept: string | null = null;
      const picked = Array.from(list);
      for (const [at, file] of picked.entries()) {
        try {
          sayBusy(readingLabel(file.name, at + 1, picked.length, file.size));
          checkCsvSize(file.size);
          // A JSON export from PacketRat, Eight Bells and the like is turned into CSV text first
          // (src/core/fleet-exports.ts). A plain CSV is never read on the page: its first line tells.
          const json = /\.json$/i.test(file.name);
          // The readers load with the first file, not with the page (web/size-budget.json).
          const { fleetExportToCsv } = await import('../../src/core/fleet-exports.ts');
          const fleet = json || fleetExportToCsv(file.name, await file.slice(0, 65536).text()) !== null;
          const fx = fleet ? fleetExportToCsv(file.name, await file.text()) : null;
          const blob: Blob = fx ? new Blob([fx.csv], { type: 'text/csv' }) : file;
          const name = fx ? fx.fileName : file.name;
          if (fx) notes.push(fx.note);
          // Parsed in the CSV worker when there is one: a large file never freezes the page.
          let t: { name: string; rows: number; columns: unknown[]; profile: TableProfile; notes: string[] };
          if (worker) {
            t = await worker.load(name, blob);
            held.add(t.name);
          } else {
            const parsed = readCsv(name, await blob.text());
            tables[parsed.name] = parsed.rows;
            t = { ...parsed, rows: parsed.rows.length };
          }
          const kept = await putFile({ name, blob, added: new Date().toISOString() });
          if (!kept.ok) notKept = notKeptMessage(name, kept);
          // Replace the measures and fields of a file loaded before under the same name.
          const without: Catalog = {
            ...cat,
            fields: cat.fields.filter((f) => !(f.source === FILES_SOURCE && f.table === t.name)),
            metrics: cat.metrics.filter((m) => !(m.source === FILES_SOURCE && (m.table === t.name || cat.fields.find((f) => f.key === m.field)?.table === t.name))),
          };
          const proposal = proposeCatalog({ source: { id: FILES_SOURCE, label: 'Files in this browser', kind: 'csv', dialect: 'ansi' }, tables: [t.profile] }, without);
          cat = pruneCatalog(proposal.catalog);
          notes.push(`${name}: ${t.rows.toLocaleString('en-US')} rows, ${t.columns.length} columns.`, ...t.notes, ...proposal.notes);
        } catch (e) {
          notes.push(`${file.name}: ${e instanceof CsvError || e instanceof WorkerError ? e.message : 'could not be read.'}`);
        }
      }
      setFiles(tables);
      setWorkerTables([...held]);
      setDataVersion((v) => v + 1);
      clearResultCache();
      setCatalog(cat);
      setProfileNotes(notes);
      notify(notKept ?? 'Files added. Check the proposed measures and fields, then describe a flag or draft a starter page.', { tone: notKept ? 'error' : 'success' });
      }).then(() => undefined),
    [catalog, files, workerTables, worker, setCatalog, runBusy],
  );

  const profile = useCallback(
    (source: string, table: string) =>
      runBusy(`Profiling ${table}…`, async () => {
      try {
        const p = await profileTable(source, table);
        const s = server?.sources.find((x) => x.id === source);
        const kind = (s?.kind ?? 'other') as Catalog['sources'][number]['kind'];
        const dialect = dialectForSource({ kind, engine: s?.engine, provider: s?.provider });
        const proposal = proposeCatalog({ source: { id: source, label: s?.label ?? source, kind, dialect, ...(s?.engine ? { engine: s.engine as RdsEngine } : {}) }, tables: [{ name: p.table, rows: p.rows, columns: p.columns }] }, catalog);
        setCatalog(proposal.catalog);
        setProfileNotes(proposal.notes);
        notify(`${table} added to the catalog.`, { tone: 'success' });
      } catch (e) {
        notify(`Could not profile ${table}. ${describeError(e)}`, { tone: 'error' });
      }
      }).then(() => undefined),
    [server, catalog, setCatalog, runBusy],
  );

  // Import from Qlik: profile each picked table, name its fields the way the Qlik app did, then add
  // the chart expressions as measures. One catalog update at the end; returns what happened.
  const importQlik = useCallback(
    async (plan: QlikImportPlan): Promise<string[]> => {
      // The Qlik readers load with the import, not with the page (web/size-budget.json).
      const { applyQlikLabels, qlikCleaningSteps, qlikMeasures, qlikRelationshipCandidates } = await import('../../src/core/qlik.ts');
      const out: string[] = [];
      const imported: QlikImported[] = [];
      let cat = catalog;
      const ran = await runBusy('Importing from Qlik…', async () => {
        for (const t of plan.tables) {
          sayBusy(`Profiling ${t.table}…`);
          try {
            const p = await profileTable(t.source, t.table);
            const s = server?.sources.find((x) => x.id === t.source);
            const kind = (s?.kind ?? 'other') as Catalog['sources'][number]['kind'];
            const dialect = dialectForSource({ kind, engine: s?.engine, provider: s?.provider });
            cat = proposeCatalog({ source: { id: t.source, label: s?.label ?? t.source, kind, dialect, ...(s?.engine ? { engine: s.engine as RdsEngine } : {}) }, tables: [{ name: p.table, rows: p.rows, columns: p.columns }] }, cat).catalog;
            const labelled = applyQlikLabels(cat, t.source, p.table, t.labels);
            cat = labelled.catalog;
            imported.push({ source: t.source, table: p.table, qlik: t.qlik });
            out.push(`${p.table}: ${p.columns.length} columns profiled, ${labelled.renamed} named the way the Qlik app named them.`);
          } catch (e) {
            out.push(`${t.table}: could not be profiled. ${describeError(e)}`);
          }
        }
        if (plan.expressions.trim()) {
          const m = qlikMeasures(plan.expressions, cat, imported);
          cat = { ...cat, metrics: [...cat.metrics, ...m.metrics] };
          if (m.metrics.length) out.push(`${m.metrics.length} measure${m.metrics.length === 1 ? '' : 's'} added: ${m.metrics.map((x) => x.label).join(', ')}.`);
          out.push(...m.filterNotes);
          for (const s of m.skipped) out.push(`Not added, ${s.label}: ${s.reason}`);
        }
        if (plan.script && imported.length) {
          // The cleaning Qlik's mapping loads did, and the links its same-named fields made.
          const cleaning = qlikCleaningSteps(plan.script, cat, imported);
          const have = new Set((cat.cleaning ?? []).map((s) => s.id));
          const fresh = cleaning.steps.filter((s) => !have.has(s.id));
          if (fresh.length) {
            cat = { ...cat, cleaning: [...(cat.cleaning ?? []), ...fresh] };
            out.push(`${fresh.length} mapping${fresh.length === 1 ? '' : 's'} carried over as cleaning steps (Data > Clean).`);
          }
          out.push(...cleaning.notes);
          const candidates = qlikRelationshipCandidates(plan.script, cat, imported);
          const { checkRelationship, proposeRelationship, toValueCounts, valuesPlan } = await import('../../src/core/quality.ts');
          const checkCtx: DataContext = { ...ctx, index: indexCatalog(cat) };
          for (const c of candidates) {
            sayBusy(`Checking the ${c.from.label} link…`);
            try {
              const [a, b] = [await runAnywhere(valuesPlan(checkCtx.index, c.from.key), checkCtx), await runAnywhere(valuesPlan(checkCtx.index, c.to.key), checkCtx)];
              const rel = proposeRelationship(c, checkRelationship(toValueCounts(a.rows), toValueCounts(b.rows)));
              if (rel && !(cat.relationships ?? []).some((r) => r.id === rel.id)) {
                cat = { ...cat, relationships: [...(cat.relationships ?? []), { ...rel, origin: 'qlik' }] };
                out.push(`Linked ${c.from.table} to ${c.to.table} on ${c.from.label}, as Qlik did (${Math.round((rel.match ?? 0) * 100)}% of values match).`);
              }
            } catch (e) {
              out.push(`The ${c.from.label} link could not be checked. ${describeError(e)}`);
            }
          }
        }
        setCatalog(cat);
        notify('Qlik import done: check the new measures and fields under Data.', { tone: 'success' });
        return true;
      });
      if (!ran) return ['Another import or draft is still running. Try again when it has finished.'];
      return out.length ? out : ['Nothing was imported: map a connection and pick a table, or add expressions.'];
    },
    [catalog, server, setCatalog, ctx, runBusy, sayBusy],
  );

  // The model's smaller jobs (tasks.ts) load when one is first asked for, not with the page.
  const readQlikWithAi = useCallback(async (label: string, expression: string) => (await import('../../src/core/intelligence/tasks.ts')).readQlikExpressionWithAi(draftingProvider(index, ai, useAi), label, expression, catalog), [index, ai, useAi, catalog]);
  const addMeasures = useCallback((metrics: Metric[]) => setCatalog({ ...catalog, metrics: [...catalog.metrics, ...metrics] }), [catalog, setCatalog]);

  // A Qlik expression Semaphore could not read becomes a flag with it in the brief, to draft.
  const addBriefFlag = useCallback(
    (title: string, brief: string) => {
      const id = newId();
      change((h) => {
        const items = h.flags.map((f) => ({ id: f.id, layout: f.layout }));
        const flag: Flag = { id, kind: 'bar', title, brief, layout: findSlot(items, 4, 4, h.grid.cols), binding: null, behavior: emptyBehavior(), status: 'empty', notes: [] };
        return { ...h, flags: [...h.flags, flag] };
      });
      setAutoKinds((x) => ({ ...x, [id]: true }));
      setSelectedId(id);
      notify(`Added "${title}" as a flag: select Draft to let Semaphore work it out.`);
    },
    [change],
  );

  const removeSource = useCallback(
    (id: string) => {
      if (id === FILES_SOURCE) {
        // Stored files are keyed by file name (not table name): remove every one this browser keeps.
        allFiles().then((all) => all.forEach((f) => void deleteFile(f.name)));
        setFiles({});
        void worker?.clear();
        setWorkerTables([]);
        setDataVersion((v) => v + 1);
      }
      const fieldKeys = new Set(catalog.fields.filter((f) => f.source === id).map((f) => f.key));
      setCatalog({
        ...catalog,
        sources: catalog.sources.filter((s) => s.id !== id),
        fields: catalog.fields.filter((f) => f.source !== id),
        metrics: catalog.metrics.filter((m) => m.source !== id && !(m.field && fieldKeys.has(m.field))),
        relationships: (catalog.relationships ?? []).filter((r) => r.source !== id),
        cleaning: (catalog.cleaning ?? []).filter((c) => !fieldKeys.has(c.field)),
        hierarchies: (catalog.hierarchies ?? []).filter((h) => !h.levels.some((l) => fieldKeys.has(l))),
      });
    },
    [catalog, setCatalog],
  );

  const loadExample = useCallback(() => {
    const ex = exampleCatalog as Catalog;
    setCatalog({ ...catalog, version: 1, sources: [...catalog.sources.filter((s) => !EXAMPLE_SOURCES.has(s.id)), ...ex.sources], fields: [...catalog.fields.filter((f) => !EXAMPLE_SOURCES.has(f.source)), ...ex.fields], metrics: [...catalog.metrics.filter((m) => !EXAMPLE_SOURCES.has(m.source)), ...ex.metrics] });
    if (conflictBlocks()) return;
    const h = parseHoist(exampleHoist, indexCatalog(ex)).hoist;
    if (h) {
      void flushSave();
      history.replace(h);
      leavePage();
    }
  }, [catalog, setCatalog, history, conflictBlocks, flushSave, leavePage]);

  const exportHoist = () => {
    const blob = new Blob([JSON.stringify(hoist, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${hoist.id}.hoist.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importHoist = async (file: File) => {
    if (conflictBlocks()) return;
    // The size check comes first (#91): the folder takes 2 MB a hoist, so a bigger file is never read in.
    if (file.size > LIMITS.docBytes) {
      notify(`${file.name} is ${formatMb(file.size)}, over the ${formatMb(LIMITS.docBytes)} a hoist may be. Remove some flags from it, or split it into two hoists.`, { tone: 'error' });
      return;
    }
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        throw new Error('It is not a JSON file.');
      }
      const { hoist: h, warnings } = parseHoist(raw, index);
      if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
      void flushSave();
      history.replace(h);
      leavePage();
      notify(warnings.length ? `Opened “${h.title}”. ${warnings.slice(0, 2).join(' ')}` : `Opened “${h.title}”.`, { tone: warnings.length ? 'info' : 'success' });
    } catch (e) {
      notify(`Could not open ${file.name}. ${describeError(e)}`, { tone: 'error' });
    }
  };

  const openFromServer = async (id: string) => {
    if (conflictBlocks()) return;
    try {
      const raw = await loadItem<unknown>('hoists', id);
      const { hoist: h, warnings } = parseHoist(raw, index);
      if (!h) throw new Error(warnings[0] ?? 'Not a hoist.');
      void flushSave();
      history.replace(h);
      leavePage();
      setOpenList(null);
      if (warnings.length) notify(warnings.slice(0, 2).join(' '));
    } catch (e) {
      notify(`Could not open it. ${describeError(e)}`, { tone: 'error' });
    }
  };
  const showOpenList = useCallback(() => {
    if (conflictBlocks()) return;
    listItems('hoists').then(setOpenList, (e: unknown) => notify(`Could not list the saved hoists. ${describeError(e)}`, { tone: 'error' }));
  }, [conflictBlocks]);
  const newHoist = useCallback(() => {
    if (conflictBlocks()) return;
    void flushSave();
    history.replace(blankHoist());
    leavePage();
  }, [flushSave, history, conflictBlocks, leavePage]);

  // End session (#87): confirm, send the pending save, stop the heartbeat, then stop the server.
  const endTheSession = useCallback(async () => {
    const ok = await confirm({ title: 'End this session?', body: 'Semaphore saves this hoist to the folder, then stops its server. You can start it again any time with Launch-Semaphore.bat.', confirmLabel: 'End session', destructive: true });
    if (ok) await session.end(() => flushSave());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flushSave, session.end]);

  // ---- The playbook: learn from accepted flags, keep it healthy, keep snapshots fresh --------
  // (usePlaybook, user and the team style are set up near the top: the draft handlers use them.)
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
          if (fresh.length && hoist.id !== exampleHoist.id && !announcedByAccept(fresh.map((e) => e.id))) notify(`Leadership can now ask for "${fresh[0]!.title}"${fresh.length > 1 ? ` and ${fresh.length - 1} more` : ''}.`, { tone: 'success' });
          const all = [...playbook.entries.filter((e) => !learnt.some((l) => l.id === e.id)), ...learnt];
          for (const q of resolveQuestions(playbook.questions, all)) void playbook.saveQuestion(q);
        },
        (e: unknown) => notify(`Could not save to the playbook. ${describeError(e)}`, { tone: 'error' }),
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

  // Recurring reports: note the days this analyst opens the page (once a day), offer a schedule
  // when there is a rhythm, and produce any edition that is due while its owner is away.
  const [offerTick, setOfferTick] = useState(0);
  useEffect(() => {
    if (!playbook.loaded || currentView !== 'builder' || !hoist.flags.length || hoist.experiment) return;
    const log = noteOpened(playbook.usage.find((u) => u.hoistId === hoist.id), hoist.id, hoist.title, user, today);
    if (log) void playbook.saveReportDoc(log).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbook.loaded, hoist.id, currentView]);
  const hoistSchedule = playbook.schedules.find((s) => s.hoistId === hoist.id);
  const reportOffer = useMemo(() => {
    if (hoistSchedule || readLocal<string>(`semaphore.reportOffer.${hoist.id}`) === 'no') return null;
    const log = playbook.usage.find((u) => u.hoistId === hoist.id);
    return log ? detectCadence(log.opened, today) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbook.usage, hoistSchedule, hoist.id, today, offerTick]);
  const producing = useRef(false);
  useEffect(() => {
    if (!playbook.loaded || producing.current || currentView === 'refresh') return;
    if (!dueSchedules(playbook, new Date()).length) return;
    producing.current = true;
    produceDueEditions(playbook, ctx, index, user, hoist, draftingProvider(index, ai, useAi))
      .catch(() => [])
      .finally(() => {
        producing.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbook.loaded, playbook.schedules, playbook.away, ctx]);

  // "Brief me": the open page's briefing, written by the AI when it is on, checked against the facts.
  const briefMe = useCallback(async () => {
    if (briefing === 'loading') return;
    setBriefing('loading');
    try {
      const frozen = await freezeHoist(hoist, ctx, index);
      setBriefing(await briefFrozen(frozen, hoist.title, index, draftingProvider(index, ai, useAi)));
    } catch (e) {
      setBriefing(null);
      notify(`Could not brief you on this page. ${describeError(e)}`, { tone: 'error' });
    }
  }, [hoist, ctx, index, ai, useAi, briefing]);

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
      // Regular reports due while their analyst is away.
      for (const line of await produceDueEditions(playbook, ctx, index, user, null, draftingProvider(index, ai, useAi)).catch((e: Error) => [`Regular reports: ${e.message}`])) say(line);
      if (server) {
        await api('/api/refresh-report', { json: { refreshed, skipped, failed } }).catch(() => undefined);
        await session.end(() => Promise.resolve());
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

  // Keyboard (hooks/useShortcuts.ts, listed in the ? help): palette, help, undo and redo, delete,
  // arrows to nudge, Escape to deselect, / for a quick chart. Flag keys come from useFlagKeys.
  const onAcceptFlag = useAccept({ hoist, index, user, entries: playbook.entries, questions: playbook.questions, style: teamStyle, updateFlag, notify, onSeeLeadership: () => setView('ask'), saveEntries: playbook.saveEntries, saveQuestion: playbook.saveQuestion });
  const flagKeys = useFlagKeys({ selectedId, selectedStatus: selected?.status, onAccept: onAcceptFlag, onDuplicate: duplicateFlag });
  useShortcuts({
    enabled: currentView === 'builder' && !welcome,
    hasSelection: !!selected,
    flagKeys,
    onPalette: () => setPaletteOpen(true),
    onHelp: () => setHelpOpen(true),
    onAsk: () => askRef.current?.focus(),
    onUndo: history.undo,
    onRedo: history.redo,
    onEscape: () => {
      setSelectedId(null);
      setAsked(null);
    },
    onDelete: () => selectedId && removeFlag(selectedId),
    ...(hoist.grid.mode === 'free' ? { onStack: (to: 'front' | 'back') => selectedId && restack(selectedId, to) } : {}),
    onArrow: (dx, dy, resize) => {
      if (!selected) return;
      const l = selected.layout;
      // Free mode moves an eighth of a cell per key press; the other modes a whole cell.
      const mode = hoist.grid.mode ?? 'snap';
      const s = mode === 'free' ? FREE_STEP : 1;
      const target = resize ? { ...l, w: Math.max(1, l.w + dx * s), h: Math.max(1, l.h + dy * s) } : { ...l, x: l.x + dx * s, y: Math.max(0, l.y + dy * s) };
      onLayout(place(hoist.flags, selected.id, target, hoist.grid.cols, mode), `keys-${selected.id}`);
    },
  });

  const selectionChips = Object.entries(selections).flatMap(([key, values]) => {
    const [field, grain] = key.split('@');
    const label = index.field(field!)?.label ?? field;
    return values.map((v) => ({ key, value: v, text: `${label}: ${formatDim(v, grain as never)}` }));
  });
  const examples = useMemo(() => exampleBriefs(catalog), [catalog]);
  // Charts re-read their colours whenever anything that changes a colour changes.
  const themeKey = `${theme}:${server?.skin || skin}:${themeSpec.accent}:${themeSpec.tint}:${themeSpec.tintStrength}:${themeSpec.contrast}`;
  const waiting = playbook.questions.filter((q) => q.status === 'open').length + playbook.entries.filter((e) => e.status === 'needs-review').length;

  if (currentView === 'refresh') {
    return (
      <main className="mx-auto max-w-2xl p-8 font-mono text-xs">
        <h1 className="mb-3 font-sans text-base font-semibold">Semaphore: refreshing snapshots</h1>
        <ul>{refreshLog.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </main>
    );
  }

  // The one action list: the header's menus and the command palette both show it (hooks/useCommands.ts).
  const importInput = useRef<HTMLInputElement>(null);
  const actions = useMemo(
    () =>
      buildActions({
        hasServer: !!server,
        hasSql: !!server && server.sources.length > 0,
        busy: busy !== null,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        hasBrief: !!hoist.brief.trim(),
        hasFlags: hoist.flags.length > 0,
        experiment: !!hoist.experiment,
        theme,
        skinLabel: skinFixed ? null : (SKINS.find((x) => x.id === skin)?.label ?? skin),
        ai: server && ai ? { configured: ai.configured, on: ai.configured && useAi } : null,
        examplesOn: server && ai?.configured && useAi ? useExamples : null,
        signalBook: playbook.social.signalBook,
        run: {
          new: newHoist,
          open: showOpenList,
          import: () => importInput.current?.click(),
          download: exportHoist,
          snapshots: () => setSnapshotsOpen(true),
          share: () => setShareOpen(true),
          assistant: toggleAssistant,
          design: () => setDesignOpen(true),
          brief: () => void briefMe(),
          kits: () => setKitsOpen(true),
          signals: () => setSignalOpen(true),
          sql: () => setSqlOpen(true),
          lineage: () => setLineageOpen(true),
          qlik: () => setQlikOpen(true),
          playbook: () => setPlaybookOpen(true),
          data: () => setDataOpen(true),
          leadership: () => setView('ask'),
          home: () => setWelcome(true),
          undo: history.undo,
          redo: history.redo,
          ask: () => askRef.current?.focus(),
          'draft-page': () => void draftPage(hoist.flags.length ? 'add' : 'replace'),
          starter: () => void draftPage('starter'),
          experiment: () => change((h) => ({ ...h, experiment: !h.experiment })),
          theme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
          skin: () => {
            const i = SKINS.findIndex((x) => x.id === skin);
            const next = SKINS[(i + 1) % SKINS.length]!;
            setSkin(next.id);
            notify(`Skin: ${next.label}.`);
          },
          ai: toggleAi,
          examples: toggleExamples,
          help: () => setHelpOpen(true),
          settings: () => setSettingsOpen(true),
          palette: () => setPaletteOpen(true),
          end: () => void endTheSession(),
        },
      }),
    // `history` is a new object every render; only its stable functions and flags matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, busy, history.canUndo, history.canRedo, history.undo, history.redo, hoist, theme, skin, skinFixed, ai, useAi, useExamples, newHoist, showOpenList, briefMe, draftPage, toggleAi, toggleExamples, endTheSession],
  );
  const paletteCommands = useCommands({
    actions,
    open: paletteOpen,
    hasServer: !!server,
    flags: hoist.flags,
    catalog,
    questions: playbook.questions,
    onSelectFlag: (id) => {
      setSelectedId(id);
      document.querySelector(`[data-flag="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
    },
    onOpenHoist: (id) => void openFromServer(id),
    onInsert: (label) => change((h) => ({ ...h, brief: `${h.brief.trimEnd()}${h.brief.trim() ? ' ' : ''}${label}`.slice(0, LIMITS.briefChars) }), 'hoist-brief'),
    onAnswer: answerQuestionItem,
  });

  // Over every view: the session's state, toasts and confirmations.
  const overlays = (
    <>
      {settingsOpen && (
        <Panel name="settings" onClose={() => setSettingsOpen(false)}>
          <SettingsDialog
            onClose={() => setSettingsOpen(false)}
            theme={theme}
            onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            skins={SKINS}
            skin={skin}
            onSkin={skinFixed ? null : setSkin}
            hasServer={!!server}
            server={server ? { version: server.version, port: server.port, home: server.home, pid: server.pid, ...(server.user ? { user: server.user } : {}) } : null}
            ai={ai}
            aiOn={!!ai?.configured && useAi}
            onAi={toggleAi}
            examplesOn={useExamples}
            onExamples={toggleExamples}
            deployment={playbook.deployment}
            onEnd={() => {
              setSettingsOpen(false);
              void endTheSession();
            }}
          />
        </Panel>
      )}
      <SessionScreen session={session} view={currentView === 'ask' ? 'ask' : 'builder'} onRetry={session.retry} />
      <ConfirmHost />
      <Toasts busy={busy} />
    </>
  );

  if (currentView === 'ask') {
    return (
      <>
        <PanelBoundary name="leadership view">
          <Suspense fallback={<PanelSkeleton label="leadership view" />}>
            <AskView index={index} ctx={ctx} playbook={playbook} user={user} theme={theme} themeKey={themeKey} lastRefresh={lastRefresh} onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} onSettings={() => setSettingsOpen(true)} onBuilder={() => setView('builder')} />
          </Suspense>
        </PanelBoundary>
        <ShakedownAskMark />
        {overlays}
      </>
    );
  }

  if (welcome) {
    return (
      <>
        <Welcome
          lastTitle={hoist.title}
          impactLine={playbook.social.impact ? impactLine(impactFor(playbook.entries, playbook.asks, playbook.bz, user, 0)?.thisWeek ?? 0) : null}
          canOpenSaved={!!server}
          onContinue={() => setWelcome(false)}
          onNew={() => {
            newHoist();
            setWelcome(false);
          }}
          onOpenSaved={() => {
            setWelcome(false);
            showOpenList();
          }}
          onData={() => {
            setWelcome(false);
            setDataOpen(true);
          }}
          onAsk={() => {
            setWelcome(false);
            setView('ask');
          }}
          onSettings={() => setSettingsOpen(true)}
          skipNextTime={!!readLocal<boolean>(K.skipWelcome)}
          onSkipNextTime={(skip) => writeLocal(K.skipWelcome, skip)}
        />
        {openList && <OpenHoistDialog items={openList} onOpen={(id) => void openFromServer(id)} onClose={() => setOpenList(null)} />}
        {overlays}
      </>
    );
  }

  const miss = selected && draftMiss && draftMiss.flagId === selected.id && draftMiss.brief === selected.brief ? draftMiss : null;

  return (
    <div className="flex h-full flex-col">
      <Header
        title={hoist.title}
        onTitle={(t) => change((h) => ({ ...h, title: t.slice(0, LIMITS.titleChars) }), 'title')}
        onHome={() => setWelcome(true)}
        experiment={!!hoist.experiment}
        onExperiment={actions.experiment.run}
        chips={
          <>
            {digestWaiting && (
              <button
                type="button"
                onClick={() => {
                  setPlaybookTab('away');
                  setPlaybookOpen(true);
                }}
                className="flex min-h-7 shrink-0 items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 text-[11px] font-semibold text-accent"
              >
                While you were out
              </button>
            )}
            {!hoist.experiment && hoistSchedule && (
              <ReportChip
                title={hoist.title}
                cadence={reportOffer}
                schedule={hoistSchedule}
                onAccept={(c) => void playbook.saveReportDoc(newSchedule(hoist.id, hoist.title, user, c, new Date())).then(() => notify(`While you are marked away, “${hoist.title || 'this page'}” keeps coming ${describeCadence(c)}.`))}
                onDismiss={() => {
                  writeLocal(`semaphore.reportOffer.${hoist.id}`, 'no');
                  setOfferTick((t) => t + 1);
                }}
                onStop={() => hoistSchedule && void playbook.removeReportDoc(hoistSchedule.id)}
              />
            )}
          </>
        }
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onUndo={history.undo}
        onRedo={history.redo}
        askBox={<AskBox index={index} onAsk={setAsked} inputRef={askRef} />}
        actions={actions}
        waiting={waiting}
        onPlaybook={actions.playbook.run}
        onData={actions.data.run}
        onLeadership={actions.leadership.run}
        onHelp={actions.help.run}
        onSettings={actions.settings.run}
      />
      <input ref={importInput} type="file" accept=".json,application/json" tabIndex={-1} aria-hidden="true" className="sr-only" onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void importHoist(f);
      }} />
      {session.state === 'no-server' && !browserNoteHidden && <BrowserOnlyNote onDismiss={() => setBrowserNoteHidden(true)} />}
      {persistence.conflict && (
        <ConflictBar
          conflict={persistence.conflict}
          onTheirs={() => persistence.resolveConflict('theirs')}
          {...(persistence.conflict.kind === 'hoists' ? { onCopy: () => persistence.resolveConflict('copy') } : {})}
          onOverwrite={() => persistence.resolveConflict('overwrite')}
        />
      )}
      {persistence.tabChange && <TabChangeBar change={persistence.tabChange} onReload={() => persistence.resolveTabChange('reload')} onKeep={() => persistence.resolveTabChange('keep')} />}
      {!hoist.experiment && !hoistSchedule && reportOffer && (
          <ReportChip
            title={hoist.title}
            cadence={reportOffer}
            schedule={hoistSchedule}
            onAccept={(c) => void playbook.saveReportDoc(newSchedule(hoist.id, hoist.title, user, c, new Date())).then(() => notify(`While you are marked away, “${hoist.title || 'this page'}” keeps coming ${describeCadence(c)}.`))}
            onDismiss={() => {
              writeLocal(`semaphore.reportOffer.${hoist.id}`, 'no');
              setOfferTick((t) => t + 1);
            }}
            onStop={() => undefined}
          />
      )}

      <section aria-label="Page brief" className="border-b border-line bg-panel-2 px-4 py-3">
        <div className="mx-auto flex max-w-[1400px] items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <BriefEditor
              value={hoist.brief}
              onChange={(v) => {
                if (v.length > LIMITS.briefChars) notify(`A brief can be up to ${LIMITS.briefChars.toLocaleString('en-US')} characters, so the rest was left out. Split a long brief over several flags.`);
                change((h) => ({ ...h, brief: v.slice(0, LIMITS.briefChars) }), 'hoist-brief');
              }}
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
            <button key={`${c.key}-${String(c.value)}`} type="button" onClick={() => onSelectValue(c.key, c.value, true)} className="flex min-h-8 items-center gap-1 rounded-full bg-accent px-2.5 font-medium text-panel" title="Remove this selection">
              {c.text} <X size={11} />
            </button>
          ))}
          <button type="button" onClick={() => setSelections({})} className="ml-1 min-h-8 px-1 text-ink-3 underline hover:text-ink">
            Clear all
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Palette onAdd={(k) => addFlag(k)} onHome={() => setWelcome(true)} />
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
          <div className="mx-auto min-h-full max-w-[1400px] p-4" {...designAttrs(hoist.design)} style={designVars(hoist.design) as React.CSSProperties}>
            <Shakedown catalog={catalog} onAsk={() => setView('ask')} onTypeForMe={(brief) => { const id = newId(); change((h) => withBriefFlag(h, id, brief)); setAutoKinds((a) => ({ ...a, [id]: true })); setSelectedId(id); }} />
            {hoist.flags.length > 0 && (
              <LayoutBar
                mode={hoist.grid.mode ?? 'snap'}
                hasSelection={!!selected}
                onMode={(m) => {
                  if (m !== (hoist.grid.mode ?? 'snap')) autoSnap('Changing the layout');
                  setLayoutMode(m);
                }}
                onTidy={() => {
                  autoSnap('Tidy up');
                  tidyUp();
                }}
                onFront={() => selected && restack(selected.id, 'front')}
                onBack={() => selected && restack(selected.id, 'back')}
              />
            )}
            <Canvas
              hoist={hoist}
              ctx={ctx}
              index={index}
              selections={selections}
              selectedId={selectedId}
              themeKey={themeKey}
              onSelectFlag={setSelectedId}
              onSelectValue={onSelectValue}
              onAccept={onAcceptFlag}
              onLayout={onLayout}
              onDropKind={addFlag}
              empty={<EmptyHoist examples={examples} onExample={(b) => change((h) => ({ ...h, brief: b }))} onStarter={() => draftPage('starter')} hasCatalog={catalog.metrics.length > 0} onData={() => setDataOpen(true)} />}
            />
          </div>
        </main>
        {selected && (
          <div className="flex h-full min-h-0 w-[360px] shrink-0 flex-col">
            {measureOffer?.flagId === selected.id && measureOffer.brief === selected.brief && (
              <section aria-label="Calculated measure" className="space-y-1.5 border-b border-l border-line bg-accent-soft p-3 text-sm">
                <p className="font-semibold">Add a calculated measure?</p>
                <p data-testid="measure-offer">{measureOffer.sentence}</p>
                <p className="text-xs text-ink-2">Worked out for each row, and for the total, from their own totals; nothing shows where it would divide by zero.</p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setCatalog({ ...catalog, metrics: [...catalog.metrics, measureOffer.metric] });
                      setMeasureOffer(null);
                      setRedraftFor(selected.id);
                    }}
                    className="min-h-8 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel"
                  >
                    Add {measureOffer.metric.label}
                  </button>
                  <button type="button" onClick={() => setMeasureOffer(null)} className="min-h-8 rounded-md border border-line bg-panel px-2.5 text-xs">
                    Not now
                  </button>
                </div>
              </section>
            )}
            {miss && (
              <DraftMiss
                miss={miss}
                index={index}
                busy={busy !== null}
                onUseMeasure={(label) => {
                  updateFlag(selected.id, { brief: `${selected.brief.trimEnd()} ${label}`.trim().slice(0, LIMITS.briefChars) });
                  setDraftMiss(null);
                  setRedraftFor(selected.id);
                }}
                onLearn={(word, sug) => {
                  onLearn(word, sug);
                  setDraftMiss(null);
                }}
                onData={() => setDataOpen(true)}
                onDismiss={() => setDraftMiss(null)}
              />
            )}
            <div className="min-h-0 flex-1">
              <PanelBoundary key={selected.id} name="inspector" variant="inline" onClose={() => setSelectedId(null)}>
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
                  onAccept={() => onAcceptFlag(selected.id)}
                  onSeeAsLeadership={() => setView('ask')}
                  onDuplicate={() => duplicateFlag(selected.id)}
                  onDelete={() => removeFlag(selected.id)}
                  onClose={() => setSelectedId(null)}
                  onLearn={onLearn}
                  onOpenDesign={() => setDesignOpen(true)}
                  onUseForPage={() =>
                    change((h) => {
                      const { look: _look, ...rest } = h.design ?? {};
                      return { ...h, design: { ...rest, charts: { ...rest.charts, ...chartLookOf(selected.style) } }, flags: h.flags.map((f) => ({ ...f, style: withoutChartLook(f.style) })) };
                    })
                  }
                  onSaveFlag={(format, result) => {
                    void import('./lib/export.ts')
                      .then(async ({ exportFlagOf, saveFlag }) => saveFlag(format, await exportFlagOf({ flag: selected, result, insights: [] }, index, hoist.design)))
                      .then((name) => notify(`Saved ${name}.`, { tone: 'success' }), (e: Error) => notify(e.message, { tone: 'error' }));
                  }}
                />
              </PanelBoundary>
            </div>
          </div>
        )}
      </div>

      {playbookOpen && (
        <Panel name="playbook" onClose={() => setPlaybookOpen(false)}>
          <PlaybookPanel
            playbook={playbook}
            index={index}
            user={user}
            reviewer={server?.reviewer ?? ''}
            style={teamStyle}
            initialTab={playbookTab}
            onClose={() => {
              setPlaybookOpen(false);
              setPlaybookTab(undefined);
            }}
            onAnswer={answerQuestionItem}
          />
        </Panel>
      )}

      {signalOpen && (
        <Panel name="Signal Book" onClose={() => setSignalOpen(false)}>
        <SignalBook hoist={hoist} catalog={catalog} playbook={playbook} user={user} onClose={() => setSignalOpen(false)}
          onTry={(t) => {
            setSignalOpen(false);
            if (t.kind === 'brief') addBriefFlag(t.title, t.brief);
            else if (t.panel === 'playbook' || t.panel === 'away') (setPlaybookTab(t.panel === 'away' ? 'away' : undefined), setPlaybookOpen(true));
            else ({ data: setDataOpen, qlik: setQlikOpen, kits: setKitsOpen, lineage: setLineageOpen })[t.panel](true);
          }}
        />
        </Panel>
      )}

      {kitsOpen && (
        <Panel name="kits panel" onClose={() => setKitsOpen(false)}>
          <KitsPanel
            store={kitStore}
            hoist={hoist}
            index={index}
            onClose={() => setKitsOpen(false)}
            onApply={(h, summary) => {
              autoSnap('Flying a kit');
              change(h);
              notify(summary, { tone: 'success' });
            }}
          />
        </Panel>
      )}

      {dataOpen && (
        <Panel name="Data panel" onClose={() => setDataOpen(false)}>
          <DataPanel
            catalog={catalog}
            server={server}
            localSources={ctx.localSources}
            notes={profileNotes}
            busy={busy}
            onClose={() => setDataOpen(false)}
            onCatalog={setCatalog}
            ctx={ctx}
            provider={draftingProvider(index, ai, useAi)}
            onLineage={() => setLineageOpen(true)}
            onAddCsv={addCsv}
            onRemoveSource={removeSource}
            onProfile={profile}
            onLoadExample={loadExample}
            onImportQlik={() => {
              setDataOpen(false);
              setQlikOpen(true);
            }}
          />
        </Panel>
      )}

      {briefing && (
        <PanelBoundary name="briefing" onClose={() => setBriefing(null)}>
          <BriefingPanel
            briefing={briefing}
            flags={hoist.flags}
            onFlag={(id) => {
              setSelectedId(id);
              document.querySelector(`[data-flag="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
            }}
            onClose={() => setBriefing(null)}
          />
        </PanelBoundary>
      )}

      {shareOpen && (
        <Panel name="share dialog" onClose={() => setShareOpen(false)}>
          <ShareDialog
            title={hoist.title}
            selections={Object.values(selections).filter((v) => v.length).length}
            onClose={() => setShareOpen(false)}
            onExport={async (format, { passphrase, selectedOnly }) => {
              if (format === 'html') {
                const frozen = await freezeHoist(hoist, ctx, index, { keepRaw: true, keepDrill: true });
                const { buildReportHtml, download, reportPayload } = await import('./lib/share.ts');
                const html = await buildReportHtml(reportPayload(hoist, frozen, catalog, user, theme, server?.skin || skin), passphrase || undefined);
                const name = `${fileStem(hoist.title)}-${new Date().toISOString().slice(0, 10)}.html`;
                download(name, html);
                return name;
              }
              const slice = planSlice(hoist);
              const sliceKey = cachedSliceKey(hoist);
              const frozen = await freezeHoist(hoist, ctx, index, selectedOnly ? { selectionsFor: (f) => relevantSelections(selections, pageKeysFor(slice, sliceKey, f, index), f.behavior) } : {});
              const picked = selectedOnly
                ? Object.entries(selections).flatMap(([key, values]) => {
                    const [field, grain] = key.split('@');
                    return values.length ? [`${index.field(field!)?.label ?? field}: ${values.map((v) => formatDim(v, grain as TimeGrain | undefined)).join(', ')}`] : [];
                  })
                : [];
              const { buildDocument, saveDocument } = await import('./lib/export.ts');
              const doc = await buildDocument({ title: hoist.title, brief: hoist.brief, by: user, filters: [...hoist.filters.map((f) => filterText(f, index)), ...picked], flags: frozen, index, design: hoist.design });
              return saveDocument(format, doc);
            }}
          />
        </Panel>
      )}

      {designOpen && (
        <Panel name="page design" onClose={() => setDesignOpen(false)}>
          <DesignDialog design={hoist.design} onClose={() => setDesignOpen(false)} onChange={(design) => change((h) => ({ ...h, design }), 'design')} />
        </Panel>
      )}

      {lineageOpen && (
        <Panel name="lineage view" onClose={() => setLineageOpen(false)}>
          <LineageView catalog={catalog} hoist={hoist} onClose={() => setLineageOpen(false)} />
        </Panel>
      )}

      {sqlOpen && server && (
        <Panel name="SQL desk" onClose={() => setSqlOpen(false)}>
          <SqlDesk sources={server.sources} onClose={() => setSqlOpen(false)} />
        </Panel>
      )}

      {qlikOpen && (
        <Panel name="Qlik import" onClose={() => setQlikOpen(false)}>
          <QlikImport sources={server?.sources ?? []} busy={busy} onImport={importQlik} onDraftAsFlag={addBriefFlag} ai={ai?.configured && useAi ? aiLabel(ai) : null} onReadWithAi={readQlikWithAi} onAddMeasures={addMeasures} onClose={() => setQlikOpen(false)} />
        </Panel>
      )}

      {snapshotsOpen && (
        <Panel name="snapshots" onClose={() => setSnapshotsOpen(false)}>
          <SnapshotsDialog
            hoist={hoist}
            catalog={catalog}
            index={index}
            onClose={() => setSnapshotsOpen(false)}
            onRestore={(h) => {
              change(h);
              setSelections({});
              setSelectedId(null);
            }}
          />
        </Panel>
      )}
      {openList && (
        <Panel name="open hoist" onClose={() => setOpenList(null)}>
          <OpenHoistDialog items={openList} onOpen={(id) => void openFromServer(id)} onClose={() => setOpenList(null)} />
        </Panel>
      )}
      {paletteOpen && (
        <Panel name="command palette" onClose={() => setPaletteOpen(false)}>
          <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
        </Panel>
      )}
      {(assistantOrb || assistantWanted) && (
        <Suspense fallback={null}>
          <AssistantRoot
            orb={assistantOrb}
            ai={ai}
            aiOn={!!ai?.configured && useAi}
            page={{ title: hoist.title, brief: hoist.brief, flags: hoist.flags.map((f) => ({ title: f.title, kind: f.kind, brief: f.brief })) }}
          />
        </Suspense>
      )}

      {helpOpen && (
        <Panel name="help" onClose={() => setHelpOpen(false)}>
          <HelpDialog index={index} onClose={() => setHelpOpen(false)} onPalette={() => setPaletteOpen(true)} onTry={(brief) => addBriefFlag(brief.slice(0, 60), brief)} />
        </Panel>
      )}
      {overlays}
    </div>
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

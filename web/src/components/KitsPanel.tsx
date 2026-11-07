// Flag kits: save some of this page's flags as a kit, and fly a kit on this page. Applying shows
// what remapped to what and what could not be matched before anything is added.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, CircleSlash, Download, LayoutDashboard, Package, Upload, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { applyKit, exportKit, type FlagOutcome, type FlagReport, type Kit, kitId, KIT_LIMITS, makeKit, type Mapping, parseKitText } from '../../../src/core/kits.ts';
import type { KitStore } from '../lib/kits.ts';
import { download } from '../lib/share.ts';
import { recordSkill } from '../lib/skills.ts';
import { EmptyState } from './EmptyState.tsx';

export interface KitsPanelProps {
  store: KitStore;
  hoist: Hoist;
  index: CatalogIndex;
  onApply: (hoist: Hoist, summary: string) => void;
  onClose: () => void;
}

const OUTCOME: Record<FlagOutcome, { label: string; hint: string }> = {
  kept: { label: 'As saved', hint: 'Every metric and field was found under its own name.' },
  remapped: { label: 'Remapped: check it', hint: 'Wired to different names in this catalog. It arrives as a draft.' },
  partial: { label: 'Partly: check it', hint: 'Wired, but some parts could not follow and were left out. It arrives as a draft.' },
  unbound: { label: 'Not wired', hint: 'A metric or field has no match. The flag arrives empty, with its title and brief, so you can draft it again.' },
};

function OutcomeIcon({ outcome }: { outcome: FlagOutcome }) {
  if (outcome === 'kept') return <Check size={13} aria-hidden="true" />;
  if (outcome === 'unbound') return <CircleSlash size={13} aria-hidden="true" />;
  if (outcome === 'partial') return <AlertTriangle size={13} aria-hidden="true" />;
  return <ArrowRight size={13} aria-hidden="true" />;
}

const TIER: Record<string, string> = { exact: 'same name', label: 'same label', synonym: 'synonym', similar: 'close match' };

export function KitsPanel({ store, hoist, index, onApply, onClose }: KitsPanelProps) {
  const [tab, setTab] = useState<'apply' | 'save'>(store.kits.length ? 'apply' : 'save');
  const [selectedId, setSelectedId] = useState<string | null>(store.kits[0]?.id ?? null);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string[] } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Keyboard: focus moves into the dialog and returns to the button that opened it; Escape closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => opener?.focus();
  }, []);

  const selected = store.kits.find((k) => k.id === selectedId) ?? store.kits[0] ?? null;

  const importFile = async (file: File) => {
    const parsed = parseKitText(await file.text());
    if (!parsed.kit) {
      setMessage({ tone: 'bad', text: [`Could not read ${file.name} as a kit.`, ...parsed.errors.slice(0, 5)] });
      return;
    }
    const kit: Kit = { ...parsed.kit, id: kitId(parsed.kit.name, store.kits.map((k) => k.id)) };
    try {
      await store.save(kit);
      setSelectedId(kit.id);
      setTab('apply');
      setMessage({ tone: 'good', text: [`Added the kit "${kit.name}" (${kit.flags.length} flags).`] });
    } catch (e) {
      setMessage({ tone: 'bad', text: [(e as Error).message] });
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        ref={dialog}
        role="dialog"
        aria-label="Flag kits"
        tabIndex={-1}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className="flex h-full w-[600px] max-w-full flex-col border-l border-line bg-panel shadow-xl outline-none"
      >
        <header className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Package size={16} className="text-brass" aria-hidden="true" />
            <h2 className="flex-1 text-base font-semibold">Flag kits</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-2">
            A kit is a set of flags you can fly on another page or another catalog. Flying one wires each flag to the closest matching metric and field here, says what it could not match, and never guesses. Kept in{' '}
            {store.where === 'shared folder' ? 'the shared Semaphore folder' : 'this browser only (start Semaphore with its server to share them; or export a file)'}.
          </p>
        </header>
        <div className="flex gap-1 border-b border-line px-3" role="tablist" aria-label="Kits">
          {(
            [
              ['apply', `Fly a kit (${store.kits.length})`],
              ['save', 'Save a kit'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`kits-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="kits-body"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-semibold' : 'border-transparent text-ink-3 hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" onClick={() => fileInput.current?.click()} className="my-1 flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs hover:border-accent">
            <Upload size={13} aria-hidden="true" /> Import a kit file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importFile(f);
            }}
          />
        </div>
        <div id="kits-body" role="tabpanel" aria-labelledby={`kits-tab-${tab}`} className="scroll-thin flex-1 overflow-y-auto p-4">
          {message && (
            <div role={message.tone === 'bad' ? 'alert' : 'status'} className={`mb-3 rounded-md border px-3 py-2 text-xs ${message.tone === 'bad' ? 'border-bad bg-bad-soft text-bad' : 'border-good bg-good-soft text-good'}`}>
              {message.text.map((t, i) => (
                <p key={i}>{t}</p>
              ))}
            </div>
          )}
          {tab === 'save' ? (
            <SaveTab
              hoist={hoist}
              index={index}
              existing={store.kits.map((k) => k.id)}
              onSave={async (kit, warnings) => {
                if (!kit) {
                  setMessage({ tone: 'bad', text: warnings });
                  return;
                }
                try {
                  await store.save(kit);
                  recordSkill('kit', { hoistId: hoist.id });
                  setSelectedId(kit.id);
                  setMessage({ tone: 'good', text: [`Saved the kit "${kit.name}" with ${kit.flags.length} flag${kit.flags.length === 1 ? '' : 's'}.`, ...warnings] });
                } catch (e) {
                  setMessage({ tone: 'bad', text: [(e as Error).message] });
                }
              }}
            />
          ) : (
            <ApplyTab
              store={store}
              kit={selected}
              hoist={hoist}
              index={index}
              onSelect={setSelectedId}
              onApply={(h, summary) => {
                onApply(h, summary);
                recordSkill('fly', { hoistId: hoist.id });
                onClose();
              }}
              onMessage={setMessage}
              onSaveTab={() => setTab('save')}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function SaveTab({ hoist, index, existing, onSave }: { hoist: Hoist; index: CatalogIndex; existing: string[]; onSave: (kit: Kit | null, warnings: string[]) => Promise<void> }) {
  const candidates = hoist.flags.filter((f) => f.binding || f.kind === 'text' || f.brief.trim());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.filter((f) => f.binding || f.kind === 'text').map((f) => f.id)));
  const [layout, setLayout] = useState(true);
  const [pageFilters, setPageFilters] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async () => {
    const made = makeKit(hoist, index, { name, description, flagIds: [...picked], layout, pageFilters, id: kitId(name, existing) });
    if (!made.kit) {
      await onSave(null, made.warnings);
      return;
    }
    setBusy(true);
    await onSave(made.kit, made.warnings);
    setBusy(false);
    setName('');
    setDescription('');
  };

  if (candidates.length === 0) return <EmptyState compact icon={LayoutDashboard} headline="No flags on this page yet." body="Add and wire some flags, then save the ones you reuse as a kit." />;

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && picked.size) void submit();
      }}
    >
      <label className="block text-xs font-semibold">
        Kit name
        <input value={name} maxLength={KIT_LIMITS.nameChars} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-normal" />
      </label>
      <label className="block text-xs font-semibold">
        What it is for (optional)
        <textarea value={description} maxLength={KIT_LIMITS.descriptionChars} rows={2} onChange={(e) => setDescription(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-normal" />
      </label>
      <fieldset>
        <legend className="text-xs font-semibold">Flags to include ({picked.size} of {candidates.length})</legend>
        <ul className="mt-1 space-y-1">
          {candidates.map((f) => (
            <li key={f.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm hover:border-accent">
                <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} />
                <span className="flex-1 truncate">{f.title || f.brief || 'Untitled flag'}</span>
                <span className="text-[11px] text-ink-3">{f.kind}{f.binding ? '' : f.kind === 'text' ? '' : ', not wired'}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="space-y-1.5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={layout} onChange={(e) => setLayout(e.target.checked)} /> Keep sizes and positions
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={pageFilters} onChange={(e) => setPageFilters(e.target.checked)} /> Keep this page's fixed filters ({hoist.filters.length})
        </label>
      </div>
      <p className="text-[11px] text-ink-3">
        A kit holds the flags' briefs, metrics, fields, filters and colour rules, with each name's label, type and synonyms so it can be matched in another catalog. It never holds data rows or connection details. A fixed filter's values (region = East) are saved as written.
      </p>
      <button type="submit" disabled={busy || !name.trim() || picked.size === 0} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
        Save the kit
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

function ApplyTab({
  store,
  kit,
  hoist,
  index,
  onSelect,
  onApply,
  onMessage,
  onSaveTab,
}: {
  onSaveTab: () => void;
  store: KitStore;
  kit: Kit | null;
  hoist: Hoist;
  index: CatalogIndex;
  onSelect: (id: string) => void;
  onApply: (hoist: Hoist, summary: string) => void;
  onMessage: (m: { tone: 'good' | 'bad'; text: string[] } | null) => void;
}) {
  const [closeMatches, setCloseMatches] = useState(false);
  const [pageFilters, setPageFilters] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [kit?.id]);

  // The preview is the real thing: the same function the button runs.
  const result = useMemo(() => (kit ? applyKit(kit, hoist, index, { closeMatches, pageFilters }) : null), [kit, hoist, index, closeMatches, pageFilters]);

  if (!kit || !result) {
    return <EmptyState compact icon={Package} headline="No kits yet." body="Save flags you reuse as a kit and fly them on any page. You can also import a kit file." action={{ label: "Save this page's flags as a kit", onClick: onSaveTab }} />;
  }
  const { report } = result;
  const c = report.counts;
  const summary = `${kit.flags.length} flag${kit.flags.length === 1 ? '' : 's'}: ${c.kept} as saved, ${c.remapped} remapped, ${c.partial} partly, ${c.unbound} not wired.`;

  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-1.5" aria-label="Saved kits">
        {store.kits.map((k) => (
          <li key={k.id}>
            <button
              type="button"
              aria-pressed={k.id === kit.id}
              onClick={() => onSelect(k.id)}
              className={`rounded-md border px-2.5 py-1 text-sm ${k.id === kit.id ? 'border-accent bg-accent-soft font-semibold' : 'border-line hover:border-accent'}`}
            >
              {k.name} <span className="text-[11px] text-ink-3">({k.flags.length})</span>
            </button>
          </li>
        ))}
      </ul>

      <section aria-label={`Kit ${kit.name}`} className="rounded-lg border border-line p-3">
        <h3 className="text-sm font-semibold">{kit.name}</h3>
        {kit.description && <p className="mt-0.5 text-xs text-ink-2">{kit.description}</p>}
        <p className="mt-0.5 text-[11px] text-ink-3">
          {kit.flags.length} flags · saved {kit.created.slice(0, 10)}
          {kit.from?.title ? ` from "${kit.from.title}"` : ''}
          {kit.filters.length ? ` · with ${kit.filters.length} page filter${kit.filters.length === 1 ? '' : 's'}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => download(`${kit.id}.kit.json`, exportKit(kit), 'application/json')} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs hover:border-accent">
            <Download size={13} aria-hidden="true" /> Export a file
          </button>
          {confirmDelete ? (
            <>
              <button
                type="button"
                onClick={() => store.remove(kit.id).then(() => onMessage({ tone: 'good', text: [`Deleted the kit "${kit.name}".`] }), (e: Error) => onMessage({ tone: 'bad', text: [e.message] }))}
                className="rounded-md border border-bad px-2 py-1 text-xs font-semibold text-bad"
              >
                Yes, delete it
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent">
                Keep it
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-md border border-line px-2 py-1 text-xs hover:border-bad hover:text-bad">
              Delete
            </button>
          )}
        </div>
      </section>

      <div className="space-y-1.5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={closeMatches} onChange={(e) => setCloseMatches(e.target.checked)} /> Also use close matches (names that only share some words; those flags arrive as drafts)
        </label>
        {kit.filters.length > 0 && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={pageFilters} onChange={(e) => setPageFilters(e.target.checked)} /> Add the kit's {kit.filters.length} page filter{kit.filters.length === 1 ? '' : 's'} to this page
          </label>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold">What will happen here</h3>
        <p className="mt-0.5 text-xs text-ink-2" role="status">
          {report.applied ? summary : report.problems[0]}
        </p>
        {report.applied && report.problems.length > 0 && <p className="mt-1 text-xs text-warn">{report.problems.slice(0, 3).join(' ')}</p>}
        <ul className="mt-2 space-y-2">
          {report.flags.map((f) => (
            <FlagLine key={f.flagId} f={f} />
          ))}
        </ul>
        {report.pageFilters.length > 0 && (
          <div className="mt-3">
            <h4 className="text-xs font-semibold">Page filters</h4>
            <ul className="mt-1 space-y-0.5">
              {report.pageFilters.map((m, i) => (
                <li key={i} className="text-xs">
                  <MappingText m={m} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={!report.applied || kit.flags.length === 0}
        onClick={() => onApply(result.hoist, `Added ${kit.flags.length} flag${kit.flags.length === 1 ? '' : 's'} from the kit "${kit.name}": ${c.kept + c.remapped + c.partial} wired, ${c.unbound} not wired. Check the drafts before accepting them.`)}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40"
      >
        Add {kit.flags.length} flag{kit.flags.length === 1 ? '' : 's'} to this page
      </button>
    </div>
  );
}

function FlagLine({ f }: { f: FlagReport }) {
  const shown = f.mappings.filter((m) => !m.to || m.from.key !== m.to.key);
  const o = OUTCOME[f.outcome];
  return (
    <li className="rounded-lg border border-line p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm font-medium">{f.title || `(${f.kind} flag with no title)`}</span>
        <span title={o.hint} className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${f.outcome === 'kept' ? 'bg-good-soft text-good' : f.outcome === 'unbound' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn'}`}>
          <OutcomeIcon outcome={f.outcome} /> {o.label}
        </span>
      </div>
      {(shown.length > 0 || f.dropped.length > 0) && (
        <ul className="mt-1.5 space-y-0.5">
          {shown.map((m, i) => (
            <li key={i} className="text-xs">
              <MappingText m={m} />
            </li>
          ))}
          {f.dropped.map((d, i) => (
            <li key={`d${i}`} className="text-xs text-warn">
              Left out: {d}.
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MappingText({ m }: { m: Mapping }) {
  if (m.to) {
    return (
      <span>
        <span className="text-ink-2">{m.from.label}</span> <ArrowRight size={11} className="inline" aria-label="became" /> <span className="font-medium">{m.to.label}</span>{' '}
        <span className="text-[11px] text-ink-3">({TIER[m.tier ?? 'exact']}{m.from.key === m.to.key ? '' : `, ${m.from.key} → ${m.to.key}`})</span>
      </span>
    );
  }
  return (
    <span className="text-bad">
      No match for "{m.from.label}" ({m.role}). {m.reason}
      {m.suggestions.length > 0 && <span className="text-ink-2"> Closest: {m.suggestions.map((s) => `"${s.label}"`).join(', ')}.</span>}
    </span>
  );
}

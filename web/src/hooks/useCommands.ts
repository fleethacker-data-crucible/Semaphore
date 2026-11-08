// The builder's one action list (#77, #85). The header's menus pick their items from it by id, and the
// command palette shows all of it together with the flags on the page, saved hoists, the catalog's
// measures and fields, and waiting questions.

import { useEffect, useMemo, useState } from 'react';
import type { Catalog } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import type { QuestionItem } from '../../../src/core/playbook.ts';
import { listItems, type StoredItem } from '../lib/api.ts';
import type { Command } from '../lib/commands.ts';

export type ActionId =
  | 'new' | 'open' | 'import' | 'download' | 'share' | 'design' | 'assistant' | 'brief' | 'kits' | 'sql' | 'lineage' | 'qlik'
  | 'playbook' | 'data' | 'leadership' | 'home' | 'undo' | 'redo' | 'ask' | 'draft-page' | 'starter' | 'experiment'
  | 'theme' | 'skin' | 'ai' | 'examples' | 'help' | 'palette' | 'end' | 'signals' | 'settings' | 'snapshots';

export type Actions = Record<ActionId, Command>;

export interface CommandDeps {
  hasServer: boolean;
  hasSql: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasBrief: boolean;
  hasFlags: boolean;
  experiment: boolean;
  theme: 'light' | 'dark';
  skinLabel: string | null;
  ai: { configured: boolean; on: boolean } | null;
  examplesOn: boolean | null;
  /** The Signal Book is switched on for this deployment (settings.json signalBook). */
  signalBook: boolean;
  run: Record<ActionId, () => void>;
}

export function buildActions(d: CommandDeps): Actions {
  const a = (id: ActionId, label: string, extra: Partial<Command> = {}): Command => ({ id: `action:${id}`, label, group: 'Actions', run: d.run[id], ...extra });
  return {
    new: a('new', 'New hoist', { keywords: 'blank page create' }),
    open: a('open', 'Open a saved hoist…', { disabled: !d.hasServer, hint: 'From the Semaphore folder' }),
    import: a('import', 'Import a hoist file…', { keywords: 'upload json' }),
    download: a('download', 'Download this hoist (JSON)', { keywords: 'export save file' }),
    snapshots: a('snapshots', 'Snapshots…', { disabled: !d.hasServer, hint: 'Save this page as it is, or go back to a saved one', keywords: 'restore version history backup undo save point' }),
    share: a('share', 'Export or share…', { hint: 'PDF, Excel, PowerPoint, Word, HTML, CSV or JSON', keywords: 'export html pdf excel xlsx powerpoint pptx word docx csv json report download' }),
    assistant: a('assistant', 'Semaphore assistant', { hint: 'Ask how to do something in Semaphore', keywords: 'help ask ai chat orb question how' }),
    design: a('design', 'Page design…', { hint: 'Colours, cards, backdrop, type and motion', keywords: 'look style theme palette colour color animation effects' }),
    brief: a('brief', 'Brief me', { hint: 'What this page says, as leadership would read it', keywords: 'summary briefing' }),
    kits: a('kits', 'Flag kits…', { hint: 'Save flags as a kit, or fly a kit on this page', keywords: 'template reuse' }),
    sql: a('sql', 'SQL desk…', { disabled: !d.hasSql, hint: 'Write your own SELECT against a source', keywords: 'query database' }),
    lineage: a('lineage', 'Lineage', { hint: 'Where each flag’s numbers come from', keywords: 'sources trace' }),
    qlik: a('qlik', 'Import from Qlik…', { keywords: 'qvf script expressions' }),
    playbook: a('playbook', 'Playbook', { hint: 'What leadership can ask for, their questions, what needs review' }),
    data: a('data', 'Data', { hint: 'Sources, the catalog, cleaning and links', keywords: 'csv catalog measures fields add' }),
    leadership: a('leadership', 'Leadership view', { hint: 'Ask a question, get an answer', keywords: 'ask view' }),
    home: a('home', 'Home: the welcome page', { keywords: 'welcome start' }),
    undo: a('undo', 'Undo', { shortcut: 'Ctrl+Z', disabled: !d.canUndo }),
    redo: a('redo', 'Redo', { shortcut: 'Ctrl+Y', disabled: !d.canRedo }),
    ask: a('ask', 'Quick chart from a question', { shortcut: '/', keywords: 'ask chart question' }),
    'draft-page': a('draft-page', d.hasFlags ? 'Add drafted flags from the brief' : 'Draft the page from the brief', { disabled: d.busy || !d.hasBrief, keywords: 'draft generate' }),
    starter: a('starter', 'Draft a starter page from the catalog', { disabled: d.busy, keywords: 'draft generate' }),
    experiment: a('experiment', d.experiment ? 'Make this a normal page' : 'Mark this page as an experiment', { hint: 'The playbook and team style never learn from an experiment', keywords: 'try freely' }),
    theme: a('theme', d.theme === 'dark' ? 'Light theme (Chart room)' : 'Dark theme (Night watch)', { keywords: 'theme dark light colour color' }),
    skin: a('skin', `Skin: ${d.skinLabel ?? ''}`, { disabled: d.skinLabel === null, hint: 'Switch to the next skin', keywords: 'look style classic fleet' }),
    ai: a('ai', d.ai?.configured ? (d.ai.on ? 'AI drafting: Fairlead (turn off)' : 'AI drafting: off (turn on)') : 'AI drafting: local rules', { disabled: !d.ai, keywords: 'fairlead model' }),
    examples: a('examples', d.examplesOn ? 'Reviewed examples: on (turn off)' : 'Reviewed examples: off (turn on)', { disabled: d.examplesOn === null, keywords: 'ai privacy' }),
    settings: a('settings', 'Settings', { hint: 'Look, Lazarette, AI drafting and your feature switches', keywords: 'preferences lazarette pair vault features options' }),
    help: a('help', 'Help and keyboard shortcuts', { shortcut: '?', keywords: 'phrasebook shakedown keys' }),
    palette: a('palette', 'Command palette', { shortcut: 'Ctrl+K' }),
    signals: a('signals', 'Signal Book', { disabled: !d.signalBook, hint: 'Your private flags for what you have tried, and your watch log', keywords: 'skills progress learn watch log' }),
    end: a('end', 'End session…', { disabled: !d.hasServer, hint: 'Save, then stop the Semaphore server', keywords: 'quit stop exit' }),
  };
}

export interface PaletteSources {
  actions: Actions;
  open: boolean;
  hasServer: boolean;
  flags: Flag[];
  catalog: Catalog;
  questions: QuestionItem[];
  onSelectFlag: (id: string) => void;
  onOpenHoist: (id: string) => void;
  onInsert: (label: string) => void;
  onAnswer: (q: QuestionItem) => void;
}

/** Everything the palette lists. Saved hoists are read when the palette opens. */
export function useCommands(p: PaletteSources): Command[] {
  const [saved, setSaved] = useState<StoredItem[]>([]);
  useEffect(() => {
    if (!p.open || !p.hasServer) return;
    listItems('hoists').then(setSaved, () => setSaved([]));
  }, [p.open, p.hasServer]);
  return useMemo(() => {
    if (!p.open) return [];
    const out: Command[] = Object.values(p.actions).filter((c) => c.id !== 'action:palette');
    for (const f of p.flags) out.push({ id: `flag:${f.id}`, label: f.title || f.brief || `Untitled ${f.kind}`, group: 'Flags on this page', hint: `Select this ${f.kind} flag`, keywords: f.brief, run: () => p.onSelectFlag(f.id) });
    for (const h of saved) out.push({ id: `hoist:${h.id}`, label: h.title || h.id, group: 'Saved hoists', hint: h.updated ? `Saved ${new Date(h.updated).toLocaleString()}` : 'Open it', run: () => p.onOpenHoist(h.id) });
    for (const m of p.catalog.metrics) out.push({ id: `metric:${m.key}`, label: `Insert “${m.label}” into the brief`, group: 'Catalog', hint: 'Measure', keywords: `${m.label} ${(m.synonyms ?? []).join(' ')}`, run: () => p.onInsert(m.label) });
    for (const f of p.catalog.fields) out.push({ id: `field:${f.key}`, label: `Insert “${f.label}” into the brief`, group: 'Catalog', hint: 'Field', keywords: `${f.label} ${(f.synonyms ?? []).join(' ')}`, run: () => p.onInsert(f.label) });
    for (const q of p.questions.filter((x) => x.status === 'open')) out.push({ id: `question:${q.id}`, label: q.title, group: 'Questions', hint: `Asked by ${q.askedBy}: answer it with a flag`, run: () => p.onAnswer(q) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.actions, p.flags, p.catalog, p.questions, saved]);
}

// The builder's header (#77, #85): the brand and the hoist title on the left, undo and redo, the quick
// chart box, then at most six controls: Hoist ▾ (new, open, import, download, share, brief me, kits,
// SQL), Playbook, Data, Leadership view, Help and Settings (components/SettingsDialog.tsx).
// The actions themselves come from the page's one action list, which the command palette shows too.

import type { ReactNode } from 'react';
import { BookMarked, BookOpen, ChevronDown, CircleHelp, Database, Download, FileDown, FilePlus2, FileText, FlaskConical, FolderOpen, GitBranch, MessagesSquare, Package, Redo2, ScrollText, Settings2, TerminalSquare, Undo2, Upload } from 'lucide-react';
import { LIMITS } from '../../../src/core/hoist.ts';
import type { Command } from '../lib/commands.ts';
import type { Actions } from '../hooks/useCommands.ts';
import { type MenuEntry, MenuButton, type MenuSection } from './Menu.tsx';

export interface HeaderProps {
  title: string;
  onTitle: (title: string) => void;
  onHome: () => void;
  experiment: boolean;
  onExperiment: () => void;
  /** Chips that come and go: "While you were out", the report schedule. */
  chips?: ReactNode;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  askBox: ReactNode;
  /** The page's action list (hooks/useCommands.ts); the menus show these. */
  actions: Actions;
  waiting: number;
  onPlaybook: () => void;
  onData: () => void;
  onLeadership: () => void;
  onHelp: () => void;
  onSettings: () => void;
}

const pill = 'flex min-h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:border-accent';

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2 disabled:opacity-30">
      {children}
    </button>
  );
}

function entry(c: Command, icon: ReactNode, extra: Partial<MenuEntry> = {}): MenuEntry {
  return { id: c.id, label: c.label, icon, run: c.run, ...(c.shortcut ? { shortcut: c.shortcut } : {}), ...(c.hint ? { hint: c.hint } : {}), ...(c.disabled ? { disabled: true } : {}), ...extra };
}

export function Header(p: HeaderProps) {
  const left = LIMITS.titleChars - p.title.length;
  const a = p.actions;
  const hoistMenu: MenuSection[] = [
    { items: [entry(a.new, <FilePlus2 size={15} />), ...(a.open.disabled ? [] : [entry(a.open, <FolderOpen size={15} />)]), entry(a.import, <Upload size={15} />), entry(a.download, <Download size={15} />)] },
    { label: 'Share', items: [entry(a.share, <FileDown size={15} />), entry(a.brief, <ScrollText size={15} />)] },
    { label: 'Build', items: [entry(a.kits, <Package size={15} />), entry(a.lineage, <GitBranch size={15} />), ...(a.sql.disabled ? [] : [entry(a.sql, <TerminalSquare size={15} />)])] },
    ...(a.signals.disabled ? [] : [{ label: 'You', items: [entry(a.signals, <BookMarked size={15} />)] }]),
  ];
  return (
    <header className="flex min-h-14 items-center gap-3 border-b border-line bg-panel px-4 py-2">
      <img src="brand/mark.svg" alt="" className="header-mark h-7 w-7" />
      <div className="flex min-w-0 flex-col">
        <button type="button" onClick={p.onHome} title="Home: the welcome page" className="self-start text-[10px] font-semibold uppercase tracking-[0.18em] text-brass hover:underline">
          Semaphore
        </button>
        <div className="flex items-center gap-1">
          <input
            value={p.title}
            maxLength={LIMITS.titleChars}
            onChange={(e) => p.onTitle(e.target.value)}
            aria-label="Hoist title"
            aria-describedby={left <= 15 ? 'title-left' : undefined}
            className="-ml-1 w-[clamp(140px,18vw,280px)] min-w-0 rounded border border-transparent bg-transparent px-1 text-[15px] font-semibold leading-tight hover:border-line focus:border-accent focus:outline-none"
          />
          {left <= 15 && (
            <span id="title-left" className={`shrink-0 text-[11px] tabular-nums ${left === 0 ? 'text-bad' : 'text-ink-3'}`}>
              {left === 0 ? 'Limit reached' : `${left} left`}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={p.onExperiment}
        aria-pressed={p.experiment}
        title={p.experiment ? 'Experiment page: never learnt from. Click to make it a normal page.' : 'Mark this page as an experiment: try anything, and the playbook and team style never learn from it.'}
        className={`flex min-h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] ${p.experiment ? 'border-warn bg-warn-soft font-semibold text-warn' : 'border-line text-ink-3 hover:border-warn hover:text-warn'}`}
      >
        <FlaskConical size={12} aria-hidden="true" /> {p.experiment ? 'Experiment' : 'Try freely'}
      </button>
      {p.chips}
      <div className="flex shrink-0 items-center">
        <IconButton label="Undo (Ctrl+Z)" onClick={p.onUndo} disabled={!p.canUndo}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={p.onRedo} disabled={!p.canRedo}>
          <Redo2 size={16} />
        </IconButton>
      </div>
      <div className="flex min-w-0 flex-1 justify-center">{p.askBox}</div>
      <nav aria-label="Page actions" className="flex shrink-0 items-center gap-1.5">
        <MenuButton
          label="Hoist"
          title="New, open, import, download and share this hoist"
          sections={hoistMenu}
          button={
            <>
              <FileText size={14} aria-hidden="true" className="text-brass" /> Hoist <ChevronDown size={13} aria-hidden="true" className="text-ink-3" />
            </>
          }
        />
        <button type="button" onClick={p.onPlaybook} className={`relative ${pill}`} title="What leadership can ask for, their questions, and what needs review">
          <BookOpen size={14} aria-hidden="true" className="text-brass" /> Playbook
          {p.waiting > 0 && (
            <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold text-accent">{p.waiting} waiting</span>
          )}
        </button>
        <button type="button" onClick={p.onData} className={pill} title="Sources, the catalog, cleaning and links">
          <Database size={14} aria-hidden="true" className="text-brass" /> Data
        </button>
        <button type="button" onClick={p.onLeadership} className={pill} title="The leadership view: ask a question, get an answer">
          <MessagesSquare size={14} aria-hidden="true" className="text-brass" /> Leadership view
        </button>
        <IconButton label="Help and keyboard shortcuts (?)" onClick={p.onHelp}>
          <CircleHelp size={16} />
        </IconButton>
        <IconButton label="Settings" onClick={p.onSettings}>
          <Settings2 size={16} />
        </IconButton>
      </nav>
    </header>
  );
}

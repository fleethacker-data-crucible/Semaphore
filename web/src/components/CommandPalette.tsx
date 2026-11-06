// Ctrl+K command palette (#77): one box that finds every action (with its shortcut), the flags on
// the page, saved hoists, catalog measures and fields, and waiting questions. Fuzzy matching and
// local recency (lib/commands.ts); a modal (useModal) with the combobox pattern, so arrow keys move
// through the list while typing.

import { useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { type Command, GROUP_ORDER, noteCommand, rankCommands, recentCommands } from '../lib/commands.ts';
import { LIMITS } from '../../../src/core/hoist.ts';
import { useModal } from '../lib/modal.ts';

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const recent = useMemo(() => recentCommands(), []);
  const ranked = useMemo(() => rankCommands(commands, q, recent), [commands, q, recent]);
  // Shown grouped when nothing is typed; in score order (with a group label) while searching.
  const list = useMemo(() => (q.trim() ? ranked : [...ranked].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))), [ranked, q]);
  const shownRecent = !q.trim() ? list.filter((c) => recent.includes(c.id)).sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id)) : [];
  const rows = q.trim() ? list : [...shownRecent, ...list.filter((c) => !recent.includes(c.id))];
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const run = (c: Command | undefined) => {
    if (!c) return;
    noteCommand(c.id);
    onClose();
    // After the palette has closed and handed focus back, so a command can move focus or open a dialog.
    window.setTimeout(c.run, 0);
  };

  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-ink/30 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} className="fl-dialog flex max-h-[70vh] w-[600px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-panel shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
          <input
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[at] ? `cmd-${at}` : undefined}
            aria-autocomplete="list"
            aria-label="Search actions, flags, saved hoists and the catalog"
            placeholder="Search actions, flags, saved hoists, measures…"
            value={q}
            maxLength={LIMITS.questionChars}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Home' && e.ctrlKey) setActive(0);
              else if (e.key === 'End' && e.ctrlKey) setActive(rows.length - 1);
              else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[at]);
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-3 text-[15px] outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-3">Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.map((c, i) => {
            const label = i < shownRecent.length ? 'Recent' : c.group;
            const head = label !== lastGroup;
            lastGroup = label;
            return (
              <li key={`${c.id}-${i}`} role="presentation">
                {head && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>}
                <div
                  id={`cmd-${i}`}
                  role="option"
                  aria-selected={i === at}
                  onPointerMove={() => i !== at && setActive(i)}
                  onClick={() => run(c)}
                  className={`flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 ${i === at ? 'bg-accent-soft' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{c.label}</span>
                    {c.hint && <span className="block truncate text-xs text-ink-3">{c.hint}</span>}
                  </span>
                  {c.shortcut && <kbd className="shrink-0 rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{c.shortcut}</kbd>}
                  {i === at && <CornerDownLeft size={14} aria-hidden="true" className="shrink-0 text-ink-3" />}
                </div>
              </li>
            );
          })}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches “{q}”. Try fewer letters, or a measure or flag title.</li>}
        </ul>
        <p className="border-t border-line px-3 py-2 text-[11px] text-ink-3">↑ ↓ to move · Enter to run · Esc to close · ? for every shortcut</p>
      </section>
    </div>
  );
}

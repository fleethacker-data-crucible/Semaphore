// A labelled menu button (WAI-ARIA menu button pattern) for the header's Hoist ▾ and settings menus:
// Enter, Space or ↓ opens it on the first item, ↑ on the last; ↑ ↓ Home End move; Escape or Tab
// closes it and focus goes back to the button; a click outside closes it.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

export interface MenuEntry {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Keys shown on the right, e.g. "Ctrl+K". */
  shortcut?: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** For an on/off setting: shown as a menuitemcheckbox. */
  checked?: boolean;
  /** A file picker instead of a command (Import): the menu item opens it. */
  file?: { accept: string; onFile: (f: File) => void };
  run?: () => void;
}
export type MenuSection = { label?: string; items: MenuEntry[] };

export function MenuButton({ label, button, sections, align = 'end', title }: { label: string; button: ReactNode; sections: MenuSection[]; align?: 'start' | 'end'; title?: string }) {
  const [open, setOpen] = useState(false);
  const [focusAt, setFocusAt] = useState<'first' | 'last'>('first');
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const files = useRef<Record<string, HTMLInputElement | null>>({});
  const id = useId();

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const list = items();
    (focusAt === 'first' ? list[0] : list[list.length - 1])?.focus();
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activate = (item: MenuEntry) => {
    if (item.disabled) return;
    if (item.file) {
      files.current[item.id]?.click();
      close(false);
      return;
    }
    close();
    item.run?.();
  };

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => {
          setFocusAt('first');
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setFocusAt(e.key === 'ArrowDown' ? 'first' : 'last');
            setOpen(true);
          }
        }}
        aria-label={label}
        className={`flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:border-accent ${open ? 'border-accent bg-accent-soft' : 'border-line'}`}
      >
        {button}
      </button>
      {/* File inputs live outside the menu, so a picker opened from it survives the menu closing. */}
      {sections.flatMap((s) => s.items).filter((i) => i.file).map((i) => (
        <input
          key={i.id}
          ref={(el) => {
            files.current[i.id] = el;
          }}
          type="file"
          accept={i.file!.accept}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) i.file!.onFile(f);
          }}
        />
      ))}
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const list = items();
            const at = list.indexOf(document.activeElement as HTMLElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
              list[next]?.focus();
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === 'Tab') close(false);
          }}
          className={`absolute top-full z-[55] mt-1.5 w-[300px] rounded-[10px] border border-line bg-panel p-1.5 shadow-xl ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {sections.map((s, si) => (
            <div key={si} role="group" aria-label={s.label} className={si > 0 ? 'mt-1.5 border-t border-line pt-1.5' : ''}>
              {s.label && <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{s.label}</div>}
              {s.items.map((item) => (
                <div
                  key={item.id}
                  role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  aria-checked={item.checked === undefined ? undefined : item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  title={item.hint}
                  onClick={() => activate(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(item);
                    }
                  }}
                  className={`flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-sm outline-none focus:bg-accent-soft ${item.disabled ? 'cursor-default opacity-40' : 'hover:bg-panel-2'} ${item.danger ? 'text-bad' : 'text-ink'}`}
                >
                  <span aria-hidden="true" className={`grid w-4 shrink-0 place-items-center ${item.danger ? 'text-bad' : 'text-ink-2'}`}>
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.checked !== undefined && <span className={`text-xs font-semibold ${item.checked ? 'text-accent' : 'text-ink-3'}`}>{item.checked ? 'On' : 'Off'}</span>}
                  {item.shortcut && <kbd className="shrink-0 font-mono text-[11px] text-ink-3">{item.shortcut}</kbd>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

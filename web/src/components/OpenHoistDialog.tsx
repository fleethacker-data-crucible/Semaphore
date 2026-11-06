// "Open a hoist": the hoists saved in the Semaphore folder, newest first, as a modal (useModal).

import { useRef } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { StoredItem } from '../lib/api.ts';
import { useModal } from '../lib/modal.ts';

export function OpenHoistDialog({ items, onOpen, onClose }: { items: StoredItem[]; onOpen: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const sorted = [...items].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-24" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="open-title" tabIndex={-1} className="fl-dialog w-[460px] max-w-[calc(100%-2rem)] rounded-[14px] border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FolderOpen size={16} aria-hidden="true" className="text-brass" />
          <h2 id="open-title" className="flex-1 text-base font-semibold">
            Open a hoist
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <ul className="scroll-thin max-h-80 space-y-0.5 overflow-y-auto p-2">
          {sorted.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)} className="w-full rounded-md px-2.5 py-1.5 text-left hover:bg-panel-2">
                <span className="block text-sm font-medium">{item.title || item.id}</span>
                <span className="text-[11px] text-ink-3">{item.updated ? new Date(item.updated).toLocaleString() : ''}</span>
              </button>
            </li>
          ))}
          {sorted.length === 0 && <li className="fl-empty px-3 py-6 text-center text-sm text-ink-3">Nothing saved yet. Hoists you build are saved here as you work.</li>}
        </ul>
      </section>
    </div>
  );
}

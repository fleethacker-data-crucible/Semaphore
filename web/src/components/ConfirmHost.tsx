// Draws the confirmation asked for with lib/confirm.ts, as a modal (useModal): Cancel takes focus
// first on a destructive one, so Enter never confirms by accident.

import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { type ConfirmRequest, settleConfirm, useConfirmRequest } from '../lib/confirm.ts';
import { useModal } from '../lib/modal.ts';

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, () => settleConfirm(false));
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-ink/30 pt-32" onPointerDown={(e) => e.target === e.currentTarget && settleConfirm(false)}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={req.body ? 'confirm-body' : undefined} tabIndex={-1} className="fl-dialog w-[420px] max-w-[calc(100%-2rem)] rounded-[14px] border border-line bg-panel p-5 shadow-xl">
        <h2 id="confirm-title" className="flex items-center gap-2 text-base font-semibold">
          {req.destructive && <AlertTriangle size={16} aria-hidden="true" className="text-bad" />}
          {req.title}
        </h2>
        {req.body && (
          <p id="confirm-body" className="mt-2 text-sm text-ink-2">
            {req.body}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-autofocus={req.destructive ? '' : undefined} onClick={() => settleConfirm(false)} className="min-h-8 rounded-md border border-ink-3 px-3 text-sm hover:bg-panel-2">
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            data-autofocus={req.destructive ? undefined : ''}
            onClick={() => settleConfirm(true)}
            className={`min-h-8 rounded-md px-3 text-sm font-semibold text-panel ${req.destructive ? 'bg-bad hover:opacity-90' : 'bg-accent hover:opacity-90'}`}
          >
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ConfirmHost() {
  const req = useConfirmRequest();
  return req ? <ConfirmDialog key={req.title} req={req} /> : null;
}

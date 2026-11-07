// Toasts (Fleet UI 6 .fl-toast, #69): bottom right. Errors sit in their own role="alert" region,
// carry an icon and the word "Error", and stay until dismissed; info and success are announced
// politely and go after 5 s. The busy line has a region of its own, so it never covers a toast.

import { AlertTriangle, CheckCircle2, Info, LoaderCircle, X } from 'lucide-react';
import { type Toast, toasts, useToasts } from '../lib/toasts.ts';

function ToastCard({ t }: { t: Toast }) {
  const error = t.tone === 'error';
  const Icon = error ? AlertTriangle : t.tone === 'success' ? CheckCircle2 : Info;
  const tone = error ? 'border-bad bg-bad-soft' : t.tone === 'success' ? 'border-good bg-panel' : 'border-line bg-panel';
  return (
    <div className={`fl-toast pointer-events-auto flex w-[380px] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-sm text-ink shadow-lg ${tone}`}>
      <Icon size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${error ? 'text-bad' : t.tone === 'success' ? 'text-good' : 'text-accent'}`} />
      <div className="min-w-0 flex-1">
        <p className="break-words">
          {error && <span className="font-semibold text-bad">Error: </span>}
          {t.text}
        </p>
        {t.secondary && (
          <button
            type="button"
            onClick={() => {
              toasts.dismiss(t.id);
              t.secondary!.run();
            }}
            className="mt-1 min-h-8 rounded-md text-sm font-semibold text-accent hover:underline"
          >
            {t.secondary.label}
          </button>
        )}
      </div>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            toasts.dismiss(t.id);
            t.action!.run();
          }}
          className="-my-1 min-h-8 shrink-0 rounded-md px-2 text-sm font-semibold text-accent hover:bg-accent-soft"
        >
          {t.action.label}
        </button>
      )}
      <button type="button" onClick={() => toasts.dismiss(t.id)} aria-label="Dismiss" title="Dismiss" className="-my-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts({ busy }: { busy?: string | null }) {
  const list = useToasts();
  const errors = list.filter((t) => t.tone === 'error');
  const others = list.filter((t) => t.tone !== 'error');
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
      <div role="alert" className="flex flex-col items-end gap-2">
        {errors.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </div>
      <div role="status" aria-live="polite" className="flex flex-col items-end gap-2">
        {others.map((t) => (
          <ToastCard key={t.id} t={t} />
        ))}
      </div>
      <div role="status" aria-live="polite" aria-label="Working">
        {busy && (
          <div className="flex items-center gap-2 rounded-[10px] bg-ink px-3 py-2 text-sm text-panel shadow-lg">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            {busy}
          </div>
        )}
      </div>
    </div>
  );
}

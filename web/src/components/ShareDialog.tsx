// Share the page as one HTML file: every flag's answer as it stands, filters that still work, and
// an optional passphrase. Says plainly what goes into the file.

import { useState } from 'react';
import { FileDown, X } from 'lucide-react';

export function ShareDialog({ title, onSave, onClose }: { title: string; onSave: (passphrase: string) => Promise<string>; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const mismatch = pass !== again;
  const weak = pass.length > 0 && pass.length < 12;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-24" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-label="Share as a report" className="w-[460px] max-w-[calc(100%-2rem)] rounded-xl border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FileDown size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Share as a report</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          <p className="text-xs text-ink-2">
            Saves “{title || 'this page'}” as one HTML file that opens in any browser, with no server and no database. It holds every flag's numbers as they are now (the summarised results, not the source rows), the field and measure names, and clicking a bar or picker still filters the other flags.
          </p>
          <label className="block text-xs font-semibold">
            Passphrase (optional)
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-normal" />
          </label>
          {pass && (
            <label className="block text-xs font-semibold">
              Again
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} className="mt-1 block w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-normal" />
            </label>
          )}
          <p className="text-[11px] text-ink-3">
            With a passphrase the data in the file is encrypted (AES-256-GCM) and the file asks for it before showing anything. Semaphore does not keep the passphrase: if it is lost, the file cannot be opened. Share it separately from the file.
          </p>
          {weak && <p className="text-[11px] text-warn">Use at least 12 characters; a few words together work well.</p>}
          {done && <p className="text-xs text-good">{done}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || (!!pass && (mismatch || weak))}
              onClick={() => {
                setBusy(true);
                onSave(pass).then(
                  (name) => setDone(`Saved ${name}${pass ? ', locked with your passphrase' : ''}.`),
                  (e: Error) => setDone(`Could not save: ${e.message}`),
                ).finally(() => setBusy(false));
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save the file'}
            </button>
            {pass && mismatch && again && <span className="self-center text-[11px] text-bad">The two do not match.</span>}
          </div>
        </div>
      </section>
    </div>
  );
}

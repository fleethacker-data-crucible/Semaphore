// Export the page: an interactive HTML report, or a file for Office, a PDF reader or another tool.
// Says plainly what goes into each file, and that only the HTML report can be locked.

import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileDown, X } from 'lucide-react';
import { useModal } from '../lib/modal.ts';
import { IDLE, presentSave, runSave, type SaveStatus } from '../lib/save-status.ts';

export type ExportChoice = 'html' | 'pdf' | 'xlsx' | 'pptx' | 'docx' | 'csv' | 'json';

const FORMATS: ReadonlyArray<{ id: ExportChoice; label: string; detail: string }> = [
  { id: 'pdf', label: 'PDF report', detail: 'For reading and printing: charts, numbers and findings, with bookmarks.' },
  { id: 'xlsx', label: 'Excel workbook', detail: 'A sheet per flag with real numbers and charts you can edit.' },
  { id: 'html', label: 'Interactive HTML', detail: 'One file that opens in any browser. Filters still work, and it can be locked.' },
  { id: 'pptx', label: 'PowerPoint', detail: 'A slide per flag, ready for a briefing.' },
  { id: 'docx', label: 'Word report', detail: 'Headings, charts and tables you can edit.' },
  { id: 'csv', label: 'CSV (zip)', detail: 'One plain table per flag, for any other tool.' },
  { id: 'json', label: 'JSON', detail: 'The answers as structured data.' },
];

export interface ShareDialogProps {
  title: string;
  /** How many selections are on the page now. */
  selections: number;
  onExport: (format: ExportChoice, options: { passphrase: string; selectedOnly: boolean }) => Promise<string>;
  onClose: () => void;
}

export function ShareDialog({ title, selections, onExport, onClose }: ShareDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const [format, setFormat] = useState<ExportChoice>('pdf');
  const [selectedOnly, setSelectedOnly] = useState(selections > 0);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [status, setStatus] = useState<SaveStatus>(IDLE);
  const busy = status.kind === 'saving';
  const result = presentSave(status);
  const html = format === 'html';
  const mismatch = html && pass !== again;
  const weak = html && pass.length > 0 && pass.length < 12;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 py-12" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-label="Export or share" className="w-[500px] max-w-[calc(100%-2rem)] rounded-xl border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FileDown size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Export or share</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-3 p-4 text-sm">
          <div role="radiogroup" aria-label="File format" className="grid gap-1">
            {FORMATS.map((f) => (
              <label key={f.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 ${format === f.id ? 'border-accent bg-accent-soft' : 'border-[var(--fl-control-border)] hover:border-accent'}`}>
                <input data-autofocus={format === f.id ? true : undefined} type="radio" name="export-format" className="mt-1 size-4 shrink-0" checked={format === f.id} onChange={() => { setFormat(f.id); setStatus(IDLE); }} />
                <span className="min-w-0">
                  <span className="block font-semibold">{f.label}</span>
                  <span className="block text-xs text-ink-2">{f.detail}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-ink-2">
            Holds the numbers in “{title || 'this page'}” as they are now (the summarised results, not the source rows), and the names of its fields and measures. Made in this browser; nothing is sent anywhere.
          </p>
          {!html && selections > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" className="size-4" checked={selectedOnly} onChange={(e) => setSelectedOnly(e.target.checked)} />
              Only what is selected on the page now ({selections} selection{selections === 1 ? '' : 's'})
            </label>
          )}
          {html ? (
            <>
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
            </>
          ) : (
            <p className="text-[11px] text-ink-3">This file is not encrypted: anyone who has it can read it. To lock an export, use Interactive HTML with a passphrase.</p>
          )}
          {result && (
            <p role={result.role} className={`flex items-start gap-1.5 text-xs ${result.tone}`}>
              {result.mark === 'ok' ? <CheckCircle2 size={14} aria-hidden="true" className="mt-px shrink-0" /> : <AlertTriangle size={14} aria-hidden="true" className="mt-px shrink-0" />}
              <span>
                <span className="font-semibold">{result.label}:</span> {result.message}
              </span>
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || (html && !!pass && (mismatch || weak))}
              onClick={() => {
                // The passphrase and its repeat stay as typed, so a retry needs nothing re-entered.
                setStatus({ kind: 'saving' });
                void runSave(() => onExport(format, { passphrase: html ? pass : '', selectedOnly: !html && selectedOnly }), (name) => `${name}${html && pass ? ', locked with your passphrase' : ''}.`).then(setStatus);
              }}
              className="min-h-8 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40"
            >
              {busy ? 'Saving…' : result?.retry ? 'Try again' : 'Save the file'}
            </button>
            {html && pass && mismatch && again && <span className="self-center text-[11px] text-bad">The two do not match.</span>}
          </div>
        </div>
      </section>
    </div>
  );
}

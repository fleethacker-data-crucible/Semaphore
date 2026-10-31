// The reader inside a shared report (lib/share.ts): it shows the page as it stood and keeps its
// filters working from the pre-split results in the file. No network: the file's own CSP forbids it.

import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Lock, X } from 'lucide-react';
import { indexCatalog } from '../../src/core/catalog.ts';
import type { Cell, Selections } from '../../src/core/crossfilter.ts';

import { dimensionKey } from '../../src/core/hoist.ts';
import { FlagView, formatDim } from './components/FlagView.tsx';
import { reportView } from './lib/report-view.ts';
import { deriveKey, type ReportPayload, type Sealed, unb64 } from './lib/share.ts';

declare global {
  interface Window {
    __SEMAPHORE_DATA__?: { report?: ReportPayload; sealed?: Sealed };
  }
}

async function open(sealed: Sealed, passphrase: string): Promise<ReportPayload> {
  const key = await deriveKey(passphrase, unb64(sealed.salt));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain)) as ReportPayload;
}

function Unlock({ sealed, onOpen }: { sealed: Sealed; onOpen: (r: ReportPayload) => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        className="w-[360px] space-y-3 rounded-xl border border-line bg-panel p-5 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          open(sealed, pass).then(onOpen, () => {
            setError('That passphrase does not open this report.');
            setBusy(false);
          });
        }}
      >
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Lock size={16} className="text-brass" /> This report is locked
        </h1>
        <p className="text-xs text-ink-2">Enter the passphrase you were given. It stays in this browser; nothing is sent anywhere.</p>
        <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Passphrase" className="w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm" />
        {error && <p className="text-xs text-bad">{error}</p>}
        <button type="submit" disabled={!pass || busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
          {busy ? 'Opening…' : 'Open'}
        </button>
      </form>
    </main>
  );
}

function Report({ report }: { report: ReportPayload }) {
  const index = useMemo(() => indexCatalog(report.catalog), [report.catalog]);
  const [selections, setSelections] = useState<Selections>({});
  document.documentElement.dataset.theme = report.theme;
  const select = (key: string, value: Cell, additive: boolean) =>
    setSelections((s) => {
      const current = s[key] ?? [];
      const has = current.some((v) => String(v) === String(value));
      const values = has ? current.filter((v) => String(v) !== String(value)) : additive ? [...current, value] : [value];
      const next = { ...s, [key]: values };
      if (!values.length) delete next[key];
      return next;
    });
  const chips = Object.entries(selections).flatMap(([key, values]) => {
    const [field, grain] = key.split('@');
    return values.map((v) => ({ key, value: v, text: `${index.field(field!)?.label ?? field}: ${formatDim(v, grain as never)}` }));
  });
  const labelFor = (k: string) => {
    for (const f of report.flags) for (const d of f.flag.binding?.dimensions ?? []) if (dimensionKey(d) === k) return true;
    return false;
  };
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-panel px-5 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass">Semaphore report</p>
        <h1 className="text-lg font-semibold">{report.title}</h1>
        <p className="text-xs text-ink-2">
          Taken {new Date(report.takenAt).toLocaleString()} by {report.by}. The numbers are as they were then; click bars and pickers to filter.
        </p>
        {report.brief && <p className="mt-1 max-w-3xl text-xs text-ink-3">{report.brief}</p>}
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button key={`${c.key}|${String(c.value)}`} type="button" onClick={() => labelFor(c.key) && select(c.key, c.value, true)} className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
                {c.text} <X size={11} />
              </button>
            ))}
            <button type="button" onClick={() => setSelections({})} className="text-[11px] text-ink-3 hover:text-ink">
              Clear all
            </button>
          </div>
        )}
      </header>
      <main className="p-5">
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${report.cols}, minmax(0, 1fr))`, gridAutoRows: '64px' }}>
          {report.flags.map((f) => {
            const v = reportView(f, selections);
            return (
              <article key={f.flag.id} className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel p-2 shadow-sm" style={{ gridColumn: `${f.flag.layout.x + 1} / span ${f.flag.layout.w}`, gridRow: `${f.flag.layout.y + 1} / span ${f.flag.layout.h}` }}>
                <h2 className="truncate px-1 text-[13px] font-semibold">{f.flag.title}</h2>
                <div className="min-h-0 flex-1">
                  {f.flag.kind === 'text' ? (
                    <p className="whitespace-pre-wrap p-1 text-sm text-ink-2">{f.flag.text || f.flag.brief}</p>
                  ) : v.result ? (
                    <FlagView flag={f.flag} result={v.result} index={index} selections={selections} onSelect={select} themeKey={report.theme} />
                  ) : (
                    <p className="p-1 text-xs text-warn">{f.error ?? 'No data.'}</p>
                  )}
                </div>
                {v.note ? <p className="truncate px-1 text-[11px] text-warn" title={v.note}>{v.note}</p> : f.insights[0] && !Object.keys(selections).length && f.flag.layout.h >= 4 && <p className="truncate px-1 text-[11px] text-ink-2">{f.insights[0].text}</p>}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function Root() {
  const data = window.__SEMAPHORE_DATA__;
  const [report, setReport] = useState<ReportPayload | null>(data?.report ?? null);
  if (report) return <Report report={report} />;
  if (data?.sealed) return <Unlock sealed={data.sealed} onOpen={setReport} />;
  return <p className="p-6 text-sm">This file has no report in it.</p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

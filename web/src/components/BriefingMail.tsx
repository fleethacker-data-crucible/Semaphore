// "Email this briefing": Semaphore never sends mail. "Draft in Outlook" makes an unsent draft in Outlook
// on this computer (server/Mail.ps1, Outlook COM) with the briefing as the body and the shared report
// attached; the person checks it and presses Send in Outlook themselves. "Save as email (.eml)" saves
// the same message as a file the default mail app opens as a draft. Recipients come from a saved list,
// and a weekly draft can be switched on (never sent). Loaded on demand.

import { useEffect, useRef, useState } from 'react';
import { CalendarClock, FileDown, Mail, X } from 'lucide-react';
import { type Alert, markBriefed } from '../../../src/core/alerts.ts';
import { cleanRecipients, composeEml } from '../../../src/core/briefing-mail.ts';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { PlaybookEntry } from '../../../src/core/playbook.ts';
import type { Snapshot } from '../../../src/core/snapshot.ts';
import { api, describeError } from '../lib/api.ts';
import { saveAlert } from '../lib/alerts.ts';
import { type BriefingPackage, buildBriefingPackage } from '../lib/briefing-package.ts';
import { useModal } from '../lib/modal.ts';
import { download } from '../lib/share.ts';
import { readLocal, writeLocal } from '../lib/storage.ts';

const LOCAL_RECIPIENTS = 'semaphore.briefingRecipients';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface MailInfo {
  outlook: { available: boolean; code: string; reason: string };
  settings: { recipients: string[]; schedule: { enabled: boolean; weekday: number; time: string; open: boolean }; lastResult: string };
  latest: { at: string; subject: string } | null;
  outbox: string;
}

export interface BriefingMailProps {
  entries: readonly PlaybookEntry[];
  snapshots: readonly Snapshot[];
  index: CatalogIndex;
  user: string;
  alerts: readonly Alert[];
  theme: 'light' | 'dark';
  server: boolean;
  onClose: () => void;
}

export function BriefingMail({ entries, snapshots, index, user, alerts, theme, server, onClose }: BriefingMailProps) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose);
  const [info, setInfo] = useState<MailInfo | null>(null);
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [schedule, setSchedule] = useState({ enabled: false, weekday: 1, time: '08:00', open: false });

  useEffect(() => {
    if (!server) {
      setTo((readLocal<string[]>(LOCAL_RECIPIENTS) ?? []).join(', '));
      return;
    }
    api<MailInfo>('/api/mail').then(
      (i) => {
        setInfo(i);
        setTo(i.settings.recipients.join(', '));
        setSchedule(i.settings.schedule);
      },
      () => setInfo(null),
    );
  }, [server]);

  const recipients = () => cleanRecipients(to.split(/[,;\s]+/));

  const saveSettings = async (patch?: Partial<typeof schedule>) => {
    const list = recipients();
    const next = { ...schedule, ...patch };
    if (!server) {
      writeLocal(LOCAL_RECIPIENTS, list);
      return;
    }
    await api('/api/mail/settings', { method: 'PUT', json: { recipients: list, schedule: next } });
    setSchedule(next);
  };

  const pack = async (): Promise<BriefingPackage> => {
    const p = await buildBriefingPackage({ entries, snapshots, index, user, alerts, theme });
    // Kept for the weekly draft, so it has this week's numbers.
    if (server) await api('/api/mail/briefing', { method: 'PUT', json: { subject: p.subject, html: p.html, text: p.text, attachment: p.report } }).catch(() => undefined);
    return p;
  };

  const briefed = async (p: BriefingPackage) => {
    for (const a of p.alerts) await saveAlert(server, markBriefed(a)).catch(() => undefined);
  };

  const outlook = async () => {
    setBusy(true);
    setStatus({ tone: 'info', text: 'Making the draft in Outlook…' });
    try {
      await saveSettings();
      const p = await pack();
      const r = await api<{ ok: boolean; code: string; error?: string }>('/api/mail/outlook-draft', { json: { subject: p.subject, html: p.html, to: recipients(), attachment: p.report, open: true } });
      if (r.ok) {
        await briefed(p);
        setStatus({ tone: 'ok', text: "Draft saved in Outlook's Drafts folder and opened. Check it and press Send in Outlook yourself: Semaphore does not send it." });
      } else setStatus({ tone: 'bad', text: `${r.error ?? 'Outlook did not make the draft.'} Use "Save as email (.eml)" instead.` });
    } catch (e) {
      setStatus({ tone: 'bad', text: `Could not make the draft. ${describeError(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const eml = async () => {
    setBusy(true);
    try {
      await saveSettings();
      const p = await pack();
      const file = composeEml({ to: recipients(), subject: p.subject, html: p.html, text: p.text, attachments: p.report ? [{ name: p.report.name, contentType: 'text/html; charset=utf-8', content: p.report.html }] : [] });
      download(`leadership-briefing-${new Date().toISOString().slice(0, 10)}.eml`, file, 'message/rfc822');
      await briefed(p);
      setStatus({ tone: 'ok', text: 'Saved as an email file. Open it: your mail app shows it as a draft to check and send yourself.' });
    } catch (e) {
      setStatus({ tone: 'bad', text: `Could not save the email file. ${describeError(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const noOutlook = server && info && !info.outlook.available;
  const btn = 'flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-40';
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-label="Email this briefing" tabIndex={-1} className="mt-12 w-[540px] max-w-full space-y-4 rounded-2xl border border-line bg-panel p-5 shadow-xl">
        <header className="flex items-start gap-2">
          <Mail size={18} className="mt-0.5 text-brass" />
          <div className="flex-1">
            <h2 className="text-base font-semibold">Email this briefing</h2>
            <p className="text-xs text-ink-2">Semaphore never sends mail. It makes a draft with the briefing and the shared report attached; you check it and press Send yourself. Only answers an analyst has reviewed are included.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <label className="block text-sm">
          <span className="text-xs font-semibold text-ink-2">To (saved for next time)</span>
          <input value={to} onChange={(e) => setTo(e.target.value.slice(0, 4000))} placeholder="name@example.org, another@example.org" aria-label="Recipients" className="mt-1 w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm" />
        </label>
        <div className="flex flex-wrap gap-2">
          {server && (
            <button type="button" disabled={busy || !!noOutlook} onClick={() => void outlook()} className={`${btn} bg-accent text-panel`}>
              <Mail size={14} /> Draft in Outlook
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void eml()} className={`${btn} border border-line text-ink hover:border-accent`}>
            <FileDown size={14} /> Save as email (.eml)
          </button>
        </div>
        {noOutlook && <p role="status" className="rounded-md bg-warn-soft px-3 py-2 text-xs text-ink">{info!.outlook.reason}</p>}
        {!server && <p className="text-xs text-ink-3">Outlook drafts need Semaphore's server on this computer; the email file works anywhere.</p>}
        {status && (
          <p role="status" className={`rounded-md px-3 py-2 text-sm ${status.tone === 'ok' ? 'bg-good-soft text-ink' : status.tone === 'bad' ? 'bg-bad-soft text-ink' : 'bg-panel-2 text-ink-2'}`}>
            {status.text}
          </p>
        )}
        {server && (
          <fieldset className="space-y-2 rounded-lg border border-line p-3">
            <legend className="flex items-center gap-1 px-1 text-xs font-semibold text-ink-2">
              <CalendarClock size={13} /> Weekly draft
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={schedule.enabled} onChange={(e) => setSchedule((s) => ({ ...s, enabled: e.target.checked }))} />
              Make this draft in Outlook every week (never sent)
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select aria-label="Weekday" value={schedule.weekday} onChange={(e) => setSchedule((s) => ({ ...s, weekday: Number(e.target.value) }))} className="min-h-8 rounded-md border border-line bg-panel-2 px-2">
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <input type="time" aria-label="Time" value={schedule.time} onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value || '08:00' }))} className="min-h-8 rounded-md border border-line bg-panel-2 px-2" />
              <button type="button" onClick={() => saveSettings().then(() => setStatus({ tone: 'ok', text: schedule.enabled ? `A draft will be made ${DAYS[schedule.weekday]}s at ${schedule.time} while Semaphore is running on this computer. It is never sent.` : 'The weekly draft is off.' }), (e: unknown) => setStatus({ tone: 'bad', text: describeError(e) }))} className="min-h-8 rounded-md border border-line px-3 text-xs hover:border-accent">
                Save
              </button>
            </div>
            <p className="text-[11px] text-ink-3">
              Uses the latest briefing saved here (each time you draft or save one, and each refresh run). Without Outlook, an email file goes to {info?.outbox ?? 'the outbox folder'} instead.
              {info?.settings.lastResult ? ` Last time: ${info.settings.lastResult}` : ''}
            </p>
          </fieldset>
        )}
      </section>
    </div>
  );
}

// Settings: how Semaphore looks, Lazarette pairing, AI drafting, each person's feature switches and
// End session, on one screen reached from the gear, the welcome page and Ctrl+K.
// The pairing code goes from this box to the local server once. It is held in a password field, sent
// in the request body, cleared at once and never shown, logged or kept here.

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Link2, Moon, Power, RefreshCw, Settings2, Sun, Unlink, X } from 'lucide-react';
import { api, describeError } from '../lib/api.ts';
import type { AiStatus } from '../lib/ai.ts';
import { confirm } from '../lib/confirm.ts';
import { FEATURE_LIST, type FeatureKey, featureState, setPersonalFeature, usePersonalFeatures } from '../lib/features.ts';
import { useModal } from '../lib/modal.ts';
import type { SocialSettings } from '../lib/playbook.ts';

export interface VaultStatus {
  paired: boolean;
  running: boolean;
  locked: boolean | null;
  problem: string | null;
  sources: Array<{ id: string; shares: Record<string, string> }>;
  shared: string[];
  notShared: Array<{ name: string; state: string }>;
}

export interface SettingsDialogProps {
  onClose: () => void;
  theme: 'light' | 'dark';
  onTheme: () => void;
  skins: Array<{ id: string; label: string }>;
  skin: string;
  /** Null when the deployment fixed the skin. */
  onSkin: ((id: string) => void) | null;
  /** Null without a server: there is no Lazarette, AI or session to show. */
  hasServer: boolean;
  ai: AiStatus | null;
  aiOn: boolean;
  onAi: () => void;
  examplesOn: boolean;
  onExamples: () => void;
  deployment: SocialSettings;
  onEnd: () => void;
}

const btn = 'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-sm hover:border-accent disabled:opacity-40';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-brass">{title}</h3>
      {children}
    </section>
  );
}

function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`flex items-start gap-2.5 py-1.5 ${disabled ? 'opacity-60' : ''}`}>
      <input type="checkbox" className="mt-1 size-4 shrink-0" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block text-[12px] text-ink-3">{detail}</span>
      </span>
    </label>
  );
}

/** One line for where the Lazarette link stands. */
export function vaultLine(s: VaultStatus): { ok: boolean; text: string } {
  if (s.problem) return { ok: false, text: s.problem };
  if (s.paired && s.running && s.locked === false) return { ok: true, text: 'Paired. Lazarette is running and unlocked.' };
  if (s.paired && !s.running) return { ok: false, text: 'Paired, but Lazarette is not running.' };
  if (s.paired) return { ok: true, text: 'Paired.' };
  return { ok: false, text: 'Not paired yet.' };
}

function LazaretteSection() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const code = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await api<VaultStatus>('/api/vault'));
      setFailed(null);
    } catch (e) {
      setFailed(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    const box = code.current;
    const value = box?.value.trim() ?? '';
    if (box) box.value = '';
    if (!value) return;
    setBusy(true);
    try {
      setStatus(await api<VaultStatus>('/api/vault/pair', { method: 'POST', json: { code: value } }));
      setFailed(null);
    } catch (err) {
      setFailed(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    const yes = await confirm({ title: 'Unpair from Lazarette?', body: 'Sources that read from Lazarette stop working until you pair again with a new code. Nothing in Lazarette changes.', confirmLabel: 'Unpair' });
    if (!yes) return;
    setBusy(true);
    try {
      setStatus(await api<VaultStatus>('/api/vault/unpair', { method: 'POST', json: {} }));
      setFailed(null);
    } catch (err) {
      setFailed(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const line = status ? vaultLine(status) : null;
  return (
    <Section title="Lazarette">
      <p role="status" className="flex items-start gap-1.5 text-sm" data-testid="vault-line">
        {line?.ok ? <CheckCircle2 size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-good" /> : <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />}
        <span>{failed ?? line?.text ?? 'Checking…'}</span>
      </p>
      {(status?.sources.length ?? 0) > 0 && (
        <ul aria-label="Sources that read from Lazarette" className="mt-2 grid gap-0.5 text-[12px] text-ink-2">
          {status!.sources.map((s) => (
            <li key={s.id}>
              <span className="font-medium">{s.id}</span>: {Object.values(s.shares).map((n) => `${n}${status!.shared.includes(n) ? ' (shared)' : status!.notShared.some((x) => x.name === n) ? ' (not shared)' : ''}`).join(', ')}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void pair(e)} className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <label htmlFor="vault-code" className="w-full text-[12px] text-ink-3">
          In Lazarette open Settings &gt; Tools &gt; Pair tool, name it Semaphore, and paste the code here. It is not shown.
        </label>
        <input ref={code} id="vault-code" type="password" autoComplete="off" spellCheck={false} aria-label="Pairing code from Lazarette" className="min-h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-sm focus:border-accent focus:outline-none" />
        <button type="submit" disabled={busy} className={btn}>
          <Link2 size={14} aria-hidden="true" /> Pair
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()} className={btn}>
          <RefreshCw size={14} aria-hidden="true" /> Check again
        </button>
        {status?.paired && (
          <button type="button" disabled={busy} onClick={() => void unpair()} className={btn}>
            <Unlink size={14} aria-hidden="true" /> Unpair
          </button>
        )}
      </form>
    </Section>
  );
}

export function SettingsDialog(p: SettingsDialogProps) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, p.onClose);
  const personal = usePersonalFeatures();
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-ink/30 pt-16" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="fl-dialog flex max-h-[calc(100vh-6rem)] w-[620px] max-w-[calc(100%-2rem)] flex-col rounded-[14px] border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Settings2 size={16} aria-hidden="true" className="text-brass" />
          <h2 id="settings-title" className="flex-1 text-base font-semibold">
            Settings
          </h2>
          <button type="button" onClick={p.onClose} aria-label="Close" data-autofocus="" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto">
          <Section title="Appearance">
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={p.onTheme} className={btn}>
                {p.theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />} {p.theme === 'dark' ? 'Use Chart room (light)' : 'Use Night watch (dark)'}
              </button>
              {p.onSkin ? (
                <label className="flex items-center gap-1.5 text-sm">
                  Skin
                  <select value={p.skin} onChange={(e) => p.onSkin?.(e.target.value)} className="min-h-8 rounded-md border border-line bg-panel px-1.5 text-sm">
                    {p.skins.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="text-[12px] text-ink-3">Skin: set for this deployment.</span>
              )}
            </div>
          </Section>

          {p.hasServer && <LazaretteSection />}

          {p.hasServer && (
            <Section title="AI drafting">
              <p className="text-sm" data-testid="ai-line">
                {p.ai === null ? 'Checking…' : p.ai.configured ? `Fairlead is set up (${p.ai.model}).` : (p.ai.problem ?? 'Fairlead is not set up, so drafting uses the local rules.')}
              </p>
              {p.ai?.configured && (
                <>
                  <Toggle label="Draft with Fairlead" detail="Off uses the local rules, on this computer." checked={p.aiOn} onChange={p.onAi} />
                  {p.aiOn && <Toggle label="Send reviewed examples" detail="Sends reviewed briefs with a request so drafts match your team." checked={p.examplesOn} onChange={p.onExamples} />}
                </>
              )}
            </Section>
          )}

          <Section title="Features">
            <p className="mb-1 text-[12px] text-ink-3">For you, in this browser. What is already kept stays, and comes back when you turn a feature on.</p>
            {FEATURE_LIST.map((f) => {
              const s = featureState(p.deployment, personal, f.key as FeatureKey);
              return <Toggle key={f.key} label={f.label} detail={s.locked ? 'Turned off for this deployment.' : f.detail} checked={s.on} disabled={s.locked} onChange={(on) => setPersonalFeature(f.key, on)} />;
            })}
          </Section>

          {p.hasServer && (
            <Section title="Session">
              <button type="button" onClick={p.onEnd} className={`${btn} text-bad`}>
                <Power size={14} aria-hidden="true" /> End session…
              </button>
            </Section>
          )}
        </div>
      </section>
    </div>
  );
}

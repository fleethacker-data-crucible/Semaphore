// Settings, laid out as Lazarette lays out its own: a page with a title, a row of tabs, and cards
// whose rows put the setting's name and a line about it on the left and the control on the right.
// Reached from the gear, the welcome page, the Leadership view and Ctrl+K.
// The pairing code goes from this box to the local server once. It is held in a password field, sent
// in the request body, cleared at once and never shown, logged or kept here.

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, CircleAlert, Link2, Power, RefreshCw, Unlink, X } from 'lucide-react';
import { api, describeError } from '../lib/api.ts';
import type { AiStatus } from '../lib/ai.ts';
import { confirm } from '../lib/confirm.ts';
import { FEATURE_LIST, type FeatureKey, featureState, setPersonalFeature, usePersonalFeatures } from '../lib/features.ts';
import { useModal } from '../lib/modal.ts';
import type { SocialSettings } from '../lib/playbook.ts';
import { ThemeCards } from './ThemeCards.tsx';
import { VoiceCard, VoiceInputCard } from './VoiceCard.tsx';
import { SqlLanguageCard } from './SqlLanguageCard.tsx';

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
  /** What the server said about itself, for the Session tab. */
  server?: { version: string; port: number; home: string; pid: number; user?: string } | null;
  ai: AiStatus | null;
  aiOn: boolean;
  onAi: () => void;
  examplesOn: boolean;
  onExamples: () => void;
  deployment: SocialSettings;
  onEnd: () => void;
}

type TabId = 'appearance' | 'lazarette' | 'ai' | 'sql' | 'features' | 'session';

const btn = 'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-sm hover:border-accent disabled:opacity-40';

/** A card like Lazarette's: an optional title and line, then rows divided by rules. */
function Card({ title, description, children, rows = true }: { title?: string; description?: string; children: ReactNode; rows?: boolean }) {
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-panel">
      {title && (
        <header className="border-b border-line px-5 py-4">
          <h3 className="text-sm font-semibold tracking-[-0.01em]">{title}</h3>
          {description && <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">{description}</p>}
        </header>
      )}
      <div className={rows ? 'divide-y divide-line px-5' : 'p-5'}>{children}</div>
    </section>
  );
}

/** One row: the setting's name and a line about it, then the control on the right. */
function Row({ label, hint, htmlFor, children, as = 'div' }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode; as?: 'div' | 'label' }) {
  const Tag = as;
  return (
    <Tag className="flex min-h-14 items-center justify-between gap-6 py-3">
      <span className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-sm font-medium">
            {label}
          </label>
        ) : (
          <span className="block text-sm font-medium">{label}</span>
        )}
        {hint && <span className="mt-0.5 block text-[12px] leading-5 text-ink-2">{hint}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </Tag>
  );
}

/** A switch. It stays a checkbox underneath, so it reads as one to assistive technology and tests. */
function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className={`flex min-h-14 cursor-pointer items-center justify-between gap-6 py-3 ${disabled ? 'cursor-default opacity-60' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-5 text-ink-2">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
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

function LazaretteTab() {
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
    <div className="grid gap-5">
      <Card title="Pairing" description="Semaphore reads database passwords and the Fairlead key from Lazarette by name, only while Lazarette is open and unlocked. No secret is ever shown here.">
        <Row label="Status" hint={status?.paired ? 'Check again after unlocking or starting Lazarette.' : undefined}>
          <span role="status" className="flex items-start gap-1.5 text-sm" data-testid="vault-line">
            {line?.ok ? <CheckCircle2 size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-good" /> : <CircleAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />}
            <span className="max-w-[360px]">{failed ?? line?.text ?? 'Checking…'}</span>
          </span>
          <button type="button" disabled={busy} onClick={() => void refresh()} className={btn}>
            <RefreshCw size={14} aria-hidden="true" /> Check again
          </button>
        </Row>
        <form onSubmit={(e) => void pair(e)}>
          <Row label="Pairing code" htmlFor="vault-code" hint="In Lazarette open Settings > Tools > Pair tool, name it Semaphore, and paste the code here. It is not shown.">
            <input ref={code} id="vault-code" type="password" autoComplete="off" spellCheck={false} aria-label="Pairing code from Lazarette" className="min-h-8 w-[240px] rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm focus:border-accent focus:outline-none" />
            <button type="submit" disabled={busy} className={btn}>
              <Link2 size={14} aria-hidden="true" /> Pair
            </button>
          </Row>
        </form>
        {status?.paired && (
          <Row label="Remove the pairing" hint="Sources that read from Lazarette stop working until you pair again. Nothing in Lazarette changes.">
            <button type="button" disabled={busy} onClick={() => void unpair()} className={`${btn} hover:border-bad hover:text-bad`}>
              <Unlink size={14} aria-hidden="true" /> Unpair
            </button>
          </Row>
        )}
      </Card>
      {(status?.sources.length ?? 0) > 0 && (
        <Card title="Sources that read from Lazarette" description="Each source names the Lazarette item it reads. A name marked not shared needs sharing with Semaphore in Lazarette's Tools tab.">
          {status!.sources.map((s) => (
            <Row key={s.id} label={s.id}>
              <span className="text-[12px] text-ink-2">{Object.values(s.shares).map((n) => `${n}${status!.shared.includes(n) ? ' (shared)' : status!.notShared.some((x) => x.name === n) ? ' (not shared)' : ''}`).join(', ')}</span>
            </Row>
          ))}
        </Card>
      )}
    </div>
  );
}

export function SettingsDialog(p: SettingsDialogProps) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, p.onClose);
  const personal = usePersonalFeatures();
  const [tab, setTab] = useState<TabId>('appearance');
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'appearance', label: 'Appearance' },
    ...(p.hasServer ? [{ id: 'lazarette' as const, label: 'Lazarette' }, { id: 'ai' as const, label: 'AI drafting' }] : []),
    { id: 'sql', label: 'SQL' },
    { id: 'features', label: 'Features' },
    ...(p.hasServer ? [{ id: 'session' as const, label: 'Session' }] : []),
  ];

  return (
    <div className="theme-surface fixed inset-0 z-[65] overflow-y-auto bg-bg" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} className="mx-auto w-full max-w-[880px] px-8 py-6 outline-none" data-testid="settings-view">
        <div className="mb-4 flex items-center justify-between">
          <button type="button" onClick={p.onClose} data-autofocus="" className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-sm text-ink-2 hover:bg-panel-2 hover:text-ink">
            <ArrowLeft size={15} aria-hidden="true" /> Back to the page
          </button>
          <button type="button" onClick={p.onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </div>
        <header>
          <h1 id="settings-title" className="text-[22px] font-semibold leading-8 tracking-[-0.02em]">
            Settings
          </h1>
          <p className="mt-1 max-w-[72ch] text-[13.5px] leading-6 text-ink-2">Appearance and your switches apply to this browser. Lazarette, AI drafting and the session belong to the Semaphore running on this computer.</p>
        </header>

        <div role="tablist" aria-label="Settings sections" className="mt-6 flex gap-1 border-b border-line pb-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = tabs[(tabs.findIndex((x) => x.id === tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
                  setTab(next.id);
                  document.getElementById(`settings-tab-${next.id}`)?.focus();
                }
              }}
              className={`flex h-8 items-center rounded-md px-3 text-[13px] ${tab === t.id ? 'bg-panel-2 font-medium text-ink' : 'text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="pt-5">
          {tab === 'appearance' && (
            <div className="grid gap-5">
              <ThemeCards />
              <Card title="Skin" description="The base palette under the theme. Themes colour the Fleet skin; Classic and Colour-blind safe keep their own colours and take the rest of the theme.">
                <Row label="Skin" htmlFor={p.onSkin ? 'settings-skin' : undefined} hint={p.onSkin ? 'The colours and type of the whole page. A page design sits on top of it.' : 'Set for this deployment in settings.json.'}>
                  {p.onSkin ? (
                    <select id="settings-skin" value={p.skin} onChange={(e) => p.onSkin?.(e.target.value)} className="min-h-8 min-w-[160px] rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm">
                      {p.skins.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-sm text-ink-2">{p.skins.find((s) => s.id === p.skin)?.label ?? p.skin}</span>
                  )}
                </Row>
              </Card>
              <p className="text-[12px] text-ink-3">How a page's charts and cards look is set per page: the paintbrush in the header opens Page design.</p>
            </div>
          )}

          {tab === 'lazarette' && <LazaretteTab />}

          {tab === 'ai' && (
            <div className="grid gap-5">
            <Card title="AI drafting" description="Fairlead runs on this computer and holds no key of its own: the key lives in Lazarette. Without it, every draft comes from the local rules.">
              <Row label="Fairlead">
                <span className="max-w-[420px] text-right text-sm" data-testid="ai-line">
                  {p.ai === null ? 'Checking…' : p.ai.configured ? `Set up (${p.ai.model}).` : (p.ai.problem ?? 'Not set up, so drafting uses the local rules.')}
                </span>
              </Row>
              {p.ai?.configured && <Switch label="Draft with Fairlead" hint="Off uses the local rules, on this computer." checked={p.aiOn} onChange={p.onAi} />}
              {p.ai?.configured && p.aiOn && <Switch label="Send reviewed examples" hint="Sends reviewed briefs with a request so drafts match your team." checked={p.examplesOn} onChange={p.onExamples} />}
            </Card>
            <VoiceCard />
            <VoiceInputCard />
            </div>
          )}

          {tab === 'sql' && <SqlLanguageCard />}

          {tab === 'features' && (
            <Card title="For you, in this browser" description="What is already kept stays, and comes back when you turn a feature on. A feature the deployment turned off stays off.">
              {FEATURE_LIST.map((f) => {
                const s = featureState(p.deployment, personal, f.key as FeatureKey);
                return <Switch key={f.key} label={f.label} hint={s.locked ? 'Turned off for this deployment.' : f.detail} checked={s.on} disabled={s.locked} onChange={(on) => setPersonalFeature(f.key, on)} />;
              })}
            </Card>
          )}

          {tab === 'session' && (
            <div className="grid gap-5">
              {p.server && (
                <Card title="This Semaphore" description="The server running on this computer. Only this computer can reach it.">
                  <Row label="Version">
                    <span className="text-sm tabular-nums">{p.server.version}</span>
                  </Row>
                  <Row label="Address">
                    <span className="font-mono text-[12.5px]">127.0.0.1:{p.server.port}</span>
                  </Row>
                  <Row label="Home folder" hint="Hoists, the catalog and the team folder live here.">
                    <span className="max-w-[420px] truncate font-mono text-[12.5px]" title={p.server.home}>
                      {p.server.home}
                    </span>
                  </Row>
                  {p.server.user && (
                    <Row label="Signed in as" hint="The Windows user running the server: who accepts a flag or asks a question.">
                      <span className="text-sm">{p.server.user}</span>
                    </Row>
                  )}
                </Card>
              )}
              <Card title="Session">
                <Row label="End session" hint="Saves, then stops the Semaphore server on this computer. Other tabs on it close.">
                  <button type="button" onClick={p.onEnd} className={`${btn} text-bad hover:border-bad`}>
                    <Power size={14} aria-hidden="true" /> End session…
                  </button>
                </Row>
              </Card>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

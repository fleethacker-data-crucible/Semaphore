// Settings > Connections (Semaphore #101, the Fleet turnkey-connections contract): Lazarette, Fairlead
// and the voice, each green or red with one line saying why and one Fix button. Loaded only when the
// tab opens. Fix starts Fairlead (POST /api/ai/start) or TalkForge (POST /api/voice/start) and checks
// again while they start; for Lazarette it says what to do in Lazarette until pairing from the tool
// lands. Nothing secret is shown: the server reports where a key comes from, never the key.

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, Wrench } from 'lucide-react';
import { api, describeError } from '../lib/api.ts';
import type { AiStatus } from '../lib/ai.ts';
import { type VaultStatus, vaultLine } from './SettingsDialog.tsx';

interface VoiceState {
  state: 'ready' | 'starting' | 'offline' | 'unavailable';
  message: string;
}
interface VoiceInfo {
  tokenSource?: string;
}

type Line = { ok: boolean; text: string; busy?: boolean };

const KEY_SOURCE: Record<string, string> = {
  environment: 'Key from SEMAPHORE_AI_KEY.',
  'credential-manager': 'Key installed in Fairlead > Clients (Windows Credential Manager).',
  file: 'Key from the older key file; run Set-SemaphoreAiKey.bat to move it to Credential Manager.',
  'local-token': "Fairlead's own local key for this Windows account.",
};

export function fairleadLine(ai: AiStatus | null): Line {
  if (!ai) return { ok: false, text: 'Checking…', busy: true };
  if (ai.problem) return { ok: false, text: ai.problem };
  if (!ai.configured) return { ok: false, text: ai.running ? 'Fairlead is running but has not made a key for Semaphore yet. Press Fix to start it again, or install a key in Fairlead > Clients.' : 'Fairlead is not running and no key is stored. Fix starts it; on its first start it makes a key for this Windows account.' };
  if (ai.running === false) return { ok: false, text: 'Fairlead is set up but not running. Fix starts it (drafts also start it when needed).' };
  return { ok: true, text: `Fairlead answers on this computer (${ai.model}). ${KEY_SOURCE[ai.keySource] ?? ''}`.trim() };
}

export function voiceLine(v: VoiceState | null, info: VoiceInfo | null): Line {
  if (!v) return { ok: false, text: 'Checking…', busy: true };
  const token = info?.tokenSource === 'local-token' ? " Uses TalkForge's local token." : info?.tokenSource === 'environment' ? ' Token from SEMAPHORE_VOICE_TOKEN.' : '';
  if (v.state === 'ready') return { ok: true, text: `TalkForge is running.${token}` };
  if (v.state === 'starting') return { ok: false, text: 'TalkForge is starting…', busy: true };
  return { ok: false, text: v.state === 'offline' ? 'TalkForge is not running. Fix starts it (speaking an answer also starts it).' : v.message };
}

export function lazaretteFix(s: VaultStatus | null): string {
  if (!s) return 'Checking…';
  if (!s.running) return 'Open Lazarette on this computer and unlock it, then press Check again.';
  if (s.locked) return 'Unlock Lazarette in its window, then press Check again.';
  if (!s.paired) return 'Open Lazarette, Settings > Tools > Pair tool, name it Semaphore, and paste the code in the Lazarette tab here.';
  return s.problem ? 'Open Lazarette, Settings > Tools, and check Semaphore there; then press Check again.' : 'Nothing to fix.';
}

function Status({ line, testid }: { line: Line; testid: string }) {
  return (
    <span role="status" data-testid={testid} data-ok={line.ok ? 'true' : 'false'} className="flex items-start gap-1.5 text-sm">
      {line.ok ? <CheckCircle2 size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-good" /> : <CircleAlert size={15} aria-hidden="true" className={`mt-0.5 shrink-0 ${line.busy ? 'text-ink-3' : 'text-bad'}`} />}
      <span className="sr-only">{line.ok ? 'Working: ' : 'Not working: '}</span>
      <span className="max-w-[420px]">{line.text}</span>
    </span>
  );
}

const btn = 'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-sm hover:border-accent disabled:opacity-40';

export function ConnectionsCard() {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultFailed, setVaultFailed] = useState<string | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const [voiceInfo, setVoiceInfo] = useState<VoiceInfo | null>(null);
  const [note, setNote] = useState<{ which: string; text: string } | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const check = useCallback(async () => {
    await Promise.all([
      api<VaultStatus>('/api/vault', { quiet: true }).then(
        (s) => alive.current && (setVault(s), setVaultFailed(null)),
        (e: unknown) => alive.current && setVaultFailed(describeError(e)),
      ),
      api<AiStatus>('/api/ai', { quiet: true }).then((s) => alive.current && setAi(s), () => undefined),
      api<VoiceState>('/api/voice/status', { quiet: true }).then((s) => alive.current && setVoice(s), () => undefined),
      api<VoiceInfo>('/api/voice', { quiet: true }).then((s) => alive.current && setVoiceInfo(s), () => undefined),
    ]);
  }, []);
  useEffect(() => void check(), [check]);

  /** Starts a service, then checks again every 2 s until it is up (at most 40 s). */
  const fix = async (which: 'fairlead' | 'voice') => {
    setFixing(which);
    setNote(null);
    try {
      const r = await api<{ state: string; message: string }>(which === 'fairlead' ? '/api/ai/start' : '/api/voice/start', { json: {} });
      if (r.state === 'unavailable') {
        setNote({ which, text: r.message });
        return;
      }
      for (let i = 0; i < 20 && alive.current; i++) {
        await check();
        const up = which === 'fairlead' ? await api<AiStatus>('/api/ai', { quiet: true }).then((s) => s.configured && s.running !== false, () => false) : await api<VoiceState>('/api/voice/status', { quiet: true }).then((s) => s.state === 'ready', () => false);
        if (up) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      await check();
    } catch (e) {
      setNote({ which, text: describeError(e) });
    } finally {
      if (alive.current) setFixing(null);
    }
  };

  const lz: Line = vaultFailed ? { ok: false, text: vaultFailed } : vault ? vaultLine(vault) : { ok: false, text: 'Checking…', busy: true };
  const fl = fairleadLine(ai);
  const vc = voiceLine(voice, voiceInfo);
  const row = 'flex min-h-14 items-center justify-between gap-6 py-3';
  return (
    <section aria-label="Connections" data-testid="connections" className="rounded-lg border border-line bg-panel">
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-[-0.01em]">Connections</h3>
          <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">The Fleet tools Semaphore works with on this computer. Green works; red says why, and Fix does the one thing that helps.</p>
        </div>
        <button type="button" onClick={() => void check()} className={btn}>
          <RefreshCw size={14} aria-hidden="true" /> Check again
        </button>
      </header>
      <div className="divide-y divide-line px-5">
        <div className={row}>
          <span className="w-24 shrink-0 text-sm font-medium">Lazarette</span>
          <span className="min-w-0 flex-1">
            <Status line={lz} testid="conn-lazarette" />
            {note?.which === 'lazarette' && <span className="mt-1 block text-[12px] text-ink-2">{note.text}</span>}
          </span>
          {!lz.ok && !lz.busy && (
            <button type="button" onClick={() => (setNote({ which: 'lazarette', text: lazaretteFix(vault) }), void check())} data-testid="fix-lazarette" className={btn}>
              <Wrench size={14} aria-hidden="true" /> Fix
            </button>
          )}
        </div>
        <div className={row}>
          <span className="w-24 shrink-0 text-sm font-medium">Fairlead</span>
          <span className="min-w-0 flex-1">
            <Status line={fixing === 'fairlead' ? { ok: false, text: 'Starting Fairlead…', busy: true } : fl} testid="conn-fairlead" />
            {note?.which === 'fairlead' && <span className="mt-1 block text-[12px] text-bad">{note.text}</span>}
          </span>
          {!fl.ok && !fl.busy && !ai?.problem && (
            <button type="button" disabled={fixing !== null} onClick={() => void fix('fairlead')} data-testid="fix-fairlead" className={btn}>
              <Wrench size={14} aria-hidden="true" /> Fix
            </button>
          )}
        </div>
        <div className={row}>
          <span className="w-24 shrink-0 text-sm font-medium">Voice</span>
          <span className="min-w-0 flex-1">
            <Status line={fixing === 'voice' ? { ok: false, text: 'Starting TalkForge…', busy: true } : vc} testid="conn-voice" />
            {note?.which === 'voice' && <span className="mt-1 block text-[12px] text-bad">{note.text}</span>}
          </span>
          {!vc.ok && !vc.busy && (
            <button type="button" disabled={fixing !== null} onClick={() => void fix('voice')} data-testid="fix-voice" className={btn}>
              <Wrench size={14} aria-hidden="true" /> Fix
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

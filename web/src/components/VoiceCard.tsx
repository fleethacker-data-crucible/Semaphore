// Settings > AI drafting > Spoken answers, as in Lazarette's Spoken answers card (PR 140). The address
// and the token are set up on this computer (SEMAPHORE_VOICE_URL, and the TALKFORGE_TOKEN share in
// Lazarette or SEMAPHORE_VOICE_TOKEN): the page shows where they come from and never sees the token.
// The voice and speed are this person's, in this browser.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, Volume2 } from 'lucide-react';
import { api, describeError } from '../lib/api.ts';
import { voice } from '../lib/voice.ts';

interface VoiceStatus {
  url: string;
  problem: string;
  tokenSource: 'environment' | 'lazarette';
  tokenShare: string;
}

const input = 'min-h-8 w-full max-w-[320px] rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm';

export function VoiceCard() {
  useSyncExternalStore(voice.subscribe, voice.snapshot, voice.snapshot);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState('');
  const [name, setName] = useState(voice.prefs.voice);
  const nameOk = name === '' || /^[A-Za-z0-9._-]{1,80}$/.test(name);

  useEffect(() => {
    api<VoiceStatus>('/api/voice').then(setStatus, (e: unknown) => setFailed(describeError(e)));
  }, []);

  const test = async () => {
    if (testing) return;
    setNote('');
    setTesting(true);
    voice.say('Semaphore can read the assistant’s answers aloud.');
    const started = Date.now();
    // Done when speech ends; the outcome is voice.error or a played clip.
    while ((voice.speaking || Date.now() - started < 200) && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
    setNote(voice.error ? '' : 'Played. If you heard nothing, check the speaker volume.');
    setTesting(false);
  };

  return (
    <section aria-label="Spoken answers" className="rounded-lg border border-line bg-panel" data-testid="voice-settings">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Spoken answers</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">
          TalkForge, running on this computer, can read the assistant&apos;s answers aloud. Start it with talkforge serve, then turn on Read answers aloud (the speaker) in the assistant panel. Answer text goes only to TalkForge, through this Semaphore.
        </p>
      </header>
      <div className="divide-y divide-line px-5">
        <div className="flex min-h-14 items-center justify-between gap-6 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">TalkForge address</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">Set on this computer with SEMAPHORE_VOICE_URL; only http://127.0.0.1 is accepted.</span>
          </span>
          <span className="font-mono text-[12.5px]" data-testid="voice-url">
            {failed ?? status?.url ?? 'Checking…'}
          </span>
        </div>
        {status?.problem && (
          <p className="flex items-start gap-1.5 py-3 text-[12.5px] text-bad">
            <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {status.problem}
          </p>
        )}
        <div className="flex min-h-14 items-center justify-between gap-6 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Token</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">
              {status?.tokenSource === 'environment'
                ? 'From SEMAPHORE_VOICE_TOKEN on this computer.'
                : `From Lazarette: share ${status?.tokenShare ?? 'TALKFORGE_TOKEN'} with Semaphore (Lazarette > Settings > Tools > Semaphore), holding the token TalkForge was started with.`}
            </span>
          </span>
          <span className="text-sm text-ink-2">Never shown</span>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-6 py-3">
          <span className="min-w-0 flex-1">
            <label htmlFor="s-voice-name" className="block text-sm font-medium">
              Voice
            </label>
            <span className="mt-0.5 block text-[12px] text-ink-2">A TalkForge voice id, such as en_US-libritts-high. Leave empty for TalkForge&apos;s default.</span>
            {!nameOk && <span className="mt-0.5 block text-[12px] text-bad">Use 1-80 letters, digits and . _ -</span>}
          </span>
          <input
            id="s-voice-name"
            className={input}
            value={name}
            placeholder="TalkForge default"
            spellCheck={false}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value === '' || /^[A-Za-z0-9._-]{1,80}$/.test(e.target.value)) voice.setPrefs({ voice: e.target.value });
            }}
          />
        </div>
        <div className="flex min-h-14 items-center justify-between gap-6 py-3">
          <span className="min-w-0 flex-1">
            <label htmlFor="s-voice-speed" className="block text-sm font-medium">
              Speed
            </label>
            <span className="mt-0.5 block text-[12px] text-ink-2">1 is normal; 0.5 to 2.</span>
          </span>
          <input id="s-voice-speed" type="number" min={0.5} max={2} step={0.05} className="min-h-8 w-24 rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-right text-sm" value={voice.prefs.speed} onChange={(e) => voice.setPrefs({ speed: Number(e.target.value) })} />
        </div>
        <div className="grid gap-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">
              <span className="block font-medium">Test voice</span>
              <span className="block text-[12px] text-ink-2">Speaks one sentence through TalkForge.</span>
            </span>
            <button type="button" onClick={() => void test()} disabled={testing} data-testid="voice-test" className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-sm hover:border-accent disabled:opacity-40">
              {testing ? <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> : <Volume2 size={14} aria-hidden="true" />} {testing ? 'Speaking…' : 'Test voice'}
            </button>
          </div>
          <div aria-live="polite" data-testid="voice-test-result" className="text-[12.5px]">
            {voice.error && !testing ? (
              <p className="flex items-start gap-1.5 text-bad">
                <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {voice.error}
              </p>
            ) : (
              note && (
                <p className="flex items-start gap-1.5 text-ink-2">
                  <CheckCircle2 size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {note}
                </p>
              )
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

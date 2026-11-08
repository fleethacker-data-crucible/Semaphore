// Settings > AI drafting > Spoken answers and Voice input, as in Lazarette's Assistant settings
// (PRs 140, 141, 142, 144). The address, the token, starting TalkForge and its folder are set up on
// this computer (SEMAPHORE_VOICE_URL, the TALKFORGE_TOKEN share in Lazarette or SEMAPHORE_VOICE_TOKEN,
// and "voice" in config\settings.json): the page shows where they come from and never sees the token.
// The voice, the speed and the voice input switches are this person's, in this browser.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, Volume2 } from 'lucide-react';
import { api, describeError } from '../lib/api.ts';
import { type TalkForgeVoices, voiceOptions } from '../lib/talkforge-voices.ts';
import { voice } from '../lib/voice.ts';

interface VoiceStatus {
  url: string;
  problem: string;
  tokenSource: 'environment' | 'lazarette';
  tokenShare: string;
  autoStart: boolean;
  folder: string;
  folderSetting: string;
  folderSource: '' | 'environment' | 'settings';
  folderProblem: string;
  input: boolean;
}

const row = 'flex min-h-14 items-center justify-between gap-6 py-3';

function useVoice() {
  useSyncExternalStore(voice.subscribe, voice.snapshot, voice.snapshot);
  return voice;
}

function folderLine(s: VoiceStatus | null): string {
  if (!s) return 'Checking…';
  if (s.folderProblem) return s.folderProblem;
  if (s.folder) return s.folder;
  return s.folderSetting ? `Not found in ${s.folderSetting}` : 'Not found';
}

export function VoiceCard() {
  const v = useVoice();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [voices, setVoices] = useState<TalkForgeVoices | null>(null);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    api<VoiceStatus>('/api/voice').then(setStatus, (e: unknown) => setFailed(describeError(e)));
    api<TalkForgeVoices>('/api/voice/voices').then(setVoices, () => setVoices(null));
  }, []);

  const test = async () => {
    if (testing) return;
    setNote('');
    setTesting(true);
    // Starts TalkForge first when it is not running ("Getting the voice ready").
    if (!(await voice.ensureReady())) {
      setTesting(false);
      return;
    }
    voice.say('Semaphore can read the assistant’s answers aloud.');
    const started = Date.now();
    // Done when speech ends; the outcome is voice.error or a played clip.
    while ((voice.speaking || Date.now() - started < 200) && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
    setNote(voice.error ? '' : 'Played. If you heard nothing, check the speaker volume.');
    setTesting(false);
  };

  const options = voiceOptions(voices, v.prefs.voice);
  const folderHint =
    status?.folderSource === 'environment'
      ? 'From SEMAPHORE_VOICE_FOLDER on this computer.'
      : status?.folderSource === 'settings'
        ? 'From voice.folder in config\\settings.json.'
        : 'Found next to the Semaphore folder or in your Projects folder; set voice.folder in config\\settings.json if yours is elsewhere.';

  return (
    <section aria-label="Spoken answers" className="rounded-lg border border-line bg-panel" data-testid="voice-settings">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Spoken answers</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">
          TalkForge, running on this computer, can read the assistant&apos;s answers aloud: turn on Read answers aloud (the speaker) in the assistant panel. Semaphore starts TalkForge when it is needed, or uses the one already running. Answer text goes only to TalkForge, through this Semaphore.
        </p>
      </header>
      <div className="divide-y divide-line px-5">
        <div className={row}>
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
        <div className={row}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Token</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">
              {status?.tokenSource === 'environment'
                ? 'From SEMAPHORE_VOICE_TOKEN on this computer.'
                : `From Lazarette: share ${status?.tokenShare ?? 'TALKFORGE_TOKEN'} with Semaphore (Lazarette > Settings > Tools > Semaphore). Any random text of 16 or more characters; TalkForge is started with it.`}
            </span>
          </span>
          <span className="text-sm text-ink-2">Never shown</span>
        </div>
        <div className={row}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Start TalkForge automatically</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">When speech is needed and TalkForge is not running, Semaphore starts it with the token, and it stops by itself after 30 idle minutes (or when Semaphore stops). Set with voice.autoStart in config\settings.json.</span>
          </span>
          <span className="text-sm" data-testid="voice-autostart">
            {status ? (status.autoStart ? 'On' : 'Off') : '…'}
          </span>
        </div>
        <div className={row}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">TalkForge folder</span>
            <span className="mt-0.5 block text-[12px] text-ink-2">{folderHint}</span>
          </span>
          <span className={`max-w-[320px] break-all text-right font-mono text-[12px] ${status && !status.folder ? 'text-bad' : ''}`} data-testid="voice-folder">
            {folderLine(status)}
          </span>
        </div>
        <div className={row}>
          <span className="min-w-0 flex-1">
            <label htmlFor="s-voice-name" className="block text-sm font-medium">
              Voice
            </label>
            <span className="mt-0.5 block text-[12px] text-ink-2">{voices?.message || 'The voices installed in TalkForge. Medium quality starts speaking much sooner than high.'}</span>
          </span>
          <select id="s-voice-name" data-testid="voice-name" className="min-h-8 w-full max-w-[320px] rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-sm" value={v.prefs.voice} onChange={(e) => voice.setPrefs({ voice: e.target.value })}>
            {options.map((o) => (
              <option key={o.value || 'default'} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <span className="min-w-0 flex-1">
            <label htmlFor="s-voice-speed" className="block text-sm font-medium">
              Speed
            </label>
            <span className="mt-0.5 block text-[12px] text-ink-2">1 is normal; 0.5 to 2.</span>
          </span>
          <input id="s-voice-speed" type="number" min={0.5} max={2} step={0.05} className="min-h-8 w-24 rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-right text-sm" value={v.prefs.speed} onChange={(e) => voice.setPrefs({ speed: Number(e.target.value) })} />
        </div>
        <div className="grid gap-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm">
              <span className="block font-medium">Test voice</span>
              <span className="block text-[12px] text-ink-2">Speaks one sentence through TalkForge, starting it first if needed.</span>
            </span>
            <button type="button" onClick={() => void test()} disabled={testing} data-testid="voice-test" className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-sm hover:border-accent disabled:opacity-40">
              {testing ? <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> : <Volume2 size={14} aria-hidden="true" />} {testing ? (v.preparing ? 'Getting ready…' : 'Speaking…') : 'Test voice'}
            </button>
          </div>
          <div aria-live="polite" data-testid="voice-test-result" className="text-[12.5px]">
            {v.preparing ? (
              <p className="flex items-start gap-1.5 text-ink-2">
                <LoaderCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0 animate-spin" /> Getting the voice ready… TalkForge is starting; this takes a few seconds the first time.
              </p>
            ) : v.error && !testing ? (
              <p className="flex items-start gap-1.5 text-bad">
                <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {v.error}
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

/** Settings > AI drafting > Voice input: talk to the assistant (Lazarette PR 142). */
export function VoiceInputCard() {
  const v = useVoice();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    api<VoiceStatus>('/api/voice').then(
      (s) => setAllowed(s.input),
      () => setAllowed(null),
    );
  }, []);
  const off = allowed === false;
  const toggle = (label: string, hint: string, checked: boolean, onChange: (on: boolean) => void, disabled: boolean, testid: string) => (
    <label className={`${row} cursor-pointer ${disabled ? 'cursor-default opacity-60' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-5 text-ink-2">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
    </label>
  );
  return (
    <section aria-label="Voice input" className="rounded-lg border border-line bg-panel" data-testid="voice-input-settings">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Voice input</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">
          Talk to the assistant: click the orb (or the microphone next to Send) and speak. Whisper turns your words into text in this page; the audio never leaves this computer, and the microphone is open only while it listens. Uses TalkForge&apos;s speech-to-text files.
        </p>
      </header>
      <div className="divide-y divide-line px-5">
        {off && (
          <p className="flex items-start gap-1.5 py-3 text-[12.5px] text-ink-2" data-testid="voice-input-off">
            <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> Voice input is turned off for this Semaphore (voice.input in config\settings.json), and the microphone is blocked for it.
          </p>
        )}
        {toggle('Talk with the microphone', 'Off removes the microphone button, and the orb only opens the assistant.', v.prefs.input && !off, (on) => voice.setPrefs({ input: on }), off, 's-voice-input')}
        {toggle('Send when I stop talking', 'After about a second and a half of quiet, the message is sent. Off: check the words, then press Send.', v.prefs.autoSend, (on) => voice.setPrefs({ autoSend: on }), off || !v.prefs.input, 's-voice-autosend')}
      </div>
    </section>
  );
}

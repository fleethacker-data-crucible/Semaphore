// The Semaphore assistant and its orb, as in Lazarette (StarkDock.svelte and AssistantOrb.svelte).
// Loaded after the page paints (lib/assistant-bus.ts). The panel docks on the right; the orb floats
// over the page, can be dragged, and opens the panel when clicked, held, or activated with Enter.
// Talking to it (Lazarette PR 142): a click on the orb, or the microphone next to Send, opens the panel
// and listens; the words go into the message box and are sent when you stop talking. A click while it
// listens stops without sending; with press and hold, letting go sends.

import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert, LoaderCircle, Mic, MicOff, Sparkles, Square, SendHorizontal, SquarePen, Volume2, VolumeOff, X } from 'lucide-react';
import '../../vendor/binnacle/binnacle.js';
import type { AiStatus } from '../lib/ai.ts';
import { assistant, assistantOrbState, MAX_QUESTION, type PageOutline } from '../lib/assistant.ts';
import { takePendingOpen } from '../lib/assistant-bus.ts';
import { HOLD_MS, orbGesture, useOrbPrefs } from '../lib/orb-prefs.ts';
import { voice } from '../lib/voice.ts';
import { dictation } from '../lib/dictation.ts';
import { joinDraft } from '../lib/dictation-audio.ts';

function useVoice() {
  useSyncExternalStore(voice.subscribe, voice.snapshot, voice.snapshot);
  return voice;
}

function useDictation() {
  useSyncExternalStore(dictation.subscribe, dictation.snapshot, dictation.snapshot);
  return dictation;
}

/** What a transcript is sent with: the latest AI status and page outline (set by AssistantRoot). */
const sendContext: { ai: AiStatus | null; on: boolean; page: PageOutline | null } = { ai: null, on: false, page: null };

function focusInput(): void {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="assistant-input"]')?.focus());
}

/** Voice input can be used: on in this person's Settings and not switched off for this Semaphore. */
const canTalk = () => voice.prefs.input && !dictation.off;

/** Opens the panel and listens; false when voice input is off or the microphone could not be opened. */
async function startTalking(): Promise<boolean> {
  voice.stop();
  assistant.toggle(true);
  if (voice.prefs.speak) voice.warmUp(); // TalkForge starts while you talk
  if (!canTalk() || assistant.busy) {
    focusInput();
    return false;
  }
  const before = assistant.draft;
  const ok = await dictation.start({
    onText: (text) => assistant.setDraft(joinDraft(before, text)),
    onDone: () => {
      if (voice.prefs.autoSend && assistant.draft.trim()) void assistant.send(assistant.draft, { status: sendContext.ai, on: sendContext.on }, sendContext.page);
    },
  });
  if (!ok) focusInput();
  return ok;
}

/** Ends listening: send keeps what was said (and sends it when that is on); otherwise it is dropped. */
function stopTalking(send: boolean): void {
  dictation.stop(send);
  focusInput();
}

interface BinnacleOrb {
  el: HTMLElement;
  destroy(): void;
  setLook(name: string): BinnacleOrb;
  setTheme(name: string): BinnacleOrb;
}
interface BinnacleApi {
  mount(opts: Record<string, unknown>): BinnacleOrb;
  voice: { set(state: string | null, level?: number, text?: string): void; setLevel(level: number): void };
}
declare global {
  interface Window {
    Binnacle?: BinnacleApi;
  }
}

const SUGGESTIONS = ['How do I add a flag?', 'How do I compare with last year?', 'How do I export to Excel?', 'How do I pair with Lazarette?'];

function useAssistant() {
  useSyncExternalStore(assistant.subscribe, assistant.snapshot, assistant.snapshot);
  return assistant;
}

/**
 * The floating orb, as Lazarette's newest (AssistantOrb.svelte, PR 140): no menu on hover, since its
 * look, theme and how you talk to it are chosen in Settings > Appearance. Talking is a click, or a
 * press held still, whichever the person chose; a drag is never a hold.
 */
function Orb() {
  const a = useAssistant();
  const prefs = useOrbPrefs();
  const orbRef = useRef<BinnacleOrb | null>(null);
  const talkRef = useRef(prefs.talk);
  talkRef.current = prefs.talk;
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    const B = window.Binnacle;
    if (!B) return;
    const orb = B.mount({
      id: 'semaphore-assistant',
      name: 'Semaphore assistant',
      look: prefs.look,
      theme: prefs.theme,
      size: 130,
      zIndex: 40,
      picker: false, // no menu on hover; the choices are in Settings
      // Left of the assistant panel (380 px), so the orb can be clicked again to stop listening while it is open.
      x: Math.max(120, window.innerWidth - 380 - 110),
      y: window.innerHeight - 110,
      onActivate: () => {
        // A click (or Enter). With "press and hold" a quick click does nothing but say how.
        if (talkRef.current !== 'click') {
          B.voice.set(null, 0, 'Press and hold to talk');
          return;
        }
        if (dictation.active) stopTalking(false); // a click while listening stops without sending
        else if (canTalk()) void startTalking();
        else {
          voice.stop();
          assistant.toggle();
          if (assistant.open && voice.prefs.speak) voice.warmUp();
        }
      },
    });
    orbRef.current = orb;
    // The orb remembers its own last look; Settings is the one place that decides it.
    orb.setLook(prefs.look);
    orb.setTheme(prefs.theme);

    // Press and hold: held still for HOLD_MS opens the assistant; releasing puts the cursor in it.
    const hit = orb.el.querySelector<HTMLElement>('.binnacle-hit');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | null = null;
    let held = false;
    const down = (e: PointerEvent) => {
      if (talkRef.current !== 'hold' || e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        held = true;
        setHolding(true);
        void startTalking(); // listening while held; just the panel when voice input is off
      }, HOLD_MS);
    };
    const move = (e: PointerEvent) => {
      if (start && orbGesture(start, { x: e.clientX, y: e.clientY }, 0) === 'drag') {
        clearTimeout(timer);
        start = null;
      }
    };
    const up = () => {
      clearTimeout(timer);
      start = null;
      if (held) {
        held = false;
        setHolding(false);
        if (dictation.active) stopTalking(true); // letting go sends
        else focusInput();
      }
    };
    hit?.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      clearTimeout(timer);
      hit?.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      orb.destroy();
      orbRef.current = null;
      B.voice.set('idle', 0);
    };
    // Mounted once; look and theme changes go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    orbRef.current?.setLook(prefs.look);
  }, [prefs.look]);
  useEffect(() => {
    orbRef.current?.setTheme(prefs.theme);
  }, [prefs.theme]);
  const v = useVoice();
  const d = useDictation();
  useEffect(() => {
    const orbVoice = window.Binnacle?.voice;
    if (!orbVoice) return;
    // (Binnacle's set() returns the voice object for chaining: never return it from the effect.)
    if (d.state === 'listening') orbVoice.set('listening', d.level, 'Listening'); // lib/dictation.ts follows the microphone
    else if (d.state === 'preparing') orbVoice.set('thinking', 0, 'Getting the microphone ready');
    else if (d.state === 'transcribing') orbVoice.set('thinking', 0, 'Writing it down');
    else if (holding) orbVoice.set('listening', 0);
    else if (v.preparing) orbVoice.set('thinking', 0, 'Getting the voice ready');
    else if (!v.speaking) orbVoice.set(assistantOrbState(a.busy, a.open), 0); // while speaking, lib/voice.ts sets 'speaking' with the real audio level
  }, [a.busy, a.open, holding, v.speaking, v.preparing, d.state]);
  return null;
}

function Dock({ ai, aiOn, page, onClose }: { ai: AiStatus | null; aiOn: boolean; page: PageOutline | null; onClose: () => void }) {
  const a = useAssistant();
  const v = useVoice();
  const d = useDictation();
  const talk = v.prefs.input && !d.off;
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [a.messages]);
  useEffect(() => {
    input.current?.focus();
    void dictation.probe();
  }, []);
  const send = (text = a.draft) => void a.send(text, { status: ai, on: aiOn }, page);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') onClose();
  };
  const viaFairlead = !!ai?.configured && aiOn;
  return (
    <aside aria-label="Semaphore assistant" data-testid="assistant-dock" className="fixed bottom-0 right-0 top-0 z-[45] flex w-[380px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <div aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-accent text-[var(--fl-accent-ink)]">
          <Sparkles size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] font-semibold">Semaphore assistant</h2>
          <p className="truncate text-[11.5px] text-ink-2" data-testid="assistant-status">
            {viaFairlead ? '' : 'Guide mode · '}
            {a.status}
          </p>
        </div>
        <button
          type="button"
          aria-label={v.prefs.speak ? 'Stop reading answers aloud' : 'Read answers aloud'}
          aria-pressed={v.prefs.speak}
          onClick={() => {
            v.setPrefs({ speak: !v.prefs.speak });
            if (v.prefs.speak) v.warmUp(); // TalkForge starts now, so the first answer speaks sooner
          }}
          data-testid="assistant-speak" className={`grid size-8 place-items-center rounded-md hover:bg-panel-2 ${v.prefs.speak ? 'text-accent' : 'text-ink-2'}`}>
          {v.prefs.speak ? <Volume2 size={16} /> : <VolumeOff size={16} />}
        </button>
        <button type="button" aria-label="New chat" onClick={() => a.newChat()} className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2">
          <SquarePen size={16} />
        </button>
        <button type="button" aria-label="Close assistant" onClick={() => {
            voice.stop();
            dictation.cancel();
            onClose();
          }} className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-panel-2">
          <X size={16} />
        </button>
      </header>

      {d.state === 'listening' ? (
        <p role="status" data-testid="assistant-listening" className="flex items-center gap-1.5 border-b border-line bg-accent-soft px-4 py-2 text-[12px]">
          <Mic size={14} aria-hidden="true" className="shrink-0 animate-pulse text-accent" /> Listening… {v.prefs.autoSend ? 'speak, then pause to send.' : 'speak, then press Send.'} Click the microphone to stop.
        </p>
      ) : d.state === 'preparing' ? (
        <p role="status" data-testid="assistant-listening-preparing" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[12px] text-ink-2">
          <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" /> Getting the microphone ready…
        </p>
      ) : d.state === 'transcribing' ? (
        <p role="status" data-testid="assistant-transcribing" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[12px] text-ink-2">
          <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" /> Writing down what you said…
        </p>
      ) : (
        d.error && (
          <p role="status" data-testid="assistant-listening-error" className="flex items-start gap-1.5 border-b border-line px-4 py-2 text-[12px] text-bad">
            <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {d.error}
          </p>
        )
      )}
      {v.preparing && v.prefs.speak ? (
        <p role="status" data-testid="assistant-speak-preparing" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[12px] text-ink-2">
          <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin" /> Getting the voice ready… this takes a few seconds the first time.
        </p>
      ) : (
        v.error &&
        v.prefs.speak && (
          <p role="status" data-testid="assistant-speak-error" className="flex items-start gap-1.5 border-b border-line px-4 py-2 text-[12px] text-bad">
            <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" /> {v.error}
          </p>
        )
      )}
      <div ref={list} role="log" aria-live="polite" aria-label="Conversation" data-testid="assistant-log" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!a.messages.length ? (
          <div className="mx-auto max-w-[300px] pt-6 text-center">
            <div aria-hidden="true" className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Sparkles size={20} />
            </div>
            <h3 className="text-[14px] font-semibold">Ask the Semaphore assistant</h3>
            <p className="mt-1 text-[12.5px] leading-5 text-ink-2">
              {viaFairlead ? 'It answers from Semaphore\'s guide through Fairlead. It cannot see your data or change anything.' : 'Fairlead is not in use, so it answers from Semaphore\'s own guide, on this computer.'}
            </p>
            <div className="mt-4 grid gap-1.5">
              {SUGGESTIONS.map((q) => (
                <button key={q} type="button" onClick={() => send(q)} className="min-h-8 rounded-lg border border-line bg-panel px-3 py-2 text-left text-[12.5px] hover:bg-panel-2">
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {a.messages.map((m) => (
              <article key={m.id} data-role={m.role} className={`grid max-w-[92%] gap-1 ${m.role === 'user' ? 'justify-self-end' : 'justify-self-start'}`}>
                <span className={`text-[10.5px] font-semibold tracking-wider text-ink-2 ${m.role === 'user' ? 'text-right' : ''}`}>{m.role === 'user' ? 'YOU' : 'SEMAPHORE'}</span>
                <div
                  data-testid={m.role === 'assistant' ? 'assistant-answer' : 'assistant-question'}
                  className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[13px] leading-[1.55] ${m.role === 'user' ? 'rounded-br-md bg-accent text-[var(--fl-accent-ink)]' : 'rounded-bl-md border border-line bg-panel-2'}`}
                >
                  {m.content}
                  {m.role === 'assistant' && !m.complete && !m.error && <span aria-label="Thinking" className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-[-2px]" />}
                </div>
                {m.error && (
                  <p className="flex items-center gap-1 text-[11.5px] text-bad">
                    <CircleAlert size={12} aria-hidden="true" /> {m.error}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="border-t border-line p-3">
        {viaFairlead && (
          <label className="mb-2 flex items-start gap-2 text-[11.5px] leading-4 text-ink-2">
            <input type="checkbox" className="mt-px size-4" checked={a.includePage} disabled={a.busy} onChange={(e) => a.setIncludePage(e.target.checked)} aria-label="Include this page" data-testid="assistant-page" />
            <span>Include this page (its title, brief and flag titles and briefs; never data, sources or secrets). Off by default; it goes to Fairlead.</span>
          </label>
        )}
        <div className="focus-frame rounded-xl border border-[var(--fl-control-border)] bg-panel">
          <textarea
            ref={input}
            value={a.draft}
            onChange={(e) => a.setDraft(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            maxLength={MAX_QUESTION}
            disabled={a.busy}
            placeholder="Ask about Semaphore… (Enter to send)"
            aria-label="Message the Semaphore assistant"
            data-testid="assistant-input"
            className="block max-h-36 min-h-12 w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] outline-none"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="pl-1 text-[11px] text-ink-2">Never paste passwords, tokens or keys.</span>
            {talk && (
              <button
                type="button"
                aria-label={d.active ? 'Stop listening' : 'Talk instead of typing'}
                aria-pressed={d.active}
                onClick={() => (d.active ? stopTalking(true) : void startTalking())}
                disabled={a.busy}
                data-testid="assistant-mic"
                className={`ml-auto mr-1 grid size-8 place-items-center rounded-md hover:bg-panel-2 disabled:opacity-40 ${d.active ? 'text-accent' : 'text-ink-2'}`}
              >
                {d.active ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            {a.busy ? (
              <button type="button" onClick={() => a.stop()} data-testid="assistant-stop" className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--fl-control-border)] px-2.5 text-[13px]">
                <Square size={14} aria-hidden="true" /> Stop
              </button>
            ) : (
              <button type="button" onClick={() => send()} disabled={!a.draft.trim()} data-testid="assistant-send" className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[13px] font-semibold text-[var(--fl-accent-ink)] disabled:opacity-40">
                <SendHorizontal size={14} aria-hidden="true" /> Send
              </button>
            )}
          </div>
        </div>
      </footer>
    </aside>
  );
}

export function AssistantRoot({ orb, ai, aiOn, page }: { orb: boolean; ai: AiStatus | null; aiOn: boolean; page: PageOutline | null }) {
  const a = useAssistant();
  sendContext.ai = ai;
  sendContext.on = aiOn;
  sendContext.page = page;
  // The header button and Ctrl+K ask through lib/assistant-bus.ts, which works before this loaded.
  useEffect(() => {
    if (takePendingOpen()) assistant.toggle(true);
    void dictation.probe(); // before the first click on the orb: is voice input on for this Semaphore?
    const open = () => {
      takePendingOpen();
      assistant.toggle();
    };
    window.addEventListener('semaphore:assistant', open);
    return () => window.removeEventListener('semaphore:assistant', open);
  }, []);
  return (
    <>
      {orb && <Orb />}
      {a.open && <Dock ai={ai} aiOn={aiOn} page={page} onClose={() => assistant.toggle(false)} />}
    </>
  );
}

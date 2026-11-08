// Voice input, as in Lazarette (ui-src/src/lib/dictation.svelte.ts, PR 142): the microphone,
// transcribed in this tab by Whisper (web/src/stt-worker.ts). The words appear in the assistant's
// message box while you talk; when you stop talking (about 1.5 s of quiet) the message is sent, if
// Settings say so. The microphone is open only while listening and is closed the moment listening
// ends. Audio never leaves the tab: no request carries it.
//
// Loaded with the assistant panel (components/AssistantRoot.tsx is a lazy chunk), and the worker
// starts only the first time someone talks, so neither is part of the page's start.

import { api, ApiError, describeError } from './api.ts';
import { cleanTranscript, createUtterance, downsample, rms, type Utterance } from './dictation-audio.ts';

declare const __SEMAPHORE_STT__: string;

export type DictationState = 'idle' | 'preparing' | 'listening' | 'transcribing';

export interface DictationHandlers {
  /** The words so far (final: the last pass, after you stopped). */
  onText: (text: string, final: boolean) => void;
  /** What was said, once listening ended with send. */
  onDone: (text: string) => void;
}

/** GET /api/voice/dictation/status. */
export interface DictationStatus {
  ready: boolean;
  missing: string[];
  message: string;
}

interface Pending {
  resolve: (t: string) => void;
  reject: (e: Error) => void;
}

export class Dictation {
  state: DictationState = 'idle';
  /** Microphone loudness while listening, for the orb (linear RMS, about 0 to 0.3). */
  level = 0;
  error = '';
  /** Voice input is off for this Semaphore (the server said so): the orb then only opens the panel. */
  off = false;

  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private utterance: Utterance | null = null;
  private handlers: DictationHandlers | null = null;
  private interim: ReturnType<typeof setInterval> | undefined;
  private interimBusy = false;
  private run = 0;
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get active(): boolean {
    return this.state !== 'idle';
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): number => this.version;
  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
  private set(state: DictationState): void {
    this.state = state;
    this.changed();
  }

  private probed = false;

  /** Asks once whether this Semaphore allows voice input (GET /api/voice, input), so the mic button can hide. */
  async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    try {
      const s = await api<{ input?: boolean }>('/api/voice', { quiet: true });
      if (s.input === false && !this.off) {
        this.off = true;
        this.changed();
      }
    } catch {
      this.probed = false; // ask again next time the panel opens
    }
  }

  /** Starts listening. Resolves once the microphone is open (true), or failed (false: see error). */
  async start(handlers: DictationHandlers): Promise<boolean> {
    if (this.active) return true;
    this.error = '';
    this.handlers = handlers;
    const run = ++this.run;
    this.set('preparing');
    try {
      const status = await api<DictationStatus>('/api/voice/dictation/status', { quiet: true });
      this.off = false;
      if (run !== this.run) return false;
      if (!status.ready) throw new Error(status.message);
      this.ensureWorker();
      void this.call({ type: 'load' }).catch(() => undefined); // warms Whisper up while you start talking
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not offer a microphone to this page.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.stream = stream;
      if (run !== this.run) {
        this.closeMic();
        return false;
      }
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaStreamSource(stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.utterance = createUtterance();
      const rate = this.ctx.sampleRate;
      this.node.onaudioprocess = (ev) => {
        if (run !== this.run || this.state !== 'listening') return;
        const raw = ev.inputBuffer.getChannelData(0);
        this.level = Math.min(0.3, rms(raw) * 2);
        window.Binnacle?.voice.set('listening', this.level, 'Listening');
        if (this.utterance!.push(downsample(raw, rate)) === 'done') void this.finish(true);
      };
      source.connect(this.node);
      this.node.connect(this.ctx.destination); // a ScriptProcessor only runs when connected; it outputs silence
      this.set('listening');
      this.interim = setInterval(() => void this.showInterim(run), 1800);
      return true;
    } catch (e) {
      if (run !== this.run) return false;
      if (e instanceof ApiError && e.status === 403) {
        this.off = true;
        this.reset();
        return false;
      }
      this.error =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          ? 'The microphone is blocked for Semaphore. Allow it in the browser (the icon in the address bar), then try again.'
          : e instanceof DOMException && e.name === 'NotFoundError'
            ? 'No microphone was found on this computer.'
            : describeError(e);
      this.reset();
      return false;
    }
  }

  /** Stops listening. With send, what was said is transcribed and handed on; without, it is dropped. */
  stop(send: boolean): void {
    if (this.state === 'listening') void this.finish(send);
    else if (this.state === 'preparing') {
      this.run++;
      this.reset();
    }
  }

  /** Closes the microphone and drops what was said (the panel closed). */
  cancel(): void {
    this.run++;
    this.reset();
  }

  private async finish(send: boolean): Promise<void> {
    const run = this.run;
    const u = this.utterance;
    clearInterval(this.interim);
    this.closeMic();
    if (!send || !u || !u.heard) {
      this.reset();
      return;
    }
    this.set('transcribing');
    try {
      const text = cleanTranscript(await this.transcribe(u.audio()));
      if (run !== this.run) return;
      this.handlers?.onText(text, true);
      if (text) this.handlers?.onDone(text);
    } catch (e) {
      if (run === this.run) this.error = describeError(e);
    } finally {
      if (run === this.run) this.reset();
    }
  }

  // While you talk, the words so far are shown (one transcription at a time).
  private async showInterim(run: number): Promise<void> {
    if (this.interimBusy || run !== this.run || this.state !== 'listening' || !this.utterance?.heard) return;
    this.interimBusy = true;
    try {
      const text = cleanTranscript(await this.transcribe(this.utterance.audio()));
      if (run === this.run && this.state === 'listening' && text) this.handlers?.onText(text, false);
    } catch {
      // The final pass reports errors.
    } finally {
      this.interimBusy = false;
    }
  }

  private transcribe(audio: Float32Array): Promise<string> {
    return this.call({ type: 'transcribe', audio }, [audio.buffer]);
  }

  private ensureWorker(): void {
    if (this.worker) return;
    if (typeof Worker === 'undefined' || typeof __SEMAPHORE_STT__ !== 'string') throw new Error('Voice input needs a browser with Web Workers.');
    this.worker = new Worker(__SEMAPHORE_STT__, { type: 'module', name: 'semaphore-stt' });
    this.worker.onmessage = (e: MessageEvent<{ type: string; id?: number; text?: string; message?: string }>) => {
      const m = e.data;
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.type === 'error') p.reject(new Error(`Speech-to-text failed: ${m.message ?? 'unknown error'}`));
      else p.resolve(m.text ?? '');
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      const err = new Error(`Speech-to-text failed: ${e.message || 'the worker did not start'}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
  }

  private call(msg: { type: string; audio?: Float32Array }, transfer: Transferable[] = []): Promise<string> {
    this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  private closeMic(): void {
    if (this.node) {
      this.node.onaudioprocess = null;
      try {
        this.node.disconnect();
      } catch {
        // already gone
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null;
    this.stream = null;
    this.ctx = null;
    this.level = 0;
  }

  private reset(): void {
    clearInterval(this.interim);
    this.closeMic();
    this.utterance = null;
    this.set('idle');
  }
}

export const dictation = new Dictation();

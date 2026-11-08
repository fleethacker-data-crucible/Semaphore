// Spoken answers, as in Lazarette (ui-src/src/lib/voice.svelte.ts, PR 140): the assistant's answer is
// read aloud through TalkForge a sentence at a time. The page never talks to TalkForge: each piece goes
// to POST /api/voice/speak on this origin, the server relays it to TalkForge on this computer with the
// token, and the WAV that comes back plays from a blob: URL. One piece is fetched ahead while the
// current one plays. The real audio level drives the orb.
//
// TalkForge need not be running first (Lazarette PR 141): when a piece comes back voice-offline, the
// page asks the server to start it (POST /api/voice/start; the server reuses a TalkForge already
// answering and never starts a second one), says "Getting the voice ready" while it starts, and tries
// that piece once more. Turning the speaker on, or clicking the orb with the speaker on, warms it up.

import { api, ApiError, describeError, sessionToken } from './api.ts';
import { takeSpeakable } from './voice-text.ts';

export interface VoicePrefs {
  /** Read answers aloud: the speaker button in the assistant panel. */
  speak: boolean;
  /** A TalkForge voice id, or '' for TalkForge's default. */
  voice: string;
  /** 0.5 to 2. */
  speed: number;
  /** Talk with the microphone (voice input, Whisper in this page). */
  input: boolean;
  /** Send what was said when you stop talking. */
  autoSend: boolean;
}

/** GET /api/voice/status and POST /api/voice/start. */
export interface VoiceState {
  state: 'ready' | 'starting' | 'offline' | 'unavailable';
  message: string;
  startedHere?: boolean;
}

export interface VoiceLifecycle {
  status(): Promise<VoiceState>;
  start(): Promise<VoiceState>;
  /** Waits between status checks while TalkForge starts. */
  wait(ms: number): Promise<void>;
}

const serverLifecycle: VoiceLifecycle = {
  status: () => api<VoiceState>('/api/voice/status', { quiet: true }),
  start: () => api<VoiceState>('/api/voice/start', { json: {}, quiet: true }),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** How long the page waits for TalkForge to start (the server gives up at 45 s too). */
export const READY_WAIT_MS = 45_000;

const KEY = 'semaphore.voice';
const NAME = /^[A-Za-z0-9._-]{1,80}$/;

export function parseVoicePrefs(raw: unknown): VoicePrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const speed = typeof o.speed === 'number' && Number.isFinite(o.speed) ? Math.min(2, Math.max(0.5, o.speed)) : 1;
  return { speak: o.speak === true, voice: typeof o.voice === 'string' && NAME.test(o.voice) ? o.voice : '', speed: Math.round(speed * 100) / 100, input: o.input !== false, autoSend: o.autoSend !== false };
}

type Fetch = (text: string, prefs: VoicePrefs, signal: AbortSignal) => Promise<Blob>;

/** POST /api/voice/speak with the session token; the WAV, or an ApiError with the server's sentence. */
const relay: Fetch = async (text, prefs, signal) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = sessionToken();
  if (token) headers['X-Semaphore-Session'] = token;
  const res = await fetch('/api/voice/speak', { method: 'POST', headers, body: JSON.stringify({ text, voice: prefs.voice, speed: prefs.speed }), signal, cache: 'no-store', redirect: 'error' });
  if (!res.ok) {
    let code = 'voice';
    let message = `Speech failed (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { code?: string; error?: string };
      if (j.code) code = j.code;
      if (j.error) message = j.error;
    } catch {
      // Not JSON: keep the plain sentence.
    }
    throw new ApiError(res.status, code, message);
  }
  return res.blob();
};

interface OrbVoice {
  set(state: string | null, level?: number, text?: string): void;
}
const orbVoice = (): OrbVoice | undefined => (window as unknown as { Binnacle?: { voice: OrbVoice } }).Binnacle?.voice;

export class Voice {
  /** True while audio is playing or queued. */
  speaking = false;
  /** The last failure, cleared when speech starts again. */
  error = '';
  /** True while TalkForge is being started: "Getting the voice ready". */
  preparing = false;
  prefs: VoicePrefs;

  private buffer = '';
  private queue: string[] = [];
  private running = false;
  private gen = 0;
  private controller: AbortController | null = null;
  private audio: HTMLAudioElement | null = null;
  private url = '';
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private frame = 0;
  private endPlayback: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly fetchAudio: Fetch;
  private readonly lifecycle: VoiceLifecycle;
  private readying: Promise<boolean> | null = null;

  constructor(fetchAudio: Fetch = relay, lifecycle: VoiceLifecycle = serverLifecycle) {
    this.fetchAudio = fetchAudio;
    this.lifecycle = lifecycle;
    let raw: unknown = null;
    try {
      raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      raw = null;
    }
    this.prefs = parseVoicePrefs(raw);
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

  setPrefs(patch: Partial<VoicePrefs>): void {
    this.prefs = parseVoicePrefs({ ...this.prefs, ...patch });
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    if (!this.prefs.speak) this.stop();
    this.changed();
  }

  /**
   * Makes sure TalkForge can speak: asks the server, has it start TalkForge when nothing answers (it
   * reuses one that is running), and waits for it. One check at a time, however often it is called.
   */
  ensureReady(): Promise<boolean> {
    this.readying ??= this.ready().finally(() => {
      this.readying = null;
      if (this.preparing) {
        this.preparing = false;
        this.changed();
      }
    });
    return this.readying;
  }

  private async ready(): Promise<boolean> {
    try {
      let s = await this.lifecycle.status();
      if (s.state === 'ready') return true;
      if (s.state !== 'starting') s = await this.lifecycle.start();
      const until = Date.now() + READY_WAIT_MS;
      while (s.state === 'starting' && Date.now() < until) {
        if (!this.preparing) {
          this.preparing = true;
          this.changed();
        }
        await this.lifecycle.wait(600);
        s = await this.lifecycle.status();
      }
      if (s.state === 'ready') {
        this.error = '';
        return true;
      }
      this.error = s.state === 'starting' ? 'TalkForge did not start in time. Run talkforge serve in a terminal to see why.' : s.message || 'TalkForge is not running.';
      return false;
    } catch (e) {
      this.error = describeError(e);
      return false;
    }
  }

  /** Starts TalkForge in the background when it is not running, so the first answer speaks sooner. */
  warmUp(): void {
    void this.ensureReady().then(() => this.changed());
  }

  /** Adds answer text; complete sentences start speaking. */
  feed(text: string): void {
    if (!text) return;
    const r = takeSpeakable(this.buffer + text);
    this.buffer = r.rest;
    for (const p of r.pieces) this.enqueue(p);
  }

  /** The answer is complete: speak whatever is left. */
  flush(): void {
    const r = takeSpeakable(this.buffer, true);
    this.buffer = '';
    for (const p of r.pieces) this.enqueue(p);
  }

  /** Speaks one text from the start (an answer, or Settings > Test voice). */
  say(text: string): void {
    this.stop();
    this.feed(text);
    this.flush();
  }

  /** Stops playback, drops the queue and cancels requests in flight. */
  stop(): void {
    this.gen++;
    this.controller?.abort();
    this.controller = null;
    this.queue = [];
    this.buffer = '';
    this.running = false;
    this.endPlayback?.();
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
    }
    this.release();
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    const was = this.speaking;
    this.speaking = false;
    if (was) this.changed();
  }

  private enqueue(piece: string): void {
    this.queue.push(piece);
    this.speaking = true;
    this.error = '';
    this.changed();
    if (!this.running) void this.run(this.gen);
  }

  private fetchPiece(text: string, gen: number): Promise<Blob | null> {
    if (!this.controller) this.controller = new AbortController();
    const signal = this.controller.signal;
    return this.fetchAudio(text, this.prefs, signal).catch(async (e: unknown) => {
      // TalkForge not running: get it ready ("Getting the voice ready"), then try this piece once more.
      if (e instanceof ApiError && e.code === 'voice-offline' && gen === this.gen && !signal.aborted && (await this.ensureReady()) && gen === this.gen && !signal.aborted) {
        try {
          return await this.fetchAudio(text, this.prefs, signal);
        } catch (e2) {
          e = e2;
        }
      }
      if (gen === this.gen && !signal.aborted) {
        if (!this.error) this.error = describeError(e);
        this.changed();
      }
      return null;
    });
  }

  private async run(gen: number): Promise<void> {
    this.running = true;
    let current: Promise<Blob | null> | null = this.fetchPiece(this.queue.shift()!, gen);
    while (current && gen === this.gen) {
      const blob = await current;
      if (gen !== this.gen) return;
      if (!blob) {
        // The error is in this.error; the rest would fail too.
        this.stop();
        return;
      }
      const next = this.queue.length ? this.fetchPiece(this.queue.shift()!, gen) : null;
      await this.play(blob, gen);
      if (gen !== this.gen) return;
      current = next ?? (this.queue.length ? this.fetchPiece(this.queue.shift()!, gen) : null);
    }
    if (gen === this.gen) {
      this.running = false;
      this.speaking = this.queue.length > 0;
      this.changed();
    }
  }

  private play(blob: Blob, gen: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (gen !== this.gen) return resolve();
      this.release();
      this.url = URL.createObjectURL(blob);
      const audio = (this.audio ??= new Audio());
      this.connectMeter(audio);
      const done = () => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        this.endPlayback = null;
        cancelAnimationFrame(this.frame);
        orbVoice()?.set('speaking', 0);
        resolve();
      };
      this.endPlayback = done;
      audio.addEventListener('ended', done);
      audio.addEventListener('error', done);
      audio.src = this.url;
      void this.ctx?.resume().catch(() => undefined);
      audio.play().then(() => this.meter(gen)).catch(() => done());
    });
  }

  // The orb follows the real audio: an analyser on the audio element, read once per frame and handed
  // straight to the orb, so the page does not re-render sixty times a second.
  private connectMeter(audio: HTMLAudioElement): void {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    try {
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.samples = new Float32Array(this.analyser.fftSize);
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  private meter(gen: number): void {
    if (gen !== this.gen || !this.analyser || !this.samples) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const s of this.samples) sum += s * s;
    orbVoice()?.set('speaking', Math.min(0.3, Math.sqrt(sum / this.samples.length)));
    this.frame = requestAnimationFrame(() => this.meter(gen));
  }

  private release(): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
  }
}

export const voice = new Voice();

// The face of a custom flag: the analyst's code drawing in a sandboxed frame. This file loads only
// when a page has a custom flag (FlagView); the frame loads its own bundle with ECharts in it.
//
// The frame is <iframe sandbox="allow-scripts"> on /sandbox/widget.html: no allow-same-origin, so
// its origin is opaque and it cannot reach this page's session token, storage or DOM. Its CSP (sent
// by the server) allows no network at all. Messages both ways carry the frame's nonce; ours go to
// the frame's window only, and we take messages only from that window, from origin "null".
//
// A widget stuck in a loop freezes its own frame, not the page: a watchdog pings it every second
// and replaces it when it stops answering.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Cell, Selections } from '../../../src/core/crossfilter.ts';
import { FONT_STACK, type HoistDesign, paletteColors, resolveStyle } from '../../../src/core/design.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { acceptFrameMessage, type HostMessage, newNonce, selectAllowed } from '../../../src/core/widget-protocol.ts';
import type { FlagResult } from '../lib/data.ts';
import { finishStart, offerPicture, queueStart, reportSandboxStall, reportWidget, sandboxRestLeft, setRendering, stallCulprit, useSandboxRest, type WidgetPicture } from '../lib/widget-bus.ts';
import { widgetData, widgetTheme } from '../lib/widget-data.ts';
import { STARTER_CODE, STARTER_CSS } from '../lib/widget-templates.ts';
import { themeColors, themeMode } from './Chart.tsx';

export const SANDBOX_PAGE = '/sandbox/widget.html';
/** How often the frame is pinged, and how long it may take to answer before it is replaced. */
export const PING_MS = 1000;
export const STALL_MS = 4000;
const LOAD_MS = 10000;
/** A widget that stalls this many times in a row is treated as the one stuck, and waits for its code to change. */
const MAX_STALLS = 3;

export interface CustomWidgetProps {
  flag: Flag;
  result: FlagResult | undefined;
  index: CatalogIndex;
  selections: Selections;
  onSelect: (key: string, value: Cell, additive: boolean) => void;
  themeKey: string;
  design?: HoistDesign;
}

export default function CustomWidget({ flag, result, index, selections, onSelect, themeKey, design }: CustomWidgetProps) {
  const [generation, setGeneration] = useState(0);
  const nonce = useMemo(() => newNonce(), [generation]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  // live: the frame is up. paused: every frame on the page is down while the browser ends a stuck
  // sandbox process. dead: this widget's own code stopped answering; it waits for new code or a click.
  const [phase, setPhase] = useState<'live' | 'paused' | 'dead'>('live');
  const live = phase === 'live';
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  const code = flag.widget?.code ?? STARTER_CODE;
  const css = flag.widget?.css ?? (flag.widget ? '' : STARTER_CSS);

  const data = useMemo(() => widgetData(result, index, selections), [result, index, selections]);
  const style = useMemo(() => resolveStyle(design, flag.style), [design, flag.style]);
  const theme = useMemo(() => {
    const c = themeColors();
    const mode = themeMode();
    return widgetTheme(c, paletteColors(style, mode, c.series), FONT_STACK[design?.font ?? 'system'], mode === 'dark');
    // themeKey re-reads the colour tokens after a theme change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, themeKey, design?.font]);

  const send = useCallback((m: HostMessage) => {
    // The frame's origin is opaque, so it cannot be named; the message goes to that one window.
    frame.current?.contentWindow?.postMessage(m, '*');
  }, []);

  const latest = useRef({ data, onSelect, behavior: flag.behavior });
  latest.current = { data, onSelect, behavior: flag.behavior };
  // Stalls in a row with no good render between them: a widget that keeps stalling stops retrying.
  const stalls = useRef(0);

  // Watchdog and messages for one frame (one nonce per frame), while it is up.
  useEffect(() => {
    if (!live) return;
    setReady(false);
    reportWidget(flag.id, { state: 'loading' });
    const state = { pending: null as number | null, seq: 0, pictureSeq: 0, lastTick: Date.now(), readyAt: 0, gaveUp: false, selects: [] as number[], pictures: new Map<number, (p: WidgetPicture | null) => void>() };
    const started = Date.now();
    const onMessage = (e: MessageEvent) => {
      const m = acceptFrameMessage(e, { window: frame.current?.contentWindow ?? null, nonce });
      if (!m) return;
      if (m.type === 'ready') {
        state.readyAt = Date.now();
        setReady(true);
      } else if (m.type === 'pong') {
        if (state.pending !== null && m.seq === state.seq) state.pending = null;
      } else if (m.type === 'rendered') {
        setRendering(flag.id, false);
        finishStart(flag.id);
        stalls.current = 0;
        reportWidget(flag.id, { state: 'ready' });
      } else if (m.type === 'error') {
        setRendering(flag.id, false);
        finishStart(flag.id);
        reportWidget(flag.id, { state: 'error', error: m.message, ...(m.line ? { line: m.line } : {}) });
      } else if (m.type === 'select') {
        const now = latest.current;
        if (now.behavior.onClick === 'none' || !selectAllowed(m.key, now.data.columns)) return;
        // The frame's own limit can be skipped by code that posts directly, so the page keeps one too.
        const t = Date.now();
        while (state.selects.length && t - state.selects[0]! > 5000) state.selects.shift();
        if (state.selects.length >= 10) return;
        state.selects.push(t);
        now.onSelect(m.key, m.value, false);
      } else if (m.type === 'picture') {
        const done = state.pictures.get(m.seq);
        state.pictures.delete(m.seq);
        done?.(m.url ? { url: m.url, width: m.width, height: m.height } : null);
      }
    };
    window.addEventListener('message', onMessage);
    const giveUp = () => {
      if (state.gaveUp) return;
      state.gaveUp = true;
      stalls.current += 1;
      for (const done of state.pictures.values()) done(null);
      state.pictures.clear();
      finishStart(flag.id);
      // Every frame on the page shares the stuck process: all of them come down, and the one
      // drawing (if only one was) stays down (the effect on useSandboxRest below).
      reportSandboxStall();
    };
    const timer = window.setInterval(() => {
      const now = Date.now();
      const gap = now - state.lastTick;
      state.lastTick = now;
      // A hidden or throttled tab: the silence was ours, not the frame's.
      if (document.hidden || gap > PING_MS * 3) {
        state.pending = null;
        return;
      }
      if (!state.readyAt) {
        if (now - started > LOAD_MS) giveUp();
        return;
      }
      if (state.pending !== null) {
        if (now - state.pending > STALL_MS) giveUp();
        return;
      }
      state.seq += 1;
      state.pending = now;
      send({ type: 'ping', nonce, seq: state.seq });
    }, PING_MS);
    const withdraw = offerPicture(
      flag.id,
      () =>
        new Promise<WidgetPicture | null>((resolve) => {
          if (!state.readyAt) return resolve(null);
          state.pictureSeq += 1;
          const seq = state.pictureSeq;
          state.pictures.set(seq, resolve);
          send({ type: 'picture', nonce, seq });
          window.setTimeout(() => {
            if (state.pictures.delete(seq)) resolve(null);
          }, 3000);
        }),
    );
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
      withdraw();
      setRendering(flag.id, false);
      finishStart(flag.id);
      for (const done of state.pictures.values()) done(null);
    };
  }, [nonce, live, flag.id, send]);

  // Draw (again) whenever the code, the data or the colours change.
  useEffect(() => {
    if (!ready || !live) return;
    setRendering(flag.id, true);
    send({ type: 'render', nonce, code, css, data, theme });
  }, [ready, live, nonce, code, css, data, theme, send]);

  // Another widget's frame stalled: this one is frozen in the same process, so it comes down too.
  const rest = useSandboxRest();
  const seenRest = useRef(rest);
  useEffect(() => {
    if (rest === seenRest.current) return;
    seenRest.current = rest;
    // A widget already down for its own loop stays as it is; the rest come down for this stall.
    if (phaseNow.current === 'dead') return;
    const own = stallCulprit() === flag.id || stalls.current >= MAX_STALLS;
    reportWidget(flag.id, own ? { state: 'dead', error: 'This widget stopped responding.' } : { state: 'loading' });
    setPhase(own ? 'dead' : 'paused');
  }, [rest, flag.id]);

  // A paused widget comes back once the page has had no frames for the rest period, one widget at a time.
  useEffect(() => {
    if (phase !== 'paused') return;
    let withdraw: (() => void) | null = null;
    const t = window.setTimeout(() => {
      withdraw = queueStart(flag.id, () => {
        setGeneration((g) => g + 1);
        setPhase('live');
      });
    }, sandboxRestLeft());
    return () => {
      window.clearTimeout(t);
      withdraw?.();
    };
  }, [phase, rest, flag.id]);

  // A widget that stopped answering starts again (after the rest) when its code changes.
  const codeKey = `${code}\u0000${css}`;
  const deadFor = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== 'dead') {
      deadFor.current = null;
      return;
    }
    if (deadFor.current === null) deadFor.current = codeKey;
    else if (deadFor.current !== codeKey) {
      deadFor.current = null;
      stalls.current = 0;
      setPhase('paused');
    }
  }, [phase, codeKey]);

  if (phase === 'dead') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-xs" role="alert" data-testid="widget-dead">
        <p className="flex items-center gap-1.5 font-medium text-warn">
          <AlertTriangle size={14} aria-hidden="true" /> This widget stopped responding
        </p>
        <p className="text-ink-2">Its code may be stuck in a loop. Change the code in the inspector, or start it again.</p>
        <button
          type="button"
          onClick={() => {
            stalls.current = 0;
            setPhase('paused');
          }}
          className="flex min-h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 hover:border-accent"
        >
          <RotateCcw size={13} aria-hidden="true" /> Start again
        </button>
      </div>
    );
  }
  if (phase === 'paused') {
    return (
      <p className="flex h-full items-center justify-center gap-2 p-3 text-center text-xs text-ink-2" role="status" data-testid="widget-paused">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        A custom widget on this page stopped responding. Its widgets start again in a few seconds.
      </p>
    );
  }
  return (
    <iframe
      key={nonce}
      ref={frame}
      src={`${SANDBOX_PAGE}#n=${nonce}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={`${flag.title || 'Custom widget'}: custom widget`}
      data-testid="widget-frame"
      className="block h-full w-full border-0 bg-transparent"
    />
  );
}

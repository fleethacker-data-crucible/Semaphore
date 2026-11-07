// The Signal Book: a private collection of maritime signal flags, one for each real capability
// Semaphore has, earned by using it for the first time. Before a flag is earned its page says how
// to earn it, with a "Try it" that opens the right panel or adds a flag with a brief to start
// from. It is also where the analyst's watch log lives: one ISO week is one watch.
//
// Private by default: kept in this browser (lib/skills.ts), never in the shared playbook, never
// shown to leadership or colleagues, with no counts to grind and no streaks to lose. A deployment
// can switch it off (settings.json "signalBook": false). These are not qualifications or any kind
// of official training record, and the copy never calls them that.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Anchor, ArrowRight, BookMarked, Check, EyeOff, Lightbulb, X } from 'lucide-react';
import type { Catalog } from '../../../src/core/catalog.ts';
import type { Hoist } from '../../../src/core/hoist.ts';
import { watchStrip, weekStart } from '../../../src/core/impact.ts';
import type { PlaybookState } from '../lib/playbook.ts';
import { type How, readSignalBook, readWatchLog, requestDataTab, scanForSkills, setMirror, setWatchLogHidden, SIGNALS, useSkillsVersion, watchLogHidden } from '../lib/skills.ts';

export { SIGNALS };
import { useModal } from '../lib/modal.ts';

/** What "Try it" does: open a panel (the Data panel on a tab), or add a flag with a starting brief. */
export type TryTarget = { kind: 'panel'; panel: 'data' | 'qlik' | 'kits' | 'lineage' | 'playbook' | 'away' } | { kind: 'brief'; brief: string; title: string };

// The flags' own colours. They are the signal flags' identity (like a logo), so they are fixed and
// the same in both themes; every flag is also told apart by its pattern and its name.
const RED = '#c8102e';
const BLUE = '#0b3d91';
const YEL = '#ffc72c';
const BLK = '#1b1b1b';
const WHT = '#ffffff';

function art(letter: string) {
  const r = (x: number, y: number, w: number, h: number, fill: string, key?: string) => <rect key={key ?? `${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />;
  switch (letter) {
    case 'A':
      return [r(0, 0, 30, 40, WHT), <polygon key="a" points="30,0 60,0 46,20 60,40 30,40" fill={BLUE} />];
    case 'B':
      return [<polygon key="b" points="0,0 60,0 46,20 60,40 0,40" fill={RED} />];
    case 'C':
      return [BLUE, WHT, RED, WHT, BLUE].map((c, i) => r(0, i * 8, 60, 8, c, `c${i}`));
    case 'D':
      return [r(0, 0, 60, 40, YEL), r(0, 10, 60, 20, BLUE)];
    case 'E':
      return [r(0, 0, 60, 20, BLUE), r(0, 20, 60, 20, RED)];
    case 'F':
      return [r(0, 0, 60, 40, WHT), <polygon key="f" points="30,3 57,20 30,37 3,20" fill={RED} />];
    case 'G':
      return [0, 1, 2, 3, 4, 5].map((i) => r(i * 10, 0, 10, 40, i % 2 ? BLUE : YEL, `g${i}`));
    case 'H':
      return [r(0, 0, 30, 40, WHT), r(30, 0, 30, 40, RED)];
    case 'I':
      return [r(0, 0, 60, 40, YEL), <circle key="i" cx={30} cy={20} r={10} fill={BLK} />];
    case 'J':
      return [r(0, 0, 60, 40, BLUE), r(0, 13.33, 60, 13.34, WHT)];
    case 'K':
      return [r(0, 0, 30, 40, YEL), r(30, 0, 30, 40, BLUE)];
    case 'L':
      return [r(0, 0, 60, 40, YEL), r(30, 0, 30, 20, BLK), r(0, 20, 30, 20, BLK)];
    case 'M':
      return [r(0, 0, 60, 40, BLUE), <path key="m" d="M0,0 L60,40 M60,0 L0,40" stroke={WHT} strokeWidth={8} />];
    case 'N':
      return Array.from({ length: 16 }, (_, i) => r((i % 4) * 15, Math.floor(i / 4) * 10, 15, 10, ((i % 4) + Math.floor(i / 4)) % 2 ? WHT : BLUE, `n${i}`));
    case 'O':
      return [r(0, 0, 60, 40, YEL), <polygon key="o" points="0,0 60,0 60,40" fill={RED} />];
    case 'P':
      return [r(0, 0, 60, 40, BLUE), r(20, 13.33, 20, 13.34, WHT)];
    case 'Q':
      return [r(0, 0, 60, 40, YEL)];
    case 'R':
      return [r(0, 0, 60, 40, RED), r(25, 0, 10, 40, YEL), r(0, 15, 60, 10, YEL)];
    case 'S':
      return [r(0, 0, 60, 40, WHT), r(20, 13.33, 20, 13.34, BLUE)];
    case 'T':
      return [r(0, 0, 20, 40, RED), r(20, 0, 20, 40, WHT), r(40, 0, 20, 40, BLUE)];
    default:
      return [];
  }
}

/** One signal flag as line-framed inline SVG. Unearned flags are shown faded, with their pattern intact. */
export function SignalFlag({ letter, earned, size = 60 }: { letter: string; earned: boolean; size?: number }) {
  const swallow = letter === 'A' || letter === 'B';
  const outline = swallow ? 'M0,0 L60,0 L46,20 L60,40 L0,40 Z' : 'M0,0 H60 V40 H0 Z';
  const clip = `clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg width={size} height={(size * 2) / 3} viewBox="-1 -1 62 42" aria-hidden="true" className={`shrink-0 transition-opacity duration-200 ${earned ? '' : 'opacity-30 grayscale'}`}>
      <clipPath id={clip}>
        <path d={outline} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>{art(letter)}</g>
      <path d={outline} fill="none" stroke="var(--ink-3)" strokeWidth={1} strokeLinejoin="round" />
    </svg>
  );
}

export interface SignalBookProps {
  hoist: Hoist;
  catalog: Catalog;
  playbook: PlaybookState;
  user: string;
  onClose: () => void;
  onTry: (t: TryTarget) => void;
}

function dayMonth(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function SignalBook({ hoist, catalog, playbook, user, onClose, onTry }: SignalBookProps) {
  const dialogRef = useRef<HTMLElement>(null);
  useModal(dialogRef, onClose);
  const v = useSkillsVersion();

  // Work done before the book (or before a caller recorded it) still counts, once.
  useEffect(() => {
    scanForSkills(hoist, playbook.entries, catalog, user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const book = useMemo(() => readSignalBook(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const strip = useMemo(() => watchStrip(readWatchLog()), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = useMemo(() => watchLogHidden(), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const earnedCount = SIGNALS.filter((s) => book.earned[s.kind]).length;
  const [selected, setSelected] = useState<string>(() => (SIGNALS.find((s) => !readSignalBook().earned[s.kind]) ?? SIGNALS[0]!).letter);
  const [tip, setTip] = useState<string | null>(null);
  const sig = SIGNALS.find((s) => s.letter === selected)!;
  const earned = book.earned[sig.kind];

  const metric = catalog.metrics[0]?.label ?? 'Labor cost';
  const field = catalog.fields.filter((f) => f.type === 'string').sort((a, b) => (a.cardinality ?? 50) - (b.cardinality ?? 50))[0]?.label ?? 'Region';
  const how = sig.try({ m: metric, f: field });

  const go = (h: How) => {
    setTip(null);
    if (h.kind === 'tip') return setTip(h.text);
    if (h.kind === 'brief') return onTry({ kind: 'brief', brief: h.brief, title: h.brief.split('.')[0]!.slice(0, 60) });
    if (h.tab) requestDataTab(h.tab);
    onTry({ kind: 'panel', panel: h.panel });
  };

  const stood = strip.filter((w) => w.state === 'stood').length;
  const away = strip.filter((w) => w.state === 'away').length;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1} aria-labelledby="signal-book-title" className="flex h-full w-[600px] max-w-full flex-col border-l border-line bg-panel shadow-xl">
        <header className="border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <BookMarked size={16} className="text-brass" />
            <h2 id="signal-book-title" className="flex-1 text-base font-semibold">
              Signal Book
            </h2>
            <span className="text-xs text-ink-3">
              {earnedCount} of {SIGNALS.length} flags
            </span>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-panel-2">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-2">Each flag stands for something Semaphore can do. Use it once and the flag is yours. Only you can see this book: it is kept in this browser and never shared.</p>
        </header>

        <div className="scroll-thin flex-1 space-y-5 overflow-y-auto p-4">
          {!hidden ? (
            <section aria-labelledby="watch-title" className="rounded-[10px] border border-line p-4">
              <div className="flex items-center gap-2">
                <h3 id="watch-title" className="flex-1 text-sm font-semibold">
                  Watch log
                </h3>
                <button type="button" onClick={() => setWatchLogHidden(true)} className="flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-3 hover:bg-panel-2" title="Hide the watch log">
                  <EyeOff size={13} /> Hide
                </button>
              </div>
              <ol className="mt-2 flex gap-1.5" aria-label="The last 12 weeks, oldest first">
                {strip.map((w, i) => {
                  const label = `Week of ${new Date(weekStart(w.week)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: ${w.state === 'stood' ? 'stood' : w.state === 'away' ? 'away, excused' : i === strip.length - 1 ? 'this week' : 'quiet'}`;
                  return (
                    <li key={w.week} title={label} aria-label={label} className={`grid size-8 place-items-center rounded-md border ${w.state === 'stood' ? 'border-accent bg-accent text-panel' : w.state === 'away' ? 'border-line bg-panel-2 text-brass' : 'border-dashed border-line text-transparent'} ${i === strip.length - 1 ? 'ring-2 ring-brass/40 ring-offset-1 ring-offset-panel' : ''}`}>
                      {w.state === 'stood' ? <Check size={14} /> : w.state === 'away' ? <Anchor size={14} /> : null}
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 text-sm text-ink-2">
                {stood > 0 ? (
                  <>
                    <b className="text-ink">
                      {stood} of the last {12 - away} watches stood.
                    </b>{' '}
                    Thanks for keeping the playbook current.
                  </>
                ) : (
                  'A watch is one week. Accept or refresh a flag, answer a question, or mark an answer "Still right", and the week is stood.'
                )}
                {away > 0 && ` ${away} week${away === 1 ? '' : 's'} away, excused automatically.`}
              </p>
              <p className="mt-1 flex flex-wrap gap-3 text-[11px] text-ink-3">
                <span className="flex items-center gap-1"><span className="inline-grid size-3.5 place-items-center rounded-sm bg-accent text-panel"><Check size={9} /></span> Stood</span>
                <span className="flex items-center gap-1"><Anchor size={11} className="text-brass" /> Away</span>
                <span className="flex items-center gap-1"><span className="inline-block size-3.5 rounded-sm border border-dashed border-line" /> Quiet</span>
              </p>
            </section>
          ) : (
            <button type="button" onClick={() => setWatchLogHidden(false)} className="text-xs text-accent underline-offset-2 hover:underline">
              Show the watch log
            </button>
          )}

          <section aria-label="Signal flags">
            <ul className="grid grid-cols-5 gap-2">
              {SIGNALS.map((s) => {
                const got = !!book.earned[s.kind];
                return (
                  <li key={s.letter}>
                    <button
                      type="button"
                      onClick={() => (setSelected(s.letter), setTip(null))}
                      aria-pressed={selected === s.letter}
                      aria-label={`${s.name}: ${s.title}. ${got ? 'Earned' : 'Not yet earned'}`}
                      className={`relative flex w-full flex-col items-center gap-1 rounded-lg border px-1 pb-1.5 pt-2 hover:border-accent ${selected === s.letter ? 'border-accent bg-accent-soft' : got ? 'border-line bg-panel' : 'border-dashed border-line bg-panel'}`}
                    >
                      <SignalFlag letter={s.letter} earned={got} size={54} />
                      <span className={`text-[11px] font-semibold ${got ? 'text-ink' : 'text-ink-3'}`}>
                        {s.letter} · {s.name}
                      </span>
                      {got && (
                        <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-good text-panel" aria-hidden="true">
                          <Check size={10} strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-live="polite" className="flex gap-4 rounded-[10px] border border-line p-4">
            <SignalFlag letter={sig.letter} earned={!!earned} size={84} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-brass">
                {sig.letter} · {sig.name}
              </p>
              <h3 className="font-display text-lg font-semibold leading-tight">{sig.title}</h3>
              {earned ? (
                <>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-good">
                    <Check size={14} /> Earned {dayMonth(earned.at)}
                    {earned.hoistId ? (earned.hoistId === hoist.id ? ', on this page' : ', on another page') : ''}
                  </p>
                  {earned.flagId && earned.hoistId === hoist.id && hoist.flags.some((f) => f.id === earned.flagId) ? (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        window.setTimeout(() => document.querySelector(`[data-flag="${earned.flagId}"]`)?.scrollIntoView({ block: 'center' }), 0);
                      }}
                      className="mt-2 flex min-h-8 items-center gap-1 rounded-md border border-line px-3 text-xs hover:border-accent"
                    >
                      Show the flag <ArrowRight size={12} />
                    </button>
                  ) : how.kind === 'panel' ? (
                    <button type="button" onClick={() => go(how)} className="mt-2 flex min-h-8 items-center gap-1 rounded-md border border-line px-3 text-xs hover:border-accent">
                      Open {how.where} <ArrowRight size={12} />
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="mt-1 text-sm text-ink-2">
                    <span className="font-medium text-ink">How to earn it: </span>
                    {sig.how}
                  </p>
                  {how.kind === 'brief' && <p className="mt-1 text-xs text-ink-3">Try it adds a flag with the brief "{how.brief}" for you to draft and adjust.</p>}
                  <button type="button" onClick={() => go(how)} className="mt-3 flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-semibold text-panel hover:opacity-90">
                    Try it <ArrowRight size={14} />
                  </button>
                  {tip && (
                    <p role="status" className="mt-2 flex items-start gap-1.5 rounded-md bg-brass-soft px-2.5 py-1.5 text-xs text-ink">
                      <Lightbulb size={13} className="mt-0.5 shrink-0 text-brass" /> {tip}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

          <footer className="space-y-2 border-t border-line pt-3 text-[11px] text-ink-3">
            <p>Flags reward a first use, once. There is nothing to repeat and nothing to lose. Practice pages count too.</p>
            {playbook.where === 'shared folder' && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={!!book.mirror} onChange={(e) => setMirror(e.target.checked)} />
                <span>Keep a copy in the Semaphore folder, so the book survives a browser reset. Your copy is one small file of flags and dates; anyone who can open that folder could open it.</span>
              </label>
            )}
          </footer>
        </div>
      </aside>
    </div>
  );
}

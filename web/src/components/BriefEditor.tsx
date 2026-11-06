// A brief box that shows what Semaphore understood while the analyst types: measures, fields,
// time and behaviour are tinted in place (each with its own underline too, so it reads without
// colour), unknown words are underlined, and every unknown word gets a way forward: a one-click
// "did you mean" when it is close to a catalog name, and "teach Semaphore…" always.
// BriefHints offers the next grammar moves ("+ by Region", "+ vs last year") built from the catalog.

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GraduationCap, Plus } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { annotateBrief, appendHint, type Annotation, type Hint, type SpanKind, type Suggestion, suggestNext } from '../../../src/core/intelligence/annotate.ts';
import { noteGrammarUsed, useFadedKinds } from '../lib/onboarding.ts';

export interface BriefEditorProps {
  value: string;
  onChange: (value: string) => void;
  index: CatalogIndex;
  placeholder?: string;
  rows?: number;
  /** Enter (without Shift) runs this instead of adding a line. */
  onSubmit?: () => void;
  /** Ctrl+Enter runs this (a flag's brief: accept the draft). */
  onCtrlEnter?: () => void;
  /** The analyst picked a suggestion or taught a word: it may be learnt. */
  onLearn?: (word: string, s: Suggestion) => void;
  label: string;
  autoFocus?: boolean;
  /** Id for the text box, so hints can return focus to it. */
  id?: string;
}

/** The kind names the legend, the chips and screen readers use. */
export const KIND_NAME: Record<SpanKind, string> = {
  metric: 'measure',
  field: 'field',
  time: 'time',
  range: 'time window',
  compare: 'comparison',
  share: 'share of total',
  rank: 'ranking',
  kind: 'chart kind',
  click: 'click behaviour',
  ignore: 'ignored filter',
  threshold: 'colour rule',
  unknown: 'not understood',
};

const LEGEND: Array<[string, string, string]> = [
  ['hl-metric', 'measure', 'solid underline'],
  ['hl-field', 'field', 'dotted underline'],
  ['hl-time', 'time', 'dashed underline'],
  ['hl-click', 'behaviour', 'double underline'],
  ['hl-unknown', 'not understood', 'wavy underline'],
];

export function BriefEditor({ value, onChange, index, placeholder, rows = 3, onSubmit, onCtrlEnter, onLearn, label, autoFocus, id }: BriefEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const annotation = useMemo(() => annotateBrief(value, index), [value, index]);
  const [teaching, setTeaching] = useState<string | null>(null);

  useLayoutEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.max(t.scrollHeight + 2, rows * 21 + 18)}px`;
  }, [value, rows]);

  const sync = () => {
    if (layer.current && ref.current) layer.current.scrollTop = ref.current.scrollTop;
  };

  const fix = (start: number, end: number, word: string, s: Suggestion) => {
    const replacement = s.label.toLowerCase();
    onChange(value.slice(0, start) + replacement + value.slice(end));
    onLearn?.(word, s);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // One entry per distinct unknown word (the same typo twice needs one answer).
  const unknown = annotation.unknown.filter((u, i, all) => all.findIndex((x) => x.word.toLowerCase() === u.word.toLowerCase()) === i);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="brief-wrap rounded-lg bg-panel">
        <div ref={layer} className="brief-layer" aria-hidden="true">
          {renderLayer(value, annotation)}
        </div>
        <textarea
          ref={ref}
          id={id}
          value={value}
          rows={rows}
          aria-label={label}
          placeholder={placeholder}
          spellCheck={false}
          autoFocus={autoFocus}
          onScroll={sync}
          onChange={(e) => onChange(e.target.value.slice(0, 4000))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              if (onCtrlEnter) {
                e.preventDefault();
                onCtrlEnter();
              }
              return;
            }
            if (onSubmit && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="placeholder:text-ink-3"
        />
      </div>
      {unknown.length > 0 && (
        <div className="flex flex-col gap-1 text-xs" role="group" aria-label="Words Semaphore did not understand">
          {unknown.map((u) => (
            <div key={`${u.start}-${u.word}`} className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-1">
                <span className="text-ink-2">
                  "<span className="text-bad">{u.word}</span>"{u.suggestions.length ? ' — did you mean' : ''}
                </span>
                {u.suggestions.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => fix(u.start, u.end, u.word, s)}
                    className="min-h-6 hit-32 rounded-full border border-line bg-panel px-2 py-0.5 font-medium text-accent hover:bg-accent-soft"
                    title={`Use ${s.label}, and remember "${u.word}" means ${s.label}`}
                  >
                    {s.label}
                  </button>
                ))}
                {onLearn && (
                  <button
                    type="button"
                    aria-expanded={teaching === u.word}
                    onClick={() => setTeaching((t) => (t === u.word ? null : u.word))}
                    className="flex min-h-6 hit-32 items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-ink-2 hover:border-accent hover:text-accent"
                    title={`Tell Semaphore which measure or field "${u.word}" means`}
                  >
                    <GraduationCap size={13} aria-hidden="true" />
                    {u.suggestions.length ? 'something else…' : 'teach Semaphore…'}
                  </button>
                )}
              </span>
              {teaching === u.word && onLearn && (
                <TeachPicker
                  word={u.word}
                  index={index}
                  onPick={(s) => {
                    onLearn(u.word, s);
                    setTeaching(null);
                    requestAnimationFrame(() => ref.current?.focus());
                  }}
                  onClose={() => setTeaching(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A type-to-filter list of the catalog's measures and fields, to say what a word means. */
function TeachPicker({ word, index, onPick, onClose }: { word: string; index: CatalogIndex; onPick: (s: Suggestion) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const options = useMemo(() => {
    const all: Suggestion[] = [
      ...index.catalog.metrics.map((m) => ({ key: m.key, kind: 'metric' as const, label: m.label })),
      ...index.catalog.fields.filter((f) => f.type !== 'number').map((f) => ({ key: f.key, kind: 'field' as const, label: f.label })),
    ];
    const needle = q.trim().toLowerCase();
    return (needle ? all.filter((o) => o.label.toLowerCase().includes(needle)) : all).slice(0, 40);
  }, [index, q]);
  const active = options[Math.min(at, options.length - 1)];
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-2">
      <label className="mb-1 block text-[11px] text-ink-2" htmlFor={`${listId}-q`}>
        What does "<span className="font-semibold text-ink">{word}</span>" mean?
      </label>
      <input
        id={`${listId}-q`}
        autoFocus
        value={q}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={active ? `${listId}-${active.kind}-${active.key}` : undefined}
        placeholder="Type to find a measure or field"
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAt((i) => Math.min(options.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAt((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active) onPick(active);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className="h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs"
      />
      <ul id={listId} role="listbox" aria-label={`Meanings for ${word}`} className="scroll-thin mt-1 max-h-40 overflow-y-auto">
        {options.map((o, i) => (
          <li
            key={`${o.kind}-${o.key}`}
            id={`${listId}-${o.kind}-${o.key}`}
            role="option"
            aria-selected={o === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o)}
            onMouseEnter={() => setAt(i)}
            className={`flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded px-2 text-xs ${o === active ? 'bg-accent-soft text-ink' : 'text-ink'}`}
          >
            <span>{o.label}</span>
            <span className="text-[10px] text-ink-2">{o.kind === 'metric' ? 'measure' : 'field'}</span>
          </li>
        ))}
        {options.length === 0 && <li className="px-2 py-1 text-xs text-ink-2">Nothing in the catalog matches.</li>}
      </ul>
    </div>
  );
}

/**
 * "Add to this brief": up to three grammar moves the brief does not use yet, from the catalog's
 * names. A kind the analyst has used three times is not offered again (the scaffolding fades).
 */
export function BriefHints({ value, index, onChange, briefId }: { value: string; index: CatalogIndex; onChange: (v: string) => void; briefId?: string }) {
  const faded = useFadedKinds();
  const fadedKey = faded.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hints = useMemo(() => suggestNext(annotateBrief(value, index), index, { skip: faded }), [value, index, fadedKey]);
  if (!hints.length) return null;
  const use = (h: Hint) => {
    onChange(appendHint(value, h));
    noteGrammarUsed([h.kind]);
    requestAnimationFrame(() => {
      const t = briefId ? (document.getElementById(briefId) as HTMLTextAreaElement | null) : null;
      if (!t) return;
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    });
  };
  return (
    <div className="hint-row flex flex-wrap items-center gap-1 text-[11px]" role="group" aria-label="Add to this brief">
      {hints.map((h) => (
        <button
          key={h.kind}
          type="button"
          onClick={() => use(h)}
          title={`Add to this brief: "${h.phrase}"`}
          aria-label={`Add to this brief: ${h.phrase}`}
          className="inline-flex min-h-6 hit-32 items-center gap-0.5 rounded-full border border-dashed border-[var(--fl-control-border)] px-2 text-ink-2 hover:border-accent hover:text-accent"
        >
          <Plus size={11} aria-hidden="true" />
          {h.label.replace(/^\+ /, '')}
        </button>
      ))}
    </div>
  );
}

export function BriefLegend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2" aria-label="Highlight key">
      {LEGEND.map(([cls, text, how]) => (
        <li key={cls} className="flex items-center gap-1" title={`${text}: tinted, with a ${how}`}>
          <span className={`hl ${cls} hl-swatch`} aria-hidden="true">
            abc
          </span>
          {text}
        </li>
      ))}
    </ul>
  );
}

function renderLayer(text: string, a: Annotation) {
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const s of a.spans) {
    if (s.start < at) continue;
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <mark key={s.start} className={`hl hl-${s.kind}`} style={{ color: 'transparent' }}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  out.push(text.slice(at));
  // A trailing newline needs a character after it to take up space in the layer.
  out.push('​');
  return out;
}

/** What the brief was understood to mean, as compact chips, each marked like its highlight. */
export function Understood({ value, index }: { value: string; index: CatalogIndex }) {
  const a = useMemo(() => annotateBrief(value, index), [value, index]);
  const chips = a.spans.filter((s) => s.kind !== 'unknown');
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap gap-1 text-[11px]" aria-label="Understood">
      {chips.map((s) => (
        <li key={s.start} className={`hl hl-${s.kind} rounded px-1.5 py-0.5 text-ink`} title={`${KIND_NAME[s.kind]}: ${s.label}`}>
          <span className="sr-only">{KIND_NAME[s.kind]}: </span>
          {s.label}
        </li>
      ))}
    </ul>
  );
}

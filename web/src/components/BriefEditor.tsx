// A brief box that shows what Semaphore understood while the analyst types: measures, fields,
// time and behaviour are tinted in place, unknown words are underlined, and each typo gets a
// one-click "did you mean" that also teaches the catalog the word.

import { useLayoutEffect, useMemo, useRef } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { annotateBrief, type Annotation, type Suggestion } from '../../../src/core/intelligence/annotate.ts';

export interface BriefEditorProps {
  value: string;
  onChange: (value: string) => void;
  index: CatalogIndex;
  placeholder?: string;
  rows?: number;
  /** Enter (without Shift) runs this instead of adding a line. */
  onSubmit?: () => void;
  /** The analyst picked a suggestion: the word was replaced, and it may be learnt. */
  onLearn?: (word: string, s: Suggestion) => void;
  label: string;
  autoFocus?: boolean;
}

const LEGEND: Array<[string, string]> = [
  ['hl-metric', 'measure'],
  ['hl-field', 'field'],
  ['hl-time', 'time'],
  ['hl-click', 'behaviour'],
  ['hl-unknown', 'not understood'],
];

export function BriefEditor({ value, onChange, index, placeholder, rows = 3, onSubmit, onLearn, label, autoFocus }: BriefEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const annotation = useMemo(() => annotateBrief(value, index), [value, index]);

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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="brief-wrap rounded-lg bg-panel">
        <div ref={layer} className="brief-layer" aria-hidden="true">
          {renderLayer(value, annotation)}
        </div>
        <textarea
          ref={ref}
          value={value}
          rows={rows}
          aria-label={label}
          placeholder={placeholder}
          spellCheck={false}
          autoFocus={autoFocus}
          onScroll={sync}
          onChange={(e) => onChange(e.target.value.slice(0, 4000))}
          onKeyDown={(e) => {
            if (onSubmit && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="placeholder:text-ink-3"
        />
      </div>
      {annotation.unknown.some((u) => u.suggestions.length) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Did you mean">
          {annotation.unknown
            .filter((u) => u.suggestions.length)
            .map((u) => (
              <span key={`${u.start}-${u.word}`} className="flex flex-wrap items-center gap-1">
                <span className="text-ink-2">
                  "<span className="text-bad">{u.word}</span>" — did you mean
                </span>
                {u.suggestions.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => fix(u.start, u.end, u.word, s)}
                    className="rounded-full border border-line bg-panel px-2 py-0.5 font-medium text-accent hover:bg-accent-soft"
                    title={`Use ${s.label}, and remember "${u.word}" means ${s.label}`}
                  >
                    {s.label}
                  </button>
                ))}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

export function BriefLegend() {
  return (
    <div className="flex flex-wrap gap-2 text-[11px] text-ink-3">
      {LEGEND.map(([cls, text]) => (
        <span key={cls} className="flex items-center gap-1">
          <span className={`hl ${cls} inline-block h-3 w-3`} />
          {text}
        </span>
      ))}
    </div>
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

/** What the brief was understood to mean, as compact chips. */
export function Understood({ value, index }: { value: string; index: CatalogIndex }) {
  const a = useMemo(() => annotateBrief(value, index), [value, index]);
  const chips = a.spans.filter((s) => s.kind !== 'unknown');
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap gap-1 text-[11px]" aria-label="Understood">
      {chips.map((s) => (
        <li key={s.start} className={`hl hl-${s.kind} rounded px-1.5 py-0.5 text-ink`}>
          {s.label}
        </li>
      ))}
    </ul>
  );
}

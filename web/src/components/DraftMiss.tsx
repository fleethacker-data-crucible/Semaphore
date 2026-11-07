// "Why it didn't draft" (#69): when a draft finds no measure in the brief, this card says what
// Semaphore did understand, which measures it knows, and offers the next move: use a measure, teach
// it a word, or open Data. It stays until the flag's brief changes. The page keeps the miss in its
// state (app.tsx `draftMiss`) and renders this card just above the inspector; the flags agent may
// move it inside the Inspector, passing the same props.

import { useState } from 'react';
import { Database, GraduationCap, Lightbulb, Sparkles, X } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { annotateBrief, type Suggestion } from '../../../src/core/intelligence/annotate.ts';
import { LIMITS } from '../../../src/core/hoist.ts';

export interface DraftMissInfo {
  flagId: string;
  /** The brief the draft read; the card goes once the brief is different. */
  brief: string;
  /** The draft's own last note, e.g. "Nothing in the brief matched a measure." */
  note: string;
}

export interface DraftMissView {
  understood: string[];
  measures: Suggestion[];
  unknown: Array<{ word: string; suggestions: Suggestion[] }>;
}

/** What the card shows, worked out from the brief and the catalog (plain, so it is tested in Node). */
export function explainMiss(brief: string, index: CatalogIndex): DraftMissView {
  const a = annotateBrief(brief, index);
  const understood = [...new Set(a.spans.filter((s) => s.kind !== 'unknown').map((s) => s.label))].slice(0, 6);
  const known = new Set(a.spans.filter((s) => s.kind === 'metric').map((s) => s.key));
  const measures = index.catalog.metrics.filter((m) => !known.has(m.key)).slice(0, 4).map((m) => ({ key: m.key, kind: 'metric' as const, label: m.label }));
  const unknown = a.unknown.slice(0, 3).map((u) => ({ word: u.word, suggestions: u.suggestions }));
  return { understood, measures, unknown };
}

export interface DraftMissProps {
  miss: DraftMissInfo;
  index: CatalogIndex;
  busy: boolean;
  /** Put the measure's name into the flag's brief and draft again. */
  onUseMeasure: (label: string) => void;
  onLearn: (word: string, s: Suggestion) => void;
  onData: () => void;
  onDismiss: () => void;
}

export function DraftMiss({ miss, index, busy, onUseMeasure, onLearn, onData, onDismiss }: DraftMissProps) {
  const view = explainMiss(miss.brief, index);
  const [teaching, setTeaching] = useState(false);
  const [word, setWord] = useState(view.unknown[0]?.word ?? '');
  const choices: Suggestion[] = [
    ...(view.unknown.find((u) => u.word === word)?.suggestions ?? []),
    ...index.catalog.metrics.map((m) => ({ key: m.key, kind: 'metric' as const, label: m.label })),
  ].filter((s, i, all) => all.findIndex((x) => x.key === s.key) === i);
  const [target, setTarget] = useState(choices[0]?.key ?? '');
  const first = view.measures[0];
  return (
    <section aria-labelledby="miss-title" className="border-b border-l border-line bg-warn-soft p-3 text-sm">
      <div className="flex items-start gap-2">
        <Lightbulb size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <h2 id="miss-title" className="font-semibold">
            Semaphore couldn’t find a measure in this brief
          </h2>
          {view.understood.length > 0 ? (
            <p className="mt-1 text-xs text-ink-2">
              It understood: {view.understood.map((u, i) => (
                <span key={u}>
                  {i > 0 && ', '}
                  <em className="not-italic font-medium text-ink">{u}</em>
                </span>
              ))}
              .
            </p>
          ) : (
            <p className="mt-1 text-xs text-ink-2">{miss.note || 'Nothing in the brief matched the catalog yet.'}</p>
          )}
          {view.measures.length > 0 && <p className="mt-1 text-xs text-ink-2">Measures it knows: {view.measures.map((m) => m.label).join(', ')}{index.catalog.metrics.length > view.measures.length ? '…' : '.'}</p>}
        </div>
        <button type="button" onClick={onDismiss} aria-label="Hide this" title="Hide this" className="-m-1 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-panel">
          <X size={14} />
        </button>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5 pl-6">
        {first && (
          <button type="button" disabled={busy} onClick={() => onUseMeasure(first.label)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel hover:opacity-90 disabled:opacity-40">
            <Sparkles size={13} aria-hidden="true" /> Use {first.label}
          </button>
        )}
        {index.catalog.metrics.length > 0 && (
          <button type="button" aria-expanded={teaching} onClick={() => setTeaching((t) => !t)} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-ink-3 bg-panel px-2.5 text-xs hover:bg-panel-2">
            <GraduationCap size={13} aria-hidden="true" /> Teach a word
          </button>
        )}
        <button type="button" onClick={onData} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-ink-3 bg-panel px-2.5 text-xs hover:bg-panel-2">
          <Database size={13} aria-hidden="true" /> Open Data
        </button>
      </div>
      {teaching && (
        <form
          className="mt-2.5 space-y-1.5 pl-6 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const s = choices.find((c) => c.key === target);
            const w = word.trim().toLowerCase();
            if (!s || !w) return;
            onLearn(w, s);
            setTeaching(false);
          }}
        >
          <label className="block">
            <span className="text-ink-2">The word</span>
            <input value={word} maxLength={LIMITS.synonymChars} onChange={(e) => setWord(e.target.value)} list="miss-words" className="mt-0.5 block min-h-8 w-full rounded-md border border-ink-3 bg-panel px-2" />
            <datalist id="miss-words">
              {view.unknown.map((u) => (
                <option key={u.word} value={u.word} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="text-ink-2">means</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="mt-0.5 block min-h-8 w-full rounded-md border border-ink-3 bg-panel px-2">
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!word.trim() || !target} className="min-h-8 rounded-md bg-accent px-2.5 font-semibold text-panel disabled:opacity-40">
            Teach it
          </button>
        </form>
      )}
    </section>
  );
}

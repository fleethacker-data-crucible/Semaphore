// The phrasebook (#68): every construction the brief understands, each with a working example
// written in this catalog's own names and highlighted the way the brief box highlights it. The
// shell shows it as a tab of the ? help dialog; "Try it" puts the example in the selected flag's
// brief (or wherever the caller wants it).

import { useMemo } from 'react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { annotateBrief, phrasebook } from '../../../src/core/intelligence/annotate.ts';
import { BriefLegend, KIND_NAME } from './BriefEditor.tsx';

export function Phrasebook({ index, onTry }: { index: CatalogIndex; onTry?: (brief: string) => void }) {
  const phrases = useMemo(() => phrasebook(index), [index]);
  if (!phrases.length) {
    return <p className="text-sm text-ink-2">Add data first: the phrasebook writes its examples from your catalog's measures and fields.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Briefs are plain English. These are the phrases Semaphore understands, with examples from your own catalog.</p>
      <BriefLegend />
      <dl className="divide-y divide-line">
        {phrases.map((p) => (
          <div key={p.kind} className="grid gap-1 py-2 sm:grid-cols-[9rem_1fr]">
            <dt className="text-sm font-semibold text-ink">{p.name}</dt>
            <dd className="space-y-1">
              <p className="text-xs text-ink-2">{p.what}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Example text={p.example} index={index} />
                {onTry && (
                  <button type="button" onClick={() => onTry(p.example)} className="flex h-8 items-center rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent hover:text-accent">
                    Try it
                  </button>
                )}
              </div>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A brief, marked as the brief box marks it: tint and underline per kind, with the kind for screen readers. */
function Example({ text, index }: { text: string; index: CatalogIndex }) {
  const parts = useMemo(() => {
    const a = annotateBrief(text, index);
    const out: Array<{ text: string; kind?: keyof typeof KIND_NAME }> = [];
    let at = 0;
    for (const s of a.spans) {
      if (s.start < at) continue;
      if (s.start > at) out.push({ text: text.slice(at, s.start) });
      out.push({ text: text.slice(s.start, s.end), kind: s.kind });
      at = s.end;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
  }, [text, index]);
  return (
    <q className="rounded-md bg-panel-2 px-2 py-1 text-[13px] leading-6 text-ink">
      {parts.map((p, i) =>
        p.kind ? (
          <mark key={i} className={`hl hl-${p.kind} text-ink`} title={KIND_NAME[p.kind]}>
            {p.text}
            <span className="sr-only"> ({KIND_NAME[p.kind]})</span>
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </q>
  );
}

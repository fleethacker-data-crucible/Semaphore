// A brief that defines a measure ("cost per hull = labor cost / hulls") offers it here, above the
// inspector, to add or leave (src/core/formula-words.ts proposes it). Loaded when one is offered.

import type { Metric } from '../../../src/core/catalog.ts';

export function MeasureOffer({ metric, sentence, onAdd, onDismiss }: { metric: Metric; sentence: string; onAdd: () => void; onDismiss: () => void }) {
  return (
    <section aria-label="Calculated measure" className="space-y-1.5 border-b border-l border-line bg-accent-soft p-3 text-sm">
      <p className="font-semibold">Add a calculated measure?</p>
      <p data-testid="measure-offer">{sentence}</p>
      <p className="text-xs text-ink-2">Worked out for each row, and for the total, from their own totals; nothing shows where it would divide by zero.</p>
      <div className="flex gap-1.5">
        <button type="button" onClick={onAdd} className="min-h-8 rounded-md bg-accent px-2.5 text-xs font-semibold text-panel">
          Add {metric.label}
        </button>
        <button type="button" onClick={onDismiss} className="min-h-8 rounded-md border border-line bg-panel px-2.5 text-xs">
          Not now
        </button>
      </div>
    </section>
  );
}

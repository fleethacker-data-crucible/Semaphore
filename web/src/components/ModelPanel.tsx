// Inspector > Model: pick a predictive model, set it up, and for Monte Carlo and sensitivity type in
// the uncertain inputs. Loaded only when a model flag is selected, with the model list.

import { Plus, Trash2 } from 'lucide-react';
import type { CatalogIndex } from '../../../src/core/catalog.ts';
import type { Flag } from '../../../src/core/hoist.ts';
import { defaultParams, fitModel, MODEL_GROUPS, MODELS, modelInfo, type ParamDef } from '../../../src/core/predict/models.ts';
import type { ModelInput, ModelSpec, ModelType, ParamValue } from '../../../src/core/predict/types.ts';

export default function ModelPanel({ flag, index, onChange }: { flag: Flag; index: CatalogIndex; onChange: (patch: Partial<Flag>, group?: string) => void }) {
  const spec = flag.model;
  const info = spec ? modelInfo(spec.type) : null;
  const set = (next: ModelSpec, group?: string) => onChange({ model: next }, group);
  const pick = (type: ModelType) => set({ type, params: defaultParams(type), ...(spec?.inputs && modelInfo(type).needs.inputs ? { inputs: spec.inputs } : {}) });
  const fit = spec ? fitModel(spec.type, flag.binding, index, !!spec.inputs?.length) : null;
  const value = (p: ParamDef): ParamValue => spec?.params?.[p.key] ?? p.default;
  const setParam = (key: string, v: ParamValue) => spec && set({ ...spec, params: { ...(spec.params ?? {}), [key]: v } }, `model-${flag.id}-${key}`);
  const inputs = spec?.inputs ?? [];
  const setInputs = (next: ModelInput[]) => {
    if (!spec) return;
    const { inputs: _, ...rest } = spec;
    set(next.length ? { ...rest, inputs: next } : rest, `model-${flag.id}-inputs`);
  };
  const field = 'min-h-8 w-full rounded-md border border-[var(--fl-control-border)] bg-panel px-2 text-xs focus:border-accent focus:outline-none';

  return (
    <section aria-label="Model" className="space-y-2" data-testid="model-panel">
      <h3 className="text-xs font-semibold text-ink-2">Model</h3>
      <select aria-label="Predictive model" value={spec?.type ?? ''} onChange={(e) => pick(e.target.value as ModelType)} className={field}>
        {!spec && <option value="">Choose a model…</option>}
        {MODEL_GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {MODELS.filter((m) => m.group === g).map((m) => (
              <option key={m.type} value={m.type}>
                {m.label}: {m.hint.toLowerCase()}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {info && (
        <>
          <p className="text-[11.5px] leading-5 text-ink-2">
            Needs {info.needs.text}. Set the fields and measures in the brief or the binding above; the model runs on the rows the flag returns, in this browser.
          </p>
          {fit && !fit.ok && (
            <p className="text-[11.5px] leading-5 text-warn" data-testid="model-fit-note">
              {fit.note}
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            {info.params.map((p) => (
              <label key={p.key} className={`flex flex-col gap-0.5 text-[11px] text-ink-2 ${p.kind === 'choice' || p.kind === 'boolean' ? 'col-span-2' : ''}`} title={p.hint}>
                {p.kind === 'boolean' ? (
                  <span className="flex items-center gap-1.5">
                    <input type="checkbox" checked={value(p) === true} onChange={(e) => setParam(p.key, e.target.checked)} />
                    {p.label}
                  </span>
                ) : (
                  <>
                    {p.label}
                    {p.kind === 'choice' ? (
                      <select value={String(value(p))} onChange={(e) => setParam(p.key, e.target.value)} className={field}>
                        {p.choices!.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        value={Number(value(p))}
                        min={p.min}
                        max={p.max}
                        step={p.step ?? 'any'}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (e.target.value !== '' && Number.isFinite(n)) setParam(p.key, n);
                        }}
                        className={field}
                      />
                    )}
                  </>
                )}
              </label>
            ))}
          </div>
          {info.needs.inputs && (
            <div className="space-y-1.5" data-testid="model-inputs">
              <h4 className="text-[11px] font-semibold text-ink-2">Inputs</h4>
              <p className="text-[11px] leading-5 text-ink-2">{inputs.length ? 'Each input is drawn between its low and high, most often near its likely value.' : 'With no inputs typed here, each row of the flag becomes an input, spread by the low and high percentages above.'}</p>
              {inputs.length > 0 && (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-ink-3">
                      <th scope="col" className="font-medium">Name</th>
                      <th scope="col" className="font-medium">Low</th>
                      <th scope="col" className="font-medium">Likely</th>
                      <th scope="col" className="font-medium">High</th>
                      <th scope="col" className="sr-only">Remove</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inputs.map((r, i) => {
                      const edit = (patch: Partial<ModelInput>) => setInputs(inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                      const num = (key: 'low' | 'likely' | 'high') => (
                        <input
                          type="number"
                          aria-label={`${r.name || `Input ${i + 1}`} ${key}`}
                          value={r[key]}
                          step="any"
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (e.target.value !== '' && Number.isFinite(n)) edit({ [key]: n });
                          }}
                          className={`${field} px-1`}
                        />
                      );
                      return (
                        <tr key={i}>
                          <td className="pr-1">
                            <input aria-label={`Input ${i + 1} name`} value={r.name} onChange={(e) => edit({ name: e.target.value.slice(0, 80) })} className={`${field} px-1`} />
                          </td>
                          <td className="pr-1">{num('low')}</td>
                          <td className="pr-1">{num('likely')}</td>
                          <td className="pr-1">{num('high')}</td>
                          <td>
                            <button type="button" aria-label={`Remove ${r.name || `input ${i + 1}`}`} onClick={() => setInputs(inputs.filter((_, j) => j !== i))} className="flex h-8 w-7 items-center justify-center rounded-md text-ink-3 hover:text-bad">
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <button type="button" onClick={() => setInputs([...inputs, { name: `Input ${inputs.length + 1}`, low: 80, likely: 100, high: 130 }])} className="flex min-h-8 items-center gap-1 rounded-md border border-[var(--fl-control-border)] px-2 text-xs hover:border-accent">
                <Plus size={13} /> Add an input
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

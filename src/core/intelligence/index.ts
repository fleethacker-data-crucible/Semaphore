// The one entry point the UI uses to ask for drafts. Whatever provider is selected, output is
// validated against the catalog, and a failing remote provider falls back to local rules with
// the reason shown to the analyst. Drafts are suggestions: applying one to a flag leaves it
// "drafted" until the analyst accepts it.

import type { CatalogIndex } from '../catalog.ts';
import { effectiveBrief, emptyBehavior, type Flag, type Hoist, LIMITS } from '../hoist.ts';
import { DEFAULT_SIZE, findSlot } from '../layout.ts';
import {
  type FlagDraft,
  type HoistDraft,
  type IntelligenceProvider,
  summarizeCatalog,
  validateFlagDraft,
  validateHoistDraft,
} from './contract.ts';
import { LocalRulesProvider } from './local-rules.ts';

export * from './contract.ts';
export { LocalRulesProvider } from './local-rules.ts';
export { ContractProvider, OpenAICompatibleProvider } from './remote.ts';

export interface DraftOutcome<T> {
  draft: T;
  /** Which provider produced the draft that is returned. */
  providerId: string;
  /** Set when the selected provider failed and local rules answered instead. */
  fallbackReason?: string;
}

export async function draftFlag(
  provider: IntelligenceProvider,
  hoist: Hoist,
  flag: Flag,
  index: CatalogIndex,
  options: { auto?: boolean } = {},
): Promise<DraftOutcome<FlagDraft>> {
  const brief = effectiveBrief(hoist, flag);
  if (options.auto) brief.auto = true;
  const request = { task: 'draft-flag' as const, brief, catalog: summarizeCatalog(index.catalog) };
  try {
    return { draft: validateFlagDraft(await provider.draftFlag(request), index, flag.kind), providerId: provider.id };
  } catch (e) {
    if (provider.local) throw e;
    const local = new LocalRulesProvider(index);
    return { draft: validateFlagDraft(await local.draftFlag(request), index, flag.kind), providerId: local.id, fallbackReason: (e as Error).message };
  }
}

export async function draftHoist(provider: IntelligenceProvider, brief: string, index: CatalogIndex): Promise<DraftOutcome<HoistDraft>> {
  const request = { task: 'draft-hoist' as const, brief: brief.slice(0, LIMITS.briefChars), catalog: summarizeCatalog(index.catalog) };
  try {
    return { draft: validateHoistDraft(await provider.draftHoist(request), index), providerId: provider.id };
  } catch (e) {
    if (provider.local) throw e;
    const local = new LocalRulesProvider(index);
    return { draft: validateHoistDraft(await local.draftHoist(request), index), providerId: local.id, fallbackReason: (e as Error).message };
  }
}

/** Apply a flag draft. The brief and layout stay the analyst's; status becomes "drafted". */
export function applyFlagDraft(flag: Flag, draft: FlagDraft): Flag {
  return {
    ...flag,
    kind: draft.kind,
    title: flag.title || draft.title,
    binding: draft.binding,
    behavior: draft.behavior,
    status: draft.binding ? 'drafted' : 'empty',
    confidence: draft.confidence,
    notes: draft.notes,
  };
}

/** Add a hoist draft's flags below what is already on the hoist, each in the first free slot. */
export function applyHoistDraft(hoist: Hoist, draft: HoistDraft, newId: () => string): Hoist {
  const flags = [...hoist.flags];
  for (const d of draft.flags) {
    const size = DEFAULT_SIZE[d.kind];
    const layout = findSlot(flags, size.w, size.h, hoist.grid.cols);
    flags.push({
      id: newId(),
      kind: d.kind,
      title: d.title,
      brief: d.brief,
      layout,
      binding: d.binding,
      behavior: d.binding ? d.behavior : emptyBehavior(),
      status: d.binding ? 'drafted' : 'empty',
      confidence: d.confidence,
      notes: d.notes,
    });
  }
  const filters = [...hoist.filters];
  for (const f of draft.filters) if (!filters.some((x) => JSON.stringify(x) === JSON.stringify(f))) filters.push(f);
  return { ...hoist, title: hoist.title === 'Untitled hoist' && draft.title ? draft.title : hoist.title, filters, flags, updated: new Date().toISOString() };
}

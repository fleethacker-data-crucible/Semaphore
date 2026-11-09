// Changes the assistant proposes (lib/assistant.ts): the model writes them as fenced ```semaphore-action
// blocks of JSON, the page checks each one strictly here, and shows it as a card with Accept and Dismiss
// (components/AssistantRoot.tsx). Nothing is applied without Accept, and Accept checks again against the
// page as it is then, so a flag deleted or changed in the meantime is refused, not guessed at. A proposal
// is applied through the same editing paths as the inspector, so Undo takes it back.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { filterText } from '../../../src/core/describe.ts';
import { FILTER_OPS, type Filter, type FilterOp, type Flag, FLAG_KINDS, type FlagKind, LIMITS, TIME_GRAINS, type TimeGrain } from '../../../src/core/hoist.ts';
import { flagLive } from './flag-live.ts';

export type ProposalAction = 'set-title' | 'set-brief' | 'set-kind' | 'set-filter' | 'remove-filter' | 'redraft' | 'delete' | 'add' | 'ask';
export const BUILDER_ACTIONS: readonly ProposalAction[] = ['set-title', 'set-brief', 'set-kind', 'set-filter', 'remove-filter', 'redraft', 'delete', 'add', 'ask'];
export const LEADERSHIP_ACTIONS: readonly ProposalAction[] = ['ask'];
/** Kinds the assistant may set or add: not custom (code) or model (a model spec), which need the analyst. */
export const ASSISTANT_KINDS: readonly FlagKind[] = FLAG_KINDS.filter((k) => k !== 'custom' && k !== 'model');
export const MAX_PROPOSALS = 6;

export type Proposal =
  | { action: 'set-title'; flag: string; title: string; reason?: string }
  | { action: 'set-brief'; flag: string; brief: string; reason?: string }
  | { action: 'set-kind'; flag: string; kind: FlagKind; reason?: string }
  | { action: 'set-filter'; flag: string; filter: Filter; reason?: string }
  | { action: 'remove-filter'; flag: string; field: string; reason?: string }
  | { action: 'redraft'; flag: string; brief?: string; reason?: string }
  | { action: 'delete'; flag: string; reason?: string }
  | { action: 'add'; kind: FlagKind; title: string; brief: string; reason?: string }
  | { action: 'ask'; question: string; reason?: string };

export interface ProposalContext {
  mode: 'builder' | 'leadership';
  flags: readonly Flag[];
  index: CatalogIndex | null;
}

export type Checked = { ok: true; proposal: Proposal } | { ok: false; refusal: string };

const BLOCK = /```semaphore-action[ \t]*\r?\n([\s\S]*?)```/g;

/** Words only: control characters out, spaces squeezed, at most `max` characters. */
function words(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : null;
}

const flagName = (f: Flag) => (f.title ? `"${f.title}"` : `the untitled ${f.kind} flag`);

/** True when a flag shows nothing: never drafted, failed, or its query returned no rows. */
export function showsNothing(f: Flag): boolean {
  if (f.kind === 'text') return !(f.text ?? '').trim();
  if (!f.binding || f.status === 'empty' || f.status === 'error') return true;
  const live = flagLive(f.id);
  if (live?.error) return true;
  return !!live?.result && live.result.display.rows.length === 0;
}

function checkFilter(raw: unknown, flag: Flag, index: CatalogIndex): Filter | string {
  if (!raw || typeof raw !== 'object') return 'the filter must be { field, op, values }.';
  const o = raw as Record<string, unknown>;
  const field = typeof o.field === 'string' ? index.field(o.field) : undefined;
  if (!field) return `no field "${String(o.field ?? '')}" in the catalog.`;
  const metric = flag.binding?.metrics[0] ? index.metric(flag.binding.metrics[0]) : undefined;
  if (metric && metric.source !== field.source) return `${field.label} is in another source than this flag's measures.`;
  const op = o.op as FilterOp;
  if (!FILTER_OPS.includes(op)) return `unknown filter operator "${String(o.op ?? '')}" (use ${FILTER_OPS.join(', ')}).`;
  const values = Array.isArray(o.values) ? o.values : [];
  if (!values.length || values.length > 50 || !values.every((v) => (typeof v === 'string' && v.length <= 200) || (typeof v === 'number' && Number.isFinite(v)))) return 'the filter needs 1 to 50 values, each a number or a short text.';
  const out: Filter = { field: field.key, op, values: values as Array<string | number> };
  if (op === 'last') {
    const n = values[0];
    if (field.type !== 'date') return `"last" needs a date field; ${field.label} is not one.`;
    if (values.length !== 1 || typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) return '"last" needs one whole number of periods (1 to 1000).';
    if (!TIME_GRAINS.includes(o.unit as TimeGrain)) return `"last" needs a unit: ${TIME_GRAINS.join(', ')}.`;
    out.unit = o.unit as TimeGrain;
  } else if (op === 'between' && values.length !== 2) return '"between" needs two values.';
  else if ((op === 'eq' || op === 'gte' || op === 'lte') && values.length !== 1) return `"${op}" needs one value.`;
  return out;
}

/** Checks one proposal against the page as it is now. Refusals are one plain sentence. */
export function checkProposal(raw: unknown, ctx: ProposalContext): Checked {
  const no = (why: string): Checked => ({ ok: false, refusal: why });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no('A proposal was not a JSON object, so it was left out.');
  const o = raw as Record<string, unknown>;
  const action = o.action as ProposalAction;
  const allowed = ctx.mode === 'leadership' ? LEADERSHIP_ACTIONS : BUILDER_ACTIONS;
  if (!allowed.includes(action)) return no(`The assistant proposed "${String(o.action ?? '')}", which it cannot do ${ctx.mode === 'leadership' ? 'in the Leadership view' : 'here'}.`);
  const reason = words(o.reason, 300) ?? undefined;
  const r = reason ? { reason } : {};
  if (action === 'ask') {
    const question = words(o.question, LIMITS.questionChars);
    if (!question || question.length < 3) return no('A suggested question was empty or too long.');
    return { ok: true, proposal: { action, question, ...r } };
  }
  const index = ctx.index;
  if (!index) return no('The catalog is not loaded, so the proposal could not be checked.');
  if (action === 'add') {
    const kind = o.kind as FlagKind;
    if (!ASSISTANT_KINDS.includes(kind)) return no(`The assistant proposed a flag of kind "${String(o.kind ?? '')}", which it cannot add.`);
    const title = words(o.title, LIMITS.titleChars);
    const brief = words(o.brief, LIMITS.briefChars);
    if (!title || !brief) return no('A proposed new flag needs a title and a brief.');
    return { ok: true, proposal: { action, kind, title, brief, ...r } };
  }
  const id = typeof o.flag === 'string' ? o.flag : '';
  const flag = ctx.flags.find((f) => f.id === id);
  if (!flag) return no(`The assistant named a flag that is not on this page${id ? ` (${id.slice(0, 40)})` : ''}, so that proposal was left out.`);
  switch (action) {
    case 'set-title': {
      const title = words(o.title, LIMITS.titleChars);
      if (!title) return no(`The new title for ${flagName(flag)} was empty or longer than ${LIMITS.titleChars} characters.`);
      if (title === flag.title) return no(`${flagName(flag)} already has that title.`);
      return { ok: true, proposal: { action, flag: id, title, ...r } };
    }
    case 'set-brief': {
      const brief = words(o.brief, LIMITS.briefChars);
      if (!brief) return no(`The new brief for ${flagName(flag)} was empty or too long.`);
      if (brief === flag.brief) return no(`${flagName(flag)} already has that brief.`);
      return { ok: true, proposal: { action, flag: id, brief, ...r } };
    }
    case 'set-kind': {
      const kind = o.kind as FlagKind;
      if (!ASSISTANT_KINDS.includes(kind)) return no(`"${String(o.kind ?? '')}" is not a kind the assistant can set.`);
      if (flag.kind === 'text' || flag.kind === 'custom' || flag.kind === 'model') return no(`${flagName(flag)} is a ${flag.kind} flag; change its kind yourself in the inspector.`);
      if (kind === 'text') return no('The assistant cannot turn a data flag into a text note.');
      if (kind === flag.kind) return no(`${flagName(flag)} is already a ${kind}.`);
      return { ok: true, proposal: { action, flag: id, kind, ...r } };
    }
    case 'set-filter': {
      if (!flag.binding) return no(`${flagName(flag)} is not drafted yet, so it has no filters to change. Draft it first.`);
      const filter = checkFilter(o.filter, flag, index);
      if (typeof filter === 'string') return no(`The filter for ${flagName(flag)} was refused: ${filter}`);
      return { ok: true, proposal: { action, flag: id, filter, ...r } };
    }
    case 'remove-filter': {
      const field = typeof o.field === 'string' ? o.field : '';
      if (!flag.binding?.filters.some((f) => f.field === field)) return no(`${flagName(flag)} has no filter on "${field.slice(0, 60)}".`);
      return { ok: true, proposal: { action, flag: id, field, ...r } };
    }
    case 'redraft': {
      if (flag.kind === 'text' || flag.kind === 'custom') return no(`${flagName(flag)} is a ${flag.kind} flag, which is not drafted.`);
      const brief = o.brief === undefined ? undefined : words(o.brief, LIMITS.briefChars);
      if (brief === null) return no(`The new brief for ${flagName(flag)} was empty or too long.`);
      if (!brief && !flag.brief.trim()) return no(`${flagName(flag)} has no brief to draft from.`);
      return { ok: true, proposal: { action, flag: id, ...(brief ? { brief } : {}), ...r } };
    }
    case 'delete': {
      if (!showsNothing(flag)) return no(`The assistant only deletes flags that show nothing; ${flagName(flag)} shows data, so delete it yourself if you mean to.`);
      return { ok: true, proposal: { action, flag: id, ...r } };
    }
  }
  return no('That proposal could not be checked.');
}

/** The answer text without its action blocks, and every block's proposals checked (at most MAX_PROPOSALS). */
export function readProposals(text: string, ctx: ProposalContext): { text: string; proposals: Proposal[]; refusals: string[] } {
  const proposals: Proposal[] = [];
  const refusals: string[] = [];
  let found = 0;
  const clean = text.replace(BLOCK, (_all, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      refusals.push('One proposal was not valid JSON, so it was left out.');
      return '';
    }
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
      if (++found > MAX_PROPOSALS) {
        if (found === MAX_PROPOSALS + 1) refusals.push(`Only the first ${MAX_PROPOSALS} proposals are shown.`);
        continue;
      }
      const c = checkProposal(raw, ctx);
      if (c.ok) proposals.push(c.proposal);
      else refusals.push(c.refusal);
    }
    return '';
  });
  return { text: clean.replace(/\n{3,}/g, '\n\n').trim(), proposals, refusals };
}

/** What a proposal would change, as a heading and before/after lines, for its card. */
export function describeProposal(p: Proposal, flags: readonly Flag[], index: CatalogIndex | null): { heading: string; before?: string; after?: string } {
  const flag = 'flag' in p ? flags.find((f) => f.id === p.flag) : undefined;
  const name = flag ? flagName(flag) : 'a flag';
  switch (p.action) {
    case 'set-title':
      return { heading: `Rename ${name}`, before: flag?.title || '(untitled)', after: p.title };
    case 'set-brief':
      return { heading: `Change the brief of ${name}`, before: flag?.brief || '(no brief)', after: p.brief };
    case 'set-kind':
      return { heading: `Show ${name} as a ${p.kind}`, before: flag?.kind ?? '', after: p.kind };
    case 'set-filter': {
      const old = flag?.binding?.filters.find((f) => f.field === p.filter.field);
      return { heading: `${old ? 'Change' : 'Add'} a filter on ${name}`, ...(old && index ? { before: filterText(old, index) } : {}), after: index ? filterText(p.filter, index) : p.filter.field };
    }
    case 'remove-filter': {
      const old = flag?.binding?.filters.find((f) => f.field === p.field);
      return { heading: `Remove a filter from ${name}`, ...(old && index ? { before: filterText(old, index) } : {}), after: '(no filter)' };
    }
    case 'redraft':
      return { heading: `Draft ${name} again`, ...(p.brief ? { before: flag?.brief || '(no brief)', after: p.brief } : {}) };
    case 'delete':
      return { heading: `Delete ${name}`, before: 'It shows nothing.', after: '(deleted; Undo brings it back)' };
    case 'add':
      return { heading: `Add a ${p.kind} flag: "${p.title}"`, after: p.brief };
    case 'ask':
      return { heading: 'Ask this', after: p.question };
  }
}

/** The page's editing paths (app.tsx), so an accepted proposal goes through undo like any edit. */
export interface AssistantEditor {
  flags: () => readonly Flag[];
  index: () => CatalogIndex | null;
  update: (id: string, patch: Partial<Flag>) => void;
  remove: (id: string) => void;
  add: (kind: FlagKind, title: string, brief: string) => void;
  redraft: (id: string, brief?: string) => void;
  ask: (question: string) => void;
}

/** Applies an accepted proposal after checking it again; returns null when done, else why not. */
export function applyProposal(p: Proposal, mode: 'builder' | 'leadership', ed: AssistantEditor): string | null {
  const again = checkProposal(p, { mode, flags: ed.flags(), index: ed.index() });
  if (!again.ok) return again.refusal;
  const q = again.proposal;
  switch (q.action) {
    case 'ask':
      ed.ask(q.question);
      return null;
    case 'add':
      ed.add(q.kind, q.title, q.brief);
      return null;
    case 'delete':
      ed.remove(q.flag);
      return null;
    case 'redraft':
      ed.redraft(q.flag, q.brief);
      return null;
    case 'set-title':
      ed.update(q.flag, { title: q.title });
      return null;
    case 'set-brief':
      ed.update(q.flag, { brief: q.brief });
      return null;
    case 'set-kind':
      ed.update(q.flag, { kind: q.kind });
      return null;
    case 'set-filter':
    case 'remove-filter': {
      const flag = ed.flags().find((f) => f.id === q.flag);
      if (!flag?.binding) return 'That flag has no binding any more.';
      const field = q.action === 'set-filter' ? q.filter.field : q.field;
      const rest = flag.binding.filters.filter((f) => f.field !== field);
      ed.update(q.flag, { binding: { ...flag.binding, filters: q.action === 'set-filter' ? [...rest, q.filter] : rest } });
      return null;
    }
  }
}

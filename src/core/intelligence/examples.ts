// Reviewed examples for a model: the playbook's accepted flags most like the brief at hand, cut down
// to what a provider may see and sent as worked examples with a draft request (docs/PLAYBOOK.md,
// docs/INTELLIGENCE_PROVIDERS.md). A model that sees how this team answered a similar question
// phrases its draft the way the team would.
//
// Rules, all enforced here and tested in tests/ai-examples.test.ts:
//   - Only entries an analyst accepted and nobody has retired or flagged for review (status "active").
//     The playbook never holds drafts or "do not learn" flags; a stray `learn: false` is skipped too.
//   - Selection is deterministic: word overlap with the brief, ties broken by use, then recency, then id.
//   - Each example is built field by field from an allow-list: the brief, the kind, and catalog keys
//     and labels. It cannot carry rows, snapshots, results, filter values, table or source names, or
//     who built or accepted the entry, whatever else an entry holds.
//   - People's names (those on the entries, and any the caller adds) are taken out of the brief text.
//   - A count cap, a per-brief cap and a total size cap.
//
// This module only builds examples. Whether they are sent is the analyst's switch, and where they go
// is the provider's business: the browser's provider is the server-side relay, which keeps Fairlead's
// privacy rule (docs/INTELLIGENCE_PROVIDERS.md). Local rules never see them.

import type { CatalogIndex } from '../catalog.ts';
import { type Filter, parseBinding, type Threshold } from '../hoist.ts';
import { isEntry, normalizeQuestion, type PlaybookEntry } from '../playbook.ts';
import type { WorkedExample } from './contract.ts';

export const EXAMPLE_LIMITS = {
  /** Examples sent by default. */
  count: 3,
  /** The most a caller may ask for. */
  maxCount: 5,
  /** Characters of one example's brief. */
  briefChars: 240,
  /** Characters of all examples together, as JSON. */
  totalChars: 3000,
  /** Word-overlap score below which an entry is not similar enough to show. */
  minScore: 0.2,
} as const;

export interface ExampleOptions {
  /** More names to take out of the briefs (for example the signed-in user). */
  names?: readonly string[];
  /** At most this many (default EXAMPLE_LIMITS.count, never more than maxCount). */
  max?: number;
  /** At most this many JSON characters in all (default EXAMPLE_LIMITS.totalChars). */
  maxChars?: number;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'by', 'for', 'to', 'in', 'on', 'and', 'or', 'with', 'is', 'are', 'was', 'were', 'be', 'at', 'as', 'per', 'show', 'me', 'my', 'our', 'what', 'how', 'many', 'much', 'all', 'this', 'that', 'it', 'its', 'from', 'than']);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeQuestion(text).split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

/** Cosine overlap of two word sets: 0 (nothing shared) to 1 (the same words). */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

/** An entry a provider may learn from: accepted, still live, and whose binding the catalog still understands. */
function usable(e: PlaybookEntry, index: CatalogIndex): boolean {
  if (!isEntry(e) || e.status !== 'active' || e.retired) return false;
  if ((e as { learn?: unknown }).learn === false) return false;
  if (!e.binding.metrics?.length || typeof e.question !== 'string' || !e.question.trim()) return false;
  const problems: string[] = [];
  const binding = parseBinding(e.binding, index, problems, 'Example');
  return !!binding && problems.length === 0;
}

function scoreOf(query: ReadonlySet<string>, e: PlaybookEntry, index: CatalogIndex): number {
  // A brief is often a short ask followed by instructions: the first sentence counts on its own too.
  const wordings = [e.question, e.question.split(/(?<=[.!?])\s+/)[0] ?? '', ...(Array.isArray(e.phrasings) ? e.phrasings : [])].filter((w): w is string => typeof w === 'string');
  let best = 0;
  for (const w of wordings) best = Math.max(best, overlap(query, words(w)));
  // A brief that names the entry's measure is a little closer than one that only shares filler.
  const named = e.binding.metrics.filter((k) => {
    const label = index.metric(k)?.label;
    if (!label) return false;
    const lw = words(label);
    return lw.size > 0 && [...lw].every((w) => query.has(w));
  }).length;
  return best + (named > 0 ? 0.05 : 0);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Take people's names out of free text. Short names (under 3 characters) are left: they would clip ordinary words. */
function scrubNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const n of names) {
    const name = n.trim();
    if (name.length < 3) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  }
  return out;
}

type ExampleThreshold = NonNullable<WorkedExample['thresholds']>[number];

function thresholdOf(t: Threshold, index: CatalogIndex): ExampleThreshold | null {
  if (!index.metric(t.metric) || typeof t.value !== 'number' || !Number.isFinite(t.value)) return null;
  return { metric: t.metric, op: t.op, value: t.value, tone: t.tone };
}

function windowOf(filters: readonly Filter[], index: CatalogIndex): WorkedExample['window'] | undefined {
  const w = filters.find((f) => f.op === 'last' && index.field(f.field) && typeof f.values[0] === 'number' && !!f.unit);
  return w ? { field: w.field, label: index.field(w.field)!.label, count: w.values[0] as number, unit: w.unit! } : undefined;
}

/** One example, built only from the allow-list. */
function exampleOf(e: PlaybookEntry, index: CatalogIndex, names: readonly string[]): WorkedExample {
  const b = e.binding;
  const filters: WorkedExample['filters'] = [];
  for (const f of b.filters) {
    const field = index.field(f.field);
    if (!field) continue;
    const count = typeof f.values[0] === 'number' ? f.values[0] : undefined;
    filters.push({ field: f.field, label: field.label, op: f.op, ...(f.op === 'last' && count !== undefined && f.unit ? { last: { count, unit: f.unit } } : {}) });
  }
  const thresholds = e.thresholds.map((t) => thresholdOf(t, index)).filter((t): t is NonNullable<typeof t> => !!t).slice(0, 5);
  const window = windowOf(e.pageFilters, index);
  return {
    brief: scrubNames(e.question.trim().replace(/\s+/g, ' '), names).slice(0, EXAMPLE_LIMITS.briefChars),
    kind: e.kind,
    metrics: b.metrics.map((key) => ({ key, label: index.metric(key)!.label })),
    dimensions: b.dimensions.map((d) => ({ key: d.field, label: index.field(d.field)!.label, ...(d.grain ? { grain: d.grain } : {}) })),
    filters: filters.slice(0, 10),
    ...(window ? { window } : {}),
    ...(b.sort ? { sort: { by: b.sort.by, dir: b.sort.dir } } : {}),
    ...(typeof b.limit === 'number' ? { limit: b.limit } : {}),
    ...(b.compare ? { compare: b.compare } : {}),
    ...(b.share ? { share: true } : {}),
    ...(thresholds.length ? { thresholds } : {}),
  };
}

/**
 * The reviewed examples most like `query` (a flag's brief, or a whole page's), best first, cut
 * down for a provider. Empty when nothing is similar enough. Deterministic for the same inputs.
 */
export function selectExamples(query: string, entries: readonly PlaybookEntry[], index: CatalogIndex, options: ExampleOptions = {}): WorkedExample[] {
  const q = words(query);
  if (q.size === 0) return [];
  const max = Math.max(0, Math.min(options.max ?? EXAMPLE_LIMITS.count, EXAMPLE_LIMITS.maxCount));
  const budget = options.maxChars ?? EXAMPLE_LIMITS.totalChars;
  const names = [
    ...new Set(
      [...(options.names ?? []), ...entries.flatMap((e) => [e?.acceptedBy, e?.retired?.by])]
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.trim())
        .filter((n) => n.length >= 3),
    ),
  ].sort((a, b) => b.length - a.length);

  const ranked = entries
    .filter((e) => usable(e, index))
    .map((e) => ({ e, score: scoreOf(q, e, index) }))
    .filter((x) => x.score >= EXAMPLE_LIMITS.minScore)
    .sort((a, b) => b.score - a.score || b.e.uses - a.e.uses || b.e.acceptedAt.localeCompare(a.e.acceptedAt) || a.e.id.localeCompare(b.e.id));

  const out: WorkedExample[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const { e } of ranked) {
    if (out.length >= max) break;
    const ex = exampleOf(e, index, names);
    const key = normalizeQuestion(ex.brief) + JSON.stringify([ex.metrics, ex.dimensions]);
    if (seen.has(key)) continue;
    const size = JSON.stringify(ex).length;
    if (used + size > budget) continue;
    seen.add(key);
    used += size;
    out.push(ex);
  }
  return out;
}

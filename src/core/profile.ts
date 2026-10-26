// Builds a catalog from a profiled source, so the analyst confirms a semantic layer instead of
// typing one. Labels and synonyms come from column names ("qty_on_hand" reads as "Quantity on
// hand" and still answers to "qty"); measures are proposed from column types and names: a row
// count per table, totals of amounts, averages of durations and rates, and distinct counts of
// identifiers. Everything proposed can be renamed or removed before it is used.

import { type Catalog, type Field, type FieldType, isIdentifier, type Metric, type Source } from './catalog.ts';

export interface ColumnProfile {
  name: string;
  type: FieldType;
  /** Distinct values, when profiling counted them. */
  distinct?: number | null;
  samples?: string[];
}

export interface TableProfile {
  name: string;
  rows?: number | null;
  columns: ColumnProfile[];
}

export interface SourceProfile {
  source: Source;
  tables: TableProfile[];
}

export interface CatalogProposal {
  catalog: Catalog;
  /** What was decided and why, for the analyst to review. */
  notes: string[];
}

/** Abbreviations seen in column names, and the word they stand for. */
const ABBREVIATIONS: Record<string, string> = {
  qty: 'quantity', amt: 'amount', num: 'number', no: 'number', nbr: 'number', cnt: 'count', dt: 'date', dte: 'date', yr: 'year', mo: 'month',
  desc: 'description', cust: 'customer', acct: 'account', dept: 'department', emp: 'employee', mgr: 'manager', org: 'organization', loc: 'location',
  addr: 'address', cat: 'category', cls: 'class', pct: 'percent', perc: 'percent', avg: 'average', tot: 'total', hrs: 'hours', hr: 'hours',
  min: 'minutes', mins: 'minutes', sec: 'seconds', wo: 'work order', po: 'purchase order', inv: 'invoice', prod: 'product', svc: 'service',
  maint: 'maintenance', reg: 'region', stat: 'status', sts: 'status', ref: 'reference', id: 'id', fy: 'fiscal year', ytd: 'year to date',
};

const MONEY = /\b(cost|costs|amount|price|spend|spent|revenue|sales|value|budget|fee|fees|charge|charges|payment|paid|salary|wage|wages|expense|expenses|invoice|total)\b/;
const AVERAGED = /\b(days?|hours?|minutes?|seconds?|age|duration|rate|ratio|percent|score|rating|temperature|temp|speed|price|unit|latitude|longitude|lat|lon|lng|average|mean)\b/;
const IDENTIFIER = /(^|\s)(id|key|number|code|guid|uuid|serial|reference|zip|postcode|phone)$/;
const YEARISH = /\b(year|fiscal year|month|quarter|week|period)\b/;

export function proposeCatalog(profile: SourceProfile, existing?: Catalog): CatalogProposal {
  const notes: string[] = [];
  const fields: Field[] = [];
  const metrics: Metric[] = [];
  const taken = new Set<string>([...(existing?.fields.map((f) => f.key) ?? []), ...(existing?.metrics.map((m) => m.key) ?? [])]);
  const uniqueKey = (base: string) => {
    let k = base;
    for (let i = 2; taken.has(k); i++) k = `${base}_${i}`;
    taken.add(k);
    return k;
  };
  const sid = profile.source.id;

  for (const t of profile.tables) {
    if (!isIdentifier(t.name)) {
      notes.push(`Table "${t.name}" was skipped: its name cannot be quoted safely.`);
      continue;
    }
    const tableWords = humanize(t.name.split('.').at(-1)!);
    const alias = slug(t.name.split('.').at(-1)!);
    const rows = t.rows ?? null;
    const countLabel = cap(plural(singular(tableWords)));
    metrics.push({
      key: uniqueKey(`${alias}_count`),
      label: countLabel,
      agg: 'count',
      table: t.name,
      source: sid,
      synonyms: unique([tableWords, `${singular(tableWords)} count`, 'records', 'rows', 'count']).filter((s) => s.toLowerCase() !== countLabel.toLowerCase()),
    });
    for (const c of t.columns.slice(0, 200)) {
      if (!isIdentifier(c.name) || c.name.includes('.')) {
        notes.push(`Column "${t.name}.${c.name}" was skipped: its name cannot be quoted safely.`);
        continue;
      }
      const words = humanize(c.name);
      const label = cap(words);
      let type = c.type;
      const idLike = IDENTIFIER.test(words) || /(^|_)id$/i.test(c.name);
      // Numbers that identify or label something are grouped by, not added up.
      if (type === 'number' && (idLike || YEARISH.test(words))) {
        type = 'string';
        notes.push(`"${label}" holds numbers but reads as ${idLike ? 'an identifier' : 'a period'}, so it is a field to group by, not a measure.`);
      }
      const key = uniqueKey(`${alias}.${slug(c.name)}`);
      const field: Field = { key, label, source: sid, table: t.name, column: c.name, type };
      if (typeof c.distinct === 'number') field.cardinality = c.distinct;
      const syn = synonymsFor(c.name, words);
      if (syn.length) field.synonyms = syn;
      fields.push(field);

      if (type === 'number') {
        const avg = AVERAGED.test(words) && !/\b(total|count|amount)\b/.test(words);
        const metricLabel = avg ? `Average ${words}` : label;
        const m: Metric = { key: uniqueKey(slug(`${avg ? 'avg_' : ''}${c.name}`)), label: metricLabel, agg: avg ? 'avg' : 'sum', field: key, source: sid };
        if (MONEY.test(words)) m.format = 'currency';
        else if (/\b(percent|rate|ratio)\b/.test(words)) m.format = 'percent';
        const ms = unique([words, ...syn, ...(avg ? [] : [`total ${words}`])]).filter((s) => s.toLowerCase() !== metricLabel.toLowerCase());
        if (ms.length) m.synonyms = ms;
        metrics.push(m);
      } else if (type === 'string' && idLike && rows && c.distinct && c.distinct > 20) {
        metrics.push({
          key: uniqueKey(`distinct_${slug(c.name)}`),
          label: `${cap(plural(stripId(words)))} affected`,
          agg: 'count_distinct',
          field: key,
          source: sid,
          synonyms: unique([`unique ${plural(stripId(words))}`, `distinct ${plural(stripId(words))}`, `number of ${plural(stripId(words))}`]),
        });
      }
    }
  }
  const catalog: Catalog = existing
    ? { version: 1, sources: mergeById(existing.sources, [profile.source]), fields: [...existing.fields, ...fields], metrics: [...existing.metrics, ...metrics] }
    : { version: 1, sources: [profile.source], fields, metrics };
  return { catalog, notes };
}

/** "QtyOnHand" -> "qty on hand" -> "quantity on hand"; "opened_on" -> "opened on". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
  return words.map((w) => (w === 'id' ? 'id' : (ABBREVIATIONS[w] ?? w))).join(' ');
}

function synonymsFor(column: string, words: string): string[] {
  const raw = column.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').toLowerCase().trim();
  const out = [raw];
  const parts = words.split(' ');
  // "hull number" also answers to "hull"; "ship class" to "class".
  if (parts.length > 1 && /^(number|id|code|name|date|type|class|category)$/.test(parts.at(-1)!)) out.push(parts.slice(0, -1).join(' '));
  if (parts.length > 1 && /^(date|on|at)$/.test(parts.at(-1)!) && parts.length === 2) out.push(parts[0]!);
  if (parts.length === 2 && /^(ship|vessel|customer|product|employee)$/.test(parts[0]!)) out.push(parts[1]!);
  return unique(out).filter((s) => s !== words && s.length > 1);
}

function stripId(words: string): string {
  return words.replace(/\s+(id|number|code|key|no)$/, '') || words;
}

function slug(s: string): string {
  return (
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'x'
  );
}

function singular(w: string): string {
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (/(ss|us)$/.test(w)) return w;
  if (/(x|ch|sh|ss)es$/.test(w)) return w.replace(/es$/, '');
  return w.replace(/s$/, '');
}

function plural(w: string): string {
  if (/[^aeiou]y$/.test(w)) return w.replace(/y$/, 'ies');
  if (/(s|x|ch|sh)$/.test(w)) return `${w}es`;
  return `${w}s`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mergeById(a: Source[], b: Source[]): Source[] {
  const ids = new Set(a.map((s) => s.id));
  return [...a, ...b.filter((s) => !ids.has(s.id))];
}

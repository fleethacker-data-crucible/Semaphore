// Reads a flag back in plain English: what it shows, over which window, how it behaves and when
// it changes colour. This is the front of a flipped flag, above the SQL, so an analyst can check
// a draft without reading the binding.

import type { CatalogIndex } from './catalog.ts';
import { type Filter, type Flag, type Hoist, dimensionKey } from './hoist.ts';

const KIND_NAMES: Record<Flag['kind'], string> = {
  kpi: 'A KPI showing',
  bar: 'Bars of',
  line: 'A line of',
  area: 'An area chart of',
  pie: 'A pie of',
  table: 'A table of',
  filter: 'A picker listing',
  text: 'A note',
};

const AGG_WORDS: Record<string, string> = {
  sum: 'total',
  avg: 'average',
  min: 'lowest',
  max: 'highest',
  count: 'count of',
  count_distinct: 'number of distinct',
};

export function describeFlag(flag: Flag, hoist: Hoist | null, index: CatalogIndex): string[] {
  if (flag.kind === 'text') return ['A note with no data.'];
  const b = flag.binding;
  if (!b) return ['Not drafted yet: describe what this flag should show.'];
  const lines: string[] = [];
  const field = (k: string) => index.field(k)?.label ?? k;
  const metric = (k: string) => {
    const m = index.metric(k);
    if (!m) return k;
    const word = AGG_WORDS[m.agg];
    const label = m.label;
    // "Labor cost" is already a sum; say "total" only when the label does not imply it.
    if (m.agg === 'count' || m.agg === 'count_distinct' || /^(average|avg|total|number|count|min|max|lowest|highest)\b/i.test(label)) return label;
    return word ? `${label} (${word})` : label;
  };

  const own = b.dimensions.map((d) => (d.grain ? `per ${d.grain}` : `by ${field(d.field)}`));
  let what: string;
  if (flag.kind === 'filter') what = `${KIND_NAMES.filter} every ${field(b.dimensions[0]?.field ?? '')}`;
  else if (b.metrics.length === 0) what = `A list of ${b.dimensions.map((d) => field(d.field)).join(', ')}`;
  else what = `${KIND_NAMES[flag.kind]} ${list(b.metrics.map(metric))}${own.length ? ` ${own.join(', ')}` : ''}`;
  if (b.share) what += ', as a share of the total';
  lines.push(`${what}.`);

  if (b.limit) {
    const by = b.sort && index.metric(b.sort.by) ? index.metric(b.sort.by)!.label : 'value';
    lines.push(`${b.sort?.dir === 'asc' ? 'Bottom' : 'Top'} ${b.limit} by ${by}.`);
  } else if (b.sort && flag.kind !== 'kpi') {
    const time = b.dimensions.find((d) => dimensionKey(d) === b.sort!.by && d.grain);
    if (!time) {
      const by = index.metric(b.sort.by)?.label ?? field(b.sort.by.split('@')[0]!);
      lines.push(`Sorted by ${by}, ${b.sort.dir === 'desc' ? 'highest first' : 'lowest first'}.`);
    }
  }

  const window: string[] = [];
  for (const f of hoist?.filters ?? []) {
    if (flag.behavior.ignore.includes(f.field)) continue;
    window.push(`${filterText(f, index)} (page)`);
  }
  for (const f of b.filters) window.push(filterText(f, index));
  if (window.length) lines.push(`${cap(window.join('; '))}.`);
  if (b.compare) lines.push(b.compare === 'previous-year' ? 'Compared with the same window a year earlier.' : 'Compared with the window just before.');

  if (flag.kind !== 'filter') {
    if (flag.behavior.onClick === 'filter-page') lines.push('Clicking a value filters the whole page.');
    else if (flag.behavior.onClick === 'drill') lines.push('Clicking a value selects it on the page (drill paths are planned).');
  } else lines.push('Choosing values filters the whole page.');
  if (flag.behavior.ignore.length) lines.push(`Ignores page selections on ${list(flag.behavior.ignore.map(field))}.`);
  for (const t of flag.behavior.thresholds) {
    const tone = { bad: 'red', warn: 'amber', good: 'green' }[t.tone];
    const op = { gt: 'over', gte: 'at or over', lt: 'under', lte: 'at or under' }[t.op];
    lines.push(`Turns ${tone} when ${index.metric(t.metric)?.label ?? t.metric} is ${op} ${formatNumber(t.value, index.metric(t.metric)?.format)}.`);
  }
  return lines;
}

export function filterText(f: Filter, index: CatalogIndex): string {
  const label = index.field(f.field)?.label ?? f.field;
  const v = f.values;
  switch (f.op) {
    case 'last':
      return `last ${v[0] === 1 ? '' : `${v[0]} `}${f.unit}${v[0] === 1 ? '' : 's'} of ${label}`;
    case 'eq':
      return `${label} is ${v[0]}`;
    case 'in':
      return v.length === 1 ? `${label} is ${v[0]}` : `${label} is one of ${list(v.slice(0, 6).map(String))}${v.length > 6 ? ` and ${v.length - 6} more` : ''}`;
    case 'gte':
      return `${label} from ${v[0]}`;
    case 'lte':
      return `${label} up to ${v[0]}`;
    case 'between':
      return `${label} from ${v[0]} to ${v[1]}`;
  }
}

/** Compact number for labels: 5000000 -> "5M", 0.25 percent -> "25%", currency -> "$5M". */
export function formatNumber(n: number | null | undefined, format?: 'number' | 'currency' | 'percent'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (format === 'percent') return `${round(n * 100)}%`;
  const abs = Math.abs(n);
  const unit = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e4 ? ['K', 1e3] : ['', 1];
  const body = unit[0] ? `${round(n / (unit[1] as number))}${unit[0]}` : abs >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : round(n);
  return format === 'currency' ? (n < 0 ? `-$${body.replace('-', '')}` : `$${body}`) : body;
}

function round(n: number): string {
  const a = Math.abs(n);
  const s = a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

function list(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

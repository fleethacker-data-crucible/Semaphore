// A calculated measure from a sentence: "cost per hull = labor cost / hulls", "cost per job is labor
// cost divided by work orders", "the difference between budget and actual", "hull share: hulls as a
// percent of work orders". The sentence proposes a formula measure (formula.ts) that the analyst
// reads back and accepts, like a cleaning step; nothing is added until they do. Measures are found by
// their labels, keys and synonyms. Loaded with the Data panel and when a brief defines a measure.

import type { CatalogIndex, Metric } from './catalog.ts';
import { type FormulaNode, formulaRefs, parseFormula, printFormula } from './formula.ts';

export type MeasureProposal = { ok: true; metric: Metric; sentence: string } | { ok: false; error: string };

/** Whether a brief reads as a measure definition ("x = a / b", "x is a divided by b"). Cheap, for the page to decide whether to load this module. */
export const DEFINES_MEASURE = /=|\bdivided by\b|\bdifference between\b|\bas an? (?:percent(?:age)?|share|%) of\b|\bis defined as\b/i;

export function proposeMeasure(sentence: string, index: CatalogIndex): MeasureProposal {
  const text = sentence.slice(0, 300).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  if (!text) return { ok: false, error: 'Say what the measure is, for example “cost per hull = labor cost / hulls”.' };
  let name = '';
  let body = text;
  const named = /^(.{1,60}?)\s*(?:=|:|\bis defined as\b|\bis\b|\bmeans\b)\s*(.+)$/i.exec(text);
  if (named && !/\bdifference between\b/i.test(named[1]!)) [name, body] = [named[1]!.trim(), named[2]!.trim()];
  // A brief can go on after the definition: "… by region", "… for the last 12 months".
  body = body.replace(/(?<!divided|multiplied)\s(?:by|for|in the|during|across|last|this)\s.*$|,.*$/i, '').trim();

  let percent = false;
  let words = body.replace(/^(?:the|a|an)\s+/i, '');
  let hit: RegExpExecArray | null;
  if ((hit = /^difference between (.+?) and (.+)$/i.exec(words))) words = `(${hit[1]}) - (${hit[2]})`;
  else if ((hit = /^(?:ratio of )?(.+?) (?:as an? (?:percent(?:age)?|share|%) of|to) (.+)$/i.exec(words)) && (/ as /i.test(words) || /^ratio of /i.test(body))) {
    percent = / as /i.test(words);
    words = `(${hit[1]}) / (${hit[2]})`;
  }
  // Words for operators; the rest is measure names, numbers and parentheses.
  words = ` ${words} `
    .replace(/\s(?:divided by|over)\s|\s?÷\s?/gi, ' / ')
    .replace(/\s(?:times|multiplied by)\s|\s?×\s?/gi, ' * ')
    .replace(/\splus\s/gi, ' + ')
    .replace(/\s(?:minus|less)\s|\s?−\s?/gi, ' - ');

  // Split into operators/parentheses and the phrases between them.
  const parts = words.split(/([-+*/()])/).map((p) => p.trim()).filter(Boolean);
  const keys: string[] = [];
  let source: string | undefined;
  let out = '';
  for (const p of parts) {
    if (/^[-+*/()]$/.test(p)) out += ` ${p} `;
    else if (/^\d+(?:\.\d+)?$|^\.\d+$/.test(p)) out += ` ${p} `;
    else {
      const m = findMeasure(p, index);
      if (!m) return { ok: false, error: `“${p}” is not a measure Semaphore knows. Use a measure's name from Data > Measures.` };
      if (source && m.source !== source) return { ok: false, error: `“${m.label}” is in another source; a calculated measure reads one source.` };
      source = m.source;
      keys.push(m.key);
      out += ` ${m.key} `;
    }
  }
  if (!keys.length || !source) return { ok: false, error: 'Name at least one measure, for example “labor cost / hulls”.' };
  const parsed = parseFormula(out.replace(/\s+/g, ' ').trim());
  if (!parsed.ok) return { ok: false, error: `Semaphore could not read that as a calculation: ${parsed.error}` };
  const label = index.metric.bind(index);
  const node = parsed.node;
  const words2 = printFormula(node, (k) => label(k)?.label ?? k);
  const title = cap(name || (percent ? `${label(keys[0]!)?.label} as a percent of ${label(keys[1] ?? keys[0]!)?.label.toLowerCase()}` : words2)).slice(0, 80);
  const format: Metric['format'] = percent ? 'percent' : guessFormat(node, (k) => label(k)?.format);
  const taken = new Set([...index.catalog.metrics.map((m) => m.key), ...index.catalog.fields.map((f) => f.key)]);
  let key = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'calculated';
  for (let i = 2; taken.has(key); i++) key = `${key.replace(/_\d+$/, '')}_${i}`;
  const metric: Metric = { key, label: title, agg: 'formula', formula: printFormula(node), source, ...(format !== 'number' ? { format } : {}) };
  return { ok: true, metric, sentence: `${title} = ${words2}` };
}

/** A measure named by a phrase: its label, key or a synonym, then a plural or a label it starts. */
export function findMeasure(phrase: string, index: CatalogIndex): Metric | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const p = norm(phrase).replace(/^(?:the|total|all)\s+/, '');
  const metrics = index.catalog.metrics;
  const names = (m: Metric) => [m.label, m.key, ...(m.synonyms ?? [])].map(norm);
  const variants = [p, p.replace(/s$/, ''), `${p}s`];
  return (
    metrics.find((m) => names(m).some((n) => variants.includes(n))) ??
    metrics.find((m) => names(m).some((n) => variants.some((v) => v.length > 2 && n.startsWith(`${v} `)))) ??
    metrics.find((m) => names(m).some((n) => variants.some((v) => v.length > 3 && n.includes(v))))
  );
}

/** Currency over a count is still currency (cost per hull); a ratio of two currencies is a plain number. */
function guessFormat(node: FormulaNode, format: (key: string) => Metric['format']): NonNullable<Metric['format']> {
  const go = (n: FormulaNode): Metric['format'] | 'none' => {
    if (n.t === 'num') return 'none';
    if (n.t === 'ref') return format(n.key) ?? 'number';
    if (n.t === 'neg') return go(n.x);
    const l = go(n.l);
    const r = go(n.r);
    if (n.op === '/') return l === 'currency' && r !== 'currency' ? 'currency' : l === r && l !== 'none' ? 'number' : l === 'none' ? r : l;
    if (n.op === '*') return l === 'none' ? r : r === 'none' ? l : 'number';
    return l === 'none' ? r : l;
  };
  const f = go(node);
  return f === 'none' || !f ? 'number' : f;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The measures with every formula that reads a measure no longer among them taken out, until none does. */
export function dropBrokenFormulas(metrics: readonly Metric[]): Metric[] {
  let out = [...metrics];
  for (let n = -1; n !== out.length; ) {
    n = out.length;
    const keys = new Set(out.map((m) => m.key));
    out = out.filter((m) => {
      if (m.agg !== 'formula') return true;
      const p = parseFormula(m.formula ?? '');
      return p.ok && formulaRefs(p.node).every((k) => keys.has(k));
    });
  }
  return out;
}

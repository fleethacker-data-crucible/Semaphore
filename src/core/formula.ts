// Calculated measures: a metric whose value is worked out from other metrics, such as
// "cost per hull = labor cost / hulls affected". The catalog keeps it as
//   { key, label, agg: 'formula', formula: 'labor_cost / hulls_affected', format?, source }
// (the same shape the Power BI and dbt importers emit). The formula is other metric keys, numbers,
// + - * /, unary minus and parentheses; nothing else.
//
// A formula is never sent to a database. The planner asks the source for its inputs' aggregates
// (as hidden partials, like an average's sum and count), and the value is computed from them per
// row of the result: per group, per total, per comparison window, always from that row's own
// aggregates and never by adding up ratios. Division by zero, or any input with no value, is null.
// So the in-page engine and every SQL dialect give the same answer by construction.

import type { Catalog, Metric } from './catalog.ts';

export type FormulaOp = '+' | '-' | '*' | '/';

export type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'ref'; key: string }
  | { t: 'neg'; x: FormulaNode }
  | { t: 'bin'; op: FormulaOp; l: FormulaNode; r: FormulaNode };

/** Longest formula text accepted (the importers' limit too). */
export const FORMULA_MAX_CHARS = 2000;
/** How deep formulas may build on formulas (cost per hull per day: 2). */
export const FORMULA_MAX_DEPTH = 6;
/** How deep parentheses and minus signs may nest inside one formula. */
const MAX_NESTING = 64;

export type FormulaParse = { ok: true; node: FormulaNode } | { ok: false; error: string };

const NOT_PART = (t: string) => `"${t}" is not part of a calculated measure (only + - * /, parentheses, numbers and measures)`;

/**
 * The one grammar for calculated measures, used by the catalog, the planner and the model importers
 * (model-import.ts). `name` says which words are measures and may rename them (a dbt alias to its
 * metric key); a word it refuses, a function call or any other character makes the formula unreadable.
 */
export function parseFormula(text: string, name: (word: string) => string | null = (w) => w): FormulaParse {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The expression is empty' };
  if (text.length > FORMULA_MAX_CHARS) return { ok: false, error: 'The expression is too long to read' };
  const tokens: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_.]*|[-+*/()]|\S)/gy;
  for (let m = re.exec(text); m; m = re.exec(text)) tokens.push(m[1]!);
  let i = 0;
  let depth = 0;
  const fail = (why: string): never => {
    throw new FormulaSyntax(why);
  };
  const expr = (): FormulaNode => {
    let l = term();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++] as FormulaOp;
      l = { t: 'bin', op, l, r: term() };
    }
    return l;
  };
  const term = (): FormulaNode => {
    let l = unary();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++] as FormulaOp;
      l = { t: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const unary = (): FormulaNode => {
    if (++depth > MAX_NESTING) fail('The expression is nested too deeply');
    try {
      if (tokens[i] === '-') {
        i++;
        return { t: 'neg', x: unary() };
      }
      if (tokens[i] === '+') {
        i++;
        return unary();
      }
      return primary();
    } finally {
      depth--;
    }
  };
  const primary = (): FormulaNode => {
    const t = tokens[i];
    if (t === undefined) return fail('The expression ends too soon');
    if (t === '(') {
      i++;
      const inner = expr();
      if (tokens[i] !== ')') fail('Unbalanced parentheses');
      i++;
      return inner;
    }
    if (/^[\d.]/.test(t)) {
      i++;
      return { t: 'num', v: Number(t) };
    }
    if (/^[A-Za-z_]/.test(t)) {
      if (tokens[i + 1] === '(') fail(`Uses the function ${t}(), which a calculated measure cannot`);
      const key = name(t);
      if (key === null) fail(`"${t}" is not a measure in this model`);
      i++;
      return { t: 'ref', key: key! };
    }
    return fail(t === ')' ? 'Unbalanced parentheses' : NOT_PART(t));
  };
  try {
    const node = expr();
    if (i < tokens.length) fail(tokens[i] === ')' ? 'Unbalanced parentheses' : NOT_PART(tokens[i]!));
    return { ok: true, node };
  } catch (e) {
    if (e instanceof FormulaSyntax) return { ok: false, error: e.message };
    throw e;
  }
}

class FormulaSyntax extends Error {}

/** Metric keys a formula names, in the order they first appear. */
export function formulaRefs(node: FormulaNode, out: string[] = []): string[] {
  if (node.t === 'ref') {
    if (!out.includes(node.key)) out.push(node.key);
  } else if (node.t === 'neg') formulaRefs(node.x, out);
  else if (node.t === 'bin') {
    formulaRefs(node.l, out);
    formulaRefs(node.r, out);
  }
  return out;
}

/** Problems with the catalog's formula measures: unknown or cross-source inputs, cycles, depth. */
export function checkFormulas(catalog: Catalog): string[] {
  const problems: string[] = [];
  const byKey = new Map(catalog.metrics.map((m) => [m.key, m]));
  const parsed = new Map<string, FormulaNode>();
  for (const m of catalog.metrics) {
    if (m.agg !== 'formula') continue;
    if (!m.formula?.trim()) {
      problems.push(`Metric "${m.key}" is calculated but has no formula.`);
      continue;
    }
    const p = parseFormula(m.formula);
    if (!p.ok) {
      problems.push(`Measure "${m.key}" has a formula Semaphore cannot read: ${p.error}`);
      continue;
    }
    parsed.set(m.key, p.node);
    for (const ref of formulaRefs(p.node)) {
      const input = byKey.get(ref);
      if (!input) problems.push(`Measure "${m.key}" uses "${ref}", which is not a measure in the catalog.`);
      else if (input.source !== m.source) problems.push(`Measure "${m.key}" uses "${ref}" from another source; a formula reads one source.`);
    }
  }
  // Cycles and depth, over the formulas that parsed.
  const state = new Map<string, 'open' | number>();
  const reported = new Set<string>();
  const depthOf = (key: string, path: string[]): number => {
    const s = state.get(key);
    if (s === 'open') {
      const cycle = [...path.slice(path.indexOf(key)), key];
      if (!reported.has(key)) problems.push(`Measures ${cycle.map((k) => `"${k}"`).join(' → ')} are defined in a circle.`);
      for (const k of cycle) reported.add(k);
      return Infinity;
    }
    if (typeof s === 'number') return s;
    const node = parsed.get(key);
    if (!node) return 0;
    state.set(key, 'open');
    let d = 1;
    for (const ref of formulaRefs(node)) if (byKey.get(ref)?.agg === 'formula') d = Math.max(d, 1 + depthOf(ref, [...path, key]));
    state.set(key, d);
    return d;
  };
  for (const key of parsed.keys()) {
    const d = depthOf(key, []);
    if (Number.isFinite(d) && d > FORMULA_MAX_DEPTH) problems.push(`Measure "${key}" builds on formulas ${d} deep; at most ${FORMULA_MAX_DEPTH} are allowed.`);
  }
  return problems;
}

/** The plain (non-formula) measures a measure finally reads, through any formulas it builds on. */
export function baseInputs(key: string, metric: (k: string) => Metric | undefined, seen: Set<string> = new Set()): Metric[] {
  const m = metric(key);
  if (!m || seen.has(key)) return [];
  if (m.agg !== 'formula') return [m];
  seen.add(key);
  const p = parseFormula(m.formula ?? '');
  if (!p.ok) return [];
  const out: Metric[] = [];
  for (const ref of formulaRefs(p.node)) for (const b of baseInputs(ref, metric, seen)) if (!out.includes(b)) out.push(b);
  seen.delete(key);
  return out;
}

/** Applies one operator the way SQL would: null in, null out; division by zero is null. */
export function applyOp(op: FormulaOp, a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const v = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : b === 0 ? null : a / b;
  return v === null || !Number.isFinite(v) ? null : v;
}

/**
 * A formula as text. With `label`, in words for a reader ("Labor cost ÷ Hulls affected"); without,
 * as catalog text with keys (used when a sentence proposes one).
 */
export function printFormula(node: FormulaNode, label?: (key: string) => string): string {
  const sign = (op: FormulaOp) => (label ? { '+': '+', '-': '−', '*': '×', '/': '÷' }[op] : op);
  const rank = (n: FormulaNode): number => (n.t === 'bin' ? (n.op === '+' || n.op === '-' ? 1 : 2) : 3);
  const go = (n: FormulaNode): string => {
    switch (n.t) {
      case 'num':
        return String(n.v);
      case 'ref':
        return label ? label(n.key) : n.key;
      case 'neg':
        return `${sign('-')}${rank(n.x) < 3 ? `(${go(n.x)})` : go(n.x)}`;
      case 'bin': {
        const l = rank(n.l) < rank(n) ? `(${go(n.l)})` : go(n.l);
        const r = rank(n.r) < rank(n) || (rank(n.r) === rank(n) && (n.op === '-' || n.op === '/')) ? `(${go(n.r)})` : go(n.r);
        return `${l} ${sign(n.op)} ${r}`;
      }
    }
  };
  return go(node);
}

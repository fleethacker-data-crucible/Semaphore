// SQL scripts for the local database: an analyst writes a multi-statement script in their own SQL
// language (T-SQL, Oracle, PostgreSQL...) and Semaphore runs it in the local database (SQLite) in one
// transaction. This module is pure: it splits the script into statements (strings, comments and
// BEGIN...END blocks honoured), classifies them, translates each into SQLite, and produces the plan
// the server runs (server/LocalScript.cs). The page shows the translated script and the notes before
// anything runs; the server re-checks every statement with SQLite's authorizer and never trusts the plan.
//
// What SQLite lacks is lowered into the plan:
//   MERGE                         an UPDATE ... FROM, an INSERT ... WHERE NOT EXISTS (and DELETEs), in order
//   PIVOT / UNPIVOT               CASE aggregates with GROUP BY / UNION ALL branches
//   TRY...CATCH, BEGIN...EXCEPTION a "try" node: the server runs the block in a SAVEPOINT and, on an error,
//                                 rolls back to it and runs the handler (@error_message, @error_number set)
//   DECLARE / SET / := / SELECT @v = ... / SELECT ... INTO v   runner variables, bound as named parameters
//   IF / ELSE / ELSIF, WHILE, LOOP / EXIT WHEN, FOR i IN a..b    runner control flow (loops are bounded)
//   SELECT ... INTO new_table     CREATE TABLE ... AS SELECT
//   IMPORT INTO t FROM SOURCE id AS (SELECT ...)   a pull from a live (read-only) source into a local table
// Anything the local database cannot do safely is refused with a reason (REFUSALS).

import type { Dialect } from './catalog.ts';
import { DIALECT_NAMES, translateSql } from './sql-translate.ts';

// ---------------------------------------------------------------------------------------------
// Plan (the JSON the server runs; server/LocalScript.ps1 validates the same shape)
// ---------------------------------------------------------------------------------------------
export type PlanNode =
  | { op: 'sql'; sql: string; line: number; kind: StatementKind }
  | { op: 'declare'; name: string; sql?: string; line: number }
  | { op: 'assign'; names: string[]; sql: string; mode: 'last' | 'one'; line: number }
  | { op: 'if'; cond: string; then: PlanNode[]; else: PlanNode[]; line: number }
  | { op: 'while'; cond: string; body: PlanNode[]; step?: PlanNode[]; max: number; line: number }
  | { op: 'break' | 'continue'; cond?: string; line: number }
  | { op: 'try'; body: PlanNode[]; catch: PlanNode[]; line: number }
  | { op: 'raise' | 'print'; sql: string; line: number }
  | { op: 'return'; line: number }
  | { op: 'import'; table: string; source: string; sql: string; mode: 'replace' | 'append'; line: number };

export type StatementKind = 'select' | 'write' | 'ddl';

export interface ScriptParam {
  /** Lower case, without the @ or : (bound as @name). */
  name: string;
  /** As written, for the prompt. */
  label: string;
}

export interface ScriptPlan {
  version: 1;
  dialect: Dialect;
  nodes: PlanNode[];
  /** Names the script reads but never declares: the page asks for a value before it runs. */
  params: ScriptParam[];
}

export interface ScriptProblem {
  line: number;
  message: string;
}

export interface CompiledScript {
  plan: ScriptPlan;
  /** The script as it will run, in SQLite, with the control flow as comments. */
  sqlite: string;
  /** Sentences about what was translated or needs a look, with the line they came from. */
  notes: ScriptProblem[];
  /** Statements that cannot run; the plan must not be sent while there are any. */
  errors: ScriptProblem[];
  /** Number of top-level statements. */
  statements: number;
}

export interface CompileOptions {
  /** Live sources a script may IMPORT FROM: id -> the dialect it speaks. */
  sources?: Record<string, Dialect>;
  /** Most iterations a loop may run (the server caps it at 100000). */
  maxLoop?: number;
}

/** Statements and features the local database refuses, with the reason shown to the analyst. */
export const REFUSALS: Array<{ rx: RegExp; why: string }> = [
  { rx: /^\s*ATTACH\b/i, why: 'ATTACH is refused: a script works only on the local database itself.' },
  { rx: /^\s*DETACH\b/i, why: 'DETACH is refused: a script works only on the local database itself.' },
  { rx: /^\s*VACUUM\b/i, why: 'VACUUM (and VACUUM INTO) is refused: it rewrites or copies the whole database file.' },
  { rx: /\bload_extension\s*\(/i, why: 'load_extension is refused: the local database runs only the SQL that ships with Windows.' },
  { rx: /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i, why: 'Triggers are refused: a trigger would run later, outside the script and its checks.' },
  { rx: /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i, why: 'Virtual tables are refused in scripts.' },
  { rx: /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i, why: 'The script runs in one transaction that Semaphore opens and commits; BEGIN, COMMIT, ROLLBACK and SAVEPOINT are not needed (TRY...CATCH and EXCEPTION blocks roll back their own part).' },
  { rx: /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+(?:TABLE|VIEW|INDEX)(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|RENAME\s+TO|CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|VIEW)(?:\s+IF\s+NOT\s+EXISTS)?|INDEX\s+\S+\s+ON)\s+(?:main\.|"main"\.)?["`[]?_semaphore/i, why: "Tables whose names start with _semaphore belong to Semaphore's own bookkeeping; a script may read them but never change them." },
];

/** Pragmas a script may read (no value may be set). */
export const SAFE_PRAGMAS = ['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check', 'table_list', 'page_count', 'page_size', 'freelist_count'];

/** null when a SQLite statement may be sent, else the reason it is refused (the server's authorizer has the last word). */
export function refusal(sql: string): string | null {
  const s = stripForCheck(sql);
  for (const r of REFUSALS) if (r.rx.test(s)) return r.why;
  const pragma = /^\s*PRAGMA\s+(?:main\.)?([A-Za-z_]+)\s*(=|\()?/i.exec(s);
  if (pragma) {
    const name = pragma[1]!.toLowerCase();
    if (pragma[2] === '=') return `PRAGMA ${name} = ... is refused: a script may read the safe pragmas but never set one.`;
    if (!SAFE_PRAGMAS.includes(name)) return `PRAGMA ${name} is refused: scripts may read only ${SAFE_PRAGMAS.join(', ')}.`;
  }
  return null;
}

function stripForCheck(sql: string): string {
  // Strings blanked so a refused word inside quotes is not a statement.
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------
type Kind = 'space' | 'comment' | 'string' | 'ident' | 'word' | 'var' | 'number' | 'punct';
export interface Tok {
  kind: Kind;
  text: string;
  line: number;
  /** For quoted names: the name inside the quotes. For var: the name without @ / : (as written). */
  name?: string;
}

/** Tokens of a script with their line numbers. Strings, quoted names and comments stay whole. */
export function tokenizeScript(sql: string, dialect: Dialect): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const push = (kind: Kind, text: string, name?: string) => {
    out.push(name === undefined ? { kind, text, line } : { kind, text, line, name });
    for (const ch of text) if (ch === '\n') line++;
  };
  const tsql = dialect === 'tsql' || dialect === 'synapse';
  while (i < sql.length) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j]!)) j++;
      push('space', sql.slice(i, j));
      i = j;
    } else if (two === '--') {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = sql.length;
      push('comment', sql.slice(i, j));
      i = j;
    } else if (two === '/*') {
      let j = sql.indexOf('*/', i + 2);
      j = j < 0 ? sql.length : j + 2;
      push('comment', sql.slice(i, j));
      i = j;
    } else if (c === "'" || ((c === 'N' || c === 'n') && sql[i + 1] === "'" && tsql)) {
      const start = i;
      let j = c === "'" ? i + 1 : i + 2;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      // N'...' (T-SQL Unicode literal) is a plain string in SQLite.
      push('string', c === "'" ? sql.slice(start, Math.min(j + 1, sql.length)) : sql.slice(start + 1, Math.min(j + 1, sql.length)));
      i = j + 1;
    } else if (c === '"' || c === '[' || c === '`') {
      const close = c === '[' ? ']' : c;
      const j = sql.indexOf(close, i + 1);
      const end = j < 0 ? sql.length : j;
      push('ident', sql.slice(i, end + 1), sql.slice(i + 1, end));
      i = end + 1;
    } else if ((c === '@' || c === ':' || c === '$') && /[A-Za-z_@]/.test(sql[i + 1] ?? '') && !(c === ':' && sql[i + 1] === ':')) {
      // @var (T-SQL, SQLite), @@ROWCOUNT, :bind (Oracle, SQLite), $name (SQLite).
      let j = i + 1;
      if (sql[j] === '@') j++;
      while (j < sql.length && /[A-Za-z0-9_$#]/.test(sql[j]!)) j++;
      push('var', sql.slice(i, j), sql.slice(c === '@' && sql[i + 1] === '@' ? i + 2 : i + 1, j));
      i = j;
    } else if (/[A-Za-z_#]/.test(c)) {
      let j = i + 1;
      if (c === '#' && sql[j] === '#') j++;
      while (j < sql.length && /[A-Za-z0-9_$#]/.test(sql[j]!)) j++;
      push('word', sql.slice(i, j));
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && /[0-9.eE]/.test(sql[j]!) && !(sql[j] === '.' && sql[j + 1] === '.')) j++;
      push('number', sql.slice(i, j));
      i = j;
    } else {
      const ops = ['||', '::', '<=', '>=', '<>', '!=', ':=', '..', '+=', '-=', '*=', '/=', '=>'];
      if (ops.includes(two)) {
        push('punct', two);
        i += 2;
      } else {
        push('punct', c);
        i += 1;
      }
    }
  }
  return out;
}

const U = (t: Tok | undefined) => (t && t.kind === 'word' ? t.text.toUpperCase() : '');
const isP = (t: Tok | undefined, p: string) => !!t && t.kind === 'punct' && t.text === p;
const sigOf = (toks: Tok[]) => toks.filter((t) => t.kind !== 'space' && t.kind !== 'comment');

/** Joins significant tokens with single spaces where the original had space. */
const SPACED_BEFORE_PAREN = new Set(['VALUES', 'IN', 'AS', 'ON', 'AND', 'OR', 'NOT', 'EXISTS', 'FROM', 'JOIN', 'WHERE', 'SELECT', 'INTO', 'TABLE', 'USING', 'THEN', 'ELSE', 'WHEN', 'UNION', 'ALL', 'OVER', 'BY', 'SET', 'IS', 'CASE', 'RETURN', 'WITH', 'PIVOT', 'UNPIVOT', 'LIKE', 'BETWEEN', 'END']);

function joinSig(toks: readonly Tok[], lines = false): string {
  let s = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    const prev = toks[k - 1];
    if (prev && lines && prev.line > 0 && t.line > prev.line) {
      s += '\n' + t.text;
      continue;
    }
    const tight = !prev || isP(t, ',') || isP(t, ')') || isP(t, '.') || isP(prev, '.') || isP(prev, '(') || (isP(t, '(') && (prev.kind === 'ident' || (prev.kind === 'word' && !SPACED_BEFORE_PAREN.has(U(prev)))));
    s += (tight ? '' : ' ') + t.text;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------------------------
export interface SplitStatement {
  text: string;
  line: number;
}

const TSQL_STARTERS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'DROP', 'ALTER', 'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN', 'PRINT', 'TRUNCATE', 'EXEC', 'EXECUTE', 'RETURN', 'BREAK', 'CONTINUE', 'THROW', 'RAISERROR', 'WITH', 'USE', 'COMMIT', 'ROLLBACK', 'SAVE', 'IMPORT']);
const BLOCK_STOPS = new Set(['END', 'ELSE', 'ELSIF', 'EXCEPTION', 'WHEN']);

class Cursor {
  i = 0;
  toks: Tok[];
  dialect: Dialect;
  constructor(toks: Tok[], dialect: Dialect) {
    this.toks = toks;
    this.dialect = dialect;
  }
  get t(): Tok | undefined {
    return this.toks[this.i];
  }
  at(k = 0): Tok | undefined {
    return this.toks[this.i + k];
  }
  word(k = 0): string {
    return U(this.toks[this.i + k]);
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  get line(): number {
    return this.t?.line ?? this.toks[this.toks.length - 1]?.line ?? 1;
  }
}

const tsqlLike = (d: Dialect) => d === 'tsql' || d === 'synapse';

/** True when the token begins a line (only white space before it on its line). */
function startsLine(c: Cursor, idx: number): boolean {
  const t = c.toks[idx];
  const p = c.toks[idx - 1];
  return !p || !t || p.line < t.line;
}

/**
 * Collects one SQL statement from the cursor: up to a ';', a GO or '/' line, a word that ends the
 * enclosing block, or (T-SQL, where ';' is optional) the start of the next statement.
 */
function collectStatement(c: Cursor, stops: ReadonlySet<string>): Tok[] {
  const start = c.i;
  let depth = 0;
  let caseDepth = 0;
  const first = c.word();
  let mainSeen = first !== 'WITH';
  let seenSelectOrValues = false;
  while (!c.done()) {
    const t = c.t!;
    const w = U(t);
    if (depth === 0 && c.i > start) {
      if (isP(t, ';')) break;
      if (w === 'GO' && tsqlLike(c.dialect) && startsLine(c, c.i)) break;
      if (isP(t, '/') && c.dialect === 'oracle' && startsLine(c, c.i) && (c.at(1)?.line ?? Infinity) > t.line) break;
      if (caseDepth === 0 && stops.has(w) && !(w === 'WHEN' && (first === 'MERGE' || first === 'CASE'))) {
        // END after CASE belongs to the CASE; ELSE inside CASE too (tracked by caseDepth).
        break;
      }
      if (tsqlLike(c.dialect) && caseDepth === 0 && TSQL_STARTERS.has(w) && newStatementHere(c, first, mainSeen, seenSelectOrValues)) break;
    }
    if (isP(t, ';') && depth === 0 && c.i === start) {
      c.i++;
      break;
    }
    if (isP(t, '(')) depth++;
    else if (isP(t, ')')) depth = Math.max(0, depth - 1);
    else if (w === 'CASE') caseDepth++;
    else if (w === 'END' && caseDepth > 0) caseDepth--;
    if (depth === 0) {
      if (w === 'SELECT' || w === 'VALUES') seenSelectOrValues = true;
      if (!mainSeen && c.i > start && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(w) && depth === 0) mainSeen = true;
    }
    c.i++;
  }
  return c.toks.slice(start, c.i);
}

function newStatementHere(c: Cursor, first: string, mainSeen: boolean, seenSelect: boolean): boolean {
  const w = c.word();
  const prev = U(c.at(-1));
  const prevTok = c.at(-1);
  if (['ON', 'FOR', 'OF', 'INSTEAD', 'AFTER', 'BEFORE', 'THEN', 'TABLE', 'VIEW', 'INDEX', 'NOT', 'AS'].includes(prev) && w !== 'BEGIN') {
    if (!(prev === 'AS' && w !== 'SELECT' && w !== 'WITH')) return false;
  }
  if (w === 'IF' && c.word(1) === 'EXISTS') return false;
  if (w === 'IF' && c.word(1) === 'NOT' && c.word(2) === 'EXISTS') return false;
  if (w === 'WITH' && isP(c.at(1), '(')) return false; // a table hint: WITH (NOLOCK)
  if (w === 'SELECT') {
    if (['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'DISTINCT'].includes(prev) || isP(prevTok, '(')) return false;
    if (first === 'INSERT' && !seenSelect) return false;
    if (first === 'WITH' && !mainSeen) return false;
    if (first === 'CREATE' && prev === 'AS') return false;
    return true;
  }
  if (w === 'SET') return !(first === 'UPDATE' || first === 'MERGE' || (first === 'WITH' && !mainSeen) || first === 'ALTER');
  if (w === 'INSERT' || w === 'UPDATE' || w === 'DELETE') {
    if (first === 'MERGE') return false;
    if (first === 'WITH' && !mainSeen) return false;
    return true;
  }
  if ((w === 'DROP' || w === 'ALTER') && first === 'ALTER') return false;
  if (w === 'BEGIN' && first === 'CREATE') return false;
  return true;
}

/** The top-level statements of a script (a procedural block counts as one), for display and counting. */
export function splitScript(text: string, dialect: Dialect): SplitStatement[] {
  const all = tokenizeScript(text, dialect);
  const c = new Cursor(sigOf(all), dialect);
  const out: SplitStatement[] = [];
  while (!c.done()) {
    if (isP(c.t, ';') || (c.word() === 'GO' && tsqlLike(dialect)) || (isP(c.t, '/') && dialect === 'oracle')) {
      c.i++;
      continue;
    }
    const startIdx = c.i;
    const line = c.line;
    skipBlock(c);
    if (c.i === startIdx) c.i++;
    const toks = c.toks.slice(startIdx, c.i);
    out.push({ text: joinSig(toks.filter((t) => !isP(t, ';') || t !== toks[toks.length - 1])), line });
  }
  return out;
}

/** Advances over one top-level unit: a statement, or a whole BEGIN...END / DECLARE...END / IF...END IF block. */
function skipBlock(c: Cursor): void {
  const w = c.word();
  const opensBlock =
    (w === 'BEGIN' && !['TRAN', 'TRANSACTION'].includes(c.word(1))) || (w === 'DECLARE' && c.dialect === 'oracle') || (c.dialect === 'oracle' && (w === 'IF' || w === 'WHILE' || w === 'LOOP' || w === 'FOR'));
  if (!opensBlock) {
    if (tsqlLike(c.dialect) && (w === 'IF' || w === 'WHILE')) {
      // IF cond <stmt-or-block> [ELSE <stmt-or-block>]
      c.i++;
      skipCondition(c);
      skipBlock(c);
      if (c.word() === 'ELSE') {
        c.i++;
        skipBlock(c);
      }
      return;
    }
    collectStatement(c, new Set());
    if (isP(c.t, ';')) c.i++;
    return;
  }
  // Count block depth until it closes.
  let depth = 0;
  let caseDepth = 0;
  while (!c.done()) {
    const x = c.word();
    if (x === 'CASE') caseDepth++;
    else if (x === 'BEGIN' && !['TRAN', 'TRANSACTION'].includes(c.word(1))) depth++;
    else if (c.dialect === 'oracle' && (x === 'LOOP' && c.word(-1) !== 'END')) depth++;
    else if (c.dialect === 'oracle' && x === 'IF' && c.word(-1) !== 'END') depth++;
    else if (x === 'END') {
      if (caseDepth > 0 && !['IF', 'LOOP'].includes(c.word(1))) caseDepth--;
      else {
        depth--;
        if (['TRY', 'CATCH', 'IF', 'LOOP'].includes(c.word(1))) c.i++;
        if (depth <= 0) {
          c.i++;
          if (U(c.t) && !['TRY', 'CATCH'].includes(c.word()) && c.t?.line === c.at(-1)?.line && c.t?.kind === 'word' && !TSQL_STARTERS.has(c.word()) && c.dialect === 'oracle') c.i++; // END label;
          if (isP(c.t, ';')) c.i++;
          // T-SQL: END TRY BEGIN CATCH ... END CATCH is one unit.
          if (tsqlLike(c.dialect) && c.word() === 'BEGIN' && c.word(1) === 'CATCH') {
            skipBlock(c);
          }
          return;
        }
      }
    }
    c.i++;
  }
}

function skipCondition(c: Cursor): void {
  let depth = 0;
  while (!c.done()) {
    if (isP(c.t, '(')) depth++;
    else if (isP(c.t, ')')) depth--;
    else if (depth === 0 && TSQL_STARTERS.has(c.word()) && c.word() !== 'SELECT') return;
    else if (depth === 0 && c.word() === 'SELECT') return;
    c.i++;
  }
}

// ---------------------------------------------------------------------------------------------
// Compiling
// ---------------------------------------------------------------------------------------------
interface Ctx {
  from: Dialect;
  notes: ScriptProblem[];
  errors: ScriptProblem[];
  declared: Set<string>;
  params: Map<string, string>;
  sources: Record<string, Dialect>;
  maxLoop: number;
  depth: number;
  temps: Set<string>;
  /** Variables declared with a text type (T-SQL + between them joins text). */
  textVars: Set<string>;
}

const NAME_RX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Compiles a script written in `from` into the plan the local database runs. */
export function compileScript(text: string, from: Dialect, options: CompileOptions = {}): CompiledScript {
  const ctx: Ctx = { from, notes: [], errors: [], declared: new Set(['error_message', 'error_number']), params: new Map(), sources: options.sources ?? {}, maxLoop: Math.min(100_000, Math.max(1, options.maxLoop ?? 10_000)), depth: 0, temps: new Set(), textVars: new Set(['error_message']) };
  const all = tokenizeScript(text, from);
  const c = new Cursor(sigOf(all), from);
  const nodes = parseBlock(c, ctx, new Set(), true);
  if (!c.done()) ctx.errors.push({ line: c.line, message: `Unexpected ${c.t!.text} here: a block was closed that was never opened.` });
  const plan: ScriptPlan = { version: 1, dialect: from, nodes, params: [...ctx.params].filter(([n]) => !ctx.declared.has(n)).map(([name, label]) => ({ name, label })) };
  const uniq = (xs: ScriptProblem[]) => xs.filter((x, i) => xs.findIndex((y) => y.line === x.line && y.message === x.message) === i);
  return { plan, sqlite: renderPlan(nodes), notes: uniq(ctx.notes), errors: uniq(ctx.errors), statements: nodes.length };
}

function note(ctx: Ctx, line: number, message: string): void {
  // translateSql's warning about + is handled here: + next to text becomes ||.
  if (tsqlLike(ctx.from) && message.startsWith('A + between text values')) return;
  ctx.notes.push({ line, message });
}
function fail(ctx: Ctx, line: number, message: string): void {
  ctx.errors.push({ line, message });
}

/** Parses statements until one of `stops` (not consumed) or the end. */
function parseBlock(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>, top = false): PlanNode[] {
  const out: PlanNode[] = [];
  ctx.depth++;
  if (ctx.depth > 16) {
    fail(ctx, c.line, 'Blocks are nested more than 16 deep.');
    ctx.depth--;
    return out;
  }
  while (!c.done()) {
    const w = c.word();
    if (isP(c.t, ';') || (w === 'GO' && tsqlLike(ctx.from)) || (isP(c.t, '/') && ctx.from === 'oracle')) {
      c.i++;
      continue;
    }
    if (stops.has(w)) {
      // END TRY / END CATCH / END IF / END LOOP / END are closers; a bare END that is a stop ends the block.
      break;
    }
    const before = c.i;
    out.push(...parseStatement(c, ctx, stops, top));
    if (c.i === before) c.i++; // never loop on a token nothing understood
  }
  ctx.depth--;
  return out;
}

function parseStatement(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>, top: boolean): PlanNode[] {
  const line = c.line;
  const w = c.word();
  const w1 = c.word(1);
  const tsql = tsqlLike(ctx.from);
  const ora = ctx.from === 'oracle';

  if (w === 'IMPORT' && w1 === 'INTO') return parseImport(c, ctx, top, stops);

  // ---- transactions: the runner owns them -------------------------------------------------
  if ((w === 'BEGIN' && (w1 === 'TRAN' || w1 === 'TRANSACTION')) || w === 'COMMIT' || (w === 'ROLLBACK' && !(ora && w1 === 'TO')) || (w === 'SAVE' && (w1 === 'TRAN' || w1 === 'TRANSACTION'))) {
    collectStatement(c, stops);
    note(ctx, line, `${w} was left out: the whole script runs in one transaction that Semaphore commits at the end, or rolls back on an error.`);
    return [];
  }

  if (tsql) {
    if (w === 'BEGIN' && w1 === 'TRY') {
      c.i += 2;
      const body = parseBlock(c, ctx, new Set(['END']));
      expectWords(c, ctx, ['END', 'TRY']);
      if (!(c.word() === 'BEGIN' && c.word(1) === 'CATCH')) {
        fail(ctx, c.line, 'END TRY must be followed by BEGIN CATCH.');
        return [{ op: 'try', body, catch: [], line }];
      }
      c.i += 2;
      const handler = parseBlock(c, ctx, new Set(['END']));
      expectWords(c, ctx, ['END', 'CATCH']);
      note(ctx, line, 'TRY...CATCH: the TRY block runs in a savepoint; on an error it is rolled back to that point and the CATCH block runs (ERROR_MESSAGE() and ERROR_NUMBER() work there).');
      return [{ op: 'try', body, catch: handler, line }];
    }
    if (w === 'BEGIN') {
      c.i++;
      const body = parseBlock(c, ctx, new Set(['END']));
      expectWords(c, ctx, ['END']);
      return body;
    }
    if (w === 'IF') {
      c.i++;
      const cond = takeCondition(c);
      const thenNodes = parseBranch(c, ctx, stops);
      let elseNodes: PlanNode[] = [];
      if (c.word() === 'ELSE') {
        c.i++;
        elseNodes = parseBranch(c, ctx, stops);
      }
      return [{ op: 'if', cond: condition(cond, ctx, line), then: thenNodes, else: elseNodes, line }];
    }
    if (w === 'WHILE') {
      c.i++;
      const cond = takeCondition(c);
      const body = parseBranch(c, ctx, stops);
      return [{ op: 'while', cond: condition(cond, ctx, line), body, max: ctx.maxLoop, line }];
    }
    if (w === 'BREAK' || w === 'CONTINUE') {
      c.i++;
      return [{ op: w === 'BREAK' ? 'break' : 'continue', line }];
    }
    if (w === 'RETURN') {
      collectStatement(c, stops);
      return [{ op: 'return', line }];
    }
    if (w === 'DECLARE') return parseTsqlDeclare(c, ctx, stops);
    if (w === 'SET' && c.at(1)?.kind === 'var') return parseTsqlSet(c, ctx, stops);
    if (w === 'SET') {
      const toks = collectStatement(c, stops);
      note(ctx, line, `${joinSig(toks)} was left out: it is a SQL Server session setting.`);
      return [];
    }
    if (w === 'USE') {
      collectStatement(c, stops);
      note(ctx, line, 'USE was left out: a script always runs in the local database.');
      return [];
    }
    if (w === 'PRINT') {
      c.i++;
      const toks = collectStatement(c, stops);
      return [{ op: 'print', sql: expr(toks, ctx, line), line }];
    }
    if (w === 'THROW' || w === 'RAISERROR') {
      c.i++;
      const toks = collectStatement(c, stops);
      return [raiseNode(toks, ctx, line, w)];
    }
    if (w === 'SELECT' && isAssignmentSelect(c)) return parseTsqlSelectAssign(c, ctx, stops);
  }

  if (ora) {
    if (w === 'DECLARE' || w === 'BEGIN') return parseOracleBlock(c, ctx);
    if (w === 'IF') return parseOracleIf(c, ctx);
    if (w === 'WHILE' || w === 'LOOP' || w === 'FOR') return parseOracleLoop(c, ctx);
    if (w === 'EXIT' || w === 'CONTINUE') {
      c.i++;
      let cond: string | undefined;
      if (c.word() === 'WHEN') {
        c.i++;
        cond = condition(collectStatement(c, stops), ctx, line);
      } else collectStatement(c, stops);
      return [cond ? { op: w === 'EXIT' ? 'break' : 'continue', cond, line } : { op: w === 'EXIT' ? 'break' : 'continue', line }];
    }
    if (w === 'NULL' && isP(c.at(1), ';')) {
      c.i++;
      return [];
    }
    if (w === 'RETURN') {
      collectStatement(c, stops);
      return [{ op: 'return', line }];
    }
    if (w === 'RAISE' || w === 'RAISE_APPLICATION_ERROR') {
      const toks = collectStatement(c, stops);
      return [raiseNode(toks.slice(1), ctx, line, w)];
    }
    if ((w === 'DBMS_OUTPUT' && isP(c.at(1), '.')) || w === 'DBMS_OUTPUT.PUT_LINE') {
      const toks = collectStatement(c, stops);
      const open = toks.findIndex((t) => isP(t, '('));
      const inner = open >= 0 ? toks.slice(open + 1, toks.length - (isP(toks[toks.length - 1], ')') ? 1 : 0)) : [];
      return [{ op: 'print', sql: expr(inner, ctx, line), line }];
    }
    if (w === 'EXECUTE' && w1 === 'IMMEDIATE') {
      const toks = collectStatement(c, stops);
      const lit = toks[2];
      if (toks.length === 3 && lit?.kind === 'string') {
        const inner = lit.text.slice(1, -1).replace(/''/g, "'");
        note(ctx, line, 'EXECUTE IMMEDIATE with a fixed text was run as the statement it holds.');
        const sub = new Cursor(sigOf(tokenizeScript(inner, ctx.from)), ctx.from);
        sub.toks.forEach((t) => (t.line = line));
        return parseBlock(sub, ctx, new Set());
      }
      fail(ctx, line, 'EXECUTE IMMEDIATE with a built-up text cannot run here: write the statement itself.');
      return [];
    }
    if (c.at(0)?.kind === 'word' && isP(c.at(1), ':=')) {
      const name = c.t!.text.toLowerCase();
      c.i += 2;
      const toks = collectStatement(c, stops);
      ctx.declared.add(name);
      return [{ op: 'assign', names: [name], sql: expr(toks, ctx, line), mode: 'last', line }];
    }
    if (w === 'SELECT' && hasIntoVariable(c, ctx)) return parseOracleSelectInto(c, ctx, stops);
    if (w === 'CURSOR' || (w === 'OPEN' || w === 'FETCH' || w === 'CLOSE')) {
      collectStatement(c, stops);
      fail(ctx, line, 'Cursors cannot run here: write it as one set-based statement (INSERT ... SELECT, UPDATE ... FROM).');
      return [];
    }
  }

  if (w === 'EXEC' || w === 'EXECUTE' || w === 'CALL') {
    collectStatement(c, stops);
    fail(ctx, line, 'Stored procedures do not exist in the local database: write the statements themselves.');
    return [];
  }
  if (w === 'DO' && ctx.from === 'postgres') {
    collectStatement(c, stops);
    fail(ctx, line, 'PostgreSQL DO blocks cannot run here: write the statements one by one.');
    return [];
  }
  if (w === 'DELIMITER') {
    collectStatement(c, stops);
    fail(ctx, line, 'DELIMITER is a MySQL client command: end each statement with ;.');
    return [];
  }

  const toks = collectStatement(c, stops);
  if (isP(c.t, ';')) c.i++;
  return sqlNodes(toks, ctx, line);
}

function expectWords(c: Cursor, ctx: Ctx, words: string[]): void {
  for (const w of words) {
    if (c.word() === w) c.i++;
    else {
      fail(ctx, c.line, `Expected ${words.join(' ')} here${c.t ? `, found ${c.t.text}` : ' before the end of the script'}.`);
      return;
    }
  }
  if (isP(c.t, ';')) c.i++;
}

function parseBranch(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>): PlanNode[] {
  // T-SQL: one statement or a BEGIN...END block (BEGIN TRY is a statement too).
  const s = new Set([...stops, 'ELSE']);
  while (isP(c.t, ';')) c.i++;
  if (c.done()) return [];
  return parseStatement(c, ctx, s, false);
}

/** T-SQL IF / WHILE condition: up to the first statement word outside brackets. */
function takeCondition(c: Cursor): Tok[] {
  const start = c.i;
  let depth = 0;
  while (!c.done()) {
    if (isP(c.t, '(')) depth++;
    else if (isP(c.t, ')')) depth--;
    else if (depth === 0 && TSQL_STARTERS.has(c.word()) && c.i > start) break;
    c.i++;
  }
  return c.toks.slice(start, c.i);
}

function isAssignmentSelect(c: Cursor): boolean {
  // SELECT @a = expr [, @b = expr] ...
  const a = c.at(1);
  return a?.kind === 'var' && !a.text.startsWith('@@') && isP(c.at(2), '=');
}

function hasIntoVariable(c: Cursor, ctx: Ctx): boolean {
  let depth = 0;
  for (let k = c.i; k < c.toks.length; k++) {
    const t = c.toks[k]!;
    if (isP(t, ';')) return false;
    if (isP(t, '(')) depth++;
    if (isP(t, ')')) depth--;
    if (depth === 0 && U(t) === 'INTO') {
      const n = c.toks[k + 1];
      return !!n && ((n.kind === 'word' && ctx.declared.has(n.text.toLowerCase())) || n.kind === 'var');
    }
    if (depth === 0 && U(t) === 'FROM') return false;
  }
  return false;
}

// ---- T-SQL variables -------------------------------------------------------------------------
function varName(t: Tok): string {
  return (t.name ?? t.text.replace(/^[@:$]+/, '')).toLowerCase();
}

function parseTsqlDeclare(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>): PlanNode[] {
  const line = c.line;
  c.i++;
  const toks = collectStatement(c, stops);
  const out: PlanNode[] = [];
  for (const part of splitTop(toks, ',')) {
    const v = part[0];
    if (!v || v.kind !== 'var') {
      fail(ctx, line, 'DECLARE names a variable that starts with @.');
      continue;
    }
    const name = varName(v);
    if (U(part[1]) === 'TABLE' || (U(part[1]) === 'AS' && U(part[2]) === 'TABLE')) {
      fail(ctx, line, `Table variables (${v.text} TABLE) cannot run here: use a temporary table (CREATE TABLE #name or SELECT ... INTO #name).`);
      continue;
    }
    if (U(part[1]) === 'CURSOR') {
      fail(ctx, line, 'Cursors cannot run here: write it as one set-based statement.');
      continue;
    }
    ctx.declared.add(name);
    if (/CHAR|TEXT|STRING/i.test(U(part[1]) || part[1]?.text || '')) ctx.textVars.add(name);
    const eq = part.findIndex((t) => isP(t, '='));
    if (eq > 0) out.push({ op: 'declare', name, sql: expr(part.slice(eq + 1), ctx, line), line });
    else out.push({ op: 'declare', name, line });
  }
  return out;
}

function parseTsqlSet(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>): PlanNode[] {
  const line = c.line;
  c.i++;
  const v = c.t!;
  c.i++;
  const op = c.t;
  c.i++;
  const toks = collectStatement(c, stops);
  const name = varName(v);
  if (!ctx.declared.has(name)) ctx.params.set(name, v.text);
  if (op && ['+=', '-=', '*=', '/='].includes(op.text)) {
    return [{ op: 'assign', names: [name], sql: `SELECT @${name} ${op.text[0]} (${toSqliteExpr(toks, ctx, line)})`, mode: 'last', line }];
  }
  if (!isP(op, '=')) {
    fail(ctx, line, `SET ${v.text} needs = and a value.`);
    return [];
  }
  // SET @x = (SELECT ...) is an expression too.
  return [{ op: 'assign', names: [name], sql: expr(toks, ctx, line), mode: 'last', line }];
}

function parseTsqlSelectAssign(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>): PlanNode[] {
  const line = c.line;
  c.i++;
  const toks = collectStatement(c, stops);
  // Split the select list from the rest (FROM ...).
  let depth = 0;
  let fromAt = toks.length;
  for (let k = 0; k < toks.length; k++) {
    if (isP(toks[k], '(')) depth++;
    if (isP(toks[k], ')')) depth--;
    if (depth === 0 && U(toks[k]) === 'FROM') {
      fromAt = k;
      break;
    }
  }
  const names: string[] = [];
  const cols: string[] = [];
  for (const item of splitTop(toks.slice(0, fromAt), ',')) {
    if (item[0]?.kind !== 'var' || !isP(item[1], '=')) {
      fail(ctx, line, 'A SELECT that sets variables sets every item (SELECT @a = x, @b = y).');
      return [];
    }
    const name = varName(item[0]);
    if (!ctx.declared.has(name)) ctx.params.set(name, item[0].text);
    names.push(name);
    cols.push(`${joinSig(item.slice(2))} AS v${cols.length + 1}`);
  }
  const sql = translateStatement(`SELECT ${cols.join(', ')} ${joinSig(toks.slice(fromAt))}`, ctx, line);
  return sql.length === 1 ? [{ op: 'assign', names, sql: sql[0]!.sql, mode: 'last', line }] : [];
}

function raiseNode(toks: Tok[], ctx: Ctx, line: number, how: string): PlanNode {
  const args = splitTop(toks.filter((t, k) => !(k === 0 && isP(t, '(')) && !(k === toks.length - 1 && isP(t, ')') && isP(toks[0], '('))), ',');
  if (args.length === 0 || (args.length === 1 && args[0]!.length === 0)) return { op: 'raise', sql: 'SELECT @error_message', line };
  // THROW number, message, state / RAISERROR(message, severity, state) / RAISE_APPLICATION_ERROR(number, message)
  const msg = how === 'RAISERROR' ? args[0]! : args.length >= 2 ? args[1]! : args[0]!;
  if (how === 'RAISE' && args.length === 1 && args[0]!.length === 1 && args[0]![0]!.kind === 'word') return { op: 'raise', sql: `SELECT '${args[0]![0]!.text.replace(/'/g, "''")}'`, line };
  return { op: 'raise', sql: expr(msg, ctx, line), line };
}

// ---- Oracle PL/SQL ---------------------------------------------------------------------------
function parseOracleBlock(c: Cursor, ctx: Ctx): PlanNode[] {
  const line = c.line;
  const out: PlanNode[] = [];
  if (c.word() === 'DECLARE') {
    c.i++;
    while (!c.done() && c.word() !== 'BEGIN') {
      const dl = c.line;
      const toks = collectStatement(c, new Set(['BEGIN']));
      if (isP(c.t, ';')) c.i++;
      if (toks.length === 0) continue;
      const nameTok = toks[0]!;
      if (U(nameTok) === 'CURSOR' || toks.some((t) => U(t) === 'CURSOR')) {
        fail(ctx, dl, 'Cursors cannot run here: write it as one set-based statement (INSERT ... SELECT, UPDATE ... FROM).');
        continue;
      }
      if (U(nameTok) === 'TYPE' || U(nameTok) === 'PRAGMA') {
        fail(ctx, dl, `${nameTok.text} declarations cannot run here.`);
        continue;
      }
      const name = nameTok.text.toLowerCase();
      if (!NAME_RX.test(name)) {
        fail(ctx, dl, `${nameTok.text} is not a variable name Semaphore can use.`);
        continue;
      }
      ctx.declared.add(name);
      const at = toks.findIndex((t) => isP(t, ':=') || U(t) === 'DEFAULT');
      out.push(at > 0 ? { op: 'declare', name, sql: expr(toks.slice(at + 1), ctx, dl), line: dl } : { op: 'declare', name, line: dl });
    }
  }
  if (c.word() !== 'BEGIN') {
    fail(ctx, c.line, 'A PL/SQL block needs BEGIN.');
    return out;
  }
  c.i++;
  const body = parseBlock(c, ctx, new Set(['END', 'EXCEPTION']));
  let handler: PlanNode[] | null = null;
  if (c.word() === 'EXCEPTION') {
    c.i++;
    const handlers: Array<{ names: string[]; nodes: PlanNode[] }> = [];
    while (c.word() === 'WHEN') {
      c.i++;
      const names: string[] = [];
      while (!c.done() && c.word() !== 'THEN') {
        if (c.t!.kind === 'word' && c.word() !== 'OR') names.push(c.word());
        c.i++;
      }
      c.i++;
      handlers.push({ names, nodes: parseBlock(c, ctx, new Set(['WHEN', 'END'])) });
    }
    const others = handlers.find((h) => h.names.includes('OTHERS'));
    const pick = others ?? handlers[0];
    if (handlers.length > 1 || (pick && !others)) note(ctx, line, 'SQLite does not tell error kinds apart, so the ' + (others ? 'WHEN OTHERS' : `WHEN ${pick?.names.join(' OR ')}`) + ' handler runs for any error in the block.');
    handler = pick?.nodes ?? [];
    note(ctx, line, 'BEGIN...EXCEPTION: the block runs in a savepoint; on an error it is rolled back to that point and the handler runs (SQLERRM and SQLCODE work there).');
  }
  expectWords(c, ctx, ['END']);
  // END label;
  if (c.t?.kind === 'word' && !isP(c.t, ';') && c.t.line === c.at(-1)?.line && !['BEGIN', 'DECLARE'].includes(c.word())) c.i++;
  if (isP(c.t, ';')) c.i++;
  if (handler) out.push({ op: 'try', body, catch: handler, line });
  else out.push(...body);
  return out;
}

function parseOracleIf(c: Cursor, ctx: Ctx): PlanNode[] {
  const line = c.line;
  c.i++;
  const cond = takeUntilWord(c, 'THEN');
  c.i++;
  const thenNodes = parseBlock(c, ctx, new Set(['ELSIF', 'ELSE', 'END']));
  let elseNodes: PlanNode[] = [];
  if (c.word() === 'ELSIF') {
    // ELSIF is an IF inside the ELSE.
    elseNodes = parseOracleIf(c, ctx);
    return [{ op: 'if', cond: condition(cond, ctx, line), then: thenNodes, else: elseNodes, line }];
  }
  if (c.word() === 'ELSE') {
    c.i++;
    elseNodes = parseBlock(c, ctx, new Set(['END']));
  }
  expectWords(c, ctx, ['END', 'IF']);
  return [{ op: 'if', cond: condition(cond, ctx, line), then: thenNodes, else: elseNodes, line }];
}

function takeUntilWord(c: Cursor, word: string): Tok[] {
  const start = c.i;
  let depth = 0;
  while (!c.done()) {
    if (isP(c.t, '(')) depth++;
    else if (isP(c.t, ')')) depth--;
    else if (depth === 0 && c.word() === word) break;
    c.i++;
  }
  return c.toks.slice(start, c.i);
}

function parseOracleLoop(c: Cursor, ctx: Ctx): PlanNode[] {
  const line = c.line;
  const w = c.word();
  const pre: PlanNode[] = [];
  let cond = 'SELECT 1';
  let step: PlanNode[] | undefined;
  if (w === 'WHILE') {
    c.i++;
    cond = condition(takeUntilWord(c, 'LOOP'), ctx, line);
  } else if (w === 'FOR') {
    c.i++;
    const v = c.t!;
    c.i++;
    if (c.word() !== 'IN') {
      fail(ctx, line, 'FOR needs IN a .. b.');
      return [];
    }
    c.i++;
    let reverse = false;
    if (c.word() === 'REVERSE') {
      reverse = true;
      c.i++;
    }
    if (isP(c.t, '(')) {
      takeUntilWord(c, 'LOOP');
      fail(ctx, line, 'A cursor FOR loop (FOR r IN (SELECT ...)) cannot run here: write it as one set-based statement.');
      parseBlock(c, ctx, new Set(['END']));
      expectWords(c, ctx, ['END', 'LOOP']);
      return [];
    }
    const range = takeUntilWord(c, 'LOOP');
    const dots = range.findIndex((t) => isP(t, '..'));
    if (dots < 0) {
      fail(ctx, line, 'FOR needs a range: FOR i IN 1 .. 10 LOOP.');
      return [];
    }
    const name = v.text.toLowerCase();
    ctx.declared.add(name);
    const lo = expr(range.slice(0, dots), ctx, line);
    const hi = toSqliteExpr(range.slice(dots + 1), ctx, line);
    pre.push({ op: 'declare', name, sql: reverse ? `SELECT ${hi}` : lo, line });
    cond = reverse ? `SELECT CASE WHEN @${name} >= (${toSqliteExpr(range.slice(0, dots), ctx, line)}) THEN 1 ELSE 0 END` : `SELECT CASE WHEN @${name} <= (${hi}) THEN 1 ELSE 0 END`;
    step = [{ op: 'assign', names: [name], sql: `SELECT @${name} ${reverse ? '-' : '+'} 1`, mode: 'last', line }];
  }
  if (c.word() === 'LOOP') c.i++;
  const body = parseBlock(c, ctx, new Set(['END']));
  expectWords(c, ctx, ['END', 'LOOP']);
  const loop: PlanNode = step ? { op: 'while', cond, body, step, max: ctx.maxLoop, line } : { op: 'while', cond, body, max: ctx.maxLoop, line };
  return [...pre, loop];
}

function parseOracleSelectInto(c: Cursor, ctx: Ctx, stops: ReadonlySet<string>): PlanNode[] {
  const line = c.line;
  const toks = collectStatement(c, stops);
  let depth = 0;
  let into = -1;
  let from = toks.length;
  for (let k = 0; k < toks.length; k++) {
    if (isP(toks[k], '(')) depth++;
    if (isP(toks[k], ')')) depth--;
    if (depth === 0 && U(toks[k]) === 'INTO' && into < 0) into = k;
    if (depth === 0 && U(toks[k]) === 'FROM' && into >= 0) {
      from = k;
      break;
    }
  }
  const items = splitTop(toks.slice(1, into), ',');
  const names = splitTop(toks.slice(into + 1, from), ',').map((n) => (n[0] ? varName(n[0]) : ''));
  if (items.length !== names.length) {
    fail(ctx, line, 'SELECT ... INTO lists as many variables as columns.');
    return [];
  }
  for (const n of names) ctx.declared.add(n);
  const cols = items.map((it, k) => `${joinSig(it)} AS v${k + 1}`);
  const sql = translateStatement(`SELECT ${cols.join(', ')} ${joinSig(toks.slice(from))}`, ctx, line);
  note(ctx, line, 'SELECT ... INTO variables fails, as in Oracle, unless exactly one row comes back.');
  return sql.length === 1 ? [{ op: 'assign', names, sql: sql[0]!.sql, mode: 'one', line }] : [];
}

// ---- IMPORT INTO -----------------------------------------------------------------------------
function parseImport(c: Cursor, ctx: Ctx, top: boolean, stops: ReadonlySet<string>): PlanNode[] {
  const line = c.line;
  const toks = collectStatement(c, stops);
  if (!top) fail(ctx, line, 'IMPORT INTO runs only at the top of a script, not inside IF, a loop or a TRY block.');
  if (isP(c.t, ';')) c.i++;
  // IMPORT INTO table [REPLACE|APPEND] FROM SOURCE id AS ( SELECT ... )
  const tableTok = toks[2];
  let k = 3;
  let mode: 'replace' | 'append' = 'replace';
  if (U(toks[k]) === 'REPLACE' || U(toks[k]) === 'APPEND') {
    mode = U(toks[k]) === 'APPEND' ? 'append' : 'replace';
    k++;
  }
  const table = tableTok?.kind === 'ident' ? (tableTok.name ?? '') : (tableTok?.text ?? '');
  if (U(toks[k]) !== 'FROM' || U(toks[k + 1]) !== 'SOURCE' || !toks[k + 2] || U(toks[k + 3]) !== 'AS' || !isP(toks[k + 4], '(') || !isP(toks[toks.length - 1], ')')) {
    fail(ctx, line, 'Write it as IMPORT INTO table [REPLACE | APPEND] FROM SOURCE source_id AS (SELECT ...).');
    return [];
  }
  const srcTok = toks[k + 2]!;
  const source = srcTok.kind === 'ident' ? (srcTok.name ?? '') : srcTok.kind === 'string' ? srcTok.text.slice(1, -1) : srcTok.text;
  if (!NAME_RX.test(table) || /^(sqlite_|_semaphore)/i.test(table)) fail(ctx, line, 'IMPORT INTO needs a table name of letters, digits and _ (not starting with sqlite_ or _semaphore).');
  if (source === 'local') fail(ctx, line, 'IMPORT INTO reads from a live source; the local database is already here (use INSERT ... SELECT).');
  const dialect = ctx.sources[source];
  if (!dialect && source !== 'local') fail(ctx, line, `There is no source "${source}" on this server.`);
  const inner = toks.slice(k + 5, toks.length - 1);
  if (U(inner[0]) !== 'SELECT' && U(inner[0]) !== 'WITH') fail(ctx, line, 'IMPORT INTO ... AS ( ) holds one SELECT: live databases stay read-only.');
  const written = joinSig(inner);
  const sql = dialect ? translateSql(written, ctx.from, dialect) : { sql: written, notes: [] };
  for (const n of sql.notes) note(ctx, line, n);
  note(ctx, line, `IMPORT INTO runs the SELECT on ${source} through the normal read-only query path and ${mode === 'append' ? 'appends the rows to' : 'swaps the rows in as'} ${table}; what came before it in the script is committed first.`);
  return [{ op: 'import', table, source, sql: sql.sql, mode, line }];
}

// ---------------------------------------------------------------------------------------------
// Expressions and statements
// ---------------------------------------------------------------------------------------------
function splitTop(toks: readonly Tok[], sep: string): Tok[][] {
  const out: Tok[][] = [[]];
  let depth = 0;
  let caseDepth = 0;
  for (const t of toks) {
    if (isP(t, '(')) depth++;
    if (isP(t, ')')) depth--;
    if (U(t) === 'CASE') caseDepth++;
    if (U(t) === 'END' && caseDepth > 0) caseDepth--;
    if (depth === 0 && caseDepth === 0 && isP(t, sep)) {
      out.push([]);
      continue;
    }
    out[out.length - 1]!.push(t);
  }
  return out.filter((p, i) => p.length > 0 || i < out.length - 1);
}

/** Replaces variables (T-SQL @v, Oracle declared names and :bind) with @name, and the error functions. */
function bindVariables(toks: Tok[], ctx: Ctx): Tok[] {
  const out: Tok[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    const prev = out[out.length - 1];
    if (t.kind === 'var') {
      if (t.text.startsWith('@@')) {
        const sys = t.name!.toUpperCase();
        const map: Record<string, string> = { ROWCOUNT: 'changes()', ERROR: '@error_number', IDENTITY: 'last_insert_rowid()', FETCH_STATUS: '0' };
        if (map[sys]) out.push({ ...t, kind: 'word', text: map[sys]! });
        else {
          fail(ctx, t.line, `${t.text} has no meaning in the local database.`);
          out.push(t);
        }
        continue;
      }
      const name = varName(t);
      if (!NAME_RX.test(name)) fail(ctx, t.line, `${t.text} is not a variable name Semaphore can use.`);
      if (!ctx.declared.has(name)) ctx.params.set(name, t.text);
      out.push({ ...t, text: `@${name}` });
      continue;
    }
    if (t.kind === 'word') {
      const up = t.text.toUpperCase();
      const nextTok = toks[k + 1];
      const call = isP(nextTok, '(') && isP(toks[k + 2], ')');
      if (call && (up === 'ERROR_MESSAGE' || up === 'ERROR_NUMBER' || up === 'SCOPE_IDENTITY' || up === 'ERROR_LINE' || up === 'ERROR_SEVERITY' || up === 'ERROR_STATE')) {
        out.push({ ...t, text: up === 'ERROR_MESSAGE' ? '@error_message' : up === 'SCOPE_IDENTITY' ? 'last_insert_rowid()' : up === 'ERROR_NUMBER' ? '@error_number' : 'NULL' });
        k += 2;
        continue;
      }
      if (ctx.from === 'oracle' && (up === 'SQLERRM' || up === 'SQLCODE') && !isP(nextTok, '(')) {
        out.push({ ...t, text: up === 'SQLERRM' ? '@error_message' : '@error_number' });
        continue;
      }
      if (ctx.from === 'oracle' && ctx.declared.has(t.text.toLowerCase()) && !isP(prev, '.') && !isP(nextTok, '.') && !isP(nextTok, '(')) {
        out.push({ ...t, text: `@${t.text.toLowerCase()}` });
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

/** An expression as a scalar SELECT, in SQLite. */
function expr(toks: Tok[], ctx: Ctx, line: number): string {
  const inner = toSqliteExpr(toks, ctx, line);
  return `SELECT ${inner}`;
}

function toSqliteExpr(toks: Tok[], ctx: Ctx, line: number): string {
  const r = translateTokens(bindVariables(toks, ctx), ctx, line);
  const t = translateSql(`SELECT ${r}`, ctx.from, 'sqlite');
  for (const n of t.notes) note(ctx, line, n);
  return t.sql.replace(/^SELECT\s+/i, '').trim();
}

/** A T-SQL / Oracle condition as SELECT CASE WHEN (...) THEN 1 ELSE 0 END. */
function condition(toks: Tok[], ctx: Ctx, line: number): string {
  if (toks.length === 0) {
    fail(ctx, line, 'The condition is empty.');
    return 'SELECT 0';
  }
  return `SELECT CASE WHEN (${toSqliteExpr(toks, ctx, line)}) THEN 1 ELSE 0 END`;
}

const DDL = new Set(['CREATE', 'DROP', 'ALTER']);

function kindOf(sql: string): StatementKind {
  const words = sql.toUpperCase().match(/[A-Z_]+/g) ?? [];
  const first = words[0] ?? '';
  if (DDL.has(first)) return 'ddl';
  if (first === 'SELECT' || first === 'VALUES' || first === 'EXPLAIN' || first === 'PRAGMA') return 'select';
  if (first === 'WITH') {
    // The main statement of a CTE: the first DML word outside the CTE bodies.
    let depth = 0;
    const toks = sql.split(/(\(|\)|\s+)/);
    for (const p of toks) {
      if (p === '(') depth++;
      else if (p === ')') depth--;
      else if (depth === 0 && /^(INSERT|UPDATE|DELETE|REPLACE)$/i.test(p)) return 'write';
      else if (depth === 0 && /^SELECT$/i.test(p)) return 'select';
    }
    return 'select';
  }
  return 'write';
}

/** One written statement as plan nodes (MERGE and CREATE OR REPLACE become several). */
function sqlNodes(toks: Tok[], ctx: Ctx, line: number): PlanNode[] {
  if (toks.length === 0) return [];
  const bound = bindVariables(toks, ctx);
  const text = joinSigText(bound);
  return translateStatement(text, ctx, line, bound).map((s) => ({ op: 'sql' as const, sql: s.sql, line, kind: kindOf(s.sql) }));
}

function joinSigText(toks: Tok[]): string {
  return joinSig(toks, true).trim();
}

/** Translates one statement's text into SQLite statements, with refusals checked. */
function translateStatement(text: string, ctx: Ctx, line: number, pre?: Tok[]): Array<{ sql: string }> {
  const toks = pre ?? bindVariables(sigOf(tokenizeScript(text, ctx.from)), ctx);
  const first = U(toks[0]);
  let parts: string[];
  if (first === 'MERGE') parts = mergeToSqlite(toks, ctx, line);
  else parts = [translateTokens(toks, ctx, line)];
  // CREATE OR REPLACE / CREATE OR ALTER: drop first.
  parts = parts.flatMap((p) => {
    const m = /^CREATE\s+OR\s+(?:REPLACE|ALTER)\s+(VIEW|TABLE)\s+((?:"[^"]+"|[A-Za-z_][\w$#]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$#]*))?)/i.exec(p);
    if (!m) return [p];
    note(ctx, line, `CREATE OR ${/ALTER/i.test(p.slice(0, 20)) ? 'ALTER' : 'REPLACE'} ${m[1]!.toUpperCase()} became DROP ${m[1]!.toUpperCase()} IF EXISTS then CREATE ${m[1]!.toUpperCase()}.`);
    return [`DROP ${m[1]!.toUpperCase()} IF EXISTS ${m[2]}`, p.replace(/^CREATE\s+OR\s+(?:REPLACE|ALTER)\s+/i, 'CREATE ')];
  });
  const out: Array<{ sql: string }> = [];
  for (const p of parts) {
    const t = translateSql(p, ctx.from, 'sqlite');
    for (const n of t.notes) note(ctx, line, n);
    const sql = t.sql.trim().replace(/;\s*$/, '');
    const why = refusal(sql);
    if (why) fail(ctx, line, why);
    out.push({ sql });
  }
  return out;
}

// ---- token rewrites before translateSql -----------------------------------------------------
const tok = (text: string, kind: Kind = 'word', line = 0): Tok => ({ kind, text, line });

/** T-SQL and Oracle forms SQLite lacks, rewritten in tokens; then joined to text. */
function translateTokens(input: Tok[], ctx: Ctx, line: number): string {
  let toks = [...input];
  const from = ctx.from;
  const tsql = tsqlLike(from);
  const ora = from === 'oracle';

  // PIVOT / UNPIVOT
  toks = pivotToSqlite(toks, ctx, line);

  // SELECT ... INTO new_table FROM ...  ->  CREATE TABLE new_table AS SELECT ... FROM ...
  if ((tsql || from === 'access' || from === 'postgres') && U(toks[0]) === 'SELECT') {
    let depth = 0;
    for (let k = 1; k < toks.length; k++) {
      if (isP(toks[k], '(')) depth++;
      if (isP(toks[k], ')')) depth--;
      if (depth === 0 && U(toks[k]) === 'INTO') {
        const target = toks[k + 1];
        if (target) {
          const temp = target.kind === 'word' && target.text.startsWith('#');
          toks.splice(k, 2);
          toks.unshift(tok('CREATE'), tok(temp ? 'TEMP' : 'TABLE'), ...(temp ? [tok('TABLE')] : []), target, tok('AS'));
          note(ctx, line, 'SELECT ... INTO a new table became CREATE TABLE ... AS SELECT.');
        }
        break;
      }
      if (depth === 0 && U(toks[k]) === 'FROM') break;
    }
  }

  const out: Tok[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    const up = U(t);
    const n1 = toks[k + 1];
    // #temp tables: plain names, created as TEMP tables.
    if (t.kind === 'word' && t.text.startsWith('#')) {
      const name = t.text.replace(/^#+/, '');
      ctx.temps.add(name.toLowerCase());
      if (U(out[out.length - 1]) === 'TABLE' && U(out[out.length - 2]) === 'CREATE') out.splice(out.length - 1, 0, tok('TEMP'));
      out.push({ ...t, text: name });
      continue;
    }
    // TOP (n) -> TOP n, and TOP n inside brackets becomes LIMIT n at that level.
    if (up === 'TOP' && (tsql || from === 'access')) {
      let n: Tok | undefined;
      let skip = 0;
      if (isP(n1, '(') && toks[k + 2]?.kind === 'number' && isP(toks[k + 3], ')')) {
        n = toks[k + 2];
        skip = 3;
      } else if (n1?.kind === 'number') {
        n = n1;
        skip = 1;
      }
      if (n) {
        if (U(toks[k + skip + 1]) === 'PERCENT') {
          fail(ctx, line, 'TOP ... PERCENT has no SQLite form: compute the row count first.');
        }
        // Find the close of this SELECT's level.
        let depth = 0;
        let end = toks.length;
        for (let j = k + skip + 1; j < toks.length; j++) {
          if (isP(toks[j], '(')) depth++;
          if (isP(toks[j], ')')) {
            if (depth === 0) {
              end = j;
              break;
            }
            depth--;
          }
        }
        toks.splice(end, 0, tok('LIMIT'), n);
        k += skip;
        continue;
      }
    }
    // Schema dbo. (SQL Server's default) has no meaning in SQLite.
    if (tsql && (up === 'DBO' || (t.kind === 'ident' && t.name?.toLowerCase() === 'dbo')) && isP(n1, '.')) {
      k++;
      continue;
    }
    // TRUNCATE TABLE t -> DELETE FROM t
    if (up === 'TRUNCATE' && U(n1) === 'TABLE') {
      out.push(tok('DELETE'), tok('FROM'));
      k++;
      note(ctx, line, 'TRUNCATE TABLE became DELETE FROM.');
      continue;
    }
    // IDENTITY(1,1) -> nothing (INTEGER PRIMARY KEY numbers rows itself)
    if (up === 'IDENTITY' && isP(n1, '(')) {
      let j = k + 1;
      while (j < toks.length && !isP(toks[j], ')')) j++;
      k = j;
      const prevType = out[out.length - 1];
      if (prevType && /^(INT|BIGINT|SMALLINT|INTEGER)$/i.test(prevType.text)) prevType.text = 'INTEGER';
      note(ctx, line, 'IDENTITY was left out: a column declared INTEGER PRIMARY KEY numbers new rows itself in SQLite.');
      continue;
    }
    // (MAX) in a type, and Oracle's (n CHAR) / (n BYTE)
    if (isP(t, '(') && U(n1) === 'MAX' && isP(toks[k + 2], ')')) {
      k += 2;
      continue;
    }
    if (ora && t.kind === 'number' && (U(n1) === 'CHAR' || U(n1) === 'BYTE') && isP(toks[k + 2], ')')) {
      out.push(t);
      k++;
      continue;
    }
    if ((tsql && up === 'BIT') || (ora && up === 'BOOLEAN')) {
      out.push({ ...t, text: 'BOOLEAN' });
      continue;
    }
    if (ora && up === 'GLOBAL' && U(n1) === 'TEMPORARY') {
      out.push(tok('TEMP'));
      k++;
      continue;
    }
    if (ora && up === 'ON' && U(n1) === 'COMMIT' && (U(toks[k + 2]) === 'PRESERVE' || U(toks[k + 2]) === 'DELETE') && U(toks[k + 3]) === 'ROWS') {
      k += 3;
      continue;
    }
    if (ora && up === 'FROM' && U(n1) === 'DUAL') {
      k++;
      continue;
    }
    // DATE 'x' and TIMESTAMP 'x' literals are plain text in SQLite.
    if ((up === 'DATE' || up === 'TIMESTAMP') && n1?.kind === 'string') continue;
    if (up === 'ILIKE') {
      out.push({ ...t, text: 'LIKE' });
      note(ctx, line, 'ILIKE became LIKE: SQLite compares ASCII letters without case in LIKE.');
      continue;
    }
    if (up === 'NEWID' && isP(n1, '(') && isP(toks[k + 2], ')')) {
      out.push(tok('lower(hex(randomblob(16)))'));
      k += 2;
      continue;
    }
    if (up === 'OBJECT_ID' && isP(n1, '(') && toks[k + 2]?.kind === 'string') {
      const raw = toks[k + 2]!.text.slice(1, -1).replace(/''/g, "'");
      const name = raw.replace(/^tempdb\.\./i, '').replace(/^(\[?dbo\]?\.)/i, '').replace(/^#+/, '').replace(/[[\]"]/g, '');
      let j = k + 3;
      while (j < toks.length && !isP(toks[j], ')')) j++;
      out.push(tok(`(SELECT 1 FROM (SELECT name FROM sqlite_master UNION ALL SELECT name FROM sqlite_temp_master) WHERE name = '${name.replace(/'/g, "''")}' COLLATE NOCASE)`));
      k = j;
      continue;
    }
    if (ora && up === 'TO_DATE' && isP(n1, '(') && toks[k + 2]?.kind === 'string' && isP(toks[k + 3], ',') && toks[k + 4]?.kind === 'string' && isP(toks[k + 5], ')') && /^'yyyy-mm-dd'$/i.test(toks[k + 4]!.text)) {
      out.push(toks[k + 2]!);
      k += 5;
      continue;
    }
    if (ora && up === 'NVL2' && isP(n1, '(')) {
      const args = callArgs(toks, k + 1);
      if (args && args.args.length === 3) {
        out.push(tok(`CASE WHEN (${joinSig(args.args[0]!)}) IS NOT NULL THEN ${joinSig(args.args[1]!)} ELSE ${joinSig(args.args[2]!)} END`));
        k = args.close;
        continue;
      }
    }
    if ((up === 'DATEADD' || up === 'DATEDIFF') && isP(n1, '(')) {
      const args = callArgs(toks, k + 1);
      const unit = args?.args[0]?.length === 1 ? args.args[0]![0]!.text.replace(/'/g, '').toLowerCase() : '';
      const units: Record<string, string> = { day: 'day', dd: 'day', d: 'day', hour: 'hour', hh: 'hour', minute: 'minute', mi: 'minute', n: 'minute', second: 'second', ss: 'second', s: 'second', month: 'month', mm: 'month', m: 'month', year: 'year', yy: 'year', yyyy: 'year' };
      const u = units[unit];
      if (args && args.args.length === 3 && u) {
        const a = joinSig(args.args[1]!);
        const b = joinSig(args.args[2]!);
        if (up === 'DATEADD') out.push(tok(`datetime(${b}, printf('%+d ${u}', ${a}))`));
        else if (u === 'month' || u === 'year') out.push(tok(`((CAST(strftime('%Y', ${b}) AS INTEGER) - CAST(strftime('%Y', ${a}) AS INTEGER))${u === 'month' ? ` * 12 + CAST(strftime('%m', ${b}) AS INTEGER) - CAST(strftime('%m', ${a}) AS INTEGER)` : ''})`));
        else if (u === 'day') out.push(tok(`CAST(julianday(date(${b})) - julianday(date(${a})) AS INTEGER)`));
        else out.push(tok(`CAST(ROUND((julianday(${b}) - julianday(${a}))${u === 'hour' ? ' * 24' : u === 'minute' ? ' * 1440' : ' * 86400'}) AS INTEGER)`));
        note(ctx, line, `${up} became SQLite date arithmetic (${up === 'DATEADD' ? 'datetime with a modifier' : 'julianday differences'}).`);
        k = args.close;
        continue;
      }
    }
    // MySQL ON DUPLICATE KEY UPDATE a = VALUES(a)
    if (from === 'mysql' && up === 'ON' && U(n1) === 'DUPLICATE' && U(toks[k + 2]) === 'KEY' && U(toks[k + 3]) === 'UPDATE') {
      out.push(tok('ON'), tok('CONFLICT'), tok('DO'), tok('UPDATE'), tok('SET'));
      k += 3;
      note(ctx, line, 'ON DUPLICATE KEY UPDATE became ON CONFLICT DO UPDATE: the table needs a PRIMARY KEY or UNIQUE index; an INSERT ... SELECT needs WHERE true before it.');
      continue;
    }
    if (from === 'mysql' && up === 'VALUES' && isP(n1, '(') && toks[k + 2]?.kind !== 'number' && isP(toks[k + 3], ')') && out.some((x) => U(x) === 'CONFLICT')) {
      out.push(tok(`excluded.${toks[k + 2]!.text}`));
      k += 3;
      continue;
    }
    // T-SQL joins text with +: next to a text literal or a text variable it becomes ||.
    if (tsql && isP(t, '+')) {
      const isText = (x: Tok | undefined) => !!x && (x.kind === 'string' || (x.kind === 'var' && ctx.textVars.has(varName(x))));
      if (isText(out[out.length - 1]) || isText(n1)) {
        out.push({ ...t, text: '||' });
        continue;
      }
    }
    if (up === 'SYSDATE' || up === 'SYSTIMESTAMP' || up === 'GETUTCDATE' || up === 'SYSUTCDATETIME') {
      if (isP(n1, '(') && isP(toks[k + 2], ')')) k += 2;
      out.push(tok('CURRENT_TIMESTAMP'));
      continue;
    }
    if ((up === 'GETDATE' || up === 'NOW' || up === 'SYSDATETIME') && isP(n1, '(')) note(ctx, line, 'The current time is UTC in SQLite (CURRENT_TIMESTAMP); use datetime(\'now\', \'localtime\') for local time.');
    if (up === 'NEXTVAL' || up === 'CURRVAL') fail(ctx, line, 'Sequences do not exist in the local database: an INTEGER PRIMARY KEY numbers new rows itself.');
    if (ora && up === 'ROWNUM') note(ctx, line, 'ROWNUM became nothing SQLite knows: use LIMIT or ROW_NUMBER() OVER (...).');
    out.push(t);
  }
  if (ora && U(out[0]) === 'INSERT' && U(out[1]) === 'ALL') fail(ctx, line, 'INSERT ALL cannot run here: write one INSERT per table.');
  if (tsql && U(out[0]) === 'UPDATE' && out.some((x) => U(x) === 'FROM')) note(ctx, line, 'UPDATE ... FROM runs as SQLite\'s UPDATE ... FROM: the table being updated must not be listed again in FROM.');
  return joinSigText(out);
}

function callArgs(toks: readonly Tok[], open: number): { close: number; args: Tok[][] } | null {
  let depth = 0;
  const args: Tok[][] = [[]];
  for (let j = open; j < toks.length; j++) {
    const t = toks[j]!;
    if (isP(t, '(')) {
      depth++;
      if (depth === 1) continue;
    } else if (isP(t, ')')) {
      depth--;
      if (depth === 0) return { close: j, args };
    } else if (isP(t, ',') && depth === 1) {
      args.push([]);
      continue;
    }
    args[args.length - 1]!.push(t);
  }
  return null;
}

// ---- MERGE -----------------------------------------------------------------------------------
function nameText(t: Tok | undefined): string {
  if (!t) return '';
  return t.kind === 'ident' ? `"${(t.name ?? '').replace(/"/g, '""')}"` : t.text.replace(/^#+/, '');
}

function mergeToSqlite(toks: Tok[], ctx: Ctx, line: number): string[] {
  // MERGE [INTO] target [[AS] t] USING source [[AS] s] ON cond WHEN ...
  let k = 1;
  if (U(toks[k]) === 'INTO') k++;
  // target may be schema.table
  let target = nameText(toks[k]);
  k++;
  while (isP(toks[k], '.')) {
    if (!(tsqlLike(ctx.from) && /^"?dbo"?$/i.test(target))) target += '.';
    else target = '';
    target += nameText(toks[k + 1]);
    k += 2;
  }
  let tAlias = target;
  if (U(toks[k]) === 'AS') k++;
  if (toks[k] && U(toks[k]) !== 'USING') {
    tAlias = nameText(toks[k]);
    k++;
  }
  if (U(toks[k]) !== 'USING') {
    fail(ctx, line, 'MERGE needs USING source ON condition.');
    return [];
  }
  k++;
  // source: a name or a bracketed subquery
  let source = '';
  if (isP(toks[k], '(')) {
    const close = matching(toks, k);
    source = `(${translateTokens(toks.slice(k + 1, close), ctx, line)})`;
    k = close + 1;
  } else {
    source = nameText(toks[k]);
    k++;
    while (isP(toks[k], '.')) {
      source = tsqlLike(ctx.from) && /^"?dbo"?$/i.test(source) ? nameText(toks[k + 1]) : `${source}.${nameText(toks[k + 1])}`;
      k += 2;
    }
  }
  let sAlias = source.startsWith('(') ? 's' : source;
  if (U(toks[k]) === 'AS') k++;
  if (toks[k] && U(toks[k]) !== 'ON') {
    sAlias = nameText(toks[k]);
    k++;
  }
  if (U(toks[k]) !== 'ON') {
    fail(ctx, line, 'MERGE needs ON condition after the source.');
    return [];
  }
  k++;
  const onStart = k;
  let depth = 0;
  while (k < toks.length && !(depth === 0 && U(toks[k]) === 'WHEN')) {
    if (isP(toks[k], '(')) depth++;
    if (isP(toks[k], ')')) depth--;
    k++;
  }
  let on = translateTokens(toks.slice(onStart, k), ctx, line);
  if (/^\(.*\)$/s.test(on)) on = on.slice(1, -1).trim();
  // WHEN clauses
  interface When {
    matched: boolean;
    bySource: boolean;
    cond: string;
    action: 'UPDATE' | 'DELETE' | 'INSERT';
    body: Tok[];
  }
  const whens: When[] = [];
  while (U(toks[k]) === 'WHEN') {
    k++;
    let matched = true;
    let bySource = false;
    if (U(toks[k]) === 'NOT') {
      matched = false;
      k++;
    }
    k++; // MATCHED
    if (U(toks[k]) === 'BY') {
      bySource = U(toks[k + 1]) === 'SOURCE';
      k += 2;
    }
    let cond = '';
    if (U(toks[k]) === 'AND') {
      const cs = ++k;
      while (k < toks.length && U(toks[k]) !== 'THEN') k++;
      cond = translateTokens(toks.slice(cs, k), ctx, line);
    }
    k++; // THEN
    const action = U(toks[k]) as When['action'];
    k++;
    const bs = k;
    depth = 0;
    while (k < toks.length && !(depth === 0 && U(toks[k]) === 'WHEN')) {
      if (isP(toks[k], '(')) depth++;
      if (isP(toks[k], ')')) depth--;
      k++;
    }
    whens.push({ matched, bySource, cond, action, body: toks.slice(bs, k).filter((t) => !isP(t, ';')) });
  }
  const tgt = `${target}${tAlias !== target ? ` AS ${tAlias}` : ''}`;
  const src = `${source} AS ${sAlias}`;
  // The source rows with no match are taken first, so the UPDATE and DELETE below cannot change which rows
  // MERGE inserts, and the inserted rows are never updated or deleted by the same MERGE.
  const snap = `sem_merge_${line}`;
  const out: string[] = [];
  const inserts: string[] = [];
  const later: string[] = [];
  for (const w of whens) {
    if (w.matched && w.action === 'UPDATE') {
      // SET t.a = s.a  ->  SET a = s.a   (SQLite names the column alone)
      const body = w.body.slice(1); // after SET
      let oraDelete: Tok[] | null = null;
      let where: Tok[] = [];
      const di = body.findIndex((t, i) => U(t) === 'DELETE' && U(body[i + 1]) === 'WHERE');
      let setPart = di >= 0 ? body.slice(0, di) : body;
      if (di >= 0) oraDelete = body.slice(di + 2);
      const wi = setPart.findIndex((t) => U(t) === 'WHERE');
      if (wi >= 0) {
        where = setPart.slice(wi + 1);
        setPart = setPart.slice(0, wi);
      }
      const sets = splitTop(setPart, ',').map((a) => {
        const eq = a.findIndex((t) => isP(t, '='));
        const left = a.slice(0, eq);
        const col = left[left.length - 1];
        return `${nameText(col)} = ${translateTokens(a.slice(eq + 1), ctx, line)}`;
      });
      const conds = [on, w.cond, where.length ? translateTokens(where, ctx, line) : ''].filter(Boolean).map((x) => `(${x})`);
      out.push(`UPDATE ${tgt} SET ${sets.join(', ')} FROM ${src} WHERE ${conds.join(' AND ')}`);
      if (oraDelete) out.push(`DELETE FROM ${tgt} WHERE EXISTS (SELECT 1 FROM ${src} WHERE (${on})) AND (${translateTokens(oraDelete, ctx, line)})`);
    } else if (w.matched && w.action === 'DELETE' && !w.bySource) {
      out.push(`DELETE FROM ${tgt} WHERE EXISTS (SELECT 1 FROM ${src} WHERE (${on})${w.cond ? ` AND (${w.cond})` : ''})`);
    } else if (!w.matched && !w.bySource && w.action === 'INSERT') {
      // INSERT (cols) VALUES (exprs)
      let b = w.body;
      let cols = '';
      if (isP(b[0], '(')) {
        const close = matching(b, 0);
        cols = `(${splitTop(b.slice(1, close), ',').map((x) => nameText(x[x.length - 1])).join(', ')})`;
        b = b.slice(close + 1);
      }
      let values = '';
      if (U(b[0]) === 'VALUES' && isP(b[1], '(')) {
        const close = matching(b, 1);
        values = translateTokens(b.slice(2, close), ctx, line);
        const rest = b.slice(close + 1);
        const wi = rest.findIndex((t) => U(t) === 'WHERE');
        if (wi >= 0) w.cond = [w.cond, translateTokens(rest.slice(wi + 1), ctx, line)].filter(Boolean).join(') AND (');
      } else {
        fail(ctx, line, 'WHEN NOT MATCHED THEN INSERT needs VALUES (...).');
        continue;
      }
      inserts.push(`INSERT INTO ${target} ${cols} SELECT ${values} FROM ${snap} AS ${sAlias}${w.cond ? ` WHERE (${w.cond})` : ''}`.replace(/  +/g, ' '));
    } else if (!w.matched && w.bySource && w.action === 'UPDATE') {
      const sets = splitTop(w.body.slice(1), ',').map((a) => {
        const eq = a.findIndex((t) => isP(t, '='));
        return `${nameText(a[eq - 1])} = ${translateTokens(a.slice(eq + 1), ctx, line)}`;
      });
      later.push(`UPDATE ${tgt} SET ${sets.join(', ')} WHERE NOT EXISTS (SELECT 1 FROM ${src} WHERE (${on}))${w.cond ? ` AND (${w.cond})` : ''}`);
    } else if (!w.matched && w.bySource && w.action === 'DELETE') {
      later.push(`DELETE FROM ${tgt} WHERE NOT EXISTS (SELECT 1 FROM ${src} WHERE (${on}))${w.cond ? ` AND (${w.cond})` : ''}`);
    } else fail(ctx, line, `MERGE WHEN ${w.matched ? '' : 'NOT '}MATCHED THEN ${w.action} has no SQLite form.`);
  }
  if (out.length + inserts.length + later.length === 0) fail(ctx, line, 'MERGE needs at least one WHEN ... THEN clause.');
  const steps = [...out, ...inserts, ...later];
  note(ctx, line, `MERGE became ${steps.map((x) => x.split(' ')[0]).join(', then ')}: the source rows with no match are set aside first, matched rows are updated (or deleted), the set-aside rows are inserted${later.length ? ', then target rows with no source row are handled' : ''}, all in the script's transaction.`);
  if (inserts.length === 0) return steps;
  return [`DROP TABLE IF EXISTS temp.${snap}`, `CREATE TEMP TABLE ${snap} AS SELECT * FROM ${src} WHERE NOT EXISTS (SELECT 1 FROM ${tgt} WHERE (${on}))`, ...steps, `DROP TABLE temp.${snap}`];
}

function matching(toks: readonly Tok[], open: number): number {
  let depth = 0;
  for (let j = open; j < toks.length; j++) {
    if (isP(toks[j], '(')) depth++;
    if (isP(toks[j], ')')) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return toks.length - 1;
}

// ---- PIVOT / UNPIVOT -------------------------------------------------------------------------
function pivotToSqlite(toks: Tok[], ctx: Ctx, line: number): Tok[] {
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    if (isP(toks[k], '(')) depth++;
    if (isP(toks[k], ')')) depth--;
    const w = U(toks[k]);
    if ((w === 'PIVOT' || w === 'UNPIVOT') && (isP(toks[k + 1], '(') || (w === 'UNPIVOT' && (U(toks[k + 1]) === 'INCLUDE' || U(toks[k + 1]) === 'EXCLUDE')))) {
      const r = w === 'PIVOT' ? rewritePivot(toks, k, ctx, line) : rewriteUnpivot(toks, k, ctx, line);
      if (!r) return toks;
      return pivotToSqlite(r, ctx, line);
    }
  }
  return toks;
}

/** Index of FROM that owns the PIVOT at `at`, and the SELECT list before it. */
function pivotFrame(toks: Tok[], at: number): { selectAt: number; fromAt: number } | null {
  // Walk back at the same depth to FROM, then to SELECT.
  let depth = 0;
  let fromAt = -1;
  for (let j = at - 1; j >= 0; j--) {
    if (isP(toks[j], ')')) depth++;
    if (isP(toks[j], '(')) {
      if (depth === 0) return null;
      depth--;
    }
    if (depth === 0 && U(toks[j]) === 'FROM' && fromAt < 0) fromAt = j;
    if (depth === 0 && U(toks[j]) === 'SELECT' && fromAt >= 0) return { selectAt: j, fromAt };
  }
  return null;
}

function literalFor(t: Tok): { value: string; name: string } {
  if (t.kind === 'string') return { value: t.text, name: t.text.slice(1, -1).replace(/''/g, "'") };
  if (t.kind === 'number') return { value: t.text, name: t.text };
  const name = t.kind === 'ident' ? (t.name ?? '') : t.text;
  return { value: /^-?\d+(\.\d+)?$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`, name };
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function rewritePivot(toks: Tok[], at: number, ctx: Ctx, line: number): Tok[] | null {
  const frame = pivotFrame(toks, at);
  const close = matching(toks, at + 1);
  const inner = toks.slice(at + 2, close);
  const forAt = inner.findIndex((t) => U(t) === 'FOR');
  const inAt = inner.findIndex((t, i) => i > forAt && U(t) === 'IN');
  if (!frame || forAt < 0 || inAt < 0) {
    fail(ctx, line, 'PIVOT needs the form PIVOT (aggregate(column) FOR column IN (values)).');
    return null;
  }
  const aggs = splitTop(inner.slice(0, forAt), ',');
  if (aggs.length !== 1) {
    fail(ctx, line, 'PIVOT with more than one aggregate cannot be translated: write one CASE aggregate per column.');
    return null;
  }
  const agg = aggs[0]!;
  const fn = U(agg[0]);
  const aggOpen = agg.findIndex((t) => isP(t, '('));
  const aggArg = agg.slice(aggOpen + 1, matching(agg, aggOpen));
  const pivotCol = joinSig(inner.slice(forAt + 1, inAt));
  const listOpen = inAt + 1;
  const values = splitTop(inner.slice(listOpen + 1, matching(inner, listOpen)), ',').map((v) => {
    const lit = literalFor(v[0]!);
    const asAt = v.findIndex((t) => U(t) === 'AS');
    const alias = asAt >= 0 ? (v[asAt + 1]?.kind === 'ident' ? (v[asAt + 1]!.name ?? '') : (v[asAt + 1]?.text ?? '')) : lit.name;
    return { value: lit.value, alias };
  });
  // Alias of the pivoted result: PIVOT (...) [AS] p
  let after = close + 1;
  let alias = 'p';
  if (U(toks[after]) === 'AS') after++;
  if (toks[after] && (toks[after]!.kind === 'word' || toks[after]!.kind === 'ident') && !['WHERE', 'ORDER', 'GROUP', 'UNION', 'HAVING', 'LIMIT'].includes(U(toks[after]))) {
    alias = nameText(toks[after]);
    after++;
  }
  // Source: between FROM and PIVOT, with an optional alias.
  const srcToks = toks.slice(frame.fromAt + 1, at);
  // Group columns: the outer SELECT list minus the pivoted values; or the inner subquery's columns.
  const outer = splitTop(toks.slice(frame.selectAt + 1, frame.fromAt), ',');
  const valueNames = new Set(values.map((v) => v.alias.toLowerCase()));
  const argName = joinSig(aggArg).replace(/^.*\./, '').replace(/"/g, '').toLowerCase();
  const pivotName = pivotCol.replace(/^.*\./, '').replace(/[[\]"]/g, '').toLowerCase();
  let group: string[] = [];
  const isStar = outer.length === 1 && outer[0]!.length === 1 && isP(outer[0]![0], '*');
  if (!isStar) {
    group = outer.map((o) => o[o.length - 1]!).filter((t) => !valueNames.has((t.kind === 'ident' ? (t.name ?? '') : t.text).toLowerCase())).map((t) => nameText(t));
  } else if (isP(srcToks[0], '(') && U(srcToks[1]) === 'SELECT') {
    const sc = matching(srcToks, 0);
    const sub = srcToks.slice(2, sc);
    let d = 0;
    let fa = sub.length;
    for (let j = 0; j < sub.length; j++) {
      if (isP(sub[j], '(')) d++;
      if (isP(sub[j], ')')) d--;
      if (d === 0 && U(sub[j]) === 'FROM') {
        fa = j;
        break;
      }
    }
    group = splitTop(sub.slice(0, fa), ',')
      .map((o) => o[o.length - 1]!)
      .map((t) => (t.kind === 'ident' ? (t.name ?? '') : t.text))
      .filter((n) => n.toLowerCase() !== argName && n.toLowerCase() !== pivotName)
      .map(q);
  } else {
    fail(ctx, line, 'PIVOT over SELECT * from a table needs the columns named: list them in the SELECT, or pivot a subquery that names them.');
    return null;
  }
  const argSql = translateTokens(aggArg, ctx, line);
  const cols = values.map((v) => (fn === 'COUNT' && argSql === '*' ? `COUNT(CASE WHEN ${pivotCol} = ${v.value} THEN 1 END) AS ${q(v.alias)}` : `${fn}(CASE WHEN ${pivotCol} = ${v.value} THEN ${argSql} END) AS ${q(v.alias)}`));
  const src = translateTokens(srcToks, ctx, line);
  const pivotSql = `(SELECT ${[...group, ...cols].join(', ')} FROM ${src}${group.length ? ` GROUP BY ${group.join(', ')}` : ''}) AS ${alias}`;
  note(ctx, line, `PIVOT became ${fn}(CASE WHEN ...) per value, grouped by ${group.length ? group.join(', ') : 'nothing'}.`);
  return [...toks.slice(0, frame.fromAt + 1), tok(pivotSql), ...toks.slice(after)];
}

function rewriteUnpivot(toks: Tok[], at: number, ctx: Ctx, line: number): Tok[] | null {
  const frame = pivotFrame(toks, at);
  let open = at + 1;
  let includeNulls = false;
  if (U(toks[open]) === 'INCLUDE' || U(toks[open]) === 'EXCLUDE') {
    includeNulls = U(toks[open]) === 'INCLUDE';
    open += 2; // INCLUDE NULLS
  }
  const close = matching(toks, open);
  const inner = toks.slice(open + 1, close);
  const forAt = inner.findIndex((t) => U(t) === 'FOR');
  const inAt = inner.findIndex((t, i) => i > forAt && U(t) === 'IN');
  if (!frame || forAt !== 1 || inAt < 0) {
    fail(ctx, line, 'UNPIVOT needs the form UNPIVOT (value_column FOR name_column IN (columns)).');
    return null;
  }
  const valueCol = nameText(inner[0]);
  const nameCol = nameText(inner[forAt + 1]);
  const listOpen = inAt + 1;
  const cols = splitTop(inner.slice(listOpen + 1, matching(inner, listOpen)), ',').map((v) => {
    const c0 = v[0]!;
    const asAt = v.findIndex((t) => U(t) === 'AS');
    const label = asAt >= 0 ? literalFor(v[asAt + 1]!).value : `'${(c0.kind === 'ident' ? (c0.name ?? '') : c0.text).replace(/'/g, "''")}'`;
    return { col: nameText(c0), label };
  });
  let after = close + 1;
  let alias = 'u';
  if (U(toks[after]) === 'AS') after++;
  if (toks[after] && (toks[after]!.kind === 'word' || toks[after]!.kind === 'ident') && !['WHERE', 'ORDER', 'GROUP', 'UNION', 'HAVING', 'LIMIT'].includes(U(toks[after]))) {
    alias = nameText(toks[after]);
    after++;
  }
  const outer = splitTop(toks.slice(frame.selectAt + 1, frame.fromAt), ',');
  const isStar = outer.length === 1 && outer[0]!.length === 1 && isP(outer[0]![0], '*');
  if (isStar) {
    fail(ctx, line, 'UNPIVOT with SELECT * needs the columns named: list the columns you keep in the SELECT.');
    return null;
  }
  const strip = (s: string) => s.replace(/"/g, '').toLowerCase();
  const keep = outer
    .map((o) => o[o.length - 1]!)
    .map((t) => nameText(t))
    .filter((n) => strip(n) !== strip(valueCol) && strip(n) !== strip(nameCol));
  const src = translateTokens(toks.slice(frame.fromAt + 1, at), ctx, line);
  const branches = cols.map((c) => `SELECT ${[...keep, `${c.label} AS ${nameCol}`, `${c.col} AS ${valueCol}`].join(', ')} FROM ${src}${includeNulls ? '' : ` WHERE ${c.col} IS NOT NULL`}`);
  note(ctx, line, `UNPIVOT became ${cols.length} SELECTs joined with UNION ALL${includeNulls ? '' : ' (empty values left out, as UNPIVOT does)'}.`);
  return [...toks.slice(0, frame.fromAt + 1), tok(`(${branches.join(' UNION ALL ')}) AS ${alias}`), ...toks.slice(after)];
}

// ---------------------------------------------------------------------------------------------
// Showing the plan
// ---------------------------------------------------------------------------------------------
/** The plan as SQLite text with the control flow as comments, for the page to show before it runs. */
export function renderPlan(nodes: readonly PlanNode[], indent = ''): string {
  const lines: string[] = [];
  for (const n of nodes) {
    switch (n.op) {
      case 'sql':
        lines.push(`${indent}${n.sql.replace(/\n/g, `\n${indent}`)};`);
        break;
      case 'declare':
        lines.push(`${indent}-- variable @${n.name}${n.sql ? ` = (${n.sql})` : ''}`);
        break;
      case 'assign':
        lines.push(`${indent}-- ${n.names.map((x) => `@${x}`).join(', ')} = ${n.mode === 'one' ? 'the one row of ' : ''}(${n.sql})`);
        break;
      case 'if':
        lines.push(`${indent}-- IF (${n.cond})`, renderPlan(n.then, `${indent}  `));
        if (n.else.length) lines.push(`${indent}-- ELSE`, renderPlan(n.else, `${indent}  `));
        lines.push(`${indent}-- END IF`);
        break;
      case 'while':
        lines.push(`${indent}-- WHILE (${n.cond}), at most ${n.max} times`, renderPlan(n.body, `${indent}  `));
        if (n.step?.length) lines.push(renderPlan(n.step, `${indent}  `));
        lines.push(`${indent}-- END WHILE`);
        break;
      case 'break':
      case 'continue':
        lines.push(`${indent}-- ${n.op.toUpperCase()}${n.cond ? ` WHEN (${n.cond})` : ''}`);
        break;
      case 'try':
        lines.push(`${indent}-- TRY (in a savepoint)`, renderPlan(n.body, `${indent}  `), `${indent}-- ON ERROR (rolled back to the savepoint)`, renderPlan(n.catch, `${indent}  `), `${indent}-- END TRY`);
        break;
      case 'raise':
        lines.push(`${indent}-- RAISE (${n.sql})`);
        break;
      case 'print':
        lines.push(`${indent}-- PRINT (${n.sql})`);
        break;
      case 'return':
        lines.push(`${indent}-- RETURN`);
        break;
      case 'import':
        lines.push(`${indent}-- IMPORT INTO ${n.table} (${n.mode}) FROM SOURCE ${n.source}:`, `${indent}--   ${n.sql.replace(/\n/g, ' ')}`);
        break;
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

/** Every SQL text in a plan, in order (for tests and checks). */
export function planSql(nodes: readonly PlanNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.op === 'sql') out.push(n.sql);
    else if (n.op === 'if') out.push(n.cond, ...planSql(n.then), ...planSql(n.else));
    else if (n.op === 'while') out.push(n.cond, ...planSql(n.body), ...planSql(n.step ?? []));
    else if (n.op === 'try') out.push(...planSql(n.body), ...planSql(n.catch));
    else if (n.op === 'assign' || n.op === 'raise' || n.op === 'print') out.push(n.sql);
    else if (n.op === 'declare' && n.sql) out.push(n.sql);
  }
  return out;
}

/** For a live (read-only) source: each statement must be one SELECT; returns them in its dialect, or errors. */
export function compileReadOnly(text: string, from: Dialect, to: Dialect, sourceLabel: string): { statements: Array<{ line: number; sql: string }>; errors: ScriptProblem[]; notes: ScriptProblem[] } {
  const errors: ScriptProblem[] = [];
  const notes: ScriptProblem[] = [];
  const statements: Array<{ line: number; sql: string }> = [];
  for (const s of splitScript(text, from)) {
    const first = (/^\s*([A-Za-z]+)/.exec(s.text)?.[1] ?? '').toUpperCase();
    if (first !== 'SELECT' && first !== 'WITH') {
      errors.push({ line: s.line, message: `Only SELECT runs against ${sourceLabel}: live databases stay read-only here (an administrator may allow writes per source in a later version). Write to the local database instead, or pull the rows with IMPORT INTO.` });
      continue;
    }
    const t = translateSql(s.text, from, to);
    for (const n of t.notes) notes.push({ line: s.line, message: n });
    statements.push({ line: s.line, sql: t.sql });
  }
  return { statements, errors, notes };
}

export { DIALECT_NAMES };

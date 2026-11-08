// Translates a SELECT written in one SQL dialect into another, so an analyst can write in the SQL they
// know (Settings > SQL) and run it against any source: T-SQL against PostgreSQL, PostgreSQL against
// SQL Server, and so on. The SQL desk shows the translated text before it runs.
//
// It covers what differs most between Semaphore's dialects: quoted names, row limits (TOP, LIMIT,
// FETCH FIRST), the current time, null fallbacks (ISNULL, IFNULL, NVL, Nz), text length, substrings,
// upper and lower case, date truncation, text joining with ||, PostgreSQL's x::type casts, and true
// and false. Anything else is passed through unchanged, and a note says what may need a look. It is
// not a full SQL parser: strings and quoted names are never changed inside, and the server's guard
// (one SELECT, nothing that writes) still applies to whatever is sent.

import type { Dialect } from './catalog.ts';
import type { TimeGrain } from './hoist.ts';
import { truncate } from './sql.ts';

export interface Translation {
  sql: string;
  /** Plain sentences about what was changed or may need checking. */
  notes: string[];
  changed: boolean;
}

export const DIALECT_NAMES: Record<Dialect, string> = {
  postgres: 'PostgreSQL',
  oracle: 'Oracle SQL',
  access: 'Microsoft Access SQL',
  tsql: 'T-SQL (SQL Server, Azure SQL)',
  synapse: 'T-SQL (Azure Synapse)',
  spark: 'Spark SQL (Databricks, Foundry)',
  mysql: 'MySQL / MariaDB (RDS, Aurora MySQL)',
  sqlite: 'SQLite (the local database)',
  ansi: 'ANSI-like SQL (Athena, Redshift, DuckDB, Trino)',
};

type Kind = 'space' | 'string' | 'ident' | 'word' | 'number' | 'punct';
interface Tok {
  kind: Kind;
  text: string;
  /** For quoted names: the name inside the quotes. */
  name?: string;
}

const tsqlLike = (d: Dialect) => d === 'tsql' || d === 'synapse';
const bracketed = (d: Dialect) => tsqlLike(d) || d === 'access';

/** Splits SQL into tokens. Strings and quoted names stay whole, whatever is inside them. */
export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j]!)) j++;
      out.push({ kind: 'space', text: sql.slice(i, j) });
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      out.push({ kind: 'string', text: sql.slice(i, Math.min(j + 1, sql.length)) });
      i = j + 1;
    } else if (c === '"' || c === '[' || c === '`') {
      const close = c === '[' ? ']' : c;
      const j = sql.indexOf(close, i + 1);
      const end = j < 0 ? sql.length : j;
      out.push({ kind: 'ident', text: sql.slice(i, end + 1), name: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$#]/.test(sql[j]!)) j++;
      out.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i;
      while (j < sql.length && /[0-9.eE]/.test(sql[j]!)) j++;
      out.push({ kind: 'number', text: sql.slice(i, j) });
      i = j;
    } else {
      const two = sql.slice(i, i + 2);
      if (two === '||' || two === '::' || two === '<=' || two === '>=' || two === '<>' || two === '!=') {
        out.push({ kind: 'punct', text: two });
        i += 2;
      } else {
        out.push({ kind: 'punct', text: c });
        i += 1;
      }
    }
  }
  return out;
}

const join = (toks: readonly Tok[]) => toks.map((t) => t.text).join('');
const up = (t: Tok | undefined) => (t && t.kind === 'word' ? t.text.toUpperCase() : '');

/** Index of the next token that is not white space, from `i` on; -1 when none. */
function next(toks: readonly Tok[], i: number): number {
  for (let j = i; j < toks.length; j++) if (toks[j]!.kind !== 'space') return j;
  return -1;
}
function prev(toks: readonly Tok[], i: number): number {
  for (let j = i; j >= 0; j--) if (toks[j]!.kind !== 'space') return j;
  return -1;
}

/** For a "(" at `open`, the index of its ")" and the top-level arguments between them. */
function callArgs(toks: readonly Tok[], open: number): { close: number; args: Tok[][] } | null {
  let depth = 0;
  const args: Tok[][] = [[]];
  for (let j = open; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.kind === 'punct' && t.text === '(') {
      depth++;
      if (depth === 1) continue;
    } else if (t.kind === 'punct' && t.text === ')') {
      depth--;
      if (depth === 0) return { close: j, args: args.map(trim) };
    } else if (t.kind === 'punct' && t.text === ',' && depth === 1) {
      args.push([]);
      continue;
    }
    args[args.length - 1]!.push(t);
  }
  return null;
}
function trim(toks: Tok[]): Tok[] {
  let a = 0;
  let b = toks.length;
  while (a < b && toks[a]!.kind === 'space') a++;
  while (b > a && toks[b - 1]!.kind === 'space') b--;
  return toks.slice(a, b);
}

const GRAINS: Record<string, TimeGrain> = {
  day: 'day', dd: 'day', d: 'day', ddd: 'day',
  week: 'week', iso_week: 'week', iw: 'week', wk: 'week', ww: 'week',
  month: 'month', mm: 'month', mon: 'month', m: 'month',
  quarter: 'quarter', q: 'quarter', qq: 'quarter',
  year: 'year', yyyy: 'year', yy: 'year', y: 'year',
};
const grainOf = (t: Tok[]): TimeGrain | null => {
  if (t.length !== 1) return null;
  const raw = t[0]!.kind === 'string' ? t[0]!.text.slice(1, -1) : t[0]!.text;
  return GRAINS[raw.toLowerCase()] ?? null;
};

function quoteName(name: string, to: Dialect): string | null {
  if (to === 'spark' || to === 'mysql') return name.includes('`') ? null : `\`${name}\``;
  if (bracketed(to)) return name.includes(']') ? null : `[${name}]`;
  return name.includes('"') ? null : `"${name}"`;
}

/** Translates `sql` from one dialect to another. The same dialect returns it unchanged. */
export function translateSql(sql: string, from: Dialect, to: Dialect): Translation {
  if (from === to) return { sql, notes: [], changed: false };
  const notes = new Set<string>();
  let toks = tokenize(sql);

  // Row limits come off first, wherever they were written, and go back on in the target's form.
  let limit: string | null = null;
  let lastWord = prev(toks, toks.length - 1);
  if (lastWord >= 0 && toks[lastWord]!.text === ';') {
    toks = toks.slice(0, lastWord);
    lastWord = prev(toks, toks.length - 1);
  }
  for (let i = 0; i < toks.length; i++) {
    if (up(toks[i]) === 'SELECT') {
      let j = next(toks, i + 1);
      if (up(toks[j]) === 'DISTINCT' || up(toks[j]) === 'ALL') j = next(toks, j + 1);
      if (up(toks[j]) === 'TOP') {
        const n = next(toks, j + 1);
        if (toks[n]?.kind === 'number' && limit === null) {
          limit = toks[n]!.text;
          const after = n + 1;
          toks.splice(j, after - j + (toks[after]?.kind === 'space' ? 1 : 0));
        }
      }
      break;
    }
  }
  {
    // A trailing LIMIT n, or FETCH FIRST|NEXT n ROW|ROWS ONLY.
    const words = toks.map((t, i) => ({ t, i })).filter((x) => x.t.kind !== 'space');
    const w = (k: number) => words[words.length - k];
    if (w(2) && up(w(2)!.t) === 'LIMIT' && w(1)!.t.kind === 'number') {
      limit ??= w(1)!.t.text;
      toks = toks.slice(0, w(2)!.i);
    } else if (w(5) && up(w(5)!.t) === 'FETCH' && ['FIRST', 'NEXT'].includes(up(w(4)!.t)) && w(3)!.t.kind === 'number' && ['ROW', 'ROWS'].includes(up(w(2)!.t)) && up(w(1)!.t) === 'ONLY') {
      limit ??= w(3)!.t.text;
      toks = toks.slice(0, w(5)!.i);
    }
    toks = trim(toks);
  }

  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'ident') {
      const q = quoteName(t.name ?? '', to);
      if (q) out.push({ kind: 'ident', text: q, name: t.name });
      else {
        out.push(t);
        notes.add(`The name ${t.text} holds a quote character, so it was left as written.`);
      }
      continue;
    }
    if (t.kind === 'punct' && t.text === '||') {
      // In MySQL || means OR unless the server runs with PIPES_AS_CONCAT.
      if (to === 'mysql') notes.add('In MySQL || means OR unless the server sets PIPES_AS_CONCAT; join text with CONCAT(a, b) there.');
      out.push({ kind: 'punct', text: tsqlLike(to) ? '+' : to === 'access' ? '&' : '||' });
      continue;
    }
    if (t.kind === 'punct' && t.text === '&' && from === 'access') {
      out.push({ kind: 'punct', text: tsqlLike(to) ? '+' : '||' });
      continue;
    }
    if (t.kind === 'punct' && t.text === '+' && tsqlLike(from)) notes.add('A + between text values joins them in T-SQL; check it if your source expects || or CONCAT.');
    if (t.kind === 'punct' && t.text === '::') {
      // x::type becomes CAST(x AS type), for the token or bracketed group just before it.
      const typeAt = next(toks, i + 1);
      if (to !== 'postgres' && typeAt >= 0 && (toks[typeAt]!.kind === 'word' || toks[typeAt]!.kind === 'ident')) {
        let start = out.length - 1;
        while (start >= 0 && out[start]!.kind === 'space') start--;
        if (start >= 0 && out[start]!.text === ')') {
          let depth = 0;
          for (let k = start; k >= 0; k--) {
            if (out[k]!.text === ')') depth++;
            if (out[k]!.text === '(') depth--;
            if (depth === 0) {
              start = k;
              if (k > 0 && out[k - 1]!.kind === 'word') start = k - 1;
              break;
            }
          }
        }
        const operand = out.splice(start);
        out.push({ kind: 'word', text: 'CAST' }, { kind: 'punct', text: '(' }, ...trim(operand), { kind: 'space', text: ' ' }, { kind: 'word', text: 'AS' }, { kind: 'space', text: ' ' }, toks[typeAt]!, { kind: 'punct', text: ')' });
        i = typeAt;
        notes.add('PostgreSQL casts (x::type) were written as CAST(x AS type); check the type names exist in the target.');
        continue;
      }
    }
    if (t.kind === 'word') {
      const name = t.text.toUpperCase();
      const openAt = next(toks, i + 1);
      const isCall = openAt >= 0 && toks[openAt]!.text === '(';
      // true and false.
      if ((name === 'TRUE' || name === 'FALSE') && (tsqlLike(to) || to === 'access') && !isCall) {
        out.push({ kind: 'number', text: name === 'TRUE' ? (to === 'access' ? '-1' : '1') : '0' });
        continue;
      }
      // The current time, with or without brackets.
      if (['GETDATE', 'NOW', 'SYSDATETIME', 'CURRENT_TIMESTAMP', 'SYSDATE', 'SYSTIMESTAMP'].includes(name)) {
        const call = isCall ? callArgs(toks, openAt) : null;
        if (!isCall || (call && call.args.every((a) => a.length === 0))) {
          out.push({ kind: 'word', text: to === 'access' ? 'Now()' : tsqlLike(to) ? 'GETDATE()' : 'CURRENT_TIMESTAMP' });
          if (call) i = call.close;
          continue;
        }
      }
      if (isCall) {
        const call = callArgs(toks, openAt);
        if (call) {
          const args = call.args;
          // Arguments are translated too (a quoted name or a nested function inside them).
          const a = (k: number) => {
            const r = translateSql(join(args[k] ?? []), from, to);
            for (const n of r.notes) notes.add(n);
            return r.sql;
          };
          const done = (text: string) => {
            out.push({ kind: 'word', text });
            i = call.close;
          };
          // Null fallbacks: ISNULL(a, b) in T-SQL (Access's ISNULL takes one argument and is a test), IFNULL, NVL, Nz.
          // Access has no COALESCE, so a two-argument one becomes Nz there.
          if (((name === 'ISNULL' && from !== 'access') || name === 'IFNULL' || name === 'NVL' || name === 'NZ' || (name === 'COALESCE' && to === 'access')) && args.length === 2) {
            done(to === 'access' ? `Nz(${a(0)}, ${a(1)})` : `COALESCE(${a(0)}, ${a(1)})`);
            continue;
          }
          if ((name === 'LEN' || name === 'LENGTH' || name === 'CHAR_LENGTH') && args.length === 1) {
            // MySQL's LENGTH counts bytes; CHAR_LENGTH counts characters, like LEN and LENGTH elsewhere.
            done(`${tsqlLike(to) ? 'LEN' : to === 'access' ? 'Len' : to === 'mysql' ? 'CHAR_LENGTH' : 'LENGTH'}(${a(0)})`);
            continue;
          }
          if ((name === 'SUBSTRING' || name === 'SUBSTR' || name === 'MID') && (args.length === 2 || args.length === 3)) {
            const fn = to === 'oracle' ? 'SUBSTR' : to === 'access' ? 'Mid' : 'SUBSTRING';
            const third = args.length === 3 ? `, ${a(2)}` : tsqlLike(to) ? ', 2147483647' : '';
            done(`${fn}(${a(0)}, ${a(1)}${third})`);
            continue;
          }
          if ((name === 'UPPER' || name === 'UCASE' || name === 'LOWER' || name === 'LCASE') && args.length === 1) {
            const upper = name === 'UPPER' || name === 'UCASE';
            done(`${to === 'access' ? (upper ? 'UCase' : 'LCase') : upper ? 'UPPER' : 'LOWER'}(${a(0)})`);
            continue;
          }
          // Date truncation: date_trunc('month', x), DATETRUNC(month, x), TRUNC(x, 'MM').
          let grain: TimeGrain | null = null;
          let col = '';
          if ((name === 'DATE_TRUNC' || name === 'DATETRUNC') && args.length === 2) {
            grain = grainOf(args[0]!);
            col = a(1);
          } else if (name === 'TRUNC' && args.length === 2 && from === 'oracle') {
            grain = grainOf(args[1]!);
            col = a(0);
          }
          if (grain && col) {
            done(truncate(col, grain, to));
            continue;
          }
          if (name === 'CONCAT' && to === 'access') notes.add('Access has no CONCAT; join text with & instead.');
          if (['DATEADD', 'DATEDIFF', 'DATEPART', 'EXTRACT', 'TO_CHAR', 'FORMAT', 'CONVERT', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'STRFTIME', 'JULIANDAY'].includes(name)) {
            notes.add(`${t.text} differs between databases and was left as written; check it works in ${DIALECT_NAMES[to]}.`);
          }
        }
      }
      if (name === 'ROWNUM') notes.add('ROWNUM is Oracle only; use a row limit instead (TOP, LIMIT or FETCH FIRST).');
      if (name === 'ILIKE' && to !== 'postgres') notes.add('ILIKE is PostgreSQL only; use LOWER(x) LIKE LOWER(y) elsewhere.');
    }
    out.push(t);
  }

  let text = join(out);
  if (limit !== null) {
    if (tsqlLike(to) || to === 'access') {
      text = text.replace(/^(\s*SELECT)(\s+(?:DISTINCT|ALL))?/i, (m, s: string, d: string | undefined) => `${s}${d ?? ''} TOP ${limit}`);
    } else if (to === 'oracle') text = `${text}\nFETCH FIRST ${limit} ROWS ONLY`;
    else text = `${text}\nLIMIT ${limit}`;
  }
  return { sql: text, notes: [...notes], changed: text !== sql };
}

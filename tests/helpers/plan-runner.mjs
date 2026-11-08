// A stand-in for server/LocalScript.cs's runner, on node:sqlite: runs a script plan (src/core/script.ts)
// in one transaction, with SAVEPOINTs for try nodes, variables bound as @name, and bounded loops. The unit
// tests use it to prove the translated SQLite really runs; the e2e mock server uses it for /api/local/script-run.
// It mirrors the server's rules, not its safety checks (the server's authorizer is tested with Pester).

class Signal extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

export class ScriptError extends Error {
  constructor(message, line, sql) {
    super(message);
    this.line = line;
    this.sql = sql;
  }
}

/**
 * Runs plan.nodes on db (a node:sqlite DatabaseSync). Returns { ok, results, error?, vars }.
 * params: { name: value } for the plan's parameters.
 */
export function runPlan(db, plan, params = {}, opts = {}) {
  const rowCap = opts.rowCap ?? 500;
  const vars = new Map([
    ['error_message', null],
    ['error_number', null],
  ]);
  for (const [k, v] of Object.entries(params)) vars.set(k.toLowerCase(), v);
  const results = [];
  let sp = 0;
  const bind = (sql) => {
    const out = {};
    for (const m of sql.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const n = m[1].toLowerCase();
      if (!vars.has(n)) throw new Error(`@${m[1]} is not declared and has no value.`);
      let v = vars.get(n);
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof v === 'number' && Number.isInteger(v)) v = BigInt(v);
      out[m[1]] = v === undefined ? null : v;
    }
    return out;
  };
  const prepare = (sql) => {
    const st = db.prepare(sql);
    st.setReadBigInts?.(false);
    return st;
  };
  const scalarRow = (sql, line) => {
    try {
      return prepare(sql).all(bind(sql));
    } catch (e) {
      throw new ScriptError(`Line ${line}: ${e.message}`, line, sql);
    }
  };
  const truthy = (v) => v !== null && v !== undefined && v !== 0 && v !== '0' && v !== false;
  const cond = (sql, line) => {
    const rows = scalarRow(sql, line);
    const r = rows[0];
    return r ? truthy(Object.values(r)[0]) : false;
  };
  const exec = (n) => {
    const t0 = Date.now();
    try {
      const st = prepare(n.sql);
      const cols = st.columns ? st.columns().map((c) => c.name) : [];
      if (cols.length > 0) {
        const rows = st.all(bind(n.sql));
        results.push({ line: n.line, sql: n.sql, kind: 'rows', columns: cols, rows: rows.slice(0, rowCap).map((r) => cols.map((c) => r[c])), truncated: rows.length > rowCap, ms: Date.now() - t0 });
      } else {
        const r = st.run(bind(n.sql));
        results.push({ line: n.line, sql: n.sql, kind: 'changes', changes: Number(r.changes), ms: Date.now() - t0 });
      }
    } catch (e) {
      if (e instanceof ScriptError) throw e;
      throw new ScriptError(`Line ${n.line}: ${e.message}`, n.line, n.sql);
    }
  };
  const run = (nodes) => {
    for (const n of nodes) {
      switch (n.op) {
        case 'sql':
          exec(n);
          break;
        case 'declare':
          vars.set(n.name, null);
          if (n.sql) {
            const r = scalarRow(n.sql, n.line)[0];
            vars.set(n.name, r ? Object.values(r)[0] : null);
          }
          break;
        case 'assign': {
          const rows = scalarRow(n.sql, n.line);
          if (n.mode === 'one' && rows.length !== 1) throw new ScriptError(`Line ${n.line}: ${rows.length === 0 ? 'no row came back' : 'more than one row came back'} for SELECT ... INTO.`, n.line, n.sql);
          const r = rows[rows.length - 1];
          if (r) n.names.forEach((name, i) => vars.set(name, Object.values(r)[i] ?? null));
          break;
        }
        case 'if':
          run(cond(n.cond, n.line) ? n.then : n.else);
          break;
        case 'while': {
          let i = 0;
          while (cond(n.cond, n.line)) {
            if (++i > n.max) throw new ScriptError(`Line ${n.line}: the loop ran ${n.max} times; Semaphore stops loops there.`, n.line, n.cond);
            try {
              run(n.body);
            } catch (e) {
              if (e instanceof Signal && e.kind === 'break') break;
              if (!(e instanceof Signal && e.kind === 'continue')) throw e;
            }
            if (n.step) run(n.step);
          }
          break;
        }
        case 'break':
        case 'continue':
          if (!n.cond || cond(n.cond, n.line)) throw new Signal(n.op);
          break;
        case 'return':
          throw new Signal('return');
        case 'print': {
          const r = scalarRow(n.sql, n.line)[0];
          results.push({ line: n.line, kind: 'message', message: String(r ? Object.values(r)[0] : '') });
          break;
        }
        case 'raise': {
          const r = scalarRow(n.sql, n.line)[0];
          throw new ScriptError(String(r ? Object.values(r)[0] : 'Error raised by the script.'), n.line, n.sql);
        }
        case 'try': {
          const name = `sem_try_${++sp}`;
          db.exec(`SAVEPOINT ${name}`);
          try {
            run(n.body);
            db.exec(`RELEASE ${name}`);
          } catch (e) {
            if (!(e instanceof ScriptError)) throw e;
            db.exec(`ROLLBACK TO ${name}`);
            db.exec(`RELEASE ${name}`);
            vars.set('error_message', e.message.replace(/^Line \d+: /, ''));
            vars.set('error_number', 50000);
            run(n.catch);
          }
          break;
        }
        case 'import':
          if (!opts.onImport) throw new ScriptError(`Line ${n.line}: IMPORT INTO is not available here.`, n.line, n.sql);
          opts.onImport(n);
          results.push({ line: n.line, kind: 'changes', changes: 0, sql: `IMPORT INTO ${n.table}` });
          break;
        default:
          throw new ScriptError(`Unknown step ${n.op}.`, n.line ?? 0, '');
      }
    }
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    try {
      run(plan.nodes);
    } catch (e) {
      if (!(e instanceof Signal && e.kind === 'return')) throw e;
    }
    db.exec('COMMIT');
    return { ok: true, results, vars: Object.fromEntries(vars) };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    return { ok: false, results, error: { message: e.message, line: e.line ?? 0, sql: e.sql ?? '' }, vars: Object.fromEntries(vars) };
  }
}

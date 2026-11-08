// SQL scripts for the local database (src/core/script.ts): splitting, translation of what SQLite lacks
// (MERGE, PIVOT / UNPIVOT, TRY...CATCH and EXCEPTION, variables, IF / WHILE / FOR, SELECT INTO), the
// refusal list and IMPORT INTO. The translated plans are run on node:sqlite through tests/helpers/plan-runner.mjs
// (the same rules as server/LocalScript.cs), so a translation is proved by the rows it leaves behind.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileReadOnly, compileScript, planSql, refusal, splitScript } from '../src/core/script.ts';
// @ts-expect-error plain JavaScript helper shared with the e2e mock server
import { runPlan } from './helpers/plan-runner.mjs';

type Db = { exec(sql: string): void; prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>>; run(...a: unknown[]): unknown } };
let DatabaseSync: (new (path: string) => Db) | null = null;
try {
  ({ DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => Db });
} catch {
  DatabaseSync = null;
}

function db(setup = ''): Db {
  if (!DatabaseSync) throw new Error('node:sqlite is missing');
  const d = new DatabaseSync(':memory:');
  if (setup) d.exec(setup);
  return d;
}
const rows = (d: Db, sql: string) => d.prepare(sql).all().map((r) => ({ ...r }));

function runOk(d: Db, text: string, dialect: Parameters<typeof compileScript>[1], params: Record<string, unknown> = {}) {
  const c = compileScript(text, dialect);
  assert.deepEqual(c.errors, [], `no errors expected:\n${c.sqlite}`);
  const r = runPlan(d, c.plan, params);
  assert.equal(r.ok, true, `${r.error?.message}\n${c.sqlite}`);
  return { c, r };
}

// ---------------------------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------------------------
test('splits on ; but never inside strings, quoted names or comments', () => {
  const s = splitScript("SELECT 'a;b' AS \"x;y\"; -- a; comment\nSELECT 2; /* c; d */ SELECT [e;f] FROM t", 'tsql');
  assert.equal(s.length, 3);
  assert.equal(s[0]!.text, "SELECT 'a;b' AS \"x;y\"");
  assert.equal(s[1]!.line, 2);
  assert.match(s[2]!.text, /\[e;f\]/);
});

test('T-SQL without semicolons: each statement starts a new one, but INSERT ... SELECT, UNION, CTEs and UPDATE ... SET stay whole', () => {
  const s = splitScript(
    `INSERT INTO a (x)
SELECT x FROM b
UNION ALL
SELECT x FROM c
UPDATE a
SET x = 1
WITH cte AS (SELECT 1 AS x)
SELECT * FROM cte
DELETE FROM a WHERE x IN (SELECT x FROM b)
GO
SELECT 1`,
    'tsql',
  );
  assert.deepEqual(
    s.map((x) => x.text.split(/\s/)[0]),
    ['INSERT', 'UPDATE', 'WITH', 'DELETE', 'SELECT'],
  );
  assert.equal(s[0]!.line, 1);
  assert.equal(s[4]!.line, 11);
});

test('a BEGIN...END block, TRY...CATCH and an Oracle anonymous block each count as one statement; CASE ... END does not close them', () => {
  const t = splitScript(
    `BEGIN TRY
  SELECT CASE WHEN 1 = 1 THEN 'a' ELSE 'b' END;
  SELECT 2;
END TRY
BEGIN CATCH
  SELECT 3;
END CATCH
SELECT 4`,
    'tsql',
  );
  assert.equal(t.length, 2);
  const o = splitScript(
    `DECLARE
  v NUMBER := 1;
BEGIN
  IF v = 1 THEN v := CASE WHEN v > 0 THEN 2 ELSE 3 END; END IF;
END;
/
SELECT 1 FROM dual;`,
    'oracle',
  );
  assert.equal(o.length, 2);
  assert.equal(o[1]!.line, 7);
});

// ---------------------------------------------------------------------------------------------
// MERGE
// ---------------------------------------------------------------------------------------------
const STOCK = 'CREATE TABLE stock (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER); INSERT INTO stock VALUES (1, \'bolt\', 5), (2, \'nut\', 7), (9, \'old\', 1);';

test('T-SQL MERGE becomes UPDATE ... FROM then INSERT ... WHERE NOT EXISTS, and does what MERGE does', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { c } = runOk(
    d,
    `MERGE INTO dbo.stock AS t
USING (SELECT 2 AS id, 'nut' AS name, 70 AS qty UNION ALL SELECT 3, 'washer', 30) AS s
ON t.id = s.id
WHEN MATCHED AND s.qty > 0 THEN UPDATE SET t.qty = s.qty, t.name = s.name
WHEN NOT MATCHED BY TARGET THEN INSERT (id, name, qty) VALUES (s.id, s.name, s.qty)
WHEN NOT MATCHED BY SOURCE AND t.id > 5 THEN DELETE;`,
    'tsql',
  );
  const sql = planSql(c.plan.nodes);
  assert.equal(sql.length, 6);
  assert.match(sql[1]!, /^CREATE TEMP TABLE sem_merge_1 AS SELECT \* FROM \(SELECT .*\) AS s WHERE NOT EXISTS \(SELECT 1 FROM stock AS t WHERE \(t\.id = s\.id\)\)$/);
  assert.match(sql[2]!, /^UPDATE stock AS t SET qty = s\.qty, name = s\.name FROM \(SELECT .*\) AS s WHERE \(t\.id = s\.id\) AND \(s\.qty > 0\)$/);
  assert.equal(sql[3]!, 'INSERT INTO stock (id, name, qty) SELECT s.id, s.name, s.qty FROM sem_merge_1 AS s');
  assert.match(sql[4]!, /^DELETE FROM stock AS t WHERE NOT EXISTS/);
  assert.ok(c.notes.some((n) => /MERGE became UPDATE, then INSERT, then DELETE/.test(n.message)));
  assert.deepEqual(rows(d, 'SELECT id, name, qty FROM stock ORDER BY id'), [
    { id: 1, name: 'bolt', qty: 5 },
    { id: 2, name: 'nut', qty: 70 },
    { id: 3, name: 'washer', qty: 30 },
  ]);
});

test('Oracle MERGE (no AS, a table as the source, UPDATE ... WHERE and DELETE WHERE)', { skip: !DatabaseSync }, () => {
  const d = db(`${STOCK} CREATE TABLE incoming (id INTEGER, name TEXT, qty INTEGER); INSERT INTO incoming VALUES (1, 'bolt', 0), (2, 'nut', 8), (4, 'pin', 4);`);
  runOk(
    d,
    `MERGE INTO stock t
USING incoming s
ON (t.id = s.id)
WHEN MATCHED THEN UPDATE SET t.qty = s.qty WHERE s.qty >= 0 DELETE WHERE t.qty = 0
WHEN NOT MATCHED THEN INSERT (id, name, qty) VALUES (s.id, s.name, s.qty);`,
    'oracle',
  );
  assert.deepEqual(rows(d, 'SELECT id, qty FROM stock ORDER BY id'), [
    { id: 2, qty: 8 },
    { id: 4, qty: 4 },
    { id: 9, qty: 1 },
  ]);
});

// ---------------------------------------------------------------------------------------------
// PIVOT / UNPIVOT
// ---------------------------------------------------------------------------------------------
const SALES = "CREATE TABLE sales (region TEXT, quarter TEXT, amount REAL); INSERT INTO sales VALUES ('N','Q1',10),('N','Q2',20),('N','Q2',5),('S','Q1',7);";

test('T-SQL PIVOT becomes CASE aggregates grouped by the other columns', { skip: !DatabaseSync }, () => {
  const d = db(SALES);
  const { c, r } = runOk(d, 'SELECT region, [Q1], [Q2] FROM (SELECT region, quarter, amount FROM sales) AS src PIVOT (SUM(amount) FOR quarter IN ([Q1], [Q2])) AS p ORDER BY region', 'tsql');
  assert.match(c.sqlite, /SUM\(CASE WHEN quarter = 'Q1' THEN amount END\) AS "Q1"/);
  assert.match(c.sqlite, /GROUP BY region\) AS p/);
  assert.deepEqual(r.results[0].rows, [
    ['N', 10, 25],
    ['S', 7, null],
  ]);
});

test('Oracle PIVOT with aliases, and COUNT(*)', { skip: !DatabaseSync }, () => {
  const d = db(SALES);
  const { r } = runOk(d, "SELECT * FROM (SELECT region, quarter FROM sales) PIVOT (COUNT(*) FOR quarter IN ('Q1' AS q1, 'Q2' AS q2)) ORDER BY region", 'oracle');
  assert.deepEqual(r.results[0].columns, ['region', 'q1', 'q2']);
  assert.deepEqual(r.results[0].rows, [
    ['N', 1, 2],
    ['S', 1, 0],
  ]);
});

test('UNPIVOT becomes UNION ALL branches that leave out empty values (and keep them with INCLUDE NULLS)', { skip: !DatabaseSync }, () => {
  const d = db('CREATE TABLE wide (region TEXT, q1 REAL, q2 REAL); INSERT INTO wide VALUES (\'N\', 10, 25), (\'S\', 7, NULL);');
  const { r } = runOk(d, 'SELECT region, quarter, amount FROM wide UNPIVOT (amount FOR quarter IN (q1, q2)) AS u ORDER BY region, quarter', 'tsql');
  assert.deepEqual(r.results[0].rows, [
    ['N', 'q1', 10],
    ['N', 'q2', 25],
    ['S', 'q1', 7],
  ]);
  const o = runOk(d, "SELECT region, quarter, amount FROM wide UNPIVOT INCLUDE NULLS (amount FOR quarter IN (q1 AS 'Q1', q2 AS 'Q2')) ORDER BY region, quarter", 'oracle');
  assert.equal(o.r.results[0].rows.length, 4);
});

test('PIVOT over SELECT * from a plain table asks for the columns instead of guessing', () => {
  const c = compileScript('SELECT * FROM sales PIVOT (SUM(amount) FOR quarter IN ([Q1])) AS p', 'tsql');
  assert.ok(c.errors.some((e) => /needs the columns named/.test(e.message)));
});

// ---------------------------------------------------------------------------------------------
// TRY...CATCH and EXCEPTION
// ---------------------------------------------------------------------------------------------
test('T-SQL TRY...CATCH: the failed part rolls back to its savepoint, the rest stays, and the CATCH block sees ERROR_MESSAGE()', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { c, r } = runOk(
    d,
    `BEGIN TRANSACTION
INSERT INTO stock VALUES (20, 'kept', 1)
BEGIN TRY
  INSERT INTO stock VALUES (21, 'undone', 1)
  INSERT INTO stock VALUES (1, 'duplicate', 1)
END TRY
BEGIN CATCH
  DECLARE @m NVARCHAR(400) = ERROR_MESSAGE()
  INSERT INTO stock VALUES (22, 'caught: ' + @m, 0)
  PRINT 'caught'
END CATCH
COMMIT`,
    'tsql',
  );
  assert.ok(c.notes.some((n) => /BEGIN was left out/.test(n.message)));
  assert.deepEqual(rows(d, 'SELECT id FROM stock WHERE id >= 20 ORDER BY id').map((x) => x.id), [20, 22]);
  assert.match(String(rows(d, 'SELECT name FROM stock WHERE id = 22')[0]!.name), /^caught: .*UNIQUE/);
  assert.ok(r.results.some((x: { kind: string; message?: string }) => x.kind === 'message' && x.message === 'caught'));
});

test('Oracle BEGIN ... EXCEPTION WHEN OTHERS: SQLERRM in the handler, RAISE_APPLICATION_ERROR stops the script', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  runOk(
    d,
    `BEGIN
  INSERT INTO stock VALUES (30, 'a', 1);
  INSERT INTO stock VALUES (1, 'dup', 1);
EXCEPTION
  WHEN DUP_VAL_ON_INDEX THEN
    INSERT INTO stock VALUES (31, SQLERRM, 0);
END;`,
    'oracle',
  );
  assert.deepEqual(rows(d, 'SELECT id FROM stock WHERE id >= 30').map((x) => x.id), [31]);
  const c = compileScript(`BEGIN\n  RAISE_APPLICATION_ERROR(-20001, 'stock is short');\nEND;`, 'oracle');
  const r = runPlan(d, c.plan);
  assert.equal(r.ok, false);
  assert.equal(r.error.message, 'stock is short');
});

test('an error outside any TRY rolls the whole script back', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const c = compileScript("INSERT INTO stock VALUES (40, 'x', 1);\nUPDATE stock SET qty = 0;\nINSERT INTO stock VALUES (1, 'dup', 1);", 'sqlite');
  const r = runPlan(d, c.plan);
  assert.equal(r.ok, false);
  assert.equal(r.error.line, 3);
  assert.deepEqual(rows(d, 'SELECT COUNT(*) AS n FROM stock WHERE id = 40 OR qty = 0'), [{ n: 0 }]);
});

// ---------------------------------------------------------------------------------------------
// Variables and control flow
// ---------------------------------------------------------------------------------------------
test('T-SQL variables: DECLARE, SET, +=, SELECT @a = ..., and an undeclared @name becomes a parameter', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { c, r } = runOk(
    d,
    `DECLARE @total INT, @n INT = 0
SELECT @total = SUM(qty), @n = COUNT(*) FROM stock WHERE name <> @skip
SET @total += 100
SELECT @total AS total, @n AS n`,
    'tsql',
    { skip: 'old' },
  );
  assert.deepEqual(c.plan.params, [{ name: 'skip', label: '@skip' }]);
  assert.deepEqual(r.results[0].rows, [[112, 2]]);
});

test('IF / ELSE, WHILE with BREAK and CONTINUE, and a loop that would never end is stopped', { skip: !DatabaseSync }, () => {
  const d = db('CREATE TABLE log (n INTEGER)');
  runOk(
    d,
    `DECLARE @i INT = 0
WHILE 1 = 1
BEGIN
  SET @i = @i + 1
  IF @i = 2 CONTINUE
  IF @i > 4 BREAK
  ELSE INSERT INTO log VALUES (@i)
END
IF EXISTS (SELECT 1 FROM log WHERE n = 3) INSERT INTO log VALUES (99) ELSE INSERT INTO log VALUES (-1)`,
    'tsql',
  );
  assert.deepEqual(rows(d, 'SELECT n FROM log').map((x) => x.n), [1, 3, 4, 99]);
  const c = compileScript('WHILE 1 = 1 SELECT 1', 'tsql', { maxLoop: 5 });
  const r = runPlan(d, c.plan);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /ran 5 times/);
});

test('Oracle variables, FOR i IN a .. b, LOOP ... EXIT WHEN, IF ... ELSIF and SELECT ... INTO', { skip: !DatabaseSync }, () => {
  const d = db(`${STOCK} CREATE TABLE log (n INTEGER, note TEXT);`);
  const { c } = runOk(
    d,
    `DECLARE
  v_sum   NUMBER := 0;
  v_count NUMBER;
  v_label VARCHAR2(20 CHAR);
BEGIN
  FOR i IN 1 .. 4 LOOP
    v_sum := v_sum + i;
  END LOOP;
  LOOP
    v_sum := v_sum + 100;
    EXIT WHEN v_sum > 300;
  END LOOP;
  SELECT COUNT(*) INTO v_count FROM stock WHERE qty > :min_qty;
  IF v_count > 5 THEN v_label := 'many';
  ELSIF v_count > 1 THEN v_label := 'some';
  ELSE v_label := 'few';
  END IF;
  INSERT INTO log VALUES (v_sum, v_label || '/' || v_count);
END;`,
    'oracle',
    { min_qty: 1 },
  );
  assert.deepEqual(c.plan.params, [{ name: 'min_qty', label: ':min_qty' }]);
  assert.deepEqual(rows(d, 'SELECT n, note FROM log'), [{ n: 310, note: 'some/2' }]);
});

test('Oracle SELECT ... INTO a variable needs exactly one row', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const c = compileScript('DECLARE v NUMBER; BEGIN SELECT qty INTO v FROM stock WHERE id > 100; END;', 'oracle');
  const r = runPlan(d, c.plan);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /no row came back/);
});

// ---------------------------------------------------------------------------------------------
// Other T-SQL and Oracle forms
// ---------------------------------------------------------------------------------------------
test('SELECT ... INTO a new table and #temp tables become CREATE [TEMP] TABLE ... AS SELECT; TOP becomes LIMIT at its own level', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { c, r } = runOk(
    d,
    `SELECT TOP (2) id, name INTO #small FROM dbo.stock ORDER BY qty
SELECT * INTO big FROM stock WHERE id IN (SELECT TOP 1 id FROM stock ORDER BY qty DESC)
SELECT (SELECT COUNT(*) FROM #small) AS small, (SELECT name FROM big) AS big`,
    'tsql',
  );
  assert.match(c.sqlite, /^CREATE TEMP TABLE small AS SELECT id, name FROM stock ORDER BY qty\nLIMIT 2;/m);
  assert.match(c.sqlite, /IN \(SELECT id FROM stock ORDER BY qty DESC LIMIT 1\)/);
  assert.deepEqual(r.results[2].rows, [[2, 'nut']]);
});

test('IF OBJECT_ID(...) IS NOT NULL DROP TABLE, IDENTITY, NVARCHAR(MAX), BIT, GETDATE, DATEADD and DATEDIFF', { skip: !DatabaseSync }, () => {
  const d = db('CREATE TABLE jobs (x INTEGER)');
  const { r } = runOk(
    d,
    `IF OBJECT_ID('dbo.jobs') IS NOT NULL DROP TABLE dbo.jobs
CREATE TABLE jobs (id INT IDENTITY(1,1) PRIMARY KEY, title NVARCHAR(MAX) NOT NULL, done BIT, opened DATETIME2 DEFAULT GETDATE())
INSERT INTO jobs (title, done, opened) VALUES (N'paint', 1, '2026-01-30')
INSERT INTO jobs (title, done, opened) VALUES ('weld', 0, '2026-03-01')
SELECT id, DATEADD(day, 2, opened) AS due, DATEDIFF(day, '2026-01-01', opened) AS age, DATEDIFF(month, '2025-12-15', opened) AS months FROM jobs ORDER BY id`,
    'tsql',
  );
  assert.deepEqual(r.results[r.results.length - 1].rows, [
    [1, '2026-02-01 00:00:00', 29, 1],
    [2, '2026-03-03 00:00:00', 59, 3],
  ]);
});

test('CREATE OR REPLACE VIEW, Oracle temp tables, FROM DUAL, DATE literals and TRUNCATE TABLE', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { c, r } = runOk(
    d,
    `CREATE OR REPLACE VIEW v_stock AS SELECT id FROM stock;
CREATE OR REPLACE VIEW v_stock AS SELECT id, qty FROM stock WHERE qty > 1;
CREATE GLOBAL TEMPORARY TABLE scratch (d DATE) ON COMMIT PRESERVE ROWS;
INSERT INTO scratch SELECT DATE '2026-05-01' FROM DUAL;
TRUNCATE TABLE scratch;
SELECT (SELECT COUNT(*) FROM v_stock) AS v, (SELECT COUNT(*) FROM scratch) AS s FROM dual;`,
    'oracle',
  );
  assert.match(c.sqlite, /DROP VIEW IF EXISTS v_stock;\nCREATE VIEW v_stock AS/);
  assert.match(c.sqlite, /CREATE TEMP TABLE scratch\(d DATE\);/);
  assert.deepEqual(r.results[r.results.length - 1].rows, [[2, 0]]);
});

test('upserts, CTEs and window functions pass through to SQLite', { skip: !DatabaseSync }, () => {
  const d = db(STOCK);
  const { r } = runOk(
    d,
    `INSERT INTO stock (id, name, qty) VALUES (2, 'nut', 1) ON CONFLICT (id) DO UPDATE SET qty = qty + excluded.qty;
WITH ranked AS (SELECT id, qty, ROW_NUMBER() OVER (ORDER BY qty DESC) AS rn FROM stock)
SELECT id FROM ranked WHERE rn = 1;`,
    'postgres',
  );
  assert.deepEqual(r.results[1].rows, [[2]]);
  const m = runOk(db(STOCK), "INSERT INTO stock (id, name, qty) VALUES (1, 'bolt', 50) ON DUPLICATE KEY UPDATE qty = VALUES(qty);", 'mysql');
  assert.ok(m.c.notes.some((n) => /ON CONFLICT DO UPDATE/.test(n.message)));
});

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------
test('the refusal list: ATTACH, DETACH, PRAGMA (but the safe reads), VACUUM INTO, load_extension, triggers, _semaphore tables', () => {
  assert.match(refusal("ATTACH DATABASE 'x.db' AS x")!, /ATTACH is refused/);
  assert.match(refusal('DETACH x')!, /DETACH/);
  assert.match(refusal("VACUUM INTO 'C:\\copy.db'")!, /VACUUM/);
  assert.match(refusal('PRAGMA journal_mode = DELETE')!, /never set/);
  assert.match(refusal('PRAGMA writable_schema')!, /refused/);
  assert.equal(refusal("PRAGMA table_info('stock')"), null);
  assert.equal(refusal('SELECT * FROM pragma_table_info(\'stock\')'), null);
  assert.match(refusal("SELECT load_extension('evil.dll')")!, /load_extension/);
  assert.match(refusal('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END')!, /Triggers/);
  assert.match(refusal('DELETE FROM _semaphore_tables')!, /_semaphore/);
  assert.match(refusal('UPDATE "_semaphore_tables" SET rows = 0')!, /_semaphore/);
  assert.match(refusal('DROP TABLE _semaphore_tables')!, /_semaphore/);
  assert.equal(refusal("SELECT * FROM t WHERE note = 'ATTACH DATABASE'"), null, 'words inside strings are data');
  assert.equal(refusal('SELECT name FROM _semaphore_tables'), null, 'reading the bookkeeping is allowed');
});

test('a script with refused statements compiles to errors with their lines; transactions are dropped with a note', () => {
  const c = compileScript(
    `SELECT 1;
ATTACH DATABASE 'other.db' AS o;
EXEC sp_who;
DECLARE @t TABLE (id INT);
DECLARE c CURSOR FOR SELECT 1;
PRAGMA journal_mode = OFF;
BEGIN TRAN;
COMMIT;`,
    'tsql',
  );
  assert.deepEqual(
    c.errors.map((e) => e.line),
    [2, 3, 4, 5, 6],
  );
  assert.ok(c.errors.some((e) => /Stored procedures/.test(e.message)));
  assert.ok(c.errors.some((e) => /Table variables/.test(e.message)));
  assert.ok(c.notes.some((n) => n.line === 7 && /one transaction/.test(n.message)));
  const o = compileScript('DECLARE CURSOR c IS SELECT 1 FROM dual; BEGIN NULL; END;', 'oracle');
  assert.ok(o.errors.some((e) => /Cursors/.test(e.message)));
});

// ---------------------------------------------------------------------------------------------
// IMPORT INTO and live sources
// ---------------------------------------------------------------------------------------------
test('IMPORT INTO pulls a SELECT from a live source, translated into its dialect, only at the top level', () => {
  const c = compileScript("IMPORT INTO erp_orders FROM SOURCE erp AS (SELECT TOP 10 [id], ISNULL([qty], 0) AS qty FROM [orders] WHERE opened >= '2026-01-01');\nSELECT COUNT(*) FROM erp_orders;", 'tsql', { sources: { erp: 'oracle' } });
  assert.deepEqual(c.errors, []);
  const imp = c.plan.nodes[0]!;
  assert.equal(imp.op, 'import');
  if (imp.op === 'import') {
    assert.equal(imp.table, 'erp_orders');
    assert.equal(imp.mode, 'replace');
    assert.equal(imp.source, 'erp');
    assert.equal(imp.sql, `SELECT "id", COALESCE("qty", 0) AS qty FROM "orders" WHERE opened >= '2026-01-01'\nFETCH FIRST 10 ROWS ONLY`);
  }
  const bad = compileScript('BEGIN TRY IMPORT INTO x APPEND FROM SOURCE nowhere AS (DELETE FROM t) END TRY BEGIN CATCH PRINT 1 END CATCH', 'tsql', { sources: {} });
  assert.ok(bad.errors.some((e) => /only at the top/.test(e.message)));
  assert.ok(bad.errors.some((e) => /no source "nowhere"/.test(e.message)));
  assert.ok(bad.errors.some((e) => /one SELECT/.test(e.message)));
});

test('against a live source only SELECTs run, translated into its dialect', () => {
  const r = compileReadOnly('SELECT TOP 5 a FROM t;\nUPDATE t SET a = 1;\nSELECT 2', 'tsql', 'postgres', 'ERP');
  assert.deepEqual(
    r.statements.map((s) => s.sql),
    ['SELECT a FROM t\nLIMIT 5', 'SELECT 2'],
  );
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.line, 2);
  assert.match(r.errors[0]!.message, /read-only/);
});

test('the plan is plain JSON: every node has a line and every SQL text is one statement', () => {
  const c = compileScript('DECLARE @a INT = 1; IF @a = 1 BEGIN SELECT 1; SELECT 2; END ELSE SELECT 3;', 'tsql');
  const round = JSON.parse(JSON.stringify(c.plan));
  assert.deepEqual(round, c.plan);
  for (const s of planSql(c.plan.nodes)) assert.ok(!/;\s*\S/.test(s), s);
  assert.equal(c.statements, 2);
});

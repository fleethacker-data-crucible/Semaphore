// Semaphore local database: the write-capable script runner and the dataset exports. Compiled in the
// same Add-Type call as LocalDb.cs (one assembly, so it uses the internal Native entry points), never on
// the read-only query path.
//
// C# 5 only (Windows PowerShell 5.1 Add-Type): no string interpolation, no ?., no nameof, no
// exception filters, no expression-bodied members.
//
// ScriptRunner runs a plan (src/core/script.ts, validated in LocalScript.ps1) on a ReadWrite connection:
//   - every segment in one BEGIN IMMEDIATE ... COMMIT (ROLLBACK on an error), try nodes in SAVEPOINTs;
//   - an authorizer on the connection refuses ATTACH / DETACH, PRAGMA other than the safe reads,
//     load_extension, transactions and savepoints the runner did not open, triggers, virtual tables and
//     any write to a _semaphore* table; VACUUM is refused by its first word; SQLITE_LIMIT_ATTACHED is 0;
//   - variables are bound to named parameters (@name, :name, $name); loops and statements are bounded;
//   - results: rows for statements that return rows (capped), changes for writes, timings, and an error
//     that names the statement and its line.
//
// LocalTableExport writes one table to CSV, a one-table SQLite file (a new file filled through its own
// write connection: no ATTACH anywhere) or Excel (.xlsx, at most 1,048,575 data rows).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Threading;

namespace SemLocal
{
    [SuppressUnmanagedCodeSecurity]
    internal static class ScriptNative
    {
        const string Dll = "winsqlite3.dll";
        const CallingConvention CC = CallingConvention.StdCall;
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_bind_parameter_name(IntPtr stmt, int index);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_stmt_readonly(IntPtr stmt);
    }

    public sealed class ScriptNode
    {
        public string Op;
        public string Sql;
        public string[] Names;
        public string Mode;
        public string Table;
        public string Source;
        public int Line;
        public int Max;
        public List<ScriptNode> Body = new List<ScriptNode>();
        public List<ScriptNode> Else = new List<ScriptNode>();
        public List<ScriptNode> Step = new List<ScriptNode>();
    }

    public sealed class ScriptResult
    {
        public int Line;
        public string Sql;
        public string Kind;          // rows | changes | message
        public string[] Columns;
        public List<object[]> Rows;
        public bool Truncated;
        public long Changes;
        public long Ms;
        public string Message;
    }

    [Serializable]
    public sealed class ScriptException : Exception
    {
        public int Line;
        public string Sql;
        public bool Fatal;            // not caught by a try node (refusals, limits, time-outs)
        public int Code;
        public ScriptException(string message, int line, string sql, bool fatal, int code) : base(message) { Line = line; Sql = sql; Fatal = fatal; Code = code; }
    }

    internal sealed class FlowSignal : Exception
    {
        public readonly string Kind;  // break | continue | return
        public FlowSignal(string kind) : base(kind) { Kind = kind; }
    }

    public sealed class ScriptRunner : IDisposable
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        static readonly string[] ArgPragmas = { "table_info", "table_xinfo", "index_list", "index_info", "index_xinfo", "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check", "table_list" };
        static readonly string[] ReadPragmas = { "page_count", "page_size", "freelist_count" };

        readonly LocalConnection _conn;
        readonly AuthorizerCallback _auth;
        bool _internal;
        string _deny;
        int _savepoints;
        long _statements;
        readonly System.Diagnostics.Stopwatch _clock = new System.Diagnostics.Stopwatch();

        public readonly Dictionary<string, object> Vars = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        public readonly List<ScriptResult> Results = new List<ScriptResult>();
        public int ResultsDropped;
        public readonly HashSet<string> Written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> Dropped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public int RowCap = 500;
        public int MaxResults = 200;
        public long MaxStatements = 200000;
        public int TimeoutSec = 900;
        public int StatementTimeoutSec = 600;
        public string Label = "script";
        public volatile bool Cancelled;

        public ScriptRunner(LocalConnection conn)
        {
            if (conn == null || conn.IsReadOnly) throw new LocalException("The script runner needs a ReadWrite connection of its own.");
            _conn = conn;
            LocalImport.EnsureMeta(conn);   // before the authorizer, which refuses writes to _semaphore tables
            Native.sqlite3_limit(conn.Handle, 7, 0);   // SQLITE_LIMIT_ATTACHED
            _auth = new AuthorizerCallback(Authorize);
            Native.sqlite3_set_authorizer(conn.Handle, _auth, IntPtr.Zero);
            Vars["error_message"] = null;
            Vars["error_number"] = null;
        }

        public void Cancel()
        {
            Cancelled = true;
            _conn.Interrupt();
        }

        public void Dispose()
        {
            try { Native.sqlite3_set_authorizer(_conn.Handle, null, IntPtr.Zero); } catch { }
        }

        // ---- authorizer --------------------------------------------------------------------------
        static string Str(IntPtr p) { return p == IntPtr.Zero ? null : Marshal.PtrToStringAnsi(p); }

        static bool Mine(string table)
        {
            return table != null && table.StartsWith("_semaphore", StringComparison.OrdinalIgnoreCase);
        }

        int Deny(string why) { _deny = why; return 1; }

        int Authorize(IntPtr arg, int action, IntPtr a, IntPtr b, IntPtr c, IntPtr d)
        {
            if (_internal) return 0;
            string s1 = Str(a), s2 = Str(b), db = Str(c);
            switch (action)
            {
                case 24: return Deny("ATTACH is refused: a script works only on the local database itself.");
                case 25: return Deny("DETACH is refused: a script works only on the local database itself.");
                case 22: return Deny("BEGIN, COMMIT and ROLLBACK are refused: Semaphore runs the script in one transaction of its own.");
                case 32: return Deny("SAVEPOINT and RELEASE are refused: TRY...CATCH and EXCEPTION blocks make their own.");
                case 5: case 7: return Deny("Triggers are refused: a trigger would run later, outside the script and its checks.");
                case 29: case 30: return Deny("Virtual tables are refused in scripts.");
                case 19:
                    {
                        string name = (s1 ?? "").ToLowerInvariant();
                        if (Array.IndexOf(ArgPragmas, name) >= 0) return 0;
                        if (Array.IndexOf(ReadPragmas, name) >= 0 && s2 == null) return 0;
                        return Deny("PRAGMA " + name + " is refused: scripts may read only table_info, index_list, foreign_key_list, integrity_check and the page counts, and never set a pragma.");
                    }
                case 31:
                    {
                        string fn = (s2 ?? "").ToLowerInvariant();
                        if (fn == "load_extension" || fn == "fts3_tokenizer") return Deny(fn + " is refused: the local database runs only the SQL that ships with Windows.");
                        return 0;
                    }
                case 18: case 23: case 9:   // INSERT, UPDATE, DELETE: s1 = table
                    if (Mine(s1)) return Deny("Tables whose names start with _semaphore belong to Semaphore's own bookkeeping; a script may read them but never change them.");
                    if (s1 != null && s1.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase))
                    {
                        string l = s1.ToLowerInvariant();
                        if (l == "sqlite_master" || l == "sqlite_temp_master" || l == "sqlite_schema" || l == "sqlite_sequence" || l == "sqlite_stat1") return 0;
                        return Deny("The sqlite_ tables belong to the database engine.");
                    }
                    if (db == "main" && s1 != null) Written.Add(s1);
                    return 0;
                case 2: case 4: case 8: case 6:   // CREATE TABLE / TEMP TABLE / VIEW / TEMP VIEW: s1 = name
                    if (Mine(s1)) return Deny("Names starting with _semaphore are kept for Semaphore's own tables.");
                    if (action == 2 && s1 != null) Written.Add(s1);
                    return 0;
                case 11: case 13: case 17: case 15:   // DROP TABLE / TEMP TABLE / VIEW / TEMP VIEW
                    if (Mine(s1)) return Deny("Tables whose names start with _semaphore belong to Semaphore's own bookkeeping; a script may read them but never change them.");
                    if (action == 11 && s1 != null) Dropped.Add(s1);
                    return 0;
                case 26:   // ALTER TABLE: s1 = database, s2 = table
                    if (Mine(s2)) return Deny("Tables whose names start with _semaphore belong to Semaphore's own bookkeeping; a script may read them but never change them.");
                    if (s2 != null) { Written.Add(s2); Dropped.Add(s2); }
                    return 0;
                case 1: case 3: case 10: case 12:   // CREATE / DROP INDEX: s2 = table
                    if (Mine(s2)) return Deny("Tables whose names start with _semaphore belong to Semaphore's own bookkeeping; a script may read them but never change them.");
                    return 0;
                case 20: case 21: case 33: case 27: case 28: case 0:
                    return 0;
            }
            return 0;
        }

        void Internal(string sql)
        {
            bool was = _internal;
            _internal = true;
            try { _conn.Execute(sql); }
            finally { _internal = was; }
        }

        // ---- running -----------------------------------------------------------------------------
        public void SetVar(string name, object value) { Vars[name] = value; }

        /// <summary>Runs nodes in one transaction: committed when they all succeed, rolled back otherwise.</summary>
        public void RunSegment(List<ScriptNode> nodes)
        {
            if (!_clock.IsRunning) _clock.Start();
            Internal("BEGIN IMMEDIATE");
            bool done = false;
            try
            {
                try { RunList(nodes); }
                catch (FlowSignal f) { if (f.Kind != "return") throw new ScriptException(f.Kind.ToUpperInvariant() + " outside a loop.", 0, "", true, 1); }
                CheckNames();
                Internal("COMMIT");
                done = true;
            }
            finally
            {
                if (!done) { try { Internal("ROLLBACK"); } catch { } }
            }
            UpdateMeta();
        }

        /// <summary>true when a RETURN ended the script (the PowerShell side stops after this segment).</summary>
        public bool Returned;

        void RunList(List<ScriptNode> nodes)
        {
            foreach (ScriptNode n in nodes) RunNode(n);
        }

        void Check(ScriptNode n)
        {
            if (Cancelled) throw new ScriptException("The script was stopped.", n.Line, n.Sql ?? "", true, 9);
            if (++_statements > MaxStatements) throw new ScriptException("The script ran more than " + MaxStatements.ToString(Inv) + " statements; Semaphore stops it there.", n.Line, n.Sql ?? "", true, 1);
            if (_clock.Elapsed.TotalSeconds > TimeoutSec) throw new ScriptException("The script ran longer than " + TimeoutSec.ToString(Inv) + " s and was stopped.", n.Line, n.Sql ?? "", true, 9);
        }

        void RunNode(ScriptNode n)
        {
            Check(n);
            switch (n.Op)
            {
                case "sql": Exec(n.Sql, n.Line, true); break;
                case "declare":
                    Vars[n.Names[0]] = null;
                    if (!string.IsNullOrEmpty(n.Sql)) Vars[n.Names[0]] = Scalar(n.Sql, n.Line);
                    break;
                case "assign":
                    {
                        List<object[]> rows = Query(n.Sql, n.Line, n.Mode == "one" ? 2 : int.MaxValue);
                        if (n.Mode == "one" && rows.Count != 1) throw new ScriptException("Line " + n.Line.ToString(Inv) + ": " + (rows.Count == 0 ? "no row came back" : "more than one row came back") + " for SELECT ... INTO.", n.Line, n.Sql, false, 1403);
                        if (rows.Count > 0)
                        {
                            object[] last = rows[rows.Count - 1];
                            for (int i = 0; i < n.Names.Length; i++) Vars[n.Names[i]] = i < last.Length ? last[i] : null;
                        }
                        break;
                    }
                case "if":
                    RunList(Truthy(Scalar(n.Sql, n.Line)) ? n.Body : n.Else);
                    break;
                case "while":
                    {
                        int i = 0;
                        while (Truthy(Scalar(n.Sql, n.Line)))
                        {
                            if (++i > n.Max) throw new ScriptException("Line " + n.Line.ToString(Inv) + ": the loop ran " + n.Max.ToString(Inv) + " times; Semaphore stops loops there.", n.Line, n.Sql, true, 1);
                            bool stop = false;
                            try { RunList(n.Body); }
                            catch (FlowSignal f)
                            {
                                if (f.Kind == "break") stop = true;
                                else if (f.Kind != "continue") throw;
                            }
                            if (stop) break;
                            RunList(n.Step);
                            Check(n);
                        }
                        break;
                    }
                case "break":
                case "continue":
                    if (string.IsNullOrEmpty(n.Sql) || Truthy(Scalar(n.Sql, n.Line))) throw new FlowSignal(n.Op);
                    break;
                case "return":
                    Returned = true;
                    throw new FlowSignal("return");
                case "print":
                    AddResult(new ScriptResult { Line = n.Line, Kind = "message", Message = Text(Scalar(n.Sql, n.Line)), Sql = n.Sql });
                    break;
                case "raise":
                    {
                        object v = Scalar(n.Sql, n.Line);
                        string msg = v == null ? "The script raised an error." : Text(v);
                        throw new ScriptException(msg, n.Line, n.Sql, false, 50000);
                    }
                case "try":
                    {
                        string sp = "sem_try_" + (++_savepoints).ToString(Inv);
                        Internal("SAVEPOINT " + sp);
                        try
                        {
                            RunList(n.Body);
                            Internal("RELEASE " + sp);
                        }
                        catch (ScriptException e)
                        {
                            if (e.Fatal) { try { Internal("ROLLBACK TO " + sp); Internal("RELEASE " + sp); } catch { } throw; }
                            Internal("ROLLBACK TO " + sp);
                            Internal("RELEASE " + sp);
                            string m = e.Message;
                            string prefix = "Line " + e.Line.ToString(Inv) + ": ";
                            if (m.StartsWith(prefix, StringComparison.Ordinal)) m = m.Substring(prefix.Length);
                            Vars["error_message"] = m;
                            Vars["error_number"] = (long)e.Code;
                            RunList(n.Else);
                        }
                        catch (FlowSignal)
                        {
                            Internal("RELEASE " + sp);
                            throw;
                        }
                        break;
                    }
                default:
                    throw new ScriptException("Unknown step '" + n.Op + "'.", n.Line, "", true, 1);
            }
        }

        static bool Truthy(object v)
        {
            if (v == null || v is DBNull) return false;
            if (v is long) return (long)v != 0;
            if (v is double) return (double)v != 0;
            if (v is string) { double d; if (double.TryParse((string)v, NumberStyles.Float, Inv, out d)) return d != 0; return ((string)v).Length > 0; }
            return true;
        }

        static string Text(object v)
        {
            if (v == null || v is DBNull) return "";
            IFormattable f = v as IFormattable;
            return f != null ? f.ToString(null, Inv) : v.ToString();
        }

        void AddResult(ScriptResult r)
        {
            if (Results.Count < MaxResults) Results.Add(r);
            else ResultsDropped++;
        }

        // ---- statements ----------------------------------------------------------------------------
        IntPtr Prepare(string sql, int line)
        {
            if (sql == null || sql.Trim().Length == 0) throw new ScriptException("Line " + line.ToString(Inv) + ": an empty statement.", line, "", true, 1);
            string first = FirstWord(sql);
            if (first == "VACUUM") throw new ScriptException("Line " + line.ToString(Inv) + ": VACUUM (and VACUUM INTO) is refused: it rewrites or copies the whole database file.", line, sql, true, 23);
            IntPtr db = _conn.Handle;
            IntPtr stmt, tail;
            _deny = null;
            GCHandle pin = GCHandle.Alloc(sql, GCHandleType.Pinned);
            int rest;
            try
            {
                IntPtr start = pin.AddrOfPinnedObject();
                int rc = Native.sqlite3_prepare16_v2(db, start, sql.Length * 2, out stmt, out tail);
                if (rc != Native.OK)
                {
                    string why = _deny;
                    if (why != null) throw new ScriptException("Line " + line.ToString(Inv) + ": " + why, line, sql, true, 23);
                    throw new ScriptException("Line " + line.ToString(Inv) + ": " + Native.Uni(Native.sqlite3_errmsg16(db)), line, sql, false, rc);
                }
                long used = tail == IntPtr.Zero ? sql.Length * 2 : tail.ToInt64() - start.ToInt64();
                rest = (int)(used / 2);
            }
            finally { pin.Free(); }
            if (stmt == IntPtr.Zero) throw new ScriptException("Line " + line.ToString(Inv) + ": the statement is only a comment.", line, sql, true, 1);
            if (rest < sql.Length && !OnlyCommentsOrSpace(sql.Substring(rest)))
            {
                Native.sqlite3_finalize(stmt);
                throw new ScriptException("Line " + line.ToString(Inv) + ": one SQL statement per step (the plan holds more than one here).", line, sql, true, 1);
            }
            try { BindVars(stmt, line, sql); }
            catch { Native.sqlite3_finalize(stmt); throw; }
            return stmt;
        }

        static bool OnlyCommentsOrSpace(string s)
        {
            int i = 0;
            while (i < s.Length)
            {
                char c = s[i];
                if (char.IsWhiteSpace(c) || c == ';') { i++; continue; }
                if (c == '-' && i + 1 < s.Length && s[i + 1] == '-') { int j = s.IndexOf('\n', i); if (j < 0) return true; i = j + 1; continue; }
                if (c == '/' && i + 1 < s.Length && s[i + 1] == '*') { int j = s.IndexOf("*/", i + 2, StringComparison.Ordinal); if (j < 0) return true; i = j + 2; continue; }
                return false;
            }
            return true;
        }

        static string FirstWord(string sql)
        {
            int i = 0;
            while (i < sql.Length)
            {
                if (char.IsWhiteSpace(sql[i]) || sql[i] == '(' || sql[i] == ';') { i++; continue; }
                if (sql[i] == '-' && i + 1 < sql.Length && sql[i + 1] == '-') { int j = sql.IndexOf('\n', i); if (j < 0) return ""; i = j + 1; continue; }
                if (sql[i] == '/' && i + 1 < sql.Length && sql[i + 1] == '*') { int j = sql.IndexOf("*/", i + 2, StringComparison.Ordinal); if (j < 0) return ""; i = j + 2; continue; }
                break;
            }
            int k = i;
            while (k < sql.Length && char.IsLetter(sql[k])) k++;
            return sql.Substring(i, k - i).ToUpperInvariant();
        }

        void BindVars(IntPtr stmt, int line, string sql)
        {
            int n = Native.sqlite3_bind_parameter_count(stmt);
            for (int i = 1; i <= n; i++)
            {
                string raw = Str(ScriptNative.sqlite3_bind_parameter_name(stmt, i));
                if (string.IsNullOrEmpty(raw) || raw.Length < 2) throw new ScriptException("Line " + line.ToString(Inv) + ": a ? placeholder has no name; use @name.", line, sql, true, 1);
                string name = raw.Substring(1);
                object v;
                if (!Vars.TryGetValue(name, out v)) throw new ScriptException("Line " + line.ToString(Inv) + ": " + raw + " is not declared and was given no value.", line, sql, true, 1);
                LocalCommand.Bind(_conn, stmt, i, v);
            }
        }

        Timer StartTimer()
        {
            LocalConnection c = _conn;
            return new Timer(delegate (object s) { c.Interrupt(); }, null, (long)StatementTimeoutSec * 1000L, Timeout.Infinite);
        }

        static object Column(IntPtr stmt, int i)
        {
            switch (Native.sqlite3_column_type(stmt, i))
            {
                case Native.INTEGER: return Native.sqlite3_column_int64(stmt, i);
                case Native.FLOAT: return Native.sqlite3_column_double(stmt, i);
                case Native.TEXT: return Marshal.PtrToStringUni(Native.sqlite3_column_text16(stmt, i), Native.sqlite3_column_bytes16(stmt, i) / 2);
                case Native.BLOB:
                    {
                        int len = Native.sqlite3_column_bytes(stmt, i);
                        byte[] b = new byte[len];
                        if (len > 0) Marshal.Copy(Native.sqlite3_column_blob(stmt, i), b, 0, len);
                        return b;
                    }
            }
            return null;
        }

        ScriptException StepError(int rc, int line, string sql)
        {
            if ((rc & 0xFF) == Native.INTERRUPT)
            {
                if (Cancelled) return new ScriptException("The script was stopped.", line, sql, true, 9);
                return new ScriptException("Line " + line.ToString(Inv) + ": the statement ran longer than " + StatementTimeoutSec.ToString(Inv) + " s and was stopped.", line, sql, true, 9);
            }
            string why = _deny;
            if (why != null) return new ScriptException("Line " + line.ToString(Inv) + ": " + why, line, sql, true, 23);
            return new ScriptException("Line " + line.ToString(Inv) + ": " + Native.Uni(Native.sqlite3_errmsg16(_conn.Handle)), line, sql, false, rc & 0xFF);
        }

        /// <summary>Runs one statement and records its result (rows, capped, or changes).</summary>
        void Exec(string sql, int line, bool record)
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            IntPtr stmt = Prepare(sql, line);
            Timer t = StartTimer();
            try
            {
                int cols = Native.sqlite3_column_count(stmt);
                ScriptResult r = new ScriptResult { Line = line, Sql = sql };
                if (cols > 0)
                {
                    r.Kind = "rows";
                    r.Columns = new string[cols];
                    for (int i = 0; i < cols; i++) r.Columns[i] = Native.Uni(Native.sqlite3_column_name16(stmt, i));
                    r.Rows = new List<object[]>();
                    int rc;
                    while ((rc = Native.sqlite3_step(stmt)) == Native.ROW)
                    {
                        if (r.Rows.Count >= RowCap)
                        {
                            r.Truncated = true;
                            // A writing statement that returns rows (RETURNING) must still finish.
                            if (ScriptNative.sqlite3_stmt_readonly(stmt) != 0) { rc = Native.DONE; break; }
                            continue;
                        }
                        object[] row = new object[cols];
                        for (int i = 0; i < cols; i++) row[i] = Column(stmt, i);
                        r.Rows.Add(row);
                    }
                    if (rc != Native.DONE) throw StepError(rc, line, sql);
                }
                else
                {
                    r.Kind = "changes";
                    int rc;
                    while ((rc = Native.sqlite3_step(stmt)) == Native.ROW) { }
                    if (rc != Native.DONE) throw StepError(rc, line, sql);
                    r.Changes = ScriptNative.sqlite3_stmt_readonly(stmt) != 0 ? 0 : Native.sqlite3_changes(_conn.Handle);
                }
                r.Ms = sw.ElapsedMilliseconds;
                if (record) AddResult(r);
            }
            finally
            {
                t.Dispose();
                Native.sqlite3_finalize(stmt);
            }
        }

        List<object[]> Query(string sql, int line, int max)
        {
            IntPtr stmt = Prepare(sql, line);
            Timer t = StartTimer();
            try
            {
                int cols = Native.sqlite3_column_count(stmt);
                List<object[]> rows = new List<object[]>();
                int rc;
                while ((rc = Native.sqlite3_step(stmt)) == Native.ROW)
                {
                    object[] row = new object[cols];
                    for (int i = 0; i < cols; i++) row[i] = Column(stmt, i);
                    if (rows.Count < max) rows.Add(row);
                    else { rows[rows.Count - 1] = row; }
                }
                if (rc != Native.DONE) throw StepError(rc, line, sql);
                return rows;
            }
            finally
            {
                t.Dispose();
                Native.sqlite3_finalize(stmt);
            }
        }

        object Scalar(string sql, int line)
        {
            List<object[]> rows = Query(sql, line, 1);
            if (rows.Count == 0 || rows[0].Length == 0) return null;
            return rows[0][0];
        }

        // ---- after the statements ----------------------------------------------------------------
        void CheckNames()
        {
            // ALTER TABLE x RENAME TO _semaphore...: the authorizer sees only the old name.
            bool was = _internal;
            _internal = true;
            try
            {
                using (LocalCommand c = new LocalCommand(_conn, "SELECT name FROM sqlite_master WHERE name LIKE '\\_semaphore%' ESCAPE '\\' AND name NOT LIKE '\\_semaphore\\_stage\\_%' ESCAPE '\\' AND name <> '_semaphore_tables' AND type IN ('table','view') LIMIT 1"))
                {
                    object v = c.ExecuteScalar();
                    if (v != null && !(v is DBNull)) throw new ScriptException("A table may not be renamed to " + v + ": names starting with _semaphore are kept for Semaphore.", 0, "", true, 23);
                }
            }
            finally { _internal = was; }
        }

        /// <summary>Keeps _semaphore_tables in step: rows and columns of the tables the script wrote, and no row for a dropped one.</summary>
        void UpdateMeta()
        {
            bool was = _internal;
            _internal = true;
            try
            {
                List<string[]> user = _conn.UserTables();
                Dictionary<string, string> tables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (string[] t in user) if (t[1] == "TABLE") tables[t[0]] = t[0];
                foreach (string d in Dropped)
                {
                    if (tables.ContainsKey(d)) continue;
                    using (LocalCommand c = new LocalCommand(_conn, "DELETE FROM _semaphore_tables WHERE name = ?")) { c.Parameters.Add(new LocalParameter("n", d)); c.ExecuteNonQuery(); }
                }
                foreach (string w in Written)
                {
                    string name;
                    if (!tables.TryGetValue(w, out name)) continue;
                    long rows = _conn.ScalarLong("SELECT COUNT(*) FROM " + LocalConnection.Quote(name));
                    long cols = _conn.TableColumns(name).Count;
                    using (LocalCommand c = new LocalCommand(_conn, "UPDATE _semaphore_tables SET rows = ?, columns = ?, imported_at = ? WHERE name = ?"))
                    {
                        c.Parameters.Add(new LocalParameter("r", rows)); c.Parameters.Add(new LocalParameter("c", cols));
                        c.Parameters.Add(new LocalParameter("t", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", Inv))); c.Parameters.Add(new LocalParameter("n", name));
                        if (c.ExecuteNonQuery() > 0) continue;
                    }
                    using (LocalCommand c = new LocalCommand(_conn, "INSERT INTO _semaphore_tables (name, source, path, format, imported_at, rows, columns) VALUES (?, ?, NULL, 'script', ?, ?, ?)"))
                    {
                        c.Parameters.Add(new LocalParameter("n", name)); c.Parameters.Add(new LocalParameter("s", Label));
                        c.Parameters.Add(new LocalParameter("t", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", Inv)));
                        c.Parameters.Add(new LocalParameter("r", rows)); c.Parameters.Add(new LocalParameter("c", cols));
                        c.ExecuteNonQuery();
                    }
                }
            }
            catch { }
            finally { _internal = was; }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Dataset exports: CSV, a one-table SQLite file, Excel
    // ---------------------------------------------------------------------------------------------
    public static class LocalTableExport
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        public const long XlsxMaxRows = 1048575;   // plus the header row: Excel's 1,048,576

        static void CheckTable(LocalConnection conn, string table)
        {
            string bad = LocalImport.CheckTableName(table);
            if (bad != null) throw new LocalException(bad);
            if (!conn.TableExists(table)) throw new LocalException("No table named \"" + table + "\" in the local database.");
        }

        static string Select(LocalConnection conn, string table, out List<string[]> cols)
        {
            cols = conn.TableColumns(table);
            StringBuilder sb = new StringBuilder("SELECT ");
            for (int i = 0; i < cols.Count; i++) { if (i > 0) sb.Append(", "); sb.Append(LocalConnection.Quote(cols[i][0])); }
            sb.Append(" FROM ").Append(LocalConnection.Quote(table));
            return sb.ToString();
        }

        static object Raw(IntPtr stmt, int i)
        {
            switch (Native.sqlite3_column_type(stmt, i))
            {
                case Native.INTEGER: return Native.sqlite3_column_int64(stmt, i);
                case Native.FLOAT: return Native.sqlite3_column_double(stmt, i);
                case Native.TEXT: return Marshal.PtrToStringUni(Native.sqlite3_column_text16(stmt, i), Native.sqlite3_column_bytes16(stmt, i) / 2);
                case Native.BLOB:
                    {
                        int len = Native.sqlite3_column_bytes(stmt, i);
                        byte[] b = new byte[len];
                        if (len > 0) Marshal.Copy(Native.sqlite3_column_blob(stmt, i), b, 0, len);
                        return b;
                    }
            }
            return null;
        }

        delegate void RowSink(object[] row);

        static long Each(LocalConnection conn, string sql, int n, long max, RowSink sink, out bool more)
        {
            more = false;
            LocalCommand cmd = new LocalCommand(conn, sql);
            IntPtr stmt = cmd.PrepareStatement(false);
            long count = 0;
            try
            {
                object[] row = new object[n];
                int rc;
                while ((rc = Native.sqlite3_step(stmt)) == Native.ROW)
                {
                    if (count >= max) { more = true; break; }
                    for (int i = 0; i < n; i++) row[i] = Raw(stmt, i);
                    sink(row);
                    count++;
                }
                if (rc != Native.ROW && rc != Native.DONE) throw conn.Error(rc);
            }
            finally { Native.sqlite3_finalize(stmt); }
            return count;
        }

        // ---- CSV ---------------------------------------------------------------------------------
        static string CsvCell(object v, bool text)
        {
            if (v == null) return "";
            string s;
            if (v is byte[]) s = Convert.ToBase64String((byte[])v);
            else if (v is double) s = ((double)v).ToString("R", Inv);
            else { IFormattable f = v as IFormattable; s = f != null ? f.ToString(null, Inv) : v.ToString(); }
            // A text cell starting with = + - @ would be read as a formula by a spreadsheet.
            if (text && v is string && s.Length > 0 && "=+-@\t\r".IndexOf(s[0]) >= 0) s = "'" + s;
            if (s.IndexOfAny(new char[] { ',', '"', '\r', '\n' }) >= 0) s = "\"" + s.Replace("\"", "\"\"") + "\"";
            return s;
        }

        /// <summary>UTF-8 with a byte-order mark (Excel reads it right), RFC 4180 quoting; returns the rows written.</summary>
        public static long Csv(LocalConnection conn, string table, string path)
        {
            CheckTable(conn, table);
            List<string[]> cols;
            string sql = Select(conn, table, out cols);
            bool[] text = new bool[cols.Count];
            for (int i = 0; i < cols.Count; i++) { Kind k = Values.FromDecl(cols[i][1]); text[i] = k == Kind.Text || k == Kind.None; }
            using (StreamWriter w = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20), new UTF8Encoding(true), 1 << 16))
            {
                w.NewLine = "\r\n";
                for (int i = 0; i < cols.Count; i++) { if (i > 0) w.Write(','); w.Write(CsvCell(cols[i][0], false)); }
                w.WriteLine();
                StringBuilder sb = new StringBuilder(4096);
                bool more;
                return Each(conn, sql, cols.Count, long.MaxValue, delegate (object[] row)
                {
                    sb.Length = 0;
                    for (int i = 0; i < row.Length; i++) { if (i > 0) sb.Append(','); sb.Append(CsvCell(row[i], text[i])); }
                    w.WriteLine(sb.ToString());
                }, out more);
            }
        }

        // ---- SQLite ------------------------------------------------------------------------------
        /// <summary>A new SQLite file holding one table with the same declared types, filled through its own connection.</summary>
        public static long Sqlite(LocalConnection conn, string table, string path)
        {
            CheckTable(conn, table);
            List<string[]> cols;
            string sql = Select(conn, table, out cols);
            if (File.Exists(path)) File.Delete(path);
            using (LocalConnection outConn = new LocalConnection("Data Source=" + path + ";Mode=ReadWrite"))
            {
                outConn.Open();
                outConn.Execute("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF");
                StringBuilder create = new StringBuilder("CREATE TABLE ").Append(LocalConnection.Quote(table)).Append(" (");
                StringBuilder ins = new StringBuilder("INSERT INTO ").Append(LocalConnection.Quote(table)).Append(" VALUES (");
                for (int i = 0; i < cols.Count; i++)
                {
                    if (i > 0) { create.Append(", "); ins.Append(','); }
                    create.Append(LocalConnection.Quote(cols[i][0]));
                    string decl = cols[i][1];
                    bool safe = true;
                    foreach (char ch in decl ?? "") if (!(char.IsLetterOrDigit(ch) || ch == ' ' || ch == '(' || ch == ')' || ch == ',' || ch == '_')) safe = false;
                    if (safe && !string.IsNullOrEmpty(decl)) create.Append(' ').Append(decl);
                    ins.Append('?');
                }
                create.Append(')'); ins.Append(')');
                outConn.Execute(create.ToString());
                outConn.Execute("BEGIN");
                LocalCommand ic = new LocalCommand(outConn, ins.ToString());
                IntPtr st = ic.PrepareStatement(false);
                long n;
                try
                {
                    bool more;
                    n = Each(conn, sql, cols.Count, long.MaxValue, delegate (object[] row)
                    {
                        for (int i = 0; i < row.Length; i++) LocalCommand.Bind(outConn, st, i + 1, row[i]);
                        int rc = Native.sqlite3_step(st);
                        Native.sqlite3_reset(st);
                        if (rc != Native.DONE) throw outConn.Error(rc);
                    }, out more);
                }
                finally { Native.sqlite3_finalize(st); }
                outConn.Execute("COMMIT");
                return n;
            }
        }

        // ---- XLSX --------------------------------------------------------------------------------
        static string Xml(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                if (c == '<') sb.Append("&lt;");
                else if (c == '>') sb.Append("&gt;");
                else if (c == '&') sb.Append("&amp;");
                else if (c == '"') sb.Append("&quot;");
                else if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') continue;   // not allowed in XML
                else if (c >= 0xFFFE) continue;
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static string ColName(int i)
        {
            string s = "";
            i++;
            while (i > 0) { int m = (i - 1) % 26; s = (char)('A' + m) + s; i = (i - 1) / 26; }
            return s;
        }

        static void Entry(ZipArchive zip, string name, string text)
        {
            ZipArchiveEntry e = zip.CreateEntry(name, CompressionLevel.Fastest);
            using (StreamWriter w = new StreamWriter(e.Open(), new UTF8Encoding(false))) w.Write(text);
        }

        /// <summary>One sheet with a header row; dates as Excel dates; at most XlsxMaxRows rows (truncated tells when more were left out).</summary>
        public static long Xlsx(LocalConnection conn, string table, string path, out bool truncated)
        {
            CheckTable(conn, table);
            List<string[]> cols;
            string sql = Select(conn, table, out cols);
            Kind[] kinds = new Kind[cols.Count];
            for (int i = 0; i < cols.Count; i++) kinds[i] = Values.FromDecl(cols[i][1]);
            if (File.Exists(path)) File.Delete(path);
            long n;
            bool more = false;
            using (FileStream fs = new FileStream(path, FileMode.Create, FileAccess.ReadWrite))
            using (ZipArchive zip = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                Entry(zip, "[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>");
                Entry(zip, "_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
                string sheet = Xml(table.Length > 31 ? table.Substring(0, 31) : table);
                Entry(zip, "xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"" + sheet + "\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
                Entry(zip, "xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>");
                // Style 1: a date (yyyy-mm-dd), style 2: a date and time.
                Entry(zip, "xl/styles.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"yyyy-mm-dd\"/><numFmt numFmtId=\"165\" formatCode=\"yyyy-mm-dd hh:mm:ss\"/></numFmts><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"3\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/><xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/></cellXfs></styleSheet>");
                ZipArchiveEntry se = zip.CreateEntry("xl/worksheets/sheet1.xml", CompressionLevel.Fastest);
                using (StreamWriter w = new StreamWriter(se.Open(), new UTF8Encoding(false), 1 << 16))
                {
                    w.Write("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\">");
                    for (int i = 0; i < cols.Count; i++) w.Write("<c r=\"" + ColName(i) + "1\" t=\"inlineStr\"><is><t>" + Xml(cols[i][0]) + "</t></is></c>");
                    w.Write("</row>");
                    long r = 1;
                    StringBuilder sb = new StringBuilder(4096);
                    n = Each(conn, sql, cols.Count, XlsxMaxRows, delegate (object[] row)
                    {
                        r++;
                        sb.Length = 0;
                        string rs = r.ToString(Inv);
                        sb.Append("<row r=\"").Append(rs).Append("\">");
                        for (int i = 0; i < row.Length; i++)
                        {
                            object v = row[i];
                            if (v == null) continue;
                            string at = ColName(i) + rs;
                            if (kinds[i] == Kind.Boolean && v is long) { sb.Append("<c r=\"").Append(at).Append("\" t=\"b\"><v>").Append((long)v != 0 ? "1" : "0").Append("</v></c>"); continue; }
                            if (kinds[i] == Kind.Date && v is string)
                            {
                                DateTime d;
                                if (Values.TryAnyDate((string)v, out d))
                                {
                                    double serial = d.ToOADate();
                                    bool hasTime = d.TimeOfDay.Ticks != 0 || ((string)v).Length > 10;
                                    sb.Append("<c r=\"").Append(at).Append("\" s=\"").Append(hasTime ? "2" : "1").Append("\"><v>").Append(serial.ToString("R", Inv)).Append("</v></c>");
                                    continue;
                                }
                            }
                            if (v is long) { sb.Append("<c r=\"").Append(at).Append("\"><v>").Append(((long)v).ToString(Inv)).Append("</v></c>"); continue; }
                            if (v is double)
                            {
                                double dv = (double)v;
                                if (double.IsNaN(dv) || double.IsInfinity(dv)) continue;
                                sb.Append("<c r=\"").Append(at).Append("\"><v>").Append(dv.ToString("R", Inv)).Append("</v></c>");
                                continue;
                            }
                            string s = v is byte[] ? Convert.ToBase64String((byte[])v) : v.ToString();
                            if (s.Length > 32767) s = s.Substring(0, 32767);
                            sb.Append("<c r=\"").Append(at).Append("\" t=\"inlineStr\"><is><t xml:space=\"preserve\">").Append(Xml(s)).Append("</t></is></c>");
                        }
                        sb.Append("</row>");
                        w.Write(sb.ToString());
                    }, out more);
                    w.Write("</sheetData></worksheet>");
                }
            }
            truncated = more;
            return n;
        }
    }
}

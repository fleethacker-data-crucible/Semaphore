// Semaphore local database: ADO.NET over the SQLite engine that ships with Windows
// (C:\Windows\System32\winsqlite3.dll, stdcall exports), plus streaming importers.
//
// C# 5 only (Windows PowerShell 5.1 Add-Type): no string interpolation, no ?., no nameof, no
// expression-bodied members, no auto-property initializers.
//
// Classes
//   LocalConnection : DbConnection   "Data Source=<path>;Mode=ReadOnly|ReadWrite"
//   LocalCommand    : DbCommand      positional ? parameters, CommandTimeout via sqlite3_interrupt
//   LocalDataReader : DbDataReader   INTEGER long, REAL double, TEXT string, BLOB byte[], NULL DBNull;
//                                    declared DATE/DATETIME -> DateTime, BOOLEAN -> bool
//   LocalParameter(+Collection), LocalTransaction
//   LocalImport                      Csv, Xlsx, Sqlite, Columnar (parquet/arrow through SemColumnar)
//   LocalPaths                       which file paths may be opened (UNC allowlist, links resolved)
//
// Read-only connections (the query and profile path) are opened SQLITE_OPEN_READONLY, with
// PRAGMA query_only, no ATTACH (SQLITE_LIMIT_ATTACHED = 0) and an authorizer that allows only
// SELECT, READ, FUNCTION and RECURSIVE: a write, ATTACH or PRAGMA is refused at prepare time.
//
// Columnar hook: this file never names SemColumnar at compile time. LocalImport.Columnar finds
// the type named by LocalImport.ColumnarTypeName ("SemColumnar.ColumnarFiles") in the loaded
// assemblies, calls its static Open(string), and reads the returned ITableReader (Names, Types,
// Next(object[])) through a delegate bound to the interface method, so Columnar.cs is compiled
// on its own (before or after this file) and no adapter class is needed.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Threading;
using System.Xml;

namespace SemLocal
{
    // ---------------------------------------------------------------------------------------------
    // Native entry points
    // ---------------------------------------------------------------------------------------------
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int AuthorizerCallback(IntPtr arg, int action, IntPtr a, IntPtr b, IntPtr c, IntPtr d);

    [SuppressUnmanagedCodeSecurity]
    internal static class Native
    {
        const string Dll = "winsqlite3.dll";
        const CallingConvention CC = CallingConvention.StdCall;

        public const int OK = 0, ERROR = 1, BUSY = 5, LOCKED = 6, READONLY = 8, INTERRUPT = 9, AUTH = 23, ROW = 100, DONE = 101;
        public const int OPEN_READONLY = 0x1, OPEN_READWRITE = 0x2, OPEN_CREATE = 0x4, OPEN_URI = 0x40, OPEN_NOMUTEX = 0x8000;
        public const int INTEGER = 1, FLOAT = 2, TEXT = 3, BLOB = 4, NULL = 5;
        public static readonly IntPtr TRANSIENT = new IntPtr(-1);

        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_close_v2(IntPtr db);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_prepare16_v2(IntPtr db, IntPtr sql, int nBytes, out IntPtr stmt, out IntPtr tail);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_step(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_reset(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_bind_parameter_count(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CC, CharSet = CharSet.Unicode)] public static extern int sqlite3_bind_text16(IntPtr stmt, int index, string value, int nBytes, IntPtr destructor);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_bind_int64(IntPtr stmt, int index, long value);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_bind_double(IntPtr stmt, int index, double value);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_bind_null(IntPtr stmt, int index);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_bind_blob(IntPtr stmt, int index, byte[] value, int n, IntPtr destructor);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_column_count(IntPtr stmt);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_column_type(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern long sqlite3_column_int64(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern double sqlite3_column_double(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_column_text16(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_column_bytes16(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_column_blob(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_column_bytes(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_column_name16(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_column_decltype16(IntPtr stmt, int i);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_errmsg16(IntPtr db);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_exec(IntPtr db, byte[] sql, IntPtr callback, IntPtr arg, IntPtr errmsg);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_busy_timeout(IntPtr db, int ms);
        [DllImport(Dll, CallingConvention = CC)] public static extern void sqlite3_interrupt(IntPtr db);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_changes(IntPtr db);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_limit(IntPtr db, int id, int value);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_set_authorizer(IntPtr db, AuthorizerCallback cb, IntPtr arg);
        [DllImport(Dll, CallingConvention = CC)] public static extern int sqlite3_get_autocommit(IntPtr db);
        [DllImport(Dll, CallingConvention = CC)] public static extern IntPtr sqlite3_libversion();
        [DllImport(Dll, CallingConvention = CC, CharSet = CharSet.Unicode)] public static extern int sqlite3_win32_set_directory16(uint type, string value);
        // Variadic: always cdecl, whatever the DLL's convention for the other exports.
        [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)] public static extern int sqlite3_db_config(IntPtr db, int op, int value, IntPtr result);

        public static byte[] Utf8z(string s)
        {
            byte[] b = Encoding.UTF8.GetBytes(s);
            byte[] z = new byte[b.Length + 1];
            Buffer.BlockCopy(b, 0, z, 0, b.Length);
            return z;
        }

        public static string Uni(IntPtr p)
        {
            if (p == IntPtr.Zero) return null;
            return Marshal.PtrToStringUni(p);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------
    [Serializable]
    public class LocalException : DbException
    {
        readonly int _code;
        public LocalException(string message) : base(message) { _code = Native.ERROR; }
        public LocalException(string message, int code) : base(message) { _code = code; }
        public LocalException(string message, Exception inner) : base(message, inner) { _code = Native.ERROR; }
        public int Code { get { return _code; } }
        public override int ErrorCode { get { return _code; } }
    }

    // ---------------------------------------------------------------------------------------------
    // Connection
    // ---------------------------------------------------------------------------------------------
    public sealed class LocalConnection : DbConnection
    {
        string _cs = "";
        string _path = "";
        bool _readOnly = true;
        ConnectionState _state = ConnectionState.Closed;
        IntPtr _db = IntPtr.Zero;
        AuthorizerCallback _auth;          // kept alive for as long as the connection is open
        readonly object _gate = new object();
        int _busyMs = 5000;

        public LocalConnection() { }
        public LocalConnection(string connectionString) { ConnectionString = connectionString; }

        public static string Version { get { return Marshal.PtrToStringAnsi(Native.sqlite3_libversion()); } }

        /// <summary>Where SQLite writes temporary files (large sorts and indexes), for the whole process.</summary>
        public static void SetTempDirectory(string dir)
        {
            int rc = Native.sqlite3_win32_set_directory16(2, dir);
            if (rc != Native.OK) throw new LocalException("Could not set the SQLite temp directory (code " + rc.ToString(CultureInfo.InvariantCulture) + ").", rc);
        }

        public override string ConnectionString
        {
            get { return _cs; }
            set
            {
                if (_state != ConnectionState.Closed) throw new InvalidOperationException("Close the connection before changing its connection string.");
                _cs = value ?? "";
                _path = ""; _readOnly = true; _busyMs = 5000;
                foreach (string part in _cs.Split(';'))
                {
                    int eq = part.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = part.Substring(0, eq).Trim().ToLowerInvariant().Replace(" ", "");
                    string v = part.Substring(eq + 1).Trim();
                    if (k == "datasource" || k == "filename") _path = v.Trim('"');
                    else if (k == "mode")
                    {
                        string m = v.ToLowerInvariant();
                        if (m == "readonly") _readOnly = true;
                        else if (m == "readwrite" || m == "readwritecreate") _readOnly = false;
                        else throw new ArgumentException("Mode must be ReadOnly or ReadWrite.");
                    }
                    else if (k == "busytimeout")
                    {
                        int ms;
                        if (int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out ms) && ms >= 0) _busyMs = ms;
                    }
                }
            }
        }

        public bool IsReadOnly { get { return _readOnly; } }
        public string FilePath { get { return _path; } }
        public override string Database { get { return "main"; } }
        public override string DataSource { get { return _path; } }
        public override string ServerVersion { get { return Version; } }
        public override ConnectionState State { get { return _state; } }
        public override int ConnectionTimeout { get { return _busyMs / 1000; } }

        internal IntPtr Handle
        {
            get
            {
                if (_state != ConnectionState.Open) throw new InvalidOperationException("The connection is not open.");
                return _db;
            }
        }

        public override void Open()
        {
            if (_state == ConnectionState.Open) return;
            if (string.IsNullOrEmpty(_path)) throw new InvalidOperationException("The connection string has no Data Source.");
            int flags = Native.OPEN_NOMUTEX;
            if (_readOnly) flags |= Native.OPEN_READONLY;
            else flags |= Native.OPEN_READWRITE | Native.OPEN_CREATE | Native.OPEN_URI;
            IntPtr db;
            int rc = Native.sqlite3_open_v2(Native.Utf8z(_path), out db, flags, IntPtr.Zero);
            if (rc != Native.OK)
            {
                string msg = db != IntPtr.Zero ? Native.Uni(Native.sqlite3_errmsg16(db)) : null;
                if (db != IntPtr.Zero) Native.sqlite3_close_v2(db);
                throw new LocalException("Could not open the local database: " + (msg ?? ("code " + rc.ToString(CultureInfo.InvariantCulture))), rc);
            }
            _db = db;
            _state = ConnectionState.Open;
            try
            {
                Native.sqlite3_busy_timeout(_db, _busyMs);
                try { Native.sqlite3_db_config(_db, 1010, 1, IntPtr.Zero); } catch { }   // SQLITE_DBCONFIG_DEFENSIVE
                if (_readOnly)
                {
                    Execute("PRAGMA query_only = 1; PRAGMA temp_store = 1; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456");
                    Native.sqlite3_limit(_db, 7, 0);   // SQLITE_LIMIT_ATTACHED: no ATTACH on the query path
                    _auth = new AuthorizerCallback(ReadOnlyAuthorizer);
                    Native.sqlite3_set_authorizer(_db, _auth, IntPtr.Zero);
                }
            }
            catch
            {
                Close();
                throw;
            }
        }

        // SQLITE_READ 20, SQLITE_SELECT 21, SQLITE_FUNCTION 31, SQLITE_RECURSIVE 33, and SQLITE_PRAGMA 19 for the
        // schema-reading pragmas only (pragma_table_info for GetSchema); everything else is denied.
        static readonly string[] ReadPragmas = { "table_info", "table_xinfo", "index_list", "index_info" };

        static int ReadOnlyAuthorizer(IntPtr arg, int action, IntPtr a, IntPtr b, IntPtr c, IntPtr d)
        {
            if (action == 20 || action == 21 || action == 31 || action == 33) return 0;
            if (action == 19 && a != IntPtr.Zero)
            {
                string name = Marshal.PtrToStringAnsi(a);
                if (name != null && Array.IndexOf(ReadPragmas, name.ToLowerInvariant()) >= 0) return 0;
            }
            return 1;   // SQLITE_DENY
        }

        public override void Close()
        {
            lock (_gate)
            {
                if (_db != IntPtr.Zero)
                {
                    Native.sqlite3_close_v2(_db);
                    _db = IntPtr.Zero;
                }
                _state = ConnectionState.Closed;
            }
        }

        /// <summary>Stops whatever statement is running on this connection (any thread).</summary>
        public void Interrupt()
        {
            lock (_gate)
            {
                if (_db != IntPtr.Zero) Native.sqlite3_interrupt(_db);
            }
        }

        public override void ChangeDatabase(string databaseName) { throw new NotSupportedException("The local database has one database."); }

        protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
        {
            Execute("BEGIN IMMEDIATE");
            return new LocalTransaction(this, isolationLevel);
        }

        protected override DbCommand CreateDbCommand() { return new LocalCommand(this); }

        public new LocalCommand CreateCommand() { return new LocalCommand(this); }

        /// <summary>Runs one or more statements with no result (setup, pragmas, BEGIN/COMMIT).</summary>
        public void Execute(string sql)
        {
            int rc = Native.sqlite3_exec(Handle, Native.Utf8z(sql), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (rc != Native.OK) throw Error(rc);
        }

        public object Scalar(string sql)
        {
            using (LocalCommand c = new LocalCommand(this, sql)) { return c.ExecuteScalar(); }
        }

        public long ScalarLong(string sql)
        {
            object v = Scalar(sql);
            if (v == null || v is DBNull) return 0;
            return Convert.ToInt64(v, CultureInfo.InvariantCulture);
        }

        public bool TableExists(string name)
        {
            using (LocalCommand c = new LocalCommand(this, "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? COLLATE NOCASE"))
            {
                c.Parameters.Add(new LocalParameter("name", name));
                object v = c.ExecuteScalar();
                return v != null && !(v is DBNull);
            }
        }

        public bool InTransaction { get { return Native.sqlite3_get_autocommit(Handle) == 0; } }

        internal LocalException Error(int rc)
        {
            string msg = _db != IntPtr.Zero ? Native.Uni(Native.sqlite3_errmsg16(_db)) : null;
            if (string.IsNullOrEmpty(msg)) msg = "SQLite error " + rc.ToString(CultureInfo.InvariantCulture);
            int primary = rc & 0xFF;
            if (primary == Native.READONLY || primary == Native.AUTH) msg = "The local database is read-only here: Semaphore only reads on the query path (" + msg + ").";
            return new LocalException(msg, rc);
        }

        public override DataTable GetSchema() { return GetSchema("MetaDataCollections", null); }
        public override DataTable GetSchema(string collectionName) { return GetSchema(collectionName, null); }

        public override DataTable GetSchema(string collectionName, string[] restrictionValues)
        {
            string name = (collectionName ?? "").ToLowerInvariant();
            if (name == "metadatacollections")
            {
                DataTable m = new DataTable("MetaDataCollections");
                m.Locale = CultureInfo.InvariantCulture;
                m.Columns.Add("CollectionName", typeof(string));
                m.Columns.Add("NumberOfRestrictions", typeof(int));
                m.Columns.Add("NumberOfIdentifierParts", typeof(int));
                m.Rows.Add("MetaDataCollections", 0, 0);
                m.Rows.Add("Tables", 4, 3);
                m.Rows.Add("Columns", 4, 4);
                return m;
            }
            if (name == "tables") return SchemaTables(restrictionValues);
            if (name == "columns") return SchemaColumns(restrictionValues);
            throw new ArgumentException("The local database has the schema collections Tables and Columns.");
        }

        static string Restriction(string[] r, int i)
        {
            if (r == null || r.Length <= i) return null;
            return r[i];
        }

        DataTable SchemaTables(string[] r)
        {
            // Restrictions: catalog, schema, table name, table type (like OLE DB / ODBC).
            DataTable t = new DataTable("Tables");
            t.Locale = CultureInfo.InvariantCulture;
            t.Columns.Add("TABLE_CATALOG", typeof(string));
            t.Columns.Add("TABLE_SCHEMA", typeof(string));
            t.Columns.Add("TABLE_NAME", typeof(string));
            t.Columns.Add("TABLE_TYPE", typeof(string));
            string want = Restriction(r, 2);
            string type = Restriction(r, 3);
            foreach (string[] row in UserTables())
            {
                if (want != null && !string.Equals(want, row[0], StringComparison.OrdinalIgnoreCase)) continue;
                if (type != null && !string.Equals(type, row[1], StringComparison.OrdinalIgnoreCase)) continue;
                t.Rows.Add("main", DBNull.Value, row[0], row[1]);
            }
            return t;
        }

        DataTable SchemaColumns(string[] r)
        {
            DataTable t = new DataTable("Columns");
            t.Locale = CultureInfo.InvariantCulture;
            t.Columns.Add("TABLE_CATALOG", typeof(string));
            t.Columns.Add("TABLE_SCHEMA", typeof(string));
            t.Columns.Add("TABLE_NAME", typeof(string));
            t.Columns.Add("COLUMN_NAME", typeof(string));
            t.Columns.Add("ORDINAL_POSITION", typeof(int));
            t.Columns.Add("DATA_TYPE", typeof(string));
            t.Columns.Add("IS_NULLABLE", typeof(string));
            string want = Restriction(r, 2);
            string col = Restriction(r, 3);
            foreach (string[] row in UserTables())
            {
                if (want != null && !string.Equals(want, row[0], StringComparison.OrdinalIgnoreCase)) continue;
                List<string[]> cols = TableColumns(row[0]);
                for (int i = 0; i < cols.Count; i++)
                {
                    if (col != null && !string.Equals(col, cols[i][0], StringComparison.OrdinalIgnoreCase)) continue;
                    t.Rows.Add("main", DBNull.Value, row[0], cols[i][0], i + 1, cols[i][1], cols[i][2] == "1" ? "NO" : "YES");
                }
            }
            return t;
        }

        /// <summary>[name, 'TABLE'|'VIEW'] of the user's tables: not sqlite_* and not Semaphore's own _semaphore* tables.</summary>
        public List<string[]> UserTables()
        {
            List<string[]> list = new List<string[]>();
            using (LocalCommand c = new LocalCommand(this, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_semaphore%' ESCAPE '\\' ORDER BY name"))
            using (DbDataReader rd = c.ExecuteReader())
            {
                while (rd.Read()) list.Add(new string[] { rd.GetString(0), rd.GetString(1) == "view" ? "VIEW" : "TABLE" });
            }
            return list;
        }

        /// <summary>[name, declared type, notnull] per column, through pragma_table_info (works on read-only connections).</summary>
        public List<string[]> TableColumns(string table)
        {
            List<string[]> list = new List<string[]>();
            using (LocalCommand c = new LocalCommand(this, "SELECT name, type, \"notnull\" FROM pragma_table_info(?)"))
            {
                c.Parameters.Add(new LocalParameter("t", table));
                using (DbDataReader rd = c.ExecuteReader())
                {
                    while (rd.Read()) list.Add(new string[] { rd.GetString(0), rd.IsDBNull(1) ? "" : rd.GetString(1), Convert.ToString(rd.GetValue(2), CultureInfo.InvariantCulture) });
                }
            }
            return list;
        }

        protected override void Dispose(bool disposing)
        {
            Close();
            base.Dispose(disposing);
        }

        public static string Quote(string name)
        {
            return "\"" + (name ?? "").Replace("\"", "\"\"") + "\"";
        }
    }

    public sealed class LocalTransaction : DbTransaction
    {
        LocalConnection _conn;
        readonly IsolationLevel _level;
        internal LocalTransaction(LocalConnection conn, IsolationLevel level) { _conn = conn; _level = level; }
        public override IsolationLevel IsolationLevel { get { return _level; } }
        protected override DbConnection DbConnection { get { return _conn; } }
        public override void Commit() { if (_conn == null) throw new InvalidOperationException("The transaction has ended."); _conn.Execute("COMMIT"); _conn = null; }
        public override void Rollback() { if (_conn == null) return; try { _conn.Execute("ROLLBACK"); } finally { _conn = null; } }
        protected override void Dispose(bool disposing) { if (disposing && _conn != null) { try { Rollback(); } catch { } } base.Dispose(disposing); }
    }

    // ---------------------------------------------------------------------------------------------
    // Command
    // ---------------------------------------------------------------------------------------------
    public sealed class LocalCommand : DbCommand
    {
        LocalConnection _conn;
        string _text = "";
        int _timeout = 30;
        readonly LocalParameterCollection _params = new LocalParameterCollection();
        Timer _timer;
        volatile bool _timedOut;
        volatile bool _cancelled;
        volatile bool _inStep;

        public LocalCommand() { }
        public LocalCommand(LocalConnection conn) { _conn = conn; }
        public LocalCommand(LocalConnection conn, string sql) { _conn = conn; _text = sql ?? ""; }

        public override string CommandText { get { return _text; } set { _text = value ?? ""; } }
        public override int CommandTimeout { get { return _timeout; } set { if (value < 0) throw new ArgumentException("CommandTimeout must be 0 or more."); _timeout = value; } }
        public override CommandType CommandType { get { return CommandType.Text; } set { if (value != CommandType.Text) throw new NotSupportedException("Only CommandType.Text."); } }
        public override bool DesignTimeVisible { get { return false; } set { } }
        public override UpdateRowSource UpdatedRowSource { get { return UpdateRowSource.None; } set { } }
        protected override DbConnection DbConnection { get { return _conn; } set { _conn = (LocalConnection)value; } }
        protected override DbParameterCollection DbParameterCollection { get { return _params; } }
        protected override DbTransaction DbTransaction { get { return null; } set { } }
        public new LocalParameterCollection Parameters { get { return _params; } }
        internal bool Cancelled { get { return _cancelled; } }

        public override void Cancel()
        {
            _cancelled = true;
            if (_inStep && _conn != null) _conn.Interrupt();
        }

        public override void Prepare() { }
        protected override DbParameter CreateDbParameter() { return new LocalParameter(); }
        public new LocalParameter CreateParameter() { return new LocalParameter(); }

        internal IntPtr PrepareStatement() { return PrepareStatement(true); }

        internal IntPtr PrepareStatement(bool bind)
        {
            if (_conn == null) throw new InvalidOperationException("The command has no connection.");
            IntPtr db = _conn.Handle;
            string sql = _text;
            if (sql.Trim().Length == 0) throw new LocalException("No SQL statement.");
            IntPtr stmt, tail;
            GCHandle pin = GCHandle.Alloc(sql, GCHandleType.Pinned);
            int rest;
            try
            {
                IntPtr start = pin.AddrOfPinnedObject();
                int rc = Native.sqlite3_prepare16_v2(db, start, sql.Length * 2, out stmt, out tail);
                if (rc != Native.OK) throw _conn.Error(rc);
                long used = tail == IntPtr.Zero ? sql.Length * 2 : tail.ToInt64() - start.ToInt64();
                rest = (int)(used / 2);
            }
            finally { pin.Free(); }
            if (stmt == IntPtr.Zero) throw new LocalException("No SQL statement.");
            if (rest < sql.Length && sql.Substring(rest).Trim().Length > 0)
            {
                Native.sqlite3_finalize(stmt);
                throw new LocalException("One SQL statement at a time.");
            }
            if (!bind) return stmt;
            try { BindAll(stmt); }
            catch { Native.sqlite3_finalize(stmt); throw; }
            return stmt;
        }

        void BindAll(IntPtr stmt)
        {
            int n = Native.sqlite3_bind_parameter_count(stmt);
            if (n != _params.Count)
                throw new LocalException("The SQL has " + n.ToString(CultureInfo.InvariantCulture) + " placeholders but the command has " + _params.Count.ToString(CultureInfo.InvariantCulture) + " parameters.");
            for (int i = 0; i < n; i++) Bind(_conn, stmt, i + 1, _params[i].Value);
        }

        internal static void Bind(LocalConnection conn, IntPtr stmt, int index, object v)
        {
            int rc;
            if (v == null || v is DBNull) rc = Native.sqlite3_bind_null(stmt, index);
            else if (v is string) { string s = (string)v; rc = Native.sqlite3_bind_text16(stmt, index, s, s.Length * 2, Native.TRANSIENT); }
            else if (v is bool) rc = Native.sqlite3_bind_int64(stmt, index, ((bool)v) ? 1 : 0);
            else if (v is long) rc = Native.sqlite3_bind_int64(stmt, index, (long)v);
            else if (v is int || v is short || v is byte || v is sbyte || v is ushort || v is uint) rc = Native.sqlite3_bind_int64(stmt, index, Convert.ToInt64(v, CultureInfo.InvariantCulture));
            else if (v is ulong)
            {
                ulong u = (ulong)v;
                if (u <= long.MaxValue) rc = Native.sqlite3_bind_int64(stmt, index, (long)u);
                else rc = Native.sqlite3_bind_double(stmt, index, (double)u);
            }
            else if (v is double) rc = Native.sqlite3_bind_double(stmt, index, (double)v);
            else if (v is float) rc = Native.sqlite3_bind_double(stmt, index, (double)(float)v);
            else if (v is decimal) rc = Native.sqlite3_bind_double(stmt, index, (double)(decimal)v);
            else if (v is DateTime) { string s = Values.DateText((DateTime)v); rc = Native.sqlite3_bind_text16(stmt, index, s, s.Length * 2, Native.TRANSIENT); }
            else if (v is DateTimeOffset) { string s = Values.DateText(((DateTimeOffset)v).UtcDateTime); rc = Native.sqlite3_bind_text16(stmt, index, s, s.Length * 2, Native.TRANSIENT); }
            else if (v is byte[]) { byte[] b = (byte[])v; rc = Native.sqlite3_bind_blob(stmt, index, b, b.Length, Native.TRANSIENT); }
            else if (v is Enum) rc = Native.sqlite3_bind_int64(stmt, index, Convert.ToInt64(v, CultureInfo.InvariantCulture));
            else
            {
                IFormattable f = v as IFormattable;
                string s = f != null ? f.ToString(null, CultureInfo.InvariantCulture) : v.ToString();
                rc = Native.sqlite3_bind_text16(stmt, index, s, s.Length * 2, Native.TRANSIENT);
            }
            if (rc != Native.OK) throw conn.Error(rc);
        }

        internal void StartTimer()
        {
            _timedOut = false;
            _cancelled = false;
            StopTimer();
            if (_timeout > 0)
            {
                LocalConnection conn = _conn;
                _timer = new Timer(delegate (object state) { _timedOut = true; conn.Interrupt(); }, null, (long)_timeout * 1000L, Timeout.Infinite);
            }
        }

        internal void StopTimer()
        {
            Timer t = _timer;
            _timer = null;
            if (t != null) t.Dispose();
        }

        internal int Step(IntPtr stmt)
        {
            _inStep = true;
            try { return Native.sqlite3_step(stmt); }
            finally { _inStep = false; }
        }

        internal Exception StepError(int rc)
        {
            if ((rc & 0xFF) == Native.INTERRUPT)
            {
                if (_timedOut) return new LocalException("The query took longer than its time limit (timeout after " + _timeout.ToString(CultureInfo.InvariantCulture) + " s).", rc);
                return new LocalException("The query was cancelled.", rc);
            }
            return _conn.Error(rc);
        }

        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            IntPtr stmt = PrepareStatement();
            StartTimer();
            int rc = Step(stmt);
            if (rc != Native.ROW && rc != Native.DONE)
            {
                Exception e = StepError(rc);
                StopTimer();
                Native.sqlite3_finalize(stmt);
                throw e;
            }
            return new LocalDataReader(this, stmt, rc == Native.ROW, behavior);
        }

        public new LocalDataReader ExecuteReader() { return (LocalDataReader)ExecuteDbDataReader(CommandBehavior.Default); }

        public override int ExecuteNonQuery()
        {
            IntPtr stmt = PrepareStatement();
            StartTimer();
            try
            {
                int rc;
                while ((rc = Step(stmt)) == Native.ROW) { }
                if (rc != Native.DONE) throw StepError(rc);
                return Native.sqlite3_changes(_conn.Handle);
            }
            finally
            {
                StopTimer();
                Native.sqlite3_finalize(stmt);
            }
        }

        public override object ExecuteScalar()
        {
            using (DbDataReader r = ExecuteDbDataReader(CommandBehavior.Default))
            {
                if (!r.Read() || r.FieldCount == 0) return null;
                return r.GetValue(0);
            }
        }

        protected override void Dispose(bool disposing)
        {
            StopTimer();
            base.Dispose(disposing);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Values: declared type kinds and ISO text for dates
    // ---------------------------------------------------------------------------------------------
    internal enum Kind { None = 0, Boolean = 1, Integer = 2, Real = 3, Date = 4, Text = 5, Blob = 6 }

    internal static class Values
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        public static Kind FromDecl(string decl)
        {
            if (string.IsNullOrEmpty(decl)) return Kind.None;
            string d = decl.ToUpperInvariant();
            if (d.Contains("BOOL")) return Kind.Boolean;
            if (d.Contains("DATE") || d.Contains("TIMESTAMP")) return Kind.Date;
            if (d.Contains("INT")) return Kind.Integer;
            if (d.Contains("CHAR") || d.Contains("CLOB") || d.Contains("TEXT")) return Kind.Text;
            if (d.Contains("BLOB")) return Kind.Blob;
            return Kind.Real;   // REAL, FLOAT, DOUBLE, NUMERIC, DECIMAL and anything else numeric
        }

        /// <summary>yyyy-MM-dd at midnight, else yyyy-MM-dd HH:mm:ss[.fff] (SQLite's own date and time form).</summary>
        public static string DateText(DateTime d)
        {
            if (d.TimeOfDay == TimeSpan.Zero) return d.ToString("yyyy-MM-dd", Inv);
            if (d.Millisecond != 0) return d.ToString("yyyy-MM-dd HH:mm:ss.fff", Inv);
            return d.ToString("yyyy-MM-dd HH:mm:ss", Inv);
        }

        static int Digits(string s, int at, int n)
        {
            int v = 0;
            for (int i = at; i < at + n; i++)
            {
                char c = s[i];
                if (c < '0' || c > '9') return -1;
                v = v * 10 + (c - '0');
            }
            return v;
        }

        public static bool TryDate(string s, out DateTime d)
        {
            d = DateTime.MinValue;
            if (s == null || s.Length != 10 || s[4] != '-' || s[7] != '-') return false;
            int y = Digits(s, 0, 4), m = Digits(s, 5, 2), day = Digits(s, 8, 2);
            if (y < 1 || m < 1 || m > 12 || day < 1) return false;
            if (day > DateTime.DaysInMonth(y, m)) return false;
            d = new DateTime(y, m, day);
            return true;
        }

        /// <summary>yyyy-MM-dd[T ]HH:mm[:ss[.f+]][Z|+hh:mm|-hh:mm]; offsets are converted to UTC.</summary>
        public static bool TryDateTime(string s, out DateTime d)
        {
            d = DateTime.MinValue;
            if (s == null || s.Length < 16 || s.Length > 35) return false;
            if (s[10] != 'T' && s[10] != ' ') return false;
            DateTime day;
            if (!TryDate(s.Substring(0, 10), out day)) return false;
            if (s[13] != ':') return false;
            int h = Digits(s, 11, 2), mi = Digits(s, 14, 2), sec = 0;
            if (h < 0 || h > 23 || mi < 0 || mi > 59) return false;
            int i = 16;
            long fracTicks = 0;
            if (i < s.Length && s[i] == ':')
            {
                if (s.Length < 19) return false;
                sec = Digits(s, 17, 2);
                if (sec < 0 || sec > 59) return false;
                i = 19;
                if (i < s.Length && (s[i] == '.' || s[i] == ','))
                {
                    i++;
                    int start = i;
                    long scale = TimeSpan.TicksPerSecond;
                    while (i < s.Length && s[i] >= '0' && s[i] <= '9')
                    {
                        scale /= 10;
                        fracTicks += (s[i] - '0') * scale;
                        i++;
                    }
                    if (i == start) return false;
                }
            }
            DateTime v = day.AddHours(h).AddMinutes(mi).AddSeconds(sec).AddTicks(fracTicks);
            if (i < s.Length)
            {
                if (s[i] == 'Z' && i == s.Length - 1) { }
                else if ((s[i] == '+' || s[i] == '-') && s.Length - i == 6 && s[i + 3] == ':')
                {
                    int oh = Digits(s, i + 1, 2), om = Digits(s, i + 4, 2);
                    if (oh < 0 || oh > 14 || om < 0 || om > 59) return false;
                    TimeSpan off = new TimeSpan(oh, om, 0);
                    v = s[i] == '+' ? v - off : v + off;
                }
                else return false;
            }
            d = new DateTime((v.Ticks / TimeSpan.TicksPerMillisecond) * TimeSpan.TicksPerMillisecond);
            return true;
        }

        public static bool TryAnyDate(string s, out DateTime d)
        {
            if (TryDate(s, out d)) return true;
            return TryDateTime(s, out d);
        }

        /// <summary>A whole number without a leading zero (so "007" stays text) that fits a long.</summary>
        public static bool TryInt(string s, out long v)
        {
            v = 0;
            int n = s.Length;
            if (n == 0 || n > 20) return false;
            int i = 0;
            bool neg = false;
            if (s[0] == '-') { neg = true; i = 1; if (n == 1) return false; }
            if (s[i] == '0' && n - i > 1) return false;
            long acc = 0;
            for (; i < n; i++)
            {
                char c = s[i];
                if (c < '0' || c > '9') return false;
                int dg = c - '0';
                if (acc > (long.MaxValue - dg) / 10) return false;
                acc = acc * 10 + dg;
            }
            v = neg ? -acc : acc;
            return true;
        }

        /// <summary>An invariant decimal or exponent number ("1.5", "-0.25", "1e6"); no thousands separators, no leading zeros.</summary>
        public static bool TryReal(string s, out double v)
        {
            v = 0;
            int n = s.Length;
            if (n == 0 || n > 40) return false;
            int i = 0;
            if (s[0] == '-' || s[0] == '+') i = 1;
            int intStart = i;
            while (i < n && s[i] >= '0' && s[i] <= '9') i++;
            int intDigits = i - intStart;
            if (intDigits > 1 && s[intStart] == '0') return false;
            int fracDigits = 0;
            if (i < n && s[i] == '.')
            {
                i++;
                int fs = i;
                while (i < n && s[i] >= '0' && s[i] <= '9') i++;
                fracDigits = i - fs;
            }
            if (intDigits + fracDigits == 0) return false;
            if (i < n && (s[i] == 'e' || s[i] == 'E'))
            {
                i++;
                if (i < n && (s[i] == '+' || s[i] == '-')) i++;
                int es = i;
                while (i < n && s[i] >= '0' && s[i] <= '9') i++;
                if (i == es) return false;
            }
            if (i != n) return false;
            if (!double.TryParse(s, NumberStyles.Float, Inv, out v)) return false;
            return !(double.IsInfinity(v) || double.IsNaN(v));
        }

        public static bool TryBool(string s, out bool b)
        {
            b = false;
            if (s.Length == 4 && string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) { b = true; return true; }
            if (s.Length == 5 && string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Data reader
    // ---------------------------------------------------------------------------------------------
    public sealed class LocalDataReader : DbDataReader
    {
        LocalCommand _cmd;
        IntPtr _stmt;
        readonly CommandBehavior _behavior;
        readonly bool _hasRows;
        bool _first = true;
        bool _done;
        bool _onRow;
        readonly int _fields;
        string[] _names;
        Kind[] _kinds;

        internal LocalDataReader(LocalCommand cmd, IntPtr stmt, bool hasRow, CommandBehavior behavior)
        {
            _cmd = cmd; _stmt = stmt; _hasRows = hasRow; _behavior = behavior;
            _fields = Native.sqlite3_column_count(stmt);
            _done = !hasRow;
        }

        void Check() { if (_stmt == IntPtr.Zero) throw new InvalidOperationException("The reader is closed."); }

        public override bool Read()
        {
            if (_stmt == IntPtr.Zero) return false;
            if (_first)
            {
                _first = false;
                _onRow = _hasRows;
                return _hasRows;
            }
            if (_done) { _onRow = false; return false; }
            if (_cmd.Cancelled) { _done = true; _onRow = false; return false; }
            int rc = _cmd.Step(_stmt);
            if (rc == Native.ROW) { _onRow = true; return true; }
            _done = true;
            _onRow = false;
            if (rc == Native.DONE) return false;
            throw _cmd.StepError(rc);
        }

        public override int FieldCount { get { return _fields; } }
        public override int VisibleFieldCount { get { return _fields; } }
        public override bool HasRows { get { return _hasRows; } }
        public override bool IsClosed { get { return _stmt == IntPtr.Zero; } }
        public override int RecordsAffected { get { return -1; } }
        public override int Depth { get { return 0; } }
        public override bool NextResult() { return false; }

        public override void Close()
        {
            if (_stmt != IntPtr.Zero)
            {
                Native.sqlite3_finalize(_stmt);
                _stmt = IntPtr.Zero;
            }
            if (_cmd != null)
            {
                _cmd.StopTimer();
                if ((_behavior & CommandBehavior.CloseConnection) != 0 && _cmd.Connection != null) _cmd.Connection.Close();
                _cmd = null;
            }
        }

        protected override void Dispose(bool disposing) { if (disposing) Close(); base.Dispose(disposing); }

        void Range(int i)
        {
            Check();
            if (i < 0 || i >= _fields) throw new IndexOutOfRangeException("No column " + i.ToString(CultureInfo.InvariantCulture) + ".");
        }

        public override string GetName(int i)
        {
            Range(i);
            if (_names == null)
            {
                _names = new string[_fields];
                for (int k = 0; k < _fields; k++) _names[k] = Native.Uni(Native.sqlite3_column_name16(_stmt, k)) ?? ("column" + (k + 1).ToString(CultureInfo.InvariantCulture));
            }
            return _names[i];
        }

        Kind KindOf(int i)
        {
            if (_kinds == null)
            {
                _kinds = new Kind[_fields];
                for (int k = 0; k < _fields; k++) _kinds[k] = Values.FromDecl(Native.Uni(Native.sqlite3_column_decltype16(_stmt, k)));
            }
            return _kinds[i];
        }

        public override int GetOrdinal(string name)
        {
            for (int i = 0; i < _fields; i++) if (string.Equals(GetName(i), name, StringComparison.Ordinal)) return i;
            for (int i = 0; i < _fields; i++) if (string.Equals(GetName(i), name, StringComparison.OrdinalIgnoreCase)) return i;
            throw new IndexOutOfRangeException("No column named " + name + ".");
        }

        public override string GetDataTypeName(int i)
        {
            Range(i);
            string d = Native.Uni(Native.sqlite3_column_decltype16(_stmt, i));
            if (!string.IsNullOrEmpty(d)) return d;
            return GetFieldType(i).Name;
        }

        public override Type GetFieldType(int i)
        {
            Range(i);
            switch (KindOf(i))
            {
                case Kind.Boolean: return typeof(bool);
                case Kind.Integer: return typeof(long);
                case Kind.Real: return typeof(double);
                case Kind.Date: return typeof(DateTime);
                case Kind.Text: return typeof(string);
                case Kind.Blob: return typeof(byte[]);
            }
            // An expression with no declared type: what the current (or first) row holds.
            if (_onRow || (_first && _hasRows))
            {
                switch (Native.sqlite3_column_type(_stmt, i))
                {
                    case Native.INTEGER: return typeof(long);
                    case Native.FLOAT: return typeof(double);
                    case Native.BLOB: return typeof(byte[]);
                }
            }
            return typeof(string);
        }

        void OnRow()
        {
            Check();
            if (!_onRow) throw new InvalidOperationException("No current row: call Read first.");
        }

        public override object GetValue(int i)
        {
            Range(i);
            OnRow();
            switch (Native.sqlite3_column_type(_stmt, i))
            {
                case Native.INTEGER:
                    {
                        long v = Native.sqlite3_column_int64(_stmt, i);
                        if (KindOf(i) == Kind.Boolean) return v != 0;
                        return v;
                    }
                case Native.FLOAT: return Native.sqlite3_column_double(_stmt, i);
                case Native.TEXT:
                    {
                        string s = Text(i);
                        if (KindOf(i) == Kind.Date)
                        {
                            DateTime d;
                            if (Values.TryAnyDate(s, out d)) return d;
                        }
                        return s;
                    }
                case Native.BLOB:
                    {
                        int n = Native.sqlite3_column_bytes(_stmt, i);
                        byte[] b = new byte[n];
                        if (n > 0) Marshal.Copy(Native.sqlite3_column_blob(_stmt, i), b, 0, n);
                        return b;
                    }
            }
            return DBNull.Value;
        }

        string Text(int i)
        {
            IntPtr p = Native.sqlite3_column_text16(_stmt, i);
            if (p == IntPtr.Zero) return "";
            int n = Native.sqlite3_column_bytes16(_stmt, i);
            return Marshal.PtrToStringUni(p, n / 2);
        }

        public override int GetValues(object[] values)
        {
            int n = Math.Min(values.Length, _fields);
            for (int i = 0; i < n; i++) values[i] = GetValue(i);
            return n;
        }

        public override bool IsDBNull(int i) { Range(i); OnRow(); return Native.sqlite3_column_type(_stmt, i) == Native.NULL; }
        public override object this[int i] { get { return GetValue(i); } }
        public override object this[string name] { get { return GetValue(GetOrdinal(name)); } }

        public override bool GetBoolean(int i) { object v = GetValue(i); if (v is bool) return (bool)v; return Convert.ToInt64(v, CultureInfo.InvariantCulture) != 0; }
        public override byte GetByte(int i) { return Convert.ToByte(GetValue(i), CultureInfo.InvariantCulture); }
        public override char GetChar(int i) { string s = GetString(i); return s.Length > 0 ? s[0] : '\0'; }
        public override DateTime GetDateTime(int i)
        {
            object v = GetValue(i);
            if (v is DateTime) return (DateTime)v;
            DateTime d;
            if (v is string && Values.TryAnyDate((string)v, out d)) return d;
            throw new InvalidCastException("The value is not a date.");
        }
        public override decimal GetDecimal(int i) { return Convert.ToDecimal(GetValue(i), CultureInfo.InvariantCulture); }
        public override double GetDouble(int i) { return Convert.ToDouble(GetValue(i), CultureInfo.InvariantCulture); }
        public override float GetFloat(int i) { return Convert.ToSingle(GetValue(i), CultureInfo.InvariantCulture); }
        public override Guid GetGuid(int i) { object v = GetValue(i); if (v is byte[]) return new Guid((byte[])v); return new Guid(Convert.ToString(v, CultureInfo.InvariantCulture)); }
        public override short GetInt16(int i) { return Convert.ToInt16(GetValue(i), CultureInfo.InvariantCulture); }
        public override int GetInt32(int i) { return Convert.ToInt32(GetValue(i), CultureInfo.InvariantCulture); }
        public override long GetInt64(int i) { return Convert.ToInt64(GetValue(i), CultureInfo.InvariantCulture); }
        public override string GetString(int i)
        {
            Range(i); OnRow();
            int t = Native.sqlite3_column_type(_stmt, i);
            if (t == Native.TEXT) return Text(i);
            if (t == Native.NULL) throw new InvalidCastException("The value is NULL.");
            return Convert.ToString(GetValue(i), CultureInfo.InvariantCulture);
        }

        public override long GetBytes(int i, long dataOffset, byte[] buffer, int bufferOffset, int length)
        {
            byte[] b = GetValue(i) as byte[];
            if (b == null) throw new InvalidCastException("The value is not a BLOB.");
            if (buffer == null) return b.Length;
            int n = (int)Math.Max(0, Math.Min(length, b.Length - dataOffset));
            if (n > 0) Array.Copy(b, dataOffset, buffer, bufferOffset, n);
            return n;
        }

        public override long GetChars(int i, long dataOffset, char[] buffer, int bufferOffset, int length)
        {
            string s = GetString(i);
            if (buffer == null) return s.Length;
            int n = (int)Math.Max(0, Math.Min(length, s.Length - dataOffset));
            if (n > 0) s.CopyTo((int)dataOffset, buffer, bufferOffset, n);
            return n;
        }

        public override IEnumerator GetEnumerator() { return new DbEnumerator(this); }

        public override DataTable GetSchemaTable()
        {
            Check();
            DataTable t = new DataTable("SchemaTable");
            t.Locale = CultureInfo.InvariantCulture;
            t.Columns.Add("ColumnName", typeof(string));
            t.Columns.Add("ColumnOrdinal", typeof(int));
            t.Columns.Add("ColumnSize", typeof(int));
            t.Columns.Add("DataType", typeof(Type));
            t.Columns.Add("DataTypeName", typeof(string));
            t.Columns.Add("AllowDBNull", typeof(bool));
            for (int i = 0; i < _fields; i++) t.Rows.Add(GetName(i), i, -1, GetFieldType(i), GetDataTypeName(i), true);
            return t;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Parameters
    // ---------------------------------------------------------------------------------------------
    public sealed class LocalParameter : DbParameter
    {
        string _name = "";
        object _value;
        DbType _type = DbType.String;
        int _size;
        string _source = "";

        public LocalParameter() { }
        public LocalParameter(string name, object value) { _name = name ?? ""; _value = value; }

        public override DbType DbType { get { return _type; } set { _type = value; } }
        public override ParameterDirection Direction { get { return ParameterDirection.Input; } set { if (value != ParameterDirection.Input) throw new NotSupportedException("Only input parameters."); } }
        public override bool IsNullable { get { return true; } set { } }
        public override string ParameterName { get { return _name; } set { _name = value ?? ""; } }
        public override int Size { get { return _size; } set { _size = value; } }
        public override string SourceColumn { get { return _source; } set { _source = value ?? ""; } }
        public override bool SourceColumnNullMapping { get { return false; } set { } }
        public override DataRowVersion SourceVersion { get { return DataRowVersion.Current; } set { } }
        public override object Value { get { return _value; } set { _value = value; } }
        public override void ResetDbType() { _type = DbType.String; }
    }

    public sealed class LocalParameterCollection : DbParameterCollection
    {
        readonly List<LocalParameter> _list = new List<LocalParameter>();
        readonly object _sync = new object();

        static LocalParameter Cast(object value)
        {
            LocalParameter p = value as LocalParameter;
            if (p == null) throw new InvalidCastException("Use a LocalParameter (command.CreateParameter()).");
            return p;
        }

        public override int Add(object value) { _list.Add(Cast(value)); return _list.Count - 1; }
        public override void AddRange(Array values) { foreach (object v in values) Add(v); }
        public override void Clear() { _list.Clear(); }
        public override bool Contains(object value) { return _list.Contains(value as LocalParameter); }
        public override bool Contains(string value) { return IndexOf(value) >= 0; }
        public override void CopyTo(Array array, int index) { ((ICollection)_list).CopyTo(array, index); }
        public override int Count { get { return _list.Count; } }
        public override IEnumerator GetEnumerator() { return _list.GetEnumerator(); }
        protected override DbParameter GetParameter(int index) { return _list[index]; }
        protected override DbParameter GetParameter(string parameterName) { int i = IndexOf(parameterName); if (i < 0) throw new IndexOutOfRangeException(parameterName); return _list[i]; }
        public override int IndexOf(object value) { return _list.IndexOf(value as LocalParameter); }
        public override int IndexOf(string parameterName)
        {
            for (int i = 0; i < _list.Count; i++) if (string.Equals(_list[i].ParameterName, parameterName, StringComparison.OrdinalIgnoreCase)) return i;
            return -1;
        }
        public override void Insert(int index, object value) { _list.Insert(index, Cast(value)); }
        public override bool IsFixedSize { get { return false; } }
        public override bool IsReadOnly { get { return false; } }
        public override bool IsSynchronized { get { return false; } }
        public override void Remove(object value) { _list.Remove(value as LocalParameter); }
        public override void RemoveAt(int index) { _list.RemoveAt(index); }
        public override void RemoveAt(string parameterName) { int i = IndexOf(parameterName); if (i >= 0) _list.RemoveAt(i); }
        protected override void SetParameter(int index, DbParameter value) { _list[index] = Cast(value); }
        protected override void SetParameter(string parameterName, DbParameter value) { int i = IndexOf(parameterName); if (i < 0) Add(value); else _list[i] = Cast(value); }
        public override object SyncRoot { get { return _sync; } }
        public new LocalParameter this[int index] { get { return _list[index]; } set { _list[index] = value; } }
    }

    // ---------------------------------------------------------------------------------------------
    // Import options, progress and results
    // ---------------------------------------------------------------------------------------------
    public sealed class ImportProgress
    {
        public string Phase;
        public long Rows;
        public long Bytes;
        public long TotalBytes;
        public string Table;
    }

    public sealed class ImportOptions
    {
        public string Table;            // target name; null or empty: derived from the file name
        public bool Replace;            // swap an existing table of that name atomically
        public string SourceLabel;      // where the data came from (shown on the page)
        public string SourcePath;
        public string ETag;
        public string Format;
        public long FileBytes;          // -1: the size of SourcePath
        public string NameHint;         // the file name a derived table name comes from (an upload's own name)
        public char Delimiter;          // '\0': sniffed from , ; tab |
        public bool HasHeader;
        public int SampleRows;
        public int BatchRows;
        public Action<ImportProgress> Progress;
        public int ProgressMs;
        volatile bool _cancel;
        LocalConnection _conn;

        public ImportOptions()
        {
            HasHeader = true;
            SampleRows = 20000;
            BatchRows = 200000;
            ProgressMs = 250;
            FileBytes = -1;
        }

        public bool Cancelled { get { return _cancel; } }

        /// <summary>Stops the import (any thread); the staging table is dropped and nothing is published.</summary>
        public void Cancel()
        {
            _cancel = true;
            LocalConnection c = _conn;
            if (c != null) c.Interrupt();
        }

        internal void Attach(LocalConnection c) { _conn = c; }
    }

    public sealed class ImportResult
    {
        public string Table;
        public long Rows;
        public int Columns;
        public string[] Names;
        public string[] Types;
        public long Ms;
        public long TableBytes;
        public List<string> Warnings = new List<string>();
    }

    internal interface IRowSource : IDisposable
    {
        /// <summary>Next record as strings (null for an empty cell); false at the end.</summary>
        bool Next(List<string> fields);
        long Position { get; }
        long Length { get; }
    }

    // ---------------------------------------------------------------------------------------------
    // CSV parser: RFC 4180 quotes (doubled quotes, embedded newlines), CRLF / LF / CR
    // ---------------------------------------------------------------------------------------------
    internal sealed class CsvSource : IRowSource
    {
        readonly TextReader _r;
        readonly Stream _raw;           // the file stream, for progress
        readonly char _delim;
        readonly char[] _buf = new char[1 << 16];
        int _pos, _len;
        bool _eof;
        readonly StringBuilder _sb = new StringBuilder(256);

        public CsvSource(TextReader reader, Stream raw, char delimiter)
        {
            _r = reader; _raw = raw; _delim = delimiter;
        }

        public long Position { get { try { return _raw.Position; } catch { return 0; } } }
        public long Length { get { try { return _raw.Length; } catch { return 0; } } }

        bool Fill()
        {
            if (_eof) return false;
            _len = _r.Read(_buf, 0, _buf.Length);
            _pos = 0;
            if (_len <= 0) { _len = 0; _eof = true; return false; }
            return true;
        }

        public bool Next(List<string> fields)
        {
            fields.Clear();
            if (_pos >= _len && !Fill()) return false;
            while (true)
            {
                string value;
                if (_pos >= _len && !Fill()) { fields.Add(null); return true; }
                if (_buf[_pos] == '"')
                {
                    _pos++;
                    _sb.Length = 0;
                    while (true)
                    {
                        if (_pos >= _len && !Fill()) break;
                        int start = _pos;
                        while (_pos < _len && _buf[_pos] != '"') _pos++;
                        _sb.Append(_buf, start, _pos - start);
                        if (_pos >= _len) continue;
                        _pos++;   // the quote
                        if (_pos >= _len && !Fill()) break;
                        if (_buf[_pos] == '"') { _sb.Append('"'); _pos++; continue; }
                        break;
                    }
                    // Anything between the closing quote and the delimiter is kept (lenient, like Excel).
                    while (true)
                    {
                        if (_pos >= _len && !Fill()) break;
                        char ch = _buf[_pos];
                        if (ch == _delim || ch == '\r' || ch == '\n') break;
                        _sb.Append(ch);
                        _pos++;
                    }
                    value = _sb.Length == 0 ? null : _sb.ToString();
                }
                else
                {
                    int start = _pos;
                    bool spilled = false;
                    while (true)
                    {
                        while (_pos < _len)
                        {
                            char ch = _buf[_pos];
                            if (ch == _delim || ch == '\r' || ch == '\n') break;
                            _pos++;
                        }
                        if (_pos < _len) break;
                        if (!spilled) { _sb.Length = 0; spilled = true; }
                        _sb.Append(_buf, start, _pos - start);
                        if (!Fill()) { start = 0; break; }
                        start = 0;
                    }
                    if (spilled)
                    {
                        if (_pos > start && _len > 0) _sb.Append(_buf, start, _pos - start);
                        value = _sb.Length == 0 ? null : _sb.ToString();
                    }
                    else value = _pos == start ? null : new string(_buf, start, _pos - start);
                }
                fields.Add(value);
                if (_pos >= _len && !Fill()) return true;
                char t = _buf[_pos];
                if (t == _delim) { _pos++; continue; }
                if (t == '\r')
                {
                    _pos++;
                    if ((_pos < _len || Fill()) && _buf[_pos] == '\n') _pos++;
                    return true;
                }
                if (t == '\n') { _pos++; return true; }
            }
        }

        public void Dispose() { _r.Dispose(); }
    }

    // ---------------------------------------------------------------------------------------------
    // XLSX: shared strings, inline strings, numbers, booleans, dates by number format; first row headers
    // ---------------------------------------------------------------------------------------------
    internal sealed class XlsxSource : IRowSource
    {
        readonly ZipArchive _zip;
        readonly FileStream _file;
        readonly Stream _sheet;
        readonly XmlReader _x;
        readonly List<string> _shared;
        readonly List<int> _styleKind;   // per cellXfs index: 0 number, 1 date, 2 time only
        readonly bool _date1904;
        readonly long _length;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        public static List<string[]> SheetList(ZipArchive zip, out bool date1904)
        {
            // [name, entry path] in workbook order.
            date1904 = false;
            string wbPath = "xl/workbook.xml";
            ZipArchiveEntry rootRels = zip.GetEntry("_rels/.rels");
            if (rootRels != null)
            {
                foreach (string[] rel in ReadRels(rootRels, ""))
                    if (rel[2].EndsWith("/officeDocument", StringComparison.Ordinal)) { wbPath = rel[1]; break; }
            }
            ZipArchiveEntry wb = zip.GetEntry(wbPath);
            if (wb == null) throw new LocalException("This is not an Excel workbook (no " + wbPath + ").");
            string wbDir = wbPath.Contains("/") ? wbPath.Substring(0, wbPath.LastIndexOf('/') + 1) : "";
            Dictionary<string, string> targets = new Dictionary<string, string>();
            ZipArchiveEntry wbRels = zip.GetEntry(wbDir + "_rels/" + wbPath.Substring(wbDir.Length) + ".rels");
            if (wbRels != null) foreach (string[] rel in ReadRels(wbRels, wbDir)) targets[rel[0]] = rel[1];
            List<string[]> sheets = new List<string[]>();
            using (Stream s = wb.Open())
            using (XmlReader x = XmlReader.Create(s, Settings()))
            {
                while (x.Read())
                {
                    if (x.NodeType != XmlNodeType.Element) continue;
                    if (x.LocalName == "workbookPr")
                    {
                        string v = x.GetAttribute("date1904");
                        date1904 = v == "1" || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
                    }
                    else if (x.LocalName == "sheet")
                    {
                        string name = x.GetAttribute("name");
                        string rid = null;
                        if (x.MoveToFirstAttribute())
                        {
                            do { if (x.LocalName == "id" && x.NamespaceURI.EndsWith("relationships", StringComparison.Ordinal)) rid = x.Value; } while (x.MoveToNextAttribute());
                            x.MoveToElement();
                        }
                        string target;
                        if (name != null && rid != null && targets.TryGetValue(rid, out target)) sheets.Add(new string[] { name, target });
                    }
                }
            }
            return sheets;
        }

        static XmlReaderSettings Settings()
        {
            XmlReaderSettings s = new XmlReaderSettings();
            s.DtdProcessing = DtdProcessing.Prohibit;
            s.XmlResolver = null;
            s.IgnoreComments = true;
            s.IgnoreProcessingInstructions = true;
            s.CloseInput = false;
            return s;
        }

        static List<string[]> ReadRels(ZipArchiveEntry e, string baseDir)
        {
            // [Id, resolved entry path, Type]
            List<string[]> list = new List<string[]>();
            using (Stream s = e.Open())
            using (XmlReader x = XmlReader.Create(s, Settings()))
            {
                while (x.Read())
                {
                    if (x.NodeType != XmlNodeType.Element || x.LocalName != "Relationship") continue;
                    string target = x.GetAttribute("Target") ?? "";
                    string path = target.StartsWith("/", StringComparison.Ordinal) ? target.Substring(1) : Normalize(baseDir + target);
                    list.Add(new string[] { x.GetAttribute("Id") ?? "", path, x.GetAttribute("Type") ?? "" });
                }
            }
            return list;
        }

        static string Normalize(string p)
        {
            List<string> parts = new List<string>();
            foreach (string seg in p.Replace('\\', '/').Split('/'))
            {
                if (seg == "" || seg == ".") continue;
                if (seg == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); continue; }
                parts.Add(seg);
            }
            return string.Join("/", parts.ToArray());
        }

        public XlsxSource(string path, string sheet)
        {
            _file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16);
            try
            {
                _length = _file.Length;
                _zip = new ZipArchive(_file, ZipArchiveMode.Read, true);
                List<string[]> sheets = SheetList(_zip, out _date1904);
                if (sheets.Count == 0) throw new LocalException("The workbook has no sheets.");
                string[] pick = null;
                if (string.IsNullOrEmpty(sheet)) pick = sheets[0];
                else foreach (string[] s in sheets) if (string.Equals(s[0], sheet, StringComparison.OrdinalIgnoreCase)) { pick = s; break; }
                if (pick == null) throw new LocalException("The workbook has no sheet named \"" + sheet + "\".");
                SheetName = pick[0];
                _shared = ReadShared(_zip);
                _styleKind = ReadStyles(_zip);
                ZipArchiveEntry e = _zip.GetEntry(pick[1]);
                if (e == null) throw new LocalException("The sheet \"" + pick[0] + "\" is missing from the workbook.");
                _sheet = e.Open();
                _x = XmlReader.Create(_sheet, Settings());
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public string SheetName { get; private set; }
        public long Position { get { try { return _file.Position; } catch { return 0; } } }
        public long Length { get { return _length; } }

        static List<string> ReadShared(ZipArchive zip)
        {
            List<string> list = new List<string>();
            ZipArchiveEntry e = zip.GetEntry("xl/sharedStrings.xml");
            if (e == null) return list;
            using (Stream s = e.Open())
            using (XmlReader x = XmlReader.Create(s, Settings()))
            {
                StringBuilder sb = new StringBuilder();
                bool inSi = false;
                int phonetic = 0;
                bool more = x.Read();
                while (more)
                {
                    if (x.NodeType == XmlNodeType.Element)
                    {
                        if (x.LocalName == "si") { inSi = true; sb.Length = 0; if (x.IsEmptyElement) { list.Add(""); inSi = false; } }
                        else if (x.LocalName == "rPh" && !x.IsEmptyElement) phonetic++;
                        else if (x.LocalName == "t" && inSi && phonetic == 0 && !x.IsEmptyElement)
                        {
                            sb.Append(x.ReadElementContentAsString());   // leaves the reader on the next node
                            more = !x.EOF;
                            continue;
                        }
                    }
                    else if (x.NodeType == XmlNodeType.EndElement)
                    {
                        if (x.LocalName == "rPh") phonetic--;
                        else if (x.LocalName == "si") { list.Add(sb.ToString()); inSi = false; }
                    }
                    more = x.Read();
                }
            }
            return list;
        }

        static readonly int[] BuiltinDate = { 14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58 };
        static readonly int[] BuiltinTime = { 18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56 };

        static int FormatKind(string code)
        {
            // Strip "quoted", [bracketed] (colours, locales; [h] elapsed hours is a time), \x escapes.
            if (string.IsNullOrEmpty(code)) return 0;
            StringBuilder sb = new StringBuilder();
            bool elapsed = false;
            for (int i = 0; i < code.Length; i++)
            {
                char c = code[i];
                if (c == '"') { int j = code.IndexOf('"', i + 1); if (j < 0) break; i = j; continue; }
                if (c == '\\' || c == '_' || c == '*') { i++; continue; }
                if (c == '[')
                {
                    int j = code.IndexOf(']', i + 1);
                    if (j < 0) break;
                    string inner = code.Substring(i + 1, j - i - 1).ToLowerInvariant();
                    if (inner == "h" || inner == "hh" || inner == "m" || inner == "mm" || inner == "s" || inner == "ss") elapsed = true;
                    i = j;
                    continue;
                }
                sb.Append(char.ToLowerInvariant(c));
            }
            string f = sb.ToString();
            int semi = f.IndexOf(';');
            if (semi >= 0) f = f.Substring(0, semi);
            bool hasY = f.IndexOf('y') >= 0, hasD = f.IndexOf('d') >= 0, hasH = f.IndexOf('h') >= 0 || elapsed, hasS = f.IndexOf('s') >= 0;
            bool hasM = f.IndexOf('m') >= 0;
            if (f.Contains("general")) return 0;
            if (hasY || hasD) return 1;
            if (hasH || hasS) return 2;
            if (hasM && !f.Contains("0") && !f.Contains("#")) return 1;
            return 0;
        }

        static List<int> ReadStyles(ZipArchive zip)
        {
            List<int> kinds = new List<int>();
            ZipArchiveEntry e = zip.GetEntry("xl/styles.xml");
            if (e == null) return kinds;
            Dictionary<int, int> custom = new Dictionary<int, int>();
            using (Stream s = e.Open())
            using (XmlReader x = XmlReader.Create(s, Settings()))
            {
                bool inXfs = false;
                while (x.Read())
                {
                    if (x.NodeType == XmlNodeType.Element)
                    {
                        if (x.LocalName == "numFmt")
                        {
                            int id;
                            if (int.TryParse(x.GetAttribute("numFmtId"), NumberStyles.Integer, Inv, out id)) custom[id] = FormatKind(x.GetAttribute("formatCode"));
                        }
                        else if (x.LocalName == "cellXfs") inXfs = !x.IsEmptyElement;
                        else if (x.LocalName == "xf" && inXfs)
                        {
                            int id;
                            int kind = 0;
                            if (int.TryParse(x.GetAttribute("numFmtId"), NumberStyles.Integer, Inv, out id))
                            {
                                int ck;
                                if (custom.TryGetValue(id, out ck)) kind = ck;
                                else if (Array.IndexOf(BuiltinDate, id) >= 0) kind = 1;
                                else if (Array.IndexOf(BuiltinTime, id) >= 0) kind = 2;
                            }
                            kinds.Add(kind);
                        }
                    }
                    else if (x.NodeType == XmlNodeType.EndElement && x.LocalName == "cellXfs") inXfs = false;
                }
            }
            return kinds;
        }

        static int ColumnIndex(string r)
        {
            if (string.IsNullOrEmpty(r)) return -1;
            int n = 0, i = 0;
            while (i < r.Length && char.IsLetter(r[i])) { n = n * 26 + (char.ToUpperInvariant(r[i]) - 'A' + 1); i++; }
            return i == 0 ? -1 : n - 1;
        }

        string CellText(string t, string s, string v, string inline)
        {
            if (t == "inlineStr") return inline;
            if (v == null) return null;
            if (t == "s")
            {
                int k;
                if (int.TryParse(v, NumberStyles.Integer, Inv, out k) && k >= 0 && k < _shared.Count) return _shared[k];
                return null;
            }
            if (t == "b") return v == "1" ? "true" : "false";
            if (t == "e") return null;
            if (t == "str") return v;
            if (t == "d")
            {
                DateTime d;
                if (Values.TryAnyDate(v, out d)) return Values.DateText(d);
                return v;
            }
            double x;
            if (!double.TryParse(v, NumberStyles.Float, Inv, out x)) return v;
            int style = 0;
            int si;
            if (s != null && int.TryParse(s, NumberStyles.Integer, Inv, out si) && si >= 0 && si < _styleKind.Count) style = _styleKind[si];
            if (style == 1 && x > -657435 && x < 2958466)
            {
                DateTime d = DateTime.FromOADate(x);
                if (_date1904) d = d.AddDays(1462);
                d = new DateTime((d.Ticks + TimeSpan.TicksPerSecond / 2) / TimeSpan.TicksPerSecond * TimeSpan.TicksPerSecond);
                return Values.DateText(d);
            }
            if (style == 2 && x >= 0)
            {
                TimeSpan ts = TimeSpan.FromSeconds(Math.Round((x - Math.Floor(x)) * 86400.0));
                return ts.ToString("hh\\:mm\\:ss", Inv);
            }
            if (x == Math.Floor(x) && Math.Abs(x) < 1e15) return ((long)x).ToString(Inv);
            return x.ToString("R", Inv);
        }

        public bool Next(List<string> fields)
        {
            fields.Clear();
            while (_x.Read())
            {
                if (_x.NodeType != XmlNodeType.Element || _x.LocalName != "row") continue;
                if (_x.IsEmptyElement) { return true; }
                int depth = _x.Depth;
                int next = 0;
                while (_x.Read())
                {
                    if (_x.NodeType == XmlNodeType.EndElement && _x.Depth == depth) break;
                    if (_x.NodeType != XmlNodeType.Element || _x.LocalName != "c") continue;
                    int col = ColumnIndex(_x.GetAttribute("r"));
                    if (col < 0) col = next;
                    string t = _x.GetAttribute("t"), s = _x.GetAttribute("s");
                    string v = null, inline = null;
                    if (!_x.IsEmptyElement)
                    {
                        int cd = _x.Depth;
                        StringBuilder isb = null;
                        bool more = _x.Read();
                        while (more)
                        {
                            if (_x.NodeType == XmlNodeType.EndElement && _x.Depth == cd) break;
                            if (_x.NodeType == XmlNodeType.Element && !_x.IsEmptyElement && (_x.LocalName == "v" || _x.LocalName == "t"))
                            {
                                // ReadElementContentAsString leaves the reader on the next node: look at it before reading on.
                                if (_x.LocalName == "v") v = _x.ReadElementContentAsString();
                                else
                                {
                                    if (isb == null) isb = new StringBuilder();
                                    isb.Append(_x.ReadElementContentAsString());
                                }
                                more = !_x.EOF;
                                continue;
                            }
                            more = _x.Read();
                        }
                        if (isb != null) inline = isb.ToString();
                    }
                    string text = CellText(t, s, v, inline);
                    if (col > 16383) continue;
                    while (fields.Count < col) fields.Add(null);
                    if (fields.Count == col) fields.Add(text == "" ? null : text);
                    else fields[col] = text == "" ? null : text;
                    next = col + 1;
                }
                return true;
            }
            return false;
        }

        public void Dispose()
        {
            if (_x != null) ((IDisposable)_x).Dispose();
            if (_sheet != null) _sheet.Dispose();
            if (_zip != null) _zip.Dispose();
            if (_file != null) _file.Dispose();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Importer: staging table, type inference on a sample, per-column widening, batched inserts
    // ---------------------------------------------------------------------------------------------
    internal sealed class Importer
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        readonly LocalConnection _conn;
        readonly ImportOptions _o;
        readonly Clock _clock = new Clock();
        public string Staging;
        public string Final;
        public long PagesBefore;

        internal sealed class Clock
        {
            readonly System.Diagnostics.Stopwatch _sw = System.Diagnostics.Stopwatch.StartNew();
            long _lastTick = -1000000;
            public long Ms { get { return _sw.ElapsedMilliseconds; } }
            public bool Due(int ms) { long now = _sw.ElapsedMilliseconds; if (now - _lastTick < ms) return false; _lastTick = now; return true; }
        }

        public Importer(LocalConnection conn, ImportOptions o, string defaultName)
        {
            _conn = conn;
            _o = o ?? new ImportOptions();
            _o.Attach(conn);
            LocalImport.EnsureMeta(conn);
            if (!string.IsNullOrEmpty(_o.Table))
            {
                string bad = LocalImport.CheckTableName(_o.Table);
                if (bad != null) throw new LocalException(bad);
                Final = _o.Table;
                if (!_o.Replace && conn.TableExists(Final)) throw new LocalException("A table named \"" + Final + "\" is already in the local database. Choose another name, or replace it.");
            }
            else Final = LocalImport.UniqueTableName(conn, LocalImport.SafeTableName(defaultName));
            Staging = "_semaphore_stage_" + Guid.NewGuid().ToString("N").Substring(0, 12);
            PagesBefore = conn.ScalarLong("PRAGMA page_count");
        }

        public ImportOptions Options { get { return _o; } }
        public long Ms { get { return _clock.Ms; } }

        public void Report(string phase, long rows, long bytes, long total)
        {
            if (_o.Progress == null) return;
            if (phase == "importing" && !_clock.Due(_o.ProgressMs)) return;
            ImportProgress p = new ImportProgress();
            p.Phase = phase; p.Rows = rows; p.Bytes = bytes; p.TotalBytes = total; p.Table = Final;
            _o.Progress(p);
        }

        public void CheckCancel()
        {
            if (_o.Cancelled) throw new LocalException("The import was cancelled.", Native.INTERRUPT);
        }

        static string Decl(Kind k)
        {
            switch (k)
            {
                case Kind.Boolean: return "BOOLEAN";
                case Kind.Integer: return "INTEGER";
                case Kind.Real: return "REAL";
                case Kind.Date: return "DATE";
                case Kind.Blob: return "BLOB";
            }
            return "TEXT";
        }

        public void CreateStaging(string table, string[] names, string[] decls)
        {
            StringBuilder sb = new StringBuilder("CREATE TABLE ");
            sb.Append(LocalConnection.Quote(table)).Append(" (");
            for (int i = 0; i < names.Length; i++)
            {
                if (i > 0) sb.Append(", ");
                sb.Append(LocalConnection.Quote(names[i]));
                if (!string.IsNullOrEmpty(decls[i])) sb.Append(' ').Append(decls[i]);
            }
            sb.Append(')');
            _conn.Execute(sb.ToString());
        }

        public IntPtr PrepareInsert(int n)
        {
            StringBuilder sb = new StringBuilder("INSERT INTO ");
            sb.Append(LocalConnection.Quote(Staging)).Append(" VALUES (");
            for (int i = 0; i < n; i++) { if (i > 0) sb.Append(','); sb.Append('?'); }
            sb.Append(')');
            LocalCommand c = new LocalCommand(_conn, sb.ToString());
            return c.PrepareStatement(false);
        }

        public void StepInsert(IntPtr stmt)
        {
            int rc = Native.sqlite3_step(stmt);
            if (rc != Native.DONE)
            {
                Native.sqlite3_reset(stmt);
                if ((rc & 0xFF) == Native.INTERRUPT) CheckCancel();
                throw _conn.Error(rc);
            }
            Native.sqlite3_reset(stmt);
        }

        public void DropStaging()
        {
            try { if (_conn.InTransaction) _conn.Execute("ROLLBACK"); } catch { }
            try { _conn.Execute("DROP TABLE IF EXISTS " + LocalConnection.Quote(Staging)); } catch { }
        }

        /// <summary>Renames the staging table to the final name (replacing it when asked) and records where it came from, in one transaction.</summary>
        public ImportResult Publish(long rows, string[] names, string[] decls)
        {
            CheckCancel();
            if (_conn.InTransaction) _conn.Execute("COMMIT");
            _conn.Execute("BEGIN IMMEDIATE");
            try
            {
                if (_conn.TableExists(Final))
                {
                    if (!_o.Replace) throw new LocalException("A table named \"" + Final + "\" appeared while importing; nothing was replaced.");
                    _conn.Execute("DROP TABLE " + LocalConnection.Quote(Final));
                }
                _conn.Execute("ALTER TABLE " + LocalConnection.Quote(Staging) + " RENAME TO " + LocalConnection.Quote(Final));
                long pages = _conn.ScalarLong("PRAGMA page_count") - PagesBefore;
                long pageSize = _conn.ScalarLong("PRAGMA page_size");
                long bytes = Math.Max(0, pages) * pageSize;
                using (LocalCommand c = new LocalCommand(_conn, "INSERT OR REPLACE INTO _semaphore_tables (name, source, path, format, imported_at, rows, columns, file_bytes, etag, table_bytes, ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)"))
                {
                    c.Parameters.Add(new LocalParameter("name", Final));
                    c.Parameters.Add(new LocalParameter("source", (object)_o.SourceLabel ?? DBNull.Value));
                    c.Parameters.Add(new LocalParameter("path", (object)_o.SourcePath ?? DBNull.Value));
                    c.Parameters.Add(new LocalParameter("format", (object)_o.Format ?? DBNull.Value));
                    c.Parameters.Add(new LocalParameter("at", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", Inv)));
                    c.Parameters.Add(new LocalParameter("rows", rows));
                    c.Parameters.Add(new LocalParameter("columns", (long)names.Length));
                    c.Parameters.Add(new LocalParameter("file_bytes", _o.FileBytes >= 0 ? (object)_o.FileBytes : (_o.SourcePath != null && File.Exists(_o.SourcePath) ? (object)new FileInfo(_o.SourcePath).Length : DBNull.Value)));
                    c.Parameters.Add(new LocalParameter("etag", (object)_o.ETag ?? DBNull.Value));
                    c.Parameters.Add(new LocalParameter("table_bytes", bytes));
                    c.Parameters.Add(new LocalParameter("ms", _clock.Ms));
                    c.ExecuteNonQuery();
                }
                _conn.Execute("COMMIT");
                ImportResult r = new ImportResult();
                r.Table = Final; r.Rows = rows; r.Columns = names.Length; r.Names = names; r.Types = decls; r.Ms = _clock.Ms; r.TableBytes = bytes;
                Report("done", rows, 0, 0);
                return r;
            }
            catch
            {
                try { _conn.Execute("ROLLBACK"); } catch { }
                throw;
            }
        }

        // ---- String rows (CSV, XLSX) -----------------------------------------------------------------
        sealed class Col
        {
            public bool CanBool = true, CanInt = true, CanReal = true, CanDate = true, CanDateTime = true, Seen;
        }

        static void Observe(Col c, string s)
        {
            if (s == null) return;
            c.Seen = true;
            bool b; long l; double d; DateTime dt;
            if (c.CanBool && !Values.TryBool(s, out b)) c.CanBool = false;
            if (c.CanInt && !Values.TryInt(s, out l)) c.CanInt = false;
            if (c.CanReal && !Values.TryReal(s, out d)) c.CanReal = false;
            bool isDate = (c.CanDate || c.CanDateTime) && Values.TryDate(s, out dt);
            if (c.CanDate && !isDate) c.CanDate = false;
            if (c.CanDateTime && !isDate && !Values.TryDateTime(s, out dt)) c.CanDateTime = false;
        }

        static Kind Decide(Col c)
        {
            if (!c.Seen) return Kind.Text;
            if (c.CanBool) return Kind.Boolean;
            if (c.CanInt) return Kind.Integer;
            if (c.CanReal) return Kind.Real;
            if (c.CanDate || c.CanDateTime) return Kind.Date;
            return Kind.Text;
        }

        bool BindString(IntPtr stmt, int index, Kind k, string s)
        {
            int rc;
            if (s == null) rc = Native.sqlite3_bind_null(stmt, index);
            else
            {
                switch (k)
                {
                    case Kind.Boolean:
                        {
                            bool b;
                            if (!Values.TryBool(s, out b)) return false;
                            rc = Native.sqlite3_bind_int64(stmt, index, b ? 1 : 0);
                            break;
                        }
                    case Kind.Integer:
                        {
                            long l;
                            if (!Values.TryInt(s, out l)) return false;
                            rc = Native.sqlite3_bind_int64(stmt, index, l);
                            break;
                        }
                    case Kind.Real:
                        {
                            double d;
                            if (!Values.TryReal(s, out d)) return false;
                            rc = Native.sqlite3_bind_double(stmt, index, d);
                            break;
                        }
                    case Kind.Date:
                        {
                            string t;
                            DateTime dt;
                            if (s.Length == 10 && Values.TryDate(s, out dt)) t = s;
                            else if (Values.TryDateTime(s, out dt)) t = Values.DateText(dt);
                            else return false;
                            rc = Native.sqlite3_bind_text16(stmt, index, t, t.Length * 2, Native.TRANSIENT);
                            break;
                        }
                    default:
                        rc = Native.sqlite3_bind_text16(stmt, index, s, s.Length * 2, Native.TRANSIENT);
                        break;
                }
            }
            if (rc != Native.OK) throw _conn.Error(rc);
            return true;
        }

        static Kind Widen(Kind k, string s)
        {
            double d;
            if (k == Kind.Integer && Values.TryReal(s, out d)) return Kind.Real;
            return Kind.Text;
        }

        /// <summary>Rebuilds the staging table with wider column types (inside the current transaction).</summary>
        IntPtr Rebuild(IntPtr stmt, string[] names, Kind[] before, Kind[] after)
        {
            Native.sqlite3_finalize(stmt);
            string tmp = Staging + "_w";
            string[] decls = new string[names.Length];
            for (int i = 0; i < names.Length; i++) decls[i] = Decl(after[i]);
            CreateStaging(tmp, names, decls);
            StringBuilder sel = new StringBuilder();
            for (int i = 0; i < names.Length; i++)
            {
                if (i > 0) sel.Append(", ");
                string q = LocalConnection.Quote(names[i]);
                if (before[i] == Kind.Boolean && after[i] == Kind.Text) sel.Append("CASE WHEN ").Append(q).Append(" IS NULL THEN NULL WHEN ").Append(q).Append(" THEN 'true' ELSE 'false' END");
                else sel.Append(q);
            }
            _conn.Execute("INSERT INTO " + LocalConnection.Quote(tmp) + " SELECT " + sel.ToString() + " FROM " + LocalConnection.Quote(Staging));
            _conn.Execute("DROP TABLE " + LocalConnection.Quote(Staging));
            _conn.Execute("ALTER TABLE " + LocalConnection.Quote(tmp) + " RENAME TO " + LocalConnection.Quote(Staging));
            return PrepareInsert(names.Length);
        }

        public ImportResult ImportStrings(IRowSource src, ImportResult partial)
        {
            List<string> rec = new List<string>(64);
            string[] names = null;
            // Header
            if (_o.HasHeader)
            {
                while (src.Next(rec))
                {
                    if (rec.Count == 1 && rec[0] == null) continue;   // blank line
                    names = LocalImport.SafeColumnNames(rec);
                    break;
                }
                if (names == null) throw new LocalException("The file is empty: there is no header row.");
            }
            // Sample
            List<string[]> sample = new List<string[]>(Math.Min(_o.SampleRows, 100000));
            bool more = true;
            int width = names == null ? 0 : names.Length;
            long ragged = 0;
            while (sample.Count < _o.SampleRows)
            {
                if (!src.Next(rec)) { more = false; break; }
                if (rec.Count == 1 && rec[0] == null) continue;
                if (names == null && rec.Count > width) width = rec.Count;
                if (names != null && rec.Count > names.Length) ragged++;
                sample.Add(rec.ToArray());
                if ((sample.Count & 1023) == 0) { CheckCancel(); Report("sampling", sample.Count, src.Position, src.Length); }
            }
            if (names == null)
            {
                List<string> gen = new List<string>();
                for (int i = 0; i < width; i++) gen.Add("column_" + (i + 1).ToString(Inv));
                names = gen.ToArray();
            }
            int n = names.Length;
            if (n == 0) throw new LocalException("The file has no columns.");
            if (n > 2000) throw new LocalException("The file has more than 2000 columns.");
            Col[] cols = new Col[n];
            for (int i = 0; i < n; i++) cols[i] = new Col();
            foreach (string[] row in sample)
                for (int i = 0; i < n && i < row.Length; i++) Observe(cols[i], row[i]);
            Kind[] kinds = new Kind[n];
            for (int i = 0; i < n; i++) kinds[i] = Decide(cols[i]);
            string[] decls = new string[n];
            for (int i = 0; i < n; i++) decls[i] = Decl(kinds[i]);

            CreateStaging(Staging, names, decls);
            long rows = 0;
            IntPtr stmt = IntPtr.Zero;
            try
            {
                _conn.Execute("BEGIN IMMEDIATE");
                stmt = PrepareInsert(n);
                string[] buf = new string[n];
                int si = 0;
                while (true)
                {
                    string[] row;
                    if (si < sample.Count) { row = sample[si]; sample[si] = null; si++; }
                    else
                    {
                        if (!more || !src.Next(rec)) break;
                        if (rec.Count == 1 && rec[0] == null) continue;
                        if (rec.Count > n) ragged++;
                        for (int i = 0; i < n; i++) buf[i] = i < rec.Count ? rec[i] : null;
                        row = buf;
                    }
                    while (true)
                    {
                        int bad = -1;
                        for (int i = 0; i < n; i++)
                        {
                            string v = i < row.Length ? row[i] : null;
                            if (!BindString(stmt, i + 1, kinds[i], v)) { bad = i; break; }
                        }
                        if (bad < 0) break;
                        Kind[] before = (Kind[])kinds.Clone();
                        for (int i = bad; i < n; i++)
                        {
                            string v = i < row.Length ? row[i] : null;
                            if (v == null) continue;
                            while (!Fits(kinds[i], v)) kinds[i] = Widen(kinds[i], v);
                        }
                        stmt = Rebuild(stmt, names, before, kinds);
                        for (int i = 0; i < n; i++) decls[i] = Decl(kinds[i]);
                    }
                    StepInsert(stmt);
                    rows++;
                    if (rows % _o.BatchRows == 0)
                    {
                        _conn.Execute("COMMIT");
                        _conn.Execute("BEGIN IMMEDIATE");
                    }
                    if ((rows & 4095) == 0) { CheckCancel(); Report("importing", rows, src.Position, src.Length); }
                }
                Native.sqlite3_finalize(stmt);
                stmt = IntPtr.Zero;
                _conn.Execute("COMMIT");
                ImportResult r = Publish(rows, names, decls);
                if (ragged > 0) r.Warnings.Add(ragged.ToString(Inv) + " rows had more cells than the header; the extra cells were left out.");
                for (int i = 0; i < n; i++) if (kinds[i] == Kind.Text && cols[i].Seen && (cols[i].CanInt || cols[i].CanReal || cols[i].CanDate || cols[i].CanBool)) r.Warnings.Add("Column \"" + names[i] + "\" looked typed in the first rows but later rows hold text: it is kept as text.");
                return r;
            }
            catch
            {
                if (stmt != IntPtr.Zero) Native.sqlite3_finalize(stmt);
                DropStaging();
                throw;
            }
        }

        static bool Fits(Kind k, string s)
        {
            bool b; long l; double d; DateTime dt;
            switch (k)
            {
                case Kind.Boolean: return Values.TryBool(s, out b);
                case Kind.Integer: return Values.TryInt(s, out l);
                case Kind.Real: return Values.TryReal(s, out d);
                case Kind.Date: return Values.TryAnyDate(s, out dt);
            }
            return true;
        }

        // ---- Typed rows (columnar files) ------------------------------------------------------------
        static Kind FromColumnarType(string t)
        {
            switch ((t ?? "").ToLowerInvariant())
            {
                case "integer": return Kind.Integer;
                case "real": return Kind.Real;
                case "date": return Kind.Date;
                case "boolean": return Kind.Boolean;
                case "blob": return Kind.Blob;
            }
            return Kind.Text;
        }

        void BindTyped(IntPtr stmt, int index, Kind k, object v)
        {
            if (v == null || v is DBNull) { LocalCommand.Bind(_conn, stmt, index, null); return; }
            if (k == Kind.Date)
            {
                if (v is DateTime) { LocalCommand.Bind(_conn, stmt, index, Values.DateText((DateTime)v)); return; }
                if (v is DateTimeOffset) { LocalCommand.Bind(_conn, stmt, index, Values.DateText(((DateTimeOffset)v).UtcDateTime)); return; }
            }
            if (k == Kind.Text && !(v is string))
            {
                IFormattable f = v as IFormattable;
                LocalCommand.Bind(_conn, stmt, index, f != null ? f.ToString(null, Inv) : v.ToString());
                return;
            }
            LocalCommand.Bind(_conn, stmt, index, v);
        }

        public ImportResult ImportTyped(string[] rawNames, string[] types, Func<object[], bool> next, Func<long> position, long length)
        {
            if (rawNames == null || rawNames.Length == 0) throw new LocalException("The file has no columns.");
            string[] names = LocalImport.SafeColumnNames(new List<string>(rawNames));
            int n = names.Length;
            Kind[] kinds = new Kind[n];
            string[] decls = new string[n];
            for (int i = 0; i < n; i++) { kinds[i] = FromColumnarType(types != null && i < types.Length ? types[i] : "text"); decls[i] = Decl(kinds[i]); }
            CreateStaging(Staging, names, decls);
            long rows = 0;
            IntPtr stmt = IntPtr.Zero;
            try
            {
                _conn.Execute("BEGIN IMMEDIATE");
                stmt = PrepareInsert(n);
                object[] row = new object[n];
                while (true)
                {
                    Array.Clear(row, 0, n);
                    if (!next(row)) break;
                    for (int i = 0; i < n; i++) BindTyped(stmt, i + 1, kinds[i], row[i]);
                    StepInsert(stmt);
                    rows++;
                    if (rows % _o.BatchRows == 0) { _conn.Execute("COMMIT"); _conn.Execute("BEGIN IMMEDIATE"); }
                    if ((rows & 4095) == 0) { CheckCancel(); Report("importing", rows, position == null ? 0 : position(), length); }
                }
                Native.sqlite3_finalize(stmt);
                stmt = IntPtr.Zero;
                _conn.Execute("COMMIT");
                return Publish(rows, names, decls);
            }
            catch
            {
                if (stmt != IntPtr.Zero) Native.sqlite3_finalize(stmt);
                DropStaging();
                throw;
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Public import API
    // ---------------------------------------------------------------------------------------------
    public static class LocalImport
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        /// <summary>The columnar helper's type (server/Columnar.cs), looked up at run time.</summary>
        public static string ColumnarTypeName = "SemColumnar.ColumnarFiles";

        public static void EnsureMeta(LocalConnection conn)
        {
            conn.Execute("CREATE TABLE IF NOT EXISTS _semaphore_tables (name TEXT PRIMARY KEY COLLATE NOCASE, source TEXT, path TEXT, format TEXT, imported_at TEXT, rows INTEGER, columns INTEGER, file_bytes INTEGER, etag TEXT, table_bytes INTEGER, ms INTEGER)");
        }

        /// <summary>A safe, lower-case table name from a file name: letters, digits and _, never starting with a digit.</summary>
        public static string SafeTableName(string fileName)
        {
            string b = Path.GetFileName(fileName ?? "") ?? "";
            string lower = b.ToLowerInvariant();
            foreach (string ext in new string[] { ".gz" }) if (lower.EndsWith(ext, StringComparison.Ordinal)) { b = b.Substring(0, b.Length - ext.Length); lower = b.ToLowerInvariant(); }
            int dot = b.LastIndexOf('.');
            if (dot > 0) b = b.Substring(0, dot);
            StringBuilder sb = new StringBuilder();
            bool us = false;
            foreach (char ch in b.ToLowerInvariant())
            {
                bool ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
                if (ok) { sb.Append(ch); us = false; }
                else if (!us) { sb.Append('_'); us = true; }
            }
            string s = sb.ToString().Trim('_');
            if (s.Length == 0) s = "table";
            if (s[0] >= '0' && s[0] <= '9') s = "t_" + s;
            if (s.StartsWith("sqlite_", StringComparison.Ordinal)) s = "t_" + s;
            if (s.Length > 60) s = s.Substring(0, 60).TrimEnd('_');
            return s;
        }

        /// <summary>null when the name may be used for a table, else why not.</summary>
        public static string CheckTableName(string name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 64) return "A table name has 1 to 64 characters.";
            char c0 = name[0];
            if (!((c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z') || c0 == '_')) return "A table name starts with a letter or _.";
            foreach (char ch in name)
                if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_')) return "A table name has only letters, digits and _.";
            string l = name.ToLowerInvariant();
            if (l.StartsWith("sqlite_", StringComparison.Ordinal) || l.StartsWith("_semaphore", StringComparison.Ordinal)) return "Names starting with sqlite_ or _semaphore are kept for the database itself.";
            return null;
        }

        public static string UniqueTableName(LocalConnection conn, string name)
        {
            if (!conn.TableExists(name)) return name;
            for (int i = 2; i < 10000; i++)
            {
                string suffix = "_" + i.ToString(Inv);
                string cand = (name.Length + suffix.Length > 64 ? name.Substring(0, 64 - suffix.Length) : name) + suffix;
                if (!conn.TableExists(cand)) return cand;
            }
            throw new LocalException("Too many tables named " + name + ".");
        }

        /// <summary>Column names Semaphore's catalog accepts: letters, digits, _ and single spaces, unique ignoring case.</summary>
        public static string[] SafeColumnNames(List<string> raw)
        {
            string[] outp = new string[raw.Count];
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < raw.Count; i++)
            {
                string r = (raw[i] ?? "").Trim();
                StringBuilder sb = new StringBuilder();
                bool gap = false;
                foreach (char ch in r)
                {
                    bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
                    if (ok) { if (gap && sb.Length > 0) sb.Append(ch == '_' ? "" : " "); sb.Append(ch); gap = false; }
                    else gap = true;
                }
                string s = sb.ToString().Trim();
                while (s.Contains("  ")) s = s.Replace("  ", " ");
                if (s.Length == 0) s = "column_" + (i + 1).ToString(Inv);
                if (s[0] >= '0' && s[0] <= '9') s = "_" + s;
                if (s.Length > 100) s = s.Substring(0, 100).TrimEnd();
                string baseName = s;
                int k = 2;
                while (seen.Contains(s)) { s = baseName + "_" + k.ToString(Inv); k++; }
                seen.Add(s);
                outp[i] = s;
            }
            return outp;
        }

        // ---- CSV ------------------------------------------------------------------------------------
        static Stream OpenMaybeGzip(string path, out FileStream file)
        {
            file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 20, FileOptions.SequentialScan);
            int b1 = file.ReadByte(), b2 = file.ReadByte();
            file.Position = 0;
            if (b1 == 0x1F && b2 == 0x8B) return new GZipStream(file, CompressionMode.Decompress, false);
            return file;
        }

        /// <summary>The text encoding of the first bytes: UTF-8 / UTF-16 by BOM, else UTF-8 when valid, else Windows-1252.</summary>
        public static Encoding DetectEncoding(byte[] head, int n, out int bomLength)
        {
            bomLength = 0;
            if (n >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF) { bomLength = 3; return new UTF8Encoding(false); }
            if (n >= 2 && head[0] == 0xFF && head[1] == 0xFE) { bomLength = 2; return new UnicodeEncoding(false, false); }
            if (n >= 2 && head[0] == 0xFE && head[1] == 0xFF) { bomLength = 2; return new UnicodeEncoding(true, false); }
            try
            {
                Decoder d = new UTF8Encoding(false, true).GetDecoder();
                d.GetCharCount(head, 0, n, false);
                return new UTF8Encoding(false);
            }
            catch (DecoderFallbackException) { return Encoding.GetEncoding(1252); }
        }

        /// <summary>The delimiter (, ; tab |) that splits the first lines most consistently, outside quotes.</summary>
        public static char SniffDelimiter(string sample, char hint)
        {
            char[] cands = { ',', ';', '\t', '|' };
            List<string> lines = new List<string>();
            StringBuilder cur = new StringBuilder();
            bool q = false;
            for (int i = 0; i < sample.Length && lines.Count < 50; i++)
            {
                char c = sample[i];
                if (c == '"') q = !q;
                if (!q && (c == '\n' || c == '\r'))
                {
                    if (cur.Length > 0) lines.Add(cur.ToString());
                    cur.Length = 0;
                    continue;
                }
                cur.Append(c);
            }
            if (lines.Count == 0 && cur.Length > 0) lines.Add(cur.ToString());
            if (lines.Count > 1 && lines.Count < 50 && cur.Length > 0) { }   // last partial line is left out
            char best = hint != '\0' ? hint : ',';
            double bestScore = 0;
            foreach (char d in cands)
            {
                List<int> counts = new List<int>();
                foreach (string line in lines)
                {
                    int k = 0; bool inq = false;
                    foreach (char c in line) { if (c == '"') inq = !inq; else if (c == d && !inq) k++; }
                    counts.Add(k);
                }
                if (counts.Count == 0 || counts[0] == 0) continue;
                int first = counts[0];
                int same = 0;
                foreach (int k in counts) if (k == first) same++;
                double score = (double)same / counts.Count * 1000 + first;
                if (d == hint) score += 0.5;
                if (score > bestScore) { bestScore = score; best = d; }
            }
            return best;
        }

        public static ImportResult Csv(LocalConnection conn, string path, string table, ImportOptions options)
        {
            ImportOptions o = options ?? new ImportOptions();
            if (!string.IsNullOrEmpty(table)) o.Table = table;
            if (o.Format == null) o.Format = "csv";
            if (o.SourcePath == null) o.SourcePath = path;
            Importer imp = new Importer(conn, o, string.IsNullOrEmpty(o.NameHint) ? path : o.NameHint);
            FileStream file;
            byte[] head = new byte[65536];
            int n;
            using (Stream s = OpenMaybeGzip(path, out file))
            {
                n = 0;
                int c;
                while (n < head.Length && (c = s.Read(head, n, head.Length - n)) > 0) n += c;
            }
            int bom;
            Encoding enc = DetectEncoding(head, n, out bom);
            char delim = o.Delimiter;
            if (delim == '\0')
            {
                string lowerPath = path.ToLowerInvariant();
                char hint = lowerPath.EndsWith(".tsv", StringComparison.Ordinal) || lowerPath.EndsWith(".tsv.gz", StringComparison.Ordinal) || lowerPath.EndsWith(".tab", StringComparison.Ordinal) ? '\t' : '\0';
                string text = enc.GetString(head, bom, n - bom);
                delim = SniffDelimiter(text, hint);
            }
            Stream st = OpenMaybeGzip(path, out file);
            StreamReader reader = new StreamReader(st, enc, true, 1 << 16);
            using (CsvSource src = new CsvSource(reader, file, delim))
            {
                return imp.ImportStrings(src, null);
            }
        }

        // ---- XLSX -----------------------------------------------------------------------------------
        public static string[] XlsxSheets(string path)
        {
            using (FileStream f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (ZipArchive zip = new ZipArchive(f, ZipArchiveMode.Read))
            {
                bool d1904;
                List<string[]> sheets = XlsxSource.SheetList(zip, out d1904);
                string[] names = new string[sheets.Count];
                for (int i = 0; i < names.Length; i++) names[i] = sheets[i][0];
                return names;
            }
        }

        public static ImportResult Xlsx(LocalConnection conn, string path, string sheet, string table, ImportOptions options)
        {
            ImportOptions o = options ?? new ImportOptions();
            if (!string.IsNullOrEmpty(table)) o.Table = table;
            if (o.Format == null) o.Format = "xlsx";
            if (o.SourcePath == null) o.SourcePath = path;
            using (XlsxSource src = new XlsxSource(path, sheet))
            {
                string defaultName = string.IsNullOrEmpty(o.NameHint) ? path : o.NameHint;
                string[] all = null;
                try { all = XlsxSheets(path); } catch { }
                if (all != null && all.Length > 1) defaultName = Path.GetFileNameWithoutExtension(defaultName) + "_" + src.SheetName + ".xlsx";
                Importer imp = new Importer(conn, o, defaultName);
                return imp.ImportStrings(src, null);
            }
        }

        // ---- SQLite ---------------------------------------------------------------------------------
        static string FileUri(string path)
        {
            string p = path.Replace('\\', '/');
            StringBuilder sb = new StringBuilder("file:");
            if (p.StartsWith("//", StringComparison.Ordinal)) sb.Append("//");
            else sb.Append("///");
            foreach (char c in p)
            {
                if (c == '%' || c == '?' || c == '#' || c == ' ' || c < 0x20) sb.Append('%').Append(((int)c).ToString("X2", Inv));
                else sb.Append(c);
            }
            sb.Append("?mode=ro");
            return sb.ToString();
        }

        static string Attach(LocalConnection conn, string path)
        {
            string alias = "src_" + Guid.NewGuid().ToString("N").Substring(0, 8);
            using (LocalCommand c = new LocalCommand(conn, "ATTACH DATABASE ? AS " + alias))
            {
                c.Parameters.Add(new LocalParameter("uri", FileUri(path)));
                c.ExecuteNonQuery();
            }
            return alias;
        }

        public static string[] SqliteTables(LocalConnection conn, string path)
        {
            string alias = Attach(conn, path);
            try { return ListTables(conn, alias).ToArray(); }
            finally { try { conn.Execute("DETACH DATABASE " + alias); } catch { } }
        }

        static List<string> ListTables(LocalConnection conn, string alias)
        {
            List<string> list = new List<string>();
            using (LocalCommand c = new LocalCommand(conn, "SELECT name FROM " + alias + ".sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_semaphore%' ESCAPE '\\' ORDER BY name"))
            using (DbDataReader r = c.ExecuteReader())
            {
                while (r.Read()) list.Add(r.GetString(0));
            }
            return list;
        }

        static string SafeDecl(string decl)
        {
            if (string.IsNullOrEmpty(decl)) return "";
            foreach (char c in decl) if (!(char.IsLetterOrDigit(c) || c == ' ' || c == '(' || c == ')' || c == ',' || c == '_')) return "";
            return decl;
        }

        /// <summary>Copies tables of another SQLite file (attached read-only). tables null or empty: every table.</summary>
        public static List<ImportResult> Sqlite(LocalConnection conn, string path, string[] tables, ImportOptions options)
        {
            ImportOptions o = options ?? new ImportOptions();
            if (o.Format == null) o.Format = "sqlite";
            if (o.SourcePath == null) o.SourcePath = path;
            string alias = Attach(conn, path);
            List<ImportResult> results = new List<ImportResult>();
            try
            {
                List<string> have = ListTables(conn, alias);
                List<string> pick = new List<string>();
                if (tables == null || tables.Length == 0) pick.AddRange(have);
                else foreach (string t in tables)
                    {
                        string found = null;
                        foreach (string h in have) if (string.Equals(h, t, StringComparison.OrdinalIgnoreCase)) { found = h; break; }
                        if (found == null) throw new LocalException("The file has no table named \"" + t + "\".");
                        pick.Add(found);
                    }
                if (pick.Count == 0) throw new LocalException("The SQLite file has no tables.");
                if (pick.Count > 1 && !string.IsNullOrEmpty(o.Table)) throw new LocalException("Pick one table of the file when you name the target table.");
                foreach (string t in pick)
                {
                    ImportOptions one = Clone(o);
                    Importer imp = new Importer(conn, one, t + ".sqlite");
                    List<string[]> cols = new List<string[]>();
                    using (LocalCommand c = new LocalCommand(conn, "SELECT name, type FROM " + alias + ".pragma_table_info(?)"))
                    {
                        c.Parameters.Add(new LocalParameter("t", t));
                        using (DbDataReader r = c.ExecuteReader())
                            while (r.Read()) cols.Add(new string[] { r.GetString(0), r.IsDBNull(1) ? "" : r.GetString(1) });
                    }
                    if (cols.Count == 0) continue;
                    List<string> rawNames = new List<string>();
                    foreach (string[] col in cols) rawNames.Add(col[0]);
                    string[] names = SafeColumnNames(rawNames);
                    string[] decls = new string[cols.Count];
                    for (int i = 0; i < cols.Count; i++) decls[i] = SafeDecl(cols[i][1]);
                    try
                    {
                        imp.CreateStaging(imp.Staging, names, decls);
                        StringBuilder sel = new StringBuilder();
                        for (int i = 0; i < cols.Count; i++) { if (i > 0) sel.Append(", "); sel.Append(LocalConnection.Quote(cols[i][0])); }
                        imp.Report("importing", 0, 0, 0);
                        conn.Execute("BEGIN IMMEDIATE");
                        conn.Execute("INSERT INTO " + LocalConnection.Quote(imp.Staging) + " SELECT " + sel.ToString() + " FROM " + alias + "." + LocalConnection.Quote(t));
                        conn.Execute("COMMIT");
                        imp.CheckCancel();
                        long rows = conn.ScalarLong("SELECT COUNT(*) FROM " + LocalConnection.Quote(imp.Staging));
                        results.Add(imp.Publish(rows, names, decls));
                    }
                    catch (LocalException e)
                    {
                        imp.DropStaging();
                        if ((e.Code & 0xFF) == Native.INTERRUPT) throw new LocalException("The import was cancelled.", Native.INTERRUPT);
                        throw;
                    }
                    catch
                    {
                        imp.DropStaging();
                        throw;
                    }
                }
            }
            finally
            {
                try { conn.Execute("DETACH DATABASE " + alias); } catch { }
            }
            return results;
        }

        static ImportOptions Clone(ImportOptions o)
        {
            ImportOptions c = new ImportOptions();
            c.Table = o.Table; c.Replace = o.Replace; c.SourceLabel = o.SourceLabel; c.SourcePath = o.SourcePath; c.ETag = o.ETag; c.Format = o.Format;
            c.FileBytes = o.FileBytes; c.NameHint = o.NameHint; c.Delimiter = o.Delimiter; c.HasHeader = o.HasHeader; c.SampleRows = o.SampleRows; c.BatchRows = o.BatchRows; c.Progress = o.Progress; c.ProgressMs = o.ProgressMs;
            return c;
        }

        // ---- Columnar (parquet, arrow, feather) through SemColumnar ---------------------------------
        static Type FindType(string name)
        {
            foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type t = null;
                try { t = a.GetType(name, false); } catch { }
                if (t != null) return t;
            }
            return null;
        }

        public static bool ColumnarAvailable { get { return FindType(ColumnarTypeName) != null; } }

        static Exception Unwrap(Exception e)
        {
            while (e is TargetInvocationException && e.InnerException != null) e = e.InnerException;
            return e;
        }

        public static ImportResult Columnar(LocalConnection conn, string path, string table, ImportOptions options)
        {
            ImportOptions o = options ?? new ImportOptions();
            if (!string.IsNullOrEmpty(table)) o.Table = table;
            if (o.Format == null) o.Format = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
            if (o.SourcePath == null) o.SourcePath = path;
            Type t = FindType(ColumnarTypeName);
            if (t == null) throw new LocalException("Parquet and Arrow files need Semaphore's columnar reader (server\\Columnar.cs), which is not in this copy. Save the data as CSV, or update Semaphore.");
            MethodInfo open = t.GetMethod("Open", BindingFlags.Public | BindingFlags.Static, null, new Type[] { typeof(string) }, null);
            if (open == null) throw new LocalException(ColumnarTypeName + " has no Open(string).");
            object reader;
            try { reader = open.Invoke(null, new object[] { path }); }
            catch (Exception e) { Exception inner = Unwrap(e); throw new LocalException("Could not read the file: " + inner.Message, inner); }
            if (reader == null) throw new LocalException("The columnar reader returned nothing for this file.");
            try
            {
                Type iface = null;
                foreach (Type i in reader.GetType().GetInterfaces()) if (i.Name == "ITableReader") { iface = i; break; }
                if (iface == null) iface = reader.GetType();
                PropertyInfo pn = iface.GetProperty("Names"), pt = iface.GetProperty("Types");
                MethodInfo mn = iface.GetMethod("Next", new Type[] { typeof(object[]) });
                if (pn == null || pt == null || mn == null || mn.ReturnType != typeof(bool)) throw new LocalException("The columnar reader does not have Names, Types and Next(object[]).");
                string[] names = (string[])pn.GetValue(reader, null);
                string[] types = (string[])pt.GetValue(reader, null);
                Func<object[], bool> next = (Func<object[], bool>)Delegate.CreateDelegate(typeof(Func<object[], bool>), reader, mn);
                long length = 0;
                try { length = new FileInfo(path).Length; } catch { }
                Importer imp = new Importer(conn, o, string.IsNullOrEmpty(o.NameHint) ? path : o.NameHint);
                Func<object[], bool> guarded = delegate (object[] row)
                {
                    try { return next(row); }
                    catch (Exception e) { throw new LocalException("Could not read the file: " + Unwrap(e).Message, Unwrap(e)); }
                };
                return imp.ImportTyped(names, types, guarded, null, length);
            }
            finally
            {
                IDisposable d = reader as IDisposable;
                if (d != null) d.Dispose();
            }
        }

        /// <summary>Drops leftover staging tables of imports that did not finish (a crash, a killed server).</summary>
        public static int DropStagingTables(LocalConnection conn)
        {
            List<string> names = new List<string>();
            using (LocalCommand c = new LocalCommand(conn, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_semaphore\\_stage\\_%' ESCAPE '\\'"))
            using (DbDataReader r = c.ExecuteReader())
                while (r.Read()) names.Add(r.GetString(0));
            foreach (string n in names) conn.Execute("DROP TABLE IF EXISTS " + LocalConnection.Quote(n));
            return names.Count;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Running imports by job id, so a route or the server's stop can cancel them from another runspace
    // ---------------------------------------------------------------------------------------------
    public static class LocalJobs
    {
        static readonly Dictionary<string, ImportOptions> Running = new Dictionary<string, ImportOptions>();

        public static void Register(string job, ImportOptions o) { lock (Running) { Running[job] = o; } }
        public static void Unregister(string job) { lock (Running) { Running.Remove(job); } }
        public static int Count { get { lock (Running) { return Running.Count; } } }

        public static bool Cancel(string job)
        {
            ImportOptions o;
            lock (Running) { if (!Running.TryGetValue(job, out o)) return false; }
            o.Cancel();
            return true;
        }

        public static void CancelAll()
        {
            List<ImportOptions> all;
            lock (Running) { all = new List<ImportOptions>(Running.Values); }
            foreach (ImportOptions o in all) o.Cancel();
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Paths: local drives always; \\host\share only when the host is allowed; links resolved first
    // ---------------------------------------------------------------------------------------------
    public sealed class LocalPathException : Exception
    {
        public LocalPathException(string message) : base(message) { }
    }

    [SuppressUnmanagedCodeSecurity]
    internal static class PathNative
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetDriveTypeW(string root);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint QueryDosDeviceW(string device, StringBuilder target, int max);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
        [DllImport("mpr.dll", CharSet = CharSet.Unicode)] public static extern int WNetGetConnectionW(string local, StringBuilder remote, ref int length);
    }

    public static class LocalPaths
    {
        const uint INVALID = 0xFFFFFFFF;
        const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400;
        const uint TAG_MOUNT = 0xA0000003, TAG_SYMLINK = 0xA000000C;

        static string Refuse(string host)
        {
            return "Semaphore does not open files on \\\\" + host + ": opening a network path sends your Windows sign-in (NTLM) to that computer. Ask whoever looks after Semaphore to add \"" + host + "\" to localShares in config\\settings.local.json, or copy the file to this computer.";
        }

        /// <summary>The path to open (links and mapped drives resolved), or throws LocalPathException with the reason.</summary>
        public static string Resolve(string path, string[] allowedHosts)
        {
            if (path == null) throw new LocalPathException("No path given.");
            string p = path.Trim();
            if (p.Length >= 2 && p[0] == '"' && p[p.Length - 1] == '"') p = p.Substring(1, p.Length - 2).Trim();
            if (p.Length == 0) throw new LocalPathException("No path given.");
            return Walk(p, allowedHosts ?? new string[0], 0);
        }

        static bool HostAllowed(string host, string[] allowed)
        {
            foreach (string a in allowed) if (a != null && string.Equals(a.Trim(), host, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        static string Walk(string p, string[] allowed, int depth)
        {
            if (depth > 32) throw new LocalPathException("The path goes through too many links.");
            if (p.IndexOf('\0') >= 0) throw new LocalPathException("The path has a NUL character.");
            p = p.Replace('/', '\\');
            if (p.StartsWith("\\\\?\\", StringComparison.Ordinal) || p.StartsWith("\\\\.\\", StringComparison.Ordinal) || p.StartsWith("\\??\\", StringComparison.Ordinal))
            {
                if (p.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) p = "\\\\" + p.Substring(8);
                else if (p.Length >= 7 && p.StartsWith("\\\\?\\", StringComparison.Ordinal) && char.IsLetter(p[4]) && p[5] == ':' && p[6] == '\\') p = p.Substring(4);
                else throw new LocalPathException("Use a normal path such as C:\\data\\file.csv or \\\\server\\share\\file.csv.");
            }
            string root;
            if (p.StartsWith("\\\\", StringComparison.Ordinal))
            {
                int hs = 2;
                int he = p.IndexOf('\\', hs);
                if (he <= hs) throw new LocalPathException("A network path looks like \\\\server\\share\\folder\\file.csv.");
                string host = p.Substring(hs, he - hs);
                int se = p.IndexOf('\\', he + 1);
                string share = se < 0 ? p.Substring(he + 1) : p.Substring(he + 1, se - he - 1);
                if (share.Length == 0) throw new LocalPathException("A network path looks like \\\\server\\share\\folder\\file.csv.");
                foreach (char c in host)
                    if (!(char.IsLetterOrDigit(c) || c == '.' || c == '-' || c == '_')) throw new LocalPathException("Semaphore does not open this kind of network address (\\\\" + host + "). Use \\\\server\\share\\file.");
                if (!HostAllowed(host, allowed)) throw new LocalPathException(Refuse(host));
                string full;
                try { full = Path.GetFullPath(p); }
                catch (Exception e) { throw new LocalPathException("The path is not valid: " + e.Message); }
                if (!full.StartsWith("\\\\" + host + "\\" + share, StringComparison.OrdinalIgnoreCase)) throw new LocalPathException("The path leaves the share it names.");
                p = full;
                root = "\\\\" + host + "\\" + share + "\\";
            }
            else
            {
                if (p.Length < 3 || !char.IsLetter(p[0]) || p[1] != ':' || p[2] != '\\') throw new LocalPathException("Give the full path, starting with a drive letter (C:\\...) or a network share (\\\\server\\share\\...).");
                if (p.IndexOf(':', 2) >= 0) throw new LocalPathException("The path has a ':' after the drive letter.");
                try { p = Path.GetFullPath(p); }
                catch (Exception e) { throw new LocalPathException("The path is not valid: " + e.Message); }
                string drive = p.Substring(0, 2);
                root = drive + "\\";
                uint dt = PathNative.GetDriveTypeW(root);
                if (dt == 1) throw new LocalPathException("There is no drive " + drive + " on this computer.");
                StringBuilder dos = new StringBuilder(1024);
                if (PathNative.QueryDosDeviceW(drive, dos, dos.Capacity) > 0)
                {
                    string target = dos.ToString();
                    if (target.StartsWith("\\??\\", StringComparison.Ordinal))
                    {
                        // A subst drive: check where it really points.
                        string t = target.Substring(4);
                        if (t.StartsWith("UNC\\", StringComparison.OrdinalIgnoreCase)) t = "\\\\" + t.Substring(4);
                        return Walk(t.TrimEnd('\\') + p.Substring(2), allowed, depth + 1);
                    }
                }
                if (dt == 4)
                {
                    StringBuilder remote = new StringBuilder(1024);
                    int len = remote.Capacity;
                    if (PathNative.WNetGetConnectionW(drive, remote, ref len) != 0) throw new LocalPathException("Drive " + drive + " is a network drive whose server Semaphore cannot check. Use the \\\\server\\share path instead.");
                    return Walk(remote.ToString().TrimEnd('\\') + p.Substring(2), allowed, depth + 1);
                }
            }
            // Walk every component: a symbolic link or junction is resolved and the result checked again.
            string rest = p.Substring(root.Length);
            string[] parts = rest.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            string cur = root.TrimEnd('\\');
            for (int i = 0; i < parts.Length; i++)
            {
                string parent = cur;
                cur = cur + "\\" + parts[i];
                uint a = PathNative.GetFileAttributesW(cur);
                if (a == INVALID) throw new LocalPathException("No such file: " + p);
                if ((a & ATTR_REPARSE) == 0) continue;
                string target = ReadLink(cur);
                if (target == null) continue;   // cloud files, dedup and volume mount points stay local
                if (!(target.StartsWith("\\\\", StringComparison.Ordinal) || (target.Length >= 3 && target[1] == ':')))
                    target = parent + "\\" + target;   // a relative symbolic link
                string remaining = string.Join("\\", parts, i + 1, parts.Length - i - 1);
                return Walk(remaining.Length > 0 ? target.TrimEnd('\\') + "\\" + remaining : target, allowed, depth + 1);
            }
            uint fa = PathNative.GetFileAttributesW(p);
            if (fa == INVALID) throw new LocalPathException("No such file: " + p);
            if ((fa & ATTR_DIRECTORY) != 0) throw new LocalPathException("That is a folder, not a file: " + p);
            return p;
        }

        /// <summary>The target of a symbolic link or junction (\??\ prefix removed), or null for other reparse points.</summary>
        static string ReadLink(string path)
        {
            IntPtr h = PathNative.CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);   // OPEN_REPARSE_POINT | BACKUP_SEMANTICS
            if (h == new IntPtr(-1)) throw new LocalPathException("Semaphore cannot check the link " + path + ".");
            try
            {
                byte[] buf = new byte[16384];
                int got;
                if (!PathNative.DeviceIoControl(h, 0x000900A8, IntPtr.Zero, 0, buf, buf.Length, out got, IntPtr.Zero)) throw new LocalPathException("Semaphore cannot check the link " + path + ".");
                uint tag = BitConverter.ToUInt32(buf, 0);
                int baseOff;
                if (tag == TAG_SYMLINK) baseOff = 20;
                else if (tag == TAG_MOUNT) baseOff = 16;
                else return null;
                int subOff = BitConverter.ToUInt16(buf, 8), subLen = BitConverter.ToUInt16(buf, 10);
                string sub = Encoding.Unicode.GetString(buf, baseOff + subOff, subLen);
                if (sub.StartsWith("\\??\\", StringComparison.Ordinal))
                {
                    sub = sub.Substring(4);
                    if (sub.StartsWith("UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + sub.Substring(4);
                    if (sub.StartsWith("Volume{", StringComparison.OrdinalIgnoreCase)) return null;   // a local volume mounted in a folder
                    return sub;
                }
                if (tag == TAG_SYMLINK) return sub;   // relative (flag 1) or already a plain path
                return null;
            }
            finally { PathNative.CloseHandle(h); }
        }
    }
}

# Local database

Big files (10 million rows and more) are too big to read in the page. Semaphore loads them into a
database on this computer and queries them there with SQL, like any other server source.

- **Engine**: SQLite, the copy that ships with Windows (`C:\Windows\System32\winsqlite3.dll`). Nothing
  is installed. `server/LocalDb.cs` wraps it in ADO.NET classes (`SemLocal.LocalConnection`,
  `LocalCommand`, `LocalDataReader`), so the query and profile code is the same as for ODBC.
- **File**: `<home>\local\warehouse.sqlite` (WAL, 8 KB pages). SQLite's temporary files, used by large
  sorts and `DISTINCT`, go to `<home>\local\temp`; uploads wait in `<home>\local\incoming` while they are
  imported and are deleted afterwards; import progress is in `<home>\local\jobs`.
- **Source**: the built-in source `{ id: 'local', label: 'Local database', kind: 'local', provider: 'local' }`
  is always there; it needs no `sources.json` entry (an entry with the id `local` is skipped).

## Adding files

Data > Sources > **Add to local database**: pick or drop files, or type a path. Then **Profile and add**
puts a table in the catalog.

| Format | Files | Notes |
|---|---|---|
| Delimited text | `.csv` `.tsv` `.txt` `.tab` | Delimiter guessed from `,` `;` tab `\|`; RFC 4180 quotes and line breaks in quotes; UTF-8, UTF-8 or UTF-16 with a byte-order mark, else Windows-1252; first row is the header |
| Excel | `.xlsx` `.xlsm` | The first sheet unless one is named; dates by their number format; first row is the header |
| SQLite | `.sqlite` `.db` | Every table, or the one named; attached read-only and copied with its declared types |
| Parquet, Arrow | `.parquet` `.pq` `.arrow` `.feather` | Read by `server/Columnar.cs` |
| Any of these, gzipped | `*.gz` | Decompressed as they are read |

Types are inferred from the first 20,000 rows: `BOOLEAN` (true / false), `INTEGER`, `REAL`, `DATE`
(ISO dates and date-times) or `TEXT`. A whole number with a leading zero (`007`) stays text. When a
later row does not fit, the column is widened (integer to real, anything to text) and the rows already
loaded are converted, so nothing is lost. Empty cells are `NULL`. Column names keep letters, digits, `_`
and single spaces and are made unique; table names come from the file name (`Work Orders.csv` becomes
`work_orders`, then `work_orders_2`).

Dates are stored as ISO text in SQLite's own form: `yyyy-MM-dd` for a date, `yyyy-MM-dd HH:mm:ss` for a
date and time (offsets converted to UTC), so `date()`, `strftime()` and text comparison agree. A date
parameter is bound the same way. Readers return `DATE` columns as `DateTime`.

A name that is already taken is never overwritten or added to unless asked: the new table gets a suffix
(`orders_2`). **Append** (`-Append`, `X-Append: 1`, `append: true`, `--append yes`) adds the rows to the
table of that name, matching columns by name: columns the file lacks are left `NULL`, and columns the table
lacks are refused with their names; the table is created when it does not exist. Imports go into a staging
table and are renamed (or appended) into place in one transaction at the end. Replacing a
table (`-Replace`, or `X-Replace: 1` on an upload) drops the old one in that same transaction, so a
re-import never leaves half a table, and a failed or stopped import leaves the old table as it was.
Every table has a row in `_semaphore_tables`: source label, path, format, time, rows, columns, file size,
ETag and size in the database.

Measured on the development workstation: 2,000,000 CSV rows (92 MB, 6 columns) in about 2 s
(950,000-1,040,000 rows/s); 1,000,000 Parquet rows in about 1.3 s.

## Network paths

A path such as `\\fileserver01\share\orders.csv` is opened only when `fileserver01` is listed in
`localShares` in `config\settings.local.json`:

```json
{ "localShares": ["fileserver01", "files.corp.example"], "localImportMaxGB": 20 }
```

Opening `\\server\share` makes Windows send the user's sign-in (NTLM) to that server, so Semaphore checks
the host name before anything touches the path. Mapped network drives, `subst` drives, symbolic links and
junctions are resolved first and their target is checked the same way; device paths (`\\.\`, `\\?\GLOBALROOT`)
and WebDAV addresses (`\\host@SSL\...`) are refused.

`localImportMaxGB` (default 20) caps an upload from the page; the body streams to disk and is never held in
memory.

## Read-only on the query path

`/api/query` and `/api/profile` open the file with `SQLITE_OPEN_READONLY`, `PRAGMA query_only`, no
`ATTACH`, and an authorizer that allows only reads (plus the schema pragmas `GetSchema` uses). The SQL guard
(`Test-SemSqlGuard`) still applies. Writes happen only through the import, rename and drop routes, and through
SQL scripts (below), which have a write path of their own.

## Routes and commands

| Route | Command |
|---|---|
| `GET /api/local/tables` | `local list` |
| `POST /api/local/import` (raw file body, `X-File-Name`, optional `X-Table`, `X-Sheet`, `X-Replace`) | (the page only; the CLI reads files in place) |
| `POST /api/local/import-path { path, sheet?, table?, replace? }` | `local import --file <path> [--table] [--sheet] [--replace yes]` |
| `POST /api/local/sheets { path }` | `local sheets --file <path>` |
| `GET /api/local/import-status/<job>` | `local status --id <job>` |
| `POST /api/local/import-cancel { job }` | (the page's Stop button) |
| `POST /api/local/tables/<name>/rename { name }` | `local rename --id <name> --to <new>` |
| `DELETE /api/local/tables/<name>` | `local delete --id <name> --yes` |
| `POST /api/local/script-run { plan, params }` or `{ id }` | `script run --id <id>` |
| `GET /api/local/scripts`, `GET`, `PUT`, `DELETE /api/local/scripts/<id>` | `script list`, `script get`, `script put`, `script delete` |
| `POST /api/local/export { table, format }` (the file) | `local export --id <name> --format <f> --file <path>` |
| `POST /api/local/import` with `X-Keep: 1` (kept in `<home>\local\sources`) | `local sources` lists them |

Imports run on their own runspaces (not the query pool), so a long import never holds the server or other
queries.

For other server code (a connector that downloads a file, a scheduled re-import):

```powershell
Import-SemLocalFile -HomeDir $home -Path $file [-Table name] [-Sheet name] [-SourceLabel 's3://bucket/key'] [-ETag '"..."'] [-Replace | -Append]
# -> @{ Table; Rows; Columns; Ms; Tables; Names; Types; Warnings; Format; TotalRows; Appended }
Export-SemLocalTable -HomeDir $home -Name orders -Path C:\out\orders.parquet -Format parquet   # or arrow
```

## SQL scripts

SQL desk > **Script** runs several statements against the local database in one transaction: `CREATE`, `DROP`
and `ALTER TABLE`, `CREATE VIEW`, `INSERT ... SELECT`, `UPDATE` (also `UPDATE ... FROM`), `DELETE`, upserts
(`INSERT ... ON CONFLICT`), CTEs, window functions, everything SQLite has. Analysts write in their own SQL
language (Settings > SQL, or the picker in Script mode); the page shows the script as it will run in SQLite,
with notes, before anything runs. An error rolls the whole script back and names the statement and its line.

`src/core/script.ts` splits the script (strings, comments, `BEGIN ... END` blocks and, in T-SQL, statements
without `;` honoured), translates each statement (`translateSql` plus what SQLite lacks) and builds a plan.
`server/LocalScript.cs` runs the plan; the server checks the plan's shape again and SQLite's authorizer checks
every statement as it is prepared, so the page is never trusted.

| Written | Runs as |
|---|---|
| `MERGE` (T-SQL, Oracle; `WHEN MATCHED [AND ...] THEN UPDATE / DELETE`, `WHEN NOT MATCHED [BY TARGET] THEN INSERT`, `WHEN NOT MATCHED BY SOURCE THEN UPDATE / DELETE`, Oracle's `UPDATE ... WHERE ... DELETE WHERE`) | the unmatched source rows set aside in a temp table, then `UPDATE ... FROM`, the `DELETE`s, the `INSERT`, the by-source steps, in the script's transaction |
| `PIVOT (agg(x) FOR c IN (...))` | `agg(CASE WHEN c = v THEN x END)` per value, grouped by the other columns (named in the SELECT, or in the pivoted subquery) |
| `UNPIVOT (v FOR n IN (...))` | one `SELECT` per column joined with `UNION ALL` (empty values left out unless `INCLUDE NULLS`) |
| `BEGIN TRY ... END TRY BEGIN CATCH ... END CATCH`, Oracle `BEGIN ... EXCEPTION WHEN ... THEN ... END` | the block in a `SAVEPOINT`; on an error it is rolled back to that point and the handler runs, with `ERROR_MESSAGE()`, `ERROR_NUMBER()`, `SQLERRM`, `SQLCODE` set |
| `DECLARE @v INT = 1`, `SET @v = ...`, `SET @v += 1`, `SELECT @a = x, @b = y FROM ...`; Oracle `v NUMBER := 0;`, `v := ...;`, `SELECT x INTO v FROM ...` (exactly one row) | runner variables, bound as named parameters (`@v`) |
| A name the script reads but never declares (`@region`, `:region`) | a parameter the page asks for before the run |
| `IF ... ELSE`, Oracle `IF ... ELSIF ... END IF` | the runner evaluates `SELECT CASE WHEN (...) THEN 1 ELSE 0 END` |
| `WHILE` with `BREAK` / `CONTINUE`; Oracle `WHILE ... LOOP`, `LOOP ... EXIT WHEN`, `FOR i IN a .. b LOOP` | runner loops, at most 10,000 times each (Semaphore stops them there) |
| `SELECT ... INTO new_table FROM`, `#temp` tables, Oracle `CREATE GLOBAL TEMPORARY TABLE` | `CREATE [TEMP] TABLE ... AS SELECT` |
| `TOP (n)` at any level, `TRUNCATE TABLE`, `IDENTITY(1,1)`, `NVARCHAR(MAX)`, `BIT`, `dbo.`, `IF OBJECT_ID('t') IS NOT NULL`, `DATEADD`, `DATEDIFF`, `GETDATE()`, `NEWID()`, `+` joining text; Oracle `FROM DUAL`, `VARCHAR2(n CHAR)`, `NVL2`, `TO_DATE(x, 'YYYY-MM-DD')`, `EXECUTE IMMEDIATE 'fixed text'`; `CREATE OR REPLACE VIEW`; MySQL `ON DUPLICATE KEY UPDATE`; `DATE '...'` literals | their SQLite forms |
| `BEGIN TRAN`, `COMMIT`, `ROLLBACK`, `SET NOCOUNT ON`, `USE`, `GO`, Oracle `/` | left out with a note: the whole script is one transaction |

Refused, with the reason, before the script runs (and again by the authorizer): `ATTACH`, `DETACH`, `PRAGMA`
except reading `table_info`, `table_xinfo`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`,
`foreign_key_check`, `integrity_check`, `quick_check`, `table_list` and the page counts; `VACUUM` and
`VACUUM INTO`; `load_extension`; triggers and virtual tables; transactions and savepoints of the script's own;
any write to a `_semaphore*` table (insert, update, delete, drop, alter, index, or a rename onto such a name);
stored procedures (`EXEC`), cursors, table variables, sequences, `INSERT ALL`, PostgreSQL `DO` blocks.

Each statement's result has its own tab: rows (up to 500 per statement; at most 200 results are kept) or the rows
changed, with the time. Tables a script writes get their row count in `_semaphore_tables` (source "script ...").

**Live databases stay read-only.** Against another source a script may only `SELECT` (each runs through
`/api/query`, translated into that source's SQL). To bring rows into the local database, write

```sql
IMPORT INTO erp_stock [REPLACE | APPEND] FROM SOURCE erp AS (SELECT id, qty FROM stock WHERE site = 'North')
```

at the top level of a script: the SELECT is translated into the source's SQL, runs through the guarded read path
(`Test-SemSqlGuard`, the read-only connection, Lazarette), and its rows are swapped in with `Import-SemLocalFile`.
What came before it in the script is committed first. Writing to a live source is refused; an administrator may
allow it per source in a later version.

**Saved scripts** live in `<home>\scripts\<id>.json` with their text, SQL language and plan, so a pipeline (and
`Semaphore-CLI.bat script run --id <id>`) can run them without the page. Pipelines: [PIPELINES.md](PIPELINES.md).

## Exports

The local tables list (the download button on each table) and a Table flag on a local table (the inspector's
"All of ...") export the whole table:

| Format | File |
|---|---|
| CSV | UTF-8 with a byte-order mark, RFC 4180 quotes; text starting with `=`, `+`, `-` or `@` gets a leading `'` |
| Parquet, Arrow | `server/Columnar.cs`'s writers |
| SQLite | a new one-table `.sqlite` file with the same declared types, filled through its own connection (no `ATTACH`) |
| Excel (.xlsx) | one sheet, a header row, numbers, dates and booleans typed; at most 1,048,576 rows, with a note when more were left out |

The server writes the file to `<home>\local\temp`, streams it with `Content-Disposition: attachment` and deletes
it. From the command line: `Semaphore-CLI.bat local export --id orders --format parquet --file C:\out\orders.parquet`.

## Parquet and Arrow

`server/Columnar.cs` (namespace `SemColumnar`) reads and writes them. It is compiled in its own `Add-Type`
call, and `LocalDb.cs` never names it at compile time: the importer finds `SemColumnar.ColumnarFiles` in
the loaded assemblies, calls `Open(path)` and reads rows through a delegate bound to `ITableReader.Next`,
so the row loop stays in C#. Either file compiles without the other; without `Columnar.cs` a Parquet file
is refused with a message.

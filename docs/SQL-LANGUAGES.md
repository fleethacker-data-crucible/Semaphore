# SQL languages and compatibility

When a flag is flipped over, its footer names the SQL language used to generate the query. The SQL section explains its identifier quotes, date functions, row limit and value markers. The selected source's catalog `dialect` determines the language; the connection driver can change the parameter marker style.

## Implemented profiles

| Catalog dialect | Label on the card | Important syntax and limits |
| --- | --- | --- |
| `postgres` | PostgreSQL | Double-quoted identifiers, `date_trunc`, `LIMIT`; native `$1` markers or driver `?` markers. |
| `oracle` | Oracle SQL | Double-quoted identifiers, `TRUNC`, `FETCH FIRST`; native `:p1` markers or driver `?` markers. Confirm the target Oracle version supports the generated row limit. |
| `access` | Microsoft Access SQL | Bracketed identifiers, Access date functions, `TOP`, positional `?` markers. `COUNT(DISTINCT)` is refused by the renderer. |
| `tsql` | T-SQL (SQL Server / Azure SQL) | Bracketed identifiers, `TOP`, `DATETRUNC`; native `@p1` markers or driver `?` markers. Date grouping requires SQL Server 2022+ or a compatible Azure SQL engine. |
| `ansi` | ANSI-like SQL profile | Double-quoted identifiers, `date_trunc`, `LIMIT`, positional markers. This is a specific profile used for compatible sources such as the Athena path, not universal ANSI SQL. |

Values listed as parameters are supplied separately by the driver. A query displayed with `$1`, `:p1`, `@p1` or `?` is not a complete copy-and-run script for an arbitrary SQL editor. Do not concatenate business values into SQL to remove those markers.

For sample and CSV sources, Semaphore calculates the results in the browser. The flipped card identifies the displayed SQL as reference SQL, so the source label is not mistaken for evidence of a live database connection.

## Broad compatibility

The goal is to support the SQL systems analysts need through explicit, tested profiles. SQL dialects differ in quoting, date arithmetic, limits, joins, types and driver bindings. A connection through ODBC/OLE DB alone does not make every SQL language compatible. Qlik load scripts and expressions have their own supported import subset; they are not interchangeable SQL dialects.

MySQL/MariaDB, SQLite, Snowflake, BigQuery and other engines do not currently have dedicated renderer profiles. Do not claim compatibility by labeling an unknown source `ansi`. New support should add a source/profile definition, quoting, date grouping and row-limiting rules, parameter binding checks, and query-result tests on the intended engine and version. Unknown dialect values are rejected rather than silently rendered as another language.

Target database names, versions and available drivers are needed to prioritize and validate the next profiles. Existing renderer tests establish generated SQL behavior; they do not establish that every workstation has a driver or that every vendor/version has been validated live.

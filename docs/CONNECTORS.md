# Connectors: Redshift, Synapse, Foundry, RDS and Aurora, S3 (and what the others prove)

All run on Windows PowerShell 5.1 with the .NET Framework only: no installs, no admin, no custom DLLs. Code: `server/Connectors.ps1`, `server/Aws.ps1` (RDS) and `server/S3.ps1` (S3). Secrets come from Lazarette, read by name over loopback ([VAULT.md](VAULT.md)), or the environment, never from `sources.json`. Every connector is **read-only by construction**: Semaphore's SQL guard allows one SELECT.

| Connector | `provider` | `kind` | SQL profile | Talks to |
|---|---|---|---|---|
| Amazon Redshift | `redshift-data` | `aws-redshift` | `ansi` | Redshift Data API over HTTPS, SigV4 signed with the Athena signer (provisioned cluster or serverless) |
| Azure Synapse / Azure SQL | `synapse` (runs as `odbc`) | `azure-synapse` | `synapse` | ODBC Driver 17/18 for SQL Server, Microsoft Entra sign-in |
| Palantir Foundry | `foundry` | `foundry` | `spark` | Foundry SQL queries API (`/api/v2/sqlQueries/execute`, `getStatus`, `getResults` as CSV), bearer token |
| Amazon RDS and Aurora | `odbc` | `aws-rds` + `engine` | `postgres`, `mysql`, `tsql` or `oracle` by engine | The ODBC driver already installed for the engine, TLS on, a password from Lazarette or an RDS IAM auth token |
| Amazon S3 (import) | settings, not a source | | | ListObjectsV2 and GetObject, SigV4 signed, streamed to disk and loaded into the local database |

## sources.json

```json
{ "id": "wh", "kind": "aws-redshift", "provider": "redshift-data", "region": "us-gov-west-1", "database": "dev",
  "clusterId": "maint-cluster", "dbUser": "semaphore_ro",
  "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
{ "id": "syn", "kind": "azure-synapse", "provider": "synapse", "server": "ws-ondemand.sql.azuresynapse.net",
  "database": "maint", "authentication": "ActiveDirectoryIntegrated" }
{ "id": "fnd", "kind": "foundry", "provider": "foundry", "host": "https://acme.palantirfoundry.com", "branch": "master",
  "datasets": { "ops.work_orders": "/Acme/Maintenance/work_orders" }, "vault": { "token": "FOUNDRY_TOKEN" } }
```

**Redshift.** Serverless uses `"workgroup"` instead of `clusterId`/`dbUser`; `"secretArn"` signs in through Secrets Manager. Parameters become named `:p1`.. with a cast per type (the API carries values as text). Profiling uses `ListTables`/`DescribeTable`, so nothing is scanned. The AWS keys come from the names the `vault` block gives (`accessKeyId`, `secretAccessKey`, optional `sessionToken`), shared with Semaphore in Lazarette, or from the environment.

**Synapse.** The connection string is built for you: encrypted, certificate checked, `ApplicationIntent=ReadOnly`. The host must end in `.sql.azuresynapse.net` or `.database.windows.net` (or the US Gov equivalents). `authentication` is `ActiveDirectoryIntegrated` (default), `ActiveDirectoryInteractive`, `ActiveDirectoryMsi`, `ActiveDirectoryPassword` or `SqlPassword`; the last two need a `vault` block naming both shares, for example `"vault": { "user": "SYN_USER", "password": "SYN_PASSWORD" }`; a block without `user` is refused rather than signing in with an empty user. Synapse has no `DATETRUNC`, so the `synapse` SQL profile groups dates with `DATEADD`/`DATEDIFF` (weeks from Monday 1900-01-01).

**Foundry.** Foundry takes Spark SQL and **no bound parameters**, so each value is checked and written inline: numbers must be finite, text is escaped (`\` and `'`), control characters are refused, dates are `DATE'...'`. `datasets` maps a catalog table name to a dataset path or RID; Semaphore swaps `` `ops`.`work_orders` `` for `` `/Acme/Maintenance/work_orders` ``. CSV comes back untyped, so columns are typed from their values (numbers without leading zeros, dates, else text) and an empty cell is null. Profiling samples `LIMIT 200`.

## Amazon RDS and Aurora

An RDS or Aurora database is an ODBC source whose connection string Semaphore builds for you (`server/Aws.ps1`) from the ODBC driver **already installed** on the computer. Nothing is installed, and an `aws-rds` entry with a `"connection"` is refused.

```json
{ "id": "maint", "label": "Maintenance (Aurora)", "kind": "aws-rds", "provider": "odbc", "engine": "aurora-postgresql",
  "host": "maint.cluster-ro-abc123.us-gov-west-1.rds.amazonaws.com", "port": 5432, "database": "maint",
  "region": "us-gov-west-1", "auth": "iam", "user": "semaphore_ro",
  "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
{ "id": "supply", "label": "Supply (SQL Server)", "kind": "aws-rds", "provider": "odbc", "engine": "sqlserver",
  "host": "supply.abc123.us-gov-west-1.rds.amazonaws.com", "database": "supply", "region": "us-gov-west-1",
  "auth": "password", "vault": { "password": "SUPPLY_PASSWORD", "user": "SUPPLY_USER" } }
```

Fields: `engine` (required: `postgres`, `aurora-postgresql`, `mysql`, `mariadb`, `aurora-mysql`, `sqlserver` or `oracle`), `host` (the instance or cluster endpoint; for Aurora use the **reader** endpoint, `cluster-ro-`), `port` (default 5432, 3306, 1433 or 1521 by engine), `database` (for Oracle the service name), `region`, `auth` (`password`, the default, or `iam`), `user` (the database user name, not a secret), and optionally `driver` (the exact name of an installed driver), `caBundle` (full path to the RDS certificate bundle, `global-bundle.pem`, to verify the server certificate) and, for Oracle, `tcps`.

| `engine` | Driver Semaphore looks for (best first) | TLS | Read-only session | SQL profile |
|---|---|---|---|---|
| `postgres`, `aurora-postgresql` | `PostgreSQL Unicode(x64)`, `PostgreSQL Unicode` (psqlODBC) | `SSLmode=require`; `verify-full` with `sslrootcert` when `caBundle` is set | `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, UTC | `postgres` |
| `mysql`, `aurora-mysql` | `MySQL ODBC 8.x / 9.x Unicode Driver` (newest first), then `MariaDB ODBC 3.x Driver` | `SSLMODE=REQUIRED`; `VERIFY_IDENTITY` with `SSLCA` when `caBundle` is set | `SET SESSION TRANSACTION READ ONLY`, UTC, `ANSI_QUOTES` | `mysql` |
| `mariadb` | `MariaDB ODBC 3.x Driver`, then the MySQL driver | MariaDB driver `FORCETLS=1` (`SSLVERIFY=1` with `SSLCA` when `caBundle` is set); MySQL driver as above | as MySQL | `mysql` |
| `sqlserver` | `ODBC Driver 18 for SQL Server`, then 17 | `Encrypt=yes;TrustServerCertificate=no` | `ApplicationIntent=ReadOnly` | `tsql` |
| `oracle` | `Oracle in instantclient_...` (Instant Client with its ODBC package), then `Oracle in OraClient...` | TCPS with `"tcps": true` (usually port 2484, set up in the RDS option group); otherwise the option group's native network encryption | none: the SQL guard and a read-only login | `oracle` |

When no fitting driver is installed, a flag on the source answers `501 provider-unavailable` with a sentence that names the driver to ask IT for, for example *"No PostgreSQL ODBC driver is installed on this computer: Semaphore looked for "PostgreSQL Unicode(x64)" and "PostgreSQL Unicode" (psqlODBC) for the postgres source. Ask IT to install it (64-bit, to match Windows PowerShell); Semaphore never installs drivers."* Drivers are read from `ODBCINST.INI\ODBC Drivers` for the computer and for the user (a per-user driver install needs no admin rights).

**Password sign-in** (`"auth": "password"`, every engine): the `vault` block names the Lazarette shares of the password and, unless `"user"` is in the entry, of the user. They go in as `UID={..};PWD={..}` in memory for one connection.

**IAM sign-in** (`"auth": "iam"`, PostgreSQL, MySQL and MariaDB engines only: RDS has no IAM database authentication for SQL Server or Oracle). For each connection Semaphore signs an RDS auth token: a SigV4 presigned `GET` for service `rds-db` with `Action=connect` and `DBUser`, signed for `host:port`, valid 900 s, with the AWS session from Lazarette (the `vault` block's `accessKeyId`, `secretAccessKey` and optional `sessionToken`) or else the environment. The token is the password: it lives in memory for that connection, is scrubbed from every message and is never logged. The MySQL driver gets `ENABLE_CLEARTEXT_PLUGIN=1` (the token travels inside TLS). The database user needs `GRANT rds_iam TO semaphore_ro` (PostgreSQL) or `IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS'` (MySQL, MariaDB), and the AWS identity needs `rds-db:connect` (below).

**GovCloud and FIPS.** `us-gov-west-1` and `us-gov-east-1` sign with their own region in the `aws-us-gov` partition (hosts under `amazonaws.com`); China regions use `amazonaws.com.cn`. `"aws": { "fips": true }` in `config\settings.json` sends "Find RDS databases" and S3 to the FIPS endpoints (`rds-fips.<region>.amazonaws.com`, `s3-fips.<region>.amazonaws.com`). The database endpoint is whatever `host` says.

**Certificates.** `require` / `REQUIRED` encrypt but do not check the server certificate; set `caBundle` to check it. SQL Server always checks it (`TrustServerCertificate=no`), so Windows must trust the Amazon RDS root CAs: importing `global-bundle.pem` into the **current user's** Trusted Root store needs no admin rights.

**Find RDS databases.** The Data panel's RDS card calls `DescribeDBClusters` and `DescribeDBInstances` (query API, XML, SigV4 service `rds`, paged by `Marker`) for one region with the session in `aws.vault` (or the environment) and lists each database with a `sources.json` entry to copy: Aurora clusters with their reader endpoint, instances that are not cluster members, only engines Semaphore reads, and `"auth": "iam"` where IAM database authentication is on. **Semaphore does not write `sources.json`** (it has no route that writes it): the administrator pastes the entry into the file in the Semaphore folder and renames the share names.

## Amazon S3: browse and import

The Data panel's **Amazon S3** section lists the buckets an administrator allows, browses their folders, and imports picked objects, or a whole folder of a partitioned dataset, into the local database (`server/S3.ps1`). In `config\settings.json` (or `settings.local.json`):

```json
"s3": {
  "buckets": [
    { "bucket": "maint-exports", "region": "us-gov-west-1", "prefix": "semaphore/", "label": "Maintenance exports" },
    { "bucket": "lab-data", "region": "us-east-1", "endpoint": "https://bucket.vpce-0abc123.s3.us-east-1.vpce.amazonaws.com" }
  ],
  "maxObjectMb": 20480
},
"aws": { "fips": false, "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
```

- **The allowlist.** Only the listed buckets, and in each only keys under its `prefix`, can be listed or read. A slash is added to the prefix, so `sales` does not open `sales-archive/`. Anything else is refused with `403 s3-not-allowed` and a sentence, before AWS is asked. Bucket names match exactly; a bucket may be listed more than once with different prefixes. An `endpoint` (https, or http on 127.0.0.1) replaces the AWS host, for a VPC endpoint or a simulator. Buckets with dots in their names use path-style requests. A bucket's own `"fips"` overrides `aws.fips`.
- **Browsing.** `GET /api/s3/list` is one ListObjectsV2 page with delimiter `/`: folders, and objects with size, last modified and ETag, plus a continuation token behind **Show more**.
- **Importing.** `POST /api/s3/import { bucket, key | keys | prefix, table?, sheet?, replace? }` answers `202` with a job id at once, and the page follows `GET /api/s3/import-status/<job>` (phase, bytes, objects). The job runs on the server's worker pool. HeadObject (or the listing) gives each object's size and ETag; an object over `maxObjectMb` (default 20480) or more than the free disk space is refused. GetObject is **streamed to a file** under `<home>\local\incoming\<job>` in 1 MB pieces, never held in memory, with `If-Match` on the ETag (an object that changed since it was listed is refused); the bytes written must equal `Content-Length` and the listed size. A `.gz` object is expanded (a concatenated multi-stream gzip is refused, because the .NET Framework reads only its first stream). Then `Import-SemLocalFile` loads the file with `-SourceLabel s3://bucket/key#etag`, and the folder is removed. One import runs at a time; jobs are forgotten when Semaphore stops.
- **Partitioned prefixes.** **Import this whole folder** takes every data file below the prefix (CSV, TSV, text, JSON lines, Parquet or Excel, optionally `.gz`), skipping `_SUCCESS`, `.crc` files and other names starting with `_` or `.`, up to **2000 objects**. CSV and TSV parts must have the first part's header and become one file with the header once; JSON lines parts are joined; Parquet and Excel parts are loaded one after another into the same table (the first replaces it when asked). The label is `s3://bucket/prefix/#<hash of the parts' keys and ETags>`.
- **The local database** (`Import-SemLocalFile`) comes with the local database work. Until it is in the build, an import downloads and checks the files, then says "The local database is not available yet".

**IAM permissions** for the AWS session Semaphore uses (use `arn:aws-us-gov:` in GovCloud):

| What | Actions | Resource |
|---|---|---|
| Browse an allowlisted bucket | `s3:ListBucket` (an `s3:prefix` condition can match the allowlisted prefix) | `arn:aws:s3:::maint-exports` |
| Import objects | `s3:GetObject`, and `kms:Decrypt` on the key for SSE-KMS objects | `arn:aws:s3:::maint-exports/semaphore/*` |
| IAM sign-in to RDS or Aurora | `rds-db:connect` | `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId or cluster resource id>/<database user>` |
| Find RDS databases | `rds:DescribeDBInstances`, `rds:DescribeDBClusters` | `*`, or the instances and clusters to list |

## The SQL profiles

`synapse` is T-SQL for Synapse pools; `spark` is Spark SQL with backtick names (Foundry; also what Databricks SQL uses). `mysql` is MySQL and MariaDB (RDS and Aurora MySQL); its SQL rendering arrives with the MySQL and SQLite dialect work, and Semaphore turns on `ANSI_QUOTES` for MySQL sessions so double-quoted names work. An `aws-rds` source takes its profile from `engine` (`dialectForSource` in `src/core/catalog.ts`). See [SQL-LANGUAGES.md](SQL-LANGUAGES.md). `checkCatalog` ties each kind to its profile, so a Synapse source labelled `tsql` is reported.

## How well each is tested

| Piece | Test | What it proves | What it does not |
|---|---|---|---|
| ODBC and OLE DB | `tests/server/Drivers.Tests.ps1` runs Semaphore's own loading, guard, typed parameter binding, result writer, row cap, profiling and error mapping against **real** drivers (Microsoft Access Text ODBC driver and ACE OLE DB over a CSV folder). Skipped, and reported as skipped, where the driver is not installed. | The driver plumbing works for real: binding of date/number/string/boolean, types, truncation, errors without the connection string. | Any vendor's SQL or server behaviour (Postgres, Oracle, SQL Server, Access `.accdb`). |
| Athena | `Lake.Tests.ps1` (cost guard, cache, SigV4 against AWS's own test vector) and `Connectors.Tests.ps1` (failed and stopped queries, paging, row cap, AWS errors, unreachable endpoint), all against a simulated AWS on loopback. | Signing, the call sequence, paging, errors, no keys in messages. | That real AWS accepts exactly these calls and returns exactly these shapes. |
| Redshift, Foundry | `Connectors.Tests.ps1` against simulated services shaped from the vendors' public API documentation. | Request shape, polling, paging, typing, injection resistance, no secrets in messages. | Real accounts. The Foundry `queryId` is read from whichever status variant carries it, because the public page does not show the variant fields. |
| Synapse | Connection-string builder and the sign-in from Lazarette's shares. The SQL profile is rendered and checked as text. | The string is safe and complete. | A real Synapse pool. |
| RDS and Aurora | `Aws.Tests.ps1`: SigV4 presigning against AWS's published presigned-URL example, the IAM token against the AWS SDK's (botocore) test vector and a fixed-date GovCloud token with a session token (cross-checked with a separate implementation), settings, driver choice and the missing-driver sentences with a mocked driver list, the connection string per engine, session statements, Describe XML fixtures and paging through a mocked HTTP seam, secrets scrubbed. | Signing, strings, refusals, messages. | A real RDS database or driver: nothing connects to an engine. |
| S3 | `S3.Tests.ps1`: the allowlist, endpoints, ListObjectsV2 fixtures, GetObject streamed through a fake HTTP layer (sizes, If-Match, short bodies, limits, `.gz`), partitioned prefixes, the import contract and its stub, the routes, no secret in logs or answers, and one import through the real worker pool and HTTP seam against a simulated S3 on loopback. `tests/e2e/s3-browser.spec.ts`: the page against the mock server. | The whole path up to the importer. | Real S3, SSE-KMS objects, very large objects, and the local database importer itself. |

## For Anthony to validate on real services

1. **Redshift:** one provisioned cluster and one serverless workgroup; run a flag, a profile, a failing query. Check that `ExecuteStatement` with `DbUser` and with `WorkgroupName` is accepted, and that a `float8` and a `date` column arrive typed.
2. **Synapse:** a dedicated pool and a serverless pool with each `authentication` you use; check the date grouping (`DATEADD`/`DATEDIFF`) matches the numbers in the source, and that ODBC Driver 18 is on the thin clients.
3. **Foundry:** run a flag against a real dataset: confirm the status JSON carries `queryId` (or tell us where), that CSV with dates and nulls round-trips, and the dataset path/RID rewrite.
4. **Postgres, Oracle, SQL Server, Access `.accdb` over ODBC/OLE DB:** one flag each on the target machines; only the driver plumbing is proven here.
5. **Athena:** one real run in the target AWS partition, with the session shared from Lazarette.
6. **RDS and Aurora:** on a thin client with the drivers IT installs: one PostgreSQL or Aurora PostgreSQL source with `"auth": "iam"` and one with a password, one MySQL or Aurora MySQL with IAM (the cleartext plugin), one SQL Server (with the RDS CA trusted) and, if used, Oracle over TCPS. Check the missing-driver sentence on a machine without the driver, and "Find RDS databases" in GovCloud with and without `aws.fips`.
7. **S3:** browse an allowlisted bucket in GovCloud and, once the local database is in the build, import a CSV, a `.csv.gz` and a partitioned Parquet prefix; try an SSE-KMS object and one of several GB.

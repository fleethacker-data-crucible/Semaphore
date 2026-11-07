# Connectors: Redshift, Synapse, Foundry (and what the others prove)

All run on Windows PowerShell 5.1 with the .NET Framework only: no installs, no admin, no custom DLLs. Code: `server/Connectors.ps1`. Secrets come from Lazarette, read by name over loopback ([VAULT.md](VAULT.md)), or the environment, never from `sources.json`. Every connector is **read-only by construction**: Semaphore's SQL guard allows one SELECT.

| Connector | `provider` | `kind` | SQL profile | Talks to |
|---|---|---|---|---|
| Amazon Redshift | `redshift-data` | `aws-redshift` | `ansi` | Redshift Data API over HTTPS, SigV4 signed with the Athena signer (provisioned cluster or serverless) |
| Azure Synapse / Azure SQL | `synapse` (runs as `odbc`) | `azure-synapse` | `synapse` | ODBC Driver 17/18 for SQL Server, Microsoft Entra sign-in |
| Palantir Foundry | `foundry` | `foundry` | `spark` | Foundry SQL queries API (`/api/v2/sqlQueries/execute`, `getStatus`, `getResults` as CSV), bearer token |

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

## The SQL profiles

`synapse` is T-SQL for Synapse pools; `spark` is Spark SQL with backtick names (Foundry; also what Databricks SQL uses). See [SQL-LANGUAGES.md](SQL-LANGUAGES.md). `checkCatalog` ties each kind to its profile, so a Synapse source labelled `tsql` is reported.

## How well each is tested

| Piece | Test | What it proves | What it does not |
|---|---|---|---|
| ODBC and OLE DB | `tests/server/Drivers.Tests.ps1` runs Semaphore's own loading, guard, typed parameter binding, result writer, row cap, profiling and error mapping against **real** drivers (Microsoft Access Text ODBC driver and ACE OLE DB over a CSV folder). Skipped, and reported as skipped, where the driver is not installed. | The driver plumbing works for real: binding of date/number/string/boolean, types, truncation, errors without the connection string. | Any vendor's SQL or server behaviour (Postgres, Oracle, SQL Server, Access `.accdb`). |
| Athena | `Lake.Tests.ps1` (cost guard, cache, SigV4 against AWS's own test vector) and `Connectors.Tests.ps1` (failed and stopped queries, paging, row cap, AWS errors, unreachable endpoint), all against a simulated AWS on loopback. | Signing, the call sequence, paging, errors, no keys in messages. | That real AWS accepts exactly these calls and returns exactly these shapes. |
| Redshift, Foundry | `Connectors.Tests.ps1` against simulated services shaped from the vendors' public API documentation. | Request shape, polling, paging, typing, injection resistance, no secrets in messages. | Real accounts. The Foundry `queryId` is read from whichever status variant carries it, because the public page does not show the variant fields. |
| Synapse | Connection-string builder and the sign-in from Lazarette's shares. The SQL profile is rendered and checked as text. | The string is safe and complete. | A real Synapse pool. |

## For Anthony to validate on real services

1. **Redshift:** one provisioned cluster and one serverless workgroup; run a flag, a profile, a failing query. Check that `ExecuteStatement` with `DbUser` and with `WorkgroupName` is accepted, and that a `float8` and a `date` column arrive typed.
2. **Synapse:** a dedicated pool and a serverless pool with each `authentication` you use; check the date grouping (`DATEADD`/`DATEDIFF`) matches the numbers in the source, and that ODBC Driver 18 is on the thin clients.
3. **Foundry:** run a flag against a real dataset: confirm the status JSON carries `queryId` (or tell us where), that CSV with dates and nulls round-trips, and the dataset path/RID rewrite.
4. **Postgres, Oracle, SQL Server, Access `.accdb` over ODBC/OLE DB:** one flag each on the target machines; only the driver plumbing is proven here.
5. **Athena:** one real run in the target AWS partition, with the session shared from Lazarette.

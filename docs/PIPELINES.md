# Pipelines

A pipeline is an ordered list of steps that rebuilds tidy tables in the [local database](LOCAL-DATABASE.md):
import the raw files, run the saved scripts that clean and join them, pull what a live database holds, then
mark what reads the results as out of date. Data > Sources > **Pipelines** lists them, edits them, runs them
and schedules them.

## Steps

| Step | What it does | Skipped when |
|---|---|---|
| **Import** | Reads a file into a table, swapped in whole (`Import-SemLocalFile -Replace`). The file is a path on this computer or a share listed in `localShares`, an upload kept with **Keep for pipelines** (`<home>\local\sources`), or an S3 object or prefix from the `s3.buckets` allowlist. | The source has not changed since the last run (size and modified time; the ETags and sizes for S3) and the table exists. **Force** (for the run) or **always import** (for the step) imports it anyway. |
| **Script** | Runs a saved script (SQL desk > Script, **Save**) in one transaction. | Never |
| **Pull** | Runs one SELECT on a live source through the normal read-only query path (`Test-SemSqlGuard`, the source's read-only connection, Lazarette for its sign-in) and swaps the rows in as a table, or adds them (`mode: append`). | Never |
| **Publish** | Marks the playbook snapshots that read the pipeline's tables from the local database as out of date (`invalidatedAt` on the snapshot), so the next page that can reach the local database, or `Semaphore-CLI.bat refresh run`, refreshes them. Report editions read the tables as they are when they are produced. | Never |

**Update now** runs the whole chain, or from a chosen step, on the local import pool (never the query workers),
one step after another. Each step's state, rows, time and warnings go to the run log; the boxes at the top of the
editor show the last run, left to right. The run stops at the first failed step and names it:

```
Step 2 (tidy orders) failed: Line 14: no such column: shipped_on
```

Every table a step builds is swapped in whole: imports and pulls fill a staging table and rename it in one
transaction, and a script commits at its end or rolls back. So a failed run never leaves half a table: the
steps before the failure are complete, the failed step's tables are as they were.

One pipeline runs at a time, across the server and the CLI (`<home>\pipelines\.running.json`, ignored when the
process that wrote it has stopped).

## Schedule

| Runs | Setting |
|---|---|
| Only when you click Update now | `{ "every": "off" }` |
| Every hour | `{ "every": "hourly", "minute": 15 }` |
| Every day | `{ "every": "daily", "time": "06:30" }` |
| Some days of the week | `{ "every": "weekly", "time": "06:30", "days": ["mon", "thu"] }` |

Times are this computer's local time. The running Semaphore server checks the schedules every 20 seconds and starts
a due run (one at a time). A time that passed while Semaphore was not running is skipped, or, with **Catch up**
(`"catchUp": true`), run once when the server starts. A schedule counts from when it was saved.

### Without the server: Windows Task Scheduler

`Semaphore-CLI.bat pipeline run <id>` runs a pipeline in the foreground, prints the run log and exits 0 when it
finished, 1 when a step failed. Task Scheduler runs it for the current user without administrator rights:

```bat
schtasks /Create /SC DAILY /ST 06:30 /TN "Semaphore pipeline nightly" /TR "\"C:\Tools\Semaphore\Semaphore-CLI.bat\" pipeline run nightly" /F
schtasks /Create /SC WEEKLY /D MON,THU /ST 06:30 /TN "Semaphore pipeline stock" /TR "\"C:\Tools\Semaphore\Semaphore-CLI.bat\" pipeline run stock --force yes" /F
schtasks /Run /TN "Semaphore pipeline nightly"
schtasks /Delete /TN "Semaphore pipeline nightly" /F
```

Without `/RU` the task runs as you, only while you are signed in, which needs no administrator rights and no stored
password. Use one or the other for a pipeline: the server's schedule or Task Scheduler.

## Files

```
<home>\pipelines\<id>.json            the pipeline (at most 256 KB, checked when saved and when run)
<home>\pipelines\state\<id>.json      last run, last scheduled time, each import's source fingerprint
<home>\pipelines\runs\<id>\<run>.json one run's log (the newest 30 are kept)
<home>\scripts\<id>.json              saved scripts: { version, name, dialect, text, plan }
```

```json
{
  "version": 1,
  "name": "Nightly",
  "steps": [
    { "id": "load", "kind": "import", "path": "\\\\fileserver01\\exports\\orders.csv", "table": "orders" },
    { "id": "erp", "kind": "pull", "source": "erp", "sql": "SELECT id, qty, updated FROM stock", "table": "erp_stock" },
    { "id": "tidy", "kind": "script", "script": "tidy-orders" },
    { "id": "pub", "kind": "publish" }
  ],
  "schedule": { "every": "daily", "time": "06:30", "catchUp": true }
}
```

Step ids and pipeline ids use lower-case letters, digits, `_` and `-`. The page checks a pipeline with the same
rules as the server (`src/core/pipeline.ts` `validatePipeline`, `server/Pipeline.ps1` `Test-SemPipeline`).

## Routes and commands

| Route | Command |
|---|---|
| `GET /api/pipelines` | `pipeline list` |
| `GET /api/pipelines/<id>` | `pipeline get --id <id>` |
| `PUT /api/pipelines/<id>` | `pipeline put --id <id> --file <json> --yes` |
| `DELETE /api/pipelines/<id>` | `pipeline delete --id <id> --yes` |
| `POST /api/pipelines/<id>/run { from?, force? }` -> 202 `{ run }` | `pipeline run <id> [--from <step>] [--force yes]` |
| `GET /api/pipelines/<id>/runs` | `pipeline runs --id <id>` |
| `GET /api/pipelines/<id>/runs/<run>` | `pipeline status --id <id> --run <run>` |
| `GET /api/local/sources` | `local sources` |

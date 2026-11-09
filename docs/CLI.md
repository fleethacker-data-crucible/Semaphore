# Semaphore from the command line

`Semaphore-CLI.bat <noun> <verb> [options]` runs the headless actions of the browser UI. It works on the Semaphore folder directly (`%USERPROFILE%\Semaphore`, or `SEMAPHORE_HOME`): no running server and no session token are needed, and the token never leaves the server. Windows PowerShell 5.1, no installs.

```
Semaphore-CLI.bat commands [--json]
Semaphore-CLI.bat hoist list --json
Semaphore-CLI.bat hoist put --id fleet --file page.json --yes
Semaphore-CLI.bat hoist delete --id fleet --dry-run
Semaphore-CLI.bat refresh run
```

| Option | Meaning |
|---|---|
| `--json` | One JSON document on standard output: `semaphore.result/1` (`schema`, `command`, `ok`, `result` or `error`), or `semaphore.commands/1` for `commands`. |
| `--out <file>` | Write that JSON to a file as UTF-8 without a BOM. |
| `--yes` | Required for commands that replace or remove saved data: the `put` and `delete` commands, `local delete`, `script put` and `delete`, `pipeline put` and `delete`, and `session stop`. Imports, renames, exports and runs (`local import`, `local rename`, `local export`, `script run`, `pipeline run`) do not ask for it: they add or rebuild tables and never overwrite a saved document. |
| `--dry-run` | Check the command and its options and show what it would do, without doing it. |

Exit codes: **0** success, **1** the command failed, **2** a usage error (unknown command, missing or unknown option, a missing `--yes`). Nothing waits on a dialog; only `vault pair` asks for its code in the console.

## Commands

The same list is served by the running server at `GET /api/commands` and by `commands --json`.

| Command | What it does |
|---|---|
| `commands` | The list below, with options. |
| `info show`, `source list` | Version, the Semaphore folder and the sources in `sources.json`: id, label, kind, provider. Never a connection string or a secret. |
| `hoist`, `catalog`, `playbook`, `snapshot`, `question`, `team` `list` | `id`, `title`, `updated` of each saved document. |
| (same nouns) `get --id <id>` | One document, as the stored text itself: with `--json` or `--out` it is spliced into `result` unchanged (no depth cut, no respelling of numbers or non-ASCII), so `get` then `put` round-trips byte for byte. |
| (same nouns) `put --id <id> --file <json> --yes` | Save a document: a JSON object with `"version": 1`, at most 2 MB; replaces the same id. |
| (same nouns) `delete --id <id> --yes` | Move a document to the `.trash` folder (not erased). |
| `refresh run` | Refresh every playbook snapshot headless and stop (the same run as `Start-Semaphore.ps1 --refresh`). Refuses while Semaphore is open. When another Semaphore (one from another folder, which the refusal cannot see) already holds the port, the run exits 3 and the command reports "nothing was refreshed" instead of success. Needs a machine that can reach the sources. |
| `refresh report` | The report of the last refresh. |
| `vault status` | Whether Semaphore is paired with Lazarette (asked of the running Lazarette itself, not just the pairing file on this computer), whether Lazarette is running and unlocked, which source reads which share, and which names Lazarette has for Semaphore. Names only, never a value. |
| `vault pair` | Pair Semaphore with Lazarette ([VAULT.md](VAULT.md)), the same as Settings > Lazarette in the page: paste the code from Lazarette (Settings > Tools > Pair tool). This is the one command that asks for input: the code is read without echo, never printed, logged or written to a transcript, and stored DPAPI-protected for your Windows account. |
| `vault unpair` | Forget the pairing on this computer. Remove Semaphore in Lazarette (Settings > Tools) as well. |
| `ai status` | Whether drafting goes through Fairlead, the address and where the key comes from. Never the key. |
| `local list`, `local sources` | The tables in the local database (rows, columns, size, the file each came from), and the uploaded files kept for pipelines. |
| `local import --file <path>` | Import a CSV, TSV, Excel, SQLite, Parquet or Arrow file (also .gz) into the local database, in the foreground (Ctrl+C stops it). Network paths only on shares listed in settings `localShares`. See [LOCAL-DATABASE.md](LOCAL-DATABASE.md). |
| `local sheets --file <path>` | The sheets of an Excel workbook, or the tables of a SQLite file, to pick one to import. |
| `local status --id <job>` | Progress of an import the page started. |
| `local rename --id <table> --to <name>` | Rename a local table (flags that read the old name need their catalog updated). |
| `local delete --id <table> --yes` | Drop a local table. It cannot be undone: import the file again. |
| `local export --id <table> --format csv\|parquet\|arrow\|sqlite\|xlsx --file <path>` | Write a whole local table to a file (xlsx at most 1,048,576 rows). |
| `script list`, `script get --id`, `script put --id --file --yes`, `script delete --id --yes` | The saved SQL scripts of the local database; `put` checks the script's plan first. |
| `script run --id <id>` | Run a saved script in the local database in one transaction and print each statement's result. |
| `pipeline list`, `pipeline get --id`, `pipeline put --id --file --yes`, `pipeline delete --id --yes` | The data-prep pipelines ([PIPELINES.md](PIPELINES.md)); deleting one keeps its tables. |
| `pipeline run --id <id>` | Run a pipeline now, step by step, and print the run log. This is the command for Windows Task Scheduler. |
| `pipeline runs --id <id>`, `pipeline status --id <id> --run <run>` | The last runs of a pipeline, and one run's steps, rows, times and errors. |
| `session stop --yes` | Stop every running copy of Semaphore on this computer. |

## What is not a command, and why

Only headless work is offered. The routes the browser session needs have no command, and the registry lists each with its reason (`uiOnly` in `commands --json`): heartbeat and leaving (tab presence), launch (the launch link's single-use code), end (use `session stop`), query and profile (the page plans the SQL and holds the session token), the AI check and relay (they carry the browser session), client-log (the page reports its own script errors), vault pair and unpair (the Settings screen; `vault pair` and `vault unpair` do the same here), the voice routes (audio and the microphone are the browser's), the page's file upload and its Stop button (`local import` reads files where they are), page snapshots (the Snapshots dialog), S3 browsing and import and RDS discovery (the Data panel), the widget library and region maps (plain JSON and GeoJSON files in the Semaphore folder), alerts (only the page's planner works out the values they check) and briefing email (only the page builds the briefing). Running a page's flags headless, profiling a table and model imports are the main gaps; they are planned as commands. `tests/server/Commands.Tests.ps1` fails when a route in `server/Routes.ps1` or a `/api` path in the UI has neither a command nor a reason, so a new route cannot arrive without one.

Run on Windows PowerShell 5.1; not tried on a real workstation folder.

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
| `--yes` | Required for commands that change saved data. |
| `--dry-run` | Check the command and its options and show what it would do, without doing it. |

Exit codes: **0** success, **1** the command failed, **2** a usage error (unknown command, missing or unknown option, a missing `--yes`). Nothing waits on a dialog.

## Commands

The same list is served by the running server at `GET /api/commands` and by `commands --json`.

| Command | What it does |
|---|---|
| `commands` | The list below, with options. |
| `info show`, `source list` | Version, the Semaphore folder and the sources in `sources.json`: id, label, kind, provider. Never a connection string or a secret. |
| `hoist`, `catalog`, `playbook`, `snapshot`, `question`, `team` `list` | `id`, `title`, `updated` of each saved document. |
| (same nouns) `get --id <id>` | One document as JSON. |
| (same nouns) `put --id <id> --file <json> --yes` | Save a document: a JSON object with `"version": 1`, at most 2 MB; replaces the same id. |
| (same nouns) `delete --id <id> --yes` | Move a document to the `.trash` folder (not erased). |
| `refresh run` | Refresh every playbook snapshot headless and stop (the same run as `Start-Semaphore.ps1 --refresh`). Refuses while Semaphore is open. Needs a machine that can reach the sources. |
| `refresh report` | The report of the last refresh. |
| `vault status` | Whether Lazarette is found, and which source names which vault item. Never a secret. A command-line run never unlocks the vault. |
| `ai status` | Whether drafting goes through Fairlead, the address and where the key comes from. Never the key. |
| `session stop --yes` | Stop every running copy of Semaphore on this computer. |

## What is not a command, and why

Only headless work is offered. The routes the browser session needs have no command, and the registry lists each with its reason (`uiOnly` in `commands --json`): heartbeat and leaving (tab presence), launch (the launch link's single-use code), end (use `session stop`), query and profile (the page plans the SQL and holds the session token), and the AI check and relay (they carry the browser session). `tests/server/Commands.Tests.ps1` fails when a route in `server/Routes.ps1` or a `/api` path in the UI has neither a command nor a reason, so a new route cannot arrive without one.

Run on Windows PowerShell 5.1; not tried on a real workstation folder.

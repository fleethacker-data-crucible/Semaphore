# Roadmap

## v0.1: foundations

Framework-free core with tests: catalog, hoist and flag model, validation, lego grid, thin-client query planner, SQL for four dialects, local cross-filtering, and the intelligence layer (local rules, contract endpoint, OpenAI-compatible gateway, fallback).

## v0.2: local server, sources and the canvas

Done:

- `Launch-Semaphore.bat`, the PowerShell 5.1 loopback server and every TechStack lifecycle rule (heartbeat, auto-stop, End session, `Stop-Semaphore.ps1`, single instance, runtime file, off switch). Port block 8774-8776 in the suite registry.
- `/api/query` and `/api/profile` over ODBC and OLE DB (BCL only), typed bound parameters, timeout and row cap.
- Sources: CSV files in the browser, the generated fleet-maintenance sample, and server sources from `sources.json`.
- Source profiling into a proposed catalog: labels and synonyms from column names, measures from types and names.
- Hoists and catalogs saved to the user's Semaphore folder.
- The canvas: flag palette, drag, resize, keyboard, undo; hoist brief → drafted page; flag brief → draft, accept; flip a flag over for its plain-English readback, notes and SQL; ECharts rendering, thresholds, cross-filter clicks, live re-query indicator.
- Intelligence without a model: live brief highlighting, did-you-mean that teaches the catalog, chart choice from the data's shape, questions, comparisons, shares, a starter page, insights.

Still to do from the original v0.2 list:

- Secrets from the Lazarette vault via the bridge Halyard uses (today: DSN or integrated authentication only).
- AWS (Athena, Redshift), Azure SQL/Synapse and Palantir Foundry connectors beyond what ODBC reaches.
- Remote intelligence providers from the UI: the browser's CSP allows only the loopback server, so gateway calls need a server-side relay.
- Restyle to the unified Data Crucible UI rules once they are published.

## v0.3: the playbook and the leadership view (this release)

Semaphore learns from analysts' reviewed work, so leadership can simply ask, and so it can stand in when an analyst is away. See [PLAYBOOK.md](PLAYBOOK.md). Built, except where marked:

- Playbook store with provenance; learn on accept, on corrections and on chosen synonyms; "do not learn"; retiring entries; automatic "needs review"; a named reviewer.
- Snapshots: leaders never connect to a database. Accepted flags are refreshed into aggregated, pre-split snapshots whenever an analyst runs Semaphore, and answers re-add them. **To do:** an IT-approved `--refresh` runner for when analysts are away.
- Question-to-entry matching: same words, same binding, re-addable from an entry or its snapshot; deterministic and explainable.
- Leadership view: one question box, answer cards labelled reviewed / drafted, not reviewed / can't answer yet, follow-up chips.
- Analyst stand-in: headline numbers and what changed, question queue with "Build the answer", coverage report.
- **To do (optional):** reviewed examples sent to an approved AI gateway, through the server-side relay.

## v0.4: depth

- Joins through catalog relationships, so a flag can read more than one table and selections reach related tables.
- Drill paths (year → quarter → month), and drill on categories into a detail table.
- Queries and cross-filtering in a Web Worker for very large CSV files.
- Lineage view (React Flow): which flags read which measures, fields and sources.

## v0.5: sharing

- Self-contained HTML report with cached results and working filters, optional passphrase encryption.

## Later

- Databricks serving endpoint provider.
- Qlik migration helper: read a QVF/QVW load script or field list into the catalog.
- Flag kits: saved flag sets that remap to a new catalog.

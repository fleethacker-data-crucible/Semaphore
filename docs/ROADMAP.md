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
- AWS (Athena, Redshift), Azure SQL/Synapse and Palantir Foundry connectors beyond what ODBC reaches. For the S3 data lake, see Sounding Line under "AI-first" below.
- ~~Remote intelligence providers from the UI~~: done, through Fairlead and the server-side relay (`/api/ai`, [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md)).
- ~~Restyle to the unified UI~~: done, Fleet UI v0.2 as the default skin, with skins for last-minute changes ([SKINS.md](SKINS.md)).

## v0.3: the playbook and the leadership view (this release)

Semaphore learns from analysts' reviewed work, so leadership can simply ask, and so it can stand in when an analyst is away. See [PLAYBOOK.md](PLAYBOOK.md). Built, except where marked:

- Playbook store with provenance; learn on accept, on corrections and on chosen synonyms; "do not learn"; retiring entries; automatic "needs review"; a named reviewer.
- Snapshots: leaders never connect to a database. Accepted flags are refreshed into aggregated, pre-split snapshots whenever an analyst runs Semaphore, and answers re-add them. `--refresh` runs every snapshot headless for an always-on machine; scheduling it is an IT-approved exception.
- Question-to-entry matching: same words, same binding, re-addable from an entry or its snapshot; deterministic and explainable.
- Leadership view: one question box, answer cards labelled reviewed / drafted, not reviewed / can't answer yet, follow-up chips.
- Analyst stand-in: headline numbers and what changed, question queue with "Build the answer", coverage report.
- **To do (optional):** reviewed examples sent to an approved AI gateway, through the server-side relay.

## AI-first: the AI does the heavy lifting, the rules engine is the safety net

Semaphore is meant to be an AI tool that still works without AI: the model drafts, cleans and explains; Semaphore's own code writes the SQL and computes every number; and with no model (a disconnected ship, no approval yet) the local rules carry on. AI goes through Fairlead, on a local model by default or an approved cloud model.

**Standing in for an absent analyst** (the point is cover and freedom to experiment, not replacing analysts):

- **Done:** team style card (`src/core/style.ts`): chart per kind of question, time grain, top N, page window and colour rules, learnt from accepted flags with their evidence; analysts switch rules off or pin them (`team/style`). Every draft, by AI or local rules, is finished in the team's style where its brief is silent, and the AI receives the style as context.
- **Done:** away mode and the "while you were out" digest (`src/core/away.ts`, `team/away-<user>`): leadership sees who is out; familiar questions are answered from reviewed work; new ones are queued; on return the analyst gets what was asked, what was used, what was drafted and what needs sign-off.
- **Done:** experiment pages ("Try freely"): never learnt from by the playbook or the style.
- **Next:** recurring reports: recognise a dashboard refreshed on a schedule (the Monday brief) and produce it while its analyst is out, same structure, new data.
- **Next:** AI-written briefings for leadership from the "what changed" insights, each sentence linked to its flag.

**Messy data, done with the analyst instead of by them** (the load-script work that takes much of an analyst's time in Qlik):

- Profile data quality: inconsistent labels ("N.E." vs "Northeast"), stray spaces, mixed date formats, numbers stored as text, duplicates, blanks that mean zero.
- AI proposes cleaning steps as readable sentences; the analyst accepts or undoes each; accepted steps live in the catalog and Semaphore applies them in its own SQL and in snapshots.
- Relationship discovery: proposed joins between tables with how many rows actually match, feeding "joins through catalog relationships" below.

**Where the data lives:**

- Today: CSV in the page, Access through ACE, Postgres (including Postgres on AWS), Oracle and SQL Server through ODBC.
- The S3 data lake through Athena, by way of the **Sounding Line** proposal (comms repo, `proposals/sounding-line`): a query desk with a cost guard (scan size and price before a query runs, partition-filter warnings, per-user daily limits), a local result cache, and short AWS sessions brokered through Lazarette so analysts hold no AWS keys. Semaphore already writes Athena-ready SQL; one aggregate query per flag and leadership answering from snapshots keep scans small.

**AI-assisted Qlik migration:** paste a load script or a set-analysis expression and get catalog entries and draft flags back for review (supersedes the "Qlik migration helper" under Later).

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

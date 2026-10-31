# Roadmap

## v0.1: foundations

Framework-free core with tests: catalog, hoist and flag model, validation, lego grid, thin-client query planner, SQL for four dialects, local cross-filtering, and the intelligence layer (local rules, contract endpoint, OpenAI-compatible gateway, fallback).

## v0.2: local server, sources and the canvas

Done:

- `Launch-Semaphore.bat`, the PowerShell 5.1 loopback server and every TechStack lifecycle rule (heartbeat, auto-stop, End session, `Stop-Semaphore.ps1`, single instance, runtime file, off switch). Port block 8800-8802 in the suite registry.
- `/api/query` and `/api/profile` over ODBC and OLE DB (BCL only), typed bound parameters, timeout and row cap.
- Sources: CSV files in the browser, the generated fleet-maintenance sample, and server sources from `sources.json`.
- Source profiling into a proposed catalog: labels and synonyms from column names, measures from types and names.
- Hoists and catalogs saved to the user's Semaphore folder.
- The canvas: flag palette, drag, resize, keyboard, undo; hoist brief → drafted page; flag brief → draft, accept; flip a flag over for its plain-English readback, notes and SQL; ECharts rendering, thresholds, cross-filter clicks, live re-query indicator.
- Intelligence without a model: live brief highlighting, did-you-mean that teaches the catalog, chart choice from the data's shape, questions, comparisons, shares, a starter page, insights.

Still to do from the original v0.2 list:

- Secrets from the Lazarette vault via the bridge Halyard uses (today: DSN or integrated authentication only).
- Redshift, Azure SQL/Synapse and Palantir Foundry connectors beyond what ODBC reaches. Athena (the S3 data lake) is done: see "Where the data lives" below.
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

Semaphore is meant to be an AI tool that still works without AI: the model drafts, cleans and explains; Semaphore's own code writes the SQL and computes every number; and with no model (a disconnected ship, no approval yet) the local rules carry on. AI goes through Fairlead, on a local model by default or an approved cloud model. Every AI answer is validated before it is used (see `src/core/intelligence/tasks.ts`).

**Standing in for an absent analyst** (the point is cover and freedom to experiment, not replacing analysts):

- **Done:** team style card (`src/core/style.ts`), away mode and the "while you were out" digest (`src/core/away.ts`), experiment pages ("Try freely").
- **Done:** recurring reports (`src/core/reports.ts`): Semaphore notices that a page is opened on a weekly or monthly rhythm and offers to keep it coming; while its analyst is marked away, whoever can reach the data (an analyst, the Ask view, or the `--refresh` run) produces a dated edition on schedule, read by leadership under Regular reports.
- **Done:** briefings (`src/core/briefing.ts`): what a page says in a few sentences, each linked to its flag. The AI may only rephrase Semaphore's own facts; a sentence is kept only when every number in it is in the facts of the flag it cites. Editions carry one; "Brief me" shows the open page's.

**Messy data, done with the analyst instead of by them** (`src/core/quality.ts`, `src/core/cleaning.ts`, Data > Clean):

- **Done:** stray spaces, the same label spelt different ways (case, punctuation, compass abbreviations), numbers kept as text, mixed date formats (page data), blanks, duplicate rows; each proposed as a sentence to accept or undo. The AI suggests abbreviations and misspellings per field on request (it is sent that field's distinct values and counts, not rows).
- **Done:** accepted steps live in the catalog and are applied wherever a field is read, in Semaphore's SQL (once, in an inner query, every value bound) and in the page. The data itself is never changed.
- **Done:** relationship discovery (Data > Links): key columns proposed from their names, kept only when the values match and the target identifies one row.

**Where the data lives:**

- CSV in the page (large files in a Web Worker), Access through ACE, Postgres (including Postgres on AWS), Oracle and SQL Server through ODBC.
- **Done:** the lake engine (`server/Lake.ps1`, from the Sounding Line proposal): Athena with SigV4 signing (BCL only), a cost guard (every table a query reads is sized, partition-filter warning, approval above a threshold, daily per-user limit), result cache, usage records, free profiling from Glue; tested against a simulated AWS, not yet against real AWS.
- **Done:** the SQL desk: analysts write their own SELECT against any server source, the lake included, with the same guard, cost guard and cache; CSV download.
- **Next:** AWS sessions brokered through Lazarette, so analysts hold no AWS keys; database secrets from the Lazarette vault.

**Porting from Qlik:** **done**: Data > Import from Qlik reads a load script and chart expressions, profiles the tables and uses Qlik's names; mapping loads (ApplyMap) become cleaning steps; associations become relationships the data confirms; expressions Semaphore cannot read can be read by the AI, validated against the catalog and added only when the analyst says so.

## v0.4: depth (done in this release)

- **Done:** joins through catalog relationships (`src/core/joins.ts`): a flag's measures stay on one table and it groups or filters by any table reached many-to-one, so totals never double; LEFT JOINs in every dialect (Access nested, Oracle without AS) and in the page.
- **Done:** drill paths (`src/core/drill.ts`): dates drill year → quarter → month → day, categories follow drill paths set under Data > Links, the last level opens the rows; the click narrows that flag only.
- **Done:** large CSV files in a Web Worker: parsed and queried off the page's thread.
- **Done:** lineage view (Data > Lineage): sources, tables, fields, measures and flags, every join hop; built with SVG, no new dependency.

## v0.5: sharing (done in this release)

- **Done:** Share as a report: one self-contained HTML file with every flag's answers, working filters from the pre-split results, no network (its own CSP), and optional AES-256-GCM encryption with a passphrase.

## Later

- Databricks serving endpoint provider.
- Flag kits: saved flag sets that remap to a new catalog.
- Comparisons under a drill and in shared reports (today they show at the top level only). Drill levels inside shared reports: see SHARED_REPORT_DRILL.md.
- Joins one-to-many (a measure on the one side split by the many side) with distinct handling.

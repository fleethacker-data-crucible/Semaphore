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

From the original v0.2 list, now built:

- **Done:** secrets from the Lazarette vault through the same in-process contract Halyard uses ([VAULT.md](VAULT.md)): database passwords and AWS sessions. Tested against a fake Lazarette that follows its documented contract; a real vault is for Anthony to check.
- **Done, tested against simulated services only:** Redshift (Data API), Azure Synapse/SQL (ODBC with Entra sign-in) and Palantir Foundry (SQL queries API) connectors ([CONNECTORS.md](CONNECTORS.md)). Athena (the S3 data lake) is done too: see "Where the data lives" below.
- ~~Remote intelligence providers from the UI~~: done, through Fairlead and the server-side relay (`/api/ai`, [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md)).
- ~~Restyle to the unified UI~~: done, Fleet UI v0.2 as the default skin, with skins for last-minute changes ([SKINS.md](SKINS.md)).

## v0.3: the playbook and the leadership view (this release)

Semaphore learns from analysts' reviewed work, so leadership can simply ask, and so it can stand in when an analyst is away. See [PLAYBOOK.md](PLAYBOOK.md). Built, except where marked:

- Playbook store with provenance; learn on accept, on corrections and on chosen synonyms; "do not learn"; retiring entries; automatic "needs review"; a named reviewer.
- Snapshots: leaders never connect to a database. Accepted flags are refreshed into aggregated, pre-split snapshots whenever an analyst runs Semaphore, and answers re-add them. `--refresh` runs every snapshot headless for an always-on machine; scheduling it is an IT-approved exception.
- Question-to-entry matching: same words, same binding, re-addable from an entry or its snapshot; deterministic and explainable.
- Leadership view: one question box, answer cards labelled reviewed / drafted, not reviewed / can't answer yet, follow-up chips.
- Analyst stand-in: headline numbers and what changed, question queue with "Build the answer", coverage report.
- **Done:** reviewed examples sent to the AI as worked examples, opt-in and off by default, briefs and catalog names only ([INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md)).

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
- **Done:** AWS sessions and database secrets from a named Lazarette item, so analysts hold no AWS keys ([VAULT.md](VAULT.md)).
- **Done:** Redshift, Synapse and Foundry ([CONNECTORS.md](CONNECTORS.md)).
- **Tested for real:** ODBC and OLE DB drivers, through the Access Text and ACE drivers on a CSV folder (binding, types, row cap, errors). **Not yet tested:** a database server over ODBC/OLE DB, real AWS (Athena, Redshift), Synapse, Foundry, a real Lazarette vault, a real Databricks workspace. The checklists are in CONNECTORS.md, VAULT.md and DATABRICKS.md.

**Porting from Qlik:** **done**: Data > Import from Qlik reads a load script and chart expressions, profiles the tables and uses Qlik's names; mapping loads (ApplyMap) become cleaning steps; associations become relationships the data confirms; expressions Semaphore cannot read can be read by the AI, validated against the catalog and added only when the analyst says so.

## v0.4: depth (done in this release)

- **Done:** joins through catalog relationships (`src/core/joins.ts`): a flag's measures stay on one table and it groups or filters by any table reached many-to-one, so totals never double; LEFT JOINs in every dialect (Access nested, Oracle without AS) and in the page.
- **Done:** drill paths (`src/core/drill.ts`): dates drill year → quarter → month → day, categories follow drill paths set under Data > Links, the last level opens the rows; the click narrows that flag only.
- **Done:** large CSV files in a Web Worker: parsed and queried off the page's thread.
- **Done:** lineage view (Data > Lineage): sources, tables, fields, measures and flags, every join hop; built with SVG, no new dependency.

## v0.5: sharing (done in this release)

- **Done:** Share as a report: one self-contained HTML file with every flag's answers, working filters from the pre-split results, no network (its own CSP), and optional AES-256-GCM encryption with a passphrase.

## Later, now built

- **Done (simulated endpoint only):** Databricks serving endpoint provider ([DATABRICKS.md](DATABRICKS.md)).
- **Done:** flag kits, saved flag sets that remap to a new catalog ([FLAG_KITS.md](FLAG_KITS.md)).
- **Done, with one gap:** comparisons under a drill and in shared reports ([DRILL_COMPARISONS.md](DRILL_COMPARISONS.md)). Shared reports carry the top level only, so a drilled comparison does not exist in the file.
- **Done:** joins one-to-many with distinct handling ([ONE_TO_MANY_JOINS.md](ONE_TO_MANY_JOINS.md)). Drafting from plain English and the lineage view do not follow many-side links yet.

## Still open

- Drill levels inside shared reports.
- Real-service validation of every connector above, and of the vault bridge.

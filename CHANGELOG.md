# Changelog

## Unreleased

- **Read a briefing aloud** ("Brief me" > Read aloud, [docs/VOICE.md](docs/VOICE.md)): speaks with a voice installed on this PC, never an online voice; silent with a message when there is none. Off until clicked.
- **One modal behaviour for every overlay** (`web/src/lib/modal.ts`): Share, SQL desk, Data, Lineage, Qlik import, Playbook and report editions now move focus in, trap Tab, close on Escape (top-most only), make the page behind inert and hidden from assistive technology, return focus to the opener, and carry `aria-modal` and a name.
- **Own port block 8800-8802** (was 8774-8776, which overlapped Eight Bells 8774, Scrimshaw 8775 and Fairlead 8776). `server/FleetPorts.psd1`, the launcher, the self-check, README and docs follow; startup walks only 8800-8802 and fails with a message naming that block when all three are taken. AI drafting still goes to Fairlead on `127.0.0.1:8776`. Stored browser data is keyed to the origin, so a page held in the browser on the old port is not seen on the new one: export hoists first (Download this hoist) or reopen them from the Semaphore folder.
- **Halyard's backlog-health export as a data source**: the four CSV files (health, items, features, velocity) are recognised by their pinned columns when added under Data, the protective leading apostrophe on text cells is removed, and the tables arrive as `halyard_*` with typed columns and a proposed catalog. Synthetic-file tests only; not tried on a real Halyard export or in a running Semaphore.
- **Fleet exports as data sources** (`src/core/fleet-exports.ts`, [docs/FLEET_EXPORTS.md](docs/FLEET_EXPORTS.md)): Data > Add data reads PacketRat usage counts, Eight Bells eLog exports and any list of flat JSON records as tables, through the same reader as CSV. Synthetic-data tests only.
- **Welcome page and emblem** (UNIFIED-UI 6 and 8). Semaphore opens on the full emblem, a headline and the ways in: continue the last page, a new hoist, a saved one, add data, or the leadership view ("Open straight to the builder next time" turns it off). The emblem follows the window: it grows with the height up to 380 px and shrinks on a short window. On a window with room for it the full emblem also tops the flag palette, and the header's small mark gives way to it. Web copies of the Night watch and Chart room emblems (`web/public/brand`, 768 px) have the backdrop outside the art made transparent.
- **AI drafts keep to one source.** The catalog a model sees numbers each source as a set; a draft that still mixes sources keeps one, swapping in same-named metrics and fields or leaving the rest out with a note. Colour rules the brief did not ask for are dropped, and a model's own confidence is capped at 0.8. Found testing against a throwaway Access database through Fairlead.
- Found testing through Fairlead's OpenAI route: GPT-5 and o-series models refuse `temperature: 0`, so every draft quietly fell back to local rules. A model that refuses it is now asked again with its default, and from then on. The prompt now says what "Pick chart for me" (`brief.auto`) means and to choose the set that has everything the brief names. A chart whose only field the plan dropped crashed the whole page; it now shows its number, and any flag that cannot be drawn says so in its own card.
- The launcher drops PowerShell 7's module folders when it is started from a PowerShell 7 console ("Import-PowerShellDataFile is not recognized").
- **Joins** through catalog relationships (many-to-one, so totals never double), in every SQL dialect and in the page. **Drill paths**: dates drill year to day, categories follow drill paths, the last level opens the rows.
- **Messy data** (Data > Clean): Semaphore finds stray spaces, label variants, numbers kept as text, mixed date formats, blanks and duplicate rows, and proposes each fix as a sentence to accept or undo; accepted steps are applied wherever a field is read, the data is never changed. The AI suggests abbreviations and misspellings per field on request. **Links**: relationships found from key names and checked on the data.
- **Qlik, part two**: mapping loads become cleaning steps, associations become checked relationships, and the AI can read expressions Semaphore cannot (validated, added on the analyst's say-so).
- **SQL desk** for typed SELECTs on any server source, the lake included. The lake's cost guard now sizes every table a query reads. The SQL guard also refuses `INTO`.
- **Recurring reports**: the Monday brief keeps coming while its analyst is away, as dated editions leadership reads under Regular reports. **Briefings**: a page's news in a few sentences, each linked to its flag; the AI may only rephrase Semaphore's facts and its numbers are checked.
- **Large CSV files** are parsed and queried in a Web Worker. **Lineage** (Data > Lineage). **Share as a report**: one HTML file with working filters and an optional passphrase (AES-256-GCM).
- "Most labor hours" now means the total: hours and durations get a total measure as well as an average.
- Fixes: two measures on sideways bars crashed the whole page (now drawn on a second x axis, and a chart that cannot be drawn says so in its own card); a Pester test depended on whether the machine had a Fairlead key stored; PowerShell 7 reported "Fairlead down" as "unreachable".
- **The S3 data lake.** `provider: "athena"` sources (`server/Lake.ps1`, the Sounding Line lake engine): signed Athena, Glue and S3 calls with no driver, a cost guard (estimate, partition warning, "Run it" approval on the flag above a threshold, daily per-user limit), a result cache, usage records, and profiling from Glue. Flags show "cached" or what Athena read. 11 Pester tests against a simulated AWS, including AWS's SigV4 test vector.
- **Import from Qlik** (Data panel): load script and chart expressions to profiled tables with Qlik's field names, and measures; see `src/core/qlik.ts`.
- **Standing in for an absent analyst.** A **Team style** card learns how the team builds from accepted flags (chart for each kind of question, time grain, top N, page window, colour rules), shows the evidence for each rule, and lets analysts switch rules off or pin them. Drafts are finished in that style where the brief is silent, whether the AI or local rules drafted them, and the AI is given the style. **Away mode**: an analyst marks themselves out; leadership sees it in the Ask view, familiar questions are answered from reviewed work, new ones are queued, and on return a "while you were out" digest lists what happened and what needs sign-off. **Experiment pages** ("Try freely") are never learnt from.
- Server: a `team` document kind (`/api/team`) for the style overrides and away notices.
- Roadmap: the AI-first direction (stand-in, messy-data prep, data lake through Sounding Line, AI-assisted Qlik migration).
- **AI drafting through Fairlead.** With a Fairlead client key stored (`Set-SemaphoreAiKey.bat`, DPAPI-protected for the Windows account), flag and page drafts go through Fairlead's `local` route with `X-Fairlead-Privacy: local`, by way of Semaphore's own server: the page never holds the key. An **AI** button in the header shows the state and switches it. Failures fall back to local rules and say why; Fairlead's drafts say so in their notes.
- Port authority: the Fairlead key is sent only after the address answers `/__fleethacker/id` as `fairlead`, so a tool holding Fairlead's port never receives it.
- Server: `GET /api/ai`, `POST /api/ai/check`, `POST /api/ai/v1/chat/completions` (on the worker pool, up to 180 s). `SEMAPHORE_AI_URL` (loopback only), `SEMAPHORE_AI_MODEL`, `SEMAPHORE_AI_PRIVACY`, `SEMAPHORE_AI_KEY`.
- CI on the self-hosted Windows runners: typecheck, Node tests and build, PowerShell 5.1 parse check and the Pester suite.
- Fix: the document-store test expected PowerShell 7's `ConvertFrom-Json` array behaviour and failed on Windows PowerShell 5.1.

## 0.3.0 (2026-10-26)

Analysts build, leadership asks. See [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

- **Playbook:** every accepted flag becomes an answer leadership can ask for, with who accepted it and when. Never drafts, never flags marked "do not learn", nothing about how people work. Retire with a reason, restore, flag for review; Semaphore marks entries "needs review" itself when the catalog changes under them, they stop running, or nobody has used them for six months. A named reviewer (`playbookReviewer`).
- **Leadership view** (`Ask-Semaphore.bat`, or `"view": "ask"`): a question box, the reviewed headline numbers, what changed across reviewed flags, and answers labelled *reviewed*, *worked out from a reviewed flag*, *drafted by Semaphore, not reviewed* or *can't answer yet*, each with its data date, "Why this answer?" and follow-up chips.
- **Snapshots:** leaders never connect to a database. Whoever can reach a source refreshes the playbook's snapshots in the background (aggregated, pre-split by the short lists); answers re-add them, so one reviewed flag answers related questions too.
- **Refresher:** `Launch-Semaphore.bat --refresh` refreshes every snapshot in a headless Edge or Chrome (the page's own query code), writes a report (`/api/refresh-report`, shown in the Ask view), and stops; with a time limit, and never interrupting a copy in use. Scheduling it is for IT to approve.
- **Question queue:** unanswered and unreviewed questions wait for the analysts; "Build the answer" turns one into a flag, and accepting it answers the question for next time, in those words.
- Server: `/api/playbook`, `/api/snapshots`, `/api/questions` (one file per document, `?full=1`), user and reviewer in `/api/info`, `--ask`.
- Decisions recorded: unreviewed answers are shown, labelled; leaders read snapshots; the playbook is kept by automatic adding, analyst retirement, automatic needs-review flags and one named reviewer.

## 0.2.0 (2026-10-26)

Semaphore becomes a tool you can use: a local server, a browser UI, and intelligence that needs no model.

### Run it
- `Launch-Semaphore.bat` starts the PowerShell 5.1 loopback server (TcpListener on 127.0.0.1, port block 8774-8776) and opens the page. Every TechStack lifecycle rule: heartbeat and auto-stop, End session, `Stop-Semaphore.ps1`, one instance, runtime file, `SEMAPHORE_AUTO_STOP=0`.
- Hoists and catalogs autosave to the user's Semaphore folder. Without a server the page still works on sample data and CSV files and saves in the browser.

### Data
- Sources: the fleet-maintenance example with generated sample rows, CSV files read in the page (never uploaded), and ODBC / OLE DB sources listed in `sources.json` (DSN or integrated authentication; passwords in connection strings are refused).
- Profiling a table or a CSV file proposes a catalog: labels and synonyms from column names ("hull_no" reads as "Hull number" and answers to "hull"), row counts, totals of amounts, averages of durations and rates, distinct counts of identifiers, and identifiers or years kept as fields rather than added up.
- An in-memory engine answers page-held sources with exactly the query a database would get, so flags behave the same on a CSV file and on Oracle.

### Building a page
- Canvas: drag flags from the palette, move and resize on the 12-column grid, arrow keys to nudge (Shift to resize), Delete, undo and redo.
- Brief boxes highlight what Semaphore understood as you type: measures, fields, time, ranking, behaviour, colour rules, comparisons. Unknown words are underlined; typos get "did you mean", and picking one teaches the catalog the word.
- Smart flag: describe it and Semaphore picks the chart from the data's shape. More than 15 categories are cut to the top 15 and the flag says so.
- Ask a question ("Which ship class had the most work orders?") and pin the answer.
- An empty page offers a starter page drafted from the catalog, and example briefs written with the catalog's own names.
- Flags flip over to a plain-English readback, notes and the exact SQL with its parameters.
- Insights on each flag: the latest move in a trend (a period still running is not compared), a dominant category, an outlier, the biggest move against the comparison window, values breaking a red rule.

### Model
- `binding.compare`: `previous-period` or `previous-year`, like for like against a "last N" window, with time values lined up period by period.
- `binding.share`: values as a share of the total, taken before any top-N cut.

### Local rules
- Questions ("which X had the most Y"), comparisons ("vs last year", "growth"), shares ("% of total").
- A word two tables share resolves to the table the rest of the brief points at.
- "Clicking a bar filters the page" no longer forces a bar chart.

## 0.1.0 (2026-10-25)

Framework-free core with tests: catalog, hoist and flag model, validation, lego grid, thin-client query planner, SQL for five dialects, local cross-filtering, and the intelligence layer (local rules, contract endpoint, OpenAI-compatible gateway, fallback).

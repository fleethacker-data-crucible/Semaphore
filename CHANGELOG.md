# Changelog

## Unreleased

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

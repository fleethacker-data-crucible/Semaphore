# Changelog

## Unreleased

- Docs: the vision for v0.3, learning from analysts' reviewed work for a leadership view and an analyst stand-in ([docs/PLAYBOOK.md](docs/PLAYBOOK.md)), reflected in the README, architecture, intelligence and roadmap docs. Design only; nothing built yet.

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

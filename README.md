<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/emblem-dark.png">
    <img src="assets/brand/emblem-light.png" width="280" alt="Semaphore emblem: a ship's semaphore mast with two signal arms over a deck panel showing a compass rose and a bar chart, riding the waves, above the SEMAPHORE wordmark">
  </picture>
</p>

# SEMAPHORE · Dashboard Intelligence

A local-first dashboard builder meant to replace Qlik on thin clients: analysts drop flags on a page and say in plain English what each should show, and Semaphore wires the data. Next, it learns from the analysts' reviewed work so leadership can simply ask, and so it can stand in when an analyst is away.

> **Engineering preview (0.3).** Runs on sample data and CSV files today; database sources go through ODBC or OLE DB and have not yet been tried on the target Windows machines.

Part of the Data Crucible family alongside Lazarette, Halyard and Shellback, and built on the same [TechStack](TechStack).

## The name

Before radio, ships talked with flags. *Semaphore* is a sailor spelling out a message with a flag in each hand, read by eye across open water. A *hoist* is the set of signal flags run up together to send one message; each flag carries one part of it. Semaphore works the same way: every flag on the dashboard carries one part of the picture, and the hoist as a whole tells leadership what they need to know at a glance.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
    <img src="docs/screenshot-light.png" width="900" alt="Semaphore with the fleet-maintenance example: KPIs, a ship-class picker with Icebreaker selected, labor cost by region, a monthly trend, and a top-10 hulls chart compared with a year earlier; the inspector shows the brief highlighted and read back in plain English">
  </picture>
</p>

## Analysts build, leadership asks

Semaphore serves two people. **Analysts** build: they describe flags, check Semaphore's drafts and accept them. **Leadership** asks: they want an answer they can trust, not a dashboard tool.

Every flag an analyst accepts pairs a plain-English question with the exact data behind its answer. The **playbook** collects those reviewed pairs, so leadership gets a single question box answered from the analysts' own work, each answer labelled *reviewed*, *drafted, not reviewed* or *can't answer yet*. When an analyst is out, Semaphore stands in: it answers familiar questions, briefs leadership on what changed, and queues anything new for the analyst's return. It learns only from accepted work, never by watching people. Leaders never connect to a database: they are answered from small, already-summarised snapshots of the analysts' accepted flags, each showing how fresh it is.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-ask-dark.png">
    <img src="docs/screenshot-ask-light.png" width="760" alt="The leadership view: a question box and the answer to 'Labor cost by ship class vs last year', labelled 'Drafted by Semaphore, not reviewed' and sent to the analysts, with bars for this year and a year earlier, two insights and follow-up chips">
  </picture>
</p>

Leadership opens it with **`Ask-Semaphore.bat`**. How it works and what is still to come: [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Run it

1. On a build machine, run `npm ci` then `npm run build` once. This writes the page to `web\dist` (the workstation never builds anything).
2. Copy the folder to the workstation and double-click **`Launch-Semaphore.bat`**. It needs Windows PowerShell 5.1 and Edge or Chrome: no admin rights, no installs, no network.
3. Semaphore opens on the fleet-maintenance example with generated sample data. Click **New hoist** for an empty page, or **Data** to add CSV files or a database.
4. Leadership double-clicks **`Ask-Semaphore.bat`** instead: a question box answered from the analysts' reviewed work, with no database access needed. Share the playbook by pointing `SEMAPHORE_HOME` at one network folder on every computer.
5. To stop, choose **End session**, or close the tab: the server stops itself about 20 seconds later. `server\Stop-Semaphore.ps1` stops any copy that is still running.

Launcher options: `--ask` (the leadership view; `Ask-Semaphore.bat`), `--refresh` (refresh every playbook snapshot headless and stop; for an IT-approved morning run, see [docs/PLAYBOOK.md](docs/PLAYBOOK.md)), `--no-browser`, `--stay` (keep running after the tab closes), `--replace` (stop a running copy and start fresh), `--console`, `-Port <n>`. Semaphore listens on `127.0.0.1`, port 8774 to 8776. Set `SEMAPHORE_AUTO_STOP=0` to turn auto-stop off.

## What it does

| | |
| --- | --- |
| **Brief boxes that read back** | As you type, measures, fields, time, ranking and behaviour are highlighted. Unknown words are underlined; typos get "did you mean", and picking one teaches the catalog the word. |
| **Smart flags** | Describe a flag and Semaphore picks the chart from the data's shape: one number is a KPI, time is a line, parts of a whole are a pie, a long list is cut to its top 15. |
| **Questions** | "Which ship class had the most work orders?" comes back as a chart you can pin. |
| **Comparisons and shares** | "vs last year", "compared with the previous quarter", "as a % of total", like for like. |
| **Starter page** | An empty page offers one drafted from the catalog: headline numbers, pickers, a trend, a breakdown and a top 10. |
| **Worth a look** | Each flag points out the latest move in a trend, a dominant category, an outlier, the biggest change and values breaking a red rule. |
| **Flip a flag over** | The flag in plain English, why Semaphore drafted it that way, and the exact SQL with its parameters. |
| **Cross-filtering** | Click a bar or a picker value and the whole page filters from cached results, asking the source again only when it must. |
| **Lego grid** | Drag, resize, drop from the palette, arrow keys, undo and redo. Light and dark themes. |
| **Catalog from your data** | Add a CSV file or profile a database table and Semaphore proposes measures and fields, with labels and synonyms from the column names, for you to check. |

Everything above runs in the page with no AI model. An approved AI gateway can be added later as a provider ([docs/INTELLIGENCE_PROVIDERS.md](docs/INTELLIGENCE_PROVIDERS.md)).

## Databases

List them in `sources.json` in your Semaphore folder (`%USERPROFILE%\Semaphore`, or `SEMAPHORE_HOME`):

```json
[
  { "id": "maint", "label": "Maintenance warehouse", "kind": "postgres", "provider": "odbc", "connection": "DSN=MaintWarehouse" },
  { "id": "parts", "label": "Parts tracker", "kind": "access", "provider": "oledb", "connection": "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=\\\\server\\share\\parts.accdb" }
]
```

ODBC and OLE DB come with Windows (.NET Framework), so nothing is installed; the database's own driver must already be on the machine. Then open **Data**, pick the table and choose **Profile and add**.

## Privacy and security in short

- The server listens on loopback only, checks every request's `Host` and `Origin`, and needs the session token the launcher gives the browser. The token is never written to disk or logged.
- Rows never leave the machine. CSV files are read in the page and never uploaded. AI providers, when added, see only briefs and catalog names, never data, tables, columns or credentials.
- No passwords in connection strings: use a DSN or Windows authentication (the Lazarette vault bridge is next). SQL is generated by Semaphore with bound, typed parameters, and the server refuses anything but a single `SELECT`.
- Hoists and the catalog are JSON files in your Semaphore folder.

## Build and test

Node 22.18 or later. `npm ci` installs the build tools (esbuild, Tailwind, React, ECharts); they are bundled into `web\dist` and never needed on the workstation.

```shell
npm test             # node --test: core, data path and UI logic (98 tests)
npm run typecheck    # strict tsc for the core and the UI
npm run build        # web/dist
npm run dev          # rebuild on change
```

Server tests are Pester 5 (`Invoke-Pester tests\server`) under Windows PowerShell 5.1.

## Documentation

- [docs/PLAYBOOK.md](docs/PLAYBOOK.md): learning from analysts, the leadership view, snapshots, standing in for an absent analyst
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layers, the thin-client data strategy, storage, and how the TechStack maps on
- [docs/FLAG_SPEC.md](docs/FLAG_SPEC.md): the catalog, hoist and flag formats
- [docs/INTELLIGENCE_PROVIDERS.md](docs/INTELLIGENCE_PROVIDERS.md): what local rules understand, AI providers, and the contract
- [docs/ROADMAP.md](docs/ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md)
- [examples/fleet-maintenance/](examples/fleet-maintenance/): the sample catalog and hoist (synthetic)

## License

No license has been chosen yet; there is no `LICENSE` file.

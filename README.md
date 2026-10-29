<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/emblem-dark.png">
    <img src="assets/brand/emblem-light.png" width="280" alt="Semaphore emblem: a ship's semaphore mast with two signal arms over a deck panel showing a compass rose and a bar chart, riding the waves, above the SEMAPHORE wordmark">
  </picture>
</p>

# SEMAPHORE · Dashboard Intelligence

Semaphore is an analyst workbench for building dashboards from plain-English briefs, CSV files and configured database sources. Analysts review proposed charts and their SQL, accept useful definitions into a playbook, and publish summarized snapshots for leadership questions. It targets Windows thin clients and Qlik-style analytical workflows.

> **Engineering preview (0.3 development line).** This README describes `armp/semaphore-0.3.0` in [PR #10](https://github.com/fleethacker-data-crucible/Semaphore/pull/10). The default `main` branch still contains the v0.1 TypeScript core. Sample and CSV workflows are available here; database adapters need validation against the intended services and target workstations. [PR #13](https://github.com/fleethacker-data-crucible/Semaphore/pull/13) adds the Fairlead integration and further analytical features.

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

Every flag an analyst accepts pairs a plain-English question with the exact data behind its answer. The **playbook** collects those reviewed pairs, so leadership gets a single question box answered from the analysts' own work, each answer labelled *reviewed*, *drafted, not reviewed* or *can't answer yet*. When an analyst is out, Semaphore stands in: it answers familiar questions, briefs leadership on what changed, and queues anything new for the analyst's return. The playbook reuses accepted definitions and snapshots; it does not train a model on user activity. Leaders never connect to a database: they are answered from small, already-summarised snapshots of the analysts' accepted flags, each showing how fresh it is.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-ask-dark.png">
    <img src="docs/screenshot-ask-light.png" width="760" alt="The leadership view: a question box and the answer to 'Labor cost by ship class vs last year', labelled 'Drafted by Semaphore, not reviewed' and sent to the analysts, with bars for this year and a year earlier, two insights and follow-up chips">
  </picture>
</p>

Leadership opens it with **`Ask-Semaphore.bat`**. How it works and what is still to come: [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Run it

1. On a build machine, run `npm ci` then `npm run build` once. This writes the page to `web\dist` (the workstation never builds anything).
2. Copy the folder to the workstation and double-click **`Launch-Semaphore.bat`**. It needs Windows PowerShell 5.1 and Edge or Chrome. The built sample/CSV application runs offline without Node.js, admin rights or runtime installation. Configured databases or a shared network folder require network access.
3. Semaphore opens on the fleet-maintenance example with generated sample data. Click **New hoist** for an empty page, or **Data** to add CSV files or a database.
4. Leadership double-clicks **`Ask-Semaphore.bat`** instead: a question box answered from the analysts' reviewed work, with no database access needed. Share the playbook by pointing `SEMAPHORE_HOME` at one network folder on every computer.
5. To stop, choose **End session**, or close the tab: the server stops itself about 20 seconds later. `server\Stop-Semaphore.ps1` stops any copy that is still running.

> **Current connections:** the UI uses deterministic local rules. Database queries currently use Semaphore's own connectors. [PR #13](https://github.com/fleethacker-data-crucible/Semaphore/pull/13) adds model requests through [Fairlead](https://github.com/fleethacker-data-crucible/Fairlead); routing database connections through Fairlead is still a direction in [TechStack](TechStack).

Launcher options: `--ask` (the leadership view; `Ask-Semaphore.bat`), `--refresh` (refresh every playbook snapshot headless and stop; for an IT-approved morning run, see [docs/PLAYBOOK.md](docs/PLAYBOOK.md)), `--no-browser`, `--stay` (keep running after the tab closes), `--replace` (stop a running copy and start fresh), `--console`, `-Port <n>`. Semaphore listens on `127.0.0.1`, port 8774 to 8776. Set `SEMAPHORE_AUTO_STOP=0` to turn auto-stop off. Snapshot refreshes need an active instance or an explicitly scheduled `--refresh` run; the launcher does not install a background service or scheduled task. The current 8774–8776 port block also needs reconciliation with other Fleet assignments before shared deployment.

## Architecture at a glance

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/application-overview-dark.svg">
  <img src="docs/diagrams/application-overview-light.svg" alt="The preview browser uses a local PowerShell API for queries and JSON documents; optional model requests go to Fairlead and leadership reads snapshots." width="1280">
</picture>

[Architecture diagrams](docs/ARCHITECTURE-DIAGRAMS.md): current core, preview application, and AI payload / credential boundaries, with editable SVGs and Mermaid flows.

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

Semaphore uses .NET Framework's ODBC and OLE DB APIs. The appropriate database driver/provider, matching the PowerShell process architecture, must already be installed; Semaphore does not install it. Then open **Data**, pick the table and choose **Profile and add**.

## Privacy and security in short

- The server listens on loopback only, checks every request's `Host` and `Origin`, and needs the session token the launcher gives the browser. The token is never written to disk or logged.
- CSV files are parsed in the browser. Database queries use the configured services, and shared playbook snapshots contain summarized result data. Treat shared snapshots as data-bearing files.
- The UI on this branch uses local rules without a model. Optional core provider adapters send briefs and summarized catalog metadata. The broader AI features in PR #13 have additional payloads described in that branch's documentation.
- No passwords in connection strings: use a DSN or Windows authentication (the Lazarette vault bridge is next). SQL is generated by Semaphore with bound, typed parameters, and the server refuses anything but a single `SELECT`.
- Hoists and the catalog are JSON files in your Semaphore folder.

## Build and test

Node 22.18 or later. `npm ci` installs the build tools (esbuild, Tailwind, React, ECharts); they are bundled into `web\dist` and never needed on the workstation.

```shell
npm test             # node --test: core, data path and UI logic
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

The organization uses MIT. The root license file is being added in [PR #11](https://github.com/fleethacker-data-crucible/Semaphore/pull/11) and is not yet present on this branch.

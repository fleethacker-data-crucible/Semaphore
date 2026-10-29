# Semaphore architecture, visually

These diagrams distinguish the **v0.1 core on `main`** from the **application previews in PR #10 and PR #13**. A component shown in a preview is not a claim that it exists in a default-branch checkout. Diagram assets are repository-local SVGs with light/dark variants and descriptive text.

## 1. Current core: available on main

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/core-overview-dark.svg">
  <img src="diagrams/core-overview-light.svg" alt="The main-branch core turns catalog and hoist models into validated bindings and SQL. A caller executes queries, returns aggregate results to cross-filtering, and supplies the interface." width="1280">
</picture>

The core supplies models, local-rule drafting, optional provider adapters, validation, layout, planning, parameterized SQL and cached-result filtering. The integrating application supplies query execution and presentation.

```mermaid
flowchart LR
  subgraph Core["Available on main: TypeScript core"]
    Catalog["Catalog: fields, metrics and synonyms"]
    Hoist["Hoist: flags, layout and selections"]
    Draft["Local rules / optional provider adapter"]
    Validate["Validate draft against catalog"]
    Plan["Query planner + parameterized SQL"]
    Filter["Cross-filter cached aggregates"]
    Catalog --> Draft
    Hoist --> Draft
    Draft --> Validate
    Catalog --> Validate
    Validate --> Plan
    Hoist --> Plan
  end
  Caller["Caller executes query: outside main"]
  Output["Caller displays or consumes results"]
  Plan -->|"SQL + typed parameters"| Caller
  Caller -->|"Aggregate results"| Filter
  Filter --> Output
  Filter -.->|"Fresh query needed"| Plan
```

SQL-dialect support is not a live database connector. A draft is not an accepted analytical answer. Optional remote-provider adapters can make configured model requests; local rules do not require a model or network.

## 2. Application preview: components and data paths

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/application-overview-dark.svg">
  <img src="diagrams/application-overview-light.svg" alt="Analysts use a browser and local PowerShell API. CSV and sample calculations run in the browser; configured databases and Athena are queried by the server. JSON snapshots and playbooks support the leadership view. Optional model calls go through Fairlead." width="1280">
</picture>

**PR #10** provides the browser/server application, sample/CSV workflows, ODBC/OLE DB adapter code, playbooks and leadership snapshots. **PR #13**, stacked on #10, adds the Fairlead integration, Athena/lake path and additional analytical features. Real services and target-machine deployment require their own validation.

```mermaid
flowchart TB
  subgraph Analyst["Analyst workstation: preview"]
    Browser["Browser: React UI + shared TypeScript core"]
    LocalData["Sample / CSV engine and cached results"]
    Server["Own PowerShell 5.1 loopback API"]
    Browser <--> LocalData
    Browser <-->|"Session-authenticated requests"| Server
  end
  Database["Configured databases: ODBC / OLE DB, PR #10"]
  Lake["Athena / Glue / S3, PR #13"]
  Documents["Local folder or Windows share: JSON documents, playbook and snapshots"]
  Server <-->|"SQL + bound parameters / results"| Database
  Server <-->|"Signed service requests / results"| Lake
  Server <--> Documents
  subgraph Leadership["Leadership workstation: preview"]
    Ask["Browser: Ask view"]
    AskServer["Own PowerShell loopback API"]
    Ask <--> AskServer
  end
  AskServer <--> Documents
  Fairlead["Optional local Fairlead router, PR #13"]
  Model["Local model: default route"]
  Remote["Remote model: explicit route / privacy opt-in"]
  Server -->|"Model requests only"| Fairlead
  Fairlead --> Model
  Fairlead -.-> Remote
```

- Each user runs a local browser and server. The normal leadership UI reads snapshots rather than querying database sources.
- Windows folder permissions determine access to shared JSON files; the two views are not a substitute for file-access controls.
- Database/lake connections currently bypass Fairlead. The router handles optional model requests, not database traffic.
- Sample/CSV analysis can run offline. Databases, AWS services, shared folders and explicitly remote model routes need their corresponding network access.
- Report editions and snapshot refreshes require a running instance or an explicitly scheduled refresh. Closing the browser normally stops its server; the app does not install an always-on service.

## 3. AI requests: payloads and credential boundary

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/ai-boundaries-dark.svg">
  <img src="diagrams/ai-boundaries-light.svg" alt="Drafting sends briefs and summarized catalog metadata; cleaning sends up to 300 distinct values with counts; Qlik assistance sends expressions and field metadata; briefings send computed facts. A local proxy keeps the Fairlead client key out of the browser, and Fairlead defaults to a local model." width="1280">
</picture>

This flow describes **PR #13**. The exact payload depends on the feature, and excerpts can contain business data. The built-in UI does not upload complete source tables to the model. The proxy is not a sensitive-content classifier. Shared snapshots and exported reports are separate data-bearing files.

```mermaid
sequenceDiagram
  actor Analyst
  participant UI as Browser
  participant API as Semaphore loopback API
  participant Router as Local Fairlead
  participant Model as Local model (default)
  Analyst->>UI: Request AI assistance
  UI->>API: Session token + feature payload
  Note over API: Read Fairlead key from environment or Credential Manager, with legacy file fallback
  API->>Router: Check service identity before sending key
  Router-->>API: Fairlead identity
  API->>Router: Client key + local route + privacy header + payload
  Router->>Model: Feature payload
  Model-->>Router: Candidate answer
  Router-->>API: Answer and target metadata
  API-->>UI: Answer without the Fairlead key
  UI->>UI: Validate output and fall back where supported
  UI-->>Analyst: Draft for review
```

An explicitly configured nonlocal route and privacy override can permit remote model processing. The default local path shown above does not promise that every possible configuration is offline.

## Source map

| Diagram area | Code to inspect |
| --- | --- |
| Current core | `src/core/catalog.ts`, `hoist.ts`, `layout.ts`, `planner.ts`, `sql.ts`, `crossfilter.ts`, `intelligence/` on `main` |
| Preview UI and data execution | `web/src/lib/data.ts`, `worker.ts`, `playbook.ts`, and `web/src/components/AskView.tsx` on the application branches |
| Loopback server and document/query APIs | `server/Start-Semaphore.ps1`, `Http.ps1`, `Routes.ps1`, `Query.ps1` on the application branches |
| Lake services | `server/Lake.ps1` in PR #13 |
| AI routing and credentials | `web/src/lib/ai.ts`, `server/Intelligence.ps1`, `AiCredential.ps1` and `Set-SemaphoreAiKey.ps1` in PR #13 |
| AI feature payloads | `src/core/intelligence/tasks.ts` in PR #13 |
| Shared report payloads | `src/core/reports.ts`, `web/src/lib/share.ts` and `web/src/report.tsx` in PR #13 |

For the longer design narrative, see [ARCHITECTURE.md](ARCHITECTURE.md). For branch status and launch instructions, use the [README](../README.md) on your current branch.

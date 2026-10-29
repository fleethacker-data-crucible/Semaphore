# Semaphore architecture

**Scope:** main currently contains the v0.1 TypeScript core. The server, browser and deployment layers described as planned below are target application design. The preview implementations are tracked in PR #10 and PR #13.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/diagrams/core-overview-dark.svg">
  <img src="diagrams/diagrams/core-overview-light.svg" alt="The current TypeScript core validates dashboard models, plans SQL and cross-filters results; query execution and rendering belong to the caller." width="1280">
</picture>

See [Architecture, visually](ARCHITECTURE-DIAGRAMS.md) for the component, data-flow and AI-boundary diagrams, including explicit current-versus-preview labels.

**The stack is defined by [`TechStack`](../TechStack).** This document describes how Semaphore uses it.

## Layers

```
Launch-Semaphore.bat ──► PowerShell 5.1 loopback server (planned)
                           ├─ static UI (compiled JS/CSS/WASM)
                           ├─ /api/heartbeat, lifecycle per TechStack
                           ├─ /api/query   runs a rendered SQL query against a source, binds params
                           ├─ connectors   bundled managed .NET drivers via Add-Type (no installs)
                           └─ vault bridge  connection secrets and AI tokens come from the Lazarette vault

Browser
  src/app (planned)       canvas, flag palette, flag inspector, report export
  src/core                framework-free TypeScript, unit-tested
    catalog.ts            semantic layer: sources, fields, metrics, defined once
    hoist.ts              hoist (dashboard) and flag (block) model + validation
    layout.ts             lego grid placement
    planner.ts            flag → query plan, sized for a thin client
    sql.ts                plan → SQL per dialect, typed bound parameters
    crossfilter.ts        page selections applied to cached results locally
    intelligence/         provider contract, local rules, remote providers, fallback
```

## Thin clients: the database does the work

Users are on thin clients, so Semaphore never copies whole tables into the browser.

1. **Aggregate at the source.** Every flag becomes one `GROUP BY` query. Millions of rows in Oracle come back as a few hundred.
2. **Pre-slice for the page.** A flag's query is also split by the fields *other* flags on the page can select (filter flags, and charts whose click filters the page). Clicking "Northeast" on one flag then filters every other flag from its cached result, with no round trip. Example: work orders split by 6 regions × 12 ship classes is 72 rows.
3. **Re-aggregable partials.** Results carry partials, not finished numbers: `avg` travels as `sum` + `count`, so re-adding after a filter is exact. A distinct count cannot be re-added, so a flag with one sends page selections back to the source instead, and says so.
4. **Row caps.** Each query is capped (50,000 rows by default). Slices are added cheapest first while the estimate stays under the cap; the rest become **live**: a selection on that field re-queries the source for that flag only, and the flag shows its last result until the new one arrives.
5. **Top-N.** A "top 10" is cut at the source only when nothing is re-aggregated locally and it does not rank by an average; otherwise it is cut after local filtering, so it is the right top 10 for the current selection. When it is cut at the source, selecting a value outside the top 10 re-queries the source. It is always cut locally as well, because Access's `TOP n` returns ties.
6. **Truncation.** A result as long as the row cap may be missing rows. It is marked `truncated` so the UI can show the totals as incomplete, and every selection on that flag goes to the source.

Estimates use profiled cardinalities from the catalog, `in`/`eq` filters, and relative date filters ("last 12 months" at month grain is 12).

### Associative filtering

Filter flags are pre-sliced like any other flag, so selecting a region narrows the ship-class list to classes with work in that region, the way Qlik users expect. A picker's own selection does not filter the picker, so it keeps listing every value.

### Per-flag "ignore"

A flag's brief can opt out of page selections ("ignore the region filter"). The field is then left out of that flag's plan entirely, and its selections are skipped when cross-filtering.

## SQL safety

- Table and column names come only from the catalog, are checked by `isIdentifier()` and are always quoted (`"name"`, or `[name]` for Access).
- Every value is a bound parameter (`$1` Postgres, `:p1` Oracle, `@p1` T-SQL, `?` Access/ANSI), typed by its field (`date`, `number`, `boolean`, `string`). The server binds them with the driver API as real dates and numbers. A date's upper bound covers the whole day (`< next day`).
- T-SQL needs `DATETRUNC`, so Azure SQL or SQL Server 2022 and later. The catalog check flags a source whose dialect does not match its kind.
- Date buckets and "last N" edges are computed in UTC. A Postgres `timestamptz` column truncates in the session time zone, so the server sets the session to UTC.
- Oracle quoted identifiers are case-sensitive; profiling stores names exactly as the database reports them.
- Access has no `COUNT(DISTINCT …)`; Semaphore refuses rather than generating wrong SQL.

## Untrusted input

Hoist files, imports and AI output are capped before use: briefs at 4,000 characters, 200 flags, 50 metrics, 20 fields, 50 filters of at most 500 values, 20 thresholds, 2 MB provider responses, 200 warnings. Overlapping layouts are repaired on load. Regexes that read briefs are bounded, and provider text is unwrapped without regexes.

## v1 limits

- One source and one table per flag. Joins arrive with catalog relationships.
- Selections only reach flags on the same table.

## Storage

- **Hoists and the catalog are small JSON files.** On non-persistent VDI profiles, browser storage may be wiped at logoff, so these are saved by the server to the user's home or a network folder. IndexedDB holds only cached results, which are safe to lose.
- Credentials never enter the browser or the hoist: a source names an Lazarette vault item.

## Sharing

A report is exported as one self-contained HTML file (the same technique as Shellback's standalone edition): the cached results, the hoist and the cross-filter engine, with optional AES-GCM passphrase encryption. Recipients need nothing installed; live drill-downs are disabled in the export.

## TechStack mapping

| TechStack item | Semaphore use | State |
| --- | --- | --- |
| `.bat` → `powershell.exe -File` | `Launch-Semaphore.bat` | Planned |
| PowerShell 5.1 + `TcpListener` | Loopback server, query endpoint, lifecycle rules | Planned |
| React 19 + TS, or Svelte 5 | UI | Waiting on the unified Data Crucible UI rules |
| Tailwind 4 + shadcn-style | UI | Waiting, as above |
| ECharts, React Flow, Motion | Flag rendering (ECharts); lineage view (Flow) | Planned |
| Rust → WebAssembly | Optional: cross-filter kernel if results grow; today's results are small enough for TypeScript | Not needed yet |
| IndexedDB / localStorage | Cached results / settings | Planned |
| Service workers, Web Workers | App-shell cache; queries and cross-filtering off the main thread | Planned |
| Web Crypto, DPAPI | Report encryption; secrets via Lazarette | Planned |
| C# via `Add-Type` | Managed DB drivers (Npgsql, Oracle.ManagedDataAccess), OLE DB for Access | Planned |

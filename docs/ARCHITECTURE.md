# Semaphore architecture

**The stack is defined by [`TechStack`](../TechStack).** This document describes how Semaphore uses it.

## Layers

```
Launch-Semaphore.bat ──► PowerShell 5.1 loopback server (planned)
                           ├─ static UI (compiled JS/CSS/WASM)
                           ├─ /api/heartbeat, lifecycle per TechStack
                           ├─ /api/query   runs a rendered SQL query against a source, binds params
                           ├─ connectors   bundled managed .NET drivers via Add-Type (no installs)
                           └─ ARC bridge   connection secrets and AI tokens come from the ARC vault

Browser
  src/app (planned)       canvas, flag palette, flag inspector, report export
  src/core                framework-free TypeScript, unit-tested
    catalog.ts            semantic layer: sources, fields, metrics, defined once
    hoist.ts              hoist (dashboard) and flag (block) model + validation
    layout.ts             lego grid placement
    planner.ts            flag → query plan, sized for a thin client
    sql.ts                plan → SQL per dialect, bound parameters
    crossfilter.ts        page selections applied to cached results locally
    intelligence/         provider contract, local rules, remote providers, fallback
```

## Thin clients: the database does the work

Users are on thin clients, so Semaphore never copies whole tables into the browser.

1. **Aggregate at the source.** Every flag becomes one `GROUP BY` query. Millions of rows in Oracle come back as a few hundred.
2. **Pre-slice for the page.** A flag's query is also split by the fields *other* flags on the page can select (filter flags, and charts whose click filters the page). Clicking "Northeast" on one flag then filters every other flag from its cached result, with no round trip. Example: work orders split by 6 regions × 12 ship classes is 72 rows.
3. **Re-aggregable partials.** Results carry partials, not finished numbers: `avg` travels as `sum` + `count`, so re-adding after a filter is exact. A distinct count cannot be re-added, so a flag with one sends page selections back to the source instead, and says so.
4. **Row caps.** Each query is capped (50,000 rows by default). Slices are added cheapest first while the estimate stays under the cap; the rest become **live**: a selection on that field re-queries the source for that flag only, and the flag shows its last result until the new one arrives.
5. **Top-N.** A "top 10" is cut at the source only when nothing is re-aggregated locally; otherwise it is cut after local filtering, so it is the right top 10 for the current selection.

Estimates use profiled cardinalities from the catalog, `in`/`eq` filters, and relative date filters ("last 12 months" at month grain is 12).

### Associative filtering

Filter flags are pre-sliced like any other flag, so selecting a region narrows the ship-class list to classes with work in that region, the way Qlik users expect.

### Per-flag "ignore"

A flag's brief can opt out of page selections ("ignore the region filter"). The field is then left out of that flag's plan entirely, and its selections are skipped when cross-filtering.

## SQL safety

- Table and column names come only from the catalog, are checked by `isIdentifier()` and are always quoted (`"name"`, or `[name]` for Access).
- Every value is a bound parameter (`$1` Postgres, `:p1` Oracle, `?` Access/ANSI). The server binds them with the driver API, including real date types.
- Oracle quoted identifiers are case-sensitive; profiling stores names exactly as the database reports them.
- Access has no `COUNT(DISTINCT …)`; Semaphore refuses rather than generating wrong SQL.

## v1 limits

- One source and one table per flag. Joins arrive with catalog relationships.
- Selections only reach flags on the same table.

## Storage

- **Hoists and the catalog are small JSON files.** On non-persistent VDI profiles, browser storage may be wiped at logoff, so these are saved by the server to the user's home or a network folder. IndexedDB holds only cached results, which are safe to lose.
- Credentials never enter the browser or the hoist: a source names an ARC vault item.

## Sharing

A report is exported as one self-contained HTML file (the same technique as Synapse's standalone edition): the cached results, the hoist and the cross-filter engine, with optional AES-GCM passphrase encryption. Recipients need nothing installed; live drill-downs are disabled in the export.

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
| Web Crypto, DPAPI | Report encryption; secrets via ARC | Planned |
| C# via `Add-Type` | Managed DB drivers (Npgsql, Oracle.ManagedDataAccess), OLE DB for Access | Planned |

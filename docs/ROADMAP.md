# Roadmap

## v0.1: foundations (this release)

Framework-free core with tests: catalog, hoist and flag model, validation, lego grid, thin-client query planner, SQL for four dialects, local cross-filtering, and the intelligence layer (local rules, contract endpoint, OpenAI-compatible gateway, fallback).

## v0.2: local server and sources

- `Launch-Semaphore.bat`, PowerShell 5.1 loopback server, and every lifecycle rule in TechStack (heartbeat, auto-stop, End session, `Stop-Semaphore.ps1`, single instance, runtime file, off switch), following Halyard's reference implementation.
- `/api/query`: run a rendered query against a source with bound, typed parameters, a timeout and the row cap.
- Connectors: Postgres (Npgsql), Oracle (Oracle.ManagedDataAccess), Access (OLE DB, needs the Access database engine already on the machine), CSV in the browser. Then AWS (Athena, Redshift), Azure SQL/Synapse, Palantir Foundry.
- Source profiling into the catalog: tables, columns, types, cardinalities; the analyst names metrics.
- Secrets from the Lazarette vault via the same bridge Halyard uses.
- Hoists and catalogs saved to the user's home or a network folder (non-persistent VDI profiles).

## v0.3: the canvas

- UI per the unified Data Crucible rules (pending).
- Flag palette, drag onto the grid, resize in cell units.
- Hoist brief → drafted layout; click a flag → its own brief, draft, accept.
- Flip a flag over: binding, notes, confidence, generated SQL, lineage.
- ECharts rendering, thresholds, cross-filter clicks, live re-query indicator.

## v0.4: sharing

- Self-contained HTML report with cached results and working filters, optional passphrase encryption.

## Later

- Joins through catalog relationships, so a flag can read more than one table and selections reach related tables.
- Databricks serving endpoint provider.
- Qlik migration helper: read a QVF/QVW load script or field list into the catalog.
- Flag kits: saved flag sets that remap to a new catalog.

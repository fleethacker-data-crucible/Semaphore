<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/emblem-dark.png">
    <img src="assets/brand/emblem-light.png" width="280" alt="Semaphore emblem: a semaphore signal mast on a ship with a dashboard chart, above the waves, inside a brass compass ring">
  </picture>
</p>

# SEMAPHORE · Dashboard Intelligence

Semaphore is a local-first dashboard builder for a single analyst, meant to replace Qlik on thin clients. Part of the Data Crucible family alongside Lazarette, Halyard and Shellback, and built on the same [TechStack](TechStack).

The analyst connects any data source, then builds a dashboard the way you'd build with Lego: drag empty **flags** (blocks) onto a **hoist** (the dashboard), and say in plain English what each one should show and how it should behave. Semaphore works out the data connections.

## The name

Before radio, ships talked with flags. *Semaphore* is a sailor spelling out a message with a flag in each hand, read by eye across open water. A *hoist* is the set of signal flags run up together to send one message; each flag carries one part of it. Semaphore works the same way: every flag on the dashboard carries one part of the picture, and the hoist as a whole tells leadership what they need to know at a glance.

## The idea in one example

The analyst types a brief for the whole hoist:

> *Maintenance picture for the last 12 months. Leadership wants cost and backlog at a glance, and clicking a region or ship class should filter the whole page.*

Semaphore drafts headline KPIs, region and ship-class pickers and a monthly trend, laid out on the grid. The analyst then clicks any flag and refines just that one:

> *Monthly work orders. Ignore the region filter so leadership always sees the fleet-wide trend.*

Every draft is a suggestion with a confidence badge. Flip a flag over to see the exact metrics, fields, filters, behaviour and generated SQL, and edit any of it.

## Status

**v0.1, foundations.** This repository currently holds the framework-free core, fully tested, with no UI yet:

| Piece | Where | State |
| --- | --- | --- |
| Catalog (semantic layer): sources, fields, metrics defined once | `src/core/catalog.ts` | Done |
| Hoist and flag model, validation of anything loaded or returned by an AI | `src/core/hoist.ts` | Done |
| Lego grid: snap, push down, float up, first free slot | `src/core/layout.ts` | Done |
| Query planner sized for thin clients (pre-sliced aggregates, row caps) | `src/core/planner.ts` | Done |
| SQL for Postgres, Oracle, Access, T-SQL (Azure SQL) and ANSI (Athena, Redshift, DuckDB), typed bound parameters only | `src/core/sql.ts` | Done |
| Cross-filtering on cached results, no round trip | `src/core/crossfilter.ts` | Done |
| Intelligence layer: local rules (default), contract endpoint, OpenAI-compatible gateway, fallback | `src/core/intelligence/` | Done |
| PowerShell 5.1 loopback server, lifecycle rules, source connectors, Lazarette vault bridge | — | Next |
| Browser UI (canvas, flag palette, flag inspector, report export) | — | Waiting on the unified Data Crucible UI rules |

See [docs/ROADMAP.md](docs/ROADMAP.md).

## Develop

Requires Node 22.18 or later (it runs TypeScript directly). No packages are needed to run the tests.

```shell
npm test             # node --test, 67 tests
npm run typecheck    # strict tsc (needs typescript and @types/node installed)
```

## Read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): layers, the thin-client data strategy, and how the TechStack maps on
- [docs/FLAG_SPEC.md](docs/FLAG_SPEC.md): the catalog, hoist and flag formats
- [docs/INTELLIGENCE_PROVIDERS.md](docs/INTELLIGENCE_PROVIDERS.md): AI providers, what they are sent, and the contract
- [examples/fleet-maintenance/](examples/fleet-maintenance/): a sample catalog and hoist (synthetic)

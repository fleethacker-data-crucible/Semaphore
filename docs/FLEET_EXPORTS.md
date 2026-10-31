# Fleet exports as data sources

Data > Add data takes the JSON exports of sibling Fleet apps as well as CSV. A recognised export is flattened to a table in the page, typed and profiled by the same reader as a CSV file (`src/core/fleet-exports.ts`), and kept in this browser. Nothing is sent anywhere and no server change is needed.

| Export | File | Becomes |
|---|---|---|
| PacketRat `stats export` | `packetrat.usage-counts/1` | table `packetrat_usage_counts`: `action`, `count` (number), `since`, `exported_at`, `estimate`. The minutes saved are PacketRat's estimate, not a measurement; the note says so. |
| Eight Bells eLog export | `{ watch, entries: [...] }` | table `eight_bells_entries`: `timestamp` (date), `equipment`, `category`, `text`, `status` |
| Halyard backlog health (`health.csv`, `items.csv`, `features.csv`, `velocity.csv`; schema 1, Halyard `docs/SEMAPHORE-EXPORT.md`) | recognised by the pinned header (extra columns on the right are allowed) | tables `halyard_health`, `halyard_items`, `halyard_features`, `halyard_velocity`. Halyard protects a text cell that starts with `=`, `+`, `-`, `@` or a tab with a leading apostrophe; Semaphore takes it off again (it never runs a cell), outside quoted line breaks too. A CSV with other headers loads as plain CSV. |
| Any JSON | an array of objects, or one array of objects under `records`, `items`, `rows`, `entries` or `data` | one table named after the file |

Rules: a nested object is flattened one level (`who_team`), an array is joined with `; `, column names are made safe and unique, and a file that is not a list of records is refused with a message. Limits are the CSV limits.

Not covered: Halyard exports and Bowerbird support bundles are not read specially yet (a Bowerbird bundle is a report, not a table; any list of records in it is read as generic JSON). Reading exports as live sources, so they refresh when the sibling app writes a new one, would need a server-side folder watch and is not built. Tests: `tests/fleet-exports.test.ts` with synthetic data only. Not tried on real exports.

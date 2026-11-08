# Catalog, hoist and flag formats (version 1)

All three are plain JSON. Types live in `src/core/catalog.ts` and `src/core/hoist.ts`; a worked example is in [`examples/fleet-maintenance/`](../examples/fleet-maintenance/).

## Catalog: the semantic layer

Every source, field and metric is defined once. Flags refer to them by key, so "Labor cost" means the same thing on every flag.

```jsonc
{
  "version": 1,
  "sources": [{ "id": "maint", "label": "Maintenance warehouse", "kind": "postgres", "dialect": "postgres", "vaultItem": "Semaphore / maint-warehouse" }],
  "fields": [
    { "key": "jobs.region", "label": "Region", "source": "maint", "table": "ops.work_orders", "column": "region", "type": "string", "cardinality": 6, "synonyms": ["area"] }
  ],
  "metrics": [
    { "key": "labor_cost", "label": "Labor cost", "agg": "sum", "field": "jobs.cost", "source": "maint", "format": "currency", "synonyms": ["cost", "spend"] },
    { "key": "work_orders", "label": "Work orders", "agg": "count", "table": "ops.work_orders", "source": "maint" }
  ]
}
```

- `dialect`: `postgres` | `oracle` | `access` | `tsql` (Azure SQL, SQL Server 2022+) | `ansi` (Athena, Redshift, DuckDB and similar). Postgres, Oracle, Access and Azure SQL sources must use their own dialect.
- `vaultItem` names the Lazarette vault item with the connection secret. The secret itself is never in the catalog.
- `type`: `number` | `string` | `date` | `boolean`. Number fields are aggregated by metrics, not grouped by.
- `cardinality` (distinct values) comes from profiling and drives result-size estimates.
- `agg`: `sum` | `avg` | `min` | `max` | `count` | `count_distinct`. A `count` with no `field` counts rows of `table`. `sum`, `avg`, `min` and `max` need a number field.
- `synonyms` help the local rules match the analyst's words.

## Hoist (dashboard)

```jsonc
{
  "version": 1,
  "id": "fleet-maintenance",
  "title": "Fleet maintenance overview",
  "brief": "Maintenance picture for the last 12 months …",
  "grid": { "cols": 12 },
  "filters": [{ "field": "jobs.opened", "op": "last", "values": [12], "unit": "month" }],
  "flags": [ … ],
  "design": { "look": "bridge", "card": "glass", "radius": 14, "backdrop": "tide", "font": "system", "charts": { "palette": "signal", "fill": "gradient", "glow": true, "motion": "lively" } },
  "experiment": false,
  "updated": "2026-10-25T16:00:00.000Z"
}
```

`filters` apply to every flag on the same table, unless the flag ignores that field. Filters on other tables are reported on the flag rather than silently dropped.

`design` (optional) is how the page looks ([DESIGN.md](DESIGN.md)); it never changes what a flag means. `look` names the preset it came from (`standard`, `bridge`, `broadsheet`, `beacon`, `chartroom`); `card` is `raised` | `outline` | `flat` | `glass`; `radius` is the card corner in pixels (0–24); `backdrop` is `plain` | `tide` | `dawn` | `grid`; `font` is `system` | `serif` | `mono` | `condensed`; `charts` holds the defaults every flag's chart starts from (the `ChartLook` fields of the flag `style` below). Every value is checked against its list or range when read (`parseDesign` in `src/core/design.ts`), and colours must be plain `#rrggbb`. `experiment: true` marks a page the playbook and team style never learn from.

## Flag (block)

```jsonc
{
  "id": "line-trend",
  "kind": "line",
  "title": "Work orders per month",
  "brief": "Monthly work orders. Ignore the region filter …",
  "layout": { "x": 6, "y": 2, "w": 6, "h": 4 },
  "binding": {
    "metrics": ["work_orders", "avg_days_open"],
    "dimensions": [{ "field": "jobs.opened", "grain": "month" }],
    "filters": [],
    "sort": { "by": "jobs.opened@month", "dir": "asc" },
    "limit": 10,
    "compare": "previous-year",
    "share": false
  },
  "behavior": {
    "onClick": "none",
    "ignore": ["jobs.region"],
    "thresholds": [{ "metric": "labor_cost", "op": "gt", "value": 5000000, "tone": "bad" }]
  },
  "status": "ready",
  "confidence": 0.8,
  "notes": [],
  "style": { "palette": "ember", "barLayout": "stacked", "target": { "value": 50, "label": "Goal" }, "hideTitle": false }
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `kpi` (one number), `bar`, `line`, `area`, `pie` (one field), `table`, `filter` (a picker for one field), `text`; also `combo` (one field, two or more measures: bars and a line) and `map` (one field of states or region names, or latitude and longitude fields; [MAPS.md](MAPS.md)) among the richer chart kinds |
| `brief` | What the analyst asked for, in their words. The hoist brief sets context; the flag brief wins where they disagree. |
| `layout` | Grid cells on a 12-column grid. Flags never overlap and float up to fill gaps. |
| `binding` | `null` until drafted. Metric keys, dimension fields (dates may have a `grain`), filters, optional sort and limit. |
| `dimension key` | A field key, or `field@grain` for dates (`jobs.opened@month`). Used in sorts and selections. |
| `filters[].op` | `in`, `eq`, `gte`, `lte`, `between` (two values), `last` (a whole count plus `unit`; includes the current period). `eq` with an empty value (`""`) means blank: it matches NULL and, on a text field, the empty string too (`(col IS NULL OR col = '')` in SQL). |
| `filters[].values` | Typed by the field: a date is `YYYY-MM-DD` (longer text is read as the day its first ten characters name), a yes-or-no field takes `true`/`false`, a number reads as a number. A value that does not read as the field's type removes the filter with a warning. |
| `binding.limit` | A "top N". It always has an order: a limit with no `sort` ranks by the first metric, highest first, with a warning. |
| dates in data | A date or date-time cell means the calendar day it is written as, whatever zone the text carries or the browser runs in (`2026-03-01T22:00:00` is 1 March). Filters, period buckets (`grain`), selections and comparison shifts all read it that way, as a database's `date_trunc` does in the column's own clock. |
| `binding.compare` | Optional. `previous-period` (the window just before) or `previous-year` (the same window a year earlier). Needs a `last` filter on the flag or the page; the earlier window is like for like (on 26 October, "last 3 months" compares 1 Aug–26 Oct with 1 May–26 Jul). Time values are moved forward so March lines up with March. |
| `binding.share` | Optional. Show each value as a share of the total across all rows, taken before any top-N cut (a share flag's top N is never cut at the source, so the total is the true one; the earlier window of a comparison is a share of its own total). |
| `behavior.onClick` | `filter-page` (select that value everywhere), `drill`, or `none` |
| `behavior.ignore` | Fields whose page selections this flag skips |
| `behavior.thresholds` | Colour rules; the first match wins. Tones: `good`, `warn`, `bad` |
| `status` | `empty` → `drafted` (an AI suggestion, not yet accepted) → `ready`; `error` when the binding is unusable |
| `confidence` | 0–1 from the provider. Low values show a "verify" badge. |
| `notes` | Plain-language explanations: what could not be matched, what re-queries the source, and why |
| `style` | Optional. How this one flag is drawn, over the page's `design` ([DESIGN.md](DESIGN.md)); never touches the binding. Chart fields shared with `design.charts`: `palette` (`skin`, `signal`, `ember`, `meadow`, `dusk`, `mono`, `custom` with `colors`), `fill`, `corners`, `glow`, `curve`, `lineWidth`, `markers`, `labels`, `legend`, `gridLines`, `focus`, `motion` (`none`, `calm`, `lively`), `striped`, `tableBars`, `titleAlign`. Flag-only: `barLayout` (`auto`, `stacked`, `grouped`, `percent`), `orientation`, `pieForm` (`donut`, `pie`, `rose`, `funnel`, `treemap`), `kpiForm` (`number`, `gauge`) with `gaugeMax`, `kpiSize`, `zeroBase` (lines only; bars always start at zero), `target` `{ value, label }`, `average`, `zoom`, `accent` (a `#rrggbb` strip), `hideTitle`, `combo` (combo flags: per measure key `{ as: "bar" | "line", axis: "left" | "right" }`, only where it differs from the default of bars on the left and the last measure a line on the right), `map` (map flags: `us-states`, the default, or a region map's id; [MAPS.md](MAPS.md)). Checked by `parseFlagStyle` in `src/core/design.ts`; an unknown value is dropped. |

## Validation

Everything is validated when it is loaded, imported, or returned by an AI provider (`parseHoist`, `validateFlagDraft`):

- A document that is not a version-1 hoist is rejected.
- A malformed flag (bad id, unknown kind, bad layout, duplicate id) is dropped, with a warning.
- An unknown metric or field inside a flag is removed, with a warning, and a `ready` flag drops back to `drafted` for review.
- Provider output that needed fixing has its confidence capped at 0.4.
- An unknown `compare` value is removed, with a warning.
- A draft's kind and binding are made to agree: a KPI has no fields (or becomes a chart), a pie and a picker have one field, a picker has no metrics and filters the page.
- Overlapping layouts are moved down to fit, with a warning.
- Size limits are in `LIMITS` in `src/core/hoist.ts`; anything over a limit is cut or removed with a warning, never silently.

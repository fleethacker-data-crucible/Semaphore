# Fleet maintenance (synthetic)

A sample catalog and hoist used by the tests and as a demo. All names and numbers are invented.

- `catalog.json`: two sources (a Postgres maintenance warehouse and an Access parts tracker), their fields and five metrics, including an average and a distinct count to exercise re-aggregation.
- `hoist.json`: KPIs, a ship-class picker, labor cost by region (clicking a bar filters the page), a monthly trend that ignores the region filter, and one empty flag waiting for a brief.

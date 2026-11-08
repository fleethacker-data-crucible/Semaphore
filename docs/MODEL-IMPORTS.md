# Import a model: Qlik, dbt and Power BI

Data > Add data > **Import a model** (or Ctrl+K, *Import a model…*) brings across what analysts already
defined in another tool. Pick where it comes from:

- **Qlik app**: paste the load script and chart expressions (the Qlik import, unchanged).
- **dbt project**: pick the project folder, or its YAML files.
- **Power BI model**: pick a Power BI Project's `.SemanticModel` folder (its `.tmdl` files) or a `model.bim`.

The files are read in the page, with no model and nothing sent anywhere (src/core/dbt.ts,
src/core/powerbi.ts, src/core/yaml.ts). Semaphore then shows what it found: the tables, the
Semaphore source and database table each one maps to (both can be changed), the measures it will
add, the links and drill paths, and a warning for each thing it will not import, with the original
expression. Nothing reaches the catalog until you choose **Import**. Then each picked table is
profiled for its real columns and types (one query per table), and the model's field names,
measures, links and drill paths are added (src/core/model-import.ts). Measures the profile already
proposed the same way are used as they are rather than added twice; importing again adds nothing new.

Types always come from the database. When the model says a column is a date or a number and the
database reads it as text, the import says so, so you can add a cleaning step under Data > Clean.

## Calculated measures

A measure built from other measures (a ratio, a margin, a total of two costs) becomes a calculated
measure: `{ key, label, agg: 'formula', formula, format?, source }`, where `formula` names other
measures by their catalog key with `+ - * /`, unary minus, parentheses and numbers only. Division by
zero gives an empty value. Anything that does not fit that grammar is a warning, never a guess.

## dbt

| dbt | Semaphore |
|---|---|
| `dbt_project.yml` `name` | the import's name |
| `models:` in models/\*\*/\*.yml (name, `config.alias`, columns, `data_type`) | the database table name and the declared column types |
| `semantic_models` (MetricFlow) | a table, read from its `model: ref('...')` |
| dimension (categorical, or time with `time_granularity`) | a field, labelled with the dimension's `label` (the name is kept as a synonym); time dimensions show their grain |
| entity `primary` / `unique` and a `foreign` entity of the same name | a link from the foreign side (many) to the primary side (one) |
| measure `sum`, `count`, `count_distinct`, `average`, `min`, `max` over a column | a measure; `expr: 1` is a row count |
| metric `simple` | its measure, with the metric's name and label |
| metric `ratio` | calculated: numerator / denominator |
| metric `derived` | calculated, when its `expr` is only metrics, numbers, `+ - * /` and parentheses (aliases are followed) |
| legacy metrics (dbt before 1.6: `calculation_method`, `expression`, `timestamp`, `dimensions`) | measures on their model; `derived` ones through `{{ metric('x') }}` become calculated |

Warned and not imported: measures `sum_boolean`, `median`, `percentile` and any aggregation over a
SQL expression; dimensions that are SQL expressions; metrics with a `filter` (Semaphore measures do
not carry a fixed filter: add it to the flags that use the measure); derived metrics with
`offset_window` / `offset_to_grain` (use a flag's comparisons, previous period or previous year);
`cumulative` and `conversion` metrics; derived expressions with functions; Jinja other than `ref()`,
`source()` and legacy `metric()`; semi-additive measures are imported with a note. dbt has no
hierarchies, so none are proposed. The YAML reader handles the subset dbt uses (maps, lists, flow
`[ ]` and `{ }`, quoted strings, `|` and `>` blocks, comments, several documents); anchors, aliases,
merge keys and tags are warned about and not resolved.

`profiles.yml` (the connection profile, with its secrets) and everything under `target/`,
`dbt_packages/`, `logs/` and `.git/` are never read.

## Power BI

Only the text formats are read. **A .pbix is refused**: its model is a compressed binary format. In
Power BI Desktop choose File > Save as > Power BI Project (.pbip) and pick its `.SemanticModel`
folder, or open the model in Tabular Editor and save it as `model.bim`.

| Power BI | Semaphore |
|---|---|
| table | a table; the database table comes from the partition's M query (`Schema`/`Item`), a DirectLake entity, or `SELECT * FROM x`, otherwise the table name (edit it in the review) |
| `Sql.Database("server", "db")` and similar | a hint used to pick the Semaphore source |
| column (`sourceColumn`, `dataType`) | a field labelled with the Power BI name; int64, double, decimal → number, string → text, dateTime → date, boolean → yes/no |
| `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `DISTINCTCOUNT` of `T[c]`, `COUNTROWS(T)` | a measure |
| `DIVIDE(a, b)` (or with `BLANK()`), `a / b`, `a + b`, `a - b`, `a * b` over measures and those aggregates | a calculated measure (an inline aggregate becomes a measure of its own, or reuses an identical one) |
| `CALCULATE(x)` with no filter | x |
| format string with a currency sign / `%` | currency / percent |
| relationship (`fromColumn`, `toColumn`, cardinality) | a link from the many side to the one side, turned round when Power BI lists the one side first; one-to-one and both-direction filtering are noted |
| hierarchy | a drill path, levels in order |
| column names | field labels; the label Semaphore proposed from the column is kept as a synonym |

Warned and not imported: `CALCULATE` with filters (add the filter to the flags), time intelligence
(`TOTALYTD`, `SAMEPERIODLASTYEAR`, `DATEADD` and the rest: use a flag's comparisons, previous
period or previous year, or a running total), `DIVIDE` with an alternate result other than blank,
iterators (`SUMX`) and every other function, `VAR`/`RETURN`, calculated columns and calculated
tables, many-to-many and inactive relationships, and Power BI's automatic date tables. Descriptions
are shown in the review but the catalog has no place for them; display folders are not kept.

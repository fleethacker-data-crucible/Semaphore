# Calculated measures and reshaping fixes

Two additions to the catalog, both accepted from a sentence the way cleaning fixes are: you say what
you want, Semaphore says it back (with a preview for a fix), and nothing changes until you accept.

## Calculated measures

A calculated measure is worked out from other measures:

```json
{ "key": "cost_per_hull", "label": "Cost per hull", "agg": "formula", "formula": "labor_cost / hulls_affected", "format": "currency", "source": "maint" }
```

The formula holds other measure keys, numbers, `+ - * /`, unary minus and parentheses, nothing else
(src/core/formula.ts is the one grammar; the dbt and Power BI importers use it too). A formula may
build on other formulas, up to 6 deep, and is at most 2000 characters. The catalog check refuses a
formula that names a measure that is not there, a measure from another source, or a circle of
formulas, and says which.

**How it is computed.** A formula is never sent to a database. The planner asks the source for its
inputs' aggregates as hidden parts of the query (`SUM(cost)`, `COUNT(DISTINCT hull)`), exactly as an
average asks for a sum and a count, and the value is worked out after the query, from each row's
own aggregates. So it is the same in the in-page engine and in all nine SQL dialects, and:

- per row of a result: cost per hull for East is East's cost over East's hulls;
- in totals (a top-N's total, share of the total): from the inputs' totals, never by adding up the
  rows' ratios. Over a distinct count, whose total cannot be added up from rows, the page reads the
  total from the data with one more query grouped by nothing;
- in comparisons: the earlier window's value is its own ratio;
- in pivots: a formula is not added up from its cells; subtotals and the grand total are read from
  the data at their level, like averages and distinct counts;
- division by zero, or an input with no value, shows nothing (null);
- ranking and top N by a formula happen in the page, never at the source.

**From a sentence.** On Data > Measures, *Define a measure in words*, or in a flag's brief:

- `cost per hull = labor cost / hulls`
- `cost per job is labor cost divided by work orders`
- `the difference between labor cost and parts cost`
- `parts share: parts cost as a percent of labor cost` (shown as a percent)

Measures are found by their names, keys and synonyms. A brief that defines a measure offers it above
the inspector; once added, the flag is drafted again over it, and the brief keeps meaning the new
measure rather than the two it is made of. The readback says the formula in words.

## Fixes that make fields or a table

On Data > Clean, *Describe a fix*:

| Sentence | Makes |
|---|---|
| `split full name on the comma into last and first` | two fields, the text between commas (2 to 4 parts) |
| `split code at 3 into prefix and number` | by position: the first 3 characters, then the rest (up to 8 parts) |
| `join city and state with ', ' as location` | one field; blank values are skipped |
| `group days open into 0-7, 8-30, 31-90, 90+` | one field of labels; whole-number ranges close at the next whole number, so 7.5 is in 0-7 |
| `bucket cost into quartiles` (or tertiles, quintiles, deciles, "5 equal groups") | Q1 to Q4 by row count |
| `turn the month columns Jan..Dec into rows of month and value` | a new long table: the other columns, the column's name and its value, with a total measure |

Parts, joined values and labels are trimmed, and blank is null. New fields get their types (text for
parts, joins and groups; the columns' type for an unpivoted value). The preview runs the step on the
real data first. Undo takes the step out with the fields it made and anything built on them: other
steps, measures, formulas and drill paths.

**SQL.** A made field is an expression over its inputs, computed once in the query's inner select;
every value (delimiter, separator, bounds, labels) is a bound parameter, written in the order the
`?` dialects read. Splits use `SPLIT_PART` (PostgreSQL, Spark, ANSI), `SUBSTRING_INDEX` (MySQL),
`INSTR` with an occurrence (Oracle), and `CHARINDEX` / `instr` / `InStr` chains (T-SQL, Synapse,
SQLite, Access). Quartiles use `NTILE` over every row of the table, partitioned so blanks stay
blank; Access has no NTILE, so it uses the group bounds read from the values when the step was
accepted. A reshaped table is a derived table of one `SELECT` per column joined with `UNION ALL`.
The in-page engine follows the same rules; the SQLite SQL is checked against it in tests.

**Limits.** A made field or reshaped table cannot be on the many side of a one-to-many split, and
quartile groups are read only on charts of their own table. Mixed date formats are still cleaned in
data held in the page only.

The readers and SQL for these fixes load only for a catalog that has them (src/core/reshape-impl.ts).

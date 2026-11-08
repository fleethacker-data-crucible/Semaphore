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

**Inputs in different tables** (src/core/across.ts). Cost per hull with labor cost on jobs and hulls
on a hulls table, or labor cost plus parts cost from two fact tables: the tables are never joined to
each other (that would repeat each one's rows once per row of the other). The flag is planned as one
query per table, a *drill-across*:

- each table's query asks for its own inputs, grouped by the same fields, with the same filters, page
  selections and comparison window, each reaching those fields through its own relationships (a
  shared regions or calendar table). A total with no split needs no relationship at all;
- the rows are lined up by the group values, like a full outer join. A group one table has and the
  other does not gets nothing for the other's inputs, so a formula that needs both shows nothing
  there; the flag's notes say how many groups that is ("2 of these groups are found in only some of
  jobs, hulls ..."). Each table's query also counts its rows, which is how a group with no rows there
  is told apart from one whose values are blank;
- in SQL it is one statement: each table's `SELECT ... GROUP BY`, with `NULL` for the other tables'
  aggregates, joined with `UNION ALL` and grouped once more by the same columns (`MAX` of the one
  value each group has per table). Placeholders are numbered across the parts; only the outer
  statement has `TOP`, `LIMIT` or `FETCH FIRST`. The in-page engine runs each part and lines the rows
  up the same way; the SQLite SQL is checked against it in tests;
- totals come from each table's own totals; a distinct count's total is read with one more
  statement grouped by nothing (one part per table again). Comparisons, shares, pivot levels (one
  statement per level), ranking and top N in the page, drill, exports, snapshots (the lined-up rows
  re-add like any others), lineage (both tables and their joins) and the readback ("Worked out from
  jobs and hulls, lined up by Region ...") all follow;
- page selections apply locally only when every table is pre-split by the field; a field one table
  cannot reach does not apply, with a note;
- refused, with the field and table named: a split or filter field one of the tables cannot reach
  ("From hulls: "Status" is in a table not related to hulls"), a page filter that does not reach one
  of them, and a many-side ambiguity from one of them (the one-to-many joins' message). Inputs in two
  different sources are still refused.

The planning of these flags loads on first use, so the start of the page does not grow with it.

**From a sentence.** On Data > Measures, *Define a measure in words*, or in a flag's brief:

- `cost per hull = labor cost / hulls`
- `cost per job is labor cost divided by work orders`
- `the difference between labor cost and parts cost`
- `parts share: parts cost as a percent of labor cost` (shown as a percent)

Measures are found by their names, keys and synonyms. A brief that defines a measure offers it above
the inspector; once added, the flag is drafted again over it, and the brief keeps meaning the new
measure rather than the two it is made of. The readback says the formula in words.

**In flag kits.** A kit saved with a flag on a calculated measure carries the measure's definition:
label, format, formula, and each input described like any kit metric. Flown onto another catalog,
each input is matched by key, label or synonym; an identical formula already there is used, or the
measure is made again over the matched inputs (under a free key); an input with no match leaves the
flag empty with the input named ([FLAG_KITS.md](FLAG_KITS.md)).

## Fixes that make fields or a table

On Data > Clean, *Describe a fix*:

| Sentence | Makes |
|---|---|
| `split full name on the comma into last and first` | two fields, the text between commas (2 to 4 parts) |
| `split code at 3 into prefix and number` | by position: the first 3 characters, then the rest (up to 8 parts) |
| `join city and state with ', ' as location` | one field; blank values are skipped |
| `group days open into 0-7, 8-30, 31-90, 90+` | one field of labels; whole-number ranges close at the next whole number, so 7.5 is in 0-7 |
| `bucket cost into quartiles` (or tertiles, quintiles, deciles, "5 equal groups") | Q1 to Q4 by row count; equal values always share a group, so groups can differ in size |
| `turn the month columns Jan..Dec into rows of month and value` | a new long table: the other columns, the column's name and its value, with a total measure |

Parts, joined values and labels are trimmed, and blank is null. New fields get their types (text for
parts, joins and groups; the columns' type for an unpivoted value). The preview runs the step on the
real data first. Undo takes the step out with the fields it made and anything built on them: other
steps, measures, formulas and drill paths.

**SQL.** A made field is an expression over its inputs, computed once in the query's inner select;
every value (delimiter, separator, bounds, labels) is a bound parameter, written in the order the
`?` dialects read. Splits use `SPLIT_PART` (PostgreSQL, Spark, ANSI), `SUBSTRING_INDEX` (MySQL),
`INSTR` with an occurrence (Oracle), and `CHARINDEX` / `instr` / `InStr` chains (T-SQL, Synapse,
SQLite, Access). A reshaped table is a derived table of one `SELECT` per column joined with `UNION ALL`.
The in-page engine follows the same rules; the SQLite SQL is checked against it in tests.

**Equal-count groups and ties.** One rule everywhere (the page, its worker, every dialect, Access):
a value's group is `floor((rank - 1) * k / n) + 1`, where `rank` is its rank among the values that are
not blank, in ascending order, with equal values sharing the lowest rank (one more than how many
values are below it), `n` is how many values are not blank and `k` is the number of groups. Blanks
stay blank. So equal values always share a group, the result never depends on row order, and groups
can differ in size: 1, 1, 1, 1, 2, 3, 3, 9 in quartiles is Q1 for the 1s, Q3 for 2 and 3, Q4 for 9,
and no Q2. In SQL (PostgreSQL, Oracle, T-SQL, Synapse, Spark, MySQL 8+, SQLite 3.25+ and the ANSI
engines) it is `RANK() OVER (PARTITION BY <blank or not> ORDER BY x)` and `COUNT(x) OVER ()` over
every row of the table, compared as whole numbers (`(rank - 1) * k < n * g` for group g), so no
dialect's division or rounding can differ. Access has no window functions: when the step is accepted
Semaphore reads the field's values and counts, works out each group's upper bound by the same rule,
and the SQL is a `Switch` over those bounds (a group no value falls in takes the bound before it).

**On the many side of a one-to-many split** (docs/ONE_TO_MANY_JOINS.md), a made field is computed
inside the many-side block, in a derived table of its own table (`(SELECT s.*, <made field> AS
sem_made0 FROM orders AS s)`), so equal-count groups rank the many-side table's own rows; a reshaped
table there is its derived table of `UNION ALL`s. Customers are still counted once per group.

**Limits.** Equal-count groups are read on charts of their own table or from the many side of a
one-to-many split, never through a many-to-one join (they would rank the joined rows). Mixed date
formats are still cleaned in data held in the page only.

The readers and SQL for these fixes load only for a catalog that has them (src/core/reshape-impl.ts).

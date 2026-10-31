# One-to-many joins

A flag's measures live on one table, its **base**. Until now the base could only reach tables
many-to-one (a job's ship, the ship's class), so a join never repeated a base row and totals stayed
right. This adds the opposite direction: a measure on the **one** side (`customers.credit_limit`, a
count of customers) split or filtered by a field on the **many** side (`orders.status`). Nothing is
counted twice.

Code: `src/core/manyjoin.ts` (planning, SQL derived table, in-page rows). Small hooks in
`planner.ts`, `sql.ts`, `engine.ts`, `crossfilter.ts`, `describe.ts` and `web/src/lib/data.ts`.

## Why a plain join is wrong

`customers LEFT JOIN orders` repeats Alice once per order. `SUM(credit_limit)` then counts her limit
three times. The fix is to shrink the many side to the pairs we actually need, *before* joining.

## The semantics

For a flag on `customers` that reads `orders` fields:

| Situation | What is counted |
|---|---|
| Split by a many-side field (`credit limit by order status`) | Each customer **once in every group it has at least one order in**, never once per order. A customer with open and shipped orders is in both groups. |
| Split by several fields (`status`, `region`) | Once per **combination** the customer appears in. |
| Filter on a many-side field (`status is open`) | Customers with **at least one** matching order, each once. Customers with no matching order are left out (no blank group). |
| Several many-side filters | All must hold on the **same order**. Status open and placed in September means one order that is both. |
| Split with no filter | Customers with no orders fall in the **blank group**, as an unmatched row does for a LEFT JOIN today. |
| `sum`, `count`, `avg`, `min`, `max`, `count_distinct` | Computed over those de-duplicated one-side rows. `avg` is the sum of the credit limits over the count of customers in that group. |
| No split (KPI, or split only by the customer's own fields) | The true total. A filter alone never overlaps. |

Duplicated many-side rows (the same order entered twice) change nothing: the many side is reduced
to *distinct* pairs.

### Groups can overlap, so there is no grand total

Because a customer sits in several groups, group values can add up to more than the true total (in
the tests: 300 + 500 + 300 = 1,100 against a real 1,000). Semaphore:

* warns in the plan notes and in the flag readback ("Order status splits customers: ... the groups can
  add up to more than the real total of customers");
* offers **no total** for that flag (`applySelections().totals` is `null` for its metrics), so no
  insight or briefing is built from a doubled sum;
* **refuses a "share of the total"** on an overlapping split, with a message, instead of drawing
  percentages that add up to more than 100%.

### Page selections

Clicking a value elsewhere on the page normally filters a flag locally, because the planner
pre-splits the result by the fields other flags can select. A many-side field is **never** a
pre-split: adding its groups back up would count a customer twice. A selection on a many-side field
re-queries the source with the value as a **filter** (a semi-join), which is exact. Selections on
the customer's own fields (segment, region) still apply locally. The plan notes say which is which.

## Which tables count as the many side

Starting from the base table `A`, a field's table `T` is on the many side when it is reached by going
**against** one or more relationships first, then optionally many-to-one:

```
customers <- orders                       (orders.customer_id -> customers.id)
customers <- orders <- order_lines        (two steps down)
customers <- orders <- order_lines -> products   (then one lookup across)
```

* A table reachable **many-to-one from the base always wins** (the existing rule, unchanged).
  Only tables that cannot be reached that way are looked for on the many side.
* The many side is searched only when the flag has a measure; a list or picker with no measure keeps
  today's behaviour (a one-side table cannot reach the many side).
* At most six hops.

### Refused, never guessed

| Case | Message says |
|---|---|
| Two relationships between the same tables (`orders.billing_id` and `orders.ship_id` both to customers) | the field "relates to customers in 2 ways (...; or ...). Semaphore will not guess which one you mean" |
| A diamond: a table reached through two different many-side paths (warehouses via orders and via shipments) | same, listing both paths |
| Fields from two different many-side tables in one flag (`orders.status` with `shipments.carrier`) | "different many-side tables of customers (orders and shipments)": pairing their rows would multiply them, so use one many-side table per flag |
| A table reached two different ways inside the block | refused with the table named |
| A share of the total over an overlapping split | refused (see above) |

Ambiguity is refused for the flag's fields and filters **and for page filters**, because ignoring a
page filter silently would also be a guess. Ambiguous *selections* from other flags are skipped with
a note. Refusals are returned as `{ ok: false, reason: 'many-side' }` and the flag readback shows
the message.

## The SQL

The many side becomes a derived table of distinct `(key, group values)` pairs, joined to the base on
its key. Every value is a bound parameter; identifiers are quoted from the catalog as before.

```sql
-- credit limit by order status, orders filtered to open/shipped, customers filtered to gold
SELECT "mx"."g0" AS "d0", SUM("t0"."credit_limit") AS "a0"
FROM "customers" AS "t0"
INNER JOIN (SELECT DISTINCT "m0"."customer_id" AS "k", "m0"."status" AS "g0"
            FROM "orders" AS "m0"
            WHERE "m0"."status" IN ($1, $2)) AS "mx" ON "t0"."id" = "mx"."k"
WHERE "t0"."segment" = $3
GROUP BY "mx"."g0" LIMIT 50000
```

* `mx` has the key `k` and one column per many-side group (`g0`, `g1`, ...). Dates are cut to their
  grain **inside** the `DISTINCT`, so a customer with two orders in one month is one row for that
  month.
* **LEFT JOIN** when there is no many-side filter (customers without orders keep a blank group),
  **INNER JOIN** when there is one (a semi-join).
* Deeper many sides and their lookups are LEFT JOINs inside the block:
  `orders LEFT JOIN order_lines LEFT JOIN products`.
* Cleaning steps on a many-side field run once, in an inner query of the block, and the group value
  passes through the outer query unchanged. Values are bound in the order they appear in the text,
  which the `?` dialects need.
* A dedupe step on the base table still applies. On many-side tables it is moot: the block is
  already distinct.

| Dialect | Notes |
|---|---|
| postgres | `$n`, `"quoted"`, `LIMIT` |
| oracle | `:pN`, no `AS` before table aliases, `FETCH FIRST n ROWS ONLY` |
| tsql | `@pN`, `[quoted]`, `SELECT TOP n` |
| access | `?`, every join but the first wrapped in brackets, on the block's joins as well as the outer ones; `TOP n` |
| ansi | `?`, `"quoted"`, `LIMIT` |

Access has no `COUNT(DISTINCT ...)`; as before, a `count_distinct` metric is refused there.

## In the page

`engine.ts` builds the same distinct set from the rows in memory (`prepareManyRows`): it expands the
many-side tables, applies the many-side filters and cleaning, cuts dates to grain, keeps the distinct
`(key, group)` pairs, and expands each base row to the groups it belongs to. A base row with none
goes to the blank group (LEFT) or is dropped (semi-join). The tests run the generated `ansi` SQL on
SQLite for real and compare the rows to the engine's, for sums, counts, averages, extremes,
distinct counts, filters, multi-field splits, deeper paths and cleaning.

## What the analyst sees

The flag readback (`describeFlag`) adds plain-English lines, for example:

> Customers is the one side of orders: a customer can have several orders. Each customer is counted
> from its own row once, never once per order. Split by Order status, each customer is counted once in
> every group it has at least one order in, so a customer with orders in two groups appears in both. A
> customer with no orders falls in the blank group. Order status splits customers: a customer with
> orders in several groups is counted in each, so the groups can add up to more than the real total of
> customers. Totals and shares are not built by adding the groups up.

The same warning is in the plan notes the flag card and inspector already show.

## Not covered

* Many-to-many through a shared lookup (customers <- orders -> products <- other_orders) is never
  searched: a path must go down, then only up.
* The lineage view (`lineage.ts`) draws the join path to a many-side field, every hop (customers, orders,
  order lines, products), and marks a flag that reads a field reachable in more than one way. Drafting from
  plain English (`local-rules.ts`) still only follows many-to-one hops, so it does not yet suggest many-side
  fields. A flag written by hand or edited in the inspector can use them.
* Access nested joins with bound parameters inside the derived table follow the same bracket rules as
  the existing joins but have not been run against a live Access engine, nor Oracle, SQL Server or
  PostgreSQL: only the text is tested for them, plus SQLite for the `ansi` text.
* The relationship's `to` column is assumed to identify one row (discovery checks this). A repeated
  key on the one side would count each of those rows, as it would anywhere.

// Porting from Qlik (src/core/qlik.ts): load scripts and chart expressions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLoadScript, parseQlikExpression, qlikAssociations, qlikLabels, qlikMappings } from '../src/core/qlik.ts';

const SCRIPT = `
///$tab Main
SET ThousandSep=',';
LET vToday = Today();
// Region names arrive three different ways
RegionMap:
MAPPING LOAD * INLINE [
from, to
N.E., Northeast
NE, Northeast
Gulf Coast, Gulf
];

LIB CONNECT TO 'Maintenance Warehouse (shipyard)';

/* Work orders: renamed for the analysts */
WorkOrders:
LOAD
    wo_id         AS [Work Order],
    hull_no       AS HullNo,
    ApplyMap('RegionMap', region, region) AS Region,
    opened_on     AS [Opened Date],
    labor_cost    AS [Labor Cost],
    Date(closed_on) AS [Closed Date],
    labor_cost * 1.1 AS [Loaded Cost];
SQL SELECT wo_id, hull_no, region, opened_on, closed_on, labor_cost
FROM ops.work_orders
WHERE opened_on >= '2024-01-01';

Hulls:
LOAD HullNo, [Ship Class], Commissioned
FROM [lib://Shipyard/hulls.qvd] (qvd);

LEFT JOIN (Hulls)
LOAD HullNo, [Home Yard]
RESIDENT WorkOrders;

REM this table is not used any more;
Trace Done;
`;

test('reads connections, tables, renames and where clauses', () => {
  const s = parseLoadScript(SCRIPT);
  assert.deepEqual(s.connections, ['Maintenance Warehouse (shipyard)']);
  assert.deepEqual(s.tables.map((t) => [t.label, t.kind]), [['RegionMap', 'mapping'], ['WorkOrders', 'sql'], ['Hulls', 'file'], ['Table 1', 'resident']]);
  const wo = s.tables[1]!;
  assert.equal(wo.from, 'ops.work_orders');
  assert.equal(wo.connection, 'Maintenance Warehouse (shipyard)');
  assert.match(wo.where ?? '', /opened_on >= '2024-01-01'/);
  assert.deepEqual(wo.fields.slice(0, 2), [{ column: 'wo_id', name: 'Work Order' }, { column: 'hull_no', name: 'HullNo' }]);
  const region = wo.fields.find((f) => f.name === 'Region')!;
  assert.equal(region.mapping, 'RegionMap');
  assert.equal(region.column, 'region');
  assert.equal(wo.fields.find((f) => f.name === 'Closed Date')?.column, 'closed_on', 'one-column computed fields keep their column');
  assert.equal(wo.fields.find((f) => f.name === 'Loaded Cost')?.expression, 'labor_cost * 1.1');
  const hulls = s.tables[2]!;
  assert.equal(hulls.from, 'lib://Shipyard/hulls.qvd');
  const join = s.tables[3]!;
  assert.deepEqual(join.into, { how: 'left join', table: 'Hulls' });
  assert.equal(join.from, 'WorkOrders');
  assert.equal(s.warnings.length, 0, s.warnings.join('\n'));
});

test('labels for profiling: column -> the name analysts know', () => {
  const labels = qlikLabels(parseLoadScript(SCRIPT));
  const wo = labels.get('ops.work_orders')!;
  assert.equal(wo.get('wo_id'), 'Work Order');
  assert.equal(wo.get('labor_cost'), 'Labor Cost');
  assert.equal(wo.has('closed_on'), false, 'computed fields are not plain labels');
  assert.equal(labels.get('lib://Shipyard/hulls.qvd')?.get('ship class'), 'Ship Class');
});

test('associations: fields Qlik links tables on', () => {
  const a = qlikAssociations(parseLoadScript(SCRIPT));
  const hull = a.find((x) => x.field === 'HullNo')!;
  assert.deepEqual(hull.tables.map((t) => [t.label, t.column]), [['WorkOrders', 'hull_no'], ['Hulls', 'HullNo'], ['Table 1', 'HullNo']]);
});

test('mapping tables become cleaning proposals with their pairs and users', () => {
  const m = qlikMappings(parseLoadScript(SCRIPT));
  assert.equal(m.length, 1);
  assert.deepEqual(m[0]!.pairs, [['N.E.', 'Northeast'], ['NE', 'Northeast'], ['Gulf Coast', 'Gulf']]);
  assert.deepEqual(m[0]!.usedBy, ['WorkOrders.Region']);
});

test('a plain SQL SELECT with no preceding load, and a statement it cannot read', () => {
  const s = parseLoadScript("ODBC CONNECT TO [Parts];\nParts: SQL SELECT ItemName, QtyOnHand FROM \"dbo\".\"Parts\";\nFOO bar;");
  assert.deepEqual(s.connections, ['Parts']);
  assert.equal(s.tables[0]!.from, 'dbo.Parts');
  assert.deepEqual(s.tables[0]!.fields.map((f) => f.column), ['ItemName', 'QtyOnHand']);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /FOO bar/);
});

test('semicolons inside quotes and brackets do not split statements', () => {
  const s = parseLoadScript("T: LOAD [a;b] AS X, 'x;y' AS Y FROM [c:\\data\\f;1.csv] (txt);");
  assert.equal(s.tables.length, 1);
  assert.deepEqual(s.tables[0]!.fields.map((f) => f.name), ['X', 'Y']);
});

test('expressions: aggregates, DISTINCT and set analysis', () => {
  assert.deepEqual(parseQlikExpression('Sum([Labor Cost])'), { ok: true, agg: 'sum', field: 'Labor Cost', filters: [], label: 'Total Labor Cost' });
  assert.deepEqual(parseQlikExpression('=Count(DISTINCT HullNo)'), { ok: true, agg: 'count_distinct', field: 'HullNo', filters: [], label: 'Distinct HullNo' });
  assert.deepEqual(parseQlikExpression('Count(*)'), { ok: true, agg: 'count', filters: [], label: 'Count' });
  const set = parseQlikExpression("Sum({<Year={2025}, Region={'Gulf','Northeast'}, Status-={'Cancelled'}>} [Labor Cost])");
  assert.ok(set.ok);
  if (set.ok) {
    assert.deepEqual(set.filters, [
      { field: 'Year', op: 'in', values: [2025] },
      { field: 'Region', op: 'in', values: ['Gulf', 'Northeast'] },
      { field: 'Status', op: 'not-in', values: ['Cancelled'] },
    ]);
  }
  const range = parseQlikExpression('Avg({$<[Opened Date]={">=2025-01-01"}>} DaysOpen)');
  assert.ok(range.ok && range.filters[0]!.op === 'gte' && range.filters[0]!.values[0] === '2025-01-01');
});

test('expressions it leaves to the AI or the analyst say why', () => {
  const cases: Array<[string, RegExp]> = [
    ['Sum(Cost)/Sum(Hours)', /ratio/],
    ['Sum(Cost * 1.1)', /calculation, not a field/],
    ['Sum({<Year={$(vYear)}>} Cost)', /dollar-sign/],
    ['Aggr(Sum(Cost), Region)', /Not a single/],
    ["Sum({<Region={'G*'}>} Cost)", /Searches/],
    ['Sum({1-$} Cost)', /set operators/],
    ['Avg(DISTINCT Cost)', /DISTINCT is only/],
  ];
  for (const [e, why] of cases) {
    const r = parseQlikExpression(e);
    assert.equal(r.ok, false, e);
    if (!r.ok) assert.match(r.reason, why, e);
  }
});

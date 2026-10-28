// Porting from Qlik (src/core/qlik.ts): load scripts and chart expressions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Catalog } from '../src/core/catalog.ts';
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

test('Qlik names become labels after profiling; the old label stays a synonym', async () => {
  const { loadCatalog } = await import('./fixtures.ts');
  const { applyQlikLabels } = await import('../src/core/qlik.ts');
  const cat = loadCatalog();
  const out = applyQlikLabels(cat, 'maint', 'ops.work_orders', new Map([['labor_cost', 'Labor $'], ['region', 'Fleet Region'], ['nope', 'X']]));
  assert.equal(out.renamed, 2);
  const region = out.catalog.fields.find((f) => f.key === 'jobs.region')!;
  assert.equal(region.label, 'Fleet Region');
  assert.ok(region.synonyms!.includes('region'));
  assert.ok(region.synonyms!.includes('area'), 'existing synonyms are kept');
  assert.equal(out.catalog.fields.find((f) => f.key === 'parts.item')!.label, 'Part', 'other tables untouched');
});

test('chart expressions become measures over catalog fields', async () => {
  const { loadCatalog } = await import('./fixtures.ts');
  const { qlikMeasures } = await import('../src/core/qlik.ts');
  const r = qlikMeasures(
    [
      "Gulf labor: Sum({<Region={'Gulf'}>} [Labor cost])",
      'Count(DISTINCT hull_no)',
      'Count(*)',
      'Sum(Cost)/Sum(Hours)',
      'Sum(Overtime)',
    ].join('\n'),
    loadCatalog(),
  );
  assert.deepEqual(r.metrics.map((m) => [m.label, m.agg, m.field]), [
    ['Gulf labor', 'sum', 'jobs.cost'],
    ['Distinct Hull number', 'count_distinct', 'jobs.hull'],
    ['Count', 'count', undefined],
  ]);
  assert.equal(r.metrics[0]!.key, 'gulf_labor');
  assert.match(r.filterNotes[0]!, /Region in Gulf/);
  assert.deepEqual(r.skipped.map((s) => s.reason.slice(0, 20)), ['A calculation across', 'No field "Overtime" ']);
});

test('a name found in the tables just imported wins; a name in two other tables is not guessed', async () => {
  const { loadCatalog } = await import('./fixtures.ts');
  const { qlikMeasures } = await import('../src/core/qlik.ts');
  const base = loadCatalog();
  const yard = { key: 'work_orders.labor_cost', label: 'Labor Cost', source: 'shipyard', table: 'work_orders', column: 'labor_cost', type: 'number' as const };
  const cat = { ...base, sources: [...base.sources, { id: 'shipyard', label: 'Shipyard', kind: 'access' as const, dialect: 'access' as const }], fields: [...base.fields, yard] };
  const r = qlikMeasures('Gulf labor: Sum([Labor Cost])\nRows: Count(*)', cat, [{ source: 'shipyard', table: 'work_orders' }]);
  assert.deepEqual(r.metrics.map((m) => [m.label, m.field, m.source, m.table]), [
    ['Gulf labor', 'work_orders.labor_cost', 'shipyard', undefined],
    ['Rows', undefined, 'shipyard', 'work_orders'],
  ]);
  const amb = qlikMeasures('Sum([Labor Cost])', cat);
  assert.equal(amb.metrics.length, 0);
  assert.match(amb.skipped[0]!.reason, /more than one table/);
});

test('Qlik part two: mapping loads become cleaning steps, associations become checked relationships', async () => {
  const { qlikCleaningSteps, qlikRelationshipCandidates } = await import('../src/core/qlik.ts');
  const { validateQlikReading } = await import('../src/core/intelligence/tasks.ts');
  const script = parseLoadScript(`LIB CONNECT TO 'Yard';
RegionMap:
MAPPING LOAD * INLINE [
raw, clean
N.E., Northeast
NE, Northeast
];
Jobs:
LOAD wo_id AS [Work Order], ApplyMap('RegionMap', region, region) AS Region, ship_id AS ShipId, labor_hours AS Hours;
SQL SELECT wo_id, region, ship_id, labor_hours FROM yard.jobs;
Ships:
LOAD id AS ShipId, class AS [Ship Class];
SQL SELECT id, class FROM yard.ships;`);
  const catalog: Catalog = {
    version: 1,
    sources: [{ id: 'y', label: 'Yard', kind: 'postgres', dialect: 'postgres' }],
    fields: [
      { key: 'jobs.region', label: 'region', source: 'y', table: 'jobs', column: 'region', type: 'string' },
      { key: 'jobs.ship_id', label: 'ShipId', source: 'y', table: 'jobs', column: 'ship_id', type: 'string' },
      { key: 'jobs.hours', label: 'Hours', source: 'y', table: 'jobs', column: 'labor_hours', type: 'number' },
      { key: 'ships.id', label: 'ShipId', source: 'y', table: 'ships', column: 'id', type: 'string' },
      { key: 'ships.class', label: 'Ship Class', source: 'y', table: 'ships', column: 'class', type: 'string' },
    ],
    metrics: [],
  };
  const imported = [
    { qlik: 'Jobs', source: 'y', table: 'jobs' },
    { qlik: 'Ships', source: 'y', table: 'ships' },
  ];
  const { steps } = qlikCleaningSteps(script, catalog, imported);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.field, 'jobs.region');
  assert.deepEqual(steps[0]!.map, { 'N.E.': 'Northeast', NE: 'Northeast' });
  assert.equal(steps[0]!.origin, 'qlik');
  const pairs = qlikRelationshipCandidates(script, catalog, imported).map((c) => `${c.from.key}>${c.to.key}`);
  assert.deepEqual(pairs.sort(), ['jobs.ship_id>ships.id', 'ships.id>jobs.ship_id']);

  // The AI's reading of an expression is held to the catalog.
  const r = validateQlikReading(
    { measures: [{ label: 'Hours', agg: 'sum', field: 'jobs.hours', filters: [{ field: 'jobs.region', op: 'in', values: ['Gulf'] }] }, { agg: 'sum', field: 'ships.class' }, { agg: 'sum', field: 'made.up' }], explanation: 'Gulf hours.' },
    'Gulf hours',
    "Sum({<Region={'Gulf'}>} Hours)",
    catalog,
  );
  assert.deepEqual(r.metrics.map((m) => [m.label, m.agg, m.field]), [['Hours', 'sum', 'jobs.hours']]);
  assert.match(r.filterNotes[0]!, /region in Gulf/);
  assert.equal(r.rejected.length, 2);
});

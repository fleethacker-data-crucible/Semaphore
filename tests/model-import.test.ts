// Importing a dbt project or a Power BI model (src/core/yaml.ts, dbt.ts, powerbi.ts, model-import.ts,
// model-read.ts), against the fixtures in tests/fixtures/models.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Catalog, checkCatalog } from '../src/core/catalog.ts';
import { readDbt, refName } from '../src/core/dbt.ts';
import { applyModelImport, describeMeasure, type ModelFile, type ModelRead, parseFormula, printFormula } from '../src/core/model-import.ts';
import { readModelFiles, wantedModelFile } from '../src/core/model-read.ts';
import { daxTokens, formatOf, mapDax, mapPowerBi, parseDax, parseTmdl, partitionRelation, PBIX_REFUSAL, readBim, readPowerBi, readTmdl, tmdlColumnRef } from '../src/core/powerbi.ts';
import { proposeCatalog } from '../src/core/profile.ts';
import { parseYaml } from '../src/core/yaml.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'models');

function walk(dir: string, base = dir): ModelFile[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [{ path: path.relative(base, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') }];
  });
}
const dbtFiles = () => walk(path.join(FIXTURES, 'dbt-fleet'));
const tmdlFiles = () => walk(path.join(FIXTURES, 'Fleet.SemanticModel'), FIXTURES);
const bimText = () => readFileSync(path.join(FIXTURES, 'model.bim'), 'utf8');
const doc = (text: string) => {
  const r = parseYaml(text);
  return { value: r.documents[0], warnings: r.warnings, documents: r.documents };
};

// ---------------------------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------------------------

test('yaml: maps, lists of maps, scalars and comments', () => {
  const { value, warnings } = doc(`# a comment
version: 2
name: 'fleet' # trailing comment
ratio: 1.5
count: -3
on: true
off: False
empty:
tilde: ~
hash: "not # a comment"
url: http://example.com/a#b
models:
  - name: orders
    columns:
      - name: id
      - name: total
  - name: hulls
`);
  assert.deepEqual(value, { version: 2, name: 'fleet', ratio: 1.5, count: -3, on: true, off: false, empty: null, tilde: null, hash: 'not # a comment', url: 'http://example.com/a#b', models: [{ name: 'orders', columns: [{ name: 'id' }, { name: 'total' }] }, { name: 'hulls' }] });
  assert.deepEqual(warnings, []);
});

test('yaml: a list at the same indent as its key, nested lists, and "- key:" items', () => {
  const { value } = doc(`metrics:
- name: a
  tags:
  - x
  - y
- - 1
  - 2
-
  name: b
`);
  assert.deepEqual(value, { metrics: [{ name: 'a', tags: ['x', 'y'] }, [1, 2], { name: 'b' }] });
});

test('yaml: literal and folded blocks with chomping', () => {
  const { value } = doc(`keep: |
  line one
    indented
  line three

strip: |-
  no newline
clip: >
  folded
  together

  new paragraph
fstrip: >-
  a
  b
plus: |+
  kept

after: x
`);
  const v = value as Record<string, string>;
  assert.equal(v['keep'], 'line one\n  indented\nline three\n');
  assert.equal(v['strip'], 'no newline');
  assert.equal(v['clip'], 'folded together\nnew paragraph\n');
  assert.equal(v['fstrip'], 'a b');
  assert.equal(v['plus'], 'kept\n\n');
  assert.equal(v['after'], 'x');
});

test('yaml: quoted strings with escapes, quoted keys, and multi-line quoted and plain values', () => {
  const { value } = doc(`"quoted key": "tab\\there \\"q\\" \\u00e9"
'single': 'it''s'
multi: "first
  second"
plain: this runs
  onto the next line
colon: a: b
`);
  assert.deepEqual(value, { 'quoted key': 'tab\there "q" \u00e9', single: "it's", multi: 'first second', plain: 'this runs onto the next line', colon: 'a: b' });
});

test('yaml: flow collections, nested and over several lines', () => {
  const { value, warnings } = doc(`params: {measure: {name: total, filter: "x = 'a, b'"}, list: [1, two, 'three, four']}
grains: [day,
  week, month]
empty: []
pair: [a: 1]
`);
  assert.deepEqual(value, { params: { measure: { name: 'total', filter: "x = 'a, b'" }, list: [1, 'two', 'three, four'] }, grains: ['day', 'week', 'month'], empty: [], pair: [{ a: 1 }] });
  assert.deepEqual(warnings, []);
});

test('yaml: several documents, anchors, aliases, merge keys and tags are warned about', () => {
  const r = parseYaml(`a: 1
---
base: &base
  x: 1
copy:
  <<: *base
  y: !!str 2
alias: *base
`);
  assert.equal(r.documents.length, 2);
  assert.deepEqual(r.documents[0], { a: 1 });
  const second = r.documents[1] as Record<string, unknown>;
  assert.deepEqual(second['base'], { x: 1 }, 'an anchored value is read as written');
  assert.equal(second['alias'], null, 'an alias is not resolved');
  assert.deepEqual(second['copy'], { y: 2 });
  assert.ok(r.warnings.some((w) => /anchors/.test(w)));
  assert.ok(r.warnings.some((w) => /aliases/.test(w)));
  assert.ok(r.warnings.some((w) => /merge keys/.test(w)));
  assert.ok(r.warnings.some((w) => /tags/.test(w)));
});

test('yaml: tabs, duplicate keys, bad indentation and deep nesting are warnings, never exceptions', () => {
  const tabs = parseYaml('a:\n\tb: 1\n');
  assert.ok(tabs.warnings.some((w) => /tabs/.test(w)));
  const dup = parseYaml('a: 1\na: 2\n');
  assert.deepEqual(dup.documents[0], { a: 2 });
  assert.ok(dup.warnings.some((w) => /twice/.test(w)));
  const bad = parseYaml('a:\n    b: 1\n  c: 2\n');
  assert.ok(bad.warnings.some((w) => /indentation/.test(w)));
  const deep = parseYaml('x: ' + '['.repeat(200) + ']'.repeat(200));
  assert.ok(deep.warnings.some((w) => /nested too deeply/.test(w)));
  const proto = parseYaml('__proto__: {polluted: true}\n');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'a __proto__ key is an own property, not the prototype');
  assert.deepEqual(Object.keys(proto.documents[0] as object), ['__proto__']);
  assert.deepEqual(parseYaml('').documents, []);
  assert.deepEqual(parseYaml('# only a comment\n').documents, []);
});

// ---------------------------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------------------------

test('formulas: the calculated-measure grammar, printed with only the parentheses it needs', () => {
  const f = parseFormula('(revenue - cost) / revenue * 100');
  assert.ok(f.ok);
  assert.equal(printFormula(f.formula), '(revenue - cost) / revenue * 100');
  const g = parseFormula('a - (b - c) + -(d / (e / f))');
  assert.ok(g.ok);
  assert.equal(printFormula(g.formula), 'a - (b - c) + -(d / (e / f))');
  const k = parseFormula('a / b', (w) => `${w}_key`);
  assert.ok(k.ok);
  assert.equal(printFormula(k.formula, (r) => r.toUpperCase()), 'A_KEY / B_KEY');
  assert.deepEqual(parseFormula('round(a, 0)'), { ok: false, reason: 'Uses the function round(), which a calculated measure cannot' });
  assert.equal((parseFormula('a / (b') as { reason: string }).reason, 'Unbalanced parentheses');
  assert.equal((parseFormula('a > b') as { reason: string }).reason, '">" is not part of a calculated measure (only + - * /, parentheses, numbers and measures)');
  assert.equal((parseFormula('a + zz', (w) => (w === 'a' ? w : null)) as { reason: string }).reason, '"zz" is not a measure in this model');
});

// ---------------------------------------------------------------------------------------------
// dbt
// ---------------------------------------------------------------------------------------------

test('dbt: ref() and source() names', () => {
  assert.equal(refName("ref('orders')"), 'orders');
  assert.equal(refName('{{ ref("orders") }}'), 'orders');
  assert.equal(refName("ref('pkg', 'orders')"), 'orders');
  assert.equal(refName("ref('orders', v=2)"), 'orders');
  assert.equal(refName("source('raw', 'orders')"), 'raw.orders');
  assert.equal(refName('{{ var("x") }}'), undefined);
});

test('dbt: the project name, the files read, and profiles.yml and target/ never read', () => {
  const read = readDbt(dbtFiles());
  assert.equal(read.tool, 'dbt');
  assert.equal(read.name, 'fleet_maintenance');
  assert.deepEqual(read.files.sort(), ['dbt_project.yml', 'models/legacy/legacy_metrics.yml', 'models/marts/_marts.yml']);
  assert.equal(wantedModelFile('profiles.yml'), false);
  assert.equal(wantedModelFile('config/profiles.yaml'), false);
  assert.equal(wantedModelFile('target/manifest.yml'), false, 'what dbt writes into target/ is not the project');
  assert.equal(read.tables.some((t) => t.name === 'should_not_be_read'), false);
  assert.ok(!JSON.stringify(read).includes('not-a-real-secret'));
});

test('dbt: semantic models become tables with their dimensions, time grains and entities', () => {
  const read = readDbt(dbtFiles());
  assert.deepEqual(read.tables.map((t) => [t.name, t.relation]), [['work_orders', 'work_orders'], ['hulls', 'hulls']], 'dim_hulls has alias hulls');
  const wo = read.tables[0]!;
  assert.match(wo.description ?? '', /Work orders as the maintenance office counts them/);
  const col = (n: string) => wo.columns.find((c) => c.name === n);
  assert.deepEqual(col('opened_on'), { name: 'opened_on', column: 'opened_on', label: 'Opened date', type: 'date', grain: 'day' });
  assert.equal(col('work_status')?.column, 'status');
  assert.equal(col('work_status')?.type, 'string', 'data_type from the model YAML');
  assert.equal(col('work_order')?.column, 'wo_id');
  assert.equal(col('labor_cost')?.type, 'number', 'measure columns are columns too');
  assert.equal(col('is_big_job'), undefined);
  assert.deepEqual(read.relationships, [{ from: { table: 'work_orders', column: 'hull_no' }, to: { table: 'hulls', column: 'hull_no' } }]);
  const hulls = read.tables[1]!;
  assert.deepEqual(hulls.columns.map((c) => c.column), ['hull_no', 'ship_class', 'home_yard', 'commissioned_on'], 'legacy metric dimensions and timestamp join the same table');
  assert.equal(hulls.columns.find((c) => c.column === 'commissioned_on')?.grain, 'month');
});

test('dbt: simple metrics, measures, ratio and derived metrics, legacy metrics', () => {
  const read = readDbt(dbtFiles());
  const byName = new Map(read.measures.map((m) => [m.name, m]));
  assert.deepEqual(
    read.measures.map((m) => [m.name, m.label, describeMeasure(m)]),
    [
      ['hull_count', 'Hulls in service', 'distinct count of hulls.hull_no'],
      ['legacy_parts', 'Parts spend (legacy)', 'sum of work_orders.parts_cost'],
      ['labor', 'Labor cost', 'sum of work_orders.labor_cost'],
      ['parts', 'Parts cost', 'sum of work_orders.parts_cost'],
      ['work_orders', 'Work orders', 'count of work_orders rows'],
      ['hulls_affected', 'Hulls affected', 'distinct count of work_orders.hull_no'],
      ['avg_labor', 'Avg labor', 'average of work_orders.labor_cost'],
      ['parts_per_hull', 'Parts per hull', 'calculated: legacy_parts / hull_count'],
      ['cost_per_order', 'Cost per work order', 'calculated: labor / work_orders'],
      ['total_cost', 'Total cost', 'calculated: labor + parts'],
      ['parts_share', 'Parts share', 'calculated: parts / (labor + parts)'],
    ],
  );
  assert.equal(byName.get('labor')?.description, 'Total labour cost.');
  assert.equal(byName.get('labor_cost'), undefined, 'a measure a simple metric exposes is not added twice');
});

test('dbt: what cannot be expressed is a warning with the original definition', () => {
  const w = readDbt(dbtFiles()).warnings.join('\n');
  for (const [re, why] of [
    [/is_big_job is calculated \(case when labor_cost > 10000/, 'SQL dimension'],
    [/Median labor: Semaphore has no median measure yet \(work_orders: median\(labor_cost\)\)/, 'median'],
    [/Big jobs: sum_boolean/, 'sum_boolean'],
    [/Weighted cost: it aggregates a SQL expression.*sum\(labor_cost \* 1\.1\)/, 'expression measure'],
    [/Labor growth: labor is offset in time \(1 month\)/, 'offset_window'],
    [/Open labor: it has a filter .*Dimension\('work_order__work_status'\)/, 'metric filter'],
    [/Cumulative labor: cumulative metrics/, 'cumulative'],
    [/Rounded cost: Uses the function round\(\).*\(round\(labor, 0\)\)/, 'derived with a function'],
    [/Gulf parts: it has filters \(region = 'Gulf'\)/, 'legacy filter'],
    [/P90 labor: the calculation method "percentile"/, 'legacy percentile'],
  ] as const) assert.match(w, re, why);
});

test('dbt: Jinja in a measure is not guessed, and a project with only model YAML lists its models', () => {
  const read = readDbt([{ path: 'models/x.yml', text: `semantic_models:
  - name: s
    model: ref('s')
    measures:
      - name: m
        agg: sum
        expr: "{{ cents_to_dollars('amount') }}"
` }]);
  assert.equal(read.measures.length, 0);
  assert.match(read.warnings.join('\n'), /uses Jinja/);
  const only = readDbt([{ path: 'models/y.yml', text: 'models:\n  - name: orders\n    columns:\n      - name: id\n        data_type: bigint\n' }]);
  assert.deepEqual(only.tables, [{ name: 'orders', relation: 'orders', columns: [{ name: 'id', column: 'id', type: 'number' }] }]);
  assert.match(only.warnings.join('\n'), /No semantic models or metrics/);
});

// ---------------------------------------------------------------------------------------------
// DAX
// ---------------------------------------------------------------------------------------------

const ctx = { measures: new Set(['Labor', 'Parts', 'Orders']), columns: new Map([['Work Orders', new Set(['Cost', 'Hull', 'Opened'])], ['Hulls', new Set(['Class'])]]) };

test('dax: tokens and parsing, comments and quoted names', () => {
  const t = daxTokens(`SUM('Work Orders'[Cost]) // labour\n-- and\n/* more */ + [Labor]`);
  assert.ok(Array.isArray(t));
  assert.deepEqual(t.map((x) => x.k), ['id', 'op', 'tab', 'col', 'op', 'op', 'col']);
  assert.deepEqual(parseDax("'It''s'[A]]B]"), { t: 'col', table: "It's", col: 'A]B' });
  assert.equal(parseDax('VAR x = 1 RETURN x'), 'Uses VAR.');
  assert.equal(parseDax('SUM(A[b]'), 'Unbalanced parentheses.');
  assert.equal(parseDax('{1, 2}'), 'Uses a table constructor { }.');
});

test('dax: single aggregates map to measures', () => {
  assert.deepEqual(mapDax("SUM('Work Orders'[Cost])", ctx), { ok: true, agg: { agg: 'sum', table: 'Work Orders', column: 'Cost' } });
  assert.deepEqual(mapDax("averagE('Work Orders'[Cost])", ctx), { ok: true, agg: { agg: 'avg', table: 'Work Orders', column: 'Cost' } });
  assert.deepEqual(mapDax("COUNTROWS('Work Orders')", ctx), { ok: true, agg: { agg: 'count', table: 'Work Orders' } });
  assert.deepEqual(mapDax("COUNTA('Work Orders'[Hull])", ctx), { ok: true, agg: { agg: 'count', table: 'Work Orders', column: 'Hull' } });
  assert.deepEqual(mapDax('DISTINCTCOUNT(Hulls[Class])', ctx), { ok: true, agg: { agg: 'count_distinct', table: 'Hulls', column: 'Class' } });
  assert.deepEqual(mapDax("CALCULATE(MAX('Work Orders'[Cost]))", ctx), { ok: true, agg: { agg: 'max', table: 'Work Orders', column: 'Cost' } }, 'CALCULATE with no filter is the expression itself');
});

test('dax: DIVIDE and arithmetic over measures and inline aggregates map to formulas', () => {
  const show = (dax: string) => {
    const r = mapDax(dax, ctx);
    assert.ok(r.ok && 'formula' in r, dax);
    return [printFormula(r.formula), r.parts.map((p) => `${p.ref}=${p.agg}:${p.table}.${p.column ?? '*'}`)];
  };
  assert.deepEqual(show('DIVIDE([Labor], [Orders])'), ['Labor / Orders', []]);
  assert.deepEqual(show('DIVIDE([Labor], [Orders], BLANK())'), ['Labor / Orders', []]);
  assert.deepEqual(show('([Labor] - [Parts]) * 100 / [Labor]'), ['(Labor - Parts) * 100 / Labor', []]);
  assert.deepEqual(show("'Work Orders'[Labor] + -[Parts]"), ['Labor + -Parts', []], 'a table-qualified measure reference');
  assert.deepEqual(show("DIVIDE(SUM('Work Orders'[Cost]), COUNTROWS('Work Orders'))"), ['part_1 / part_2', ['part_1=sum:Work Orders.Cost', 'part_2=count:Work Orders.*']]);
});

test('dax: filters, time intelligence and anything else are reasons, never guesses', () => {
  const why = (dax: string) => {
    const r = mapDax(dax, ctx);
    assert.equal(r.ok, false, dax);
    return (r as { reason: string }).reason;
  };
  assert.match(why("CALCULATE([Labor], Hulls[Class] = \"Arleigh\")"), /CALCULATE with filters \(Hulls\[Class\] = "Arleigh"\)/);
  assert.match(why("TOTALYTD([Labor], 'Work Orders'[Opened])"), /time intelligence.*comparisons \(previous period, previous year\)/);
  assert.match(why("CALCULATE([Labor], SAMEPERIODLASTYEAR('Work Orders'[Opened]))"), /time intelligence/);
  assert.match(why("CALCULATE([Labor], DATEADD('Work Orders'[Opened], -1, MONTH))"), /time intelligence/);
  assert.match(why('DIVIDE([Labor], [Orders], 0)'), /alternate result \(0\)/);
  assert.match(why("SUMX('Work Orders', 'Work Orders'[Cost] * 2)"), /SUMX\(\) is not something Semaphore reads/);
  assert.match(why("'Work Orders'[Cost]"), /column without an aggregate/);
  assert.match(why("SUM('Work Orders'[Nope])"), /not a column in this model/);
  assert.match(why("MAX('Work Orders'[Cost], 5)"), /2 arguments/);
  assert.match(why('IF([Labor] > 0, 1, 0)'), /IF\(\) is not something/);
  assert.match(why('[Labor] & "x"'), /operator &/);
  assert.match(why('[Unknown]'), /column without an aggregate/);
});

test('power bi: format strings and partition sources', () => {
  assert.equal(formatOf('\\$#,0.00;(\\$#,0.00)'), 'currency');
  assert.equal(formatOf('[$€-2] #,0'), 'currency');
  assert.equal(formatOf('0.0%'), 'percent');
  assert.equal(formatOf('#,0'), 'number');
  assert.equal(formatOf(undefined), undefined);
  assert.deepEqual(partitionRelation({ kind: 'm', source: 'let\n  Source = Sql.Database("srv", "db"),\n  t = Source{[Schema="dbo",Item="orders"]}[Data]\nin t' }), { relation: 'dbo.orders', connection: 'srv/db' });
  assert.deepEqual(partitionRelation({ kind: 'm', source: 'Value.NativeQuery(Sql.Database("srv","db"), "select 1")' }), { connection: 'srv/db', note: 'it reads a native SQL query, not a table' });
  assert.deepEqual(partitionRelation({ kind: 'query', source: 'SELECT * FROM [ops].[hulls]' }), { relation: 'ops.hulls' });
  assert.deepEqual(partitionRelation({ kind: 'entity', source: '', entity: 'orders', schema: 'gold' }), { relation: 'gold.orders' });
});

// ---------------------------------------------------------------------------------------------
// TMDL and .bim
// ---------------------------------------------------------------------------------------------

test('tmdl: objects, properties, multi-line expressions, descriptions and column references', () => {
  const p = parseTmdl("/// A table.\ntable 'My T'\n\tisHidden\n\tmeasure M =\n\t\t\tSUM(\n\t\t\t  'My T'[x])\n\t\tformatString: 0\n\tmeasure N = ```\n\t\tDIVIDE(\n\t\t  [M], 2)\n\t\t```\n\tcolumn x\n\t\tdataType: int64\n");
  const t = p.nodes[0]!;
  assert.equal(t.kind, 'table');
  assert.equal(t.name, 'My T');
  assert.equal(t.description, 'A table.');
  assert.equal(t.props['isHidden'], 'true');
  assert.deepEqual(t.children.map((c) => [c.kind, c.name, c.expr ?? null]), [['measure', 'M', "SUM(\n  'My T'[x])"], ['measure', 'N', 'DIVIDE(\n  [M], 2)'], ['column', 'x', null]]);
  assert.equal(t.children[0]!.props['formatString'], '0');
  assert.equal(t.children[2]!.props['dataType'], 'int64');
  assert.deepEqual(tmdlColumnRef("'Work Orders'.Hull"), ['Work Orders', 'Hull']);
  assert.deepEqual(tmdlColumnRef("Hulls.'Hull No'"), ['Hulls', 'Hull No']);
  assert.equal(tmdlColumnRef('nodot'), null);
});

test('power bi (TMDL project): tables, measures, a relationship, a hierarchy and warnings', () => {
  const read = readPowerBi(tmdlFiles());
  assert.equal(read.tool, 'powerbi');
  assert.equal(read.name, 'Fleet');
  assert.equal(read.files.length, 5);
  assert.deepEqual(read.tables.map((t) => [t.name, t.relation, t.connection]), [['Hulls', 'ops.hulls', 'fleet-sql01/Maintenance'], ['Work Orders', 'ops.work_orders', 'fleet-sql01/Maintenance']]);
  const wo = read.tables[1]!;
  assert.deepEqual(wo.columns.find((c) => c.name === 'Opened'), { name: 'Opened', column: 'opened_on', label: 'Opened', type: 'date' });
  assert.equal(wo.columns.find((c) => c.name === 'Labor')?.folder, 'Costs');
  assert.equal(wo.description, 'One row per work order raised against a hull.');
  assert.deepEqual(
    read.measures.map((m) => [m.name, describeMeasure(m), m.format ?? '']),
    [
      ['Labor Cost', 'sum of Work Orders.Labor', 'currency'],
      ['Parts Cost', 'sum of Work Orders.parts_cost', 'currency'],
      ['Work Orders', 'count of Work Orders rows', 'number'],
      ['Hulls Affected', 'distinct count of Work Orders.Hull', ''],
      ['Cost per Order', 'calculated: Labor Cost / Work Orders', 'currency'],
      ['Total Cost', 'calculated: Labor Cost + Parts Cost', 'currency'],
      ['Parts Share', 'calculated: Parts Cost / (Labor Cost + Parts Cost)', 'percent'],
    ],
    'inline SUMs that equal a plain measure reuse it',
  );
  assert.equal(read.measures[0]!.description, 'Labour cost in dollars.');
  assert.equal(read.relationships.length, 1);
  assert.deepEqual(read.relationships[0]!.from, { table: 'Work Orders', column: 'Hull' });
  assert.deepEqual(read.relationships[0]!.to, { table: 'Hulls', column: 'Hull No' });
  assert.match(read.relationships[0]!.note ?? '', /filters both ways/);
  assert.deepEqual(read.hierarchies, [{ label: 'Fleet', table: 'Hulls', levels: ['Ship Class', 'Hull No'] }]);
  const w = read.warnings.join('\n');
  for (const re of [/Big Job\]: a calculated column/, /1 automatic date table/, /Gulf Labor: CALCULATE with filters.*DAX: CALCULATE\(\[Labor Cost\], 'Work Orders'\[Region\] = "Gulf"\)/, /Labor YTD: time intelligence.*DAX: TOTALYTD/, /Labor LY: time intelligence/, /Weighted Labor: SUMX\(\)/, /Safe Ratio: DIVIDE with an alternate result \(0\)/, /inactive in Power BI/, /Display folders \(Costs\)/]) assert.match(w, re);
});

test('power bi (.bim): the same model as Tabular JSON, with many-to-many, VAR and a calculated table', () => {
  const model = readBim(bimText(), 'model.bim');
  assert.equal(model.name, 'Fleet Maintenance');
  assert.equal(model.tables.length, 3);
  const read = mapPowerBi(model);
  assert.deepEqual(read.tables.map((t) => [t.name, t.relation]), [['Work Orders', 'ops.work_orders'], ['Hulls', 'ops.hulls']]);
  assert.deepEqual(read.tables[0]!.columns.map((c) => `${c.name}:${c.column}:${c.type}`), ['Work Order:wo_id:number', 'Hull:hull_no:string', 'Region:region:string', 'Opened:opened_on:date', 'Labor:labor_cost:number', 'Parts:parts_cost:number']);
  assert.deepEqual(
    read.measures.map((m) => [m.name, describeMeasure(m)]),
    [
      ['Labor Cost', 'sum of Work Orders.Labor'],
      ['Parts Cost', 'sum of Work Orders.Parts'],
      ['Orders', 'count of Work Orders rows'],
      ['Average Labor', 'average of Work Orders.Labor'],
      ['Largest Job', 'maximum of Work Orders.Labor'],
      ['Cost per Order', 'calculated: (Labor Cost + Parts Cost) / Orders'],
      ['Labor Margin', 'calculated: (Labor Cost - Parts Cost) / Labor Cost'],
    ],
  );
  assert.deepEqual(read.hierarchies, [{ label: 'Yard drill', table: 'Hulls', levels: ['Home Yard', 'Ship Class', 'Hull No'] }], 'levels in ordinal order');
  assert.deepEqual(read.relationships.map((r) => `${r.from.table}.${r.from.column}->${r.to.table}.${r.to.column}`), ['Work Orders.Hull->Hulls.Hull No']);
  const w = read.warnings.join('\n');
  for (const re of [/Loaded Labor\]: a calculated column/, /Region Targets: a calculated table/, /Gulf Labor: CALCULATE with filters/, /Labor Last Year: time intelligence/, /Rank: RANKX\(\)/, /Spread: the DAX could not be read: Uses VAR\. DAX: VAR hi/]) assert.match(w, re);
  assert.equal(readBim('{not json').warnings.length, 1);
  assert.match(readBim('{"x": 1}').warnings[0]!, /no "model"/);
});

test('power bi: a relationship with the one side first is turned round; one-to-one is noted', () => {
  const read = mapPowerBi({
    name: 'm',
    warnings: [],
    tables: [
      { name: 'A', columns: [{ name: 'k', sourceColumn: 'k' }], measures: [], hierarchies: [], partitions: [] },
      { name: 'B', columns: [{ name: 'k', sourceColumn: 'k' }], measures: [], hierarchies: [], partitions: [] },
    ],
    relationships: [
      { fromTable: 'A', fromColumn: 'k', toTable: 'B', toColumn: 'k', fromCardinality: 'one', toCardinality: 'many' },
      { fromTable: 'B', fromColumn: 'k', toTable: 'A', toColumn: 'k', fromCardinality: 'one', toCardinality: 'one' },
    ],
  });
  assert.deepEqual(read.relationships[0], { from: { table: 'B', column: 'k' }, to: { table: 'A', column: 'k' } });
  assert.match(read.relationships[1]!.note ?? '', /one to one/);
});

test('a .pbix is refused with what to do instead, and the reader follows what the files are', () => {
  const r = readModelFiles('powerbi', [], ['Reports/Fleet.pbix']);
  assert.equal(r.refused, `Fleet.pbix: ${PBIX_REFUSAL}`);
  assert.match(PBIX_REFUSAL, /Power BI Project \(\.pbip\)/);
  assert.match(PBIX_REFUSAL, /Tabular Editor/);
  assert.equal(readModelFiles('dbt', [], ['x.pbit']).refused?.startsWith('x.pbit'), true);
  const both = readModelFiles('powerbi', [{ path: 'model.bim', text: bimText() }], ['model.bim', 'Fleet.pbix']);
  assert.equal(both.refused, undefined);
  assert.match(both.warnings[0]!, /Fleet\.pbix was left unread/);
  const switched = readModelFiles('powerbi', dbtFiles());
  assert.equal(switched.tool, 'dbt');
  assert.equal(switched.switched, true);
  assert.equal(readTmdl([]).tables.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Into the catalog
// ---------------------------------------------------------------------------------------------

/** A catalog in which work_orders and hulls were just profiled from source "wh". */
function profiled(): Catalog {
  const base: Catalog = { version: 1, sources: [], fields: [], metrics: [] };
  return proposeCatalog(
    {
      source: { id: 'wh', label: 'Warehouse', kind: 'postgres', dialect: 'postgres' },
      tables: [
        { name: 'work_orders', rows: 10, columns: [{ name: 'wo_id', type: 'number' }, { name: 'hull_no', type: 'string', distinct: 4 }, { name: 'region', type: 'string', distinct: 3 }, { name: 'opened_on', type: 'string' }, { name: 'labor_cost', type: 'number' }, { name: 'parts_cost', type: 'number' }, { name: 'status', type: 'string', distinct: 2 }] },
        { name: 'hulls', rows: 4, columns: [{ name: 'hull_no', type: 'string', distinct: 4 }, { name: 'ship_class', type: 'string', distinct: 2 }, { name: 'home_yard', type: 'string', distinct: 2 }] },
      ],
    },
    base,
  ).catalog;
}

test('apply (dbt): labels, measures, calculated measures over catalog keys, links and notes', () => {
  const read = readDbt(dbtFiles());
  const before = profiled();
  const r = applyModelImport(before, read, [{ model: 'work_orders', source: 'wh', table: 'work_orders' }, { model: 'hulls', source: 'wh', table: 'hulls' }]);
  const cat = r.catalog;
  assert.deepEqual(checkCatalog(cat), []);
  const field = (k: string) => cat.fields.find((f) => f.key === k)!;
  const status = cat.fields.find((f) => f.table === 'work_orders' && f.column === 'status')!;
  assert.equal(status.label, 'Work status');
  assert.ok(status.synonyms?.includes('work_status'));
  const metric = (label: string) => cat.metrics.find((m) => m.label === label)!;
  assert.equal(metric('Labor cost').agg, 'sum');
  assert.equal(field(metric('Labor cost').field!).column, 'labor_cost');
  assert.deepEqual([metric('Work orders').agg, metric('Work orders').table, metric('Work orders').field], ['count', 'work_orders', undefined]);
  const cpo = metric('Cost per work order');
  assert.deepEqual([cpo.agg, cpo.formula, cpo.source], ['formula', `${metric('Labor cost').key} / ${metric('Work orders').key}`, 'wh']);
  assert.equal(metric('Parts share').formula, `${metric('Parts cost').key} / (${metric('Labor cost').key} + ${metric('Parts cost').key})`);
  assert.equal(metric('Parts per hull').formula, `${metric('Parts spend (legacy)').key} / ${metric('Hulls in service').key}`);
  assert.equal(r.added.formulas, 4);
  assert.equal(r.added.metrics, 4, 'labor, parts and work orders match the measures profiling proposed, and are used as they are');
  assert.equal(metric('Labor cost').key, 'labor_cost');
  assert.deepEqual(cat.relationships, [{ id: 'rel-work-orders-hull-no-hulls', source: 'wh', from: { table: 'work_orders', column: 'hull_no' }, to: { table: 'hulls', column: 'hull_no' }, origin: 'dbt' }]);
  const lines = r.lines.join('\n');
  assert.match(lines, /^4 measures and 4 calculated measures added from the dbt project; 3 measures it defines were already in the catalog and are used as they are\./);
  assert.match(lines, /work_orders\.opened_on: the dbt project has it as a date, the database reads a string/);
  assert.match(lines, /hulls: 1 column the model names is not in hulls \(commissioned_on\)/);
  assert.match(lines, /Linked work_orders to hulls/);
  // Importing again adds nothing new.
  const again = applyModelImport(cat, read, [{ model: 'work_orders', source: 'wh', table: 'work_orders' }, { model: 'hulls', source: 'wh', table: 'hulls' }]);
  assert.equal(again.catalog.metrics.length, cat.metrics.length);
  assert.equal(again.catalog.relationships?.length, 1);
});

test('apply (Power BI): only the placed tables, a drill path, and measures that need a missing table are lines', () => {
  const read = mapPowerBi(readBim(bimText()));
  const cat0 = profiled();
  const only = applyModelImport(cat0, read, [{ model: 'Work Orders', source: 'wh', table: 'work_orders' }]);
  assert.deepEqual(checkCatalog(only.catalog), []);
  assert.equal(only.catalog.relationships, undefined, 'the link needs both tables');
  assert.equal(only.catalog.hierarchies, undefined);
  const both = applyModelImport(cat0, read, [{ model: 'Work Orders', source: 'wh', table: 'work_orders' }, { model: 'Hulls', source: 'wh', table: 'hulls' }]);
  const cat = both.catalog;
  assert.deepEqual(checkCatalog(cat), []);
  const hull = cat.fields.find((f) => f.table === 'work_orders' && f.column === 'hull_no')!;
  assert.equal(hull.label, 'Hull');
  const margin = cat.metrics.find((m) => m.label === 'Labor Margin')!;
  const key = (label: string) => cat.metrics.find((m) => m.label.toLowerCase() === label.toLowerCase())!.key;
  assert.equal(margin.formula, '(labor_cost - parts_cost) / labor_cost', 'Labor Cost and Parts Cost are the measures profiling proposed');
  assert.equal(margin.format, 'percent');
  assert.equal(cat.metrics.find((m) => m.key === 'labor_cost')!.format, 'currency', 'the model gives the measure it shares its format');
  assert.equal(cat.metrics.find((m) => m.label === 'Cost per Order')!.formula, `(labor_cost + parts_cost) / ${key('Orders')}`);
  assert.ok(!both.lines.some((l) => /Work Order: the Power BI model has it as a number/.test(l)), 'an identifier profiled as text is not reported');
  assert.deepEqual(cat.hierarchies, [{ id: 'powerbi-hulls-yard-drill', label: 'Yard drill', levels: ['hulls.home_yard', 'hulls.ship_class', 'hulls.hull_no'].map((k) => cat.fields.find((f) => `${f.table}.${f.column}` === k)!.key) }]);
  assert.equal(cat.relationships?.[0]?.origin, 'powerbi');
  assert.match(both.lines.join('\n'), /Opened: the Power BI model has it as a date, the database reads a string/);
  // A different source for each table: no link, and a calculated measure over both is refused.
  const split: ModelRead = { ...read, measures: [...read.measures, { kind: 'formula', name: 'Mixed', label: 'Mixed', formula: { op: '/', a: { ref: 'Labor Cost' }, b: { ref: 'Missing' } }, expression: '[Labor Cost] / [Missing]' }] };
  const lines = applyModelImport(cat0, split, [{ model: 'Work Orders', source: 'wh', table: 'work_orders' }]).lines.join('\n');
  assert.match(lines, /Not added, Mixed: it needs Missing, which was not added \(\[Labor Cost\] \/ \[Missing\]\)/);
});

test('checkCatalog accepts a calculated measure with a formula and refuses one without', () => {
  const cat = profiled();
  const ok: Catalog = { ...cat, metrics: [...cat.metrics, { key: 'ratio', label: 'Ratio', agg: 'formula', formula: 'labor_cost / work_orders_count', source: 'wh' }] };
  assert.deepEqual(checkCatalog(ok), []);
  const bad: Catalog = { ...cat, metrics: [...cat.metrics, { key: 'ratio', label: 'Ratio', agg: 'formula', source: 'wh' }] };
  assert.deepEqual(checkCatalog(bad), ['Metric "ratio" is calculated but has no formula.']);
});

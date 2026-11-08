// Flag kits that carry calculated measures (src/core/kits.ts): a flag on a formula keeps the
// formula's definition, and flying the kit onto another catalog matches each input like any metric,
// then reuses an identical formula there or makes the measure again over the matched keys.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, checkCatalog, type Field, indexCatalog, type Metric } from '../src/core/catalog.ts';
import { applySelections } from '../src/core/crossfilter.ts';
import { runPlan } from '../src/core/engine.ts';
import { type Flag, type Hoist, parseHoist } from '../src/core/hoist.ts';
import { applyKit, exportKit, type Kit, makeKit, parseKit, parseKitText } from '../src/core/kits.ts';
import { planFlag } from '../src/core/planner.ts';

const now = new Date('2026-11-08T12:00:00Z');

function field(source: string, key: string, label: string, type: Field['type'], synonyms?: string[]): Field {
  const [table = 't', column = key] = key.split('.');
  return { key, label, source, table, column, type, ...(synonyms ? { synonyms } : {}) };
}

/** Where the kit is saved: three plain measures and formulas over them, one built on another. */
function maint(): Catalog {
  const c: Catalog = {
    version: 1,
    sources: [{ id: 'maint', label: 'Maintenance', kind: 'csv', dialect: 'ansi' }],
    fields: [field('maint', 'jobs.cost', 'Cost', 'number'), field('maint', 'jobs.hull', 'Hull', 'string'), field('maint', 'jobs.region', 'Region', 'string')],
    metrics: [
      { key: 'labor_cost', label: 'Labor cost', agg: 'sum', field: 'jobs.cost', source: 'maint', format: 'currency', synonyms: ['spend'] },
      { key: 'hulls', label: 'Hulls affected', agg: 'count_distinct', field: 'jobs.hull', source: 'maint' },
      { key: 'work_orders', label: 'Work orders', agg: 'count', table: 'jobs', source: 'maint' },
      { key: 'cost_per_hull', label: 'Cost per hull', agg: 'formula', formula: 'labor_cost / hulls', source: 'maint', format: 'currency', synonyms: ['hull cost'] },
      { key: 'per_hull_order', label: 'Cost per hull per order', agg: 'formula', formula: '(cost_per_hull) / work_orders', source: 'maint', format: 'currency' },
    ],
  };
  assert.deepEqual(checkCatalog(c), []);
  return c;
}

function flagOf(id: string, kind: Flag['kind'], title: string, metrics: string[], dims: string[] = [], status: Flag['status'] = 'ready'): Flag {
  return {
    id,
    kind,
    title,
    brief: `${title}.`,
    layout: { x: 0, y: id === 'a' ? 0 : id === 'b' ? 3 : 6, w: 4, h: 3 },
    binding: { metrics, dimensions: dims.map((field) => ({ field })), filters: [] },
    behavior: { onClick: 'none', ignore: [], thresholds: [] },
    status,
    notes: [],
  };
}

const source: Hoist = {
  version: 1,
  id: 'maint-page',
  title: 'Maintenance',
  brief: '',
  grid: { cols: 12 },
  filters: [],
  flags: [flagOf('a', 'kpi', 'Cost per hull', ['cost_per_hull']), flagOf('b', 'bar', 'Per hull per order by region', ['per_hull_order'], ['jobs.region']), flagOf('c', 'kpi', 'Labor cost', ['labor_cost'])],
  updated: now.toISOString(),
};

function blank(): Hoist {
  return { version: 1, id: 'target', title: 'Target', brief: '', grid: { cols: 12 }, filters: [], flags: [], updated: now.toISOString() };
}

/** Another team's catalog: every key renamed; the inputs are found by label or synonym. */
function yard(patch: (c: Catalog) => void = () => undefined): Catalog {
  const c: Catalog = {
    version: 1,
    sources: [
      { id: 'yard', label: 'Ship yard', kind: 'csv', dialect: 'ansi' },
      { id: 'hr', label: 'People', kind: 'csv', dialect: 'ansi' },
    ],
    fields: [field('yard', 'tickets.spend', 'Spend', 'number'), field('yard', 'tickets.hull_no', 'Hull number', 'string'), field('yard', 'tickets.area', 'Region', 'string'), field('hr', 'crew.hull', 'Hull', 'string')],
    metrics: [
      { key: 'spend_total', label: 'Labor cost', agg: 'sum', field: 'tickets.spend', source: 'yard', format: 'currency' },
      { key: 'ships', label: 'Ships', agg: 'count_distinct', field: 'tickets.hull_no', source: 'yard', synonyms: ['hulls'] },
      { key: 'tickets_total', label: 'Work orders', agg: 'count', table: 'tickets', source: 'yard' },
    ],
  };
  patch(c);
  assert.deepEqual(checkCatalog(c), []);
  return c;
}

function kitOf(): Kit {
  const { kit, warnings } = makeKit(source, indexCatalog(maint()), { name: 'Hull costs', now });
  assert.ok(kit, warnings.join(' '));
  assert.deepEqual(warnings, []);
  return kit;
}

/** The catalog after the kit's measures are added, checked, and the hoist checked against it. */
function landed(target: Catalog, r: ReturnType<typeof applyKit>): Catalog {
  assert.ok(r.report.applied, r.report.problems.join(' '));
  const next: Catalog = { ...target, metrics: [...target.metrics, ...r.metrics] };
  assert.deepEqual(checkCatalog(next), []);
  const again = parseHoist(JSON.parse(JSON.stringify(r.hoist)), indexCatalog(next));
  assert.ok(again.hoist);
  assert.deepEqual(again.warnings, []);
  const keys = new Set(next.metrics.map((m) => m.key));
  for (const f of r.hoist.flags) for (const m of f.binding?.metrics ?? []) assert.ok(keys.has(m), m);
  return next;
}

test('saving a kit carries each formula it uses, nested ones too, with inputs described like metrics', () => {
  const kit = kitOf();
  assert.equal(kit.version, 1);
  assert.deepEqual(
    kit.formulas?.map((f) => [f.key, f.label, f.format, f.formula, f.inputs.map((i) => `${i.key}:${i.agg}`)]),
    [
      ['cost_per_hull', 'Cost per hull', 'currency', 'labor_cost / hulls', ['labor_cost:sum', 'hulls:count_distinct']],
      ['per_hull_order', 'Cost per hull per order', 'currency', 'cost_per_hull / work_orders', ['cost_per_hull:formula', 'work_orders:count']],
    ],
  );
  const cost = kit.formulas![0]!.inputs[0]!;
  assert.deepEqual(cost, { key: 'labor_cost', label: 'Labor cost', agg: 'sum', format: 'currency', synonyms: ['spend'], field: { key: 'jobs.cost', label: 'Cost', type: 'number', synonyms: [] } });
  assert.deepEqual(kit.formulas![0]!.synonyms, ['hull cost']);
  // The flag names the formula like any metric; the definition is carried once.
  assert.deepEqual(kit.flags[0]!.binding!.metrics[0], { key: 'cost_per_hull', label: 'Cost per hull', agg: 'formula', format: 'currency', synonyms: ['hull cost'] });
  // A kit with no formula flag carries no formulas section.
  const plain = makeKit(source, indexCatalog(maint()), { name: 'Plain', flagIds: ['c'], now }).kit!;
  assert.equal('formulas' in plain, false);
  // Round trip through the file.
  const back = parseKitText(exportKit(kit));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.kit, kit);
});

test('flying it onto a catalog with renamed keys: inputs matched by label and synonym, the formulas made again', () => {
  const target = yard();
  const r = applyKit(kitOf(), blank(), indexCatalog(target), { now });
  assert.deepEqual(r.report.problems, []);
  assert.deepEqual(
    r.metrics.map((m: Metric) => [m.key, m.label, m.agg, m.formula, m.source, m.format]),
    [
      ['cost_per_hull', 'Cost per hull', 'formula', 'spend_total / ships', 'yard', 'currency'],
      ['per_hull_order', 'Cost per hull per order', 'formula', 'cost_per_hull / tickets_total', 'yard', 'currency'],
    ],
  );
  assert.deepEqual(r.report.measures.map((m) => m.key), ['cost_per_hull', 'per_hull_order']);
  const next = landed(target, r);
  const [a, b, c] = r.hoist.flags;
  assert.deepEqual(a!.binding!.metrics, ['cost_per_hull']);
  assert.deepEqual(b!.binding!.metrics, ['per_hull_order']);
  assert.deepEqual(b!.binding!.dimensions, [{ field: 'tickets.area' }]);
  // Made here, over inputs matched by label and synonym: drafts to check, never "ready".
  assert.equal(a!.status, 'drafted');
  assert.equal(b!.status, 'drafted');
  assert.equal(c!.status, 'drafted');
  const fa = r.report.flags[0]!;
  assert.equal(fa.outcome, 'remapped');
  const how = Object.fromEntries(fa.mappings.map((m) => [m.from.key, `${m.to?.key}:${m.tier}${m.formula ? `:${m.formula}` : ''}`]));
  assert.deepEqual(how, { cost_per_hull: 'cost_per_hull:synonym:made', labor_cost: 'spend_total:label', hulls: 'ships:synonym' });
  assert.ok(a!.notes.some((n) => /added the calculated measure "Cost per hull"/.test(n)));
  assert.ok(a!.notes.some((n) => /"Hulls affected" became "Ships" \(synonym match\)/.test(n)));
  // And the made measure computes in the new catalog: cost per hull from the inputs' totals.
  const rows = { tickets: [
    { spend: 100, hull_no: 'A', area: 'East' },
    { spend: 50, hull_no: 'A', area: 'East' },
    { spend: 90, hull_no: 'B', area: 'West' },
  ] };
  const idx = indexCatalog(next);
  const p = planFlag(r.hoist, a!, idx);
  assert.ok(p.ok, p.ok ? '' : p.error);
  const shown = applySelections(p.plan, runPlan(p.plan, idx, rows, now).rows, {}, a!.behavior);
  assert.equal(shown.rows[0]!.values.cost_per_hull, 120);
});

test('an identical formula already in the catalog is reused, under its own key', () => {
  const target = yard((c) => c.metrics.push({ key: 'hull_cost', label: 'Spend per ship', agg: 'formula', formula: '(spend_total) / (ships)', source: 'yard' }));
  const r = applyKit(kitOf(), blank(), indexCatalog(target), { now });
  assert.deepEqual(r.metrics.map((m) => [m.key, m.formula]), [['per_hull_order', 'hull_cost / tickets_total']]);
  landed(target, r);
  assert.deepEqual(r.hoist.flags[0]!.binding!.metrics, ['hull_cost']);
  const m = r.report.flags[0]!.mappings[0]!;
  assert.equal(m.formula, 'reused');
  assert.equal(m.to?.key, 'hull_cost');
  // A formula over other inputs is not the same, even under the same label.
  const other = yard((c) => c.metrics.push({ key: 'x', label: 'Cost per hull', agg: 'formula', formula: 'spend_total / tickets_total', source: 'yard' }));
  const r2 = applyKit(kitOf(), blank(), indexCatalog(other), { now });
  assert.equal(r2.report.flags[0]!.mappings[0]!.formula, 'made');
});

test('flown back onto its own catalog: everything exact, the formulas reused, ready flags stay ready', () => {
  const own = maint();
  const r = applyKit(kitOf(), blank(), indexCatalog(own), { now });
  assert.deepEqual(r.metrics, []);
  assert.deepEqual(r.report.measures, []);
  assert.deepEqual(r.report.flags.map((f) => f.outcome), ['kept', 'kept', 'kept']);
  assert.deepEqual(r.hoist.flags.map((f) => f.status), ['ready', 'ready', 'ready']);
  assert.deepEqual(r.hoist.flags.map((f) => f.binding!.metrics[0]), ['cost_per_hull', 'per_hull_order', 'labor_cost']);
});

test('a key already taken in the new catalog: the made formula gets the next free key', () => {
  const target = yard((c) => {
    c.metrics.push({ key: 'cost_per_hull', label: 'Spend again', agg: 'sum', field: 'tickets.spend', source: 'yard' });
    c.metrics.push({ key: 'cost_per_hull_2', label: 'Spend once more', agg: 'sum', field: 'tickets.spend', source: 'yard' });
  });
  const r = applyKit(kitOf(), blank(), indexCatalog(target), { now });
  assert.deepEqual(r.metrics.map((m) => [m.key, m.formula]), [['cost_per_hull_3', 'spend_total / ships'], ['per_hull_order', 'cost_per_hull_3 / tickets_total']]);
  landed(target, r);
  assert.deepEqual(r.hoist.flags[0]!.binding!.metrics, ['cost_per_hull_3']);
});

test('an input with no match: the flag arrives empty with the input named, and nothing is added', () => {
  const target = yard((c) => (c.metrics = c.metrics.filter((m) => m.key !== 'ships')));
  const r = applyKit(kitOf(), blank(), indexCatalog(target), { now });
  assert.deepEqual(r.metrics, []);
  assert.deepEqual(r.report.flags.map((f) => f.outcome), ['unbound', 'unbound', 'remapped']);
  const [a, b, c] = r.hoist.flags;
  assert.equal(a!.binding, null);
  assert.equal(a!.status, 'empty');
  assert.equal(a!.title, 'Cost per hull');
  assert.match(a!.notes[0]!, /"Cost per hull" A calculated measure whose input "Hulls affected" has no match/);
  // The nested one names the formula it builds on, which names its own missing input.
  assert.match(b!.notes[0]!, /input "Cost per hull" has no match: A calculated measure whose input "Hulls affected"/);
  assert.deepEqual(c!.binding!.metrics, ['spend_total']);
  assert.match(r.report.flags[0]!.mappings[0]!.reason!, /Hulls affected/);
});

test('inputs from two sources: not made, with the reason', () => {
  const target = yard((c) => {
    c.metrics = c.metrics.filter((m) => m.key !== 'ships');
    c.metrics.push({ key: 'crew_hulls', label: 'Hulls affected', agg: 'count_distinct', field: 'crew.hull', source: 'hr' });
  });
  const r = applyKit(kitOf(), blank(), indexCatalog(target), { now });
  assert.deepEqual(r.metrics, []);
  assert.equal(r.report.flags[0]!.outcome, 'unbound');
  assert.match(r.report.flags[0]!.mappings[0]!.reason!, /different sources here \("yard", "hr"\); a calculated measure reads one source/);
});

test('older kits still load: no formulas section, and a formula flag saved before kits carried them', () => {
  const old = JSON.parse(exportKit(kitOf())) as Record<string, any>;
  delete old.formulas;
  // Without definitions, a formula flag matches an existing calculated measure like any metric.
  const parsed = parseKit(old);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.kit!.formulas, undefined);
  const own = applyKit(parsed.kit!, blank(), indexCatalog(maint()), { now });
  assert.deepEqual(own.report.flags.map((f) => f.outcome), ['kept', 'kept', 'kept']);
  const r = applyKit(parsed.kit!, blank(), indexCatalog(yard()), { now });
  assert.deepEqual(r.metrics, []);
  assert.equal(r.report.flags[0]!.outcome, 'unbound');
  assert.equal(r.report.flags[2]!.outcome, 'remapped');
  // A kit of plain metrics written by an older Semaphore (no "field" on metrics, no formulas) is unchanged.
  const plain = JSON.parse(exportKit(makeKit(source, indexCatalog(maint()), { name: 'Plain', flagIds: ['c'], now }).kit!));
  const p = parseKit(plain);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(applyKit(p.kit!, blank(), indexCatalog(yard()), { now }).hoist.flags[0]!.binding!.metrics, ['spend_total']);
});

test('formula definitions in a kit file are checked', () => {
  const good = JSON.parse(exportKit(kitOf())) as Record<string, any>;
  const mutate = (fn: (k: Record<string, any>) => void) => {
    const k = JSON.parse(JSON.stringify(good)) as Record<string, any>;
    fn(k);
    return parseKitText(JSON.stringify(k));
  };
  const rejects = (fn: (k: Record<string, any>) => void, why: RegExp) => {
    const r = mutate(fn);
    assert.equal(r.kit, null, `accepted: ${why}`);
    assert.match(r.errors.join(' | '), why);
  };
  rejects((k) => (k.formulas[0].formula = 'labor_cost / ghosts'), /formula cannot be read: "ghosts" is not a measure/);
  rejects((k) => (k.formulas[0].formula = 'SUM(labor_cost)'), /formula cannot be read/);
  rejects((k) => (k.formulas[0].formula = 'x'.repeat(3000)), /formula is longer/);
  rejects((k) => k.formulas.push(k.formulas[0]), /defined twice/);
  rejects((k) => (k.formulas = 'x'), /calculated measures must be a list/);
  rejects((k) => (k.formulas[0].inputs[0].agg = 'median'), /unknown aggregate/);
  rejects((k) => (k.formulas[0].format = 'stars'), /unknown format/);
  // A kit that defines a formula in a circle parses, but the flag on it is not bound.
  const loop = mutate((k) => {
    k.formulas[0].formula = 'per_hull_order * 2';
    k.formulas[0].inputs = [{ key: 'per_hull_order', label: 'Cost per hull per order', agg: 'formula', synonyms: [] }];
  });
  assert.ok(loop.kit, loop.errors.join(' '));
  const r = applyKit(loop.kit, blank(), indexCatalog(yard()), { now });
  assert.equal(r.report.flags[0]!.outcome, 'unbound');
  assert.match(JSON.stringify(r.report.flags[0]!.mappings), /in a circle/);
});

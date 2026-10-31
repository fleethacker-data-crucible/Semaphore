import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Catalog, checkCatalog, type Field, indexCatalog, type Metric } from '../src/core/catalog.ts';
import type { Flag, Hoist } from '../src/core/hoist.ts';
import { LIMITS, parseHoist } from '../src/core/hoist.ts';
import { applyKit, exportKit, isKitDocument, type Kit, KIT_LIMITS, kitId, makeKit, parseKit, parseKitText } from '../src/core/kits.ts';
import { flag, loadCatalog, loadHoist, loadIndex } from './fixtures.ts';

const index = loadIndex();
const hoist = loadHoist();
const now = new Date('2026-10-30T12:00:00Z');

function blank(): Hoist {
  return { version: 1, id: 'target', title: 'Target', brief: '', grid: { cols: 12 }, filters: [], flags: [], updated: now.toISOString() };
}

function field(key: string, label: string, type: Field['type'], synonyms?: string[]): Field {
  const [table = 'tickets', column = key] = key.split('.');
  return { key, label, source: 'yard', table, column, type, ...(synonyms ? { synonyms } : {}) };
}

/** A different catalog for the same kind of work: other keys, other labels, some of the same words. */
function yardCatalog(patch: (c: Catalog) => void = () => undefined): Catalog {
  const c: Catalog = {
    version: 1,
    sources: [{ id: 'yard', label: 'Ship yard', kind: 'csv', dialect: 'ansi' }],
    fields: [
      field('tickets.area', 'Area', 'string'),
      field('tickets.hull_class', 'Ship class', 'string'),
      field('tickets.state', 'State', 'string'),
      field('tickets.opened_at', 'Opened', 'date'),
      field('tickets.hull', 'Hull', 'string'),
      field('tickets.spend', 'Spend', 'number'),
      field('tickets.age', 'Age', 'number'),
    ],
    metrics: [
      { key: 'tickets_total', label: 'Tickets', agg: 'count', table: 'tickets', source: 'yard' },
      { key: 'labor_cost', label: 'Labor cost', agg: 'sum', field: 'tickets.spend', source: 'yard', format: 'currency' },
      // Same key as the kit's "average days open", but a maximum: not the same measure.
      { key: 'avg_days_open', label: 'Longest wait', agg: 'max', field: 'tickets.age', source: 'yard' },
    ],
  };
  patch(c);
  assert.deepEqual(checkCatalog(c), []);
  return c;
}

const yard = indexCatalog(yardCatalog());

function kitOf(options: Partial<Parameters<typeof makeKit>[2]> = {}): Kit {
  const { kit, warnings } = makeKit(hoist, index, { name: 'Maintenance overview', now, ...options });
  assert.ok(kit, warnings.join(' '));
  return kit;
}

const byTitle = (r: ReturnType<typeof applyKit>['report'], title: string) => {
  const f = r.flags.find((x) => x.title === title);
  assert.ok(f, `no report for "${title}"`);
  return f;
};

function allKeys(h: Hoist): { metrics: string[]; fields: string[] } {
  const metrics = new Set<string>();
  const fields = new Set<string>();
  const filters = [...h.filters, ...h.flags.flatMap((f) => f.binding?.filters ?? [])];
  for (const f of filters) fields.add(f.field);
  for (const f of h.flags) {
    for (const m of f.binding?.metrics ?? []) metrics.add(m);
    for (const d of f.binding?.dimensions ?? []) fields.add(d.field);
    for (const k of f.behavior.ignore) fields.add(k);
    for (const t of f.behavior.thresholds) metrics.add(t.metric);
  }
  return { metrics: [...metrics], fields: [...fields] };
}

test('a kit keeps keys, labels, types and synonyms, and no live ids', () => {
  const kit = kitOf();
  assert.equal(kit.version, 1);
  assert.equal(kit.kind, 'flag-kit');
  assert.equal(kit.flags.length, hoist.flags.length);
  const cost = kit.flags.find((f) => f.title === 'Labor cost');
  assert.deepEqual(cost?.binding?.metrics[0], { key: 'labor_cost', label: 'Labor cost', agg: 'sum', format: 'currency', synonyms: ['cost', 'spend', 'labor'] });
  const bar = kit.flags.find((f) => f.title === 'Labor cost by region');
  assert.deepEqual(bar?.binding?.dimensions[0]?.field, { key: 'jobs.region', label: 'Region', type: 'string', synonyms: ['area', 'fleet area'] });
  assert.deepEqual(bar?.binding?.sort, { by: { kind: 'metric', index: 0 }, dir: 'desc' });
  assert.equal(JSON.stringify(kit).includes('"id":"kpi-orders"'), false);
});

test('a selection of flags, with or without layout and page filters', () => {
  const some = kitOf({ flagIds: ['kpi-cost', 'bar-region'], layout: false, pageFilters: true });
  assert.equal(some.flags.length, 2);
  assert.equal(some.flags.every((f) => f.layout === undefined), true);
  assert.equal(some.filters.length, 1);
  assert.equal(kitOf().filters.length, 0);
  assert.equal(makeKit(hoist, index, { name: '  ', now }).kit, null);
  assert.equal(makeKit(hoist, index, { name: 'x', flagIds: ['nope'], now }).kit, null);
});

test('exact remap: the same catalog gives the same flags, with their review state', () => {
  const { hoist: out, report } = applyKit(kitOf(), blank(), index, { now });
  assert.equal(report.applied, true);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.counts, { kept: hoist.flags.length, remapped: 0, partial: 0, unbound: 0 });
  assert.equal(out.flags.length, hoist.flags.length);
  const cost = out.flags.find((f) => f.title === 'Labor cost') as Flag;
  assert.equal(cost.status, 'ready');
  assert.deepEqual(cost.binding?.metrics, ['labor_cost']);
  assert.deepEqual(cost.behavior.thresholds, [{ metric: 'labor_cost', op: 'gt', value: 5000000, tone: 'bad' }]);
  const line = out.flags.find((f) => f.title === 'Work orders per month') as Flag;
  assert.deepEqual(line.binding?.dimensions, [{ field: 'jobs.opened', grain: 'month' }]);
  assert.deepEqual(line.binding?.sort, { by: 'jobs.opened@month', dir: 'asc' });
  assert.deepEqual(line.behavior.ignore, ['jobs.region']);
  assert.equal(out.flags.find((f) => f.title === '')?.status, 'empty');
});

test('synonym and label remap onto another catalog; the flags become drafts to check', () => {
  const { hoist: out, report } = applyKit(kitOf(), blank(), yard, { now });
  const orders = byTitle(report, 'Work orders');
  assert.equal(orders.outcome, 'remapped');
  assert.deepEqual(orders.mappings.map((m) => [m.from.key, m.to?.key, m.tier]), [['work_orders', 'tickets_total', 'synonym']]);

  const klass = byTitle(report, 'Ship class');
  assert.deepEqual(klass.mappings.map((m) => [m.to?.key, m.tier]), [['tickets.hull_class', 'label']]);

  const bar = byTitle(report, 'Labor cost by region');
  assert.deepEqual(bar.mappings.map((m) => [m.from.key, m.to?.key, m.tier]), [
    ['labor_cost', 'labor_cost', 'exact'],
    ['jobs.region', 'tickets.area', 'synonym'],
  ]);
  const barFlag = out.flags.find((f) => f.id === bar.flagId) as Flag;
  assert.deepEqual(barFlag.binding?.dimensions, [{ field: 'tickets.area' }]);
  assert.deepEqual(barFlag.binding?.sort, { by: 'labor_cost', dir: 'desc' });
  assert.equal(barFlag.status, 'drafted');
  assert.equal(barFlag.confidence, 0.8);
  assert.match(barFlag.notes.join(' '), /Region.*became.*Area/);

  // All-exact flag stays as accepted.
  const cost = out.flags.find((f) => f.title === 'Labor cost') as Flag;
  assert.equal(cost.status, 'ready');
  assert.equal(byTitle(report, 'Labor cost').outcome, 'kept');
});

test('type-incompatible matches are refused, not forced', () => {
  // "avg_days_open" exists in the yard catalog under the same key, but it is a maximum, not an average.
  const { hoist: out, report } = applyKit(kitOf(), blank(), yard, { now });
  const line = byTitle(report, 'Work orders per month');
  assert.equal(line.outcome, 'unbound');
  const avg = line.mappings.find((m) => m.from.key === 'avg_days_open');
  assert.equal(avg?.to, undefined);
  assert.match(avg?.reason ?? '', /max/);
  const f = out.flags.find((x) => x.id === line.flagId) as Flag;
  assert.equal(f.binding, null);

  // A field with the right name but the wrong type: "Opened" as text cannot stand in for a date.
  const texty = indexCatalog(yardCatalog((c) => (c.fields.find((x) => x.key === 'tickets.opened_at') as Field).type = 'string'));
  const res = applyKit(kitOf({ flagIds: ['line-trend'] }), blank(), texty, { now });
  const opened = res.report.flags[0]?.mappings.find((m) => m.from.key === 'jobs.opened');
  assert.equal(opened?.to, undefined);
  assert.match(opened?.reason ?? '', /string field.*needs a date field/);
  assert.equal(res.hoist.flags[0]?.binding, null);

  // A currency measure is not swapped for a percentage one.
  const pct = indexCatalog(
    yardCatalog((c) => {
      (c.metrics.find((m) => m.key === 'labor_cost') as Metric).format = 'percent';
    }),
  );
  const r2 = applyKit(kitOf({ flagIds: ['kpi-cost'] }), blank(), pct, { now });
  assert.equal(r2.report.flags[0]?.outcome, 'unbound');
  assert.match(r2.report.flags[0]?.mappings[0]?.reason ?? '', /percent/);
});

test('unmatched references are reported, and the flag is left unbound with its brief', () => {
  const { hoist: out, report } = applyKit(kitOf(), blank(), yard, { now });
  const hulls = byTitle(report, 'Hulls affected');
  assert.equal(hulls.outcome, 'unbound');
  assert.equal(hulls.mappings[0]?.to, undefined);
  assert.match(hulls.mappings[0]?.reason ?? '', /Nothing in the new catalog/);
  const f = out.flags.find((x) => x.id === hulls.flagId) as Flag;
  assert.equal(f.binding, null);
  assert.equal(f.status, 'empty');
  assert.equal(f.brief, 'How many distinct hulls had work.');
  assert.equal(f.title, 'Hulls affected');
  assert.match(f.notes[0] ?? '', /not bound/);
  assert.deepEqual(report.counts, { kept: 2, remapped: 3, partial: 0, unbound: 2 });
  assert.equal(report.counts.unbound, report.flags.filter((x) => x.outcome === 'unbound').length);
});

test('a partly matching flag is bound only when everything it shows matched; the rest is left out and said so', () => {
  // The line chart's filters and colour rules can fall away, but its metrics and fields cannot.
  const k = kitOf({ flagIds: ['kpi-cost'] });
  const target = indexCatalog(
    yardCatalog((c) => {
      c.metrics.push({ key: 'extra', label: 'Extra', agg: 'count', table: 'tickets', source: 'yard' });
    }),
  );
  const hot: Kit = JSON.parse(JSON.stringify(k));
  const kf = hot.flags[0] as Kit['flags'][number];
  (kf.binding as NonNullable<typeof kf.binding>).filters = [{ field: { key: 'jobs.hull', label: 'Hull number', type: 'string', synonyms: ['hull', 'ship'] }, op: 'eq', values: ['H-1'] }];
  kf.behavior.thresholds.push({ metric: { key: 'avg_days_open', label: 'Average days open', agg: 'avg', synonyms: [] }, op: 'gt', value: 30, tone: 'warn' });
  const res = applyKit(hot, blank(), target, { now });
  const r = res.report.flags[0];
  assert.equal(r?.outcome, 'partial');
  assert.deepEqual(res.hoist.flags[0]?.binding?.filters, [{ field: 'tickets.hull', op: 'eq', values: ['H-1'] }]);
  assert.equal(r?.dropped.length, 1);
  assert.match(r?.dropped[0] ?? '', /colour rule on "Average days open"/);
  assert.equal(res.hoist.flags[0]?.behavior.thresholds.length, 1);
  assert.equal(res.hoist.flags[0]?.status, 'drafted');
  assert.ok((res.hoist.flags[0]?.confidence ?? 1) <= 0.6);
  assert.deepEqual(res.report.problems, []);
});

test('close matches are suggestions unless asked for, and never when ambiguous', () => {
  const target = yardCatalog((c) => {
    // Shares two of the kit metric's four words, and nothing else agrees: a "similar" match.
    c.metrics = c.metrics.filter((m) => m.key !== 'tickets_total');
    c.metrics.push({ key: 'work_order_total', label: 'Work order total', agg: 'count', table: 'tickets', source: 'yard' });
    c.metrics.push({ key: 'distinct_hulls', label: 'Distinct hull count', agg: 'count_distinct', field: 'tickets.hull', source: 'yard' });
  });
  const k = kitOf({ flagIds: ['kpi-orders', 'kpi-hulls'] });
  const off = applyKit(k, blank(), indexCatalog(target), { now });
  const orders = off.report.flags[0];
  assert.equal(orders?.outcome, 'unbound');
  assert.equal(orders?.mappings[0]?.suggestions[0]?.key, 'work_order_total');
  assert.match(orders?.mappings[0]?.reason ?? '', /close matches are off/);

  const on = applyKit(k, blank(), indexCatalog(target), { now, closeMatches: true });
  assert.deepEqual(on.report.flags[0]?.mappings.map((m) => [m.to?.key, m.tier]), [['work_order_total', 'similar']]);
  assert.equal(on.hoist.flags[0]?.status, 'drafted');
  assert.equal(on.hoist.flags[0]?.confidence, 0.5);
  // "Distinct hull count" only shares a word: suggested, never used, even with close matches on.
  const hulls = on.report.flags[1];
  assert.equal(hulls?.outcome, 'unbound');
  assert.equal(hulls?.mappings[0]?.suggestions[0]?.key, 'distinct_hulls');

  // Two fields called "Region" in different tables: ambiguous, so not guessed.
  const amb = indexCatalog(
    yardCatalog((c) => {
      c.fields.push(field('crews.region', 'Region', 'string'), field('berths.region', 'Region', 'string'));
    }),
  );
  const res = applyKit(kitOf({ flagIds: ['bar-region'] }), blank(), amb, { now });
  const region = res.report.flags[0]?.mappings.find((m) => m.from.key === 'jobs.region');
  assert.equal(region?.to, undefined);
  assert.match(region?.reason ?? '', /Matches 2/);
  assert.equal(res.hoist.flags[0]?.binding, null);
});

test('round trip: export, then import gives the same kit; the file carries its version', () => {
  const kit = kitOf({ description: 'The standard maintenance page.', pageFilters: true });
  const text = exportKit(kit);
  assert.equal(JSON.parse(text).version, 1);
  assert.equal(JSON.parse(text).kind, 'flag-kit');
  const back = parseKitText(text);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.kit, kit);
  // And it still applies the same way after the trip.
  const a = applyKit(kit, blank(), yard, { now });
  const b = applyKit(back.kit as Kit, blank(), yard, { now });
  assert.deepEqual(b, a);
  assert.equal(isKitDocument(JSON.parse(text)), true);
  assert.equal(isKitDocument({ version: 1, id: 'style' }), false);
});

test('malformed or oversized kits are rejected whole', () => {
  const good = JSON.parse(exportKit(kitOf())) as Record<string, any>;
  const mutate = (fn: (k: Record<string, any>) => void): string => {
    const k = JSON.parse(JSON.stringify(good)) as Record<string, any>;
    fn(k);
    return JSON.stringify(k);
  };
  const rejects = (text: string, why: RegExp) => {
    const r = parseKitText(text);
    assert.equal(r.kit, null, `accepted: ${why}`);
    assert.match(r.errors.join(' | '), why);
  };
  rejects('{not json', /not valid JSON/);
  rejects('[]', /Not a Semaphore flag kit/);
  rejects('null', /Not a Semaphore flag kit/);
  rejects(JSON.stringify({ version: 1, id: 'hoist', flags: [] }), /Not a Semaphore flag kit/);
  rejects(mutate((k) => (k.version = 2)), /newer Semaphore/);
  rejects(mutate((k) => (k.version = 0)), /Unsupported kit version/);
  rejects(mutate((k) => delete k.name), /name/);
  rejects(mutate((k) => (k.id = '../evil')), /id may use/);
  rejects(mutate((k) => (k.cols = 99)), /grid width/);
  rejects(mutate((k) => (k.flags = [])), /at least one flag/);
  rejects(mutate((k) => (k.flags = 'x')), /flags must be a list/);
  rejects(mutate((k) => (k.flags[0].kind = 'sparkle')), /unknown kind/);
  rejects(mutate((k) => (k.flags[0].layout = { x: 20, y: 0, w: 9, h: 1 })), /invalid layout/);
  rejects(mutate((k) => (k.flags[1].binding.metrics[0].agg = 'median')), /unknown aggregate/);
  rejects(mutate((k) => (k.flags[1].binding.metrics[0].synonyms = Array(KIT_LIMITS.synonyms + 1).fill('x'))), /synonyms/);
  rejects(mutate((k) => (k.flags[4].binding.dimensions[0].field.type = 'blob')), /unknown type/);
  rejects(mutate((k) => (k.flags[4].binding.sort = { by: { kind: 'metric', index: 7 }, dir: 'desc' })), /invalid sort/);
  rejects(mutate((k) => (k.flags[1].binding.filters = [{ field: good.flags[4].binding.dimensions[0].field, op: 'between', values: [1] }])), /wrong number of values/);
  rejects(mutate((k) => (k.flags[1].binding.limit = 1e9)), /invalid limit/);
  rejects(mutate((k) => (k.flags[1].behavior.thresholds = [{ metric: good.flags[1].binding.metrics[0], op: 'gt', value: 'high', tone: 'bad' }])), /malformed threshold/);
  rejects(mutate((k) => (k.name = 'x'.repeat(KIT_LIMITS.nameChars + 1))), /name is longer/);
  rejects(mutate((k) => (k.flags = Array(KIT_LIMITS.flags + 1).fill(k.flags[0]))), /more than 200/);
  rejects(' '.repeat(KIT_LIMITS.chars + 1), /larger than/);
  rejects(mutate((k) => (k.flags[0].brief = 'x'.repeat(LIMITS.briefChars + 1))), /brief is longer/);

  // Unknown and hostile properties are dropped, not copied.
  const hostile = parseKitText(mutate((k) => ((k.flags[0].extra = { admin: true }), (k.__proto__ = { polluted: true }))));
  assert.ok(hostile.kit);
  assert.equal('extra' in (hostile.kit.flags[0] as object), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(parseKit(good).kit !== null, true);
});

test('remapped flags pass the existing hoist validation and never invent a key', () => {
  for (const [name, target] of [['same catalog', index], ['yard', yard]] as const) {
    for (const closeMatches of [false, true]) {
      const { hoist: out, report } = applyKit(kitOf({ pageFilters: true }), blank(), target, { now, closeMatches, pageFilters: true });
      assert.equal(report.applied, true, name);
      assert.deepEqual(report.problems, [], name);
      const checked = parseHoist(JSON.parse(JSON.stringify(out)), target);
      assert.deepEqual(checked.warnings, [], name);
      assert.deepEqual(checked.hoist, out, name);
      const keys = allKeys(out);
      for (const m of keys.metrics) assert.ok(target.metric(m), `${name}: invented metric ${m}`);
      for (const f of keys.fields) assert.ok(target.field(f), `${name}: invented field ${f}`);
      for (const f of out.flags) {
        if (f.binding) assert.ok(f.binding.metrics.length + f.binding.dimensions.length > 0);
        else assert.notEqual(f.status, 'ready', `${name}: an unbound flag claims to be ready`);
      }
    }
  }
});

test('applying places flags below the page, with fresh ids, and can be done twice', () => {
  const target = parseHoist(JSON.parse(JSON.stringify(hoist)), index).hoist as Hoist;
  const bottom = Math.max(...target.flags.map((f) => f.layout.y + f.layout.h));
  const k = kitOf({ flagIds: ['kpi-orders', 'bar-region'] });
  const once = applyKit(k, target, index, { now });
  const twice = applyKit(k, once.hoist, index, { now });
  assert.equal(twice.hoist.flags.length, target.flags.length + 4);
  assert.equal(new Set(twice.hoist.flags.map((f) => f.id)).size, twice.hoist.flags.length);
  assert.equal(twice.hoist.flags.slice(target.flags.length).every((f) => /^[A-Za-z0-9_-]{1,64}$/.test(f.id)), true);
  const added = once.hoist.flags.slice(target.flags.length);
  assert.equal(Math.min(...added.map((f) => f.layout.y)) >= bottom, true);
  assert.deepEqual(once.report.problems, []);
  // The input hoist is not changed.
  assert.equal(target.flags.length, hoist.flags.length);

  // Without saved layout the flags take their default sizes.
  const plain = applyKit(kitOf({ flagIds: ['kpi-orders', 'bar-region'], layout: false }), blank(), index, { now });
  assert.deepEqual(plain.hoist.flags.map((f) => [f.layout.w, f.layout.h]), [[3, 2], [6, 4]]);
  assert.deepEqual(plain.report.problems, []);
});

test('a kit that would overfill the hoist is refused and nothing changes', () => {
  const full = blank();
  const base = hoist.flags[0] as Flag;
  full.flags = Array.from({ length: LIMITS.flags }, (_, i) => ({ ...base, id: `f${i}`, layout: { x: 0, y: i * 2, w: 3, h: 2 } }));
  const res = applyKit(kitOf({ flagIds: ['kpi-cost'] }), full, index, { now });
  assert.equal(res.report.applied, false);
  assert.match(res.report.problems[0] ?? '', /at most 200/);
  assert.equal(res.hoist, full);
});

test('page filters follow only when asked, and a comparison needs a "last" window to keep', () => {
  const k = kitOf({ pageFilters: true, flagIds: ['bar-region'] });
  const off = applyKit(k, blank(), yard, { now });
  assert.deepEqual(off.hoist.filters, []);
  const on = applyKit(k, blank(), yard, { now, pageFilters: true });
  assert.deepEqual(on.hoist.filters, [{ field: 'tickets.opened_at', op: 'last', values: [12], unit: 'month' }]);
  assert.equal(on.report.pageFiltersAdded, 1);
  // Applying again does not stack a duplicate.
  assert.equal(applyKit(k, on.hoist, yard, { now, pageFilters: true }).hoist.filters.length, 1);

  const cmp: Kit = JSON.parse(JSON.stringify(k));
  (cmp.flags[0]?.binding as NonNullable<Kit['flags'][number]['binding']>).compare = 'previous-year';
  const without = applyKit(cmp, blank(), yard, { now });
  assert.equal(without.hoist.flags[0]?.binding?.compare, undefined);
  assert.match(without.report.flags[0]?.dropped.join(' ') ?? '', /comparison/);
  assert.equal(without.report.flags[0]?.outcome, 'partial');
  const withWindow = applyKit(cmp, blank(), yard, { now, pageFilters: true });
  assert.equal(withWindow.hoist.flags[0]?.binding?.compare, 'previous-year');
});

test('kit ids are storage-safe and unique', () => {
  assert.equal(kitId('Labor cost / Q4!', []), 'kit-labor-cost-q4');
  assert.equal(kitId('Labor cost / Q4!', ['kit-labor-cost-q4']), 'kit-labor-cost-q4-2');
  assert.equal(kitId('***', []), 'kit-kit');
  assert.match(kitId('x'.repeat(300), []), /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(loadCatalog().fields.length > 0, true);
  assert.equal(flag(hoist, 'kpi-cost').status, 'ready');
});
